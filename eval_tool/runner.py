from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import os
import tempfile
import threading
import traceback
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable, Iterator
from urllib.parse import urlparse

from .chrome_profile import browser_mode, chrome_profile_name, ensure_chrome_profile_available, resolve_chrome_profile
from .judge import LlmJudge, _env_value, configured_judge_model, normalize_judge_method, normalize_model
from .webjudge import WebJudge
from .scoring import enrich_step_scores
from .step_confidence import SpecProgressClient, backfill_element_step_similarity
from .storage import EvalRun, REPO_ROOT, load_run, save_run, save_task_result, screenshot_dir, task_path, utc_now
from .tasks import EvalTask


RUN_THREADS: dict[str, threading.Thread] = {}
RUN_STOPS: dict[str, threading.Event] = {}
RUN_LOOPS: dict[str, asyncio.AbstractEventLoop] = {}
RUN_CONTEXTS: dict[str, list[Any]] = {}


class RunStopped(Exception):
    pass

# Args for bundled Chromium only (loads the unpacked extension via flags).
CHROMIUM_EXTENSION_ARGS = [
    f"--disable-extensions-except={REPO_ROOT}",
    f"--load-extension={REPO_ROOT}",
]

# Shared anti-fingerprinting flags for both Chrome and Chromium.
COMMON_BROWSER_ARGS = [
    "--no-sandbox",
    "--disable-blink-features=AutomationControlled",
]


# Default dedicated Chromium eval profile. Used when PAGEGUIDE_EVAL_BROWSER=chromium.
DEFAULT_CHROMIUM_PROFILE = str(Path.home() / ".pageguide-eval-chromium")
DEFAULT_MAX_STEPS = 15
MIN_MAX_STEPS = 1
MAX_MAX_STEPS = 100
DEFAULT_TEMPERATURE = 0.0
MIN_TEMPERATURE = 0.0
MAX_TEMPERATURE = 2.0
DEFAULT_GROUNDING_WARNING_THRESHOLD = 0.8
DEFAULT_LOOP_WARNING_THRESHOLD = 0.3
INPUT_MODE_DOM = "dom"
INPUT_MODE_DOM_SCREENSHOT = "dom_screenshot"

# Mirrors extension key `guideDebugRegionCapture` (side panel debug toggle).
GUIDE_REGION_CAPTURE_KEY = "guideDebugRegionCapture"
REGION_CAPTURE_LEGACY = "legacy"
REGION_CAPTURE_ALIGNED = "aligned"


def normalize_region_capture_mode(value: Any) -> str:
    v = str(value or "").strip().lower().replace("-", "_")
    if v in {REGION_CAPTURE_ALIGNED, "new", "new_target", "new_target_captured"}:
        return REGION_CAPTURE_ALIGNED
    return REGION_CAPTURE_LEGACY


def normalize_input_mode(value: Any) -> str:
    v = str(value or "").strip().lower().replace("-", "_").replace("+", "_")
    if v in {INPUT_MODE_DOM_SCREENSHOT, "screenshot", "screenshots", "vision", "dom_plus_screenshot", "dom_screenshots"}:
        return INPUT_MODE_DOM_SCREENSHOT
    return INPUT_MODE_DOM


def region_capture_mode_label(mode: str | None) -> str:
    return "New Target Captured" if normalize_region_capture_mode(mode) == REGION_CAPTURE_ALIGNED else "Legacy target captured"


def configured_region_capture_mode() -> str:
    return normalize_region_capture_mode(os.environ.get("PAGEGUIDE_EVAL_REGION_CAPTURE"))


def configured_task_model() -> str:
    return normalize_model(os.environ.get("PAGEGUIDE_EVAL_LLM_MODEL"))


def normalize_temperature(value: Any, default: float = DEFAULT_TEMPERATURE) -> float:
    try:
        temperature = float(value)
    except (TypeError, ValueError):
        temperature = default
    if temperature < MIN_TEMPERATURE:
        return MIN_TEMPERATURE
    if temperature > MAX_TEMPERATURE:
        return MAX_TEMPERATURE
    return temperature


def normalize_unit_threshold(value: Any, default: float) -> float:
    try:
        threshold = float(value)
    except (TypeError, ValueError):
        threshold = default
    if threshold < 0.0:
        return 0.0
    if threshold > 1.0:
        return 1.0
    return threshold


def _id_from_path(path: str) -> str:
    digest = hashlib.sha256(path.encode("utf-8")).hexdigest()
    return "".join(chr(ord("a") + int(nibble, 16)) for nibble in digest[:32])


def expected_extension_ids(extension_path: str | Path) -> list[str]:
    """Candidate unpacked-extension IDs Chrome may assign (it hashes the absolute path).

    Chrome maps the first 16 bytes of the path's SHA-256 to the a-p alphabet. Depending on
    symlinks Chrome may use abspath or realpath, so we return both candidates. This lets us
    find the extension without relying on catching its (lazy, MV3) service worker.
    """
    candidates: list[str] = []
    for variant in (os.path.abspath(str(extension_path)), os.path.realpath(str(extension_path))):
        ext_id = _id_from_path(variant)
        if ext_id not in candidates:
            candidates.append(ext_id)
    return candidates


def profile_dir() -> str | None:
    """Resolve the profile folder for bundled-Chromium mode.

    Ignored when browser_mode() is `chrome` (real Chrome user data is used instead).
    Set `PAGEGUIDE_EVAL_PROFILE=temp` for a throwaway Chromium profile.
    """
    value = os.environ.get("PAGEGUIDE_EVAL_PROFILE")
    if value is None:
        return DEFAULT_CHROMIUM_PROFILE
    if value.strip().lower() in {"temp", "tmp", "none", ""}:
        return None
    return str(Path(value).expanduser())


def launch_kwargs(headless: bool) -> dict[str, Any]:
    """Launch options for the active browser mode.

    - **chromium** (default): Playwright's bundled Chromium with `--load-extension`.
    - **chrome**: explicit escape hatch for branded Chrome with a named profile.
    """
    mode = browser_mode()
    args = list(COMMON_BROWSER_ARGS)
    channel = "chromium"

    if mode == "chrome":
        resolved = resolve_chrome_profile()
        if not resolved:
            raise RuntimeError(
                "PAGEGUIDE_EVAL_BROWSER=chrome but no Chrome profile named "
                f"'{chrome_profile_name()}' was found. Create it in Chrome's profile "
                "picker, install PageGuide via chrome://extensions → Load unpacked, "
                "or set PAGEGUIDE_EVAL_BROWSER=chromium."
            )
        _, profile_directory = resolved
        args.append(f"--profile-directory={profile_directory}")
        channel = "chrome"
    else:
        args = CHROMIUM_EXTENSION_ARGS + args

    kwargs: dict[str, Any] = {
        "headless": headless,
        "args": args,
        # Playwright defaults include --disable-extensions, which turns off the installed
        # PageGuide extension in real Chrome profiles. Drop that in chrome mode.
        "ignore_default_args": ["--enable-automation"]
        + (["--disable-extensions"] if mode == "chrome" else []),
    }
    if channel != "chromium":
        kwargs["channel"] = channel
    return kwargs


def launch_user_data_dir() -> str:
    """Directory passed to launch_persistent_context for the active browser mode."""
    if browser_mode() == "chrome":
        resolved = resolve_chrome_profile()
        if not resolved:
            raise RuntimeError("Chrome PageGuide profile not found.")
        return str(resolved[0])
    persistent = profile_dir()
    if persistent:
        Path(persistent).mkdir(parents=True, exist_ok=True)
        return persistent
    raise RuntimeError("No profile directory available for Chromium mode.")


