from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

from flask import Flask, abort, redirect, render_template, request, send_from_directory, url_for

from .ece import ece_payload
from .judge import MODEL_OPTIONS, LlmJudge, configured_judge_model, normalize_model
from .runner import DEFAULT_MAX_STEPS, configured_task_model, create_run, is_running, normalize_max_steps, start_run, stop_run
from .scoring import ALL_FORMULAS, chart_payload, compute_confidence, effective_success
from .step_confidence import SpecProgressClient, backfill_g_progress
from .storage import (
    REPO_ROOT,
    current_data_csv,
    load_run,
    load_task_result,
    list_runs,
    list_task_results,
    normalize_task_set,
    save_run,
    save_task_result,
    task_set_options,
    utc_now,
)
from .tasks import load_tasks, tasks_by_id


DEFAULT_TASK_COUNT = 2

# Tasks selected by default (matched against the CSV `name`/`task`, case-insensitive).
DEFAULT_TASK_NAMES = ["expedia"]


def default_tasks(tasks: list) -> list:
    selected = []
    for keyword in DEFAULT_TASK_NAMES:
        for task in tasks:
            if keyword in (task.name or "").lower() or keyword in (task.task or "").lower():
                if task not in selected:
                    selected.append(task)
                break
    if selected:
        return selected
    return tasks[-DEFAULT_TASK_COUNT:]


