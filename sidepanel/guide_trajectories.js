// PageGuide User Study — captured guide trajectories
// ==================================================
// A Guide run is the study material for the guide half: the participant is shown what the agent did,
// step by step, and asked whether it got the task right and where it went wrong. That means the run
// has to survive long enough to be shown to everyone, and it has to be editable — a study needs a
// trajectory with a KNOWN fault in it, not whatever the agent happened to do that afternoon.
//
// WHY A SECOND STORE, when rewind already keeps every run:
//   1. rewind evicts. RW_SESSION_CAP is 8 (rewind/rewind_store.js) and 🧹 New Chat calls
//      rewindClear(). A trajectory the study depends on cannot live somewhere that prunes itself.
//   2. rewind does not keep the recap. _gv2BuildRecap (content/tasks/guidev2.js) returns the summary,
//      the milestones and the final verdict; the panel renders them and the HTML dies with the tab
//      session. The answer and the reasoning trail — the two things this study asks about — are
//      exactly what a recalled journey is missing today.
// So capture COPIES a finished run out of rewind, with the recap the panel was holding, into a bank
// that is only ever written by hand.
//
// TWO ARMS, one run. Grounded shows the trajectory with a screenshot per step; non-grounded shows the
// same steps as text. Derived from the grounded arm by _stripGuideArm, not generated separately —
// the same rule the Find recorder follows, for the same reason: the arms must differ in grounding
// and in nothing else.

const PAGEGUIDE_GUIDE_TRAJECTORIES_KEY = 'pageguide_guide_trajectories';

/** The error types a participant chooses between. Shown in this order, numbered as written. */
const GUIDE_ERROR_TYPES = [
  { id: 'loop', label: 'Loop / no progress — stuck without advancing.' },
  { id: 'mismatch', label: 'Action–goal mismatch — the action is valid on the page but does not serve the goal.' },
  { id: 'wrong_target', label: 'Wrong target / misclick — clicked the wrong element.' },
];

/**
 * WHAT WENT WRONG WITH THE RESULT — the closed answer to Q1b.
 *
 * Q1b used to be a free-text box on both sides, which made it the one question in the study that
 * could not be scored: comparing a participant's sentence to the researcher's sentence means
 * reading both and deciding, by hand, whether they meant the same thing. A closed list makes the
 * comparison mechanical. The free-text box stays underneath as OPTIONAL elaboration — useful to
 * read, never required, never scored.
 *
 * STRICTLY ABOUT THE END STATE. Every option here describes where the run FINISHED; nothing here
 * describes how it got there. That is the whole line between this list and GUIDE_ERROR_TYPES, and
 * it is what makes the study's two timers mean different things:
 *
 *   Q1b (this list, 🔍 "Finding the answer")  — DETECTION:    did you notice it went wrong?
 *   Q2  (GUIDE_ERROR_TYPES, 🔎 "Finding the errors") — LOCALIZATION: can you find WHERE it did?
 *
 * A participant can answer Q1b from the agent's answer alone, with no trajectory at all. Q2 needs
 * the steps. So localization is where grounding should pay off, and any behavioural wording that
 * leaks into this list ("failed to click…") lets a participant answer the localization question in
 * the detection box, without a step number, and the measure quietly stops separating the two.
 *
 * No id here appears in GUIDE_ERROR_TYPES, and none should: identical wording under two headings
 * gets ticked in both places, and the data cannot then say whether one thing was meant or two.
 */
const GUIDE_PROBLEM_TYPES = [
  { id: 'hallucinated_result', label: 'Hallucinated result — the agent made up an answer that the page does not support.' },
  { id: 'incomplete', label: 'Incomplete — the agent only completed part of the task.' },
  { id: 'could_not_complete', label: 'Could not complete — the agent could not finish the task.' },
];

/** The questions a guide task asks. Editable per trajectory; these are the defaults. */
const GUIDE_STUDY_QUESTIONS = {
  correctness: 'Did the agent complete the task successfully?',
  problem: 'What is the problem with it?',
  errors: 'Which error did the agent make, and at which steps?',
};

/**
 * The condition a trajectory is assigned to.
 *
 * The ids are the evidence-mode vocabulary (`normalizeEvidenceMode`, content/utils.js) rather than a
 * third set of names, because they denote the same thing: whether the run the participant reads was
 * produced with screenshot evidence or with text. Sharing the vocabulary is what lets a trajectory's
 * assignment be checked against the mode the run was actually captured under.
 */
const GUIDE_CONDITIONS = [
  { id: 'visual', label: 'GUIDE × VISUAL' },
  { id: 'text', label: 'GUIDE × TEXT' },
];

