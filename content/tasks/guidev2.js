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

// Feature flag: disabled for now in favour of the deterministic Subgoal Progress score
// computed offline in the eval tool. When false, we skip the once-per-session
// predicted-final-goal-state LLM call and the per-step goal-relevance embedding.
const GV2_GOAL_RELEVANCE_ENABLED = false;

// ===== PROMPT (inline to keep guidev2.js self-contained) =====

const GUIDE_V2_PROMPT = `You are a helpful guide assistant providing step-by-step interactive guidance.

Given the current page and the user's goal, provide ONE step at a time.

Return JSON only:
{
  "thought": "Your internal chain-of-thought reasoning about the page state and chosen action",
  "instruction": "Concise, action-oriented instruction shown to the user (max 1-2 sentences)",
  "element": {"index": N, "text": "element text to highlight"},
  "action": "click" | "type" | "clear_text" | "done",
  "typeText": "text to type (only when action=type; null/empty when action=clear_text)",
  "isLastStep": false,
  "risk": "low" | "high",
  "riskReason": "short reason for the risk level",
  "confirmation": "needed" | "no need"
}

"thought": write your step-by-step reasoning or thought process here first before deciding on the instruction. Analyze what the user wants, what is visible in the PAGE INDEX, and what action is required.
"instruction": must be a very concise, direct action-oriented instruction for the user (1-2 sentences maximum, e.g. "Click on 'Languages' to open settings"). Do NOT put any chain-of-thought, meta-commentary, reasoning, or explanation here.
"risk": "low" if this action is reversible, routine and easy (e.g. opening a menu, toggling a setting that can be undone, navigating, typing a search query) — safe for the agent to perform automatically. "high" if it is sensitive or hard to undo: signing in, payments/purchases, deleting or removing data, sending/posting/publishing, or entering a password or other sensitive text. High-risk steps are left for the user to perform.
"confirmation": "needed" if you need the user's explicit confirmation or review before proceeding with this step, or "no need" otherwise.

RULES:
1. ONE step at a time — never list multiple things to do
2. "thought": write your internal chain-of-thought/reasoning here first (analyzing the page state, completed steps, user goals, and candidate actions).
3. "instruction": must be a very concise, direct action-oriented instruction (1-2 sentences maximum, e.g. "Click on 'Languages' to open the language settings"). Do NOT put any chain-of-thought, reasoning, meta-commentary, or explanation here. Keep it short and readable for the user.
4. action="click": click the highlighted element (the agent does this for low-risk steps;
   the user does it for high-risk ones)
5. action="type": provide typeText; the agent auto-fills low-risk fields, and lets the user
   type high-risk ones (e.g. passwords)
6. action="clear_text": clear the highlighted form field's current value; leave typeText
   empty/null. Use it before typing a replacement value or when the task asks to reset a field.
   Sensitive fields (passwords, payment, private data) are high risk and should be handed to the user.
7. action="done": set isLastStep=true; no element interaction needed
8. Highlight the element to interact with using its index from PAGE INDEX
9. If the target is not visible, guide the user to open the relevant menu first

COMMON PATTERNS:
- Hidden options: Step 1 → click three-dot menu → Step 2 → click the option
- Forms:          Step 1 → type in field (action=type) → Step 2 → click submit
- Replace text:   Step 1 → clear the field (action=clear_text) → Step 2 → type replacement
- Settings:       Step 1 → click profile/settings icon → Step 2 → click specific option

NATIVE BROWSER DIALOGS (print, save, open file, etc.):
When a step will open a native browser dialog (print dialog, save dialog, OS file picker), that
step MUST be the last step (isLastStep=true, action="done"). Explain what the user will see in
the dialog and what they should do, but do NOT attempt to guide actions inside the dialog — the
extension cannot access native browser UI. Example last-step instruction:
"Click 'Print' in the File menu. Your browser's print dialog will open — choose your printer and
settings there, then click the Print or Save button to finish."`;
if (typeof window !== 'undefined') window.GUIDE_V2_PROMPT = GUIDE_V2_PROMPT;

const GUIDE_V2_PLANNING_PROMPT = `You are a helpful guide planner for PageGuide.

Given the current page and the user's goal, produce a concise user-visible plan for completing the goal.

Return JSON only:
{
  "planTitle": "short title",
  "steps": [
    {"n": 1, "goal": "Open destination field"},
    {"n": 2, "goal": "Enter destination"},
    {"n": 3, "goal": "Submit search"}
  ]
}

Rules:
1. Produce only a high-level plan, not an action to execute now.
2. Each goal must be short, user-visible, and easy to understand.
3. Do not include private reasoning, chain-of-thought, or page-index implementation details.
4. Use no more than 15 steps.
5. If the task is already complete, return one step with goal "Confirm completion".`;
if (typeof window !== 'undefined') window.GUIDE_V2_PLANNING_PROMPT = GUIDE_V2_PLANNING_PROMPT;

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
// A light-yellow lock over the page signals that the agent is acting autonomously.
// It blocks user interaction with the page while leaving the take-over button clickable.

const _GV2_AUTO_OVERLAY_ID = 'pageguide-gv2-auto';
let _gv2AutoOverlayCss = false;

function gv2ShowAutoOverlay() {
  if (!_gv2AutoOverlayCss) {
    _gv2AutoOverlayCss = true;
    const style = document.createElement('style');
    style.id = 'pageguide-gv2-auto-css';
    style.textContent = `
#${_GV2_AUTO_OVERLAY_ID}{position:fixed;inset:0;z-index:2147483646;pointer-events:none;background:rgba(255,248,220,.36);box-shadow:inset 0 0 0 3px rgba(245,158,11,.38);opacity:0;transition:opacity .2s ease;cursor:not-allowed;touch-action:none;overscroll-behavior:contain}
#${_GV2_AUTO_OVERLAY_ID}.on{opacity:1}
#${_GV2_AUTO_OVERLAY_ID}.on{pointer-events:all}
#${_GV2_AUTO_OVERLAY_ID} .gv2-take{position:absolute;top:10px;left:50%;transform:translateX(-50%);pointer-events:auto;display:flex;align-items:center;gap:10px;background:rgba(255,251,235,.97);color:#221a06;border:1px solid rgba(245,158,11,.62);border-radius:999px;padding:12px 22px;font:800 15px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;box-shadow:0 10px 34px rgba(180,83,9,.24);opacity:1;transition:transform .15s ease,box-shadow .15s ease,background .15s ease}
#${_GV2_AUTO_OVERLAY_ID} .gv2-take:hover{transform:translateX(-50%) translateY(-1px);background:#fff7d6;box-shadow:0 14px 40px rgba(180,83,9,.3)}
#${_GV2_AUTO_OVERLAY_ID} .gv2-take .gv2-pause{font-size:18px;line-height:1;color:#b45309}
@keyframes gv2autopulse{0%,100%{opacity:1}50%{opacity:.25}}`;
    document.head.appendChild(style);
  }
  let el = document.getElementById(_GV2_AUTO_OVERLAY_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = _GV2_AUTO_OVERLAY_ID;
    el.tabIndex = -1;
    ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mouseover', 'mousemove', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'dragstart'].forEach(evt => {
      el.addEventListener(evt, (e) => {
        if (e.target && e.target.closest && e.target.closest('.gv2-take')) return;
        e.preventDefault();
        e.stopPropagation();
      }, { capture: true, passive: false });
    });
    const btn = document.createElement('button');
    btn.className = 'gv2-take';
    btn.innerHTML = '<span class="gv2-pause" aria-hidden="true">Ⅱ</span><span>Pause task</span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof gv2TakeControl === 'function') gv2TakeControl();
    });
    el.appendChild(btn);
    document.body.appendChild(el);
  }
  try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
  el.style.pointerEvents = '';
  el.getBoundingClientRect(); // force reflow so the fade plays
  el.classList.add('on');
  try { el.focus({ preventScroll: true }); } catch (e) {}
}

function gv2HideAutoOverlay() {
  const el = document.getElementById(_GV2_AUTO_OVERLAY_ID);
  if (el) {
    el.classList.remove('on');
    el.style.pointerEvents = 'none';
    setTimeout(() => {
      if (!el.classList.contains('on')) el.remove();
    }, 220);
  }
}

// ===== RESTORE OVERLAY =====
// A teal tint (distinct from auto-mode's yellow) signals the agent is rebuilding the page's
// recorded state during a restore. Two phases:
//   'restoring' — blocking tint + spinner while actions are applied;
//   'review'    — click-through tint + banner asking the user to confirm in the side panel.

const _GV2_RESTORE_OVERLAY_ID = 'pageguide-gv2-restore';
let _gv2RestoreOverlayCss = false;

function gv2ShowRestoreOverlay(phase = 'restoring', text = '') {
  if (!_gv2RestoreOverlayCss) {
    _gv2RestoreOverlayCss = true;
    const style = document.createElement('style');
    style.id = 'pageguide-gv2-restore-css';
    style.textContent = `
#${_GV2_RESTORE_OVERLAY_ID}{position:fixed;inset:0;z-index:2147483646;background:rgba(45,212,191,.12);box-shadow:inset 0 0 0 3px rgba(20,184,166,.5);opacity:0;transition:opacity .2s ease}
#${_GV2_RESTORE_OVERLAY_ID}.on{opacity:1}
#${_GV2_RESTORE_OVERLAY_ID}.gv2-restoring{pointer-events:all;cursor:progress}
#${_GV2_RESTORE_OVERLAY_ID}.gv2-review{pointer-events:none}
#${_GV2_RESTORE_OVERLAY_ID} .gv2-rbanner{position:absolute;top:64px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;background:rgba(15,23,30,.92);color:#5eead4;border:1px solid rgba(94,234,212,.5);border-radius:999px;padding:10px 18px;font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 4px 22px rgba(0,0,0,.45);max-width:80vw}
#${_GV2_RESTORE_OVERLAY_ID} .gv2-rspin{width:14px;height:14px;border:2px solid rgba(94,234,212,.35);border-top-color:#5eead4;border-radius:50%;animation:gv2spin .75s linear infinite;flex-shrink:0}
#${_GV2_RESTORE_OVERLAY_ID} .gv2-rdot{width:8px;height:8px;border-radius:50%;background:#5eead4;animation:gv2autopulse 1.2s ease-in-out infinite;flex-shrink:0}`;
    document.head.appendChild(style);
  }
  let el = document.getElementById(_GV2_RESTORE_OVERLAY_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = _GV2_RESTORE_OVERLAY_ID;
    el.innerHTML = '<div class="gv2-rbanner"><span class="gv2-rmark"></span><span class="gv2-rlabel"></span></div>';
    document.body.appendChild(el);
  }
  const restoring = phase !== 'review';
  el.classList.toggle('gv2-restoring', restoring);
  el.classList.toggle('gv2-review', !restoring);
  const mark = el.querySelector('.gv2-rmark');
  if (mark) mark.className = restoring ? 'gv2-rmark gv2-rspin' : 'gv2-rmark gv2-rdot';
  const label = el.querySelector('.gv2-rlabel');
  if (label) label.textContent = text || (restoring ? 'Restoring state…' : 'State restored — confirm in the panel');
  el.getBoundingClientRect(); // force reflow so the fade plays
  el.classList.add('on');
}