def reconcile_run(run: dict) -> dict:
    """Mark a run as interrupted if it claims to be running but no live thread owns it.

    A run executes in a background thread inside this Flask process. If the process was
    restarted (e.g. by the debug reloader) the thread dies but the on-disk status is left at
    'running'. Detect that here so the dashboard doesn't show a dead run as still in progress.
    """
    if run.get("status") == "running" and not is_running(run.get("run_id", "")):
        run = save_run({**run, "status": "interrupted", "completed_at": run.get("completed_at") or utc_now(),
                        "error": run.get("error") or "Run was interrupted (server restarted while it was running)."})
    return run


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["SECRET_KEY"] = "pageguide-eval-local"

    @app.template_filter("fmt")
    def fmt(value):
        if value is None:
            return "—"
        try:
            return f"{float(value):.2f}"
        except Exception:
            return str(value)

    @app.template_global("fmt")
    def fmt_global(value):
        return fmt(value)

    @app.template_global("pct")
    def pct(value):
        if value is None:
            return "—"
        try:
            return f"{float(value) * 100:.0f}%"
        except Exception:
            return "—"

    @app.get("/")
    def index():
        task_set = normalize_task_set(request.args.get("task_set"))
        tasks = load_tasks(task_set)
        runs = [reconcile_run(run) for run in list_runs()[:8]]
        selected = {task.task_id for task in default_tasks(tasks)}
        return render_template(
            "index.html",
            tasks=tasks,
            runs=runs,
            selected=selected,
            task_set=task_set,
            task_set_options=task_set_options(),
            csv_path=current_data_csv(task_set),
            default_max_steps=DEFAULT_MAX_STEPS,
            model_options=MODEL_OPTIONS,
            default_task_model=configured_task_model(),
            default_judge_model=configured_judge_model(),
        )

    @app.post("/runs")
    def create_eval_run():
        task_set = normalize_task_set(request.form.get("task_set"))
        selected = request.form.getlist("task_ids")
        if not selected:
            all_tasks = load_tasks(task_set)
            selected = [task.task_id for task in default_tasks(all_tasks)]
        task_map = tasks_by_id(task_set)
        tasks = [task_map[task_id] for task_id in selected if task_id in task_map]
        if not tasks:
            abort(400, "No valid tasks selected.")
        max_steps = normalize_max_steps(request.form.get("max_steps"))
        task_model = normalize_model(request.form.get("task_model"))
        judge_model = normalize_model(request.form.get("judge_model"))
        run = create_run([task.task_id for task in tasks])
        run = save_run({
            **run,
            "task_set": task_set,
            "csv_path": str(current_data_csv(task_set)),
            "max_steps": max_steps,
            "task_model": task_model,
            "judge_model": judge_model,
        })
        start_run(run, tasks)
        return redirect(url_for("run_detail", run_id=run["run_id"]))

    @app.post("/runs/rerun-current-csv")
    def rerun_current_csv():
        task_set = normalize_task_set(request.args.get("task_set") or request.form.get("task_set"))
        tasks = default_tasks(load_tasks(task_set))
        if not tasks:
            abort(400, "No runnable tasks found in the current CSV.")
        max_steps = normalize_max_steps(request.args.get("max_steps") or request.form.get("max_steps"))
        task_model = normalize_model(request.args.get("task_model") or request.form.get("task_model") or configured_task_model())
        judge_model = normalize_model(request.args.get("judge_model") or request.form.get("judge_model") or configured_judge_model())
        run = create_run([task.task_id for task in tasks])
        run = save_run({
            **run,
            "task_set": task_set,
            "csv_path": str(current_data_csv(task_set)),
            "max_steps": max_steps,
            "task_model": task_model,
            "judge_model": judge_model,
        })
        start_run(run, tasks)
        return redirect(url_for("run_detail", run_id=run["run_id"]))

    @app.post("/runs/<run_id>/rerun-with-gt")
    def rerun_with_gt(run_id: str):
        source = load_run(run_id)
        if not source:
            abort(404)
        task_set = normalize_task_set(source.get("task_set"))
        task_map = tasks_by_id(task_set)
        task_ids = [tid for tid in (source.get("task_ids") or []) if tid in task_map]
        tasks = [task_map[tid] for tid in task_ids]
        if not tasks:
            abort(400, "No tasks from this run are available to re-run with ground truth.")
        run = create_run(task_ids)
        run = save_run({
            **run,
            "task_set": task_set,
            "csv_path": source.get("csv_path") or str(current_data_csv(task_set)),
            "max_steps": source.get("max_steps") or DEFAULT_MAX_STEPS,
            "task_model": source.get("task_model") or configured_task_model(),
            "judge_model": source.get("judge_model") or configured_judge_model(),
            "ground_truth_mode": True,
            "gt_of": run_id,
        })
        start_run(run, tasks)
        return redirect(url_for("run_detail", run_id=run["run_id"]))

    @app.get("/runs/<run_id>")
    def run_detail(run_id: str):
        run = load_run(run_id)
        if not run:
            abort(404)
        run = reconcile_run(run)
        running = is_running(run_id)
        results = list_task_results(run_id)
        summary = summarize_results(results)
        payload = chart_payload(results)
        # Calibration charts (Plots A/C/D/E) live on the run page. Compute the spec
        # progress embeddings once, but only when the run is idle so the 3s live
        # refresh during a run never triggers network calls.
        if not running and request.args.get("embed") != "0":
            backfill_spec_progress(run_id, results)
        cal_aggregate = chart_payload(results, formulas=ALL_FORMULAS)["aggregate"]
        ece = {
            "spec_full": ece_payload(results, "spec_full"),
            "full": ece_payload(results, "full"),
        }
        compare = None
        compare_id = request.args.get("compare")
        if compare_id and load_run(compare_id):
            other = list_task_results(compare_id)
            compare = {
                "this_id": run_id,
                "other_id": compare_id,
                "this": chart_payload(results, formulas=["full"])["aggregate"],
                "other": chart_payload(other, formulas=["full"])["aggregate"],
            }
        return render_template(
            "run.html",
            run=run,
            results=results,
            summary=summary,
            payload=payload,
            cal_aggregate=cal_aggregate,
            ece=ece,
            compare=compare,
            filter_options=filter_options(results, summary),
            running=running,
        )

    @app.post("/runs/<run_id>/stop")
    def stop_eval_run(run_id: str):
        run = load_run(run_id)
        if not run:
            abort(404)
        if run.get("status") == "running" or is_running(run_id):
            stop_run(run_id)
        return redirect(url_for("run_detail", run_id=run_id))

    @app.get("/runs/<run_id>/tasks/<task_id>")
    def task_detail(run_id: str, task_id: str):
        run = load_run(run_id)
        result = load_task_result(run_id, task_id)
        if not run or not result:
            abort(404)
        return render_template("task.html", run=run, result=result)

    @app.get("/runs/<run_id>/charts")
    def charts(run_id: str):
        # Charts now render inline on the run page; keep this route as a redirect so
        # existing links/bookmarks land on the calibration section.
        compare = request.args.get("compare")
        return redirect(url_for("run_detail", run_id=run_id, compare=compare) + "#calibration")

    @app.post("/runs/<run_id>/tasks/<task_id>/label")
    def set_task_label(run_id: str, task_id: str):
        if not load_run(run_id):
            abort(404)
        result = load_task_result(run_id, task_id)
        if not result:
            abort(404)
        value = (request.form.get("human_success") or "").strip().lower()
        if value in {"true", "success", "1", "yes"}:
            result["human_success"] = True
        elif value in {"false", "fail", "failed", "0", "no"}:
            result["human_success"] = False
        else:  # "clear" / anything else removes the override
            result.pop("human_success", None)
        save_task_result(run_id, task_id, result)
        target = request.form.get("next") or url_for("task_detail", run_id=run_id, task_id=task_id)
        return redirect(target)

    @app.get("/runs/<run_id>/phase3")
    def phase3(run_id: str):
        run = load_run(run_id)
        if not run:
            abort(404)
        results = list_task_results(run_id)
        rows = build_phase3_rows(results)
        return render_template("phase3.html", run=run, rows=rows)

    @app.post("/runs/<run_id>/phase3/judge")
    def judge_phase3(run_id: str):
        run = load_run(run_id)
        if not run:
            abort(404)
        force = request.form.get("force") == "1"
        judge = LlmJudge()
        for result in list_task_results(run_id):
            task = result.get("task", {})
            steps = result.get("steps", [])
            changed = False
            for index, step in enumerate(steps):
                if step.get("isInitial") or int(step.get("step") or 0) <= 0:
                    continue
                if step.get("progress_ground_truth") is not None and not force:
                    continue
                observed_so_far = [
                    s for s in steps[: index + 1]
                    if not s.get("isInitial") and int(s.get("step") or 0) > 0
                ]
                progress = judge.judge_progress_with_ground_truth(task, step, observed_so_far)
                step["progress_ground_truth"] = progress.get("progress_ground_truth")
                step["progress_ground_truth_judge"] = progress
                if progress.get("progress_ground_truth") is not None:
                    step["confidence_versions"] = {
                        **(step.get("confidence_versions") or {}),
                        "full_ground_truth": compute_confidence(
                            {**step, "progress": progress.get("progress_ground_truth")},
                            "full",
                        ),
                    }
                changed = True
            if changed:
                save_task_result(run_id, result.get("task_id"), result)
        return redirect(url_for("phase3", run_id=run_id))

    @app.get("/artifacts/<path:path>")
    def artifacts(path: str):
        full = (REPO_ROOT / path).resolve()
        if not str(full).startswith(str(REPO_ROOT.resolve())) or not full.exists():
            abort(404)
        return send_from_directory(REPO_ROOT, path)

    return app


