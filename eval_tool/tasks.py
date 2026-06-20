from __future__ import annotations

import csv
import hashlib
from pathlib import Path

from .storage import EvalTask, current_data_csv


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


def load_tasks(csv_path: Path | str | None = None) -> list[EvalTask]:
    if isinstance(csv_path, str):
        csv_path = current_data_csv(csv_path)
    csv_path = csv_path or current_data_csv()
    if not csv_path.exists():
        return []

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
