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
// Layout:
//   RW_INDEX                     -> { sessionId, goal, startedAt, steps:[lightweight meta] }
//   RW_REC::<sessionId>::<step>  -> full record (incl. screenshot + domSnapshot)
//
// The lightweight index keeps the timeline fast to render; full records (with the heavy
// screenshot/DOM payload) are loaded lazily only when a step is hovered or inspected.

(function (global) {
  const RW_INDEX_KEY = 'RW_INDEX';
  const RW_REC_PREFIX = 'RW_REC::';
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

  // Lightweight meta projected from a full record for the timeline index.
  function _toMeta(record) {
    return {
      step: record.step,
      planStep: record.planStep,
      instruction: record.instruction,
      action: record.action,
      isLastStep: record.isLastStep,
      url: record.url,
      timestamp: record.timestamp,
      durationMs: record.durationMs,
      confidence: record.confidence,
      risk: record.risk,
      mode: record.mode,
      verification: record.verification,
      cost: record.cost
    };
  }

  // Begin a fresh session: wipe any prior session's records and start a new index.
  async function rewindStartSession(sessionId, goal) {
    await rewindClear();
    await _set({ [RW_INDEX_KEY]: { sessionId, goal: goal || '', startedAt: Date.now(), steps: [] } });
  }

  // Store (or overwrite) the full record for a step and update the index meta.
  async function rewindPutRecord(record) {
    if (!record || record.sessionId == null || record.step == null) return;
    await _set({ [_recKey(record.sessionId, record.step)]: record });

    const res = await _get(RW_INDEX_KEY);
    const index = res[RW_INDEX_KEY] || { sessionId: record.sessionId, goal: '', startedAt: Date.now(), steps: [] };
    // If this record belongs to a different session than the index, reset the index.
    if (index.sessionId !== record.sessionId) {
      index.sessionId = record.sessionId;
      index.steps = [];
    }
    const meta = _toMeta(record);
    const existing = index.steps.findIndex(s => s.step === record.step);
    if (existing >= 0) index.steps[existing] = meta;
    else index.steps.push(meta);
    index.steps.sort((a, b) => a.step - b.step);
    await _set({ [RW_INDEX_KEY]: index });
  }

  async function rewindGetIndex() {
    const res = await _get(RW_INDEX_KEY);
    return res[RW_INDEX_KEY] || null;
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

  // Remove the index and every RW_REC:: record (across any session).
  async function rewindClear() {
    const all = await _get(null);
    const toRemove = Object.keys(all).filter(k => k === RW_INDEX_KEY || k.indexOf(RW_REC_PREFIX) === 0);
    if (toRemove.length) await _remove(toRemove);
  }

  // Drop records after `step` (used by the redirect/fork feature in a later slice).
  async function rewindTruncateAfter(sessionId, step) {
    const all = await _get(null);
    const toRemove = Object.keys(all).filter(k => {
      if (k.indexOf(RW_REC_PREFIX + sessionId + '::') !== 0) return false;
      const n = parseInt(k.slice((RW_REC_PREFIX + sessionId + '::').length), 10);
      return Number.isFinite(n) && n > step;
    });
    if (toRemove.length) await _remove(toRemove);
    const res = await _get(RW_INDEX_KEY);
    const index = res[RW_INDEX_KEY];
    if (index && index.sessionId === sessionId) {
      index.steps = index.steps.filter(s => s.step <= step);
      await _set({ [RW_INDEX_KEY]: index });
    }
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
    rewindPutRecord,
    rewindGetIndex,
    rewindGetRecord,
    rewindPatchRecord,
    rewindClear,
    rewindTruncateAfter,
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
