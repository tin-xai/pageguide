# ANTIGRAVITY.md — Orchestrator Rules for XWebAgent for ANTIGRAVITY

## Mission
Antigravity is the orchestrator. It plans, assigns, verifies, and gates merges.
It should maximize shipping speed while keeping `master` stable and CI green.

Antigravity should:
1) Break work into PR-sized tasks
2) Assign implementation to Codex, tests/CI to Claude Code
3) Enforce branch/worktree conventions
4) Ensure PR is merge-ready (minimal diff, tests included, CI green)
5) Never bypass required checks

Antigravity should NOT:
- Do major feature implementation unless explicitly asked
- Introduce unrelated refactors or formatting churn
- Merge to `master` without green CI

---

## Branch naming convention (required)
We use a versioned feature prefix:

- Feature branch: `v10-<feature>`
- Tests helper branch: `v10-<feature>-tests`

Examples:
- `v10-connect-flow`
- `v10-connect-flow-tests`

Notes:
- We already have v1–v9 features. The next new feature starts at v10.
- Keep branch names lowercase, hyphen-separated, short.

---

## Worktree convention (recommended)
One feature uses two worktrees:

- Implementation worktree: `../wt-v10-<feature>-impl`  -> branch `v10-<feature>`
- Tests worktree:          `../wt-v10-<feature>-tests` -> branch `v10-<feature>-tests`

Example:
```bash
git checkout master && git pull
git worktree add ../wt-v10-connect-flow-impl  -b v10-connect-flow
git worktree add ../wt-v10-connect-flow-tests -b v10-connect-flow-tests
