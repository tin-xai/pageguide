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
  "nextStepHint": "What will happen after this step",
  "confidence": 0.0,
  "planStep": N,
  "risk": "low" | "high",
  "riskReason": "short reason for the risk level"
}

confidence: 0.0–1.0 — how sure you are that THIS step and the chosen element are correct
  for the user's goal on the current page. Be honest: use a low value (< 0.5) when the
  target is ambiguous, not clearly visible, or you are guessing.
planStep: the number of the PLAN item (from the === PLAN === section, if provided) that
  this action works toward. Omit or repeat the same number across multiple concrete steps.
risk: "low" if this action is reversible, routine and easy (e.g. opening a menu, toggling
  a setting that can be undone, navigating) — safe for the agent to perform automatically.
  "high" if it is sensitive or hard to undo: signing in, payments/purchases, deleting or
  removing data, sending/posting/publishing, or anything entering a password. High-risk
  steps should be left for the user to perform.

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

ADVANCED ACTIONS (use only when click/type/done are not enough):
- "act": generalized interaction. Set "operation" to one of:
    "select" (choose a dropdown <option>, put the visible label in "value"),
    "check" (tick a checkbox/radio), "clear" (empty a field), "hover" (reveal a hover menu).
    Provide "element" like a click. Example:
    {"action":"act","operation":"select","element":{"index":4,"text":"Country"},"value":"Canada",...}
- "extract": read data the user asked for from the CURRENT page. Provide "schema" mapping
    each field name to a short description. The agent reads the values and continues.
    Example: {"action":"extract","schema":{"price":"the item's listed price","eta":"delivery date"},...}
- "wait_until": the page is loading/updating async. Provide a "condition" describing what to
    wait for and optional "timeoutMs". The agent waits for the page to settle, then continues.
    Example: {"action":"wait_until","condition":"search results finish loading","timeoutMs":8000,...}
- "scroll_to_find": the target is off-screen. Provide "target" (the text to locate). The agent
    scrolls until it appears, then continues. Example: {"action":"scroll_to_find","target":"Delete account",...}
- "ask_human": you genuinely need a human decision (ambiguous choice, personal/sensitive input).
    Provide "reason" and a "choices" array of short options. Example:
    {"action":"ask_human","reason":"Which shipping speed do you want?","choices":["Standard","Express"],...}
- "done": you may include a final "answer" and short "evidence" (especially after extract).

Do NOT emit verify/recover/checkpoint/navigate — verification, recovery and step capture
happen automatically between steps.

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

// ===== PLAN GENERATION (Slice 2) =====

/**
 * Generate a short high-level plan (3–6 steps) and title for the user's goal.
 * Best-effort: returns { title, plan } and never blocks guidance.
 */
async function gv2GeneratePlan(goal, tutorialRef) {
  try {
    let seed = '';
    if (tutorialRef && tutorialRef.content && Array.isArray(tutorialRef.content.steps)) {
      seed = `\n\nA verified reference flow exists for a similar task on ${tutorialRef.website}:\n`
        + tutorialRef.content.steps.join('\n')
        + `\nUse it to inform the plan, adapting to the user's actual goal.`;
    }
    const response = await safeSendMessage({
      action: 'callRouterLLM',
      systemPrompt: `You are a planning assistant for an interactive web guide. Given the user's goal, produce a short title and a SHORT high-level plan of 3 to 6 steps describing the sequence of actions to accomplish it on a website. The title should be 3 to 6 words. Each step is a brief imperative phrase (e.g. "Open the Settings menu", "Turn off the toggle"). Do not include signing in unless clearly required. Return JSON only: {"title":"short title","plan":["step 1","step 2",...]}`,
      messages: [{ role: 'user', content: `USER GOAL: "${goal}"${seed}` }]
    });

    if (!response || !response.content) return { title: '', plan: [] };
    const parsed = (typeof gv2ExtractJsonObject === 'function')
      ? gv2ExtractJsonObject(response.content)
      : null;
    const arr = parsed && Array.isArray(parsed.plan) ? parsed.plan : [];
    const plan = arr
      .filter(s => s != null && String(s).trim())
      .slice(0, 8)
      .map((g, i) => ({ n: i + 1, goal: String(g).trim() }));
    return {
      title: parsed?.title ? String(parsed.title).trim().slice(0, 80) : '',
      plan
    };
  } catch (e) {
    console.warn('[guidev2] plan generation failed:', e.message);
    return { title: '', plan: [] };
  }
}

// ===== CONSTRAINT-AWARE LOOP (follow-up) =====

/**
 * Split the user's request into a clean goal + explicit constraints (limits/preferences the
 * result must satisfy, e.g. "under $50", "nonstop", "in dark mode"). Cheap router LLM,
 * best-effort. Returns { goal, constraints:[] } via the pure gv2NormalizeConstraints.
 */
