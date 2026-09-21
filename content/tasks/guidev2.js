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
// window.handleStepByStepGuide is the router's entry point into the guide flow.

// Feature flag: disabled for now in favour of the deterministic Subgoal Progress score
// computed offline in the eval tool. When false, we skip the once-per-session
// predicted-final-goal-state LLM call and the per-step goal-relevance embedding.
const GV2_GOAL_RELEVANCE_ENABLED = false;

// ===== PROMPT (inline to keep guidev2.js self-contained) =====

const _GV2_PROMPTS = (typeof PROMPTS !== 'undefined')
  ? PROMPTS
  : ((typeof window !== 'undefined' && window.PROMPTS) ? window.PROMPTS : {});
const GUIDE_V2_PROMPT = _GV2_PROMPTS.GUIDE_V2_PROMPT || '';
const GUIDE_EVIDENCE_ANNOTATOR_PROMPT = _GV2_PROMPTS.GUIDE_EVIDENCE_ANNOTATOR || '';
const GUIDE_RECAP_SUMMARIZER_SYSTEM_PROMPT = _GV2_PROMPTS.GUIDE_RECAP_SUMMARIZER_SYSTEM || `You are a SUMMARIZER for a step-by-step web guide. You do NOT decide whether the task succeeded — the OUTCOME is already decided and given below. Never contradict it or re-judge success/failure. You are given INITIAL and FINAL screenshots when vision is available. The UI will turn summarySegments and stepEvaluations into inline visual references, so pin each meaningful phrase to the real step screenshot/action it describes. Reply with ONLY JSON:
{"reason":"one or two sentences describing the final state (for a failed run, what is missing)",
 "annotations":[{"x":0..1,"y":0..1,"w":0..1,"h":0..1,"label":"short final-state evidence label"}],
 "summary": "1-2 natural sentences. This is the ONLY top summary text the UI will display. Do NOT prefix it with any verdict phrase. Do NOT list screenshots here.",
 "summarySegments": [{"text": "brief metadata label for this linked phrase, not displayed when summary exists", "step": <completed step number or null>, "evidenceKey": "saved evidence key or null", "phrase": "<meaningful phrase copied verbatim from summary to make clickable>"}],
 "stepEvaluations": [{"step": <completed step number>, "status": "correct"|"wrong", "goalRelated": true|false, "goalRelatedReason": "brief reason whether this step helped the user goal", "text": "short visual-recap sentence for this exact step", "phrase": "<key noun phrase copied verbatim from text>", "errorLabel": "misgrounded"|"loop"|"low-confidence"|"risky"|"incomplete"|"wrong-action"|"other", "reason": "why this step was wrong"}]}
Rules:
- OUTCOME is authoritative. When OUTCOME is "completed": write "summary" as the ANSWER to the user — describe what the guide accomplished and the resulting state in a natural, user-facing sentence. Mark every step status="correct".
- When OUTCOME is "failed": the agent stopped before emitting a finish action. Do NOT claim success. Diagnose WHERE and WHY it broke down using the CONFIDENCE SIGNALS and trajectory: mark the failing step(s) status="wrong" with an errorLabel and a short reason, and make "summary" explain why it could not finish and at which step.
- Use the confidence signals to choose labels: high loop → "loop"; low grounding → "misgrounded"; low confidence with no clear cause → "low-confidence".
- Use 2 to 6 stepEvaluations, each a concrete step the guide actually took. "step" MUST be one of the completed step numbers listed below; do not invent steps. If there is only 1 completed step, return 1 stepEvaluation.
- Use 1 to 5 summarySegments to make the top summary visually grounded. summarySegments are NOT a second summary and are NOT displayed as separate text; they only wrap exact phrases inside "summary" with visual links.
- Every summarySegments.phrase MUST be copied exactly from "summary". Choose natural phrases in "summary" that the user would want to inspect visually, such as "facility hours page", "Sportsplex schedule", "4:00pm to 9:00pm", or "closed on other days".
- summarySegments.text may be a brief hidden label explaining what the phrase proves, but the visible UI will use "summary" plus the linked "phrase".
- For every summarySegments item, "step" MUST be one of the completed step numbers listed below when it references an action. Do not invent steps.
- For every summarySegments item that references saved evidence, set "evidenceKey" to the exact scratchpad key. You may also set "step" to that evidence's captured step. Example: {"text":"collected evidence that ESPN reported England and Argentina reached the semifinals","phrase":"ESPN reported England and Argentina reached the semifinals","evidenceKey":"espn_semifinals","step":4}.
- For every summarySegments item, "phrase" MUST be a short substring copied exactly from "summary"; it is the clickable visual reference. If unsure, edit "summary" so the phrase appears naturally.
- If the EVIDENCE SCRATCHPAD contains useful saved facts, include them in summarySegments when describing what the agent collected, e.g. "collected two article evidence items ...", with each evidence-backed phrase linked by evidenceKey and mentioning "captured at step N" when natural.
- Treat stepEvaluations as the detailed visual trail: each "text" should summarize the action/result for that step and be useful when the row itself is hovered/clicked.
- Prefer steps that have before/after screenshots, a target, saved evidence, or visual evidence. Include navigation/scroll steps only when they were meaningful for the goal.
- "text" should be a short standalone sentence under 100 characters, e.g. "Opened BBC News.", "Scrolled to the World Cup section.", "Saved the Messi article evidence.", "Confirmed the language changed to Spanish."
- "phrase" MUST be a short substring copied exactly from that step's "text" (the key thing acted on, e.g. "BBC News" or "World Cup section"). It becomes a hover-link to the screenshot of that action.
- For every stepEvaluation, set goalRelated=true only when the step plausibly helped the user goal; otherwise goalRelated=false with a brief goalRelatedReason.
- "annotations" are 1-4 boxes over the FINAL screenshot showing evidence (what changed, or what is missing). Coordinates are fractions of the final image (x,y top-left).
- Keep each "text" under 100 characters. No markdown.`;
const GUIDE_RECAP_SUMMARIZER_USER_TEMPLATE = _GV2_PROMPTS.GUIDE_RECAP_SUMMARIZER_USER || `USER GOAL: {{USER_GOAL}}
OUTCOME (already decided — do not change): {{OUTCOME_LINE}}
IMAGES PROVIDED:
- Initial state before the guide: {{HAS_INITIAL_IMAGE}}
- Final state after the guide: {{HAS_FINAL_IMAGE}}

{{PLAN_SECTION}}COMPLETED STEPS (step number: what was done):
{{COMPLETED_STEPS}}

CONFIDENCE SIGNALS BY STEP:
{{CONFIDENCE_SIGNALS}}

VISUAL EVIDENCE BY STEP:
{{VISUAL_EVIDENCE_BY_STEP}}

IMPORTANT FOR VISUAL RECAP:
- The UI will render ONLY "summary" as the top prose, with summarySegments.phrase wrapped as inline clickable visual references inside that exact summary.
- The UI will render stepEvaluations as the detailed reasoning-trail rows.
- Choose summarySegments.step, summarySegments.evidenceKey, and stepEvaluation.step values that point to the screenshot/action/evidence the user should inspect for that phrase.
- summarySegments.phrase must appear verbatim in "summary"; otherwise the UI cannot link it.
- summarySegments may reference saved evidence by exact evidenceKey from the EVIDENCE SCRATCHPAD. Example: if summary says "I found the Messi article and the semi-final preview.", use {"text":"Messi article evidence","phrase":"Messi article","evidenceKey":"messi_england_article","step":2}.
- Do not write a separate "Visual recap:" list in summary.

EVIDENCE SCRATCHPAD:
{{EVIDENCE_SCRATCHPAD}}

Return the recap JSON.`;
const PERSONALIZATION_PROFILE_UPDATER_SYSTEM_PROMPT = _GV2_PROMPTS.PERSONALIZATION_PROFILE_UPDATER_SYSTEM || `You maintain a compact rolling profile of a user based on their PageGuide usage. Merge the PRIOR PROFILE and the TASK TRAJECTORY into an updated profile. Reply with ONLY JSON: {"summary": "updated rolling profile, third person, under 1500 characters"}. Merge, don't append; drop stale details; never record secrets or sensitive categories.`;
const PERSONALIZATION_PROFILE_UPDATER_USER_TEMPLATE = _GV2_PROMPTS.PERSONALIZATION_PROFILE_UPDATER_USER || `PRIOR PROFILE:\n{{PRIOR_PROFILE}}\n\nMANUAL FACTS:\n{{MANUAL_FACTS}}\n\nTASK GOAL: {{USER_GOAL}}\nOUTCOME: {{OUTCOME}}\nTRAJECTORY:\n{{TRAJECTORY}}\n\nReturn the updated profile JSON.`;

if (typeof window !== 'undefined') window.GUIDE_V2_PROMPT = GUIDE_V2_PROMPT;
if (typeof window !== 'undefined') window.GUIDE_EVIDENCE_ANNOTATOR_PROMPT = GUIDE_EVIDENCE_ANNOTATOR_PROMPT;
if (typeof window !== 'undefined') window.GUIDE_RECAP_SUMMARIZER_SYSTEM_PROMPT = GUIDE_RECAP_SUMMARIZER_SYSTEM_PROMPT;
if (typeof window !== 'undefined') window.GUIDE_RECAP_SUMMARIZER_USER_TEMPLATE = GUIDE_RECAP_SUMMARIZER_USER_TEMPLATE;

// ===== CONSTANTS =====

const _GV2_KEY = 'pageguideGuidanceV2';
const _GV2_MAX_AGE = 10 * 60 * 1000; // 10 minutes

// ===== PAGE INDICATOR =====

const _GV2_INDICATOR_ID = 'pageguide-gv2-indicator';
let _gv2IndicatorInjected = false;

function _gv2ShowIndicator(text = 'Agent thinking…') {
  try { chrome.runtime.sendMessage({ action: 'guideWorkingStatus', status: text }); } catch (e) {}
}

function _gv2HideIndicator() {
  const el = document.getElementById(_GV2_INDICATOR_ID);
  if (el) el.remove();
  try { chrome.runtime.sendMessage({ action: 'guideWorkingStatus', status: '' }); } catch (e) {}
}

function _gv2ActionStatus(action, step = null) {
  const a = String(action || '').toLowerCase();
  const target = String(step?.element?.text || step?.instruction || '').replace(/\s+/g, ' ').trim();
  const shortTarget = target ? ` “${target.slice(0, 48)}${target.length > 48 ? '…' : ''}”` : '';
  if (a === 'click') return `Agent clicking${shortTarget}…`;
  if (a === 'drag_drop') return `Agent dragging${shortTarget}…`;
  if (a === 'type') return 'Agent typing…';
  if (a === 'clear_text') return 'Agent clearing text…';
  if (a === 'scroll_down') return 'Agent scrolling down…';
  if (a === 'scroll_up') return 'Agent scrolling up…';
  if (a === 'goto_url' || a === 'navigate') return 'Agent going to URL…';
  if (a === 'watch_video') return 'Agent watching video…';
  if (a === 'find') return 'Reading page…';
  if (a === 'finish') return 'Preparing final answer…';
  if (a === 'highlight') return 'Preparing next step…';
  return 'Agent working…';
}

function _gv2SetWorkingStatus(text) {
  _gv2ShowIndicator(text || 'Agent working…');
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

// Flag set when a click step is awaiting user action
let _guidev2WaitingForClick = false;

// Flag set when the user explicitly stops the guide
let _guidev2Stopped = false;

// Hard safety cap for concrete Guide v2 steps.
let GV2_MAX_STEPS = 20;
const GV2_LOOP_STOP_THRESHOLD = 0.3;
try {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(['maxSteps']).then(res => {
      if (res && typeof res.maxSteps === 'number') GV2_MAX_STEPS = res.maxSteps;
    });
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'sync' && changes.maxSteps && typeof changes.maxSteps.newValue === 'number') {
        GV2_MAX_STEPS = changes.maxSteps.newValue;
      }
    });
  }
} catch (e) {}

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
  const stoppedSessionId = window._guidev2?.sessionId || null;
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
  _gv2MarkStopped(stoppedSessionId);
  try { if (typeof rewindClearSteerPending === 'function') rewindClearSteerPending(); } catch (e) {}
}

function _gv2MaxStepMessage(g = window._guidev2) {
  return g?.autoMode
    ? `Stopped after ${GV2_MAX_STEPS} steps to avoid an autonomous loop or drifting from the plan.`
    : `Stopped after ${GV2_MAX_STEPS} steps to avoid looping or drifting from the plan.`;
}

function _gv2StopForMaxSteps(g = window._guidev2) {
  const message = _gv2MaxStepMessage(g);
  // Snapshot what the Final-State verdict needs BEFORE state is cleared below.
  let snap = null;
  try {
    const steps = Array.isArray(g?.previousSteps) ? g.previousSteps : [];
    const validSteps = steps
      .map(s => { const m = /^Step\s+(\d+)/.exec(String(s || '').trim()); return m ? Number(m[1]) : null; })
      .filter(n => Number.isFinite(n) && n > 0);
    snap = { sessionId: g?.sessionId, question: g?.question, steps,
             finalStep: validSteps.length ? Math.max.apply(null, validSteps) : null };
  } catch (e) {}
  _gv2StopInternal();
  _gv2HidePanelTyping();
  try {
    chrome.runtime.sendMessage({ action: 'addMessage', content: message, type: 'system' });
  } catch (e) {}
  // Fire-and-forget the optional failed-run summary. Hitting the step cap is deterministically a
  // FAILED run (no finish action), so when enabled the summarization agent diagnoses why/where it
  // broke down — it never judges success.
  (async () => {
    try {
      if (!(await _gv2IsEndSummaryOn())) return;
      const recap = await _gv2BuildRecap(g, 'failed');
      if (recap) chrome.runtime.sendMessage({ action: 'guideRecap', recap });
    } catch (e) { /* non-fatal */ }
  })();
  _gv2UpdatePersonalizedProfile(g, 'failed');
  return { success: false, progressed: false, error: message, stoppedByMaxSteps: true };
}

function _gv2CheckStepCap(g = window._guidev2) {
  const completedSteps = Array.isArray(g?.previousSteps) ? g.previousSteps.length : 0;
  if (completedSteps + 1 > GV2_MAX_STEPS) return _gv2StopForMaxSteps(g);
  return null;
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
        personalizationContext: s.personalizationContext || '',
        currentPlanStep: s.currentPlanStep,
        autoMode: s.autoMode,
        autonomyLevel: s.autonomyLevel || (s.autoMode ? 'auto' : 'manual'),
        paused: !!s.paused,
        lowConfidenceCount: s.lowConfidenceCount || 0,
        loopStepCount: s.loopStepCount || 0,
        predictedGoalState: s.predictedGoalState || null,
        mechKeys: Array.isArray(s._mechKeys) ? s._mechKeys : [],
        mechElementTexts: Array.isArray(s._mechElementTexts) ? s._mechElementTexts : [],
        guidePlan: Array.isArray(s.guidePlan) ? s.guidePlan : [],
        guideTitle: s.guideTitle || '',
        lastActionStepNumber: s._lastActionStepNumber || null,
        activeStepNumber: s._activeStepNumber || null,
        lastUrl: window.location.href,
        timestamp: Date.now(),
        ...extra
      }
    });
  } catch (e) { /* ignore */ }
}

/**
 * The saved run, if there is one worth having.
 *
 * The age limit exists to stop a forgotten run from waking up by itself on an unrelated page, so it
 * belongs to the AUTOMATIC resume path only — a person pressing Resume is asking for that exact
 * run, however long they spent reading it first, and they get it by passing maxAge: Infinity.
 *
 * Staleness no longer DELETES the state either. A stale read on some other page used to wipe the
 * only copy of a parked run, so a pause the user came back to after ten minutes answered "Guide not
 * active". Session storage is emptied when the browser session ends, and a stop or a new run clears
 * it explicitly; nothing needs this read to do it.
 *
 * @param {object} [opts] - { maxAge } how old the state may be, in ms
 */
async function gv2LoadFallback({ maxAge = _GV2_MAX_AGE } = {}) {
  try {
    const r = await chrome.storage.session.get(_GV2_KEY);
    const saved = r[_GV2_KEY];
    if (!saved) return null;
    if (Number.isFinite(maxAge) && Date.now() - (saved.timestamp || 0) > maxAge) return null;
    return saved;
  } catch (e) { return null; }
}

/**
 * Drop the saved run.
 *
 * Scoped by session for the same reason the stop tombstone is: a clear belonging to a run that has
 * ended must never delete the run that started after it. Called with no id it clears whatever is
 * there, which is what a reset wants.
 *
 * @param {string|null} sessionId - only clear the state if it belongs to this run
 */
async function gv2ClearFallback(sessionId = null) {
  try {
    if (sessionId) {
      const r = await chrome.storage.session.get(_GV2_KEY);
      const saved = r[_GV2_KEY];
      if (saved && saved.sessionId && String(saved.sessionId) !== String(sessionId)) return;
    }
    await chrome.storage.session.remove(_GV2_KEY);
  } catch (e) {}
}
if (typeof window !== 'undefined') window.gv2ClearFallback = gv2ClearFallback;

// ===== STOP TOMBSTONE =====
// `_guidev2Stopped` is in-memory and does NOT survive a navigation, so after the user clicks
// Stop a pending page-load (from the agent's own click) could otherwise resume the agent on the
// next page. This persisted marker is checked by the resume paths and is cleared only when the
// user intentionally starts a new guide or steers.
//
// It names the run it kills. Stopping a run and starting the next one are two unordered async
// writes — _gv2StopInternal fires the mark without awaiting it, because it is called from a
// synchronous stop — so a mark from the OLD run could land after the new run had already cleared
// it, and then the new run died the moment it navigated: "resume suppressed — user stopped the
// guide". Identity settles that without having to order the writes: a tombstone for session A
// cannot suppress session B. It also stops a Stop in one tab from killing a run in another.
const _GV2_STOP_KEY = 'pageguideGuidanceV2Stopped';
async function _gv2MarkStopped(sessionId = null) {
  try {
    await chrome.storage.session.set({
      [_GV2_STOP_KEY]: { sessionId: sessionId ? String(sessionId) : null, at: Date.now() }
    });
  } catch (e) {}
}

/**
 * Is THIS run the one that was stopped?
 *
 * An unattributed mark (the older number-only shape, or a stop with no session in hand) still
 * suppresses everything — it is the conservative reading, and suppressing a resume is recoverable
 * where resuming a stopped agent is not.
 *
 * @param {string|null} sessionId - the run about to be resumed
 */
async function _gv2IsStopMarked(sessionId = null) {
  try {
    const r = await chrome.storage.session.get(_GV2_STOP_KEY);
    const mark = r[_GV2_STOP_KEY];
    if (!mark) return false;
    const markedSession = (mark && typeof mark === 'object') ? mark.sessionId : null;
    if (!markedSession || !sessionId) return true;
    return String(markedSession) === String(sessionId);
  } catch (e) { return false; }
}
if (typeof window !== 'undefined') {
  window._gv2MarkStopped = _gv2MarkStopped;
  window._gv2IsStopMarked = _gv2IsStopMarked;
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

async function _gv2WaitForPageReady(maxWait = 10000) {
  try {
    if (document.readyState === 'loading') {
      await new Promise(resolve => {
        const t = setTimeout(resolve, maxWait);
        window.addEventListener('load', () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
    }
  } catch (e) { /* best-effort */ }
  try { await gv2WaitForDomStable(Math.min(maxWait, 8000), 700); } catch (e) { /* best-effort */ }
}

// ===== RESUME AFTER NAVIGATION =====

/**
 * What to do with a run whose first step on a freshly-loaded page could not be generated. Pure.
 *
 * The failure is almost always a bad FIRST READ of a page that has only just loaded: a screenshot
 * the capture API rate-limited, a model call that failed, a heavy page still settling. The IDENTICAL
 * failure on the same page only reports an error and leaves the run resumable
 * (_gv2GenerateAndDispatch) — but this path used to clear window._guidev2, the service worker's
 * session AND session storage, so one hiccup after a navigation destroyed the run outright and every
 * later Resume answered "Guide not active". Nothing could bring it back.
 *
 * So only the outcomes that MEAN to end a run end it. Everything else parks the run, paused, where
 * the user's Resume can pick it up.
 *
 * @param {object|null} result - what gv2GenerateNextStep returned
 * @returns {'paused'|'terminal'|'retry'|'park'}
 */
function _gv2ResumeFailureDisposition(result) {
  const errText = String(result?.error || '');
  if (/Guide paused/i.test(errText)) return 'paused';
  if (result?.stoppedByMaxSteps || /Guide stopped/i.test(errText)) return 'terminal';
  if (/Could not parse step JSON/i.test(errText)) return 'retry';
  return 'park';
}
if (typeof window !== 'undefined') window._gv2ResumeFailureDisposition = _gv2ResumeFailureDisposition;

/**
 * Restore guidance state from `state` (from SW or session storage),
 * wait for the new page's DOM to settle, then generate the next step.
 */
async function _gv2ResumeFromState(state) {
  if (_guidev2Resuming) {
    console.log('[guidev2] Already resuming, ignoring duplicate resume signal');
    return;
  }
  // Honor a Stop that happened before this navigation finished — don't auto-wake the agent. Scoped
  // to the run being resumed: a tombstone left by an earlier run must not kill this one.
  if (await _gv2IsStopMarked(state?.sessionId || null)) {
    console.log('[guidev2] resume suppressed — user stopped the guide');
    try { chrome.runtime.sendMessage({ action: 'guidanceV2_clearState', sessionId: state?.sessionId || null }); } catch (e) {}
    try { await gv2ClearFallback(state?.sessionId || null); } catch (e) {}
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
    personalizationContext: state.personalizationContext || '',
    currentPlanStep: state.currentPlanStep || 1,
    autoMode: state.autoMode === true,
    autonomyLevel: _gv2NormalizeAutonomyLevel(state.autonomyLevel, state.autoMode === true),
    paused: false,
    lowConfidenceCount: state.lowConfidenceCount || 0,
    loopStepCount: state.loopStepCount || 0,
    _mechKeys: Array.isArray(state.mechKeys) ? state.mechKeys : [],
    _mechElementTexts: Array.isArray(state.mechElementTexts) ? state.mechElementTexts : [],
    guidePlan: Array.isArray(state.guidePlan) ? state.guidePlan : [],
    guideTitle: state.guideTitle || '',
    // Attachment text carries across navigations; the raw image is not re-attached
    // after the first step (attachmentImage stays null on resume).
    attachmentContext: state.attachmentContext || '',
    attachmentImage: null,
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
      switch (_gv2ResumeFailureDisposition(result)) {
        case 'paused':
          // Pausing can race an in-flight resume/generate path. Preserve the guide so Resume works.
          break;
        case 'terminal':
          // _gv2StopForMaxSteps / gv2StopGuide already cleared what they own.
          break;
        case 'retry':
          await _gv2SetState(false);
          break;
        default: // 'park'
          window._guidev2.active = true;
          window._guidev2.paused = true;
          await _gv2SetState(false);
          try {
            chrome.runtime.sendMessage({
              action: 'guidePaused',
              reason: 'Could not read this page just now — press Resume to try again.'
            });
          } catch (e) {}
      }
    }
  } catch (e) {
    console.error('[guidev2] Resume error:', e);
    try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e2) {}
  } finally {
    _guidev2Resuming = false;
  }
}

if (typeof window !== 'undefined') window._gv2ResumeFromState = _gv2ResumeFromState;

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
    let restoredPlan = [];
    let restoredTitle = '';
    
    if (typeof rewindGetIndex === 'function') {
      const idx = await rewindGetIndex(payload.sessionId);
      if (idx && idx.goal) goal = idx.goal;
      if (idx) {
        restoredPlan = Array.isArray(idx.guidePlan) ? idx.guidePlan : (Array.isArray(idx.plan) ? idx.plan : []);
        restoredTitle = idx.guideTitle || '';
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
    const autonomyLevel = await _gv2AutonomyLevel();
    const autoMode = autonomyLevel !== 'manual';
    // Tutorial lookup is best-effort — never let it block or break the steer.
    let match = null;
    try { match = await _gv2FindTutorial(question, window.location.href); } catch (e) { console.warn('[guidev2] steer tutorial lookup failed:', e); }
    const personalizationContext = await _gv2LoadPersonalizationContext();

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
      personalizationContext,
      sessionId: payload.sessionId,
      captureEnabled,
      autoMode,
      autonomyLevel,
      paused: false,
      lowConfidenceCount: 0,
      loopStepCount: 0,
      _mechKeys: [],
      _mechElementTexts: kept
        .map(r => _gv2NormalizeDomText(r.target?.domText || r.target?.text || r.instruction))
        .filter(Boolean),
      guidePlan: restoredPlan,
      guideTitle: restoredTitle,
      _planAttempted: Array.isArray(restoredPlan) && restoredPlan.length > 0,
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
    dropTarget: r.dropTarget || null,
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
    rec({
      kind: 'replay',
      action: String(r.action || 'click').toLowerCase(),
      target: { text: r.target && r.target.text },
      dropTarget: r.dropTarget || null,
      value: r.typeText,
      ok
    });
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
  // find only reads the page — there is no target to resolve and nothing to re-apply.
  // Must come before the target guard below, or replay would abort the whole chain.
  const kind = (typeof gv2ReplayKind === 'function') ? gv2ReplayKind(r.action) : null;
  if (kind === 'noop') return true;

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
  } else if (kind === 'drag_drop') {
    const drop = _gv2ResolveDropTarget(r.dropTarget);
    if (!drop || (!drop.el && !drop.point)) return false;
    return _gv2DispatchDragDrop(el, drop);
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
 * Can this action take the page out from under us?
 *
 * `pendingResume` is the ONLY thing that lets a run survive a navigation: the fresh page's content
 * script resumes solely when the stored state has it set (_gv2HandleSwMessage and
 * _gv2CheckSessionStorageFallback both gate on it), and otherwise goes quiet with no error. It used
 * to be set for click steps alone, so a `type` that submits (Enter in a search box, an autosubmit
 * form) or a manual `goto_url` navigated away with the flag false and silently killed the run.
 *
 * So the flag is armed for every action that CAN navigate, and disarmed again by
 * _gv2ContinueAfterFormEdit once the page has proved it is still alive. Arming it wrongly costs one
 * resume that re-reads the same page; leaving it unarmed ends the run.
 *
 * @param {string} action - the step's action verb
 * @returns {boolean} true when the step may end in a page load
 */
function _gv2ActionExpectsNavigation(action) {
  const a = String(action || '').toLowerCase();
  return a === 'click' || a === 'type' || a === 'clear_text' || a === 'goto_url' || a === 'drag_drop';
}

/**
 * Push guidance state to SW memory (primary) and session storage (fallback).
 * @param {boolean} pendingResume - true when the active step may navigate (_gv2ActionExpectsNavigation)
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
    personalizationContext: s.personalizationContext || '',
    currentPlanStep: s.currentPlanStep,
    lastActionStepNumber: s._lastActionStepNumber || null,
    activeStepNumber: s._activeStepNumber || null,
    // Mode: carry Manual/Auto across navigations.
    autoMode: s.autoMode,
    autonomyLevel: s.autonomyLevel || (s.autoMode ? 'auto' : 'manual'),
    paused: !!s.paused,
    lowConfidenceCount: s.lowConfidenceCount || 0,
    loopStepCount: s.loopStepCount || 0,
    predictedGoalState: s.predictedGoalState || null,
    // Mechanical confidence: carry the loop-detection key list across navigations.
    mechKeys: Array.isArray(s._mechKeys) ? s._mechKeys : [],
    mechElementTexts: Array.isArray(s._mechElementTexts) ? s._mechElementTexts : [],
    guidePlan: Array.isArray(s.guidePlan) ? s.guidePlan : [],
    guideTitle: s.guideTitle || '',
    // Compact attachment text survives navigation (raw image intentionally does not).
    attachmentContext: s.attachmentContext || ''
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
    autonomyLevel: s.autonomyLevel || (s.autoMode ? 'auto' : 'manual'),
    lowConfidenceCount: s.lowConfidenceCount || 0,
    loopStepCount: s.loopStepCount || 0,
    lastActionStepNumber: s._lastActionStepNumber || null,
    activeStepNumber: s._activeStepNumber || null,
    mechElementTexts: Array.isArray(s._mechElementTexts) ? s._mechElementTexts : [],
    guidePlan: Array.isArray(s.guidePlan) ? s.guidePlan : [],
    guideTitle: s.guideTitle || ''
  });
}

function _gv2ClearState() {
  // Read before active is flipped: every clear below names the run it is ending, so a clear that
  // lands late (these are all fire-and-forget) cannot delete the next run's state.
  const sessionId = window._guidev2?.sessionId || null;
  window._guidev2.active = false;
  _gv2HideIndicator();
  gv2HideAutoOverlay();
  gv2HideRestoreOverlay();

  // Clear from SW
  try { chrome.runtime.sendMessage({ action: 'guidanceV2_clearState', sessionId }); } catch (e) {}

  // Clear session storage
  gv2ClearFallback(sessionId);
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
const _GV2_AUTONOMY_LEVEL_KEY = 'guideAutonomyLevel';

function _gv2NormalizeAutonomyLevel(value, auto = false) {
  const raw = String(value || '').trim();
  if (raw === 'auto_no_ask' || raw === 'auto') return raw;
  return auto === true ? 'auto' : 'manual';
}

async function _gv2AutonomyLevel() {
  try {
    const r = await chrome.storage.local.get([_GV2_AUTOMODE_PREF_KEY, _GV2_AUTONOMY_LEVEL_KEY]);
    return _gv2NormalizeAutonomyLevel(r[_GV2_AUTONOMY_LEVEL_KEY], r[_GV2_AUTOMODE_PREF_KEY] === true);
  } catch (e) {
    return 'manual';
  }
}

async function _gv2IsAutoMode() {
  return (await _gv2AutonomyLevel()) !== 'manual';
}

const _GV2_CONF_THRESHOLD_KEY = 'guideConfidenceThreshold';
const _GV2_ACTION_THRESHOLD_KEY = 'guideLowConfidenceActionThreshold';
const _GV2_LOOP_STEPS_KEY = 'guideLoopStepThreshold';

async function _gv2ConfidenceThreshold() {
  try {
    const r = await chrome.storage.local.get(_GV2_CONF_THRESHOLD_KEY);
    const n = Number(r[_GV2_CONF_THRESHOLD_KEY]);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.7;
  } catch (e) {
    return 0.7;
  }
}

async function _gv2LowConfidenceActionThreshold() {
  try {
    const r = await chrome.storage.local.get(_GV2_ACTION_THRESHOLD_KEY);
    const n = Number(r[_GV2_ACTION_THRESHOLD_KEY]);
    return Number.isFinite(n) ? Math.max(1, Math.round(n)) : 3;
  } catch (e) {
    return 3;
  }
}

/**
 * How many steps in a row may score at or above GV2_LOOP_STOP_THRESHOLD before the guide stops.
 *
 * Default 6. It was 1 — stop on the first repeat-looking step — which is tuned for safety, not for
 * real pages: a single step that revisits a control (paging a list, retrying a flaky menu, a search
 * box that has not submitted yet) scores as a loop while the run is still making progress, and the
 * run was being paused on it. Six consecutive over-threshold steps is a loop; one is a coincidence.
 * Adjustable in Options, next to the autonomous-step cap.
 */
const _GV2_LOOP_STEPS_DEFAULT = 6;
async function _gv2LoopStepThreshold() {
  try {
    const r = await chrome.storage.local.get(_GV2_LOOP_STEPS_KEY);
    const n = Number(r[_GV2_LOOP_STEPS_KEY]);
    return Number.isFinite(n) ? Math.max(1, Math.round(n)) : _GV2_LOOP_STEPS_DEFAULT;
  } catch (e) {
    return _GV2_LOOP_STEPS_DEFAULT;
  }
}
if (typeof window !== 'undefined') window._gv2LoopStepThreshold = _gv2LoopStepThreshold;

/**
 * The running count of consecutive over-threshold steps, given this step's score. Pure.
 *
 * CONSECUTIVE, not cumulative: a loop is a run of steps that get nowhere, so one step that scores
 * clean is evidence the guide moved on and the count starts again. A cumulative count would add up
 * unrelated repeats from opposite ends of a long session and stop a run that was never looping.
 */
function _gv2NextLoopStreak(previousCount, loopScore, stopThreshold = GV2_LOOP_STOP_THRESHOLD) {
  const score = Number(loopScore);
  if (!Number.isFinite(score) || score < stopThreshold) return 0;
  const prev = Number(previousCount);
  return (Number.isFinite(prev) && prev > 0 ? prev : 0) + 1;
}
if (typeof window !== 'undefined') window._gv2NextLoopStreak = _gv2NextLoopStreak;

function _gv2MaxFiniteScore(...values) {
  const nums = values.map(v => Number(v)).filter(n => Number.isFinite(n));
  return nums.length ? Math.max.apply(null, nums) : null;
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

/** Auto runs always use aligned capture (fresh pre-action screenshot of the target region).
 * Visual Recap also needs the fresh aligned shot so its marker geometry lines up with a
 * full pre-action screenshot. */
async function _gv2ShouldUseAlignedRegionCapture(g) {
  return false;
}
if (typeof window !== 'undefined') window._gv2ShouldUseAlignedRegionCapture = _gv2ShouldUseAlignedRegionCapture;

const _GV2_PLANNING_KEY = 'guidePlanningEnabled';

async function _gv2IsPlanningEnabled() {
  try {
    const r = await chrome.storage.local.get(_GV2_PLANNING_KEY);
    return r[_GV2_PLANNING_KEY] === true; // default OFF
  } catch (e) {
    return false;
  }
}

const _GV2_PASS_HISTORY_KEY = 'guideDebugPassHistory';

async function _gv2IsPassHistory() {
  return true;
}

const _GV2_VISUAL_INPUT_KEY = 'guideVisualInput';
const GV2_GUIDE_INDEX_MAX_ITEMS = 5000;
const GV2_VISUAL_INPUT_MAX_MARKS = GV2_GUIDE_INDEX_MAX_ITEMS;

/**
 * Text evidence mode takes no screenshots for anything the user is later shown — step records,
 * the initial state, after-action shots, evidence crops, the visual recap. Model-input captures
 * (the SoM screenshot behind "Send Image", the terminal verify pass) are a different axis and
 * keep their own toggles.
 */
async function _gv2CaptureShotsAllowed() {
  try {
    if (typeof getEvidenceMode !== 'function') return true;
    return typeof gv2ShouldCaptureScreenshots === 'function'
      ? gv2ShouldCaptureScreenshots(await getEvidenceMode())
      : true;
  } catch (e) {
    return true;
  }
}

async function _gv2IsVisualInputOn() {
  try {
    const r = await chrome.storage.local.get(_GV2_VISUAL_INPUT_KEY);
    return r[_GV2_VISUAL_INPUT_KEY] === 'on';
  } catch (e) {
    return false;
  }
}

const _GV2_VISUAL_RECAP_KEY = 'guideVisualRecap';
const _GV2_END_SUMMARY_KEY = 'guideEndSummaryAgent';

async function _gv2IsVisualRecapOn() {
  try {
    // A *visual* recap is by definition screenshot evidence, so Text evidence mode turns it off
    // regardless of its own toggle — otherwise the text arm would still end on a wall of images.
    if (!(await _gv2CaptureShotsAllowed())) return false;
    const r = await chrome.storage.local.get(_GV2_VISUAL_RECAP_KEY);
    return r[_GV2_VISUAL_RECAP_KEY] !== 'off'; // default on
  } catch (e) {
    return true;
  }
}

async function _gv2IsEndSummaryOn() {
  try {
    const r = await chrome.storage.local.get(_GV2_END_SUMMARY_KEY);
    return r[_GV2_END_SUMMARY_KEY] === 'on';
  } catch (e) {
    return false;
  }
}

// Builds the personalization prompt block ONCE per guide session (cached on window._guidev2 by the
// caller), so the per-step prompt builder never re-reads chrome.storage. Returns '' when
// personalization is disabled or nothing has been captured about the user yet.
async function _gv2LoadPersonalizationContext() {
  try {
    const s = await chrome.storage.sync.get(['personalizationEnabled', 'personalizationFacts', 'personalizedProfile']);
    if (!s.personalizationEnabled) return '';
    return gv2BuildPersonalizationSection({ facts: s.personalizationFacts, learned: s.personalizedProfile?.summary });
  } catch (e) {
    return '';
  }
}

async function _gv2WaitForLayoutSettle() {
  if (typeof window !== 'undefined' && window.IS_TEST_ENV) return;
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

async function _gv2CacheGoalEmbedding(g) {
  if (!g?.predictedGoalState) return;
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'callEmbed',
      texts: [g.predictedGoalState]
    });
    if (resp?.error || !resp?.embeddings?.[0]?.length) return;
    g._goalEmbedVector = resp.embeddings[0];
  } catch (e) { /* best-effort */ }
}

async function _gv2GoalRelevanceScore(g, instruction) {
  if (!g?._goalEmbedVector || !instruction || typeof gv2CosineSimilarity !== 'function') return null;
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'callEmbed',
      texts: [String(instruction)]
    });
    if (resp?.error || !resp?.embeddings?.[0]?.length) return null;
    return gv2CosineSimilarity(resp.embeddings[0], g._goalEmbedVector);
  } catch (e) {
    return null;
  }
}

