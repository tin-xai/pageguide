import os
import json
import datetime
import threading
from flask import Flask, request, jsonify, render_template, abort, redirect, url_for, send_from_directory, send_file

import sys
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(BASE_DIR))

from eval_tool.storage import list_runs as list_auto_runs, load_run, task_set_options, normalize_task_set, list_task_results, clear_run, utc_now, RUNS_DIR, REPO_ROOT
from eval_tool.tasks import load_tasks, tasks_by_id, display_task_name
from eval_tool.runner import create_run, save_run, start_run, DEFAULT_MAX_STEPS, configured_task_model, is_running, stop_run, configured_region_capture_mode, normalize_region_capture_mode, region_capture_mode_label
from eval_tool.judge import configured_judge_model, MODEL_OPTIONS, DEFAULT_JUDGE_METHOD, judge_method_options, normalize_judge_method, LlmJudge
from eval_tool.mind2web_levels import (
    DIFFICULTY_LABELS,
    DIFFICULTY_LEVELS,
    difficulty_counts,
    effective_task_difficulty,
    export_mind2web_csv,
    filter_tasks_by_difficulty,
    normalize_difficulty,
    reference_step_count,
)
from eval_tool.scoring import apply_manual_evaluation, evaluation_for_inspector, task_outcome
from eval_tool.step_confidence import backfill_computed_loop, backfill_element_step_similarity, backfill_g_progress, compute_spec_confidence, SpecProgressClient, g_grounding, _action_key, _action_key_updated, _element_text, low_grounding_summary, format_low_grounding_summary, infer_predicted_goal_state, loop_metrics_summary
from eval_tool.subgoal_progress import PageState, backfill_subgoal_progress, evaluate_subgoal_details

app = Flask(__name__)
app.config['TEMPLATES_AUTO_RELOAD'] = True
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0


@app.template_global('task_difficulty')
def task_difficulty(task):
    return DIFFICULTY_LABELS[effective_task_difficulty(task)]

@app.template_global('task_difficulty_level')
def task_difficulty_level(task):
    return effective_task_difficulty(task)

@app.template_global('task_reference_step_count')
def task_reference_step_count(task):
    return reference_step_count(task)


def _supports_reference_difficulty(task_set):
    if not task_set:
        return False
    return normalize_task_set(task_set) in {"no_login", "mind2web", "online_mind2web"}


def _task_reference_meta(task):
    if not task:
        return {"steps": None, "difficulty": "", "label": "Unknown"}
    steps = reference_step_count(task)
    difficulty = effective_task_difficulty(task)
    return {
        "steps": steps,
        "difficulty": difficulty,
        "label": DIFFICULTY_LABELS.get(difficulty, "Unknown"),
    }


def _run_reference_summary(run: dict) -> dict:
    if not _supports_reference_difficulty(run.get("task_set")):
        return {"available": False, "label": "—", "title": ""}
    task_ids = run.get("task_ids") or []
    task_map = tasks_by_id(run.get("task_set"))
    metas = [_task_reference_meta(task_map.get(task_id)) for task_id in task_ids if task_map.get(task_id)]
    with_steps = [meta for meta in metas if meta["steps"] is not None]
    if not with_steps:
        return {"available": False, "label": "Unknown", "title": "No reference step metadata found"}
    counts = {level: 0 for level in DIFFICULTY_LEVELS}
    for meta in with_steps:
        if meta["difficulty"] in counts:
            counts[meta["difficulty"]] += 1
    step_values = [meta["steps"] for meta in with_steps]
    step_range = str(step_values[0]) if len(set(step_values)) == 1 else f"{min(step_values)}-{max(step_values)}"
    parts = [
        f"{DIFFICULTY_LABELS[level]} {counts[level]}"
        for level in DIFFICULTY_LEVELS
        if counts[level]
    ]
    return {
        "available": True,
        "label": f"{step_range} ref steps · " + " / ".join(parts),
        "title": f"{len(with_steps)} task(s) with reference step metadata",
    }


@app.template_global('task_display_name')
def task_display_name(task):
    return display_task_name(task)


@app.template_global('spec_grounding')
def spec_grounding(step, high_threshold=None, medium_threshold=None):
    return g_grounding(step, high_threshold=high_threshold, medium_threshold=medium_threshold)


@app.template_global('spec_confidence')
def spec_confidence(step, formula="spec_full", high_threshold=None, medium_threshold=None):
    return compute_spec_confidence(step, formula=formula, high_threshold=high_threshold, medium_threshold=medium_threshold)


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
DASHBOARD_CACHE_VERSION = 2


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
    return {'mtime_ns': stat.st_mtime_ns, 'size': stat.st_size, 'version': DASHBOARD_CACHE_VERSION}


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


def _step_metrics(steps, high_threshold=None, medium_threshold=None):
    payload = {"steps": steps or []}
    backfill_computed_loop(payload)
    step_metrics = []
    loop_count = 0
    for s in payload["steps"]:
        if s.get("isInitial"):
            continue
        loop_u = s.get("computed_loop_updated")
        if loop_u is not None and loop_u > 0.5:
            loop_count += 1
        step_metrics.append({
            "step": s.get("step"),
            "action": s.get("action"),
            "mech_confidence": compute_spec_confidence(s, formula="spec_noprogress", high_threshold=high_threshold, medium_threshold=medium_threshold),
            "rule_grounding": g_grounding(s, high_threshold=high_threshold, medium_threshold=medium_threshold),
            "element_step_similarity": s.get("element_step_similarity"),
            "grounded_human_label": s.get("grounded_human_label"),
            "instruction": s.get("instruction"),
            "g_goal_relevance_score": s.get("g_goal_relevance_score"),
            "g_progress_score": s.get("g_progress_score"),
            "self_progress_gt": s.get("self_progress_gt"),
            "self_progress_no_gt": s.get("self_progress_no_gt"),
            "progress": s.get("progress"),
            "legacy_progress": s.get("progress"),
            "subgoal_progress": s.get("subgoal_progress"),
            "subgoal_verified": s.get("subgoal_verified"),
            "subgoal_completion": s.get("subgoal_completion"),
            "computed_loop_updated": loop_u if loop_u is not None else 0.0,
        })
    return step_metrics, loop_count


def _avg_metric(steps, field):
    """Mean of a per-step numeric field over non-initial steps, or None if none present."""
    vals = [s.get(field) for s in (steps or [])
            if not s.get("isInitial") and isinstance(s.get(field), (int, float))]
    return round(sum(vals) / len(vals), 3) if vals else None


def _ratio(numer, denom):
    return (numer / denom) if denom else None


def _grounding_human_label(step):
    return "non_grounded" if step.get("grounded_human_label") == "non_grounded" else "grounded"


