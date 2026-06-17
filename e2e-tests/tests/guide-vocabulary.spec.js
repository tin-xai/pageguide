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
      await rewindPutRecord({ sessionId: 'steer-sess', step: 1, instruction: 'open menu', action: 'click', url: 'https://ex.com/a', target: { text: 'Menu' }, screenshot: 'AAAA' });
      // @ts-ignore
      await rewindPutRecord({ sessionId: 'steer-sess', step: 2, instruction: 'pick option', action: 'click', url: 'https://ex.com/b', target: { text: 'Option' }, screenshot: 'BBBB' });
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
    // Redo step 2 → branch after step 1 → restore the state BEFORE step 2 (== step 1's page).
    expect(res.pending.fromStep).toBe(1);
    expect(res.pending.newGoal).toContain('do something different');
    expect(res.pending.url).toBe('https://ex.com/a'); // land on step 1's page (before step 2)
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
      await rewindPutRecord({ sessionId: 'steer-card', step: 1, instruction: 'open menu', action: 'click', url: 'https://ex.com/a', target: { text: 'Menu' }, screenshot: 'AAAA' });
      // @ts-ignore
      await rewindPutRecord({ sessionId: 'steer-card', step: 2, instruction: 'pick option', action: 'click', url: 'https://ex.com/b', target: { text: 'Option' }, screenshot: 'BBBB' });
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
    // Redo step 2 → branch after step 1 → restore the state BEFORE step 2 (== step 1's page).
    expect(res.pending.fromStep).toBe(1);
    expect(res.pending.newGoal).toContain('do something different');
    expect(res.pending.url).toBe('https://ex.com/a'); // land on step 1's page (before step 2)
    expect(res.nav).toBe('https://ex.com/a'); // working tab navigated to the landing URL
  });

  test('steer creates a branch journey and preserves the original path', async () => {
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
        await rewindPutRecord({ sessionId: 'prune-sess', step: i, planStep: i, instruction: 's' + i, action: 'click', url: 'https://p.com/' + i, screenshot: 'AAAA' });
        // @ts-ignore
        currentGuideRecords.push({ step: i, planStep: i, sessionId: 'prune-sess', url: 'https://p.com/' + i, instruction: 's' + i, confidence: 0.9 });
      }
      // @ts-ignore
      currentGuideStep = 10; guideActive = true;
      // @ts-ignore
      renderGoalCard({ route: 'guide', title: 'T', step: 10 });
    });
    await expect(panelPage.locator('#pageguide-goal-dots .pageguide-goal-dot')).toHaveCount(10);

    const result = await panelPage.evaluate(async () => {
      // @ts-ignore - redo step 5 → branch after step 4 → original remains full, branch has 1..4
      await RewindTimeline.steerFromStep({ sessionId: 'prune-sess', step: 5, url: 'https://p.com/5' }, 'go a different way');
      // @ts-ignore
      const sessions = await rewindGetSessions();
      const branch = sessions.find(s => s.parentSessionId === 'prune-sess');
      // @ts-ignore
      const parentIdx = await rewindGetIndex('prune-sess');
      // @ts-ignore
      const branchIdx = branch ? await rewindGetIndex(branch.sessionId) : null;
      return {
        branchLabel: branch && branch.branchLabel,
        parentSteps: parentIdx.steps.map(s => s.step),
        branchSteps: branchIdx && branchIdx.steps.map(s => s.step),
        branchId: branch && branch.sessionId
      };
    });

    await expect(panelPage.locator('#pageguide-goal-dots .pageguide-goal-dot')).toHaveCount(4);
    expect(result.branchLabel).toBe('View journey before Step 5');
    expect(result.parentSteps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.branchSteps).toEqual([1, 2, 3, 4]);
    await expect(panelPage.locator('.pageguide-journey-recall-title')).toContainText('View journey before Step 5');
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
      await rewindPutRecord({ sessionId: 'steer-same', step: 1, instruction: 'open menu', action: 'click', url: 'https://ex.com/a?q=1', target: { text: 'Menu' }, screenshot: 'AAAA' });
      // @ts-ignore
      await rewindPutRecord({ sessionId: 'steer-same', step: 2, instruction: 'expand panel', action: 'click', url: 'https://ex.com/a?q=1', target: { text: 'More' }, screenshot: 'BBBB' });
      // @ts-ignore - steer step 2 → land on step 1's URL, which equals the current tab URL
      await RewindTimeline.steerFromStep({ sessionId: 'steer-same', step: 2, url: 'https://ex.com/a?q=1' }, 'do it differently');
      // @ts-ignore
      return { nav: window.__nav, inplace: window.__inplace };
    });
    expect(res.nav).toBeNull();                       // no reload / no navigation
    expect(res.inplace && res.inplace.action).toBe('gv2SteerNow'); // in-place re-run message
    expect(res.inplace.payload.fromStep).toBe(1);     // redo step 2 → branch after step 1
  });

  test('same-page steer failure clears loading and keeps user in control', async () => {
    const res = await panelPage.evaluate(async () => {
      // @ts-ignore
      window.__nav = null; window.__inplace = null;
      // @ts-ignore
      chrome.tabs = chrome.tabs || {};
      // @ts-ignore
      chrome.tabs.query = async () => [{ id: 7, url: 'https://ex.com/a?q=1' }];
      // @ts-ignore
      chrome.tabs.update = async (id, props) => { window.__nav = 'UPDATE:' + props.url; return {}; };
      // @ts-ignore
      chrome.tabs.reload = async () => { window.__nav = 'RELOAD'; return {}; };
      // @ts-ignore
      chrome.tabs.sendMessage = async (id, msg) => { window.__inplace = msg; return { success: false, error: 'no-op' }; };
      // @ts-ignore
      await rewindStartSession('steer-fail', 'goal');
      // @ts-ignore
      await rewindPutRecord({ sessionId: 'steer-fail', step: 1, instruction: 'open menu', action: 'click', url: 'https://ex.com/a?q=1', target: { text: 'Menu' }, screenshot: 'AAAA' });
      // @ts-ignore
      showTyping();
      // @ts-ignore
      const ok = await RewindTimeline.steerFromStep({ sessionId: 'steer-fail', step: 2, url: 'https://ex.com/a?q=1' }, 'do it differently');
      return {
        ok,
        nav: window.__nav,
        inplace: window.__inplace,
        typing: !!document.querySelector('.pageguide-typing'),
        running: document.getElementById('pageguide-send')?.classList.contains('pageguide-send-btn--stop')
      };
    });
    expect(res.ok).toBe(false);
    expect(res.nav).toBeNull();
    expect(res.inplace && res.inplace.action).toBe('gv2SteerNow');
    expect(res.typing).toBe(false);
    expect(res.running).toBe(false);
  });

  test('send button morphs into a square Stop while running; no in-chat stop rectangle', async () => {
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
    // The send button is the Stop control; there is no separate in-chat stop rectangle.
    await expect(send).toHaveClass(/pageguide-send-btn--stop/);
    await expect(send).toHaveText('■');
    await expect(panelPage.locator('.pageguide-guide-stop-btn')).toHaveCount(0);

    await send.click();
    const sent = await panelPage.evaluate(() => window.__sent);
    expect(sent.some(m => m && m.action === 'stopGuide')).toBe(true);

    // Reverts to the send shape once stopped.
    await expect(send).not.toHaveClass(/pageguide-send-btn--stop/);
    await expect(send).toHaveText('➤');
  });

  test('a guide journey can be recalled from its "View journey" button', async () => {
    await panelPage.evaluate(async () => {
      // @ts-ignore - seed a stored guide session with 3 valid (screenshotted) steps + 1 void one
      await rewindStartSession('jrn', 'my journey goal');
      for (let i = 1; i <= 3; i++) {
        // @ts-ignore — each valid step has a screenshot
        await rewindPutRecord({ sessionId: 'jrn', step: i, planStep: i, instruction: 'step ' + i, url: 'https://x/' + i, screenshot: 'AAAA' });
      }
      // @ts-ignore — a void step (no screenshot) must be pruned from the recalled timeline
      await rewindPutRecord({ sessionId: 'jrn', step: 4, planStep: 4, instruction: 'void step', url: 'https://x/4' });
      // @ts-ignore - reset live state so the recall is what populates the dots
      currentGuideRecords = []; currentGuidePlan = []; currentGuideStep = 0; guideActive = false; currentGuideInitial = null;
      // @ts-ignore
      addJourneyRecallMessage('jrn', 'my journey goal');
    });

    const btn = panelPage.locator('.pageguide-journey-recall-btn');
    await expect(btn).toBeVisible();
    await btn.click();

    // The task-panel journey re-populates with the 3 valid steps; the void (screenshot-less) step is pruned.
    await expect(panelPage.locator('#pageguide-goal-dots .pageguide-goal-dot')).toHaveCount(3);
  });

  test('View journey button still works after the chat is restored on a tab switch', async () => {
    await panelPage.evaluate(async () => {
      // @ts-ignore - seed a 2-step journey in both the store and the in-memory map
      await rewindStartSession('tabsw', 'goal');
      // @ts-ignore
      await rewindPutRecord({ sessionId: 'tabsw', step: 1, instruction: 's1', screenshot: 'AAAA' });
      // @ts-ignore
      await rewindPutRecord({ sessionId: 'tabsw', step: 2, instruction: 's2', screenshot: 'BBBB' });
      // @ts-ignore
      _journeysBySession['tabsw'] = { title: 'goal', steps: [
        { sessionId: 'tabsw', step: 1, instruction: 's1', hasShot: true },
        { sessionId: 'tabsw', step: 2, instruction: 's2', hasShot: true }
      ] };
      // @ts-ignore
      currentGuideRecords = []; currentGuidePlan = []; currentGuideStep = 0; guideActive = false; currentGuideInitial = null;
      // @ts-ignore
      addJourneyRecallMessage('tabsw', 'goal');
      // Simulate the tab-switch restore (_restoreTabSession does `container.innerHTML = session.html`),
      // which rebuilds the DOM and would drop any per-button click listener.
      const c = document.getElementById('pageguide-messages');
      c.innerHTML = c.innerHTML;
    });

    // The delegated container listener still handles the click after the innerHTML rebuild.
    await panelPage.locator('.pageguide-journey-recall-btn').click();
    await expect(panelPage.locator('#pageguide-goal-dots .pageguide-goal-dot')).toHaveCount(2);
  });

  test('displayed branch journey remains visible after tab session restore', async () => {
    await panelPage.evaluate(async () => {
      // @ts-ignore
      await rewindStartSession('branch-visible', 'View journey before Step 6');
      for (let i = 1; i <= 3; i++) {
        // @ts-ignore
        await rewindPutRecord({ sessionId: 'branch-visible', step: i, instruction: 'branch ' + i, screenshot: 'AAAA' });
      }
      // @ts-ignore
      _journeysBySession['branch-visible'] = {
        title: 'View journey before Step 6',
        steps: [1, 2, 3].map(i => ({ sessionId: 'branch-visible', step: i, instruction: 'branch ' + i, hasShot: true }))
      };
      // @ts-ignore
      addJourneyRecallMessage('branch-visible', 'View journey before Step 6', 'View journey before Step 6');
      // @ts-ignore
      await showStoredJourney('branch-visible');
      // @ts-ignore
      _saveTabSession(101);
      // @ts-ignore
      clearGoalAndStepPanel();
      // @ts-ignore
      _restoreTabSession(_tabSessions.get(101));
    });

    await expect(panelPage.locator('#pageguide-goal')).toBeVisible();
    await expect(panelPage.locator('#pageguide-goal')).toContainText('View journey before Step 6');
    await expect(panelPage.locator('#pageguide-goal-dots .pageguide-goal-dot')).toHaveCount(3);
  });

  test('after Stop, late "still working" messages do not re-arm the running animation/button or gray the dots', async () => {
    const after = await panelPage.evaluate(async () => {
      // @ts-ignore - don't actually message a content script during stop
      sendToContentScript = () => Promise.resolve({});
      // @ts-ignore - running: typing + red stop button
      showTyping();
      // @ts-ignore - user stops → guideStopped = true, typing hidden
      await stopGuide('⏹ Stopped.');

      // Late, in-flight content-script messages arriving AFTER the stop must be dropped by the
      // listener (invoked directly — a page's own runtime.sendMessage doesn't hit its own onMessage).
      // @ts-ignore
      handleContentMessage({ action: 'showTyping' });
      // @ts-ignore
      handleContentMessage({ action: 'guideStepRecord', meta: { step: 9, instruction: 'late', hasShot: true, sessionId: 's' } });

      const btn = document.getElementById('pageguide-send');
      return {
        running: !!(btn && btn.classList.contains('pageguide-send-btn--stop')),
        typing: !!document.querySelector('.pageguide-typing'),
        dots: document.querySelectorAll('#pageguide-goal-dots .pageguide-goal-dot').length
      };
    });
    expect(after.running).toBe(false); // red Stop button did not reappear
    expect(after.typing).toBe(false);  // running animation did not reappear
    expect(after.dots).toBe(0);        // the late record didn't add timeline dots
  });

  test('restore card v2: clean action-first checklist, target screenshot, and a live-snapshot button', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore
      addSteerRestoreCard({
        fromStep: 1, redoStep: 2, url: 'https://ex.com/a', restoreShot: 'AAAA', redoBeforeShot: 'BBBB', canRetry: true,
        log: [
          { kind: 'localStorage', key: 'tok', value: 'a', ok: true },
          { kind: 'replay', action: 'click', target: { text: 'Idiomas' }, ok: false }
        ],
        recorded: [{ step: 1, action: 'click', target: { text: 'Idiomas' }, instruction: 'open menu' }]
      });
    });
    // Two checklist items, two checkboxes; the failed one is unchecked.
    await expect(panelPage.locator('.pageguide-steer-restore-item')).toHaveCount(2);
    await expect(panelPage.locator('.pageguide-steer-restore-check')).toHaveCount(2);
    await expect(panelPage.locator('.pageguide-steer-restore-item.failed .pageguide-steer-restore-check')).not.toBeChecked();
    // Action-first labels: the replay shows the human action up front, no raw selector clutter.
    await expect(panelPage.locator('.pageguide-steer-restore-item.failed .pageguide-steer-restore-action')).toContainText('Click');
    await expect(panelPage.locator('.pageguide-steer-restore-item.failed .pageguide-steer-restore-action')).toContainText('Idiomas');
    // The recorded "before step N" target screenshot is shown inline.
    await expect(panelPage.locator('.pageguide-steer-restore-target img')).toBeVisible();
    await panelPage.locator('.pageguide-steer-restore-target img').click();
    await expect(panelPage.locator('#pageguide-memory-shot-lightbox')).toBeVisible();
    await expect(panelPage.locator('#pageguide-memory-shot-lightbox img')).toHaveCSS('object-fit', 'contain');
    await panelPage.keyboard.press('Escape');
    await expect(panelPage.locator('#pageguide-memory-shot-lightbox')).toHaveCount(0);
    // Live restored-page snapshot button present (because restoreShot was supplied).
    await expect(panelPage.locator('.pageguide-steer-restore-snap')).toBeVisible();
  });

  test('restore card v2: Retry sends retrySteerRestore; Tell-agent sends fixSteerRestore with the note', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore
      window.__sent = [];
      // @ts-ignore
      sendToContentScript = (msg) => { window.__sent.push(msg); return Promise.resolve({}); };
      // @ts-ignore
      addSteerRestoreCard({ fromStep: 1, redoStep: 2, url: 'https://ex.com/a', canRetry: true, log: [], recorded: [] });
    });

    await panelPage.locator('.pageguide-steer-restore-retry').click();
    // Retry disables the card's buttons (a fresh card arrives on reply); re-render to test fix.
    await panelPage.evaluate(() => {
      // @ts-ignore
      addSteerRestoreCard({ fromStep: 1, redoStep: 2, url: 'https://ex.com/a', canRetry: true, log: [], recorded: [] });
    });
    // Open the fix box, type a note, send.
    await panelPage.locator('.pageguide-steer-restore-fix').click();
    await panelPage.locator('.pageguide-steer-restore-fix-input').fill('the menu dropdown is not open');
    await panelPage.locator('.pageguide-steer-restore-fix-send').click();

    const sent = await panelPage.evaluate(() => window.__sent);
    expect(sent.some(m => m.action === 'retrySteerRestore')).toBe(true);
    const fix = sent.find(m => m.action === 'fixSteerRestore');
    expect(fix).toBeTruthy();
    expect(fix.note).toBe('the menu dropdown is not open');
  });

  test('restore card v2: error banner shows and the Retry button is hidden when canRetry is false', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore
      addSteerRestoreCard({
        fromStep: 1, redoStep: 2, canRetry: false, error: "⚠ Couldn't apply: Click “Idiomas”",
        log: [{ kind: 'replay', action: 'click', target: { text: 'Idiomas' }, ok: false }], recorded: []
      });
    });
    await expect(panelPage.locator('.pageguide-steer-restore-error')).toContainText("Couldn't apply");
    await expect(panelPage.locator('.pageguide-steer-restore-retry')).toHaveCount(0);
  });

  test('inspector opens styled (no spill) even when the live timeline never mounted', async () => {
    // Regression: _openInspector must inject its own CSS so it isn't a full-page screenshot
    // spilling into the panel. Fresh page = no prior addStep(), so _injectCss never ran.
    await panelPage.evaluate(async () => {
      // @ts-ignore
      await rewindStartSession('spill', 'spill');
      // @ts-ignore
      await rewindPutRecord({ sessionId: 'spill', step: 1, instruction: 'do a thing', url: 'https://ex.com', screenshot: 'AAAA' });
      // @ts-ignore
      RewindTimeline.openStep({ sessionId: 'spill', step: 1, instruction: 'do a thing', url: 'https://ex.com' });
    });
    const inspector = panelPage.locator('#pageguide-rewind-inspector');
    await expect(inspector).toBeVisible();
    const pos = await inspector.evaluate(el => getComputedStyle(el).position);
    expect(pos).toBe('fixed'); // styled overlay, not inline-flow spill
  });

  test('full-page inspector clickable steps switch records and preserve inspect tabs', async () => {
    await panelPage.evaluate(async () => {
      // @ts-ignore - seed stored records through the extension rewind store
      await rewindStartSession('inspect-slider', 'change language');
      const img = 'AAAA';
      const snap = '<!doctype html><html><body><main><h1>Before page</h1></main></body></html>';
      // @ts-ignore
      await rewindPutRecord({
        sessionId: 'inspect-slider', step: 1, planStep: 1, instruction: 'Open language settings',
        target: { text: 'Language' }, nextStepHint: 'Choose English', confidence: 0.9,
        durationMs: 900, url: 'https://example.com/settings', title: 'Settings',
        screenshot: img, screenshotBefore: img, domSnapshot: snap, rawLlmJson: '{"step":1}'
      });
      // @ts-ignore
      await rewindPutRecord({
        sessionId: 'inspect-slider', step: 2, planStep: 2, instruction: 'Click English',
        target: { text: 'English' }, nextStepHint: 'The page refreshes', confidence: 0.42,
        durationMs: 1200, url: 'https://example.com/settings/languages', title: 'Language Settings',
        action: 'click', screenshot: img, screenshotBefore: img, screenshotAfter: img,
        domSnapshot: snap, rawLlmJson: '{"step":2}'
      });
      // @ts-ignore
      await rewindPutRecord({
        sessionId: 'inspect-slider', step: 3, planStep: 3, instruction: 'Confirm language changed',
        target: { text: 'English' }, confidence: 0.8, durationMs: 600,
        url: 'https://example.com/settings/languages', title: 'Language Settings',
        screenshot: img, screenshotBefore: img, domSnapshot: snap
      });
    });

    const inspectorPage = await context.newPage();
    await inspectorPage.goto(`chrome-extension://${extensionId}/rewind/inspector.html?session=inspect-slider&step=1`);
    await inspectorPage.waitForLoadState('domcontentloaded');

    await expect(inspectorPage.locator('#timeline')).toBeVisible();
    await expect(inspectorPage.locator('#why')).toContainText('Target');
    await expect(inspectorPage.locator('#why')).toContainText('Open language settings');
    await expect(inspectorPage.locator('#why a[href="https://example.com/settings"]')).toBeVisible();

    await inspectorPage.locator('#timeline-track .step-chip[data-step="2"]').click();
    await expect(inspectorPage.locator('#title')).toContainText('Step 2');
    await expect(inspectorPage.locator('#why')).toContainText('Click English');
    await expect(inspectorPage.locator('#why')).toContainText('Needs review');

    await expect(inspectorPage.locator('#tab-before')).toBeEnabled();
    await expect(inspectorPage.locator('#tab-snap')).toBeEnabled();
    await expect(inspectorPage.locator('#tab-after')).toBeEnabled();
    await inspectorPage.locator('#tab-snap').click();
    await expect(inspectorPage.locator('#view iframe')).toBeVisible();
    await inspectorPage.locator('#tab-after').click();
    await expect(inspectorPage.locator('#view img[alt*="after action"]')).toBeVisible();
    await expect(inspectorPage.locator('#raw-wrap')).toBeVisible();
    await expect(inspectorPage.locator('#record-wrap')).toBeVisible();
    await inspectorPage.close();
  });

  test('timeline inspector uses before/after screenshot fallbacks', async () => {
    await panelPage.evaluate(async () => {
      // @ts-ignore
      await rewindStartSession('shot-fallback', 'screenshots');
      // @ts-ignore - no legacy `screenshot`, only screenshotBefore
      await rewindPutRecord({
        sessionId: 'shot-fallback', step: 1, instruction: 'before only',
        screenshotBefore: 'AAAA', domSnapshot: '<html><body>snapshot</body></html>'
      });
      // @ts-ignore - no legacy `screenshot`, only screenshotAfter
      await rewindPutRecord({
        sessionId: 'shot-fallback', step: 2, instruction: 'after only',
        screenshotAfter: 'BBBB', domSnapshot: '<html><body>snapshot</body></html>'
      });
      // @ts-ignore
      RewindTimeline.openStep({ sessionId: 'shot-fallback', step: 1, instruction: 'before only' });
    });
    await expect(panelPage.locator('#pageguide-rewind-inspector .rw-tabs [data-view="shot"]')).toBeEnabled();
    await expect(panelPage.locator('#pageguide-rewind-inspector .rw-view img')).toBeVisible();

    await panelPage.evaluate(() => {
      document.getElementById('pageguide-rewind-inspector')?.remove();
      // @ts-ignore
      RewindTimeline.openStep({ sessionId: 'shot-fallback', step: 2, instruction: 'after only' });
    });
    await expect(panelPage.locator('#pageguide-rewind-inspector .rw-tabs [data-view="shot"]')).toBeEnabled();
    await expect(panelPage.locator('#pageguide-rewind-inspector .rw-view img')).toBeVisible();
  });

  test('the steer run button is labeled "Run"', async () => {
    await panelPage.evaluate(async () => {
      // @ts-ignore
      await rewindStartSession('run', 'run');
      // @ts-ignore
      await rewindPutRecord({ sessionId: 'run', step: 2, instruction: 'x', url: 'https://ex.com', screenshot: 'AAAA' });
      // @ts-ignore
      RewindTimeline.openStep({ sessionId: 'run', step: 2, instruction: 'x', url: 'https://ex.com' });
    });
    await expect(panelPage.locator('#pageguide-rewind-inspector [data-rw="steer-run"]')).toHaveText('Run');
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

    // The live (non-recalled) journey also has a collapse ✕ that hides it.
    const x = panelPage.locator('#pageguide-goal-collapse');
    await expect(x).toBeVisible();
    await x.click();
    await expect(panelPage.locator('#pageguide-goal')).toBeHidden();
  });

  test('confidence shows as a yellow/green status, never red', async () => {
    await panelPage.evaluate(() => {
      // @ts-ignore
      currentGuidePlan = [];
      // @ts-ignore — step 1 low confidence (yellow), step 2 high confidence (green)
      currentGuideRecords = [{ step: 1, planStep: 1, confidence: 0.3 }, { step: 2, planStep: 2, confidence: 0.9 }];
      // @ts-ignore
      currentGuideStep = 3;
      // @ts-ignore
      guideActive = true;
      // @ts-ignore
      renderGoalCard({ route: 'guide', title: 'T', step: 3 });
    });
    const dots = panelPage.locator('#pageguide-goal-dots .pageguide-goal-dot');
    // Low confidence → yellow (conf-med), NOT red (review).
    await expect(dots.nth(0)).toHaveClass(/conf-med/);
    await expect(dots.nth(0)).not.toHaveClass(/review/);
    // High confidence → green (conf-high).
    await expect(dots.nth(1)).toHaveClass(/conf-high/);
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
