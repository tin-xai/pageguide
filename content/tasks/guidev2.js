// PageGuide - Step-by-Step Guidance v2
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

Return JSON only:
{
  "step": N,
  "instruction": "Clear instruction shown to the user",
  "element": {"index": N, "text": "element text to highlight"},
  "action": "click" | "type" | "done",
  "typeText": "text to type (only when action=type)",
  "isLastStep": false,
  "nextStepHint": "What will happen after this step",
  "confidence": 0.0,
  "risk": "low" | "high",
  "riskReason": "short reason for the risk level"
}

confidence: 0.0–1.0 — how sure you are that THIS step and the chosen element are correct
  for the user's goal on the current page. Be honest: use a low value (< 0.5) when the
  target is ambiguous, not clearly visible, or you are guessing.
risk: "low" if this action is reversible, routine and easy (e.g. opening a menu, toggling
  a setting that can be undone, navigating, typing a search query) — safe for the agent to
  perform automatically. "high" if it is sensitive or hard to undo: signing in,
  payments/purchases, deleting or removing data, sending/posting/publishing, or entering a
  password or other sensitive text. High-risk steps are left for the user to perform.

RULES:
1. ONE step at a time — never list multiple things to do
2. action="click": click the highlighted element (the agent does this for low-risk steps;
   the user does it for high-risk ones)
3. action="type": provide typeText; the agent auto-fills low-risk fields, and lets the user
   type high-risk ones (e.g. passwords)
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

const _GV2_KEY = 'pageguideGuidanceV2';
const _GV2_MAX_AGE = 10 * 60 * 1000; // 10 minutes

// ===== PAGE INDICATOR =====

const _GV2_INDICATOR_ID = 'pageguide-gv2-indicator';
let _gv2IndicatorInjected = false;

function _gv2ShowIndicator(text = 'Agent thinking…') {
  if (!_gv2IndicatorInjected) {
    _gv2IndicatorInjected = true;
    const style = document.createElement('style');
    style.id = 'pageguide-gv2-indicator-css';
    style.textContent = `
#pageguide-gv2-indicator{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(16px);z-index:2147483647;display:flex;align-items:center;gap:10px;padding:10px 18px;border-radius:999px;background:rgba(20,20,30,.88);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.12);box-shadow:0 4px 24px rgba(0,0,0,.45);color:#e8e8f0;font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none;opacity:0;transition:opacity .22s ease,transform .22s ease}
#pageguide-gv2-indicator.gv2-visible{opacity:1;transform:translateX(-50%) translateY(0)}
#pageguide-gv2-indicator .gv2-spinner{width:14px;height:14px;border:2px solid rgba(160,120,255,.35);border-top-color:#a078ff;border-radius:50%;animation:gv2spin .75s linear infinite;flex-shrink:0}
@keyframes gv2spin{to{transform:rotate(360deg)}}`;
    document.head.appendChild(style);
  }
  let el = document.getElementById(_GV2_INDICATOR_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = _GV2_INDICATOR_ID;
    el.innerHTML = '<div class="gv2-spinner"></div><span class="gv2-label"></span>';
    document.body.appendChild(el);
  }
  el.querySelector('.gv2-label').textContent = text;
  el.getBoundingClientRect(); // force reflow so transition plays
  el.classList.add('gv2-visible');
}

function _gv2HideIndicator() {
  const el = document.getElementById(_GV2_INDICATOR_ID);
  if (el) el.classList.remove('gv2-visible');
}

// ===== AUTO-MODE OVERLAY + TAKE-CONTROL BUTTON (Slice 4) =====
// A light-yellow, click-through tint over the page signals that the agent is acting
// autonomously. A floating "Take control" button (which IS clickable) lets the user
// reclaim control at any moment.

const _GV2_AUTO_OVERLAY_ID = 'pageguide-gv2-auto';
let _gv2AutoOverlayCss = false;

