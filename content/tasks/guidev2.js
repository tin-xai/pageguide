// XWebAgent - Step-by-Step Guidance v2
//
// Architecture (SeeAct-inspired):
//   • Service worker (SW) owns the guidance state in memory.
//   • Every time a content script loads it opens a persistent port named 'guidev2'.
//   • SW immediately replies with {type:'swState', state} via that port.
//   • If state.pendingResume is true, this page is a continuation → resume.
//   • If SW was killed (no state), session storage is the fallback.
//
// Interaction model:
//   • action="click"  → highlight element, user clicks, then wait for navigation or DOM settle
//   • action="type"   → agent fills the field automatically, then continues
//   • action="done"   → last step, no further interaction
//
// window.handleStepByStepGuide is overridden so the router calls v2 instead of guide.js.

// ===== PROMPT (inline to keep guidev2.js self-contained) =====

const GUIDE_V2_PROMPT = `You are a helpful guide assistant providing step-by-step interactive guidance.

Given the current page and the user's goal, provide ONE step at a time.
For "type" steps you provide the exact text to type — the agent fills it automatically.
For "click" steps the user clicks the highlighted element themselves.

Return JSON only:
{
  "step": N,
  "instruction": "Clear instruction shown to the user",
  "element": {"index": N, "text": "element text to highlight"},
  "action": "click" | "type" | "done",
  "typeText": "text to type (only when action=type)",
  "isLastStep": false,
  "nextStepHint": "What will happen after this step"
}

RULES:
1. ONE step at a time — never list multiple things to do
2. action="click": user manually clicks the highlighted element; wait for them
3. action="type": provide typeText, the agent auto-fills the field and continues
4. action="done": set isLastStep=true; no element interaction needed
5. Highlight the element to interact with using its index from PAGE INDEX
6. If the target is not visible, guide the user to open the relevant menu first

COMMON PATTERNS:
- Hidden options: Step 1 → click three-dot menu → Step 2 → click the option
- Forms:          Step 1 → type in field (action=type) → Step 2 → click submit
- Settings:       Step 1 → click profile/settings icon → Step 2 → click specific option

NATIVE BROWSER DIALOGS (print, save, open file, etc.):
When a step will open a native browser dialog (print dialog, save dialog, OS file picker), that
step MUST be the last step (isLastStep=true, action="done"). Explain what the user will see in
the dialog and what they should do, but do NOT attempt to guide actions inside the dialog — the
extension cannot access native browser UI. Example last-step instruction:
"Click 'Print' in the File menu. Your browser's print dialog will open — choose your printer and
settings there, then click the Print or Save button to finish."`;

// ===== CONSTANTS =====

const _GV2_KEY = 'xwebagentGuidanceV2';
const _GV2_MAX_AGE = 10 * 60 * 1000; // 10 minutes

// ===== TUTORIAL REFERENCE LOOKUP =====
// Strategy:
//   1. Filter candidates by URL hostname match (primary).
//      If no URL match, fall back to all tutorials (user may not be on target site yet).
//   2. Always ask the router LLM to pick the best semantic match.
//      Word-overlap is NOT used — the LLM handles paraphrases and synonyms correctly
//      (e.g. "delete watch history" ↔ "delete your watch history when I log out",
//            "go incognito" ↔ "start a private session").
//   3. If a match is found → inject its steps into the guide LLM context
//      as === TUTORIAL REFERENCE === so the LLM follows the verified flow.

let _gv2TutorialsCache = null; // in-memory cache (loaded once per content script lifetime)

async function _gv2LoadTutorials() {
  if (_gv2TutorialsCache) return _gv2TutorialsCache;
  try {
    const url = chrome.runtime.getURL('guide_tutorials.json');
    const resp = await fetch(url);
    _gv2TutorialsCache = await resp.json();
  } catch (e) {
    console.warn('[guidev2] Could not load guide_tutorials.json:', e.message);
    _gv2TutorialsCache = [];
  }
  return _gv2TutorialsCache;
}

function _gv2UrlMatches(pageUrl, tutorialUrl) {
  try {
    const norm = u => new URL(u.startsWith('http') ? u : 'https://' + u)
      .hostname.replace(/^www\./, '');
    const pageHost = norm(pageUrl);
    const tutHost = norm(tutorialUrl);
    return pageHost === tutHost
      || pageHost.endsWith('.' + tutHost)
      || tutHost.endsWith('.' + pageHost);
  } catch { return false; }
}

