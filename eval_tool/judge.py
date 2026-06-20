from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


FAILURE_CATEGORIES = {
    "UNKNOWN FAILURE",
    "FAILED TO EXECUTE ACTION",
    "NO INTERACTIVE ELEMENTS",
    "ACCESS DENIED",
}

DEFAULT_LLM_MODEL = "google/gemini-2.5-flash-lite"
MODEL_OPTIONS = [
    {"id": "google/gemini-2.5-flash-lite", "label": "Gemini 2.5 Flash Lite"},
    {"id": "google/gemini-2.5-flash", "label": "Gemini 2.5 Flash"},
    {"id": "google/gemini-2.5-pro", "label": "Gemini 2.5 Pro"},
    {"id": "openai/gpt-4o", "label": "GPT-4o"},
    {"id": "openai/gpt-4o-mini", "label": "GPT-4o Mini"},
]


def _dotenv_values() -> dict[str, str]:
    path = Path(__file__).resolve().parents[1] / ".env"
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _env_value(*keys: str) -> str | None:
    dotenv = _dotenv_values()
    normalized_dotenv = {
        key.lower().replace("-", "_"): value
        for key, value in dotenv.items()
    }
    for key in keys:
        if os.environ.get(key):
            return os.environ[key]
        normalized = key.lower().replace("-", "_")
        if normalized_dotenv.get(normalized):
            return normalized_dotenv[normalized]
    return None


def normalize_model(value: str | None) -> str:
    value = (value or "").strip()
    valid = {option["id"] for option in MODEL_OPTIONS}
    return value if value in valid else DEFAULT_LLM_MODEL