function gv2HideRestoreOverlay() {
  const el = document.getElementById(_GV2_RESTORE_OVERLAY_ID);
  if (el) el.remove();
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
// When the resume lock was last taken by an auto-loop continuation. Used only to release a leaked
// lock (see _gv2ResumeLockStuck) so a stuck flag can't permanently wedge the loop.
let _guidev2ResumingSince = 0;
const _GV2_RESUMING_MAX_MS = 120000; // 2 min — longer than any real continuation
function _gv2ResumeLockStuck() {
  return _guidev2Resuming && _guidev2ResumingSince > 0 && (Date.now() - _guidev2ResumingSince) > _GV2_RESUMING_MAX_MS;
}

// Flag set when a click step is awaiting user action
let _guidev2WaitingForClick = false;

// Flag set when the user explicitly stops the guide
let _guidev2Stopped = false;

// Hard safety cap for concrete Guide v2 steps. If we need step 16, we stop
// instead of asking the model to continue drifting.
const GV2_MAX_STEPS = 15;

function _gv2IsStopped() {
  const g = window._guidev2;
  return _guidev2Stopped || !g || g.active === false;
}

function _gv2IsPaused() {
  return !!(window._guidev2 && window._guidev2.paused);
}

function _gv2HidePanelTyping() {
  try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
}

function _gv2ClearActionTimers() {
  const g = window._guidev2;
  if (!g) return;
  if (g._autoClickTimer) {
    clearTimeout(g._autoClickTimer);
    g._autoClickTimer = null;
  }
  if (g._autoTypeTimer) {
    clearTimeout(g._autoTypeTimer);
    g._autoTypeTimer = null;
  }
}

function _gv2StopInternal() {
  const restoreCtx = window._guidev2 && window._guidev2._restoreContext;
  _guidev2Stopped = true;
  _guidev2Resuming = false;
  _guidev2WaitingForClick = false;
  if (window._guidev2) window._guidev2._awaitingRestoreConfirm = false;
  _gv2ClearActionTimers();
  _gv2RemoveClickListeners();
  _gv2HideIndicator();
  gv2HideAutoOverlay();
  gv2HideRestoreOverlay();
  _gv2ClearState();
  try {
    if (restoreCtx && restoreCtx.sessionId && typeof rewindUpdateSessionMeta === 'function') {
      rewindUpdateSessionMeta(restoreCtx.sessionId, { branchStatus: 'stopped' });
    }
  } catch (e) {}
  // Persist a tombstone so a navigation already in flight can't resume the agent, and drop any
  // one-shot steer handoff so it doesn't fire on the next load.
  _gv2MarkStopped();
  try { if (typeof rewindClearSteerPending === 'function') rewindClearSteerPending(); } catch (e) {}
}

function _gv2MaxStepMessage(g = window._guidev2) {
  return g?.autoMode
    ? `Stopped after ${GV2_MAX_STEPS} steps to avoid an autonomous loop or drifting from the plan.`
    : `Stopped after ${GV2_MAX_STEPS} steps to avoid looping or drifting from the plan.`;
}

function _gv2StopForMaxSteps(g = window._guidev2) {
  const message = _gv2MaxStepMessage(g);
  _gv2StopInternal();
  _gv2HidePanelTyping();
  try {
    chrome.runtime.sendMessage({
      action: 'addMessage',
      content: message,
      type: 'system'
    });
  } catch (e) {}
  return { success: false, progressed: false, error: message, stoppedByMaxSteps: true };
}

function _gv2CheckStepCap(g = window._guidev2) {
  const completedSteps = Array.isArray(g?.previousSteps) ? g.previousSteps.length : 0;
  if (completedSteps + 1 > GV2_MAX_STEPS) return _gv2StopForMaxSteps(g);
  return null;
}

function _gv2NormalizeForceUrl(url) {
  try {
    const u = new URL(String(url || ''), window.location.href);
    u.hash = u.hash || '';
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
    u.hostname = u.hostname.toLowerCase();
    u.pathname = decodeURIComponent(u.pathname).replace(/\/+$/, '') || '/';
    return u.toString().replace(/\/(?=[?#]?$)/, '');
  } catch (e) {
    return String(url || '').trim().replace(/\/+$/, '');
  }
}

function _gv2ForceUrlsMatch(actual, expected) {
  return _gv2NormalizeForceUrl(actual) === _gv2NormalizeForceUrl(expected);
}

async function _gv2LoadForceGroundTruthConfig() {
  try {
    const r = await chrome.storage.local.get([
      'guideForceGroundTruthMode',
      'guideForceGroundTruthRetries',
      'guideForceGroundTruthPlan'
    ]);
    const plan = Array.isArray(r.guideForceGroundTruthPlan)
      ? r.guideForceGroundTruthPlan.filter(item => item && item.subgoal && item.expectedUrl)
      : [];
    if (!r.guideForceGroundTruthMode || !plan.length) return null;
    const retries = Math.max(0, Math.min(2, Number(r.guideForceGroundTruthRetries) || 0));
    return { enabled: true, retries, plan, cursor: 0, attempts: {}, pendingVerification: null };
  } catch (e) {
    return null;
  }
}

function _gv2ForceStateFromSaved(saved) {
  const fg = saved?.forceGroundTruth;
  if (!fg?.enabled || !Array.isArray(fg.plan) || !fg.plan.length) return null;
  return {
    enabled: true,
    retries: Math.max(0, Math.min(2, Number(fg.retries) || 0)),
    plan: fg.plan,
    cursor: Math.max(0, Number(fg.cursor) || 0),
    attempts: fg.attempts && typeof fg.attempts === 'object' ? fg.attempts : {},
    pendingVerification: fg.pendingVerification || null
  };
}

function _gv2ForceTarget(g = window._guidev2) {
  const fg = g?.forceGroundTruth;
  if (!fg?.enabled || !Array.isArray(fg.plan)) return null;
  return fg.plan[fg.cursor] || null;
}

function _gv2ForceAttemptHistory(fg, step) {
  const key = String(step);
  const attempts = Array.isArray(fg?.attempts?.[key]) ? fg.attempts[key] : [];
  if (!attempts.length) return 'None';
  return attempts.map((a, i) => {
    return `${i + 1}. action=${a.action || 'unknown'}, index=${a.index ?? 'none'}, expected=${a.expectedUrl || ''}, actual=${a.actualUrl || ''}`;
  }).join('\n');
}

async function _gv2ForceMarkFailure(message, pending, attempts) {
  try {
    await chrome.storage.local.set({
      guideForceGroundTruthFailure: {
        message,
        expectedUrl: pending?.expectedUrl || '',
        actualUrl: window.location.href,
        oracleStep: pending?.step || null,
        attempts: attempts || [],
        timestamp: Date.now()
      }
    });
  } catch (e) {}
  _gv2StopInternal();
  _gv2HidePanelTyping();
  try { chrome.runtime.sendMessage({ action: 'addMessage', content: message, type: 'error' }); } catch (e) {}
  return { success: false, progressed: false, error: message, forceGroundTruthFailed: true };
}

async function _gv2ForceVerifyPending() {
  const g = window._guidev2;
  const fg = g?.forceGroundTruth;
  const pending = fg?.pendingVerification;
  if (!fg?.enabled || !pending) return { ok: true };
  const actualUrl = window.location.href;
  const passed = _gv2ForceUrlsMatch(actualUrl, pending.expectedUrl);
  const stepNumber = pending.generatedStep || _gv2CompletedStepNumber();
  const attempt = {
    attempt: pending.attempt,
    action: pending.action,
    index: pending.index,
    expectedUrl: pending.expectedUrl,
    actualUrl,
    passed,
    timestamp: Date.now()
  };
  const key = String(pending.step);
  fg.attempts[key] = Array.isArray(fg.attempts[key]) ? fg.attempts[key] : [];
  fg.attempts[key].push(attempt);
  try {
    if (typeof rewindPatchRecord === 'function' && g.sessionId && stepNumber) {
      await rewindPatchRecord(g.sessionId, stepNumber, {
        forceGroundTruth: true,
        oracleStep: pending.step,
        oracleSubgoal: pending.subgoal,
        expectedUrl: pending.expectedUrl,
        actualUrl,
        verificationPassed: passed,
        attempt: pending.attempt,
        attemptHistory: fg.attempts[key]
      });
    }
  } catch (e) {}
  fg.pendingVerification = null;
  if (passed) {
    fg.cursor = (Number(fg.cursor) || 0) + 1;
    await _gv2SetState(false);
    return { ok: true };
  }
  if ((Number(pending.attempt) || 1) <= (Number(fg.retries) || 0)) {
    await _gv2SetState(false);
    return { ok: true, retrying: true };
  }
  const message = `ForceGroundTruth verifier failed for oracle step ${pending.step}: expected ${pending.expectedUrl}, got ${actualUrl}`;
  return { ok: false, result: await _gv2ForceMarkFailure(message, pending, fg.attempts[key]) };
}

function _gv2BuildForceGroundTruthPrompt(target, pageIndex, stepNumber, attemptNumber, attemptHistory) {
  return `You are PageGuide ForceGroundTruth mode.

You are NOT choosing the next task step. The next task step is fixed by the annotated dataset.
Your job is only to map that fixed oracle step to the best live DOM action.

Return JSON only:
{
  "thought": "brief reasoning summary",
  "instruction": "short action instruction for this oracle step",
  "element": {"index": N, "text": "visible element text"},
  "action": "click" | "type" | "clear_text" | "done",
  "typeText": "text to type when action=type, otherwise null",
  "isLastStep": false,
  "risk": "low" | "high",
  "riskReason": "short reason",
  "confirmation": "no need"
}

CURRENT URL:
${window.location.href}

EXPECTED URL AFTER THIS ACTION:
${target.expectedUrl}

ORACLE STEP:
Step ${target.step}: ${target.subgoal}

PAGE INDEX:
${pageIndex.indexText}

PREVIOUS FAILED ATTEMPTS FOR THIS SAME ORACLE STEP:
${attemptHistory}

Rules:
1. Do not create a new plan.
2. Do not skip to a later oracle step.
3. Choose an action that should make the browser reach EXPECTED URL AFTER THIS ACTION.
4. This is attempt ${attemptNumber} for this oracle step. If this is not the first attempt, choose a different DOM index/action from the failed attempts.
5. Return corrected JSON for PageGuide step ${stepNumber}.`;
}

async function gv2GenerateForceGroundTruthStep(pageIndex, stepNumber) {
  const g = window._guidev2;
  const fg = g?.forceGroundTruth;
  if (!fg?.enabled) return null;
  const verify = await _gv2ForceVerifyPending();
  if (!verify.ok) return verify.result;
  const target = _gv2ForceTarget(g);
  if (!target) {
    return gv2ProcessResponse(JSON.stringify({
      thought: 'All annotated oracle URL targets have been verified.',
      instruction: 'Done.',
      element: { index: null, text: '' },
      action: 'done',
      typeText: null,
      isLastStep: true,
      risk: 'low',
      riskReason: 'No further action is needed.',
      confirmation: 'no need'
    }), GUIDE_V2_PROMPT, 'ForceGroundTruth completed all oracle URL targets.');
  }
  const priorAttempts = Array.isArray(fg.attempts?.[String(target.step)]) ? fg.attempts[String(target.step)] : [];
  const attemptNumber = priorAttempts.length + 1;
  const systemPrompt = GUIDE_V2_PROMPT;
  const userPrompt = _gv2BuildForceGroundTruthPrompt(
    target,
    pageIndex,
    stepNumber,
    attemptNumber,
    _gv2ForceAttemptHistory(fg, target.step)
  );
  const response = await safeSendMessage({
    action: 'callLLM',
    systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    imageBase64: g._pendingPromptImage || null,
    metadata: {
      mode: 'force_ground_truth',
      step: stepNumber,
      oracleStep: target.step,
      attempt: attemptNumber,
      expectedUrl: target.expectedUrl,
      url: window.location.href
    }
  });
  if (response?.error) return { success: false, error: response.error };
  if (!response?.content) return { success: false, error: 'No response from AI' };
  g._forceGroundTruthPromptTarget = { ...target, attempt: attemptNumber, attemptHistory: priorAttempts };
  return gv2ProcessResponse(response.content, systemPrompt, userPrompt);
}

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
        planningMode: s.planningMode || 'planning',
        plan: Array.isArray(s.plan) ? s.plan : [],
        planTitle: s.planTitle || '',
        autoMode: s.autoMode,
        paused: !!s.paused,
        lowConfidenceCount: s.lowConfidenceCount || 0,
        predictedGoalState: s.predictedGoalState || null,
        forceGroundTruth: s.forceGroundTruth || null,
        mechKeys: Array.isArray(s._mechKeys) ? s._mechKeys : [],
        lastActionStepNumber: s._lastActionStepNumber || null,
        activeStepNumber: s._activeStepNumber || null,
        predictedGoalState: s.predictedGoalState || null,
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

// ===== STOP TOMBSTONE =====
// `_guidev2Stopped` is in-memory and does NOT survive a navigation, so after the user clicks
// Stop a pending page-load (from the agent's own click) could otherwise resume the agent on the
// next page. This persisted marker is checked by the resume paths and is cleared only when the
// user intentionally starts a new guide or steers.
const _GV2_STOP_KEY = 'pageguideGuidanceV2Stopped';
async function _gv2MarkStopped() {
  try { await chrome.storage.session.set({ [_GV2_STOP_KEY]: Date.now() }); } catch (e) {}
}
async function _gv2IsStopMarked() {
  try { const r = await chrome.storage.session.get(_GV2_STOP_KEY); return !!r[_GV2_STOP_KEY]; } catch (e) { return false; }
}
async function _gv2ClearStopMark() {
  try { await chrome.storage.session.remove(_GV2_STOP_KEY); } catch (e) {}
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

// Set once a Rewind restore handoff has been consumed on this page load, so the
// normal navigation-resume paths don't also fire and fight the forked session.
let _gv2SteerHandled = false;

async function _gv2HandleSwMessage(msg) {
  if (msg.type !== 'swState') return;
  if (_gv2SteerHandled) return; // a steer fork owns this page

  if (msg.state?.active && msg.state?.pendingResume && !msg.state?.paused) {
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
  if (saved?.active && saved?.pendingResume && !saved?.paused) {
    await _gv2ResumeFromState(saved);
  }
}

// Bootstrap on each page load: a pending restore handoff takes precedence over
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
  // Honor a Stop that happened before this navigation finished — don't auto-wake the agent.
  if (await _gv2IsStopMarked()) {
    console.log('[guidev2] resume suppressed — user stopped the guide');
    try { chrome.runtime.sendMessage({ action: 'guidanceV2_clearState' }); } catch (e) {}
    try { await gv2ClearFallback(); } catch (e) {}
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
    planningMode: state.planningMode === 'direct' ? 'direct' : 'planning',
    plan: Array.isArray(state.plan) ? state.plan : [],
    planTitle: state.planTitle || '',
    autoMode: state.autoMode === true,
    paused: false,
    lowConfidenceCount: state.lowConfidenceCount || 0,
    forceGroundTruth: _gv2ForceStateFromSaved(state),
    _mechKeys: Array.isArray(state.mechKeys) ? state.mechKeys : [],
    _lastActionStepNumber: state.lastActionStepNumber || state.activeStepNumber || (state.previousSteps || []).length || null,
    _activeStepNumber: state.activeStepNumber || null
  };

  console.log('[guidev2] Resuming on new page — next step will be',
    window._guidev2.previousSteps.length + 1);

  try {
    try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}

    const capResult = _gv2CheckStepCap(window._guidev2);
    if (capResult) return capResult;

    // Wait for the new page's DOM to stop mutating before indexing.
    // Add a small initial delay so the new page has time to start rendering,
    // then require 700 ms of DOM silence (up from the default 300 ms).
    await new Promise(r => setTimeout(r, 500));
    await gv2WaitForDomStable(8000, 700);

    // Rewind: the click that triggered this full-page nav is the last recorded step;
    // refresh its snapshot with the post-navigation page before generating the next step.
    if (_gv2IsStopped()) return null;
    await gv2RecaptureAfterAction(_gv2CompletedStepNumber());
    if (_gv2IsStopped()) return null;

    const result = await gv2GenerateNextStep();

    if (!_guidev2Stopped && result && result.success !== false) {
      try { chrome.runtime.sendMessage({ action: 'guideStep', result }); } catch (e) {}
    } else {
      try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
      const errText = String(result?.error || '');
      const pausedErr = /Guide paused/i.test(errText);
      if (pausedErr) {
        if (window._guidev2) {
          window._guidev2.active = true;
          window._guidev2.paused = true;
          await _gv2SetState(false);
        }
        try {
          chrome.runtime.sendMessage({
            action: 'guidePaused',
            reason: 'Guide paused. Resume when you are ready.'
          });
        } catch (e) {}
      } else if (result?.error) {
        try {
          chrome.runtime.sendMessage({
            action: 'addMessage',
            content: `❌ Could not generate next step: ${result.error}`,
            type: 'error'
          });
        } catch (e) {}
      }
      if (pausedErr) {
        // Pausing can race an in-flight resume/generate path. Preserve the guide so Resume works.
      } else if (!/Could not parse step JSON/i.test(errText)) {
        window._guidev2.active = false;
        _gv2ClearState();
      } else {
        await _gv2SetState(false);
      }
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
 * Resume a restored session: rebuild the earlier steps' transient state and
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
  if (_guidev2Resuming) {
    console.warn('[guidev2] steer ignored — already resuming');
    _gv2HidePanelTyping();
    return { success: false, progressed: false, error: 'Guide is already rewinding' };
  }
  _guidev2Resuming = true;
  await _gv2ClearStopMark(); // an explicit user steer overrides any prior Stop tombstone

  // `fromStep` is the ANCHOR step we branch after; the step being REDONE is fromStep+1. Allow 0
  // (redo step 1 from the Initial-state node) — `|| 1` would wrongly turn 0 into 1.
  const fromStep = (payload && Number.isFinite(payload.fromStep)) ? payload.fromStep : 1;
  const redoStep = fromStep + 1;
  // Immediate, unmissable feedback so it's clear the content script received the steer —
  // this fires BEFORE any record reads or LLM calls, so a later failure can't hide it.
  try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}
  try {
    chrome.runtime.sendMessage({
      action: 'addMessage',
      content: inPlace
        ? `♻️ Rewinding to before step ${redoStep} on this page and redoing it…`
        : `♻️ Restoring the state before step ${redoStep} and redoing it…`,
      type: 'info'
    });
  } catch (e) {}

  try {
    // One-shot: clear the handoff so a manual reload can't replay it again.
    if (typeof rewindClearSteerPending === 'function') await rewindClearSteerPending();

    // Keep steps 1…fromStep (inclusive); the agent re-runs from fromStep+1.
    const kept = [];
    const originalTrajectory = [];
    let goal = '';

    if (typeof rewindGetIndex === 'function') {
      const idx = await rewindGetIndex(payload.sessionId);
      if (idx && idx.goal) goal = idx.goal;
      if (idx && Array.isArray(idx.plan)) {
        payload._planningPlan = idx.plan;
        payload._planningTitle = idx.planTitle || '';
        payload._planningMode = idx.planningMode || 'planning';
      }

      if (idx && idx.steps) {
        const sortedSteps = idx.steps.slice().sort((a, b) => Number(a.step) - Number(b.step));
        for (const meta of sortedSteps) {
          if (meta.step === 0) continue;
          const r = typeof rewindGetRecord === 'function' ? await rewindGetRecord(payload.sessionId, meta.step) : null;
          if (r) {
            originalTrajectory.push(`Step ${r.step}: ${r.instruction || ''}`);
            if (r.step <= fromStep) kept.push(r);
          }
        }
      } else {
        // Fallback if idx.steps is missing
        for (let s = 1; s <= fromStep; s++) {
          const r = await rewindGetRecord(payload.sessionId, s);
          if (r) kept.push(r);
        }
      }
    }

    // Always use the pure original goal as the core question
    const question = String(goal || '').trim();

    const captureEnabled = await _gv2IsCaptureEnabled();
    const autoMode = await _gv2IsAutoMode();
    // Tutorial lookup is best-effort — never let it block or break the steer.
    let match = null;
    try { match = await _gv2FindTutorial(question, window.location.href); } catch (e) { console.warn('[guidev2] steer tutorial lookup failed:', e); }

    _guidev2Stopped = false;
    window._guidev2 = {
      active: true,
      question,
      _steerRedirection: payload.newGoal || null,
      _steerRedoStep: redoStep,
      _originalTrajectory: originalTrajectory,
      previousSteps: kept.map(r => `Step ${r.step}: ${r.instruction || ''}`),
      tutorialRef: match?.tutorial || null,
      tutorialReason: match?.reason || null,
      sessionId: payload.sessionId,
      captureEnabled,
      autoMode,
      paused: false,
      lowConfidenceCount: 0,
      planningMode: payload._planningMode === 'direct' ? 'direct' : (Array.isArray(payload._planningPlan) && payload._planningPlan.length ? 'planning' : 'direct'),
      plan: Array.isArray(payload._planningPlan) ? payload._planningPlan : [],
      planTitle: payload._planningTitle || '',
      // Seed the loop-detection key list from the kept steps so L_t keeps counting
      // correctly after a rewind/steer. One entry per prior action (the loop denominator
      // counts ALL previous actions), using the same action+text key.
      _mechKeys: kept
        .map(r => (typeof gv2ElementKey === 'function'
          ? gv2ElementKey({ action: r.action, element: { text: r.target?.text }, instruction: r.instruction })
          : '')),
      currentPlanStep: fromStep + 1,
      _lastActionStepNumber: fromStep || null,
      _activeStepNumber: fromStep + 1,
      _restoreLog: []
    };
    const log = window._guidev2._restoreLog;
    console.log('[guidev2] steer session built; continuing from step', fromStep + 1);

    const capResult = _gv2CheckStepCap(window._guidev2);
    if (capResult) {
      _gv2HidePanelTyping();
      try { gv2HideRestoreOverlay(); } catch (e) {}
      return capResult;
    }

    // Colored on-page overlay so the user can see the agent is rebuilding the recorded state.
    try { gv2ShowRestoreOverlay('restoring'); } catch (e) {}

    // The restore anchor is the kept record we branch after; when redoing step 1 (fromStep 0)
    // `kept` is empty, so read record(0) — the Initial-state node. Best-effort.
    let branchRec = kept.length ? kept[kept.length - 1] : null;
    if (!branchRec && typeof rewindGetRecord === 'function') {
      try { branchRec = await rewindGetRecord(payload.sessionId, fromStep); } catch (e) {}
    }

    try {
      await _gv2PerformRestore(kept, branchRec, payload, fromStep, inPlace, log);
    } catch (restoreErr) {
      console.warn('[guidev2] steer restore attempt failed:', restoreErr);
      log.push({ kind: 'note', value: 'Restore needs review: ' + (restoreErr?.message || 'PageGuide could not finish applying the saved state.'), ok: false });
    }
    if (!log.length) {
      log.push({ kind: 'note', value: 'Checked the saved page state', ok: true });
    }
    if (_gv2IsStopped()) {
      _gv2HidePanelTyping();
      try { gv2HideRestoreOverlay(); } catch (e) {}
      return { success: false, progressed: false, error: 'Guide stopped' };
    }

    // Persist the restore action log onto the branch record so the inspector can show it.
    try {
      if (typeof rewindPatchRecord === 'function') {
        await rewindPatchRecord(payload.sessionId, fromStep, { restoreLog: log.slice(), restoredAt: Date.now() });
      }
    } catch (e) {}

    // Stash the full restore context so panel confirmation can continue from the same anchor.
    const ctx = {
      sessionId: payload.sessionId,
      fromStep, redoStep,
      url: payload.url || window.location.href,
      inPlace,
      newGoal: payload.newGoal || '',
      parentSessionId: payload.parentSessionId || null,
      branchLabel: payload.branchLabel || '',
      recorded: _gv2RecordedActions(kept),
      // The recorded "before the redo step" screenshot == the anchor's post-action shot (carry-
      // forward design), so the panel can show the exact target state we're restoring to.
      redoBeforeShot: branchRec ? (branchRec.screenshotAfter || branchRec.screenshotBefore || branchRec.screenshot || null) : null,
      kept, branchRec, payload
    };
    window._guidev2._restoreContext = ctx;
    window._guidev2._restoreRetried = false;

    // PAUSE: do NOT act yet. Switch the overlay to review mode and ask the user to confirm the
    // restored state in the side panel before the agent continues with the new instruction.
    window._guidev2._awaitingRestoreConfirm = true;
    try { gv2ShowRestoreOverlay('review'); } catch (e) {}
    try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
    ctx._lastLog = log;
    await _gv2SendRestoreReady(ctx, log, { canRetry: true });
    return { success: true, progressed: true, awaitingRestoreConfirm: true };
  } catch (e) {
    console.error('[guidev2] steer resume error:', e);
    try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e2) {}
    try { gv2HideRestoreOverlay(); } catch (e2) {}
    return { success: false, progressed: false, error: e?.message || 'Could not rewind this step' };
  } finally {
    _guidev2Resuming = false;
  }
}

/**
 * Generate the branch step and dispatch it to the panel. Shared by the post-confirm flow.
 * Mirrors the tail that used to run inline at the end of _gv2ResumeFromSteer.
 */
async function _gv2GenerateAndDispatchSteer() {
  try {
    const result = await gv2GenerateNextStep();
    if (!_guidev2Stopped && result && result.success !== false) {
      try { chrome.runtime.sendMessage({ action: 'guideStep', result }); } catch (e) {}
    } else {
      try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
    }
  } catch (e) {
    console.error('[guidev2] steer generate error:', e);
    try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e2) {}
  }
}

/**
 * User confirmed (in the side panel) that the restored state looks right. Drop the overlay and
 * let the agent continue from the branch step with the new instruction. Invoked from the
 * content-script message router on `confirmSteerRestore`.
 */
async function gv2ConfirmSteerRestore(reason, mode, isFixed) {
  const g = window._guidev2;
  if (!g || !g._awaitingRestoreConfirm) {
    console.warn('[guidev2] confirmSteerRestore: nothing awaiting confirmation');
    return;
  }
  g._awaitingRestoreConfirm = false;

  g._steerReason = reason || null;
  g._steerMode = mode || 'wrong';
  g._steerFixed = !!isFixed;

  try {
    const sid = g._restoreContext && g._restoreContext.sessionId;
    if (sid && typeof rewindUpdateSessionMeta === 'function') {
      await rewindUpdateSessionMeta(sid, { branchStatus: 'active' });
    }
  } catch (e) {}
  try { gv2HideRestoreOverlay(); } catch (e) {}
  try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}
  await _gv2GenerateAndDispatchSteer();
}
if (typeof window !== 'undefined') window.gv2ConfirmSteerRestore = gv2ConfirmSteerRestore;

/**
 * Perform the actual page restore for a steer branch: settle, re-apply the recorded page
 * condition (web storage + scroll + forms) and replay transient UI actions. Pushes a per-item
 * entry into `log`. Respects the Stop tombstone (bails early).
 */
async function _gv2PerformRestore(kept, branchRec, payload, fromStep, inPlace, log) {
  if (inPlace) {
    // Already on the page with its live state — let in-flight changes settle, no reload/replay.
    await gv2WaitForDomStable(3000, 300);
    if (_gv2IsStopped()) return;
    log.push({ kind: 'note', value: 'Live page — state preserved in place (no reload)', ok: true });
    return;
  }
  // Freshly-loaded landing page: settle, restore recorded condition, then replay transient UI.
  await new Promise(r => setTimeout(r, 500));
  if (_gv2IsStopped()) return;
  await gv2WaitForDomStable(8000, 700);
  if (_gv2IsStopped()) return;

  // Prefer state restore over re-clicking (re-clicking risks re-firing non-idempotent actions).
  if (branchRec && branchRec.restore && typeof gv2ApplyRestoreState === 'function') {
    try { console.log('[guidev2] steer restore applied', gv2ApplyRestoreState(branchRec.restore, window, null, log)); }
    catch (e) { console.warn('[guidev2] steer restore failed:', e); }
    await gv2WaitForDomStable(3000, 300);
    if (_gv2IsStopped()) return;
  }

  await _gv2ReplayActions(kept, payload.url, log);
  if (_gv2IsStopped()) return;

  // Match gate: flag (but don't block) if the restored page doesn't resemble the branch point.
  if (!_gv2VerifyResumeMatch(branchRec, payload.url)) {
    _gv2FlagReplayStuck(fromStep, "the restored page didn't match the recorded step");
    log.push({ kind: 'note', value: "⚠ Restored page didn't match the recorded step", ok: false });
  }
}

/** Project kept records into the "from memory" action list shown beside the restore checklist. */
function _gv2RecordedActions(kept) {
  return (Array.isArray(kept) ? kept : []).map(r => ({
    step: r.step,
    action: r.action || null,
    instruction: r.instruction || '',
    target: { text: (r.target && r.target.text) || '' },
    url: r.url || ''
  }));
}

/** Whole-page screenshot for the restore card's hover preview; best-effort. */
async function _gv2CaptureRestoreShot() {
  try { return await captureScreenshot(); } catch (e) { return null; }
}

/** Capture a fresh shot and send the (enriched) steerRestoreReady message to the panel. */
async function _gv2SendRestoreReady(ctx, log, opts = {}) {
  const restoreShot = await _gv2CaptureRestoreShot();
  if (ctx) ctx.restoreShot = restoreShot || null;
  const error = ('error' in opts)
    ? opts.error
    : ((typeof gv2RestoreErrorSummary === 'function') ? gv2RestoreErrorSummary(log) : '');
  try {
    chrome.runtime.sendMessage({
      action: 'steerRestoreReady',
      sessionId: ctx.sessionId,
      fromStep: ctx.fromStep,
      redoStep: ctx.redoStep,
      url: ctx.url,
      inPlace: ctx.inPlace,
      newGoal: ctx.newGoal,
      parentSessionId: ctx.parentSessionId || null,
      branchLabel: ctx.branchLabel || '',
      log: Array.isArray(log) ? log.slice() : [],
      recorded: ctx.recorded || [],
      restoreShot,
      redoBeforeShot: ctx.redoBeforeShot || null,
      error: error || null,
      canRetry: opts.canRetry !== false
    });
  } catch (e) {}
}

async function gv2CompareSteerRestoreState() {
  const g = window._guidev2;
  const ctx = g && g._restoreContext;
  if (!g || !g._awaitingRestoreConfirm || !ctx) {
    return { success: false, error: 'No restore review is active.' };
  }
  const beforeShot = ctx.redoBeforeShot || null;
  const restoreShot = ctx.restoreShot || null;
  if (!beforeShot || !restoreShot) {
    return { success: false, error: 'Need both saved and current screenshots to compare.' };
  }

  const prompt = (typeof gv2BuildRestoreComparePrompt === 'function')
    ? gv2BuildRestoreComparePrompt(ctx)
    : 'Compare the saved before screenshot with the current restored screenshot. Return JSON with summary, restored, notRestored, recommendation, and confidence.';
  const response = await safeSendMessage({
    action: 'callLLMWithImages',
    systemPrompt: 'You compare browser screenshots for a restore-quality check. Be concise, practical, and return JSON only.',
    messages: [{ role: 'user', content: prompt }],
    images: [
      { base64: beforeShot, label: 'Saved state before the step' },
      { base64: restoreShot, label: 'Current page after restore' }
    ],
    metadata: {
      mode: 'guide_restore_check',
      step: (g && g.currentPlanStep) || 0,
      url: window.location.href
    }
  });
  if (response?.error) return { success: false, error: response.error };
  const comparison = (typeof gv2ParseRestoreComparison === 'function')
    ? gv2ParseRestoreComparison(response?.content || '')
    : { summary: response?.content || 'Comparison complete.', restored: [], notRestored: [], recommendation: '', confidence: null };
  return { success: true, comparison };
}
if (typeof window !== 'undefined') window.gv2CompareSteerRestoreState = gv2CompareSteerRestoreState;

/**
 * Deterministically re-apply the saved restore ONCE. Invoked from the message router on
 * `retrySteerRestore`. Rebuilds the restore on the same anchor; on persistent failure the
 * resent card carries a specific error and disables further retries.
 */
async function gv2RetrySteerRestore() {
  const g = window._guidev2;
  const ctx = g && g._restoreContext;
  if (!g || !g._awaitingRestoreConfirm || !ctx) {
    console.warn('[guidev2] retrySteerRestore: nothing to retry');
    // Un-stick the panel (its buttons are disabled waiting on us).
    try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
    try { chrome.runtime.sendMessage({ action: 'addMessage', content: '⚠ Nothing to retry — the restore session expired.', type: 'error' }); } catch (e) {}
    return;
  }
  if (g._restoreRetried) {
    // Already used the single retry — just re-send current state with retry disabled.
    await _gv2SendRestoreReady(ctx, ctx._lastLog || [], { canRetry: false });
    return;
  }
  g._restoreRetried = true;
  try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}
  try { gv2ShowRestoreOverlay('restoring', 'Retrying restore…'); } catch (e) {}
  const log = [];
  g._restoreLog = log;
  try {
    await _gv2PerformRestore(ctx.kept, ctx.branchRec, ctx.payload, ctx.fromStep, ctx.inPlace, log);
  } catch (e) {
    console.error('[guidev2] retry restore error:', e);
    log.push({ kind: 'note', value: 'Restore retry needs review: ' + (e?.message || 'PageGuide could not finish applying the saved state.'), ok: false });
  }
  if (!log.length) log.push({ kind: 'note', value: 'Checked the saved page state', ok: true });
  ctx._lastLog = log;
  try {
    if (typeof rewindPatchRecord === 'function') {
      await rewindPatchRecord(ctx.sessionId, ctx.fromStep, { restoreLog: log.slice(), restoredAt: Date.now() });
    }
  } catch (e) {}
  if (_gv2IsStopped()) return;
  try { gv2ShowRestoreOverlay('review'); } catch (e) {}
  try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
  await _gv2SendRestoreReady(ctx, log, { canRetry: false });
}
if (typeof window !== 'undefined') window.gv2RetrySteerRestore = gv2RetrySteerRestore;

/**
 * User says the restore is wrong and describes what's off. We hand the correction to the agent:
 * fold the note into the branch instruction, drop the confirm gate, and let the agent proceed —
 * it re-grounds on the live page each step, so it can take whatever action is needed to reach the
 * desired state (this is what makes "tell agent" actually DO something, unlike a deterministic
 * re-apply). Invoked from the router on `fixSteerRestore`.
 */
async function gv2FixSteerRestore(note) {
  const g = window._guidev2;
  const ctx = g && g._restoreContext;
  if (!g || !g._awaitingRestoreConfirm || !ctx) {
    console.warn('[guidev2] fixSteerRestore: nothing to fix');
    try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
    try { chrome.runtime.sendMessage({ action: 'addMessage', content: '⚠ Nothing to fix — the restore session expired.', type: 'error' }); } catch (e) {}
    return;
  }
  note = String(note || '').trim();
  if (note) {
    g.question = `${g.question}\nRESTORE FIX — the state before step ${ctx.redoStep} wasn't fully restored: ${note}. Take whatever action is needed to fix this before continuing.`;
    try { chrome.runtime.sendMessage({ action: 'addMessage', content: `🔧 Asking the agent to fix the restore: “${note}”`, type: 'info' }); } catch (e) {}
  }
  // Hand off to the agent (same tail as Confirm), so it acts on the correction now.
  g._awaitingRestoreConfirm = false;
  try { gv2HideRestoreOverlay(); } catch (e) {}
  try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}
  await _gv2GenerateAndDispatchSteer();
}
if (typeof window !== 'undefined') window.gv2FixSteerRestore = gv2FixSteerRestore;

