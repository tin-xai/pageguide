// PageGuide - Rewind Store (Slice 1)
//
// Persists per-step guidance "records" (screenshot + static DOM snapshot + reasoning)
// so the user can rewind and inspect any step the agent performed.
//
// Why chrome.storage.local (not IndexedDB):
//   The capture happens in a CONTENT SCRIPT (page origin) while the timeline and the
//   full-page inspector run in EXTENSION pages (chrome-extension:// origin). A content
//   script cannot share an extension-origin IndexedDB. chrome.storage.local is reachable
//   identically from content scripts, the service worker, and extension pages, so a single
//   plain-function module works in every context. `unlimitedStorage` (manifest) lifts the
//   10 MB cap so MB-sized DOM snapshots fit.
//
// Layout (multi-session — each guide prompt keeps its own journey, so an earlier guide's
// journey can be recalled later):
//   RW_SESSIONS                  -> [{ sessionId, goal, startedAt, ...branchMeta }] oldest→newest (capped)
//   RW_CURRENT                   -> sessionId of the active/most-recent session
//   RW_IDX::<sessionId>          -> { sessionId, goal, startedAt, steps:[lightweight meta], ...branchMeta }
//   RW_REC::<sessionId>::<step>  -> full record (incl. screenshot + domSnapshot)
//
// The lightweight index keeps the timeline fast to render; full records (with the heavy
// screenshot/DOM payload) are loaded lazily only when a step is hovered or inspected.

