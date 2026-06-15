// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.join(__dirname, '../../');
const HEADLESS = process.env.HEADFUL !== '1';

/**
 * Slice 5/6: verify the side panel renders the new robust-action UI surfaces
 * (ASK_HUMAN choices, EXTRACT results, and the Steer box) when the content script
 * sends the corresponding messages. These are driven directly via the panel's global
 * render functions so the suite stays CI-safe (no LLM calls).
 */
test.describe('Guide Action Vocabulary UI (Slice 5/6)', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;
  /** @type {string} */
  let extensionId;
  /** @type {import('@playwright/test').Page} */
  let panelPage;

  test.beforeAll(async () => {
    const userDataDir = path.join(__dirname, '../.test-user-data-vocab-' + Date.now());
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
      if (worker.url().includes('chrome-extension://')) {
        extensionId = worker.url().split('/')[2];
        break;
      }
    }
    if (!extensionId) {
      for (const page of context.backgroundPages()) {
        if (page.url().includes('chrome-extension://')) {
          extensionId = page.url().split('/')[2];
          break;
        }
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

  test.afterEach(async () => {
    await panelPage?.close();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('ASK_HUMAN renders the question and one button per choice', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore - global panel function
      addAskHumanPrompt('Which shipping speed do you want?', ['Standard', 'Express'], 'verb');
    });
    const ask = panelPage.locator('.pageguide-ask-human');
    await expect(ask).toBeVisible();
    await expect(ask.locator('.pageguide-ask-human-q')).toContainText('Which shipping speed');
    await expect(ask.locator('.pageguide-step-btn-row button')).toHaveCount(2);
    await expect(ask.locator('button', { hasText: 'Express' })).toBeVisible();
    // The panel carries a ✕ dismiss control.
    await expect(ask.locator('.pageguide-panel-dismiss')).toBeVisible();
  });

  test('stuck ASK_HUMAN offers Stop / steer / keep-trying choices', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore - global panel function
      addAskHumanPrompt('I seem to be stuck.', ['Stop', 'Let me steer', 'Keep trying'], 'stuck');
    });
    const ask = panelPage.locator('.pageguide-ask-human');
    await expect(ask.locator('.pageguide-step-btn-row button')).toHaveCount(3);
    await expect(ask.locator('button', { hasText: 'Stop' })).toBeVisible();
    await expect(ask.locator('button', { hasText: 'Let me steer' })).toBeVisible();
  });

  test('EXTRACT renders the structured data the agent read', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore - global panel function
      addExtractResult({ price: '$19.99', eta: 'June 20' });
    });
    const messages = panelPage.locator('#pageguide-messages');
    await expect(messages).toContainText('Extracted');
    await expect(messages).toContainText('price');
    await expect(messages).toContainText('$19.99');
  });

  test('Steer box renders a text input and a Steer button', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore - global panel function
      addSteerPrompt();
    });
    const steer = panelPage.locator('.pageguide-steer');
    await expect(steer).toBeVisible();
    await expect(steer.locator('textarea.pageguide-steer-input')).toBeVisible();
    await expect(steer.locator('button', { hasText: 'Steer' })).toBeVisible();
  });

  test('timeline step preview shows Steer under Inspect more during an active guide', async () => {
    await panelPage.evaluate(async () => {
      // Globals declared in panel.js (classic script — reachable by bare name).
      // @ts-ignore
      guideActive = true;
      // @ts-ignore
      currentGuidePlan = [{ n: 1, goal: 'first' }, { n: 2, goal: 'second' }];
      // @ts-ignore — a normal (high-confidence) step: Steer must still appear.
      currentGuideRecords = [{ step: 1, planStep: 1, instruction: 'Click X', confidence: 0.9 }];
      const anchor = document.createElement('div');
      document.body.appendChild(anchor);
      // @ts-ignore - global panel function
      await showGoalStepPreview(1, anchor);
    });
    const preview = panelPage.locator('#pageguide-goal-step-preview');
    await expect(preview).toBeVisible();
    await expect(preview.locator('button.pageguide-goal-step-inspect')).toBeVisible();
    const steerBtn = preview.locator('button.pageguide-goal-step-steer');
    await expect(steerBtn).toBeVisible();

    // Clicking it opens the free-text steer box.
    await steerBtn.click();
    await expect(panelPage.locator('.pageguide-steer textarea.pageguide-steer-input')).toBeVisible();
  });

  test('each transient chat panel has a ✕ that removes it', async () => {
    // Steer box
    await panelPage.evaluate(() => { /* @ts-ignore */ addSteerPrompt(); });
    let steer = panelPage.locator('.pageguide-steer');
    await expect(steer).toBeVisible();
    await steer.locator('.pageguide-panel-dismiss').click();
    await expect(panelPage.locator('.pageguide-steer')).toHaveCount(0);

    // Extract result
    await panelPage.evaluate(() => { /* @ts-ignore */ addExtractResult({ price: '$5' }); });
    const extract = panelPage.locator('.pageguide-extract');
    await expect(extract).toBeVisible();
    await expect(extract).toContainText('$5');
    await extract.locator('.pageguide-panel-dismiss').click();
    await expect(panelPage.locator('.pageguide-extract')).toHaveCount(0);
  });

  test('timeline renders one dot per concrete step with success/error status', async () => {
    await panelPage.evaluate(() => {
      // Plan estimated only 3 steps, but 10 concrete steps have run.
      // @ts-ignore
      currentGuidePlan = [{ n: 1, goal: 'a' }, { n: 2, goal: 'b' }, { n: 3, goal: 'c' }];
      // @ts-ignore
      currentGuideRecords = Array.from({ length: 10 }, (_, i) => ({ step: i + 1, planStep: Math.min(i + 1, 3), confidence: 0.9 }));
      // @ts-ignore
      currentGuideVerifications = { 1: { status: 'success' }, 2: { status: 'failed' } };
      // @ts-ignore
      currentGuideStep = 4;
      // @ts-ignore
      guideActive = true;
      // @ts-ignore
      renderGoalCard({ route: 'guide', title: 'T', step: 4, total: 3 });
    });
    const dots = panelPage.locator('#pageguide-goal-dots .pageguide-goal-dot');
    await expect(dots).toHaveCount(10);                       // all 10 steps shown, not capped to plan
    await expect(dots.nth(0)).toHaveClass(/verify-success/);  // step 1 correct
    await expect(dots.nth(1)).toHaveClass(/verify-failed/);   // step 2 errored
    await expect(dots.nth(0)).toHaveClass(/done/);            // step 1 < current → done
    await expect(dots.nth(3)).toHaveClass(/current/);         // step 4 in progress
  });

  test('"More" menu opens downward (not off-screen) in guide mode', async () => {
    // Render a guide goal card — this enters guide mode and relocates the "⋯ More" menu
    // into the task panel header (top of the panel).
    await panelPage.evaluate(() => {
      // @ts-ignore
      currentGuidePlan = [{ n: 1, goal: 'a' }, { n: 2, goal: 'b' }];
      // @ts-ignore
      currentGuideStep = 1;
      // @ts-ignore - global panel function
      renderGoalCard({ route: 'guide', title: 'Test guide', step: 1, total: 2 });
      const menu = document.getElementById('pageguide-more-menu');
      if (menu) menu.style.display = 'block';
    });

    const btn = panelPage.locator('#pageguide-more-btn');
    const menu = panelPage.locator('#pageguide-more-menu');
    await expect(menu).toBeVisible();

    const btnBox = await btn.boundingBox();
    const menuBox = await menu.boundingBox();
    // The menu's top edge should sit at/below the button's bottom edge (opens downward).
    expect(menuBox.y).toBeGreaterThanOrEqual(btnBox.y + btnBox.height - 1);
  });
});