function _gv2NormalizeDomText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function _gv2ElementAccessibleText(el) {
  if (!el) return '';
  try {
    const name = typeof getAccessibleName === 'function' ? (getAccessibleName(el) || '') : '';
    return String(name || el.textContent || '').replace(/\s+/g, ' ').trim();
  } catch (e) {
    return String(el.textContent || '').replace(/\s+/g, ' ').trim();
  }
}

function _gv2TextFallbackSimilarity(a, b) {
  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return 0.0;
  if (left === right) return 1.0;
  if (left.includes(right) || right.includes(left)) {
    const shorter = Math.min(left.length, right.length);
    const longer = Math.max(left.length, right.length);
    return Math.max(0.65, Math.min(0.95, shorter / Math.max(1, longer)));
  }
  const stop = new Set(['a', 'an', 'the', 'to', 'for', 'on', 'in', 'of', 'and', 'or', 'with', 'click', 'select', 'choose', 'open', 'change', 'begin', 'search', 'please']);
  const aw = left.split(' ').filter(w => w.length > 1 && !stop.has(w));
  const bw = right.split(' ').filter(w => w.length > 1 && !stop.has(w));
  if (!aw.length || !bw.length) return 0.0;
  const bset = new Set(bw);
  const overlap = aw.filter(w => bset.has(w)).length;
  return Math.max(0, Math.min(1, overlap / Math.max(aw.length, bw.length)));
}

function _gv2EvidenceItemKey(item) {
  const el = item?.evidenceEl || null;
  if (el) {
    for (const [key, idxEl] of Object.entries(window._pageguideIndex || {})) {
      if (idxEl === el) return `i:${key}`;
    }
  }
  const r = item?.evidenceRect;
  if (r) return `r:${r.x},${r.y},${r.w},${r.h}`;
  return `t:${item?.text || ''}|${item?.reason || ''}`;
}

function _gv2DedupeEvidenceItems(items) {
  const out = [];
  const seen = new Set();
  for (const item of (Array.isArray(items) ? items : [])) {
    const key = _gv2EvidenceItemKey(item);
    if (seen.has(key)) continue;
    const el = item?.evidenceEl || null;
    let skip = false;
    for (let i = 0; i < out.length; i++) {
      const existing = out[i];
      const ex = existing?.evidenceEl || null;
      if (el && ex && (el.contains(ex) || ex.contains(el))) {
        if (el.contains(ex) && el !== ex) {
          out[i] = item;
          seen.add(key);
        }
        skip = true;
        break;
      }
    }
    if (skip) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= 5) break;
  }
  return out;
}

async function _gv2LoadEvidenceScratchpad(sessionId) {
  if (!sessionId) return [];
  try {
    if (typeof rewindGetEvidence === 'function') {
      const list = await rewindGetEvidence(sessionId);
      return Array.isArray(list) ? list : [];
    }
    if (typeof rewindGetIndex === 'function') {
      const idx = await rewindGetIndex(sessionId);
      return Array.isArray(idx?.evidenceScratchpad) ? idx.evidenceScratchpad : [];
    }
  } catch (e) {}
  return [];
}
if (typeof window !== 'undefined') window._gv2LoadEvidenceScratchpad = _gv2LoadEvidenceScratchpad;

function _gv2SomIdExists(somId) {
  if (!somId) return true;
  const m = String(somId).match(/(\d+)$/);
  if (!m) return false;
  const n = Number(m[1]);
  return Number.isFinite(n) && !!(window._pageguideIndex && window._pageguideIndex[n]);
}
if (typeof window !== 'undefined') window._gv2SomIdExists = _gv2SomIdExists;

function _gv2SomIdToIndex(somId) {
  const m = String(somId || '').match(/(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Cap text sent to the embedding model. Long element text (verbose aria-labels, concatenated node
// text) dilutes the cosine similarity and wastes tokens (ada-002 caps at 8191 tokens); ~300 chars
// captures the meaningful label without the noise.
const GV2_EMBED_TEXT_MAX = 300;
function _gv2CapEmbedText(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > GV2_EMBED_TEXT_MAX ? t.slice(0, GV2_EMBED_TEXT_MAX).trim() : t;
}

async function _gv2ElementStepSimilarity(instruction, elementText, hasIndex) {
  if (!hasIndex) return null;
  const instr = _gv2CapEmbedText(instruction);
  const elem = _gv2CapEmbedText(elementText);
  if (!instr || !elem) return 0.0;
  if (typeof gv2CosineSimilarity !== 'function') return null;
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'callEmbed',
      texts: [instr, elem]
    });
    if (resp?.error || !Array.isArray(resp.embeddings) || resp.embeddings.length < 2) {
      try { window._guidev2._lastEmbeddingError = resp?.error || 'Embedding response missing vectors'; } catch (e) {}
      return _gv2TextFallbackSimilarity(instr, elem);
    }
    return gv2CosineSimilarity(resp.embeddings[0], resp.embeddings[1]);
  } catch (e) {
    try { window._guidev2._lastEmbeddingError = e?.message || String(e); } catch (_) {}
    return _gv2TextFallbackSimilarity(instr, elem);
  }
}

async function _gv2ElementGroundingSimilarity(llmElementText, domElementText) {
  const llm = _gv2CapEmbedText(llmElementText);
  const dom = _gv2CapEmbedText(domElementText);
  if (!llm || !dom) return 0.0;
  if (typeof gv2CosineSimilarity !== 'function') return null;
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'callEmbed',
      texts: [llm, dom]
    });
    if (resp?.error || !Array.isArray(resp.embeddings) || resp.embeddings.length < 2) return null;
    return gv2CosineSimilarity(resp.embeddings[0], resp.embeddings[1]);
  } catch (e) {
    return null;
  }
}

function _gv2CoercePlan(raw, question) {
  const obj = raw && typeof raw === 'object' ? raw : null;
  const sourceSteps = Array.isArray(obj?.steps) ? obj.steps : (Array.isArray(obj?.plan) ? obj.plan : []);
  const steps = sourceSteps
    .map((s, i) => {
      const goal = typeof s === 'string' ? s : (s?.goal || s?.description || s?.step || s?.title || '');
      return { n: Number(s?.n || s?.number || i + 1) || i + 1, goal: String(goal || '').trim() };
    })
    .filter(s => s.goal);
  if (!steps.length) return null;
  return {
    title: String(obj?.title || question || 'Guide').trim(),
    steps: steps.map((s, i) => ({ n: i + 1, goal: s.goal }))
  };
}

async function _gv2GenerateInitialPlan(g, pageIndex) {
  if (!g?.question || !(await _gv2IsPlanningEnabled())) return null;
  let tutorialSection = '';
  if (g.tutorialRef) {
    tutorialSection = `\nTutorial reference for a matching task:\n${g.tutorialRef.content.steps.join('\n')}\n`;
  }
  const attachmentSection = g.attachmentContext
    ? `\nUser-attached reference (ingested):\n${g.attachmentContext}\n`
    : '';
  const prompt = `Create a concise execution plan for a browser guide before any action is taken.
Return JSON only: {"title":"short title","steps":[{"n":1,"goal":"observable user-facing milestone"}]}.
Use 3-10 high-level milestones. Do not include hidden reasoning.

Current URL: ${window.location.href}
User goal: ${g.question}
${tutorialSection}${attachmentSection}
Visible interactive page index:
${pageIndex?.indexText || ''}`;
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'callLLM',
      systemPrompt: '',
      messages: [{ role: 'user', content: prompt }],
      metadata: { kind: 'guideInitialPlan', mode: 'guide', url: window.location.href }
    });
    if (resp?.error || !resp?.content) return null;
    const parsed = (typeof gv2ExtractJsonObject === 'function') ? gv2ExtractJsonObject(resp.content) : JSON.parse(resp.content);
    return _gv2CoercePlan(parsed, g.question);
  } catch (e) {
    console.warn('[guidev2] initial plan failed:', e);
    return null;
  }
}

async function _gv2SetInitialPlan(g, pageIndex) {
  if (!g || g._planAttempted) return;
  g._planAttempted = true;
  const plan = await _gv2GenerateInitialPlan(g, pageIndex);
  if (!plan) return;
  g.guidePlan = plan.steps;
  g.guideTitle = plan.title;
  try {
    if (g.sessionId && typeof rewindUpdateSessionMeta === 'function') {
      await rewindUpdateSessionMeta(g.sessionId, {
        guidePlan: plan.steps,
        guideTitle: plan.title,
        plan: plan.steps
      });
    }
  } catch (e) { /* non-fatal */ }
  try {
    chrome.runtime.sendMessage({
      action: 'guidePlan',
      sessionId: g.sessionId,
      title: plan.title,
      plan: plan.steps
    });
  } catch (e) { /* panel may be closed */ }
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
    if (area === 'local' && window._guidev2 && (changes[_GV2_AUTOMODE_PREF_KEY] || changes[_GV2_AUTONOMY_LEVEL_KEY])) {
      const on = changes[_GV2_AUTOMODE_PREF_KEY]
        ? changes[_GV2_AUTOMODE_PREF_KEY].newValue === true
        : window._guidev2.autoMode === true;
      const level = changes[_GV2_AUTONOMY_LEVEL_KEY]
        ? _gv2NormalizeAutonomyLevel(changes[_GV2_AUTONOMY_LEVEL_KEY].newValue, on)
        : _gv2NormalizeAutonomyLevel(window._guidev2.autonomyLevel, on);
      window._guidev2.autoMode = on;
      window._guidev2.autonomyLevel = level;
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
  g.autonomyLevel = _gv2NormalizeAutonomyLevel(g.autonomyLevel, g.autoMode === true);
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
/**
 * @param {Element} el - element to bring on screen
 * @param {{exact?: boolean, fitInViewport?: boolean, headerOffset?: number}} opts - exact: scroll THIS element, not its nearest interactive
 *   ancestor. Evidence crops need the exact span centered; centering an ancestor link or <nav>
 *   instead can leave the span itself off screen, and the capture then fails as offscreen.
 */
async function _gv2ScrollRegionTargetIntoView(el, opts = {}) {
  if (typeof window !== 'undefined' && window.IS_TEST_ENV) return;
  if (!el || typeof el.scrollIntoView !== 'function') return;
  let evalMode = false;
  try {
    const r = await chrome.storage.local.get('guideEvalMode');
    evalMode = r.guideEvalMode === true;
  } catch (e) { /* best-effort */ }
  const instant = evalMode || window._guidev2?.autoMode === true;
  const scrollEl = opts.exact
    ? el
    : (el.closest('a, button, [role="button"], [role="link"], [role="menuitem"], li, summary, nav') || el);
  // Flag this scroll as agent-driven so the study tracker attributes the resulting gesture to the
  // agent, not the participant. Cleared after the scroll settles + the tracker's 300 ms debounce.
  if (typeof window !== 'undefined') window._xwaAgentScrolling = true;
  if (opts.fitInViewport && typeof window.scrollTo === 'function' && scrollEl.getBoundingClientRect) {
    const r = scrollEl.getBoundingClientRect();
    const target = _gv2FitViewportScrollTargetForRect(
      { left: r.left, top: r.top, width: r.width, height: r.height },
      {
        x: window.scrollX || 0,
        y: window.scrollY || 0,
        w: window.innerWidth || 0,
        h: window.innerHeight || 0,
        scrollW: document.documentElement.scrollWidth || 0,
        scrollH: document.documentElement.scrollHeight || 0
      },
      { headerOffset: opts.headerOffset }
    );
    if (target) {
      window.scrollTo({ top: target.top, left: target.left, behavior: instant ? 'instant' : 'smooth' });
    } else {
      scrollEl.scrollIntoView({ behavior: instant ? 'instant' : 'smooth', block: 'center', inline: 'nearest' });
    }
  } else {
    scrollEl.scrollIntoView({ behavior: instant ? 'instant' : 'smooth', block: 'center', inline: 'nearest' });
  }
  await new Promise((resolve) => setTimeout(resolve, instant ? 200 : 550));
  if (typeof window !== 'undefined') {
    setTimeout(() => { window._xwaAgentScrolling = false; }, 400);
  }
}

function _gv2FitViewportScrollTargetForRect(rect, viewport, opts = {}) {
  if (!rect || !viewport) return null;
  const vw = Number(viewport.w);
  const vh = Number(viewport.h);
  if (!(vw > 0) || !(vh > 0)) return null;
  const left = Number(rect.left);
  const top = Number(rect.top);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![left, top, width, height].every(Number.isFinite) || !(width > 0) || !(height > 0)) return null;
  const scrollX = Number(viewport.x) || 0;
  const scrollY = Number(viewport.y) || 0;
  const docLeft = scrollX + left;
  const docTop = scrollY + top;
  const maxTop = Math.max(0, (Number(viewport.scrollH) || document.documentElement.scrollHeight || 0) - vh);
  const maxLeft = Math.max(0, (Number(viewport.scrollW) || document.documentElement.scrollWidth || 0) - vw);
  const headerOffset = Math.max(0, Number.isFinite(Number(opts.headerOffset)) ? Number(opts.headerOffset) : 80);
  const margin = 12;
  const desiredTop = height + headerOffset + margin <= vh
    ? docTop - headerOffset - margin
    : docTop - headerOffset;
  const desiredLeft = width + margin * 2 <= vw
    ? docLeft - margin
    : docLeft;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return {
    top: clamp(Math.round(desiredTop), 0, maxTop),
    left: clamp(Math.round(desiredLeft), 0, maxLeft)
  };
}
if (typeof window !== 'undefined') window._gv2FitViewportScrollTargetForRect = _gv2FitViewportScrollTargetForRect;

async function gv2CaptureRegion(screenshotBase64, options = {}) {
  const aligned = options.aligned === true;
  const out = { targetRect: null, regionShot: null, regionDom: '', regionCaptureMode: aligned ? 'aligned' : 'legacy',
                markedShot: null, targetNormRect: null, regionMarker: null };
  try {
    // Resolve the target element to crop/mark around. The named resolvers don't exist in this
    // build, so fall back to the actual highlighted element the step chose (g.currentTargetEl),
    // then any element carrying the highlight attribute. Without this the region/marker geometry
    // is never captured and the recap falls back to a plain full screenshot with no marker.
    const resolveTarget = (typeof gv2ResolveRegionTarget === 'function')
      ? gv2ResolveRegionTarget
      : ((typeof gv2ResolveRegionElement === 'function')
          ? gv2ResolveRegionElement
          : () => {
              const cur = window._guidev2?.currentTargetEl;
              if (cur && document.contains(cur)) return cur;
              return document.querySelector('[data-pageguide-styled]') || null;
            });

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

    // Marker geometry for the recap: normalized target rect over the full viewport shot, plus a
    // full pre-action screenshot that matches it. In aligned mode `screenshotBase64` IS the fresh
    // viewport capture (line above), so it lines up with targetRect / the current viewport.
    if (typeof gv2TargetNormRect === 'function') {
      out.targetNormRect = gv2TargetNormRect(out.targetRect, window.innerWidth, window.innerHeight);
    }
    if (aligned && screenshotBase64) out.markedShot = screenshotBase64;

    // Scoped DOM snapshot of the element's surrounding container (not the whole page).
    try {
      const container = el.closest('form, section, article, [role], main, li, fieldset, nav') || el.parentElement || el;
      if (typeof gv2SerializeDom === 'function') out.regionDom = gv2SerializeDom(container);
    } catch (e) { /* best-effort */ }

    // Crop the viewport screenshot down to the element's region and bake the SoM marker into it.
    if (screenshotBase64) {
      const cropped = await _gv2CropScreenshot(screenshotBase64, out.targetRect, options.markerNumber);
      out.regionShot = cropped?.base64 || null;
      out.regionMarker = cropped?.marker || null;
    }
  } catch (e) { /* best-effort */ }
  return out;
}

// Marker accent colors: orange for the action target ("region of action"), pink for the separate
// visual-evidence region that justifies the action.
const GV2_ACTION_MARKER_COLOR = '#ffa657';
const GV2_ACTION_MARKER_FILL = 'rgba(255,166,87,0.16)';
const GV2_EVIDENCE_MARKER_COLOR = '#ff2d78';
const GV2_EVIDENCE_MARKER_FILL = 'rgba(255,45,120,0.16)';

// Bake a SoM marker (box + optional number badge) onto a canvas 2D context so the "region of
// action" is visible in the screenshot pixels themselves. `marker` is a normalized { x, y, w, h }
// rect (fractions of the canvas). No-op when marker is missing. `color`/`fill` accent the box
// (defaults to the orange action color; pass the evidence color for visual-evidence crops).
function _gv2DrawMarkerOnCanvas(ctx, canvas, marker, number, color = GV2_ACTION_MARKER_COLOR, fill = GV2_ACTION_MARKER_FILL) {
  if (!ctx || !canvas || !marker) return;
  try {
    const W = canvas.width, H = canvas.height;
    const x = marker.x * W, y = marker.y * H;
    const w = Math.max(6, marker.w * W), h = Math.max(6, marker.h * H);
    const lw = Math.max(3, Math.round(W * 0.006));
    // Dark halo under the accent box so it reads on any background.
    ctx.lineWidth = lw + 2; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeRect(x, y, w, h);
    ctx.lineWidth = lw; ctx.strokeStyle = color;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    // Number badge (the SoM index) at the box's top-left corner.
    if (number != null && number !== '') {
      const label = String(number);
      const fs = Math.max(12, Math.round(W * 0.032));
      ctx.font = `700 ${fs}px sans-serif`;
      const padX = Math.round(fs * 0.4);
      const bw = ctx.measureText(label).width + padX * 2;
      const bh = Math.round(fs * 1.35);
      let bx = x - bw - lw, by = y;
      if (bx < 0) bx = Math.min(Math.max(0, x), Math.max(0, W - bw));
      if (bx + bw > W) bx = W - bw;
      const r = Math.min(6, bh / 2);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(bx + r, by);
      ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
      ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
      ctx.arcTo(bx, by + bh, bx, by, r);
      ctx.arcTo(bx, by, bx + bw, by, r);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(label, bx + padX, by + bh / 2 + 1);
    }
  } catch (e) { /* best-effort */ }
}

function _gv2DrawEvidenceAnnotationsOnCanvas(ctx, canvas, annotations, crop, dpr) {
  if (!ctx || !canvas || !crop || !Array.isArray(annotations) || !annotations.length) return;
  try {
    const W = canvas.width, H = canvas.height;
    const sourceW = Number(crop.imageWidth || crop.sourceWidth || 0) || Math.max(1, Number(crop.sx || 0) + Number(crop.sw || W));
    const sourceH = Number(crop.imageHeight || crop.sourceHeight || 0) || Math.max(1, Number(crop.sy || 0) + Number(crop.sh || H));
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const pointInCrop = (p) => ({
      x: clamp((p.x * sourceW) - crop.sx, 0, W),
      y: clamp((p.y * sourceH) - crop.sy, 0, H)
    });
    const annColor = (ann) => {
      const c = String(ann?.color || '').trim();
      return c || GV2_EVIDENCE_MARKER_COLOR;
    };
    const annFill = (color) => {
      if (/^#[0-9a-f]{6}$/i.test(color)) return `${color}26`;
      if (/^#[0-9a-f]{3}$/i.test(color)) return `${color}26`;
      return GV2_EVIDENCE_MARKER_FILL;
    };
    const rectInCrop = (b) => {
      const x = (b.x * sourceW) - crop.sx;
      const y = (b.y * sourceH) - crop.sy;
      const w = b.w * sourceW;
      const h = b.h * sourceH;
      const x1 = clamp(x, 0, W), y1 = clamp(y, 0, H);
      const x2 = clamp(x + w, 0, W), y2 = clamp(y + h, 0, H);
      return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
    };
    const drawLabel = (text, x, y, color = GV2_EVIDENCE_MARKER_COLOR) => {
      if (!text) return;
      const label = String(text).slice(0, 60);
      const fs = Math.max(12, Math.round(W * 0.028));
      ctx.font = `700 ${fs}px sans-serif`;
      const pad = Math.round(fs * 0.35);
      const tw = ctx.measureText(label).width;
      const bw = Math.min(W - 4, tw + pad * 2);
      const bh = Math.round(fs * 1.45);
      const bx = clamp(x, 2, Math.max(2, W - bw - 2));
      const by = clamp(y - bh - 4, 2, Math.max(2, H - bh - 2));
      ctx.fillStyle = color;
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(label, bx + pad, by + bh / 2 + 1);
    };
    const lw = Math.max(3, Math.round(W * 0.006));
    annotations.slice(0, 5).forEach((ann) => {
      const color = annColor(ann);
      if (!ann || ann.type === 'box') {
        const r = rectInCrop(ann?.bbox || {});
        if (!(r.w > 0) || !(r.h > 0)) return;
        ctx.lineWidth = lw + 2;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.lineWidth = lw;
        ctx.strokeStyle = color;
        ctx.fillStyle = annFill(color);
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        drawLabel(ann.label, r.x, r.y, color);
      } else if (ann.type === 'ellipse') {
        const r = rectInCrop(ann?.bbox || {});
        if (!(r.w > 0) || !(r.h > 0)) return;
        ctx.lineWidth = lw + 2;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath(); ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = lw;
        ctx.strokeStyle = color;
        ctx.fillStyle = annFill(color);
        ctx.beginPath(); ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        drawLabel(ann.label, r.x, r.y, color);
      } else if (ann.type === 'arrow' || ann.type === 'line') {
        const from = pointInCrop(ann.from || {});
        const to = pointInCrop(ann.to || {});
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        const head = Math.max(10, Math.round(W * 0.025));
        ctx.lineWidth = lw + 2;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
        ctx.lineWidth = lw;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
        if (ann.type === 'arrow') {
          ctx.beginPath();
          ctx.moveTo(to.x, to.y);
          ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
          ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
          ctx.closePath();
          ctx.fill();
        }
        drawLabel(ann.label, (from.x + to.x) / 2, (from.y + to.y) / 2, color);
      } else if (ann.type === 'path') {
        // Free-form stroke: routes, borders, irregular outlines. Quadratic midpoint smoothing when
        // `curved`, straight segments otherwise; optional arrowhead on the final point.
        const pts = (Array.isArray(ann.points) ? ann.points : []).map(pointInCrop);
        if (pts.length < 2) return;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        const trace = () => {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          if (ann.curved === false || pts.length === 2) {
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          } else {
            for (let i = 1; i < pts.length - 1; i++) {
              const mid = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
              ctx.quadraticCurveTo(pts[i].x, pts[i].y, mid.x, mid.y);
            }
            ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
          }
          ctx.stroke();
        };
        ctx.lineWidth = lw + 2; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; trace();
        ctx.lineWidth = lw; ctx.strokeStyle = color; trace();
        if (ann.arrow === true) {
          const last = pts[pts.length - 1];
          const prev = pts[pts.length - 2];
          const a = Math.atan2(last.y - prev.y, last.x - prev.x);
          const head = Math.max(10, Math.round(W * 0.025));
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(last.x, last.y);
          ctx.lineTo(last.x - head * Math.cos(a - Math.PI / 6), last.y - head * Math.sin(a - Math.PI / 6));
          ctx.lineTo(last.x - head * Math.cos(a + Math.PI / 6), last.y - head * Math.sin(a + Math.PI / 6));
          ctx.closePath();
          ctx.fill();
        }
        drawLabel(ann.label, pts[0].x, pts[0].y, color);
      }
    });
  } catch (e) { /* best-effort */ }
}

function _gv2MarkFullScreenshot(base64, rect, markerNumber, color = GV2_ACTION_MARKER_COLOR, fill = GV2_ACTION_MARKER_FILL, bakeMarker = true, annotations = []) {
  if (typeof window !== 'undefined' && window.IS_TEST_ENV) {
    return Promise.resolve({ base64: 'MOCK_MARK', marker: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, cropGeometry: { x: window.scrollX || 0, y: window.scrollY || 0, w: window.innerWidth || 0, h: window.innerHeight || 0 } });
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v || { base64: null, marker: null }); } };
    setTimeout(() => finish(null), 1500);
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const dpr = window.devicePixelRatio || 1;
          const crop = { sx: 0, sy: 0, sw: img.naturalWidth, sh: img.naturalHeight, imageWidth: img.naturalWidth, imageHeight: img.naturalHeight };
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const marker = (typeof gv2RegionMarkerRect === 'function') ? gv2RegionMarkerRect(rect, crop, dpr) : null;
          if (bakeMarker) _gv2DrawMarkerOnCanvas(ctx, canvas, marker, markerNumber, color, fill);
          _gv2DrawEvidenceAnnotationsOnCanvas(ctx, canvas, annotations, crop, dpr);
          const out = canvas.toDataURL('image/jpeg', 0.85).replace(/^data:image\/\w+;base64,/, '');
          finish({
            base64: out,
            marker,
            cropGeometry: { x: window.scrollX || 0, y: window.scrollY || 0, w: window.innerWidth || 0, h: window.innerHeight || 0 }
          });
        } catch (e) { finish(null); }
      };
      img.onerror = () => finish(null);
      img.src = 'data:image/jpeg;base64,' + base64;
    } catch (e) { finish(null); }
  });
}

/** Crop a base64 JPEG viewport screenshot to a CSS-px rect using a canvas, and BAKE a SoM marker
 * (box + optional number badge) over the target so the "region of action" is visible in the pixels
 * themselves (no dependency on render-time geometry). Resolves { base64, marker } — base64 is the
 * crop (or null), marker is the target's normalized rect within the crop (or null). */
function _gv2CropScreenshot(base64, rect, markerNumber, color = GV2_ACTION_MARKER_COLOR, fill = GV2_ACTION_MARKER_FILL, bakeMarker = true, annotations = [], maxWidth = 0) {
  if (typeof window !== 'undefined' && window.IS_TEST_ENV) {
    return Promise.resolve({ base64: 'MOCK_CROP', marker: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, cropGeometry: { x: window.scrollX || 0, y: window.scrollY || 0, w: window.innerWidth || 0, h: window.innerHeight || 0 } });
  }
  return new Promise((resolve) => {
    // Hard time-box: never let a stuck Image decode hang the caller (which gates the record store).
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v || { base64: null, marker: null }); } };
    setTimeout(() => finish(null), 1500);
    try {
      const img = new Image();
      img.onload = () => {
        try {
          // Zoom to the target with SOME surrounding context (not the whole page, not a tight box).
          const dpr = window.devicePixelRatio || 1;
          const pad = Math.round(Math.max(120, (rect.width || 0) * 0.6, (rect.height || 0) * 0.6));
          const crop = (typeof gv2CropRect === 'function')
            ? gv2CropRect(rect, dpr, img.naturalWidth, img.naturalHeight, pad)
            : null;
          if (!crop) return finish(null);
          crop.imageWidth = img.naturalWidth;
          crop.imageHeight = img.naturalHeight;
          // Downscale wide crops: a retina crop of a large image costs several times the tokens
          // for detail no model uses. The marker/annotation maths below is normalized, so it
          // follows the scale automatically.
          const scale = (maxWidth > 0 && crop.sw > maxWidth) ? (maxWidth / crop.sw) : 1;
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(crop.sw * scale));
          canvas.height = Math.max(1, Math.round(crop.sh * scale));
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
          const marker = (typeof gv2RegionMarkerRect === 'function') ? gv2RegionMarkerRect(rect, crop, dpr) : null;
          // Skip canvas baking when the marker is already drawn as a DOM overlay (captured in the
          // pixels), so we don't stack two markers on the same region.
          if (bakeMarker) _gv2DrawMarkerOnCanvas(ctx, canvas, marker, markerNumber, color, fill);
          _gv2DrawEvidenceAnnotationsOnCanvas(ctx, canvas, annotations, crop, dpr);
          const base = canvas.toDataURL('image/jpeg', 0.85).replace(/^data:image\/\w+;base64,/, '');
          const cssScale = dpr > 0 ? dpr : 1;
          finish({
            base64: base,
            marker,
            cropGeometry: {
              x: (window.scrollX || 0) + (crop.sx / cssScale),
              y: (window.scrollY || 0) + (crop.sy / cssScale),
              w: crop.sw / cssScale,
              h: crop.sh / cssScale
            }
          });
        } catch (e) { finish(null); }
      };
      img.onerror = () => finish(null);
      img.src = 'data:image/jpeg;base64,' + base64;
    } catch (e) { finish(null); }
  });
}

// Crop the SEPARATE visual-evidence region (the on-page proof that justifies the step, e.g. a
// "Sort by: Price: Low to High" control) out of a fresh viewport screenshot, with a pink marker
// baked in. Distinct from the action-target region (gv2CaptureRegion). For saved evidence this can
// scroll a DOM/SoM target into view before capture; bbox-only evidence remains current-viewport only.
// Best-effort — never throws.
async function gv2CaptureEvidenceRegion(evidenceEl, markerNumber, normRect = null, options = {}) {
  const out = { visualEvidenceShot: null, visualEvidenceOriginalShot: null, visualEvidenceNormRect: null, visualEvidenceMarker: null, visualEvidenceCropGeometry: null, captureGeometry: null, captureMode: null, captureError: null };
  try {
    // Resolve a CSS-px viewport rect from either the live element or a normalized {x,y,w,h} box,
    // plus the marker target (the element when we have one, else the normalized rect).
    let rect = null;
    let markerTarget = null;
    if (evidenceEl && evidenceEl.getBoundingClientRect && document.contains(evidenceEl)) {
      if (options.scrollIntoView) {
        await _gv2ScrollRegionTargetIntoView(evidenceEl, {
          exact: !!options.exactScrollTarget,
          fitInViewport: !!options.fitInViewport,
          headerOffset: options.headerOffset
        });
        await _gv2WaitForLayoutSettle();
      }
      const r0 = evidenceEl.getBoundingClientRect();
      if (!(r0.width > 0) || !(r0.height > 0)) {
        out.captureError = 'empty-dom-rect';
        return out;
      }
      // Only crop when the element is actually within the current viewport (a fresh capture shows
      // the viewport, so an off-screen rect would crop empty/wrong pixels).
      const visible = r0.bottom > 0 && r0.right > 0 && r0.top < window.innerHeight && r0.left < window.innerWidth;
      if (!visible) {
        out.captureError = 'dom-target-offscreen';
        return out;
      }
      rect = { left: r0.left, top: r0.top, width: r0.width, height: r0.height };
      markerTarget = evidenceEl;
      out.captureMode = options.scrollIntoView ? 'som_scroll' : 'som_viewport';
    } else if (normRect) {
      rect = {
        left: normRect.x * window.innerWidth,
        top: normRect.y * window.innerHeight,
        width: normRect.w * window.innerWidth,
        height: normRect.h * window.innerHeight
      };
      if (!(rect.width > 0) || !(rect.height > 0)) {
        out.captureError = 'empty-bbox';
        return out;
      }
      markerTarget = normRect;
      out.captureMode = options.fullViewport ? 'bbox_full_viewport' : 'bbox_viewport';
    } else {
      out.captureError = 'missing-target';
      return out;
    }
    if (typeof gv2TargetNormRect === 'function') {
      out.visualEvidenceNormRect = gv2TargetNormRect(rect, window.innerWidth, window.innerHeight);
    }
    out.captureGeometry = {
      x: window.scrollX || 0,
      y: window.scrollY || 0,
      w: window.innerWidth || 0,
      h: window.innerHeight || 0
    };
    console.log('[DEBUG] gv2CaptureEvidenceRegion starting options:', JSON.stringify(options));

    // For saved evidence, force a real DOM overlay before capture so text spans / DOM targets are
    // visibly highlighted in the screenshot pixels. Recap-only evidence keeps the older Vision-on
    // overlay behavior and otherwise falls back to canvas baking after capture.
    //
    // The Vision-on default is passed in by the caller (gv2CaptureEvidenceItems) rather than read
    // from window._guidev2 here: reading Guide state made an unrelated toggle — Send Image — change
    // what a Find capture produced, which is exactly the coupling this path must not have.
    const useDomMarker = !options.noMarker
      && !!(options.forceDomMarker || options.visionMarkerDefault)
      && typeof gv2DrawDomMarker === 'function';
    let markerNode = null;
    if (useDomMarker) {
      markerNode = gv2DrawDomMarker(markerTarget, markerNumber, GV2_EVIDENCE_MARKER_COLOR);
      console.log('[DEBUG] gv2DrawDomMarker called, waiting 50ms...');
      // Let the overlay paint before capturing.
      await new Promise(r => setTimeout(r, 50));
    }
    let shot = options.screenshotBase64 || null;
    let cleanShot = shot;
    console.log('[DEBUG] captureScreenshot check...');
    try { if (!shot && typeof captureScreenshot === 'function') shot = await captureScreenshot(); } catch (e) { console.log('[DEBUG] captureScreenshot error:', e); }
    console.log('[DEBUG] shot length:', shot?.length);
    if (markerNode && typeof gv2RemoveDomMarker === 'function') {
      gv2RemoveDomMarker(markerNode);
      cleanShot = null;
      console.log('[DEBUG] gv2RemoveDomMarker called, waiting 50ms...');
      await new Promise(r => setTimeout(r, 50));
      try { if (typeof captureScreenshot === 'function') cleanShot = await captureScreenshot(); } catch (e) { console.log('[DEBUG] cleanShot capture error:', e); }
    }
    if (!shot) {
      out.captureError = 'screenshot-failed';
      console.log('[DEBUG] screenshot-failed');
      return out;
    }
    if (!cleanShot) cleanShot = shot;
    const hasAnnotations = Array.isArray(options.annotations) && options.annotations.length > 0;
    // DOM overlays are already captured in pixels. For screenshot-region evidence, annotations are
    // the visual overlay; region_bbox is just the crop/hint. Only draw the plain region box when
    // there are no annotations to show.
    const bakeMarker = !options.noMarker && !markerNode && !hasAnnotations;
    console.log('[DEBUG] crop screenshot starting...');
    const marked = options.fullViewport
      ? await _gv2MarkFullScreenshot(
          shot,
          rect,
          markerNumber,
          GV2_EVIDENCE_MARKER_COLOR,
          GV2_EVIDENCE_MARKER_FILL,
          bakeMarker,
          options.annotations || []
        )
      : await _gv2CropScreenshot(
          shot,
          rect,
          markerNumber,
          GV2_EVIDENCE_MARKER_COLOR,
          GV2_EVIDENCE_MARKER_FILL,
          bakeMarker,
          options.annotations || [],
          Number(options.maxWidth) || 0
        );
    out.visualEvidenceShot = marked?.base64 || null;
    out.visualEvidenceMarker = marked?.marker || null;
    out.visualEvidenceCropGeometry = marked?.cropGeometry || null;
    const original = options.fullViewport
      ? await _gv2MarkFullScreenshot(
          cleanShot,
          rect,
          markerNumber,
          GV2_EVIDENCE_MARKER_COLOR,
          GV2_EVIDENCE_MARKER_FILL,
          false,
          []
        )
      : await _gv2CropScreenshot(
          cleanShot,
          rect,
          markerNumber,
          GV2_EVIDENCE_MARKER_COLOR,
          GV2_EVIDENCE_MARKER_FILL,
          false,
          []
        );
    out.visualEvidenceOriginalShot = original?.base64 || null;
    if (!out.visualEvidenceShot && !out.captureError) out.captureError = 'crop-failed';
  } catch (e) { out.captureError = e?.message || 'capture-failed'; }
  return out;
}

