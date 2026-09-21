// PageGuide — captured guide trajectories for the ANNOTATOR website
// ==================================================================
// A second bank beside guide_trajectories.js, for a different audience. The study bank feeds
// participants a run with a KNOWN fault and asks whether they notice; this bank feeds annotators
// the run AS IT HAPPENED and asks them to grade it — every step correct or not, the final answer
// correct or not — so two annotators' labels can be compared for agreement (annotate/).
//
// WHY NOT REUSE THE STUDY BANK: the study bank is edited by hand into a stimulus (steps reordered,
// screenshots swapped, two arms derived), and the annotation site must see what the agent actually
// did. Sharing one store would mean an edit for the study silently changes what the annotators are
// grading. So capture writes the raw run here, and nothing in here is edited afterwards.
//
// SAME TRAJECTORY SHAPE as the study bank (_buildGuideTrajectory, guide_trajectories.js) so the
// annotator site can render a run with the same code the study viewer uses, and so a trajectory
// captured for one can be copied to the other without translation.
//
// THREE PARTS:
//   the bank        — list/get/save/delete in chrome.storage.local
//   buildAnnotationTask — pure. A banked trajectory in, the RPC's `p_task` payload out.
//   publishAnnotationTrajectories — the fetch, through the same V2 project, admin password and
//                     headers as guide_v2_publish.js. See supabase_schema_annotation.sql.

const PAGEGUIDE_ANNOTATION_TRAJECTORIES_KEY = 'pageguide_annotation_trajectories';

/**
 * A row id the RPC will accept (`^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$`), rewritten deterministically
 * so re-publishing the same capture lands on the same row. Same rule as _guideV2Id.
 */
function _annotationId(raw) {
  const cleaned = String(raw == null ? '' : raw).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  const trimmed = cleaned.replace(/^[^A-Za-z0-9]+/, '');
  if (trimmed.length >= 2) return trimmed;
  return `annot-${cleaned || 'item'}`.slice(0, 80);
}

/**
 * guide_visual when the run carries screenshots, guide_text otherwise — the same vocabulary as
 * pageguide_guide_v2_tasks.task_style, read off the data rather than remembered.
 */
function _annotationTaskStyle(record) {
  const steps = record?.arms?.grounding?.steps;
  return (Array.isArray(steps) && steps.some(st => st && st.screenshot)) ? 'guide_visual' : 'guide_text';
}

/**
 * The flattened step list the site grades, one entry per numbered step. Screenshots travel with
 * the step because an annotator has to SEE the click to grade it.
 */
