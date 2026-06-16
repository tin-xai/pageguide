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
    // Branch AFTER step 2 → land on step 2's own page (keep 1..2, re-run from 3).
    expect(res.pending.url).toBe('https://ex.com/b');
    expect(res.nav).toBe('https://ex.com/b'); // working tab navigated to the landing URL
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
    expect(res.pending.url).toBe('https://ex.com/b');
    expect(res.nav).toBe('https://ex.com/b'); // working tab navigated to the landing URL
  });

  test('rebranch prunes timeline steps after the branch point', async () => {
    await panelPage.evaluate(async () => {
      // @ts-ignore
      window.__nav = null;
      // @ts-ignore
      chrome.tabs = chrome.tabs || {};
      // @ts-ignore - working tab is on some other page → steer navigates (not in-place)
      chrome.tabs.query = async () => [{ id: 3, url: 'https://current.example/x' }];
      // @ts-ignore
      chrome.tabs.update = async (id, props) => { window.__nav = props.url; return {}; };
      // @ts-ignore
      chrome.tabs.reload = async () => { window.__nav = 'RELOAD'; return {}; };
      // @ts-ignore
      chrome.tabs.sendMessage = async () => ({});
      // @ts-ignore
      await rewindStartSession('prune-sess', 'goal');
      // @ts-ignore
      currentGuidePlan = [];
      // @ts-ignore
      currentGuideRecords = [];
      for (let i = 1; i <= 10; i++) {
        // @ts-ignore
        await rewindPutRecord({ sessionId: 'prune-sess', step: i, planStep: i, instruction: 's' + i, action: 'click', url: 'https://p.com/' + i });
        // @ts-ignore
        currentGuideRecords.push({ step: i, planStep: i, sessionId: 'prune-sess', url: 'https://p.com/' + i, instruction: 's' + i, confidence: 0.9 });
      }
      // @ts-ignore
      currentGuideStep = 10; guideActive = true;
      // @ts-ignore
      renderGoalCard({ route: 'guide', title: 'T', step: 10 });
    });
    await expect(panelPage.locator('#pageguide-goal-dots .pageguide-goal-dot')).toHaveCount(10);

    await panelPage.evaluate(async () => {
      // @ts-ignore - rebranch from step 5 → steps 6..10 should be removed
      await RewindTimeline.steerFromStep({ sessionId: 'prune-sess', step: 5, url: 'https://p.com/5' }, 'go a different way');
    });

    await expect(panelPage.locator('#pageguide-goal-dots .pageguide-goal-dot')).toHaveCount(5);
    const storeSteps = await panelPage.evaluate(async () => {
      // @ts-ignore
      const idx = await rewindGetIndex();
      return idx.steps.map(s => s.step);
    });
    expect(storeSteps).toEqual([1, 2, 3, 4, 5]); // store truncated to match the UI
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

  test('running shows the guide spinner + in-chat Stop rectangle; send is disabled (not morphed)', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore - capture stop messages to the content script
      window.__sent = [];
      // @ts-ignore
      sendToContentScript = (m) => { window.__sent.push(m); return Promise.resolve({}); };
      // @ts-ignore
      guideActive = true;
      // @ts-ignore
      showTyping();
    });
    const send = panelPage.locator('#pageguide-send');
    // Progress is the spinner + a red rectangle Stop in the chat — NOT a morphed send button.
    await expect(panelPage.locator('.pageguide-typing')).toBeVisible();
    const stopRect = panelPage.locator('.pageguide-guide-stop-btn');
    await expect(stopRect).toBeVisible();
    await expect(send).toBeDisabled();
    await expect(send).not.toHaveClass(/pageguide-send-btn--stop/);
    await expect(send).toHaveText('➤');

    await stopRect.click();
    const sent = await panelPage.evaluate(() => window.__sent);
    expect(sent.some(m => m && m.action === 'stopGuide')).toBe(true);

    // Spinner cleared and send re-enabled once stopped.
    await expect(panelPage.locator('.pageguide-typing')).toHaveCount(0);
    await expect(send).toBeEnabled();
  });

  test('a guide journey can be recalled from its "View journey" button', async () => {
    await panelPage.evaluate(async () => {
      // @ts-ignore - seed a stored guide session with 3 steps
      await rewindStartSession('jrn', 'my journey goal');
      for (let i = 1; i <= 3; i++) {
        // @ts-ignore
        await rewindPutRecord({ sessionId: 'jrn', step: i, planStep: i, instruction: 'step ' + i, url: 'https://x/' + i });
      }
      // @ts-ignore - reset live state so the recall is what populates the dots
      currentGuideRecords = []; currentGuidePlan = []; currentGuideStep = 0; guideActive = false;
      // @ts-ignore
      addJourneyRecallMessage('jrn', 'my journey goal');
    });

    const btn = panelPage.locator('.pageguide-journey-recall-btn');
    await expect(btn).toBeVisible();
    await btn.click();

    // The task-panel journey re-populates with that session's steps.
    await expect(panelPage.locator('#pageguide-goal-dots .pageguide-goal-dot')).toHaveCount(3);
  });

  test('recall works from in-memory journey, shows a collapse X, no chat error', async () => {
    await panelPage.evaluate(() => {
      // In-memory only (no stored index) — simulates the storage-shape mismatch that made
      // recall always say "no longer available". Recall must still work.
      // @ts-ignore
      _journeysBySession['mem'] = { title: 'mem goal', steps: [
        { sessionId: 'mem', step: 1, instruction: 'a' },
        { sessionId: 'mem', step: 2, instruction: 'b' }
      ] };
      // @ts-ignore
      addJourneyRecallMessage('mem', 'mem goal');
    });

    await panelPage.locator('.pageguide-journey-recall-btn').click();
    // Card shows with the right dots; no "no longer available" chat message (fix #4).
    await expect(panelPage.locator('#pageguide-goal-dots .pageguide-goal-dot')).toHaveCount(2);
    await expect(panelPage.locator('#pageguide-messages')).not.toContainText('no longer available');

    // Collapse X hides the journey card (fix #3).
    const x = panelPage.locator('#pageguide-goal-collapse');
    await expect(x).toBeVisible();
    await x.click();
    await expect(panelPage.locator('#pageguide-goal')).toBeHidden();
  });

  test('each prompt recalls its OWN journey, with distinguishable titles', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore - two distinct guide prompts, each with its own session
      _journeysBySession['p1'] = { title: 'prompt one', steps: [{ sessionId: 'p1', step: 1, instruction: 'a' }] };
      // @ts-ignore
      _journeysBySession['p2'] = { title: 'prompt two', steps: [
        { sessionId: 'p2', step: 1, instruction: 'x' },
        { sessionId: 'p2', step: 2, instruction: 'y' },
        { sessionId: 'p2', step: 3, instruction: 'z' }
      ] };
      // @ts-ignore
      addJourneyRecallMessage('p1', 'prompt one');
      // @ts-ignore
      addJourneyRecallMessage('p2', 'prompt two');
    });
    const btns = panelPage.locator('.pageguide-journey-recall-btn');
    await expect(btns).toHaveCount(2);
    await expect(btns.nth(0)).toContainText('prompt one');
    await expect(btns.nth(1)).toContainText('prompt two');

    await btns.nth(0).click();
    await expect(panelPage.locator('#pageguide-goal-dots .pageguide-goal-dot')).toHaveCount(1);
    await btns.nth(1).click();
    await expect(panelPage.locator('#pageguide-goal-dots .pageguide-goal-dot')).toHaveCount(3);
  });

  test('current step panel shows a collapse X that hides it (guide mode)', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore
      sendToContentScript = () => Promise.resolve({});
      // @ts-ignore
      addGuideStep({ success: true, isGuide: true, isLastStep: false, step: 1, action: 'click', answer: 'Click the thing', targetText: 'Thing' });
    });
    const panel = panelPage.locator('#pageguide-step-panel');
    const x = panel.locator('.pageguide-step-collapse');
    await expect(x).toBeVisible();
    await x.click();
    await expect(panel).toBeHidden();
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
