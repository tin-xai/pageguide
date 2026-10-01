// PageGuide — captured guide trajectories for MODEL PERFORMANCE
// =============================================================
// The third bank beside guide_trajectories.js (the user study) and annotation_trajectories.js (the
// annotator website). Same trajectory shape, different question: how did a given MODEL do on the
// same 12 tasks the annotators graded? A run is captured as it happened, tagged with the task it
// was started from and with what the run cost — provider, model, calls, tokens, dollars, wall time,
// read off the cost ledger (content/utils.js) — and published to its own table so runs of different
// models on the same task can be lined up.
//
// WHY A THIRD BANK: the study bank is edited into a stimulus and the annotation bank is what the
// annotators grade; neither may change because a model comparison needs one more run. This bank
// takes any number of runs per task, one per model tried.
//
// THREE PARTS, as in annotation_trajectories.js:
//   the bank            — list/get/save/delete in chrome.storage.local
//   buildModelPerformanceTask — pure. A banked trajectory in, the RPC's `p_task` payload out.
//   publishModelPerformanceTrajectories — the fetch, through the same V2 project, admin password
//                         and headers as guide_v2_publish.js. See supabase_schema_model_performance.sql.

const PAGEGUIDE_MODEL_PERFORMANCE_TRAJECTORIES_KEY = 'pageguide_model_performance_trajectories';

/** A row id the RPC will accept, rewritten deterministically (same rule as _annotationId). */
function _modelPerfId(raw) {
  const cleaned = String(raw == null ? '' : raw).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  const trimmed = cleaned.replace(/^[^A-Za-z0-9]+/, '');
  if (trimmed.length >= 2) return trimmed;
  return `perf-${cleaned || 'item'}`.slice(0, 80);
}

/** guide_visual when the run carries screenshots, guide_text otherwise. */
function _modelPerfTaskStyle(record) {
  const steps = record?.arms?.grounding?.steps;
  return (Array.isArray(steps) && steps.some(st => st && st.screenshot)) ? 'guide_visual' : 'guide_text';
}

/** The flattened step list, one entry per numbered step, screenshots included. */
function _modelPerfSteps(record) {
  const steps = record?.arms?.grounding?.steps;
  return (Array.isArray(steps) ? steps : []).map((st, i) => ({
    n: Number.isFinite(Number(st?.n)) ? Number(st.n) : i + 1,
    instruction: String(st?.instruction || ''),
    action: String(st?.action || ''),
    target_text: String(st?.target_text || ''),
    url: String(st?.url || ''),
    screenshot: st?.screenshot || null,
  }));
}

/**
 * What one run cost, from the cost ledger's entries for its session. Pure.
 *
 * provider/model are the ones most of the run's calls used (a run is one model, but a fallback
 * or a mid-run settings change would otherwise make the label a coin toss). duration_ms is the
 * span from the first call to the last — the wall time the agent was thinking, not the user's.
 *
 * @param {Array<object>} entries - ledger entries already filtered to the session
 * @returns {{provider, model, calls, unpriced, cost_usd, prompt_tokens, completion_tokens, duration_ms}}
 */
function _modelPerfRunMeta(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
  const tally = (field) => {
    const counts = new Map();
    list.forEach(e => { const v = String(e[field] || '').trim(); if (v) counts.set(v, (counts.get(v) || 0) + 1); });
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  };
  const sums = list.reduce((acc, e) => {
    acc.calls += 1;
    const c = Number(e.costUsd);
    if (e.costUsd != null && isFinite(c)) acc.cost_usd += c; else acc.unpriced += 1;
    acc.prompt_tokens += Number(e.promptTokens) || 0;
    acc.completion_tokens += Number(e.completionTokens) || 0;
    return acc;
  }, { calls: 0, unpriced: 0, cost_usd: 0, prompt_tokens: 0, completion_tokens: 0 });
  const times = list.map(e => Number(e.ts)).filter(t => isFinite(t) && t > 0);
  return Object.assign({ provider: tally('provider'), model: tally('model') }, sums, {
    duration_ms: times.length ? Math.max(...times) - Math.min(...times) : null,
  });
}