/**
 * Best-effort replay of recorded actions to rebuild transient state (open dropdowns, filled
 * forms) on the landing page. Replays only the steps whose action happened on this page
 * (post-action URL === landingUrl), skipping the click that navigated *into* the page (the
 * reload already did that). On a miss it flags the step for the user and stops — the agent
 * then re-grounds on whatever state exists.
 */
async function _gv2ReplayActions(records, landingUrl, log) {
  if (!Array.isArray(records) || !records.length) return;
  let list = records.filter(r => r && r.url === landingUrl).sort((a, b) => a.step - b.step);
  if (list.length) {
    const first = list[0];
    const prev = records.find(r => r.step === first.step - 1);
    if (prev && prev.url !== landingUrl) list = list.slice(1); // drop the boundary navigator
  }
  const rec = (e) => { if (Array.isArray(log)) { try { log.push(e); } catch (_) {} } };
  for (const r of list) {
    if (window.location.href !== landingUrl) {
      _gv2FlagReplayStuck(r.step, 'the page changed unexpectedly during replay');
      return { success: false, progressed: false, navigated: true, capturedAfter: false };
    }
    const ok = await _gv2ReplayOne(r);
    rec({ kind: 'replay', action: String(r.action || 'click').toLowerCase(), target: { text: r.target && r.target.text }, value: r.typeText, ok });
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
  } else if (action === 'clear_text') {
    _gv2ReplayType(el, '');
  } else if (action === 'select') {
    // Set the dropdown to the recorded option (by visible text), then fire change.
    const field = el.matches('select') ? el : el.querySelector('select');
    if (field && r.typeText != null) {
      const opt = Array.from(field.options).find(o => (o.textContent || '').trim() === String(r.typeText).trim() || o.value === r.typeText);
      if (opt) { field.value = opt.value; field.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  } else if (action === 'check' || action === 'toggle') {
    // Restore a checkbox/radio to its recorded state, then fire change.
    const box = el.matches('input[type=checkbox],input[type=radio]') ? el : el.querySelector('input[type=checkbox],input[type=radio]');
    if (box) { box.checked = (r.checked != null) ? !!r.checked : true; box.dispatchEvent(new Event('change', { bubbles: true })); }
  } else {
    _gv2DispatchClick(el);
  }
  return true;
}

/**
 * Lightweight gate: does the freshly-restored page actually resemble the branch step? Used
 * before auto-continuing a reload-path steer so we never silently act on the wrong page.
 * Decisive signal is the URL (hash-insensitive); we also require the page to have rendered
 * some interactive content. Returns true (permissive) when there's nothing to compare.
 */
function _gv2VerifyResumeMatch(rec, landingUrl) {
  const strip = (u) => { try { const x = new URL(u); return x.origin + x.pathname + x.search; } catch (e) { return u; } };
  try {
    if (landingUrl && strip(window.location.href) !== strip(landingUrl)) return false;
  } catch (e) {}
  try {
    const pageIndex = createPageIndex(5000, true);
    if (pageIndex && pageIndex.count === 0) return false; // page rendered nothing actionable
  } catch (e) {}
  return true;
}

/** Set a value into a resolved field (mirrors _gv2AutoType's core, for an explicit element). */
function _gv2ReplayType(el, text) {
  const input = el.matches('input,textarea,[contenteditable]')
    ? el : el.querySelector('input,textarea,[contenteditable]');
  if (!input) return;
  input.focus();
  if ((typeof _gv2IsContentEditable === 'function' ? _gv2IsContentEditable(input) : input.isContentEditable)) {
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
    planningMode: s.planningMode || 'planning',
    plan: Array.isArray(s.plan) ? s.plan : [],
    planTitle: s.planTitle || '',
    lastActionStepNumber: s._lastActionStepNumber || null,
    activeStepNumber: s._activeStepNumber || null,
    // Mode: carry Manual/Auto across navigations.
    autoMode: s.autoMode,
    paused: !!s.paused,
    lowConfidenceCount: s.lowConfidenceCount || 0,
    predictedGoalState: s.predictedGoalState || null,
    forceGroundTruth: s.forceGroundTruth || null,
    // Mechanical confidence: carry the loop-detection key list across navigations.
    mechKeys: Array.isArray(s._mechKeys) ? s._mechKeys : []
  };

  // Primary: tell service worker (survives page navigation if SW stays alive)
  try {
    await safeSendMessage({ action: 'guidanceV2_setState', state });
  } catch (e) {
    console.warn('[guidev2] SW state set failed:', e);
  }

  // Fallback: session storage (survives SW restart)
  await gv2SaveFallback({
    pendingResume,
    paused: !!s.paused,
    lowConfidenceCount: s.lowConfidenceCount || 0,
    lastActionStepNumber: s._lastActionStepNumber || null,
    activeStepNumber: s._activeStepNumber || null
  });
}

function _gv2ClearState() {
  window._guidev2.active = false;
  _gv2HideIndicator();
  gv2HideAutoOverlay();
  gv2HideRestoreOverlay();

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

// Confidence formula preference: 'full' (grounded·loop·progress) or 'reduced' (grounded·loop, no progress).
// Applies in both manual and auto modes; the score computation is mode-independent.
const _GV2_CONF_FORMULA_KEY = 'guideConfidenceFormula';

async function _gv2ConfidenceFormula() {
  try {
    const r = await chrome.storage.local.get(_GV2_CONF_FORMULA_KEY);
    const v = r[_GV2_CONF_FORMULA_KEY];
    return (v === 'reduced' || v === 'noloop') ? v : 'full'; // default full
  } catch (e) {
    return 'full';
  }
}

// Confidence SOURCE toggle: 'llm' = self-reported grounded/loop/progress (default, original
// behavior), 'mechanical' = rule-based grounding × loop computed from execution signals (no LLM).
// Decides which score becomes the active `confidence` that drives the tier/pause/red-highlight logic.
const _GV2_CONF_SOURCE_KEY = 'guideConfidenceSource';

async function _gv2ConfidenceSource() {
  try {
    const r = await chrome.storage.local.get(_GV2_CONF_SOURCE_KEY);
    return r[_GV2_CONF_SOURCE_KEY] === 'mechanical' ? 'mechanical' : 'llm'; // default llm
  } catch (e) {
    return 'llm';
  }
}

const _GV2_EVAL_GROUNDING_WARNING_KEY = 'guideEvalGroundingWarningEnabled';
const _GV2_EVAL_LOOP_WARNING_KEY = 'guideEvalLoopWarningEnabled';
const _GV2_EVAL_GROUNDING_WARNING_THRESHOLD_KEY = 'guideEvalGroundingWarningThreshold';
const _GV2_EVAL_LOOP_WARNING_THRESHOLD_KEY = 'guideEvalLoopWarningThreshold';

async function _gv2EvalWarningPrefs() {
  try {
    const r = await chrome.storage.local.get([
      _GV2_EVAL_GROUNDING_WARNING_KEY,
      _GV2_EVAL_LOOP_WARNING_KEY,
      _GV2_EVAL_GROUNDING_WARNING_THRESHOLD_KEY,
      _GV2_EVAL_LOOP_WARNING_THRESHOLD_KEY
    ]);
    return {
      groundingEnabled: r[_GV2_EVAL_GROUNDING_WARNING_KEY] === true,
      loopEnabled: r[_GV2_EVAL_LOOP_WARNING_KEY] === true,
      groundingThreshold: Number.isFinite(Number(r[_GV2_EVAL_GROUNDING_WARNING_THRESHOLD_KEY]))
        ? Number(r[_GV2_EVAL_GROUNDING_WARNING_THRESHOLD_KEY]) : 0.8,
      loopThreshold: Number.isFinite(Number(r[_GV2_EVAL_LOOP_WARNING_THRESHOLD_KEY]))
        ? Number(r[_GV2_EVAL_LOOP_WARNING_THRESHOLD_KEY]) : 0.3
    };
  } catch (e) {
    return { groundingEnabled: false, loopEnabled: false, groundingThreshold: 0.8, loopThreshold: 0.3 };
  }
}

async function _gv2IsEvalMode() {
  try {
    const r = await chrome.storage.local.get('guideEvalMode');
    return r.guideEvalMode === true;
  } catch (e) {
    return false;
  }
}

// DOM+Screenshot eval mode: the guide attaches the current viewport screenshot to its
// reasoning LLM call (and any warning-retry call). Gated on eval mode so normal
// interactive guide usage is unchanged; the eval sets sync `visionEnabled` per input mode.
async function _gv2EvalVisionEnabled() {
  try {
    if (!(await _gv2IsEvalMode())) return false;
    const s = await chrome.storage.sync.get(['visionEnabled']);
    return s.visionEnabled === true;
  } catch (e) {
    return false;
  }
}

async function _gv2CaptureVisionShot() {
  // Capture the current (before-action) viewport, hiding PageGuide's own overlays so the
  // model sees only the page — not the "Pause task" / "Agent thinking…" UI.
  const hidden = [];
  try {
    for (const id of [_GV2_AUTO_OVERLAY_ID, _GV2_INDICATOR_ID, 'pageguide-som-container']) {
      const el = document.getElementById(id);
      if (el && el.style.visibility !== 'hidden') { el.style.visibility = 'hidden'; hidden.push(el); }
    }
  } catch (e) {}
  let shot = null;
  try {
    if (typeof captureScreenshot === 'function') shot = await captureScreenshot();
  } catch (e) {}
  for (const el of hidden) { try { el.style.visibility = ''; } catch (e) {} }
  return shot;
}

// Debug-only target-region capture: 'legacy' crops the carried before-shot using immediate
// element bounds; 'aligned' scrolls the highlight into view, takes a fresh screenshot, then crops.
const _GV2_REGION_CAPTURE_KEY = 'guideDebugRegionCapture';

async function _gv2IsAlignedRegionCapture() {
  try {
    const r = await chrome.storage.local.get(_GV2_REGION_CAPTURE_KEY);
    return r[_GV2_REGION_CAPTURE_KEY] === 'aligned';
  } catch (e) {
    return false;
  }
}

/** Auto runs always use aligned capture (fresh pre-action screenshot of the target region). */
async function _gv2ShouldUseAlignedRegionCapture(g) {
  if (g?.autoMode) return true;
  return _gv2IsAlignedRegionCapture();
}
if (typeof window !== 'undefined') window._gv2ShouldUseAlignedRegionCapture = _gv2ShouldUseAlignedRegionCapture;

const _GV2_PASS_HISTORY_KEY = 'guideDebugPassHistory';

async function _gv2IsPassHistory() {
  try {
    const r = await chrome.storage.local.get(_GV2_PASS_HISTORY_KEY);
    return r[_GV2_PASS_HISTORY_KEY] !== 'not_passing'; // default true
  } catch (e) {
    return true;
  }
}

const _GV2_PLANNING_MODE_KEY = 'guideDebugPlanningMode';

async function _gv2PlanningMode() {
  try {
    const r = await chrome.storage.local.get(_GV2_PLANNING_MODE_KEY);
    return r[_GV2_PLANNING_MODE_KEY] === 'direct' ? 'direct' : 'planning';
  } catch (e) {
    return 'planning';
  }
}

function _gv2NormalizePlan(raw) {
  const steps = Array.isArray(raw?.steps) ? raw.steps : [];
  const out = [];
  steps.slice(0, GV2_MAX_STEPS).forEach((item, idx) => {
    const goal = String(item?.goal || item?.text || item?.instruction || '').replace(/\s+/g, ' ').trim();
    if (!goal) return;
    out.push({ n: out.length + 1, goal, status: 'pending' });
  });
  return {
    planTitle: String(raw?.planTitle || raw?.title || '').replace(/\s+/g, ' ').trim(),
    steps: out
  };
}

function _truncateGuideText(text, max = 60) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function _gv2PlanSection(g) {
  if (!g || g.planningMode !== 'planning' || !Array.isArray(g.plan) || !g.plan.length) return '';
  const lines = g.plan.map(p => {
    const status = p.status === 'complete' ? 'complete' : (Number(p.n) === Number(g.currentPlanStep || 1) ? 'current' : 'pending');
    return `${p.n}. [${status}] ${p.goal}`;
  }).join('\n');
  return `
=== TASK PLAN ===
Use this plan as a reference point. It is advisory; choose the best next action from the current page.
After choosing the action, include these extra JSON fields:
"completedPlanStep": the highest plan step completed by this action, or null if none is completed yet
"completedPlanStepReason": short explanation for that completion value
${lines}
`;
}

function _gv2MarkPlanComplete(g, completedPlanStep) {
  if (!g || !Array.isArray(g.plan) || !g.plan.length) return null;
  const raw = Number(completedPlanStep);
  if (!Number.isFinite(raw) || raw < 1) return null;
  const n = Math.max(1, Math.min(g.plan.length, Math.floor(raw)));
  g.plan = g.plan.map(p => ({ ...p, status: Number(p.n) <= n ? 'complete' : (p.status || 'pending') }));
  g.currentPlanStep = Math.min(g.plan.length, n + 1);
  return n;
}

async function _gv2GenerateInitialPlan(g, pageIndex, pageBg) {
  if (!g || g.planningMode !== 'planning' || !pageIndex) return false;
  let tutorialSection = '';
  if (g.tutorialRef) {
    tutorialSection = `
=== TUTORIAL REFERENCE ===
Pre-verified steps for "${g.tutorialRef.task}" on ${g.tutorialRef.website}:
${g.tutorialRef.content.steps.join('\n')}
Use these as a reference guide but map the plan to the actual elements visible in the PAGE INDEX above.
`;
  }
  const prompt = `PAGE BACKGROUND: ${pageBg?.isDark ? 'DARK' : 'LIGHT'}
CURRENT URL: ${window.location.href}

=== PAGE INDEX ===
${pageIndex.indexText}

=== USER GOAL ===
${g.question}
${tutorialSection}

Return JSON for the task plan.`;
  const planningStartedAt = Date.now();
  const planningMetadata = { mode: 'guide_plan', step: 0, url: window.location.href };
  try {
    const response = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: GUIDE_V2_PLANNING_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      imageBase64: g._pendingPromptImage || null,
      metadata: planningMetadata
    });
    if (response?.error || !response?.content) throw new Error(response?.error || 'No planning response');
    const parsed = (typeof gv2ExtractJsonObject === 'function')
      ? gv2ExtractJsonObject(response.content)
      : JSON.parse(response.content);
    const normalized = _gv2NormalizePlan(parsed);
    if (!normalized.steps.length) throw new Error('Planning response did not include steps');
    g.plan = normalized.steps;
    g.planTitle = normalized.planTitle || _truncateGuideText(g.question, 60);
    g.currentPlanStep = 1;
    try {
      chrome.runtime.sendMessage({
        action: 'guidePlan',
        plan: g.plan,
        title: g.planTitle,
        sessionId: g.sessionId,
        prompt: g.question
      });
    } catch (e) {}
    if (g.sessionId && typeof rewindUpdateSessionMeta === 'function') {
      try {
        await rewindUpdateSessionMeta(g.sessionId, {
          plan: g.plan,
          planTitle: g.planTitle,
          planningMode: g.planningMode,
          planningPromptTimestamp: planningStartedAt,
          planningSystemPrompt: GUIDE_V2_PLANNING_PROMPT,
          planningPrompt: prompt,
          planningRawResponse: response.content || '',
          planningResponseError: '',
          planningMetadata
        });
      } catch (e) {}
    }
    return true;
  } catch (e) {
    console.warn('[guidev2] planning initialization failed:', e);
    g.planningMode = 'direct';
    g.plan = [];
    g.planTitle = '';
    if (g.sessionId && typeof rewindUpdateSessionMeta === 'function') {
      try {
        await rewindUpdateSessionMeta(g.sessionId, {
          planningMode: 'direct',
          planningPromptTimestamp: planningStartedAt,
          planningSystemPrompt: GUIDE_V2_PLANNING_PROMPT,
          planningPrompt: prompt,
          planningRawResponse: '',
          planningResponseError: e?.message || String(e),
          planningMetadata
        });
      } catch (metaErr) {}
    }
    try {
      chrome.runtime.sendMessage({
        action: 'addMessage',
        content: `Planning initialization skipped: ${e.message || e}`,
        type: 'info'
      });
    } catch (sendErr) {}
    return false;
  }
}
if (typeof window !== 'undefined') window._gv2GenerateInitialPlan = _gv2GenerateInitialPlan;

async function _gv2WaitForLayoutSettle() {
  await new Promise((resolve) => {
    try {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    } catch (e) {
      resolve();
    }
  });
}

/** Ask the LLM once per guide session what the final page state should look like. */
async function _gv2PredictFinalGoalState(question, url) {
  const prompt = (typeof gv2BuildPredictFinalGoalPrompt === 'function')
    ? gv2BuildPredictFinalGoalPrompt(question, url)
    : `Predict the final goal state for: ${question}`;
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'callLLM',
      systemPrompt: '',
      messages: [{ role: 'user', content: prompt }],
      metadata: { kind: 'predictFinalGoalState' }
    });
    const text = (resp?.content || '').trim();
    return text || null;
  } catch (e) {
    console.warn('[guidev2] predictFinalGoalState failed:', e);
    return null;
  }
}

