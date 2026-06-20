"""Parse the free-form password/password.txt file and map it to per-site login flows.

The password file looks like:

    Google account
    Email:  pageguide2026@gmail.com
    Password:  PageguideisTheBest1!

    Everything else (Amazon, Facebook, LinkedIn, etc.)
    Email:  pageguide2026@gmail.com
    Password:  NeverSayNever1!

    Scratch (username sign-in)
    Username:  pageguide2026
    Password:  NeverSayNever1!

Blocks are separated by blank lines; the first line of each block is a header. We bucket the
credentials into three named sets — `google`, `scratch`, and `default` (everything else) — then
combine them with SITE_CATALOG (login URLs + selectors) to produce ready-to-use Account objects.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from .storage import REPO_ROOT

# Defaults reused by the pipe-delimited accounts.txt format too.
DEFAULT_USER_SELECTORS = 'input[type="email"], input[type="text"], input[name="username"], input[name="email"]'
DEFAULT_PASS_SELECTOR = 'input[type="password"]'
DEFAULT_SUBMIT_SELECTOR = 'button[type="submit"], input[type="submit"]'


@dataclass
class Account:
    name: str
    login_url: str
    username: str
    password: str
    user_selector: str = DEFAULT_USER_SELECTORS
    pass_selector: str = DEFAULT_PASS_SELECTOR
    submit_selector: str = DEFAULT_SUBMIT_SELECTOR


@dataclass
class Site:
    login_url: str
    cred: str  # which credential bucket: "google", "scratch", or "default"
    user_selector: str = DEFAULT_USER_SELECTORS
    pass_selector: str = DEFAULT_PASS_SELECTOR
    submit_selector: str = DEFAULT_SUBMIT_SELECTOR


# Known login flows. Selectors are best-effort; large providers (Google/Facebook) frequently
# block scripted sign-in, in which case use `python -m eval_tool.login` to sign in by hand.
SITE_CATALOG: dict[str, Site] = {
    "google": Site(
        login_url="https://accounts.google.com/ServiceLogin",
        cred="google",
        user_selector='input[type="email"], input#identifierId',
        pass_selector='input[type="password"], input[name="Passwd"]',
        submit_selector='#identifierNext, #passwordNext, button[type="submit"]',
    ),
    "facebook": Site(
        login_url="https://www.facebook.com/login",
        cred="default",
        user_selector='input#email, input[name="email"]',
        pass_selector='input#pass, input[name="pass"]',
        submit_selector='button[name="login"], button[type="submit"]',
    ),
    "linkedin": Site(
        login_url="https://www.linkedin.com/login",
        cred="default",
        user_selector='input#username, input[name="session_key"]',
        pass_selector='input#password, input[name="session_password"]',
        submit_selector='button[type="submit"]',
    ),
    "quora": Site(
        login_url="https://www.quora.com/",
        cred="default",
        user_selector='input[name="email"], input[type="email"]',
        pass_selector='input[name="password"], input[type="password"]',
        submit_selector='button[type="submit"]',
    ),
    "scratch": Site(
        login_url="https://scratch.mit.edu/login/",
        cred="scratch",
        user_selector='input#login-username, input[name="username"]',
        pass_selector='input#login-password, input[name="password"]',
        submit_selector='button[type="submit"]',
    ),
}

DEFAULT_SITES = ["quora", "google", "facebook", "linkedin"]


def password_file_path() -> Path:
    value = os.environ.get("PAGEGUIDE_EVAL_PASSWORD_FILE")
    if value:
        return Path(value).expanduser()
    return Path(REPO_ROOT) / "password" / "password.txt"


def _bucket_for_header(header: str) -> str:
    lower = header.lower()
    if "google" in lower:
        return "google"
    if "scratch" in lower:
        return "scratch"
    return "default"


def parse_password_file(path: Path) -> dict[str, dict[str, str]]:
    """Return {bucket: {"login": <email/username>, "password": <pw>}}."""
    text = path.read_text(encoding="utf-8")
    buckets: dict[str, dict[str, str]] = {}
    current_header: str | None = None
    current: dict[str, str] = {}

    def flush() -> None:
        nonlocal current
        if current_header and ("login" in current and "password" in current):
            buckets[_bucket_for_header(current_header)] = dict(current)
        current = {}

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            flush()
            current_header = None
            continue
        match = re.match(r"^(Email|Username|Login|Password)\s*:\s*(.+)$", line, re.IGNORECASE)
        if match:
            key = match.group(1).lower()
            value = match.group(2).strip()
            if key == "password":
                current["password"] = value
            else:
                current["login"] = value
        else:
            # A non key:value line starts a new block header.
            flush()
            current_header = line
    flush()
    return buckets


def requested_sites() -> list[str]:
    value = os.environ.get("PAGEGUIDE_EVAL_SITES")
    if not value:
        return list(DEFAULT_SITES)
    return [s.strip().lower() for s in value.split(",") if s.strip()]


def build_accounts_from_passwords() -> list[Account]:
    path = password_file_path()
    if not path.exists():
        raise SystemExit(
            f"No password file at {path}. Create it or set PAGEGUIDE_EVAL_PASSWORD_FILE / "
            "use eval_tool/accounts.txt instead."
        )
    buckets = parse_password_file(path)
    if not buckets:
        raise SystemExit(f"Could not parse any credentials from {path}.")

    accounts: list[Account] = []
    skipped: list[str] = []
    for site_name in requested_sites():
        site = SITE_CATALOG.get(site_name)
        if not site:
            skipped.append(f"{site_name} (no login flow defined)")
            continue
        creds = buckets.get(site.cred) or buckets.get("default")
        if not creds:
            skipped.append(f"{site_name} (no credentials for bucket '{site.cred}')")
            continue
        accounts.append(
            Account(
                name=site_name,
                login_url=site.login_url,
                username=creds["login"],
                password=creds["password"],
                user_selector=site.user_selector,
                pass_selector=site.pass_selector,
                submit_selector=site.submit_selector,
            )
        )
    if skipped:
        print("Skipping: " + ", ".join(skipped))
    return accounts