def extract_json(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    text = re.sub(r"^```json\s*", "", text, flags=re.I)
    text = re.sub(r"^```\s*", "", text, flags=re.I)
    text = re.sub(r"\s*```$", "", text, flags=re.I)
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        text = match.group(0)
    return json.loads(text)


def normalize_judge_response(raw: dict[str, Any]) -> dict[str, Any]:
    success = bool(raw.get("success"))
    category = raw.get("failureCategory")
    if success:
        category = None
    elif category not in FAILURE_CATEGORIES:
        category = "UNKNOWN FAILURE"
    try:
        confidence = max(0.0, min(1.0, float(raw.get("confidence", 0.0))))
    except (TypeError, ValueError):
        confidence = 0.0
    return {
        "success": success,
        "failureCategory": category,
        "reason": str(raw.get("reason") or "").strip() or ("Task completed." if success else "No reason supplied."),
        "confidence": confidence,
        "raw": raw,
    }


class LlmJudge:
    def __init__(self, model: str | None = None, api_key: str | None = None) -> None:
        self.model = model or configured_judge_model()
        self.api_key = api_key or _env_value("OPENROUTER_API_KEY", "OPEN_REUTER_API_KEY", "open-reuter-api-key")
        self.endpoint = os.environ.get("PAGEGUIDE_EVAL_JUDGE_ENDPOINT", "https://openrouter.ai/api/v1/chat/completions")

    def judge_final_screenshot(self, task: dict[str, Any], screenshot_path: Path | None) -> dict[str, Any]:
        if not self.api_key:
            return normalize_judge_response({
                "success": False,
                "failureCategory": "UNKNOWN FAILURE",
                "reason": "OPENROUTER_API_KEY is not configured, so the final screenshot was not judged.",
                "confidence": 0,
            })
        if not screenshot_path or not screenshot_path.exists():
            return normalize_judge_response({
                "success": False,
                "failureCategory": "FAILED TO EXECUTE ACTION",
                "reason": "No final screenshot was available for judging.",
                "confidence": 0.8,
            })

        image_b64 = base64.b64encode(screenshot_path.read_bytes()).decode("ascii")
        prompt = f"""You are judging whether a browser automation agent completed a PageGuide task.

Use ONLY the final screenshot. Do not infer hidden state. If the screenshot shows an access/login wall, choose ACCESS DENIED.
If the agent appears stuck because there are no visible actionable controls, choose NO INTERACTIVE ELEMENTS.
If the intended action visibly failed or the page is clearly not in the requested final state, choose FAILED TO EXECUTE ACTION.
Otherwise use UNKNOWN FAILURE for ambiguous failures.

Task: {task.get('task', '')}
Website URL: {task.get('website_url', '')}
Reference URL or note: {task.get('ground_truth', '')}
Success criteria: {task.get('success_criteria', '')}

Return JSON only:
{{
  "success": true,
  "failureCategory": null,
  "reason": "short explanation",
  "confidence": 0.0
}}"""
        try:
            raw_text = self._call_openai(prompt, image_b64)
            return normalize_judge_response(extract_json(raw_text))
        except Exception as exc:
            return normalize_judge_response({
                "success": False,
                "failureCategory": "UNKNOWN FAILURE",
                "reason": f"Judge LLM request failed for model {self.model}: {exc}",
                "confidence": 0,
            })

    def judge_progress_with_ground_truth(
        self,
        task: dict[str, Any],
        step: dict[str, Any],
        observed_steps: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        reference_steps = task.get("reference_steps") or ""
        if not reference_steps:
            return {
                "available": False,
                "progress_ground_truth": None,
                "reason": "No reference_steps column is available for this task.",
            }
        if not self.api_key:
            return {
                "available": False,
                "progress_ground_truth": None,
                "reason": "OPENROUTER_API_KEY is not configured.",
            }

        observed = observed_steps or [step]
        observed_text = "\n".join(
            f"{idx}. action={s.get('action') or 'state'}; instruction={s.get('instruction') or ''}; "
            f"target={(s.get('target') or {}).get('text', '')}"
            for idx, s in enumerate(observed, start=1)
            if not s.get("isInitial")
        )

        prompt = f"""Given this referenced ground truth, based on the observed PageGuide steps so far, score how close the run is to completing the user goal.

User goal: {task.get('task', '')}
Referenced ground-truth steps:
{reference_steps}

Observed steps so far:
{observed_text}

Current observed step:
Instruction: {step.get('instruction', '')}
Action: {step.get('action', '')}
Target element: {(step.get('target') or {}).get('text', '')}

If screenshots are included, image 1 is before the action and image 2 is after the action.

Return JSON only:
{{
  "progress_ground_truth": 0.0,
  "matches_reference": true,
  "reason": "short explanation"
}}

Use progress_ground_truth from -1.0 to 1.0:
- 1.0 means this step/run state substantially completes or reaches the goal.
- Positive means closer to the user goal according to the referenced ground truth.
- 0 means no meaningful progress toward the referenced ground truth.
- Negative means regression or moving away from the goal.

Base the score on the referenced ground truth, not only the model's original self-reported progress."""
        images = self._step_images(step)
        raw_text = self._call_openai(prompt, images)
        parsed = extract_json(raw_text)
        score = parsed.get("progress_ground_truth")
        try:
            score = max(-1.0, min(1.0, float(score)))
        except (TypeError, ValueError):
            score = None
        parsed["progress_ground_truth"] = score
        parsed["available"] = score is not None
        return parsed

    def _step_images(self, step: dict[str, Any]) -> list[str]:
        root = Path(__file__).resolve().parents[1]
        images = []
        for key in ("screenshotBefore", "screenshotAfter"):
            rel = step.get(key)
            if not rel:
                continue
            path = (root / rel).resolve()
            if path.exists() and str(path).startswith(str(root)):
                images.append(base64.b64encode(path.read_bytes()).decode("ascii"))
        return images

    def _call_openai(self, prompt: str, image_b64: str | list[str] | None) -> str:
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        images = image_b64 if isinstance(image_b64, list) else ([image_b64] if image_b64 else [])
        for image in images:
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{image}"},
            })
        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": content}],
            "temperature": 0,
        }
        req = urllib.request.Request(
            self.endpoint,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "http://127.0.0.1:5050",
                "X-Title": "PageGuide Eval",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Judge LLM request failed: {exc}") from exc
        return data["choices"][0]["message"]["content"]


def configured_judge_model() -> str:
    return normalize_model(os.environ.get("PAGEGUIDE_EVAL_JUDGE_MODEL", DEFAULT_LLM_MODEL))
