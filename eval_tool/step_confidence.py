"""New-spec step confidence score.

This implements the alternative confidence definition that differs from the
LLM-self-reported score in `scoring.py`:

    C_t = clip(G_t * (1 - lambda_L * L_t_u), 0, 1)
    G_t = 0.5 * G_grounding + 0.5 * G_progress

- G_grounding is RULE-BASED from the trace (no LLM): element index present
  -> 1.0, text only -> 0.7, not found / no target -> 0.0.
  TODO: 1.0 currently only requires the index to be *present*. It should later
  require the index to actually RESOLVE in the step DOM snapshot (the step stores
  `targetRect` / `regionDom`, which only exist when the element resolved at action
  time). Keeping present-based for now per product direction.
- G_goal_relevance is the cosine similarity between an embedding of the step
  instruction and an embedding of the predicted final-goal STATE
  (text-embedding-ada-002 via OpenRouter). It is stored on the step as
  `g_goal_relevance_score` (older traces use `g_progress_score`). This measures
  how RELEVANT the step is to the goal -- it is NOT real progress, so we no longer
  fabricate a neutral value when it is missing: the step simply falls back to
  grounding-only (spec_noprogress) scoring.
- `progress` (range -1..1) is the agent's own LLM-self-reported progress and is a
  SEPARATE signal from goal relevance. It is surfaced for inspection but is not
  part of the spec C_t formula.
- Scroll / done / target-less steps carry no element-targeting signal and are
  excluded from scoring (G_grounding returns None).

The spec score prefers the updated post-hoc loop value `computed_loop_updated`,
which matches on both action type and target text, then falls back to historical
loop fields for older records.

TODO (`g_state_progress_score`): a genuine post-action *state* progress signal
(comparing `domSnapshot` vs `domSnapshotAfter`) is future work; see the stub at
the bottom of this module.
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

# How many recent steps `computed_loop_recent` looks back over. Kept for older
# records/back-compat; the inspector now displays `computed_loop_updated`.
RECENT_LOOP_WINDOW = 3

# Actions that mechanically succeed / have no element-targeting signal.
NON_GROUNDING_ACTIONS = {"scroll", "scroll_up", "scroll_down", "done"}


def goal_relevance(step: dict[str, Any]) -> Any:
    """Read the goal-relevance score, honoring the legacy field name."""
    value = step.get("g_goal_relevance_score")
    if value is None:
        value = step.get("g_progress_score")
    return value


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
    # TODO: require the index to RESOLVE in the step DOM snapshot (targetRect /
    # regionDom), not merely be present, before awarding 1.0. Present-based for now.
    if index is not None and index != "":
        return 1.0
    if target.get("text"):
        return 0.7
    return 0.0


# Fields, in priority order, used to build the loop "action key" for a step.
# Mirrors the reference implementation's _action_key(action): the first non-empty
# value of element_text / element_desc / description / instruction, stripped + lowered.
# We map element_text onto our nested target.text.
def _action_key(step: dict[str, Any]) -> str:
    """Normalized text identity of the element/action a step targets.

    Faithful port of the reference `_action_key`: NOT page-scoped and NOT index-based
    -- two steps loop when their action key (element text, falling back to the
    instruction) is the same string.
    """
    target = step.get("target") or {}
    candidates = (
        target.get("text"),        # element_text
        step.get("element_desc"),  # element_desc
        step.get("description"),   # description
        step.get("instruction"),   # instruction
    )
    for value in candidates:
        if value and str(value).strip():
            return str(value).strip().lower()
    return ""


# Back-compat alias: older callers/imports referenced `element_key`.
element_key = _action_key


def _action_type_key(step: dict[str, Any]) -> str:
    """Normalized action type for updated loop matching."""
    raw = step.get("action")
    if raw is None or str(raw).strip() == "":
        raw = step.get("type")
    value = str(raw or "").strip().lower()
    if "(" in value:
        value = value.split("(", 1)[0].strip()
    return value


def _action_key_updated(step: dict[str, Any]) -> str:
    """Action+text identity used by L_t_u.

    Click and type actions against the same element text are intentionally
    different keys; only same action type + same target text counts as a loop.
    """
    action_type = _action_type_key(step)
    text_key = _action_key(step)
    if not action_type or not text_key:
        return ""
    return f"{action_type}: {text_key}"


def compute_loop_score_updated(step: dict[str, Any], prev_steps: list[dict[str, Any]]) -> float:
    """L_t_u in [0, 1]: previous-action fraction with matching type and text."""
    if not prev_steps:
        return 0.0
    key = _action_key_updated(step)
    if not key:
        return 0.0
    matches = sum(1 for s in prev_steps if _action_key_updated(s) == key)
    return min(1.0, matches / len(prev_steps))


def compute_loop_score(step: dict[str, Any], prev_steps: list[dict[str, Any]]) -> float:
    """L_t in [0, 1]: fraction of previous actions sharing this step's action key.

    Faithful port of the reference `compute_loop_score` -- the denominator is the
    number of previous actions (not just target-bearing ones), and there is no +1.
    Returns 0.0 when there are no previous actions or this step has no key.
    """
    if not prev_steps:
        return 0.0
    key = _action_key(step)
    if not key:
        return 0.0
    matches = sum(1 for s in prev_steps if _action_key(s) == key)
    return min(1.0, matches / len(prev_steps))


def backfill_computed_loop(result: dict[str, Any]) -> None:
    """Compute loop metrics post-hoc from the trace.

    `actions` excludes the initial-state placeholder so it matches the reference's
    flat action list (prev_actions = actions[:i]).
    Sets per step:
    - `computed_loop`: historical text-only L_t over ALL prior actions.
    - `computed_loop_updated`: L_t_u over ALL prior actions, matching both action
      type and target/instruction text. This is used in C_t.
    - `action_key_updated`: display/debug key for L_t_u.
    - `computed_loop_recent`: same score but over the last `RECENT_LOOP_WINDOW`
      actions, kept for older UI/back-compat.
    """
    steps = result.get("steps") or []
    actions = [s for s in steps if not s.get("isInitial")]
    for step in steps:
        if step.get("isInitial"):
            step["computed_loop"] = 0.0
            step["computed_loop_updated"] = 0.0
            step["action_key_updated"] = ""
            step["computed_loop_recent"] = 0.0
    for i, action in enumerate(actions):
        action["computed_loop"] = compute_loop_score(action, actions[:i])
        action["computed_loop_updated"] = compute_loop_score_updated(action, actions[:i])
        action["action_key_updated"] = _action_key_updated(action)
        window = actions[max(0, i - RECENT_LOOP_WINDOW):i]
        action["computed_loop_recent"] = compute_loop_score(action, window)


def compute_spec_confidence(
    step: dict[str, Any],
    formula: str = "spec_full",
    lambda_l: float = SPEC_LAMBDA_L,
) -> float | None:
    """C_t for the new spec. None when the step carries no grounding signal."""
    grounding = g_grounding(step)
    if grounding is None:
        return None
    # Prefer updated L_t_u when available, then fall back for older records.
    loop_value = step.get("computed_loop_updated")
    if loop_value is None:
        loop_value = step.get("computed_loop", step.get("loop"))
    loop = _num(loop_value, 0.0, 1.0, 0.0)
    # Goal relevance is the embedding cosine sim. When it is missing we do NOT
    # fabricate a neutral value -- the step falls back to grounding-only scoring.
    relevance = _num(goal_relevance(step), 0.0, 1.0, None)

    if formula == "spec_noprogress" or relevance is None:
        g_t = grounding
    else:
        g_t = 0.5 * grounding + 0.5 * relevance

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
    """Fill `g_goal_relevance_score` on each grounding step. Returns True if changed.

    Non-fatal: any network/parse failure leaves steps untouched. Steps without a
    goal-relevance score fall back to grounding-only inside compute_spec_confidence
    (no fabricated neutral value).
    """
    if not client.available:
        return False
    steps = result.get("steps") or []
    pending = [
        s for s in steps
        if not s.get("isInitial")
        and int(s.get("step") or 0) > 0
        and goal_relevance(s) is None
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
        step["g_goal_relevance_score"] = max(0.0, min(1.0, sim))
    result["spec_goal_text"] = goal
    return True


# TODO: g_state_progress_score -- genuine post-action STATE progress.
#
# Goal relevance above measures how relevant a step's *instruction* is to the
# predicted goal; it says nothing about whether the action actually moved the page
# state forward. A future signal should compare the page before vs after the action
# (the step stores `domSnapshot` and `domSnapshotAfter`), e.g. embed both and use
# 1 - cosine(before, after), or a structured diff of the rendered state. Until that
# is implemented, `g_state_progress_score` is intentionally not computed.