function _annotationSteps(record) {
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
 * The RPC payload for one banked trajectory. Pure.
 *
 * Mirrors buildGuideV2Task column for column where the columns mean the same thing (id,
 * source ids, title, url, task_style, goal, arms, trajectory, step_count, task_index) and drops the
 * study-only ones (answer_variants, correctness_mode, guide_ground_truth): the annotators ARE the
 * ground truth here, so there is nothing to author ahead of them.
 *
 * @param {object} record - a banked trajectory
 * @param {number} taskIndex - position in the annotators' queue
 * @returns {object} `p_task` for save_pageguide_annotation_trajectory
 */
function buildAnnotationTask(record, taskIndex = 0) {
  const t = record || {};
  const grounded = t.arms?.grounding || {};
  const trajectory = _annotationSteps(t);
  return {
    id: _annotationId(t.id),
    source_task_id: String(t.task_id || ''),
    source_trajectory_id: String(t.id || ''),
    title: String(t.title || t.goal || ''),
    url: String(grounded.initial_state?.url || trajectory[0]?.url || '').trim(),
    task_style: _annotationTaskStyle(t),
    goal: String(t.goal || '').trim(),
    arms: { grounding: grounded },
    trajectory,
    agent_answer: String(grounded.answer || '').trim(),
    claims_completion: typeof t.claims_completion === 'boolean' ? t.claims_completion : null,
    in_annotation: t.in_annotation !== false && trajectory.length > 0,
    task_index: Number.isFinite(Number(taskIndex)) ? Number(taskIndex) : 0,
  };
}

// ── the bank ────────────────────────────────────────────────────────────────

async function listAnnotationTrajectories() {
  try {
    const data = await chrome.storage.local.get(PAGEGUIDE_ANNOTATION_TRAJECTORIES_KEY);
    const all = data[PAGEGUIDE_ANNOTATION_TRAJECTORIES_KEY];
    return (all && typeof all === 'object') ? all : {};
  } catch (e) {
    console.warn('[AnnotationTrajectories] read failed:', e);
    return {};
  }
}

async function getAnnotationTrajectory(id) {
  const all = await listAnnotationTrajectories();
  return all[String(id || '').trim()] || null;
}

/** Save one capture. Screenshots are downscaled the same way the study bank does it. */
async function saveAnnotationTrajectory(record, { downscale = true } = {}) {
  const toStore = (downscale && typeof _downscaleGuideTrajectory === 'function')
    ? await _downscaleGuideTrajectory(record)
    : JSON.parse(JSON.stringify(record || {}));
  toStore.updated_at = new Date().toISOString();
  toStore.in_annotation = toStore.in_annotation !== false;
  try {
    const all = await listAnnotationTrajectories();
    all[String(toStore.id || '').trim()] = toStore;
    await chrome.storage.local.set({ [PAGEGUIDE_ANNOTATION_TRAJECTORIES_KEY]: all });
  } catch (e) {
    console.error('[AnnotationTrajectories] local save failed:', e);
    return { saved: false, error: e?.message || 'local save failed' };
  }
  return { saved: true, record: toStore };
}

async function deleteAnnotationTrajectory(id) {
  try {
    const all = await listAnnotationTrajectories();
    delete all[String(id || '').trim()];
    await chrome.storage.local.set({ [PAGEGUIDE_ANNOTATION_TRAJECTORIES_KEY]: all });
    return true;
  } catch (e) {
    console.warn('[AnnotationTrajectories] delete failed:', e);
    return false;
  }
}

// ── publishing ──────────────────────────────────────────────────────────────

/** Same project, headers and admin password as the V2 publishers (study_v2_publish.js). */
function _annotationConfigured() {
  return typeof window._v2Configured === 'function' && window._v2Configured();
}

async function publishAnnotationTask(payload, password) {
  const res = await fetch(`${SUPABASE_V2_URL}/rest/v1/rpc/save_pageguide_annotation_trajectory`, {
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

/**
 * Upsert every ticked trajectory (or just `onlyId`) into pageguide_annotation_trajectories.
 * task_index is capture order, so the annotators' queue runs in the order the runs were made.
 */
async function publishAnnotationTrajectories(records, onlyId = null) {
  if (!_annotationConfigured()) {
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
    if (!onlyId && record.in_annotation === false) continue;
    const payload = buildAnnotationTask(record, i);
    try {
      await publishAnnotationTask(payload, password);
      rows.push({ id: record.id, row_id: payload.id, ok: true, steps: payload.trajectory.length,
        in_annotation: payload.in_annotation });
    } catch (e) {
      rows.push({ id: record.id, row_id: payload.id, ok: false, error: e?.message || String(e) });
    }
  }
  return { ok: true, rows };
}

function describeAnnotationPublish(rows) {
  return (rows || []).map(r => {
    const into = r.row_id && r.row_id !== r.id ? ` → ${r.row_id}` : '';
    if (!r.ok) return `✗ ${r.id}${into} — ${r.error}`;
    return `${r.in_annotation ? '✓' : '◦'} ${r.id}${into} — ${r.steps} steps${r.in_annotation ? '' : ' (hidden from annotators)'}`;
  }).join('\n');
}

/**
 * The file the annotator site can load when Supabase is not in play: the same payloads the RPC
 * would receive, in queue order, so one JSON works for both routes.
 */
function buildAnnotationBundle(records) {
  const queue = (records || [])
    .filter(t => t && t.id && t.in_annotation !== false)
    .sort((a, b) => String(a.captured_at || '').localeCompare(String(b.captured_at || '')));
  return {
    kind: 'pageguide_annotation_trajectories',
    exported_at: new Date().toISOString(),
    trajectories: queue.map((t, i) => buildAnnotationTask(t, i)),
  };
}

if (typeof window !== 'undefined') {
  window.PAGEGUIDE_ANNOTATION_TRAJECTORIES_KEY = PAGEGUIDE_ANNOTATION_TRAJECTORIES_KEY;
  window._annotationId = _annotationId;
  window._annotationTaskStyle = _annotationTaskStyle;
  window.buildAnnotationTask = buildAnnotationTask;
  window.buildAnnotationBundle = buildAnnotationBundle;
  window.listAnnotationTrajectories = listAnnotationTrajectories;
  window.getAnnotationTrajectory = getAnnotationTrajectory;
  window.saveAnnotationTrajectory = saveAnnotationTrajectory;
  window.deleteAnnotationTrajectory = deleteAnnotationTrajectory;
  window.publishAnnotationTrajectories = publishAnnotationTrajectories;
  window.describeAnnotationPublish = describeAnnotationPublish;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _annotationId, _annotationTaskStyle, buildAnnotationTask, buildAnnotationBundle };
}