/**
 * Ask the router LLM (Gemini Flash) to semantically pick the best tutorial
 * from the candidate list. Always used — no word-overlap fallback.
 * Returns { tutorial, reason } or null.
 */
async function _gv2LlmPickTutorial(query, candidates) {
  const list = candidates
    .map((t, i) => `[${i}] (${t.website}) ${t.task}`)
    .join('\n');
  try {
    const response = await safeSendMessage({
      action: 'callRouterLLM',
      systemPrompt: `You are a tutorial matcher. Given a user query and a numbered list of tutorial tasks, pick the ONE that best matches the intent of the user's query — considering synonyms and paraphrases (e.g. "delete" ↔ "remove", "incognito" ↔ "private session", "turn off" ↔ "disable"). Return -1 if no tutorial is a reasonable match. Return JSON only: {"bestIndex": N, "confidence": 0.0-1.0, "reason": "brief reason"}`,
      messages: [{
        role: 'user',
        content: `USER QUERY: "${query}"\n\nCANDIDATE TUTORIALS:\n${list}`
      }]
    });

    if (!response?.content) return null;

    let json = response.content.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
    const m = json.match(/\{[\s\S]*\}/);
    if (m) json = m[0];
    const picked = JSON.parse(json);

    const idx = picked.bestIndex;
    if (idx === -1 || picked.confidence < 0.4 || idx < 0 || idx >= candidates.length) return null;

    console.log(`[guidev2] LLM picked tutorial [${idx}]: "${candidates[idx].task}" (${(picked.confidence * 100).toFixed(0)}% — ${picked.reason})`);
    return { tutorial: candidates[idx], reason: picked.reason };
  } catch (e) {
    console.warn('[guidev2] LLM tutorial ranking failed:', e.message);
    return null;
  }
}

/**
 * Find the best matching tutorial for this query + page URL.
 * Returns { tutorial, reason } or null (no match).
 * Called ONCE at the start of a guide session; result cached in window._guidev2.
 */
async function _gv2FindTutorial(query, pageUrl) {
  const tutorials = await _gv2LoadTutorials();
  if (!tutorials.length) return null;

  // Primary: narrow to tutorials for this site (fewer candidates = better LLM accuracy)
  let candidates = tutorials.filter(t => _gv2UrlMatches(pageUrl, t.website_url));

  // Fallback: if not on any known site, search all tutorials
  // (user may be asking before navigating, or the URL didn't match)
  if (!candidates.length) {
    console.log('[guidev2] No URL match — searching all tutorials');
    candidates = tutorials;
  }

  console.log(`[guidev2] Asking LLM to rank ${candidates.length} tutorial(s) for: "${query}"`);
  return _gv2LlmPickTutorial(query, candidates);
}

// ===== IN-PAGE STATE =====

window._guidev2 = { active: false, question: '', previousSteps: [] };

// Prevent concurrent resume/generate calls
let _guidev2Resuming = false;

// Flag set when a click step is awaiting user action
let _guidev2WaitingForClick = false;

// Flag set when the user explicitly stops the guide
let _guidev2Stopped = false;

// ===== SESSION-STORAGE FALLBACK (for when SW was killed) =====

async function gv2SaveFallback(extra = {}) {
  const s = window._guidev2;
  try {
    await chrome.storage.session.set({
      [_GV2_KEY]: {
        active: s.active,
        question: s.question,
        previousSteps: s.previousSteps,
        lastUrl: window.location.href,
        timestamp: Date.now(),
        ...extra
      }
    });
  } catch (e) { /* ignore */ }
}

async function gv2LoadFallback() {
  try {
    const r = await chrome.storage.session.get(_GV2_KEY);
    const saved = r[_GV2_KEY];
    if (!saved) return null;
    if (Date.now() - (saved.timestamp || 0) > _GV2_MAX_AGE) {
      await gv2ClearFallback();
      return null;
    }
    return saved;
  } catch (e) { return null; }
}

async function gv2ClearFallback() {
  try { await chrome.storage.session.remove(_GV2_KEY); } catch (e) {}
}

// ===== SERVICE WORKER PORT (primary state channel) =====
// The SW immediately responds to our port connection with {type:'swState', state}.
// We also send state updates to SW through separate chrome.runtime.sendMessage calls
// (ports can't be used for content→SW messages after the initial handshake reliably
// across page navigations).

let _gv2Port = null;