@contextlib.contextmanager
def _resolve_profile(worker_id: int | None = None) -> Iterator[str]:
    """Yield the user-data directory for launch_persistent_context."""
    if browser_mode() == "chrome":
        user_data = launch_user_data_dir()
        if not Path(user_data).exists():
            raise RuntimeError(
                f"Chrome user data not found at {user_data}. Install Google Chrome first."
            )
        yield user_data
        return
    persistent = profile_dir()
    if persistent:
        if worker_id is not None:
            persistent = f"{persistent}-worker-{worker_id}"
        Path(persistent).mkdir(parents=True, exist_ok=True)
        yield persistent
    else:
        prefix = f"pageguide-eval-worker-{worker_id}-" if worker_id is not None else "pageguide-eval-"
        with tempfile.TemporaryDirectory(prefix=prefix) as tmp:
            yield tmp


def create_run(task_ids: list[str]) -> dict[str, Any]:
    run = EvalRun(
        run_id="run-" + uuid.uuid4().hex[:12],
        created_at=utc_now(),
        task_ids=task_ids,
    )
    return save_run(run)


def normalize_max_steps(value: Any) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return DEFAULT_MAX_STEPS
    return max(MIN_MAX_STEPS, min(MAX_MAX_STEPS, number))


# Opaque terminal reasons that we try to re-attribute to a concrete cause (bot_block /
# llm_empty_response). "done" / "max_steps" / "force_ground_truth_verifier_failed" /
# "FAILED TO EXECUTE ACTION" are already meaningful and left untouched.
_RECLASSIFIABLE_REASONS = {"idle_timeout", "NO STEPS RECORDED", "task_timeout", "UNKNOWN FAILURE"}
# Cloudflare / challenge markers that appear in the URL of an active bot-block page.
_BOT_BLOCK_URL_MARKERS = ("__cf_chl", "/cdn-cgi/challenge", "cf_chl_")
# Interstitial-specific phrases. Kept narrow (no bare "captcha"/"recaptcha") so a page that merely
# embeds a captcha widget in its normal flow is not misread as a block.
_BOT_BLOCK_TEXT_MARKERS = (
    "verify you are human",
    "verify you are a human",
    "please verify you are a human",
    "checking your browser before",
    "checking if the site connection is secure",
    "unusual traffic from your",
    "pardon our interruption",
    "request unsuccessful. incapsula",
    "px-captcha",
    "are you a robot",
    "enable javascript and cookies to continue",
    "why do i have to complete a captcha",
)


def classify_failure_reason(
    terminal_reason: str,
    *,
    final_url: str | None = None,
    steps: list[dict[str, Any]] | None = None,
    debug_prompts: list[dict[str, Any]] | None = None,
    nav_http_status: int | None = None,
) -> str:
    """Re-attribute an opaque terminal_reason to a concrete cause when the evidence supports it.

    Returns `bot_block` (site blocked the automation) or `llm_empty_response` (the model/provider
    returned nothing, so no step could be built), else the original reason. Pure — unit-testable.
    Precision over recall: only strong signals (cloudflare URL token, HTTP 403/429, block-page
    phrases) trigger bot_block.
    """
    if terminal_reason not in _RECLASSIFIABLE_REASONS:
        return terminal_reason
    steps = steps or []
    debug_prompts = debug_prompts or []
    non_initial = [s for s in steps if not s.get("isInitial")]

    if nav_http_status in (403, 429):
        return "bot_block"

    urls = " ".join([str(final_url or "")] + [str(s.get("url") or "") for s in steps]).lower()
    if any(marker in urls for marker in _BOT_BLOCK_URL_MARKERS):
        return "bot_block"

    haystack = urls
    for prompt in debug_prompts:
        haystack += " " + str(prompt.get("userPrompt") or "").lower()
    if any(marker in haystack for marker in _BOT_BLOCK_TEXT_MARKERS):
        return "bot_block"

    # No committed step and the last LLM call errored / came back empty → provider throttle/flakiness.
    if not non_initial and debug_prompts:
        last = debug_prompts[-1]
        if last.get("responseError") or not str(last.get("responseContent") or "").strip():
            return "llm_empty_response"

    return terminal_reason


def _zero_step_explanation(diagnostics: dict[str, Any], terminal_reason: str) -> str:
    if diagnostics.get("error"):
        return "The evaluator hit an exception before any PageGuide step was recorded."
    if not diagnostics.get("tab_found"):
        return "The evaluator loaded the page but could not match it to a browser tab for PageGuide."
    if not diagnostics.get("content_script_ready"):
        return "The PageGuide content script did not respond on this page before the evaluator timed out."
    if not diagnostics.get("guide_start_sent"):
        return "The evaluator did not finish sending the task to PageGuide."
    if int(diagnostics.get("debug_prompt_count") or 0) == 0:
        return "PageGuide was started, but no LLM prompt/debug record or rewind step was observed before the idle timeout."
    if terminal_reason == "done":
        return "PageGuide reported completion, but no rewind steps were recorded for this task."
    return "PageGuide produced no recorded action steps before the evaluator stopped waiting."


# Runs halted with pause_run (vs stop_run) are marked "paused" so the UI can offer a
# Resume action; the flag is consulted by _run_eval when the worker unwinds.
PAUSED_RUNS: set[str] = set()


def start_run(run: dict[str, Any], tasks: list[EvalTask]) -> None:
    PAUSED_RUNS.discard(run["run_id"])
    stop_event = threading.Event()
    RUN_STOPS[run["run_id"]] = stop_event
    _patch_run(
        run["run_id"],
        status="running",
        started_at=utc_now(),
        error=None,
        task_total=len(tasks),
        completed_tasks=0,
        progress=f"0/{len(tasks)}",
        current_step=0,
        current_phase="queued",
    )
    thread = threading.Thread(target=lambda: asyncio.run(_run_eval(run["run_id"], tasks, stop_event)), daemon=True)
    RUN_THREADS[run["run_id"]] = thread
    try:
        thread.start()
    except Exception as exc:
        _patch_run(run["run_id"], status="failed", completed_at=utc_now(), error=str(exc))
        raise


def is_running(run_id: str) -> bool:
    thread = RUN_THREADS.get(run_id)
    return bool(thread and thread.is_alive())


def _halt_run(run_id: str, *, status: str, phase: str) -> dict[str, Any]:
    stop_event = RUN_STOPS.setdefault(run_id, threading.Event())
    stop_event.set()
    loop = RUN_LOOPS.get(run_id)
    contexts = RUN_CONTEXTS.get(run_id)
    if loop and contexts:
        for context in list(contexts):
            try:
                asyncio.run_coroutine_threadsafe(context.close(), loop)
            except Exception:
                pass
    return _patch_run(run_id, status=status, completed_at=utc_now(), current_phase=phase, error=None)


def stop_run(run_id: str) -> dict[str, Any]:
    PAUSED_RUNS.discard(run_id)
    return _halt_run(run_id, status="stopped", phase="stopped by user")


def pause_run(run_id: str) -> dict[str, Any]:
    """Gracefully halt a run but mark it 'paused' so it can be resumed later."""
    PAUSED_RUNS.add(run_id)
    return _halt_run(run_id, status="paused", phase="paused by user")


def _patch_run(run_id: str, **patch: Any) -> dict[str, Any]:
    run = load_run(run_id) or {"run_id": run_id, "created_at": utc_now()}
    run.update(patch)
    return save_run(run)


# Single-task backfill: evaluate one task INTO an existing run without touching
# that run's run.json metadata (status, task_total, progress). Used to fill a
# missing/stale task into an already-completed run. Progress is tracked purely
# in memory so the run's stored summary is left intact.
SINGLE_TASK_THREADS: dict[str, threading.Thread] = {}
SINGLE_TASK_PROGRESS: dict[str, dict[str, Any]] = {}