function gv2ShowAutoOverlay() {
  if (!_gv2AutoOverlayCss) {
    _gv2AutoOverlayCss = true;
    const style = document.createElement('style');
    style.id = 'pageguide-gv2-auto-css';
    style.textContent = `
#${_GV2_AUTO_OVERLAY_ID}{position:fixed;inset:0;z-index:2147483646;pointer-events:none;background:rgba(255,221,87,.10);box-shadow:inset 0 0 0 3px rgba(255,200,0,.45);opacity:0;transition:opacity .2s ease}
#${_GV2_AUTO_OVERLAY_ID}.on{opacity:1}
#${_GV2_AUTO_OVERLAY_ID} .gv2-take{position:absolute;top:64px;left:50%;transform:translateX(-50%);pointer-events:auto;display:flex;align-items:center;gap:8px;background:rgba(20,20,30,.92);color:#ffd166;border:1px solid rgba(255,209,102,.5);border-radius:999px;padding:9px 16px;font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;box-shadow:0 4px 22px rgba(0,0,0,.45);opacity:.7;transition:opacity .15s ease}
#${_GV2_AUTO_OVERLAY_ID} .gv2-take:hover{opacity:1;background:rgba(44,44,60,.96);border-color:rgba(255,209,102,.8)}
#${_GV2_AUTO_OVERLAY_ID} .gv2-take .gv2-dot{width:8px;height:8px;border-radius:50%;background:#ffd166;animation:gv2autopulse 1.2s ease-in-out infinite;flex-shrink:0}
@keyframes gv2autopulse{0%,100%{opacity:1}50%{opacity:.25}}`;
    document.head.appendChild(style);
  }
  let el = document.getElementById(_GV2_AUTO_OVERLAY_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = _GV2_AUTO_OVERLAY_ID;
    const btn = document.createElement('button');
    btn.className = 'gv2-take';
    btn.innerHTML = '<span class="gv2-dot"></span><span>✋ Take control</span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof gv2TakeControl === 'function') gv2TakeControl();
    });
    el.appendChild(btn);
    document.body.appendChild(el);
  }
  el.getBoundingClientRect(); // force reflow so the fade plays
  el.classList.add('on');
}

function gv2HideAutoOverlay() {
  const el = document.getElementById(_GV2_AUTO_OVERLAY_ID);
  if (el) el.classList.remove('on');
}

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

window._guidev2 = { active: false, question: '', previousSteps: [], currentPlanStep: 1 };

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
        sessionId: s.sessionId,
        captureEnabled: s.captureEnabled,
        tutorialRef: s.tutorialRef,
        tutorialReason: s.tutorialReason,
        currentPlanStep: s.currentPlanStep,
        autoMode: s.autoMode,
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

// Set once a Rewind "Steer from here" handoff has been consumed on this page load, so the
// normal navigation-resume paths don't also fire and fight the forked session.
let _gv2SteerHandled = false;

async function _gv2HandleSwMessage(msg) {
  if (msg.type !== 'swState') return;
  if (_gv2SteerHandled) return; // a steer fork owns this page

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
  if (_gv2SteerHandled) return;
  const saved = await gv2LoadFallback();
  if (saved?.active && saved?.pendingResume) {
    await _gv2ResumeFromState(saved);
  }
}

// Bootstrap on each page load: a pending "Steer from here" handoff takes precedence over
// the normal resume; otherwise connect to the SW for ordinary resume.
async function _gv2Bootstrap() {
  try {
    if (typeof rewindGetSteerPending === 'function') {
      const steer = await rewindGetSteerPending();
      if (steer && steer.url && _gv2UrlMatches(steer.url, window.location.href)) {
        _gv2SteerHandled = true;
        _gv2ConnectToSW(); // keep the SW port for ownership; the flag blocks SW-driven resume
        await _gv2ResumeFromSteer(steer);
        return;
      }
    }
  } catch (e) {
    console.warn('[guidev2] steer bootstrap failed:', e);
  }
  _gv2ConnectToSW();
}

// Tolerant URL compare: exact href, else same origin + pathname (ignore query/hash drift).
function _gv2UrlMatches(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const ua = new URL(a), ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch (e) { return false; }
}

_gv2Bootstrap();

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
    previousSteps: state.previousSteps || [],
    sessionId: state.sessionId,
    captureEnabled: state.captureEnabled,
    tutorialRef: state.tutorialRef || null,
    tutorialReason: state.tutorialReason || null,
    currentPlanStep: state.currentPlanStep || 1,
    autoMode: state.autoMode === true
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

    // Rewind: the click that triggered this full-page nav is the last recorded step;
    // refresh its snapshot with the post-navigation page before generating the next step.
    await gv2RecaptureAfterAction(window._guidev2?.previousSteps?.length || 0);

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

// ===== REWIND STEER (branch & re-run from a past step) =====

/**
 * Same-page steer: fork + re-run on the CURRENT live DOM without reloading. Used when the
 * branch point is the page the user is already on — reloading a heavy SPA (e.g. Google Slides)
 * would lose in-page state and can trigger a "leave site?" prompt, so we re-ground in place.
 */
async function gv2SteerNow(payload) {
  return _gv2ResumeFromSteer(payload, { inPlace: true });
}

/**
 * Resume a forked ("Steer from here") session: rebuild the earlier steps' transient state and
 * re-decide the branch step with the user's new instruction. previousSteps holds steps
 * 1…fromStep−1, so the next generated step is `fromStep` itself.
 *
 * @param {object} payload - { sessionId, fromStep, newGoal, url }
 * @param {object} [opts]  - { inPlace } true = current live page (no reload / no replay);
 *                           false = freshly-loaded landing page (settle + action replay).
 */
