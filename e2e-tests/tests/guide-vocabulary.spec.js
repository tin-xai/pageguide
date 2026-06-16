// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.join(__dirname, '../../');
const HEADLESS = process.env.HEADFUL !== '1';

/**
 * Simple-agent branch: the guide timeline renders one dot per concrete step, and the
 * "More" menu opens downward in guide mode. Driven via the panel's global render functions
 * so the suite stays CI-safe (no LLM calls).
 */
test.describe('Guide timeline + menu (simple agent)', () => {
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

  test('manual mode shows Next + Stop on a TYPE step and Next advances', async () => {
    // Capture the message the panel would send to the content script.
    await panelPage.evaluate(() => {
      // @ts-ignore - record sendToContentScript calls
      window.__sent = [];
      // @ts-ignore
      sendToContentScript = (msg) => { window.__sent.push(msg); return Promise.resolve({}); };
      // @ts-ignore - render a manual TYPE step (the old-framework regression case)
      addGuideStep({
        success: true, isGuide: true, isLastStep: false,
        step: 1, action: 'type', answer: 'Type your search term', targetText: 'Search box'
      });
    });
    const panel = panelPage.locator('#pageguide-step-panel');
    await expect(panel.locator('.pageguide-step-next-btn')).toBeVisible(); // bug fix: Next on type
    await expect(panel.locator('.pageguide-step-stop-btn')).toBeVisible();

    await panel.locator('.pageguide-step-next-btn').click();
    const sent = await panelPage.evaluate(() => window.__sent);
    expect(sent.some((m) => m.action === 'nextGuideStep')).toBe(true);
  });

  test('manual Next recovers controls when the content script reports no progress', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore - force a content-script no-op response
      sendToContentScript = () => Promise.resolve({ success: true, progressed: false });
      // @ts-ignore
      addGuideStep({
        success: true, isGuide: true, isLastStep: false,
        step: 1, action: 'click', answer: 'Select Yes', targetText: 'Yes'
      });
    });

    const panel = panelPage.locator('#pageguide-step-panel');
    const next = panel.locator('.pageguide-step-next-btn');
    const stop = panel.locator('.pageguide-step-stop-btn');

    await next.click();
    await expect(panelPage.locator('.pageguide-typing')).toHaveCount(0);
    await expect(next).toBeEnabled();
    await expect(stop).toBeEnabled();
    await expect(panelPage.locator('#pageguide-messages')).toContainText('Could not continue the guide');
  });

  test('inspector "Steer from here" writes a steer handoff and requests navigation', async () => {
    await panelPage.evaluate(async () => {
      // @ts-ignore - record outgoing messages + stub tab navigation
      window.__sent = [];
      window.__nav = null;
      // @ts-ignore
      chrome.runtime.sendMessage = (msg, cb) => { window.__sent.push(msg); if (cb) cb({}); return Promise.resolve({}); };
      // @ts-ignore
      chrome.tabs = chrome.tabs || {};
      // @ts-ignore
      chrome.tabs.query = async () => [{ id: 1, url: 'https://current.example/page' }];
      // @ts-ignore
      chrome.tabs.update = async (id, props) => { window.__nav = props.url; return {}; };
      // @ts-ignore
      chrome.tabs.reload = async () => { window.__nav = 'RELOAD'; return {}; };
      // @ts-ignore - seed two steps on different pages so the landing URL is step N−1's URL
      await rewindStartSession('steer-sess', 'original goal');
      // @ts-ignore
      await rewindPutRecord({ sessionId: 'steer-sess', step: 1, instruction: 'open menu', action: 'click', url: 'https://ex.com/a', target: { text: 'Menu' } });
      // @ts-ignore
      await rewindPutRecord({ sessionId: 'steer-sess', step: 2, instruction: 'pick option', action: 'click', url: 'https://ex.com/b', target: { text: 'Option' } });
      // @ts-ignore
      RewindTimeline.openStep({ sessionId: 'steer-sess', step: 2 });
    });

    const steerBtn = panelPage.locator('#pageguide-rewind-inspector [data-rw="steer"]');
    await expect(steerBtn).toBeVisible();
    await steerBtn.click();

    const ta = panelPage.locator('#pageguide-rewind-inspector .rw-steer-input');
    await expect(ta).toBeVisible();
    await ta.fill('do something different');
    await panelPage.locator('#pageguide-rewind-inspector [data-rw="steer-run"]').click();

    await panelPage.waitForTimeout(200);
    const res = await panelPage.evaluate(async () => {
      // @ts-ignore
      const pending = await rewindGetSteerPending();
      // @ts-ignore
      return { pending, nav: window.__nav };
    });
    expect(res.pending).toBeTruthy();
    expect(res.pending.fromStep).toBe(2);
    expect(res.pending.newGoal).toContain('do something different');
    // Re-decide step 2 → land where step 2 was presented = step 1's recorded URL.
    expect(res.pending.url).toBe('https://ex.com/a');
    expect(res.nav).toBe('https://ex.com/a'); // working tab navigated to the landing URL
  });

  test('step preview card "Steer from here" writes a handoff and requests navigation', async () => {
    await panelPage.evaluate(async () => {
      // @ts-ignore
      window.__sent = [];
      window.__nav = null;
      // @ts-ignore
      chrome.runtime.sendMessage = (msg, cb) => { window.__sent.push(msg); if (cb) cb({}); return Promise.resolve({}); };
      // @ts-ignore
      chrome.tabs = chrome.tabs || {};
      // @ts-ignore
      chrome.tabs.query = async () => [{ id: 1, url: 'https://current.example/page' }];
      // @ts-ignore
      chrome.tabs.update = async (id, props) => { window.__nav = props.url; return {}; };
      // @ts-ignore
      chrome.tabs.reload = async () => { window.__nav = 'RELOAD'; return {}; };
      // @ts-ignore
      await rewindStartSession('steer-card', 'original goal');
      // @ts-ignore
      await rewindPutRecord({ sessionId: 'steer-card', step: 1, instruction: 'open menu', action: 'click', url: 'https://ex.com/a', target: { text: 'Menu' } });
      // @ts-ignore
      await rewindPutRecord({ sessionId: 'steer-card', step: 2, instruction: 'pick option', action: 'click', url: 'https://ex.com/b', target: { text: 'Option' } });
      // @ts-ignore - the preview card reads its meta from currentGuideRecords
      currentGuideRecords = [
        { step: 1, planStep: 1, sessionId: 'steer-card', url: 'https://ex.com/a', instruction: 'open menu', confidence: 0.9 },
        { step: 2, planStep: 2, sessionId: 'steer-card', url: 'https://ex.com/b', instruction: 'pick option', confidence: 0.9 }
      ];
      const anchor = document.createElement('div');
      anchor.style.cssText = 'position:fixed;top:0;left:0;width:10px;height:10px';
      document.body.appendChild(anchor);
      // @ts-ignore
      showGoalStepPreview(2, anchor);
    });

    const steerBtn = panelPage.locator('#pageguide-goal-step-preview .pageguide-goal-step-steer');
    await expect(steerBtn).toBeVisible();
    await steerBtn.click();

    const ta = panelPage.locator('#pageguide-goal-step-preview .pageguide-goal-step-steer-input');
    await expect(ta).toBeVisible();
    await ta.fill('do something different');
    await panelPage.locator('#pageguide-goal-step-preview .pageguide-goal-step-steer-go').click();

    await panelPage.waitForTimeout(200);
    const res = await panelPage.evaluate(async () => {
      // @ts-ignore
      const pending = await rewindGetSteerPending();
      // @ts-ignore
      return { pending, nav: window.__nav };
    });
    expect(res.pending).toBeTruthy();
    expect(res.pending.fromStep).toBe(2);
    expect(res.pending.newGoal).toContain('do something different');
    expect(res.pending.url).toBe('https://ex.com/a');
    expect(res.nav).toBe('https://ex.com/a'); // working tab navigated to the landing URL
  });

  test('steering a step on the SAME page forks in place (no reload)', async () => {
    const res = await panelPage.evaluate(async () => {
      // @ts-ignore
      window.__nav = null; window.__inplace = null;
      // @ts-ignore - working tab is already ON the landing URL (same page as step N−1)
      chrome.tabs = chrome.tabs || {};
      // @ts-ignore
      chrome.tabs.query = async () => [{ id: 7, url: 'https://ex.com/a?q=1' }];
      // @ts-ignore
      chrome.tabs.update = async (id, props) => { window.__nav = 'UPDATE:' + props.url; return {}; };
      // @ts-ignore
      chrome.tabs.reload = async () => { window.__nav = 'RELOAD'; return {}; };
      // @ts-ignore
      chrome.tabs.sendMessage = async (id, msg) => { window.__inplace = msg; return {}; };
      // @ts-ignore
      await rewindStartSession('steer-same', 'goal');
      // @ts-ignore
      await rewindPutRecord({ sessionId: 'steer-same', step: 1, instruction: 'open menu', action: 'click', url: 'https://ex.com/a?q=1', target: { text: 'Menu' } });
      // @ts-ignore
      await rewindPutRecord({ sessionId: 'steer-same', step: 2, instruction: 'expand panel', action: 'click', url: 'https://ex.com/a?q=1', target: { text: 'More' } });
      // @ts-ignore - steer step 2 → land on step 1's URL, which equals the current tab URL
      await RewindTimeline.steerFromStep({ sessionId: 'steer-same', step: 2, url: 'https://ex.com/a?q=1' }, 'do it differently');
      // @ts-ignore
      return { nav: window.__nav, inplace: window.__inplace };
    });
    expect(res.nav).toBeNull();                       // no reload / no navigation
    expect(res.inplace && res.inplace.action).toBe('gv2SteerNow'); // in-place re-run message
    expect(res.inplace.payload.fromStep).toBe(2);
  });

  test('timeline renders one dot per concrete step', async () => {
    await panelPage.evaluate(() => {
      // No upfront plan in the simple version — the timeline is driven by concrete records.
      // @ts-ignore
      currentGuidePlan = [];
      // @ts-ignore
      currentGuideRecords = Array.from({ length: 10 }, (_, i) => ({ step: i + 1, planStep: i + 1, confidence: 0.9 }));
      // @ts-ignore
      currentGuideStep = 4;
      // @ts-ignore
      guideActive = true;
      // @ts-ignore
      renderGoalCard({ route: 'guide', title: 'T', step: 4 });
    });
    const dots = panelPage.locator('#pageguide-goal-dots .pageguide-goal-dot');
    await expect(dots).toHaveCount(10);            // all 10 steps shown
    await expect(dots.nth(0)).toHaveClass(/done/); // step 1 < current → done
    await expect(dots.nth(3)).toHaveClass(/current/); // step 4 in progress
  });

  test('low-confidence step is flagged for review (red)', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore
      currentGuidePlan = [];
      // @ts-ignore
      currentGuideRecords = [{ step: 1, planStep: 1, confidence: 0.3 }];
      // @ts-ignore
      currentGuideStep = 2;
      // @ts-ignore
      guideActive = true;
      // @ts-ignore
      renderGoalCard({ route: 'guide', title: 'T', step: 2 });
    });
    await expect(panelPage.locator('#pageguide-goal-dots .pageguide-goal-dot').nth(0)).toHaveClass(/review/);
  });

  test('"More" menu opens downward (not off-screen) in guide mode', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore
      currentGuidePlan = [];
      // @ts-ignore
      currentGuideRecords = [{ step: 1, planStep: 1, confidence: 0.9 }];
      // @ts-ignore
      currentGuideStep = 1;
      // @ts-ignore
      renderGoalCard({ route: 'guide', title: 'Test guide', step: 1 });
      const menu = document.getElementById('pageguide-more-menu');
      if (menu) menu.style.display = 'block';
    });

    const btn = panelPage.locator('#pageguide-more-btn');
    const menu = panelPage.locator('#pageguide-more-menu');
    await expect(menu).toBeVisible();

    const btnBox = await btn.boundingBox();
    const menuBox = await menu.boundingBox();
    expect(menuBox.y).toBeGreaterThanOrEqual(btnBox.y + btnBox.height - 1);
  });
});