def single_task_running(run_id: str) -> bool:
    thread = SINGLE_TASK_THREADS.get(run_id)
    return bool(thread and thread.is_alive())


def single_task_progress(run_id: str) -> dict[str, Any] | None:
    return SINGLE_TASK_PROGRESS.get(run_id)


def start_single_task(run: dict[str, Any], task: EvalTask) -> None:
    """Evaluate a single ``task`` into an existing run in a background thread.

    The task result file is saved (overwriting any stale result) using the run's
    existing configuration, but ``run.json`` is never rewritten, so a completed
    run keeps its status/metadata. Any composite run that sources this run picks
    up the refreshed result automatically. Raises if a single-task evaluation is
    already in flight for this run.
    """
    run_id = run["run_id"]
    if single_task_running(run_id):
        raise RuntimeError("A single-task evaluation is already running for this run.")
    stop_event = threading.Event()
    SINGLE_TASK_PROGRESS[run_id] = {
        "task_id": task.task_id,
        "status": "running",
        "phase": "queued",
        "error": None,
        "started_at": utc_now(),
        "completed_at": None,
    }

    def _progress(rid: str, **patch: Any) -> dict[str, Any]:
        state = SINGLE_TASK_PROGRESS.get(rid)
        if state is None:
            return {}
        phase = patch.get("current_phase")
        if phase:
            state["phase"] = phase
        return state

    def _worker() -> None:
        try:
            asyncio.run(_run_single_task_eval(run_id, task, _progress, stop_event))
            state = SINGLE_TASK_PROGRESS.get(run_id)
            if state is not None and state.get("status") == "running":
                state["status"] = "completed"
        except Exception as exc:  # noqa: BLE001 - surface any failure to the UI
            state = SINGLE_TASK_PROGRESS.get(run_id)
            if state is not None:
                state["status"] = "failed"
                state["error"] = str(exc)
        finally:
            state = SINGLE_TASK_PROGRESS.get(run_id)
            if state is not None:
                state["completed_at"] = utc_now()

    thread = threading.Thread(target=_worker, daemon=True)
    SINGLE_TASK_THREADS[run_id] = thread
    thread.start()


async def _run_single_task_eval(
    run_id: str,
    task: EvalTask,
    progress_cb: Callable[..., dict[str, Any]],
    stop_event: threading.Event,
) -> None:
    result_path = task_path(run_id, task.task_id)
    before_mtime = result_path.stat().st_mtime if result_path.exists() else None
    # _run_in_browser indexes RUN_CONTEXTS[run_id] directly, so it must be seeded (as
    # _run_eval does) or the worker raises KeyError, which run() swallows via its
    # return_exceptions=True gather.
    RUN_LOOPS[run_id] = asyncio.get_running_loop()
    RUN_CONTEXTS[run_id] = []
    try:
        runner = PlaywrightGuideRunner(run_id, LlmJudge(), progress_cb, stop_event)
        await runner.run([task])
    finally:
        RUN_CONTEXTS.pop(run_id, None)
        RUN_LOOPS.pop(run_id, None)
    # run() gathers worker exceptions with return_exceptions=True, so any failure inside a
    # worker is swallowed and no result is written. Detect that a result was actually
    # (re)saved so the caller can report a real failure instead of a false success.
    saved = result_path.exists() and (before_mtime is None or result_path.stat().st_mtime > before_mtime)
    if not saved:
        raise RuntimeError(
            "The evaluation finished without saving a result for this task (PageGuide "
            "reported no completed steps). Check the server terminal for a traceback and retry."
        )


def start_single_task_batch(run: dict[str, Any], tasks: list[EvalTask]) -> None:
    """Evaluate several tasks into an existing run in one background job, without mutating
    run.json. Uses the run's own worker concurrency. Progress is tracked in-memory (shared
    with single-task progress, keyed by run_id) so the same banner/status endpoint reports it.
    """
    run_id = run["run_id"]
    if single_task_running(run_id):
        raise RuntimeError("A task evaluation is already running for this run.")
    tasks = list(tasks or [])
    if not tasks:
        return
    stop_event = threading.Event()
    SINGLE_TASK_PROGRESS[run_id] = {
        "task_id": f"{len(tasks)} tasks",
        "status": "running",
        "phase": "queued",
        "completed": 0,
        "total": len(tasks),
        "error": None,
        "started_at": utc_now(),
        "completed_at": None,
    }

    def _progress(rid: str, **patch: Any) -> dict[str, Any]:
        state = SINGLE_TASK_PROGRESS.get(rid)
        if state is None:
            return {}
        phase = patch.get("current_phase")
        if phase:
            state["phase"] = phase
        if "completed_tasks" in patch:
            state["completed"] = patch["completed_tasks"]
        return state

    def _worker() -> None:
        try:
            asyncio.run(_run_task_batch_eval(run_id, tasks, _progress, stop_event))
            state = SINGLE_TASK_PROGRESS.get(run_id)
            if state is not None and state.get("status") == "running":
                state["status"] = "completed"
        except Exception as exc:  # noqa: BLE001 - surface any failure to the UI
            state = SINGLE_TASK_PROGRESS.get(run_id)
            if state is not None:
                state["status"] = "failed"
                state["error"] = str(exc)
        finally:
            state = SINGLE_TASK_PROGRESS.get(run_id)
            if state is not None:
                state["completed_at"] = utc_now()

    thread = threading.Thread(target=_worker, daemon=True)
    SINGLE_TASK_THREADS[run_id] = thread
    thread.start()


async def _run_task_batch_eval(
    run_id: str,
    tasks: list[EvalTask],
    progress_cb: Callable[..., dict[str, Any]],
    stop_event: threading.Event,
) -> None:
    # Seed RUN_CONTEXTS (see _run_single_task_eval) so the worker doesn't KeyError.
    RUN_LOOPS[run_id] = asyncio.get_running_loop()
    RUN_CONTEXTS[run_id] = []
    try:
        runner = PlaywrightGuideRunner(run_id, LlmJudge(), progress_cb, stop_event)
        await runner.run(tasks)
    finally:
        RUN_CONTEXTS.pop(run_id, None)
        RUN_LOOPS.pop(run_id, None)


async def _run_eval(run_id: str, tasks: list[EvalTask], stop_event: threading.Event) -> None:
    RUN_LOOPS[run_id] = asyncio.get_running_loop()
    RUN_CONTEXTS[run_id] = []
    runner = PlaywrightGuideRunner(run_id, LlmJudge(), _patch_run, stop_event)
    # A halted run is "paused" (resumable) if pause_run flagged it, else "stopped".
    halt_status = lambda: "paused" if run_id in PAUSED_RUNS else "stopped"
    halt_phase = lambda: "paused by user" if run_id in PAUSED_RUNS else "stopped by user"
    try:
        await runner.run(tasks)
        if stop_event.is_set():
            _patch_run(run_id, status=halt_status(), completed_at=utc_now(), current_phase=halt_phase())
        else:
            _patch_run(run_id, status="completed", completed_at=utc_now())
    except RunStopped:
        _patch_run(run_id, status=halt_status(), completed_at=utc_now(), current_phase=halt_phase(), error=None)
    except Exception as exc:
        traceback.print_exc()
        if stop_event.is_set():
            _patch_run(run_id, status=halt_status(), completed_at=utc_now(), current_phase=halt_phase(), error=None)
        else:
            _patch_run(run_id, status="failed", completed_at=utc_now(), error=str(exc))
    finally:
        RUN_CONTEXTS.pop(run_id, None)
        RUN_LOOPS.pop(run_id, None)
        RUN_STOPS.pop(run_id, None)