/**
 * The RPC payload for one banked trajectory. Pure. Mirrors buildAnnotationTask column for column
 * and adds the run's cost/model columns.
 *
 * @param {object} record - a banked trajectory (with `run_meta` from _modelPerfRunMeta)
 * @param {number} taskIndex - position in capture order
 * @returns {object} `p_task` for save_pageguide_model_performance_trajectory
 */
function buildModelPerformanceTask(record, taskIndex = 0) {
  const t = record || {};
  const grounded = t.arms?.grounding || {};
  const trajectory = _modelPerfSteps(t);
  const meta = t.run_meta && typeof t.run_meta === 'object' ? t.run_meta : {};
  return {
    id: _modelPerfId(t.id),
    source_task_id: String(t.task_id || ''),
    source_trajectory_id: String(t.id || ''),
    title: String(t.title || t.goal || ''),
    url: String(grounded.initial_state?.url || trajectory[0]?.url || '').trim(),
    task_style: _modelPerfTaskStyle(t),
    goal: String(t.goal || '').trim(),
    arms: { grounding: grounded },
    trajectory,
    agent_answer: String(grounded.answer || '').trim(),
    claims_completion: typeof t.claims_completion === 'boolean' ? t.claims_completion : null,
    provider: String(meta.provider || ''),
    model: String(meta.model || ''),
    run_meta: meta,
    in_report: t.in_report !== false && trajectory.length > 0,
    task_index: Number.isFinite(Number(taskIndex)) ? Number(taskIndex) : 0,
    captured_at: String(t.captured_at || ''),
  };
}

// ── the bank ────────────────────────────────────────────────────────────────

async function listModelPerformanceTrajectories() {
  try {
    const data = await chrome.storage.local.get(PAGEGUIDE_MODEL_PERFORMANCE_TRAJECTORIES_KEY);
    const all = data[PAGEGUIDE_MODEL_PERFORMANCE_TRAJECTORIES_KEY];
    return (all && typeof all === 'object') ? all : {};
  } catch (e) {
    console.warn('[ModelPerformance] read failed:', e);
    return {};
  }
}

async function getModelPerformanceTrajectory(id) {
  const all = await listModelPerformanceTrajectories();
  return all[String(id || '').trim()] || null;
}

/** Save one capture. Screenshots are downscaled the same way the other banks do it. */
async function saveModelPerformanceTrajectory(record, { downscale = true } = {}) {
  const toStore = (downscale && typeof _downscaleGuideTrajectory === 'function')
    ? await _downscaleGuideTrajectory(record)
    : JSON.parse(JSON.stringify(record || {}));
  toStore.updated_at = new Date().toISOString();
  toStore.in_report = toStore.in_report !== false;
  try {
    const all = await listModelPerformanceTrajectories();
    all[String(toStore.id || '').trim()] = toStore;
    await chrome.storage.local.set({ [PAGEGUIDE_MODEL_PERFORMANCE_TRAJECTORIES_KEY]: all });
  } catch (e) {
    console.error('[ModelPerformance] local save failed:', e);
    return { saved: false, error: e?.message || 'local save failed' };
  }
  return { saved: true, record: toStore };
}

async function deleteModelPerformanceTrajectory(id) {
  try {
    const all = await listModelPerformanceTrajectories();
    delete all[String(id || '').trim()];
    await chrome.storage.local.set({ [PAGEGUIDE_MODEL_PERFORMANCE_TRAJECTORIES_KEY]: all });
    return true;
  } catch (e) {
    console.warn('[ModelPerformance] delete failed:', e);
    return false;
  }
}

// ── publishing ──────────────────────────────────────────────────────────────

function _modelPerfConfigured() {
  return typeof window._v2Configured === 'function' && window._v2Configured();
}