async function _gv2ResumeFromSteer(payload, opts = {}) {
  const inPlace = !!opts.inPlace;
  console.log('[guidev2] steer resume start', { inPlace, payload });
  if (_guidev2Resuming) { console.warn('[guidev2] steer ignored — already resuming'); return; }
  _guidev2Resuming = true;

  const fromStep = (payload && payload.fromStep) || 1;
  // Immediate, unmissable feedback so it's clear the content script received the steer —
  // this fires BEFORE any record reads or LLM calls, so a later failure can't hide it.
  try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}
  try {
    chrome.runtime.sendMessage({
      action: 'addMessage',
      content: inPlace
        ? `♻️ Continuing after step ${fromStep} on this page with your new instruction…`
        : `♻️ Restoring through step ${fromStep} and continuing with your new instruction…`,
      type: 'info'
    });
  } catch (e) {}

  try {
    // One-shot: clear the handoff so a manual reload can't replay it again.
    if (typeof rewindClearSteerPending === 'function') await rewindClearSteerPending();

    // Keep steps 1…fromStep (inclusive); the agent re-runs from fromStep+1.
    const kept = [];
    if (typeof rewindGetRecord === 'function') {
      for (let s = 1; s <= fromStep; s++) {
        const r = await rewindGetRecord(payload.sessionId, s);
        if (r) kept.push(r);
      }
    }

    // Original goal lives in the session index; combine it with the steer redirection.
    let goal = '';
    try {
      if (typeof rewindGetIndex === 'function') {
        const idx = await rewindGetIndex(payload.sessionId);
        if (idx && idx.goal) goal = idx.goal;
      }
    } catch (e) {}
    const question = `${goal}\nUSER REDIRECTION after step ${fromStep}: ${payload.newGoal || ''}`.trim();

    const captureEnabled = await _gv2IsCaptureEnabled();
    const autoMode = await _gv2IsAutoMode();
    // Tutorial lookup is best-effort — never let it block or break the steer.
    let match = null;
    try { match = await _gv2FindTutorial(question, window.location.href); } catch (e) { console.warn('[guidev2] steer tutorial lookup failed:', e); }

    _guidev2Stopped = false;
    window._guidev2 = {
      active: true,
      question,
      previousSteps: kept.map(r => `Step ${r.step}: ${r.instruction || ''}`),
      tutorialRef: match?.tutorial || null,
      tutorialReason: match?.reason || null,
      sessionId: payload.sessionId,
      captureEnabled,
      autoMode,
      currentPlanStep: fromStep + 1
    };
    console.log('[guidev2] steer session built; continuing from step', fromStep + 1);

    if (inPlace) {
      // Already on the page with its live state — just let any in-flight changes settle and
      // re-ground on the current DOM. No reload, no replay.
      await gv2WaitForDomStable(3000, 300);
    } else {
      // Freshly-loaded landing page: let it settle, then replay the in-page actions to rebuild
      // transient state (open dropdowns, filled forms) before re-deciding the branch step.
      await new Promise(r => setTimeout(r, 500));
      await gv2WaitForDomStable(8000, 700);
      await _gv2ReplayActions(kept, payload.url);
    }

    const result = await gv2GenerateNextStep();
    if (result && result.success !== false) {
      try { chrome.runtime.sendMessage({ action: 'guideStep', result }); } catch (e) {}
    } else {
      try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
    }
  } catch (e) {
    console.error('[guidev2] steer resume error:', e);
    try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e2) {}
  } finally {
    _guidev2Resuming = false;
  }
}

/**
 * Best-effort replay of recorded actions to rebuild transient state (open dropdowns, filled
 * forms) on the landing page. Replays only the steps whose action happened on this page
 * (post-action URL === landingUrl), skipping the click that navigated *into* the page (the
 * reload already did that). On a miss it flags the step for the user and stops — the agent
 * then re-grounds on whatever state exists.
 */
async function _gv2ReplayActions(records, landingUrl) {
  if (!Array.isArray(records) || !records.length) return;
  let list = records.filter(r => r && r.url === landingUrl).sort((a, b) => a.step - b.step);
  if (list.length) {
    const first = list[0];
    const prev = records.find(r => r.step === first.step - 1);
    if (prev && prev.url !== landingUrl) list = list.slice(1); // drop the boundary navigator
  }
  for (const r of list) {
    if (window.location.href !== landingUrl) {
      _gv2FlagReplayStuck(r.step, 'the page changed unexpectedly during replay');
      return;
    }
    const ok = await _gv2ReplayOne(r);
    if (!ok) {
      const what = (r.target && r.target.text) ? `"${r.target.text}"` : 'the element';
      _gv2FlagReplayStuck(r.step, `couldn't find ${what}`);
      return;
    }
    await gv2WaitForDomStable(3000, 300);
  }
}

