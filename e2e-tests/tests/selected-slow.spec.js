// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.join(__dirname, '../../');

test.describe('Selected Slow Tests', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;
  /** @type {string | undefined} */
  let extensionId;
  /** @type {import('@playwright/test').Page} */
  let activePage;

  test.beforeAll(async () => {
    const userDataDir = path.join(__dirname, '../.test-user-data-slow-' + Date.now());

    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      slowMo: 2000,    // Slow down interactions to 2 seconds for each step
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-gpu',
      ],
    });

    await expect.poll(async () => {
      const serviceWorkers = context.serviceWorkers();
      const worker = serviceWorkers.find(w => w.url().includes('chrome-extension://'));
      if (worker) {
        extensionId = worker.url().split('/')[2];
        return true;
      }
      return false;
    }, {
      message: 'Extension service worker did not appear',
      timeout: 3000
    }).toBe(true);
    
    if (!extensionId) {
      const pages = context.backgroundPages();
      for (const pg of pages) {
        const pgUrl = pg.url();
        if (pgUrl.includes('chrome-extension://')) {
          extensionId = pgUrl.split('/')[2];
          break;
        }
      }
    }
  });

  test.afterAll(async () => {
    if (context) {
      await context.close();
    }
  });

  test.afterEach(async () => {
    if (activePage && !activePage.isClosed()) {
      await activePage.close();
    }
  });

  test('can enter and mask API key (from options-page.spec.js)', async () => {
    test.skip(!extensionId, 'Extension ID not found');

    activePage = await context.newPage();
    await activePage.goto(`chrome-extension://${extensionId}/options/options.html`);
    await activePage.waitForLoadState('domcontentloaded');

    const apiKeyInput = activePage.locator('#geminiApiKey');
    await expect(apiKeyInput).toBeVisible({ timeout: 10000 });

    // Ensure the input masks the value from the user visibly
    const inputType = await apiKeyInput.getAttribute('type');
    expect(inputType).toBe('password');

    // Input the API key
    await apiKeyInput.fill('test-api-key-12345');
    await expect(apiKeyInput).toHaveValue('test-api-key-12345');

    // Click Save to persist it
    const saveBtn = activePage.locator('#saveBtn');
    await saveBtn.click();

    // Wait for 1 second at the end before it closes
    await activePage.waitForTimeout(1000);
  });

  test('pressing Enter in input triggers send (from sidepanel-ui.spec.js)', async () => {
    test.skip(!extensionId, 'Extension ID not found');

    activePage = await context.newPage();
    await activePage.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`);
    await activePage.waitForLoadState('domcontentloaded');

    const input = activePage.locator('#xwebagent-input');
    const messagesContainer = activePage.locator('#xwebagent-messages');

    await input.fill('Hello! What is 2+2?');
    await input.press('Enter');

    // User message should appear
    await expect(messagesContainer.locator('.xwebagent-message.user').first()).toBeVisible({
      timeout: 10000,
    });

    // Wait for an assistant or system/error response back
    await expect(messagesContainer.locator('.xwebagent-message:not(.user)').first()).toBeVisible({
      timeout: 15000,
    });

    // Wait for 1 second at the end before it closes
    await activePage.waitForTimeout(1000);
  });
});