def grounding_boundary_metrics(steps, threshold=0.8):
    """Compare grounding similarity predictions with human grounded labels.

    Human label defaults to grounded; only ``grounded_human_label == "non_grounded"``
    flips a step to the negative class. Steps without numeric similarity are excluded.
    Grounded is the positive class.
    """
    try:
        threshold = float(threshold)
    except (TypeError, ValueError):
        threshold = 0.8
    tp = tn = fp = fn = 0
    mismatches = []
    for step in steps or []:
        if step.get("isInitial"):
            continue
        try:
            sim = float(step.get("element_step_similarity"))
        except (TypeError, ValueError):
            continue
        pred = "grounded" if sim >= threshold else "non_grounded"
        human = _grounding_human_label(step)
        if human == "grounded" and pred == "grounded":
            tp += 1
        elif human == "grounded" and pred == "non_grounded":
            fn += 1
        elif human == "non_grounded" and pred == "grounded":
            fp += 1
        else:
            tn += 1
        if pred != human:
            mismatches.append({
                "step": step.get("step"),
                "similarity": sim,
                "predicted": pred,
                "human": human,
                "instruction": step.get("instruction") or "",
                "action": step.get("action") or "",
            })
    total = tp + tn + fp + fn
    precision = _ratio(tp, tp + fp)
    recall = _ratio(tp, tp + fn)
    f1 = (2 * precision * recall / (precision + recall)) if precision is not None and recall is not None and (precision + recall) else None
    return {
        "threshold": threshold,
        "total": total,
        "correct": tp + tn,
        "incorrect": fp + fn,
        "tp": tp,
        "tn": tn,
        "fp": fp,
        "fn": fn,
        "accuracy": _ratio(tp + tn, total),
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "mismatches": mismatches,
    }


def _subgoal_check_label(check):
    ctype = check.get("type") or "check"
    if ctype == "role_label":
        value = " ".join(str(v) for v in [check.get("role"), check.get("name")] if v)
    elif ctype == "text_group_includes":
        bits = []
        if check.get("all_of"):
            bits.append("all: " + ", ".join(str(v) for v in check.get("all_of") or []))
        if check.get("any_of"):
            bits.append("any: " + ", ".join(str(v) for v in check.get("any_of") or []))
        value = "; ".join(bits)
    elif ctype == "control_state":
        value = " ".join(str(v) for v in [check.get("state"), check.get("label") or check.get("name") or check.get("value")] if v)
    else:
        value = check.get("value") or check.get("name") or check.get("label") or check.get("role") or ""
        if isinstance(value, list):
            value = ", ".join(str(v) for v in value)
    return f"{ctype}: {value}" if value else ctype


def _step_page_state(step):
    dom = step.get("domSnapshotAfter") or step.get("domSnapshot") or ""
    return PageState(step.get("url", ""), dom)


def enrich_subgoal_breakdown(trajectory):
    """Attach per-step, per-subgoal check results for display only.

    This is intentionally read-only: it evaluates the stored rubric against the stored
    URL/DOM snapshots and never generates a rubric, reruns scoring, or writes files.
    """
    subgoals = ((trajectory.get("subgoal_rubric") or {}).get("subgoals") or [])
    if not subgoals:
        return
    for step in trajectory.get("steps", []):
        if step.get("isInitial"):
            continue
        state = _step_page_state(step)
        breakdown = []
        completed = set(step.get("subgoal_verified_indices") or [])
        direct = set(step.get("subgoal_direct_verified_indices") or [])
        for index, subgoal in enumerate(subgoals, start=1):
            details = evaluate_subgoal_details(subgoal, state)
            check_rows = []
            for row in details["checks"]:
                check = row["check"]
                check_rows.append({
                    "label": _subgoal_check_label(check),
                    "passed": row["passed"],
                })
            order = subgoal.get("order", index)
            try:
                order_int = int(order)
            except Exception:
                order_int = index
            directly_verified = bool(details["verified"])
            verified = order_int in completed or directly_verified
            breakdown.append({
                "order": order,
                "goal": subgoal.get("goal", ""),
                "verified": verified,
                "direct": directly_verified or order_int in direct,
                # Verified on a PREVIOUS step but not on this one (subgoals are independent +
                # cumulative; there is no longer any implied-by-ordering completion).
                "earlier": verified and not (directly_verified or order_int in direct),
                "mode": details["mode"],
                "checks": check_rows,
            })
        step["subgoal_breakdown"] = breakdown


def _ensure_trajectory_task(trajectory):
    if not isinstance(trajectory.get('task'), dict):
        first_url = next((s.get('url') for s in trajectory.get('steps', []) if s.get('url')), '')
        trajectory['task'] = {'task': trajectory.get('goal', ''), 'website_url': first_url}


def rerun_trajectory_grounding_similarity(trajectory, client=None):
    """Explicitly recompute cosine(step instruction, target element text)."""
    if 'steps' not in trajectory:
        trajectory['steps'] = []
    client = client or SpecProgressClient()
    if not client.available:
        return {"updated": False, "steps_scored": 0, "reason": "OPENROUTER_API_KEY is not configured"}
    for step in trajectory.get("steps", []):
        step.pop("element_step_similarity", None)
    updated = backfill_element_step_similarity(trajectory, client)
    steps_scored = sum(
        1 for step in trajectory.get("steps", [])
        if not step.get("isInitial") and step.get("element_step_similarity") is not None
    )
    reason = "" if updated else "no indexed instruction/element-text steps to embed"
    return {"updated": updated, "steps_scored": steps_scored, "reason": reason}


def rerun_trajectory_goal_relevance(trajectory, client=None):
    """Explicitly predict final state and recompute cosine(final state, step instruction)."""
    if 'steps' not in trajectory:
        trajectory['steps'] = []
    _ensure_trajectory_task(trajectory)
    client = client or SpecProgressClient()
    if not client.available:
        return {"updated": False, "steps_scored": 0, "reason": "OPENROUTER_API_KEY is not configured"}
    trajectory["spec_goal_text"] = ""
    trajectory.pop("predictedGoalState", None)
    for step in trajectory.get("steps", []):
        step.pop("g_goal_relevance_score", None)
        step.pop("predictedGoalState", None)
    updated = backfill_g_progress(trajectory, client)
    steps_scored = sum(
        1 for step in trajectory.get("steps", [])
        if not step.get("isInitial") and step.get("g_goal_relevance_score") is not None
    )
    reason = "" if updated else "no instruction-bearing grounding steps to embed"
    return {"updated": updated, "steps_scored": steps_scored, "reason": reason}


def rerun_trajectory_subgoal_progress(trajectory):
    """Explicitly regenerate/score Subgoal Progress for one trajectory.

    This is only called from the user-triggered POST route; page views never call it.
    """
    _ensure_trajectory_task(trajectory)
    client = SpecProgressClient()
    changed = backfill_subgoal_progress(trajectory, client)
    if not changed:
        return {"updated": False, "steps_scored": 0}
    steps_scored = sum(
        1 for step in trajectory.get("steps", [])
        if not step.get("isInitial") and step.get("subgoal_progress") is not None
    )
    return {"updated": True, "steps_scored": steps_scored}


# Per-run detail of the last GT/no-GT self-report rerun, keyed by run_id: which tasks were
# scored vs skipped and why. Read + cleared by run_detail so the result page can explain skips.
_selfreport_reports = {}