/** Re-apply a single recorded action. Returns false when the target can't be resolved. */
async function _gv2ReplayOne(r) {
  const text = r.target && r.target.text;
  if (!text) return false;
  const pageIndex = createPageIndex(5000, true);
  const idx = (typeof gv2MatchIndexText === 'function') ? gv2MatchIndexText(pageIndex.indexText, text) : null;
  const el = idx ? (window._pageguideIndex[idx] || null) : null;
  if (!el) return false;

  const action = String(r.action || 'click').toLowerCase();
  if (action === 'type') {
    if (r.typeText == null) return true; // no stored value (e.g. a secret) — nothing to refill
    _gv2ReplayType(el, r.typeText);
  } else {
    _gv2DispatchClick(el);
  }
  return true;
}

/** Set a value into a resolved field (mirrors _gv2AutoType's core, for an explicit element). */
function _gv2ReplayType(el, text) {
  const input = el.matches('input,textarea,[contenteditable]')
    ? el : el.querySelector('input,textarea,[contenteditable]');
  if (!input) return;
  input.focus();
  if (input.isContentEditable) {
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    try { input.select(); } catch (e) {}
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, text); else input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/**
 * Replay couldn't re-apply a step: tell the user and force the branch step to render in manual
 * mode (Next + Stop) so they keep control even if Auto is on.
 */
function _gv2FlagReplayStuck(step, reason) {
  if (window._guidev2) window._guidev2._forceManualNextStep = true;
  try {
    chrome.runtime.sendMessage({
      action: 'addMessage',
      content: `🖐 I couldn't auto-restore step ${step} (${reason}). I'll continue from the current page — please adjust it if needed, then use the step's buttons.`,
      type: 'info'
    });
  } catch (e) {}
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
    pendingResume,
    // Rewind (Slice 1): carry capture session across navigations.
    sessionId: s.sessionId,
    captureEnabled: s.captureEnabled,
    tutorialRef: s.tutorialRef,
    tutorialReason: s.tutorialReason,
    currentPlanStep: s.currentPlanStep,
    // Mode: carry Manual/Auto across navigations.
    autoMode: s.autoMode
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
  _gv2HideIndicator();
  gv2HideAutoOverlay();

  // Clear from SW
  try { chrome.runtime.sendMessage({ action: 'guidanceV2_clearState' }); } catch (e) {}

  // Clear session storage
  gv2ClearFallback();
}

// ===== REWIND CAPTURE (Slice 1) =====

const _GV2_CAPTURE_PREF_KEY = 'rewindCaptureEnabled';

/**
 * Read the user's "capture steps for rewind" preference (default ON).
 */
async function _gv2IsCaptureEnabled() {
  try {
    const r = await chrome.storage.local.get(_GV2_CAPTURE_PREF_KEY);
    // Default to enabled unless explicitly turned off.
    return r[_GV2_CAPTURE_PREF_KEY] !== false;
  } catch (e) {
    return true;
  }
}

// ===== AUTONOMOUS MODE (Manual vs Auto) =====
// Manual (default): the user clicks each highlighted step themselves.
// Auto: the agent performs reversible/low-risk steps automatically and hands control
//       back to the user for sensitive/high-risk ones.

const _GV2_AUTOMODE_PREF_KEY = 'guideAutoMode';

async function _gv2IsAutoMode() {
  try {
    const r = await chrome.storage.local.get(_GV2_AUTOMODE_PREF_KEY);
    return r[_GV2_AUTOMODE_PREF_KEY] === true; // default false (manual)
  } catch (e) {
    return false;
  }
}

// Keep the live session's mode in sync when the user toggles it mid-session.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[_GV2_AUTOMODE_PREF_KEY] && window._guidev2) {
      const on = changes[_GV2_AUTOMODE_PREF_KEY].newValue === true;
      window._guidev2.autoMode = on;
      // Turning Auto off mid-session: drop the overlay and any pending auto-click.
      if (!on) {
        if (window._guidev2._autoClickTimer) {
          clearTimeout(window._guidev2._autoClickTimer);
          window._guidev2._autoClickTimer = null;
        }
        if (typeof gv2HideAutoOverlay === 'function') gv2HideAutoOverlay();
      }
    }
  });
} catch (e) { /* storage events unavailable */ }

/**
 * Whether the agent should auto-perform this step (Auto mode + low effective risk).
 */
function _gv2ShouldAutoExecute(step) {
  const g = window._guidev2;
  if (!g || !g.autoMode) return false;
  const risk = (typeof gv2AssessRisk === 'function') ? gv2AssessRisk(step) : 'low';
  return risk === 'low';
}

/**
 * Capture a rewind record for the current step: viewport screenshot + static DOM
 * snapshot + the agent's reasoning. Persisted to the rewind store and announced to
 * the side panel (lightweight meta only — the heavy payload is loaded lazily on
 * inspect). Fire-and-forget: never blocks or breaks the guidance flow.
 *
 * @param {object} data - reasoning fields for the step (see record shape in plan)
 */