/** The label for a condition id, or the "not assigned yet" wording. */
function guideConditionLabel(id) {
  return GUIDE_CONDITIONS.find(c => c.id === id)?.label || 'Unassigned';
}

/**
 * Which condition a captured run looks like it belongs to.
 *
 * A first guess only, and the researcher can always override it. A Text-mode run takes no captures
 * at all (`gv2CaptureStepRecord` nulls every screenshot when the mode is text), so a trajectory
 * whose steps carry no images was almost certainly recorded as GUIDE × TEXT. Guessing beats leaving
 * every capture unassigned, and guessing from the one signal that is actually in the data beats
 * asking the researcher to remember which toggle was set that afternoon.
 */
function _inferGuideCondition(arm) {
  const steps = Array.isArray(arm?.steps) ? arm.steps : [];
  if (!steps.length) return '';
  return steps.some(st => st && st.screenshot) ? 'visual' : 'text';
}

/**
 * THE GROUND TRUTH: what the right answer to this trajectory's questions actually is.
 *
 * Authored by the researcher in the same vocabulary the participant answers in — the same
 * success/failure choice, the same GUIDE_ERROR_TYPES, the same per-error step lists. That is the
 * whole point: a participant's answer and the ground truth have to be directly comparable, and any
 * drift between the two shapes turns scoring into a translation exercise done by hand, later, from
 * memory.
 *
 * Lives on the record rather than inside an arm. What the agent actually did is a property of the
 * RUN; both arms show the same run and are graded against the same truth. Putting it in an arm
 * would allow the grounded and non-grounded copies of one trajectory to disagree about what
 * happened, which is not a state that should be representable.
 *
 * @param {object|null} raw
 * @returns {{correctness: string, problem: string, errors: Array<{type: string, steps: number[]}>}}
 */
function _buildGuideGroundTruth(raw) {
  const src = raw || {};
  const correctness = (src.correctness === 'success' || src.correctness === 'failure') ? src.correctness : '';
  const validProblems = new Set(GUIDE_PROBLEM_TYPES.map(t => t.id));
  const problems = [...new Set((Array.isArray(src.problems) ? src.problems : [])
    .filter(id => validProblems.has(id)))];
  const validTypes = new Set(GUIDE_ERROR_TYPES.map(t => t.id));
  const errors = (Array.isArray(src.errors) ? src.errors : [])
    .filter(e => e && validTypes.has(e.type))
    .map(e => ({
      type: e.type,
      // Numbers, deduplicated, in order. A step list read back as ["2","2",null] cannot be compared
      // against a participant's [2] without cleaning it first, so it is cleaned once, here.
      steps: [...new Set((Array.isArray(e.steps) ? e.steps : [])
        .map(n => Number(n))
        .filter(n => Number.isFinite(n) && n > 0))].sort((a, b) => a - b),
    }));
  return {
    correctness,
    // The scored answer.
    problems,
    // Optional elaboration. Kept because it is genuinely useful to read back, never required.
    problem: String(src.problem || '').trim(),
    errors,
    // "I looked, and there were none" — the affirmative answer to Q2, distinct from an empty list.
    //
    // The participant cannot submit Q2 without ticking something, so THEIR empty `errors` always
    // means "No error". The ground truth has no such gate, so without this flag its empty list
    // means either "no error" or "not filled in yet" — two states that would score identically,
    // and one of them silently marks every unfinished trajectory as agreeing with a participant
    // who said the run was clean.
    //
    // An errors list wins: recording both "no error" and an error is not a state worth keeping.
    no_error: errors.length ? false : !!src.no_error,
  };
}

/**
 * What is incomplete about a ground truth, or null when nothing is.
 *
 * Deliberately permissive about a half-filled record — the researcher fills it in over several
 * sittings and a save must never be refused. This drives a "needs attention" badge in the list, so
 * an unscoreable trajectory is visible before the study runs rather than discovered during
 * analysis.
 */
function _guideGroundTruthProblem(gt) {
  const t = gt || {};
  if (!t.correctness) return 'No verdict recorded — say whether the agent succeeded.';
  if (t.correctness === 'failure' && !t.problems?.length) return 'Marked as failed, but no problem is recorded.';
  // Q2 is asked on EVERY run, not only failed ones — a run can reach the right answer while still
  // misclicking at step 3 and recovering by step 5, and "did a successful run contain errors" is
  // exactly what the participant is asked. So a successful run needs an answer here too, even if
  // that answer is "none".
  if (!t.no_error && !t.errors?.length) {
    return 'No answer to “which error” — add an error, or tick “No error”.';
  }
  const noSteps = (t.errors || []).filter(e => !(Array.isArray(e.steps) && e.steps.length));
  if (noSteps.length) return 'An error has no step recorded — say where it happened.';
  return null;
}