function _gv2ConnectToSW() {
  try {
    _gv2Port = chrome.runtime.connect({ name: 'guidev2' });
    _gv2Port.onMessage.addListener(_gv2HandleSwMessage);
    _gv2Port.onDisconnect.addListener(() => { _gv2Port = null; });
  } catch (e) {
    console.warn('[guidev2] SW port connect failed:', e);
    // If port fails, fall back to session storage check
    _gv2CheckSessionStorageFallback();
  }
}

async function _gv2HandleSwMessage(msg) {
  if (msg.type !== 'swState') return;

  if (msg.state?.active && msg.state?.pendingResume) {
    // SW has live guidance state AND it's expecting navigation → resume
    await _gv2ResumeFromState(msg.state);
  } else {
    // SW has no state (was killed/restarted) → check session-storage fallback
    await _gv2CheckSessionStorageFallback();
  }
}

// Called when SW has no state — check if session storage has a pending resume
async function _gv2CheckSessionStorageFallback() {
  const saved = await gv2LoadFallback();
  if (saved?.active && saved?.pendingResume) {
    await _gv2ResumeFromState(saved);
  }
}

// Connect as soon as the script loads on each page
_gv2ConnectToSW();

// ===== DOM STABILITY DETECTION (MutationObserver — SeeAct pattern) =====

/**
 * Wait until the DOM has had no mutations for `stableMs` milliseconds,
 * or until `maxWait` milliseconds have elapsed, whichever comes first.
 */
function gv2WaitForDomStable(maxWait = 6000, stableMs = 300) {
  return new Promise(resolve => {
    let stableTimer = null;
    let giveUpTimer = null;

    function done() {
      if (stableTimer) clearTimeout(stableTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      observer.disconnect();
      resolve();
    }

    function resetStableTimer() {
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = setTimeout(done, stableMs);
    }

    const observer = new MutationObserver(resetStableTimer);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Start the stable timer immediately (handles pages with no mutations at all)
    resetStableTimer();

    // Hard cap
    giveUpTimer = setTimeout(done, maxWait);
  });
}

// ===== RESUME AFTER NAVIGATION =====

/**
 * Restore guidance state from `state` (from SW or session storage),
 * wait for the new page's DOM to settle, then generate the next step.
 */
async function _gv2ResumeFromState(state) {
  if (_guidev2Resuming) {
    console.log('[guidev2] Already resuming, ignoring duplicate resume signal');
    return;
  }
  _guidev2Resuming = true;

  // Restore in-memory state
  window._guidev2 = {
    active: true,
    question: state.question,
    previousSteps: state.previousSteps || []
  };

  console.log('[guidev2] Resuming on new page — next step will be',
    window._guidev2.previousSteps.length + 1);

  try {
    try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}

    // Wait for the new page's DOM to stop mutating before indexing.
    // Add a small initial delay so the new page has time to start rendering,
    // then require 700 ms of DOM silence (up from the default 300 ms).
    await new Promise(r => setTimeout(r, 500));
    await gv2WaitForDomStable(8000, 700);

    const result = await gv2GenerateNextStep();

    if (result && result.success !== false) {
      try { chrome.runtime.sendMessage({ action: 'guideStep', result }); } catch (e) {}
    } else {
      try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
      if (result?.error) {
        try {
          chrome.runtime.sendMessage({
            action: 'addMessage',
            content: `❌ Could not generate next step: ${result.error}`,
            type: 'error'
          });
        } catch (e) {}
      }
      window._guidev2.active = false;
      _gv2ClearState();
    }
  } catch (e) {
    console.error('[guidev2] Resume error:', e);
    try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e2) {}
  } finally {
    _guidev2Resuming = false;
  }
}

// ===== STATE HELPERS =====

/**
 * Push guidance state to SW memory (primary) and session storage (fallback).
 * @param {boolean} pendingResume - true when a click step is active and we expect navigation
 */
async function _gv2SetState(pendingResume) {
  const s = window._guidev2;
  const state = {
    active: s.active,
    question: s.question,
    previousSteps: s.previousSteps,
    lastUrl: window.location.href,
    timestamp: Date.now(),
    pendingResume
  };

  // Primary: tell service worker (survives page navigation if SW stays alive)
  try {
    await safeSendMessage({ action: 'guidanceV2_setState', state });
  } catch (e) {
    console.warn('[guidev2] SW state set failed:', e);
  }

  // Fallback: session storage (survives SW restart)
  await gv2SaveFallback({ pendingResume });
}

function _gv2ClearState() {
  window._guidev2.active = false;

  // Clear from SW
  try { chrome.runtime.sendMessage({ action: 'guidanceV2_clearState' }); } catch (e) {}

  // Clear session storage
  gv2ClearFallback();
}