async function gv2ExtractGoalAndConstraints(question) {
  try {
    const response = await safeSendMessage({
      action: 'callRouterLLM',
      systemPrompt: `You analyze a user's web task request. Separate the core GOAL from any CONSTRAINTS — limits, preferences, or conditions the final result must satisfy (budget caps, "nonstop", "without signing up", quantities, dates, etc.). If there are no explicit constraints, return an empty list. Return JSON only: {"goal":"...","constraints":["...","..."]}`,
      messages: [{ role: 'user', content: `USER REQUEST: "${question}"` }]
    });
    const parsed = (typeof gv2ExtractJsonObject === 'function')
      ? gv2ExtractJsonObject(response && response.content) : null;
    return (typeof gv2NormalizeConstraints === 'function')
      ? gv2NormalizeConstraints(parsed)
      : { goal: question, constraints: [] };
  } catch (e) {
    console.warn('[guidev2] constraint extraction failed:', e.message);
    return { goal: question, constraints: [] };
  }
}

/**
 * After an action succeeds, check the resulting page still satisfies the user's constraints.
 * Cheap router LLM. Fails OPEN ({ok:true}) so it never blocks guidance on error or when
 * there are no constraints.
 *
 * @returns {Promise<{ok:boolean, violated:string[], reason:string}>}
 */
async function gv2VerifyConstraints(pageIndex, constraints) {
  if (!Array.isArray(constraints) || !constraints.length) return { ok: true, violated: [], reason: '' };
  try {
    const response = await safeSendMessage({
      action: 'callRouterLLM',
      systemPrompt: `You check whether the current web page state still satisfies the user's constraints. Return JSON only: {"ok":true|false,"violated":["..."],"reason":"brief"}. Only mark ok:false when the page shows a CLEAR violation (e.g. a price above the cap, a selection that contradicts a stated preference). If you cannot tell, answer ok:true.`,
      messages: [{
        role: 'user',
        content: `CONSTRAINTS:\n${constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nCURRENT URL: ${window.location.href}\n\n=== PAGE NOW ===\n${pageIndex && pageIndex.indexText ? pageIndex.indexText : '(none)'}`
      }]
    });
    const parsed = (typeof gv2ExtractJsonObject === 'function')
      ? gv2ExtractJsonObject(response && response.content) : null;
    if (!parsed || typeof parsed.ok === 'undefined') return { ok: true, violated: [], reason: '' };
    return {
      ok: parsed.ok !== false,
      violated: Array.isArray(parsed.violated) ? parsed.violated : [],
      reason: parsed.reason || ''
    };
  } catch (e) {
    console.warn('[guidev2] constraint verify failed (failing open):', e.message);
    return { ok: true, violated: [], reason: '' };
  }
}

/**
 * Replan: regenerate the high-level plan when a step can't be completed or a constraint is
 * violated, taking into account what's already been done and why. Updates g.plan and
 * re-emits it to the panel. Best-effort; runs at most as the recover path dictates.
 */
async function gv2Replan(g, reason) {
  if (!g || !g.active) return;
  try {
    const seed = `\n\nSo far these steps were completed:\n${(g.previousSteps || []).join('\n') || '(none)'}\n` +
      (g.constraints && g.constraints.length ? `\nConstraints to respect:\n${g.constraints.join('\n')}\n` : '') +
      (reason ? `\nReplan because: ${reason}\n` : '') +
      `\nProduce a fresh plan for the REMAINING work toward the goal.`;
    const generated = await gv2GeneratePlan(g.question + seed, g.tutorialRef || null);
    const plan = Array.isArray(generated) ? generated : (generated?.plan || []);
    if (plan.length) {
      g.plan = plan;
      g.currentPlanStep = 1;
      g._replanned = (g._replanned || 0) + 1;
      const title = Array.isArray(generated) ? (g.planTitle || '') : (generated?.title || g.planTitle || '');
      try { chrome.runtime.sendMessage({ action: 'guidePlan', title, plan, total: plan.length }); } catch (e) {}
      console.log('[guidev2] Replanned:', reason);
    }
  } catch (e) {
    console.warn('[guidev2] replan failed:', e.message);
  }
}

// ===== STEP VERIFICATION (Slice 3) =====

/**
 * Check whether the previously-performed step achieved its intended outcome, using the
 * current page state. Uses the cheap router LLM. Fails OPEN — any error returns
 * 'success' so verification never blocks guidance.
 *
 * @param {object} prev - { instruction, nextStepHint } of the step just performed
 * @param {object} pageIndex - fresh index of the resulting page (after-state)
 * @returns {Promise<{status:'success'|'failed'|'blocked', reason:string}>}
 */
async function gv2VerifyStep(prev, pageIndex) {
  try {
    const response = await safeSendMessage({
      action: 'callRouterLLM',
      systemPrompt: `You verify whether a step in an interactive web guide succeeded, given the step performed and the resulting page. Return JSON only: {"status":"success"|"failed"|"blocked","reason":"brief reason"}.
- "success": the page now reflects the step's intended outcome (or plausibly progressed toward it).
- "failed": the page did not change as expected (e.g. the menu didn't open, nothing happened).
- "blocked": further progress needs the user (a login wall, captcha, permission prompt, or an error message is shown).
Be lenient — if the outcome was plausibly achieved, answer success.`,
      messages: [{
        role: 'user',
        content: `STEP PERFORMED: ${prev.instruction}
EXPECTED RESULT: ${prev.nextStepHint || '(progress toward the goal)'}
USER GOAL: ${window._guidev2 ? window._guidev2.question : ''}

CURRENT URL: ${window.location.href}

=== PAGE NOW (interactive elements) ===
${pageIndex && pageIndex.indexText ? pageIndex.indexText : '(none)'}`
      }]
    });

    const parsed = (typeof gv2ExtractJsonObject === 'function')
      ? gv2ExtractJsonObject(response && response.content) : null;
    if (!parsed || !parsed.status) return { status: 'success', reason: '' };
    const status = ['success', 'failed', 'blocked'].includes(parsed.status) ? parsed.status : 'success';
    return { status, reason: parsed.reason || '' };
  } catch (e) {
    console.warn('[guidev2] verify failed (failing open):', e.message);
    return { status: 'success', reason: '' };
  }
}

