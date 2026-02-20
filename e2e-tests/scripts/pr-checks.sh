#!/bin/bash
set -e

# Base directory
BASE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "🚀 Starting PR Required Checks..."

# 1. Lint & Format
echo "--------------------------------------------------"


# 2. Unit Tests
# 2. Unit Tests
echo "--------------------------------------------------"
echo "🧪 Running Unit Tests..."
(cd "$BASE_DIR/e2e-tests" && npx jest unit/logic.test.js)



# 4. Playwright Smoke Tests
echo "--------------------------------------------------"
# Smoke script handles its own logging output
"$BASE_DIR/e2e-tests/scripts/smoke.sh"

echo "--------------------------------------------------"
echo "✅ ALL CHECKS PASSED! PR is ready for merge."
