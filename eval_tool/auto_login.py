"""Automatically sign in to accounts listed in a credentials file, into the persistent profile.

Reads a plain-text accounts file (default: eval_tool/accounts.txt) and, for each account, opens
the login page, fills in the username and password, and submits. Sessions are saved into the
same persistent Chrome profile the evaluation uses, so runs start already logged in.

Accounts file format (one account per line, fields separated by `|`):

    name | login_url | username | password [ | user_selector | pass_selector | submit_selector ]

- Lines starting with `#` and blank lines are ignored.
- The three selectors are OPTIONAL. If omitted, sensible defaults are used:
    user_selector   -> input[type="email"], input[type="text"], input[name="username"]
    pass_selector   -> input[type="password"]
    submit_selector -> button[type="submit"], input[type="submit"]
- For two-step logins (username, then a "Next" button, then password), put the Next-button
  selector as the user_selector's submit by leaving submit_selector default; the script clicks
  submit after the username if no password field is visible yet, then fills the password.

WARNING: this file holds plaintext credentials. Keep it OUT of git (accounts.txt is gitignored).
Google and other large providers frequently block scripted logins; finish those manually via
`python -m eval_tool.login` instead.

Usage:
    python -m eval_tool.auto_login
    PAGEGUIDE_EVAL_ACCOUNTS=/path/to/accounts.txt python -m eval_tool.auto_login
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

from .credentials import (
    DEFAULT_PASS_SELECTOR,
    DEFAULT_SUBMIT_SELECTOR,
    DEFAULT_USER_SELECTORS,
    Account,
    build_accounts_from_passwords,
    password_file_path,
)
from .chrome_profile import browser_mode, ensure_chrome_profile_available, resolve_chrome_profile
from .runner import _resolve_profile, launch_kwargs, profile_dir


def accounts_path() -> Path:
    value = os.environ.get("PAGEGUIDE_EVAL_ACCOUNTS")
    if value:
        return Path(value).expanduser()
    return Path(__file__).resolve().parent / "accounts.txt"


def resolve_accounts() -> list[Account]:
    """Prefer the pipe-delimited accounts.txt; otherwise use password/password.txt + catalog."""
    pipe = accounts_path()
    if pipe.exists():
        print(f"Using accounts file: {pipe}")
        return parse_accounts(pipe)
    print(f"No accounts.txt; using password file: {password_file_path()}")
    return build_accounts_from_passwords()


def parse_accounts(path: Path) -> list[Account]:
    if not path.exists():
        raise SystemExit(
            f"No credentials file found at {path}.\n"
            "Create one (see eval_tool/accounts.example.txt) or set PAGEGUIDE_EVAL_ACCOUNTS."
        )
    accounts: list[Account] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 4:
            raise SystemExit(f"Bad line in {path} (need at least name|url|user|pass):\n  {raw}")
        fields = parts + [""] * (7 - len(parts)) if len(parts) < 7 else parts
        accounts.append(
            Account(
                name=fields[0],
                login_url=fields[1],
                username=fields[2],
                password=fields[3],
                user_selector=fields[4] or DEFAULT_USER_SELECTORS,
                pass_selector=fields[5] or DEFAULT_PASS_SELECTOR,
                submit_selector=fields[6] or DEFAULT_SUBMIT_SELECTOR,
            )
        )
    if not accounts:
        raise SystemExit(f"No accounts found in {path}.")
    return accounts


async def _sign_in(page: Any, account: Account) -> None:
    await page.goto(account.login_url, wait_until="domcontentloaded", timeout=45000)

    await page.fill(account.user_selector, account.username, timeout=15000)

    # If the password field is not visible yet, this is a two-step form: submit the username first.
    has_password = await page.locator(account.pass_selector).count()
    if not has_password:
        try:
            await page.click(account.submit_selector, timeout=5000)
        except Exception:
            await page.keyboard.press("Enter")
        await page.wait_for_selector(account.pass_selector, timeout=15000)

    await page.fill(account.pass_selector, account.password, timeout=15000)
    try:
        await page.click(account.submit_selector, timeout=5000)
    except Exception:
        await page.keyboard.press("Enter")

    # Give the site a moment to set cookies / complete redirects.
    try:
        await page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass


async def _main() -> None:
    if profile_dir() is None and browser_mode() != "chrome":
        raise SystemExit(
            "PAGEGUIDE_EVAL_PROFILE is a throwaway profile, so logins cannot be saved.\n"
            "Unset it (default) or use your Chrome PageGuide profile (PAGEGUIDE_EVAL_BROWSER=chrome)."
        )
    accounts = resolve_accounts()
    if not accounts:
        raise SystemExit("No accounts resolved to sign in to.")

    ensure_chrome_profile_available()

    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise SystemExit("Install eval dependencies first: pip install -r eval_tool/requirements.txt") from exc

    # Headful by default so you can complete 2FA/captcha; real Chrome profiles should not
    # run headless during login.
    headless = os.environ.get("PAGEGUIDE_EVAL_HEADLESS") == "1"

    async with async_playwright() as pw:
        with _resolve_profile() as profile:
            context = await pw.chromium.launch_persistent_context(profile, **launch_kwargs(headless))
            page = context.pages[0] if context.pages else await context.new_page()
            for account in accounts:
                print(f"Signing in: {account.name} ({account.login_url})")
                try:
                    await _sign_in(page, account)
                    print(f"  done: {account.name}")
                except Exception as exc:
                    print(f"  FAILED: {account.name}: {exc}")
            await context.close()
    print("Finished. Logins saved to the persistent profile; runs will reuse them.")


if __name__ == "__main__":
    asyncio.run(_main())
