import os
import json
import datetime
import threading
from flask import Flask, request, jsonify, render_template, abort, redirect, url_for, send_from_directory

import sys
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(BASE_DIR))

from eval_tool.storage import list_runs as list_auto_runs, load_run, task_set_options, normalize_task_set, list_task_results, clear_run, utc_now, RUNS_DIR, REPO_ROOT
from eval_tool.tasks import load_tasks, tasks_by_id
from eval_tool.runner import create_run, save_run, start_run, DEFAULT_MAX_STEPS, configured_task_model, is_running, stop_run
from eval_tool.judge import configured_judge_model, MODEL_OPTIONS
from eval_tool.step_confidence import backfill_computed_loop, compute_spec_confidence, backfill_g_progress, SpecProgressClient, g_grounding, _action_key, _action_key_updated

app = Flask(__name__)
app.config['TEMPLATES_AUTO_RELOAD'] = True
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0


@app.after_request
def add_dev_no_cache_headers(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

# Directory where saved trajectories are stored (relative to this file)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SAVED_DIR = os.path.join(BASE_DIR, 'saved_trajectories')
os.makedirs(SAVED_DIR, exist_ok=True)

# SINGLE source of truth for starred tasks, keyed by session id. Replaces the old
# per-trajectory `star` field that was split across saved_trajectories/ and runs/.
STARS_FILE = os.path.join(BASE_DIR, 'stars.json')
DASHBOARD_CACHE_FILE = os.path.join(BASE_DIR, '.dashboard_summary_cache.json')


def _load_dashboard_cache():
    try:
        with open(DASHBOARD_CACHE_FILE, 'r', encoding='utf-8') as f:
            cache = json.load(f)
            return cache if isinstance(cache, dict) else {}
    except Exception:
        return {}


def _save_dashboard_cache(cache):
    try:
        with open(DASHBOARD_CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache, f)
    except Exception:
        pass


def _cache_meta(filepath):
    stat = os.stat(filepath)
    return {'mtime_ns': stat.st_mtime_ns, 'size': stat.st_size}


def _cached_file_summary(cache, filepath, builder):
    key = os.path.abspath(filepath)
    try:
        meta = _cache_meta(filepath)
    except OSError:
        return None
    item = cache.get(key)
    if item and item.get('meta') == meta:
        return item.get('summary')
    summary = builder(filepath)
    cache[key] = {'meta': meta, 'summary': summary}
    return summary


def _step_metrics(steps):
    step_metrics = []
    loop_count = 0
    for s in steps:
        loop_val = s.get('loop')
        if loop_val is not None and loop_val > 0.5:
            loop_count += 1
        step_metrics.append({
            'step': s.get('step'),
            'action': s.get('action'),
            'confidence': s.get('confidence'),
            'grounded': s.get('grounded'),
            'progress': s.get('progress'),
            'loop': loop_val,
        })
    return step_metrics, loop_count


def _saved_trajectory_dashboard_summary(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)

    started_at = data.get('startedAt')
    date_str = 'N/A'
    if started_at:
        try:
            dt = datetime.datetime.fromtimestamp(started_at / 1000.0)
            date_str = dt.strftime('%Y-%m-%d %H:%M:%S')
        except Exception:
            pass

    evaluation = data.get('evaluation', {})
    steps = data.get('steps', [])
    step_metrics, loop_count = _step_metrics(steps)
    return {
        'sessionId': data.get('sessionId'),
        'goal': data.get('goal', 'N/A'),
        'date_str': date_str,
        'startedAt': started_at or 0,
        'step_count': len(steps),
        'status': evaluation.get('status', 'pending'),
        'error_types': evaluation.get('error_types', []),
        'conf_source': data.get('conf_source', 'LLM Report'),
        'has_loop': loop_count >= 2,
        'steps': step_metrics,
    }


def _run_task_chart_summary(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)

    started_at_ms = 0
    started_at = data.get('started_at')
    if started_at:
        try:
            dt = datetime.datetime.fromisoformat(started_at)
            started_at_ms = dt.timestamp() * 1000
        except Exception:
            pass

    task = data.get('task', {})
    steps = data.get('steps', [])
    step_metrics, loop_count = _step_metrics(steps)
    return {
        'sessionId': data.get('session_id') or data.get('task_id'),
        'goal': task.get('task', 'N/A'),
        'startedAt': started_at_ms,
        'step_count': len(steps),
        'has_loop': loop_count >= 2,
        'steps': step_metrics,
    }


def _save_stars(stars):
    with open(STARS_FILE, 'w', encoding='utf-8') as f:
        json.dump(stars, f, indent=2, ensure_ascii=False)


def load_stars():
    """Return {session_id: {starred, reason, starredAt}}. Migrates legacy per-file
    `star` fields into stars.json on first run."""
    if os.path.exists(STARS_FILE):
        try:
            with open(STARS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (ValueError, OSError):
            return {}
    # One-time migration from the old per-trajectory `star` fields.
    stars = {}

    def _migrate(filepath):
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception:
            return
        st = data.get('star')
        sid = data.get('sessionId') or data.get('session_id')
        if sid and isinstance(st, dict) and st.get('starred'):
            stars[sid] = {
                'starred': True,
                'reason': st.get('reason', ''),
                'starredAt': st.get('starredAt', ''),
            }

    if os.path.exists(SAVED_DIR):
        for fn in os.listdir(SAVED_DIR):
            if fn.endswith('.json'):
                _migrate(os.path.join(SAVED_DIR, fn))
    if os.path.exists(RUNS_DIR):
        for run_dir in os.listdir(RUNS_DIR):
            tasks_dir = os.path.join(RUNS_DIR, run_dir, 'tasks')
            if os.path.isdir(tasks_dir):
                for fn in os.listdir(tasks_dir):
                    if fn.endswith('.json'):
                        _migrate(os.path.join(tasks_dir, fn))
    _save_stars(stars)
    return stars

def _resolve_trajectory_path(session_id):
    """Locate the JSON file backing a session id.

    Returns (filepath, run_id). run_id is set only when the file lives under an
    automated run's tasks dir. Both are None when nothing matches.
    """
    saved = os.path.join(SAVED_DIR, f"{session_id}.json")
    if os.path.exists(saved):
        return saved, None

    if os.path.exists(RUNS_DIR):
        for run_dir in os.listdir(RUNS_DIR):
            tasks_dir = os.path.join(RUNS_DIR, run_dir, 'tasks')
            if not os.path.exists(tasks_dir):
                continue
            for task_file in os.listdir(tasks_dir):
                if not task_file.endswith('.json'):
                    continue
                tf_path = os.path.join(tasks_dir, task_file)
                try:
                    with open(tf_path, 'r', encoding='utf-8') as f:
                        tdata = json.load(f)
                except Exception:
                    continue
                if tdata.get('session_id') == session_id or tdata.get('sessionId') == session_id:
                    return tf_path, run_dir
    return None, None


def _parse_dt(value):
    """Parse an ISO timestamp to a naive-UTC datetime, tolerating mixed tz-aware/naive
    values (some run records store naive local times, others tz-aware UTC)."""
    if not value:
        return None
    try:
        dt = datetime.datetime.fromisoformat(value)
    except Exception:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    return dt


def _fmt_dt(value):
    """Render an ISO timestamp as a friendly string, e.g. 'Jun 21, 2026 · 9:54 PM'."""
    dt = _parse_dt(value)
    if dt is None:
        return value or None
    # Strip a leading zero from the hour for a cleaner look ("09:54" -> "9:54").
    return dt.strftime('%b %d, %Y · %I:%M %p').replace('· 0', '· ')


def _fmt_duration(total_seconds):
    total = int(total_seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def _run_timing(run):
    """Start/finish timestamps (raw + formatted) and human-readable duration for a run."""
    start = run.get('started_at')
    finish = run.get('completed_at')
    duration = None
    t0, t1 = _parse_dt(start), _parse_dt(finish)
    if t0 and t1:
        total = (t1 - t0).total_seconds()
        if total >= 0:
            duration = _fmt_duration(total)
    return {
        'started_at': start,
        'completed_at': finish,
        'started_fmt': _fmt_dt(start),
        'completed_fmt': _fmt_dt(finish),
        'duration': duration,
    }


def _recorded_action_steps(result):
    steps = set()
    for step in result.get("steps") or []:
        if step.get("isInitial"):
            continue
        try:
            n = int(step.get("step"))
        except Exception:
            continue
        if n > 0:
            steps.add(n)
    return steps


def _format_missing_steps(missing):
    if not missing:
        return ""
    shown = ", ".join(str(n) for n in missing[:5])
    if len(missing) > 5:
        shown += f", +{len(missing) - 5}"
    return f"Missing steps: {shown}"


def missing_step_summary(results):
    missing_any = 0
    missing_step_2 = 0
    by_task = {}
    for result in results:
        steps = _recorded_action_steps(result)
        missing = []
        if steps:
            missing = [n for n in range(1, max(steps) + 1) if n not in steps]
            if missing:
                missing_any += 1
            if 2 not in steps:
                missing_step_2 += 1
        task_id = result.get("task_id") or result.get("session_id") or result.get("sessionId")
        row = {
            "missing": missing,
            "missing_label": _format_missing_steps(missing),
            "missing_step_2": bool(steps and 2 not in steps),
        }
        if task_id:
            by_task[task_id] = row
        result["missing_steps"] = missing
        result["missing_steps_label"] = row["missing_label"]
        result["missing_step_2"] = row["missing_step_2"]
    return {
        "missing_any_step_tasks": missing_any,
        "missing_step_2_tasks": missing_step_2,
        "by_task": by_task,
    }


def collect_starred_tasks():
    """Build the starred-tasks list without scanning every large run JSON.

    Some automated task files store the PageGuide session id inside 10-90 MB JSON
    files rather than in the filename. Resolving those on every dashboard refresh
    makes / slow, so the dashboard only uses cheap direct-file lookups here.
    """
    starred = []
    for session_id, star in load_stars().items():
        if not (isinstance(star, dict) and star.get('starred')):
            continue
        goal = 'N/A'
        run_id = None

        filepath = os.path.join(SAVED_DIR, f"{session_id}.json")
        if not os.path.exists(filepath):
            filepath = None

        if filepath:
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                task = data.get('task')
                if isinstance(task, dict):
                    goal = task.get('task') or task.get('name') or 'N/A'
                else:
                    goal = data.get('goal', 'N/A')
            except Exception:
                pass
        starred.append({
            'sessionId': session_id,
            'goal': goal,
            'run_id': run_id,
            'reason': star.get('reason', ''),
            'starredAt': star.get('starredAt', ''),
        })
    starred.sort(key=lambda x: x['starredAt'], reverse=True)
    return starred


@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    response.headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS'
    return response

@app.route('/api/save_trajectory', methods=['POST', 'OPTIONS'])
def api_save_trajectory():
    if request.method == 'OPTIONS':
        return '', 204
    
    try:
        data = request.json
        if not data or 'sessionId' not in data:
            return jsonify({'error': 'Missing sessionId in payload'}), 400
        
        session_id = data['sessionId']
        filename = f"{session_id}.json"
        filepath = os.path.join(SAVED_DIR, filename)
        
        # Preserve existing evaluation if re-saved
        if os.path.exists(filepath):
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    old_data = json.load(f)
                    if 'evaluation' in old_data:
                        data['evaluation'] = old_data['evaluation']
            except Exception:
                pass

        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            
        return jsonify({'status': 'success', 'filename': filename})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/evaluate_trajectory/<session_id>', methods=['POST', 'OPTIONS'])
def api_evaluate_trajectory(session_id):
    if request.method == 'OPTIONS':
        return '', 204
        
    filepath = os.path.join(SAVED_DIR, f"{session_id}.json")
    if not os.path.exists(filepath):
        return jsonify({'error': 'Trajectory not found'}), 404
        
    try:
        eval_payload = request.json or {}
        status = eval_payload.get('status') # 'success' or 'failed'
        error_types = eval_payload.get('error_types', [])
        notes = eval_payload.get('notes', '')
        
        if not status:
            return jsonify({'error': 'Missing evaluation status'}), 400
            
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
            
        data['evaluation'] = {
            'status': status,
            'error_types': error_types if status == 'failed' else [],
            'notes': notes,
            'evaluatedAt': datetime.datetime.now().isoformat()
        }
        
        if 'llm_source' in eval_payload:
            data['llm_source'] = eval_payload['llm_source']
            
        if 'conf_source' in eval_payload:
            data['conf_source'] = eval_payload['conf_source']
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            
        return jsonify({'status': 'success'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/star_trajectory/<session_id>', methods=['POST', 'OPTIONS'])
def api_star_trajectory(session_id):
    if request.method == 'OPTIONS':
        return '', 204

    filepath, _run_id = _resolve_trajectory_path(session_id)
    if not filepath:
        return jsonify({'error': 'Trajectory not found'}), 404

    try:
        payload = request.json or {}
        starred = bool(payload.get('starred'))
        reason = payload.get('reason', '')

        stars = load_stars()
        if starred:
            stars[session_id] = {
                'starred': True,
                'reason': reason,
                'starredAt': datetime.datetime.now().isoformat(),
            }
        else:
            stars.pop(session_id, None)
        _save_stars(stars)

        return jsonify({'status': 'success', 'starred': starred})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/')
def dashboard():
    trajectories = []
    dashboard_cache = _load_dashboard_cache()
    cache_changed = False
    
    # Read all files in saved_trajectories
    for filename in os.listdir(SAVED_DIR):
        if filename.endswith('.json'):
            filepath = os.path.join(SAVED_DIR, filename)
            try:
                before = dict(dashboard_cache.get(os.path.abspath(filepath)) or {})
                summary = _cached_file_summary(dashboard_cache, filepath, _saved_trajectory_dashboard_summary)
                cache_changed = cache_changed or dashboard_cache.get(os.path.abspath(filepath)) != before
                if summary:
                    trajectories.append(summary)
            except Exception:
                pass
                
    # Sort trajectories newest first
    trajectories.sort(key=lambda x: x['startedAt'], reverse=True)
    
    chart_run_id = request.args.get("chart_run_id", "")
    chart_trajectories = []
    
    if chart_run_id and chart_run_id.startswith('run-'):
        run_tasks_dir = os.path.join(RUNS_DIR, chart_run_id, 'tasks')
        if os.path.exists(run_tasks_dir):
            for filename in os.listdir(run_tasks_dir):
                if filename.endswith('.json'):
                    try:
                        filepath = os.path.join(run_tasks_dir, filename)
                        before = dict(dashboard_cache.get(os.path.abspath(filepath)) or {})
                        summary = _cached_file_summary(dashboard_cache, filepath, _run_task_chart_summary)
                        cache_changed = cache_changed or dashboard_cache.get(os.path.abspath(filepath)) != before
                        if summary:
                            chart_trajectories.append(summary)
                    except Exception:
                        pass
    else:
        chart_trajectories = trajectories
    
    # Calculate simple stats
    total_count = len(trajectories)
    success_count = sum(1 for t in trajectories if t['status'] == 'success')
    failed_count = sum(1 for t in trajectories if t['status'] == 'failed')
    pending_count = sum(1 for t in trajectories if t['status'] == 'pending')
    
    success_rate = (success_count / total_count * 100.0) if total_count > 0 else 0.0
    
    # Count error type occurrences
    error_stats = {}
    for t in trajectories:
        for err in t['error_types']:
            error_stats[err] = error_stats.get(err, 0) + 1
            
    stats = {
        'total': total_count,
        'success': success_count,
        'failed': failed_count,
        'pending': pending_count,
        'success_rate': round(success_rate, 1),
        'error_stats': error_stats
    }
    
    # Load data for Automatic Evaluation
    task_set = normalize_task_set(request.args.get("task_set"))
    available_tasks = load_tasks(task_set)
    
    def reconcile_run(run: dict) -> dict:
        if run.get("status") == "running" and not is_running(run.get("run_id", "")):
            run = save_run({**run, "status": "interrupted", "completed_at": utc_now(),
                            "error": run.get("error") or "Run was interrupted (server restarted while it was running)."})
        return run
        
    auto_runs = [reconcile_run(run) for run in list_auto_runs()]
    for run in auto_runs:
        run['duration'] = _run_timing(run)['duration']
    starred_tasks = collect_starred_tasks()
    if cache_changed:
        _save_dashboard_cache(dashboard_cache)

    return render_template('dashboard.html',
        trajectories=trajectories,
        chart_trajectories=chart_trajectories,
        chart_run_id=chart_run_id,
        stats=stats,
        available_tasks=available_tasks,
        auto_runs=auto_runs,
        starred_tasks=starred_tasks,
        task_set=task_set,
        task_set_options=task_set_options(),
        default_max_steps=DEFAULT_MAX_STEPS,
        model_options=MODEL_OPTIONS,
        default_task_model=configured_task_model(),
        default_judge_model=configured_judge_model()
    )

@app.route('/runs', methods=['POST'])
def create_eval_run():
    task_set = normalize_task_set(request.form.get("task_set"))
    selected = request.form.getlist("task_ids")
    if not selected:
        abort(400, "No valid tasks selected.")
    task_map = tasks_by_id(task_set)
    tasks = [task_map[task_id] for task_id in selected if task_id in task_map]
    if not tasks:
        abort(400, "No valid tasks selected.")
    max_steps = request.form.get("max_steps") or DEFAULT_MAX_STEPS
    workers = int(request.form.get("workers") or 1)
    task_model = request.form.get("task_model") or configured_task_model()
    judge_model = request.form.get("judge_model") or configured_judge_model()
    run = create_run([task.task_id for task in tasks])
    run = save_run({
        **run,
        "task_set": task_set,
        "csv_path": str(task_set),
        "max_steps": max_steps,
        "workers": workers,
        "task_model": task_model,
        "judge_model": judge_model,
    })
    start_run(run, tasks)
    return redirect(url_for("dashboard") + "?tab=automatic")

@app.route('/runs/<run_id>')
def run_detail(run_id):
    run = load_run(run_id)
    if not run:
        abort(404)
    if run.get("status") == "running" and not is_running(run_id):
        run = save_run({**run, "status": "interrupted", "completed_at": utc_now(),
                        "error": run.get("error") or "Run was interrupted."})
                        
    results = list_task_results(run_id)

    # Star state from the single star store (keyed by session id).
    stars = load_stars()
    for res in results:
        sid = res.get("session_id") or res.get("sessionId")
        star = stars.get(sid) if sid else None
        res["starred"] = bool(star and star.get("starred"))
        res["star_reason"] = (star or {}).get("reason", "")

    # Compute run stats
    total = len(run.get("task_ids") or [])
    completed = 0
    passed = 0
    failed = 0
    pending = 0
    
    error_stats = {}
    chart_trajectories = []
    
    for res in results:
        completed += 1
        judge = res.get("judge") or {}
        is_completed_status = (res.get("status") == "completed")
        has_error = bool(res.get("error"))
        
        # Determine status for stats
        if is_completed_status and not has_error:
            if judge.get("success") == True:
                passed += 1
                status_str = "success"
            elif judge.get("success") == False:
                failed += 1
                status_str = "failed"
                cat = judge.get("failureCategory") or "UNKNOWN FAILURE"
                error_stats[cat] = error_stats.get(cat, 0) + 1
            else:
                pending += 1
                status_str = "pending"
        else:
            failed += 1
            status_str = "failed"
            err_msg = res.get("terminal_reason") or "RUNNER ERROR"
            error_stats[err_msg] = error_stats.get(err_msg, 0) + 1
            
        # Chart trajectories mapping
        session_id = res.get("session_id") or res.get("task_id")
        task = res.get("task") or {}
        goal = task.get("task", "N/A")
        
        started_at = res.get("started_at")
        started_at_ms = 0
        if started_at:
            try:
                dt = datetime.datetime.fromisoformat(started_at)
                started_at_ms = dt.timestamp() * 1000
            except Exception:
                pass
                
        steps = res.get("steps") or []
        # Mechanical loop detection for the Loops columns (the LLM `loop` is ~always <1).
        backfill_computed_loop(res)
        old_loops = [s.get("computed_loop") or 0.0 for s in steps if not s.get("isInitial")]
        updated_loops = [s.get("computed_loop_updated") or 0.0 for s in steps if not s.get("isInitial")]
        res["loop_steps"] = sum(1 for v in old_loops if v > 0.5)
        res["max_loop"] = max(old_loops) if old_loops else 0.0
        res["loop_steps_updated"] = sum(1 for v in updated_loops if v > 0.5)
        res["max_loop_updated"] = max(updated_loops) if updated_loops else 0.0
        res["loop_metric_disagrees"] = (
            res["loop_steps"] != res["loop_steps_updated"] or
            abs(res["max_loop"] - res["max_loop_updated"]) > 1e-9
        )
        step_metrics = []
        loop_count = 0
        for s in steps:
            loop_val = s.get("loop")
            if loop_val is not None and loop_val > 0.5:
                loop_count += 1
                
            step_metrics.append({
                "step": s.get("step"),
                "action": s.get("action"),
                "confidence": s.get("confidence"),
                "grounded": s.get("grounded"),
                "progress": s.get("progress"),
                "loop": loop_val
            })
            
        chart_trajectories.append({
            "sessionId": session_id,
            "goal": goal,
            "startedAt": started_at_ms,
            "step_count": len(steps),
            "has_loop": loop_count >= 2,
            "steps": step_metrics,
            "status": status_str,
            "conf_source": "LLM Report"
        })
        
    missing_steps = missing_step_summary(results)
    success_rate = (passed / completed * 100.0) if completed > 0 else 0.0
    
    # Remaining tasks in the run that haven't produced results yet
    remaining = max(0, total - completed)
    pending += remaining
    
    stats = {
        "total": total,
        "completed": completed,
        "passed": passed,
        "failed": failed,
        "pending": pending,
        "success_rate": round(success_rate, 1),
        "error_stats": error_stats,
        "missing_any_step_tasks": missing_steps["missing_any_step_tasks"],
        "missing_step_2_tasks": missing_steps["missing_step_2_tasks"],
    }

    timing = _run_timing(run)

    return render_template('run_detail.html', run=run, results=results, stats=stats, chart_trajectories=chart_trajectories, timing=timing)

@app.route('/artifacts/<path:filename>')
def serve_artifacts(filename):
    return send_from_directory(str(REPO_ROOT), filename)

@app.route('/runs/delete', methods=['POST'])
def delete_runs():
    for run_id in request.form.getlist('run_ids'):
        clear_run(run_id)
    return redirect(url_for("dashboard") + "?tab=automatic")

@app.route('/runs/<run_id>/stop', methods=['POST'])
def stop_eval_run(run_id):
    run = load_run(run_id)
    if not run:
        abort(404)
    if run.get("status") == "running" or is_running(run_id):
        stop_run(run_id)
    return redirect(url_for("run_detail", run_id=run_id))

@app.route('/runs/<run_id>/delete', methods=['POST'])
def delete_run(run_id):
    clear_run(run_id)
    return redirect(url_for("dashboard") + "?tab=automatic")

@app.route('/trajectory/<session_id>/delete', methods=['POST'])
def delete_trajectory(session_id):
    # Only manual/saved trajectories are deletable here; run task files are removed
    # by deleting the whole run.
    filepath = os.path.join(SAVED_DIR, f"{session_id}.json")
    if os.path.exists(filepath):
        os.remove(filepath)
    return redirect(url_for("dashboard"))

@app.route('/trajectory/<session_id>')
def trajectory_detail(session_id):
    filepath, run_id = _resolve_trajectory_path(session_id)
    if not filepath:
        return (
            "No trajectory was recorded for this task. It most likely failed before "
            "any PageGuide step ran (e.g. a navigation/DNS error or the site blocked "
            "the automated browser), so no session was created. Check the run's Reason "
            "column for the terminal reason.",
            404,
        )

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            trajectory = json.load(f)

        # Ensure default structure
        if 'steps' not in trajectory:
            trajectory['steps'] = []

        # Compute + cache goal-relevance embeddings on first view. Non-fatal: a
        # missing OPENROUTER_API_KEY or network error leaves the column as "—".
        try:
            if not isinstance(trajectory.get('task'), dict):
                first_url = next((s.get('url') for s in trajectory['steps'] if s.get('url')), '')
                trajectory['task'] = {'task': trajectory.get('goal', ''), 'website_url': first_url}
            client = SpecProgressClient()
            if client.available and backfill_g_progress(trajectory, client):
                with open(filepath, 'w', encoding='utf-8') as f:
                    json.dump(trajectory, f, indent=2, ensure_ascii=False)
        except Exception:
            pass


        # Format the start time
        started_at = trajectory.get('startedAt') or trajectory.get('started_at')
        date_str = 'N/A'
        if started_at:
            try:
                if isinstance(started_at, str):
                    # For eval_tool runs, started_at is an ISO string "2026-06-20T14:15:50+00:00"
                    date_str = started_at
                else:
                    dt = datetime.datetime.fromtimestamp(started_at / 1000.0)
                    date_str = dt.strftime('%Y-%m-%d %H:%M:%S')
            except Exception:
                pass
        trajectory['date_str'] = date_str
        
        # Map automated runs structure (has task_id, task, etc.) to inspector format
        if 'task' in trajectory and isinstance(trajectory['task'], dict):
            if 'goal' not in trajectory:
                trajectory['goal'] = trajectory['task'].get('task', 'N/A')
            if 'sessionId' not in trajectory:
                trajectory['sessionId'] = session_id
        
        # Backfill rule-based L_t_u, rule grounding, mechanical C_t and loop keys for the UI.
        backfill_computed_loop(trajectory)
        for step in trajectory.get('steps', []):
            if step.get('isInitial'):
                continue
            step['rule_grounding'] = g_grounding(step)
            step['mech_confidence'] = compute_spec_confidence(step, formula="spec_noprogress")
            step['action_key'] = _action_key(step)
            step['action_key_updated'] = _action_key_updated(step)

        star = load_stars().get(session_id)
        return render_template('inspector.html', trajectory=trajectory, run_id=run_id, star=star)
    except Exception:
        abort(500)

if __name__ == '__main__':
    # Start on standard port 5000
    app.run(host='127.0.0.1', port=5000, debug=True)