// ===== CORE GUIDANCE =====

/**
 * Start guidance for a new question (called by the router override at bottom of file).
 */
async function _handleStepByStepGuideV2(question) {
  _guidev2Stopped = false;
  // Look up a pre-verified tutorial ONCE at the start. Result is cached in
  // window._guidev2.tutorialRef so intermediate steps reuse it for free.
  const match = await _gv2FindTutorial(question, window.location.href);
  window._guidev2 = {
    active: true,
    question,
    previousSteps: [],
    tutorialRef: match?.tutorial || null,
    tutorialReason: match?.reason || null
  };

  // Not pending resume on first step — we're already on the right page
  await _gv2SetState(false);

  console.log('[guidev2] Starting guidance for:', question);
  return gv2GenerateNextStep();
}

/**
 * Generate the next step: build page index, call LLM, process response.
 */
async function gv2GenerateNextStep() {
  const g = window._guidev2;
  if (!g.active || _guidev2Stopped) return null;

  // Retry loop in case DOM is sparse (page still rendering)
  // interactiveOnly=true: guide only needs clickable/typeable elements, not headings,
  // paragraphs, list items, etc. This prevents the LLM from picking a text label
  // that shares the same name as the actual interactive button.
  let pageIndex;
  for (let attempt = 0; attempt < 3; attempt++) {
    pageIndex = createPageIndex(5000, true);
    if (pageIndex.count > 5) break;
    console.log('[guidev2] Sparse DOM (', pageIndex.count, 'el), retrying...');
    await new Promise(r => setTimeout(r, 700));
  }

  const pageBg = getPageBackground();
  if (typeof showSomIfEnabled === 'function') await showSomIfEnabled(pageIndex);

  const stepNumber = g.previousSteps.length + 1;
  console.log('[guidev2] Generating step', stepNumber, 'with', pageIndex.count, 'elements');

  // Use tutorial cached at session start (no repeated lookup or API call)
  let tutorialSection = '';
  if (g.tutorialRef) {
    tutorialSection = `\n=== TUTORIAL REFERENCE ===
Pre-verified steps for "${g.tutorialRef.task}" on ${g.tutorialRef.website}:
${g.tutorialRef.content.steps.join('\n')}
Use these as a reference guide but map each step to the actual elements visible in the PAGE INDEX above.
`;
  }

  try {
    const response = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: GUIDE_V2_PROMPT,
      messages: [{
        role: 'user',
        content: `PAGE BACKGROUND: ${pageBg.isDark ? 'DARK' : 'LIGHT'}
CURRENT URL: ${window.location.href}

=== PAGE INDEX ===
${pageIndex.indexText}

=== USER GOAL ===
${g.question}
${tutorialSection}
=== CURRENT STEP ===
Step ${stepNumber}

=== COMPLETED STEPS ===
${g.previousSteps.length > 0 ? g.previousSteps.join('\n') : 'None — this is the first step'}

Provide the next step as JSON.`
      }]
    });

    if (_guidev2Stopped) return null;

    if (response?.error) {
      console.warn('[guidev2] LLM error:', response.error);
      return { success: false, error: response.error };
    }
    if (response?.content) {
      const result = await gv2ProcessResponse(response.content);
      // On step 1 only, attach tutorial match info so the panel can show it in Details
      if (result?.success && g.tutorialRef && stepNumber === 1) {
        result.tutorialMatch = {
          task: g.tutorialRef.task,
          website: g.tutorialRef.website,
          steps: g.tutorialRef.content.steps,
          reason: g.tutorialReason
        };
      }
      return result;
    }
    return { success: false, error: 'No response from AI' };

  } catch (e) {
    console.error('[guidev2] Generation error:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Find the best matching element index in window._xwebagentIndex by text.
 *
 * Two-step approach: the LLM often gets element.index wrong but gets
 * element.text right. We search all indexed elements by their accessible
 * name and return the index of the closest text match.  The LLM's index
 * is used as a fallback only when no confident text match is found.
 *
 * @param {string} searchText - The element description from the LLM response
 * @returns {number|null} The best-matching index key, or null if not found
 */
function gv2FindElementByText(searchText) {
  if (!searchText) return null;
  const indexMap = window._xwebagentIndex;
  if (!indexMap || Object.keys(indexMap).length === 0) return null;

  const normalize = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const needle = normalize(searchText);
  if (needle.length < 2) return null;

  const needleWords = needle.split(' ').filter(w => w.length >= 2);
  if (needleWords.length === 0) return null;

  let bestKey = null;
  let bestScore = -1;

  for (const [key, el] of Object.entries(indexMap)) {
    let name;
    try { name = normalize(typeof getAccessibleName === 'function' ? (getAccessibleName(el) || '') : (el.textContent || '')); }
    catch (e) { continue; }
    if (!name || name.length < 2) continue;

    let score;
    if (name === needle) {
      // Perfect match
      score = 1000;
    } else if (name.includes(needle)) {
      // Element's accessible name contains the full search text
      // Prefer shorter names (more specific elements)
      score = 900 - Math.min(name.length, 400);
    } else if (needle.includes(name) && name.length >= 5) {
      // Search text contains the element's full name
      // (e.g. needle="Clear all watch history button", name="Clear all watch history")
      score = 800 - Math.min(needle.length - name.length, 200);
    } else {
      // Word overlap: count how many needle words appear in the element's name
      const nameWords = new Set(name.split(' '));
      const matched = needleWords.filter(w => nameWords.has(w)).length;
      score = Math.floor((matched / needleWords.length) * 200);
    }

    if (score > bestScore) {
      bestScore = score;
      bestKey = parseInt(key);
    }
  }

  // Require at least 50% word-overlap confidence before trusting the match
  if (bestScore < 100) return null;
  return bestKey;
}

/**
 * Parse LLM JSON, apply highlight, schedule the appropriate action.
 */
async function gv2ProcessResponse(content) {
  const g = window._guidev2;
  try {
    let json = content.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
    const m = json.match(/\{[\s\S]*\}/);
    if (m) json = m[0];
    const step = JSON.parse(json);
    console.log('[guidev2] Parsed step:', step);

    // Clear previous highlights
    if (typeof clearHighlights === 'function') clearHighlights();
    window._xwebagentHighlights = [];

    // Highlight target element — two-step approach:
    //   Step 1: find the element by text match (more reliable than LLM index)
    //   Step 2: fall back to the LLM's index only if no confident text match
    let highlightCount = 0;
    if (step.element?.index || step.element?.text) {
      const pageBg = getPageBackground();
      const style = typeof getRandomHighlightStyle === 'function'
        ? getRandomHighlightStyle(pageBg.isDark)
        : { color: '#2ed573', animation: 'pulse' };

      const textMatchIdx = step.element?.text ? gv2FindElementByText(step.element.text) : null;
      const idxToUse = textMatchIdx !== null ? textMatchIdx : step.element.index;

      if (textMatchIdx !== null && textMatchIdx !== step.element.index) {
        console.log(`[guidev2] Text-match override: LLM index ${step.element.index} → matched index ${textMatchIdx} for "${step.element.text}"`);
      } else if (textMatchIdx === null) {
        console.log(`[guidev2] No text match for "${step.element.text}", using LLM index ${step.element.index}`);
      }

      highlightCount = applyIndexedHighlight(idxToUse, step.element.text, style);
      if (window._xwebagentHighlights?.length > 0) {
        setTimeout(() => { if (typeof scrollToHighlight === 'function') scrollToHighlight(0); }, 300);
      }

      // Store the resolved target element and its text so gv2NextStep can click
      // it reliably even if React's reconciliation removes the highlight span
      // before the user presses "Next →".
      g.currentTargetEl   = window._xwebagentIndex[idxToUse] || null;
      g.currentTargetText = step.element.text || null;
    } else {
      g.currentTargetEl   = null;
      g.currentTargetText = null;
    }

    if (typeof cleanupSom === 'function') cleanupSom();

    const isLast = !!step.isLastStep;
    g.previousSteps.push(`Step ${step.step}: ${step.instruction}${isLast ? ' ✓' : ''}`);

    if (isLast) {
      _gv2ClearState();
    } else if (step.action === 'click') {
      // Save state with pendingResume=true BEFORE setting up click listener.
      // This ensures the SW and session storage have the flag before the user
      // can possibly click — no race condition with fast navigation.
      await _gv2SetState(true);
      _gv2SetupClickListener();
    } else if (step.action === 'type') {
      await _gv2SetState(false);
      setTimeout(() => _gv2AutoType(step), 200);
    } else {
      // done / unknown
      await _gv2SetState(false);
    }

    return {
      success: true,
      answer: step.instruction,
      step: step.step,
      isLastStep: isLast,
      nextStepHint: step.nextStepHint,
      action: step.action,
      highlightCount,
      hasHighlights: highlightCount > 0,
      isGuide: true
    };

  } catch (e) {
    console.error('[guidev2] Parse error:', e);
    _gv2ClearState();
    if (typeof cleanupSom === 'function') cleanupSom();
    return { success: true, answer: content, isGuide: false };
  }
}

// ===== CLICK LISTENER =====

let _gv2ClickHandlers = [];

function _gv2RemoveClickListeners() {
  _gv2ClickHandlers.forEach(({ el, evt, fn, cap }) => el.removeEventListener(evt, fn, cap));
  _gv2ClickHandlers = [];
}

function _gv2SetupClickListener() {
  _gv2RemoveClickListeners();
  _guidev2WaitingForClick = true;

  const handler = async (e) => {
    const onHighlight = e.target.closest('[data-xwebagent-styled]') ||
                        e.target.hasAttribute('data-xwebagent-styled');
    if (!onHighlight) return;

    console.log('[guidev2] User clicked highlighted element');
    _gv2RemoveClickListeners();
    _guidev2WaitingForClick = false;

    if (_guidev2Resuming) {
      console.log('[guidev2] Already resuming (SPA watcher), ignoring click handler');
      return;
    }

    try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e2) {}

    // Arm SW watch-for-new-tab window before the click propagates.
    // Fire-and-forget — no await so the click event isn't blocked.
    try { chrome.runtime.sendMessage({ action: 'guidanceV2_preClick' }); } catch (e2) {}

    const startUrl = window.location.href;
    await _gv2WaitForNavOrSettle(startUrl);
  };

  document.addEventListener('click', handler, true);
  _gv2ClickHandlers.push({ el: document, evt: 'click', fn: handler, cap: true });
  console.log('[guidev2] Waiting for user click...');
}

/**
 * After user clicks:
 *
 * Full page nav  → the port to SW will disconnect; SW signals the new page via port.
 *                  We just poll briefly to detect this and bail out cleanly.
 *
 * SPA nav        → URL changes while page stays alive. We detect it here and
 *                  generate the next step ourselves.
 *
 * Same page      → DOM changed (dropdown opened, modal appeared). Wait for DOM
 *                  to settle, then generate next step.
 *
 * We poll every 100 ms for up to 2 s. For full-page nav, browser usually
 * fires pagehide within a few hundred ms.
 */
let _guidev2PageHiding = false;
window.addEventListener('pagehide', () => { _guidev2PageHiding = true; });

async function _gv2WaitForNavOrSettle(startUrl) {
  const POLL_MS = 100;
  const MAX_POLLS = 20; // 2 s

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));

    // Full page navigation: pagehide has fired.
    // The SW port from this page is now (or about to be) disconnected.
    // The new page's content script will connect to SW and get the state.
    if (_guidev2PageHiding) {
      console.log('[guidev2] Full page navigation detected — new page will resume via SW');
      return;
    }

    // SPA navigation: URL changed but page is still alive.
    if (window.location.href !== startUrl) {
      // Poll for up to 800 ms for pagehide — some sites (e.g. Amazon) push a new
      // history entry via JS *before* the full page unload.  400 ms was too short
      // for those cases; 800 ms with early exit keeps SPA detection responsive.
      for (let j = 0; j < 8; j++) {
        await new Promise(r => setTimeout(r, 100));
        if (_guidev2PageHiding) {
          console.log('[guidev2] Full-page nav after URL change — new page will resume via SW');
          return;
        }
      }
      console.log('[guidev2] SPA navigation confirmed');
      if (_guidev2Resuming) return;
      _guidev2Resuming = true;  // Set BEFORE any await to prevent double-fire
      try {
        // Give the SPA framework time to tear down the old view and render the
        // new one before we start the stability observer.  Without this initial
        // delay the observer can resolve on the OLD (static) DOM within 250 ms
        // and capture the wrong page.
        await new Promise(r => setTimeout(r, 600));
        await gv2WaitForDomStable(6000, 600);
        const result = await gv2GenerateNextStep();
        if (result && result.success !== false) {
          try { chrome.runtime.sendMessage({ action: 'guideStep', result }); } catch (e) {}
        } else {
          try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
        }
      } finally {
        _guidev2Resuming = false;
      }
      return;
    }
  }

  // No navigation after 2 s — same page (dropdown, modal, etc.)
  // One last guard: if pagehide fired during the polling loop it means a very
  // slow full-page navigation is in progress — let the new page handle it.
  if (_guidev2PageHiding) return;

  // Check if the click opened a new tab (target="_blank" / window.open).
  // In that case the SW has transferred guidance ownership to the new tab,
  // so this tab should stop — the new tab will resume on its own.
  try {
    const ownerCheck = await safeSendMessage({ action: 'guidanceV2_isOwner' });
    if (ownerCheck && ownerCheck.isOwner === false) {
      console.log('[guidev2] Guidance transferred to new tab — stopping on this page');
      try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
      return;
    }
  } catch (e) { /* SW unavailable — proceed with same-page behaviour */ }

  console.log('[guidev2] No navigation — continuing on same page');
  if (_guidev2Resuming) return;
  _guidev2Resuming = true;
  try {
    // Wait for DOM to settle (e.g. dropdown finished rendering)
    await gv2WaitForDomStable(2000, 300);
    const result = await gv2GenerateNextStep();
    if (result && result.success !== false) {
      try { chrome.runtime.sendMessage({ action: 'guideStep', result }); } catch (e) {}
    } else {
      try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
    }
  } finally {
    _guidev2Resuming = false;
  }
}

