// PageGuide User Study V2 — publishing a captured Guide trajectory into the V2 schema
// ===================================================================================
// The Find half already has study_v2_publish.js; this is the same bridge for the Guide half, and it
// is a SEPARATE file for the same reason the two halves are separate tables: they share a project,
// a password and a transport, and nothing else. A guide item's stimulus is a recorded run rather
// than a page, its four cells come from somewhere different, and its ground truth is scored against
// a taxonomy rather than against sentences on a page.
//
// WHAT V2 WANTS (supabase_schema_v2.sql, `pageguide_guide_v2_tasks`):
//   one row per task, carrying the run as `trajectory`, the authored final answers as the same
//   four-cell `answer_variants` Find uses, and the answer key as `guide_ground_truth`.
//
// WHAT THE LOCAL BANK HAS (guide_trajectories.js):
//   one record per capture, with TWO arms — grounded and non-grounded — of ONE run, plus a
//   researcher-authored ground truth saying whether that run actually succeeded.
//
// SO THE CORRECTNESS AXIS IS PINNED, NOT INVENTED. V2 counterbalances correctness × grounding, but
// the guide recorder only ever authors one correctness side: the agent's real answer, grounded and
// bare. Which side that is is already recorded — `ground_truth.correctness` — so a failed run is
// published into the two `incorrect_*` cells under `always_incorrect`, and a successful one into
// the two `correct_*` cells under `always_correct`. Writing the run's real answer into a cell the
// ground truth contradicts would make the item score every participant wrong, so the mapping reads
// the verdict rather than defaulting to "correct".
//
// TWO HALVES, split so the mapping can be tested without a network:
//   buildGuideV2Task   — pure. A banked trajectory in, the RPC's `p_task` payload out.
//   publishGuideV2Task — the fetch.
//
// The admin password is shared with study_v2_publish.js (ensureV2AdminPassword), so publishing both
// halves in one sitting asks for it once and it still dies with the tab.