def rerun_trajectory_progress_self_report(trajectory, which="both", model=None):
    """Per-step LLM self-reported progress on a -1/0/1 scale. ``which`` selects the GT variant
    (uses the dataset reference_steps), the no-GT variant, or both. ``model`` is the LLM id to
    judge with (normally the run's task_model). Writes `self_progress_gt` / `self_progress_no_gt`
    (+ reasons). Always recomputes (deliberate, user-triggered). Returns a result with a `reason`
    explaining why nothing was scored, so the caller can report skips.
    """
    if not isinstance(trajectory.get('task'), dict):
        first_url = next((s.get('url') for s in trajectory.get('steps', []) if s.get('url')), '')
        trajectory['task'] = {'task': trajectory.get('goal', ''), 'website_url': first_url}
    task = trajectory['task']
    do_gt = which in ("gt", "both")
    do_nogt = which in ("nogt", "both")
    judge = LlmJudge(model=model) if model else LlmJudge()
    if not judge.api_key:
        return {"updated": False, "steps_scored": 0, "reason": "OPENROUTER_API_KEY is not configured"}
    steps = trajectory.get("steps", [])
    actionable = [s for s in steps if not s.get("isInitial") and int(s.get("step") or 0) > 0]
    if not actionable:
        return {"updated": False, "steps_scored": 0, "reason": "no actionable steps were recorded"}
    has_ref = bool((task.get("reference_steps") or "").strip())
    if do_gt and not do_nogt and not has_ref:
        return {"updated": False, "steps_scored": 0,
                "reason": "no reference_steps (GT progress only applies to No-Login tasks)"}

    steps_scored = 0
    details = []
    for index, step in enumerate(steps):
        if step.get("isInitial") or int(step.get("step") or 0) <= 0:
            continue
        observed = [s for s in steps[: index + 1]
                    if not s.get("isInitial") and int(s.get("step") or 0) > 0]
        if do_gt:
            gt = judge.judge_progress_self_report(task, step, observed, use_ground_truth=True)
            step["self_progress_gt"] = gt.get("score")
            step["self_progress_gt_reason"] = gt.get("reason", "")
            step["self_progress_gt_prompt"] = gt.get("prompt", "")
            step["self_progress_gt_raw_response"] = gt.get("raw_response", "")
            if gt.get("score") is not None:
                details.append({
                    "step": step.get("step"),
                    "variant": "GT",
                    "score": gt.get("score"),
                    "reason": gt.get("reason", ""),
                    "prompt": gt.get("prompt", ""),
                    "raw_response": gt.get("raw_response", ""),
                })
        if do_nogt:
            no_gt = judge.judge_progress_self_report(task, step, observed, use_ground_truth=False)
            step["self_progress_no_gt"] = no_gt.get("score")
            step["self_progress_no_gt_reason"] = no_gt.get("reason", "")
            step["self_progress_no_gt_prompt"] = no_gt.get("prompt", "")
            step["self_progress_no_gt_raw_response"] = no_gt.get("raw_response", "")
            if no_gt.get("score") is not None:
                details.append({
                    "step": step.get("step"),
                    "variant": "No-GT",
                    "score": no_gt.get("score"),
                    "reason": no_gt.get("reason", ""),
                    "prompt": no_gt.get("prompt", ""),
                    "raw_response": no_gt.get("raw_response", ""),
                })
        if (do_gt and step.get("self_progress_gt") is not None) or \
           (do_nogt and step.get("self_progress_no_gt") is not None):
            steps_scored += 1

    reason = ""
    if steps_scored == 0:
        reason = "no scores produced"
        if do_gt and not has_ref:
            reason += " (GT needs reference_steps)"
    return {"updated": steps_scored > 0, "steps_scored": steps_scored, "reason": reason, "details": details}


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
    high = data.get("grounding_high_threshold")
    medium = data.get("grounding_medium_threshold")
    step_metrics, loop_count = _step_metrics(steps, high_threshold=high, medium_threshold=medium)
    return {
        'sessionId': data.get('sessionId'),
        'goal': data.get('goal', 'N/A'),
        'date_str': date_str,
        'startedAt': started_at or 0,
        'step_count': len(steps),
        'status': evaluation.get('status', 'pending'),
        'error_types': evaluation.get('error_types', []),
        'conf_source': data.get('conf_source', 'LLM Report'),
        'has_loop': loop_count >= 1,
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

    run_dir = os.path.dirname(os.path.dirname(filepath))
    run_high = None
    run_medium = None
    try:
        run_json_path = os.path.join(run_dir, "run.json")
        if os.path.exists(run_json_path):
            with open(run_json_path, 'r', encoding='utf-8') as rf:
                run_meta = json.load(rf)
                run_high = run_meta.get("grounding_high_threshold")
                run_medium = run_meta.get("grounding_medium_threshold")
    except Exception:
        pass

    task = data.get('task', {})
    steps = data.get('steps', [])
    high = data.get("grounding_high_threshold") or run_high
    medium = data.get("grounding_medium_threshold") or run_medium
    step_metrics, loop_count = _step_metrics(steps, high_threshold=high, medium_threshold=medium)
    return {
        'sessionId': data.get('session_id') or data.get('task_id'),
        'goal': task.get('task', 'N/A'),
        'startedAt': started_at_ms,
        'step_count': len(steps),
        'has_loop': loop_count >= 1,
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

    filepath, _run_id = _resolve_trajectory_path(session_id)
    if not filepath:
        return jsonify({'error': 'Trajectory not found'}), 404

    try:
        eval_payload = request.json or {}
        status = eval_payload.get('status')  # 'success' or 'failed'
        error_types = eval_payload.get('error_types', [])
        notes = eval_payload.get('notes', '')

        if status not in {'success', 'failed'}:
            return jsonify({'error': 'Missing evaluation status'}), 400

        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)

        data = apply_manual_evaluation(
            data,
            status=status,
            error_types=error_types,
            notes=notes,
            llm_source=eval_payload.get('llm_source'),
            conf_source=eval_payload.get('conf_source'),
        )

        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        return jsonify({'status': 'success', 'outcome': task_outcome(data)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/trajectory/<session_id>/grounding-human-label', methods=['POST', 'OPTIONS'])
def api_grounding_human_label(session_id):
    if request.method == 'OPTIONS':
        return '', 204

    filepath, run_id = _resolve_trajectory_path(session_id)
    if not filepath:
        return jsonify({'error': 'Trajectory not found'}), 404
    if run_id and is_running(run_id):
        return jsonify({'error': 'Cannot edit grounding labels while the backing run is running.'}), 400

    payload = request.json or {}
    label = payload.get("label")
    if label not in {"grounded", "non_grounded"}:
        return jsonify({'error': 'label must be grounded or non_grounded'}), 400
    try:
        step_id = int(payload.get("step"))
    except (TypeError, ValueError):
        return jsonify({'error': 'step must be an integer'}), 400

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        steps = data.get("steps") or []
        target = None
        for step in steps:
            try:
                current = int(step.get("step"))
            except (TypeError, ValueError):
                continue
            if current == step_id:
                target = step
                break
        if target is None:
            return jsonify({'error': 'Step not found'}), 404

        if label == "non_grounded":
            target["grounded_human_label"] = "non_grounded"
        else:
            target.pop("grounded_human_label", None)

        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        threshold = payload.get("threshold", 0.8)
        metrics = grounding_boundary_metrics(steps, threshold)
        return jsonify({'status': 'success', 'label': label, 'metrics': metrics})
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
    difficulty = normalize_difficulty(request.args.get("difficulty"))
    all_tasks = load_tasks(task_set)
    has_difficulty_filter = task_set in {"no_login", "mind2web", "online_mind2web"}
    difficulty_level_counts = difficulty_counts(all_tasks) if has_difficulty_filter else {}
    available_tasks = filter_tasks_by_difficulty(all_tasks, difficulty) if has_difficulty_filter else all_tasks
    
    def reconcile_run(run: dict) -> dict:
        if run.get("status") == "running" and not is_running(run.get("run_id", "")):
            run = save_run({**run, "status": "interrupted", "completed_at": utc_now(),
                            "error": run.get("error") or "Run was interrupted (server restarted while it was running)."})
        return run
        
    auto_runs = [reconcile_run(run) for run in list_auto_runs()]
    for run in auto_runs:
        run['duration'] = _run_timing(run)['duration']
        run['reference_summary'] = _run_reference_summary(run)
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
        difficulty=difficulty,
        difficulty_labels=DIFFICULTY_LABELS,
        difficulty_level_counts=difficulty_level_counts,
        has_difficulty_filter=has_difficulty_filter,
        default_max_steps=DEFAULT_MAX_STEPS,
        model_options=MODEL_OPTIONS,
        default_task_model=configured_task_model(),
        default_judge_model=configured_judge_model(),
        judge_method_options=judge_method_options(),
        default_judge_method=DEFAULT_JUDGE_METHOD,
        default_region_capture_mode=configured_region_capture_mode(),
        region_capture_mode_label=region_capture_mode_label,
    )

@app.route('/mind2web/download')
def download_mind2web_csv():
    level = normalize_difficulty(request.args.get("level"))
    filename = f"mind2web_tasks_{level}.csv" if level else "mind2web_tasks_all.csv"
    dest = REPO_ROOT / "data-guide" / f".export_{filename}"
    count = export_mind2web_csv(level, dest)
    if count == 0:
        abort(404, "No Mind2Web tasks match that difficulty filter.")
    return send_file(dest, as_attachment=True, download_name=filename)

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
    judge_method = normalize_judge_method(request.form.get("judge_method"))
    # Only the curated no_login set has reliable reference_steps to inject.
    ground_truth_mode = task_set == "no_login" and bool(request.form.get("ground_truth_mode"))
    region_capture_mode = normalize_region_capture_mode(
        request.form.get("region_capture_mode") or configured_region_capture_mode()
    )
    run = create_run([task.task_id for task in tasks])
    run = save_run({
        **run,
        "task_set": task_set,
        "csv_path": str(task_set),
        "max_steps": max_steps,
        "workers": workers,
        "task_model": task_model,
        "judge_model": judge_model,
        "judge_method": judge_method,
        "ground_truth_mode": ground_truth_mode,
        "region_capture_mode": region_capture_mode,
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
    run_task_map = tasks_by_id(run.get("task_set")) if _supports_reference_difficulty(run.get("task_set")) else {}

    # Star state from the single star store (keyed by session id).
    stars = load_stars()
    for res in results:
        task_id = res.get("task_id")
        task_meta_source = res.get("task") or run_task_map.get(task_id) or {}
        if _supports_reference_difficulty(run.get("task_set")):
            res["reference_meta"] = _task_reference_meta(task_meta_source)
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
    total_steps = 0
    grounding_similarity_default_threshold = 0.8
    grounding_similarity_low_steps = 0
    grounding_similarity_scored_steps = 0
    grounding_similarity_low_tasks = 0
    grounding_boundary_totals = {"tp": 0, "tn": 0, "fp": 0, "fn": 0}
    loop_updated_positive_steps = 0
    loop_updated_positive_tasks = 0
    loop_updated_scored_steps = 0
    
    error_stats = {}
    chart_trajectories = []
    
    for res in results:
        completed += 1
        is_completed_status = (res.get("status") == "completed")
        has_error = bool(res.get("error"))
        outcome = task_outcome(res) if is_completed_status and not has_error else "failed"

        if is_completed_status and not has_error:
            if outcome == "success":
                passed += 1
                status_str = "success"
            elif outcome == "failed":
                failed += 1
                status_str = "failed"
                if res.get("evaluation") and (res.get("evaluation") or {}).get("source") == "human":
                    cat = "MANUAL OVERRIDE"
                else:
                    cat = (res.get("judge") or {}).get("failureCategory") or "UNKNOWN FAILURE"
                error_stats[cat] = error_stats.get(cat, 0) + 1
            else:
                pending += 1
                status_str = "pending"
        else:
            failed += 1
            status_str = "failed"
            err_msg = res.get("terminal_reason") or "RUNNER ERROR"
            error_stats[err_msg] = error_stats.get(err_msg, 0) + 1

        res["outcome"] = outcome if is_completed_status and not has_error else status_str
        res["has_manual_override"] = (
            res.get("human_success") is not None
            and (res.get("judge") or {}).get("success") is not None
            and bool(res.get("human_success")) != bool((res.get("judge") or {}).get("success"))
        )

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
        total_steps += sum(
            1 for step in steps
            if not step.get("isInitial") and int(step.get("step") or 0) > 0
        )
        high = res.get("grounding_high_threshold") or run.get("grounding_high_threshold")
        medium = res.get("grounding_medium_threshold") or run.get("grounding_medium_threshold")
        res.update(loop_metrics_summary(steps))
        loop_u_values = []
        loop_u_positive_steps = []
        for step in steps:
            if step.get("isInitial"):
                continue
            try:
                loop_u = float(step.get("computed_loop_updated") or 0.0)
            except (TypeError, ValueError):
                loop_u = 0.0
            loop_u_values.append(loop_u)
            if loop_u > 0:
                loop_u_positive_steps.append({
                    "step": step.get("step"),
                    "value": loop_u,
                    "action_key": step.get("action_key_updated") or _action_key_updated(step),
                })
        res["loop_updated_scored_steps"] = len(loop_u_values)
        res["loop_updated_positive_count"] = len(loop_u_positive_steps)
        res["loop_updated_positive_steps"] = loop_u_positive_steps
        res["loop_updated_max_positive"] = max(loop_u_values) if loop_u_values else 0.0
        loop_updated_scored_steps += len(loop_u_values)
        loop_updated_positive_steps += len(loop_u_positive_steps)
        if loop_u_positive_steps:
            loop_updated_positive_tasks += 1
        grounding = low_grounding_summary(steps, high_threshold=high, medium_threshold=medium)
        res["low_grounding_count"] = grounding["count"]
        res["min_grounding"] = grounding["min_grounding"]
        res["has_low_grounding"] = grounding["has_issue"]
        res["low_grounding_detail"] = format_low_grounding_summary(grounding)
        sim_values = []
        sim_low_steps = []
        for step in steps:
            try:
                sim = float(step.get("element_step_similarity"))
            except (TypeError, ValueError):
                continue
            sim_values.append(sim)
            if sim < grounding_similarity_default_threshold:
                sim_low_steps.append({"step": step.get("step"), "value": sim})
        res["grounding_similarity_scored"] = len(sim_values)
        res["grounding_similarity_low_count"] = len(sim_low_steps)
        res["grounding_similarity_min"] = min(sim_values) if sim_values else None
        res["grounding_similarity_low_steps"] = sim_low_steps
        grounding_similarity_scored_steps += len(sim_values)
        grounding_similarity_low_steps += len(sim_low_steps)
        if sim_low_steps:
            grounding_similarity_low_tasks += 1
        res["grounding_boundary_metrics"] = grounding_boundary_metrics(steps, grounding_similarity_default_threshold)
        for key in grounding_boundary_totals:
            grounding_boundary_totals[key] += res["grounding_boundary_metrics"][key]
        # Per-task average GT / no-GT self-reported progress (None when not yet scored).
        res["avg_self_progress_gt"] = _avg_metric(steps, "self_progress_gt")
        res["avg_self_progress_no_gt"] = _avg_metric(steps, "self_progress_no_gt")
        step_metrics, loop_count = _step_metrics(steps, high_threshold=high, medium_threshold=medium)
            
        chart_trajectories.append({
            "sessionId": session_id,
            "goal": goal,
            "task_name": display_task_name(task),
            "startedAt": started_at_ms,
            "step_count": len(steps),
            "has_loop": loop_count >= 1,
            "steps": step_metrics,
            "status": status_str,
            "conf_source": "LLM Report"
        })
        
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
        "total_steps": total_steps,
        "grounding_similarity_default_threshold": grounding_similarity_default_threshold,
        "grounding_similarity_low_steps": grounding_similarity_low_steps,
        "grounding_similarity_scored_steps": grounding_similarity_scored_steps,
        "grounding_similarity_low_tasks": grounding_similarity_low_tasks,
        "grounding_boundary_metrics": grounding_boundary_metrics([], grounding_similarity_default_threshold),
        "loop_updated_positive_steps": loop_updated_positive_steps,
        "loop_updated_positive_tasks": loop_updated_positive_tasks,
        "loop_updated_scored_steps": loop_updated_scored_steps,
        "success_rate": round(success_rate, 1),
        "error_stats": error_stats,
    }
    gb = stats["grounding_boundary_metrics"]
    gb.update(grounding_boundary_totals)
    gb["total"] = gb["tp"] + gb["tn"] + gb["fp"] + gb["fn"]
    gb["correct"] = gb["tp"] + gb["tn"]
    gb["incorrect"] = gb["fp"] + gb["fn"]
    gb["accuracy"] = _ratio(gb["correct"], gb["total"])
    gb["precision"] = _ratio(gb["tp"], gb["tp"] + gb["fp"])
    gb["recall"] = _ratio(gb["tp"], gb["tp"] + gb["fn"])
    gb["f1"] = (2 * gb["precision"] * gb["recall"] / (gb["precision"] + gb["recall"])) if gb["precision"] is not None and gb["recall"] is not None and (gb["precision"] + gb["recall"]) else None

    timing = _run_timing(run)
    subgoal_rerun_summary = None
    if request.args.get("subgoal_rerun") == "1":
        subgoal_rerun_summary = {
            "tasks": request.args.get("subgoal_tasks", "0"),
            "steps": request.args.get("subgoal_steps", "0"),
            "skipped": request.args.get("subgoal_skipped", "0"),
        }

    selfreport_rerun_summary = None
    if request.args.get("selfreport_rerun") == "1":
        selfreport_rerun_summary = _selfreport_reports.pop(run_id, {
            "which": "both", "model": run.get("task_model"),
            "tasks_updated": 0, "tasks_skipped": 0, "steps_scored": 0, "reports": [],
        })

    goalrel_rerun_summary = None
    if request.args.get("goalrel_rerun") == "1":
        goalrel_rerun_summary = {
            "tasks": request.args.get("goalrel_tasks", "0"),
            "steps": request.args.get("goalrel_steps", "0"),
            "skipped": request.args.get("goalrel_skipped", "0"),
            "reason": request.args.get("goalrel_reason", ""),
        }

    grounding_rerun_summary = None
    if request.args.get("grounding_rerun") == "1":
        grounding_rerun_summary = {
            "tasks": request.args.get("grounding_tasks", "0"),
            "steps": request.args.get("grounding_steps", "0"),
            "skipped": request.args.get("grounding_skipped", "0"),
            "reason": request.args.get("grounding_reason", ""),
        }

    return render_template('run_detail.html', run=run, results=results, stats=stats, chart_trajectories=chart_trajectories, timing=timing, region_capture_mode_label=region_capture_mode_label, subgoal_rerun_summary=subgoal_rerun_summary, selfreport_rerun_summary=selfreport_rerun_summary, goalrel_rerun_summary=goalrel_rerun_summary, grounding_rerun_summary=grounding_rerun_summary)

@app.route('/artifacts/<path:filename>')
def serve_artifacts(filename):
    return send_from_directory(str(REPO_ROOT), filename)

@app.route('/runs/delete', methods=['POST'])
def delete_runs():
    for run_id in request.form.getlist('run_ids'):
        clear_run(run_id)
    return redirect(url_for("dashboard") + "?tab=automatic")

@app.route('/runs/<run_id>/subgoal-progress/rerun', methods=['POST'])
def rerun_run_subgoal_progress(run_id):
    run = load_run(run_id)
    if not run:
        abort(404)
    if is_running(run_id) or run.get("status") == "running":
        abort(400, "Subgoal Progress can only be rerun when the run is not running.")

    tasks_dir = os.path.join(RUNS_DIR, run_id, 'tasks')
    if not os.path.exists(tasks_dir):
        abort(404, "No task results found for this run.")

    tasks_updated = 0
    tasks_skipped = 0
    steps_scored = 0
    for task_file in os.listdir(tasks_dir):
        if not task_file.endswith('.json'):
            continue
        filepath = os.path.join(tasks_dir, task_file)
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                trajectory = json.load(f)
            if 'steps' not in trajectory:
                trajectory['steps'] = []
            summary = rerun_trajectory_subgoal_progress(trajectory)
            if summary["updated"]:
                with open(filepath, 'w', encoding='utf-8') as f:
                    json.dump(trajectory, f, indent=2, ensure_ascii=False)
                tasks_updated += 1
                steps_scored += summary["steps_scored"]
            else:
                tasks_skipped += 1
        except Exception:
            tasks_skipped += 1

    return redirect(url_for(
        "run_detail",
        run_id=run_id,
        subgoal_rerun="1",
        subgoal_tasks=tasks_updated,
        subgoal_steps=steps_scored,
        subgoal_skipped=tasks_skipped,
    ))

@app.route('/runs/<run_id>/progress-selfreport/rerun', methods=['POST'])
def rerun_run_progress_self_report(run_id):
    run = load_run(run_id)
    if not run:
        abort(404)
    if is_running(run_id) or run.get("status") == "running":
        abort(400, "Self-report progress can only be rerun when the run is not running.")

    tasks_dir = os.path.join(RUNS_DIR, run_id, 'tasks')
    if not os.path.exists(tasks_dir):
        abort(404, "No task results found for this run.")

    which = request.form.get("which")
    which = which if which in ("gt", "nogt", "both") else "both"
    # Use the same model the run used to drive the agent.
    model = run.get("task_model")

    reports = []
    tasks_updated = 0
    tasks_skipped = 0
    steps_scored = 0
    for task_file in sorted(os.listdir(tasks_dir)):
        if not task_file.endswith('.json'):
            continue
        filepath = os.path.join(tasks_dir, task_file)
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                trajectory = json.load(f)
            if 'steps' not in trajectory:
                trajectory['steps'] = []
            task = trajectory.get('task') or {}
            name = task.get('name') or task.get('task') or trajectory.get('task_id') or task_file
            summary = rerun_trajectory_progress_self_report(trajectory, which=which, model=model)
            if summary["updated"]:
                with open(filepath, 'w', encoding='utf-8') as f:
                    json.dump(trajectory, f, indent=2, ensure_ascii=False)
                tasks_updated += 1
                steps_scored += summary["steps_scored"]
                reports.append({"name": name, "status": "scored",
                                "steps": summary["steps_scored"], "reason": "",
                                "details": summary.get("details", [])})
            else:
                tasks_skipped += 1
                reports.append({"name": name, "status": "skipped",
                                "steps": 0, "reason": summary.get("reason", "")})
        except Exception as exc:
            tasks_skipped += 1
            reports.append({"name": task_file, "status": "skipped", "steps": 0,
                            "reason": f"error: {exc}"})

    _selfreport_reports[run_id] = {
        "which": which, "model": model,
        "tasks_updated": tasks_updated, "tasks_skipped": tasks_skipped,
        "steps_scored": steps_scored, "reports": reports,
    }
    return redirect(url_for("run_detail", run_id=run_id, selfreport_rerun="1"))

@app.route('/runs/<run_id>/goal-relevance/rerun', methods=['POST'])
def rerun_run_goal_relevance(run_id):
    run = load_run(run_id)
    if not run:
        abort(404)
    if is_running(run_id) or run.get("status") == "running":
        abort(400, "Goal relevance can only be rerun when the run is not running.")

    tasks_dir = os.path.join(RUNS_DIR, run_id, 'tasks')
    if not os.path.exists(tasks_dir):
        abort(404, "No task results found for this run.")

    model = run.get("task_model")
    client = SpecProgressClient(chat_model=model) if model else SpecProgressClient()
    if not client.available:
        return redirect(url_for(
            "run_detail",
            run_id=run_id,
            goalrel_rerun="1",
            goalrel_tasks=0,
            goalrel_steps=0,
            goalrel_skipped=0,
            goalrel_reason="OPENROUTER_API_KEY is not configured",
        ))

    tasks_updated = 0
    tasks_skipped = 0
    steps_scored = 0
    for task_file in sorted(os.listdir(tasks_dir)):
        if not task_file.endswith('.json'):
            continue
        filepath = os.path.join(tasks_dir, task_file)
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                trajectory = json.load(f)
            summary = rerun_trajectory_goal_relevance(trajectory, client)
            if summary["updated"]:
                with open(filepath, 'w', encoding='utf-8') as f:
                    json.dump(trajectory, f, indent=2, ensure_ascii=False)
                tasks_updated += 1
                steps_scored += summary["steps_scored"]
            else:
                tasks_skipped += 1
        except Exception:
            tasks_skipped += 1

    return redirect(url_for(
        "run_detail",
        run_id=run_id,
        goalrel_rerun="1",
        goalrel_tasks=tasks_updated,
        goalrel_steps=steps_scored,
        goalrel_skipped=tasks_skipped,
        goalrel_reason="" if tasks_updated else "no instruction-bearing grounding steps to embed",
    ))

@app.route('/runs/<run_id>/grounding-similarity/rerun', methods=['POST'])
def rerun_run_grounding_similarity(run_id):
    run = load_run(run_id)
    if not run:
        abort(404)
    if is_running(run_id) or run.get("status") == "running":
        abort(400, "Grounding similarity can only be rerun when the run is not running.")

    tasks_dir = os.path.join(RUNS_DIR, run_id, 'tasks')
    if not os.path.exists(tasks_dir):
        abort(404, "No task results found for this run.")

    client = SpecProgressClient()
    if not client.available:
        return redirect(url_for(
            "run_detail",
            run_id=run_id,
            grounding_rerun="1",
            grounding_tasks=0,
            grounding_steps=0,
            grounding_skipped=0,
            grounding_reason="OPENROUTER_API_KEY is not configured",
        ))

    tasks_updated = 0
    tasks_skipped = 0
    steps_scored = 0
    for task_file in sorted(os.listdir(tasks_dir)):
        if not task_file.endswith('.json'):
            continue
        filepath = os.path.join(tasks_dir, task_file)
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                trajectory = json.load(f)
            summary = rerun_trajectory_grounding_similarity(trajectory, client)
            if summary["updated"]:
                with open(filepath, 'w', encoding='utf-8') as f:
                    json.dump(trajectory, f, indent=2, ensure_ascii=False)
                tasks_updated += 1
                steps_scored += summary["steps_scored"]
            else:
                tasks_skipped += 1
        except Exception:
            tasks_skipped += 1

    return redirect(url_for(
        "run_detail",
        run_id=run_id,
        grounding_rerun="1",
        grounding_tasks=tasks_updated,
        grounding_steps=steps_scored,
        grounding_skipped=tasks_skipped,
        grounding_reason="" if tasks_updated else "no indexed instruction/element-text steps to embed",
    ))

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


@app.route('/trajectory/<session_id>/subgoal-progress/rerun', methods=['POST'])
def rerun_trajectory_subgoal_progress_route(session_id):
    filepath, run_id = _resolve_trajectory_path(session_id)
    if not filepath:
        abort(404)
    if run_id and is_running(run_id):
        abort(400, "Subgoal Progress can only be rerun when the backing run is not running.")

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            trajectory = json.load(f)
        if 'steps' not in trajectory:
            trajectory['steps'] = []
        summary = rerun_trajectory_subgoal_progress(trajectory)
        if summary["updated"]:
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(trajectory, f, indent=2, ensure_ascii=False)
        return redirect(url_for(
            "trajectory_detail",
            session_id=session_id,
            subgoal_rerun="1",
            subgoal_updated="1" if summary["updated"] else "0",
            subgoal_steps=summary["steps_scored"],
        ))
    except Exception:
        abort(500)


@app.route('/trajectory/<session_id>/progress-selfreport/rerun', methods=['POST'])
def rerun_trajectory_progress_self_report_route(session_id):
    filepath, run_id = _resolve_trajectory_path(session_id)
    if not filepath:
        abort(404)
    if run_id and is_running(run_id):
        abort(400, "Self-report progress can only be rerun when the backing run is not running.")

    which = request.form.get("which")
    which = which if which in ("gt", "nogt", "both") else "both"
    # Use the model the backing run drove the agent with, when available.
    model = (load_run(run_id) or {}).get("task_model") if run_id else None
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            trajectory = json.load(f)
        if 'steps' not in trajectory:
            trajectory['steps'] = []
        summary = rerun_trajectory_progress_self_report(trajectory, which=which, model=model)
        if summary["updated"]:
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(trajectory, f, indent=2, ensure_ascii=False)
        return redirect(url_for(
            "trajectory_detail",
            session_id=session_id,
            selfreport_rerun="1",
            selfreport_which=which,
            selfreport_updated="1" if summary["updated"] else "0",
            selfreport_steps=summary["steps_scored"],
            selfreport_reason=summary.get("reason", ""),
        ))
    except Exception:
        abort(500)


@app.route('/trajectory/<session_id>/goal-relevance/rerun', methods=['POST'])
def rerun_trajectory_goal_relevance_route(session_id):
    filepath, run_id = _resolve_trajectory_path(session_id)
    if not filepath:
        abort(404)
    if run_id and is_running(run_id):
        abort(400, "Goal relevance can only be rerun when the backing run is not running.")

    # Predict the goal with the same model the run drove the agent with, when available.
    model = (load_run(run_id) or {}).get("task_model") if run_id else None
    client = SpecProgressClient(chat_model=model) if model else SpecProgressClient()
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            trajectory = json.load(f)
        summary = rerun_trajectory_goal_relevance(trajectory, client)
        if summary["updated"]:
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(trajectory, f, indent=2, ensure_ascii=False)
        return redirect(url_for(
            "trajectory_detail",
            session_id=session_id,
            goalrel_rerun="1",
            goalrel_updated="1" if summary["updated"] else "0",
            goalrel_steps=summary["steps_scored"],
            goalrel_reason=summary.get("reason", ""),
        ))
    except Exception:
        abort(500)


@app.route('/trajectory/<session_id>/grounding-similarity/rerun', methods=['POST'])
def rerun_trajectory_grounding_similarity_route(session_id):
    filepath, run_id = _resolve_trajectory_path(session_id)
    if not filepath:
        abort(404)
    if run_id and is_running(run_id):
        abort(400, "Grounding similarity can only be rerun when the backing run is not running.")

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            trajectory = json.load(f)
        summary = rerun_trajectory_grounding_similarity(trajectory)
        if summary["updated"]:
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(trajectory, f, indent=2, ensure_ascii=False)
        return redirect(url_for(
            "trajectory_detail",
            session_id=session_id,
            grounding_rerun="1",
            grounding_updated="1" if summary["updated"] else "0",
            grounding_steps=summary["steps_scored"],
            grounding_reason=summary.get("reason", ""),
        ))
    except Exception:
        abort(500)


@app.route('/runs/<run_id>/thresholds', methods=['POST'])
def update_server_run_thresholds(run_id):
    from eval_tool.storage import save_run, save_task_result
    run = load_run(run_id)
    if not run:
        abort(404)
        
    high_val = request.form.get("grounding_high_threshold")
    med_val = request.form.get("grounding_medium_threshold")
    
    try:
        high = float(high_val) if high_val else None
        med = float(med_val) if med_val else None
    except ValueError:
        abort(400, "Thresholds must be floating point numbers.")
        
    if high is not None:
        run["grounding_high_threshold"] = high
    else:
        run.pop("grounding_high_threshold", None)
        
    if med is not None:
        run["grounding_medium_threshold"] = med
    else:
        run.pop("grounding_medium_threshold", None)
        
    save_run(run)
    
    # Touch all task files under this run to update their mtime so dashboard cache is invalidated
    for result in list_task_results(run_id):
        task_id = result.get("task", {}).get("task_id")
        if task_id:
            save_task_result(run_id, task_id, result)
            
    target = request.form.get("next") or url_for("run_detail", run_id=run_id)
    return redirect(target)


@app.route('/trajectory/<session_id>/thresholds', methods=['POST'])
def update_trajectory_thresholds(session_id):
    filepath, run_id = _resolve_trajectory_path(session_id)
    if not filepath:
        abort(404)
        
    clear_override = request.form.get("clear_override") == "true"
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            trajectory = json.load(f)
            
        if clear_override:
            trajectory.pop("grounding_high_threshold", None)
            trajectory.pop("grounding_medium_threshold", None)
        else:
            high_val = request.form.get("grounding_high_threshold")
            med_val = request.form.get("grounding_medium_threshold")
            try:
                high = float(high_val) if high_val else None
                med = float(med_val) if med_val else None
            except ValueError:
                abort(400, "Thresholds must be floating point numbers.")
                
            if high is not None:
                trajectory["grounding_high_threshold"] = high
            else:
                trajectory.pop("grounding_high_threshold", None)
                
            if med is not None:
                trajectory["grounding_medium_threshold"] = med
            else:
                trajectory.pop("grounding_medium_threshold", None)
                
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(trajectory, f, indent=2, ensure_ascii=False)
            
        target = request.form.get("next") or url_for("trajectory_detail", session_id=session_id)
        return redirect(target)
    except Exception:
        abort(500)


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

        trajectory['spec_goal_text'] = infer_predicted_goal_state(trajectory)
        
        # Get active thresholds from task/trajectory first, then fallback to run-wide ones if trajectory belongs to a run.
        run_high = None
        run_medium = None
        if run_id:
            run_obj = load_run(run_id) or {}
            run_high = run_obj.get("grounding_high_threshold")
            run_medium = run_obj.get("grounding_medium_threshold")
        
        high_threshold = trajectory.get("grounding_high_threshold") or run_high
        medium_threshold = trajectory.get("grounding_medium_threshold") or run_medium
        grounding_boundary_threshold = high_threshold if high_threshold is not None else 0.8
        
        # Backfill rule-based L_t_u, rule grounding, mechanical C_t and loop keys for the UI.
        backfill_computed_loop(trajectory)
        for step in trajectory.get('steps', []):
            if step.get('isInitial'):
                continue
            step['rule_grounding'] = g_grounding(step, high_threshold=high_threshold, medium_threshold=medium_threshold)
            step['mech_confidence'] = compute_spec_confidence(step, formula="spec_noprogress", high_threshold=high_threshold, medium_threshold=medium_threshold)
            step['action_key'] = _action_key(step)
            step['action_key_updated'] = _action_key_updated(step)
            step['dom_element_text'] = _element_text(step)
        # Only expose the "Agent Response" toggle once a GT/no-GT rerun has produced reasons.
        trajectory['has_self_report'] = any(
            s.get('self_progress_gt_reason') or s.get('self_progress_no_gt_reason')
            for s in trajectory.get('steps', [])
        )
        trajectory['grounding_boundary_metrics'] = grounding_boundary_metrics(
            trajectory.get('steps', []),
            grounding_boundary_threshold,
        )
        enrich_subgoal_breakdown(trajectory)

        star = load_stars().get(session_id)

        evaluation, evaluation_source = evaluation_for_inspector(trajectory)
        trajectory['evaluation'] = evaluation
        trajectory['evaluation_source'] = evaluation_source
        judge = trajectory.get('judge') or {}
        trajectory['judge_success'] = judge.get('success')

        subgoal_rerun_summary = None
        if request.args.get("subgoal_rerun") == "1":
            subgoal_rerun_summary = {
                "updated": request.args.get("subgoal_updated") == "1",
                "steps": request.args.get("subgoal_steps", "0"),
            }

        selfreport_rerun_summary = None
        if request.args.get("selfreport_rerun") == "1":
            selfreport_rerun_summary = {
                "which": request.args.get("selfreport_which", "both"),
                "updated": request.args.get("selfreport_updated") == "1",
                "steps": request.args.get("selfreport_steps", "0"),
                "reason": request.args.get("selfreport_reason", ""),
            }

        goalrel_rerun_summary = None
        if request.args.get("goalrel_rerun") == "1":
            goalrel_rerun_summary = {
                "updated": request.args.get("goalrel_updated") == "1",
                "steps": request.args.get("goalrel_steps", "0"),
                "reason": request.args.get("goalrel_reason", ""),
            }

        grounding_rerun_summary = None
        if request.args.get("grounding_rerun") == "1":
            grounding_rerun_summary = {
                "updated": request.args.get("grounding_updated") == "1",
                "steps": request.args.get("grounding_steps", "0"),
                "reason": request.args.get("grounding_reason", ""),
            }

        return render_template('inspector.html', trajectory=trajectory, run_id=run_id, run_high=run_high, run_medium=run_medium, star=star, subgoal_rerun_summary=subgoal_rerun_summary, selfreport_rerun_summary=selfreport_rerun_summary, goalrel_rerun_summary=goalrel_rerun_summary, grounding_rerun_summary=grounding_rerun_summary)
    except Exception:
        abort(500)

@app.route('/api/grounding_metrics', methods=['POST', 'OPTIONS'])
def api_grounding_metrics():
    if request.method == 'OPTIONS':
        return '', 204
    try:
        payload = request.json or {}
        run_ids = payload.get("run_ids", [])
        try:
            threshold = float(payload.get("threshold", 0.8))
        except (ValueError, TypeError):
            threshold = 0.8

        metrics_by_model = {}
        for run_id in run_ids:
            run = load_run(run_id)
            if not run:
                continue
            model = run.get("task_model", "Unknown")
            # Simplify model name (e.g. openai/gpt-4o -> GPT4o, google/gemini-2.5-flash-lite -> Gemini, qwen/qwen3.6-flash -> Qwen)
            if "gpt-4o" in model.lower():
                model_name = "GPT4o"
            elif "gemini" in model.lower():
                model_name = "Gemini"
            elif "qwen" in model.lower():
                model_name = "Qwen"
            else:
                model_name = model.split("/")[-1].capitalize() if "/" in model else model.capitalize()

            if model_name not in metrics_by_model:
                metrics_by_model[model_name] = []

            run_tasks_dir = os.path.join(RUNS_DIR, run_id, 'tasks')
            if not os.path.exists(run_tasks_dir):
                continue

            for filename in os.listdir(run_tasks_dir):
                if not filename.endswith('.json'):
                    continue
                filepath = os.path.join(run_tasks_dir, filename)
                try:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    
                    for step in data.get("steps", []):
                        if step.get("isInitial"):
                            continue
                        try:
                            sim = float(step.get("element_step_similarity"))
                        except (TypeError, ValueError):
                            continue
                        human_label = _grounding_human_label(step)
                        metrics_by_model[model_name].append((sim, human_label == "grounded"))
                except Exception:
                    pass

        # Create Average pseudo-model
        all_steps = []
        for steps in metrics_by_model.values():
            all_steps.extend(steps)
        if all_steps:
            metrics_by_model["Average"] = all_steps

        response_data = {}
        for m_name, steps in metrics_by_model.items():
            # For the active threshold:
            tp = sum(1 for s, h in steps if h and s >= threshold)
            tn = sum(1 for s, h in steps if not h and s < threshold)
            fp = sum(1 for s, h in steps if not h and s >= threshold)
            fn = sum(1 for s, h in steps if h and s < threshold)
            total_scored = len(steps)
            
            # ROC and AUC
            roc_curve = []
            for i in range(101):
                t = i / 100.0
                c_tp = sum(1 for s, h in steps if h and s >= t)
                c_tn = sum(1 for s, h in steps if not h and s < t)
                c_fp = sum(1 for s, h in steps if not h and s >= t)
                c_fn = sum(1 for s, h in steps if h and s < t)
                tpr = c_tp / (c_tp + c_fn) if (c_tp + c_fn) > 0 else 0.0
                fpr = c_fp / (c_fp + c_tn) if (c_fp + c_tn) > 0 else 0.0
                roc_curve.append({"threshold": t, "tpr": tpr, "fpr": fpr})
                
            # AUC using trapezoidal rule
            auc = 0.0
            roc_sorted = sorted(roc_curve, key=lambda x: (x["fpr"], x["tpr"]))
            for i in range(1, len(roc_sorted)):
                fpr1, tpr1 = roc_sorted[i-1]["fpr"], roc_sorted[i-1]["tpr"]
                fpr2, tpr2 = roc_sorted[i]["fpr"], roc_sorted[i]["tpr"]
                auc += (fpr2 - fpr1) * (tpr1 + tpr2) / 2.0
                
            # Optimal threshold (Youden's J statistic)
            best_t = 0.8
            best_j = -1
            for pt in roc_curve:
                j = pt["tpr"] - pt["fpr"]
                if j > best_j:
                    best_j = j
                    best_t = pt["threshold"]
                    
            # Calculate min grounded and max misgrounded
            grounded_sims = [s for s, h in steps if h]
            misgrounded_sims = [s for s, h in steps if not h]
            
            min_grounded = min(grounded_sims) if grounded_sims else None
            max_misgrounded = max(misgrounded_sims) if misgrounded_sims else None

            response_data[m_name] = {
                "tp": tp, "tn": tn, "fp": fp, "fn": fn,
                "total_scored_steps": total_scored,
                "roc": roc_curve,
                "auc": auc,
                "optimal_threshold": best_t,
                "min_grounded": min_grounded,
                "max_misgrounded": max_misgrounded
            }

        return jsonify(response_data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=True)