/**
 * Verify the pending (just-performed) step and decide what to do next:
 * returns 'proceed' | 'retry' | 'pause'. Records the verdict, updates the timeline,
 * and (on pause) notifies the panel to show [Retry] [Continue] [Stop].
 */
async function _gv2VerifyPending(pageIndex) {
  const g = window._guidev2;
  const pv = g._pendingVerify;
  g._pendingVerify = null;
  if (!pv) return 'proceed';

  _gv2ShowIndicator('Checking the last step…');
  const verdict = await gv2VerifyStep(pv, pageIndex);

  // Constraint-aware loop: if the action itself succeeded, also confirm the result still
  // satisfies the user's constraints. A violation downgrades the verdict to a failure so the
  // existing recover/replan path handles it.
  if (verdict.status === 'success' && g.constraints && g.constraints.length) {
    _gv2ShowIndicator('Checking your constraints…');
    const c = await gv2VerifyConstraints(pageIndex, g.constraints);
    if (!c.ok) {
      verdict.status = 'failed';
      verdict.reason = `Constraint not satisfied: ${(c.violated && c.violated.join('; ')) || c.reason || 'see constraints'}`;
      g._constraintViolation = true;
    }
  }

  // Slice 5: record this step's loop signature now that the verify verdict is known.
  _gv2PushSignature({ verb: pv.verb, elementText: pv.elementText, verifyStatus: verdict.status });

  // Persist verdict onto the step's rewind record and update its timeline dot.
  if (g.captureEnabled && typeof rewindPatchRecord === 'function') {
    try { rewindPatchRecord(g.sessionId, pv.step, { verification: verdict }); } catch (e) {}
  }
  try {
    chrome.runtime.sendMessage({
      action: 'guideStepVerify', sessionId: g.sessionId, step: pv.step,
      status: verdict.status, reason: verdict.reason
    });
  } catch (e) {}

  g.retryCounts = g.retryCounts || {};
  const key = pv.planStep || pv.step;
  const count = g.retryCounts[key] || 0;
  const decision = (typeof gv2RetryDecision === 'function')
    ? gv2RetryDecision(verdict.status, count, pv.highRisk) : 'proceed';

  if (decision === 'retry') {
    g.retryCounts[key] = count + 1;
    g._retryNote = `The previous step ("${pv.instruction}") did not appear to work: ${verdict.reason || 'no visible change'}. Try a DIFFERENT way to achieve the same result.`;
    console.log('[guidev2] Verification failed — auto-retrying step', pv.step);
    return 'retry';
  }
  if (decision === 'pause') {
    g._lastFailReason = verdict.reason || '';
    gv2HideAutoOverlay(); // handing control to the user

    // Slice 5/6: count how many times this step has failed (incl. manual retries). A
    // genuine loop — repeated failures here or gv2DetectLoop tripping — escalates from the
    // plain [Retry][Continue] prompt to a stuck prompt that proactively offers steering.
    g.failCounts = g.failCounts || {};
    g.failCounts[key] = (g.failCounts[key] || 0) + 1;
    const stuck = g.failCounts[key] >= 2 ||
      (typeof gv2DetectLoop === 'function' && gv2DetectLoop(g));

    // Recover by replanning ONCE before handing control to the user — especially useful
    // when a constraint was violated and the current plan can't satisfy it.
    if (stuck && !(g._replanned > 0) && (g.plan && g.plan.length)) {
      const why = g._constraintViolation ? `constraint issue: ${verdict.reason}` : (verdict.reason || 'repeated failures');
      g._constraintViolation = false;
      g.failCounts[key] = 0;
      await gv2Replan(g, why);
      g._retryNote = `Previous approach didn't work (${why}). Following the updated plan, try a different way.`;
      return 'retry';
    }

    if (stuck && !g._stuckAsked) {
      g._stuckAsked = true;
      console.log('[guidev2] Step', pv.step, 'appears stuck — offering Stop/Steer/Keep trying');
      _gv2AskHuman(
        `I'm having trouble getting past this step (${verdict.reason || 'no visible change'}). How should I proceed?`,
        ['Stop', 'Let me steer', 'Keep trying'],
        'stuck'
      );
      return 'pause';
    }

    try {
      chrome.runtime.sendMessage({
        action: 'guideVerifyFail', step: pv.step, status: verdict.status, reason: verdict.reason || ''
      });
    } catch (e) {}
    console.log('[guidev2] Verification', verdict.status, '— pausing for user on step', pv.step);
    return 'pause';
  }

  // 'proceed': the step worked — clear any accumulated stuck/fail state for this step.
  if (g.failCounts) g.failCounts[key] = 0;
  g._stuckAsked = false;
  return 'proceed';
}

// ===== IN-PAGE STATE =====

