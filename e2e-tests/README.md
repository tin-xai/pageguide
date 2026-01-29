# XWebAgent E2E Tests

End-to-end tests for the XWebAgent browser extension using Playwright.

## Setup

```bash
cd e2e-tests
npm install
npx playwright install chromium
```

## Running Tests

### Run all tests
```bash
npm test
```

### Run tests with browser visible (headed mode)
```bash
npm run test:headed
```

### Run tests in debug mode
```bash
npm run test:debug
```

### Run tests with UI
```bash
npm run test:ui
```

### View test report
```bash
npm run report
```

## Test Structure

```
e2e-tests/
├── package.json              # Dependencies
├── playwright.config.js      # Playwright configuration
├── README.md                 # This file
└── tests/
    ├── fixtures/             # Test HTML pages
    │   ├── sample-article.html
    │   ├── long-page.html
    │   ├── minimal-page.html
    │   └── image-page.html
    ├── helpers/
    │   └── extension.js      # Helper utilities
    ├── extension-loading.spec.js  # Extension load tests
    ├── sidepanel-ui.spec.js       # Side panel UI tests
    ├── options-page.spec.js       # Options page tests
    ├── content-script.spec.js     # Content script tests
    └── error-handling.spec.js     # Error handling tests
```

## Test Categories

### 1. Extension Loading (`extension-loading.spec.js`)
- Service worker loads correctly
- Extension ID is obtained
- Side panel page loads
- Options page loads
- PDF viewer page loads
- Content scripts inject on web pages

### 2. Side Panel UI (`sidepanel-ui.spec.js`)
- Input field accepts text
- Send button is clickable
- Enter key triggers send
- Reset button clears chat
- Settings button works
- Image upload button exists
- Typing indicator appears

### 3. Options Page (`options-page.spec.js`)
- API key input exists and is secure
- Model selection dropdown works
- Save button exists
- Settings form structure
- No JavaScript errors

### 4. Content Scripts (`content-script.spec.js`)
- Scripts load on pages
- Page text can be extracted
- Handles minimal content pages
- Handles long scrollable pages
- Scrolling works correctly
- Highlights can be added/cleared

### 5. Error Handling (`error-handling.spec.js`)
- Empty input handling
- Whitespace-only input
- Very long input text
- Special characters
- Unicode and emoji
- Rapid multiple sends
- Invalid API key format
- Tab close recovery

## Notes

### Browser Extension Testing Limitations

1. **Headed mode required**: Chrome extensions cannot run in headless mode
2. **Side panel limitations**: Playwright cannot directly open the side panel via the extension icon; tests open the panel HTML directly
3. **Network mocking**: For tests that need predictable LLM responses, use the helper's `mockLLMResponse()` function

### Adding New Tests

1. Create a new `.spec.js` file in `tests/`
2. Follow the existing pattern for browser/context setup
3. Use fixtures for test pages
4. Clean up resources in `afterEach`/`afterAll`

### Debugging Tips

- Use `test:debug` for step-through debugging
- Use `test:ui` for visual test running
- Check `playwright-report/` for detailed failure reports
- Screenshots are captured on failure in `test-results/`

## CI Integration

For GitHub Actions or similar CI:

```yaml
- name: Install dependencies
  run: |
    cd e2e-tests
    npm ci
    npx playwright install chromium --with-deps

- name: Run tests
  run: |
    cd e2e-tests
    npm test
  env:
    CI: true
```

Note: Extension tests require a display. Use `xvfb-run` on Linux CI:

```yaml
- name: Run tests
  run: xvfb-run --auto-servernum npm test
```