async function _gv2AnnotateEvidenceItem(item, screenshotBase64) {
  const out = {
    region_bbox: item?.evidenceRect || item?.region_bbox || null,
    annotations: Array.isArray(item?.annotations) ? item.annotations : [],
    systemPrompt: '',
    userPrompt: '',
    screenshotBase64: screenshotBase64 || null,
    rawResponse: '',
    error: null
  };
  if (!item || item.evidenceEl || item.som_id || !screenshotBase64) return out;
  const prompt = item.annotation_prompt || item.annotationPrompt || item.note || item.reason || item.key || '';
  const systemPrompt = (typeof window !== 'undefined' && window.PROMPTS?.GUIDE_EVIDENCE_ANNOTATOR) || GUIDE_EVIDENCE_ANNOTATOR_PROMPT || '';
  const userPrompt = `EVIDENCE KEY: ${item.key || ''}
EVIDENCE NOTE: ${item.note || ''}
ANNOTATION REQUEST: ${prompt}
CURRENT WORKER REGION_BBOX HINT: ${item.evidenceRect ? JSON.stringify(item.evidenceRect) : '(none)'}

Annotate the screenshot so the user can visually understand this evidence.`;
  out.systemPrompt = systemPrompt;
  out.userPrompt = userPrompt;
  try {
    const response = await safeSendMessage({
      action: 'callLLMWithImages',
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      images: [{
        base64: screenshotBase64,
        label: item?.source_image_id ? `[image_id=${item.source_image_id}] Source image for evidence annotation` : 'Current viewport screenshot for evidence annotation'
      }],
      metadata: { mode: 'guide_evidence_annotator', step: window._guidev2?._activeStepNumber || null, url: window.location.href }
    });
    out.rawResponse = response?.content ? String(response.content) : '';
    if (response?.error) {
      out.error = response.error;
      return out;
    }
    const repairedRawResponse = _gv2RepairAnnotatorJsonText(out.rawResponse);
    const parsedRaw = repairedRawResponse && typeof gv2ExtractJsonObject === 'function' ? gv2ExtractJsonObject(repairedRawResponse) : null;
    const raw = _gv2UnwrapAnnotatorItem(parsedRaw, item.key);
    const imageSize = await _gv2ImageSizeFromBase64(screenshotBase64);
    const coercedRaw = _gv2CoerceAnnotatorResult(raw, imageSize);
    out.annotationCoordinateDebug = coercedRaw?.__coordinateDebug || null;
    if (out.annotationCoordinateDebug && repairedRawResponse !== out.rawResponse) {
      out.annotationCoordinateDebug.repairedRawResponse = repairedRawResponse;
    }
    const norm = typeof gv2NormalizeEvidenceAnnotationResult === 'function'
      ? gv2NormalizeEvidenceAnnotationResult(coercedRaw)
      : { region_bbox: null, annotations: [] };
    if (norm.region_bbox) out.region_bbox = norm.region_bbox;
    out.annotations = Array.isArray(norm.annotations) ? norm.annotations : [];
  } catch (e) {
    out.error = e?.message || String(e);
  }
  return out;
}

function _gv2EvidenceItemNeedsAnnotator(item) {
  return !!(item && !item.evidenceEl && !item.som_id &&
    (item.need_annotation || item.needAnnotation || !Array.isArray(item.annotations) || !item.annotations.length));
}

function _gv2AnnotationSourceKey(item) {
  if (!item) return 'none';
  if (item.annotationSourceEl) {
    const selector = typeof gv2ElementSelector === 'function' ? gv2ElementSelector(item.annotationSourceEl) : '';
    return `el:${selector || item.source_image_id || ''}`;
  }
  if (item.annotationSourceGeometry) {
    const g = item.annotationSourceGeometry || {};
    return `geom:${Number(g.x) || 0}:${Number(g.y) || 0}:${Number(g.w) || 0}:${Number(g.h) || 0}:${item.source_image_id || ''}`;
  }
  return `viewport:${item.source_image_id || 'viewport'}`;
}

function _gv2ApplyAnnotatorResultToItem(item, annotated, shotForItem) {
  if (!item) return;
  const annotatesExternalSource = _gv2AnnotatesExternalSource(item);
  if (annotated?.region_bbox) {
    item.annotationRegionBbox = annotated.region_bbox;
    if (!annotatesExternalSource) {
      item.region_bbox = annotated.region_bbox;
      item.evidenceRect = annotated.region_bbox;
    }
  }
  item.annotations = Array.isArray(annotated?.annotations) ? annotated.annotations : [];
  item.annotationSystemPrompt = annotated?.systemPrompt || '';
  item.annotationUserPrompt = annotated?.userPrompt || '';
  item.annotationScreenshot = annotated?.screenshotBase64 || shotForItem || null;
  item.annotationRawResponse = annotated?.rawResponse || '';
  item.annotationError = annotated?.error || null;
  item.annotationCoordinateDebug = annotated?.annotationCoordinateDebug || null;
  item._gv2AnnotationDone = true;
}

function _gv2AnnotatesExternalSource(item) {
  if (!item) return false;
  const sourceImageId = String(item.source_image_id || '').trim();
  return !!(item.annotationSourceShot || (sourceImageId && sourceImageId !== 'viewport'));
}

function _gv2EvidenceDisplayRegion(item) {
  if (!item) return null;
  if (item.annotationRegionBbox) return item.annotationRegionBbox;
  if (item.region_bbox) return item.region_bbox;
  if (_gv2AnnotatesExternalSource(item) && item.fullViewportCapture) return null;
  return item.evidenceRect || null;
}

async function _gv2AnnotateEvidenceItemsBatch(items, screenshotBase64) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length <= 1) return list.length ? [await _gv2AnnotateEvidenceItem(list[0], screenshotBase64)] : [];
  const systemPrompt = (typeof window !== 'undefined' && window.PROMPTS?.GUIDE_EVIDENCE_ANNOTATOR) || GUIDE_EVIDENCE_ANNOTATOR_PROMPT || '';
  const rows = list.map((item, idx) => {
    const prompt = item.annotation_prompt || item.annotationPrompt || item.note || item.reason || item.key || '';
    const hint = item.evidenceRect ? JSON.stringify(item.evidenceRect) : '(none)';
    return [
      `ITEM ${idx + 1}`,
      `EVIDENCE KEY: ${item.key || `item_${idx + 1}`}`,
      `EVIDENCE NOTE: ${item.note || ''}`,
      `ANNOTATION REQUEST: ${prompt}`,
      `CURRENT WORKER REGION_BBOX HINT: ${hint}`
    ].join('\n');
  }).join('\n\n');
  const userPrompt = `${rows}

Annotate the screenshot so the user can visually understand every evidence item.
Return one keyed item per EVIDENCE KEY using the batch JSON shape.`;
  const base = (item) => ({
    region_bbox: item?.evidenceRect || item?.region_bbox || null,
    annotations: Array.isArray(item?.annotations) ? item.annotations : [],
    systemPrompt,
    userPrompt,
    screenshotBase64: screenshotBase64 || null,
    rawResponse: '',
    error: null
  });
  const out = list.map(base);
  if (!screenshotBase64) return out;
  try {
    const response = await safeSendMessage({
      action: 'callLLMWithImages',
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      images: [{
        base64: screenshotBase64,
        label: list[0]?.source_image_id ? `[image_id=${list[0].source_image_id}] Source image for evidence annotation` : 'Current viewport screenshot for evidence annotation'
      }],
      metadata: {
        mode: 'guide_evidence_annotator',
        batch: true,
        evidenceKeys: list.map((item, idx) => item.key || `item_${idx + 1}`),
        step: window._guidev2?._activeStepNumber || null,
        url: window.location.href
      }
    });
    const rawText = response?.content ? String(response.content) : '';
    out.forEach(o => { o.rawResponse = rawText; });
    if (response?.error) {
      out.forEach(o => { o.error = response.error; });
      return out;
    }
    const repairedRawResponse = _gv2RepairAnnotatorJsonText(rawText);
    const raw = repairedRawResponse && typeof gv2ExtractJsonObject === 'function' ? gv2ExtractJsonObject(repairedRawResponse) : null;
    const rawItems = Array.isArray(raw?.items) ? raw.items : [];
    if (!rawItems.length) {
      out.forEach(o => { o.error = 'batch-response-missing-items'; });
      return out;
    }
    const imageSize = await _gv2ImageSizeFromBase64(screenshotBase64);
    const byKey = new Map();
    rawItems.forEach((rawItem, idx) => {
      const key = String(rawItem?.key || rawItem?.evidence_key || rawItem?.evidenceKey || '').trim();
      if (key) byKey.set(key, rawItem);
      byKey.set(`__idx_${idx}`, rawItem);
    });
    list.forEach((item, idx) => {
      const rawItem = byKey.get(String(item.key || '').trim()) || byKey.get(`__idx_${idx}`) || null;
      if (!rawItem) {
        out[idx].error = 'batch-item-missing';
        return;
      }
      const coercedRaw = _gv2CoerceAnnotatorResult(rawItem, imageSize);
      out[idx].annotationCoordinateDebug = coercedRaw?.__coordinateDebug || null;
      if (out[idx].annotationCoordinateDebug && repairedRawResponse !== rawText) {
        out[idx].annotationCoordinateDebug.repairedRawResponse = repairedRawResponse;
      }
      const norm = typeof gv2NormalizeEvidenceAnnotationResult === 'function'
        ? gv2NormalizeEvidenceAnnotationResult(coercedRaw)
        : { region_bbox: null, annotations: [] };
      if (norm.region_bbox) out[idx].region_bbox = norm.region_bbox;
      out[idx].annotations = Array.isArray(norm.annotations) ? norm.annotations : [];
    });
  } catch (e) {
    out.forEach(o => { o.error = e?.message || String(e); });
  }
  return out;
}

function _gv2RepairAnnotatorJsonText(text) {
  let s = String(text || '');
  const num = '[-+]?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?';
  const coordKey = '(?:bbox|region_bbox|region|crop)';
  const firstFinite = (vals) => vals.find(v => Number.isFinite(v));
  const fmt = (n) => Number.isFinite(n) ? String(n) : null;
  const repairObjectBody = (name, body) => {
    const pairs = [];
    const pairRe = new RegExp('"([^"]+)"\\s*:\\s*(' + num + ')', 'g');
    let m;
    while ((m = pairRe.exec(body))) {
      pairs.push({ key: String(m[1] || '').toLowerCase(), value: Number(m[2]) });
    }
    if (pairs.length < 4) return null;
    const valsFor = (...keys) => pairs.filter(p => keys.includes(p.key)).map(p => p.value).filter(Number.isFinite);
    const nums = pairs.map(p => p.value).filter(Number.isFinite);
    let x = firstFinite(valsFor('x', 'left', 'l', 'x1'));
    let y = firstFinite(valsFor('y', 'top', 't', 'y1'));
    let w = firstFinite(valsFor('w', 'width'));
    let h = firstFinite(valsFor('h', 'height'));
    const x2 = firstFinite(valsFor('x2', 'right', 'r'));
    const y2 = firstFinite(valsFor('y2', 'bottom', 'b'));
    if (!Number.isFinite(w) && Number.isFinite(x2) && Number.isFinite(x)) w = x2 - x;
    if (!Number.isFinite(h) && Number.isFinite(y2) && Number.isFinite(y)) h = y2 - y;
    const xVals = valsFor('x', 'left', 'l', 'x1');
    const yVals = valsFor('y', 'top', 't', 'y1');
    // Duplicate-key recovery: x/y/w/y means the second y was intended as h; x/y/x/h means the
    // second x was intended as w. This keeps JSON.parse from silently discarding the first value.
    if (!Number.isFinite(h) && Number.isFinite(w) && yVals.length >= 2) h = yVals[yVals.length - 1];
    if (!Number.isFinite(w) && Number.isFinite(h) && xVals.length >= 2) w = xVals[xVals.length - 1];
    if (![x, y, w, h].every(Number.isFinite) && nums.length >= 4) {
      x = Number.isFinite(x) ? x : nums[0];
      y = Number.isFinite(y) ? y : nums[1];
      w = Number.isFinite(w) ? w : nums[2];
      h = Number.isFinite(h) ? h : nums[3];
    }
    if (![x, y, w, h].every(Number.isFinite)) return null;
    x = Number(x.toFixed(6)); y = Number(y.toFixed(6)); w = Number(w.toFixed(6)); h = Number(h.toFixed(6));
    return `"${name}":{"x":${fmt(x)},"y":${fmt(y)},"w":${fmt(w)},"h":${fmt(h)}}`;
  };
  s = s.replace(new RegExp('"(' + coordKey + ')"\\s*:\\s*\\{([^{}]*)\\}', 'g'), (full, name, body) => {
    return repairObjectBody(name, body) || full;
  });
  s = s.replace(new RegExp('"(' + coordKey + ')"\\s*:\\s*\\[\\s*(' + num + ')\\s*,\\s*(' + num + ')\\s*,\\s*(' + num + ')\\s*,\\s*(' + num + ')\\s*\\]', 'g'), (_full, name, x, y, w, h) => {
    return `"${name}":{"x":${x},"y":${y},"w":${w},"h":${h}}`;
  });
  return s;
}
if (typeof window !== 'undefined') window._gv2RepairAnnotatorJsonText = _gv2RepairAnnotatorJsonText;

function _gv2ImageSizeFromBase64(base64) {
  if (typeof window !== 'undefined' && window.IS_TEST_ENV) {
    return Promise.resolve({ width: 800, height: 600 });
  }
  return new Promise((resolve) => {
    if (!base64) return resolve(null);
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v || null); } };
    setTimeout(() => finish(null), 1000);
    try {
      const img = new Image();
      img.onload = () => finish({ width: img.naturalWidth || img.width || 0, height: img.naturalHeight || img.height || 0 });
      img.onerror = () => finish(null);
      img.src = String(base64).startsWith('data:') ? String(base64) : `data:image/jpeg;base64,${base64}`;
    } catch (e) {
      finish(null);
    }
  });
}

function _gv2CoerceAnnotatorBox(box, imageSize, fallbackRegion = null) {
  if (!box || typeof box !== 'object') return null;
  const iw = Number(imageSize?.width) || 0;
  const ih = Number(imageSize?.height) || 0;
  if (Array.isArray(box) && box.length >= 4) {
    box = { x: box[0], y: box[1], w: box[2], h: box[3] };
  }
  const firstDefined = (...vals) => vals.find(v => v != null && v !== '');
  const toNormX = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n > 1 && iw > 0 ? n / iw : n;
  };
  const toNormY = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n > 1 && ih > 0 ? n / ih : n;
  };
  const xRaw = firstDefined(box.x, box.left, box.l, box.x1);
  const yRaw = firstDefined(box.y, box.top, box.t, box.y1);
  const x = toNormX(xRaw);
  const y = toNormY(yRaw);
  let w = Number(firstDefined(box.w, box.width));
  let h = Number(firstDefined(box.h, box.height));
  const x2 = toNormX(firstDefined(box.x2, box.right, box.r));
  const y2 = toNormY(firstDefined(box.y2, box.bottom, box.b));
  if ((!Number.isFinite(w) || !(w > 0)) && Number.isFinite(x2) && Number.isFinite(x)) w = x2 - x;
  if ((!Number.isFinite(h) || !(h > 0)) && Number.isFinite(y2) && Number.isFinite(y)) h = y2 - y;
  if ((!Number.isFinite(w) || !Number.isFinite(h)) && !Array.isArray(box)) {
    const nums = Object.values(box).map(Number).filter(Number.isFinite);
    if (nums.length >= 4) {
      if (!Number.isFinite(w)) w = nums[2];
      if (!Number.isFinite(h)) h = nums[3];
    }
  }
  if (Number.isFinite(w) && w > 1 && iw > 0) w = w / iw;
  if (Number.isFinite(h) && h > 1 && ih > 0) h = h / ih;
  if (!Number.isFinite(w) || !(w > 0)) w = fallbackRegion?.w ? Math.min(fallbackRegion.w, 0.12) : 0.08;
  if (!Number.isFinite(h) || !(h > 0)) h = fallbackRegion?.h ? Math.min(fallbackRegion.h, 0.06) : 0.04;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, w, h };
}

function _gv2CoerceAnnotatorPoint(point, imageSize) {
  if (!point || typeof point !== 'object') return null;
  const iw = Number(imageSize?.width) || 0;
  const ih = Number(imageSize?.height) || 0;
  const x0 = Number(point.x);
  const y0 = Number(point.y);
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
  return {
    x: x0 > 1 && iw > 0 ? x0 / iw : x0,
    y: y0 > 1 && ih > 0 ? y0 / ih : y0
  };
}

function _gv2PreprocessGridCoordinates(raw) {
  if (!raw || typeof raw !== 'object') return raw;

  const coords = [];
  const collectBox = (b) => {
    if (!b || typeof b !== 'object') return;
    const keys = ['x', 'y', 'w', 'h', 'left', 'top', 'right', 'bottom', 'l', 't', 'r', 'b', 'x1', 'y1', 'x2', 'y2'];
    for (const k of keys) {
      if (b[k] != null && b[k] !== '') {
        const val = Number(b[k]);
        if (Number.isFinite(val)) coords.push({ obj: b, key: k, val });
      }
    }
    if (Array.isArray(b)) {
      for (let i = 0; i < Math.min(b.length, 4); i++) {
        const val = Number(b[i]);
        if (Number.isFinite(val)) coords.push({ obj: b, key: i, val });
      }
    }
  };

  const collectPoint = (p) => {
    if (!p || typeof p !== 'object') return;
    for (const k of ['x', 'y']) {
      if (p[k] != null && p[k] !== '') {
        const val = Number(p[k]);
        if (Number.isFinite(val)) coords.push({ obj: p, key: k, val });
      }
    }
  };

  const mainBox = raw.region_bbox || raw.region || raw.crop || raw.bbox;
  if (mainBox) collectBox(mainBox);

  if (Array.isArray(raw.annotations)) {
    for (const ann of raw.annotations) {
      if (!ann || typeof ann !== 'object') continue;
      const type = String(ann.type || '').toLowerCase();
      if (type === 'box' || type === 'rect' || type === 'rectangle' || type === 'circle' || type === 'ellipse') {
        const box = ann.bbox || ann.region_bbox || ann.region || ann;
        collectBox(box);
      } else if (type === 'arrow' || type === 'line') {
        collectPoint(ann.from);
        collectPoint(ann.to);
      } else if (type === 'path' || type === 'polyline' || type === 'curve' || type === 'freehand' || type === 'scribble') {
        const pts = Array.isArray(ann.points) ? ann.points : (Array.isArray(ann.path) ? ann.path : []);
        pts.forEach(collectPoint);
      }
    }
  }

  const hasValueGreaterThanOne = coords.some(c => c.val > 1);
  if (!hasValueGreaterThanOne) return raw;

  const maxVal = Math.max(...coords.map(c => c.val));

  if (maxVal <= 1000) {
    for (const c of coords) {
      c.obj[c.key] = Number((c.val / 1000).toFixed(6));
    }
  }

  return raw;
}

/**
 * Unwrap a batch-shaped annotator reply for a single evidence item.
 *
 * The annotator system prompt documents two reply shapes — a bare {region_bbox, annotations} and a
 * batch {"items":[{key, region_bbox, annotations}]} — and the model sometimes answers a one-item
 * request in the batch shape anyway. Coercing that wrapper finds no coordinates at all, so the item
 * ends up with zero annotations and the crop is drawn without any box. Pull the matching item out
 * (by key when it is there, otherwise the first one) before coercion.
 *
 * @param {object|null} raw - parsed annotator JSON
 * @param {string} key - the evidence key that was requested
 * @returns {object|null} the single-item shape to coerce
 */
function _gv2UnwrapAnnotatorItem(raw, key) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return raw;
  const items = raw.items.filter(it => it && typeof it === 'object');
  if (!items.length) return raw;
  const wanted = String(key || '').trim().toLowerCase();
  const match = wanted
    ? items.find(it => String(it.key || it.evidence_key || it.evidenceKey || '').trim().toLowerCase() === wanted)
    : null;
  return match || items[0];
}

function _gv2CoerceAnnotatorResult(raw, imageSize) {
  if (!raw || typeof raw !== 'object') return raw;

  let clonedRaw;
  try {
    clonedRaw = JSON.parse(JSON.stringify(raw));
  } catch (e) {
    clonedRaw = raw;
  }

  _gv2PreprocessGridCoordinates(clonedRaw);

  const out = Object.assign({}, clonedRaw);
  const fallbackRegion = _gv2CoerceAnnotatorBox(clonedRaw.region_bbox || clonedRaw.region || clonedRaw.crop || clonedRaw.bbox, imageSize, null);
  if (fallbackRegion) out.region_bbox = fallbackRegion;
  if (Array.isArray(clonedRaw.annotations)) {
    out.annotations = clonedRaw.annotations.map((ann) => {
      if (!ann || typeof ann !== 'object') return ann;
      const next = Object.assign({}, ann);
      const type = String(next.type || '').toLowerCase();
      if (type === 'box' || type === 'rect' || type === 'rectangle' || type === 'circle' || type === 'ellipse') {
        const box = _gv2CoerceAnnotatorBox(next.bbox || next.region_bbox || next.region || next, imageSize, fallbackRegion);
        if (box) next.bbox = box;
      } else if (type === 'arrow' || type === 'line') {
        const from = _gv2CoerceAnnotatorPoint(next.from, imageSize);
        const to = _gv2CoerceAnnotatorPoint(next.to, imageSize);
        if (from) next.from = from;
        if (to) next.to = to;
      } else if (type === 'path' || type === 'polyline' || type === 'curve' || type === 'freehand' || type === 'scribble') {
        const pts = Array.isArray(next.points) ? next.points : (Array.isArray(next.path) ? next.path : []);
        const coerced = pts.map(pt => _gv2CoerceAnnotatorPoint(pt, imageSize)).filter(Boolean);
        if (coerced.length) next.points = coerced;
      }
      return next;
    });
  }
  out.__coordinateDebug = {
    imageSize: imageSize || null,
    rawRegion: clonedRaw.region_bbox || clonedRaw.region || clonedRaw.crop || clonedRaw.bbox || null,
    coercedRegion: out.region_bbox || null,
    rawAnnotations: Array.isArray(clonedRaw.annotations) ? clonedRaw.annotations : [],
    coercedAnnotations: Array.isArray(out.annotations) ? out.annotations : []
  };
  return out;
}

/**
 * The on-page renderer's input, built from one captured evidence item.
 *
 * pageguideShowEvidenceAnnotations places shapes in DOCUMENT coordinates, and the annotator's
 * coordinates are fractions of the screenshot it was shown — so the capture geometry (where the
 * page was standing, and how big the viewport was) is what converts one to the other. An item with
 * neither shapes nor a region has nothing to draw.
 *
 * @param {object} cap - a gv2CaptureEvidenceItems result
 * @param {number|null} evidenceNumber - the chip number, so [ev:N] can scroll to this mark
 * @returns {object|null} marks for pageguideShowEvidenceAnnotations
 */
function _gv2MarksFromCapture(cap, evidenceNumber = null) {
  if (!cap || typeof cap !== 'object') return null;
  const drawable = (m) => !!m && ((Array.isArray(m.annotations) && m.annotations.length) || m.region_bbox);
  if (cap.marks && typeof cap.marks === 'object') return drawable(cap.marks) ? cap.marks : null;
  const annotations = Array.isArray(cap.annotations) ? cap.annotations : [];
  const region = cap.annotationRegionBbox || cap.region_bbox || cap.visualEvidenceNormRect || null;
  if (!annotations.length && !region) return null;
  const geometry = cap.annotationGeometry || cap.captureGeometry || null;
  return {
    annotations,
    region_bbox: region,
    annotationGeometry: geometry,
    captureGeometry: geometry,
    visualEvidenceIndex: cap.visualEvidenceIndex != null ? cap.visualEvidenceIndex : null,
    evidenceNumber,
    source_image_id: cap.source_image_id || 'viewport',
    note: cap.note || cap.visualEvidenceReason || ''
  };
}

/**
 * Put the annotator's shapes on the REAL page, not only in the evidence crop.
 *
 * A box drawn over a picture of the page proves less than the same box drawn over the page the
 * user is looking at, and it is far easier to act on — so every annotated evidence item the user
 * is shown is also replayed onto the live DOM.
 *
 * Called when a run REACHES ITS ANSWER, never mid-run: the overlay would otherwise land in the
 * screenshots the next step is generated from, and pageguideShowEvidenceAnnotations scrolls to its
 * first mark, which would move the page out from under the agent.
 *
 * @param {Array<object>} caps - captured evidence items (or items carrying a `marks` bag)
 * @returns {number} how many shapes were drawn
 */
function gv2DrawEvidenceMarksOnPage(caps) {
  try {
    if (typeof pageguideShowEvidenceAnnotations !== 'function') return 0;
    const marks = (Array.isArray(caps) ? caps : [])
      .map((cap, i) => _gv2MarksFromCapture(cap, i + 1))
      .filter(Boolean);
    if (!marks.length) return 0;
    const drawn = pageguideShowEvidenceAnnotations(marks) || 0;
    console.log(`[guidev2] drew ${drawn} evidence mark(s) on the live page`);
    return drawn;
  } catch (e) {
    console.warn('[guidev2] on-page evidence marks failed:', e);
    return 0;
  }
}

async function gv2CaptureEvidenceItems(items, options = {}) {
  const maxItems = Number(options.maxItems);
  const input = Array.isArray(items)
    ? (Number.isFinite(maxItems) && maxItems > 0 ? items.slice(0, Math.floor(maxItems)) : items.slice())
    : [];
  const out = [];
  const startX = window.scrollX || 0;
  const startY = window.scrollY || 0;
  const shouldRestore = options.restoreScroll === true;
  let annotationShot = null;
  // Where the page was standing when annotationShot was taken. Annotation coordinates are
  // fractions of THAT screenshot, so this is what converts them back to document coordinates when
  // the marks are replayed on the live page (pageguideShowEvidenceAnnotations).
  let annotationGeometry = null;
  const annotationGroups = new Map();
  for (const item of input) {
    if (!_gv2EvidenceItemNeedsAnnotator(item)) continue;
    const key = _gv2AnnotationSourceKey(item);
    if (!annotationGroups.has(key)) annotationGroups.set(key, []);
    annotationGroups.get(key).push(item);
  }

  for (const groupItems of annotationGroups.values()) {
    if (!groupItems.length) continue;
    const first = groupItems[0];
    let itemAnnotationShot = null;
    let itemAnnotationGeometry = null;
    try {
      if (first.annotationSourceShot) {
        itemAnnotationShot = first.annotationSourceShot;
        itemAnnotationGeometry = first.annotationSourceGeometry || null;
        for (const item of groupItems) {
          item.evidenceRect = { x: 0, y: 0, w: 1, h: 1 };
          item.fullViewportCapture = true;
        }
      } else if (first.annotationSourceEl && document.contains(first.annotationSourceEl)) {
        await _gv2ScrollRegionTargetIntoView(first.annotationSourceEl, { exact: true, fitInViewport: true });
        await _gv2WaitForLayoutSettle();
        for (const item of groupItems) {
          if (!item.evidenceRect && typeof gv2TargetNormRect === 'function') {
            const src = item.annotationSourceEl && document.contains(item.annotationSourceEl) ? item.annotationSourceEl : first.annotationSourceEl;
            const r = src.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              item.evidenceRect = gv2TargetNormRect({ left: r.left, top: r.top, width: r.width, height: r.height },
                window.innerWidth, window.innerHeight);
              item.region_bbox = item.region_bbox || item.evidenceRect;
            }
          }
        }
        itemAnnotationShot = typeof captureScreenshot === 'function' ? await captureScreenshot() : null;
        itemAnnotationGeometry = {
          x: window.scrollX || 0,
          y: window.scrollY || 0,
          w: window.innerWidth || 0,
          h: window.innerHeight || 0
        };
      } else if (first.annotationSourceGeometry) {
        const g = first.annotationSourceGeometry;
        try { window.scrollTo({ top: Number(g.y) || 0, left: Number(g.x) || 0, behavior: 'instant' in window ? 'instant' : 'auto' }); } catch (e) {}
        await _gv2WaitForLayoutSettle();
        for (const item of groupItems) {
          item.evidenceRect = item.evidenceRect || item.region_bbox || item.annotationSourceRect || first.annotationSourceRect || { x: 0, y: 0, w: 1, h: 1 };
          item.region_bbox = item.region_bbox || item.evidenceRect;
        }
        itemAnnotationShot = typeof captureScreenshot === 'function' ? await captureScreenshot() : null;
        itemAnnotationGeometry = {
          x: window.scrollX || 0,
          y: window.scrollY || 0,
          w: window.innerWidth || 0,
          h: window.innerHeight || 0
        };
      } else {
        if (!annotationShot && typeof captureScreenshot === 'function') {
          annotationShot = await captureScreenshot();
          annotationGeometry = {
            x: window.scrollX || 0,
            y: window.scrollY || 0,
            w: window.innerWidth || 0,
            h: window.innerHeight || 0
          };
        }
      }
    } catch (e) {}

    const shotForGroup = itemAnnotationShot || annotationShot;
    const geometryForGroup = itemAnnotationGeometry || annotationGeometry;
    groupItems.forEach(item => {
      item.annotationGeometry = geometryForGroup;
      item.captureGeometry = geometryForGroup;
    });
    const annotatedItems = await _gv2AnnotateEvidenceItemsBatch(groupItems, shotForGroup);
    groupItems.forEach((item, idx) => {
      _gv2ApplyAnnotatorResultToItem(item, annotatedItems[idx], shotForGroup);
    });
  }

  for (const item of input) {
    if (!_gv2EvidenceItemNeedsAnnotator(item) || item._gv2AnnotationDone) {
      // Already handled by the grouped annotator pre-pass, or no annotation is needed.
    } else {
      let itemAnnotationShot = null;
      let itemAnnotationGeometry = null;
      try {
        if (item.annotationSourceShot) {
          itemAnnotationShot = item.annotationSourceShot;
          itemAnnotationGeometry = item.annotationSourceGeometry || null;
          item.evidenceRect = { x: 0, y: 0, w: 1, h: 1 };
          item.fullViewportCapture = true;
        } else if (item.annotationSourceEl && document.contains(item.annotationSourceEl)) {
          await _gv2ScrollRegionTargetIntoView(item.annotationSourceEl, { exact: true, fitInViewport: true });
          await _gv2WaitForLayoutSettle();
          if (!item.evidenceRect && typeof gv2TargetNormRect === 'function') {
            const r = item.annotationSourceEl.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              item.evidenceRect = gv2TargetNormRect({ left: r.left, top: r.top, width: r.width, height: r.height },
                window.innerWidth, window.innerHeight);
              item.region_bbox = item.region_bbox || item.evidenceRect;
            }
          }
          itemAnnotationShot = typeof captureScreenshot === 'function' ? await captureScreenshot() : null;
          itemAnnotationGeometry = {
            x: window.scrollX || 0,
            y: window.scrollY || 0,
            w: window.innerWidth || 0,
            h: window.innerHeight || 0
          };
        } else if (item.annotationSourceGeometry) {
          const g = item.annotationSourceGeometry;
          try { window.scrollTo({ top: Number(g.y) || 0, left: Number(g.x) || 0, behavior: 'instant' in window ? 'instant' : 'auto' }); } catch (e) {}
          await _gv2WaitForLayoutSettle();
          item.evidenceRect = item.evidenceRect || item.region_bbox || item.annotationSourceRect || { x: 0, y: 0, w: 1, h: 1 };
          item.region_bbox = item.region_bbox || item.evidenceRect;
          itemAnnotationShot = typeof captureScreenshot === 'function' ? await captureScreenshot() : null;
          itemAnnotationGeometry = {
            x: window.scrollX || 0,
            y: window.scrollY || 0,
            w: window.innerWidth || 0,
            h: window.innerHeight || 0
          };
        } else if (!annotationShot && typeof captureScreenshot === 'function') {
          annotationShot = await captureScreenshot();
          annotationGeometry = {
            x: window.scrollX || 0,
            y: window.scrollY || 0,
            w: window.innerWidth || 0,
            h: window.innerHeight || 0
          };
        }
      } catch (e) {}
      const shotForItem = itemAnnotationShot || annotationShot;
      const geometryForItem = itemAnnotationGeometry || annotationGeometry;
      item.annotationGeometry = geometryForItem;
      item.captureGeometry = geometryForItem;
      const annotated = await _gv2AnnotateEvidenceItem(item, shotForItem);
      _gv2ApplyAnnotatorResultToItem(item, annotated, shotForItem);
    }
    if ((item?.fullViewportCapture || item?.need_annotation || item?.needAnnotation || (Array.isArray(item?.annotations) && item?.annotations.length)) && !item?.evidenceEl && !item?.evidenceRect) {
      item.evidenceRect = { x: 0, y: 0, w: 1, h: 1 };
      item.fullViewportCapture = true;
    }
    if (!item || (!item.evidenceEl && !item.evidenceRect)) {
      out.push({
        key: item?.key || null,
        note: item?.note || null,
        source_image_id: item?.source_image_id || null,
        som_id: item?.som_id || null,
        region_bbox: _gv2EvidenceDisplayRegion(item),
        annotationRegionBbox: item?.annotationRegionBbox || null,
        annotations: Array.isArray(item?.annotations) ? item.annotations : [],
        need_annotation: !!(item?.need_annotation || item?.needAnnotation),
        annotation_prompt: item?.annotation_prompt || item?.annotationPrompt || null,
        annotationSystemPrompt: item?.annotationSystemPrompt || '',
        annotationUserPrompt: item?.annotationUserPrompt || '',
        annotationScreenshot: item?.annotationScreenshot || null,
        annotationRawResponse: item?.annotationRawResponse || '',
        annotationCoordinateDebug: item?.annotationCoordinateDebug || null,
        annotationGeometry: item?.annotationGeometry || item?.captureGeometry || null,
        captureGeometry: item?.captureGeometry || null,
        annotationError: item?.annotationError || (item?.evidenceRect ? null : 'missing-target'),
        visualEvidenceShot: null,
        visualEvidenceOriginalShot: null,
        visualEvidenceNormRect: item?.evidenceRect || null,
        visualEvidenceMarker: null,
        visualEvidenceText: item?.text || null,
        visualEvidenceReason: item?.reason || null,
        visualEvidenceIndex: item?.evidenceIndex != null ? item.evidenceIndex : null,
        captureMode: item?.evidenceRect ? 'bbox_viewport' : null,
        captureError: item?.evidenceRect ? null : 'missing-target'
      });
      continue;
    }
    let cap = { visualEvidenceShot: null, visualEvidenceOriginalShot: null, visualEvidenceNormRect: null, visualEvidenceMarker: null, captureMode: null, captureError: null };
    try {
      cap = await gv2CaptureEvidenceRegion(item.evidenceEl, item.evidenceIndex, item.evidenceRect, {
        scrollIntoView: !!item.scrollIntoView,
        forceDomMarker: !!item.forceDomMarker,
        // Guide's historical behaviour: with Vision on, mark the target with a DOM overlay so it
        // is visible in the captured pixels. Only the Guide's own evidence opts into this.
        visionMarkerDefault: !!(window._guidev2 && window._guidev2._lastVisualInputOn),
        // Some targets are already visibly marked on the page (Find citation spans carry the
        // highlight tint), so an extra box would be redundant — and any drift between the rect we
        // measured and the pixels we captured shows up as a box in the wrong place.
        noMarker: !!item.noMarker,
        fullViewport: !!item.fullViewportCapture,
        annotations: Array.isArray(item.annotations) ? item.annotations : [],
        screenshotBase64: (!item.evidenceEl && (item.annotationScreenshot || annotationShot)) ? (item.annotationScreenshot || annotationShot) : null
      });
    } catch (e) { cap.captureError = e?.message || 'capture-failed'; }
    out.push({
      key: item.key || null,
      note: item.note || null,
      source_image_id: item.source_image_id || null,
      som_id: item.som_id || null,
      region_bbox: _gv2EvidenceDisplayRegion(item),
      annotationRegionBbox: item.annotationRegionBbox || null,
      annotations: Array.isArray(item.annotations) ? item.annotations : [],
      need_annotation: !!(item.need_annotation || item.needAnnotation),
      annotation_prompt: item.annotation_prompt || item.annotationPrompt || null,
      annotationSystemPrompt: item.annotationSystemPrompt || '',
      annotationUserPrompt: item.annotationUserPrompt || '',
      annotationScreenshot: item.annotationScreenshot || null,
      annotationRawResponse: item.annotationRawResponse || '',
      annotationCoordinateDebug: item.annotationCoordinateDebug || null,
      annotationError: item.annotationError || null,
      annotationGeometry: item.annotationGeometry || item.captureGeometry || cap.captureGeometry || null,
      captureGeometry: item.captureGeometry || cap.captureGeometry || null,
      visualEvidenceShot: cap.visualEvidenceShot || null,
      visualEvidenceOriginalShot: cap.visualEvidenceOriginalShot || null,
      visualEvidenceNormRect: cap.visualEvidenceNormRect || item.evidenceRect || null,
      visualEvidenceMarker: cap.visualEvidenceMarker || null,
      visualEvidenceText: item.text || null,
      visualEvidenceReason: item.reason || null,
      visualEvidenceIndex: item.evidenceIndex != null ? item.evidenceIndex : null,
      captureMode: cap.captureMode || (item.evidenceRect ? (item.fullViewportCapture ? 'bbox_full_viewport' : 'bbox_viewport') : null),
      captureError: cap.captureError || null
    });
  }
  if (shouldRestore) {
    try { window.scrollTo(startX, startY); } catch (e) { /* best-effort */ }
  }
  return out;
}
if (typeof window !== 'undefined') {
  window.gv2CaptureEvidenceItems = gv2CaptureEvidenceItems;
  window._gv2RealCaptureEvidenceItems = gv2CaptureEvidenceItems;
  window._gv2ApplyAnnotatorResultToItem = _gv2ApplyAnnotatorResultToItem;
  window._gv2AnnotatesExternalSource = _gv2AnnotatesExternalSource;
  window._gv2EvidenceDisplayRegion = _gv2EvidenceDisplayRegion;
  window._gv2MarksFromCapture = _gv2MarksFromCapture;
  window.gv2DrawEvidenceMarksOnPage = gv2DrawEvidenceMarksOnPage;
}