// ===== Embedding request plumbing =====
// Grounding/goal-relevance scoring needs an embedding computed every step, before the action
// is applied. Routing that through the service worker is unreliable: during an active guide
// the SW does not receive callEmbed messages (the guide's own heavy SW traffic — screenshots,
// vision LLM calls, state updates — starves them), so the reply resolves `undefined` →
// reason:'no_response'. We therefore embed DIRECTLY from the content script (which is alive
// and running the guide), reading the API key from chrome.storage; the SW sendMessage path is
// only a fallback for the rare case the direct fetch is blocked. Calls are SERIALIZED through
// a single in-flight chain and MEMOIZED per text (embeddings are a pure function of the text).
let _gv2EmbedChain = Promise.resolve();
const _gv2EmbedCache = new Map(); // text -> number[] (embedding vector)
const GV2_EMBED_CACHE_MAX = 128;

function _gv2EmbedCacheSet(text, vec) {
  if (!Array.isArray(vec) || !vec.length) return;
  if (_gv2EmbedCache.has(text)) _gv2EmbedCache.delete(text);
  _gv2EmbedCache.set(text, vec);
  while (_gv2EmbedCache.size > GV2_EMBED_CACHE_MAX) {
    _gv2EmbedCache.delete(_gv2EmbedCache.keys().next().value); // FIFO evict oldest
  }
}

/** Reset embed serialization + cache. Test/diagnostic helper. */
function _gv2ResetEmbedState() {
  _gv2EmbedCache.clear();
  _gv2EmbedChain = Promise.resolve();
}

/**
 * Embed `texts`, SERIALIZED (one request in flight at a time) and MEMOIZED per text. Returns
 * `{ embeddings: number[][] }` aligned to `texts` on success, or the raw failure response
 * (`{ error }` / undefined) so callers keep their graceful handling. Never throws.
 */
async function _gv2CallEmbed(texts, attempts = 2) {
  const input = Array.isArray(texts) ? texts.map(t => String(t ?? '')) : [];
  if (!input.length) return { embeddings: [] };
  // Chain after any in-flight embed; keep the chain alive even if this call rejects so a
  // single failure can't wedge the queue.
  const run = _gv2EmbedChain.then(() => _gv2CallEmbedInner(input, attempts));
  _gv2EmbedChain = run.then(() => {}, () => {});
  return run;
}

const GV2_EMBED_MSG_TIMEOUT_MS = 6000;
const GV2_EMBED_MODEL = 'openai/text-embedding-ada-002';

/**
 * Embed `texts` directly from the content script (bypassing the SW), reading the key from
 * chrome.storage. This is the reliable path during an active guide. Returns
 * `{ embeddings }` / `{ error }`, or undefined if the fetch itself is blocked (e.g. page CSP)
 * so the caller can fall back to the SW.
 */
async function _gv2DirectEmbed(texts) {
  try {
    const s = await chrome.storage.sync.get(['provider', 'openrouterApiKey', 'openaiApiKey']);
    const provider = s.provider || 'openrouter';
    let endpoint, apiKey;
    if (provider === 'openai') {
      endpoint = 'https://api.openai.com/v1/embeddings';
      apiKey = (s.openaiApiKey || '').trim();
    } else {
      endpoint = 'https://openrouter.ai/api/v1/embeddings';
      apiKey = (s.openrouterApiKey || '').trim() || (s.openaiApiKey || '').trim();
    }
    if (!apiKey) return { error: 'Embedding API key not configured.' };
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GV2_EMBED_MODEL, input: texts })
    });
    if (!resp.ok) return { error: `Embedding HTTP ${resp.status}` };
    const data = await resp.json();
    const rows = Array.isArray(data.data) ? data.data.slice().sort((a, b) => (a.index || 0) - (b.index || 0)) : [];
    return { embeddings: rows.map(r => r.embedding || []) };
  } catch (e) {
    return undefined; // fall back to the SW transport
  }
}

/**
 * Transport for a single embed of `texts`: direct content-script fetch (primary), falling back
 * to one-shot sendMessage to the SW if the direct fetch is blocked. Returns the response object
 * or undefined.
 */
async function _gv2SendEmbed(texts) {
  const direct = await _gv2DirectEmbed(texts);
  if (direct && (direct.error || Array.isArray(direct.embeddings))) return direct;
  return (typeof safeSendMessage === 'function')
    ? await safeSendMessage({ action: 'callEmbed', texts }, GV2_EMBED_MSG_TIMEOUT_MS)
    : await chrome.runtime.sendMessage({ action: 'callEmbed', texts });
}

async function _gv2CallEmbedInner(input, attempts) {
  const missing = input.filter(t => !_gv2EmbedCache.has(t));
  if (missing.length) {
    let resp = null;
    for (let i = 0; i < attempts; i++) {
      resp = await _gv2SendEmbed(missing);
      if (resp && !resp.error && Array.isArray(resp.embeddings) && resp.embeddings.length === missing.length) break;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 250));
    }
    if (!resp || resp.error || !Array.isArray(resp.embeddings) || resp.embeddings.length !== missing.length) {
      return resp; // propagate failure unchanged — callers handle no_response / embed_error
    }
    missing.forEach((t, k) => _gv2EmbedCacheSet(t, resp.embeddings[k]));
  }
  return { embeddings: input.map(t => _gv2EmbedCache.get(t) || []) };
}
if (typeof window !== 'undefined') {
  window._gv2CallEmbed = _gv2CallEmbed;
  window._gv2ResetEmbedState = _gv2ResetEmbedState;
}

async function _gv2CacheGoalEmbedding(g) {
  if (!g?.predictedGoalState) return;
  try {
    const resp = await _gv2CallEmbed([g.predictedGoalState]);
    if (resp?.error || !resp?.embeddings?.[0]?.length) return;
    g._goalEmbedVector = resp.embeddings[0];
  } catch (e) { /* best-effort */ }
}

async function _gv2GoalRelevanceScore(g, instruction) {
  if (!g?._goalEmbedVector || !instruction || typeof gv2CosineSimilarity !== 'function') return null;
  try {
    const resp = await _gv2CallEmbed([String(instruction)]);
    if (resp?.error || !resp?.embeddings?.[0]?.length) return null;
    return gv2CosineSimilarity(resp.embeddings[0], g._goalEmbedVector);
  } catch (e) {
    return null;
  }
}

async function _gv2ElementStepSimilarityResult(instruction, elementText, hasIndex) {
  if (!hasIndex) return { value: null, reason: 'no_index', detail: 'The agent response did not include a resolved element index.' };
  const instr = String(instruction || '').trim();
  const elem = String(elementText || '').trim();
  if (!instr) return { value: null, reason: 'empty_instruction', detail: 'The agent response instruction was empty.' };
  if (!elem) return { value: null, reason: 'empty_element_text', detail: 'The resolved DOM element text was empty.' };
  if (typeof gv2CosineSimilarity !== 'function') {
    return { value: null, reason: 'cosine_unavailable', detail: 'gv2CosineSimilarity was not available in the page context.' };
  }
  try {
    const resp = await _gv2CallEmbed([instr, elem]);
    if (!resp) {
      return { value: null, reason: 'no_response', detail: 'Embedding request returned no response (service worker unavailable).' };
    }
    if (resp.error) {
      return { value: null, reason: 'embed_error', detail: String(resp.error || 'Embedding request failed.') };
    }
    if (!Array.isArray(resp.embeddings) || resp.embeddings.length < 2) {
      return { value: null, reason: 'bad_embeddings', detail: 'Embedding response did not include two embedding vectors.' };
    }
    const value = gv2CosineSimilarity(resp.embeddings[0], resp.embeddings[1]);
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      return { value: null, reason: 'cosine_null', detail: 'Cosine similarity could not be computed from the returned vectors.' };
    }
    return { value: Number(value), reason: 'ok', detail: '' };
  } catch (e) {
    console.warn('[guidev2] element-step embed failed:', e);
    return { value: null, reason: 'exception', detail: String(e?.message || e || 'Embedding request threw an exception.') };
  }
}

async function _gv2ElementStepSimilarity(instruction, elementText, hasIndex) {
  const result = await _gv2ElementStepSimilarityResult(instruction, elementText, hasIndex);
  return result.value;
}
if (typeof window !== 'undefined') window._gv2ElementStepSimilarityResult = _gv2ElementStepSimilarityResult;

function _gv2NormalizeCandidateStep(raw) {
  const step = raw ? { ...raw } : null;
  if (!step) throw new Error('Could not parse step JSON');
  if (!step.instruction) throw new Error('LLM response JSON is missing instruction field');
  const g = window._guidev2;
  const stepNumberInfo = (typeof gv2NormalizeStepNumber === 'function')
    ? gv2NormalizeStepNumber(step, g?.previousSteps || [])
    : {
        expectedStep: (Array.isArray(g?.previousSteps) ? g.previousSteps.length : 0) + 1,
        llmStep: Number.isFinite(Number(step.step)) ? Number(step.step) : null,
        stepNumberCorrected: Number(step.step) !== ((Array.isArray(g?.previousSteps) ? g.previousSteps.length : 0) + 1)
      };
  step.llmStep = stepNumberInfo.llmStep;
  step.expectedStep = stepNumberInfo.expectedStep;
  step.stepNumberCorrected = stepNumberInfo.stepNumberCorrected;
  step.step = stepNumberInfo.expectedStep;
  return step;
}

function _gv2ResolvedElementText(step) {
  const idx = step?.element?.index;
  const hasIndex = idx != null && idx !== '';
  if (hasIndex) {
    const el = window._pageguideIndex?.[idx];
    if (el) {
      try {
        const name = (typeof getAccessibleName === 'function' ? getAccessibleName(el) : '') || el.innerText || el.textContent || '';
        const cleaned = String(name || '').replace(/\s+/g, ' ').trim();
        if (cleaned) return cleaned;
      } catch (e) {}
    }
  }
  return String(step?.element?.text || '').replace(/\s+/g, ' ').trim();
}

async function _gv2ScoreCandidate(content) {
  const raw = (typeof gv2ExtractJsonObject === 'function')
    ? gv2ExtractJsonObject(content)
    : JSON.parse(content);
  const step = _gv2NormalizeCandidateStep(raw);
  const action = String(step.action || (step.isLastStep ? 'done' : 'click')).toLowerCase().replace(/[\s-]+/g, '_');
  const hasIndex = step.element?.index != null && step.element?.index !== '';
  const resolvedElementText = _gv2ResolvedElementText(step);
  const reportedElementText = String(step.element?.text || '').replace(/\s+/g, ' ').trim();
  const similarityResult = await _gv2ElementStepSimilarityResult(step.instruction, resolvedElementText || reportedElementText, hasIndex);
  const elementStepSimilarity = similarityResult.value;
  const currentKey = (typeof gv2ElementKey === 'function')
    ? gv2ElementKey({ ...step, action, element: { ...(step.element || {}), text: resolvedElementText || reportedElementText } })
    : '';
  const priorKeys = Array.isArray(window._guidev2?._mechKeys) ? window._guidev2._mechKeys : [];
  const loopScore = (typeof gv2LoopScore === 'function') ? gv2LoopScore(priorKeys, currentKey) : 0;
  const loopMatchCount = currentKey ? priorKeys.filter(k => k === currentKey).length : 0;
  return {
    rawContent: content,
    step,
    action,
    hasIndex,
    reportedElementText,
    resolvedElementText,
    elementStepSimilarity,
    elementStepSimilarityReason: similarityResult.reason,
    elementStepSimilarityDetail: similarityResult.detail,
    currentKey,
    loopScore,
    loopMatchCount
  };
}

function _gv2FormatScore(value) {
  if (value === null || value === undefined || value === '') return 'unknown';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : 'unknown';
}

function _gv2WarningPromptBlock(candidate, decision) {
  // Diagnostic sentence(s) describing why the previous attempt failed. Folded into the
  // reflector-style Reflection section of the retry prompt (see _gv2WarningRetryPrompt).
  const blocks = [];
  if (decision.types.includes('grounding')) {
    const described = String(candidate.step?.instruction || candidate.reportedElementText || 'Unknown instruction').replace(/\s+/g, ' ').trim();
    const resolved = String(candidate.resolvedElementText || 'Unknown element').replace(/\s+/g, ' ').trim();
    blocks.push(`It failed grounding (similarity ${_gv2FormatScore(candidate.elementStepSimilarity)}): you described "${described}" but the page resolved "${resolved}". Only reference SoM labels that are actually visible, and choose an element/index whose DOM text matches the instruction.`);
  }
  if (decision.types.includes('loop')) {
    blocks.push(`It repeated the target "${candidate.currentKey || 'this target'}" in ${candidate.loopMatchCount} previous step(s) without progress. Choose a completely different element or approach.`);
  }
  return blocks.join(' ');
}
if (typeof window !== 'undefined') window._gv2WarningPromptBlock = _gv2WarningPromptBlock;

// Build the reflector-style retry user prompt (BacktrackAgent Table 10 format). Reuses the
// original userPrompt (which already carries the page index / action space, user goal / task,
// and completed steps / history), then appends a Reflection that folds in the grounding/loop
// diagnostic, lists the previously generated (failed) action, and asks for a NEW action that
// differs from all previous ones.
function _gv2WarningRetryPrompt(userPrompt, diagnostic, previousResponse, stepNumber) {
  const reflectionLead = 'Reflection: This is not your first attempt to generate the next action. The previous attempt to generate the next action has failed.';
  const diag = String(diagnostic || '').trim();
  return `${userPrompt}

${diag ? `${reflectionLead} ${diag}` : reflectionLead}
Here are some previously generated next actions:
${previousResponse}

Please note that you are currently in the middle stage of the trajectory. First, analyze the current state, completed actions, and task, and compare them with the previous attempt at the next action. Then, generate a new action that is DIFFERENT from all previously generated next actions. Return corrected JSON for Step ${stepNumber}.`;
}
if (typeof window !== 'undefined') window._gv2WarningRetryPrompt = _gv2WarningRetryPrompt;

function _gv2WarningSkipReason(candidate, decision, warningPrefs) {
  const reasons = [];
  if (!warningPrefs?.groundingEnabled) {
    reasons.push('grounding_disabled');
  } else if (candidate?.elementStepSimilarity === null || candidate?.elementStepSimilarity === undefined) {
    reasons.push(`grounding_similarity_unavailable:${candidate?.elementStepSimilarityReason || 'unknown'}`);
  } else if (Number(candidate.elementStepSimilarity) >= Number(warningPrefs.groundingThreshold)) {
    reasons.push('grounding_similarity_above_threshold');
  } else if (!decision?.types?.includes('grounding')) {
    reasons.push('grounding_not_selected');
  }

  if (!warningPrefs?.loopEnabled) {
    reasons.push('loop_disabled');
  } else if (candidate?.loopScore === null || candidate?.loopScore === undefined) {
    reasons.push('loop_score_unavailable');
  } else if (Number(candidate.loopScore) < Number(warningPrefs.loopThreshold)) {
    reasons.push('loop_below_threshold');
  } else if (!decision?.types?.includes('loop')) {
    reasons.push('loop_not_selected');
  }

  return reasons.join('; ');
}

