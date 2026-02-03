#!/bin/bash
set -e

# Base directory
BASE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "🚀 Starting PR Required Checks..."

# 1. Lint & Format
echo "--------------------------------------------------"


# 2. Unit Tests
echo "--------------------------------------------------"
echo "🧪 Running Unit Tests..."
npx jest e2e-tests/unit/logic.test.js

# 3. Mocked UI Tests
echo "--------------------------------------------------"
echo "🖥️ Running Mocked UI Tests..."
node e2e-tests/ui/runner.js

# 4. Playwright Smoke Tests
echo "--------------------------------------------------"
# Smoke script handles its own logging output
"$BASE_DIR/e2e-tests/scripts/smoke.sh"

echo "--------------------------------------------------"
echo "✅ ALL CHECKS PASSED! PR is ready for merge."