def backfill_spec_progress(run_id: str, results: list[dict]) -> None:
    """Compute + persist the new-spec g_progress embeddings for any task missing
    them. Non-fatal: a missing key or network error leaves the neutral fallback.
    """
    client = SpecProgressClient()
    if not client.available:
        return
    for result in results:
        try:
            if backfill_g_progress(result, client):
                save_task_result(run_id, result.get("task_id"), result)
        except Exception:
            # Calibration must never be blocked by an embedding hiccup.
            continue


def summarize_results(results: list[dict]) -> dict:
    success = [r for r in results if effective_success(r)]
    failed = [r for r in results if not effective_success(r)]
    categories: dict[str, int] = {}
    for result in failed:
        category = result.get("judge", {}).get("failureCategory") or result.get("terminal_reason") or "UNKNOWN FAILURE"
        categories[category] = categories.get(category, 0) + 1
    return {
        "total": len(results),
        "success": len(success),
        "failed": len(failed),
        "success_rate": (len(success) / len(results) * 100) if results else 0,
        "categories": categories,
    }


def filter_options(results: list[dict], summary: dict) -> dict[str, list[dict[str, str]]]:
    levels: dict[str, str] = {}
    errors: dict[str, str] = {}
    for result in results:
        level = (result.get("task", {}).get("level") or "").strip()
        if level:
            levels.setdefault(level.lower(), level)
        if not result.get("judge", {}).get("success"):
            label = (
                result.get("judge", {}).get("failureCategory")
                or result.get("terminal_reason")
                or "UNKNOWN FAILURE"
            )
            errors.setdefault(str(label).lower(), str(label))
    for category in summary.get("categories", {}).keys():
        errors.setdefault(str(category).lower(), str(category))
    return {
        "levels": [{"value": key, "label": levels[key]} for key in sorted(levels)],
        "errors": [{"value": key, "label": errors[key]} for key in sorted(errors)],
    }


def build_phase3_rows(results: list[dict]) -> list[dict]:
    rows = []
    for result in results:
        task = result.get("task", {})
        for step in result.get("steps", []):
            if step.get("isInitial") or int(step.get("step") or 0) <= 0:
                continue
            progress_self = step.get("progress")
            gt = step.get("progress_ground_truth")
            deviation = None
            full_self = (step.get("confidence_versions") or {}).get("full")
            full_gt = (step.get("confidence_versions") or {}).get("full_ground_truth")
            if progress_self is not None and gt is not None:
                deviation = float(progress_self) - float(gt)
            if full_gt is None and gt is not None:
                full_gt = compute_confidence({**step, "progress": gt}, "full")
            rows.append({
                "task_id": result.get("task_id"),
                "task": task.get("task", ""),
                "step": step.get("step"),
                "instruction": step.get("instruction", ""),
                "progress_self": progress_self,
                "progress_ground_truth": gt,
                "deviation": deviation,
                "full_self": full_self,
                "full_ground_truth": full_gt,
                "full_deviation": (float(full_self) - float(full_gt)) if full_self is not None and full_gt is not None else None,
                "ground_truth_reason": (step.get("progress_ground_truth_judge") or {}).get("reason", ""),
                "reference_available": bool(task.get("reference_steps")),
            })
    return rows


app = create_app()


if __name__ == "__main__":
    # use_reloader=False: the file-watch reloader restarts the process on any code change,
    # which would kill in-flight evaluation threads. Keep the debugger but not the reloader.
    app.run(debug=True, port=5050, use_reloader=False)