class PlaywrightGuideRunner:
    def __init__(
        self,
        run_id: str,
        judge: LlmJudge,
        patch_run: Callable[..., dict[str, Any]],
        stop_event: threading.Event | None = None,
    ) -> None:
        self.run_id = run_id
        self.judge = judge
        self.patch_run = patch_run
        self.stop_event = stop_event or threading.Event()
        self.timeout_s = int(os.environ.get("PAGEGUIDE_EVAL_TASK_TIMEOUT", "240"))
        self.idle_timeout_s = int(os.environ.get("PAGEGUIDE_EVAL_IDLE_TIMEOUT", "45"))
        self.launch_timeout_s = int(os.environ.get("PAGEGUIDE_EVAL_LAUNCH_TIMEOUT", "60"))
        self.extension_timeout_s = int(os.environ.get("PAGEGUIDE_EVAL_EXTENSION_TIMEOUT", "60"))
        run = load_run(run_id) or {}
        self.max_steps = normalize_max_steps(os.environ.get("PAGEGUIDE_EVAL_MAX_STEPS") or run.get("max_steps"))
        self.workers = int(run.get("workers") or 1)
        self.task_model = str(run.get("task_model") or configured_task_model())
        self.temperature = normalize_temperature(os.environ.get("PAGEGUIDE_EVAL_TEMPERATURE") or run.get("temperature"))
        self.judge_model = str(run.get("judge_model") or configured_judge_model())
        self.judge_method = normalize_judge_method(run.get("judge_method"))
        # Opt-in: inject each task's reference_steps into the guide prompt (Plot B).
        self.ground_truth_mode = bool(run.get("ground_truth_mode"))
        self.include_oracle_plan = bool(run.get("include_oracle_plan"))
        self.force_ground_truth_mode = bool(run.get("force_ground_truth_mode"))
        try:
            self.force_ground_truth_retries = int(run.get("force_ground_truth_retries") or 0)
        except (TypeError, ValueError):
            self.force_ground_truth_retries = 0
        self.force_ground_truth_retries = max(0, min(2, self.force_ground_truth_retries))
        self.inject_grounding_warning = bool(run.get("inject_grounding_warning"))
        self.inject_looping_warning = bool(run.get("inject_looping_warning"))
        self.grounding_warning_threshold = normalize_unit_threshold(
            run.get("grounding_warning_threshold"), DEFAULT_GROUNDING_WARNING_THRESHOLD
        )
        self.loop_warning_threshold = normalize_unit_threshold(
            run.get("loop_warning_threshold"), DEFAULT_LOOP_WARNING_THRESHOLD
        )
        self.automatic_planning_mode = bool(run.get("automatic_planning_mode"))
        self.input_mode = normalize_input_mode(run.get("input_mode"))
        self.region_capture_mode = normalize_region_capture_mode(
            run.get("region_capture_mode") or os.environ.get("PAGEGUIDE_EVAL_REGION_CAPTURE")
        )
        # Default to headful: MV3 extensions are unreliable in headless Chrome. Opt into
        # headless with PAGEGUIDE_EVAL_HEADLESS=1.
        self.headless = os.environ.get("PAGEGUIDE_EVAL_HEADLESS") == "1"
        # Auto-login is opt-in. Public/no-login tasks such as Expedia should start
        # immediately without waiting on providers that block scripted sign-in.
        self.auto_login = os.environ.get("PAGEGUIDE_EVAL_AUTO_LOGIN", "0") not in {"0", "false", "False"}

    def _check_stop(self) -> None:
        if self.stop_event.is_set():
            raise RunStopped()

    async def run(self, tasks: list[EvalTask]) -> None:
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise RuntimeError("Install eval dependencies first: pip install -r eval_tool/requirements.txt") from exc

        async with async_playwright() as pw:
            self.total_tasks = len(tasks)
            self.completed_tasks = 0
            self.update_lock = asyncio.Lock()
            
            queue = asyncio.Queue()
            for task in tasks:
                queue.put_nowait(task)
                
            self.patch_run(self.run_id, current_phase="launching browsers", task_total=self.total_tasks, progress=f"0/{self.total_tasks}")
            
            worker_tasks = []
            num_workers = min(self.workers, self.total_tasks)
            for i in range(num_workers):
                worker_tasks.append(asyncio.create_task(self._browser_worker_loop(pw, queue, worker_id=i)))
                
            await asyncio.gather(*worker_tasks, return_exceptions=True)

    async def _browser_worker_loop(self, pw: Any, queue: asyncio.Queue, worker_id: int) -> None:
        try:
            await self._run_in_browser(pw, queue, headless=self.headless, worker_id=worker_id)
        except RuntimeError as exc:
            if self.headless and "Could not find PageGuide extension service worker" in str(exc):
                # Try falling back to headful if headless fails to load the extension
                await self._run_in_browser(pw, queue, headless=False, worker_id=worker_id)
            else:
                raise

    async def _run_in_browser(self, pw: Any, queue: asyncio.Queue, headless: bool, worker_id: int) -> None:
        ensure_chrome_profile_available()
        with _resolve_profile(worker_id) as profile:
            self._check_stop()
            self.patch_run(self.run_id, current_phase="launching browser", task_total=self.total_tasks, progress=f"0/{self.total_tasks}")
            context = await asyncio.wait_for(
                pw.chromium.launch_persistent_context(
                    profile,
                    **launch_kwargs(headless),
                ),
                timeout=self.launch_timeout_s,
            )
            RUN_CONTEXTS[self.run_id].append(context)
            try:
                self._check_stop()
                await self._auto_login(context)
                self._check_stop()
                self.patch_run(self.run_id, current_phase="opening PageGuide extension")
                extension_page = await asyncio.wait_for(
                    self._open_extension_page(context),
                    timeout=self.extension_timeout_s,
                )
                self._check_stop()
                await self._set_eval_prefs(extension_page)

                while not queue.empty():
                    self._check_stop()
                    try:
                        task = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    
                    try:
                        result = await self._run_task(context, extension_page, task)
                        self._check_stop()
                        save_task_result(self.run_id, task.task_id, result)
                    finally:
                        async with self.update_lock:
                            self.completed_tasks += 1
                            self.patch_run(
                                self.run_id, 
                                status="running", 
                                completed_tasks=self.completed_tasks, 
                                task_total=self.total_tasks,
                                progress=f"{self.completed_tasks}/{self.total_tasks}",
                                current_phase="running tasks"
                            )
                        queue.task_done()
            finally:
                if context in RUN_CONTEXTS.get(self.run_id, []):
                    RUN_CONTEXTS[self.run_id].remove(context)
                await context.close()

    async def _auto_login(self, context: Any) -> None:
        if not self.auto_login or os.environ.get("SKIP_LOGIN") == "1":
            return
        self._check_stop()

        try:
            from .auto_login import accounts_path, resolve_accounts
            from .credentials import password_file_path
        except Exception as exc:
            self.patch_run(self.run_id, warning=f"Auto-login unavailable: {exc}")
            return

        has_accounts_file = accounts_path().exists() or bool(os.environ.get("PAGEGUIDE_EVAL_ACCOUNTS"))
        has_password_file = password_file_path().exists() or bool(os.environ.get("PAGEGUIDE_EVAL_PASSWORD_FILE"))
        if not (has_accounts_file or has_password_file):
            return

        try:
            from .auto_login import _sign_in

            accounts = resolve_accounts()
        except BaseException as exc:
            self.patch_run(self.run_id, warning=f"Auto-login skipped: {exc}")
            return

        if not accounts:
            return

        page = context.pages[0] if context.pages else await context.new_page()
        failures: list[str] = []
        self.patch_run(self.run_id, current_phase="auto-login")
        for account in accounts:
            self._check_stop()
            try:
                await _sign_in(page, account)
            except Exception as exc:
                failures.append(f"{account.name}: {type(exc).__name__}")

        if failures:
            self.patch_run(
                self.run_id,
                warning="Auto-login failed for " + ", ".join(failures)
                + ". If the site blocks scripted login, run python -m eval_tool.login once.",
            )

    async def _candidate_extension_ids(self, context: Any) -> list[str]:
        ids: list[str] = []

        def add(value: str | None) -> None:
            if value and value not in ids:
                ids.append(value)

        # 1. Most reliable: read the actually-loaded extension ID from chrome://extensions.
        for ext_id in await self._ids_from_extensions_page(context):
            add(ext_id)
        # 2. A live service worker / background page if one happens to be running...
        for worker in context.service_workers:
            if worker.url.startswith("chrome-extension://"):
                add(worker.url.split("/")[2])
        for bg in getattr(context, "background_pages", []) or []:
            if bg.url.startswith("chrome-extension://"):
                add(bg.url.split("/")[2])
        if not ids:
            try:
                worker = await context.wait_for_event("serviceworker", timeout=3000)
                if worker.url.startswith("chrome-extension://"):
                    add(worker.url.split("/")[2])
            except Exception:
                pass
        # 3. Deterministic, path-derived IDs (MV3 SWs are lazy, so this is the safety net).
        for ext_id in expected_extension_ids(REPO_ROOT):
            add(ext_id)
        return ids

    async def _ids_from_extensions_page(self, context: Any) -> list[str]:
        page = await context.new_page()
        try:
            await page.goto("chrome://extensions/", timeout=10000)
            ids = await page.evaluate(
                """() => {
                  try {
                    const mgr = document.querySelector('extensions-manager');
                    const list = mgr.shadowRoot.querySelector('extensions-item-list');
                    const items = list.shadowRoot.querySelectorAll('extensions-item');
                    return Array.from(items).map((el) => el.id).filter(Boolean);
                  } catch (e) { return []; }
                }"""
            )
            return ids or []
        except Exception:
            return []
        finally:
            await page.close()

    async def _open_extension_page(self, context: Any) -> Any:
        candidates = await self._candidate_extension_ids(context)
        page = await context.new_page()
        attempts: list[str] = []
        for extension_id in candidates:
            url = f"chrome-extension://{extension_id}/sidepanel/panel.html"
            try:
                await page.goto(url, timeout=20000)
                await page.wait_for_function(
                    "() => !!(window.chrome && chrome.storage && chrome.storage.local)",
                    timeout=10000,
                )
                return page
            except Exception as exc:
                attempts.append(f"{extension_id}: {type(exc).__name__}: {str(exc).splitlines()[0]}")
                continue
        # Most often this means the extension did not load (e.g. headless Chromium), which
        # the caller handles by retrying headful.
        detail = " | ".join(attempts) if attempts else "no candidate IDs"
        raise RuntimeError(f"Could not find PageGuide extension service worker (tried: {detail})")

    async def _set_eval_prefs(self, extension_page: Any) -> None:
        await self._apply_region_capture_mode(extension_page)
        openrouter_key = _env_value("OPENROUTER_API_KEY", "OPEN_REUTER_API_KEY", "open-reuter-api-key")
        openrouter_model = self.task_model
        await extension_page.evaluate(
            """async ({ openrouterKey, openrouterModel, maxSteps, temperature, inputMode, regionCaptureMode, groundingWarning, loopingWarning, groundingThreshold, loopThreshold, planningMode }) => {
              const syncPrefs = { visionEnabled: inputMode === 'dom_screenshot' };
              if (openrouterKey) {
                syncPrefs.provider = 'openrouter';
                syncPrefs.openrouterApiKey = openrouterKey;
                syncPrefs.openrouterModel = openrouterModel;
              }
              if (Object.keys(syncPrefs).length) {
                await chrome.storage.sync.set(syncPrefs);
              }
              await chrome.storage.local.set({
                guideAutoMode: true,
                rewindCaptureEnabled: true,
                guideEvalMode: true,
                guideConfidenceFormula: 'full',
                guideEvalMaxSteps: maxSteps,
                guideEvalTemperature: temperature,
                guideDebugRegionCapture: regionCaptureMode,
                guideEvalGroundingWarningEnabled: groundingWarning,
                guideEvalLoopWarningEnabled: loopingWarning,
                guideDebugPlanningMode: planningMode,
                guideEvalGroundingWarningThreshold: groundingThreshold,
                guideEvalLoopWarningThreshold: loopThreshold
              });
              await chrome.storage.local.remove([
                'debugPrompts',
                'lastDebugPrompt',
                'guideForceGroundTruthFailure',
                'guideForceGroundTruthMode',
                'guideForceGroundTruthRetries',
                'guideForceGroundTruthPlan'
              ]);
            }""",
            {
                "openrouterKey": openrouter_key or "",
                "openrouterModel": openrouter_model,
                "maxSteps": self.max_steps,
                "temperature": self.temperature,
                "inputMode": self.input_mode,
                "regionCaptureMode": self.region_capture_mode,
                "groundingWarning": self.inject_grounding_warning,
                "loopingWarning": self.inject_looping_warning,
                "groundingThreshold": self.grounding_warning_threshold,
                "loopThreshold": self.loop_warning_threshold,
                "planningMode": "planning" if self.automatic_planning_mode else "direct",
            },
        )

    async def _apply_region_capture_mode(self, extension_page: Any) -> None:
        mode = self.region_capture_mode
        await extension_page.evaluate(
            """async (regionCaptureMode) => {
              await chrome.storage.local.set({ guideDebugRegionCapture: regionCaptureMode });
            }""",
            mode,
        )

    async def _run_task(
        self, context: Any, extension_page: Any, task: EvalTask, index: int = 1, total: int = 1
    ) -> dict[str, Any]:
        task_data = asdict(task)
        await self._clear_task_storage(extension_page)
        await self._close_task_pages(context, keep=extension_page)
        page = await context.new_page()
        final_screenshot: Path | None = None
        terminal_reason = "UNKNOWN FAILURE"
        session_id = None
        started_at = utc_now()
        error = None
        diagnostics: dict[str, Any] = {
            "requested_url": task.website_url,
            "phase": "created task page",
            "content_script_ready": False,
            "tab_found": False,
            "guide_start_sent": False,
            "step_count": 0,
            "debug_prompt_count": 0,
            "idle_timeout_s": self.idle_timeout_s,
            "task_timeout_s": self.timeout_s,
            "max_steps": self.max_steps,
            "task_model": self.task_model,
            "judge_model": self.judge_model,
            "input_mode": self.input_mode,
        }

        def progress(step: int, phase: str) -> None:
            diagnostics["phase"] = phase
            self.patch_run(
                self.run_id,
                status="running",
                current_phase=phase,
            )

        try:
            progress(0, "loading page")
            await self._navigate_to_task(page, task.website_url, diagnostics)
            diagnostics["loaded_url"] = page.url
            host = urlparse(task.website_url).netloc.replace("www.", "")
            tab_id = await self._wait_for_tab(extension_page, host)
            if tab_id is None:
                raise RuntimeError("Could not locate the task tab to drive the guide")
            diagnostics["tab_found"] = True
            diagnostics["tab_id"] = tab_id
            await self._wait_for_content_script(extension_page, tab_id)
            diagnostics["content_script_ready"] = True
            # Fresh rewind session for this task.
            diagnostics["reset_response"] = await self._send_to_tab(extension_page, tab_id, {"action": "reset"})
            await self._clear_task_storage(extension_page)
            await self._apply_region_capture_mode(extension_page)
            progress(0, "starting guide")
            # Inject (or clear) this task's ground-truth reference steps before starting.
            await self._set_ground_truth_steps(extension_page, task)
            await self._set_force_ground_truth_plan(extension_page, task)
            guide_query = self._guide_query_for_task(task)
            oracle_plan = self._oracle_plan_for_task(task)
            # Drive the guide the way the side panel does: message the content script. The
            # content script lives in an isolated world, so page.evaluate(window.*) can't reach
            # it. forcedRoute='guide' skips LLM routing; guideEvalMode/guideAutoMode auto-run it.
            await self._start_guide(extension_page, tab_id, guide_query)
            diagnostics["guide_start_sent"] = True
            diagnostics["include_oracle_plan"] = bool(oracle_plan)
            diagnostics["force_ground_truth_mode"] = self.force_ground_truth_mode
            diagnostics["force_ground_truth_retries"] = self.force_ground_truth_retries

            status = await self._poll_task(extension_page, progress)
            terminal_reason = status.get("reason", terminal_reason)
            session_id = status.get("sessionId")
            diagnostics.update({
                "poll_reason": terminal_reason,
                "session_id": session_id,
                "step_count": int(status.get("stepCount") or 0),
                "debug_prompt_count": int(status.get("debugPromptCount") or 0),
                "last_debug_prompt_action": status.get("lastDebugPromptAction"),
                "last_debug_prompt_timestamp": status.get("lastDebugPromptTimestamp"),
            })

        except Exception as exc:
            error = str(exc)
            diagnostics["error"] = error
            terminal_reason = "FAILED TO EXECUTE ACTION"
        finally:
            diagnostics["final_url"] = getattr(page, "url", None)
            shot_dir = screenshot_dir(self.run_id, task.task_id)
            shot_dir.mkdir(parents=True, exist_ok=True)
            final_screenshot = shot_dir / "final.png"
            try:
                await page.screenshot(path=str(final_screenshot), full_page=False)
            except Exception:
                final_screenshot = None

        steps = await self._load_rewind_steps(extension_page, session_id, task.task_id)
        spec_goal_text = None
        if isinstance(steps, dict):
            spec_goal_text = steps.get("spec_goal_text") or steps.get("predictedGoalState")
            steps = steps.get("steps") or []
        debug_prompts = await self._load_debug_prompts(extension_page)
        diagnostics["step_count"] = len([s for s in steps if not s.get("isInitial")])
        diagnostics["debug_prompt_count"] = len(debug_prompts)
        if debug_prompts:
            last_prompt = debug_prompts[-1]
            diagnostics["last_debug_prompt_action"] = last_prompt.get("action")
            diagnostics["last_debug_prompt_timestamp"] = last_prompt.get("timestamp")
        if not steps and terminal_reason == "UNKNOWN FAILURE":
            terminal_reason = "NO STEPS RECORDED"
        # Re-attribute an opaque timeout/no-steps to a concrete cause (bot_block / llm_empty_response)
        # so eval failures reflect real errors instead of a catch-all timeout.
        reclassified = classify_failure_reason(
            terminal_reason,
            final_url=diagnostics.get("final_url"),
            steps=steps,
            debug_prompts=debug_prompts,
            nav_http_status=diagnostics.get("nav_http_status"),
        )
        if reclassified != terminal_reason:
            diagnostics["reclassified_from"] = terminal_reason
            terminal_reason = reclassified
        if diagnostics["step_count"] == 0:
            diagnostics["zero_step_explanation"] = _zero_step_explanation(diagnostics, terminal_reason)

        oracle_plan = self._oracle_plan_for_task(task)
        guide_query = self._guide_query_for_task(task)
        self._attach_oracle_plan_to_steps(steps, oracle_plan, guide_query)
        if oracle_plan:
            task_data["oracle_plan"] = oracle_plan
            task_data["guide_query_with_oracle_plan"] = guide_query
        enriched_steps = enrich_step_scores(steps)
        # DOM+Screenshot: externalize the screenshot(s) the guide sent to the LLM and link the
        # file path onto each step so the inspector can show exactly what the model saw.
        debug_prompts = self._externalize_and_link_prompt_images(task.task_id, enriched_steps, debug_prompts)
        if self.judge_method == "webjudge":
            judge = WebJudge(
                model=self.judge_model, api_key=self.judge.api_key
            ).judge_trajectory(task_data, enriched_steps, final_screenshot)
        else:
            judge = self.judge.judge_final_screenshot(task_data, final_screenshot)
        result = {
            "task_id": task.task_id,
            "task": task_data,
            "status": "completed",
            "started_at": started_at,
            "completed_at": utc_now(),
            "terminal_reason": terminal_reason,
            "error": error,
            "session_id": session_id,
            "final_screenshot": _rel(final_screenshot) if final_screenshot else None,
            "judge": judge,
            "steps": enriched_steps,
            "spec_goal_text": spec_goal_text,
            "debug_prompts": debug_prompts,
            "diagnostics": diagnostics,
            "input_mode": self.input_mode,
        }
        try:
            backfill_element_step_similarity(result, SpecProgressClient())
        except Exception:
            pass
        await page.close()
        await self._close_task_pages(context, keep=extension_page)
        return result

    async def _navigate_to_task(self, page: Any, url: str, diagnostics: dict[str, Any]) -> None:
        diagnostics["navigation_strategy"] = "commit_then_best_effort_domcontentloaded"
        try:
            response = await page.goto(url, wait_until="commit", timeout=20000)
            if response is not None:
                try:
                    diagnostics["nav_http_status"] = response.status
                except Exception:
                    pass
        except Exception as exc:
            diagnostics["navigation_commit_error"] = f"{type(exc).__name__}: {str(exc).splitlines()[0]}"
            raise

        diagnostics["committed_url"] = getattr(page, "url", None)
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=15000)
            diagnostics["domcontentloaded"] = True
        except Exception as exc:
            diagnostics["domcontentloaded"] = False
            diagnostics["domcontentloaded_error"] = f"{type(exc).__name__}: {str(exc).splitlines()[0]}"

        current_url = getattr(page, "url", "") or ""
        if current_url == "about:blank":
            raise RuntimeError(f"Navigation did not leave about:blank for {url}")

    async def _wait_for_tab(self, extension_page: Any, host: str) -> int | None:
        for _ in range(20):
            tab_id = await extension_page.evaluate(
                """async (host) => {
                  const tabs = await chrome.tabs.query({});
                  const match = tabs.filter((t) => {
                    try {
                      const h = new URL(t.url).host.replace(/^www\\./, '');
                      return h && (h.includes(host) || host.includes(h));
                    } catch (e) { return false; }
                  });
                  return match.length ? match[match.length - 1].id : null;
                }""",
                host,
            )
            if tab_id is not None:
                return int(tab_id)
            await asyncio.sleep(0.5)
        return None

    async def _wait_for_content_script(self, extension_page: Any, tab_id: int) -> None:
        # A live content script answers any message (even unknown actions) instead of throwing
        # "Receiving end does not exist", so we poll a harmless ping until it responds.
        for _ in range(40):
            ok = await extension_page.evaluate(
                """async (tabId) => {
                  try { await chrome.tabs.sendMessage(tabId, { action: '__ping__' }); return true; }
                  catch (e) { return false; }
                }""",
                tab_id,
            )
            if ok:
                return
            await asyncio.sleep(0.5)
        raise RuntimeError("PageGuide content scripts did not load on the task page")

    async def _send_to_tab(self, extension_page: Any, tab_id: int, message: dict[str, Any]) -> Any:
        return await extension_page.evaluate(
            """async ({ tabId, message }) => {
              try { return await chrome.tabs.sendMessage(tabId, message); }
              catch (e) { return { error: String(e) }; }
            }""",
            {"tabId": tab_id, "message": message},
        )

    async def _clear_task_storage(self, extension_page: Any) -> None:
        # Keep this in the evaluator harness. PageGuide's reset message is still sent first,
        # but stale rewind/debug records can survive long enough for the poller to see the
        # previous task's "done" step. Clearing only eval-observation keys forces each task
        # to prove progress with a fresh session.
        await extension_page.evaluate(
            """async () => {
              const all = await chrome.storage.local.get(null);
              const keys = Object.keys(all).filter((key) =>
                key === 'RW_CURRENT' ||
                key.startsWith('RW_IDX::') ||
                key.startsWith('RW_REC::') ||
                key === 'debugPrompts' ||
                key === 'lastDebugPrompt' ||
                key === 'guideForceGroundTruthFailure'
              );
              if (keys.length) await chrome.storage.local.remove(keys);
            }"""
        )

    async def _close_task_pages(self, context: Any, keep: Any | None = None) -> None:
        for page in list(getattr(context, "pages", []) or []):
            if keep is not None and page is keep:
                continue
            try:
                url = getattr(page, "url", "") or ""
                if url.startswith("chrome-extension://"):
                    continue
                await page.close()
            except Exception:
                pass

    async def _set_ground_truth_steps(self, extension_page: Any, task: EvalTask) -> None:
        # Per-task: only set the key when ground-truth mode is on and the task has
        # reference steps; otherwise clear it so a normal run never injects GT.
        steps = (task.reference_steps or "").strip() if self.ground_truth_mode else ""
        await extension_page.evaluate(
            """async ({ steps }) => {
              if (steps) {
                await chrome.storage.local.set({ guideGroundTruthSteps: steps });
              } else {
                await chrome.storage.local.remove('guideGroundTruthSteps');
              }
            }""",
            {"steps": steps},
        )

    def _oracle_plan_for_task(self, task: EvalTask) -> str:
        if not self.include_oracle_plan:
            return ""
        steps = [line.strip() for line in (task.reference_steps or "").splitlines() if line.strip()]
        if not steps:
            return ""
        return "\n".join(f"{i}. {step}" for i, step in enumerate(steps, start=1))

    def _force_ground_truth_plan_for_task(self, task: EvalTask) -> list[dict[str, Any]]:
        if not self.force_ground_truth_mode:
            return []
        subgoals = list(task.annotated_subgoals or [])
        urls = list(task.annotated_reference_urls or [])
        matchers = list(task.annotated_match_functions or [])
        plan: list[dict[str, Any]] = []
        # Step 1 is the loaded start URL. The first action should make the browser match step 2.
        for zero_idx in range(1, min(len(subgoals), len(urls))):
            expected_url = (urls[zero_idx] or "").strip()
            subgoal = (subgoals[zero_idx] or "").strip()
            if not expected_url or not subgoal:
                continue
            plan.append({
                "step": zero_idx + 1,
                "subgoal": subgoal,
                "expectedUrl": expected_url,
                "matchFunction": matchers[zero_idx] if zero_idx < len(matchers) else "",
            })
        return plan

    async def _set_force_ground_truth_plan(self, extension_page: Any, task: EvalTask) -> None:
        plan = self._force_ground_truth_plan_for_task(task)
        await extension_page.evaluate(
            """async ({ enabled, retries, plan }) => {
              if (enabled && Array.isArray(plan) && plan.length) {
                await chrome.storage.local.set({
                  guideForceGroundTruthMode: true,
                  guideForceGroundTruthRetries: retries,
                  guideForceGroundTruthPlan: plan
                });
              } else {
                await chrome.storage.local.remove([
                  'guideForceGroundTruthMode',
                  'guideForceGroundTruthRetries',
                  'guideForceGroundTruthPlan'
                ]);
              }
            }""",
            {
                "enabled": self.force_ground_truth_mode and bool(plan),
                "retries": self.force_ground_truth_retries,
                "plan": plan,
            },
        )

    def _guide_query_for_task(self, task: EvalTask) -> str:
        query = task.task
        oracle_plan = self._oracle_plan_for_task(task)
        if oracle_plan:
            query += (
                "\n\nORACLE PLAN FROM THE ANNOTATED DATASET:\n"
                f"{oracle_plan}\n\n"
                "Use this as a reference plan for the intended task trajectory. "
                "Still inspect the current page and choose actions that are valid in the live UI."
            )
        return query

    def _attach_oracle_plan_to_steps(self, steps: list[dict[str, Any]], oracle_plan: str, guide_query: str) -> None:
        if not oracle_plan:
            return
        for step in steps:
            if not isinstance(step, dict):
                continue
            step["oraclePlanIncluded"] = True
            step["oraclePlan"] = oracle_plan
            step["guideQueryWithOraclePlan"] = guide_query

    async def _start_guide(self, extension_page: Any, tab_id: int, query: str) -> None:
        # Fire-and-forget: the guide persists across navigations via chrome.storage and would
        # otherwise reject this message the moment the task page reloads.
        await extension_page.evaluate(
            """({ tabId, query }) => {
              chrome.tabs.sendMessage(tabId, { action: 'handleQuery', query, forcedRoute: 'guide' }).catch(() => {});
            }""",
            {"tabId": tab_id, "query": query},
        )

    async def _poll_task(self, extension_page: Any, progress: Callable[[int, str], None] | None = None) -> dict[str, Any]:
        # Read progress from the rewind store in chrome.storage.local (cross-world safe), since
        # the guide's in-page state (window._guidev2) is in the content script's isolated world.
        deadline = asyncio.get_running_loop().time() + self.timeout_s
        idle_deadline = asyncio.get_running_loop().time() + self.idle_timeout_s
        last_step_count = -1
        last_session_id = None
        # Track in-flight LLM activity so idle_timeout means "genuinely hung", not "working slowly".
        # A new committed step OR a new/updated debug prompt (an LLM call being issued) counts as
        # progress and resets the idle clock.
        last_debug_count = -1
        last_debug_ts = None

        while asyncio.get_running_loop().time() < deadline:
            state = await extension_page.evaluate(
                """async () => {
                  const all = await chrome.storage.local.get(null);
                  const current = all.RW_CURRENT || null;
                  let steps = [];
                  if (current) {
                    const idx = all['RW_IDX::' + current];
                    steps = Array.isArray(idx?.steps) ? idx.steps.filter((s) => !s.isInitial) : [];
                  }
                  const debugPrompts = Array.isArray(all.debugPrompts) ? all.debugPrompts : [];
                  const lastDebugPrompt = debugPrompts.length ? debugPrompts[debugPrompts.length - 1] : null;
                  const last = steps.length ? steps[steps.length - 1] : null;
                  const forceFailure = all.guideForceGroundTruthFailure || null;
                  return {
                    sessionId: current,
                    stepCount: steps.length,
                    lastIsDone: !!(last && (last.isLastStep || last.action === 'done')),
                    forceGroundTruthFailed: !!forceFailure,
                    forceGroundTruthFailure: forceFailure,
                    debugPromptCount: debugPrompts.length,
                    lastDebugPromptAction: lastDebugPrompt && lastDebugPrompt.action,
                    lastDebugPromptTimestamp: lastDebugPrompt && lastDebugPrompt.timestamp,
                  };
                }"""
            )
            last_session_id = state.get("sessionId") or last_session_id
            step_count = int(state.get("stepCount") or 0)
            debug_count = int(state.get("debugPromptCount") or 0)
            debug_ts = state.get("lastDebugPromptTimestamp")
            step_progressed = step_count != last_step_count
            llm_active = (debug_count != last_debug_count) or (debug_ts != last_debug_ts)
            if step_progressed:
                last_step_count = step_count
                if progress:
                    progress(step_count, "executing steps")
            # Reset the idle clock on a committed step OR any in-flight LLM activity.
            if step_progressed or llm_active:
                last_debug_count = debug_count
                last_debug_ts = debug_ts
                idle_deadline = asyncio.get_running_loop().time() + self.idle_timeout_s

            if state.get("lastIsDone"):
                return {**state, "reason": "done", "sessionId": last_session_id}
            if state.get("forceGroundTruthFailed"):
                return {**state, "reason": "force_ground_truth_verifier_failed", "sessionId": last_session_id}
            if step_count >= self.max_steps:
                return {**state, "reason": "max_steps", "sessionId": last_session_id}
            if asyncio.get_running_loop().time() >= idle_deadline:
                reason = "idle_timeout" if step_count else "NO STEPS RECORDED"
                return {**state, "reason": reason, "sessionId": last_session_id}
            await asyncio.sleep(2)

        return {"reason": "task_timeout", "sessionId": last_session_id, "stepCount": last_step_count}

    async def _load_rewind_steps(self, extension_page: Any, session_id: str | None, task_id: str) -> dict[str, Any]:
        if not session_id:
            return {"steps": [], "spec_goal_text": None, "predictedGoalState": None}
        data = await extension_page.evaluate(
            """async (sessionId) => {
              const all = await chrome.storage.local.get(null);
              const current = sessionId;
              const index = all[`RW_IDX::${current}`];
              const metas = Array.isArray(index?.steps) ? index.steps.slice() : [];
              const out = [];
              for (const meta of metas) {
                const rec = all[`RW_REC::${current}::${meta.step}`] || meta;
                out.push(rec);
              }
              const predicted = index?.predictedGoalState || index?.spec_goal_text || null;
              const planning = index ? {
                plan: Array.isArray(index.plan) ? index.plan : [],
                planTitle: index.planTitle || '',
                planningPromptTimestamp: index.planningPromptTimestamp || null,
                planningSystemPrompt: index.planningSystemPrompt || '',
                planningPrompt: index.planningPrompt || '',
                planningRawResponse: index.planningRawResponse || '',
                planningResponseError: index.planningResponseError || '',
                planningMode: index.planningMode || ''
              } : null;
              return { steps: out, spec_goal_text: predicted, predictedGoalState: predicted, planning };
            }""",
            session_id,
        )
        out = []
        planning = (data or {}).get("planning") or {}
        if planning.get("planningPrompt") or planning.get("planningRawResponse") or planning.get("plan"):
            plan_lines = []
            for item in planning.get("plan") or []:
                if not isinstance(item, dict):
                    continue
                n = item.get("n") or len(plan_lines) + 1
                goal = str(item.get("goal") or "").strip()
                status = str(item.get("status") or "pending").strip()
                if goal:
                    suffix = f" [{status}]" if status else ""
                    plan_lines.append(f"{n}. {goal}{suffix}")
            instruction = "\n".join(plan_lines) or "Planning step"
            title = str(planning.get("planTitle") or "Plan").strip()
            out.append({
                "step": -1,
                "planStep": -1,
                "isInitial": True,
                "isPlanningStep": True,
                "action": "plan",
                "instruction": f"{title}\n{instruction}" if title and instruction else (title or instruction),
                "timestamp": planning.get("planningPromptTimestamp"),
                "systemPrompt": planning.get("planningSystemPrompt") or "",
                "userPrompt": planning.get("planningPrompt") or "",
                "rawLlmJson": planning.get("planningRawResponse") or planning.get("planningResponseError") or "",
                "plan": planning.get("plan") or [],
                "planTitle": title,
                "planningMode": planning.get("planningMode") or "",
            })
        for rec in (data or {}).get("steps") or []:
            cleaned = dict(rec)
            for key in ("screenshot", "screenshotBefore", "screenshotAfter", "regionShot", "promptImage"):
                if cleaned.get(key):
                    cleaned[key] = self._save_base64(task_id, cleaned["step"], key, cleaned[key])
            # Full-page DOM snapshots can be tens of MB each; inlining them makes the task
            # result JSON huge and the inspector/task pages slow to load (the whole trajectory
            # is embedded into the page). Write them to sibling files and reference by path so
            # the JSON stays small; consumers (restore/state-progress) resolve them lazily via
            # load_dom_snapshot(). See eval_tool/storage.py.
            for key in ("domSnapshot", "domSnapshotAfter"):
                if cleaned.get(key):
                    saved = self._save_text(task_id, cleaned["step"], key, cleaned[key])
                    if saved:
                        cleaned[f"{key}Path"] = saved
                        cleaned.pop(key, None)
            out.append(cleaned)
        predicted = (data or {}).get("spec_goal_text") or (data or {}).get("predictedGoalState")
        return {"steps": out, "spec_goal_text": predicted, "predictedGoalState": predicted}

    async def _load_debug_prompts(self, extension_page: Any) -> list[dict[str, Any]]:
        data = await extension_page.evaluate(
            """async () => {
              const r = await chrome.storage.local.get(['debugPrompts']);
              return Array.isArray(r.debugPrompts) ? r.debugPrompts : [];
            }"""
        )
        return data or []

    def _externalize_and_link_prompt_images(self, task_id: str, steps: list[dict[str, Any]], debug_prompts: Any) -> Any:
        """Save each debug prompt's inline LLM image to a file and attach the path to its step.

        The guide records the sent screenshot as ``imageBase64`` on the debug prompt (via the
        service worker). Inlining that base64 in the task JSON would bloat it, so write it to a
        sibling file and reference by path. Matching the debug prompt's ``metadata.step``/``mode``
        to a step sets ``promptImage`` (main call) or ``warningPromptImage`` (warning retry).
        """
        if not isinstance(debug_prompts, list):
            return debug_prompts
        by_num: dict[int, dict[str, Any]] = {}
        for step in steps or []:
            try:
                by_num[int(step.get("step"))] = step
            except (TypeError, ValueError):
                continue
        for idx, dp in enumerate(debug_prompts):
            if not isinstance(dp, dict):
                continue
            image = dp.get("imageBase64")
            if not (isinstance(image, str) and image):
                continue
            meta = dp.get("metadata") or {}
            mode = meta.get("mode")
            try:
                step_num = int(meta.get("step"))
            except (TypeError, ValueError):
                step_num = None
            step = by_num.get(step_num) if step_num is not None else None
            # The step's rewind record is the reliable source of the sent image; when it already
            # carries one, just drop the (redundant, bulky) inline base64 to keep the JSON small.
            if step is not None and mode != "guide_warning_retry" and step.get("promptImage"):
                dp["imageBase64"] = None
                continue
            path = self._save_debug_image(task_id, idx, step_num, mode, image)
            if not path:
                continue
            dp["imageBase64Path"] = path
            dp["imageBase64"] = None
            if step is not None:
                if mode == "guide_warning_retry":
                    step.setdefault("warningPromptImage", path)
                else:
                    step.setdefault("promptImage", path)
        return debug_prompts

    def _save_debug_image(self, task_id: str, idx: int, step_num: Any, mode: Any, value: str) -> str | None:
        payload = value.split(",", 1)[-1]
        label = f"{step_num if step_num is not None else 'x'}-{mode or 'llm'}"
        path = screenshot_dir(self.run_id, task_id) / f"debug-{idx}-{label}.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            path.write_bytes(base64.b64decode(payload))
        except Exception:
            return None
        return _rel(path)

    def _save_base64(self, task_id: str, step: Any, name: str, value: str) -> str:
        payload = value.split(",", 1)[-1]
        suffix = "jpg" if name != "regionShot" else "jpg"
        path = screenshot_dir(self.run_id, task_id) / f"step-{step}-{name}.{suffix}"
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            path.write_bytes(base64.b64decode(payload))
        except Exception:
            return value
        return _rel(path)

    def _save_text(self, task_id: str, step: Any, name: str, value: str) -> str | None:
        path = screenshot_dir(self.run_id, task_id) / f"step-{step}-{name}.html"
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            path.write_text(value, encoding="utf-8")
        except Exception:
            return None
        return _rel(path)


def _rel(path: Path | None) -> str | None:
    if not path:
        return None
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)