window._guidev2 = { active: false, question: '', previousSteps: [], plan: [], planTitle: '', currentPlanStep: 1 };

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
        plan: s.plan,
        planTitle: s.planTitle,
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
    previousSteps: state.previousSteps || [],
    sessionId: state.sessionId,
    captureEnabled: state.captureEnabled,
    tutorialRef: state.tutorialRef || null,
    tutorialReason: state.tutorialReason || null,
    plan: state.plan || [],
    planTitle: state.planTitle || '',
    currentPlanStep: state.currentPlanStep || 1,
    autoMode: state.autoMode === true,
    // Follow-up: restore constraints/extracted/budget and any pending steer/retry note so
    // the loop and a steer URL-reload continue seamlessly on the new page.
    constraints: state.constraints || [],
    extracted: state.extracted || {},
    autoStepCount: state.autoStepCount || 0,
    stepSignatures: [],
    _retryNote: state.retryNote || null
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
    pendingResume,
    // Rewind (Slice 1): carry capture session across navigations.
    sessionId: s.sessionId,
    captureEnabled: s.captureEnabled,
    tutorialRef: s.tutorialRef,
    tutorialReason: s.tutorialReason,
    // Plan (Slice 2): carry the plan + progress pointer across navigations.
    plan: s.plan,
    planTitle: s.planTitle,
    currentPlanStep: s.currentPlanStep,
    // Mode: carry Manual/Auto across navigations.
    autoMode: s.autoMode,
    // Follow-up: constraints, extracted facts, auto-step budget counter, and a pending
    // steer/retry note must all survive a page load (esp. for steer's URL reload).
    constraints: s.constraints || [],
    extracted: s.extracted || {},
    autoStepCount: s.autoStepCount || 0,
    retryNote: s._retryNote || null
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

    // On-demand grounding: for steps the model itself rated uncertain, score how well the
    // screenshot supports the step (fire-and-forget; never blocks the flow).
    if (typeof gv2ShouldAutoGround === 'function' && gv2ShouldAutoGround(record)) {
      gv2ScoreStepGrounding(record);
    }
  } catch (e) {
    console.warn('[guidev2] gv2CaptureStepRecord failed:', e);
  }
}

/**
 * Score how well a step's captured screenshot supports/matches the step (0–1). Uses the
 * vision-capable main LLM via the SW `callLLM` path with the step's stored screenshot.
 * Persists the score on the rewind record and notifies the panel. Fails open (null).
 */
