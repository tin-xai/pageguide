"""New-spec step confidence score.

This implements the alternative confidence definition that differs from the
LLM-self-reported score in `scoring.py`:

    C_t = clip(G_t * (1 - lambda_L * L_t), 0, 1)
    G_t = 0.5 * G_grounding + 0.5 * G_progress

- G_grounding is RULE-BASED from the trace (no LLM): element resolved by index
  -> 1.0, resolved by text only -> 0.7, not found / no target -> 0.0.
- G_progress is the cosine similarity between an embedding of the step
  instruction and an embedding of the predicted final goal (text-embedding-ada-002
  via OpenRouter). It is stored on the step as `g_progress_score` and falls back
  to 0.5 (neutral) when unavailable (e.g. old traces without embeddings).
- Scroll / done / target-less steps carry no element-targeting signal and are
  excluded from scoring (G_grounding returns None).

Both families share the same stored `loop` value, so the spec and the LLM-based
score can be compared apples-to-apples on the same runs.
"""

from __future__ import annotations

import json
import math
import os
import urllib.error
import urllib.request
from typing import Any

from .judge import _env_value, configured_judge_model


SPEC_LAMBDA_L = 0.5
SPEC_FORMULAS = ("spec_full", "spec_noloop", "spec_noprogress")
SPEC_PROGRESS_FALLBACK = 0.5

# Actions that mechanically succeed / have no element-targeting signal.
NON_GROUNDING_ACTIONS = {"scroll", "scroll_up", "scroll_down", "done"}


def _num(value: Any, lo: float, hi: float, default: float | None) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def g_grounding(step: dict[str, Any]) -> float | None:
    """Rule-based grounding score. Returns None for non-grounding steps."""
    if step.get("isInitial"):
        return None
    action = (step.get("action") or "").strip().lower()
    if action in NON_GROUNDING_ACTIONS:
        return None
    target = step.get("target") or {}
    index = target.get("llmIndex")
    if index is not None and index != "":
        return 1.0
    if target.get("text"):
        return 0.7
    return 0.0


def compute_spec_confidence(
    step: dict[str, Any],
    formula: str = "spec_full",
    lambda_l: float = SPEC_LAMBDA_L,
) -> float | None:
    """C_t for the new spec. None when the step carries no grounding signal."""
    grounding = g_grounding(step)
    if grounding is None:
        return None
    loop = _num(step.get("loop"), 0.0, 1.0, 0.0)
    progress = _num(step.get("g_progress_score"), 0.0, 1.0, SPEC_PROGRESS_FALLBACK)

    if formula == "spec_noprogress":
        g_t = grounding
    else:
        g_t = 0.5 * grounding + 0.5 * progress

    score = g_t
    if formula != "spec_noloop":
        score *= 1 - lambda_l * float(loop or 0.0)
    return max(0.0, min(1.0, score))


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


class SpecProgressClient:
    """Predicts the final goal once per task and embeds step instructions.

    Reuses the existing OPENROUTER_API_KEY. OpenRouter hosts
    text-embedding-ada-002 at /api/v1/embeddings (OpenAI-compatible).
    """

    def __init__(
        self,
        api_key: str | None = None,
        chat_model: str | None = None,
        embed_model: str | None = None,
    ) -> None:
        self.api_key = api_key or _env_value(
            "OPENROUTER_API_KEY", "OPEN_REUTER_API_KEY", "open-reuter-api-key"
        )
        self.chat_model = chat_model or configured_judge_model()
        self.embed_model = embed_model or os.environ.get(
            "PAGEGUIDE_EVAL_EMBED_MODEL", "openai/text-embedding-ada-002"
        )
        self.chat_endpoint = os.environ.get(
            "PAGEGUIDE_EVAL_JUDGE_ENDPOINT", "https://openrouter.ai/api/v1/chat/completions"
        )
        self.embed_endpoint = os.environ.get(
            "PAGEGUIDE_EVAL_EMBED_ENDPOINT", "https://openrouter.ai/api/v1/embeddings"
        )

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://127.0.0.1:5050",
            "X-Title": "PageGuide Eval",
        }

    def _post(self, endpoint: str, body: dict[str, Any]) -> dict[str, Any]:
        req = urllib.request.Request(
            endpoint,
            data=json.dumps(body).encode("utf-8"),
            headers=self._headers(),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=90) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def predict_goal(self, task: dict[str, Any]) -> str:
        prompt = (
            "Predict the final goal STATE for this browser task in one concise sentence "
            "describing what the page should show when the task is complete.\n\n"
            f"Task: {task.get('task', '')}\n"
            f"Website: {task.get('website_url', '')}\n\n"
            "Return only the sentence, no preamble."
        )
        data = self._post(
            self.chat_endpoint,
            {
                "model": self.chat_model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0,
            },
        )
        return (data["choices"][0]["message"]["content"] or "").strip()

    def embed(self, texts: list[str]) -> list[list[float]]:
        data = self._post(self.embed_endpoint, {"model": self.embed_model, "input": texts})
        rows = sorted(data.get("data", []), key=lambda r: r.get("index", 0))
        return [row.get("embedding", []) for row in rows]


def backfill_g_progress(result: dict[str, Any], client: SpecProgressClient) -> bool:
    """Fill `g_progress_score` on each grounding step. Returns True if changed.

    Non-fatal: any network/parse failure leaves steps untouched (g_progress then
    falls back to the neutral 0.5 inside compute_spec_confidence).
    """
    if not client.available:
        return False
    steps = result.get("steps") or []
    pending = [
        s for s in steps
        if not s.get("isInitial")
        and int(s.get("step") or 0) > 0
        and s.get("g_progress_score") is None
        and g_grounding(s) is not None
        and (s.get("instruction") or "").strip()
    ]
    if not pending:
        return False
    try:
        goal = client.predict_goal(result.get("task", {}))
        if not goal:
            return False
        instructions = [s.get("instruction", "") for s in pending]
        vectors = client.embed([goal] + instructions)
    except (urllib.error.URLError, KeyError, ValueError, TimeoutError):
        return False
    if len(vectors) != len(pending) + 1:
        return False
    goal_vec = vectors[0]
    for step, vec in zip(pending, vectors[1:]):
        sim = _cosine(vec, goal_vec)
        step["g_progress_score"] = max(0.0, min(1.0, sim))
    result["spec_goal_text"] = goal
    return True
