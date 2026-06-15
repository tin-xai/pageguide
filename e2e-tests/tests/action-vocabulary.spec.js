// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.join(__dirname, '../../');
const HEADLESS = process.env.HEADFUL !== '1';

/**
 * Robust action vocabulary (Slice 5) + Steer (Slice 6): UI rendering tests.
 *
 * These drive the panel's render functions directly (no LLM) to assert that ASK_HUMAN
 * questions, the steer box, and EXTRACT results render with the expected structure.
 */
test.describe('Action vocabulary panel UI', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;
  /** @type {string} */
  let extensionId;
  /** @type {import('@playwright/test').Page} */
  let panelPage;

  test.beforeAll(async () => {
    const userDataDir = path.join(__dirname, '../.test-user-data-av-' + Date.now());
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        ...(HEADLESS ? ['--headless=new'] : []),
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-gpu',
      ],
    });
    await new Promise((r) => setTimeout(r, 3000));

    for (const worker of context.serviceWorkers()) {
      if (worker.url().includes('chrome-extension://')) { extensionId = worker.url().split('/')[2]; break; }
    }
    if (!extensionId) {
      for (const page of context.backgroundPages()) {
        if (page.url().includes('chrome-extension://')) { extensionId = page.url().split('/')[2]; break; }
      }
    }
  });

  test.beforeEach(async () => {
    test.skip(!extensionId, 'Extension ID not found');
    panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`);
    await panelPage.waitForLoadState('domcontentloaded');
    await panelPage.waitForTimeout(500);
  });

  test.afterEach(async () => { await panelPage?.close(); });
  test.afterAll(async () => { await context?.close(); });

  test('ASK_HUMAN renders the question with one button per choice', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore - global function from panel.js
      window.addAskHumanPrompt('Which shipping speed?', ['Standard', 'Express'], 'verb');
    });
    const ask = panelPage.locator('.pageguide-ask-human');
    await expect(ask).toBeVisible();
    await expect(ask.locator('.pageguide-ask-human-q')).toContainText('Which shipping speed?');
    const buttons = ask.locator('.pageguide-step-btn-row button');
    await expect(buttons).toHaveCount(2);
    await expect(buttons.nth(0)).toHaveText('Standard');
    await expect(buttons.nth(1)).toHaveText('Express');
  });

  test('stuck prompt renders Stop / Let me steer / Keep trying', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore
      window.addAskHumanPrompt('I seem to be stuck.', ['Stop', 'Let me steer', 'Keep trying'], 'stuck');
    });
    const buttons = panelPage.locator('.pageguide-ask-human .pageguide-step-btn-row button');
    await expect(buttons).toHaveCount(3);
    await expect(buttons.nth(1)).toHaveText('Let me steer');
  });

  test('steer box accepts a redirection note', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore
      window.addSteerPrompt();
    });
    const input = panelPage.locator('.pageguide-steer-input');
    await expect(input).toBeVisible();
    await input.fill('Use the search box at the top instead');
    await expect(input).toHaveValue('Use the search box at the top instead');
    await expect(panelPage.locator('.pageguide-steer .pageguide-step-next-btn')).toHaveText('Steer →');
  });

  test('EXTRACT result renders the structured fields', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore
      window.addExtractResult({ price: '$10.00', eta: 'Tomorrow' });
    });
    const messages = panelPage.locator('#pageguide-messages');
    await expect(messages).toContainText('Extracted');
    await expect(messages).toContainText('price');
    await expect(messages).toContainText('$10.00');
  });
});