async function gv2CaptureStepRecord(data) {
  const g = window._guidev2;
  if (!g || !g.active || !g.captureEnabled || !g.sessionId) return;
  if (typeof rewindPutRecord !== 'function') return;

  // Stash so a later re-capture (e.g. after auto-type fills a field) can reuse the
  // same reasoning fields and only refresh the screenshot/DOM snapshot.
  g._lastCaptureData = data;

  try {
    const startedAt = g._stepStartedAt || Date.now();
    let screenshot = null;
    try { if (typeof captureScreenshot === 'function') screenshot = await captureScreenshot(); }
    catch (e) { /* screenshot is best-effort */ }

    let domSnapshot = '';
    try { if (typeof gv2SerializeDom === 'function') domSnapshot = gv2SerializeDom(); }
    catch (e) { console.warn('[guidev2] DOM snapshot failed:', e); }

    const record = {
      sessionId: g.sessionId,
      step: data.step,
      planStep: data.planStep != null ? data.planStep : data.step,
      timestamp: Date.now(),
      url: window.location.href,
      instruction: data.instruction || '',
      action: data.action || null,
      typeText: data.typeText != null ? data.typeText : null,
      isLastStep: !!data.isLastStep,
      nextStepHint: data.nextStepHint || '',
      target: data.target || null,
      confidence: data.confidence != null ? data.confidence : null,
      durationMs: Date.now() - startedAt,
      screenshot: screenshot || null,
      domSnapshot,
      tutorialMatch: data.tutorialMatch || null,
      rawLlmJson: data.rawLlmJson || ''
    };

    await rewindPutRecord(record);

    // Tell the panel a step record is ready (lightweight — no screenshot/DOM payload).
    try {
      chrome.runtime.sendMessage({
        action: 'guideStepRecord',
        meta: {
          sessionId: record.sessionId,
          step: record.step,
          planStep: record.planStep,
          instruction: record.instruction,
          action: record.action,
          isLastStep: record.isLastStep,
          url: record.url,
          timestamp: record.timestamp,
          durationMs: record.durationMs,
          confidence: record.confidence
        }
      });
    } catch (e) { /* panel may be closed */ }
  } catch (e) {
    console.warn('[guidev2] gv2CaptureStepRecord failed:', e);
  }
}

/**
 * Refresh a step's stored record with the page state AFTER its action ran (screenshot +
 * DOM snapshot + URL), so the inspector shows the result of the click — not the pre-click
 * page. Merges into the existing record (instruction/action/target/typeText are preserved).
 * Fire-and-forget: never blocks or breaks the guidance flow.
 *
 * @param {number} stepNumber - the step whose action just completed
 */
async function gv2RecaptureAfterAction(stepNumber) {
  const g = window._guidev2;
  if (!g || !g.captureEnabled || !g.sessionId || !stepNumber) return;
  if (typeof rewindPatchRecord !== 'function') return;
  try {
    let screenshot = null;
    try { if (typeof captureScreenshot === 'function') screenshot = await captureScreenshot(); }
    catch (e) { /* best-effort */ }

    let domSnapshot = '';
    try { if (typeof gv2SerializeDom === 'function') domSnapshot = gv2SerializeDom(); }
    catch (e) { /* best-effort */ }

    const patch = { url: window.location.href };
    if (screenshot) patch.screenshot = screenshot;
    if (domSnapshot) patch.domSnapshot = domSnapshot;
    await rewindPatchRecord(g.sessionId, stepNumber, patch);
  } catch (e) {
    console.warn('[guidev2] gv2RecaptureAfterAction failed:', e);
  }
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

  // Rewind (Slice 1): start a fresh capture session. sessionId rides along in the
  // persisted state so the resumed page on the next navigation keeps writing to it.
  const sessionId = 'gv2-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const captureEnabled = await _gv2IsCaptureEnabled();
  const autoMode = await _gv2IsAutoMode();

  window._guidev2 = {
    active: true,
    question,
    previousSteps: [],
    tutorialRef: match?.tutorial || null,
    tutorialReason: match?.reason || null,
    sessionId,
    captureEnabled,
    autoMode,
    currentPlanStep: 1
  };

  if (captureEnabled && typeof rewindStartSession === 'function') {
    try { await rewindStartSession(sessionId, question); } catch (e) { /* non-fatal */ }
  }

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

  // Rewind: mark when work on this step began (used for durationMs in the record).
  g._stepStartedAt = Date.now();

  _gv2ShowIndicator('Agent thinking…');
  // Auto mode: show the "agent is driving" overlay + Take-control button while working.
  if (g.autoMode) gv2ShowAutoOverlay();

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

  if (!g.active || _guidev2Stopped) return null;

  const curSig = (typeof gv2PageSignature === 'function')
    ? gv2PageSignature(pageIndex, window.location.href) : null;
  // Remember this page's signature so the NEXT auto-performed step has a "before" baseline.
  g._lastPageSig = curSig;

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
      _gv2HideIndicator();
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
    _gv2HideIndicator();
    return { success: false, error: 'No response from AI' };

  } catch (e) {
    console.error('[guidev2] Generation error:', e);
    _gv2HideIndicator();
    return { success: false, error: e.message };
  }
}