// ===== AUTO-TYPING =====

/**
 * Agent fills a text field automatically using native input setters
 * so React / Vue / Angular state management picks up the change.
 */
async function _gv2AutoType(step) {
  if (!step.typeText) {
    console.warn('[guidev2] autoType: no typeText in step');
  } else {
    const highlighted = document.querySelector('[data-xwebagent-styled]');
    const input = highlighted
      ? (highlighted.matches('input,textarea,[contenteditable]')
          ? highlighted
          : highlighted.querySelector('input,textarea,[contenteditable]'))
      : null;

    if (!input) {
      console.warn('[guidev2] autoType: no input element found in highlighted area');
    } else {
      console.log('[guidev2] Auto-typing:', step.typeText);
      input.focus();

      if (input.isContentEditable) {
        // Select all existing content and replace it in one execCommand call
        // so rich-text frameworks (Draft.js, ProseMirror, etc.) see proper events.
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, step.typeText);
        // execCommand already fires 'input'; fire 'change' for good measure.
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // Select all existing text first (visual feedback + clean slate).
        input.select();
        const proto = input.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(input, step.typeText);
        else input.value = step.typeText;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }

  console.log('[guidev2] Auto-type done, generating next step...');
  if (_guidev2Resuming) return;
  _guidev2Resuming = true;
  try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}
  try {
    const result = await gv2GenerateNextStep();
    if (result && result.success !== false) {
      try { chrome.runtime.sendMessage({ action: 'guideStep', result }); } catch (e) {}
    } else {
      try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
    }
  } finally {
    _guidev2Resuming = false;
  }
}