function _gv2WarningMetaBase({ firstCandidate, warningPrefs, decision, warningInjected, warningPrompt = '', warningSystemPrompt = '', warningDiagnostic = '', retryRawResponse = '' }) {
  return {
    warningChecked: true,
    warningInjected: !!warningInjected,
    warningSkipReason: warningInjected ? '' : _gv2WarningSkipReason(firstCandidate, decision || { types: [] }, warningPrefs || {}),
    warningTypes: Array.isArray(decision?.types) ? decision.types : [],
    // Full user prompt sent for the retry (user goal + current page index + completed steps +
    // the reflection). warningSystemPrompt is the system prompt used; warningDiagnostic is just
    // the grounding/loop reflection sentence for a compact summary.
    warningPrompt,
    warningSystemPrompt,
    warningDiagnostic,
    firstRawResponse: firstCandidate?.rawContent || '',
    retryRawResponse,
    firstGroundingSimilarity: firstCandidate?.elementStepSimilarity ?? null,
    firstGroundingSimilarityReason: firstCandidate?.elementStepSimilarityReason || '',
    firstGroundingSimilarityDetail: firstCandidate?.elementStepSimilarityDetail || '',
    firstLoopScore: firstCandidate?.loopScore ?? null,
    warningGroundingThreshold: decision?.groundingThreshold ?? warningPrefs?.groundingThreshold ?? null,
    warningLoopThreshold: decision?.loopThreshold ?? warningPrefs?.loopThreshold ?? null,
    firstReportedElementText: firstCandidate?.reportedElementText || '',
    firstResolvedElementText: firstCandidate?.resolvedElementText || '',
    firstActionKey: firstCandidate?.currentKey || '',
    retryGroundingSimilarity: null,
    retryGroundingSimilarityReason: '',
    retryGroundingSimilarityDetail: '',
    retryLoopScore: null,
    retryReportedElementText: '',
    retryResolvedElementText: '',
    retryActionKey: ''
  };
}

/**
 * Predict + persist the LLM's final-state sentence and pre-embed it for per-step cosine
 * goal-relevance scoring (g_goal_relevance_score on each step record).
 */
async function _gv2InitPredictedGoalState(g) {
  if (!g?.question) return;
  const predicted = await _gv2PredictFinalGoalState(g.question, window.location.href);
  if (!predicted) return;
  g.predictedGoalState = predicted;
  if (g.sessionId && typeof rewindUpdateSessionMeta === 'function') {
    try {
      await rewindUpdateSessionMeta(g.sessionId, {
        predictedGoalState: predicted,
        spec_goal_text: predicted
      });
    } catch (e) { /* non-fatal */ }
  }
  await _gv2CacheGoalEmbedding(g);
}

async function _gv2HydratePredictedGoalFromIndex(g) {
  if (!g?.sessionId || g.predictedGoalState) return;
  if (typeof rewindGetIndex !== 'function') return;
  try {
    const idx = await rewindGetIndex(g.sessionId);
    if (idx?.predictedGoalState) {
      g.predictedGoalState = idx.predictedGoalState;
      await _gv2CacheGoalEmbedding(g);
    }
  } catch (e) { /* best-effort */ }
}

// Keep the live session's mode in sync when the user toggles it mid-session.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[_GV2_AUTOMODE_PREF_KEY] && window._guidev2) {
      const on = changes[_GV2_AUTOMODE_PREF_KEY].newValue === true;
      window._guidev2.autoMode = on;
      // Turning Auto off mid-session: drop the overlay and any pending auto action.
      if (!on) {
        _gv2ClearActionTimers();
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
/**
 * Capture the region around the currently highlighted target element: its bounding rect, a
 * cropped screenshot of just that region, and a scoped DOM snapshot of its surrounding
 * container. Best-effort — returns nulls/'' when no target is resolvable (e.g. post-action,
 * after the element is gone). `screenshotBase64` is the just-taken viewport screenshot, reused
 * so we don't capture twice.
 */
async function _gv2ScrollRegionTargetIntoView(el) {
  if (!el || typeof el.scrollIntoView !== 'function') return;
  let evalMode = false;
  try {
    const r = await chrome.storage.local.get('guideEvalMode');
    evalMode = r.guideEvalMode === true;
  } catch (e) { /* best-effort */ }
  const instant = evalMode || window._guidev2?.autoMode === true;
  const scrollEl = el.closest('a, button, [role="button"], [role="link"], [role="menuitem"], li, summary, nav') || el;
  // Reliable scroll: verify the target actually became visible; fall back to moving the real
  // scroll container (nested/transformed scrollers, sticky headers) so the captured screenshot
  // and SoM marks reflect the target. Falls back to a bare scrollIntoView if the helper is absent.
  if (typeof pgScrollIntoViewReliably === 'function') {
    const visible = await pgScrollIntoViewReliably(scrollEl, {
      behavior: instant ? 'instant' : 'smooth',
      settleMs: instant ? 200 : 550,
    });
    if (!visible) console.warn('[guidev2] scroll-to-target failed — target not visible in viewport after scroll');
  } else {
    scrollEl.scrollIntoView({ behavior: instant ? 'instant' : 'smooth', block: 'center', inline: 'nearest' });
    await new Promise((resolve) => setTimeout(resolve, instant ? 200 : 550));
  }
}

async function gv2CaptureRegion(screenshotBase64, options = {}) {
  const aligned = options.aligned === true;
  const out = { targetRect: null, regionShot: null, regionDom: '', regionCaptureMode: aligned ? 'aligned' : 'legacy' };
  try {
    const resolveTarget = (typeof gv2ResolveRegionTarget === 'function')
      ? gv2ResolveRegionTarget
      : ((typeof gv2ResolveRegionElement === 'function') ? gv2ResolveRegionElement : () => null);

    let el = resolveTarget();
    if (!el || !el.getBoundingClientRect) return out;

    // New Target Captured: scroll the click target into view, take a fresh screenshot, then
    // crop — the screenshot and getBoundingClientRect() must come from the same viewport.
    // Legacy crops the carried before-shot and can misalign when scroll/layout changed.
    if (aligned) {
      await _gv2ScrollRegionTargetIntoView(el);
      await _gv2WaitForLayoutSettle();
      try {
        if (typeof captureScreenshot === 'function') {
          const fresh = await captureScreenshot();
          if (fresh) screenshotBase64 = fresh;
        }
      } catch (e) { /* best-effort */ }
      el = resolveTarget();
      if (!el || !el.getBoundingClientRect) return out;
    }

    const r = el.getBoundingClientRect();
    out.targetRect = { left: r.left, top: r.top, width: r.width, height: r.height };

    // Scoped DOM snapshot of the element's surrounding container (not the whole page).
    try {
      const container = el.closest('form, section, article, [role], main, li, fieldset, nav') || el.parentElement || el;
      if (typeof gv2SerializeDom === 'function') out.regionDom = gv2SerializeDom(container);
    } catch (e) { /* best-effort */ }

    // Crop the viewport screenshot down to the element's region.
    if (screenshotBase64) out.regionShot = await _gv2CropScreenshot(screenshotBase64, out.targetRect);
  } catch (e) { /* best-effort */ }
  return out;
}

/** Crop a base64 JPEG viewport screenshot to a CSS-px rect using a canvas. Resolves base64 or null. */
function _gv2CropScreenshot(base64, rect) {
  return new Promise((resolve) => {
    // Hard time-box: never let a stuck Image decode hang the caller (which gates the record store).
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(null), 1500);
    try {
      const img = new Image();
      img.onload = () => {
        try {
          // Zoom OUT: pad generously around the element so the crop shows surrounding context,
          // not a tight box. Floor of 160 CSS px, scaling up for larger targets.
          const pad = Math.round(Math.max(160, (rect.width || 0) * 0.75, (rect.height || 0) * 0.75));
          const crop = (typeof gv2CropRect === 'function')
            ? gv2CropRect(rect, window.devicePixelRatio || 1, img.naturalWidth, img.naturalHeight, pad)
            : null;
          if (!crop) return finish(null);
          const canvas = document.createElement('canvas');
          canvas.width = crop.sw; canvas.height = crop.sh;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
          finish(canvas.toDataURL('image/jpeg', 0.8).replace(/^data:image\/\w+;base64,/, ''));
        } catch (e) { finish(null); }
      };
      img.onerror = () => finish(null);
      img.src = 'data:image/jpeg;base64,' + base64;
    } catch (e) { finish(null); }
  });
}

// SoM mark palette (mirrors showSetOfMarks in content/functions/highlight.js) so the baked-in
// screenshot marks and the live overlay use the same per-index colors.
const _GV2_SOM_COLORS = ['#e74c3c', '#9b59b6', '#3498db', '#27ae60', '#f39c12', '#1abc9c', '#e91e63', '#00bcd4'];

/**
 * Scale a viewport rect to screenshot-image pixels, returning {x,y,w,h}, or null when the element
 * is too small or fully outside the viewport. Pure (no DOM) so it is unit-testable.
 */
function _gv2SomImageBox(rect, scaleX, scaleY, vw, vh) {
  if (!rect) return null;
  if (rect.width < 5 || rect.height < 5) return null;
  if (rect.bottom < 0 || rect.top > vh) return null;
  if (rect.right < 0 || rect.left > vw) return null;
  return { x: rect.left * scaleX, y: rect.top * scaleY, w: rect.width * scaleX, h: rect.height * scaleY };
}
if (typeof window !== 'undefined') window._gv2SomImageBox = _gv2SomImageBox;

/**
 * Bake numbered Set-of-Marks boxes onto a base64 JPEG viewport screenshot using a canvas. Uses
 * getBoundingClientRect() viewport coordinates scaled to the captured image (scale = image width /
 * innerWidth), so alignment does not depend on the page's CSS positioning/transform/scroll — unlike
 * a DOM overlay. Resolves the marked base64, or the original base64 on any failure.
 */
function _gv2DrawSomOnScreenshot(base64, pageIndex) {
  return new Promise((resolve) => {
    const indexMap = pageIndex?.indexMap || (typeof window !== 'undefined' ? window._pageguideIndex : null) || {};
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(base64), 1500); // never hang the record store on a stuck decode
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const vw = window.innerWidth || img.naturalWidth;
          const vh = window.innerHeight || img.naturalHeight;
          const scaleX = img.naturalWidth / vw;
          const scaleY = img.naturalHeight / vh;
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const lineW = Math.max(2, Math.round(2 * scaleX));
          const fontPx = Math.max(11, Math.round(11 * scaleX));
          const padX = Math.max(2, Math.round(2 * scaleX));
          const padY = Math.max(1, Math.round(1 * scaleY));
          ctx.textBaseline = 'top';
          ctx.font = `bold ${fontPx}px monospace`;
          for (const [idx, el] of Object.entries(indexMap)) {
            let rect;
            try { rect = el.getBoundingClientRect(); } catch (e) { continue; }
            const box = _gv2SomImageBox(rect, scaleX, scaleY, vw, vh);
            if (!box) continue;
            const color = _GV2_SOM_COLORS[parseInt(idx, 10) % _GV2_SOM_COLORS.length];
            ctx.lineWidth = lineW;
            ctx.strokeStyle = color;
            ctx.strokeRect(box.x, box.y, box.w, box.h);
            // Numbered label at the box's top-left corner (drop inside if it would clip off-screen).
            const label = String(idx);
            const lw = ctx.measureText(label).width + padX * 2;
            const lh = fontPx + padY * 2;
            const lx = box.x;
            const ly = box.y - lh < 0 ? box.y : box.y - lh;
            ctx.fillStyle = color;
            ctx.fillRect(lx, ly, lw, lh);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(label, lx + padX, ly + padY);
          }
          finish(canvas.toDataURL('image/jpeg', 0.8).replace(/^data:image\/\w+;base64,/, ''));
        } catch (e) { finish(base64); }
      };
      img.onerror = () => finish(base64);
      img.src = 'data:image/jpeg;base64,' + base64;
    } catch (e) { finish(base64); }
  });
}
if (typeof window !== 'undefined') window._gv2DrawSomOnScreenshot = _gv2DrawSomOnScreenshot;

