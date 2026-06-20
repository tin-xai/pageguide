#!/usr/bin/env bash
#
# One-shot evaluation launcher:
#   1. Activates the eval virtualenv (if present).
#   2. Starts the Flask evaluation dashboard.
#
# Auto-login is opt-in. Set AUTO_LOGIN=1 if you want to prefill credentials from
# eval_tool/accounts.txt or password/password.txt before opening the dashboard.
#
# Usage (from anywhere):
#   ./eval_tool/run_eval.sh
#   AUTO_LOGIN=1 ./eval_tool/run_eval.sh
#
set -euo pipefail

# Move to repo root (parent of this script's directory).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Activate the eval virtualenv if it exists.
if [ -f ".venv-eval/bin/activate" ]; then
  # shellcheck disable=SC1091
  source ".venv-eval/bin/activate"
fi

# Use Playwright's bundled Chromium by default. It uses a dedicated non-default profile
# (~/.pageguide-eval-chromium) and loads this repo's unpacked extension automatically.
# Real Chrome's normal profile directory cannot be remote-debugged reliably on current
# Chrome builds. Override only if you know you need it: PAGEGUIDE_EVAL_BROWSER=chrome.
export PAGEGUIDE_EVAL_BROWSER="${PAGEGUIDE_EVAL_BROWSER:-chromium}"

# Chrome locks its profile while running — only relevant when explicitly using Chrome mode.
if [ "$PAGEGUIDE_EVAL_BROWSER" = "chrome" ] && pgrep -x "Google Chrome" >/dev/null 2>&1; then
  if [ "${AUTO_QUIT_CHROME:-0}" = "1" ]; then
    echo "==> Quitting Google Chrome so the PageGuide profile can open..."
    osascript -e 'quit app "Google Chrome"' 2>/dev/null || true
    sleep 2
  fi
  if pgrep -x "Google Chrome" >/dev/null 2>&1; then
    echo "ERROR: Google Chrome is still running."
    echo "Quit Chrome completely (Cmd+Q on every window), then run again."
    echo "Or set AUTO_QUIT_CHROME=1 to quit Chrome automatically before launch."
    exit 1
  fi
fi

if [ "$PAGEGUIDE_EVAL_BROWSER" = "chromium" ]; then
  echo "==> Browser: bundled Chromium eval profile (~/.pageguide-eval-chromium)"
elif python3 -c "from eval_tool.chrome_profile import resolve_chrome_profile; raise SystemExit(0 if resolve_chrome_profile() else 1)" 2>/dev/null; then
  echo "==> Browser: Google Chrome profile 'PageGuide' (quit Chrome first if launch fails)"
else
  echo "==> Warning: no Chrome profile named PageGuide; set PAGEGUIDE_EVAL_BROWSER=chromium or create the profile"
fi

export PAGEGUIDE_EVAL_AUTO_LOGIN="${PAGEGUIDE_EVAL_AUTO_LOGIN:-0}"

if [ "${AUTO_LOGIN:-0}" = "1" ] && [ "${SKIP_LOGIN:-0}" != "1" ]; then
  if [ -f "eval_tool/accounts.txt" ] || [ -n "${PAGEGUIDE_EVAL_ACCOUNTS:-}" ] || [ -f "password/password.txt" ]; then
    echo "==> Auto-signing in to accounts..."
    export PAGEGUIDE_EVAL_AUTO_LOGIN=1
    python -m eval_tool.auto_login
  else
    echo "==> No credentials found; skipping auto-login."
    echo "    (Add password/password.txt, copy eval_tool/accounts.example.txt to"
     echo "     eval_tool/accounts.txt, or run 'python -m eval_tool.login' to sign in once.)"
  fi
else
  echo "==> Auto-login: disabled (set AUTO_LOGIN=1 to enable)"
fi

echo "==> Starting evaluation dashboard..."
exec python -m eval_tool.app
