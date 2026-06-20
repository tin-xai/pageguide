"""Resolve the browser mode/profile for evaluation runs.

Evaluation defaults to Playwright's bundled Chromium with a dedicated non-default profile.
Current Chrome builds reject remote debugging against the normal user-data directory, which
causes a blank about:blank window followed by launch timeout. Real Chrome remains an
explicit escape hatch only.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def chrome_user_data_root() -> Path:
    override = os.environ.get("PAGEGUIDE_EVAL_CHROME_USER_DATA")
    if override:
        return Path(override).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/Google/Chrome"
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA", "")
        return Path(local) / "Google/Chrome/User Data"
    return Path.home() / ".config/google-chrome"


def chrome_profile_name() -> str:
    return os.environ.get("PAGEGUIDE_EVAL_CHROME_PROFILE_NAME", "PageGuide").strip() or "PageGuide"


def resolve_chrome_profile(profile_name: str | None = None) -> tuple[Path, str] | None:
    """Return (user_data_dir, profile_directory) for a named Chrome profile, or None."""
    name = (profile_name or chrome_profile_name()).strip()
    user_data = chrome_user_data_root()
    local_state = user_data / "Local State"
    if not local_state.exists():
        return None
    try:
        data = json.loads(local_state.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    cache = data.get("profile", {}).get("info_cache", {})
    for directory, info in cache.items():
        if str(info.get("name", "")).strip().lower() == name.lower():
            return user_data, directory
    return None


def browser_mode() -> str:
    """`chromium` = bundled + unpacked extension; `chrome` = explicit real Chrome escape hatch."""
    explicit = os.environ.get("PAGEGUIDE_EVAL_BROWSER", "").strip().lower()
    if explicit in {"chrome", "chromium"}:
        return explicit
    return "chromium"


def chrome_is_running() -> bool:
    """True if Google Chrome main process is running (profile will be locked)."""
    import subprocess

    try:
        for name in ("Google Chrome",):
            result = subprocess.run(["pgrep", "-x", name], capture_output=True)
            if result.returncode == 0:
                return True
    except (FileNotFoundError, OSError):
        pass
    return False


PROFILE_LOCK_MESSAGE = """Google Chrome is still running and has locked your profile.

Quit Chrome completely before evaluation:
  • Press Cmd+Q on every Chrome window (don't just close tabs)
  • Or run: osascript -e 'quit app "Google Chrome"'

Then run ./eval_tool/run_eval.sh again."""


def ensure_chrome_profile_available() -> None:
    """Raise with a clear message if the PageGuide Chrome profile cannot be opened."""
    if browser_mode() != "chrome":
        return
    if chrome_is_running():
        raise RuntimeError(PROFILE_LOCK_MESSAGE)
