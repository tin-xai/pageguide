from __future__ import annotations

from statistics import mean
from typing import Any

from .step_confidence import SPEC_FORMULAS, compute_spec_confidence


LAMBDA_L = 0.8
LAMBDA_P = 0.3
FORMULAS = ("full", "reduced", "noloop")
# All families: LLM-self-reported (FORMULAS) + new-spec (SPEC_FORMULAS).
ALL_FORMULAS = FORMULAS + SPEC_FORMULAS
OPTIONAL_FORMULAS = ("full_ground_truth",)


def score_step(step: dict[str, Any], formula: str) -> float | None:
    """Dispatch a step to the right confidence family."""
    if formula in SPEC_FORMULAS:
        return compute_spec_confidence(step, formula)
    return compute_confidence(step, formula)


def effective_success(result: dict[str, Any]) -> bool:
    """Task correctness label for calibration.

    A human override (`human_success`) wins over the LLM judge verdict so the
    ECE plots reflect corrected labels.
    """
    human = result.get("human_success")
    if human is not None:
        return bool(human)
    return bool((result.get("judge") or {}).get("success"))


def _num(value: Any, lo: float, hi: float, default: float | None) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def compute_confidence(parts: dict[str, Any], formula: str = "full") -> float | None:
    grounded = _num(parts.get("grounded"), 0.0, 1.0, None)
    loop = _num(parts.get("loop"), 0.0, 1.0, 0.0)
    progress = _num(parts.get("progress"), -1.0, 1.0, 0.0)
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
) -> dict[str, Any]:
    requested = list(formulas) if formulas is not None else list(FORMULAS)
    out_formulas = list(requested)
    task_series = []
    by_step: dict[int, dict[str, list[float]]] = {}

    for result in task_results:
        points = []
        for step in result.get("steps", []):
            if step.get("isInitial") or int(step.get("step") or 0) <= 0:
                continue
            scores = {formula: score_step(step, formula) for formula in requested}
            # Surface optional formulas already computed/stored (e.g. full_ground_truth).
            stored = step.get("confidence_versions") or {}
            for formula in OPTIONAL_FORMULAS:
                if stored.get(formula) is not None:
                    scores[formula] = stored[formula]
                    if formula not in out_formulas:
                        out_formulas.append(formula)
            step_number = int(step.get("step") or len(points) + 1)
            points.append({"step": step_number, **scores})
            bucket = by_step.setdefault(step_number, {})
            for formula, score in scores.items():
                if score is not None:
                    bucket.setdefault(formula, []).append(float(score))
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
