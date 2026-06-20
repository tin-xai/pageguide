from __future__ import annotations

import json
import shutil
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_GUIDE_DIR = REPO_ROOT / "data-guide"
DATA_CSV = DATA_GUIDE_DIR / "Copy of GuideTaskData - guide_task.csv"
NO_LOGIN_DATA_CSV = DATA_GUIDE_DIR / "Copy of GuideTaskData - guide_task_no_log_in.csv"
LOGIN_DATA_CSV = DATA_GUIDE_DIR / "Copy of GuideTaskData - guide_task-log-in.csv"
RUNS_DIR = REPO_ROOT / "eval_tool" / "runs"


def task_set_options() -> list[dict[str, str]]:
    return [
        {"id": "no_login", "label": "No Login", "path": str(NO_LOGIN_DATA_CSV)},
        {"id": "login", "label": "Login", "path": str(LOGIN_DATA_CSV)},
    ]


def normalize_task_set(value: str | None) -> str:
    value = (value or "").strip().lower().replace("-", "_")
    return "login" if value == "login" else "no_login"


def current_data_csv(task_set: str | None = None) -> Path:
    task_set = normalize_task_set(task_set)
    if task_set == "no_login" and NO_LOGIN_DATA_CSV.exists():
        return NO_LOGIN_DATA_CSV
    if task_set == "login" and LOGIN_DATA_CSV.exists():
        return LOGIN_DATA_CSV

    preferred = [
        DATA_CSV,
        DATA_GUIDE_DIR / "Copy of GuideTaskData - guide_task-2.csv",
        NO_LOGIN_DATA_CSV,
        LOGIN_DATA_CSV,
    ]
    for path in preferred:
        if path.exists():
            return path
    candidates = sorted(DATA_GUIDE_DIR.glob("*.csv"), key=lambda path: path.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else DATA_CSV


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class EvalTask:
    name: str
    task_id: str
    task: str
    website_url: str
    ground_truth: str = ""
    reference_length: str = ""
    level: str = ""
    popularity: str = ""
    use_case: str = ""
    need_login: str = ""
    need_user_input: str = ""
    notes: str = ""
    reference_steps: str = ""
    success_criteria: str = ""
    required_test_inputs: str = ""
    allowed_stop_before_destructive_action: str = ""


@dataclass
class EvalRun:
    run_id: str
    created_at: str
    status: str = "queued"
    task_ids: list[str] = field(default_factory=list)
    started_at: str | None = None
    completed_at: str | None = None
    error: str | None = None


def run_dir(run_id: str) -> Path:
    return RUNS_DIR / run_id


def metadata_path(run_id: str) -> Path:
    return run_dir(run_id) / "run.json"


def task_path(run_id: str, task_id: str) -> Path:
    return run_dir(run_id) / "tasks" / f"{task_id}.json"


def screenshot_dir(run_id: str, task_id: str) -> Path:
    return run_dir(run_id) / "screenshots" / task_id


def ensure_runs_dir() -> None:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def save_run(run: EvalRun | dict[str, Any]) -> dict[str, Any]:
    data = asdict(run) if isinstance(run, EvalRun) else dict(run)
    write_json(metadata_path(data["run_id"]), data)
    return data


def load_run(run_id: str) -> dict[str, Any] | None:
    return read_json(metadata_path(run_id))


def list_runs() -> list[dict[str, Any]]:
    ensure_runs_dir()
    runs = []
    for path in RUNS_DIR.glob("*/run.json"):
        data = read_json(path)
        if data and not (data.get("status") == "queued" and not data.get("started_at")):
            runs.append(data)
    return sorted(runs, key=lambda r: r.get("created_at", ""), reverse=True)


def save_task_result(run_id: str, task_id: str, result: dict[str, Any]) -> None:
    write_json(task_path(run_id, task_id), result)


def load_task_result(run_id: str, task_id: str) -> dict[str, Any] | None:
    return read_json(task_path(run_id, task_id))


def list_task_results(run_id: str) -> list[dict[str, Any]]:
    task_dir = run_dir(run_id) / "tasks"
    if not task_dir.exists():
        return []
    results = [read_json(path) for path in task_dir.glob("*.json")]
    return [r for r in results if r]


def clear_run(run_id: str) -> None:
    path = run_dir(run_id)
    if path.exists():
        shutil.rmtree(path)
