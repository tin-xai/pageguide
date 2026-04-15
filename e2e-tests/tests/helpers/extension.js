/**
 * Helper utilities for testing browser extensions with Playwright
 */

const { chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.join(__dirname, '../../../');

/**
 * Launch a browser with the PageGuide extension loaded
 * @returns {Promise<{browser: Browser, context: BrowserContext, extensionId: string}>}
 */
async function launchBrowserWithExtension() {
  const browser = await chromium.launch({
    headless: false, // Extensions require headed mode
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
    ],
  });

  // Get the background page to find extension ID
  const context = browser.contexts()[0];

  // Wait for service worker to be ready
  let extensionId = null;
  const maxRetries = 10;

  for (let i = 0; i < maxRetries; i++) {
    const serviceWorkers = context.serviceWorkers();
    for (const worker of serviceWorkers) {
      const url = worker.url();
      if (url.includes('chrome-extension://')) {
        extensionId = url.split('/')[2];
        break;
      }
    }
    if (extensionId) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!extensionId) {
    // Fallback: try to get from any extension page
    const pages = context.pages();
    for (const page of pages) {
      const url = page.url();
      if (url.includes('chrome-extension://')) {
        extensionId = url.split('/')[2];
        break;
      }
    }
  }

  return { browser, context, extensionId };
}

/**
 * Open the extension's side panel
 * Note: Side panels can't be directly opened via Playwright,
 * so we test the panel page directly
 * @param {BrowserContext} context
 * @param {string} extensionId
 * @returns {Promise<Page>}
 */
async function openSidePanel(context, extensionId) {
  const panelUrl = `chrome-extension://${extensionId}/sidepanel/panel.html`;
  const page = await context.newPage();
  await page.goto(panelUrl);
  return page;
}

/**
 * Open the extension's options page
 * @param {BrowserContext} context
 * @param {string} extensionId
 * @returns {Promise<Page>}
 */
async function openOptionsPage(context, extensionId) {
  const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;
  const page = await context.newPage();
  await page.goto(optionsUrl);
  return page;
}

/**
 * Open the PDF viewer page
 * @param {BrowserContext} context
 * @param {string} extensionId
 * @returns {Promise<Page>}
 */
async function openPdfViewer(context, extensionId) {
  const viewerUrl = `chrome-extension://${extensionId}/pdf-viewer/viewer.html`;
  const page = await context.newPage();
  await page.goto(viewerUrl);
  return page;
}

/**
 * Wait for content scripts to be injected into a page
 * @param {Page} page
 * @param {number} timeout
 */
async function waitForContentScripts(page, timeout = 5000) {
  await page
    .waitForFunction(
      () =>
        typeof window._pageguideIndex !== 'undefined' || document.querySelector('[data-pageguide]'),
      { timeout }
    )
    .catch(() => {
      // Content scripts may not always set these, that's OK
    });

  // Give a little extra time for all scripts to initialize
  await page.waitForTimeout(500);
}

/**
 * Mock the LLM API calls to return predictable responses
 * This is crucial for deterministic testing
 * @param {Page} page
 * @param {Object} mockResponse - The response to return
 */
async function mockLLMResponse(page, mockResponse) {
  await page.route('**/api.openai.com/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [
          {
            message: {
              content: mockResponse.content || 'Mocked response',
            },
          },
        ],
      }),
    });
  });

  // Also mock other potential LLM endpoints
  await page.route('**/api.anthropic.com/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: [
          {
            text: mockResponse.content || 'Mocked response',
          },
        ],
      }),
    });
  });
}

/**
 * Mock LLM to simulate an error
 * @param {Page} page
 * @param {string} errorMessage
 */
async function mockLLMError(page, errorMessage = 'API Error') {
  await page.route('**/api.openai.com/**', (route) => {
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: errorMessage } }),
    });
  });

  await page.route('**/api.anthropic.com/**', (route) => {
    route.abort('failed');
  });
}

module.exports = {
  EXTENSION_PATH,
  launchBrowserWithExtension,
  openSidePanel,
  openOptionsPage,
  openPdfViewer,
  waitForContentScripts,
  mockLLMResponse,
  mockLLMError,
};