// ===== CLICK SIMULATION =====

/**
 * Dispatch the full synthetic pointer+mouse event sequence on an element.
 *
 * el.click() only fires the 'click' event.  Many SPA frameworks — including
 * Google Docs and Google Sheets — open menus by listening for 'mousedown'
 * (which el.click() skips).  Dispatching the complete sequence
 * pointerdown → mousedown → pointerup → mouseup → click ensures those
 * frameworks respond identically to a real user click.
 *
 * A synthetic 'click' MouseEvent still triggers the browser default action
 * (e.g. following <a href> links) per spec, so navigation works too.
 */
function _gv2DispatchClick(el) {
  const rect = el.getBoundingClientRect();
  const cx = Math.round(rect.left + rect.width / 2);
  const cy = Math.round(rect.top + rect.height / 2);
  const shared = {
    bubbles: true, cancelable: true, view: window,
    clientX: cx, clientY: cy,
    screenX: cx + (window.screenX || 0),
    screenY: cy + (window.screenY || 0),
  };

  try { el.focus({ preventScroll: true }); } catch (e) {}

  el.dispatchEvent(new PointerEvent('pointerover',  { ...shared, pointerType: 'mouse', isPrimary: true, button: -1, buttons: 0 }));
  el.dispatchEvent(new MouseEvent ('mouseover',     { ...shared, button: -1, buttons: 0 }));
  el.dispatchEvent(new PointerEvent('pointermove',  { ...shared, pointerType: 'mouse', isPrimary: true, button: -1, buttons: 0 }));
  el.dispatchEvent(new MouseEvent ('mousemove',     { ...shared, button: -1, buttons: 0 }));
  el.dispatchEvent(new PointerEvent('pointerdown',  { ...shared, pointerType: 'mouse', isPrimary: true, button: 0,  buttons: 1 }));
  el.dispatchEvent(new MouseEvent ('mousedown',     { ...shared, button: 0,  buttons: 1 }));
  el.dispatchEvent(new PointerEvent('pointerup',    { ...shared, pointerType: 'mouse', isPrimary: true, button: 0,  buttons: 0 }));
  el.dispatchEvent(new MouseEvent ('mouseup',       { ...shared, button: 0,  buttons: 0 }));
  el.dispatchEvent(new MouseEvent ('click',         { ...shared, button: 0,  buttons: 0 }));
}