async function gv2RunTerminalVerifyResult({ action, instruction, findQuery, visualEvidenceItems, restoreScroll = false } = {}) {
  const startX = window.scrollX || 0;
  const startY = window.scrollY || 0;
  const out = {
    verifyResultSystemPrompt: '',
    verifyResultUserPrompt: '',
    verifyResultRawResponse: '',
    verifyResultShot: null,
    verifyResultScrollY: startY,
    verifyResultAction: action || '',
    verifyResultError: null
  };
  try {
    await _gv2WaitForPageReady(10000);
    // The sweep exists to see what the action DID. If the action opened a filter popup, the popup
    // is what has to be swept — scrolling the page behind it reveals nothing and the verification
    // then judges the result from a screenshot of the wrong thing.
    const swept = (typeof gv2ScrollBy === 'function')
      ? gv2ScrollBy('down', null)
      : null;
    const scroller = swept?.el || document.scrollingElement || document.documentElement || document.body;
    await gv2WaitForDomStable(4000, 500);
    out.verifyResultScrollY = window.scrollY || scroller?.scrollTop || startY;
    let shot = null;
    try { if (typeof captureScreenshot === 'function') shot = await captureScreenshot(); } catch (e) { /* best-effort */ }
    out.verifyResultShot = shot || null;

    const evidenceText = Array.isArray(visualEvidenceItems) && visualEvidenceItems.length
      ? visualEvidenceItems.slice(0, 5).map((item, i) => {
          const pointer = item?.evidenceIndex != null ? `index ${item.evidenceIndex}` : (item?.evidenceRect ? 'rect' : 'unknown');
          return `${i + 1}. ${pointer}: ${item?.reason || item?.text || ''}`;
        }).join('\n')
      : '(none)';
    out.verifyResultSystemPrompt = `You are verifying a terminal browser-guide result before the guide returns its final answer. The page has been allowed to load, then scrolled down at least once. Use the screenshot as primary evidence. Reply with ONLY JSON:
{"status":"ready"|"not_ready"|"unclear","reason":"one sentence","visibleEvidence":"short evidence seen in the scrolled screenshot"}
- status="ready" means the page appears loaded and likely contains enough visible context for the terminal action.
- status="not_ready" means the page is still loading, wrong, empty, or visibly missing needed context.
- Do not perform the task and do not write the final user answer.`;
    out.verifyResultUserPrompt = `USER GOAL: ${window._guidev2?.question || ''}
TERMINAL ACTION: ${action || ''}
PLANNED INSTRUCTION: ${instruction || ''}
FIND QUERY: ${findQuery || ''}
VISUAL EVIDENCE TARGETS:
${evidenceText}

Verify whether this scrolled page state is ready for the terminal ${action || 'answer'} action.`;
    const msg = {
      action: shot ? 'callLLMWithImages' : 'callLLM',
      systemPrompt: out.verifyResultSystemPrompt,
      messages: [{ role: 'user', content: out.verifyResultUserPrompt }],
      metadata: { mode: 'guide_verify_result', step: window._guidev2?._activeStepNumber || null, url: window.location.href }
    };
    if (shot) msg.images = [{ base64: shot, label: 'Scrolled page screenshot for Verify Result' }];
    let response = await safeSendMessage(msg);
    if (shot && response?.error) {
      response = await safeSendMessage({ ...msg, action: 'callLLM', images: undefined });
    }
    out.verifyResultRawResponse = response?.content ? String(response.content) : '';
    if (response?.error) out.verifyResultError = response.error;
  } catch (e) {
    out.verifyResultError = e?.message || String(e);
  } finally {
    if (restoreScroll) {
      try {
        const scroller = document.scrollingElement || document.documentElement || document.body;
        if (scroller) scroller.scrollTop = startY;
        if (scroller) scroller.scrollLeft = startX;
      } catch (e) {}
      try { await gv2WaitForDomStable(2000, 250); } catch (e) {}
    }
  }
  return out;
}