async function gv2CaptureStepRecord(data) {
  const g = window._guidev2;
  if (!g || !g.active || !g.captureEnabled || !g.sessionId) return;
  if (typeof rewindPutRecord !== 'function') return;

  // Stash so a later re-capture (e.g. after auto-type fills a field) can reuse the
  // same reasoning fields and only refresh the screenshot/DOM snapshot.
  g._lastCaptureData = data;

  const startedAt = g._stepStartedAt || Date.now();

  // BEFORE-action screenshot = the PREVIOUS step's AFTER-shot (carried forward). The page hasn't
  // changed between step N-1's after-capture and step N's before, so this is the same image — and
  // reusing it avoids a second back-to-back captureVisibleTab that Chrome rate-limits (the cause
  // of "step 2 has no screenshot"). Fall back to a fresh capture only when there's no carried shot
  // yet (the first step, or right after a navigation-resume).
  const stepNum = Number(data.step);
  let beforeShot = (Number.isFinite(stepNum) && g._lastAfterShotStep === stepNum - 1) ? g._lastAfterShot : null;
  if (!beforeShot) {
    try { if (typeof captureScreenshot === 'function') beforeShot = await captureScreenshot(); }
    catch (e) { /* best-effort */ }
  }

  if (!beforeShot) {
    // Fallback: search for the latest screenshot from previous steps in this session
    try {
      if (typeof rewindGetIndex === 'function') {
        const idx = await rewindGetIndex(g.sessionId);
        if (idx && idx.steps) {
          const sorted = idx.steps.slice().sort((a, b) => Number(b.step) - Number(a.step));
          for (const meta of sorted) {
            if (Number(meta.step) < stepNum) {
              const rec = typeof rewindGetRecord === 'function' ? await rewindGetRecord(g.sessionId, meta.step) : null;
              const shot = rec?.screenshotAfter || rec?.screenshotBefore || rec?.screenshot;
              if (shot) {
                beforeShot = shot;
                console.log(`📸 Found fallback screenshot from step ${meta.step} for step ${stepNum}`);
                break;
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('[guidev2] fallback screenshot search failed:', e);
    }
  }

  if (!beforeShot) {
    // If still no screenshot, use a 1x1 transparent placeholder so the step is not void,
    // ensuring the record is stored and shown in the timeline/Inspector.
    beforeShot = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    console.log(`📸 No screenshot could be captured/found for step ${stepNum}. Using placeholder.`);
  }

  // VERIFICATION: a step with no screenshot is void — skip it entirely (don't announce a dot,
  // don't store a record), so the timeline and the stored journey only contain valid steps.
  if (!beforeShot) {
    console.warn('[guidev2] skipping void step (no screenshot available):', data.step);
    return;
  }

  let goalRelevance = null;
  if (GV2_GOAL_RELEVANCE_ENABLED && (data.instruction || '').trim()) {
    if (!g._goalEmbedVector && g.predictedGoalState) await _gv2CacheGoalEmbedding(g);
    if (!g.predictedGoalState) await _gv2HydratePredictedGoalFromIndex(g);
    goalRelevance = await _gv2GoalRelevanceScore(g, data.instruction);
  }

  // ANNOUNCE THE STEP FIRST (lightweight meta, no heavy captures) so the timeline dot, journey
  // accumulation, and the "View journey" button (added on step 1) appear immediately.
  try {
    chrome.runtime.sendMessage({
      action: 'guideStepRecord',
      meta: {
        sessionId: g.sessionId,
        step: data.step,
        planStep: data.planStep != null ? data.planStep : data.step,
        completedPlanStep: data.completedPlanStep != null ? data.completedPlanStep : null,
        completedPlanStepReason: data.completedPlanStepReason || '',
        plan: Array.isArray(data.plan) ? data.plan : null,
        instruction: data.instruction || '',
        action: data.action || null,
        isLastStep: !!data.isLastStep,
        url: window.location.href,
        title: document.title || '',
        timestamp: Date.now(),
        confidence: data.confidence != null ? data.confidence : null,
        grounded: data.grounded != null ? data.grounded : null,
        loop: data.loop != null ? data.loop : null,
        progress: data.progress != null ? data.progress : null,
        confidenceFormula: data.confidenceFormula || null,
        mechConfidence: data.mechConfidence != null ? data.mechConfidence : null,
        mechGrounding: data.mechGrounding != null ? data.mechGrounding : null,
        elementStepSimilarity: data.elementStepSimilarity != null ? data.elementStepSimilarity : null,
        element_step_similarity: data.element_step_similarity != null ? data.element_step_similarity : null,
        mechLoop: data.mechLoop != null ? data.mechLoop : null,
        confidenceSource: data.confidenceSource || null,
        confirmation: data.confirmation || null,
        llmStep: data.llmStep != null ? data.llmStep : null,
        expectedStep: data.expectedStep != null ? data.expectedStep : null,
        stepNumberCorrected: !!data.stepNumberCorrected,
        warningChecked: !!data.warningChecked,
        warningInjected: !!data.warningInjected,
        warningSkipReason: data.warningSkipReason || '',
        warningTypes: Array.isArray(data.warningTypes) ? data.warningTypes : [],
        forceGroundTruth: !!data.forceGroundTruth,
        oracleStep: data.oracleStep != null ? data.oracleStep : null,
        expectedUrl: data.expectedUrl || '',
        actualUrl: data.actualUrl || '',
        verificationPassed: data.verificationPassed != null ? data.verificationPassed : null,
        attempt: data.attempt != null ? data.attempt : null,
        hasShot: true,
        g_goal_relevance_score: goalRelevance
      }
    });
  } catch (e) { /* panel may be closed */ }

  try {
    let domSnapshot = '';
    try { if (typeof gv2SerializeDom === 'function') domSnapshot = gv2SerializeDom(); }
    catch (e) { console.warn('[guidev2] DOM snapshot failed:', e); }

    // Restorable state (web storage + scroll + form values) so a later restore
    // on a fresh load can rebuild the page condition without keeping a live tab around.
    let restore = null;
    try { if (typeof gv2CaptureRestoreState === 'function') restore = gv2CaptureRestoreState(); }
    catch (e) { /* restore capture is best-effort */ }

    // Region around the highlighted target. Auto mode always uses aligned capture (scroll target
    // into view, fresh screenshot, crop) so regionShot reflects the page BEFORE the action runs.
    let region = { targetRect: null, regionShot: null, regionDom: '', regionCaptureMode: 'legacy' };
    const alignedRegion = await _gv2ShouldUseAlignedRegionCapture(g);
    try { region = await gv2CaptureRegion(beforeShot, { aligned: alignedRegion }); } catch (e) { /* best-effort */ }

    const record = {
      sessionId: g.sessionId,
      step: data.step,
      planStep: data.planStep != null ? data.planStep : data.step,
      completedPlanStep: data.completedPlanStep != null ? data.completedPlanStep : null,
      completedPlanStepReason: data.completedPlanStepReason || '',
      plan: Array.isArray(data.plan) ? data.plan : null,
      timestamp: Date.now(),
      url: window.location.href,
      title: document.title || '',
      instruction: data.instruction || '',
      action: data.action || null,
      typeText: data.typeText != null ? data.typeText : null,
      isLastStep: !!data.isLastStep,
      target: data.target || null,
      confidence: data.confidence != null ? data.confidence : null,
      grounded: data.grounded != null ? data.grounded : null,
      loop: data.loop != null ? data.loop : null,
      progress: data.progress != null ? data.progress : null,
      confidenceFormula: data.confidenceFormula || null,
      mechConfidence: data.mechConfidence != null ? data.mechConfidence : null,
      mechGrounding: data.mechGrounding != null ? data.mechGrounding : null,
      elementStepSimilarity: data.elementStepSimilarity != null ? data.elementStepSimilarity : null,
      element_step_similarity: data.element_step_similarity != null ? data.element_step_similarity : null,
      mechLoop: data.mechLoop != null ? data.mechLoop : null,
      confidenceSource: data.confidenceSource || null,
      confirmation: data.confirmation || null,
      llmStep: data.llmStep != null ? data.llmStep : null,
      expectedStep: data.expectedStep != null ? data.expectedStep : null,
      stepNumberCorrected: !!data.stepNumberCorrected,
      warningChecked: !!data.warningChecked,
      warningInjected: !!data.warningInjected,
      warningSkipReason: data.warningSkipReason || '',
      warningTypes: Array.isArray(data.warningTypes) ? data.warningTypes : [],
      forceGroundTruth: !!data.forceGroundTruth,
      oracleStep: data.oracleStep != null ? data.oracleStep : null,
      oracleSubgoal: data.oracleSubgoal || '',
      expectedUrl: data.expectedUrl || '',
      actualUrl: data.actualUrl || '',
      verificationPassed: data.verificationPassed != null ? data.verificationPassed : null,
      attempt: data.attempt != null ? data.attempt : null,
      attemptHistory: Array.isArray(data.attemptHistory) ? data.attemptHistory : [],
      warningPrompt: data.warningPrompt || '',
      warningSystemPrompt: data.warningSystemPrompt || '',
      warningDiagnostic: data.warningDiagnostic || '',
      firstRawResponse: data.firstRawResponse || '',
      retryRawResponse: data.retryRawResponse || '',
      firstGroundingSimilarity: data.firstGroundingSimilarity != null ? data.firstGroundingSimilarity : null,
      firstGroundingSimilarityReason: data.firstGroundingSimilarityReason || '',
      firstGroundingSimilarityDetail: data.firstGroundingSimilarityDetail || '',
      firstLoopScore: data.firstLoopScore != null ? data.firstLoopScore : null,
      warningGroundingThreshold: data.warningGroundingThreshold != null ? data.warningGroundingThreshold : null,
      warningLoopThreshold: data.warningLoopThreshold != null ? data.warningLoopThreshold : null,
      firstReportedElementText: data.firstReportedElementText || '',
      firstResolvedElementText: data.firstResolvedElementText || '',
      firstActionKey: data.firstActionKey || '',
      retryGroundingSimilarity: data.retryGroundingSimilarity != null ? data.retryGroundingSimilarity : null,
      retryGroundingSimilarityReason: data.retryGroundingSimilarityReason || '',
      retryGroundingSimilarityDetail: data.retryGroundingSimilarityDetail || '',
      retryLoopScore: data.retryLoopScore != null ? data.retryLoopScore : null,
      retryReportedElementText: data.retryReportedElementText || '',
      retryResolvedElementText: data.retryResolvedElementText || '',
      retryActionKey: data.retryActionKey || '',
      durationMs: Date.now() - startedAt,
      // BEFORE-action screenshot (carried from the previous step's after-shot). The timeline shows
      // this. `screenshot` mirrors it for back-compat. The AFTER-action shot is added later by
      // gv2RecaptureAfterAction and shown only in "Inspect more".
      screenshot: beforeShot,
      screenshotBefore: beforeShot,
      domSnapshot,
      restore,
      targetRect: region.targetRect,
      regionShot: region.regionShot,
      regionDom: region.regionDom,
      regionCaptureMode: region.regionCaptureMode || (alignedRegion ? 'aligned' : 'legacy'),
      predictedGoalState: g.predictedGoalState || null,
      g_goal_relevance_score: goalRelevance,
      tutorialMatch: data.tutorialMatch || null,
      rawLlmJson: data.rawLlmJson || '',
      systemPrompt: data.systemPrompt || '',
      userPrompt: data.userPrompt || '',
      // DOM+Screenshot: the exact (clean, before-action) viewport image sent to the LLM this step.
      promptImage: g._pendingPromptImage || null
    };

    await rewindPutRecord(record);
  } catch (e) {
    console.warn('[guidev2] gv2CaptureStepRecord failed:', e);
  }
}

function _gv2CompletedStepNumber() {
  const g = window._guidev2;
  if (!g) return 0;
  return Number(g._lastActionStepNumber || g._activeStepNumber || (Array.isArray(g.previousSteps) ? g.previousSteps.length : 0)) || 0;
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

    // Carry this AFTER-shot forward: it becomes the NEXT step's before-shot (same page until the
    // next action), so we never take a second back-to-back capture for the next step.
    if (screenshot) {
      g._lastAfterShot = screenshot;
      g._lastAfterShotStep = Number(stepNumber);
    }

    let domSnapshot = '';
    try { if (typeof gv2SerializeDom === 'function') domSnapshot = gv2SerializeDom(); }
    catch (e) { /* best-effort */ }

    // Store the AFTER-action screenshot SEPARATELY — do NOT overwrite the before-shot or the
    // region crop (those belong to the pre-action moment when the target was highlighted). The
    // after-shot is surfaced only in "Inspect more".
    const patch = {
      url: window.location.href,
      title: document.title || '',
      afterCaptureStatus: screenshot ? 'captured' : 'missing'
    };
    if (screenshot) patch.screenshotAfter = screenshot;
    if (domSnapshot) patch.domSnapshotAfter = domSnapshot;
    // Refresh restorable state to reflect the post-action page (used by steer/resume).
    try { if (typeof gv2CaptureRestoreState === 'function') patch.restore = gv2CaptureRestoreState(); }
    catch (e) { /* best-effort */ }
    await rewindPatchRecord(g.sessionId, stepNumber, patch);
  } catch (e) {
    console.warn('[guidev2] gv2RecaptureAfterAction failed:', e);
  }
}

/**
 * Capture the "Initial State" node (step 0) at guide start: the page as it was before any
 * agent action. Stored like a step record (screenshot + DOM + restore + url + title) and
 * announced to the panel with `isInitial:true` so the timeline can show it as the first node.
 * Fire-and-forget.
 */
async function gv2CaptureInitialState() {
  const g = window._guidev2;
  if (!g || !g.captureEnabled || !g.sessionId) return;
  if (typeof rewindPutRecord !== 'function') return;
  try {
    let screenshot = null;
    try { if (typeof captureScreenshot === 'function') screenshot = await captureScreenshot(); }
    catch (e) { /* best-effort */ }
    // Carry forward so step 1's before-shot is this initial-state screenshot.
    if (screenshot) {
      g._lastAfterShot = screenshot;
      g._lastAfterShotStep = 0;
    }
    let domSnapshot = '';
    try { if (typeof gv2SerializeDom === 'function') domSnapshot = gv2SerializeDom(); }
    catch (e) { /* best-effort */ }
    let restore = null;
    try { if (typeof gv2CaptureRestoreState === 'function') restore = gv2CaptureRestoreState(); }
    catch (e) { /* best-effort */ }

    const record = {
      sessionId: g.sessionId, step: 0, planStep: 0, timestamp: Date.now(),
      url: window.location.href, title: document.title || '',
      instruction: 'Initial state', action: null, isInitial: true,
      isLastStep: false, target: null, confidence: null, durationMs: 0,
      screenshot: screenshot || null, screenshotBefore: screenshot || null,
      domSnapshot, restore, rawLlmJson: '', systemPrompt: '', userPrompt: ''
    };
    await rewindPutRecord(record);

    try {
      chrome.runtime.sendMessage({
        action: 'guideStepRecord',
        meta: {
          sessionId: record.sessionId, step: 0, planStep: 0,
          instruction: 'Initial state', isInitial: true,
          url: record.url, title: record.title, timestamp: record.timestamp
        }
      });
    } catch (e) { /* panel may be closed */ }
  } catch (e) {
    console.warn('[guidev2] gv2CaptureInitialState failed:', e);
  }
}

// ===== CORE GUIDANCE =====

// The eval runner's "Include Oracle Plan" option appends this marker plus the annotated
// ground-truth plan to the task query. When present we use ONLY the annotated ground truth
// and skip the (separately sourced, often unrelated) tutorial reference — see _handleStepByStepGuideV2.
const _GV2_ORACLE_PLAN_MARKER = 'ORACLE PLAN FROM THE ANNOTATED DATASET';
function _gv2QuestionHasOraclePlan(question) {
  return typeof question === 'string' && question.includes(_GV2_ORACLE_PLAN_MARKER);
}
if (typeof window !== 'undefined') window._gv2QuestionHasOraclePlan = _gv2QuestionHasOraclePlan;

/**
 * Start guidance for a new question (called by the router override at bottom of file).
 */
async function _handleStepByStepGuideV2(question) {
  _guidev2Stopped = false;
  await _gv2ClearStopMark(); // a fresh guide overrides any prior Stop tombstone
  // Look up a pre-verified tutorial ONCE at the start. Result is cached in
  // window._guidev2.tutorialRef so intermediate steps reuse it for free. Skip the lookup
  // entirely when the annotated oracle plan is already in the query — that ground truth
  // supersedes the tutorial reference (and skipping avoids the tutorial-matching LLM call).
  const match = _gv2QuestionHasOraclePlan(question)
    ? null
    : await _gv2FindTutorial(question, window.location.href);

  // Rewind (Slice 1): start a fresh capture session. sessionId rides along in the
  // persisted state so the resumed page on the next navigation keeps writing to it.
  const sessionId = 'gv2-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const captureEnabled = await _gv2IsCaptureEnabled();
  const autoMode = await _gv2IsAutoMode();
  const planningMode = await _gv2PlanningMode();
  const forceGroundTruth = await _gv2LoadForceGroundTruthConfig();

  window._guidev2 = {
    active: true,
    question,
    previousSteps: [],
    tutorialRef: match?.tutorial || null,
    tutorialReason: match?.reason || null,
    sessionId,
    captureEnabled,
    autoMode,
    planningMode,
    plan: [],
    planTitle: '',
    paused: false,
    lowConfidenceCount: 0,
    forceGroundTruth,
    _mechKeys: [],
    currentPlanStep: 1
  };

  if (captureEnabled && typeof rewindStartSession === 'function') {
    try { await rewindStartSession(sessionId, question); } catch (e) { /* non-fatal */ }
  }

  // Phase 1: capture the Initial State (node 0) before the first step, so the timeline shows
  // where the journey began (screenshot + URL + title + restorable state).
  // In parallel, predict the LLM final goal state for goal-relevance embedding.
  try {
    const phase1 = [
      gv2CaptureInitialState().catch((e) => console.warn('[guidev2] initial state capture failed:', e)),
    ];
    if (GV2_GOAL_RELEVANCE_ENABLED) {
      phase1.push(_gv2InitPredictedGoalState(window._guidev2).catch((e) => console.warn('[guidev2] goal prediction failed:', e)));
    }
    await Promise.all(phase1);
  } catch (e) { /* non-fatal */ }

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
  if (_gv2IsStopped()) return null;
  if (_gv2IsPaused()) {
    _gv2HideIndicator();
    gv2HideAutoOverlay();
    _gv2HidePanelTyping();
    return { success: false, progressed: false, error: 'Guide paused' };
  }

  const capResult = _gv2CheckStepCap(g);
  if (capResult) return capResult;

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
    if (_gv2IsStopped()) return null;
    if (_gv2IsPaused()) return { success: false, progressed: false, error: 'Guide paused' };
    pageIndex = createPageIndex(5000, true);
    if (pageIndex.count > 5) break;
    console.log('[guidev2] Sparse DOM (', pageIndex.count, 'el), retrying...');
    await new Promise(r => setTimeout(r, 700));
  }

  if (_gv2IsStopped()) return null;

  const curSig = (typeof gv2PageSignature === 'function')
    ? gv2PageSignature(pageIndex, window.location.href) : null;
  // Remember this page's signature so the NEXT auto-performed step has a "before" baseline.
  g._lastPageSig = curSig;

  const pageBg = getPageBackground();
  // Live overlay for the human watching (honors the user's persistent somEnabled toggle). The
  // model's screenshot gets its marks baked in below, not from this overlay.
  if (typeof showSomIfEnabled === 'function') await showSomIfEnabled(pageIndex);
  if (_gv2IsStopped()) return null;

  const stepNumber = g.previousSteps.length + 1;
  console.log('[guidev2] Generating step', stepNumber, 'with', pageIndex.count, 'elements');

  // DOM+Screenshot mode: capture the (clean, before-action) viewport ONCE here so every variant's
  // LLM call for this step — main reasoning, planning, force-ground-truth, and warning retry —
  // sends the same DOM text + screenshot. Stashed on `g` so those separate call sites can read it
  // and so this step's rewind record stores it reliably.
  const visionEnabled = await _gv2EvalVisionEnabled();
  let visionShot = visionEnabled ? await _gv2CaptureVisionShot() : null;
  // Bake the numbered [N] Set-of-Marks onto the captured bitmap so the image the model sees carries
  // the same indices as the PAGE INDEX text. Done on the screenshot (via canvas, using viewport
  // rects scaled to the image) rather than a DOM overlay, so the marks stay aligned with the
  // captured pixels regardless of the page's CSS positioning / transform / scroll container.
  if (visionShot && typeof _gv2DrawSomOnScreenshot === 'function') {
    visionShot = (await _gv2DrawSomOnScreenshot(visionShot, pageIndex)) || visionShot;
  }
  g._pendingPromptImage = visionShot || null;

  if (g.forceGroundTruth?.enabled) {
    return gv2GenerateForceGroundTruthStep(pageIndex, stepNumber);
  }

  if (stepNumber === 1 && g.planningMode === 'planning' && (!Array.isArray(g.plan) || !g.plan.length)) {
    _gv2ShowIndicator('Planning task…');
    await _gv2GenerateInitialPlan(g, pageIndex, pageBg);
    _gv2ShowIndicator('Agent thinking…');
  }

  // Use tutorial cached at session start (no repeated lookup or API call)
  let tutorialSection = '';
  if (g.tutorialRef) {
    tutorialSection = `\n=== TUTORIAL REFERENCE ===
Pre-verified steps for "${g.tutorialRef.task}" on ${g.tutorialRef.website}:
${g.tutorialRef.content.steps.join('\n')}
Use these as a reference guide but map each step to the actual elements visible in the PAGE INDEX above.
`;
  }

  const passHistory = await _gv2IsPassHistory();

  let completedStepsSection = '';
  let activeQuestion = g.question;

  if (g._steerRedoStep && g._steerMode === 'intent') {
    // Mode 2: Updating goal
    // Replace original goal with new intent
    activeQuestion = g._steerReason || activeQuestion;

    if (passHistory) {
      const originalTraj = g._originalTrajectory && g._originalTrajectory.length > 0
        ? g._originalTrajectory.join('\n')
        : 'None';
      completedStepsSection = `
=== ORIGINAL TRAJECTORY (Before Steering) ===
${originalTraj}

=== STEERING ===
The user restored the page to the state before Step ${g._steerRedoStep} and provided a completely new goal for the rest of the journey.
You must now abandon the old goal and fulfill the new USER GOAL, starting from Step ${stepNumber}.

=== COMPLETED STEPS (New Trajectory) ===
${g.previousSteps.length > 0 ? g.previousSteps.join('\n') : 'None — this is the first step'}
`;
    } else {
      completedStepsSection = `
=== COMPLETED STEPS ===
${g.previousSteps.length > 0 ? g.previousSteps.join('\n') : 'None — this is the first step'}
`;
    }

  } else if (passHistory && g._steerRedoStep) {
    // Mode 1: Fixing an error (and pass history is true)
    const originalTraj = g._originalTrajectory && g._originalTrajectory.length > 0
      ? g._originalTrajectory.join('\n')
      : 'None';

    let steerInstruction = `\nThe user restored the page to the state before Step ${g._steerRedoStep} because: "${g._steerReason || g._steerRedirection || 'The previous step was incorrect'}"`;

    if (g._steerFixed) {
      steerInstruction += `\nNOTE: The user has already manually corrected the error on the page. You should proceed with the next step as normal to fulfill the original goal.`;
    } else {
      steerInstruction += `\nYou must now generate Step ${stepNumber} to correct this error and fulfill the original goal.`;
    }

    completedStepsSection = `
=== ORIGINAL TRAJECTORY (Before Steering) ===
${originalTraj}

=== STEERING ===${steerInstruction}

=== COMPLETED STEPS (New Trajectory) ===
${g.previousSteps.length > 0 ? g.previousSteps.join('\n') : 'None — this is the first step'}
`;
  } else {
    completedStepsSection = `
=== COMPLETED STEPS ===
${g.previousSteps.length > 0 ? g.previousSteps.join('\n') : 'None — this is the first step'}
`;
  }

  const systemPrompt = GUIDE_V2_PROMPT;
  const userPrompt = `PAGE BACKGROUND: ${pageBg.isDark ? 'DARK' : 'LIGHT'}
CURRENT URL: ${window.location.href}

=== PAGE INDEX ===
${pageIndex.indexText}

=== USER GOAL ===
${activeQuestion}
${tutorialSection}
${_gv2PlanSection(g)}
=== CURRENT STEP ===
Step ${stepNumber}
${completedStepsSection}
Return JSON for Step ${stepNumber}`;

  try {

    const response = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: systemPrompt,
      messages: [{
        role: 'user',
        content: userPrompt
      }],
      imageBase64: visionShot || null,
      metadata: {
        mode: 'guide',
        step: stepNumber,
        url: window.location.href
      }
    });

    if (_gv2IsStopped()) return null;
    if (_gv2IsPaused()) return { success: false, progressed: false, error: 'Guide paused' };

    if (response?.error) {
      console.warn('[guidev2] LLM error:', response.error);
      _gv2HideIndicator();
      return { success: false, error: response.error };
    }
    if (response?.content) {
      let chosenContent = response.content;
      let warningMeta = null;
      const warningPrefs = await _gv2EvalWarningPrefs();
      const shouldCheckWarnings = g.autoMode && await _gv2IsEvalMode() && (warningPrefs.groundingEnabled || warningPrefs.loopEnabled);
      if (shouldCheckWarnings) {
        const firstCandidate = await _gv2ScoreCandidate(response.content);
        const decision = (typeof gv2WarningDecision === 'function')
          ? gv2WarningDecision({
              groundingEnabled: warningPrefs.groundingEnabled,
              loopEnabled: warningPrefs.loopEnabled,
              groundingThreshold: warningPrefs.groundingThreshold,
              loopThreshold: warningPrefs.loopThreshold,
              elementStepSimilarity: firstCandidate.elementStepSimilarity,
              loopScore: firstCandidate.loopScore
            })
          : { inject: false, types: [] };
        warningMeta = _gv2WarningMetaBase({
          firstCandidate,
          warningPrefs,
          decision,
          warningInjected: false
        });
        if (decision.inject) {
          const warningBlock = _gv2WarningPromptBlock(firstCandidate, decision);
          const retryUserPrompt = _gv2WarningRetryPrompt(userPrompt, warningBlock, response.content, stepNumber);
          console.warn('[guidev2] Eval warning injected before auto action:', decision.types);
          const retryResponse = await safeSendMessage({
            action: 'callLLM',
            systemPrompt,
            messages: [{ role: 'user', content: retryUserPrompt }],
            imageBase64: visionShot || null,
            metadata: {
              mode: 'guide_warning_retry',
              step: stepNumber,
              url: window.location.href,
              warningTypes: decision.types
            }
          });
          if (retryResponse?.error || !retryResponse?.content) {
            console.warn('[guidev2] Warning retry failed; using first response:', retryResponse?.error || 'No retry response');
            warningMeta = _gv2WarningMetaBase({
              firstCandidate,
              warningPrefs,
              decision,
              warningInjected: true,
              warningPrompt: retryUserPrompt,
              warningSystemPrompt: systemPrompt,
              warningDiagnostic: warningBlock,
              retryRawResponse: ''
            });
          } else {
            let retryCandidate = null;
            try {
              retryCandidate = await _gv2ScoreCandidate(retryResponse.content);
            } catch (retryScoreErr) {
              console.warn('[guidev2] Could not score warning retry response:', retryScoreErr);
            }
            if (!retryCandidate) {
              warningMeta = _gv2WarningMetaBase({
                firstCandidate,
                warningPrefs,
                decision,
                warningInjected: true,
                warningPrompt: retryUserPrompt,
                warningSystemPrompt: systemPrompt,
                warningDiagnostic: warningBlock,
                retryRawResponse: retryResponse.content
              });
            } else {
              chosenContent = retryResponse.content;
              warningMeta = {
                ..._gv2WarningMetaBase({
                  firstCandidate,
                  warningPrefs,
                  decision,
                  warningInjected: true,
                  warningPrompt: retryUserPrompt,
                  warningSystemPrompt: systemPrompt,
                  warningDiagnostic: warningBlock,
                  retryRawResponse: retryResponse.content
                }),
                retryGroundingSimilarity: retryCandidate.elementStepSimilarity,
                retryGroundingSimilarityReason: retryCandidate.elementStepSimilarityReason || '',
                retryGroundingSimilarityDetail: retryCandidate.elementStepSimilarityDetail || '',
                retryLoopScore: retryCandidate.loopScore,
                retryReportedElementText: retryCandidate.reportedElementText,
                retryResolvedElementText: retryCandidate.resolvedElementText,
                retryActionKey: retryCandidate.currentKey
              };
            }
          }
        }
      }
      const result = await gv2ProcessResponse(chosenContent, systemPrompt, userPrompt, warningMeta);
      if (_guidev2Stopped) return null;
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
 * Choose the indexed element for highlight + click. Prefer a text search hit, but when
 * the LLM index also matches the search text, keep the LLM index (avoids filter chips /
 * duplicate labels stealing the target from the intended sidebar link).
 */
function gv2PickTargetIndex(searchText, llmIndex) {
  const textIdx = gv2FindElementByText(searchText);
  if (textIdx == null) return llmIndex ?? null;
  if (llmIndex == null || textIdx === llmIndex) return textIdx;

  const indexMap = window._pageguideIndex;
  const el = indexMap?.[llmIndex];
  if (!el) return textIdx;

  const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const needle = normalize(searchText);
  if (needle.length < 2) return textIdx;

  let name;
  try {
    name = normalize(typeof getAccessibleName === 'function' ? (getAccessibleName(el) || '') : (el.textContent || ''));
  } catch (e) {
    return textIdx;
  }
  if (!name) return textIdx;

  const llmMatches = name === needle || name.includes(needle) || (name.length >= 5 && needle.includes(name));
  if (llmMatches) {
    console.log('[guidev2] Keeping LLM index', llmIndex, 'over text-match index', textIdx, 'for', searchText);
    return llmIndex;
  }
  return textIdx;
}

/**
 * Parse LLM JSON, apply highlight, schedule the appropriate action.
 */
async function gv2ProcessResponse(content, systemPrompt = '', userPrompt = '', warningMeta = null) {
  const g = window._guidev2;
  try {
    if (_gv2IsStopped()) return null;
    if (_gv2IsPaused()) return { success: false, progressed: false, error: 'Guide paused' };
    const step = (typeof gv2ExtractJsonObject === 'function')
      ? gv2ExtractJsonObject(content)
      : JSON.parse(content);
    if (!step) throw new Error('Could not parse step JSON');
    if (!step.instruction) throw new Error('LLM response JSON is missing instruction field');
    console.log('[guidev2] Parsed step:', step);

    const stepNumberInfo = (typeof gv2NormalizeStepNumber === 'function')
      ? gv2NormalizeStepNumber(step, g.previousSteps)
      : {
          expectedStep: (Array.isArray(g.previousSteps) ? g.previousSteps.length : 0) + 1,
          llmStep: Number.isFinite(Number(step.step)) ? Number(step.step) : null,
          stepNumberCorrected: Number(step.step) !== ((Array.isArray(g.previousSteps) ? g.previousSteps.length : 0) + 1)
        };
    if (stepNumberInfo.stepNumberCorrected) {
      console.warn('[guidev2] Correcting model step number', {
        llmStep: stepNumberInfo.llmStep,
        expectedStep: stepNumberInfo.expectedStep
      });
    }
    step.llmStep = stepNumberInfo.llmStep;
    step.expectedStep = stepNumberInfo.expectedStep;
    step.stepNumberCorrected = stepNumberInfo.stepNumberCorrected;
    step.step = stepNumberInfo.expectedStep;

    if (Number(step.step) > GV2_MAX_STEPS) {
      return _gv2StopForMaxSteps(g);
    }

    // LLM self-reported confidence: combine the model's grounded/loop/progress signals via the
    // selected formula (full = G·(1−λ_L·L)·(1+λ_P·P), reduced = G·(1−λ_L·L)). Falls back to the
    // legacy self-reported confidence when the model didn't emit a grounded score.
    const formula = await _gv2ConfidenceFormula();
    const conf = (typeof gv2ComputeConfidence === 'function')
      ? gv2ComputeConfidence({ grounded: step.grounded, loop: step.loop, progress: step.progress }, formula)
      : { confidence: null, grounded: null, loop: null, progress: null, formula };
    const llmConfidence = conf.confidence != null ? conf.confidence
      : ((typeof step.confidence === 'number' && isFinite(step.confidence))
          ? Math.max(0, Math.min(1, step.confidence)) : null);

    // Mechanical ("no-LLM") confidence: element-step cosine grounding × loop penalty.
    const action = String(step.action || (step.isLastStep ? 'done' : 'click')).toLowerCase().replace(/[\s-]+/g, '_');
    const hasIndex = step.element?.index != null && step.element?.index !== '';
    const hasText = !!(step.element?.text && String(step.element.text).trim());
    const textMatchIdx = step.element?.text ? gv2FindElementByText(step.element.text) : null;
    const resolvedElementText = _gv2ResolvedElementText(step);
    const metricElementText = resolvedElementText || step.element?.text || '';
    const elementStepSimilarity = await _gv2ElementStepSimilarity(step.instruction, metricElementText, hasIndex);
    const currentKey = (typeof gv2ElementKey === 'function')
      ? gv2ElementKey({ ...step, action, element: { ...(step.element || {}), text: metricElementText } })
      : '';
    const priorKeys = Array.isArray(g._mechKeys) ? g._mechKeys : (g._mechKeys = []);
    const mech = (typeof gv2ComputeMechanicalConfidence === 'function')
      ? gv2ComputeMechanicalConfidence({ action, hasIndex, hasText, elementStepSimilarity, priorKeys, currentKey })
      : { confidence: null, grounding: null, loop: null };
    // Record this step's action key for future loop detection. Every action is pushed
    // (not just target-bearing ones) so the loop denominator counts ALL previous actions,
    // matching the reference compute_loop_score.
    priorKeys.push(currentKey);

    // The ACTIVE confidence — what drives the timeline tier, the 3-strikes pause, and the red
    // highlight — is chosen by the source toggle: 'mechanical' uses the rule-based score, otherwise
    // the LLM self-report (default). Both are stored on the record regardless (side-by-side).
    const confSource = await _gv2ConfidenceSource();
    const confidence = (confSource === 'mechanical') ? mech.confidence : llmConfidence;
    let completedPlanStep = null;
    if (g.planningMode === 'planning' && Array.isArray(g.plan) && g.plan.length) {
      const rawCompleted = step.completedPlanStep;
      if (rawCompleted !== null && rawCompleted !== undefined && rawCompleted !== '') {
        completedPlanStep = _gv2MarkPlanComplete(g, rawCompleted);
      }
    } else if (typeof step.planStep === 'number' && step.planStep >= 1) {
      g.currentPlanStep = step.planStep;
    }
    const planStepForRecord = completedPlanStep || (g.planningMode === 'planning' ? (g.currentPlanStep || 1) : step.step);
    if (g.planningMode === 'planning' && g.sessionId && typeof rewindUpdateSessionMeta === 'function') {
      try {
        await rewindUpdateSessionMeta(g.sessionId, {
          plan: Array.isArray(g.plan) ? g.plan : [],
          planTitle: g.planTitle || '',
          currentPlanStep: g.currentPlanStep || 1,
          planningMode: g.planningMode
        });
      } catch (e) {}
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

      const idxToUse = gv2PickTargetIndex(step.element?.text, step.element?.index) ?? step.element?.index;

      if (textMatchIdx !== null && idxToUse === step.element.index && textMatchIdx !== step.element.index) {
        console.log(`[guidev2] Kept LLM index ${step.element.index} over text-match index ${textMatchIdx} for "${step.element.text}"`);
      } else if (textMatchIdx !== null && idxToUse === textMatchIdx && textMatchIdx !== step.element.index) {
        console.log(`[guidev2] Text-match override: LLM index ${step.element.index} → matched index ${textMatchIdx} for "${step.element.text}"`);
      } else if (textMatchIdx === null) {
        console.log(`[guidev2] No text match for "${step.element.text}", using LLM index ${step.element.index}`);
      }

      highlightCount = applyIndexedHighlight(idxToUse, step.element.text, style);
      const alignedRegionCapture = await _gv2ShouldUseAlignedRegionCapture(g);
      if (window._pageguideHighlights?.length > 0 && !alignedRegionCapture && !g.autoMode) {
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
    if (_gv2IsStopped()) return null;

    const isLast = !!step.isLastStep;
    g._activeStepNumber = Number(step.step) || (g.previousSteps.length + 1);
    g.previousSteps.push(`Step ${step.step}: ${step.instruction}${isLast ? ' ✓' : ''}`);

    // Simple dispatch: click | type | clear_text | done. (`action` computed above for G_ground.)
    const risk = (typeof gv2AssessRisk === 'function') ? gv2AssessRisk(step) : 'low';
    const isHighRisk = risk === 'high';
    g._lastAction = action;
    if (!isLast && action !== 'done') g._lastActionStepNumber = g._activeStepNumber;

    // Remember the live step so the panel "Next →" (manual mode) can perform it and advance.
    g._currentStep = { action, typeText: step.typeText, value: step.value, instruction: step.instruction, highRisk: isHighRisk };

    const forceTarget = g._forceGroundTruthPromptTarget || null;
    if (forceTarget && !isLast && action !== 'done') {
      g.forceGroundTruth = g.forceGroundTruth || { enabled: true, retries: 0, plan: [], cursor: 0, attempts: {}, pendingVerification: null };
      g.forceGroundTruth.pendingVerification = {
        step: forceTarget.step,
        subgoal: forceTarget.subgoal,
        expectedUrl: forceTarget.expectedUrl,
        attempt: forceTarget.attempt,
        generatedStep: g._activeStepNumber,
        action,
        index: step.element?.index ?? null
      };
    }

    // Pause conditions: 3 low-confidence actions, high risk (JSON), or confirmation needed (JSON)
    const isHighRiskJson = step.risk === 'high';
    const needsConfirmation = step.confirmation === 'needed';
    if (confidence !== null && confidence < 0.7) {
      g.lowConfidenceCount = (g.lowConfidenceCount || 0) + 1;
    }
    const willPause = (g.lowConfidenceCount >= 3) || isHighRiskJson || needsConfirmation;

    // Gate 1 (Risk) + hand-back override: the agent auto-performs only in Auto mode, for
    // low-risk actions, and not when a prior gate handed control back for this step or we need to pause.
    const forcedManual = !!g._forceManualNextStep;
    g._forceManualNextStep = false;
    const autoPerform = g.autoMode && !isHighRisk && !forcedManual && !willPause;
    let pauseAfterCaptureMessage = '';

    if (isLast || action === 'done') {
      // Clear state after capture runs at end of function
    } else if (action === 'type' || action === 'clear_text') {
      await _gv2SetState(false);
      if (!autoPerform) {
        if (willPause) {
          if (needsConfirmation) {
            pauseAfterCaptureMessage = 'Confirmation needed. Please verify and press Resume.';
          } else if (isHighRiskJson) {
            pauseAfterCaptureMessage = 'This step is high risk. Please perform it yourself, then press Resume.';
          } else {
            pauseAfterCaptureMessage = 'Page Guide paused: 3 low-confidence actions detected. Review and resume when ready.';
          }
        } else if (g.autoMode && isHighRisk) {
          const reason = step.riskReason ? ` (${step.riskReason})` : '';
          pauseAfterCaptureMessage = `This field looks sensitive${reason}. Type it yourself, then press Resume.`;
        } else {
          // Manual / handed-back: highlight the field; the user types and presses Next.
          _gv2SetupClickListener();
        }
      }
    } else {
      // click — defer pendingResume + listener until after capture when auto-performing
      if (!autoPerform) {
        await _gv2SetState(true);
        if (!willPause && !(g.autoMode && isHighRisk)) _gv2SetupClickListener();
        if (willPause) {
          if (needsConfirmation) {
            pauseAfterCaptureMessage = 'Confirmation needed. Please verify and press Resume.';
          } else if (isHighRiskJson) {
            pauseAfterCaptureMessage = 'This step is high risk. Please perform it yourself, then press Resume.';
          } else {
            pauseAfterCaptureMessage = 'Page Guide paused: 3 low-confidence actions detected. Review and resume when ready.';
          }
        } else if (g.autoMode && isHighRisk) {
          // High-risk click in auto mode → hand control back for this one.
          const reason = step.riskReason ? ` (${step.riskReason})` : '';
          pauseAfterCaptureMessage = `This step looks sensitive${reason}. Do it yourself, then press Resume.`;
        }
      }
    }

    _gv2HideIndicator();

    // Rewind: capture screenshot + target region + DOM snapshot BEFORE auto-performing the action.
    await gv2CaptureStepRecord({
      step: step.step,
      planStep: planStepForRecord,
      completedPlanStep,
      completedPlanStepReason: step.completedPlanStepReason || '',
      plan: Array.isArray(g.plan) ? g.plan : [],
      confidence,
      grounded: conf.grounded,
      loop: conf.loop,
      progress: conf.progress,
      confidenceFormula: conf.formula,
      // Mechanical ("no-LLM") confidence stored side-by-side with the LLM self-report.
      mechConfidence: mech.confidence,
      mechGrounding: mech.grounding,
      elementStepSimilarity,
      element_step_similarity: elementStepSimilarity,
      mechLoop: mech.loop,
      confidenceSource: confSource,
      confirmation: step.confirmation || null,
      llmStep: step.llmStep,
      expectedStep: step.expectedStep,
      stepNumberCorrected: step.stepNumberCorrected,
      instruction: step.instruction,
      action,
      typeText: (step.typeText != null ? step.typeText : step.value) || null,
      isLastStep: isLast,
      target: { text: metricElementText || step.element?.text || null, llmIndex: step.element?.index ?? null },
      rawLlmJson: content,
      systemPrompt,
      userPrompt,
      warningChecked: !!warningMeta?.warningChecked,
      warningInjected: !!warningMeta?.warningInjected,
      warningSkipReason: warningMeta?.warningSkipReason || '',
      warningTypes: Array.isArray(warningMeta?.warningTypes) ? warningMeta.warningTypes : [],
      warningPrompt: warningMeta?.warningPrompt || '',
      warningSystemPrompt: warningMeta?.warningSystemPrompt || '',
      warningDiagnostic: warningMeta?.warningDiagnostic || '',
      firstRawResponse: warningMeta?.firstRawResponse || '',
      retryRawResponse: warningMeta?.retryRawResponse || '',
      firstGroundingSimilarity: warningMeta?.firstGroundingSimilarity ?? null,
      firstGroundingSimilarityReason: warningMeta?.firstGroundingSimilarityReason || '',
      firstGroundingSimilarityDetail: warningMeta?.firstGroundingSimilarityDetail || '',
      firstLoopScore: warningMeta?.firstLoopScore ?? null,
      warningGroundingThreshold: warningMeta?.warningGroundingThreshold ?? null,
      warningLoopThreshold: warningMeta?.warningLoopThreshold ?? null,
      firstReportedElementText: warningMeta?.firstReportedElementText || '',
      firstResolvedElementText: warningMeta?.firstResolvedElementText || '',
      firstActionKey: warningMeta?.firstActionKey || '',
      retryGroundingSimilarity: warningMeta?.retryGroundingSimilarity ?? null,
      retryGroundingSimilarityReason: warningMeta?.retryGroundingSimilarityReason || '',
      retryGroundingSimilarityDetail: warningMeta?.retryGroundingSimilarityDetail || '',
      retryLoopScore: warningMeta?.retryLoopScore ?? null,
      retryReportedElementText: warningMeta?.retryReportedElementText || '',
      retryResolvedElementText: warningMeta?.retryResolvedElementText || '',
      retryActionKey: warningMeta?.retryActionKey || '',
      forceGroundTruth: !!forceTarget,
      oracleStep: forceTarget?.step ?? null,
      oracleSubgoal: forceTarget?.subgoal || '',
      expectedUrl: forceTarget?.expectedUrl || '',
      verificationPassed: null,
      attempt: forceTarget?.attempt ?? null,
      attemptHistory: forceTarget?.attemptHistory || [],
      tutorialMatch: (step.step === 1 && g.tutorialRef) ? {
        task: g.tutorialRef.task,
        website: g.tutorialRef.website,
        steps: g.tutorialRef.content.steps,
        reason: g.tutorialReason
      } : null
    });
    g._forceGroundTruthPromptTarget = null;

    // Auto-perform only after pre-action capture completes (regionShot + before-shot are stored).
    if (autoPerform && !isLast && action !== 'done') {
      if (action !== 'type') {
        await _gv2SetState(true);
        if (!willPause && !(g.autoMode && isHighRisk)) _gv2SetupClickListener();
      }
      _gv2ScheduleAutoPerformAfterCapture(g, step, action);
    }

    if (pauseAfterCaptureMessage && !isLast && action !== 'done') {
      await gv2PauseGuide(pauseAfterCaptureMessage);
    }

    if (isLast || action === 'done') {
      _gv2ClearState();
    }

    return {
      success: true,
      answer: step.instruction,
      step: step.step,
      planStep: planStepForRecord,
      completedPlanStep,
      completedPlanStepReason: step.completedPlanStepReason || '',
      plan: Array.isArray(g.plan) ? g.plan : [],
      isLastStep: isLast,
      targetText: step.element?.text || null,
      action,
      confidence,
      highlightCount,
      hasHighlights: highlightCount > 0,
      autoMode: !!g.autoMode,
      isGuide: true
    };

  } catch (e) {
    console.error('[guidev2] Parse error:', e);
    _gv2HideIndicator();
    if (typeof cleanupSom === 'function') cleanupSom();
    return { success: false, error: e.message || 'Could not parse step JSON' };
  }
}

async function gv2RetryGuideStep() {
  const g = window._guidev2;
  if (!g || !g.active) return { success: false, error: 'Guide not active' };
  g.paused = false;
  g.lowConfidenceCount = 0;
  await _gv2SetState(false);
  return _gv2GenerateAndDispatch();
}
if (typeof window !== 'undefined') window.gv2RetryGuideStep = gv2RetryGuideStep;

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
    if (_gv2IsStopped()) return;
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

/**
 * Should a failed gv2GenerateNextStep() result be retried? True only for *transient* failures
 * (empty/errored LLM response, sparse DOM, generic throw). False for terminal outcomes — a null
 * (stopped/inactive), a success, or an intentional stop (paused, max-steps, force-ground-truth,
 * already-continuing). Pure — unit-testable. Prevents one flaky next-step call from permanently
 * ending an eval task.
 */
function _gv2ShouldRetryGeneration(result) {
  if (!result) return false;                 // null → guide stopped/inactive; don't spin
  if (result.success !== false) return false; // success (or non-failure) → nothing to retry
  if (result.stoppedByMaxSteps || result.forceGroundTruthFailed) return false;
  const err = result.error || '';
  if (err === 'Guide paused' || err === 'Guide stopped' || err === 'Guide is already continuing') return false;
  return true;                               // transient (LLM empty/error, sparse DOM, …) → retry
}
if (typeof window !== 'undefined') window._gv2ShouldRetryGeneration = _gv2ShouldRetryGeneration;

/**
 * gv2GenerateNextStep() with a bounded retry on transient failures, so a single empty/errored LLM
 * response doesn't strand the auto-loop (which is the dominant cause of eval idle_timeouts). The
 * caller must already hold the _guidev2Resuming lock.
 */
async function _gv2GenerateNextStepResilient(maxTries = 3, backoffMs = 1200) {
  let result = null;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    if (_gv2IsStopped()) return result || { success: false, progressed: false, error: 'Guide stopped' };
    result = await gv2GenerateNextStep();
    if (!_gv2ShouldRetryGeneration(result)) return result;
    if (attempt < maxTries) {
      console.log(`[guidev2] next-step generation failed (attempt ${attempt}/${maxTries}) — retrying`, result?.error || '');
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  console.warn('[guidev2] next-step generation still failing after retries; ending continuation', result?.error || '');
  return result;
}
if (typeof window !== 'undefined') window._gv2GenerateNextStepResilient = _gv2GenerateNextStepResilient;

async function _gv2WaitForNavOrSettle(startUrl) {
  const POLL_MS = 100;
  const MAX_POLLS = 20; // 2 s

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));
    if (_gv2IsStopped()) {
      _gv2HidePanelTyping();
      return { success: false, progressed: false, navigated: false, capturedAfter: false, error: 'Guide stopped' };
    }

    // Full page navigation: pagehide has fired.
    // The SW port from this page is now (or about to be) disconnected.
    // The new page's content script will connect to SW and get the state.
    if (_guidev2PageHiding) {
      console.log('[guidev2] Full page navigation detected — new page will resume via SW');
      return { success: false, progressed: false, navigated: true, capturedAfter: false };
    }

    // SPA navigation: URL changed but page is still alive.
    if (window.location.href !== startUrl) {
      // Poll for up to 800 ms for pagehide — some sites (e.g. Amazon) push a new
      // history entry via JS *before* the full page unload.  400 ms was too short
      // for those cases; 800 ms with early exit keeps SPA detection responsive.
      for (let j = 0; j < 8; j++) {
        await new Promise(r => setTimeout(r, 100));
        if (_gv2IsStopped()) {
          _gv2HidePanelTyping();
          return { success: false, progressed: false, navigated: true, capturedAfter: false };
        }
        if (_guidev2PageHiding) {
          console.log('[guidev2] Full-page nav after URL change — new page will resume via SW');
          return { success: false, progressed: false, navigated: true, capturedAfter: false };
        }
      }
      console.log('[guidev2] SPA navigation confirmed');
      if (_gv2ResumeLockStuck()) { console.warn('[guidev2] releasing stale resume lock (SPA nav)'); _guidev2Resuming = false; }
      if (_guidev2Resuming) return { success: false, progressed: false, navigated: true, capturedAfter: false, error: 'Guide is already continuing' };
      _guidev2Resuming = true;  // Set BEFORE any await to prevent double-fire
      _guidev2ResumingSince = Date.now();
      try {
        // Give the SPA framework time to tear down the old view and render the
        // new one before we start the stability observer.  Without this initial
        // delay the observer can resolve on the OLD (static) DOM within 250 ms
        // and capture the wrong page.
        await new Promise(r => setTimeout(r, 600));
        if (_gv2IsStopped()) return { success: false, progressed: false, navigated: true, capturedAfter: false, error: 'Guide stopped' };
        await gv2WaitForDomStable(6000, 600);
        if (_gv2IsStopped()) return { success: false, progressed: false, navigated: true, capturedAfter: false, error: 'Guide stopped' };
        // Rewind: refresh the just-clicked step's snapshot with the post-click view.
        await gv2RecaptureAfterAction(_gv2CompletedStepNumber());
        if (_gv2IsStopped()) return { success: false, progressed: false, navigated: true, capturedAfter: true, error: 'Guide stopped' };
        const result = await _gv2GenerateNextStepResilient();
        if (!_guidev2Stopped && result && result.success !== false) {
          try { chrome.runtime.sendMessage({ action: 'guideStep', result }); } catch (e) {}
          return { success: true, progressed: true, navigated: true, capturedAfter: true };
        } else {
          try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
          return { success: false, progressed: false, navigated: true, capturedAfter: true, error: result?.error };
        }
      } finally {
        _guidev2Resuming = false;
      }
      return { success: false, progressed: false, navigated: true, capturedAfter: false };
    }
  }

  // No navigation after 2 s — same page (dropdown, modal, etc.)
  // One last guard: if pagehide fired during the polling loop it means a very
  // slow full-page navigation is in progress — let the new page handle it.
  if (_guidev2PageHiding) return { success: false, progressed: false, navigated: true, capturedAfter: false };
  if (_gv2IsStopped()) {
    _gv2HidePanelTyping();
    return { success: false, progressed: false, navigated: false, capturedAfter: false, error: 'Guide stopped' };
  }

  // Check if the click opened a new tab (target="_blank" / window.open).
  // In that case the SW has transferred guidance ownership to the new tab,
  // so this tab should stop — the new tab will resume on its own.
  try {
    const ownerCheck = await safeSendMessage({ action: 'guidanceV2_isOwner' });
    if (_gv2IsStopped()) {
      _gv2HidePanelTyping();
      return { success: false, progressed: false, navigated: false, capturedAfter: false };
    }
    if (ownerCheck && ownerCheck.isOwner === false) {
      console.log('[guidev2] Guidance transferred to new tab — stopping on this page');
      try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
      return { success: false, progressed: false, navigated: true, capturedAfter: false };
    }
  } catch (e) { /* SW unavailable — proceed with same-page behaviour */ }

  console.log('[guidev2] No navigation — continuing on same page');
  if (_gv2ResumeLockStuck()) { console.warn('[guidev2] releasing stale resume lock (same-page)'); _guidev2Resuming = false; }
  if (_guidev2Resuming) return { success: false, progressed: false, navigated: false, capturedAfter: false, error: 'Guide is already continuing' };
  _guidev2Resuming = true;
  _guidev2ResumingSince = Date.now();
  try {
    // Wait for DOM to settle (e.g. dropdown finished rendering)
    await gv2WaitForDomStable(2000, 300);
    if (_gv2IsStopped()) return { success: false, progressed: false, navigated: false, capturedAfter: false, error: 'Guide stopped' };
    // Rewind: refresh the just-clicked step's snapshot with the post-click view.
    await gv2RecaptureAfterAction(_gv2CompletedStepNumber());
    if (_gv2IsStopped()) return { success: false, progressed: false, navigated: false, capturedAfter: true, error: 'Guide stopped' };
    const result = await _gv2GenerateNextStepResilient();
    if (!_guidev2Stopped && result && result.success !== false) {
      try { chrome.runtime.sendMessage({ action: 'guideStep', result }); } catch (e) {}
      return { success: true, progressed: true, navigated: false, capturedAfter: true };
    } else {
      try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
      return { success: false, progressed: false, navigated: false, capturedAfter: true, error: result?.error };
    }
  } finally {
    _guidev2Resuming = false;
  }
}

// ===== AUTO-PERFORM (after pre-action capture) =====

/**
 * Schedule the agent to perform the current step AFTER gv2CaptureStepRecord finishes,
 * so target-region screenshots always reflect the highlighted DOM before the action.
 */
function _gv2ScheduleAutoPerformAfterCapture(g, step, action) {
  if (!g || !step) return;
  _gv2ClearActionTimers();
  if (action === 'type' || action === 'clear_text') {
    g._autoTypeTimer = setTimeout(() => {
      g._autoTypeTimer = null;
      if (_gv2IsStopped()) return;
      if (action === 'clear_text') _gv2AutoClearText(step);
      else _gv2AutoType(step);
    }, 200);
    return;
  }
  console.log('[guidev2] Auto mode: auto-performing low-risk click step', step.step);
  g._autoClickTimer = setTimeout(() => {
    g._autoClickTimer = null;
    if (!_gv2IsStopped() && typeof gv2NextStep === 'function') gv2NextStep();
  }, 900);
}
if (typeof window !== 'undefined') window._gv2ScheduleAutoPerformAfterCapture = _gv2ScheduleAutoPerformAfterCapture;

// ===== AUTO FORM EDITING =====

function _gv2EditableTarget() {
  const stored = window._guidev2?.currentTargetEl;
  const root = (stored && document.contains(stored))
    ? stored
    : document.querySelector('[data-pageguide-styled]');
  if (!root) return null;
  if (root.matches && root.matches('input,textarea,[contenteditable]')) return root;
  return root.querySelector ? root.querySelector('input,textarea,[contenteditable]') : null;
}

function _gv2IsContentEditable(el) {
  const hasAttr = !!(el?.hasAttribute && el.hasAttribute('contenteditable'));
  const attr = hasAttr ? String(el.getAttribute('contenteditable') || '').toLowerCase() : null;
  return !!(el && (el.isContentEditable || attr === '' || attr === 'true'));
}

function _gv2SetEditableValue(input, text) {
  if (!input) return false;
  try { input.focus(); } catch (e) {}
  if (_gv2IsContentEditable(input)) {
    try {
      const range = document.createRange();
      range.selectNodeContents(input);
      const sel = window.getSelection && window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      document.execCommand('insertText', false, text);
      if (text === '' && input.textContent !== '') {
        input.textContent = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (e) {
      input.textContent = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  try { input.select(); } catch (e) {}
  if (typeof gv2SetFieldValue === 'function') {
    gv2SetFieldValue(input, text);
  }
  if (input.value !== text) {
    const proto = input.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, text);
    else input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
}

async function _gv2ContinueAfterFormEdit(label) {
  try { await gv2RecaptureAfterAction(_gv2CompletedStepNumber()); } catch (e) { /* non-fatal */ }

  console.log(`[guidev2] ${label} done, generating next step...`);
  if (_gv2IsStopped()) return { success: false, progressed: false, error: 'Guide stopped' };
  if (_gv2ResumeLockStuck()) { console.warn('[guidev2] releasing stale resume lock (form edit)'); _guidev2Resuming = false; }
  if (_guidev2Resuming) return;
  _guidev2Resuming = true;
  _guidev2ResumingSince = Date.now();
  try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}
  try {
    const result = await _gv2GenerateNextStepResilient();
    if (!_guidev2Stopped && result && result.success !== false) {
      try { chrome.runtime.sendMessage({ action: 'guideStep', result }); } catch (e) {}
      return { success: true, progressed: true, result };
    }
    try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
    return { success: false, progressed: false, error: result?.error || `${label} did not continue` };
  } finally {
    _guidev2Resuming = false;
  }
}

/**
 * Agent fills a text field automatically using native input setters
 * so React / Vue / Angular state management picks up the change.
 */
async function _gv2AutoType(step) {
  if (_gv2IsStopped()) return { success: false, progressed: false, error: 'Guide stopped' };

  // Slice 5: canonical ACT/type carries text in `value`; legacy type used `typeText`.
  const typeText = (step.typeText != null) ? step.typeText : step.value;
  if (!typeText) {
    console.warn('[guidev2] autoType: no text to type in step');
  } else {
    const input = _gv2EditableTarget();

    if (!input) {
      console.warn('[guidev2] autoType: no input element found in highlighted area');
    } else {
      console.log('[guidev2] Auto-typing:', typeText);
      _gv2SetEditableValue(input, typeText);
      await new Promise(r => setTimeout(r, 400));
      if (_gv2IsStopped()) return { success: false, progressed: false, error: 'Guide stopped' };
    }
  }

  return _gv2ContinueAfterFormEdit('Auto-type');
}

async function _gv2AutoClearText(step) {
  if (_gv2IsStopped()) return { success: false, progressed: false, error: 'Guide stopped' };
  const input = _gv2EditableTarget();
  if (!input) {
    console.warn('[guidev2] autoClearText: no editable element found in highlighted area');
  } else {
    console.log('[guidev2] Auto-clearing text for step', step?.step);
    _gv2SetEditableValue(input, '');
    await new Promise(r => setTimeout(r, 250));
    if (_gv2IsStopped()) return { success: false, progressed: false, error: 'Guide stopped' };
  }
  return _gv2ContinueAfterFormEdit('Auto-clear text');
}
if (typeof window !== 'undefined') {
  window._gv2EditableTarget = _gv2EditableTarget;
  window._gv2SetEditableValue = _gv2SetEditableValue;
  window._gv2AutoClearText = _gv2AutoClearText;
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

  if (_gv2IsStopped()) {
    _gv2HidePanelTyping();
    return { success: false, progressed: false, error: 'Guide stopped' };
  }
  if (_gv2IsPaused()) {
    _gv2HidePanelTyping();
    return { success: false, progressed: false, error: 'Guide paused' };
  }

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
    // Manual "Next →" = "I performed this step, continue." The page now reflects the result,
    // so refresh the just-completed step's snapshot (post-action) before generating the next —
    // the user-click path does this via _gv2WaitForNavOrSettle, but the panel button doesn't.
    try { await gv2RecaptureAfterAction(_gv2CompletedStepNumber()); } catch (e) {}
    return continueGuide();
  }

  // Synthetic/internal form-edit continuation: low-risk known text can be typed by
  // the agent, clear_text can be performed by the agent, while high-risk or missing
  // text just continues after hand-back.
  if (cur && (cur.action === 'type' || cur.action === 'clear_text')) {
    if (cur.action === 'clear_text') {
      if (!cur.highRisk) {
        if (_gv2IsStopped()) return { success: false, progressed: false, error: 'Guide stopped' };
        return _gv2AutoClearText(cur);
      }
      return continueGuide();
    }
    const text = (cur.typeText != null) ? cur.typeText : cur.value;
    if (text && !cur.highRisk) {
      if (_gv2IsStopped()) return { success: false, progressed: false, error: 'Guide stopped' };
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

  if (_gv2IsStopped()) {
    _gv2HidePanelTyping();
    return { success: false, progressed: false, error: 'Guide stopped' };
  }

  if (toClick) {
    try { _gv2DispatchClick(toClick); } catch (e) { console.warn('[guidev2] Auto-click failed:', e); }
  } else {
    console.warn('[guidev2] No clickable element found — continuing without click');
  }

  // Use the same post-click flow as a real user click: detects full-page nav,
  // SPA nav, or same-page DOM settle, then generates the next step.
  const startUrl = window.location.href;
  const outcome = await _gv2WaitForNavOrSettle(startUrl);
  if (_gv2IsStopped()) return { success: false, progressed: false, error: 'Guide stopped' };
  if (outcome) return outcome;
  return continueGuide();
};

// ===== PAUSE / RESUME GUIDE =====

async function gv2PauseGuide(reason = '') {
  const g = window._guidev2;
  if (!g || !g.active) return { success: false, error: 'Guide not active' };
  g.paused = true;
  _gv2ClearActionTimers();
  _gv2RemoveClickListeners();
  _guidev2WaitingForClick = false;
  _guidev2Resuming = false;
  _gv2HideIndicator();
  gv2HideAutoOverlay();
  await _gv2SetState(false);
  try {
    chrome.runtime.sendMessage({
      action: 'guidePaused',
      reason: reason || 'Guide paused. Resume when you are ready for the agent to continue.'
    });
  } catch (e) {}
  _gv2HidePanelTyping();
  return { success: true, paused: true };
}
if (typeof window !== 'undefined') window.gv2PauseGuide = gv2PauseGuide;

async function _gv2HydrateResumeState() {
  const live = window._guidev2;
  if (live && live.active) return live;
  const saved = await gv2LoadFallback();
  if (!saved?.active) return null;
  window._guidev2 = {
    active: true,
    question: saved.question,
    previousSteps: saved.previousSteps || [],
    sessionId: saved.sessionId,
    captureEnabled: saved.captureEnabled,
    tutorialRef: saved.tutorialRef || null,
    tutorialReason: saved.tutorialReason || null,
    currentPlanStep: saved.currentPlanStep || 1,
    planningMode: saved.planningMode === 'direct' ? 'direct' : 'planning',
    plan: Array.isArray(saved.plan) ? saved.plan : [],
    planTitle: saved.planTitle || '',
    autoMode: saved.autoMode === true,
    paused: !!saved.paused,
    lowConfidenceCount: saved.lowConfidenceCount || 0,
    predictedGoalState: saved.predictedGoalState || null,
    forceGroundTruth: _gv2ForceStateFromSaved(saved),
    _lastActionStepNumber: saved.lastActionStepNumber || saved.activeStepNumber || (saved.previousSteps || []).length || null,
    _activeStepNumber: saved.activeStepNumber || null
  };
  return window._guidev2;
}

async function gv2ResumeGuide() {
  const g = await _gv2HydrateResumeState();
  if (!g || !g.active) return { success: false, error: 'Guide not active' };
  if (_guidev2Resuming) return { success: false, error: 'Guide is already continuing' };
  _guidev2Stopped = false;
  await _gv2ClearStopMark();
  g.paused = false;
  g.lowConfidenceCount = 0;
  await _gv2SetState(false);
  try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}
  await new Promise(r => setTimeout(r, 250));
  await gv2WaitForDomStable(5000, 500);
  try { await gv2RecaptureAfterAction(_gv2CompletedStepNumber()); } catch (e) {}
  return _gv2GenerateAndDispatch();
}
if (typeof window !== 'undefined') window.gv2ResumeGuide = gv2ResumeGuide;

async function gv2ManualRestoreHere() {
  const g = window._guidev2;
  if (!g || !g._awaitingRestoreConfirm) return { success: false, error: 'No restore review is active.' };
  try { gv2ShowRestoreOverlay('review', 'Restore manually, then confirm in the panel'); } catch (e) {}
  try {
    chrome.runtime.sendMessage({
      action: 'addMessage',
      content: 'You can restore the page yourself now. Press Confirm when the page matches the saved step.',
      type: 'info'
    });
  } catch (e) {}
  return { success: true };
}
if (typeof window !== 'undefined') window.gv2ManualRestoreHere = gv2ManualRestoreHere;

// ===== STOP GUIDE =====

/**
 * Called when the user presses the Stop button or resets the chat.
 * Aborts any in-progress generation and clears all guidance state.
 */
window.gv2StopGuide = function () {
  _gv2StopInternal();
  _gv2HidePanelTyping();
};

// ===== CONTINUATION HELPER =====
// Generates the next step and dispatches it to the panel (used after auto-type / manual
// type continue / take-control resume).

async function _gv2GenerateAndDispatch() {
  if (_gv2IsStopped()) {
    _gv2HidePanelTyping();
    return { success: false, progressed: false, error: 'Guide stopped' };
  }
  if (_guidev2Resuming) return { success: false, progressed: false, error: 'Guide is already continuing' };
  _guidev2Resuming = true;
  try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}
  try {
    if (_gv2IsStopped()) {
      _gv2HidePanelTyping();
      return { success: false, progressed: false, error: 'Guide stopped' };
    }
    const result = await gv2GenerateNextStep();
    if (result?.stoppedByMaxSteps) {
      return result;
    }
    if (_guidev2Stopped) {
      _gv2HidePanelTyping();
      return { success: false, progressed: false, error: 'Guide stopped' };
    }
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
  return gv2PauseGuide('You have control. Press Resume when you want the agent to continue.');
};

// ===== ROUTER INTEGRATION =====
// guidev2.js is injected after guide.js, so this assignment overrides guide.js.

window.handleStepByStepGuide = function (question, continueFromStep = false) {
  // continueFromStep=true comes from guide.js's continueGuidance() which won't fire
  // when v2 is active (_pageguideGuidance.active = false). Handle defensively anyway.
  if (continueFromStep) {
    const capResult = _gv2CheckStepCap(window._guidev2);
    if (capResult) return capResult;
    return gv2GenerateNextStep();
  }
  return _handleStepByStepGuideV2(question);
};

console.log('[guidev2] loaded — SW-based navigation, MutationObserver stability');