/**
 * Find the best matching element index in window._pageguideIndex by text.
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
  const indexMap = window._pageguideIndex;
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
    const step = (typeof gv2ExtractJsonObject === 'function')
      ? gv2ExtractJsonObject(content)
      : JSON.parse(content);
    if (!step) throw new Error('Could not parse step JSON');
    console.log('[guidev2] Parsed step:', step);

    // Plan (Slice 2): normalize confidence to 0..1 and advance the plan pointer.
    const confidence = (typeof step.confidence === 'number' && isFinite(step.confidence))
      ? Math.max(0, Math.min(1, step.confidence)) : null;
    if (typeof step.planStep === 'number' && step.planStep >= 1) {
      g.currentPlanStep = step.planStep;
    }

    // Clear previous highlights
    if (typeof clearHighlights === 'function') clearHighlights();
    window._pageguideHighlights = [];

    // Highlight target element — two-step approach:
    //   Step 1: find the element by text match (more reliable than LLM index)
    //   Step 2: fall back to the LLM's index only if no confident text match
    let highlightCount = 0;
    if (step.element?.index || step.element?.text) {
      const pageBg = getPageBackground();
      // Slice 6: low-confidence steps (< 0.5) are highlighted RED on the page to flag the
      // user that this step is uncertain and worth reviewing/steering before acting.
      const isLowConfidence = confidence != null && confidence < 0.5;
      const style = isLowConfidence
        ? { color: '#ff4757', animation: 'pulse' }
        : (typeof getRandomHighlightStyle === 'function'
            ? getRandomHighlightStyle(pageBg.isDark)
            : { color: '#2ed573', animation: 'pulse' });

      const textMatchIdx = step.element?.text ? gv2FindElementByText(step.element.text) : null;
      const idxToUse = textMatchIdx !== null ? textMatchIdx : step.element.index;

      if (textMatchIdx !== null && textMatchIdx !== step.element.index) {
        console.log(`[guidev2] Text-match override: LLM index ${step.element.index} → matched index ${textMatchIdx} for "${step.element.text}"`);
      } else if (textMatchIdx === null) {
        console.log(`[guidev2] No text match for "${step.element.text}", using LLM index ${step.element.index}`);
      }

      highlightCount = applyIndexedHighlight(idxToUse, step.element.text, style);
      if (window._pageguideHighlights?.length > 0) {
        setTimeout(() => { if (typeof scrollToHighlight === 'function') scrollToHighlight(0); }, 300);
      }

      // Store the resolved target element and its text so gv2NextStep can click
      // it reliably even if React's reconciliation removes the highlight span
      // before the user presses "Next →".
      g.currentTargetEl   = window._pageguideIndex[idxToUse] || null;
      g.currentTargetText = step.element.text || null;
    } else {
      g.currentTargetEl   = null;
      g.currentTargetText = null;
    }

    if (typeof cleanupSom === 'function') cleanupSom();

    const isLast = !!step.isLastStep;
    g.previousSteps.push(`Step ${step.step}: ${step.instruction}${isLast ? ' ✓' : ''}`);

    // Simple dispatch: click | type | done.
    const action = String(step.action || (isLast ? 'done' : 'click')).toLowerCase();
    const risk = (typeof gv2AssessRisk === 'function') ? gv2AssessRisk(step) : 'low';
    const isHighRisk = risk === 'high';
    g._lastAction = action;

    // Remember the live step so the panel "Next →" (manual mode) can perform it and advance.
    g._currentStep = { action, typeText: step.typeText, value: step.value, instruction: step.instruction, highRisk: isHighRisk };

    // Gate 1 (Risk) + hand-back override: the agent auto-performs only in Auto mode, for
    // low-risk actions, and not when a prior gate handed control back for this step.
    const forcedManual = !!g._forceManualNextStep;
    g._forceManualNextStep = false;
    const autoPerform = g.autoMode && !isHighRisk && !forcedManual;

    if (isLast || action === 'done') {
      _gv2ClearState();
    } else if (action === 'type') {
      await _gv2SetState(false);
      if (autoPerform) {
        setTimeout(() => _gv2AutoType(step), 200);
      } else {
        // Manual / handed-back: highlight the field; the user types and presses Next.
        _gv2SetupClickListener();
        if (g.autoMode && isHighRisk) {
          gv2HideAutoOverlay();
          const reason = step.riskReason ? ` (${step.riskReason})` : '';
          try {
            chrome.runtime.sendMessage({
              action: 'addMessage',
              content: `🖐 This field looks sensitive${reason} — please type it yourself, then press Next.`,
              type: 'info'
            });
          } catch (e) {}
        }
      }
    } else {
      // click — save state with pendingResume=true BEFORE wiring the listener so there's no
      // race with fast navigation.
      await _gv2SetState(true);
      _gv2SetupClickListener();
      if (autoPerform) {
        console.log('[guidev2] Auto mode: auto-performing low-risk click step', step.step);
        g._autoClickTimer = setTimeout(() => {
          g._autoClickTimer = null;
          if (typeof gv2NextStep === 'function') gv2NextStep();
        }, 900);
      } else if (g.autoMode && isHighRisk) {
        // High-risk click in auto mode → hand control back for this one.
        gv2HideAutoOverlay();
        const reason = step.riskReason ? ` (${step.riskReason})` : '';
        try {
          chrome.runtime.sendMessage({
            action: 'addMessage',
            content: `🖐 This step looks sensitive${reason} — I'll let you do this one. Click the highlighted element when ready.`,
            type: 'info'
          });
        } catch (e) {}
      }
    }

    _gv2HideIndicator();

    // Rewind (Slice 1): capture this step (screenshot + DOM snapshot + reasoning).
    // Fire-and-forget so it never delays showing the step to the user.
    gv2CaptureStepRecord({
      step: step.step,
      planStep: step.step,
      confidence,
      instruction: step.instruction,
      action,
      typeText: (step.typeText != null ? step.typeText : step.value) || null,
      isLastStep: isLast,
      nextStepHint: step.nextStepHint,
      target: { text: step.element?.text || null, llmIndex: step.element?.index ?? null },
      rawLlmJson: content,
      tutorialMatch: (step.step === 1 && g.tutorialRef) ? {
        task: g.tutorialRef.task,
        website: g.tutorialRef.website,
        steps: g.tutorialRef.content.steps,
        reason: g.tutorialReason
      } : null
    });

    return {
      success: true,
      answer: step.instruction,
      step: step.step,
      isLastStep: isLast,
      nextStepHint: step.nextStepHint,
      targetText: step.element?.text || null,
      action,
      confidence,
      planStep: step.step,
      highlightCount,
      hasHighlights: highlightCount > 0,
      isGuide: true
    };

  } catch (e) {
    console.error('[guidev2] Parse error:', e);
    _gv2HideIndicator();
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
    const onHighlight = e.target.closest('[data-pageguide-styled]') ||
                        e.target.hasAttribute('data-pageguide-styled');
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
        // Rewind: refresh the just-clicked step's snapshot with the post-click view.
        await gv2RecaptureAfterAction(window._guidev2?.previousSteps?.length || 0);
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
    // Rewind: refresh the just-clicked step's snapshot with the post-click view.
    await gv2RecaptureAfterAction(window._guidev2?.previousSteps?.length || 0);
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
  // Slice 5: canonical ACT/type carries text in `value`; legacy type used `typeText`.
  const typeText = (step.typeText != null) ? step.typeText : step.value;
  if (!typeText) {
    console.warn('[guidev2] autoType: no text to type in step');
  } else {
    const highlighted = document.querySelector('[data-pageguide-styled]');
    const input = highlighted
      ? (highlighted.matches('input,textarea,[contenteditable]')
          ? highlighted
          : highlighted.querySelector('input,textarea,[contenteditable]'))
      : null;

    if (!input) {
      console.warn('[guidev2] autoType: no input element found in highlighted area');
    } else {
      console.log('[guidev2] Auto-typing:', typeText);
      input.focus();

      if (input.isContentEditable) {
        // Select all existing content and replace it in one execCommand call
        // so rich-text frameworks (Draft.js, ProseMirror, etc.) see proper events.
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, typeText);
        // execCommand already fires 'input'; fire 'change' for good measure.
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // Select all existing text first (visual feedback + clean slate).
        input.select();
        const proto = input.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(input, typeText);
        else input.value = typeText;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }

  // Rewind: re-capture this step now that the field is filled, overwriting the
  // pre-fill snapshot so the inspector shows the typed value. Reuse the stashed
  // reasoning fields so rawLlmJson/tutorialMatch are preserved.
  try {
    const reuse = (window._guidev2 && window._guidev2._lastCaptureData) || {
      step: step.step,
      instruction: step.instruction,
      action: step.action,
      typeText: (step.typeText != null ? step.typeText : step.value) || null,
      isLastStep: !!step.isLastStep,
      nextStepHint: step.nextStepHint,
      target: { text: step.element?.text || null, llmIndex: step.element?.index ?? null }
    };
    await gv2CaptureStepRecord(reuse);
  } catch (e) { /* non-fatal */ }

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
 * Called when the user clicks the "Next →" button in the side panel, or when
 * auto mode asks the content script to perform the current step.
 *
 * Manual panel Next means "I did this step, continue." It should not synthesize
 * a click or type into the page. Auto mode keeps the existing synthetic action
 * path so agent-performed steps still use the same synthetic action flow.
 */
