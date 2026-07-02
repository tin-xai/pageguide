from __future__ import annotations

from datetime import datetime
from statistics import mean
from typing import Any

from .step_confidence import SPEC_FORMULAS, compute_spec_confidence


LAMBDA_L = 0.8
LAMBDA_P = 0.3
FORMULAS = ("full", "reduced", "noloop")
# All families: LLM-self-reported (FORMULAS) + new-spec (SPEC_FORMULAS).
ALL_FORMULAS = FORMULAS + SPEC_FORMULAS
OPTIONAL_FORMULAS = ("full_ground_truth",)


def score_step(step: dict[str, Any], formula: str, high_threshold: float = None, medium_threshold: float = None) -> float | None:
    """Dispatch a step to the right confidence family."""
    if formula in SPEC_FORMULAS:
        return compute_spec_confidence(step, formula, high_threshold=high_threshold, medium_threshold=medium_threshold)
    return compute_confidence(step, formula)


def task_outcome(result: dict[str, Any]) -> str:
    """Return 'success', 'failed', or 'pending' for run tables."""
    human = result.get("human_success")
    if human is not None:
        return "success" if human else "failed"
    eval_status = (result.get("evaluation") or {}).get("status")
    if eval_status in {"success", "failed"}:
        return eval_status
    judge_success = (result.get("judge") or {}).get("success")
    if judge_success is True:
        return "success"
    if judge_success is False:
        return "failed"
    return "pending"


def effective_success(result: dict[str, Any]) -> bool:
    """Task correctness label for calibration.

    Human overrides and saved evaluations win over the LLM judge verdict so the
    ECE plots reflect corrected labels.
    """
    human = result.get("human_success")
    if human is not None:
        return human
    eval_outcome = (result.get("evaluation") or {}).get("status")
    if eval_outcome == "success":
        return True
    if eval_outcome == "failed":
        return False
    return bool((result.get("judge") or {}).get("success"))


def evaluation_for_inspector(trajectory: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """Build evaluation form state and source tag for the trajectory inspector."""
    saved = trajectory.get("evaluation") or {}
    if saved.get("status") in {"success", "failed"}:
        source = saved.get("source") or ("human" if trajectory.get("human_success") is not None else "saved")
        return dict(saved), source

    if trajectory.get("human_success") is not None:
        status = "success" if trajectory["human_success"] else "failed"
        return {"status": status, "error_types": [], "notes": ""}, "human"

    judge = trajectory.get("judge") or {}
    if judge.get("success") is True:
        return {
            "status": "success",
            "error_types": [],
            "notes": judge.get("reason") or judge.get("reasoning") or "",
        }, "llm_judge"
    if judge.get("success") is False:
        error_types = []
        category = judge.get("failureCategory")
        if category:
            error_types = [category]
        return {
            "status": "failed",
            "error_types": error_types,
            "notes": judge.get("reason") or judge.get("reasoning") or "",
        }, "llm_judge"

    return None, "none"


def apply_manual_evaluation(
    trajectory: dict[str, Any],
    *,
    status: str,
    error_types: list[str] | None = None,
    notes: str = "",
    llm_source: str | None = None,
    conf_source: str | None = None,
) -> dict[str, Any]:
    """Persist a human evaluation and sync outcome fields used by run summaries."""
    updated = dict(trajectory)
    updated["evaluation"] = {
        "status": status,
        "error_types": error_types or [] if status == "failed" else [],
        "notes": notes,
        "evaluatedAt": datetime.now().isoformat(timespec="seconds"),
        "source": "human",
    }
    updated["human_success"] = status == "success"
    if llm_source is not None:
        updated["llm_source"] = llm_source
    if conf_source is not None:
        updated["conf_source"] = conf_source
    return updated


def _num(value: Any, lo: float, hi: float, default: float | None) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def compute_confidence(parts: dict[str, Any], formula: str = "full") -> float | None:
    # "Full Confidence" is the primary metric: C_t = clip(G_grounding * (1 - 0.5 * L_t_u), 0, 1),
    # where G_grounding is the cosine element-step grounding (bucketed) and L_t_u is the updated
    # loop score. No progress term. This is identical to the spec_noprogress formula and to the
    # live extension's mechanical confidence (gv2ComputeMechanicalConfidence).
    if formula == "full":
        return compute_spec_confidence(parts, "spec_noprogress")

    # Legacy LLM-self-reported families (kept for comparison lines only).
    grounded = _num(parts.get("grounded"), 0.0, 1.0, None)
    loop = _num(parts.get("loop"), 0.0, 1.0, 0.0)
    progress = _num(parts.get("progress"), 0.0, 1.0, 0.0)
    if grounded is None:
        return None

    score = grounded
    if formula != "noloop":
        score *= 1 - LAMBDA_L * float(loop or 0.0)
    if formula != "reduced":
        score *= 1 + LAMBDA_P * float(progress or 0.0)
    return max(0.0, min(1.0, score))


def enrich_step_scores(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    enriched = []
    for step in steps:
        copy = dict(step)
        copy["confidence_versions"] = {
            formula: compute_confidence(step, formula)
            for formula in FORMULAS
        }
        enriched.append(copy)
    return enriched


def chart_payload(
    task_results: list[dict[str, Any]],
    formulas: tuple[str, ...] | list[str] | None = None,
    run_high: float = None,
    run_medium: float = None,
) -> dict[str, Any]:
    requested = list(formulas) if formulas is not None else list(FORMULAS)
    out_formulas = list(requested)
    task_series = []
    by_step: dict[int, dict[str, list[float]]] = {}
    progress_metrics = ("llm_progress", "subgoal_progress")

    for result in task_results:
        high = result.get("grounding_high_threshold")
        if high is None:
            high = run_high
        medium = result.get("grounding_medium_threshold")
        if medium is None:
            medium = run_medium

        points = []
        for step in result.get("steps", []):
            if step.get("isInitial") or int(step.get("step") or 0) <= 0:
                continue
            scores = {
                formula: score_step(step, formula, high_threshold=high, medium_threshold=medium)
                for formula in requested
            }
            progress_scores = {
                "llm_progress": step.get("progress"),
                "subgoal_progress": step.get("subgoal_progress"),
            }
            # Surface optional formulas already computed/stored (e.g. full_ground_truth).
            stored = step.get("confidence_versions") or {}
            for formula in OPTIONAL_FORMULAS:
                if stored.get(formula) is not None:
                    scores[formula] = stored[formula]
                    if formula not in out_formulas:
                        out_formulas.append(formula)
            step_number = int(step.get("step") or len(points) + 1)
            points.append({
                "step": step_number,
                **scores,
                **progress_scores,
                "subgoal_verified": step.get("subgoal_verified"),
                "subgoal_completion": step.get("subgoal_completion"),
            })
            bucket = by_step.setdefault(step_number, {})
            for formula, score in scores.items():
                if score is not None:
                    bucket.setdefault(formula, []).append(float(score))
            for metric in progress_metrics:
                score = progress_scores.get(metric)
                if score is not None:
                    bucket.setdefault(metric, []).append(float(score))
        task_series.append({
            "task_id": result.get("task_id"),
            "task": result.get("task", {}).get("task", ""),
            "success": effective_success(result),
            "points": points,
        })

    aggregate = []
    for step_number in sorted(by_step):
        aggregate.append({
            "step": step_number,
            **{
                formula: mean(values) if values else None
                for formula, values in by_step[step_number].items()
            },
        })

    return {"tasks": task_series, "aggregate": aggregate, "formulas": out_formulas}