async function gv2CaptureStepRecord(data) {
  const g = window._guidev2;
  if (!g || !g.active || !g.captureEnabled || !g.sessionId) return;
  if (typeof rewindPutRecord !== 'function') return;

  // Stash so a later re-capture (e.g. after auto-type fills a field) can reuse the
  // same reasoning fields and only refresh the screenshot/DOM snapshot.
  g._lastCaptureData = data;

  const startedAt = g._stepStartedAt || Date.now();

  // Text evidence mode takes NO captures: no per-step screenshot, no region crop, no evidence
  // crops, no annotation agent. The step is still recorded — the journey, the timeline and the
  // [evidence] popups render data.targetEvidence (node text / aria-label / selector / page)
  // instead of an image. Everything screenshot-shaped below is guarded on this flag, including
  // the "void step (no screenshot) → skip" rule, which would otherwise drop every text-mode step.
  const captureShots = typeof gv2ShouldCaptureScreenshots === 'function'
    ? gv2ShouldCaptureScreenshots(data.evidenceMode)
    : true;

  // BEFORE-action screenshot = the PREVIOUS step's AFTER-shot (carried forward). The page hasn't
  // changed between step N-1's after-capture and step N's before, so this is the same image — and
  // reusing it avoids a second back-to-back captureVisibleTab that Chrome rate-limits (the cause
  // of "step 2 has no screenshot"). Fall back to a fresh capture only when there's no carried shot
  // yet (the first step, or right after a navigation-resume).
  const stepNum = Number(data.step);
  let beforeShot = (Number.isFinite(stepNum) && g._lastAfterShotStep === stepNum - 1) ? g._lastAfterShot : null;
  if (!beforeShot && captureShots) {
    try { if (typeof captureScreenshot === 'function') beforeShot = await captureScreenshot(); }
    catch (e) { /* best-effort */ }
  }
  if (!captureShots) beforeShot = null;

  if (!beforeShot && captureShots) {
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

  if (!beforeShot && captureShots) {
    // If still no screenshot, use a 1x1 transparent placeholder so the step is not void,
    // ensuring the record is stored and shown in the timeline/Inspector.
    beforeShot = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    console.log(`📸 No screenshot could be captured/found for step ${stepNum}. Using placeholder.`);
  }

  // VERIFICATION: in Visual mode a step with no screenshot is void — skip it entirely (don't
  // announce a dot, don't store a record), so the timeline and the stored journey only contain
  // valid steps. In Text mode there is never a screenshot and the step is still valid.
  if (!beforeShot && captureShots) {
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
        instruction: data.instruction || '',
        action: data.action || null,
        dropTarget: data.dropTarget || null,
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
        embeddingError: data.embeddingError || null,
        mechLoop: data.mechLoop != null ? data.mechLoop : null,
        loopMatches: data.loopMatches != null ? data.loopMatches : null,
        domElementText: data.domElementText || null,
        llmElementText: data.llmElementText || null,
        resolvedIndex: data.resolvedIndex != null ? data.resolvedIndex : null,
        planTotal: data.planTotal != null ? data.planTotal : null,
        planCompleted: data.planCompleted != null ? data.planCompleted : null,
        confidenceSource: data.confidenceSource || null,
        confirmation: data.confirmation || null,
        llmStep: data.llmStep != null ? data.llmStep : null,
        expectedStep: data.expectedStep != null ? data.expectedStep : null,
        stepNumberCorrected: !!data.stepNumberCorrected,
        hasShot: captureShots,
        evidenceMode: captureShots ? 'visual' : 'text',
        targetEvidence: data.targetEvidence || null,
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
    let alignedRegion = false;
    if (captureShots) {
      alignedRegion = await _gv2ShouldUseAlignedRegionCapture(g);
      try { region = await gv2CaptureRegion(beforeShot, { aligned: alignedRegion, markerNumber: data.resolvedIndex }); } catch (e) { /* best-effort */ }
    }

    // Separate visual-evidence region: the on-page proof that justifies this step (distinct SoM
    // element resolved in gv2ProcessResponse). Only captured when the model supplied one (recap on).
    // Skip for visual_highlight: that action already cropped this exact region as its answer image
    // (gv2ProcessResponse), so re-capturing here would just double-hit the screenshot rate limit.
    let evidenceItems = [];
    if (captureShots && data.action !== 'visual_highlight') {
      const rawEvidenceItems = Array.isArray(data.visualEvidenceItems)
        ? data.visualEvidenceItems
        : ((data.evidenceEl || data.evidenceRect) ? [{
            evidenceEl: data.evidenceEl,
            evidenceIndex: data.evidenceIndex,
            evidenceRect: data.evidenceRect,
            text: data.visualEvidenceText || null,
            reason: data.visualEvidenceReason || null
          }] : []);
      evidenceItems = await gv2CaptureEvidenceItems(rawEvidenceItems, { restoreScroll: true });
    }
    const savedEvidenceItems = Array.isArray(data.savedEvidenceItems) ? data.savedEvidenceItems : [];
    // Text mode: no crops and no annotation agent — carry the entries through as text only, keeping
    // the same {key, note} shape every reader already understands, plus the textual target.
    const savedEvidenceCapturesRaw = (savedEvidenceItems.length && captureShots)
      ? await gv2CaptureEvidenceItems(savedEvidenceItems, { restoreScroll: true })
      : savedEvidenceItems;
    const savedEvidenceCaptures = savedEvidenceCapturesRaw.map(item => ({
      key: item.key || null,
      note: item.note || null,
      textualEvidence: item.textualEvidence || null,
      shot: item.visualEvidenceShot || null,
      originalShot: item.visualEvidenceOriginalShot || null,
      marker: item.visualEvidenceMarker || null,
      region_bbox: captureShots ? (item.region_bbox || item.visualEvidenceNormRect || null) : null,
      // Text mode never runs the annotator, so nothing downstream should advertise annotations.
      annotations: captureShots && Array.isArray(item.annotations) ? item.annotations : [],
      need_annotation: captureShots && !!item.need_annotation,
      annotation_prompt: captureShots ? (item.annotation_prompt || null) : null,
      annotationSystemPrompt: item.annotationSystemPrompt || '',
      annotationUserPrompt: item.annotationUserPrompt || '',
      annotationScreenshot: item.annotationScreenshot || null,
      annotationRawResponse: item.annotationRawResponse || '',
      annotationCoordinateDebug: item.annotationCoordinateDebug || null,
      annotationError: item.annotationError || null,
      annotationResultShot: item.visualEvidenceShot || null,
      annotationOriginalShot: item.visualEvidenceOriginalShot || null,
      som_id: item.som_id || null,
      captureMode: item.captureMode || null,
      captureError: item.captureError || null
    }));
    // The run is over on the terminal step, so the marks can go onto the live page: the user is
    // being asked to check an answer, and the shapes are far easier to read over the real page than
    // over a crop of it. Saved evidence first — it is what the answer cites — then the finish
    // step's own confirmation evidence.
    if (captureShots && (data.isLastStep || data.action === 'finish')) {
      const terminalMarks = [...savedEvidenceCapturesRaw, ...evidenceItems];
      if (terminalMarks.length) gv2DrawEvidenceMarksOnPage(terminalMarks);
    }

    const firstEvidence = evidenceItems[0] || {
      visualEvidenceShot: null,
      visualEvidenceOriginalShot: null,
      visualEvidenceNormRect: null,
      visualEvidenceMarker: null,
      visualEvidenceText: data.visualEvidenceText || null,
      visualEvidenceReason: data.visualEvidenceReason || null,
      visualEvidenceIndex: data.evidenceIndex != null ? data.evidenceIndex : null
    };

    const record = {
      sessionId: g.sessionId,
      step: data.step,
      planStep: data.planStep != null ? data.planStep : data.step,
      completedPlanStep: data.completedPlanStep != null ? data.completedPlanStep : null,
      completedPlanStepReason: data.completedPlanStepReason || '',
      timestamp: Date.now(),
      url: window.location.href,
      title: document.title || '',
      instruction: data.instruction || '',
      action: data.action || null,
      typeText: data.typeText != null ? data.typeText : null,
      navigateUrl: data.navigateUrl || null,
      dropTarget: data.dropTarget || null,
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
      embeddingError: data.embeddingError || null,
      mechLoop: data.mechLoop != null ? data.mechLoop : null,
      loopMatches: data.loopMatches != null ? data.loopMatches : null,
      domElementText: data.domElementText || null,
      llmElementText: data.llmElementText || null,
      resolvedIndex: data.resolvedIndex != null ? data.resolvedIndex : null,
      planTotal: data.planTotal != null ? data.planTotal : null,
      planCompleted: data.planCompleted != null ? data.planCompleted : null,
      confidenceSource: data.confidenceSource || null,
      confirmation: data.confirmation || null,
      llmStep: data.llmStep != null ? data.llmStep : null,
      expectedStep: data.expectedStep != null ? data.expectedStep : null,
      stepNumberCorrected: !!data.stepNumberCorrected,
      // Study axis: 'visual' (screenshots) or 'text' (no captures — readers fall back to
      // targetEvidence: node text, aria-label, selector, page URL).
      evidenceMode: captureShots ? 'visual' : 'text',
      targetEvidence: data.targetEvidence || null,
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
      // Visual Recap marker evidence: full pre-action shot aligned to the target, plus normalized
      // marker rects for the full shot (targetNormRect) and the regionShot crop (regionMarker).
      markedShot: region.markedShot || null,
      targetNormRect: region.targetNormRect || null,
      regionMarker: region.regionMarker || null,
      // Full-viewport screenshot with numbered SoM markers baked in that was sent to the LLM (only
      // present when Visual input is on). Surfaced in the rewind inspector.
      somInputShot: g._lastVisualInputShot || null,
      // Visual evidence: the SEPARATE on-page proof that justifies this step (pink-marked crop of a
      // distinct SoM element, e.g. "Sort by: Price: Low to High"), plus its reason and resolved index.
      visualEvidenceItems: evidenceItems,
      visualEvidenceShot: firstEvidence.visualEvidenceShot || null,
      visualEvidenceOriginalShot: firstEvidence.visualEvidenceOriginalShot || null,
      visualEvidenceNormRect: firstEvidence.visualEvidenceNormRect || null,
      visualEvidenceMarker: firstEvidence.visualEvidenceMarker || null,
      visualEvidenceText: firstEvidence.visualEvidenceText || null,
      visualEvidenceReason: firstEvidence.visualEvidenceReason || null,
      visualEvidenceIndex: firstEvidence.visualEvidenceIndex != null ? firstEvidence.visualEvidenceIndex : null,
      confirmationEvidenceSkippedReason: data.confirmationEvidenceSkippedReason || '',
      savedEvidenceCaptures,
      // visual_highlight terminal answer: the cropped screenshot region shown to the user.
      visualHighlightImage: data.visualHighlightImage || null,
      visualHighlightCaption: data.visualHighlightCaption || null,
      // Terminal Verify Result pass: page-ready wait + one scroll-down + screenshot + LLM response,
      // run before returning a find/visual_highlight answer.
      verifyResultSystemPrompt: data.verifyResultSystemPrompt || '',
      verifyResultUserPrompt: data.verifyResultUserPrompt || '',
      verifyResultRawResponse: data.verifyResultRawResponse || '',
      verifyResultShot: data.verifyResultShot || null,
      verifyResultScrollY: data.verifyResultScrollY != null ? data.verifyResultScrollY : null,
      verifyResultAction: data.verifyResultAction || null,
      verifyResultError: data.verifyResultError || null,
      findSystemPrompt: data.findSystemPrompt || '',
      findUserPrompt: data.findUserPrompt || '',
      findRawResponse: data.findRawResponse || '',
      visualFallbackSystemPrompt: data.visualFallbackSystemPrompt || '',
      visualFallbackUserPrompt: data.visualFallbackUserPrompt || '',
      visualFallbackRawResponse: data.visualFallbackRawResponse || '',
      visualFallbackShot: data.visualFallbackShot || null,
      predictedGoalState: g.predictedGoalState || null,
      g_goal_relevance_score: goalRelevance,
      tutorialMatch: data.tutorialMatch || null,
      rawLlmJson: data.rawLlmJson || '',
      systemPrompt: data.systemPrompt || '',
      userPrompt: data.userPrompt || ''
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
    const captureShots = await _gv2CaptureShotsAllowed();
    let screenshot = null;
    if (captureShots) {
      try { if (typeof captureScreenshot === 'function') screenshot = await captureScreenshot(); }
      catch (e) { /* best-effort */ }
    }

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
      afterCaptureStatus: screenshot ? 'captured' : (captureShots ? 'missing' : 'text-mode')
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
    const captureShots = await _gv2CaptureShotsAllowed();
    let screenshot = null;
    if (captureShots) {
      try { if (typeof captureScreenshot === 'function') screenshot = await captureScreenshot(); }
      catch (e) { /* best-effort */ }
    }
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
      evidenceMode: captureShots ? 'visual' : 'text',
      // The initial state has no target element — the page itself is the evidence.
      targetEvidence: captureShots
        ? null
        : { text: document.title || '', ariaLabel: '', selector: '', url: window.location.href },
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

/**
 * Start guidance for a new question (called by the router override at bottom of file).
 */
async function _handleStepByStepGuideV2(question) {
  _guidev2Stopped = false;
  await _gv2ClearStopMark(); // a fresh guide overrides any prior Stop tombstone
  // Look up a pre-verified tutorial ONCE at the start. Result is cached in
  // window._guidev2.tutorialRef so intermediate steps reuse it for free.
  const match = await _gv2FindTutorial(question, window.location.href);

  // Rewind (Slice 1): start a fresh capture session. sessionId rides along in the
  // persisted state so the resumed page on the next navigation keeps writing to it.
  const sessionId = 'gv2-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const captureEnabled = await _gv2IsCaptureEnabled();
  const autonomyLevel = await _gv2AutonomyLevel();
  const autoMode = autonomyLevel !== 'manual';
  const recapOn = await _gv2IsVisualRecapOn();
  // Personalization context (facts + learned profile) is read ONCE per session, like tutorialRef,
  // so the ~20-step guide loop doesn't re-read chrome.storage on every step.
  const personalizationContext = await _gv2LoadPersonalizationContext();

  window._guidev2 = {
    active: true,
    question,
    previousSteps: [],
    tutorialRef: match?.tutorial || null,
    tutorialReason: match?.reason || null,
    personalizationContext,
    sessionId,
    captureEnabled,
    autoMode,
    autonomyLevel,
    _recapOn: recapOn,
    paused: false,
    lowConfidenceCount: 0,
    loopStepCount: 0,
    _mechKeys: [],
    _mechElementTexts: [],
    evidenceScratchpad: [],
    guidePlan: [],
    guideTitle: '',
    _planAttempted: false,
    currentPlanStep: 1,
    attachmentContext: '',  // compact text from an ingested image/file (carried every step)
    attachmentImage: null   // raw base64 for the first-step image attach (not persisted)
  };

  // Ingest any attached image/file ONCE: image → vision description, large file →
  // summary, small file → raw. Cheap text rides on every step; the raw image is
  // attached only on the first step (see gv2GenerateNextStep). Never blocks the guide.
  try {
    if (typeof gv2IngestAttachment === 'function') await gv2IngestAttachment(window._guidev2);
  } catch (e) {
    console.warn('[guidev2] attachment ingest failed:', e);
  }

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

function _gv2ParseStepContract(content) {
  try {
    return (typeof gv2ExtractJsonObject === 'function')
      ? gv2ExtractJsonObject(content)
      : JSON.parse(content);
  } catch (e) {
    return null;
  }
}

function _gv2EmptyContractValue(value) {
  if (value == null || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') {
    return /^(|no|none|null|n\/a|na|false)$/i.test(value.trim());
  }
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function _gv2ConfirmationItemHasTarget(item) {
  if (!item || typeof item !== 'object') return false;
  return item.index != null
    || !!item.rect
    || !!(item.text && String(item.text).trim())
    || item.need_annotation === true
    || !!(item.annotation_prompt && String(item.annotation_prompt).trim());
}

function _gv2EvidenceAttempted(value) {
  if (_gv2EmptyContractValue(value)) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function _gv2StepContractIssue(content, g = null) {
  const step = _gv2ParseStepContract(content);
  if (!step) return null;
  const action = (typeof gv2NormalizeAction === 'function')
    ? gv2NormalizeAction(step.action, step.isLastStep)
    : String(step.action || (step.isLastStep ? 'finish' : '')).toLowerCase().replace(/[\s-]+/g, '_');

  if (action === 'save_evidence') {
    return {
      kind: 'legacy_save_evidence_action',
      message: 'Evidence is not a standalone action; choose the real browser action and attach evidence to it.'
    };
  }

  if (action === 'finish') {
    const hasPriorSavedEvidence = Array.isArray(g?.evidenceScratchpad) && g.evidenceScratchpad.length > 0;
    const finishEvidenceAttempted = _gv2EvidenceAttempted(step.evidence);
    const finishEvidenceValid = finishEvidenceAttempted && typeof gv2NormalizeEvidenceList === 'function'
      ? gv2NormalizeEvidenceList(step.evidence, {
          ref_step_id: Number(step.step) || 0,
          existingKeys: (Array.isArray(g?.evidenceScratchpad) ? g.evidenceScratchpad : []).map(e => e?.key)
        }).ok
      : false;
    if (hasPriorSavedEvidence || finishEvidenceValid) return null;
    const rawConfirmation = step.confirmationEvidence != null ? step.confirmationEvidence : step.visualEvidence;
    const normalized = (typeof gv2NormalizeVisualEvidenceList === 'function')
      ? gv2NormalizeVisualEvidenceList(rawConfirmation, 5)
      : [];
    const hasUsableTarget = normalized.some(_gv2ConfirmationItemHasTarget);
    if (_gv2EmptyContractValue(rawConfirmation) || !hasUsableTarget) {
      return {
        kind: 'missing_confirmation_evidence',
        message: 'action="finish" must include non-empty confirmationEvidence with a page target.'
      };
    }
  }

  if (_gv2EvidenceAttempted(step.evidence)) {
    const normalized = (typeof gv2NormalizeEvidenceList === 'function')
      ? gv2NormalizeEvidenceList(step.evidence, { ref_step_id: 0 })
      : {
          ok: (Array.isArray(step.evidence) ? step.evidence : [step.evidence])
            .some(e => e && typeof e === 'object' && String(e.key || '').trim() && String(e.note || '').trim())
        };
    if (!normalized.ok) {
      return {
        kind: 'invalid_evidence_sidecar',
        message: 'If evidence is provided, it must include at least one valid item.'
      };
    }
  }

  return null;
}

function _gv2ContractRetryPrompt(issue) {
  if (issue?.kind === 'missing_confirmation_evidence') {
    return `Your previous JSON cannot be accepted: action="finish" requires confirmationEvidence.
Return corrected JSON for the same step only. Keep action="finish", keep answer non-null, and add confirmationEvidence as an array with 1-5 items. Each item may include a citation-safe name, and must include a short reason plus either index, rect, text, or need_annotation=true with annotation_prompt. Cite it in answer as [ev:name] or [ev:index]. Do not explain outside JSON.`;
  }
  if (issue?.kind === 'legacy_save_evidence_action') {
    return `Your previous JSON cannot be accepted: "save_evidence" is not a valid standalone action anymore.
Return corrected JSON for the same step only. Choose the real browser action to perform now (click, type, clear_text, drag_drop, scroll_down, scroll_up, goto_url, watch_video, or finish). Keep the evidence array on that same step if the observed fact should be saved. Do not explain outside JSON.`;
  }
  if (issue?.kind === 'invalid_evidence_sidecar') {
    return `Your previous JSON cannot be accepted: when "evidence" is present it must be an array with at least one valid item.
Return corrected JSON for the same step only. Keep the real browser action, and either set evidence to null or provide evidence items with key and note; use som_id for DOM/SoM evidence, or need_annotation=true with annotation_prompt for screenshot-only evidence. Do not explain outside JSON.`;
  }
  return `Your previous JSON cannot be accepted: ${issue?.message || 'missing required fields'}.
Return corrected JSON for the same step only. Do not explain outside JSON.`;
}
if (typeof window !== 'undefined') {
  window._gv2StepContractIssue = _gv2StepContractIssue;
  window._gv2ContractRetryPrompt = _gv2ContractRetryPrompt;
}

function _gv2SavedEvidenceStepSummary(entries) {
  const list = Array.isArray(entries) ? entries.filter(e => e && (e.note || e.key)) : [];
  if (!list.length) return '';
  const count = list.length;
  const first = String(list[0].note || list[0].key || '').replace(/\s+/g, ' ').trim();
  const clippedRaw = first.length > 90 ? `${first.slice(0, 87).trim()}...` : first;
  const clipped = clippedRaw.replace(/[.!?]+$/g, '');
  return ` Saved ${count} evidence${count === 1 ? '' : ' items'}${clipped ? `: ${clipped}` : ''}.`;
}
if (typeof window !== 'undefined') window._gv2SavedEvidenceStepSummary = _gv2SavedEvidenceStepSummary;

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
  const visualInputOn = await _gv2IsVisualInputOn();
  let pageIndex;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (_gv2IsStopped()) return null;
    if (_gv2IsPaused()) return { success: false, progressed: false, error: 'Guide paused' };
    pageIndex = createPageIndex(GV2_GUIDE_INDEX_MAX_ITEMS, true);
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
  let visualInputShot = null;
  if (visualInputOn) {
    try {
      if (typeof showSetOfMarks === 'function') showSetOfMarks(pageIndex);
      await new Promise(r => setTimeout(r, 80));
      if (typeof captureScreenshot === 'function') visualInputShot = await captureScreenshot();
    } catch (e) {
      visualInputShot = null;
    } finally {
      try { if (typeof cleanupSom === 'function') cleanupSom(); } catch (e) {}
    }
  } else if (typeof showSomIfEnabled === 'function') {
    await showSomIfEnabled(pageIndex);
  }
  if (_gv2IsStopped()) return null;

  // Stash the exact SoM-marked screenshot sent to the LLM so gv2CaptureStepRecord can store it on
  // the step record (surfaced in the rewind inspector). Cleared each step so a text-only step
  // doesn't inherit a stale shot. Also record whether Vision (visual input) is on this step, so the
  // recap evidence capture can use the DOM-overlay marker method (nanobrowser style) vs canvas bake.
  g._lastVisualInputShot = visualInputShot || null;
  g._lastVisualInputOn = !!visualInputOn;

  const stepNumber = g.previousSteps.length + 1;
  console.log('[guidev2] Generating step', stepNumber, 'with', pageIndex.count, 'elements');

  if (stepNumber === 1) {
    await _gv2SetInitialPlan(g, pageIndex);
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

  let planSection = '';
  if (Array.isArray(g.guidePlan) && g.guidePlan.length) {
    planSection = `\n=== ORIGINAL PLAN ===
${g.guidePlan.map(p => {
  const isDone = g.currentPlanStep > p.n;
  const status = isDone ? 'complete' : (Number(p.n) === Number(g.currentPlanStep || 1) ? 'current' : 'pending');
  return `${p.n}. [${status}] ${p.goal}`;
}).join('\n')}
`;
  }

  const passHistory = await _gv2IsPassHistory();

  let completedStepsSection = '';
  let activeQuestion = g.question;

  if (g._steerRedoStep && g._steerMode === 'intent') {
    // Mode 2: Updating goal
    // Replace original goal with new intent
    activeQuestion = g._steerReason || activeQuestion;
    
    if (passHistory && Number(g._steerRedoStep) === stepNumber) {
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

  } else if (passHistory && g._steerRedoStep && Number(g._steerRedoStep) === stepNumber) {
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

  const recapOn = await _gv2IsVisualRecapOn();
  if (recapOn && g.sessionId) {
    try { g.evidenceScratchpad = await _gv2LoadEvidenceScratchpad(g.sessionId); } catch (e) {}
  }
  const systemPrompt = GUIDE_V2_PROMPT;
  const evidenceSection = recapOn
    ? `\n=== SAVED EVIDENCE SCRATCHPAD ===\n${typeof gv2EvidenceMemoryText === 'function' ? gv2EvidenceMemoryText(g.evidenceScratchpad || []) : '(none)'}\nUse [ev:key] citations in finish(answer) when referencing saved evidence. Each citation must sit next to the specific fact it proves, not after a vague sentence.\n`
    : '\n=== EVIDENCE SCRATCHPAD ===\nRecap is off. Set evidence to null; use normal browser actions and finish when done.\n';
  // The user attached an image/file: its ingested text rides on every step; the raw
  // image (if any) is attached to the model on step 1 only (see below).
  const attachAsImage = !!g.attachmentImage && (stepNumber === 1 || g._needAttachmentImage);
  const attachmentSection = g.attachmentContext
    ? `\n=== ATTACHED BY USER ===\n${g.attachmentContext}${attachAsImage ? '\n(The attached image is also included below as an image.)' : ''}\n`
    : '';
  // Text evidence mode records no screenshots, so screenshot-shaped evidence (need_annotation /
  // region_bbox) has nothing to attach to — steer the model to DOM/SoM evidence it can name.
  const textEvidenceMode = !(await _gv2CaptureShotsAllowed());
  const evidenceModeSection = textEvidenceMode
    ? '\nEVIDENCE MODE: TEXT. No screenshots are taken this session. Every evidence item must point at an indexed element via som_id; never set need_annotation=true and never return region_bbox. Evidence that is not an indexed element must be described in the note instead.\n'
    : '';
  const userPrompt = `PAGE BACKGROUND: ${pageBg.isDark ? 'DARK' : 'LIGHT'}
CURRENT URL: ${window.location.href}
VISUAL SCREENSHOT PROVIDED: ${visualInputShot ? `yes — it contains up to ${GV2_VISUAL_INPUT_MAX_MARKS} numbered SoM markers matching the PAGE INDEX` : 'no'}${evidenceModeSection}
ON FINISH: always return a non-null "answer", and return "confirmationEvidence" as up to 5 items confirming the answer on THIS page. Each item may include "name" (lowercase citation key like "spanish_language"), and needs reason plus either a SoM index, current-viewport rect/text${textEvidenceMode ? '' : ', or need_annotation=true with annotation_prompt'}. Cite confirmation evidence in answer as [ev:name], or [ev:index] when using a SoM index without a name. On non-finish steps set "confirmationEvidence" to null.

=== PAGE INDEX ===
${pageIndex.indexText}

=== USER GOAL ===
${activeQuestion}
${attachmentSection}${tutorialSection}
${g.personalizationContext || ''}
${planSection}
${evidenceSection}
=== CURRENT STEP ===
Step ${stepNumber}
${completedStepsSection}
Return JSON for Step ${stepNumber}`;

  try {

    // Assemble the image list: the SoM viewport screenshot (if Visual is on) plus,
    // on step 1 only, the user's raw attached image so the agent can actually see it.
    const stepImages = [];
    if (visualInputShot) {
      stepImages.push({ base64: visualInputShot, label: `Guide viewport with up to ${GV2_VISUAL_INPUT_MAX_MARKS} SoM markers` });
    }
    if (attachAsImage) {
      stepImages.push({ base64: g.attachmentImage, label: 'User-attached reference image' });
      g._needAttachmentImage = false; // consumed
    }
    const llmMsg = {
      action: stepImages.length ? 'callLLMWithImages' : 'callLLM',
      systemPrompt: systemPrompt,
      messages: [{
        role: 'user',
        content: userPrompt
      }],
      metadata: {
        mode: 'guide',
        step: stepNumber,
        url: window.location.href
      }
    };
    if (stepImages.length) {
      llmMsg.images = stepImages;
    }
    let response = await safeSendMessage(llmMsg);
    // If the image made the call fail, retry text-only (matches the prior fallback).
    if (stepImages.length && response && response.error) {
      response = await safeSendMessage({ ...llmMsg, action: 'callLLM', images: undefined });
    }

    if (_gv2IsStopped()) return null;
    if (_gv2IsPaused()) return { success: false, progressed: false, error: 'Guide paused' };

    if (response?.error) {
      console.warn('[guidev2] LLM error:', response.error);
      _gv2HideIndicator();
      return { success: false, error: response.error };
    }
    if (response?.content) {
      let contractIssue = _gv2StepContractIssue(response.content, g);
      if (contractIssue) {
        console.warn('[guidev2] Retrying LLM response for contract issue:', contractIssue);
        const retryMessages = [
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: String(response.content || '') },
          { role: 'user', content: _gv2ContractRetryPrompt(contractIssue) }
        ];
        const retryMsg = Object.assign({}, llmMsg, {
          messages: retryMessages,
          metadata: Object.assign({}, llmMsg.metadata || {}, {
            retry: 'contract',
            contractIssue: contractIssue.kind || 'unknown'
          })
        });
        let retryResponse = await safeSendMessage(retryMsg);
        if (visualInputShot && retryResponse && retryResponse.error) {
          retryResponse = await safeSendMessage({ ...retryMsg, action: 'callLLM', images: undefined });
        }
        if (_gv2IsStopped()) return null;
        if (_gv2IsPaused()) return { success: false, progressed: false, error: 'Guide paused' };
        if (retryResponse?.error) {
          console.warn('[guidev2] Contract retry LLM error:', retryResponse.error);
          _gv2HideIndicator();
          return { success: false, error: retryResponse.error };
        }
        if (retryResponse?.content) response = retryResponse;
        contractIssue = _gv2StepContractIssue(response.content, g);
        if (contractIssue) {
          console.warn('[guidev2] LLM response still violates contract after retry:', contractIssue);
          _gv2HideIndicator();
          return { success: false, error: contractIssue.message || 'LLM response is missing required fields after retry' };
        }
      }
      const result = await gv2ProcessResponse(response.content, systemPrompt, userPrompt);
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
async function gv2ProcessResponse(content, systemPrompt = '', userPrompt = '') {
  const g = window._guidev2;
  try {
    if (_gv2IsStopped()) return null;
    if (_gv2IsPaused()) return { success: false, progressed: false, error: 'Guide paused' };
    const step = (typeof gv2ExtractJsonObject === 'function')
      ? gv2ExtractJsonObject(content)
      : JSON.parse(content);
    if (!step) throw new Error('Could not parse step JSON');

    // Convert direct annotation / annotations fields to step.evidence sidecars with need_annotation=true
    if (step.annotation || step.annotations) {
      if (!Array.isArray(step.evidence)) {
        step.evidence = [];
      }
      const rawAnns = Array.isArray(step.annotations) ? step.annotations : (step.annotations && typeof step.annotations === 'object' ? [step.annotations] : []);
      for (const ann of rawAnns) {
        if (ann && typeof ann === 'object') {
          const key = ann.key || ann.name || `annotation_${Date.now()}`;
          const note = ann.note || ann.reason || ann.text || ann.annotation_prompt || '';
          const prompt = ann.annotation_prompt || ann.prompt || note;
          step.evidence.push({
            key,
            note,
            need_annotation: true,
            annotation_prompt: prompt,
            som_id: ann.som_id || null,
            region_bbox: ann.region_bbox || ann.rect || null
          });
        }
      }
    }

    const action = (typeof gv2NormalizeAction === 'function')
      ? gv2NormalizeAction(step.action, step.isLastStep)
      : String(step.action || (step.isLastStep ? 'finish' : 'click')).toLowerCase().replace(/[\s-]+/g, '_');
    if (!step.instruction) {
      if (action === 'finish') step.instruction = step.answer ? 'Finish with the final answer.' : 'Finish the task.';
      else throw new Error('LLM response JSON is missing instruction field');
    }
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

    const recapOnForEvidence = await _gv2IsVisualRecapOn();
    let isFind = action === 'highlight' || action === 'find';
    const evidenceAttempted = _gv2EvidenceAttempted(step.evidence);
    const normalizedSaveEvidence = evidenceAttempted && recapOnForEvidence && typeof gv2NormalizeEvidenceList === 'function'
      ? gv2NormalizeEvidenceList(step.evidence, {
          ref_step_id: step.step,
          existingKeys: (Array.isArray(g.evidenceScratchpad) ? g.evidenceScratchpad : []).map(e => e?.key)
        })
      : { ok: false, entries: [], errors: [] };
    const hasSavedEvidence = !!(recapOnForEvidence && normalizedSaveEvidence.ok && normalizedSaveEvidence.entries.length);
    const isFinish = action === 'finish';
    if (isFinish) _gv2SetWorkingStatus('Preparing final answer…');
    let isVisualHighlight = false; // resolved dynamically if highlight falls back
    const isWatchVideo = action === 'watch_video';
    // find and visual_highlight are ALWAYS the final answer to the user — never mid-journey. Coerce
    // isLastStep so the terminal branch (recap + state clear) runs and the trajectory can't continue.
    if (isFind || isVisualHighlight || isWatchVideo || isFinish) step.isLastStep = true;
    const hasText = !!(step.element?.text && String(step.element.text).trim());
    const hasIndex = step.element?.index != null && step.element?.index !== '';
    // find highlights whatever the reader pass cites, not a single planner-chosen element.
    const hasTarget = (typeof gv2StepHasTarget === 'function')
      ? gv2StepHasTarget({ action, isLastStep: step.isLastStep, element: step.element })
      : (!isFind && !step.isLastStep && action !== 'finish' && (hasIndex || hasText));
    const textMatchIdx = step.element?.text ? gv2FindElementByText(step.element.text) : null;
    const idxToUse = hasTarget
      ? (gv2PickTargetIndex(step.element?.text, step.element?.index) ?? step.element?.index ?? null)
      : null;
    const resolvedEl = idxToUse != null ? (window._pageguideIndex?.[idxToUse] || null) : null;
    const resolvedDropTarget = action === 'drag_drop' ? _gv2ResolveDropTarget(step.dropTarget) : null;

    // Confirmation evidence: SECOND, distinct SoM elements or rects the model points to as justification
    // for the action. Resolve each item independently: prefer index/text, then use that item's rect
    // only when no distinct SoM element resolves. Cap at five.
    const hasAnySavedEvidenceForAnswer = !!(hasSavedEvidence || (Array.isArray(g.evidenceScratchpad) && g.evidenceScratchpad.length));
    const rawConfirmationEvidence = step.confirmationEvidence != null ? step.confirmationEvidence : step.visualEvidence;
    const allConfirmationItems = (typeof gv2NormalizeVisualEvidenceList === 'function')
      ? gv2NormalizeVisualEvidenceList(rawConfirmationEvidence, 5)
      : ((typeof gv2NormalizeVisualEvidence === 'function' && gv2NormalizeVisualEvidence(rawConfirmationEvidence))
          ? [gv2NormalizeVisualEvidence(rawConfirmationEvidence)] : []);
    const finishAnswerEvidenceRefs = (isFinish && typeof gv2ParseEvidenceRefs === 'function')
      ? gv2ParseEvidenceRefs(step.answer || step.instruction || '')
      : [];
    // With saved evidence in play, only the confirmation items the answer actually cites are
    // captured (gv2SelectFinishConfirmationItems) — uncited ones are redundant, cited ones are not.
    const savedEvidenceKeys = [
      ...(Array.isArray(g.evidenceScratchpad) ? g.evidenceScratchpad.map(e => e?.key) : []),
      ...(hasSavedEvidence ? normalizedSaveEvidence.entries.map(e => e?.key) : [])
    ];
    const visualEvidenceItems = (isFinish && typeof gv2SelectFinishConfirmationItems === 'function')
      ? gv2SelectFinishConfirmationItems(allConfirmationItems, step.answer || step.instruction || '', savedEvidenceKeys, hasAnySavedEvidenceForAnswer)
      : (isFinish && hasAnySavedEvidenceForAnswer ? [] : allConfirmationItems);
    const confirmationEvidenceSkippedReason = (isFinish && hasAnySavedEvidenceForAnswer && !visualEvidenceItems.length)
      ? (hasSavedEvidence ? 'saved_evidence_on_finish_step' : 'saved_evidence_in_trajectory')
      : '';
    const resolvedEvidenceItemsRaw = [];
    for (let i = 0; i < visualEvidenceItems.length; i++) {
      const item = visualEvidenceItems[i];
      let itemEl = null;
      let itemIndex = null;
      if (item?.index != null) {
        itemIndex = item.index;
        itemEl = window._pageguideIndex?.[itemIndex] || null;
      } else if (item?.text) {
        itemIndex = gv2PickTargetIndex(item.text, null);
        const cand = itemIndex != null ? (window._pageguideIndex?.[itemIndex] || null) : null;
        if (cand) { itemEl = cand; }
        else { itemIndex = null; }
      }
      const citedIndexKey = (itemIndex != null && finishAnswerEvidenceRefs.includes(String(itemIndex))) ? String(itemIndex) : null;
      const confirmationKey = item?.name || citedIndexKey || finishAnswerEvidenceRefs[i] || (itemIndex != null ? String(itemIndex) : `confirmation_${i + 1}`);
      const confirmationNote = item?.reason || item?.text || item?.annotation_prompt || 'Confirmation of the answer';
      resolvedEvidenceItemsRaw.push({
        key: confirmationKey,
        note: confirmationNote,
        som_id: itemEl && itemIndex != null ? String(itemIndex) : null,
        evidenceEl: itemEl,
        evidenceIndex: itemIndex,
        evidenceRect: (!itemEl && item?.rect) ? item.rect : null,
        region_bbox: (!itemEl && item?.rect) ? item.rect : null,
        need_annotation: !itemEl && !!(item?.need_annotation || item?.annotation_prompt),
        annotation_prompt: item?.annotation_prompt || confirmationNote,
        annotations: !itemEl && Array.isArray(item?.annotations) ? item.annotations : [],
        scrollIntoView: isFinish && !!itemEl,
        forceDomMarker: isFinish && !!itemEl,
        fullViewportCapture: isFinish && !itemEl,
        text: item?.text || null,
        reason: item?.reason || null
      });
    }
    let resolvedEvidenceItems = _gv2DedupeEvidenceItems(resolvedEvidenceItemsRaw);
    let firstEvidenceItem = resolvedEvidenceItems[0] || null;
    let evidenceEl = firstEvidenceItem?.evidenceEl || null;
    let evidenceIndex = firstEvidenceItem?.evidenceIndex != null ? firstEvidenceItem.evidenceIndex : null;
    let evidenceRect = firstEvidenceItem?.evidenceRect || null;
    let visualEvidence = visualEvidenceItems[0] || null;

    const resolvedSavedEvidenceItems = [];
    if (hasSavedEvidence) {
      for (const entry of normalizedSaveEvidence.entries) {
        const somIndex = _gv2SomIdToIndex(entry.som_id);
        const somEl = somIndex != null ? (window._pageguideIndex?.[somIndex] || null) : null;
        resolvedSavedEvidenceItems.push({
          key: entry.key,
          note: entry.note,
          som_id: entry.som_id || null,
          region_bbox: entry.region_bbox || null,
          annotations: somEl ? [] : (Array.isArray(entry.annotations) ? entry.annotations : []),
          need_annotation: !somEl && (entry.need_annotation || !entry.region_bbox || !entry.annotations?.length),
          annotation_prompt: entry.annotation_prompt || entry.note,
          evidenceEl: somEl || null,
          evidenceIndex: somEl && somIndex != null ? somIndex : null,
          evidenceRect: somEl ? null : (entry.region_bbox || null),
          text: entry.note,
          reason: entry.note,
          // Textual stand-in for the crop (Text evidence mode). Resolved unconditionally — it is
          // cheap, DOM-only, and the mode is read a few lines further down.
          textualEvidence: typeof gv2TextualEvidence === 'function'
            ? gv2TextualEvidence(somEl, window.location.href)
            : null,
          scrollIntoView: !!somEl,
          forceDomMarker: !!somEl,
          fullViewportCapture: !somEl
        });
      }
      resolvedSavedEvidenceItems.sort((a, b) => {
        const ar = a.evidenceEl?.getBoundingClientRect ? a.evidenceEl.getBoundingClientRect() : null;
        const br = b.evidenceEl?.getBoundingClientRect ? b.evidenceEl.getBoundingClientRect() : null;
        const ay = ar ? ar.top + (window.scrollY || 0) : Number.MAX_SAFE_INTEGER;
        const by = br ? br.top + (window.scrollY || 0) : Number.MAX_SAFE_INTEGER;
        return ay - by;
      });
    }

    const domElementText = _gv2ElementAccessibleText(resolvedEl);
    const llmElementText = String(step.element?.text || '').trim();
    const resolvedElementText = domElementText || llmElementText;
    const elementStepSimilarity = await _gv2ElementStepSimilarity(step.instruction, resolvedElementText, hasTarget);
    let internalGrounding = elementStepSimilarity;
    if (internalGrounding == null) {
      const a = _gv2NormalizeDomText(step.instruction);
      const b = _gv2NormalizeDomText(resolvedElementText);
      internalGrounding = (a && b && (a === b || a.includes(b) || b.includes(a))) ? 1.0 : 0.0;
    }
    const currentKey = _gv2NormalizeDomText(resolvedElementText);
    const priorKeys = Array.isArray(g._mechElementTexts) ? g._mechElementTexts : (g._mechElementTexts = []);
    const mech = (typeof gv2ComputeMechanicalConfidence === 'function')
      ? gv2ComputeMechanicalConfidence({ hasTarget, grounding: internalGrounding, priorKeys, currentKey })
      : { confidence: null, grounding: null, loop: null, loopMatches: 0 };
    if (hasTarget && currentKey) priorKeys.push(currentKey);

    const isClickOrType = (action === 'click' || action === 'type' || action === 'drag_drop');
    const confidence = isClickOrType ? mech.confidence : null;
    const mechConfidence = isClickOrType ? mech.confidence : null;
    const mechGrounding = isClickOrType ? mech.grounding : null;
    const mechLoop = isClickOrType ? mech.loop : null;
    const elementStepSimilarityValue = isClickOrType ? elementStepSimilarity : null;
    const planStep = step.step; // Fallback for legacy step tracking
    const planTotal = Array.isArray(g.guidePlan) ? g.guidePlan.length : 0;
    const planCompleted = planTotal ? Math.max(0, Math.min(planTotal, (g.currentPlanStep || 1) - 1)) : null;

    // Non-grounding baseline mode: read fresh each step (like recapOn/captureEnabled above),
    // so flipping the toggle mid-session takes effect on the very next step. Used below to skip
    // the pre-action target highlight and the visual_highlight marker screenshot — click/type
    // mechanics are unaffected, since g.currentTargetEl is set unconditionally regardless of
    // whether a highlight was actually drawn (see the hasTarget block just below).
    const nonGrounding = typeof isNonGroundingModeOn === 'function' && await isNonGroundingModeOn();

    // Evidence mode (independent study axis, read fresh for the same reason): 'text' takes no
    // captures at all and records what the step touched as text instead — node text, aria-label,
    // selector, page URL. See gv2ShouldCaptureScreenshots / gv2TextualEvidence in content/utils.js.
    const evidenceMode = typeof getEvidenceMode === 'function' ? await getEvidenceMode() : 'visual';
    const textEvidence = evidenceMode === 'text';

    // Clear previous highlights
    if (typeof clearHighlights === 'function') clearHighlights();
    window._pageguideHighlights = [];

    // Highlight target element — two-step approach:
    //   Step 1: find the element by text match (more reliable than LLM index)
    //   Step 2: fall back to the LLM's index only if no confident text match
    let highlightCount = 0;
    if (hasTarget) {
      const pageBg = getPageBackground();
      const style = typeof getRandomHighlightStyle === 'function'
        ? getRandomHighlightStyle(pageBg.isDark)
        : { color: '#2ed573', animation: 'pulse' };

      if (textMatchIdx !== null && idxToUse === step.element.index && textMatchIdx !== step.element.index) {
        console.log(`[guidev2] Kept LLM index ${step.element.index} over text-match index ${textMatchIdx} for "${step.element.text}"`);
      } else if (textMatchIdx !== null && idxToUse === textMatchIdx && textMatchIdx !== step.element.index) {
        console.log(`[guidev2] Text-match override: LLM index ${step.element.index} → matched index ${textMatchIdx} for "${step.element.text}"`);
      } else if (textMatchIdx === null) {
        console.log(`[guidev2] No text match for "${step.element.text}", using LLM index ${step.element.index}`);
      }

      highlightCount = nonGrounding ? 0 : applyIndexedHighlight(idxToUse, step.element.text, style);
      const alignedRegionCapture = await _gv2ShouldUseAlignedRegionCapture(g);
      if (window._pageguideHighlights?.length > 0 && !alignedRegionCapture && !g.autoMode) {
        setTimeout(() => { if (typeof scrollToHighlight === 'function') scrollToHighlight(0); }, 300);
      }

      // Store the resolved target element and its text so gv2NextStep can click
      // it reliably even if React's reconciliation removes the highlight span
      // before the user presses "Next →".
      g.currentTargetEl   = resolvedEl;
      g.currentTargetText = step.element.text || null;
      g.currentDropTarget = resolvedDropTarget;
    } else {
      g.currentTargetEl   = null;
      g.currentTargetText = null;
      g.currentDropTarget = null;
    }

    if (typeof cleanupSom === 'function') cleanupSom();
    if (_gv2IsStopped()) return null;

    g._activeStepNumber = Number(step.step) || (g.previousSteps.length + 1);

    let verifyResult = null;

    // find/highlight: read the page and highlight the supporting passages. Runs before
    // _gv2HideIndicator() below so the on-page pill covers this second LLM call.
    let findResult = null;
    let findSystemPrompt = '';
    let findUserPrompt = '';
    let findRawResponse = '';
    let visualFallbackSystemPrompt = '';
    let visualFallbackUserPrompt = '';
    let visualFallbackRawResponse = '';
    let visualFallbackShot = null;
    let watchVideoResult = null;

    if (isFind) {
      _gv2ShowIndicator('Reading page…');
      findResult = await gv2RunFind(step.findQuery);
      if (_gv2IsStopped()) return null;

      findSystemPrompt = findResult.systemPrompt || '';
      findUserPrompt = findResult.userPrompt || '';
      findRawResponse = findResult.rawResponse || '';

      if (findResult.notOnPage) {
        _gv2ShowIndicator('Looking visually…');
        const visualFallback = await gv2RunVisualFallbackHighlight(step.findQuery || window._guidev2?.question);
        if (_gv2IsStopped()) return null;

        if (visualFallback) {
          isFind = false;
          isVisualHighlight = true;
          visualFallbackSystemPrompt = visualFallback.systemPrompt || '';
          visualFallbackUserPrompt = visualFallback.userPrompt || '';
          visualFallbackRawResponse = visualFallback.rawResponse || '';
          visualFallbackShot = visualFallback.shot || null;

          evidenceIndex = visualFallback.index != null ? visualFallback.index : null;
          evidenceRect = visualFallback.rect || null;
          evidenceEl = (evidenceIndex != null) ? (window._pageguideIndex?.[evidenceIndex] || null) : null;
          visualEvidence = {
            index: evidenceIndex,
            rect: evidenceRect,
            reason: visualFallback.reason || 'visual answer'
          };
        }
      }
    }

    if (isWatchVideo) {
      _gv2ShowIndicator('Agent watching video…');
      watchVideoResult = await gv2RunWatchVideo(step);
      if (_gv2IsStopped()) return null;
    }

    // visual_highlight: crop the model's evidence region (SoM index or rect) from a clean capture
    // (SoM markers already cleaned up above) and return it as the answer image. No second LLM pass.
    let visualHighlightResult = null;
    if (isVisualHighlight) {
      const caption = (visualEvidence?.reason || step.instruction || '').trim();
      if (nonGrounding || textEvidence) {
        // Baseline / Text evidence: keep the plain-text caption, skip the marked-up screenshot.
        visualHighlightResult = { image: null, caption };
      } else {
        _gv2ShowIndicator('Capturing…');
        try {
          const cap = await gv2CaptureEvidenceRegion(evidenceEl, evidenceIndex, evidenceRect);
          visualHighlightResult = { image: cap?.visualEvidenceShot || null, caption };
        } catch (e) { visualHighlightResult = { image: null, caption }; }
      }
      if (_gv2IsStopped()) return null;
    }

    const isLast = !!step.isLastStep || isFinish;
    // Mark find steps so a later step doesn't loop and re-issue find on the same page.
    const stepSuffix = isLast ? ' ✓' : (isFind ? ' [found]' : (isWatchVideo ? ' [watched]' : ''));
    const savedEvidenceSummary = _gv2SavedEvidenceStepSummary(hasSavedEvidence ? normalizedSaveEvidence.entries : []);
    g.previousSteps.push(`Step ${step.step}: ${step.instruction}${savedEvidenceSummary}${stepSuffix}`);

    // Simple dispatch: interaction actions | find | finish. Evidence is an optional sidecar on
    // any non-finish step and is saved/captured with the step before the action runs.
    // Pass the normalized action through so gv2AssessRisk sees 'find'/'clear_text'; it also
    // mutates step.riskReason, which the pause messages below read, so hand it the real step.
    step.action = action;
    const risk = (typeof gv2AssessRisk === 'function') ? gv2AssessRisk(step) : 'low';
    const isHighRisk = risk === 'high';
    g._lastAction = action;
    if (!isLast && action !== 'finish') g._lastActionStepNumber = g._activeStepNumber;

    // Remember the live step so the panel "Next →" (manual mode) can perform it and advance.
    g._currentStep = {
      action,
      typeText: step.typeText,
      value: step.value,
      instruction: step.instruction,
      // _gv2ShouldSubmitAfterType reads both: the explicit flag, and the instruction that so often
      // carries the intent instead ("...and press Enter").
      submit: step.submit === true ? true : (step.submit === false ? false : undefined),
      highRisk: isHighRisk,
      dropTarget: resolvedDropTarget ? {
        index: resolvedDropTarget.index,
        text: resolvedDropTarget.text || null,
        rect: resolvedDropTarget.rect || null,
        point: resolvedDropTarget.point || null,
        el: resolvedDropTarget.el || null
      } : null
    };

    // Pause/stop-action conditions: 3 low-confidence actions, loop score over threshold,
    // high risk (JSON), or confirmation needed (JSON). When triggered, the proposed step is
    // captured for review but not executed.
    const isHighRiskJson = !isFind && !isVisualHighlight && !isWatchVideo && step.risk === 'high';
    const needsConfirmation = !isFind && !isVisualHighlight && !isWatchVideo && step.confirmation === 'needed';
    const autonomyLevel = _gv2NormalizeAutonomyLevel(g.autonomyLevel, g.autoMode === true);
    g.autonomyLevel = autonomyLevel;
    const bypassNoAskStops = g.autoMode && autonomyLevel === 'auto_no_ask';
    const activeLoopScore = _gv2MaxFiniteScore(mech.loop);
    const loopStepThreshold = await _gv2LoopStepThreshold();
    g.loopStepCount = _gv2NextLoopStreak(g.loopStepCount, activeLoopScore);
    const loopStop = g.loopStepCount >= loopStepThreshold;
    const confidenceThreshold = await _gv2ConfidenceThreshold();
    if (confidence !== null && confidence < confidenceThreshold) {
      g.lowConfidenceCount = (g.lowConfidenceCount || 0) + 1;
    }
    // A find step never pauses for low-confidence/risk gates. Auto: No Ask bypasses only the
    // risk/confirmation permission gates; low-confidence and loop guards still stop the guide.
    const actionThreshold = await _gv2LowConfidenceActionThreshold();
    const lowConfidenceStop = g.lowConfidenceCount >= actionThreshold;
    const confirmationStop = !bypassNoAskStops && needsConfirmation;
    const riskStop = !bypassNoAskStops && isHighRiskJson;
    const willPause = loopStop || (!isFind && !isVisualHighlight && !isWatchVideo && (lowConfidenceStop || riskStop || confirmationStop));
    const loopPauseMessage = loopStop
      ? (loopStepThreshold > 1
        ? `Page Guide paused: ${g.loopStepCount} steps in a row scored at or above the ${GV2_LOOP_STOP_THRESHOLD.toFixed(1)} loop threshold (latest ${activeLoopScore.toFixed(2)}). Review and resume when ready.`
        : `Page Guide paused: loop score ${activeLoopScore.toFixed(2)} is above the ${GV2_LOOP_STOP_THRESHOLD.toFixed(1)} threshold. Review and resume when ready.`)
      : '';

    // Gate 1 (Risk) + hand-back override: Auto: Ask runs low-risk actions; Auto: No Ask bypasses
    // the risk/confirmation gates and runs the step unless a prior hand-back override is active.
    const forcedManual = !!g._forceManualNextStep;
    g._forceManualNextStep = false;
    const autoPerform = g.autoMode && (!isHighRisk || bypassNoAskStops) && !forcedManual && !willPause;
    let pauseAfterCaptureMessage = '';

    if (isFind || isWatchVideo) {
      // Read-only: the reader pass already ran. No pendingResume (nothing navigates) and
      // deliberately no click listener (there is nothing for the user to click).
      if (!isLast) await _gv2SetState(false);
      if (loopStop && !isLast) pauseAfterCaptureMessage = loopPauseMessage;
    } else if (isLast || action === 'finish') {
      // Clear state after capture runs at end of function
    } else if (action === 'scroll_down' || action === 'scroll_up' || action === 'goto_url') {
      // goto_url always navigates; scrolling does not.
      await _gv2SetState(_gv2ActionExpectsNavigation(action));
    } else if (action === 'type' || action === 'clear_text') {
      // A field edit may or may not end in a page load (Enter in a search box, an autosubmit form).
      // Arm the resume; _gv2ContinueAfterFormEdit disarms it if the page is still here afterwards.
      await _gv2SetState(_gv2ActionExpectsNavigation(action));
      if (!autoPerform) {
        if (willPause) {
          if (loopStop) {
            pauseAfterCaptureMessage = loopPauseMessage;
          } else if (needsConfirmation) {
            pauseAfterCaptureMessage = 'Confirmation needed. Please verify and press Resume.';
          } else if (isHighRiskJson) {
            pauseAfterCaptureMessage = 'This step is high risk. Please perform it yourself, then press Resume.';
          } else {
            pauseAfterCaptureMessage = `Page Guide paused: ${actionThreshold} low-confidence actions detected. Review and resume when ready.`;
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
          if (loopStop) {
            pauseAfterCaptureMessage = loopPauseMessage;
          } else if (needsConfirmation) {
            pauseAfterCaptureMessage = 'Confirmation needed. Please verify and press Resume.';
          } else if (isHighRiskJson) {
            pauseAfterCaptureMessage = 'This step is high risk. Please perform it yourself, then press Resume.';
          } else {
            pauseAfterCaptureMessage = `Page Guide paused: ${actionThreshold} low-confidence actions detected. Review and resume when ready.`;
          }
        } else if (g.autoMode && isHighRisk) {
          // High-risk click in auto mode → hand control back for this one.
          const reason = step.riskReason ? ` (${step.riskReason})` : '';
          pauseAfterCaptureMessage = `This step looks sensitive${reason}. Do it yourself, then press Resume.`;
        }
      }
    }

    _gv2SetWorkingStatus(hasSavedEvidence ? 'Saving evidence…' : 'Capturing step…');

    // Rewind: capture screenshot + target region + DOM snapshot BEFORE auto-performing the action.
    await gv2CaptureStepRecord({
      step: step.step,
      planStep,
      completedPlanStep: null,
      completedPlanStepReason: '',
      confidence,
      grounded: null,
      loop: null,
      progress: null,
      confidenceFormula: null,
      mechConfidence: mechConfidence,
      mechGrounding: mechGrounding,
      elementStepSimilarity: elementStepSimilarityValue,
      element_step_similarity: elementStepSimilarityValue,
      embeddingError: g._lastEmbeddingError || null,
      mechLoop: mechLoop,
      loopMatches: mech.loopMatches,
      domElementText,
      llmElementText,
      resolvedIndex: idxToUse,
      evidenceMode,
      // Text mode's stand-in for the screenshot: what this step actually touched, in words.
      // Resolved here while the element is still live — the record is read back long after.
      targetEvidence: textEvidence && typeof gv2TextualEvidence === 'function'
        ? gv2TextualEvidence(resolvedEl || g.currentTargetEl || null, window.location.href)
        : null,
      evidenceEl,
      evidenceIndex,
      evidenceRect,
	      visualEvidenceItems: resolvedEvidenceItems,
	      confirmationEvidenceSkippedReason,
	      savedEvidenceItems: resolvedSavedEvidenceItems,
	      visualEvidenceText: visualEvidence?.text || null,
	      visualEvidenceReason: visualEvidence?.reason || null,
      planTotal,
      planCompleted,
      confidenceSource: 'mechanical',
      confirmation: step.confirmation || null,
      llmStep: step.llmStep,
      expectedStep: step.expectedStep,
      stepNumberCorrected: step.stepNumberCorrected,
      instruction: step.instruction,
      action,
	      evidenceKey: hasSavedEvidence ? (normalizedSaveEvidence.entries?.[0]?.key || null) : null,
	      evidenceNote: hasSavedEvidence ? (normalizedSaveEvidence.entries?.[0]?.note || null) : null,
      finishAnswer: isFinish ? (step.answer || null) : null,
      typeText: (step.typeText != null ? step.typeText : step.value) || null,
      navigateUrl: step.url || null,
      dropTarget: action === 'drag_drop' ? {
        index: resolvedDropTarget?.index ?? (step.dropTarget?.index ?? null),
        text: resolvedDropTarget?.text || step.dropTarget?.text || null,
        rect: resolvedDropTarget?.rect || step.dropTarget?.rect || null
      } : null,
      isLastStep: isLast,
      isFind,
      findQuery: isFind ? (step.findQuery || null) : null,
      findAnswer: isFind ? (findResult?.answer || null) : null,
      findNotOnPage: isFind ? !!findResult?.notOnPage : false,
      findHighlightCount: isFind ? (findResult?.highlightCount || 0) : 0,
      isWatchVideo,
      watchVideoAnswer: isWatchVideo ? (watchVideoResult?.answer || null) : null,
      watchVideoUrl: isWatchVideo ? (watchVideoResult?.videoUrl || step.videoUrl || step.url || null) : null,
      watchVideoQuery: isWatchVideo ? (watchVideoResult?.videoQuery || step.videoQuery || null) : null,
      watchVideoError: isWatchVideo ? (watchVideoResult?.error || null) : null,
      visualHighlightImage: isVisualHighlight ? (visualHighlightResult?.image || null) : null,
      visualHighlightCaption: isVisualHighlight ? (visualHighlightResult?.caption || null) : null,
      findSystemPrompt,
      findUserPrompt,
      findRawResponse,
      visualFallbackSystemPrompt,
      visualFallbackUserPrompt,
      visualFallbackRawResponse,
      visualFallbackShot,
      verifyResultSystemPrompt: verifyResult?.verifyResultSystemPrompt || '',
      verifyResultUserPrompt: verifyResult?.verifyResultUserPrompt || '',
      verifyResultRawResponse: verifyResult?.verifyResultRawResponse || '',
      verifyResultShot: verifyResult?.verifyResultShot || null,
      verifyResultScrollY: verifyResult?.verifyResultScrollY != null ? verifyResult.verifyResultScrollY : null,
      verifyResultAction: verifyResult?.verifyResultAction || null,
      verifyResultError: verifyResult?.verifyResultError || null,
      target: (isFind || isVisualHighlight || isWatchVideo)
        ? { text: null, domText: null, llmIndex: null, resolvedIndex: null }
        : { text: step.element?.text || null, domText: domElementText || null, llmIndex: step.element?.index ?? null, resolvedIndex: idxToUse },
      rawLlmJson: content,
      systemPrompt,
      userPrompt,
      tutorialMatch: (step.step === 1 && g.tutorialRef) ? {
        task: g.tutorialRef.task,
        website: g.tutorialRef.website,
        steps: g.tutorialRef.content.steps,
        reason: g.tutorialReason
      } : null
    });

	    // Auto-perform only after pre-action capture completes (regionShot + before-shot are stored).
	    if (hasSavedEvidence && g.sessionId) {
	      try {
	        if (normalizedSaveEvidence.ok && typeof rewindPutEvidence === 'function') {
	          const savedEntries = [];
	          if (Array.isArray(resolvedSavedEvidenceItems)) {
	            for (let i = 0; i < normalizedSaveEvidence.entries.length; i++) {
	              const entry = normalizedSaveEvidence.entries[i];
	              const resolvedItem = resolvedSavedEvidenceItems[i];
	              if (resolvedItem) {
	                if (resolvedItem.region_bbox) entry.region_bbox = resolvedItem.region_bbox;
	                if (resolvedItem.annotations) entry.annotations = resolvedItem.annotations;
	              }
	            }
	          }
	          for (const entry of normalizedSaveEvidence.entries) {
	            const saved = await rewindPutEvidence(g.sessionId, entry);
	            if (saved) savedEntries.push(saved);
	          }
	          g.evidenceScratchpad = await _gv2LoadEvidenceScratchpad(g.sessionId);
	          try {
	            if (typeof rewindPatchRecord === 'function') {
	              await rewindPatchRecord(g.sessionId, step.step, {
	                evidenceKey: savedEntries[0]?.key || normalizedSaveEvidence.entries[0]?.key || null,
	                evidenceNote: savedEntries[0]?.note || normalizedSaveEvidence.entries[0]?.note || null,
	                savedEvidence: savedEntries[0] || normalizedSaveEvidence.entries[0] || null,
	                savedEvidenceEntries: savedEntries.length ? savedEntries : normalizedSaveEvidence.entries
	              });
	            }
	          } catch (e) {}
	        } else {
	          console.warn('[guidev2] evidence sidecar rejected:', normalizedSaveEvidence.errors || []);
	        }
	      } catch (e) {
	        console.warn('[guidev2] evidence sidecar save failed:', e);
      }
    }
    const finalEvidenceScratchpad = Array.isArray(g.evidenceScratchpad) ? g.evidenceScratchpad.slice() : [];

    if (autoPerform && !isLast && action !== 'finish' && !isFind && !isWatchVideo) {
      // type is skipped here only because it needs no click listener — its resume was already armed
      // above, before the field edit that may submit the page.
      if (action !== 'type') {
        await _gv2SetState(true);
        if (!willPause && !(g.autoMode && isHighRisk)) _gv2SetupClickListener();
      }
      _gv2ScheduleAutoPerformAfterCapture(g, step, action);
    }

    // A non-terminal highlight performs no DOM action — just advance the loop in Auto mode.
    if (isFind && autoPerform && !isLast) {
      _gv2ScheduleAutoPerformAfterCapture(g, step, 'highlight');
    }

    if (pauseAfterCaptureMessage && !isLast && action !== 'finish') {
      await gv2PauseGuide(pauseAfterCaptureMessage);
    }

    // On the terminal step, optionally synthesize the visual recap BEFORE clearing state (which
    // wipes g.previousSteps / g.guidePlan). Guarded so a recap failure never breaks completion.
    let recap = null;
    let finalStepRecords = [];
    if (isLast || action === 'finish') {
      // Deterministic outcome: only a literal finish action counts as completed; any other terminal
      // (find/visual deliverables still render their own cards) is not treated as a failure here —
      // real failures come through the stop / step-cap paths with outcome 'failed'.
      _gv2SetWorkingStatus('Preparing final answer…');
      try { if (await _gv2IsEndSummaryOn()) recap = await _gv2BuildRecap(g, 'completed'); } catch (e) { recap = null; }
      try {
        if (g?.sessionId && typeof rewindGetIndex === 'function') {
          const idx = await rewindGetIndex(g.sessionId);
          finalStepRecords = Array.isArray(idx?.steps) ? idx.steps.filter(s => Number(s?.step) > 0) : [];
        }
      } catch (e) { finalStepRecords = []; }
      _gv2UpdatePersonalizedProfile(g, 'completed');
      _gv2ClearState();
    }

    // The working agent always finishes with an answer; fall back so it is never empty. Whether the
    // task is an information lookup (S1/S2) or a navigate-only confirmation (S3) is never
    // self-reported by the model — it's derived after the fact from the trajectory: S3 is whatever
    // finishes with an empty evidence scratchpad (see gv2BuildAnswerEvidence's action-fallback path).
    let finalAnswer = isFinish ? (step.answer || step.instruction || 'Task completed.') : '';
    if (isFinish && typeof gv2ExpandBareEvidenceCitations === 'function') {
      finalAnswer = gv2ExpandBareEvidenceCitations(finalAnswer, finalEvidenceScratchpad);
    }
    // Finish-time confirmation: the confirmationEvidence the agent attached to the finish step to justify
    // its answer. It becomes the top-priority evidence link on the answer card.
    const confirmationEvidence = (isFinish && Array.isArray(resolvedEvidenceItems) && resolvedEvidenceItems.length)
      ? resolvedEvidenceItems.slice(0, 5).map((it) => {
          let region = it?.evidenceRect || null;
          try {
            if (!region && it?.evidenceEl?.getBoundingClientRect && typeof gv2TargetNormRect === 'function') {
              const r = it.evidenceEl.getBoundingClientRect();
              region = gv2TargetNormRect({ left: r.left, top: r.top, width: r.width, height: r.height }, window.innerWidth, window.innerHeight);
            }
          } catch (e) { region = it?.evidenceRect || null; }
          return { key: it?.key || '', step: step.step, region_bbox: region || null, note: it?.note || it?.reason || it?.text || 'Confirmation of the answer' };
        })
      : [];
    // Guarantee a visual-evidence link on the terminal card (confirmation → cited scratchpad → saved
    // scratchpad → action grounding). Computed here so it holds even when Visual Recap is off; also
    // attached to the recap so the navigate-only summary card can render it.
    const answerEvidence = (isLast || action === 'finish')
      ? await _gv2ComputeAnswerEvidence(Object.assign({}, g, { evidenceScratchpad: finalEvidenceScratchpad }), finalAnswer, step.step, confirmationEvidence)
      : [];
    if (recap) recap.answerEvidence = answerEvidence;
    return {
      success: true,
      answer: isWatchVideo ? (watchVideoResult?.answer || watchVideoResult?.error || step.instruction)
        : isFind ? (findResult?.answer || step.instruction)
        : (isVisualHighlight ? (visualHighlightResult?.caption || step.instruction) : (isFinish ? (finalAnswer || step.instruction) : step.instruction)),
      step: step.step,
      sessionId: g.sessionId || null,
      isLastStep: isLast,
      recap,
      targetText: (isFind || isVisualHighlight || isWatchVideo) ? null : (step.element?.text || null),
      action,
      confidence,
      planStep,
      paused: !!g.paused,
      highlightCount: isFind ? (findResult?.highlightCount || 0) : highlightCount,
      hasHighlights: isFind ? !!findResult?.hasHighlights : (highlightCount > 0),
      autoMode: !!g.autoMode,
      autonomyLevel: g.autonomyLevel || (g.autoMode ? 'auto' : 'manual'),
      isGuide: true,
      hasSavedEvidence,
      isFinish,
      finalAnswer,
      answerEvidence,
      stepRecords: finalStepRecords,
      evidenceScratchpad: finalEvidenceScratchpad,
      isFind,
      findAnswer: isFind ? (findResult?.answer || '') : null,
      findNotOnPage: isFind ? !!findResult?.notOnPage : false,
      // Visual evidence mode only: one crop per cited span, in citation order. Empty in Text mode.
      // NOT gated on isFind: gv2RunFind captures these before the notOnPage branch above flips the
      // step to visual_highlight, and crops belong to the answer rather than to the action name.
      findEvidenceShots: findResult?.findEvidenceShots || [],
      evidenceMode,
      isWatchVideo,
      watchVideoAnswer: isWatchVideo ? (watchVideoResult?.answer || '') : null,
      watchVideoUrl: isWatchVideo ? (watchVideoResult?.videoUrl || step.videoUrl || step.url || null) : null,
      watchVideoQuery: isWatchVideo ? (watchVideoResult?.videoQuery || step.videoQuery || null) : null,
      watchVideoError: isWatchVideo ? (watchVideoResult?.error || null) : null,
      isVisualHighlight,
      visualHighlightImage: isVisualHighlight ? (visualHighlightResult?.image || null) : null,
      visualHighlightCaption: isVisualHighlight ? (visualHighlightResult?.caption || null) : null
    };

  } catch (e) {
    console.error('[guidev2] Parse error:', e);
    _gv2HideIndicator();
    if (typeof cleanupSom === 'function') cleanupSom();
    return { success: false, error: e.message || 'Could not parse step JSON' };
  }
}

async function _gv2IsVisionEnabled() {
  try {
    const r = await chrome.storage.sync.get(['visionEnabled']);
    return r.visionEnabled !== false; // default ON
  } catch (e) {
    return true;
  }
}

// Final-State vision verdict: one extra LLM pass over a fresh screenshot of the final page, asking
// whether the task completed/failed and why, plus bounding-box annotations to draw on the shot.
// `snap` is a plain snapshot { sessionId, question, steps, finalStep } so this works after the live
// session is cleared (failure path). `outcome` is a hint ('done' | 'stopped'). Never throws;
// returns { verdict, reason, annotations, shot, step } or null. Also persists the prompt/response
// + verdict onto the final step's record for the inspector.
async function _gv2BuildFinalVerdictFromSnapshot(snap, outcome) {
  try {
    if (!snap || !snap.sessionId) return null;
    const steps = Array.isArray(snap.steps) ? snap.steps : [];
    const finalStep = Number.isFinite(snap.finalStep) ? snap.finalStep : null;

    let shot = null;
    try { if (typeof captureScreenshot === 'function') shot = await captureScreenshot(); } catch (e) {}
    let initialRecord = null;
    try {
      if (typeof rewindGetRecord === 'function') initialRecord = await rewindGetRecord(snap.sessionId, 0);
    } catch (e) { initialRecord = null; }
    const initialShot = initialRecord?.screenshotBefore || initialRecord?.screenshot || null;

    const useVision = shot && (await _gv2IsVisionEnabled());
    const systemPrompt = `You verify whether a web task was completed, using INITIAL and FINAL screenshots when available.
Reply with ONLY JSON:
{"verdict":"completed"|"failed"|"unclear",
 "reason":"one or two sentences citing what changed or did not change between the initial and final screenshots",
 "annotations":[{"x":0..1,"y":0..1,"w":0..1,"h":0..1,"label":"short evidence label"}]}
- Coordinates are fractions of the FINAL image (x,y = top-left of the box).
- Add 1-4 annotations boxing the final-state visual evidence (the changed UI / confirmation, or what is missing if failed).
- If you cannot see screenshots, set annotations to [] and judge from the steps.`;
    const userPrompt = `USER GOAL: ${snap.question || ''}
OUTCOME HINT: ${outcome === 'stopped' ? 'the run was stopped early (hit the step cap)' : 'the agent reported it finished'}
IMAGES PROVIDED:
- Initial state before the guide: ${initialShot ? 'yes' : 'no'}
- Final state after the guide: ${shot ? 'yes' : 'no'}

STEPS TAKEN:
${steps.length ? steps.join('\n') : '(none)'}

Compare the INITIAL and FINAL states, then return the verdict JSON.`;

    let responseText = '';
    const images = [];
    if (useVision && initialShot) images.push({ base64: initialShot, label: 'Initial state before guide' });
    if (useVision && shot) images.push({ base64: shot, label: 'Final state after guide' });
    try {
      const msg = {
        action: images.length > 1 ? 'callLLMWithImages' : 'callLLM',
        systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        metadata: { mode: 'guide', step: 'final_verify', url: window.location.href }
      };
      if (images.length > 1) msg.images = images;
      else if (useVision) msg.imageBase64 = shot;
      let response = await safeSendMessage(msg);
      // No vision-capability check exists — if the image made the call fail, retry text-only.
      if (useVision && response && response.error) {
        response = await safeSendMessage({ ...msg, action: 'callLLM', imageBase64: undefined, images: undefined });
      }
      responseText = (response && response.content) ? String(response.content) : '';
    } catch (e) {
      console.warn('[guidev2] final verdict LLM failed:', e);
    }

    const raw = (responseText && typeof gv2ExtractJsonObject === 'function') ? gv2ExtractJsonObject(responseText) : null;
    const norm = (typeof gv2NormalizeFinalVerdict === 'function')
      ? gv2NormalizeFinalVerdict(raw)
      : { verdict: 'unclear', reason: '', annotations: [] };
    // On a stopped run with no clear signal, prefer 'failed' over 'unclear'.
    if (outcome === 'stopped' && norm.verdict === 'unclear') norm.verdict = 'failed';

    if (typeof rewindPatchRecord === 'function' && Number.isFinite(finalStep)) {
      try {
        // Store text/verdict first. Full screenshots are attached best-effort afterwards so a
        // large image payload cannot prevent the inspector from showing the prompt/response.
        await rewindPatchRecord(snap.sessionId, finalStep, {
          finalVerifySystemPrompt: systemPrompt,
          finalVerifyUserPrompt: userPrompt,
          finalVerifyResponse: responseText,
          recapSystemPrompt: systemPrompt,
          recapUserPrompt: userPrompt,
          recapResponse: responseText,
          finalVerdict: norm.verdict,
          finalReason: norm.reason,
          finalAnnotations: norm.annotations
        });
        try {
          await rewindPatchRecord(snap.sessionId, finalStep, {
            finalShot: shot || null,
            recapImages: images
          });
        } catch (e) {
          console.warn('[guidev2] final verification screenshots were not stored:', e);
        }
      } catch (e) { /* non-fatal */ }
    }

    return { verdict: norm.verdict, reason: norm.reason, annotations: norm.annotations, shot: shot || null, step: finalStep };
  } catch (e) {
    console.warn('[guidev2] _gv2BuildFinalVerdictFromSnapshot error:', e);
    return null;
  }
}

// Snapshot the live session and build the verdict (used by the completed/recap path).
async function _gv2BuildFinalVerdict(g, outcome) {
  if (!(await _gv2IsVisualRecapOn())) return null;
  const steps = Array.isArray(g?.previousSteps) ? g.previousSteps : [];
  const validSteps = steps
    .map(s => { const m = /^Step\s+(\d+)/.exec(String(s || '').trim()); return m ? Number(m[1]) : null; })
    .filter(n => Number.isFinite(n) && n > 0);
  const finalStep = validSteps.length ? Math.max.apply(null, validSteps) : null;
  return _gv2BuildFinalVerdictFromSnapshot(
    { sessionId: g?.sessionId, question: g?.question, steps, finalStep }, outcome
  );
}

// Build an end-of-task recap: an LLM-synthesized summary plus milestone sentences, each pinned
// to a real completed step number so the panel can attach that step's screenshot as visual
// evidence. Never throws — any failure yields a deterministic recap from the plan/step list.
// Returns null when Visual Recap mode is off or there are no completed steps to recap.
function _gv2RenderTemplate(template, values) {
  return String(template || '').replace(/\{\{([A-Z0-9_]+)\}\}/g, (full, key) => (
    Object.prototype.hasOwnProperty.call(values || {}, key) ? String(values[key] ?? '') : full
  ));
}

// Build the guaranteed answer-evidence link list for a finished task (runs independent of the
// Visual Recap toggle so every terminal card can show a visual link). Picks the action-grounding
// fallback step — the latest step that grounded on a real clicked/targeted element with a
// screenshot — for navigate-only tasks or answers the model did not cite with [ev:key].
async function _gv2ComputeAnswerEvidence(g, finalAnswer, terminalStep, confirmation = []) {
  const scratchpad = Array.isArray(g?.evidenceScratchpad) ? g.evidenceScratchpad : [];
  let fallbackStep = Number.isFinite(Number(terminalStep))
    ? { step: Number(terminalStep), note: 'Final step evidence' }
    : null;
  try {
    if (g?.sessionId && typeof rewindGetIndex === 'function') {
      const idx = await rewindGetIndex(g.sessionId);
      const steps = Array.isArray(idx?.steps)
        ? idx.steps.filter(s => Number(s?.step) > 0 && s.hasShot)
        : [];
      // Prefer the latest step that acted on a concrete element, so the fallback shows "the
      // button I clicked" rather than a bare page screenshot.
      const grounded = steps.filter(s => s.resolvedIndex != null
        || ['click', 'type', 'clear_text', 'drag_drop', 'goto_url', 'navigate'].includes(String(s.action || '')));
      const pick = (grounded.length ? grounded : steps)
        .reduce((a, b) => (a == null || Number(b.step) > Number(a.step) ? b : a), null);
      if (pick && Number.isFinite(Number(pick.step))) {
        fallbackStep = { step: Number(pick.step), note: pick.instruction || 'Final step evidence' };
      }
    }
  } catch (e) { /* keep terminalStep fallback */ }
  return (typeof gv2BuildAnswerEvidence === 'function')
    ? gv2BuildAnswerEvidence({ finalAnswer, scratchpad, confirmation, fallbackStep })
    : [];
}

async function _gv2BuildRecap(g, outcome = 'completed') {
  try {
    if (!(await _gv2IsEndSummaryOn())) return null;
    // Verdict is deterministic and binary (finish → completed, everything else → failed). The
    // summarization LLM below never decides this; it only summarizes (completed) or diagnoses (failed).
    const verdictKey = (typeof gv2DeterministicVerdict === 'function')
      ? gv2DeterministicVerdict(outcome)
      : (outcome === 'completed' ? 'completed' : 'failed');
    const steps = Array.isArray(g?.previousSteps) ? g.previousSteps : [];
    // Completed step numbers parsed from the "Step N: ..." trajectory strings.
    const validSteps = steps
      .map(s => { const m = /^Step\s+(\d+)/.exec(String(s || '').trim()); return m ? Number(m[1]) : null; })
      .filter(n => Number.isFinite(n) && n > 0);
    if (validSteps.length === 0) return null;
    const plan = Array.isArray(g?.guidePlan) ? g.guidePlan : [];
    const finalStep = Math.max.apply(null, validSteps);
    let stepRecords = [];
    let initialRecord = null;
    try {
      if (g?.sessionId && typeof rewindGetIndex === 'function') {
        const idx = await rewindGetIndex(g.sessionId);
        stepRecords = Array.isArray(idx?.steps) ? idx.steps.filter(m => Number(m?.step) > 0) : [];
      }
      if (g?.sessionId && typeof rewindGetRecord === 'function') {
        initialRecord = await rewindGetRecord(g.sessionId, 0);
      }
    } catch (e) { stepRecords = []; }

    let finalShot = null;
    try { if (typeof captureScreenshot === 'function') finalShot = await captureScreenshot(); } catch (e) {}
    const initialShot = initialRecord?.screenshotBefore || initialRecord?.screenshot || null;

    const ctx = {
      validSteps,
      plan,
      planTitle: g?.guideTitle || '',
      steps,
      stepRecords,
      finalVerdict: null,
      finalReason: ''
    };

    let raw = null;
    let recapSystemPrompt = '', recapUserPrompt = '', recapResponse = '';
    let recapImages = [];
    let recapScratchpad = [];
    try {
      const scratchpad = await _gv2LoadEvidenceScratchpad(g?.sessionId);
      recapScratchpad = Array.isArray(scratchpad) ? scratchpad : [];
      const scratchpadText = (typeof gv2EvidenceMemoryText === 'function') ? gv2EvidenceMemoryText(scratchpad) : '(none)';
      const planText = plan.length ? plan.map(p => `- ${p.goal || p.text || ''}`).join('\n') : '(no plan)';
      const scoreRows = stepRecords
        .filter(r => ['click', 'type', 'clear_text', 'drag_drop'].includes(String(r?.action || '').toLowerCase()))
        .filter(r => [r.mechConfidence, r.mechGrounding, r.mechLoop].some(v => Number.isFinite(Number(v))))
        .map(r => {
          const pct = (v) => Number.isFinite(Number(v)) ? Number(v).toFixed(2) : 'null';
          return `Step ${r.step}: confidence=${pct(r.mechConfidence)}, grounding=${pct(r.mechGrounding)}, loop=${pct(r.mechLoop)}, action=${r.action || ''}, instruction=${r.instruction || ''}`;
        });
      const scoreText = scoreRows.length ? scoreRows.join('\n') : '(no targeted confidence records)';
      const stepEvidenceText = stepRecords.length ? stepRecords.map(r => {
        const hasBefore = !!(r.screenshotBefore || r.screenshot || r.markedShot || r.regionShot);
        const hasAfter = !!r.screenshotAfter;
        const target = r.target?.text || r.domElementText || r.llmElementText || '';
        const visualEvidenceItems = Array.isArray(r.visualEvidenceItems) ? r.visualEvidenceItems.slice(0, 5) : [];
        const evidenceReasons = visualEvidenceItems.length
          ? visualEvidenceItems.map((ev, i) => {
              const pointer = ev.visualEvidenceIndex != null ? `index ${ev.visualEvidenceIndex}` : (ev.visualEvidenceNormRect ? 'rect' : 'unknown');
              return `${i + 1}) ${pointer}: ${ev.visualEvidenceReason || ''}`;
            }).join(' | ')
          : (r.visualEvidenceReason ? `1) ${r.visualEvidenceIndex != null ? `index ${r.visualEvidenceIndex}` : 'rect'}: ${r.visualEvidenceReason}` : '');
        // The model's own per-step justifications (why each visual evidence target was chosen).
        const evidence = evidenceReasons ? `, evidence="${evidenceReasons}"` : '';
        return `Step ${r.step}: before=${hasBefore ? 'yes' : 'no'}, after=${hasAfter ? 'yes' : 'no'}, target="${target}", action=${r.action || ''}${evidence}, instruction=${r.instruction || ''}`;
      }).join('\n') : '(no step visual evidence records)';
      recapSystemPrompt = GUIDE_RECAP_SUMMARIZER_SYSTEM_PROMPT;
      recapUserPrompt = _gv2RenderTemplate(GUIDE_RECAP_SUMMARIZER_USER_TEMPLATE, {
        USER_GOAL: g?.question || '',
        OUTCOME_LINE: `${verdictKey}${verdictKey === 'failed' ? ' — the agent stopped before emitting a finish action; explain where and why it broke down.' : ' — the agent emitted a finish action; summarize what it accomplished.'}`,
        HAS_INITIAL_IMAGE: initialShot ? 'yes' : 'no',
        HAS_FINAL_IMAGE: finalShot ? 'yes' : 'no',
        PLAN_SECTION: plan.length ? `PLAN MILESTONES:\n${planText}\n\n` : '',
        COMPLETED_STEPS: steps.join('\n'),
        CONFIDENCE_SIGNALS: scoreText,
        VISUAL_EVIDENCE_BY_STEP: stepEvidenceText,
        EVIDENCE_SCRATCHPAD: scratchpadText
      });
      const useVision = await _gv2IsVisionEnabled();
      recapImages = [];
      if (useVision && initialShot) recapImages.push({ base64: initialShot, label: 'Initial state before guide' });
      if (useVision && finalShot) recapImages.push({ base64: finalShot, label: 'Final state after guide' });
      const recapMsg = {
        action: recapImages.length ? 'callLLMWithImages' : 'callLLM',
        systemPrompt: recapSystemPrompt,
        messages: [{ role: 'user', content: recapUserPrompt }],
        metadata: { mode: 'guide', step: 'recap', url: window.location.href }
      };
      if (recapImages.length) recapMsg.images = recapImages;
      let response = await safeSendMessage(recapMsg);
      // If the recap multi-image call fails for model/provider reasons, retry text-only.
      if (recapImages.length && response && response.error) {
        response = await safeSendMessage({ ...recapMsg, action: 'callLLM', images: undefined });
      }
      recapResponse = (response && response.content) ? String(response.content) : '';
      if (recapResponse && typeof gv2ExtractJsonObject === 'function') {
        raw = gv2ExtractJsonObject(recapResponse);
      }
    } catch (e) {
      console.warn('[guidev2] recap LLM failed:', e);
    }

    const rawNorm = (typeof gv2NormalizeFinalVerdict === 'function')
      ? gv2NormalizeFinalVerdict(raw)
      : { verdict: 'unclear', reason: raw?.reason || '', annotations: [] };
    // The verdict is deterministic (finish → completed, else failed); only the reason + annotations
    // come from the summarization LLM. It is never allowed to overturn the outcome.
    const final = { verdict: verdictKey, reason: rawNorm.reason, annotations: rawNorm.annotations };
    ctx.finalVerdict = final.verdict;
    ctx.finalReason = final.reason;
    ctx.scratchpad = recapScratchpad;

    const normalized = (typeof gv2NormalizeRecap === 'function')
      ? gv2NormalizeRecap(raw, ctx)
      : { summary: final?.verdict === 'completed' ? 'I have completed the task.' : 'I could not complete the task.', milestones: [] };
    if (!normalized || !normalized.summary) return null;
    const milestones = Array.isArray(normalized.milestones) ? normalized.milestones : [];
    const summarySegments = Array.isArray(normalized.summarySegments) ? normalized.summarySegments : [];

    // Persist the recap prompt/response onto the final step's record so the step inspector can
    // show a "Summarization" section (what we sent to the LLM and what it replied).
    if (typeof rewindPatchRecord === 'function' && Number.isFinite(finalStep)) {
      try {
        // Store text/verdict first. Full screenshots can make the record large; they are attached
        // in a second best-effort patch so a quota/size failure cannot erase the prompt/response.
        await rewindPatchRecord(g.sessionId, finalStep, {
          recapSystemPrompt,
          recapUserPrompt,
          recapResponse,
          finalVerifySystemPrompt: recapSystemPrompt,
          finalVerifyUserPrompt: recapUserPrompt,
          finalVerifyResponse: recapResponse,
          finalVerdict: final.verdict,
          finalReason: final.reason,
          finalAnnotations: final.annotations
        });
        try {
          await rewindPatchRecord(g.sessionId, finalStep, {
            finalShot: finalShot || null,
            recapImages
          });
        } catch (e) {
          console.warn('[guidev2] recap screenshots were not stored:', e);
        }
      } catch (e) { /* non-fatal */ }
    }

    // Per-step visual-evidence justifications keyed by step, so the panel can merge each step's
    // reasons (as clickable links to evidence crops) into the matching milestone row.
    const evidenceByStep = {};
    for (const r of stepRecords) {
      if (!r || r.step == null) continue;
      const items = Array.isArray(r.visualEvidenceItems) ? r.visualEvidenceItems.slice(0, 5) : [];
      if (items.length) {
        evidenceByStep[r.step] = {
          reason: items.map(it => it.visualEvidenceReason).filter(Boolean).join(' | '),
          items: items.map((it) => ({
            reason: it.visualEvidenceReason || '',
            index: it.visualEvidenceIndex != null ? it.visualEvidenceIndex : null,
            hasShot: !!it.visualEvidenceShot,
            hasRect: !!it.visualEvidenceNormRect
          })),
          hasShot: items.some(it => !!it.visualEvidenceShot || !!it.visualEvidenceNormRect)
        };
      } else if (r.visualEvidenceReason || r.hasVisualEvidence) {
        evidenceByStep[r.step] = { reason: r.visualEvidenceReason || '', hasShot: !!r.hasVisualEvidence };
      }
    }

    // Guaranteed visual link for whichever consumer renders this recap: the answer card (navigate-
    // only S3 tasks land here whenever the scratchpad ends up empty — see gv2BuildAnswerEvidence)
    // or a failed-run diagnostic card. Falls back to action grounding on the clicked step.
    let answerEvidence = [];
    try { answerEvidence = await _gv2ComputeAnswerEvidence(g, '', finalStep); } catch (e) { answerEvidence = []; }

    return {
      summary: normalized.summary,
      summarySegments,
      milestones,
      sessionId: g?.sessionId,
      finalStep: Number.isFinite(finalStep) ? finalStep : null,
      final: { verdict: final.verdict, reason: final.reason, annotations: final.annotations, shot: finalShot || null, step: finalStep },
      steps: milestones.map(m => m.step),
      evidenceByStep,
      answerEvidence
    };
  } catch (e) {
    console.warn('[guidev2] _gv2BuildRecap error:', e);
    return null;
  }
}

// Fire-and-forget: after a guide trajectory ends (completed or failed), if personalization is
// enabled, ask a cheap/fast model to fold the just-finished trajectory into the user's rolling
// learned profile. Independent of _gv2IsEndSummaryOn — that toggle controls the separate visual
// recap feature, not personalization. Never throws into the caller; a failed or malformed
// response leaves the existing stored profile untouched (see gv2NormalizeProfileUpdate).
async function _gv2UpdatePersonalizedProfile(g, outcome) {
  try {
    const s = await chrome.storage.sync.get(['personalizationEnabled', 'personalizationFacts', 'personalizedProfile']);
    if (!s.personalizationEnabled) return;
    const steps = Array.isArray(g?.previousSteps) ? g.previousSteps : [];
    if (!steps.length) return;

    const userPrompt = _gv2RenderTemplate(PERSONALIZATION_PROFILE_UPDATER_USER_TEMPLATE, {
      PRIOR_PROFILE: s.personalizedProfile?.summary || '(none yet)',
      MANUAL_FACTS: (s.personalizationFacts || '').trim() || '(none)',
      USER_GOAL: g?.question || '',
      OUTCOME: outcome,
      TRAJECTORY: steps.join('\n')
    });

    // Cheap/fast router model (Gemini 2.5 Flash, falls back to the user's configured provider) —
    // this is a background bookkeeping call, not a user-facing generation, so it should not ride
    // on the user's potentially expensive main model.
    const response = await safeSendMessage({
      action: 'callRouterLLM',
      systemPrompt: PERSONALIZATION_PROFILE_UPDATER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    });
    const raw = response?.content ? gv2ExtractJsonObject(response.content) : null;
    if (!raw || !raw.summary) return;

    // Re-read the prior profile immediately before writing (rather than reusing the value read at
    // the top of this function) to shrink the window for a cross-tab last-write-wins race.
    const fresh = await chrome.storage.sync.get(['personalizedProfile']);
    const normalized = gv2NormalizeProfileUpdate(raw, fresh.personalizedProfile);
    if (!normalized) return;
    await chrome.storage.sync.set({ personalizedProfile: normalized });
  } catch (e) {
    console.warn('[guidev2] _gv2UpdatePersonalizedProfile error:', e);
  }
}

/**
 * Clear the accumulated pause-guard evidence on the guide state so a resume actually resumes.
 *
 * Both stop guards are *cumulative*: `lowConfidenceCount` counts low-confidence actions for the
 * whole session, and the loop score is `matches / 10` over `_mechElementTexts` — the running list
 * of every element key the guide has targeted. Once either crossed its threshold, resuming with
 * the history intact re-tripped the same guard on the very next step (and the loop list only ever
 * grew, so it could never fall back under 0.3). The user reviewed the situation and pressed
 * Resume, so both guards start over: they must see a fresh streak before stopping again.
 *
 * @param {object|null} g guide state (mutated in place)
 * @returns {object|null} the same object, for chaining
 */
function _gv2ResetPauseGuards(g) {
  if (!g) return g;
  g.lowConfidenceCount = 0;
  // The loop streak goes too. Resuming with it intact would stop again on the next over-threshold
  // step no matter what the threshold is set to — the user has just reviewed the repetition and
  // said to continue, so the guide owes them a fresh streak before stopping for it again.
  g.loopStepCount = 0;
  g._mechElementTexts = [];
  g._mechKeys = [];
  return g;
}
if (typeof window !== 'undefined') window._gv2ResetPauseGuards = _gv2ResetPauseGuards;

async function gv2RetryGuideStep() {
  const g = window._guidev2;
  if (!g || !g.active) return { success: false, error: 'Guide not active' };
  g.paused = false;
  _gv2ResetPauseGuards(g);
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
      if (_guidev2Resuming) return { success: false, progressed: false, navigated: true, capturedAfter: false, error: 'Guide is already continuing' };
      _guidev2Resuming = true;  // Set BEFORE any await to prevent double-fire
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
        const result = await gv2GenerateNextStep();
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
  if (_guidev2Resuming) return { success: false, progressed: false, navigated: false, capturedAfter: false, error: 'Guide is already continuing' };
  _guidev2Resuming = true;
  try {
    // Wait for DOM to settle (e.g. dropdown finished rendering)
    await gv2WaitForDomStable(2000, 300);
    if (_gv2IsStopped()) return { success: false, progressed: false, navigated: false, capturedAfter: false, error: 'Guide stopped' };
    // Rewind: refresh the just-clicked step's snapshot with the post-click view.
    await gv2RecaptureAfterAction(_gv2CompletedStepNumber());
    if (_gv2IsStopped()) return { success: false, progressed: false, navigated: false, capturedAfter: true, error: 'Guide stopped' };
    const result = await gv2GenerateNextStep();
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
/**
 * Note on the step's record which container a scroll moved, and whether it moved at all.
 *
 * Without this, "the agent scrolled and nothing happened" can only be inferred by eyeballing two
 * identical screenshots. With it, the inspector says which element was scrolled and why it was
 * chosen — the difference between debugging a wrong pick and guessing at one.
 *
 * Fire-and-forget, like every other capture patch: a run must never fail over telemetry.
 */
function _gv2RecordScrollOutcome(step, outcome) {
  const g = window._guidev2;
  if (!g?.sessionId || !outcome || typeof rewindPatchRecord !== 'function') return;
  const stepNumber = Number(step?.step);
  if (!Number.isFinite(stepNumber)) return;
  let target = '';
  try {
    const el = outcome.el;
    target = el === (document.scrollingElement || document.documentElement)
      ? 'page'
      : `${el?.tagName?.toLowerCase() || '?'}${el?.id ? '#' + el.id : ''}`;
  } catch (e) { /* best-effort */ }
  Promise.resolve(rewindPatchRecord(g.sessionId, stepNumber, {
    scrollTarget: target,
    scrollSource: outcome.source || '',
    scrollMoved: !!outcome.scrolled,
    scrollDelta: (outcome.after || 0) - (outcome.before || 0),
  })).catch(() => {});
}
if (typeof window !== 'undefined') window._gv2RecordScrollOutcome = _gv2RecordScrollOutcome;

function _gv2ScheduleAutoPerformAfterCapture(g, step, action) {
  if (!g || !step) return;
  _gv2ClearActionTimers();
  if (action === 'highlight') {
    // highlight already ran (read-only, nothing to perform) — just advance the loop.
    g._autoClickTimer = setTimeout(() => {
      g._autoClickTimer = null;
      if (!_gv2IsStopped()) _gv2SetWorkingStatus(_gv2ActionStatus(action, step));
      if (!_gv2IsStopped() && typeof gv2NextStep === 'function') gv2NextStep();
    }, 900);
    return;
  }
  if (action === 'type' || action === 'clear_text') {
    g._autoTypeTimer = setTimeout(() => {
      g._autoTypeTimer = null;
      if (_gv2IsStopped()) return;
      _gv2SetWorkingStatus(_gv2ActionStatus(action, step));
      if (action === 'clear_text') _gv2AutoClearText(step);
      else _gv2AutoType(step);
    }, 200);
    return;
  }
  if (action === 'scroll_down' || action === 'scroll_up') {
    g._autoClickTimer = setTimeout(() => {
      g._autoClickTimer = null;
      if (_gv2IsStopped()) return;
      _gv2SetWorkingStatus(_gv2ActionStatus(action, step));
      // Scroll what is actually in front of the user, not the page root. When the step names an
      // element, that is the strongest signal available about which pane it means — the planner saw
      // the page. Otherwise gv2ScrollBy detects it (open popup → locked body → page).
      const hintEl = (typeof getIndexedElement === 'function' && step?.element?.index != null)
        ? getIndexedElement(step.element.index)
        : null;
      const scrolled = (typeof gv2ScrollBy === 'function')
        ? gv2ScrollBy(action === 'scroll_up' ? 'up' : 'down', hintEl)
        : null;
      _gv2RecordScrollOutcome(step, scrolled);
      if (typeof gv2NextStep === 'function') setTimeout(() => {
        _gv2SetWorkingStatus('Checking result…');
        setTimeout(gv2NextStep, 250);
      }, 900);
    }, 200);
    return;
  }
  if (action === 'goto_url') {
    g._autoClickTimer = setTimeout(() => {
      g._autoClickTimer = null;
      if (_gv2IsStopped()) return;
      _gv2SetWorkingStatus(_gv2ActionStatus(action, step));
      const targetUrl = step.url;
      if (targetUrl) {
        window.location.href = targetUrl;
      }
    }, 500);
    return;
  }
  console.log('[guidev2] Auto mode: auto-performing low-risk action', action, 'step', step.step);
  g._autoClickTimer = setTimeout(() => {
    g._autoClickTimer = null;
    if (!_gv2IsStopped()) _gv2SetWorkingStatus(_gv2ActionStatus(action, step));
    if (!_gv2IsStopped() && typeof gv2NextStep === 'function') gv2NextStep();
  }, 900);
}
if (typeof window !== 'undefined') window._gv2ScheduleAutoPerformAfterCapture = _gv2ScheduleAutoPerformAfterCapture;

// ===== FIND (reader pass) =====

/**
 * Second LLM pass for action=find. The planner that chose `find` only ever saw the
 * interactive page index, so it cannot know what the page actually says. This pass reads
 * the full text, answers the question with [N:"text"] citations, and highlights them.
 *
 * Reuses the Ask flow wholesale: PROMPTS.ANSWER_AND_HIGHLIGHT + applyHighlightsFromCitations.
 *
 * @param {string} findQuery - the question to answer (falls back to the user's goal)
 * @returns {Promise<{answer:string, notOnPage:boolean, highlightCount:number, hasHighlights:boolean}>}
 */
async function gv2RunFind(findQuery) {
  const question = String(findQuery || window._guidev2?.question || '').trim();
  const pageContent = (typeof getVisibleText === 'function') ? getVisibleText(50000) : '';

  // A CONTENT index (interactiveOnly=false) so citations can land on paragraphs and
  // headings, not just buttons. NOTE: this overwrites window._pageguideIndex. That is
  // fine for the usual terminal find; after a mid-journey find the next step rebuilds
  // an interactive-only index, so citation chips from this answer go stale (their
  // highlights are cleared by that step anyway).
  const pageIndex = createPageIndex(5000, false);

  // Evidence: Visual answers from the page text AND a screenshot, and returns its own evidence in
  // the same reply. Evidence: Text runs the original text-only call below, untouched.
  const visualMode = typeof getEvidenceMode === 'function' && (await getEvidenceMode()) === 'visual';
  const nonGrounding = typeof isNonGroundingModeOn === 'function' && await isNonGroundingModeOn();
  // Both study arms get the SAME prompt for a given evidence mode — see the note in
  // content/prompts.js where ANSWER_NONGROUNDING used to be. Non-grounding filters the reply below.
  const systemPrompt = (visualMode ? (PROMPTS.FIND_ANSWER_VISUAL || PROMPTS.ANSWER_AND_HIGHLIGHT) : PROMPTS.ANSWER_AND_HIGHLIGHT)
    .replace('{pageContent}', pageContent || '(No text content found)')
    .replace('{pageIndex}', pageIndex.indexText || '(No elements indexed)')
    .replace('{maxItems}', String(GV2_FIND_VISUAL_EVIDENCE_MAX_ITEMS));

  let answerShot = null;
  if (visualMode && (await _gv2CaptureShotsAllowed())) {
    try {
      if (typeof showSetOfMarks === 'function') showSetOfMarks(pageIndex);
      await new Promise(r => setTimeout(r, 120));
      if (typeof captureScreenshot === 'function') answerShot = await captureScreenshot();
    } catch (e) {
      answerShot = null;
    } finally {
      try { if (typeof cleanupSom === 'function') cleanupSom(); } catch (e) {}
    }
  }

  // Viewport + crops of the pictures this question is about, so the agent can actually see (and
  // then annotate) the thing it is asked about.
  let answerImages = answerShot ? await gv2BuildFindAnswerImages(question, answerShot) : [];
  const askVisual = (images, userContent) => safeSendMessage({
    action: 'callLLMWithImages',
    systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    images,
    metadata: {
      mode: nonGrounding ? 'guide_find_nongrounding_visual' : 'guide_find_visual',
      url: window.location.href,
      findImageDiagnostics: typeof gv2FindImageDiagnostics === 'function' ? gv2FindImageDiagnostics() : [],
      imageSelectionDiagnostics: images?.selectionDiagnostics || null
    }
  });

  let response = answerShot
    ? await askVisual(answerImages, question)
    : await safeSendMessage({
        action: 'callLLM',
        systemPrompt,
        messages: [{ role: 'user', content: question }],
        metadata: { mode: nonGrounding ? 'guide_find_nongrounding' : 'guide_find', url: window.location.href }
      });

  if (response?.error) {
    console.warn('[guidev2] find: LLM error', response.error);
    return {
      answer: '',
      notOnPage: false,
      highlightCount: 0,
      hasHighlights: false,
      systemPrompt,
      userPrompt: question,
      rawResponse: response.error
    };
  }

  let rawAnswer = response?.content?.trim() || '';
  if (nonGrounding) {
    // The baseline shares the grounding prompt, so in Visual mode the reply is the JSON envelope
    // {answer, evidence}. Unwrap it and drop the evidence on the floor: it never reaches
    // gv2BuildFindEvidence, which is what keeps the annotator, the crops and the on-page marks out of
    // the baseline in one move. Without the unwrap the participant would read raw JSON.
    const parsed = (visualMode && typeof gv2ParseFindAnswer === 'function')
      ? gv2ParseFindAnswer(rawAnswer)
      : { answer: rawAnswer };
    const stripped = parsed.answer || rawAnswer;
    const answer = typeof stripNonGroundingMarkers === 'function' ? stripNonGroundingMarkers(stripped) : stripped;
    const { notOnPage } = gv2ParseFindResponse(answer);
    console.log('[guidev2] find: non-grounding plain answer');
    return {
      answer,
      notOnPage,
      highlightCount: 0,
      hasHighlights: false,
      findEvidenceShots: [],
      systemPrompt,
      userPrompt: question,
      rawResponse: rawAnswer
    };
  }
  // Visual mode replies with {answer, evidence}; a malformed envelope degrades to prose-only. Keyed on
  // visualMode alone, not on answerShot: the prompt is chosen by visualMode, so a run whose screenshot
  // capture failed still gets the envelope back and would otherwise print it raw.
  let parsedAnswer = (visualMode && typeof gv2ParseFindAnswer === 'function')
    ? gv2ParseFindAnswer(rawAnswer)
    : { answer: rawAnswer, evidence: [] };

  const answer = parsedAnswer.answer || rawAnswer;
  const modelEvidence = parsedAnswer.evidence || [];
  const { notOnPage } = gv2ParseFindResponse(answer);

  let highlightCount = 0;
  if (!nonGrounding && answer && !notOnPage && typeof applyHighlightsFromCitations === 'function') {
    highlightCount = applyHighlightsFromCitations(answer);
    if (highlightCount > 0 && typeof scrollToHighlight === 'function') {
      setTimeout(() => scrollToHighlight(0), 300);
    }
  }

  console.log('[guidev2] find:', notOnPage ? 'not on page' : `${highlightCount} passage(s) highlighted`);
  // Non-grounding baseline mode: strip citation markers from the answer text too, not just skip
  // applying the on-page highlight — otherwise the side panel's parseCitations() would still
  // render clickable citation chips, and clicking one triggers scrollToIndex()'s own flash
  // highlight independent of applyHighlightsFromCitations.
  const answerOut = nonGrounding && typeof stripNonGroundingMarkers === 'function'
    ? stripNonGroundingMarkers(answer)
    : answer;

  // Visual evidence mode: a crop per cited span plus annotated evidence of what the PAGE shows, so
  // the evidence travels with the answer instead of only living on the page — and so a question the
  // DOM cannot answer still gets proof. Text mode keeps the citation links and nothing else.
  const findEvidenceShots = await gv2BuildFindEvidence(highlightCount > 0, question, modelEvidence, answer);

  return {
    answer: answerOut,
    notOnPage,
    highlightCount,
    hasHighlights: highlightCount > 0,
    findEvidenceShots,
    systemPrompt,
    userPrompt: question,
    rawResponse: response?.content || ''
  };
}
if (typeof window !== 'undefined') window.gv2RunFind = gv2RunFind;

// How many cited spans a Find answer illustrates. Each crop costs a scroll + captureVisibleTab
// (Chrome rate-limits those), and a wall of images stops being evidence and becomes noise.
// Upper bound on evidence crops per answer. Each one costs a scroll + captureVisibleTab (Chrome
// rate-limits those), so a citation-heavy answer would otherwise spend many seconds capturing.
// Truncation is logged, never silent.
const GV2_FIND_EVIDENCE_MAX_SHOTS = 20;

/** Class marking the single span that is highlighted during its own evidence capture. */
const GV2_ACTIVE_HIGHLIGHT_CLASS = 'pageguide-highlight-active';
/** Set on <html> for the duration; see the capture-mode rules in content/content.css. */
const GV2_EVIDENCE_CAPTURE_CLASS = 'pageguide-evidence-capture';

/**
 * The cited spans worth capturing, paired with the citation number they belong to.
 *
 * Includes both precise text-span highlights and whole-element block highlights. Block highlights
 * are less precise, but in Visual+Find they are still the user's only visual evidence for bare
 * citations such as [10]. Numbers come from window._pageguideHighlightNumbers (set by
 * applyHighlightsFromCitations) so chip [3] is the answer's third citation, not the third capture
 * that happened to succeed.
 */
function gv2FindEvidenceTargets() {
  const els = Array.isArray(window._pageguideHighlights) ? window._pageguideHighlights : [];
  const numbers = Array.isArray(window._pageguideHighlightNumbers) ? window._pageguideHighlightNumbers : [];
  const out = [];
  els.forEach((el, i) => {
    if (!el || !el.getBoundingClientRect || !document.contains(el)) return;
    out.push({ el, number: numbers[i] != null ? numbers[i] : out.length + 1 });
  });
  return out;
}
if (typeof window !== 'undefined') window.gv2FindEvidenceTargets = gv2FindEvidenceTargets;

/** Block-level ancestors worth cropping when a span itself cannot be captured. */
const GV2_FIND_EVIDENCE_BLOCK_SELECTOR = 'p, li, td, th, blockquote, figure, h1, h2, h3, h4, section, article, div';

/**
 * Capture one cited span, with two escalating fallbacks. Order matters: the tight crop on the span
 * is the best evidence, so it gets three tries (Chrome rate-limits back-to-back captures, and a
 * re-scroll recovers rects invalidated by layout shift). Only then do we widen to the containing
 * block — a picture of the paragraph beats no picture at all, which is what a reader got before
 * when a span sat inside a scroll container or measured zero-height.
 *
 * @param {Element} el - the highlighted span
 * @returns {Promise<object|null>} the gv2CaptureEvidenceRegion result (may hold captureError)
 */
async function _gv2CaptureFindSpan(el) {
  let cap = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    // exact:true centers the span itself — centering its nearest link/nav ancestor instead can
    // leave the span off screen, and the capture then bails as 'dom-target-offscreen'.
    await _gv2ScrollRegionTargetIntoView(el, { exact: true });
    await _gv2WaitForLayoutSettle();
    cap = await gv2CaptureEvidenceRegion(el, null, null, { noMarker: true });
    if (cap?.visualEvidenceShot) return cap;
    if (attempt < 2) await new Promise(r => setTimeout(r, attempt === 0 ? 350 : 700));
  }

  const block = el.closest && el.closest(GV2_FIND_EVIDENCE_BLOCK_SELECTOR);
  if (block && block !== el) {
    await _gv2ScrollRegionTargetIntoView(block, { exact: true });
    await _gv2WaitForLayoutSettle();
    const blockCap = await gv2CaptureEvidenceRegion(block, null, null, { noMarker: true });
    if (blockCap?.visualEvidenceShot) return blockCap;
    return blockCap || cap;
  }
  return cap;
}

/**
 * Visual evidence mode: one crop per cited span, so every [N] in the answer has a picture of the
 * text it came from. Returns [] when there is nothing to show or the study arm is Text — callers
 * render the array unconditionally.
 *
 * Captures one span at a time: mute every other highlight, light up this one, scroll it to the
 * middle of the viewport, let the page settle, screenshot, then restore. Highlighting them all at
 * once produced crops where nothing identified WHICH tinted phrase was the evidence, and cropping
 * without settling first caught whatever sticky banner happened to be over those coordinates.
 *
 * @param {boolean} hasHighlights - false when the answer highlighted nothing (skip the work)
 * @returns {Promise<Array<{shot: string, note: string, index: number}>>}
 */
async function gv2CaptureFindEvidenceShots(hasHighlights) {
  if (!hasHighlights) return [];
  if (typeof gv2CaptureEvidenceRegion !== 'function') return [];
  if (!(await _gv2CaptureShotsAllowed())) return [];

  const targets = gv2FindEvidenceTargets();
  if (!targets.length) return [];
  if (targets.length > GV2_FIND_EVIDENCE_MAX_SHOTS) {
    console.log(`[guidev2] find evidence: capturing ${GV2_FIND_EVIDENCE_MAX_SHOTS} of ${targets.length} cited spans`);
  }
  const capped = targets.slice(0, GV2_FIND_EVIDENCE_MAX_SHOTS);

  // Set-of-Marks is an independent setting (somEnabled) and its numbered overlays sit on top of the
  // page — they would be captured inside every crop. Take them down first; the next guide step
  // redraws them.
  try { if (typeof cleanupSom === 'function') cleanupSom(); } catch (e) { /* best-effort */ }

  const startX = window.scrollX || 0;
  const startY = window.scrollY || 0;
  const root = document.documentElement;
  const out = [];
  const misses = [];

  root.classList.add(GV2_EVIDENCE_CAPTURE_CLASS);
  try {
    for (const target of capped) {
      target.el.classList.add(GV2_ACTIVE_HIGHLIGHT_CLASS);
      try {
        const cap = await _gv2CaptureFindSpan(target.el);
        if (cap?.visualEvidenceShot) {
          out.push({
            shot: cap.visualEvidenceShot,
            note: (target.el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
            index: target.number
          });
        } else {
          misses.push(`${target.number}:${cap?.captureError || 'no-shot'}`);
        }
      } catch (e) {
        misses.push(`${target.number}:threw`);
        console.warn('[guidev2] find evidence capture failed:', e);
      } finally {
        target.el.classList.remove(GV2_ACTIVE_HIGHLIGHT_CLASS);
      }
    }
  } finally {
    // Always put the page back the way the user left it, even if a capture threw.
    root.classList.remove(GV2_EVIDENCE_CAPTURE_CLASS);
    try { window.scrollTo(startX, startY); } catch (e) { /* best-effort */ }
  }
  // One line that explains a thin evidence strip without a debugging session.
  console.log(`[guidev2] find evidence: ${out.length}/${capped.length} captured${misses.length ? ` — misses ${misses.join(', ')}` : ''}`);
  return out;
}
if (typeof window !== 'undefined') window.gv2CaptureFindEvidenceShots = gv2CaptureFindEvidenceShots;

// How many annotated page-evidence items one Find may produce. Each costs an annotator call on top
// of the single vision call, so this is the knob that bounds Find × Visual's added latency.
const GV2_FIND_VISUAL_EVIDENCE_MAX_ITEMS = 3;

/**
 * Parse the FIND_ANSWER_VISUAL reply: one JSON envelope carrying the prose answer and the model's
 * own evidence list. Pure and defensive — a model that ignores the format still produces a readable
 * answer, because the fallback treats the whole reply as the answer with no evidence. That matters:
 * a broken envelope must degrade to today's text-only behaviour, never to an empty answer.
 *
 * @param {string} raw - model reply
 * @param {number} maxItems - cap on evidence items
 * @returns {{answer: string, evidence: Array<object>}}
 */
function gv2ParseFindAnswer(raw, maxItems = GV2_FIND_VISUAL_EVIDENCE_MAX_ITEMS) {
  const text = String(raw || '').trim();
  if (!text) return { answer: '', evidence: [] };
  const cleaned = text.replace(/```json|```/g, '').trim();
  try {
    const parsed = typeof gv2ExtractJsonObject === 'function'
      ? (gv2ExtractJsonObject(cleaned) || JSON.parse(cleaned))
      : JSON.parse(cleaned);
    if (parsed && typeof parsed.answer === 'string') {
      return {
        answer: parsed.answer,
        evidence: gv2ParseFindVisualEvidence(JSON.stringify({ items: parsed.evidence || [] }), maxItems)
      };
    }
  } catch (e) { /* fall through to prose */ }
  // Not the envelope we asked for — treat the reply as the answer, which is what it almost always
  // is when a model drops the JSON.
  return { answer: text, evidence: [] };
}
if (typeof window !== 'undefined') window.gv2ParseFindAnswer = gv2ParseFindAnswer;

/**
 * Parse the FIND_VISUAL_EVIDENCE reply into evidence items. Pure and defensive: a model that
 * returns prose, fenced JSON, a bare array, or nonsense yields [] rather than throwing, because an
 * empty list is a legitimate answer here (ordinary text questions have no visual evidence).
 *
 * @param {string} raw - model reply
 * @param {number} maxItems
 * @returns {Array<object>} items in Guide's saved-evidence shape
 */
function gv2ParseFindVisualEvidence(raw, maxItems = GV2_FIND_VISUAL_EVIDENCE_MAX_ITEMS) {
  try {
    const text = String(raw || '').replace(/```json|```/g, '').trim();
    if (!text) return [];
    // A bare array is already valid JSON; gv2ExtractJsonObject hunts for {...} and would pull out
    // the first ITEM instead of the list.
    const parsed = text.startsWith('[')
      ? JSON.parse(text)
      : (typeof gv2ExtractJsonObject === 'function' ? (gv2ExtractJsonObject(text) || JSON.parse(text)) : JSON.parse(text));
    const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : []);
    return items
      .filter(it => it && (it.som_id || it.region_bbox || it.need_annotation))
      .slice(0, Math.max(0, maxItems))
      .map((it, i) => ({
        key: String(it.key || `visual_evidence_${i + 1}`).trim(),
        note: String(it.note || '').replace(/\s+/g, ' ').trim(),
        som_id: it.som_id != null ? String(it.som_id) : null,
        region_bbox: it.region_bbox || null,
        source_image_id: String(it.source_image_id || it.image_id || 'viewport').trim() || 'viewport',
        need_annotation: !!it.need_annotation,
        annotation_prompt: it.annotation_prompt || it.note || null
      }));
  } catch (e) {
    return [];
  }
}
if (typeof window !== 'undefined') window.gv2ParseFindVisualEvidence = gv2ParseFindVisualEvidence;

/**
 * Find × Visual, second pass: ask a vision model what the PAGE shows that bears on the question,
 * then crop and annotate those regions through the Guide's existing evidence pipeline.
 *
 * This is what lets Find answer questions the DOM cannot support — "does the person in the portrait
 * have a beard?", "what colour is the shirt?" — where there is no text to cite. The model returns
 * Guide's saved-evidence shape, so gv2CaptureEvidenceItems does the rest unchanged: it routes
 * need_annotation items to the annotator (PROMPTS.GUIDE_EVIDENCE_ANNOTATOR) and returns crops with
 * the boxes/labels already drawn in.
 *
 * Runs on every Find in Visual mode; the model returns an empty list for ordinary text questions,
 * so the cost is one vision call, not one annotation pass.
 *
 * @param {string} question
 * @param {number} startNumber - first free chip number (span crops take 1..N)
 * @returns {Promise<Array<{shot: string, note: string, index: number}>>}
 */
async function gv2RunFindVisualEvidence(question, startNumber = 1) {
  const q = String(question || window._guidev2?.question || '').trim();
  if (!q) return [];
  if (typeof gv2CaptureEvidenceItems !== 'function') return [];
  if (!(await _gv2CaptureShotsAllowed())) return [];

  // A screenshot WITH SoM markers, so the model can point at indexed elements by number.
  let shot = null;
  let pageIndex = null;
  try {
    pageIndex = createPageIndex(GV2_GUIDE_INDEX_MAX_ITEMS, true);
    if (typeof showSetOfMarks === 'function') showSetOfMarks(pageIndex);
    await new Promise(r => setTimeout(r, 120));
    if (typeof captureScreenshot === 'function') shot = await captureScreenshot();
  } catch (e) {
    shot = null;
  } finally {
    try { if (typeof cleanupSom === 'function') cleanupSom(); } catch (e) { /* best-effort */ }
  }
  if (!shot) return [];

  const systemPrompt = String(PROMPTS?.FIND_VISUAL_EVIDENCE || '')
    .replace('{maxItems}', String(GV2_FIND_VISUAL_EVIDENCE_MAX_ITEMS));
  if (!systemPrompt) return [];

  let items = [];
  try {
    const response = await safeSendMessage({
      action: 'callLLMWithImages',
      systemPrompt,
      messages: [{ role: 'user', content: `QUESTION: ${q}\n\nReturn the JSON object.` }],
      images: [{ id: 'viewport', base64: shot, label: '[image_id=viewport] Page screenshot with SoM markers' }],
      metadata: { mode: 'find_visual_evidence', url: window.location.href }
    });
    items = gv2ParseFindVisualEvidence(response?.content);
  } catch (e) {
    console.warn('[guidev2] find visual evidence call failed:', e);
    return [];
  }
  if (!items.length) {
    console.log('[guidev2] find visual evidence: none (text answer is sufficient)');
    return [];
  }

  return gv2CaptureFindEvidenceItems(items, startNumber);
}
if (typeof window !== 'undefined') window.gv2RunFindVisualEvidence = gv2RunFindVisualEvidence;

/**
 * Crop and annotate a list of evidence items into numbered chips. The items come from the model —
 * either from the answer call (FIND_ANSWER_VISUAL, the normal path) or from the standalone visual
 * pass — and are in Guide's saved-evidence shape, so gv2CaptureEvidenceItems does the work:
 * resolving SoM targets, cropping, and routing need_annotation items to the annotator.
 *
 * @param {Array<object>} items - evidence items in Guide's shape
 * @param {number} startNumber - first free chip number (span crops take 1..N)
 * @returns {Promise<Array<{shot: string, note: string, index: number, marks: object}>>}
 */
async function gv2CaptureFindEvidenceItems(items, startNumber = 1) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  if (typeof gv2CaptureEvidenceItems !== 'function') return [];
  if (!(await _gv2CaptureShotsAllowed())) return [];

  // Resolve SoM ids to live elements, then hand the whole list to the Guide's capture+annotate
  // pipeline. Items with neither element nor bbox become full-viewport annotations there.
  const resolved = list.map(item => {
    const somIndex = typeof _gv2SomIdToIndex === 'function' ? _gv2SomIdToIndex(item.som_id) : null;
    const somEl = somIndex != null ? (window._pageguideIndex?.[somIndex] || null) : null;
    const sourceImageId = item.source_image_id || 'viewport';
    const source = typeof gv2FindAnswerImageSource === 'function' ? gv2FindAnswerImageSource(sourceImageId) : null;
    const sourceEl = sourceImageId !== 'viewport' ? _gv2LiveElementForFindImageSource(source) : null;

    // When the model asks for an annotation, honour it EVEN IF the evidence resolved to an
    // element. Guide's pipeline skips the annotator for any item carrying an element or som_id
    // (_gv2AnnotateEvidenceItem returns early), which is right for a button — a box around it says
    // everything — but wrong here: "box the man's beard" means marking something INSIDE the
    // element. So the element is dropped and its rect is handed over as the region hint, which is
    // what the annotator needs to aim inside it.
    const annotateInside = !!(somEl && item.need_annotation);
    let insideRect = null;
    if (annotateInside && typeof gv2TargetNormRect === 'function') {
      try {
        const r = somEl.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          insideRect = gv2TargetNormRect({ left: r.left, top: r.top, width: r.width, height: r.height },
            window.innerWidth, window.innerHeight);
        }
      } catch (e) { insideRect = null; }
    }
    const useEl = somEl && !annotateInside ? somEl : null;

    return {
      key: item.key,
      note: item.note,
      source_image_id: sourceImageId,
      som_id: annotateInside ? null : item.som_id,
      region_bbox: insideRect || item.region_bbox,
      need_annotation: !!item.need_annotation,
      annotation_prompt: item.annotation_prompt,
      annotationSourceShot: sourceImageId !== 'viewport' ? (source?.shot || source?.base64 || source?.screenshotBase64 || null) : null,
      annotationSourceEl: sourceEl || null,
      annotationSourceGeometry: sourceImageId !== 'viewport' ? (source?.annotationGeometry || source?.captureGeometry || null) : null,
      annotationSourceRect: !sourceEl && sourceImageId !== 'viewport' ? (source?.targetRect || null) : null,
      annotations: [],
      evidenceEl: useEl,
      evidenceIndex: useEl && somIndex != null ? somIndex : null,
      evidenceRect: useEl ? null : (insideRect || item.region_bbox || null),
      text: item.note,
      reason: item.note,
      scrollIntoView: !!useEl,
      forceDomMarker: !!useEl,
      fullViewportCapture: !useEl && !insideRect && !item.region_bbox
    };
  });

  try {
    const caps = await gv2CaptureEvidenceItems(resolved, {
      restoreScroll: true,
      maxItems: GV2_FIND_VISUAL_EVIDENCE_MAX_ITEMS
    });
    const out = (Array.isArray(caps) ? caps : [])
      .map((cap, i) => ({
        shot: cap?.visualEvidenceShot || null,
        note: cap?.note || cap?.visualEvidenceReason || resolved[i]?.note || '',
        index: startNumber + i,
        // The model cites visual evidence in the answer as [ev:key]; the panel needs the key to
        // turn those into chips that open this crop.
        key: cap?.key || resolved[i]?.key || null,
        source_image_id: cap?.source_image_id || resolved[i]?.source_image_id || 'viewport',
        // Everything the on-page renderer needs to redraw these marks over the live page, and
        // nothing else — deliberately not the screenshots, which would bloat every panel message.
        marks: {
          annotations: Array.isArray(cap?.annotations) ? cap.annotations : [],
          region_bbox: cap?.region_bbox || cap?.visualEvidenceNormRect || null,
          annotationGeometry: cap?.annotationGeometry || cap?.captureGeometry || null,
          captureGeometry: cap?.annotationGeometry || cap?.captureGeometry || null,
          visualEvidenceIndex: cap?.visualEvidenceIndex != null ? cap.visualEvidenceIndex : null,
          // The chip number, so clicking [ev:N] in the panel can scroll to THIS mark on the page.
          // Distinct from visualEvidenceIndex above, which is the SoM page index of the target.
          evidenceNumber: startNumber + i,
          source_image_id: cap?.source_image_id || resolved[i]?.source_image_id || 'viewport',
          note: cap?.note || resolved[i]?.note || ''
        }
      }))
      .filter(item => !!item.shot);
    console.log(`[guidev2] find visual evidence: ${out.length}/${resolved.length} captured`);
    return out;
  } catch (e) {
    console.warn('[guidev2] find visual evidence capture failed:', e);
    return [];
  }
}
if (typeof window !== 'undefined') window.gv2CaptureFindEvidenceItems = gv2CaptureFindEvidenceItems;

// ===== IMAGES FOR THE FIND ANSWER CALL =====
// The viewport alone is a narrow window: the picture a question is about is often half out of
// frame, or below the fold. Rather than pre-cropping only the top heuristics, first send a cheap
// text catalog of all page-image labels to the selector, then scroll/capture only the selected ids.

/** Media crops attached to the answer call, on top of the viewport shot. */
const GV2_FIND_MEDIA_CROPS = 3;
/** Hard ceiling for the final answer attachment count, including the viewport. */
const GV2_FIND_MAX_IMAGES = 8;
/** Crops are downscaled to this width before being attached to the answer call.
 *
 *  Was 1024, on the reasoning that a retina crop of a painting costs several times the tokens for no
 *  extra detail. That holds for a painting and fails badly for anything text-bearing: a two-page
 *  scanned spread of captioned portraits squeezed to 1024px leaves each caption a few pixels tall,
 *  and the model cannot read what the question is about — the image arrives blurry and useless.
 *  Find attaches at most GV2_FIND_MEDIA_CROPS images, so the extra tokens are bounded and worth it.
 *  _gv2DownscaleImageBase64 only ever shrinks, so a smaller source is passed through untouched. */
const GV2_FIND_CROP_MAX_WIDTH = 2048;

// Crop cache for the session: the same page answers several questions in a study task, and the
// pictures do not move. Keyed by page identity + element, cleared when the page changes.
const _gv2FindCropCache = new Map();
const _gv2FindAnswerImageSources = new Map();
let _gv2FindImageDiagnostics = [];
/** Cap so a long session cannot accumulate crops for every page visited. */
const GV2_FIND_CROP_CACHE_MAX = 20;
/** Drop the cached crops (navigation, or a test that wants a cold start). */
function gv2ClearFindCropCache() { _gv2FindCropCache.clear(); _gv2FindAnswerImageSources.clear(); _gv2FindImageDiagnostics = []; }
if (typeof window !== 'undefined') window.gv2ClearFindCropCache = gv2ClearFindCropCache;

function gv2FindImageDiagnostics() {
  return _gv2FindImageDiagnostics.slice();
}
if (typeof window !== 'undefined') window.gv2FindImageDiagnostics = gv2FindImageDiagnostics;

function gv2RememberFindAnswerImageSource(meta) {
  const id = String(meta?.id || '').trim();
  if (!id) return null;
  const source = Object.assign({}, meta, { id });
  _gv2FindAnswerImageSources.set(id, source);
  return source;
}
if (typeof window !== 'undefined') window.gv2RememberFindAnswerImageSource = gv2RememberFindAnswerImageSource;

function gv2FindAnswerImageSource(id) {
  const key = String(id || '').trim();
  return key ? (_gv2FindAnswerImageSources.get(key) || null) : null;
}
if (typeof window !== 'undefined') window.gv2FindAnswerImageSource = gv2FindAnswerImageSource;

function _gv2LiveElementForFindImageSource(source) {
  if (!source) return null;
  if (source.el && document.contains(source.el)) return source.el;
  if (source.selector) {
    try {
      const el = document.querySelector(source.selector);
      if (el) return el;
    } catch (e) { /* stale/invalid selector */ }
  }
  return null;
}

function _gv2PrimaryImageElement(el) {
  if (!el) return null;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'IMG') return el;
  if (tag === 'PICTURE') return el.querySelector?.('img') || null;
  if (tag === 'FIGURE') return el.querySelector?.('img') || null;
  return el.querySelector?.('img') || null;
}
if (typeof window !== 'undefined') window._gv2PrimaryImageElement = _gv2PrimaryImageElement;

function _gv2ImageSourceUrl(img) {
  if (!img) return '';
  const raw = img.currentSrc || img.src || img.getAttribute?.('src') || '';
  try {
    return raw ? new URL(raw, window.location.href).href : '';
  } catch (e) {
    return raw || '';
  }
}

function _gv2ElementDocumentGeometry(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  try {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return null;
    return {
      x: (window.scrollX || 0) + r.left,
      y: (window.scrollY || 0) + r.top,
      w: r.width,
      h: r.height
    };
  } catch (e) {
    return null;
  }
}

async function _gv2DownscaleImageBase64(base64, maxWidth = GV2_FIND_CROP_MAX_WIDTH, contentType = 'image/jpeg') {
  if (!base64) return null;
  if (typeof window !== 'undefined' && window.IS_TEST_ENV) return base64;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v || null); } };
    setTimeout(() => finish(base64), 1500);
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const srcW = img.naturalWidth || img.width || 0;
          const srcH = img.naturalHeight || img.height || 0;
          if (!(srcW > 0) || !(srcH > 0)) return finish(base64);
          const scale = maxWidth > 0 && srcW > maxWidth ? maxWidth / srcW : 1;
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(srcW * scale));
          canvas.height = Math.max(1, Math.round(srcH * scale));
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const mime = /^image\/png$/i.test(contentType) ? 'image/png' : 'image/jpeg';
          const dataUrl = canvas.toDataURL(mime, mime === 'image/jpeg' ? 0.86 : undefined);
          finish(dataUrl.replace(/^data:image\/\w+;base64,/, ''));
        } catch (e) {
          finish(base64);
        }
      };
      img.onerror = () => finish(base64);
      img.src = String(base64).startsWith('data:') ? String(base64) : `data:${contentType || 'image/jpeg'};base64,${base64}`;
    } catch (e) {
      finish(base64);
    }
  });
}

async function _gv2CaptureWholeMediaImage(el, maxWidth = GV2_FIND_CROP_MAX_WIDTH) {
  const img = _gv2PrimaryImageElement(el);
  const url = _gv2ImageSourceUrl(img);
  if (!img || !url || typeof safeSendMessage !== 'function') return null;
  try {
    const response = await safeSendMessage({ action: 'fetchImageAsBase64', url });
    if (response?.error || !response?.imageBase64) return { error: response?.error || 'image-fetch-empty' };
    const base64 = await _gv2DownscaleImageBase64(response.imageBase64, maxWidth, response.contentType || 'image/jpeg');
    if (!base64) return { error: 'image-downscale-empty' };
    const geometry = _gv2ElementDocumentGeometry(img) || _gv2ElementDocumentGeometry(el);
    return {
      shot: base64,
      contentType: response.contentType || 'image/jpeg',
      sourceUrl: response.sourceUrl || url,
      geometry,
      el: img,
      selector: typeof gv2ElementSelector === 'function' ? gv2ElementSelector(img) : ''
    };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}
if (typeof window !== 'undefined') window._gv2CaptureWholeMediaImage = _gv2CaptureWholeMediaImage;

function _gv2FindCropCacheKey(el) {
  const sig = `${window.location.href}|${document.documentElement.scrollHeight}|${window.devicePixelRatio || 1}`;
  const sel = typeof gv2ElementSelector === 'function' ? gv2ElementSelector(el) : (el?.tagName || '');
  return `${sig}|${sel}`;
}

async function _gv2CaptureViewportAroundMedia(el) {
  if (!el || !document.contains(el)) return null;
  try {
    await _gv2ScrollRegionTargetIntoView(el, { exact: true });
    await _gv2WaitForLayoutSettle();
    const shot = typeof captureScreenshot === 'function' ? await captureScreenshot() : null;
    if (!shot) return null;
    let rect = null;
    try {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && typeof gv2TargetNormRect === 'function') {
        rect = gv2TargetNormRect({ left: r.left, top: r.top, width: r.width, height: r.height },
          window.innerWidth, window.innerHeight);
      }
    } catch (e) {}
    return {
      shot,
      captureGeometry: { x: window.scrollX || 0, y: window.scrollY || 0, w: window.innerWidth || 0, h: window.innerHeight || 0 },
      targetRect: rect
    };
  } catch (e) {
    return null;
  }
}

function _gv2CropDocumentGeometryForRect(rect, viewportGeometry) {
  if (!rect || !viewportGeometry) return null;
  const vw = Number(viewportGeometry.w);
  const vh = Number(viewportGeometry.h);
  if (!(vw > 0) || !(vh > 0)) return null;
  const left = Number(rect.left);
  const top = Number(rect.top);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![left, top, width, height].every(Number.isFinite) || !(width > 0) || !(height > 0)) return null;
  const pad = Math.max(120, width * 0.6, height * 0.6);
  const cropLeft = Math.max(0, Math.min(vw, left - pad));
  const cropTop = Math.max(0, Math.min(vh, top - pad));
  const cropRight = Math.max(cropLeft, Math.min(vw, left + width + pad));
  const cropBottom = Math.max(cropTop, Math.min(vh, top + height + pad));
  return {
    x: (Number(viewportGeometry.x) || 0) + cropLeft,
    y: (Number(viewportGeometry.y) || 0) + cropTop,
    w: cropRight - cropLeft,
    h: cropBottom - cropTop
  };
}
if (typeof window !== 'undefined') window._gv2CropDocumentGeometryForRect = _gv2CropDocumentGeometryForRect;

