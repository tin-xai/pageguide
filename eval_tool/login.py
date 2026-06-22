"""Interactive sign-in helper for the PageGuide evaluation browser.

Opens a HEADFUL browser using the same profile as evaluation runs. By default that is your
real Google Chrome profile named "PageGuide" (when it exists), so logins persist for Quora,
Google, etc. Sign in to whatever sites your tasks need, then press Enter in the terminal.

Usage (from the repo root):

    python -m eval_tool.login        # sign in once
    ./eval_tool/run_eval.sh          # runs reuse the saved login
"""

from __future__ import annotations

import asyncio

from .chrome_profile import browser_mode, ensure_chrome_profile_available, resolve_chrome_profile
from .runner import _resolve_profile, launch_kwargs


async def _main() -> None:
    if browser_mode() == "chrome":
        resolved = resolve_chrome_profile()
        if not resolved:
            raise SystemExit(
                "No Chrome profile named 'PageGuide' found.\n"
                "In Google Chrome: add a profile named PageGuide, install PageGuide via "
                "chrome://extensions → Load unpacked (this repo), then run this again."
            )
        label = f"Chrome profile '{resolved[1]}' in {resolved[0]}"
    else:
        label = "Chromium eval profile (~/.pageguide-eval-chromium)"

    ensure_chrome_profile_available()

    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise SystemExit("Install eval dependencies first: pip install -r eval_tool/requirements.txt") from exc

    async with async_playwright() as pw:
        with _resolve_profile() as profile:
            context = await pw.chromium.launch_persistent_context(
                profile,
                **launch_kwargs(headless=False),
            )
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto("https://accounts.google.com/")
            print(f"\nBrowser open with: {label}")
            print("Quit Google Chrome completely first if this fails to launch (profile lock).")
            print("Sign in to the sites your tasks need (Google, Quora, etc.).")
            print("When you are done, come back here and press Enter to save and close.\n")
            await asyncio.get_event_loop().run_in_executor(None, input)
            await context.close()
    print("Profile saved. Evaluation runs will reuse these logins automatically.")


if __name__ == "__main__":
    asyncio.run(_main())