async function publishModelPerformanceTask(payload, password) {
  const res = await fetch(`${SUPABASE_V2_URL}/rest/v1/rpc/save_pageguide_model_performance_trajectory`, {
    method: 'POST',
    headers: window._v2Headers(),
    body: JSON.stringify({ p_password: password, p_task: payload }),
  });
  const body = await res.text();
  if (!res.ok) {
    let message = body;
    try { message = JSON.parse(body).message || body; } catch (e) { /* keep the raw body */ }
    throw new Error(message);
  }
  return body.replace(/^"|"$/g, '');
}

/** Upsert every ticked trajectory (or just `onlyId`) into pageguide_model_performance_trajectories. */
async function publishModelPerformanceTrajectories(records, onlyId = null) {
  if (!_modelPerfConfigured()) {
    return { ok: false, error: 'V2 Supabase is not configured — set SUPABASE_V2_URL and '
      + 'SUPABASE_V2_ANON_KEY in sidepanel/supabase_config.js.', rows: [] };
  }
  const password = await window.ensureV2AdminPassword();
  if (!password) return { ok: false, error: 'Wrong or no admin password.', rows: [] };

  const queue = (records || [])
    .filter(t => t && t.id)
    .sort((a, b) => String(a.captured_at || '').localeCompare(String(b.captured_at || '')));
  const rows = [];
  for (let i = 0; i < queue.length; i++) {
    const record = queue[i];
    if (onlyId && String(record.id) !== String(onlyId)) continue;
    if (!onlyId && record.in_report === false) continue;
    const payload = buildModelPerformanceTask(record, i);
    try {
      await publishModelPerformanceTask(payload, password);
      rows.push({ id: record.id, row_id: payload.id, ok: true, steps: payload.trajectory.length,
        model: payload.model, in_report: payload.in_report });
    } catch (e) {
      rows.push({ id: record.id, row_id: payload.id, ok: false, error: e?.message || String(e) });
    }
  }
  return { ok: true, rows };
}

function describeModelPerformancePublish(rows) {
  return (rows || []).map(r => {
    const into = r.row_id && r.row_id !== r.id ? ` → ${r.row_id}` : '';
    if (!r.ok) return `✗ ${r.id}${into} — ${r.error}`;
    return `${r.in_report ? '✓' : '◦'} ${r.id}${into} — ${r.steps} steps${r.model ? ` · ${r.model}` : ''}${r.in_report ? '' : ' (excluded)'}`;
  }).join('\n');
}

/** The exported file: the same payloads the RPC would receive, in capture order. */
function buildModelPerformanceBundle(records) {
  const queue = (records || [])
    .filter(t => t && t.id && t.in_report !== false)
    .sort((a, b) => String(a.captured_at || '').localeCompare(String(b.captured_at || '')));
  return {
    kind: 'pageguide_model_performance_trajectories',
    exported_at: new Date().toISOString(),
    trajectories: queue.map((t, i) => buildModelPerformanceTask(t, i)),
  };
}

if (typeof window !== 'undefined') {
  window.PAGEGUIDE_MODEL_PERFORMANCE_TRAJECTORIES_KEY = PAGEGUIDE_MODEL_PERFORMANCE_TRAJECTORIES_KEY;
  window._modelPerfId = _modelPerfId;
  window._modelPerfTaskStyle = _modelPerfTaskStyle;
  window._modelPerfRunMeta = _modelPerfRunMeta;
  window.buildModelPerformanceTask = buildModelPerformanceTask;
  window.buildModelPerformanceBundle = buildModelPerformanceBundle;
  window.listModelPerformanceTrajectories = listModelPerformanceTrajectories;
  window.getModelPerformanceTrajectory = getModelPerformanceTrajectory;
  window.saveModelPerformanceTrajectory = saveModelPerformanceTrajectory;
  window.deleteModelPerformanceTrajectory = deleteModelPerformanceTrajectory;
  window.publishModelPerformanceTrajectories = publishModelPerformanceTrajectories;
  window.describeModelPerformancePublish = describeModelPerformancePublish;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _modelPerfId, _modelPerfTaskStyle, _modelPerfRunMeta, buildModelPerformanceTask, buildModelPerformanceBundle };
}
