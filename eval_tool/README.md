# PageGuide Evaluation Tool

Run from the repository root:

```bash
python -m venv .venv-eval
source .venv-eval/bin/activate
pip install -r eval_tool/requirements.txt
python -m playwright install chromium
python -m eval_tool.app
```

Open `http://127.0.0.1:5050`.

The evaluator:

- loads tasks from the current CSV in `data-guide` (prefers `Copy of GuideTaskData - guide_task.csv`)
- launches Chrome with the PageGuide extension
- sets `guideAutoMode`, `rewindCaptureEnabled`, and `guideEvalMode`
- records rewind screenshots and raw guide responses
- judges the final screenshot with OpenRouter when `OPENROUTER_API_KEY` is configured in `.env`
- recomputes `full`, `reduced` / no-progress, and `noloop` confidence scores from the same run trace

Current test default: the dashboard selects the last two runnable rows in the current CSV unless the user manually selects other tasks. `Check All Tasks` only checks all boxes in the select-task panel; `Start Evaluation` is the only visible action that starts a run.

## Browser: bundled Chromium eval profile (default)

By default, evaluation uses Playwright's bundled Chromium with a dedicated profile at
`~/.pageguide-eval-chromium`. This profile is separate from your everyday Google Chrome
profile and loads the PageGuide extension automatically.

This avoids current Chrome's restriction on remote debugging the default user-data
directory. When that restriction is hit, Chrome opens a blank `about:blank` window and the
run eventually fails with `DevTools remote debugging requires a non-default data directory`.

**Run:**

```bash
./eval_tool/run_eval.sh
```

`run_eval.sh` sets `PAGEGUIDE_EVAL_BROWSER=chromium` by default.

Environment variables:

- `PAGEGUIDE_EVAL_BROWSER` — `chromium` (default) or `chrome` (explicit escape hatch)
- `PAGEGUIDE_EVAL_PROFILE` — Chromium profile path (default: `~/.pageguide-eval-chromium`)
- `PAGEGUIDE_EVAL_CHROME_PROFILE_NAME` — profile name to match (default: `PageGuide`)
- `PAGEGUIDE_EVAL_CHROME_USER_DATA` — override Chrome user data path (macOS default: `~/Library/Application Support/Google/Chrome`)

## Real Chrome escape hatch

Set `PAGEGUIDE_EVAL_BROWSER=chrome` only if you intentionally want to experiment with
branded Chrome and a named profile. On current Chrome builds this can fail at launch because
Chrome refuses remote debugging on its normal user-data directory. Chromium mode is the
supported path for automated evaluation.

### Optional credential-based sign-in

Auto-login is disabled by default. Public tasks such as Expedia can run without any
credential preflight. To sign in to accounts before a run, enable it explicitly:

1. Copy the template and fill in real credentials:

```bash
cp eval_tool/accounts.example.txt eval_tool/accounts.txt
```

   Each line: `name | login_url | username | password [ | user_selector | pass_selector | submit_selector ]`. `accounts.txt` is gitignored.

2. Run the one-shot launcher with auto-login enabled:

```bash
AUTO_LOGIN=1 ./eval_tool/run_eval.sh
```

   Plain `./eval_tool/run_eval.sh` skips auto-login.

You can also run the auto-login step alone: `python -m eval_tool.auto_login` (override the file with `PAGEGUIDE_EVAL_ACCOUNTS`). Scripted username/password entry works for most sites but Google often blocks it — finish Google sign-in manually with `python -m eval_tool.login` once; it persists the same way.

### Using `password/password.txt` directly

If `eval_tool/accounts.txt` does not exist, auto-login falls back to `password/password.txt` (the free-form file with `Email:`/`Username:`/`Password:` lines) combined with a built-in catalog of login flows (`eval_tool/credentials.py`). Credentials are bucketed by header: the `Google` block is used for Google; `Scratch` for Scratch; everything else uses the shared block.

- Sites to sign in to default to `quora,google,facebook,linkedin`; override with `PAGEGUIDE_EVAL_SITES` (e.g. `PAGEGUIDE_EVAL_SITES=quora,linkedin`). Available flows: quora, google, facebook, linkedin, scratch.
- Override the password file path with `PAGEGUIDE_EVAL_PASSWORD_FILE`.
- The `password/` folder is gitignored.

Reminder: Google/Facebook commonly block scripted logins; if so, run `python -m eval_tool.login` and sign in by hand once (it saves to the same profile).

For Phase 3, add CSV columns named `ground truth steps` or `reference_steps`. Semicolon-separated steps are converted into ordered reference text. The Phase 3 page can then ask the LLM to compare each observed step with the reference and store `progress_ground_truth`.
