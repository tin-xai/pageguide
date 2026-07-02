"""New-spec step confidence score.

This implements the alternative confidence definition that differs from the
LLM-self-reported score in `scoring.py`:

    C_t = clip(G_t * (1 - lambda_L * L_t_u), 0, 1)
    G_t = 0.5 * G_grounding + 0.5 * G_progress

- G_grounding is based on element-step cosine similarity for Python eval:
  no valid element index -> 0.0; similarity >= 0.8 -> 1.0; >= 0.5 -> 0.5;
  otherwise -> 0.1. The raw cosine is stored as `element_step_similarity`.
  Old traces without that field keep the previous index-present fallback until
  backfilled.
- G_goal_relevance is the cosine similarity between an embedding of the step
  instruction and an embedding of the predicted final-goal STATE
  (text-embedding-ada-002 via OpenRouter). It is stored on the step as
  `g_goal_relevance_score` (older traces use `g_progress_score`). This measures
  how RELEVANT the step is to the goal -- it is NOT real progress, so we no longer
  fabricate a neutral value when it is missing: the step simply falls back to
  grounding-only (spec_noprogress) scoring.
- `progress` (three-point 0.0 / 0.5 / 1.0: 1.0 = clear progress toward completion,
  0.5 = no clear net progress / exploratory / redundant movement, 0.0 = regression
  or undoing prior progress) is the agent's own LLM-self-reported progress and is a
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
ELEMENT_GROUNDING_HIGH_THRESHOLD = 0.84
ELEMENT_GROUNDING_MEDIUM_THRESHOLD = 0.78

# How many recent steps `computed_loop_recent` looks back over. Kept for older
# records/back-compat; the inspector now displays `computed_loop_updated`.
RECENT_LOOP_WINDOW = 3
LOOP_UPDATED_TASK_THRESHOLD = 0.3

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


def _has_valid_element_index(step: dict[str, Any]) -> bool:
    target = step.get("target") or {}
    index = target.get("llmIndex")
    return index is not None and str(index).strip() != ""


def g_grounding(step: dict[str, Any], high_threshold: float = None, medium_threshold: float = None) -> float | None:
    """Element grounding score. Returns None for non-grounding steps."""
    if step.get("isInitial"):
        return None
    action = (step.get("action") or "").strip().lower()
    if action in NON_GROUNDING_ACTIONS:
        return None
    if not _has_valid_element_index(step):
        return 0.0
    similarity = _num(step.get("element_step_similarity"), 0.0, 1.0, None)
    if similarity is None:
        # Back-compat for traces saved before element-step similarity was backfilled.
        return 1.0
    # Match the UI/reporting precision: a raw cosine like 0.7996 displays as 0.80, so
    # it should be accepted as crossing the grounding threshold.
    similarity_bucket = round(similarity, 2)
    high = high_threshold if high_threshold is not None else ELEMENT_GROUNDING_HIGH_THRESHOLD
    med = medium_threshold if medium_threshold is not None else ELEMENT_GROUNDING_MEDIUM_THRESHOLD
    if similarity_bucket >= high:
        return 1.0
    if similarity_bucket >= med:
        return 0.5
    return 0.1


def _element_text(step: dict[str, Any]) -> str:
    import re
    target = step.get("target") or {}
    index = target.get("llmIndex")
    if index is not None:
        user_prompt = step.get("userPrompt") or ""
        match = re.search(r"^\s*\[" + str(index) + r"\]\s+(.*)$", user_prompt, re.MULTILINE)
        if match:
            return match.group(1).strip()
    return str(target.get("text") or "").strip()


def backfill_element_step_similarity(result: dict[str, Any], client: "SpecProgressClient") -> bool:
    """Fill cosine(step instruction, target element text) for indexed element steps."""
    steps = result.get("steps") or []
    pending = [
        s for s in steps
        if not s.get("isInitial")
        and int(s.get("step") or 0) > 0
        and (s.get("action") or "").strip().lower() not in NON_GROUNDING_ACTIONS
        and _has_valid_element_index(s)
        and s.get("element_step_similarity") is None
    ]
    if not pending:
        return False
    changed = False
    zero_steps = [
        s for s in pending
        if not str(s.get("instruction") or "").strip() or not _element_text(s)
    ]
    for step in zero_steps:
        step["element_step_similarity"] = 0.0
        changed = True
    to_embed = [s for s in pending if s not in zero_steps]
    if not to_embed:
        return changed
    if not client.available:
        return changed
    texts: list[str] = []
    for step in to_embed:
        texts.extend([str(step.get("instruction") or "").strip(), _element_text(step)])
    try:
        vectors = client.embed(texts)
        if len(vectors) != len(texts):
            return changed
        for i, step in enumerate(to_embed):
            instr_vec = vectors[2 * i]
            element_vec = vectors[2 * i + 1]
            sim = _cosine(instr_vec, element_vec)
            step["element_step_similarity"] = max(0.0, min(1.0, sim))
            changed = True
        return changed
    except (urllib.error.URLError, KeyError, ValueError, TimeoutError):
        return changed


def low_grounding_summary(steps: list[dict[str, Any]] | None, high_threshold: float = None, medium_threshold: float = None) -> dict[str, Any]:
    """Summarize non-initial steps whose rule-based ``G_ground`` score is below 1."""
    issues: list[dict[str, Any]] = []
    min_grounding = None
    for step in steps or []:
        if step.get("isInitial"):
            continue
        value = g_grounding(step, high_threshold=high_threshold, medium_threshold=medium_threshold)
        if value is None:
            continue
        if value < 1.0:
            issues.append({"step": step.get("step"), "g_ground": value})
            min_grounding = value if min_grounding is None else min(min_grounding, value)
    return {
        "count": len(issues),
        "min_grounding": min_grounding,
        "steps": issues,
        "has_issue": bool(issues),
    }


def format_low_grounding_summary(summary: dict[str, Any]) -> str:
    if not summary.get("has_issue"):
        return ""
    parts = []
    for item in summary.get("steps") or []:
        step = item.get("step")
        value = item.get("g_ground")
        if step is None:
            parts.append(f"?={value}")
        else:
            parts.append(f"Step {step}: {float(value):.2g}")
    shown = "; ".join(parts[:8])
    extra = len(parts) - 8
    if extra > 0:
        shown += f"; +{extra} more"
    return shown


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
    """L_t_u in [0, 1]: previous-action count divided by 10."""
    if not prev_steps:
        return 0.0
    key = _action_key_updated(step)
    if not key:
        return 0.0
    matches = sum(1 for s in prev_steps if _action_key_updated(s) == key)
    return min(1.0, matches / 10)


def compute_loop_score(step: dict[str, Any], prev_steps: list[dict[str, Any]]) -> float:
    """L_t in [0, 1]: number of previous actions sharing this step's action key divided by 10."""
    if not prev_steps:
        return 0.0
    key = _action_key(step)
    if not key:
        return 0.0
    matches = sum(1 for s in prev_steps if _action_key(s) == key)
    return min(1.0, matches / 10)


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