async function gv2ScoreStepGrounding(record) {
  if (!record || !record.screenshot) return null;
  try {
    const target = (record.target && record.target.text) || record.instruction || '';
    const resp = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: 'You score whether a screenshot supports a single web-guidance step. Given the step instruction and the target element it highlights, judge how well the screenshot matches and justifies this step. Return JSON only: {"grounding":0.0-1.0,"reason":"brief"}. 1.0 = the target is clearly visible and the step is appropriate here; 0.0 = it does not match the screenshot.',
      messages: [{ role: 'user', content: `STEP: ${record.instruction || ''}\nTARGET ELEMENT: ${target}\n\nHow well does the attached screenshot support this step?` }],
      imageBase64: record.screenshot
    });
    const parsed = (typeof gv2ExtractJsonObject === 'function') ? gv2ExtractJsonObject(resp && resp.content) : null;
    let score = (parsed && typeof parsed.grounding === 'number') ? Math.max(0, Math.min(1, parsed.grounding)) : null;
    if (score == null) return null;
    try { if (typeof rewindPatchRecord === 'function') await rewindPatchRecord(record.sessionId, record.step, { grounding: score, groundingReason: parsed.reason || '' }); } catch (e) {}
    try { chrome.runtime.sendMessage({ action: 'guideStepGrounding', sessionId: record.sessionId, step: record.step, grounding: score, reason: parsed.reason || '' }); } catch (e) {}
    return score;
  } catch (e) {
    console.warn('[guidev2] grounding score failed:', e.message);
    return null;
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
    plan: [],
    planTitle: '',
    currentPlanStep: 1,
    // Slice 5: structured data accumulated by EXTRACT, surfaced in the final DONE.
    extracted: {},
    // Slice 5: recent step signatures for stuck/loop detection (oldest → newest).
    stepSignatures: [],
    // Follow-up: user constraints to keep satisfied, and the auto-mode step budget counter.
    constraints: [],
    autoStepCount: 0
  };

  if (captureEnabled && typeof rewindStartSession === 'function') {
    try { await rewindStartSession(sessionId, question); } catch (e) { /* non-fatal */ }
  }

  // Constraint-aware loop: split the goal into an explicit goal + constraints so they can
  // be injected into every step prompt and verified after each action. Best-effort.
  try {
    const gc = await gv2ExtractGoalAndConstraints(question);
    if (gc && Array.isArray(gc.constraints)) {
      window._guidev2.constraints = gc.constraints;
      if (gc.constraints.length) {
        try { chrome.runtime.sendMessage({ action: 'guideConstraints', constraints: gc.constraints }); } catch (e) {}
      }
    }
  } catch (e) { /* non-fatal */ }

  // Plan (Slice 2): draft a short high-level outline before the first step so the
  // user sees structure and the step LLM can locate itself. Best-effort.
  try {
    const generated = await gv2GeneratePlan(question, match?.tutorial || null);
    const plan = Array.isArray(generated) ? generated : (generated?.plan || []);
    const title = Array.isArray(generated) ? '' : (generated?.title || '');
    window._guidev2.plan = plan;
    window._guidev2.planTitle = title;
    if (plan.length) {
      try { chrome.runtime.sendMessage({ action: 'guidePlan', title, plan, total: plan.length }); } catch (e) {}
    }
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
  if (!g.active || _guidev2Stopped) return null;

  // Budget (follow-up): cap autonomous execution. After _GV2_AUTO_STEP_BUDGET steps in auto
  // mode, drop out of auto and hand control back to the user via an ASK_HUMAN pause.
  if (typeof gv2BudgetExceeded === 'function' && gv2BudgetExceeded(g) && !g._budgetAsked) {
    g._budgetAsked = true;
    g.autoMode = false;
    try { await chrome.storage.local.set({ [_GV2_AUTOMODE_PREF_KEY]: false }); } catch (e) {}
    _gv2HideIndicator();
    gv2HideAutoOverlay();
    _gv2AskHuman(
      `I've performed ${g.autoStepCount} steps automatically — pausing so you can check in before I continue.`,
      ['Stop', 'Continue in manual', 'Keep going (auto)'],
      'budget'
    );
    return null;
  }

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

  // Verification (Slice 3): before generating the next step, check whether the previous
  // step actually worked. May auto-retry once or pause to ask the user.
  if (g._pendingVerify) {
    const outcome = await _gv2VerifyPending(pageIndex);
    if (outcome === 'pause') { _gv2HideIndicator(); return null; }
    // 'retry' falls through to generation with g._retryNote set; 'proceed' is normal.
  }
  if (!g.active || _guidev2Stopped) return null;

  // Slice 5: stuck/loop detection. If the agent appears to be going in circles (same
  // action repeated, no page progress, or repeated verification failures), stop burning
  // LLM calls and hand control to the user via a synthesized ASK_HUMAN prompt.
  if (typeof gv2DetectLoop === 'function' && !g._stuckAsked && gv2DetectLoop(g)) {
    g._stuckAsked = true;
    _gv2HideIndicator();
    gv2HideAutoOverlay();
    _gv2AskHuman(
      "I seem to be stuck on this step and not making progress.",
      ['Stop', 'Let me steer', 'Keep trying'],
      'stuck'
    );
    return null;
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

  // Plan (Slice 2): give the LLM the high-level outline + where it currently is so it
  // can self-locate and report the planStep each concrete action works toward.
  let planSection = '';
  if (g.plan && g.plan.length) {
    planSection = `\n=== PLAN ===
${g.plan.map(p => `${p.n}. ${p.goal}`).join('\n')}
Current plan step: ${g.currentPlanStep || 1}
`;
  }

  // Constraint-aware loop: keep the agent grounded in the user's limits/preferences so the
  // chosen action never violates them.
  let constraintsSection = '';
  if (g.constraints && g.constraints.length) {
    constraintsSection = `\n=== CONSTRAINTS (must keep satisfied) ===
${g.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}
`;
  }

  // Verification retry (Slice 3): tell the LLM the previous attempt failed so it tries
  // a different approach. Consumed once.
  let retrySection = '';
  if (g._retryNote) {
    retrySection = `\n=== RETRY NOTICE ===\n${g._retryNote}\n`;
    g._retryNote = null;
  }

  // ASK_HUMAN (Slice 5): the user's answer to a prior question. Consumed once.
  if (g._humanAnswer) {
    retrySection += `\n=== USER INPUT ===\n${g._humanAnswer}\n`;
    g._humanAnswer = null;
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
${tutorialSection}${constraintsSection}${planSection}${retrySection}
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

    // Slice 5: collapse legacy click/type/done and the new verbs into one canonical
    // shape so dispatch is a single switch on `verb`.
    const norm = (typeof gv2NormalizeAction === 'function') ? gv2NormalizeAction(step) : step;
    const verb = norm.verb || (isLast ? 'DONE' : 'ACT');
    const elementText = step.element?.text || '';
    g._lastVerb = verb;
    g._lastOperation = norm.operation || null;

    // Budget (follow-up): count each non-final step the agent takes while in auto mode.
    if (g.autoMode && !isLast) g.autoStepCount = (g.autoStepCount || 0) + 1;

    // Verification (Slice 3): only ACTUATING steps (ACT) change the page and warrant a
    // verify pass. Meta verbs (OBSERVE/EXTRACT/WAIT_UNTIL/SCROLL_TO_FIND/ASK_HUMAN) and the
    // final step are skipped so they don't trip "no visible change" false failures. The
    // verify pass also records the step's loop signature once the verdict is known.
    if (!isLast && verb === 'ACT') {
      g._pendingVerify = {
        step: step.step,
        planStep: g.currentPlanStep,
        instruction: step.instruction,
        nextStepHint: step.nextStepHint || '',
        verb,
        elementText,
        highRisk: (typeof gv2AssessRisk === 'function') ? gv2AssessRisk(norm) === 'high' : false
      };
    } else {
      g._pendingVerify = null;
      // Non-actuating verbs still feed loop detection (so a run of OBSERVE/WAIT with no
      // progress is caught) — record an immediate signature with no verify verdict.
      if (!isLast) _gv2PushSignature({ verb, elementText, verifyStatus: null });
    }

    if (isLast || verb === 'DONE') {
      _gv2ClearState();
    } else if (verb === 'ACT' && norm.operation === 'click') {
      // Save state with pendingResume=true BEFORE setting up click listener.
      // This ensures the SW and session storage have the flag before the user
      // can possibly click — no race condition with fast navigation.
      await _gv2SetState(true);
      _gv2SetupClickListener();

      // Autonomous mode: if this step is reversible/low-risk, perform the click for
      // the user (reusing the same path as the "Next →" button). Otherwise leave the
      // manual click listener in place and tell the user we handed control back.
      if (_gv2ShouldAutoExecute(norm)) {
        console.log('[guidev2] Auto mode: auto-performing low-risk click step', step.step);
        // Store the timer so Take-control can cancel it before it fires.
        g._autoClickTimer = setTimeout(() => {
          g._autoClickTimer = null;
          if (typeof gv2NextStep === 'function') gv2NextStep();
        }, 900);
      } else if (g.autoMode) {
        // High-risk step in auto mode → hand control back to the user for this one.
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
    } else if (verb === 'ACT') {
      // type / select / check / clear / hover — the agent performs it, then continues.
      await _gv2SetState(false);
      setTimeout(() => _gv2PerformAct(norm), 200);
    } else if (verb === 'ASK_HUMAN') {
      // Pause and surface a question; resumes when the user answers in the panel.
      await _gv2SetState(false);
      _gv2AskHuman(norm.reason || step.instruction, Array.isArray(norm.choices) ? norm.choices : [], 'verb');
    } else {
      // OBSERVE / EXTRACT / WAIT_UNTIL / SCROLL_TO_FIND — agent-driven, then continue.
      await _gv2SetState(false);
      setTimeout(() => _gv2RunMetaVerb(verb, norm), 50);
    }

    _gv2HideIndicator();

    // Rewind (Slice 1): capture this step (screenshot + DOM snapshot + reasoning).
    // Fire-and-forget so it never delays showing the step to the user.
    gv2CaptureStepRecord({
      step: step.step,
      planStep: (typeof step.planStep === 'number' && step.planStep >= 1) ? step.planStep : (g.currentPlanStep || step.step),
      confidence,
      instruction: step.instruction,
      action: step.action,
      verb,
      operation: norm.operation || null,
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
      answer: (verb === 'DONE' && norm.answer) ? norm.answer : step.instruction,
      step: step.step,
      isLastStep: isLast,
      nextStepHint: step.nextStepHint,
      targetText: step.element?.text || null,
      action: step.action,
      verb,
      operation: norm.operation || null,
      evidence: norm.evidence || null,
      extracted: (verb === 'DONE' && g.extracted && Object.keys(g.extracted).length) ? g.extracted : null,
      confidence,
      planStep: g.currentPlanStep,
      totalSteps: Array.isArray(g.plan) ? g.plan.length : 0,
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

// ===== VERIFICATION USER CHOICES (Slice 3) =====
// Called from the panel's [Retry] / [Continue] buttons after a verification pause.

async function _gv2GenerateAndDispatch() {
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

// Retry: re-attempt the same goal, telling the LLM the prior attempt failed.
window.gv2VerifyRetry = function () {
  const g = window._guidev2;
  if (!g || !g.active) return;
  g._pendingVerify = null; // already consumed at pause time
  g._retryNote = g._lastFailReason
    ? `The previous attempt failed: ${g._lastFailReason}. Try a DIFFERENT approach to achieve the same result.`
    : 'The previous attempt may not have worked. Try a different approach.';
  return _gv2GenerateAndDispatch();
};

// Continue: accept the result and move on to the next step.
window.gv2VerifyContinue = function () {
  const g = window._guidev2;
  if (!g || !g.active) return;
  g._pendingVerify = null;
  g._retryNote = null;
  return _gv2GenerateAndDispatch();
};

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

// ===== ROBUST ACTION VOCABULARY — HANDLERS (Slice 5) =====
// The dispatcher in gv2ProcessResponse routes each normalized verb here. ACT/click and
// ACT/type reuse the existing click & auto-type paths; the rest are implemented below.
// Every non-pausing handler ends by calling _gv2GenerateAndDispatch() to continue the loop.

const _GV2_SIG_MAX = 12; // keep the loop-signature ring buffer small

/** Append a loop signature (verb + target + url + verify verdict) to the session. */
function _gv2PushSignature({ verb, elementText, verifyStatus }) {
  const g = window._guidev2;
  if (!g) return;
  if (!Array.isArray(g.stepSignatures)) g.stepSignatures = [];
  g.stepSignatures.push({ verb, elementText: elementText || '', url: window.location.href, verifyStatus: verifyStatus || null });
  if (g.stepSignatures.length > _GV2_SIG_MAX) g.stepSignatures.shift();
}

/**
 * ACT for non-click operations the agent performs itself: type / select / check / clear /
 * hover. After performing the operation we continue the loop just like auto-type does.
 */
async function _gv2PerformAct(norm) {
  const g = window._guidev2;
  if (!g || !g.active || _guidev2Stopped) return;
  const op = norm.operation || 'click';

  if (op === 'type') {
    // Delegate to the well-tuned auto-type path (handles re-capture + continuation).
    return _gv2AutoType(norm);
  }

  try {
    const highlighted = document.querySelector('[data-pageguide-styled]');
    const el = highlighted
      ? (highlighted.matches('input,textarea,select,[contenteditable]')
          ? highlighted
          : highlighted.querySelector('input,textarea,select,[contenteditable]') || highlighted)
      : (g.currentTargetEl && document.contains(g.currentTargetEl) ? g.currentTargetEl : null);

    if (el) {
      if (op === 'select' && el.tagName === 'SELECT') {
        const want = String(norm.value == null ? '' : norm.value).trim().toLowerCase();
        const opt = Array.from(el.options).find(o =>
          (o.label || o.textContent || '').trim().toLowerCase() === want ||
          (o.value || '').trim().toLowerCase() === want);
        if (opt) {
          el.value = opt.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (op === 'check') {
        if ('checked' in el) {
          el.checked = true;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          _gv2DispatchClick(el);
        }
      } else if (op === 'clear') {
        if (el.isContentEditable) { el.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); }
        else if ('value' in el) {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (op === 'hover') {
        const rect = el.getBoundingClientRect();
        const shared = { bubbles: true, cancelable: true, view: window, clientX: Math.round(rect.left + rect.width / 2), clientY: Math.round(rect.top + rect.height / 2) };
        el.dispatchEvent(new PointerEvent('pointerover', { ...shared, pointerType: 'mouse', isPrimary: true }));
        el.dispatchEvent(new MouseEvent('mouseover', shared));
        el.dispatchEvent(new MouseEvent('mousemove', shared));
      }
    } else {
      console.warn('[guidev2] ACT/' + op + ': no target element found');
    }
  } catch (e) {
    console.warn('[guidev2] ACT/' + (norm.operation) + ' failed:', e);
  }

  await new Promise(r => setTimeout(r, 250));
  return _gv2GenerateAndDispatch();
}

/** OBSERVE / EXTRACT / WAIT_UNTIL / SCROLL_TO_FIND — agent-driven meta verbs. */
async function _gv2RunMetaVerb(verb, norm) {
  const g = window._guidev2;
  if (!g || !g.active || _guidev2Stopped) return;
  try {
    if (verb === 'EXTRACT') {
      await _gv2DoExtract(norm.schema);
    } else if (verb === 'WAIT_UNTIL') {
      await _gv2DoWaitUntil(norm);
    } else if (verb === 'SCROLL_TO_FIND') {
      await _gv2DoScrollToFind(norm);
    }
    // OBSERVE is a no-op (it exists so the agent can narrate its reasoning as a step).
  } catch (e) {
    console.warn('[guidev2] meta verb', verb, 'failed:', e);
  }
  if (!g.active || _guidev2Stopped) return;
  return _gv2GenerateAndDispatch();
}

/** EXTRACT: read the requested fields from the current page via the cheap router LLM. */
async function _gv2DoExtract(schema) {
  const g = window._guidev2;
  if (!schema || typeof schema !== 'object') return;
  try {
    const pageIndex = createPageIndex(5000, false); // include text content, not just interactive
    const fields = Object.entries(schema).map(([k, v]) => `- ${k}: ${v}`).join('\n');
    const response = await safeSendMessage({
      action: 'callRouterLLM',
      systemPrompt: `You extract structured data from a web page. Return JSON only: an object whose keys are exactly the requested field names. If a value is not present on the page, use null. No prose.`,
      messages: [{
        role: 'user',
        content: `FIELDS TO EXTRACT:\n${fields}\n\n=== PAGE ===\n${pageIndex.indexText}`
      }]
    });
    const parsed = (typeof gv2ExtractJsonObject === 'function') ? gv2ExtractJsonObject(response && response.content) : null;
    if (parsed && typeof parsed === 'object') {
      g.extracted = Object.assign({}, g.extracted, parsed);
      try { chrome.runtime.sendMessage({ action: 'guideExtract', data: parsed }); } catch (e) {}
    }
  } catch (e) {
    console.warn('[guidev2] extract failed:', e);
  }
}

/** WAIT_UNTIL: let the page settle (async content / spinners) before the next step. */
async function _gv2DoWaitUntil(norm) {
  const timeout = (typeof norm.timeoutMs === 'number' && norm.timeoutMs > 0) ? Math.min(norm.timeoutMs, 20000) : 8000;
  _gv2ShowIndicator('Waiting for the page…');
  try {
    if (typeof gv2WaitForDomStable === 'function') await gv2WaitForDomStable(timeout, 500);
    else await new Promise(r => setTimeout(r, Math.min(timeout, 2000)));
  } catch (e) { /* best-effort */ }
}

/** SCROLL_TO_FIND: progressively scroll until the target text appears in the index. */
async function _gv2DoScrollToFind(norm) {
  const target = norm.target || norm.element?.text;
  if (!target) return;
  const maxScreens = (typeof norm.maxScreens === 'number' && norm.maxScreens > 0) ? Math.min(norm.maxScreens, 30) : 12;
  _gv2ShowIndicator('Scrolling to find “' + String(target).slice(0, 40) + '”…');
  for (let i = 0; i < maxScreens; i++) {
    createPageIndex(5000, true); // refresh window._pageguideIndex
    if (typeof gv2FindElementByText === 'function' && gv2FindElementByText(target) !== null) {
      console.log('[guidev2] scroll_to_find: located target after', i, 'screens');
      return;
    }
    const before = window.scrollY;
    window.scrollBy(0, Math.round(window.innerHeight * 0.85));
    await new Promise(r => setTimeout(r, 450));
    if (window.scrollY === before) break; // reached the bottom
  }
}

// ===== ASK_HUMAN + STEER (Slice 5 / Slice 6) =====

/**
 * Pause guidance and ask the user a question with choice buttons. `context` is 'verb'
 * for a model-emitted ASK_HUMAN or 'stuck' for the loop-detector fallback. Resolved by
 * gv2AskHumanAnswer() when the panel reports the user's choice.
 */
function _gv2AskHuman(reason, choices, context) {
  const g = window._guidev2;
  if (!g) return;
  g._askHuman = { reason, choices: Array.isArray(choices) ? choices : [], context: context || 'verb' };
  _gv2HideIndicator();
  try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
  try {
    chrome.runtime.sendMessage({ action: 'guideAskHuman', reason: g._askHuman.reason, choices: g._askHuman.choices, context: g._askHuman.context });
  } catch (e) {}
}

/** Handle the user's answer to an ASK_HUMAN / stuck prompt (from the panel). */
window.gv2AskHumanAnswer = function (choice) {
  const g = window._guidev2;
  if (!g || !g.active) return;
  const ctx = g._askHuman ? g._askHuman.context : 'verb';
  const reason = g._askHuman ? g._askHuman.reason : '';
  g._askHuman = null;

  if (ctx === 'stuck') {
    const c = String(choice || '').toLowerCase();
    if (c.startsWith('stop')) { return gv2StopGuide(); }
    if (c.startsWith('let me steer') || c.startsWith('steer')) {
      // Slice 6: ask the panel to reveal the steer text box; gv2Steer() resumes.
      try { chrome.runtime.sendMessage({ action: 'guidePromptSteer' }); } catch (e) {}
      return;
    }
    // "Keep trying" — clear the stuck state and resume with a fresh budget.
    g.stepSignatures = [];
    g.failCounts = {};
    g._stuckAsked = false;
    return _gv2GenerateAndDispatch();
  }

  if (ctx === 'budget') {
    const c = String(choice || '').toLowerCase();
    if (c.startsWith('stop')) { return gv2StopGuide(); }
    g.autoStepCount = 0;
    g._budgetAsked = false;
    if (c.includes('keep going') || c.includes('auto')) {
      g.autoMode = true;
      try { chrome.storage.local.set({ [_GV2_AUTOMODE_PREF_KEY]: true }); } catch (e) {}
    } else {
      g.autoMode = false; // continue in manual
    }
    return _gv2GenerateAndDispatch();
  }

  // Normal ASK_HUMAN: feed the chosen answer into the next step's context.
  g._humanAnswer = `For the question "${reason}", the user chose: "${choice}".`;
  return _gv2GenerateAndDispatch();
};

/**
 * Slice 6 / follow-up: the user steered a step with a free-text note.
 *
 * True reset semantics: when a specific `step` is given, rewind to it — truncate the rewind
 * records and completed-step history after it, set the plan pointer back, and RELOAD that
 * step's URL. On reload the resume path redoes that step from a clean page state with the
 * note. When no step is given (e.g. the stuck prompt), fall back to re-prompting the next
 * step in place.
 *
 * @param {string} note - the user's steering guidance
 * @param {number} [step] - the concrete timeline step the user clicked
 * @param {string} [url]  - that step's URL (from its rewind record), if the panel knows it
 */
window.gv2Steer = async function (note, step, url) {
  const g = window._guidev2;
  if (!g || !g.active) return;

  const cleanNote = (note || '').toString().trim();
  g._retryNote = cleanNote
    ? `The user is steering this step. Their guidance: "${cleanNote}". Follow it and try again.`
    : 'The user asked to try this step differently. Use a different approach.';
  g.stepSignatures = [];
  g.failCounts = {};
  g._stuckAsked = false;
  g._pendingVerify = null;

  const stepNum = Number(step);
  if (stepNum >= 1) {
    // Prefer the URL the panel passed (from the step's rewind record); fall back to looking
    // the record up here. Records are keyed by CONCRETE step number.
    let rec = null;
    try {
      if (typeof rewindGetRecord === 'function') rec = await rewindGetRecord(g.sessionId, stepNum);
    } catch (e) { /* best-effort */ }

    // Rewind history so the agent re-derives from this step forward.
    try { if (typeof rewindTruncateAfter === 'function') await rewindTruncateAfter(g.sessionId, stepNum); } catch (e) {}
    g.previousSteps = Array.isArray(g.previousSteps) ? g.previousSteps.slice(0, stepNum - 1) : [];
    g.currentPlanStep = (rec && rec.planStep) ? rec.planStep : (g.currentPlanStep || 1);

    const targetUrl = url || (rec && rec.url);
    if (targetUrl) {
      // Persist (with the note) BEFORE navigating so the reloaded page resumes at this step.
      await _gv2SetState(true);
      try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}
      console.log('[guidev2] Steer: reloading step', stepNum, 'URL', targetUrl);
      // Force a full load of that step's page (assigning the same href triggers a reload).
      window.location.assign(targetUrl);
      return;
    }
  }

  // No step/URL → re-prompt in place from the current position.
  return _gv2GenerateAndDispatch();
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