window.gv2NextStep = async function (options = {}) {
  const fromPanel = options?.source === 'panel';
  const continueGuide = options?.generateAndDispatch || _gv2GenerateAndDispatch;
  const g = window._guidev2;
  const cur = g && g._currentStep;

  if (!_guidev2WaitingForClick) {
    if (g?.active && cur) {
      return continueGuide();
    }
    return { success: false, progressed: false, error: 'Guide is not waiting for a step' };
  }

  _gv2RemoveClickListeners();
  _guidev2WaitingForClick = false;

  if (_guidev2Resuming) return { success: false, progressed: false, error: 'Guide is already continuing' };

  if (fromPanel && g?.active) {
    return continueGuide();
  }

  // Synthetic/internal type continuation: low-risk known text can be typed by
  // the agent, while high-risk or missing text just continues after hand-back.
  if (cur && cur.action === 'type') {
    const text = (cur.typeText != null) ? cur.typeText : cur.value;
    if (text && !cur.highRisk) {
      return _gv2AutoType(cur); // types the field, then continues to the next step
    }
    return continueGuide();
  }

  try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}

  // Resolve the element to click.
  //
  // Priority order:
  //   1. Stored reference from gv2ProcessResponse (survives React reconciliation
  //      that removes injected highlight spans from the DOM).
  //   2. Fresh text-based lookup via gv2FindElementByText (handles the case where
  //      React replaced the element node itself since the last step was generated).
  //   3. Fallback: query for [data-pageguide-styled] (whole-element highlight path,
  //      where data-pageguide-styled is on the real element, not an injected span).
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
      const freshEl = window._pageguideIndex?.[freshIdx];
      toClick = _resolveClickTarget(freshEl);
      if (toClick) console.log('[guidev2] Using fresh text-match target:', toClick.tagName, toClick.textContent?.slice(0, 60));
    }
  }

  // 3. Highlight-span fallback
  if (!toClick) {
    const highlighted = document.querySelector('[data-pageguide-styled]');
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
  return continueGuide();
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
  if (window._guidev2 && window._guidev2._autoClickTimer) {
    clearTimeout(window._guidev2._autoClickTimer);
    window._guidev2._autoClickTimer = null;
  }
  _gv2RemoveClickListeners();
  _gv2HideIndicator();
  gv2HideAutoOverlay();
  _gv2ClearState();
};