def loop_metrics_summary(steps: list[dict[str, Any]] | None) -> dict[str, Any]:
    """Summarize loop metrics from a trace.

    ``loop_steps_updated`` counts steps whose L_t_u is strictly greater than 0.5.
    ``loop_task_updated`` is the task-level table flag: 1 when any L_t_u >= 0.3.
    ``min_loop_updated`` / ``max_loop_updated`` span all non-initial steps (for display).
    """
    payload = {"steps": list(steps or [])}
    backfill_computed_loop(payload)
    actions = [s for s in payload["steps"] if not s.get("isInitial")]
    old_loops = [float(s.get("computed_loop") or 0.0) for s in actions]
    updated_loops = [float(s.get("computed_loop_updated") or 0.0) for s in actions]
    loop_steps = sum(1 for v in old_loops if v > 0.5)
    loop_steps_updated = sum(1 for v in updated_loops if v > 0.5)
    min_loop = min(old_loops) if old_loops else 0.0
    max_loop = max(old_loops) if old_loops else 0.0
    min_loop_updated = min(updated_loops) if updated_loops else 0.0
    max_loop_updated = max(updated_loops) if updated_loops else 0.0
    return {
        "loop_steps": loop_steps,
        "min_loop": min_loop,
        "max_loop": max_loop,
        "loop_steps_updated": loop_steps_updated,
        "loop_task_updated": 1 if max_loop_updated >= LOOP_UPDATED_TASK_THRESHOLD else 0,
        "loop_task_updated_threshold": LOOP_UPDATED_TASK_THRESHOLD,
        "min_loop_updated": min_loop_updated,
        "max_loop_updated": max_loop_updated,
        "loop_metric_disagrees": (
            loop_steps != loop_steps_updated or abs(max_loop - max_loop_updated) > 1e-9
        ),
    }