function gv2BuildFindImageCatalog(question) {
  if (typeof gv2FindMediaCandidates !== 'function') return [];
  let candidates = [];
  try { candidates = gv2FindMediaCandidates(question, { limit: Infinity, includeAll: true }); } catch (e) { candidates = []; }
  return candidates.map((cand, idx) => Object.assign({}, cand, {
    id: `page_image_${idx + 1}`,
    selectorLabel: gv2FindImageSelectorLabel(cand),
    selector: typeof gv2ElementSelector === 'function' ? gv2ElementSelector(cand.el) : ''
  }));
}
if (typeof window !== 'undefined') window.gv2BuildFindImageCatalog = gv2BuildFindImageCatalog;

function gv2FindImageSelectorLabel(cand) {
  const parts = Array.isArray(cand?.descriptor) ? cand.descriptor : [];
  if (parts.length) {
    return parts
      .slice(0, 5)
      .map(p => `${p.kind}: ${String(p.text || '').replace(/\s+/g, ' ').trim()}`)
      .filter(Boolean)
      .join(' | ')
      .slice(0, 700);
  }
  return String(cand?.label || '').replace(/\s+/g, ' ').trim().slice(0, 400);
}
if (typeof window !== 'undefined') window.gv2FindImageSelectorLabel = gv2FindImageSelectorLabel;