// ===== NEXT STEP (panel "Next" button) =====

/**
 * Called when the user clicks the "Next →" button in the side panel.
 * Equivalent to clicking the highlighted element, but without requiring the
 * user to interact with the page. Removes the pending click listener and
 * immediately generates the next step on the current page.
 */
window.gv2NextStep = async function () {
  if (!_guidev2WaitingForClick) return; // Not in a click-wait state
  _gv2RemoveClickListeners();
  _guidev2WaitingForClick = false;

  if (_guidev2Resuming) return;

  try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}

  // Resolve the element to click.
  //
  // Priority order:
  //   1. Stored reference from gv2ProcessResponse (survives React reconciliation
  //      that removes injected highlight spans from the DOM).
  //   2. Fresh text-based lookup via gv2FindElementByText (handles the case where
  //      React replaced the element node itself since the last step was generated).
  //   3. Fallback: query for [data-xwebagent-styled] (whole-element highlight path,
  //      where data-xwebagent-styled is on the real element, not an injected span).
  //
  // After finding the node, walk up to the nearest real interactive ancestor so
  // React/SPA event handlers (attached to <a>/<button>/[role="button"]) fire correctly.
  const _INTERACTIVE_SELECTORS =
    'a[href], button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], summary';

  function _resolveClickTarget(el) {
    if (!el || !document.contains(el)) return null;
    return el.closest(_INTERACTIVE_SELECTORS) || el;
  }

  let toClick = null;

  // 1. Stored reference
  const storedEl = window._guidev2?.currentTargetEl;
  if (storedEl && document.contains(storedEl)) {
    toClick = _resolveClickTarget(storedEl);
    console.log('[guidev2] Using stored target:', toClick?.tagName, toClick?.textContent?.slice(0, 60));
  }

  // 2. Fresh text-based lookup (React may have replaced the node)
  if (!toClick && window._guidev2?.currentTargetText) {
    const freshIdx = gv2FindElementByText(window._guidev2.currentTargetText);
    if (freshIdx !== null) {
      const freshEl = window._xwebagentIndex?.[freshIdx];
      toClick = _resolveClickTarget(freshEl);
      if (toClick) console.log('[guidev2] Using fresh text-match target:', toClick.tagName, toClick.textContent?.slice(0, 60));
    }
  }

  // 3. Highlight-span fallback
  if (!toClick) {
    const highlighted = document.querySelector('[data-xwebagent-styled]');
    toClick = _resolveClickTarget(highlighted);
    if (toClick) console.log('[guidev2] Using highlight-span fallback:', toClick.tagName, toClick.textContent?.slice(0, 60));
  }

  if (toClick) {
    try { _gv2DispatchClick(toClick); } catch (e) { console.warn('[guidev2] Auto-click failed:', e); }
  } else {
    console.warn('[guidev2] No clickable element found — continuing without click');
  }

  // Use the same post-click flow as a real user click: detects full-page nav,
  // SPA nav, or same-page DOM settle, then generates the next step.
  const startUrl = window.location.href;
  await _gv2WaitForNavOrSettle(startUrl);
};

// ===== STOP GUIDE =====

/**
 * Called when the user presses the Stop button or resets the chat.
 * Aborts any in-progress generation and clears all guidance state.
 */
window.gv2StopGuide = function () {
  _guidev2Stopped = true;
  _guidev2Resuming = false;
  _guidev2WaitingForClick = false;
  _gv2RemoveClickListeners();
  _gv2ClearState();
};

// ===== ROUTER INTEGRATION =====
// guidev2.js is injected after guide.js, so this assignment overrides guide.js.

window.handleStepByStepGuide = function (question, continueFromStep = false) {
  // continueFromStep=true comes from guide.js's continueGuidance() which won't fire
  // when v2 is active (_xwebagentGuidance.active = false). Handle defensively anyway.
  if (continueFromStep) return gv2GenerateNextStep();
  return _handleStepByStepGuideV2(question);
};

console.log('[guidev2] loaded — SW-based navigation, MutationObserver stability');