def compute_spec_confidence(
    step: dict[str, Any],
    formula: str = "spec_full",
    lambda_l: float = SPEC_LAMBDA_L,
    high_threshold: float = None,
    medium_threshold: float = None,
) -> float | None:
    """C_t for the new spec. None when the step carries no grounding signal."""
    grounding = g_grounding(step, high_threshold=high_threshold, medium_threshold=medium_threshold)
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

    def predict_subgoal_rubric(self, task: dict[str, Any]) -> dict[str, Any]:
        """Generate the ordered, deterministically-checkable subgoal rubric for a task.

        The LLM only authors the rubric; it never scores step progress. See
        ``eval_tool/subgoal_progress.py`` for how checks are verified from page state.
        """
        from .judge import extract_json

        prompt = (
            "Generate 3-7 ordered subgoals that represent concrete intermediate PAGE STATES "
            "showing progress toward the final browser task goal.\n\n"
            "Rules:\n"
            "- Each subgoal must be atomic: exactly ONE state per subgoal. Never combine two things "
            "with 'and'/'then' (split 'search New York and filter Permanent' into two subgoals).\n"
            "- Describe a state, not an action.\n"
            "- Subgoals are INDEPENDENT and may be unordered/parallel; each is scored on its own "
            "evidence. Do NOT assume one subgoal implies another is complete.\n"
            "- Each subgoal must be verifiable from current page state only: URL, visible DOM text, "
            "accessibility role/name/state, selected value, checked/active control, form value, "
            "cart count, page heading, product-detail state, or confirmation message.\n"
            "- Provide 2-4 alternative checks in `checks_any`; ANY ONE check is sufficient.\n"
            "- Prefer strong state evidence: selected value, checked/active control, form value, "
            "visible confirmation, cart count, page heading, or product-detail state.\n"
            "- For any 'X is selected/applied/chosen' state, use select_value/selected_value/"
            "control_state — NOT text_includes (the option text is usually visible even when not "
            "selected). select_value matches the option's value attribute OR its visible text.\n"
            "- Do not rely on generic text alone when it could appear without the state being complete.\n"
            "- Never output a full or exact URL/path. Use only a domain or a short path fragment as a "
            "url_includes substring.\n"
            "- Include common wording variants (e.g. 'add to cart'/'add to bag') and assume text "
            "matching is case-insensitive.\n\n"
            "Allowed check types:\n"
            '- {"type":"url_includes","value":"broad URL/domain substring"}\n'
            '- {"type":"text_includes","value":"visible state text","variants":["optional wording variant"]}\n'
            '- {"type":"text_group_includes","all_of":["required text A","required text B"],"any_of":["optional variant A","optional variant B"]}\n'
            '- {"type":"input_value","name":"field name/label optional","value":"expected value"}\n'
            '- {"type":"checkbox_checked","label":"control name/label optional"}\n'
            '- {"type":"select_value","value":"selected option text","variants":["optional variant"]}\n'
            '- {"type":"selected_value","value":"selected/active value","variants":["optional variant"]}\n'
            '- {"type":"control_state","label":"control label/value","state":"selected|checked|pressed|active"}\n'
            '- {"type":"role_label","role":"button|link|textbox|combobox|alert","name":"accessible name"}\n\n'
            "Bad XL example to avoid: do NOT verify `XL is selected` using only "
            '{"type":"text_includes","value":"XL"} because all sizes may be visible. Use selected_value '
            "or control_state checks such as aria-selected=true, aria-pressed=true, checked radio input, "
            "selected dropdown value, or visible summary like `Size: XL`.\n\n"
            "Good example:\n"
            "Task: Search Under Armour for a men's outlet t-shirt in XL and add it to the cart.\n"
            '{"subgoals":[\n'
            '{"order":1,"goal":"Under Armour site is open","checks_any":[{"type":"url_includes","value":"underarmour.com"}]},\n'
            '{"order":2,"goal":"Search results for men\\\'s t-shirt are shown","checks_any":[{"type":"input_value","name":"search","value":"men\\\'s t-shirt"},{"type":"text_includes","value":"men\\\'s t-shirt","variants":["mens t shirt","men tee"]}]},\n'
            '{"order":3,"goal":"Men\\\'s filter is applied","checks_any":[{"type":"control_state","label":"men\\\'s","state":"selected"},{"type":"checkbox_checked","label":"men\\\'s"},{"type":"text_includes","value":"Men\\\'s"}]},\n'
            '{"order":4,"goal":"T-shirt filter is applied","checks_any":[{"type":"control_state","label":"t-shirt","state":"selected","variants":["t shirt","tee"]},{"type":"checkbox_checked","label":"t-shirt"},{"type":"text_includes","value":"T-Shirt","variants":["T Shirt","Tee"]}]},\n'
            '{"order":5,"goal":"A qualifying outlet t-shirt product page is open","checks_any":[{"type":"text_group_includes","all_of":["outlet","t-shirt"],"any_of":["add to cart","add to bag","size"]},{"type":"text_group_includes","all_of":["outlet","tee"],"any_of":["add to cart","add to bag","size"]}]},\n'
            '{"order":6,"goal":"XL is selected for the current product","checks_any":[{"type":"selected_value","value":"XL"},{"type":"control_state","label":"XL","state":"selected"},{"type":"control_state","label":"XL","state":"pressed"},{"type":"text_includes","value":"Size: XL"}]},\n'
            '{"order":7,"goal":"Product is added to cart","checks_any":[{"type":"text_includes","value":"added to cart","variants":["added to bag"]},{"type":"role_label","role":"alert","name":"added"},{"type":"text_group_includes","all_of":["cart"],"any_of":["1 item","checkout"]}]}\n'
            ']}\n\n'
            f"Task: {task.get('task', '')}\n"
            f"Website: {task.get('website_url', '')}\n\n"
            'Return JSON ONLY: {"subgoals":[{"order":1,"goal":"...","checks_any":[...]}]}'
        )
        data = self._post(
            self.chat_endpoint,
            {"model": self.chat_model, "messages": [{"role": "user", "content": prompt}], "temperature": 0},
        )
        text = data["choices"][0]["message"]["content"] or ""
        parsed = extract_json(text)
        subgoals = parsed.get("subgoals") if isinstance(parsed, dict) else None
        if not isinstance(subgoals, list):
            return {"subgoals": []}
        clean = []
        for i, sg in enumerate(subgoals, start=1):
            if not isinstance(sg, dict):
                continue
            checks_any = [c for c in (sg.get("checks_any") or []) if isinstance(c, dict) and c.get("type")]
            checks = [c for c in (sg.get("checks") or []) if isinstance(c, dict) and c.get("type")]
            row = {"order": sg.get("order", i), "goal": str(sg.get("goal", "")).strip()}
            if checks_any:
                row["checks_any"] = checks_any
            elif checks:
                row["checks"] = checks
            clean.append(row)
        return {"subgoals": clean, "model": self.chat_model}