/** Take the [ev:key] markers out of an answer, closing the gap they leave. */
function _stripGuideEvidenceMarkers(text) {
  return String(text == null ? '' : text)
    .replace(/\s*\[ev:[^\]]+\]/gi, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Steps are numbered by position, always — see _renumberGuideSteps. */
function _renumberGuideSteps(steps) {
  return (Array.isArray(steps) ? steps : []).map((step, i) => Object.assign({}, step, { n: i + 1 }));
}

/**
 * Move a step and renumber. Pure.
 *
 * The renumber is the point: `n` is what the participant reads and what their error answer refers to
 * ("the agent went wrong at step 3"). If it survived a reorder or a delete, the step numbers on the
 * screen would stop matching the order they are in, and every answer that names one becomes
 * ambiguous.
 */
function _moveGuideStep(steps, from, to) {
  const list = Array.isArray(steps) ? steps.slice() : [];
  const a = Number(from);
  const b = Math.max(0, Math.min(list.length - 1, Number(to)));
  if (!Number.isFinite(a) || a < 0 || a >= list.length || !Number.isFinite(b) || a === b) {
    return _renumberGuideSteps(list);
  }
  const [moved] = list.splice(a, 1);
  list.splice(b, 0, moved);
  return _renumberGuideSteps(list);
}

// ===== SCORING =====
// A participant's answer against the ground truth, in the vocabularies both sides already share.
//
// Homed here, beside GUIDE_PROBLEM_TYPES / GUIDE_ERROR_TYPES / _buildGuideGroundTruth, so the lists
// and the comparison that consumes them cannot drift apart.
//
// TWO SCORES, NEVER ONE. The study times Q1b and Q2 separately (answer_multiple_choice_ms vs
// find_supporting_answer_ms) because they measure different things:
//
//   DETECTION    (Q1/Q1b) — did you notice it went wrong? Answerable from the agent's answer alone.
//   LOCALIZATION (Q2)     — can you find WHERE? Needs the steps, so this is where grounding should
//                           show an effect.
//
// Averaging them into one number would erase exactly the distinction the study exists to test.
//
// NULL IS NOT ZERO, anywhere in here. A trajectory whose ground truth was never filled in, and a
// set with nothing to be precise about, both score null. Returning 0 would make an unfinished
// stimulus indistinguishable from a participant who got everything wrong, and the difference would
// be invisible by the time anyone looked at a mean.

/** Precision/recall of one set against another. null when the denominator is empty. Pure. */
function _setScore(answerIds, truthIds) {
  const answer = new Set(answerIds || []);
  const truth = new Set(truthIds || []);
  let hit = 0;
  answer.forEach(id => { if (truth.has(id)) hit++; });
  return {
    precision: answer.size ? hit / answer.size : null,
    recall: truth.size ? hit / truth.size : null,
    exact: answer.size === truth.size && hit === answer.size,
    hit,
  };
}

/** Is this ground truth complete enough to score against at all? */
function _guideGroundTruthScorable(gt) {
  return !!gt && !_guideGroundTruthProblem(gt);
}

/**
 * DETECTION: did the participant see that something was wrong, and name the same thing?
 *
 * @param {object} answer - {correct: boolean, problems: string[]}
 * @param {object} gt - a ground truth record
 * @returns {object|null} null when there is nothing scorable to compare against
 */
function _scoreGuideDetection(answer, gt) {
  if (!answer || !_guideGroundTruthScorable(gt)) return null;
  const truthSucceeded = gt.correctness === 'success';
  const problems = _setScore(answer.problems, gt.problems);
  // The problem question is only ASKED when the verdict is "did not complete", so it can only be
  // scored when both sides agree it failed. Scoring it when one side said "success" would penalise
  // a participant for not answering a question they were never shown.
  const comparable = !truthSucceeded && answer.correct === false;
  return {
    verdict_correct: answer.correct === truthSucceeded,
    problem_precision: comparable ? problems.precision : null,
    problem_recall: comparable ? problems.recall : null,
    problem_exact: comparable ? problems.exact : null,
  };
}

/**
 * LOCALIZATION: did the participant name the same failures, at the same steps?
 *
 * Steps are credited ONLY for error types the participant got right. A step list hung on a type
 * that is not in the ground truth is not localization — it is a guess that happens to land
 * somewhere, and crediting it would let someone score well on steps while naming failures the run
 * never had.
 *
 * @param {object} answer - {errors: [{type, steps:[n]}]}
 * @param {object} gt - a ground truth record
 * @returns {object|null}
 */
function _scoreGuideLocalization(answer, gt) {
  if (!answer || !_guideGroundTruthScorable(gt)) return null;
  const answerErrors = Array.isArray(answer.errors) ? answer.errors : [];
  const truthErrors = Array.isArray(gt.errors) ? gt.errors : [];

  // "Nothing went wrong" is an answer on both sides, and the one case with no sets to compare.
  // The participant cannot submit Q2 without ticking something, so their empty list means they
  // looked; gt.no_error is the same claim made explicitly. See _buildGuideGroundTruth.
  const answerSaysNone = !answerErrors.length;
  const truthSaysNone = !!gt.no_error && !truthErrors.length;
  if (answerSaysNone && truthSaysNone) {
    return {
      no_error_agreement: true,
      type_precision: null, type_recall: null,
      step_precision: null, step_recall: null, step_exact: null,
    };
  }

  const types = _setScore(answerErrors.map(e => e?.type), truthErrors.map(e => e?.type));

  // Steps, pooled across the types that were named correctly.
  const truthByType = new Map(truthErrors.map(e => [e?.type, new Set(e?.steps || [])]));
  const answeredSteps = new Set();
  const creditableTruthSteps = new Set();
  let stepHits = 0;
  answerErrors.forEach(e => {
    const truthSteps = truthByType.get(e?.type);
    if (!truthSteps) return;                       // a type the run never had earns no step credit
    (e?.steps || []).forEach(n => {
      answeredSteps.add(`${e.type}:${n}`);
      if (truthSteps.has(n)) stepHits++;
    });
  });
  // Recall is against EVERY true step, including those under types the participant never named —
  // a step they could not have found because they did not name its failure is still a step missed.
  truthErrors.forEach(e => (e?.steps || []).forEach(n => creditableTruthSteps.add(`${e.type}:${n}`)));

  return {
    no_error_agreement: answerSaysNone === truthSaysNone,
    type_precision: types.precision,
    type_recall: types.recall,
    step_precision: answeredSteps.size ? stepHits / answeredSteps.size : null,
    step_recall: creditableTruthSteps.size ? stepHits / creditableTruthSteps.size : null,
    step_exact: answeredSteps.size === creditableTruthSteps.size && stepHits === creditableTruthSteps.size,
  };
}

/** Both halves, flattened for one result row. null when there is no scorable ground truth. */
function _scoreGuideAnswer(answer, gt) {
  const detection = _scoreGuideDetection(answer, gt);
  const localization = _scoreGuideLocalization(answer, gt);
  if (!detection && !localization) return null;
  return Object.assign({}, detection, localization);
}

/**
 * The non-grounded arm: the same run with its grounding taken away.
 *
 * Screenshots go, and so does everything else that only exists to show WHERE on the page a step
 * happened. The instructions stay, all of them — a shorter trajectory would be a different run, and
 * the two arms have to be the same run or nothing they measure is comparable.
 */
function _stripGuideArm(arm) {
  const source = arm || {};
  return {
    // The bookends SURVIVE the strip, screenshots and all. This is a deliberate exception, not an
    // oversight: what the arms are meant to differ in is whether each action can be checked against
    // the page it was taken on. Withholding the start and end state as well would also withhold
    // whether the task got done, which is the thing both arms are asked to judge — and the question
    // would stop being about grounding and start being about who was told the outcome.
    initial_state: Object.assign({ screenshot: null, url: '' }, source.initial_state || {}),
    final_state: Object.assign({ screenshot: null, url: '' }, source.final_state || {}),
    steps: _renumberGuideSteps(source.steps).map(step => ({
      n: step.n,
      instruction: step.instruction || '',
      action: step.action || '',
      target_text: step.target_text || '',
      url: step.url || '',
      screenshot: null,
    })),
    // No evidence of any kind: that is what the arm is. The markers go with it — a chip that opens
    // nothing is worse than no chip, and a raw "[ev:54]" in the prose is worse than both. The linked
    // phrases go with them: an underline that opens a screenshot is a grounding affordance too.
    answer_evidence: [],
    answer_segments: [],
    answer: _stripGuideEvidenceMarkers(source.answer || ''),
    trail: {
      summary: source.trail?.summary || '',
      milestones: (Array.isArray(source.trail?.milestones) ? source.trail.milestones : [])
        .map(m => Object.assign({}, m)),
    },
    questions: Object.assign({}, GUIDE_STUDY_QUESTIONS, source.questions || {}),
  };
}

/**
 * What is wrong with a set of Q2 answers, or null if nothing is.
 *
 * The steps are picked from buttons, so a malformed answer is unwritable — but an INCOMPLETE one
 * still is: ticking "wrong target" and choosing no step says something went wrong while withholding
 * where, which is half an answer and cannot be reconstructed afterwards.
 */
function _guideErrorsProblem(errors) {
  const list = Array.isArray(errors) ? errors : [];
  const missing = list.filter(e => !(Array.isArray(e?.steps) && e.steps.length));
  if (!missing.length) return null;
  return missing.length === list.length
    ? 'Please tap which step(s) went wrong.'
    : 'One of the errors has no step selected — tap which step(s) it happened at.';
}

/**
 * Copy the grounded arm's before/after states onto the non-grounded one.
 *
 * The bookends are the one thing both arms show, so they must not drift apart. Everything else a
 * re-capture reads stays on the grounded side — the non-grounded arm's text may have been edited by
 * hand, and re-capture must not overwrite that.
 */
function _syncGuideBookends(record) {
  const g = record?.arms?.grounding;
  const n = record?.arms?.nongrounding;
  if (!g || !n) return record;
  n.initial_state = Object.assign({ screenshot: null, url: '' }, g.initial_state || {});
  n.final_state = Object.assign({ screenshot: null, url: '' }, g.final_state || {});
  return record;
}

/**
 * The crop saved for one evidence key, out of the step record that captured it.
 *
 * Saved evidence lives in two places depending on how it was taken — `savedEvidenceCaptures` for an
 * explicit save_evidence, `visualEvidenceItems` for a confirmation capture — and both are keyed the
 * same way. Mirrors _recapSavedEvidenceCapture (sidepanel/panel.js), which is what the chat uses.
 */
function _guideEvidenceShot(record, key) {
  if (!record) return null;
  const needle = String(key || '').trim().toLowerCase();
  // The action-fallback item has no key at all — it stands for "the state the run ended in", so the
  // step's own picture is exactly the right image for it.
  if (!needle) {
    return record.visualEvidenceShot || record.regionShot || record.markedShot
      || _guideStepScreenshot(record) || null;
  }
  const saved = (Array.isArray(record.savedEvidenceCaptures) ? record.savedEvidenceCaptures : [])
    .find(item => item && String(item.key || '').trim().toLowerCase() === needle);
  const confirmation = (Array.isArray(record.visualEvidenceItems) ? record.visualEvidenceItems : [])
    .find(item => item && String(item.key || '').trim().toLowerCase() === needle);
  // Confirmation evidence is cited by SoM index ([ev:54]) rather than by name, so it often has no
  // keyed crop of its own — the step's own evidence image is the picture of it.
  return saved?.shot
    || confirmation?.visualEvidenceShot
    || record.visualEvidenceShot
    || record.regionShot
    || record.markedShot
    || null;
}

/** The step JSON the model returned, whether it was stored as text or already parsed. */
function _guideStepJson(record) {
  const raw = record?.rawLlmJson;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const match = String(raw).match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch (e) {
    return null;
  }
}

/**
 * The picture of a step: the page as PageGuide saw it before that step's action.
 *
 * The order is the live panel's, deliberately — showGoalStepPreview (sidepanel/panel.js) puts the
 * region crop on the step card and opens this same `screenshotBefore` full-size behind it, titled
 * "Before action — what PageGuide saw before this step". A participant reviewing a trajectory must
 * be looking at the identical image a researcher sees when they click that step in the live run;
 * two different pictures of the same step is two different studies.
 */
function _guideStepScreenshot(record) {
  return record?.screenshotBefore || record?.screenshot || record?.screenshotAfter || null;
}

/**
 * Build a trajectory from what a finished run left behind. Pure, so the projection is testable
 * without a browser — it is the piece that decides what a participant will ever be able to see.
 *
 * @param {object} index - RW_IDX::<sid>: {sessionId, goal, steps:[meta], guideTitle, guidePlan}
 * @param {Array<object>} records - the full RW_REC:: records, in step order
 * @param {object|null} recap - the panel's last recap for this session: {summary, milestones, final}
 * @returns {object} the trajectory record
 */
function _buildGuideTrajectory(index, records, recap) {
  const idx = index || {};
  const byStep = new Map();
  (Array.isArray(records) ? records : []).forEach(rec => {
    if (rec && Number.isFinite(Number(rec.step))) byStep.set(Number(rec.step), rec);
  });

  // Step 0 is the initial state — the page before the agent touched it. It is not something the
  // agent DID, so it is not a step a participant can be asked about.
  const metas = (Array.isArray(idx.steps) ? idx.steps : [])
    .filter(m => m && !m.isInitial && Number(m.step) > 0)
    .sort((a, b) => Number(a.step) - Number(b.step));

  // THE RENUMBER MAP. Steps are renumbered 1..N by position, but the recap's milestones and the
  // evidence both cite the ORIGINAL rewind step numbers. Those agree only when nothing was filtered
  // out — and step 0 always is, along with any meta the run did not finish writing. When they
  // disagree, a milestone claims "step 4" of a three-step journey: it points at nothing, so nothing
  // downstream can resolve it to a screenshot, and it silently stops being hoverable.
  const stepNumberFor = new Map();
  metas.forEach((meta, i) => stepNumberFor.set(Number(meta.step), i + 1));
  const renumber = (n) => (n == null || !stepNumberFor.has(Number(n))) ? null : stepNumberFor.get(Number(n));

  const steps = _renumberGuideSteps(metas.map(meta => {
    const rec = byStep.get(Number(meta.step)) || {};
    return {
      instruction: meta.instruction || rec.instruction || '',
      action: meta.action || rec.action || '',
      target_text: rec.target?.text || meta.domElementText || meta.llmElementText || '',
      url: meta.url || rec.url || '',
      screenshot: _guideStepScreenshot(rec),
    };
  }));

  // THE ANSWER, and what it rests on.
  //
  // The answer is the finish step's own answer — "I have successfully added the book … [ev:54]" —
  // not the recap summary. They are different texts written by different calls: the summary narrates
  // the run, the answer is the claim a participant is asked to judge. Using the summary for both is
  // how the editor ended up showing the same paragraph twice.
  //
  // The evidence behind it comes from THREE places, and only gv2BuildAnswerEvidence knows the order
  // of precedence (cited scratchpad → uncited scratchpad → finish-time confirmation → the final step
  // itself). Reusing it is the point: a run whose evidence is a confirmation cited as [ev:54] and a
  // run that saved named evidence must resolve the same way here as they do in the chat, or the
  // editor shows something the participant will never see.
  const finishRec = [...byStep.values()].find(r => r?.isLastStep || r?.action === 'finish')
    || byStep.get(metas.length ? Number(metas[metas.length - 1].step) : NaN)
    || null;
  const finishJson = _guideStepJson(finishRec);
  const rawAnswer = String(finishJson?.answer || recap?.summary || '').trim();

  const scratchpad = Array.isArray(idx.evidenceScratchpad) ? idx.evidenceScratchpad : [];
  const confirmation = (Array.isArray(finishJson?.confirmationEvidence) ? finishJson.confirmationEvidence : [])
    .map(c => ({
      step: finishRec?.step,
      region_bbox: c?.rect || null,
      note: c?.reason || c?.text || c?.name || 'Confirmation',
      key: c?.name || (c?.index != null ? String(c.index) : ''),
    }));

  const items = (typeof gv2BuildAnswerEvidence === 'function')
    ? gv2BuildAnswerEvidence({
        finalAnswer: rawAnswer,
        scratchpad,
        confirmation,
        fallbackStep: finishRec ? { step: finishRec.step, note: 'Final step' } : null,
      })
    : [];

  const answer_evidence = items.map(it => ({
    key: it.key || '',
    note: it.note || it.key || 'Evidence',
    // Renumbered for the same reason as the milestones: `step` is what ties this evidence to a row
    // on screen, and an original step number ties it to nothing.
    step: renumber(it.step),
    cited: it.source === 'cited',
    source: it.source || '',
    screenshot: _guideEvidenceShot(byStep.get(Number(it.step)), it.key || ''),
  }));

  // The [ev:key] markers STAY in the text. They are what ties a claim to the thing that backs it —
  // "added a Navel Orange to the cart [ev:54]" — and the study renders them as chips a participant
  // can hover and open, exactly as the chat does. Stripping them here would leave the evidence in a
  // list at the bottom with nothing saying which sentence it belongs to.
  const answer = rawAnswer;

  // THE BOOKENDS: the page before the agent started, and the page once it stopped.
  //
  // Both were already being recorded and both were being thrown away here. The initial state is the
  // step-0 rewind record (isInitial), filtered out of `metas` above because it is not something the
  // agent DID; the final state is the finish step's finalShot, taken by the final-verification pass
  // AFTER the last action, which is the one image in the run that shows the outcome rather than a
  // moment on the way to it. Every step screenshot is a "before" — without these two, "did the agent
  // achieve the goal?" has to be inferred from a picture taken before the last click landed.
  const initialRec = byStep.get(0) || null;
  const initialMeta = (Array.isArray(idx.steps) ? idx.steps : [])
    .find(m => m && (m.isInitial || Number(m.step) === 0)) || null;
  const lastMeta = metas.length ? metas[metas.length - 1] : null;

  const initial_state = {
    screenshot: initialRec?.screenshotBefore || initialRec?.screenshot || null,
    url: initialMeta?.url || initialRec?.url || '',
  };
  const final_state = {
    screenshot: finishRec?.finalShot || finishRec?.screenshotAfter || null,
    url: finishRec?.url || lastMeta?.url || '',
  };

  // THE LINKED PHRASES. The recap's summarySegments name a phrase copied verbatim out of the summary
  // and tie it to the step or the saved evidence that backs it (GUIDE_RECAP_SUMMARIZER_SYSTEM,
  // content/prompts.js). The chat underlines those phrases in place, which says WHICH WORDS rest on
  // the evidence — something a number parked at the end of a sentence cannot. Without them the study
  // showed the chip and lost the link between the claim and its proof.
  const answer_segments = (Array.isArray(recap?.summarySegments) ? recap.summarySegments : [])
    .map(seg => ({
      phrase: String(seg?.phrase || '').trim(),
      step: renumber(seg?.step),
      key: String(seg?.evidenceKey || seg?.evidence_key || '').trim(),
      note: String(seg?.text || seg?.phrase || '').trim(),
    }))
    .filter(seg => seg.phrase);

  const grounding = {
    initial_state,
    final_state,
    answer_segments,
    steps,
    answer_evidence,
    answer,
    trail: {
      summary: String(recap?.summary || '').trim(),
      milestones: (Array.isArray(recap?.milestones) ? recap.milestones : [])
        .filter(m => m && m.goalRelated !== false)
        .map(m => ({
          // Through the renumber map, so a milestone always names a step the journey actually has.
          step: renumber(m.firstStep != null ? m.firstStep : m.step),
          text: m.text || '',
          status: m.status || '',
          errorLabel: m.errorLabel || '',
        })),
    },
    questions: Object.assign({}, GUIDE_STUDY_QUESTIONS),
  };

  const now = new Date().toISOString();
  return {
    id: String(idx.sessionId || `guide-${Date.now()}`),
    source_session_id: idx.sessionId || null,
    captured_at: now,
    updated_at: now,
    goal: idx.goal || '',
    title: idx.guideTitle || idx.goal || 'Guide task',
    // Guessed from the capture, editable in the recorder. See _inferGuideCondition.
    condition: _inferGuideCondition(grounding),
    // Empty: only a person who knows the task can say whether the run got it right.
    ground_truth: _buildGuideGroundTruth(null),
    arms: { grounding, nongrounding: null },
  };
}

// ===== STORAGE =====
// chrome.storage.local, like every other study bank. Deliberately NOT pruned against tasks.json: a
// trajectory is authored material, not something derived from the task file, and the task file has
// no guide entries to prune it against.

async function listGuideTrajectories() {
  try {
    const data = await chrome.storage.local.get(PAGEGUIDE_GUIDE_TRAJECTORIES_KEY);
    const all = data[PAGEGUIDE_GUIDE_TRAJECTORIES_KEY];
    return (all && typeof all === 'object') ? all : {};
  } catch (e) {
    console.warn('[GuideTrajectories] read failed:', e);
    return {};
  }
}

async function getGuideTrajectory(id) {
  const all = await listGuideTrajectories();
  return all[String(id || '').trim()] || null;
}

/**
 * Is this trajectory one the study should actually show?
 *
 * OPT-OUT, not opt-in: only an explicit `false` excludes. The bank is a working set — captures made
 * to try something, runs superseded by a better take, trajectories held back for a later condition
 * — and the researcher decides which of them a participant walks. Defaulting an unset flag to
 * "included" is what keeps every trajectory banked before this existed in the study, instead of
 * emptying the guide half the first time this code ships.
 */
function _guideTrajectoryInStudy(t) {
  return !!t && t.in_study !== false;
}

/**
 * The participant's guide queue, in capture order: every trajectory that has steps AND has been
 * marked for inclusion. Both halves matter — a trajectory with no steps has nothing to show, and
 * one the researcher excluded should not appear however complete it is.
 */
async function listReadyGuideTrajectories() {
  const all = await listGuideTrajectories();
  return Object.values(all)
    .filter(t => t && t.arms?.grounding?.steps?.length && _guideTrajectoryInStudy(t))
    .sort((a, b) => String(a.captured_at || '').localeCompare(String(b.captured_at || '')));
}

/**
 * Save one trajectory. Screenshots are downscaled on the way in (the study's own helper), because a
 * guide run is a dozen retina viewport captures and the bank holds several runs.
 */
async function saveGuideTrajectory(record, { downscale = true } = {}) {
  const toStore = downscale ? await _downscaleGuideTrajectory(record) : record;
  toStore.updated_at = new Date().toISOString();
  // Normalized on the way in, so everything downstream reads one shape — including trajectories
  // banked before either field existed, which would otherwise reach the editor as undefined.
  toStore.condition = GUIDE_CONDITIONS.some(c => c.id === toStore.condition)
    ? toStore.condition
    : (toStore.condition ? '' : _inferGuideCondition(toStore.arms?.grounding));
  toStore.ground_truth = _buildGuideGroundTruth(toStore.ground_truth);
  toStore.in_study = _guideTrajectoryInStudy(toStore);
  try {
    const all = await listGuideTrajectories();
    all[String(toStore.id || '').trim()] = toStore;
    await chrome.storage.local.set({ [PAGEGUIDE_GUIDE_TRAJECTORIES_KEY]: all });
  } catch (e) {
    console.error('[GuideTrajectories] local save failed:', e);
    return { saved: false, error: e?.message || 'local save failed' };
  }
  return { saved: true, record: toStore };
}

async function deleteGuideTrajectory(id) {
  try {
    const all = await listGuideTrajectories();
    delete all[String(id || '').trim()];
    await chrome.storage.local.set({ [PAGEGUIDE_GUIDE_TRAJECTORIES_KEY]: all });
    return true;
  } catch (e) {
    console.warn('[GuideTrajectories] delete failed:', e);
    return false;
  }
}

/** Shrink every screenshot in a trajectory, reusing the study's downscaler. */
async function _downscaleGuideTrajectory(record) {
  if (typeof _downscaleStudyShot !== 'function') return record;
  const out = JSON.parse(JSON.stringify(record || {}));
  for (const armName of Object.keys(out.arms || {})) {
    const arm = out.arms[armName];
    if (!arm || !Array.isArray(arm.steps)) continue;
    for (const step of arm.steps) {
      if (step.screenshot) step.screenshot = await _downscaleStudyShot(step.screenshot);
    }
    for (const ev of (Array.isArray(arm.answer_evidence) ? arm.answer_evidence : [])) {
      if (ev.screenshot) ev.screenshot = await _downscaleStudyShot(ev.screenshot);
    }
  }
  return out;
}

if (typeof window !== 'undefined') {
  window.PAGEGUIDE_GUIDE_TRAJECTORIES_KEY = PAGEGUIDE_GUIDE_TRAJECTORIES_KEY;
  window.GUIDE_ERROR_TYPES = GUIDE_ERROR_TYPES;
  window.GUIDE_PROBLEM_TYPES = GUIDE_PROBLEM_TYPES;
  window.GUIDE_STUDY_QUESTIONS = GUIDE_STUDY_QUESTIONS;
  window.GUIDE_CONDITIONS = GUIDE_CONDITIONS;
  window.guideConditionLabel = guideConditionLabel;
  window._inferGuideCondition = _inferGuideCondition;
  window._buildGuideGroundTruth = _buildGuideGroundTruth;
  window._guideGroundTruthProblem = _guideGroundTruthProblem;
  window._guideTrajectoryInStudy = _guideTrajectoryInStudy;
  window._scoreGuideDetection = _scoreGuideDetection;
  window._scoreGuideLocalization = _scoreGuideLocalization;
  window._scoreGuideAnswer = _scoreGuideAnswer;
  window._guideGroundTruthScorable = _guideGroundTruthScorable;
  window._buildGuideTrajectory = _buildGuideTrajectory;
  window._stripGuideArm = _stripGuideArm;
  window._syncGuideBookends = _syncGuideBookends;
  window._guideErrorsProblem = _guideErrorsProblem;
  window._stripGuideEvidenceMarkers = _stripGuideEvidenceMarkers;
  window._guideEvidenceShot = _guideEvidenceShot;
  window._moveGuideStep = _moveGuideStep;
  window._renumberGuideSteps = _renumberGuideSteps;
  window.listGuideTrajectories = listGuideTrajectories;
  window.listReadyGuideTrajectories = listReadyGuideTrajectories;
  window.getGuideTrajectory = getGuideTrajectory;
  window.saveGuideTrajectory = saveGuideTrajectory;
  window.deleteGuideTrajectory = deleteGuideTrajectory;
}