// ===== CONTINUATION HELPER =====
// Generates the next step and dispatches it to the panel (used after auto-type / manual
// type continue / take-control resume).

async function _gv2GenerateAndDispatch() {
  if (_guidev2Resuming) return { success: false, progressed: false, error: 'Guide is already continuing' };
  _guidev2Resuming = true;
  try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}
  try {
    const result = await gv2GenerateNextStep();
    if (result && result.success !== false) {
      if (result.progressed === false) {
        try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
        return result;
      }
      try { chrome.runtime.sendMessage({ action: 'guideStep', result }); } catch (e) {}
      return { success: true, progressed: true };
    } else {
      try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
      return {
        success: false,
        progressed: false,
        error: result?.error || 'Could not generate the next step'
      };
    }
  } catch (e) {
    try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e2) {}
    return {
      success: false,
      progressed: false,
      error: e?.message || 'Could not continue the guide'
    };
  } finally {
    _guidev2Resuming = false;
  }
}

// ===== TAKE CONTROL (Slice 4) =====
// User reclaims control from autonomous mode without ending the guide. Cancels any
// pending auto-action, switches the session to Manual, and leaves the current
// highlighted step for the user to click themselves.
window.gv2TakeControl = async function () {
  const g = window._guidev2;
  gv2HideAutoOverlay();
  if (!g || !g.active) return;

  // Cancel a scheduled auto-click (the 900 ms window before it fires).
  if (g._autoClickTimer) { clearTimeout(g._autoClickTimer); g._autoClickTimer = null; }

  // Switch this session to Manual and persist so the panel toggle reflects it.
  g.autoMode = false;
  try { await chrome.storage.local.set({ [_GV2_AUTOMODE_PREF_KEY]: false }); } catch (e) {}

  try {
    chrome.runtime.sendMessage({
      action: 'addMessage',
      content: '🖐 You have control. Click the highlighted step yourself; I\'ll continue guiding.',
      type: 'info'
    });
  } catch (e) {}
};

// ===== ROUTER INTEGRATION =====
// guidev2.js is injected after guide.js, so this assignment overrides guide.js.

window.handleStepByStepGuide = function (question, continueFromStep = false) {
  // continueFromStep=true comes from guide.js's continueGuidance() which won't fire
  // when v2 is active (_pageguideGuidance.active = false). Handle defensively anyway.
  if (continueFromStep) return gv2GenerateNextStep();
  return _handleStepByStepGuideV2(question);
};

console.log('[guidev2] loaded — SW-based navigation, MutationObserver stability');