def infer_predicted_goal_state(result: dict[str, Any]) -> str:
    """Read the LLM final-state prediction from run metadata or step records."""
    direct = (result.get("spec_goal_text") or result.get("predictedGoalState") or "").strip()
    if direct:
        return direct
    for step in result.get("steps") or []:
        pg = (step.get("predictedGoalState") or "").strip()
        if pg:
            return pg
    return ""


def backfill_g_progress(result: dict[str, Any], client: SpecProgressClient) -> bool:
    """Fill `g_goal_relevance_score` on each instruction-bearing step. Returns True if changed.

    Non-fatal: any network/parse failure leaves steps untouched. Steps without a
    goal-relevance score fall back to grounding-only inside compute_spec_confidence
    (no fabricated neutral value).
    """
    if not client.available:
        return False
    steps = result.get("steps") or []
    goal = infer_predicted_goal_state(result)
    pending = [
        s for s in steps
        if not s.get("isInitial")
        and int(s.get("step") or 0) > 0
        and goal_relevance(s) is None
        and (s.get("instruction") or "").strip()
    ]
    changed = False
    try:
        if not goal and client.available:
            goal = (client.predict_goal(result.get("task", {})) or "").strip()
        if not goal and not pending:
            return False
        if goal and result.get("spec_goal_text") != goal:
            result["spec_goal_text"] = goal
            changed = True
        if not pending:
            return changed
        instructions = [s.get("instruction", "") for s in pending]
        vectors = client.embed([goal] + instructions)
        if len(vectors) != len(pending) + 1:
            return changed
        goal_vec = vectors[0]
        for step, vec in zip(pending, vectors[1:]):
            sim = _cosine(vec, goal_vec)
            step["g_goal_relevance_score"] = max(0.0, min(1.0, sim))
            changed = True
        return changed
    except (urllib.error.URLError, KeyError, ValueError, TimeoutError):
        return changed


# TODO: g_state_progress_score -- genuine post-action STATE progress.
#
# Goal relevance above measures how relevant a step's *instruction* is to the
# predicted goal; it says nothing about whether the action actually moved the page
# state forward. A future signal should compare the page before vs after the action
# (the step stores `domSnapshot` and `domSnapshotAfter`), e.g. embed both and use
# 1 - cosine(before, after), or a structured diff of the rendered state. Until that
# is implemented, `g_state_progress_score` is intentionally not computed.