(function () {
  'use strict';

  /** Same project as the Find half; both helpers read the one config. */
  function _configured() {
    return typeof window._v2Configured === 'function' && window._v2Configured();
  }

  function _headers() {
    return window._v2Headers();
  }

  /**
   * A V2 item id out of a local trajectory id.
   *
   * The RPC enforces `^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$`, and a local id is a rewind session id —
   * usually already safe, but it is not this file's to guarantee. Rewritten DETERMINISTICALLY so
   * re-publishing an edited trajectory lands on the same row instead of creating a second one, and
   * the untouched original still travels as `source_task_id`.
   */
  function _guideV2Id(raw) {
    const cleaned = String(raw == null ? '' : raw).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
    const trimmed = cleaned.replace(/^[^A-Za-z0-9]+/, '');
    if (trimmed.length >= 2) return trimmed;
    // Nothing usable survived. Prefixing keeps it publishable and keeps it traceable.
    return `guide-${cleaned || 'item'}`.slice(0, 80);
  }

  /**
   * guide_visual vs guide_text, from the condition the researcher assigned.
   *
   * The assignment is the authority, not the presence of screenshots: `_inferGuideCondition` only
   * ever guesses at capture time and the researcher can override it, so re-deriving it here would
   * quietly overrule that override. An unassigned trajectory falls back to the guess.
   */
  function _guideTaskStyle(record) {
    let condition = record?.condition;
    if (!condition && typeof window._inferGuideCondition === 'function') {
      condition = window._inferGuideCondition(record?.arms?.grounding);
    }
    return condition === 'visual' ? 'guide_visual' : 'guide_text';
  }

  /** Which pair of cells this run's answer belongs in, from the researcher's verdict. */
  function _guideCorrectnessSide(groundTruth) {
    return groundTruth?.correctness === 'failure' ? 'incorrect' : 'correct';
  }

  /**
   * MATCHING A LOCAL CAPTURE TO THE ROW IT ALREADY HAS ON V2.
   *
   * Not by id. Every row that predates this file carries `source_task_id: null` and an id from a
   * different scheme than the local bank's, so an id comparison says "new" about a task that is
   * already live — and publishing then writes a SECOND row for it. Two rows for one task, both in
   * the queue, differing in step count, is the failure this matcher exists to prevent.
   *
   * The goal is the identity that actually survives: it is the sentence the agent was given and the
   * sentence the participant reads, it is stable across re-captures of the same task, and it is
   * what a researcher means by "the same task". Normalized before comparing, because the copy that
   * reached V2 and the copy in the bank differ in whitespace and trailing punctuation often enough
   * to matter.
   */
  function _normalizeGuideGoal(text) {
    return String(text == null ? '' : text)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[.,;:!?\s]+$/, '')
      .trim();
  }

  /**
   * The V2 row this trajectory should be published INTO, or null to create a new one.
   *
   * Tried in order of how much the match can be trusted: the id V2 was told to remember, then the
   * id itself, then the goal. The first two are exact; the third is a judgement, and it is the only
   * one that can find a row published from another machine.
   *
   * WHEN SEVERAL ROWS SHARE A GOAL — which is exactly the mess this is being introduced to clean up
   * — the LIVE one wins, and the most recently updated one breaks a remaining tie. The live row is
   * the one participants are walking, so it is the one an edit has to land on; replacing a stale
   * draft instead would leave the live copy untouched and make the edit look lost.
   */
  function matchGuideV2Row(v2Rows, record) {
    const rows = Array.isArray(v2Rows) ? v2Rows.filter(Boolean) : [];
    const localId = String(record?.id || '');
    if (localId) {
      // source_trajectory_id FIRST. It is the id of the capture in this bank, it is what every row
      // seeded by hand is keyed to, and it is the only exact handle those rows have — matching on
      // it turns what used to be a goal-text guess into an identity.
      const byTrajectory = rows.find(r => String(r.source_trajectory_id || '') === localId);
      if (byTrajectory) return byTrajectory;
      const bySource = rows.find(r => String(r.source_task_id || '') === localId);
      if (bySource) return bySource;
      const wantId = _guideV2Id(localId);
      const byId = rows.find(r => String(r.id || '') === localId || String(r.id || '') === wantId);
      if (byId) return byId;
    }
    const goal = _normalizeGuideGoal(record?.goal || record?.title);
    if (!goal) return null;
    const sameGoal = rows.filter(r => _normalizeGuideGoal(r.goal || r.title) === goal);
    if (!sameGoal.length) return null;
    return sameGoal.slice().sort((a, b) => {
      if (!!a.in_study !== !!b.in_study) return a.in_study ? -1 : 1;
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    })[0];
  }

  /** One cell of `answer_variants`, in the shape pageguide_v2_normalize_variants rebuilds anyway. */
  function _variantPayload(arm) {
    return {
      answer_text: String(arm?.answer || '').trim(),
      // A guide answer cites its evidence with [ev:key] markers, which resolve against the arm's
      // own captures rather than against elements on a page — so there are no citation anchors to
      // send, and an empty array is the honest value rather than a placeholder.
      citation_anchors: [],
      evidence: Array.isArray(arm?.answer_evidence) ? arm.answer_evidence : []
    };
  }

  /**
   * THE STIMULUS: both arms of the run, verbatim.
   *
   * This is what `arms` holds and what the site renders, and passing it through untouched is the
   * point — it carries the per-step screenshots, the answer evidence, AND the initial/final
   * bookends, which have no column of their own and are the only thing telling a participant
   * whether the task got done.
   *
   * Not rebuilt field by field, deliberately: the recorder owns this shape (`_stripGuideArm`,
   * guide_trajectories.js), the rows already on V2 are in exactly it, and a copy that reshaped it
   * here would drift from both the moment either changed.
   */
  function _armsPayload(record) {
    const arms = record?.arms;
    if (!arms || typeof arms !== 'object') return {};
    return {
      grounding: arms.grounding || null,
      nongrounding: arms.nongrounding || null
    };
  }

  /**
   * The run itself, as the array `trajectory` expects.
   *
   * A FLATTENED VIEW, not the stimulus — `arms` is the stimulus. Kept because the column exists and
   * something may still read it, and because it is the shape supabase_schema_v2.sql documents.
   *
   * Taken from the GROUNDED arm, because it is the only arm that carries the screenshots: the bare
   * arm is that same run with its grounding stripped, which is a derivation the site can redo but
   * not undo.
   *
   * `index` is the schema's name and `n` is the recorder's; both are written, and both are the same
   * number, because a participant's error answer names a step by it and a renumber between the two
   * would silently move every recorded error one step along.
   */
  function _trajectoryPayload(arm) {
    const steps = Array.isArray(arm?.steps) ? arm.steps : [];
    return steps.map((step, i) => ({
      index: Number.isFinite(Number(step?.n)) ? Number(step.n) : i + 1,
      n: Number.isFinite(Number(step?.n)) ? Number(step.n) : i + 1,
      instruction: step?.instruction || '',
      action: step?.action || '',
      target_text: step?.target_text || '',
      url: step?.url || '',
      screenshot: step?.screenshot || null,
      note: step?.note || ''
    }));
  }

  /**
   * The answer key, translated into the shape the schema documents.
   *
   * FLATTENED: the recorder groups steps under one error ({type, steps:[3,5]}) because that is how
   * a researcher thinks about it, while the schema stores one entry per place it happened
   * ({step, type}). Flattening here rather than storing the grouped form keeps the site's scoring
   * from having to know both shapes; `errors_grouped` rides along so nothing is lost.
   *
   * `correct` is only written when a verdict actually exists. The RPC refuses a live item without
   * it, and that refusal is the point — an unset verdict must not publish as "the agent failed".
   */
  function _groundTruthPayload(groundTruth) {
    const gt = groundTruth || {};
    const grouped = Array.isArray(gt.errors) ? gt.errors : [];
    const flat = [];
    grouped.forEach(e => {
      (Array.isArray(e?.steps) ? e.steps : []).forEach(step => {
        const n = Number(step);
        if (Number.isFinite(n)) flat.push({ step: n, type: e.type });
      });
    });
    const out = {
      problems: Array.isArray(gt.problems) ? gt.problems : [],
      problem: String(gt.problem || '').trim(),
      errors: flat,
      errors_grouped: grouped,
      no_error: !!gt.no_error
    };
    if (gt.correctness === 'success' || gt.correctness === 'failure') {
      out.correct = gt.correctness === 'success';
    }
    return out;
  }

  /**
   * The `p_task` payload for one trajectory. Pure — every input is passed in.
   *
   * @param {{record: object, taskIndex?: number, v2Row?: object|null}} ctx
   *   v2Row - the row this task already occupies on V2 (matchGuideV2Row), or null to create one
   * @returns {object} the payload, plus a non-wire `_missing` list explaining any refusal
   */
  function buildGuideV2Task(ctx) {
    const { record, taskIndex, v2Row } = ctx || {};
    const t = record || {};
    const grounded = t.arms?.grounding || null;
    const bare = t.arms?.nongrounding || null;

    const side = _guideCorrectnessSide(t.ground_truth);
    const variants = {
      correct_grounding: { answer_text: '', citation_anchors: [], evidence: [] },
      correct_nongrounding: { answer_text: '', citation_anchors: [], evidence: [] },
      incorrect_grounding: { answer_text: '', citation_anchors: [], evidence: [] },
      incorrect_nongrounding: { answer_text: '', citation_anchors: [], evidence: [] }
    };
    variants[`${side}_grounding`] = _variantPayload(grounded);
    variants[`${side}_nongrounding`] = _variantPayload(bare);

    const arms = _armsPayload(t);
    const trajectory = _trajectoryPayload(grounded);
    const guideGroundTruth = _groundTruthPayload(t.ground_truth);
    const goal = String(t.goal || t.title || '').trim();

    // The two facts the site keeps apart, because an agent that failed and announced success reads
    // very differently from one that failed and said so — and only the first is a hallucination.
    //
    // `agent_completed` is the researcher's verdict, and is the same fact as guide_ground_truth's
    // `correct`. `claims_completion` has NO direct counterpart in the recorder, so it is DERIVED:
    // an agent that "could not complete" is the one case where the run itself reports the failure,
    // and every other case is one where the answer asserts the task was done. Left null when there
    // is no verdict yet, because false would read as a recorded finding rather than as silence.
    const verdict = t.ground_truth?.correctness;
    const agentCompleted = verdict === 'success' ? true : (verdict === 'failure' ? false : null);
    const problems = Array.isArray(t.ground_truth?.problems) ? t.ground_truth.problems : [];
    const claimsCompletion = agentCompleted === null
      ? null
      : (agentCompleted ? true : !problems.includes('could_not_complete'));

    // Mirrors the RPC's own gates so a refusal is explained here, in the panel, naming what is
    // missing — rather than arriving as a raw Postgres exception after the screenshots are on the
    // wire. Kept in the order a researcher would fix them.
    const missing = [];
    if (!goal) missing.push('goal');
    // Counted over the arms, which is where the run lives and what the RPC now gates on.
    if (!(arms.grounding?.steps || []).length) missing.push('steps');
    if (!variants[`${side}_grounding`].answer_text) missing.push(`${side}_grounding answer`);
    if (!variants[`${side}_nongrounding`].answer_text) missing.push(`${side}_nongrounding answer`);
    if (!Object.prototype.hasOwnProperty.call(guideGroundTruth, 'correct')) {
      missing.push('ground truth verdict');
    } else if (typeof window._guideGroundTruthProblem === 'function') {
      const problem = window._guideGroundTruthProblem(t.ground_truth);
      if (problem) missing.push('ground truth');
    }
    // The researcher's own switch. An excluded trajectory goes up as a draft rather than being held
    // back, so re-including it later is one publish and not a hunt for what was never uploaded.
    const excluded = t.in_study === false;
    if (excluded) missing.push('excluded here');

    // Pinned, never 'balanced': only one correctness side is ever authored locally — see the header.
    const correctnessMode = side === 'incorrect' ? 'always_incorrect' : 'always_correct';

    return {
      // The EXISTING row's id when this task already has one, so a re-publish updates in place.
      // Deriving it from the local id instead is what put two rows on V2 for one task: the bank and
      // the project use different id schemes, and the RPC upserts on id, so a fresh id is a fresh
      // row however obviously it is the same task.
      id: v2Row?.id ? String(v2Row.id) : _guideV2Id(t.id),
      // BOTH, and always equal. source_trajectory_id is the column the rows seeded by hand are
      // keyed to and the one the matcher reads first; source_task_id is what this file wrote before
      // that was known. Keeping them the same value is what makes a row published from here
      // indistinguishable from one seeded by hand, which is the whole point of standardizing.
      source_task_id: String(t.id || ''),
      source_trajectory_id: String(t.id || ''),
      title: t.title || t.goal || '',
      // Where the run started, so the site can say what page this was. The bookends are not columns
      // of their own, so the initial URL is the one piece of them the schema has room for.
      url: String(grounded?.initial_state?.url || trajectory[0]?.url || '').trim(),
      task_style: _guideTaskStyle(t),
      goal,
      answer_variants: variants,
      correctness_mode: correctnessMode,
      arms,
      trajectory,
      guide_ground_truth: guideGroundTruth,
      agent_completed: agentCompleted,
      claims_completion: claimsCompletion,
      in_study: !missing.length,
      task_index: Number.isFinite(Number(taskIndex)) ? Number(taskIndex) : 0,
      _missing: missing
    };
  }

  /**
   * Upsert one task. `_missing` is stripped: it is the panel's explanation of what is not authored
   * yet, not a column, and the RPC would ignore it anyway.
   */
  async function publishGuideV2Task(payload, password) {
    const { _missing, ...task } = payload || {};
    const res = await fetch(`${SUPABASE_V2_URL}/rest/v1/rpc/save_pageguide_guide_v2_task`, {
      method: 'POST',
      headers: _headers(),
      body: JSON.stringify({ p_password: password, p_task: task })
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
   * WHAT A PUBLISH WILL DO, decided before anything is sent. Pure, so it is testable and so the
   * panel can show it as a preview rather than as a report of what already happened.
   *
   * THE TICK IS THE WHOLE FILTER. A ticked trajectory is published; an unticked one is not written
   * at all, whatever state it is in:
   *
   *   create  — ticked, no row on V2 yet. A capture from this run going up for the first time.
   *   update  — ticked, already on V2. Written into the row it already occupies.
   *   skip    — not ticked. Nothing is sent for it.
   *
   * A CONSEQUENCE WORTH KNOWING, because the panel has to say it out loud: unticking something that
   * is already live on V2 does not take it down. Publish only ever writes what is ticked, so a row
   * published earlier stays live until it is changed in Supabase. The list flags that case rather
   * than quietly demoting the row, because a publish that silently unpublishes is a worse surprise
   * than one that leaves a row alone.
   *
   * `task_index` is the position in the LOCAL queue, assigned across everything being published, so
   * the participant's order comes from one place. The existing rows' indexes are overwritten on
   * purpose: V2 currently holds two rows claiming index 12, which is the kind of thing that only
   * gets fixed by having a single authority for it.
   *
   * @param {Array<object>} records - the banked trajectories, in queue order
   * @param {Array<object>} v2Rows - what listGuideV2Tasks returned
   * @param {string|null} [onlyId] - narrow to one trajectory, for checking
   * @returns {Array<{record: object, v2Row: object|null, action: string, taskIndex: number}>}
   */
  function planGuideV2Publish(records, v2Rows, onlyId = null) {
    const all = (records || []).filter(t => t && t.id);
    return all.map((record, taskIndex) => {
      const v2Row = matchGuideV2Row(v2Rows, record);
      const ticked = record.in_study !== false;
      const action = ticked ? (v2Row ? 'update' : 'create') : 'skip';
      return { record, v2Row, action, taskIndex };
    }).filter(step => (!onlyId || String(step.record.id) === String(onlyId)) && step.action !== 'skip');
  }

  /**
   * V2 rows that no local trajectory claimed.
   *
   * A LIVE one is the case worth acting on: it is in the participant's queue, this bank cannot
   * update it, and nothing here will take it down. A draft one is harmless and is reported only so
   * the count adds up.
   */
  function unmatchedGuideV2Rows(records, v2Rows) {
    const claimed = new Set();
    (records || []).forEach(record => {
      const row = matchGuideV2Row(v2Rows, record);
      if (row?.id) claimed.add(String(row.id));
    });
    return (v2Rows || []).filter(r => r?.id && !claimed.has(String(r.id)));
  }

  /**
   * Publish the TICKED trajectories, and only those — into the rows they already occupy where they
   * have one, as new rows where they do not. See planGuideV2Publish.
   *
   * A ticked trajectory with something unauthored still goes up, as `in_study: false` — the same
   * rule the Find half follows, for the same reason: a half-authored item visible on the site as a
   * draft is fixable, whereas one held back locally looks exactly like one that was never written.
   *
   * ONE AT A TIME, in order, so a failure names the trajectory it happened on: a guide row carries a
   * dozen screenshots and is the biggest single payload in the study.
   *
   * V2 IS RE-READ FIRST unless the caller passes what it already has. Publishing against a stale
   * picture is how the duplicate rows appear: a task matched as "new" against a list fetched before
   * someone else published it gets a second row.
   *
   * @param {Array<object>} records - the banked trajectories, in the order they should be walked
   * @param {{onlyId?: string|null, v2Rows?: Array<object>|null}} [opts]
   * @returns {Promise<{ok: boolean, error?: string, rows: Array<object>}>}
   */
  async function publishGuideV2(records, opts = {}) {
    // Called as publishGuideV2(rows, 'some-id') before the options object existed.
    const { onlyId = null, v2Rows = null } = (typeof opts === 'string' || opts === null)
      ? { onlyId: opts }
      : (opts || {});

    if (!_configured()) {
      return { ok: false, error: 'V2 Supabase is not configured — set SUPABASE_V2_URL and '
        + 'SUPABASE_V2_ANON_KEY in sidepanel/supabase_config.js.', rows: [] };
    }
    const password = await window.ensureV2AdminPassword();
    if (!password) return { ok: false, error: 'Wrong or no admin password.', rows: [] };

    let known = v2Rows;
    if (!Array.isArray(known)) {
      const read = await listGuideV2Tasks();
      if (!read.ok) return { ok: false, error: `Could not read V2 first: ${read.error}`, rows: [] };
      known = read.rows;
    }

    const plan = planGuideV2Publish(records, known, onlyId);
    const rows = [];
    for (const step of plan) {
      const { record, v2Row, action, taskIndex } = step;
      let payload = null;
      try {
        payload = buildGuideV2Task({ record, taskIndex, v2Row });
        await publishGuideV2Task(payload, password);
        rows.push({
          id: record.id,
          v2_id: payload.id,
          action,
          ok: true,
          in_study: payload.in_study,
          missing: payload._missing,
          steps: (payload.arms?.grounding?.steps || []).length,
          bytes: JSON.stringify(payload.arms || {}).length
        });
      } catch (e) {
        rows.push({
          id: record.id,
          v2_id: payload?.id || v2Row?.id || _guideV2Id(record.id),
          action,
          ok: false,
          missing: [],
          error: e?.message || String(e)
        });
      }
    }
    return { ok: true, rows };
  }

  /**
   * What V2 currently holds, so the panel can show what is already published without guessing.
   *
   * Read with the anon key and no password: `pageguide_guide_v2_tasks` is granted SELECT to anon
   * (the participant site reads it the same way), and only writing is password-gated. The
   * screenshots are deliberately NOT selected — `trajectory` is megabytes per row and this is a
   * status list, not a download.
   *
   * @returns {Promise<{ok: boolean, error?: string, byId: object, rows: Array<object>}>}
   */
  async function listGuideV2Tasks() {
    if (!_configured()) {
      return { ok: false, error: 'V2 Supabase is not configured.', byId: {}, rows: [] };
    }
    try {
      // source_trajectory_id is what matchGuideV2Row keys on, so it is not optional here — a select
      // that omits it silently downgrades every match to a goal-text guess.
      const select = 'id,source_task_id,source_trajectory_id,title,goal,url,task_style,'
        + 'correctness_mode,step_count,trajectory_bytes,agent_completed,claims_completion,'
        + 'in_study,task_index,updated_at';
      const res = await fetch(
        `${SUPABASE_V2_URL}/rest/v1/pageguide_guide_v2_tasks?select=${select}&order=task_index.asc`,
        { headers: _headers() });
      if (!res.ok) throw new Error(`read failed (${res.status})`);
      const rows = await res.json();
      const byId = {};
      // Keyed BOTH ways. `source_task_id` is the local trajectory id and is what the panel has in
      // hand; `id` is the sanitized copy, and is the only key a row published before source_task_id
      // was written would answer to.
      (Array.isArray(rows) ? rows : []).forEach(row => {
        if (row?.source_trajectory_id) byId[String(row.source_trajectory_id)] = row;
        if (row?.source_task_id && !byId[String(row.source_task_id)]) byId[String(row.source_task_id)] = row;
        if (row?.id && !byId[String(row.id)]) byId[String(row.id)] = row;
      });
      return { ok: true, byId, rows: Array.isArray(rows) ? rows : [] };
    } catch (e) {
      return { ok: false, error: e?.message || String(e), byId: {}, rows: [] };
    }
  }

  /**
   * One readable line per trajectory. Pure, so the report can be tested.
   *
   * The V2 id is named whenever it differs from the local one — that is the whole answer to "did
   * this update the row I meant, or make a new one?", and it is not guessable from the local id.
   */
  function describeGuideV2Publish(rows) {
    return (rows || []).map(r => {
      const into = r.v2_id && r.v2_id !== r.id ? ` → ${r.v2_id}` : '';
      if (!r.ok) return `✗ ${r.id}${into} — ${r.error}`;
      const verb = r.action === 'update' ? 'updated' : 'created';
      if (r.in_study) return `✓ ${r.id}${into} — live, ${verb} (${r.steps} steps)`;
      return `◦ ${r.id}${into} — ${verb} as a draft, not live yet `
        + `(missing: ${(r.missing || []).join(', ')})`;
    }).join('\n');
  }

  if (typeof window !== 'undefined') {
    window._guideV2Id = _guideV2Id;
    window._guideTaskStyle = _guideTaskStyle;
    window._guideCorrectnessSide = _guideCorrectnessSide;
    window._normalizeGuideGoal = _normalizeGuideGoal;
    window.matchGuideV2Row = matchGuideV2Row;
    window.planGuideV2Publish = planGuideV2Publish;
    window.unmatchedGuideV2Rows = unmatchedGuideV2Rows;
    window.buildGuideV2Task = buildGuideV2Task;
    window.publishGuideV2Task = publishGuideV2Task;
    window.publishGuideV2 = publishGuideV2;
    window.listGuideV2Tasks = listGuideV2Tasks;
    window.describeGuideV2Publish = describeGuideV2Publish;
  }
})();
