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

# Mirrors extension key `guideDebugRegionCapture` (side panel debug toggle).
GUIDE_REGION_CAPTURE_KEY = "guideDebugRegionCapture"
REGION_CAPTURE_LEGACY = "legacy"
REGION_CAPTURE_ALIGNED = "aligned"


def normalize_region_capture_mode(value: Any) -> str:
    v = str(value or "").strip().lower().replace("-", "_")
    if v in {REGION_CAPTURE_ALIGNED, "new", "new_target", "new_target_captured"}:
        return REGION_CAPTURE_ALIGNED
    return REGION_CAPTURE_LEGACY


def region_capture_mode_label(mode: str | None) -> str:
    return "New Target Captured" if normalize_region_capture_mode(mode) == REGION_CAPTURE_ALIGNED else "Legacy target captured"


def configured_region_capture_mode() -> str:
    return normalize_region_capture_mode(os.environ.get("PAGEGUIDE_EVAL_REGION_CAPTURE"))


def configured_task_model() -> str:
    return normalize_model(os.environ.get("PAGEGUIDE_EVAL_LLM_MODEL"))


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


def start_run(run: dict[str, Any], tasks: list[EvalTask]) -> None:
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


def stop_run(run_id: str) -> dict[str, Any]:
    stop_event = RUN_STOPS.setdefault(run_id, threading.Event())
    stop_event.set()
    loop = RUN_LOOPS.get(run_id)
    contexts = RUN_CONTEXTS.get(run_id)
    if loop and contexts:
        for context in contexts:
            try:
                asyncio.run_coroutine_threadsafe(context.close(), loop)
            except Exception:
                pass
    return _patch_run(
        run_id,
        status="stopped",
        completed_at=utc_now(),
        current_phase="stopped by user",
        error=None,
    )


def _patch_run(run_id: str, **patch: Any) -> dict[str, Any]:
    run = load_run(run_id) or {"run_id": run_id, "created_at": utc_now()}
    run.update(patch)
    return save_run(run)


async def _run_eval(run_id: str, tasks: list[EvalTask], stop_event: threading.Event) -> None:
    RUN_LOOPS[run_id] = asyncio.get_running_loop()
    RUN_CONTEXTS[run_id] = []
    runner = PlaywrightGuideRunner(run_id, LlmJudge(), _patch_run, stop_event)
    try:
        await runner.run(tasks)
        if stop_event.is_set():
            _patch_run(run_id, status="stopped", completed_at=utc_now(), current_phase="stopped by user")
        else:
            _patch_run(run_id, status="completed", completed_at=utc_now())
    except RunStopped:
        _patch_run(run_id, status="stopped", completed_at=utc_now(), current_phase="stopped by user", error=None)
    except Exception as exc:
        traceback.print_exc()
        if stop_event.is_set():
            _patch_run(run_id, status="stopped", completed_at=utc_now(), current_phase="stopped by user", error=None)
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
        self.judge_model = str(run.get("judge_model") or configured_judge_model())
        self.judge_method = normalize_judge_method(run.get("judge_method"))
        # Opt-in: inject each task's reference_steps into the guide prompt (Plot B).
        self.ground_truth_mode = bool(run.get("ground_truth_mode"))
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
            """async ({ openrouterKey, openrouterModel, maxSteps, regionCaptureMode }) => {
              const syncPrefs = {};
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
                guideDebugRegionCapture: regionCaptureMode
              });
              await chrome.storage.local.remove(['debugPrompts', 'lastDebugPrompt']);
            }""",
            {"openrouterKey": openrouter_key or "", "openrouterModel": openrouter_model, "maxSteps": self.max_steps, "regionCaptureMode": self.region_capture_mode},
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
            # Drive the guide the way the side panel does: message the content script. The
            # content script lives in an isolated world, so page.evaluate(window.*) can't reach
            # it. forcedRoute='guide' skips LLM routing; guideEvalMode/guideAutoMode auto-run it.
            await self._start_guide(extension_page, tab_id, task.task)
            diagnostics["guide_start_sent"] = True

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
        if diagnostics["step_count"] == 0:
            diagnostics["zero_step_explanation"] = _zero_step_explanation(diagnostics, terminal_reason)

        enriched_steps = enrich_step_scores(steps)
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
            await page.goto(url, wait_until="commit", timeout=20000)
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
                key === 'lastDebugPrompt'
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
                  return {
                    sessionId: current,
                    stepCount: steps.length,
                    lastIsDone: !!(last && (last.isLastStep || last.action === 'done')),
                    debugPromptCount: debugPrompts.length,
                    lastDebugPromptAction: lastDebugPrompt && lastDebugPrompt.action,
                    lastDebugPromptTimestamp: lastDebugPrompt && lastDebugPrompt.timestamp,
                  };
                }"""
            )
            last_session_id = state.get("sessionId") or last_session_id
            step_count = int(state.get("stepCount") or 0)
            if step_count != last_step_count:
                last_step_count = step_count
                idle_deadline = asyncio.get_running_loop().time() + self.idle_timeout_s
                if progress:
                    progress(step_count, "executing steps")

            if state.get("lastIsDone"):
                return {**state, "reason": "done", "sessionId": last_session_id}
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
              return { steps: out, spec_goal_text: predicted, predictedGoalState: predicted };
            }""",
            session_id,
        )
        out = []
        for rec in (data or {}).get("steps") or []:
            cleaned = dict(rec)
            for key in ("screenshot", "screenshotBefore", "screenshotAfter", "regionShot"):
                if cleaned.get(key):
                    cleaned[key] = self._save_base64(task_id, cleaned["step"], key, cleaned[key])
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


def _rel(path: Path | None) -> str | None:
    if not path:
        return None
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)
