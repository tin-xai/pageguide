"""Expected Calibration Error (ECE) for task-level confidence vs accuracy.

A task's confidence is aggregated from its step confidences (mean / last / min,
scroll + initial steps excluded). The accuracy label is `effective_success`
(human override, else LLM judge). Bot-detection failures (captcha / blocked /
network) are excluded from the calibration set.

ECE = sum_b (n_b / N) * |accuracy_b - confidence_b| over equal-width bins.
"""

from __future__ import annotations

import re
from statistics import mean
from typing import Any

from .scoring import effective_success, score_step


_BOT_PATTERN = re.compile(r"captcha|blocked|net::|ERR_|denied|forbidden", re.IGNORECASE)


def is_bot_detection_failure(result: dict[str, Any]) -> bool:
    """True if the run failed due to bot detection / network, not the agent."""
    judge = result.get("judge") or {}
    if (judge.get("failureCategory") or "") == "ACCESS DENIED":
        return True
    haystack = " ".join(
        str(result.get(key) or "")
        for key in ("error", "terminal_reason")
    )
    haystack += " " + str(judge.get("reason") or "")
    return bool(_BOT_PATTERN.search(haystack))


def aggregate_task(
    steps: list[dict[str, Any]],
    formula: str,
    mode: str = "mean",
    high_threshold: float = None,
    medium_threshold: float = None,
) -> float | None:
    """Collapse a task's step confidences into one score for the given formula."""
    values = []
    for step in steps or []:
        if step.get("isInitial") or int(step.get("step") or 0) <= 0:
            continue
        score = score_step(step, formula, high_threshold=high_threshold, medium_threshold=medium_threshold)
        if score is not None:
            values.append(float(score))
    if not values:
        return None
    if mode == "last":
        return values[-1]
    if mode == "min":
        return min(values)
    return mean(values)


def compute_ece(
    scores: list[float],
    labels: list[float],
    n_bins: int = 5,
) -> dict[str, Any]:
    """Equal-width reliability bins + scalar ECE."""
    total = len(scores)
    bins = []
    ece = 0.0
    for i in range(n_bins):
        lo = i / n_bins
        hi = (i + 1) / n_bins
        # Last bin is closed on the right so confidence == 1.0 lands somewhere.
        members = [
            (s, l)
            for s, l in zip(scores, labels)
            if (s >= lo and s < hi) or (i == n_bins - 1 and s == hi)
        ]
        count = len(members)
        avg_conf = mean(s for s, _ in members) if members else None
        accuracy = mean(l for _, l in members) if members else None
        if count and avg_conf is not None and accuracy is not None:
            ece += (count / total) * abs(accuracy - avg_conf)
        bins.append({
            "lo": lo,
            "hi": hi,
            "mid": (lo + hi) / 2,
            "count": count,
            "avg_confidence": avg_conf,
            "accuracy": accuracy,
        })
    return {"ece": ece if total else None, "bins": bins, "n": total}


def ece_payload(
    task_results: list[dict[str, Any]],
    formula: str,
    agg: str = "mean",
    n_bins: int = 5,
    run_high: float = None,
    run_medium: float = None,
) -> dict[str, Any]:
    """Build the calibration payload for one formula, ready to plot."""
    points = []
    excluded = 0
    for result in task_results:
        if is_bot_detection_failure(result):
            excluded += 1
            continue
        high = result.get("grounding_high_threshold")
        if high is None:
            high = run_high
        medium = result.get("grounding_medium_threshold")
        if medium is None:
            medium = run_medium
        score = aggregate_task(result.get("steps", []), formula, agg, high_threshold=high, medium_threshold=medium)
        if score is None:
            continue
        success = effective_success(result)
        points.append({
            "task_id": result.get("task_id"),
            "task": (result.get("task") or {}).get("task", ""),
            "confidence": score,
            "label": 1.0 if success else 0.0,
            "success": success,
        })
    binning = compute_ece(
        [p["confidence"] for p in points],
        [p["label"] for p in points],
        n_bins,
    )
    return {
        "formula": formula,
        "agg": agg,
        "n_bins": n_bins,
        "excluded_bot_detection": excluded,
        "points": points,
        **binning,
    }