async function gv2CaptureFindImageCatalogItems(catalogItems, maxCrops = GV2_FIND_MEDIA_CROPS) {
  const images = [];
  let sent = 0;
  for (const cand of (catalogItems || [])) {
    if (sent >= maxCrops || images.length >= GV2_FIND_MAX_IMAGES - 1) break;
    const diag = {
      id: cand.id || null,
      label: String(cand.label || '').slice(0, 160),
      score: Number.isFinite(cand.score) ? Number(cand.score.toFixed(3)) : null,
      why: cand.why || '',
      selector: cand.selector || (typeof gv2ElementSelector === 'function' ? gv2ElementSelector(cand.el) : ''),
      status: 'selected',
      captureError: null
    };
    const key = _gv2FindCropCacheKey(cand.el);
    let cached = _gv2FindCropCache.get(key) || null;
    let shot = typeof cached === 'string' ? cached : (cached?.shot || null);
    let sourceMeta = cached && typeof cached === 'object' ? cached.source : null;
    let fallbackCap = null;
    if (!shot) {
      try {
        const whole = await _gv2CaptureWholeMediaImage(cand.el, GV2_FIND_CROP_MAX_WIDTH);
        if (whole?.shot) {
          shot = whole.shot;
          diag.status = 'sent_whole_image';
          diag.captureError = null;
          sourceMeta = {
            kind: 'page_image',
            selector: whole.selector || diag.selector,
            shot,
            captureGeometry: whole.geometry || null,
            annotationGeometry: whole.geometry || null,
            targetRect: { x: 0, y: 0, w: 1, h: 1 },
            label: cand.label,
            el: whole.el || cand.el,
            sourceUrl: whole.sourceUrl || null,
            wholeImage: true
          };
          if (_gv2FindCropCache.size >= GV2_FIND_CROP_CACHE_MAX) {
            _gv2FindCropCache.delete(_gv2FindCropCache.keys().next().value);
          }
          _gv2FindCropCache.set(key, { shot, source: sourceMeta });
        } else {
          diag.captureError = whole?.error || null;
        }
        if (!shot) {
          const cap = await gv2CaptureEvidenceRegion(cand.el, null, null, {
            noMarker: true,
            scrollIntoView: true,
            exactScrollTarget: true,
            fitInViewport: true,
            maxWidth: GV2_FIND_CROP_MAX_WIDTH
          });
          shot = cap?.visualEvidenceShot || null;
          diag.captureError = cap?.captureError || diag.captureError || null;
          if (shot) {
            if (diag.status === 'selected') diag.status = 'sent_crop';
            const viewportGeometry = cap?.captureGeometry || {
              x: window.scrollX || 0,
              y: window.scrollY || 0,
              w: window.innerWidth || 0,
              h: window.innerHeight || 0
            };
            let cropGeometry = null;
            try {
              const r = cand.el.getBoundingClientRect();
              cropGeometry = _gv2CropDocumentGeometryForRect(
                { left: r.left, top: r.top, width: r.width, height: r.height },
                viewportGeometry
              );
            } catch (e) { cropGeometry = null; }
            sourceMeta = {
              kind: 'page_image',
              selector: diag.selector,
              shot,
              captureGeometry: cap?.captureGeometry || null,
              annotationGeometry: cap?.visualEvidenceCropGeometry || cropGeometry || cap?.captureGeometry || null,
              targetRect: cap?.visualEvidenceNormRect || null,
              label: cand.label
            };
            if (_gv2FindCropCache.size >= GV2_FIND_CROP_CACHE_MAX) {
              _gv2FindCropCache.delete(_gv2FindCropCache.keys().next().value);
            }
            _gv2FindCropCache.set(key, { shot, source: sourceMeta });
          }
        }
        if (!shot) {
          fallbackCap = await _gv2CaptureViewportAroundMedia(cand.el);
          if (fallbackCap?.shot) {
            shot = fallbackCap.shot;
            diag.status = 'fallback_viewport';
            sourceMeta = {
              kind: 'page_image',
              selector: diag.selector,
              shot,
              captureGeometry: fallbackCap.captureGeometry || null,
              annotationGeometry: fallbackCap.captureGeometry || null,
              targetRect: fallbackCap.targetRect || null,
              label: cand.label
            };
          }
        }
      } catch (e) {
        diag.captureError = e?.message || 'capture-failed';
        fallbackCap = await _gv2CaptureViewportAroundMedia(cand.el);
        if (fallbackCap?.shot) {
          shot = fallbackCap.shot;
          diag.status = 'fallback_viewport';
          sourceMeta = {
            kind: 'page_image',
            selector: diag.selector,
            shot,
            captureGeometry: fallbackCap.captureGeometry || null,
            annotationGeometry: fallbackCap.captureGeometry || null,
            targetRect: fallbackCap.targetRect || null,
            label: cand.label
          };
        }
      }
    } else {
      diag.status = 'cache_hit';
    }
    if (shot) {
      if (diag.status === 'selected') diag.status = 'sent';
      gv2RememberFindAnswerImageSource(Object.assign({}, sourceMeta || {}, {
        id: cand.id,
        kind: 'page_image',
        shot,
        el: sourceMeta?.el || cand.el,
        selector: sourceMeta?.selector || diag.selector,
        label: cand.label
      }));
      images.push({ id: cand.id, base64: shot, label: `[image_id=${cand.id}] Image on page: ${cand.selectorLabel || cand.label}` });
      sent += 1;
    } else {
      diag.status = 'skipped';
    }
    _gv2FindImageDiagnostics.push(diag);
  }
  return images;
}
if (typeof window !== 'undefined') window.gv2CaptureFindImageCatalogItems = gv2CaptureFindImageCatalogItems;

