#!/bin/bash
set -e

echo "🎭 Running Playwright E2E Smoke Tests..."

# Required: Run from e2e-tests directory
cd "$(dirname "$0")/.."

# 1. Extension Loading: Run ALL tests (Critical)
echo "▶️ Testing Extension Loading..."
npx playwright test tests/extension-loading.spec.js

# 2. Content Scripts: Run specific smoke tests
echo "▶️ Testing Content Scripts (Smoke)..."
npx playwright test tests/content-script.spec.js -g "content script loads|page text can be extracted|no console errors"

# 3. Options Page: Run load/save smoke tests
echo "▶️ Testing Options Page (Smoke)..."
npx playwright test tests/options-page.spec.js -g "API key input field exists|save button exists|page does not have JavaScript errors"

# 4. Side Panel UI: Run basic render/send tests
echo "▶️ Testing Side Panel (Smoke)..."
npx playwright test tests/sidepanel-ui.spec.js -g "input field accepts text|send button is clickable|pressing Enter in input triggers send"

echo "✅ Playwright Smoke Tests Passed!"
