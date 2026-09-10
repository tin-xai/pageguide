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
    const answerCorrect = src.answer_correct === true ? true : (src.answer_correct === false ? false : null);
    return {
      trajectory_id: String(src.trajectory_id || '').trim(),
      annotator_id: String(src.annotator_id || '').trim(),
      step_labels: steps,
      answer_correct: answerCorrect,
      // Problems only mean something on a failed answer.
      answer_problems: answerCorrect === false
        ? [...new Set((Array.isArray(src.answer_problems) ? src.answer_problems : []).filter(p => validProb.has(p)))]
        : [],
      answer_note: String(src.answer_note || '').trim(),
      duration_ms: Number.isFinite(Number(src.duration_ms)) ? Math.max(0, Math.round(Number(src.duration_ms))) : null,
    };
  }

  /** What is still unanswered, or null when the annotation can be submitted. */
  function annotationProblem(annotation, stepCount) {
    const a = normalizeAnnotation(annotation);
    if (!a.annotator_id) return 'Enter your annotator ID first.';
    const labelled = new Set(a.step_labels.filter(l => l.correct !== null).map(l => l.step));
    const missing = [];
    for (let n = 1; n <= (stepCount || 0); n++) if (!labelled.has(n)) missing.push(n);
    if (missing.length) return `Step${missing.length === 1 ? '' : 's'} ${missing.join(', ')} not graded yet.`;
    if (a.answer_correct === null) return 'Say whether the final answer is correct.';
    if (a.answer_correct === false && !a.answer_problems.length) return 'Pick at least one problem with the answer.';
    return null;
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
      if (both) {
        allStepA.push(...stepA); allStepB.push(...stepB);
        allErrA.push(...errA); allErrB.push(...errB);
      }
      if (ansComparable) { allAnsA.push(a.answer_correct); allAnsB.push(b.answer_correct); }
      return {
        id: String(t.id),
        title: t.title || t.goal || String(t.id),
        step_count: Number(t.step_count) || 0,
        has_a: !!a,
        has_b: !!b,
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
    const head = ['trajectory_id', 'title', 'step_count', 'steps_compared', 'step_agreement', 'step_kappa',
      'disagreeing_steps', 'error_type_agreement', 'answer_a', 'answer_b', 'answer_agree'];
    const lines = [head.join(',')];
    (report?.perTrajectory || []).forEach(r => {
      lines.push([r.id, r.title, r.step_count, r.steps_compared, fmt(r.step_agreement), fmt(r.step_kappa),
        r.disagreeing_steps.join(' '), fmt(r.error_type_agreement), r.answer_a, r.answer_b, r.answer_agree]
        .map(esc).join(','));
    });
    return lines.join('\n');
  }

  const api = {
    ANNOT_ERROR_TYPES, ANNOT_PROBLEM_TYPES,
    normalizeAnnotation, annotationProblem, cohensKappa, percentAgreement,
    pairStepLabels, agreementReport, listAnnotators, agreementCsv,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AnnotateLogic = api;
})(typeof window !== 'undefined' ? window : null);