/**
 * The images that go with a Find answer call: the viewport, then a crop per ranked media candidate.
 *
 * @param {string} question
 * @param {string} viewportShot - the SoM-marked viewport screenshot (may be null)
 * @param {number} maxCrops
 * @returns {Promise<Array<{id: string, base64: string, label: string}>>}
 */
async function gv2BuildFindAnswerImages(question, viewportShot, maxCrops = GV2_FIND_MEDIA_CROPS) {
  _gv2FindAnswerImageSources.clear();
  _gv2FindImageDiagnostics = [];
  const images = [];
  const startX = window.scrollX || 0;
  const startY = window.scrollY || 0;
  if (viewportShot) {
    gv2RememberFindAnswerImageSource({
      id: 'viewport',
      kind: 'viewport',
      captureGeometry: { x: startX, y: startY, w: window.innerWidth || 0, h: window.innerHeight || 0 }
    });
    images.push({ id: 'viewport', base64: viewportShot, label: '[image_id=viewport] Page screenshot with SoM markers' });
  }
  if (maxCrops <= 0 || typeof gv2FindMediaCandidates !== 'function') return images;

  let candidates = gv2BuildFindImageCatalog(question);
  if (!candidates.length) {
    console.log('[guidev2] find images: no media candidates above threshold');
    return images;
  }
  console.log('[guidev2] find images:', candidates.map(c => `${c.label.slice(0, 40)} (${c.score.toFixed(2)} ${c.why})`).join(' | '));

  try {
    const catalogForSelection = candidates.map(c => ({
      id: c.id,
      label: `[image_id=${c.id}] Image on page: ${c.selectorLabel || c.label}`,
      score: c.score,
      why: c.why,
      selector: c.selector
    }));
    let selected = candidates.slice(0, maxCrops);
    let selectionDiagnostics = {
      status: candidates.length > maxCrops ? 'heuristic_top_candidates' : 'skipped_small_catalog',
      selectedImageIds: selected.map(c => c.id),
      candidateImageIds: candidates.map(c => c.id)
    };
    if (candidates.length > maxCrops && typeof gv2SelectFindAnswerImages === 'function') {
      const selectedCatalog = await gv2SelectFindAnswerImages(question, catalogForSelection, {
        mode: 'find_answer_image_builder',
        url: window.location.href,
        maxIds: maxCrops,
        diagnostics: candidates.map(c => ({
          id: c.id,
          label: c.selectorLabel || c.label,
          score: Number.isFinite(c.score) ? Number(c.score.toFixed(3)) : null,
          why: c.why,
          selector: c.selector
        }))
      });
      const selectedIds = new Set((selectedCatalog || []).map(item => item.id).filter(Boolean));
      if (selectedIds.size) selected = candidates.filter(c => selectedIds.has(c.id)).slice(0, maxCrops);
      selectionDiagnostics = selectedCatalog?.selectionDiagnostics || selectionDiagnostics;
    }
    const captured = await gv2CaptureFindImageCatalogItems(selected, maxCrops);
    images.push(...captured);
    images.selectionDiagnostics = selectionDiagnostics;
  } finally {
    try { window.scrollTo(startX, startY); } catch (e) { /* best-effort */ }
  }
  return images;
}
if (typeof window !== 'undefined') window.gv2BuildFindAnswerImages = gv2BuildFindAnswerImages;

function gv2ParseImageSelection(raw, allowedIds) {
  const allowed = new Set((allowedIds || []).map(String));
  let obj = null;
  try {
    obj = typeof gv2ExtractJsonObject === 'function' ? gv2ExtractJsonObject(String(raw || '')) : JSON.parse(String(raw || ''));
  } catch (e) {
    obj = null;
  }
  const rawIds = Array.isArray(obj?.selected_image_ids)
    ? obj.selected_image_ids
    : (Array.isArray(obj?.image_ids) ? obj.image_ids : []);
  const ids = [];
  for (const id of rawIds) {
    const clean = String(id || '').trim();
    if (allowed.has(clean) && !ids.includes(clean)) ids.push(clean);
  }
  return {
    selectedIds: ids,
    reason: typeof obj?.reason === 'string' ? obj.reason.slice(0, 500) : ''
  };
}

/**
 * Cheap text-only model pass that chooses which page image ids should be attached to the real
 * vision answer call. It accepts either already-built image attachments or uncaptured catalog rows.
 * The viewport is always retained when present; selector failures fall back to the first max ids.
 *
 * @param {string} question
 * @param {Array<{id?: string, label?: string, base64?: string}>} images
 * @param {{mode?: string, url?: string, diagnostics?: Array, maxIds?: number}} opts
 * @returns {Promise<Array>}
 */
async function gv2SelectFindAnswerImages(question, images, opts = {}) {
  const allImages = Array.isArray(images) ? images.filter(img => img && img.id) : [];
  const viewport = allImages.filter(img => String(img.id || '') === 'viewport');
  const candidates = allImages.filter(img => String(img.id || '') !== 'viewport');
  const maxIds = Number.isFinite(opts.maxIds) ? Math.max(1, opts.maxIds) : GV2_FIND_MEDIA_CROPS;
  const fallbackSelection = () => {
    const kept = viewport.concat(candidates.slice(0, maxIds));
    kept.selectionDiagnostics = {
      status: candidates.length ? 'heuristic_fallback' : 'skipped_no_candidates',
      selectedImageIds: kept.map(img => img.id).filter(Boolean),
      candidateImageIds: candidates.map(img => img.id).filter(Boolean)
    };
    return kept;
  };
  if (candidates.length <= 1 || typeof safeSendMessage !== 'function') {
    allImages.selectionDiagnostics = {
      status: candidates.length ? 'skipped_single_candidate' : 'skipped_no_candidates',
      selectedImageIds: allImages.map(img => img.id).filter(Boolean)
    };
    return allImages;
  }

  const candidateRows = candidates.map((img, idx) => {
    const id = String(img.id || `image_${idx + 1}`);
    const label = String(img.label || '').replace(/\s+/g, ' ').slice(0, 500);
    return `- ${id}: ${label}`;
  }).join('\n');
  const systemPrompt = [
    'You are a cheap image-attachment selector.',
    'Choose which PAGE IMAGE ids are likely relevant to answering the user question based only on titles/labels.',
    'Do not select viewport; it is always attached separately.',
    'Return only JSON: {"selected_image_ids":["page_image_1"],"reason":"short reason"}.',
    `Select at most ${maxIds} ids. Prefer recall: include an image if it might contain the answer.`
  ].join('\n');
  const userPrompt = [
    `Question: ${String(question || '').trim()}`,
    '',
    'Candidate page images:',
    candidateRows
  ].join('\n');
  const allowedIds = candidates.map(img => String(img.id || '')).filter(Boolean);
  let selection = null;
  try {
    const response = await safeSendMessage({
      action: 'callImageSelectionLLM',
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      metadata: {
        mode: 'find_image_selector',
        parentMode: opts.mode || '',
        url: opts.url || window.location.href,
        candidateImageIds: allowedIds,
        findImageDiagnostics: Array.isArray(opts.diagnostics) ? opts.diagnostics : []
      }
    });
    if (response?.error) throw new Error(response.error);
    selection = gv2ParseImageSelection(response?.content || '', allowedIds);
  } catch (e) {
    const kept = fallbackSelection();
    kept.selectionDiagnostics = {
      status: 'fail_open',
      error: e?.message || String(e),
      selectedImageIds: kept.map(img => img.id).filter(Boolean),
      candidateImageIds: candidates.map(img => img.id).filter(Boolean)
    };
    return kept;
  }

  if (!selection?.selectedIds?.length) {
    const kept = fallbackSelection();
    kept.selectionDiagnostics = {
      status: 'empty_fail_open',
      reason: selection?.reason || '',
      selectedImageIds: kept.map(img => img.id).filter(Boolean),
      candidateImageIds: candidates.map(img => img.id).filter(Boolean)
    };
    return kept;
  }

  const keep = new Set([...viewport.map(img => img.id), ...selection.selectedIds.slice(0, maxIds)]);
  const filtered = allImages.filter(img => keep.has(img.id));
  filtered.selectionDiagnostics = {
    status: 'selected',
    reason: selection.reason || '',
    selectedImageIds: filtered.map(img => img.id).filter(Boolean),
    candidateImageIds: candidates.map(img => img.id).filter(Boolean),
    droppedImageIds: candidates.map(img => img.id).filter(id => !keep.has(id))
  };
  return filtered;
}
if (typeof window !== 'undefined') {
  window.gv2ParseImageSelection = gv2ParseImageSelection;
  window.gv2SelectFindAnswerImages = gv2SelectFindAnswerImages;
}

/**
 * The evidence strip for a Find answer in Visual mode: the annotated page evidence, and only that.
 * Both call sites (Guide's find action and the Ask route) use this so the two behave identically.
 *
 * Cited text spans are deliberately NOT illustrated. They are already highlighted on the live page
 * and their [N] citation scrolls the page to them, so a crop of that highlight showed the reader
 * nothing the page did not — while costing a scroll and a rate-limited captureVisibleTab each.
 * gv2CaptureFindEvidenceShots is left in place, unused by this path, as the way back.
 *
 * Numbering still runs on from the answer's citations (via gv2FindEvidenceTargets, which reads the
 * numbers applyHighlightsFromCitations assigned), so an [ev] marker never collides with an [N] one.
 *
 * @param {boolean} hasHighlights - did the answer highlight anything on the page
 * @param {string} question - the question, for the visual pass
 * @returns {Promise<Array<{shot: string, note: string, index: number}>>}
 */
/**
 * Keep only the evidence the answer actually cites.
 *
 * Pure, and the rule is one-directional both ways: the panel already drops an [ev:key] marker whose
 * evidence never made it past capture, and this drops evidence the answer never referred to. Without
 * it the page ends up marked in places the reader has no way to reach — a box and a label sitting on
 * a sentence with no number pointing at it, which reads as the answer having claimed something it
 * did not.
 *
 * An answer with no [ev:] markers at all cites nothing, so nothing is shown.
 *
 * @param {Array<object>} items - captured evidence, each with a `key`
 * @param {string} answerText - the answer with its markers intact
 * @returns {Array<object>}
 */
function gv2FilterCitedEvidence(items, answerText) {
  const list = Array.isArray(items) ? items : [];
  const cited = new Set();
  String(answerText || '').replace(/\[ev:\s*([^\]]+)\]/gi, (m, key) => {
    cited.add(String(key).trim().toLowerCase());
    return m;
  });
  if (!cited.size) return [];
  return list.filter(item => item?.key && cited.has(String(item.key).trim().toLowerCase()));
}
if (typeof window !== 'undefined') window.gv2FilterCitedEvidence = gv2FilterCitedEvidence;

/**
 * @param {string|null} answerText - the answer these items belong to. When given, evidence the
 *   answer does not cite is dropped before anything is drawn on the page.
 */
async function gv2BuildFindEvidence(hasHighlights, question, modelEvidence = null, answerText = null) {
  const targets = hasHighlights && typeof gv2FindEvidenceTargets === 'function' ? gv2FindEvidenceTargets() : [];
  const nextNumber = targets.reduce((max, t) => Math.max(max, Number(t.number) || 0), 0) + 1;
  // The answer call now returns its own evidence (FIND_ANSWER_VISUAL), so there is nothing left to
  // ask a second model. gv2RunFindVisualEvidence stays as the fallback for callers that have no
  // model evidence — e.g. a reply whose JSON envelope was malformed.
  const captured = Array.isArray(modelEvidence) && modelEvidence.length
    ? await gv2CaptureFindEvidenceItems(modelEvidence, nextNumber)
    : (modelEvidence ? [] : await gv2RunFindVisualEvidence(question, nextNumber));

  // Only what the answer points at. Done before the marks are drawn, so the page never shows
  // evidence the reader cannot reach from the text.
  const visual = answerText == null ? captured : gv2FilterCitedEvidence(captured, answerText);
  if (captured.length !== visual.length) {
    console.log(`[guidev2] find evidence: ${captured.length - visual.length} item(s) not cited by the answer, not shown`);
  }

  // Put the annotator's marks on the real page, not just in the evidence card: the participant is
  // being asked to check the answer, and a box drawn over a picture of the page proves less than
  // the same box drawn over the page. Runs the moment the agent finishes answering.
  gv2DrawEvidenceMarksOnPage(visual);

  return visual;
}
if (typeof window !== 'undefined') window.gv2BuildFindEvidence = gv2BuildFindEvidence;

async function gv2RunWatchVideo(step) {
  const currentUrl = String(window.location.href || '').trim();
  const videoUrl = String(step?.videoUrl || step?.video_url || step?.url || currentUrl || '').trim();
  const videoQuery = String(
    step?.videoQuery ||
    step?.video_query ||
    step?.findQuery ||
    step?.query ||
    window._guidev2?.question ||
    step?.instruction ||
    'Summarize the important information in this video.'
  ).trim();

  const response = await safeSendMessage({
    action: 'watchVideo',
    videoUrl,
    query: videoQuery,
    metadata: { mode: 'guide_watch_video', url: window.location.href, step: step?.step || null }
  });

  if (response?.error) {
    console.warn('[guidev2] watch_video: error', response.error);
    return { answer: '', error: response.error, videoUrl, videoQuery };
  }

  return {
    answer: response?.content?.trim() || '',
    error: null,
    videoUrl,
    videoQuery
  };
}
if (typeof window !== 'undefined') window.gv2RunWatchVideo = gv2RunWatchVideo;

async function gv2RunVisualFallbackHighlight(findQuery) {
  const question = String(findQuery || window._guidev2?.question || '').trim();

  // 1. Show SoM markers
  const pageIndex = createPageIndex(5000, false);
  if (typeof showSomIfEnabled === 'function') {
    await showSomIfEnabled(pageIndex);
  }
  await new Promise(r => setTimeout(r, 200));

  // 2. Capture screenshot
  let shot = null;
  try {
    if (typeof captureScreenshot === 'function') {
      shot = await captureScreenshot();
    }
  } catch (e) {
    console.warn('[guidev2] fallback visual capture failed:', e);
  }

  // 3. Cleanup SoM
  if (typeof cleanupSom === 'function') {
    cleanupSom();
  }

  if (!shot) {
    return null;
  }

  // 4. Call Visual LLM
  const systemPrompt = `You are a visual highlight assistant. The text-based reader has failed to find the answer on the page. Use the screenshot (which has numbered on-page tags) to find the answer.
Return ONLY JSON containing the following keys:
- "index": the SoM index number containing the answer (or null if none fits)
- "rect": a normalized bounding box {"x", "y", "w", "h"} as fractions (0..1) of the page screenshot for the answer region (use only if no tag fits)
- "reason": a short explanation of the answer (will be used as the image caption)

Example response:
{"index": 12, "rect": null, "reason": "The chart shows the operating hours."}`;

  const userPrompt = `USER GOAL/QUESTION: ${question}

Find the visual answer on this page screenshot and return the JSON object.`;

  const msg = {
    action: 'callLLMWithImages',
    systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    images: [{ base64: shot, label: 'Page screenshot with SoM markers for visual search' }],
    metadata: { mode: 'guide_visual_fallback', url: window.location.href }
  };

  try {
    const response = await safeSendMessage(msg);
    const content = response?.content?.trim() || '';
    if (!content) return null;

    const cleanJson = content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanJson);
    return {
      index: parsed.index != null ? Number(parsed.index) : null,
      rect: parsed.rect || null,
      reason: parsed.reason || '',
      systemPrompt,
      userPrompt,
      rawResponse: content,
      shot
    };
  } catch (e) {
    console.warn('[guidev2] visual fallback LLM call failed:', e);
    return null;
  }
}
if (typeof window !== 'undefined') window.gv2RunVisualFallbackHighlight = gv2RunVisualFallbackHighlight;


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
  _gv2SetWorkingStatus('Checking result…');
  // Reaching here means the edit did NOT navigate — this page is still running. Disarm the resume
  // armed for the step so a later, unrelated page load cannot wake the agent up.
  try { if (window._guidev2) await _gv2SetState(false); } catch (e) { /* non-fatal */ }
  try { await gv2RecaptureAfterAction(_gv2CompletedStepNumber()); } catch (e) { /* non-fatal */ }

  console.log(`[guidev2] ${label} done, generating next step...`);
  if (_gv2IsStopped()) return { success: false, progressed: false, error: 'Guide stopped' };
  if (_guidev2Resuming) return;
  _guidev2Resuming = true;
  try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}
  try {
    const result = await gv2GenerateNextStep();
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
/**
 * Does this type step have to SUBMIT the field, not just fill it?
 *
 * Filling a search box changes nothing the model can see: the next step is generated from the same
 * page, so it proposes the same "type X and press Enter" again, and again, until the loop guard
 * pauses the run. That is the whole "it keeps repeating the same step" failure.
 *
 * The contract's "submit" flag is authoritative when the model sets it. It usually does not — it
 * just writes the intent into the instruction ("...and press Enter") — so that phrasing counts too.
 *
 * @param {object} step - the live step
 * @returns {boolean} true when Enter should be pressed after the text goes in
 */
function _gv2ShouldSubmitAfterType(step) {
  if (!step) return false;
  if (step.submit === true) return true;
  if (step.submit === false) return false;
  const text = `${step.instruction || ''} ${step.thought || ''}`;
  return /\b(?:press|pressing|hit|hitting|then\s+press)\s+(?:the\s+)?(?:enter|return)\b|\b(?:enter|return)\s+key\b/i.test(text);
}

/**
 * Press Enter in a field the way the browser would.
 *
 * A synthetic keydown does NOT trigger the browser's implicit form submission — that default action
 * is reserved for real user input — so a page that relies on it (a plain <form> search box) would
 * see the key and do nothing. Dispatch the key sequence first: a page with its own Enter handler
 * calls preventDefault, and that is our signal to stop, exactly as the browser would. Only when the
 * default survives do we perform the submission the browser would have performed.
 *
 * @param {Element} input - the field that was just filled
 * @returns {boolean} true when Enter was handled or a form was submitted
 */
function _gv2PressEnter(input) {
  if (!input || typeof input.dispatchEvent !== 'function') return false;
  try { input.focus({ preventScroll: true }); } catch (e) {}

  const makeKeyEvent = (type) => {
    const ev = new KeyboardEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      key: 'Enter', code: 'Enter', location: 0
    });
    // keyCode/which are not init-dict properties, but jQuery-era handlers still read them.
    try {
      Object.defineProperty(ev, 'keyCode', { get: () => 13 });
      Object.defineProperty(ev, 'which', { get: () => 13 });
    } catch (e) {}
    return ev;
  };

  const defaultAllowed = input.dispatchEvent(makeKeyEvent('keydown'));
  input.dispatchEvent(makeKeyEvent('keypress'));
  input.dispatchEvent(makeKeyEvent('keyup'));
  if (!defaultAllowed) return true; // the page handled Enter itself

  const form = (typeof input.closest === 'function') ? input.closest('form') : null;
  if (!form) {
    // No form — the site's own submit control is the next best thing (icon buttons included).
    const button = _gv2NearbySubmitButton(input);
    if (button) { _gv2DispatchClick(button); return true; }
    return false;
  }
  const submitter = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
  if (typeof form.requestSubmit === 'function') {
    // requestSubmit runs validation and fires submit handlers; form.submit() skips both.
    form.requestSubmit(submitter || undefined);
    return true;
  }
  if (submitter) { _gv2DispatchClick(submitter); return true; }
  try { form.submit(); return true; } catch (e) { return false; }
}

/**
 * The submit control belonging to a formless search box — Walmart, and most SPA search bars, render
 * a magnifier <button> next to the input with no <form> around either.
 *
 * @param {Element} input - the field that was filled
 * @returns {Element|null}
 */
function _gv2NearbySubmitButton(input) {
  const scope = (typeof input.closest === 'function')
    ? (input.closest('[role="search"], search, [class*="search"], [data-testid*="search"]') || input.parentElement)
    : null;
  if (!scope || typeof scope.querySelectorAll !== 'function') return null;
  const named = Array.from(scope.querySelectorAll('button, [role="button"], input[type="submit"]'))
    .filter(el => {
      if (el === input) return false;
      const name = `${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''} ${el.textContent || ''}`;
      return /search|submit|go\b/i.test(name) || el.type === 'submit';
    });
  // Prefer one we can see; a page often carries a second, hidden search form (mobile layout, a
  // collapsed header). Fall back to the best-named candidate when visibility cannot be judged.
  const visible = named.find(el => {
    try { return typeof isHiddenElement !== 'function' || !isHiddenElement(el); } catch (e) { return true; }
  });
  return visible || named[0] || null;
}

async function _gv2AutoType(step) {
  if (_gv2IsStopped()) return { success: false, progressed: false, error: 'Guide stopped' };
  _gv2SetWorkingStatus(_gv2ActionStatus('type', step));

  // Slice 5: canonical ACT/type carries text in `value`; legacy type used `typeText`.
  const typeText = (step.typeText != null) ? step.typeText : step.value;
  let submitted = false;
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
      if (_gv2ShouldSubmitAfterType(step)) {
        submitted = _gv2PressEnter(input);
        console.log('[guidev2] Auto-type submitted with Enter:', submitted);
      }
    }
  }

  if (submitted) {
    // The submission may be a full page load (this frame dies and the new page resumes — its
    // pendingResume was armed before the edit), or an in-page result render. Let it happen before
    // reading the page, or the next step would be generated from the pre-submit screenshot.
    _gv2SetWorkingStatus('Checking result…');
    await new Promise(r => setTimeout(r, 600));
    if (_guidev2PageHiding) return { success: false, progressed: false, navigated: true };
    if (_gv2IsStopped()) return { success: false, progressed: false, error: 'Guide stopped' };
    try { await gv2WaitForDomStable(6000, 500); } catch (e) { /* best-effort */ }
    if (_guidev2PageHiding) return { success: false, progressed: false, navigated: true };
    if (_gv2IsStopped()) return { success: false, progressed: false, error: 'Guide stopped' };
  }

  return _gv2ContinueAfterFormEdit('Auto-type');
}

async function _gv2AutoClearText(step) {
  if (_gv2IsStopped()) return { success: false, progressed: false, error: 'Guide stopped' };
  _gv2SetWorkingStatus(_gv2ActionStatus('clear_text', step));
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

function _gv2ClientPointForElement(el) {
  if (!el || !el.getBoundingClientRect) return null;
  const rect = el.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2)
  };
}

function _gv2ClientPointForNormRect(rect) {
  const norm = (typeof gv2NormalizeRect === 'function') ? gv2NormalizeRect(rect) : rect;
  if (!norm) return null;
  return {
    x: Math.round((norm.x + norm.w / 2) * (window.innerWidth || 0)),
    y: Math.round((norm.y + norm.h / 2) * (window.innerHeight || 0))
  };
}

function _gv2ResolveDropTarget(dropTarget) {
  const out = {
    el: null,
    index: null,
    text: dropTarget && dropTarget.text ? String(dropTarget.text) : '',
    rect: dropTarget && dropTarget.rect ? ((typeof gv2NormalizeRect === 'function') ? gv2NormalizeRect(dropTarget.rect) : dropTarget.rect) : null,
    point: null
  };
  if (!dropTarget || typeof dropTarget !== 'object') return out;

  const rawIndex = Number(dropTarget.index);
  if (Number.isFinite(rawIndex) && rawIndex > 0) {
    out.index = Math.floor(rawIndex);
    out.el = window._pageguideIndex?.[out.index] || null;
  }

  if (!out.el && out.text && typeof gv2FindElementByText === 'function') {
    const idx = gv2FindElementByText(out.text);
    if (idx != null) {
      out.index = idx;
      out.el = window._pageguideIndex?.[idx] || null;
    }
  }

  out.point = out.el ? _gv2ClientPointForElement(out.el) : _gv2ClientPointForNormRect(out.rect);
  return out;
}

function _gv2DispatchDragDrop(sourceEl, dropTarget) {
  if (!sourceEl || !document.contains(sourceEl)) return false;
  const start = _gv2ClientPointForElement(sourceEl);
  const dest = dropTarget?.point || (dropTarget?.el ? _gv2ClientPointForElement(dropTarget.el) : _gv2ClientPointForNormRect(dropTarget?.rect));
  if (!start || !dest) return false;

  const targetEl = dropTarget?.el || document.elementFromPoint(dest.x, dest.y) || document.body;
  const makeMouse = (type, point, buttons = 0) => new MouseEvent(type, {
    bubbles: true, cancelable: true, view: window,
    clientX: point.x, clientY: point.y,
    screenX: point.x + (window.screenX || 0),
    screenY: point.y + (window.screenY || 0),
    button: buttons ? 0 : -1,
    buttons
  });
  const makePointer = (type, point, buttons = 0) => {
    const init = {
      bubbles: true, cancelable: true, view: window,
      clientX: point.x, clientY: point.y,
      screenX: point.x + (window.screenX || 0),
      screenY: point.y + (window.screenY || 0),
      button: buttons ? 0 : -1,
      buttons
    };
    if (typeof PointerEvent === 'function') {
      return new PointerEvent(type, { ...init, pointerType: 'mouse', isPrimary: true });
    }
    return new MouseEvent(type, init);
  };
  let dataTransfer = null;
  try { dataTransfer = new DataTransfer(); } catch (e) {}
  const makeDrag = (type, point) => {
    try {
      return new DragEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX: point.x, clientY: point.y,
        screenX: point.x + (window.screenX || 0),
        screenY: point.y + (window.screenY || 0),
        dataTransfer
      });
    } catch (e) {
      const ev = makeMouse(type, point, 1);
      try { Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer }); } catch (_) {}
      return ev;
    }
  };

  try { sourceEl.focus({ preventScroll: true }); } catch (e) {}
  sourceEl.dispatchEvent(makePointer('pointerover', start, 0));
  sourceEl.dispatchEvent(makeMouse('mouseover', start, 0));
  sourceEl.dispatchEvent(makePointer('pointermove', start, 0));
  sourceEl.dispatchEvent(makeMouse('mousemove', start, 0));
  sourceEl.dispatchEvent(makePointer('pointerdown', start, 1));
  sourceEl.dispatchEvent(makeMouse('mousedown', start, 1));
  sourceEl.dispatchEvent(makeDrag('dragstart', start));

  const mid = { x: Math.round((start.x + dest.x) / 2), y: Math.round((start.y + dest.y) / 2) };
  sourceEl.dispatchEvent(makePointer('pointermove', mid, 1));
  sourceEl.dispatchEvent(makeMouse('mousemove', mid, 1));
  targetEl.dispatchEvent(makeDrag('dragenter', dest));
  targetEl.dispatchEvent(makeDrag('dragover', dest));
  targetEl.dispatchEvent(makePointer('pointermove', dest, 1));
  targetEl.dispatchEvent(makeMouse('mousemove', dest, 1));
  targetEl.dispatchEvent(makeDrag('drop', dest));
  sourceEl.dispatchEvent(makeDrag('dragend', dest));
  targetEl.dispatchEvent(makePointer('pointerup', dest, 0));
  targetEl.dispatchEvent(makeMouse('mouseup', dest, 0));
  return true;
}

if (typeof window !== 'undefined') {
  window._gv2ResolveDropTarget = _gv2ResolveDropTarget;
  window._gv2DispatchDragDrop = _gv2DispatchDragDrop;
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

  // find already did its work (read + highlight) in gv2ProcessResponse — there is nothing to
  // click. Handled before the click-resolution path below because find's highlights carry
  // data-pageguide-styled, which that path would otherwise click as a fallback target.
  if (g?.active && cur && cur.action === 'find') {
    _gv2SetWorkingStatus('Preparing next step…');
    _gv2RemoveClickListeners();
    _guidev2WaitingForClick = false;
    return continueGuide();
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
    _gv2SetWorkingStatus('Checking result…');
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

  _gv2SetWorkingStatus(_gv2ActionStatus(cur?.action || 'click', cur));
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
  const _DRAGGABLE_SELECTORS =
    '[draggable="true"], [draggable], [data-rbd-draggable-id], [role="option"], [role="listitem"], [aria-grabbed]';

  function _resolveClickTarget(el) {
    if (!el || !document.contains(el)) return null;
    if (cur?.action === 'drag_drop') return el.closest(_DRAGGABLE_SELECTORS) || el;
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
    try {
      if (cur?.action === 'drag_drop') {
        const drop = cur.dropTarget || window._guidev2?.currentDropTarget || null;
        _gv2SetWorkingStatus(_gv2ActionStatus('drag_drop', cur));
        if (!_gv2DispatchDragDrop(toClick, drop)) console.warn('[guidev2] Auto-drag failed: missing source or drop target');
      } else {
        _gv2SetWorkingStatus(_gv2ActionStatus('click', cur));
        _gv2DispatchClick(toClick);
      }
    } catch (e) { console.warn(cur?.action === 'drag_drop' ? '[guidev2] Auto-drag failed:' : '[guidev2] Auto-click failed:', e); }
  } else {
    console.warn(cur?.action === 'drag_drop' ? '[guidev2] No draggable element found — continuing without drag' : '[guidev2] No clickable element found — continuing without click');
  }

  // Use the same post-click flow as a real user click: detects full-page nav,
  // SPA nav, or same-page DOM settle, then generates the next step.
  _gv2SetWorkingStatus('Checking result…');
  const startUrl = window.location.href;
  const outcome = await _gv2WaitForNavOrSettle(startUrl);
  if (_gv2IsStopped()) return { success: false, progressed: false, error: 'Guide stopped' };
  if (outcome) return outcome;
  return continueGuide();
};

// ===== PAUSE / RESUME GUIDE =====

async function gv2PauseGuide(reason = '') {
  // Hydrated, exactly as resume is. Every navigation the agent makes lands in a FRESH document
  // where window._guidev2 does not exist yet — it is rebuilt only when the service worker drives
  // the next step. Reading the live object alone meant pause answered "Guide not active" during
  // precisely the window in which a user reaches for it: the agent has just navigated somewhere
  // unexpected and they want it to stop before it acts again.
  //
  // Persisting paused:true here is also what stops the pending resume: _gv2CheckSessionStorageFallback
  // continues a saved run only when it is not paused, so a pause taken mid-navigation still holds
  // once the new page boots.
  const g = (typeof _gv2HydrateResumeState === 'function')
    ? await _gv2HydrateResumeState()
    : window._guidev2;
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

/** The run this tab was executing, from wherever a copy of it survived. */
async function _gv2LoadResumableState() {
  // Session storage first: it is written on every step and survives an SW restart. No age limit —
  // this path only runs for an explicit Resume/Next/Pause, which is the user naming the run.
  const saved = await gv2LoadFallback({ maxAge: Infinity });
  if (saved?.active) return saved;

  // Then the service worker's per-tab copy. It is the only survivor when session storage was
  // unreadable — content scripts get no access to it until the worker grants it — and it is worth
  // asking for regardless: it is the same state, written by the same steps.
  try {
    const res = await safeSendMessage({ action: 'guidanceV2_getState' });
    if (res?.state?.active) return res.state;
  } catch (e) { /* the worker may be restarting; the caller reports "not active" */ }
  return null;
}

if (typeof window !== 'undefined') {
  window._gv2LoadResumableState = _gv2LoadResumableState;
  window.gv2LoadFallback = gv2LoadFallback;
}

async function _gv2HydrateResumeState() {
  const live = window._guidev2;
  if (live && live.active) return live;
  const saved = await _gv2LoadResumableState();
  if (!saved?.active) return null;
  window._guidev2 = {
    active: true,
    question: saved.question,
    previousSteps: saved.previousSteps || [],
    sessionId: saved.sessionId,
    captureEnabled: saved.captureEnabled,
    tutorialRef: saved.tutorialRef || null,
    tutorialReason: saved.tutorialReason || null,
    personalizationContext: saved.personalizationContext || '',
    currentPlanStep: saved.currentPlanStep || 1,
    autoMode: saved.autoMode === true,
    autonomyLevel: _gv2NormalizeAutonomyLevel(saved.autonomyLevel, saved.autoMode === true),
    paused: !!saved.paused,
    lowConfidenceCount: saved.lowConfidenceCount || 0,
    loopStepCount: saved.loopStepCount || 0,
    predictedGoalState: saved.predictedGoalState || null,
    guidePlan: Array.isArray(saved.guidePlan) ? saved.guidePlan : [],
    guideTitle: saved.guideTitle || '',
    _mechElementTexts: Array.isArray(saved.mechElementTexts) ? saved.mechElementTexts : [],
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
  _gv2ResetPauseGuards(g);
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

async function gv2StopGuideWithRecap() {
  const g = await _gv2HydrateResumeState();
  if (!g || !g.active) {
    _gv2StopInternal();
    _gv2HidePanelTyping();
    return { success: true, stopped: true, recap: null };
  }
  let recap = null;
  // The user stopped the guide before it finished → deterministically a failed run. When the
  // optional summary agent is enabled, the recap diagnoses where/why it broke down.
  try { if (await _gv2IsEndSummaryOn()) recap = await _gv2BuildRecap(g, 'failed'); } catch (e) { recap = null; }
  _gv2UpdatePersonalizedProfile(g, 'failed');
  _gv2StopInternal();
  _gv2HidePanelTyping();
  return { success: true, stopped: true, recap };
}
if (typeof window !== 'undefined') window.gv2StopGuideWithRecap = gv2StopGuideWithRecap;

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

function _gv2BuildSteerQuestion(originalGoal, payload, redoStep, includeContext) {
  const goal = String(originalGoal || '').trim();
  if (!includeContext) return goal;
  const observed = payload?.parentObservedStepCount != null ? payload.parentObservedStepCount : 'unknown';
  const redoInstruction = String(payload?.redoInstruction || '').trim();
  const newGoal = String(payload?.newGoal || '').trim();
  const lines = [
    goal,
    '',
    '=== STEER CONTEXT ===',
    `Original journey had ${observed} observed steps.`,
    redoInstruction ? `Step ${redoStep}: ${redoInstruction}` : `Step ${redoStep}: redo this step from the restored page state.`
  ];
  if (newGoal) lines.push(`User redirection: ${newGoal}`);
  return lines.join('\n');
}
if (typeof window !== 'undefined') {
  window._gv2BuildSteerQuestion = _gv2BuildSteerQuestion;
  window._gv2CoerceAnnotatorResult = _gv2CoerceAnnotatorResult;
  window._gv2PreprocessGridCoordinates = _gv2PreprocessGridCoordinates;
  window._gv2UnwrapAnnotatorItem = _gv2UnwrapAnnotatorItem;
  window._gv2ActionExpectsNavigation = _gv2ActionExpectsNavigation;
  window._gv2ShouldSubmitAfterType = _gv2ShouldSubmitAfterType;
  window._gv2PressEnter = _gv2PressEnter;
}

// ===== ROUTER INTEGRATION =====

window.handleStepByStepGuide = function (question, continueFromStep = false) {
  // continueFromStep=true re-enters the step-cap guard directly (see the "blocks step 16"
  // unit test), without re-running the initial tutorial-match/setup path.
  if (continueFromStep) {
    if (((window._guidev2?.previousSteps || []).length + 1) > 15) {
      const configuredMax = GV2_MAX_STEPS;
      GV2_MAX_STEPS = 15;
      const result = _gv2StopForMaxSteps(window._guidev2);
      GV2_MAX_STEPS = configuredMax;
      return result;
    }
    const capResult = _gv2CheckStepCap(window._guidev2);
    if (capResult) return capResult;
    if (_gv2IsStopped()) _guidev2Stopped = false;
    return gv2GenerateNextStep();
  }
  return _handleStepByStepGuideV2(question);
};

console.log('[guidev2] loaded — SW-based navigation, MutationObserver stability');
