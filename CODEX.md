
# CODEX.md — Coding Agent Rules for XWebAgent for CODEX

## Your role
Codex is the feature implementer. Your default responsibility:
- Implement the feature requirements on branch `v10-<feature>`
- Keep diffs small, readable, and scoped
- Do not “clean up” unrelated code

When you finish implementation, leave clear notes for tests:
- edge cases
- expected behaviors
- failure modes

---

## Branch and worktree conventions (required)
- You work on: `v10-<feature>`
- Tests are typically handled on: `v10-<feature>-tests` (by Claude Code)

Example:
- Feature: `v10-connect-flow`
- Tests:   `v10-connect-flow-tests`

---

## Repo testing reality (important)
This repo’s tests are under `./e2e-tests` (not root).
CI runs:
1) `node e2e-tests/scripts/validate_manifest.js`
2) `npx jest unit/logic.test.js` (from `e2e-tests`)
3) `npx playwright test` (from `e2e-tests`)

If local scripts exist (recommended), prefer running:
- `npm run e2e:unit`
- `npm run e2e:e2e`
- `npm run ci`

---

## Implementation rules
1) Keep PR small: one feature per branch
2) Avoid unrelated refactors (no formatting-only changes)
3) Prefer minimal changes that satisfy acceptance criteria
4) If you must refactor for clarity, keep it local to the touched module
5) Add comments only when needed (avoid noise)

---

## Handoff to tests (very important)
At the end of your work, provide a “test handoff note”:

- What changed:
- Primary behaviors:
- Edge cases:
- Inputs/outputs to test:
- Any tricky selectors (for Playwright):
- Any expected error states:

This lets Claude Code write tests quickly and accurately.

---

## What to do when CI fails
Do not guess wildly.

1) Identify which step failed (manifest/unit/playwright)
2) If it’s feature logic, fix the bug with the smallest diff
3) Re-run the failing command locally
4) Commit with a clear message:
   - `fix(v10-<feature>): <what>` or `chore(v10-<feature>): <what>`

If the failure is test-only or flakiness, coordinate with Claude Code.

---

## Commit message style (suggested)
- `feat(v10-<feature>): ...`
- `fix(v10-<feature>): ...`
- `chore(v10-<feature>): ...`

Example:
- `feat(v10-connect-flow): add connect button and status state`