(function (global) {
  const RW_INDEX_PREFIX = 'RW_IDX::';
  const RW_REC_PREFIX = 'RW_REC::';
  const RW_SESSIONS_KEY = 'RW_SESSIONS';
  const RW_CURRENT_KEY = 'RW_CURRENT';
  const RW_SESSION_CAP = 8; // keep the most recent N guide journeys
  // One-shot handoff for the "Steer from here" branch: written by the side panel, consumed
  // by the content script after it navigates back to the step's URL. See guidev2 steer pickup.
  const RW_STEER_PENDING_KEY = 'RW_STEER_PENDING';

  function _store() {
    return (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
      ? chrome.storage.local
      : null;
  }

  function _get(keys) {
    const s = _store();
    if (!s) return Promise.resolve({});
    return new Promise(resolve => {
      try { s.get(keys, res => resolve(res || {})); }
      catch (e) { resolve({}); }
    });
  }

  function _set(obj) {
    const s = _store();
    if (!s) return Promise.resolve();
    return new Promise(resolve => {
      try { s.set(obj, () => resolve()); }
      catch (e) { resolve(); }
    });
  }

  function _remove(keys) {
    const s = _store();
    if (!s) return Promise.resolve();
    return new Promise(resolve => {
      try { s.remove(keys, () => resolve()); }
      catch (e) { resolve(); }
    });
  }

  function _recKey(sessionId, step) {
    return RW_REC_PREFIX + sessionId + '::' + step;
  }
  function _idxKey(sessionId) {
    return RW_INDEX_PREFIX + sessionId;
  }

  // Lightweight meta projected from a full record for the timeline index.
  function _toMeta(record) {
    return {
      sessionId: record.sessionId,
      step: record.step,
      planStep: record.planStep,
      instruction: record.instruction,
      action: record.action,
      isLastStep: record.isLastStep,
      url: record.url,
      timestamp: record.timestamp,
      durationMs: record.durationMs,
      confidence: record.confidence,
      grounded: record.grounded,
      loop: record.loop,
      progress: record.progress,
      confidenceFormula: record.confidenceFormula,
      mechConfidence: record.mechConfidence,
      mechGrounding: record.mechGrounding,
      mechLoop: record.mechLoop,
      loopMatches: record.loopMatches,
      domElementText: record.domElementText,
      llmElementText: record.llmElementText,
      resolvedIndex: record.resolvedIndex,
      planTotal: record.planTotal,
      planCompleted: record.planCompleted,
      confidenceSource: record.confidenceSource,
      risk: record.risk,
      mode: record.mode,
      verification: record.verification,
      cost: record.cost,
      title: record.title,
      isInitial: record.isInitial,
      // Visual-evidence justification (short text) + a flag for whether a cropped evidence shot was
      // stored. Kept in the lightweight index so the recap builder can surface it without loading
      // full records; the shot itself stays in the full record (loaded lazily on hover/click).
      visualEvidenceReason: record.visualEvidenceReason || null,
      hasVisualEvidence: !!record.visualEvidenceShot,
      // Verification flag: does this step have any screenshot? Steps without one are "void" and
      // get pruned from the timeline / recall.
      hasShot: !!rewindResolveScreenshot(record)
    };
  }

  function rewindResolveScreenshot(record) {
    return record ? (record.screenshotBefore || record.screenshot || record.screenshotAfter || null) : null;
  }

  async function _getSessions() {
    const res = await _get(RW_SESSIONS_KEY);
    return Array.isArray(res[RW_SESSIONS_KEY]) ? res[RW_SESSIONS_KEY] : [];
  }

  // Remove a session's index + all of its step records.
  async function _removeSession(sessionId) {
    const all = await _get(null);
    const recPrefix = RW_REC_PREFIX + sessionId + '::';
    const toRemove = Object.keys(all).filter(k => k === _idxKey(sessionId) || k.indexOf(recPrefix) === 0);
    if (toRemove.length) await _remove(toRemove);
  }

  // Begin a fresh session WITHOUT wiping prior ones (so earlier journeys can be recalled).
  // Registers the session, marks it current, and prunes the oldest beyond the cap.
  async function rewindStartSession(sessionId, goal) {
    let sessions = await _getSessions();
    sessions = sessions.filter(s => s.sessionId !== sessionId);
    sessions.push({ sessionId, goal: goal || '', startedAt: Date.now() });
    // Prune oldest beyond the cap.
    while (sessions.length > RW_SESSION_CAP) {
      const dropped = sessions.shift();
      if (dropped) await _removeSession(dropped.sessionId);
    }
    await _set({
      [RW_SESSIONS_KEY]: sessions,
      [RW_CURRENT_KEY]: sessionId,
      [_idxKey(sessionId)]: { sessionId, goal: goal || '', startedAt: Date.now(), steps: [] }
    });
  }

  // Create a branch journey by copying a parent session's prefix into a new ordinary session.
  // The parent is intentionally left untouched, so its original "View journey" remains complete.
  async function rewindCreateBranchSession(parentSessionId, branchSessionId, anchorStep, meta) {
    if (!parentSessionId || !branchSessionId || !Number.isFinite(Number(anchorStep))) return null;
    const parent = await rewindGetIndex(parentSessionId);
    if (!parent || !Array.isArray(parent.steps)) return null;

    const n = Number(anchorStep);
    const startedAt = Date.now();
    const branchMeta = Object.assign({
      parentSessionId,
      branchFromStep: n,
      redoStep: n + 1,
      branchStatus: 'pending_restore',
      branchLabel: 'View journey before Step ' + (n + 1)
    }, meta || {});
    // Keep the agent-facing goal from the parent journey. Branch display text belongs in
    // branchLabel/metadata and must not replace the original user task.
    const goal = parent.goal || '';
    const branchIndex = Object.assign({
      sessionId: branchSessionId,
      goal,
      startedAt,
      guidePlan: Array.isArray(parent.guidePlan) ? parent.guidePlan : (Array.isArray(parent.plan) ? parent.plan : []),
      guideTitle: parent.guideTitle || '',
      steps: []
    }, branchMeta);

    const writes = {};
    const parentSteps = parent.steps
      .filter(s => (s.isInitial || Number(s.step) === 0 || Number(s.step) <= n))
      .sort((a, b) => Number(a.step) - Number(b.step));
    for (const m of parentSteps) {
      const rec = await rewindGetRecord(parentSessionId, m.step);
      if (!rec) continue;
      const copy = Object.assign({}, rec, {
        sessionId: branchSessionId,
        parentSessionId,
        branchFromStep: n
      });
      writes[_recKey(branchSessionId, copy.step)] = copy;
      branchIndex.steps.push(_toMeta(copy));
    }

    let sessions = await _getSessions();
    sessions = sessions.filter(s => s.sessionId !== branchSessionId);
    sessions.push(Object.assign({ sessionId: branchSessionId, goal, startedAt }, branchMeta));
    while (sessions.length > RW_SESSION_CAP) {
      const dropped = sessions.shift();
      if (dropped) await _removeSession(dropped.sessionId);
    }

    writes[RW_SESSIONS_KEY] = sessions;
    writes[RW_CURRENT_KEY] = branchSessionId;
    writes[_idxKey(branchSessionId)] = branchIndex;
    await _set(writes);
    return branchIndex;
  }

  async function rewindUpdateSessionMeta(sessionId, patch) {
    if (!sessionId || !patch) return null;
    const res = await _get(_idxKey(sessionId));
    const index = res[_idxKey(sessionId)];
    if (!index) return null;
    Object.assign(index, patch);
    let sessions = await _getSessions();
    sessions = sessions.map(s => s.sessionId === sessionId ? Object.assign({}, s, patch) : s);
    await _set({ [_idxKey(sessionId)]: index, [RW_SESSIONS_KEY]: sessions });
    return index;
  }

  // Store (or overwrite) the full record for a step and update the session's index meta.
  // Pass { skipIndex: true } to store the record only (used by the Initial-state node, which is
  // not a journey "step" and must not appear in / inflate the step index).
  async function rewindPutRecord(record, opts) {
    if (!record || record.sessionId == null || record.step == null) return;
    const sid = record.sessionId;
    await _set({ [_recKey(sid, record.step)]: record });

    if (opts && opts.skipIndex) return;

    const res = await _get(_idxKey(sid));
    const index = res[_idxKey(sid)] || { sessionId: sid, goal: '', startedAt: Date.now(), steps: [] };
    const meta = _toMeta(record);
    const existing = index.steps.findIndex(s => s.step === record.step);
    if (existing >= 0) index.steps[existing] = meta;
    else index.steps.push(meta);
    index.steps.sort((a, b) => a.step - b.step);
    await _set({ [_idxKey(sid)]: index });

    // Ensure the session is registered (in case a record arrives without startSession).
    const sessions = await _getSessions();
    if (!sessions.some(s => s.sessionId === sid)) {
      sessions.push({ sessionId: sid, goal: index.goal || '', startedAt: index.startedAt || Date.now() });
      const patch = { [RW_SESSIONS_KEY]: sessions };
      const cur = await _get(RW_CURRENT_KEY);
      if (!cur[RW_CURRENT_KEY]) patch[RW_CURRENT_KEY] = sid;
      await _set(patch);
    }
  }

  // Index for a specific session, or — with no arg — the current/most-recent session.
  async function rewindGetIndex(sessionId) {
    if (sessionId == null) {
      const cur = await _get(RW_CURRENT_KEY);
      sessionId = cur[RW_CURRENT_KEY];
      if (sessionId == null) return null;
    }
    const res = await _get(_idxKey(sessionId));
    return res[_idxKey(sessionId)] || null;
  }

  // Ordered list of retained sessions (oldest→newest).
  async function rewindGetSessions() {
    return _getSessions();
  }

  async function rewindGetRecord(sessionId, step) {
    const key = _recKey(sessionId, step);
    const res = await _get(key);
    return res[key] || null;
  }

  // Merge a partial update into an existing record (e.g. attach a verification result
  // discovered on the next cycle). Re-puts so the index meta stays in sync.
  async function rewindPatchRecord(sessionId, step, patch) {
    const rec = await rewindGetRecord(sessionId, step);
    if (!rec) return;
    Object.assign(rec, patch || {});
    await rewindPutRecord(rec);
  }

  // Remove all sessions, indexes and records (🧹 New Chat / reset). Leaves the one-shot steer
  // handoff untouched (it's cleared separately by its consumer).
  async function rewindClear() {
    const all = await _get(null);
    const toRemove = Object.keys(all).filter(k =>
      k === RW_SESSIONS_KEY || k === RW_CURRENT_KEY ||
      k.indexOf(RW_INDEX_PREFIX) === 0 || k.indexOf(RW_REC_PREFIX) === 0
    );
    if (toRemove.length) await _remove(toRemove);
  }

  // Drop records after `step` within a session (used by the steer/rebranch fork).
  async function rewindTruncateAfter(sessionId, step) {
    const all = await _get(null);
    const recPrefix = RW_REC_PREFIX + sessionId + '::';
    const toRemove = Object.keys(all).filter(k => {
      if (k.indexOf(recPrefix) !== 0) return false;
      const n = parseInt(k.slice(recPrefix.length), 10);
      return Number.isFinite(n) && n > step;
    });
    if (toRemove.length) await _remove(toRemove);
    const res = await _get(_idxKey(sessionId));
    const index = res[_idxKey(sessionId)];
    if (index) {
      index.steps = index.steps.filter(s => s.step <= step);
      await _set({ [_idxKey(sessionId)]: index });
    }
  }

  // Delete a single step's record + its index entry (used to prune "void" screenshot-less steps).
  async function rewindDeleteRecord(sessionId, step) {
    await _remove(_recKey(sessionId, step));
    const res = await _get(_idxKey(sessionId));
    const index = res[_idxKey(sessionId)];
    if (index && Array.isArray(index.steps)) {
      index.steps = index.steps.filter(s => Number(s.step) !== Number(step));
      await _set({ [_idxKey(sessionId)]: index });
    }
  }

  async function rewindVerifyScreenshots(sessionId) {
    const index = await rewindGetIndex(sessionId);
    if (!index || !Array.isArray(index.steps)) return index || null;

    const kept = [];
    const removeKeys = [];
    for (const meta of index.steps.slice().sort((a, b) => Number(a.step) - Number(b.step))) {
      const rec = await rewindGetRecord(index.sessionId, meta.step);
      const isInitial = !!(meta.isInitial || rec?.isInitial || Number(meta.step) === 0);
      const hasShot = !!rewindResolveScreenshot(rec);
      const hasSnapshot = !!(rec && rec.domSnapshot);
      const keep = isInitial ? (hasShot || hasSnapshot) : hasShot;
      if (rec && keep) kept.push(_toMeta(rec));
      else if (!isInitial) removeKeys.push(_recKey(index.sessionId, meta.step));
      else if (rec && !keep) removeKeys.push(_recKey(index.sessionId, meta.step));
    }

    if (removeKeys.length) await _remove(removeKeys);
    index.steps = kept.sort((a, b) => Number(a.step) - Number(b.step));
    await _set({ [_idxKey(index.sessionId)]: index });
    return Object.assign({}, index, { removed: removeKeys.length });
  }

  // ----- Steer ("branch & re-run") handoff -----
  // The side panel writes a payload { sessionId, fromStep, newGoal, url, createdAt } and then
  // navigates the working tab to `url`; the content script reads it on load (taking precedence
  // over the normal resume), replays prior actions, and forks the session. One-shot: cleared
  // by the consumer.
  async function rewindSetSteerPending(payload) {
    await _set({ [RW_STEER_PENDING_KEY]: payload || null });
  }

  async function rewindGetSteerPending() {
    const res = await _get(RW_STEER_PENDING_KEY);
    return res[RW_STEER_PENDING_KEY] || null;
  }

  async function rewindClearSteerPending() {
    await _remove(RW_STEER_PENDING_KEY);
  }

  const api = {
    rewindStartSession,
    rewindCreateBranchSession,
    rewindUpdateSessionMeta,
    rewindPutRecord,
    rewindGetIndex,
    rewindGetSessions,
    rewindGetRecord,
    rewindPatchRecord,
    rewindResolveScreenshot,
    rewindVerifyScreenshots,
    rewindClear,
    rewindTruncateAfter,
    rewindDeleteRecord,
    rewindSetSteerPending,
    rewindGetSteerPending,
    rewindClearSteerPending
  };

  // Expose as globals (content scripts, panel, inspector) and as a namespace.
  global.RewindStore = api;
  Object.assign(global, api);

  // CommonJS export for unit tests.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
