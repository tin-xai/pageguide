// PageGuide annotator site — the pure half.
// ========================================
// Everything here is a function of its arguments: no DOM, no fetch, no storage. annotate.js does
// the wiring; this file is what e2e-tests/unit/logic.test.js exercises.
//
// TWO LEVELS, NEVER AVERAGED INTO ONE. A step-level label says whether ONE action served the goal;
// the answer-level verdict says whether the RUN got the task done. A run can be right at every step
// and still hallucinate its answer, or misclick twice and recover. Agreement is reported per level.

(function (root) {
  'use strict';

  /** The step-level error types — the same vocabulary as the user study (GUIDE_ERROR_TYPES). */
  const ANNOT_ERROR_TYPES = [
    { id: 'loop', label: 'Loop / no progress — stuck without advancing.' },
    { id: 'mismatch', label: 'Action–goal mismatch — valid on the page but does not serve the goal.' },
    { id: 'wrong_target', label: 'Wrong target / misclick — clicked the wrong element.' },
  ];

  /** The answer-level problem types — the same vocabulary as the user study (GUIDE_PROBLEM_TYPES). */
  const ANNOT_PROBLEM_TYPES = [
    { id: 'hallucinated_result', label: 'Hallucinated result — the answer is not supported by the page.' },
    { id: 'incomplete', label: 'Incomplete — only part of the task was completed.' },
    { id: 'could_not_complete', label: 'Could not complete — the agent could not finish the task.' },
  ];

  /**
   * The evidence-level problem types. THIS is what the annotation is about now: for every piece of
   * evidence the agent saved with its answer (and every [ev:…] marker it cited without saving a
   * crop), is it correct and relevant to the task? Step labels and the answer verdict are still
   * recorded when given, but completion and agreement are computed on evidence alone.
   */
  const ANNOT_EVIDENCE_PROBLEMS = [
    { id: 'irrelevant', label: 'Irrelevant — not about what the task asked for.' },
    { id: 'unsupported', label: 'Does not support the claim — the crop does not show what the answer says it shows.' },
    { id: 'wrong_region', label: 'Wrong region — the crop is of the wrong element or area of the page.' },
    { id: 'missing', label: 'Missing — no crop was saved for this marker.' },
  ];

  /**
   * Clean one annotation into the shape save_pageguide_annotation stores. Tolerant on the way in
   * (a half-filled form must be savable as a draft), strict on the way out.
   *
   * @returns {{trajectory_id, annotator_id, step_labels: Array<{step, correct, error_type, note}>,
   *            answer_correct: boolean|null, answer_problems: string[], answer_note, duration_ms}}
   */
  function normalizeAnnotation(raw) {
    const src = raw || {};
    const validErr = new Set(ANNOT_ERROR_TYPES.map(t => t.id));
    const validProb = new Set(ANNOT_PROBLEM_TYPES.map(t => t.id));
    const steps = (Array.isArray(src.step_labels) ? src.step_labels : [])
      .map(l => ({
        step: Number(l?.step),
        correct: l?.correct === true ? true : (l?.correct === false ? false : null),
        error_type: l?.correct === false && validErr.has(l?.error_type) ? l.error_type : '',
        note: String(l?.note || '').trim(),
      }))
      .filter(l => Number.isFinite(l.step) && l.step > 0)
      .sort((a, b) => a.step - b.step);
    const validEvProb = new Set(ANNOT_EVIDENCE_PROBLEMS.map(t => t.id));
    const seenKeys = new Set();
    const evidence = (Array.isArray(src.evidence_labels) ? src.evidence_labels : [])
      .map(l => ({
        key: String(l?.key == null ? '' : l.key).trim(),
        correct: l?.correct === true ? true : (l?.correct === false ? false : null),
        problem: l?.correct === false && validEvProb.has(l?.problem) ? l.problem : '',
        note: String(l?.note || '').trim(),
      }))
      .filter(l => l.key && !seenKeys.has(l.key) && seenKeys.add(l.key));
    const evidenceCount = Number.isFinite(Number(src.evidence_count)) ? Math.max(0, Math.round(Number(src.evidence_count))) : evidence.length;
    const answerCorrect = src.answer_correct === true ? true : (src.answer_correct === false ? false : null);
    return {
      trajectory_id: String(src.trajectory_id || '').trim(),
      annotator_id: String(src.annotator_id || '').trim(),
      step_labels: steps,
      evidence_labels: evidence,
      evidence_count: evidenceCount,
      answer_correct: answerCorrect,
      // Problems only mean something on a failed answer.
      answer_problems: answerCorrect === false
        ? [...new Set((Array.isArray(src.answer_problems) ? src.answer_problems : []).filter(p => validProb.has(p)))]
        : [],
      answer_note: String(src.answer_note || '').trim(),
      duration_ms: Number.isFinite(Number(src.duration_ms)) ? Math.max(0, Math.round(Number(src.duration_ms))) : null,
    };
  }

  /**
   * What is still unanswered, or null when the annotation can be submitted.
   *
   * ONLY the evidence gates submission: every evidence item in `evidenceKeys` needs a verdict, and
   * an incorrect one needs a problem type. Step labels and the answer verdict are optional extras
   * — they are stored if given, never required. (`stepCount` is accepted for call compatibility
   * and ignored.)
   */
  function annotationProblem(annotation, stepCount, evidenceKeys) {
    const a = normalizeAnnotation(annotation);
    if (!a.annotator_id) return 'Choose Annotator A or B first.';
    const keys = Array.isArray(evidenceKeys) ? evidenceKeys.map(k => String(k)) : a.evidence_labels.map(l => l.key);
    const byKey = new Map(a.evidence_labels.map(l => [l.key, l]));
    const missing = keys.filter(k => !byKey.has(k) || byKey.get(k).correct === null);
    if (missing.length) return `Evidence ${missing.map(k => `ev:${k}`).join(', ')} not graded yet.`;
    const noProblem = keys.filter(k => byKey.get(k).correct === false && !byKey.get(k).problem);
    if (noProblem.length) return `Pick a problem for ${noProblem.map(k => `ev:${k}`).join(', ')}.`;
    return null;
  }

  /** A saved annotation counts as complete when every evidence item it was shown has a verdict. */
  function annotationComplete(annotation) {
    const a = normalizeAnnotation(annotation);
    const graded = a.evidence_labels.filter(l => l.correct !== null).length;
    return graded >= a.evidence_count;
  }

  /** A fresh annotation's evidence labels: one per item, ungraded — the annotator must decide each. */
  function defaultEvidenceLabels(evidence) {
    const seen = new Set();
    return (Array.isArray(evidence) ? evidence : [])
      .map(e => String(e?.key == null ? '' : e.key).trim())
      .filter(k => k && !seen.has(k) && seen.add(k))
      .map(key => ({ key, correct: null, problem: '', note: '' }));
  }

  /** The evidence items both annotators graded, by key, in the first annotator's order. */
  function pairEvidenceLabels(x, y) {
    const byKey = (ann) => new Map(normalizeAnnotation(ann).evidence_labels.filter(l => l.correct !== null).map(l => [l.key, l]));
    const mx = byKey(x), my = byKey(y);
    return [...mx.keys()].filter(k => my.has(k)).map(k => ({ key: k, a: mx.get(k), b: my.get(k) }));
  }

  /**
   * Cohen's kappa over two equally long label sequences. Labels are compared with ===, so callers
   * pass primitives. null when there is nothing to compare, or when the expected agreement is 1
   * (both raters used one label everywhere — kappa is undefined there, and 0 would read as chance).
   */
  function cohensKappa(a, b) {
    const n = Math.min(Array.isArray(a) ? a.length : 0, Array.isArray(b) ? b.length : 0);
    if (!n) return null;
    let observed = 0;
    const countA = new Map();
    const countB = new Map();
    for (let i = 0; i < n; i++) {
      if (a[i] === b[i]) observed++;
      countA.set(a[i], (countA.get(a[i]) || 0) + 1);
      countB.set(b[i], (countB.get(b[i]) || 0) + 1);
    }
    let expected = 0;
    countA.forEach((ca, label) => { expected += (ca / n) * ((countB.get(label) || 0) / n); });
    const po = observed / n;
    if (expected >= 1) return null;
    return (po - expected) / (1 - expected);
  }

  /** Observed agreement as a fraction; null when empty. */
  function percentAgreement(a, b) {
    const n = Math.min(Array.isArray(a) ? a.length : 0, Array.isArray(b) ? b.length : 0);
    if (!n) return null;
    let hit = 0;
    for (let i = 0; i < n; i++) if (a[i] === b[i]) hit++;
    return hit / n;
  }

  /**
   * Line two annotators' step labels up by step number. Only steps BOTH graded are compared, so a
   * draft with step 4 missing does not count as a disagreement on step 4.
   */
  function pairStepLabels(x, y) {
    const byStep = (ann) => new Map(normalizeAnnotation(ann).step_labels
      .filter(l => l.correct !== null).map(l => [l.step, l]));
    const mx = byStep(x);
    const my = byStep(y);
    const steps = [...mx.keys()].filter(n => my.has(n)).sort((p, q) => p - q);
    return steps.map(n => ({ step: n, a: mx.get(n), b: my.get(n) }));
  }

  /**
   * Agreement between two annotators over a set of trajectories.
   *
   * @param {Array<{id, step_count}>} trajectories
   * @param {Array<object>} results - every annotation row, any annotator
   * @param {string} annotatorA
   * @param {string} annotatorB
   * @returns {{perTrajectory: Array, overall: object}}
   */
  function agreementReport(trajectories, results, annotatorA, annotatorB) {
    const rows = (Array.isArray(results) ? results : []).map(normalizeAnnotation);
    const find = (tid, who) => rows.find(r => r.trajectory_id === String(tid) && r.annotator_id === who) || null;

    const allStepA = [], allStepB = [], allErrA = [], allErrB = [], allAnsA = [], allAnsB = [];
    const allEvA = [], allEvB = [], allEvPA = [], allEvPB = [];
    const perTrajectory = (Array.isArray(trajectories) ? trajectories : []).map(t => {
      const a = find(t.id, annotatorA);
      const b = find(t.id, annotatorB);
      const both = !!(a && b);
      const pairs = both ? pairStepLabels(a, b) : [];
      const stepA = pairs.map(p => p.a.correct);
      const stepB = pairs.map(p => p.b.correct);
      // Error type only where both said "incorrect": the type question is not asked on a correct step.
      const errPairs = pairs.filter(p => p.a.correct === false && p.b.correct === false);
      const errA = errPairs.map(p => p.a.error_type);
      const errB = errPairs.map(p => p.b.error_type);
      const ansComparable = both && a.answer_correct !== null && b.answer_correct !== null;
      // Evidence — the primary measure. Problem type only where both said "incorrect".
      const evPairs = both ? pairEvidenceLabels(a, b) : [];
      const evA = evPairs.map(p => p.a.correct), evB = evPairs.map(p => p.b.correct);
      const evProbPairs = evPairs.filter(p => p.a.correct === false && p.b.correct === false);
      const evPA = evProbPairs.map(p => p.a.problem), evPB = evProbPairs.map(p => p.b.problem);
      if (both) {
        allStepA.push(...stepA); allStepB.push(...stepB);
        allErrA.push(...errA); allErrB.push(...errB);
        allEvA.push(...evA); allEvB.push(...evB);
        allEvPA.push(...evPA); allEvPB.push(...evPB);
      }
      if (ansComparable) { allAnsA.push(a.answer_correct); allAnsB.push(b.answer_correct); }
      return {
        id: String(t.id),
        title: t.title || t.goal || String(t.id),
        step_count: Number(t.step_count) || 0,
        has_a: !!a,
        has_b: !!b,
        complete_a: !!a && annotationComplete(a),
        complete_b: !!b && annotationComplete(b),
        evidence_compared: evPairs.length,
        evidence_agreement: percentAgreement(evA, evB),
        evidence_kappa: cohensKappa(evA, evB),
        disagreeing_evidence: evPairs.filter(p => p.a.correct !== p.b.correct).map(p => p.key),
        evidence_problem_agreement: percentAgreement(evPA, evPB),
        steps_compared: pairs.length,
        step_agreement: percentAgreement(stepA, stepB),
        step_kappa: cohensKappa(stepA, stepB),
        disagreeing_steps: pairs.filter(p => p.a.correct !== p.b.correct).map(p => p.step),
        error_type_agreement: percentAgreement(errA, errB),
        answer_a: a ? a.answer_correct : null,
        answer_b: b ? b.answer_correct : null,
        answer_agree: ansComparable ? a.answer_correct === b.answer_correct : null,
      };
    });

    return {
      perTrajectory,
      overall: {
        trajectories_both: perTrajectory.filter(r => r.has_a && r.has_b).length,
        trajectories_complete_both: perTrajectory.filter(r => r.complete_a && r.complete_b).length,
        evidence_compared: allEvA.length,
        evidence_agreement: percentAgreement(allEvA, allEvB),
        evidence_kappa: cohensKappa(allEvA, allEvB),
        evidence_problem_agreement: percentAgreement(allEvPA, allEvPB),
        steps_compared: allStepA.length,
        step_agreement: percentAgreement(allStepA, allStepB),
        step_kappa: cohensKappa(allStepA, allStepB),
        error_type_agreement: percentAgreement(allErrA, allErrB),
        answers_compared: allAnsA.length,
        answer_agreement: percentAgreement(allAnsA, allAnsB),
        answer_kappa: cohensKappa(allAnsA, allAnsB),
      },
    };
  }

  /** Every annotator id seen in the results, sorted. */
  function listAnnotators(results) {
    return [...new Set((Array.isArray(results) ? results : [])
      .map(r => String(r?.annotator_id || '').trim()).filter(Boolean))].sort();
  }

  /** The per-trajectory report as CSV, for the spreadsheet everyone ends up in anyway. */
  function agreementCsv(report) {
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const fmt = (v) => v == null ? '' : (typeof v === 'number' ? v.toFixed(3) : v);
    const head = ['trajectory_id', 'title', 'evidence_compared', 'evidence_agreement', 'evidence_kappa',
      'disagreeing_evidence', 'evidence_problem_agreement', 'complete_a', 'complete_b',
      'step_count', 'steps_compared', 'step_agreement', 'step_kappa',
      'disagreeing_steps', 'error_type_agreement', 'answer_a', 'answer_b', 'answer_agree'];
    const lines = [head.join(',')];
    (report?.perTrajectory || []).forEach(r => {
      lines.push([r.id, r.title, r.evidence_compared, fmt(r.evidence_agreement), fmt(r.evidence_kappa),
        (r.disagreeing_evidence || []).join(' '), fmt(r.evidence_problem_agreement), r.complete_a, r.complete_b,
        r.step_count, r.steps_compared, fmt(r.step_agreement), fmt(r.step_kappa),
        r.disagreeing_steps.join(' '), fmt(r.error_type_agreement), r.answer_a, r.answer_b, r.answer_agree]
        .map(esc).join(','));
    });
    return lines.join('\n');
  }

  /**
   * A fresh annotation's step labels: every step starts CORRECT. The annotator's job is to flag the
   * steps that did not serve the goal, not to confirm each one — most steps in a run are fine, and
   * grading them one by one was the slow part. Submit still requires the answer-level verdict.
   */
  function defaultStepLabels(steps) {
    return (Array.isArray(steps) ? steps : []).map((st, i) => ({
      step: Number.isFinite(Number(st?.n)) ? Number(st.n) : i + 1, correct: true, error_type: '', note: '',
    }));
  }

  /** Same normalization as the extension's gv2NormalizeEvidenceKey, so markers and saved keys meet. */
  function evidenceKey(key) {
    const raw = String(key == null ? '' : key).trim().toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
    return raw || String(key == null ? '' : key).trim();
  }

  /**
   * The visual evidence the agent saved for its answer: arms.grounding.answer_evidence, one crop per
   * key, in the order recorded. Tolerant of the older shapes (an object keyed by evidence key, or
   * entries with `image` instead of `screenshot`).
   */
  function answerEvidence(arms) {
    const raw = arms?.grounding?.answer_evidence;
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.entries(raw).map(([key, v]) => Object.assign({ key }, v)) : []);
    return list.filter(e => e && typeof e === 'object').map((e, i) => ({
      key: evidenceKey(e.key == null ? i + 1 : e.key),
      note: String(e.note || e.caption || ''),
      screenshot: e.screenshot || e.image || e.crop || null,
      step: Number.isFinite(Number(e.step)) ? Number(e.step) : null,
      source: String(e.source || ''),
      cited: e.cited !== false,
    }));
  }

  /**
   * Split an answer on its [ev:key] markers so the site can turn each into a chip that opens the
   * matching crop. Returns [{text}] and [{ev: key}] segments in order; text with no markers is one
   * segment.
   */
  function splitAnswerMarkers(text) {
    const out = [];
    // Any text up to the closing bracket: markers are sometimes written as the evidence's name
    // ("[ev:Sportsplex Hours 4:00pm - 9:00pm]"), not its slug. `ev` is the normalized key the
    // saved evidence is matched on; `raw` is what was written, for display.
    const re = /\[ev:\s*([^\]]+?)\s*\]/g;
    const str = String(text == null ? '' : text);
    let last = 0, m;
    while ((m = re.exec(str))) {
      if (m.index > last) out.push({ text: str.slice(last, m.index) });
      out.push({ ev: evidenceKey(m[1]), raw: m[1] });
      last = m.index + m[0].length;
    }
    if (last < str.length || !out.length) out.push({ text: str.slice(last) });
    return out;
  }

  /** The fields the researcher may edit on a published run. Everything else is what the agent did. */
  const TRAJECTORY_EDITABLE = ['source_task_id', 'title', 'goal', 'agent_answer', 'in_annotation'];

  /**
   * Apply a researcher's patch to a trajectory — the local twin of the SQL
   * update_pageguide_annotation_trajectory, so local mode and Supabase mode end up with the same
   * row. Only the keys present in `patch` change; the agent answer is mirrored into
   * arms.grounding.answer so the grading view (which falls back to the arm) never shows a stale
   * answer. Returns a new object; neither argument is mutated.
   */
  function applyTrajectoryPatch(t, patch) {
    const out = Object.assign({}, t || {});
    const p = patch || {};
    if ('source_task_id' in p) out.source_task_id = String(p.source_task_id == null ? '' : p.source_task_id).trim() || null;
    if ('title' in p) out.title = String(p.title == null ? '' : p.title).trim() || null;
    if ('goal' in p) out.goal = String(p.goal == null ? '' : p.goal).trim();
    if ('in_annotation' in p) out.in_annotation = !!p.in_annotation;
    if ('agent_answer' in p) {
      out.agent_answer = String(p.agent_answer == null ? '' : p.agent_answer).trim();
      if (out.arms && typeof out.arms.grounding === 'object' && out.arms.grounding) {
        out.arms = Object.assign({}, out.arms, { grounding: Object.assign({}, out.arms.grounding, { answer: out.agent_answer }) });
      }
    }
    out.updated_at = new Date().toISOString();
    return out;
  }

  /** The subset of a form's values that actually differ from the row — what to send, if anything. */
  function trajectoryPatchDiff(t, form) {
    const cur = t || {}, f = form || {};
    const diff = {};
    const norm = (v) => String(v == null ? '' : v).trim();
    if ('source_task_id' in f && norm(f.source_task_id) !== norm(cur.source_task_id)) diff.source_task_id = norm(f.source_task_id);
    if ('title' in f && norm(f.title) !== norm(cur.title)) diff.title = norm(f.title);
    if ('goal' in f && norm(f.goal) !== norm(cur.goal)) diff.goal = norm(f.goal);
    if ('agent_answer' in f && norm(f.agent_answer) !== norm(cur.agent_answer || cur.arms?.grounding?.answer)) diff.agent_answer = norm(f.agent_answer);
    if ('in_annotation' in f && !!f.in_annotation !== (cur.in_annotation !== false)) diff.in_annotation = !!f.in_annotation;
    return diff;
  }

  const api = {
    ANNOT_ERROR_TYPES, ANNOT_PROBLEM_TYPES, ANNOT_EVIDENCE_PROBLEMS, TRAJECTORY_EDITABLE,
    normalizeAnnotation, annotationProblem, annotationComplete, defaultStepLabels, defaultEvidenceLabels,
    cohensKappa, percentAgreement, pairStepLabels, pairEvidenceLabels, agreementReport, listAnnotators, agreementCsv,
    applyTrajectoryPatch, trajectoryPatchDiff, answerEvidence, splitAnswerMarkers, evidenceKey,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AnnotateLogic = api;
})(typeof window !== 'undefined' ? window : null);
