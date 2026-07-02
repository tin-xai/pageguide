from __future__ import annotations

import csv
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlparse

from .storage import EvalTask, current_data_csv


_GENERIC_TASK_NAMES = {
    "online_mind2web",
    "online-mind2web",
    "onlinemind2web",
}


def short_site_name(url: str) -> str:
    """Short label from a task URL, e.g. rottentomatoes.com -> rottentomatoes."""
    host = (urlparse(url or "").netloc or "").lower().split(":")[0]
    if host.startswith("www."):
        host = host[4:]
    if not host:
        return ""
    parts = host.split(".")
    if len(parts) == 2:
        return parts[0]
    return host


def display_task_name(task: EvalTask | dict) -> str:
    """Human-friendly task label for tables; Online-Mind2Web rows use the site name."""
    if isinstance(task, EvalTask):
        name = (task.name or "").strip()
        url = (task.website_url or "").strip()
    else:
        name = (task.get("name") or "").strip()
        url = (task.get("website_url") or "").strip()
    normalized = re.sub(r"[\s\-]+", "_", name.lower())
    if normalized in _GENERIC_TASK_NAMES:
        site = short_site_name(url)
        if site:
            return site
    if name:
        return name
    return short_site_name(url) or "task"


def _clean_key(key: str) -> str:
    return (key or "").strip().lower().replace(" ", "_")


def _reference_steps(norm: dict[str, str]) -> str:
    steps = norm.get("reference_steps") or norm.get("ground_truth_steps") or ""
    if ";" in steps:
        return "\n".join(part.strip() for part in steps.split(";") if part.strip())
    return steps


def _task_id(norm: dict[str, str], row_number: int) -> str:
    task_id = norm.get("task_id", "").strip()
    if task_id:
        return task_id
    seed = "|".join([
        norm.get("name", ""),
        norm.get("task", ""),
        norm.get("website_url", ""),
        str(row_number),
    ])
    return "csv-" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:12]


def _json_task_url(record: dict) -> str:
    """First usable URL among a record's key_nodes."""
    for node in record.get("key_nodes") or []:
        url = ((node or {}).get("content") or {}).get("url")
        if url:
            return str(url).strip()
    return ""


def _json_key_nodes(record: dict) -> list[dict]:
    return [node for node in (record.get("key_nodes") or []) if isinstance(node, dict)]


def _json_reference_urls(key_nodes: list[dict]) -> list[str]:
    urls: list[str] = []
    for node in key_nodes:
        url = ((node or {}).get("content") or {}).get("url")
        urls.append(str(url).strip() if url else "")
    return urls


def _json_match_functions(key_nodes: list[dict]) -> list[str]:
    return [str((node or {}).get("match_function_name") or "").strip() for node in key_nodes]


def _load_json_tasks(json_path: Path) -> list[EvalTask]:
    """Load the annotated JSON dataset (task/key_nodes/subgoals) into EvalTask rows."""
    try:
        records = json.loads(json_path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return []
    if not isinstance(records, list):
        return []
    tasks = []
    for row_number, record in enumerate(records):
        if not isinstance(record, dict):
            continue
        task_text = (record.get("task") or "").strip()
        website_url = _json_task_url(record)
        if not task_text or not website_url:
            continue
        subgoals = [str(s).strip() for s in (record.get("subgoals") or []) if str(s).strip()]
        key_nodes = _json_key_nodes(record)
        reference_steps = "\n".join(subgoals)
        index = record.get("index")
        task_id = f"annotated-{index}" if index is not None else f"annotated-row-{row_number}"
        tasks.append(EvalTask(
            name=task_text,
            task_id=task_id,
            task=task_text,
            website_url=website_url,
            reference_steps=reference_steps,
            success_criteria=reference_steps,
            annotated_subgoals=subgoals,
            annotated_key_nodes=key_nodes,
            annotated_reference_urls=_json_reference_urls(key_nodes),
            annotated_match_functions=_json_match_functions(key_nodes),
        ))
    return tasks


def load_tasks(csv_path: Path | str | None = None) -> list[EvalTask]:
    if isinstance(csv_path, str):
        csv_path = current_data_csv(csv_path)
    csv_path = csv_path or current_data_csv()
    if not csv_path.exists():
        return []

    if csv_path.suffix.lower() == ".json":
        return _load_json_tasks(csv_path)

    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        tasks = []
        for row_number, row in enumerate(reader, start=2):
            norm = {_clean_key(k): (v or "").strip() for k, v in row.items()}
            task_id = _task_id(norm, row_number)
            if not norm.get("task") or not norm.get("website_url"):
                continue
            tasks.append(EvalTask(
                name=norm.get("name", ""),
                task_id=task_id,
                task=norm.get("task", ""),
                website_url=norm.get("website_url", ""),
                ground_truth=norm.get("ground_truth", ""),
                reference_length=norm.get("reference_length", ""),
                level=norm.get("level", ""),
                popularity=norm.get("popularity", ""),
                use_case=norm.get("use_case", ""),
                need_login=norm.get("need_login", ""),
                need_user_input=norm.get("need_user_input", ""),
                notes=norm.get("notes", ""),
                reference_steps=_reference_steps(norm),
                success_criteria=norm.get("success_criteria", "") or _reference_steps(norm),
                required_test_inputs=norm.get("required_test_inputs", ""),
                allowed_stop_before_destructive_action=norm.get("allowed_stop_before_destructive_action", ""),
            ))
    return tasks


def tasks_by_id(task_set: str | None = None) -> dict[str, EvalTask]:
    return {task.task_id: task for task in load_tasks(task_set)}


def selectable_tasks(tasks: list[EvalTask] | None = None) -> list[EvalTask]:
    tasks = tasks if tasks is not None else load_tasks()
    with_ground_truth = [task for task in tasks if task.reference_steps]
    return with_ground_truth or tasks
