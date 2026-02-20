# Claude Code Instructions (XWebAgent)

## Repo layout
- Chrome extension source lives in repo root.
- Tests live in ./e2e-tests
  - Unit tests: ./e2e-tests/unit/logic.test.js
  - Playwright tests: ./e2e-tests (npx playwright test)
  - Manifest validation: ./e2e-tests/scripts/validate_manifest.js

## How to run checks (local)
From repo root:
- Install test deps: npm run e2e:install
- Validate manifest: npm run e2e:manifest
- Run unit tests: npm run e2e:unit
- Run Playwright: npm run e2e:e2e
- Run everything (CI equivalent): npm run ci

## Rules
1) Any change to logic must include or update unit tests in ./e2e-tests/unit.
2) Bug fixes must include a regression test.
3) Keep PRs small and focused. Do not refactor unrelated files.
4) Never push to master directly; always use a branch + PR and let CI pass.
5) If CI fails, fix it with the smallest possible change and rerun the failing command.
