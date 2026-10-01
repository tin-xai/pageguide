// PageGuide User Study
// Self-contained study overlay: loads a Find/Guide task queue, runs a per-task timer, records
// interaction counts + chat usage + the participant's answer, and exports everything as CSV
// (plus an optional real-time Supabase insert if sidepanel/supabase_config.js is configured).
// Every task is done WITH the extension available — there is no built-in "without PageGuide"
// control condition here; if this study needs a comparison against a different tool entirely,
// that comparison happens outside this codebase using the same user_study_data/tasks.json list.
//
// Exposes window.openStudyPanel() / window.closeStudyPanel() for the "📋 User Study" menu item,
// plus a handful of pure helpers on window (prefixed `_`) so they can be unit tested directly.

// ─────────────────────────────────────────────────────────────────
// Pure helpers (no DOM, no chrome.* — safe to unit test directly)
// ─────────────────────────────────────────────────────────────────

const STUDY_TASK_TIME_LIMIT_MS = 3 * 60 * 1000; // 3-minute countdown per task
const STUDY_TASK_LABELS = {
  find:  '🔍 Find Information',
  guide: '📘 Follow a Guide',
};
const STUDY_TASK_DESCRIPTIONS = {
  find:  'Find the answer to the question on the page.',
  guide: 'Complete the task described below on the website.',
};
const STUDY_RESULTS_STORAGE_KEY = 'pageguide_study_results';
// This find/guide study always runs with the extension available (no without-extension control),
// so the base label is constant. The arm that DOES vary is the evidence mode toggle
// (pageguideEvidenceMode — Visual vs Text), so it is appended at log time and rows come out as
// `extension-visual` / `extension-text`. Read per row: a session is not pinned to one arm.
/**
 * THE CONDITION, and there are exactly two of it.
 *
 * `grounding` | `nongrounding` — the arm whose recorded answers the participant reads. Nothing else
 * belongs in this field.
 *
 * It used to be built by gluing a client label and an evidence mode together, which produced five
 * different strings for two conditions ("extension", "extension-text", "extension-grounding",
 * "extension-nongrounding", "extension-visual"). Every one of those has to be normalised by hand
 * before the data can be grouped, and the ones recorded before the arm was known ("extension",
 * "extension-text") cannot be normalised at all — the arm is simply not in them. Which client
 * produced a row is worth knowing, but it is a different fact and lives in task_data.source.
 */
const STUDY_CONDITIONS = ['grounding', 'nongrounding'];
const STUDY_CONDITION = 'grounding';

function studyConditionLabel(arm) {
  return arm === 'nongrounding' ? 'nongrounding' : 'grounding';
}

// The exact column list on the Supabase `study_task_results` table. persistResult() posts only
// these keys so the insert matches the table even though the local/CSV record carries extra
// convenience fields (tool, task_id, url, total_tasks, completed_at).
/**
 * How a guide answer scored against its trajectory's ground truth (_scoreGuideAnswer,
 * sidepanel/guide_trajectories.js). Two groups, never averaged into one:
 *   detection    — verdict_correct, problem_*  (did you notice it went wrong?)
 *   localization — type_*, step_*, no_error_agreement  (can you find where?)
 * Named once here and spread into both column lists, so the CSV and the Supabase insert cannot
 * disagree about which scores exist.
 */
const GUIDE_SCORE_COLUMNS = [
  'score_verdict_correct',
  'score_problem_precision', 'score_problem_recall', 'score_problem_exact',
  'score_type_precision', 'score_type_recall',
  'score_step_precision', 'score_step_recall', 'score_step_exact',
  'score_no_error_agreement',
];

const SUPABASE_TASK_COLUMNS = [
  'session_id', 'participant_id', 'block_index', 'task_index', 'question_index', 'task_type',
  'condition', 'time_ms', 'notes_time_ms', 'answer_time_ms',
  'answer_multiple_choice_ms', 'find_supporting_answer_ms', 'evidence_responses',
  'guide_answer_correct', 'guide_answer_problems', 'guide_answer_problem', 'guide_errors',
  ...GUIDE_SCORE_COLUMNS,
  'answer', 'answer_correct', 'question_or_task', 'confidence',
  'helpfulness', 'chat_turn_count', 'chat_transcript',
  'user_hidden_selectors', 'guide_screenshot', 'scroll_user_count', 'scroll_agent_count',
  'ctrl_f_count', 'text_select_count', 'click_count', 'mouse_move_px', 'agent_think_ms',
  'page_visit_count', 'page_visit_urls', 'task_data',
];

function _formatStudyTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const sec = (total % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

/**
 * Flatten { find: [...], guide: [...] } from tasks.json into an ordered queue of
 * { taskType, task } entries. Order is deterministic: all find tasks (in file order), then all
 * guide tasks (in file order) — no randomization, so every participant sees the same sequence
 * unless the caller shuffles it beforehand.
 */
function _buildTaskQueue(tasksData) {
  const queue = [];
  (tasksData?.find || []).forEach(task => queue.push({ taskType: 'find', task }));
  (tasksData?.guide || []).forEach(task => queue.push({ taskType: 'guide', task }));
  return queue;
}

function _gradeFindAnswer(selected, correct) {
  return String(selected || '').trim().toLowerCase() === String(correct || '').trim().toLowerCase();
}

// ── THE V2 FIND DESIGN: two groups, four cells, one Yes/No verdict ──────────────
//
// V1 asked the participant to FIND the answer and pick it out of four options. V2 asks them to
// VERIFY one: the page and the agent's answer are both in front of them, and the only question is
// whether that answer is right. This is a different task, and the whole assignment below exists to
// make sure the answer they are asked to judge is a fair draw.
//
// GROUPS. A participant does one task style, not both, so a within-participant comparison is never
// confounded by the text/visual difference:
//
//   Group A -> Find x Text      Group B -> Find x Visual
//
// assigned round robin by the participant's slot: 1st -> A, 2nd -> B, 3rd -> A, ...
//
// CELLS. Inside their group the four cells are crossed, so one sitting covers both axes:
//
//                   grounded                    non-grounded
//   correct         correct_grounding           correct_nongrounding
//   incorrect       incorrect_grounding         incorrect_nongrounding
//
// A participant walks one question per cell, so half of what they judge is correct and half is not,
// and half is grounded and half is bare. The starting cell rotates with the slot, so which question
// carries which cell differs between participants and no single question is always the wrong one.

/** Group A runs the text questions, group B the visual ones. */
const STUDY_FIND_GROUPS = {
  A: { taskStyle: 'find_text',   label: 'Find \u00d7 Text' },
  B: { taskStyle: 'find_visual', label: 'Find \u00d7 Visual' },
};

/**
 * The cells in the order they are dealt. Must stay equal to STUDY_V2_VARIANTS in
 * study_responses.js — a unit test pins that. Spelt again here rather than imported because this
 * file loads FIRST and these are top-level pure functions; reaching for the other file's constant
 * at load time is what threw the last time it was tried.
 */
const STUDY_FIND_CELLS = [
  'correct_grounding',
  'correct_nongrounding',
  'incorrect_grounding',
  'incorrect_nongrounding'
];

/** find_visual vs find_text. tasks.json mixes "FIND X VISUAL" and "FIND x TEXT", hence the /i. */
function _findTaskStyle(task) {
  return /visual/i.test(String(task?.type || '')) ? 'find_visual' : 'find_text';
}

/** Round robin: even slots run group A, odd slots group B. */
function _studyGroupForSlot(slot) {
  return (((Number(slot) || 0) % 2) + 2) % 2 === 0 ? 'A' : 'B';
}

/**
 * How many questions a participant actually answers: whole four-cell rounds only.
 *
 * A partial round is not a smaller version of the design, it is an UNBALANCED one — six questions
 * dealt round robin gives four correct answers and two incorrect, so the participant meets more
 * right answers than wrong ones and "did they say yes too often" stops being answerable. Better to
 * hold the remainder back and say so than to run a lopsided sitting.
 */
function _balancedFindCount(available) {
  const n = Math.max(0, Math.floor(Number(available) || 0));
  return n - (n % STUDY_FIND_CELLS.length);
}

/** Rotate a list so consecutive participants start at a different place in it. Pure. */
function _rotateForSlot(items, slot) {
  const list = Array.isArray(items) ? items : [];
  const n = list.length;
  if (!n) return [];
  const k = (((Number(slot) || 0) % n) + n) % n;
  return list.slice(k).concat(list.slice(0, k));
}

/**
 * The cell for each question this participant will see, in queue order. Pure.
 *
 * @param {number} count - how many questions (a multiple of four; see _balancedFindCount)
 * @param {number} slot  - the participant's assignment slot
 */
function _dealFindVariants(count, slot) {
  const n = STUDY_FIND_CELLS.length;
  const start = (((Number(slot) || 0) % n) + n) % n;
  const out = [];
  for (let i = 0; i < Math.max(0, Number(count) || 0); i++) {
    out.push(STUDY_FIND_CELLS[(start + i) % n]);
  }
  return out;
}

/**
 * Was the participant's Yes/No right?
 *
 * Scored against the answer that was SHOWN, never against a fixed property of the question — the
 * same question is correct for one participant and incorrect for the next, which is the point of
 * the correctness axis. supabase_schema_v2.sql makes the same point about `variant_key`.
 *
 * Deliberately reads the cell name itself rather than calling _variantCorrectness, so this stays a
 * self-contained pure function in the file the study screens live in.
 *
 * @param {boolean} verdict - true = the participant said the answer is correct
 * @param {string} variantKey - the cell that was shown
 */
function _gradeFindVerdict(verdict, variantKey) {
  const shownCorrect = !String(variantKey || '').startsWith('incorrect');
  return !!verdict === shownCorrect;
}

/**
 * Everything the assignment decides for one participant, from their slot. Pure.
 *
 * @param {Array<object>} findTasks - every find task in the bank, in file order
 * @param {number} slot
 * @returns {{group: string, taskStyle: string, tasks: Array<object>, variants: Array<string>,
 *            heldBack: number}}
 */
function _assignFindSession(findTasks, slot) {
  const group = _studyGroupForSlot(slot);
  const taskStyle = STUDY_FIND_GROUPS[group].taskStyle;
  const eligible = (findTasks || []).filter(t => _findTaskStyle(t) === taskStyle);
  // Rotated before the cut, so two participants in the same group do not always get the same four.
  const rotated = _rotateForSlot(eligible, slot);
  const count = _balancedFindCount(rotated.length);
  return {
    group,
    taskStyle,
    tasks: rotated.slice(0, count),
    variants: _dealFindVariants(count, slot),
    heldBack: rotated.length - count,
  };
}

const STUDY_EVIDENCE_PROMPTS = [
  'Which paragraph supports the first part of the question?',
  'Which paragraph supports the final answer?',
];

// Per-condition supporting questions, keyed on the `type` column carried over from the task
// spreadsheet. Both conditions ask for a sentence on hop 1; they diverge on hop 2, because a
// FIND × VISUAL item's second hop lives in a picture, not in prose — so that hop asks for the image
// and is answered from a list of the page's images rather than its paragraphs.
const STUDY_EVIDENCE_PROMPTS_BY_TYPE = {
  text: [
    { prompt: 'What sentence gives you the answer to the first part?', kind: 'paragraph' },
    { prompt: 'What sentence gives you the answer to the second part?', kind: 'paragraph' },
  ],
  visual: [
    { prompt: 'Choose the evidence that helps answer the first part', kind: 'paragraph' },
    { prompt: 'Choose the image that helps answer the question', kind: 'image' },
  ],
};

/**
 * Which arm a task belongs to, from its `type` field ("FIND x TEXT" / "FIND X VISUAL" — the casing
 * varies in the source spreadsheet, so match loosely).
 * @returns {'text'|'visual'|null} null when the task carries no recognisable type
 */
function _studyTaskArm(task) {
  const type = String(task?.type || '').toUpperCase();
  if (type.includes('VISUAL')) return 'visual';
  if (type.includes('TEXT')) return 'text';
  return null;
}

/**
 * The two supporting questions for a task, each with the control it should be answered with and an
 * optional hint.
 *
 * Precedence for the question: an explicit `evidence_questions` override on the task, then the arm's
 * prompts, then the generic pair. Always exactly two hops.
 *
 * A hint (`evidence_hints`, positional) is the lighter tool and usually the right one: it points at
 * WHERE the answer sits on this particular page — "locate the year next to the evidence" — without
 * changing the question, so the same thing is being asked of every participant on every task and the
 * responses stay comparable. Rewording the question itself changes what was asked.
 *
 * @returns {Array<{hop: number, prompt: string, kind: 'paragraph'|'image', hint: string}>}
 */
function _studyEvidencePrompts(task) {
  const hints = Array.isArray(task?.evidence_hints) ? task.evidence_hints : [];
  const hintFor = (i) => String(hints[i] || '').trim();

  const custom = Array.isArray(task?.evidence_questions)
    ? task.evidence_questions.map(q => String(q || '').trim()).filter(Boolean)
    : [];
  if (custom.length >= 2) {
    return custom.slice(0, 2).map((prompt, i) => ({ hop: i + 1, prompt, kind: 'paragraph', hint: hintFor(i) }));
  }
  const arm = _studyTaskArm(task);
  const pair = arm ? STUDY_EVIDENCE_PROMPTS_BY_TYPE[arm] : null;
  if (pair) return pair.map((p, i) => ({ hop: i + 1, prompt: p.prompt, kind: p.kind, hint: hintFor(i) }));
  return STUDY_EVIDENCE_PROMPTS.map((prompt, i) => ({ hop: i + 1, prompt, kind: 'paragraph', hint: hintFor(i) }));
}

/**
 * Assemble the persisted record for one completed task. Pure function of its inputs so the
 * shape (and the answer_correct grading) can be unit tested without any DOM/chrome mocking.
 */
function _buildStudyResultRecord(ctx) {
  const {
    participantId, sessionId, taskIndex, blockIndex, questionIndex, totalTasks,
    taskType, task, condition, elapsedMs, answer,
    notesElapsedMs, answerElapsedMs, answerChoiceMs, findSupportingMs,
    evidenceResponses, guideAnswer, groundTruth, confidence, helpfulness, chatSnapshot, behaviorData,
    variantKey, claimTextSnapshot,
  } = ctx;

  const questionOrTask = taskType === 'find' ? task.question : task.task;
  // V2 Find is a VERDICT on the answer shown, so it is graded against the cell that was dealt —
  // the same question is correct for one participant and incorrect for the next. `answer` is
  // 'yes'/'no' here rather than a copied-out option.
  //
  // The V1 branch stays for a row recorded before the cells existed, and for a bank replayed
  // without an assignment: without a variantKey there is nothing to score a verdict against, and
  // silently grading 'yes' as a wrong option string would fill the column with falses.
  const findVerdict = taskType === 'find' && variantKey
    ? String(answer || '').trim().toLowerCase() === 'yes'
    : null;
  const answerCorrect = taskType !== 'find'
    ? null
    : (variantKey ? _gradeFindVerdict(findVerdict, variantKey) : _gradeFindAnswer(answer, task.answer));
  // Every score column is present on every row, null when there is nothing to score, so the CSV has
  // no ragged columns and a find row cannot be mistaken for an unscored guide row. The scorer
  // returns domain names (verdict_correct); the columns carry a score_ prefix so a reader can tell
  // a measure from a raw answer at a glance.
  const scored = (typeof _scoreGuideAnswer === 'function' && guideAnswer)
    ? (_scoreGuideAnswer(guideAnswer, groundTruth) || {})
    : {};
  const guideScores = GUIDE_SCORE_COLUMNS.reduce((acc, col) => {
    const key = col.replace(/^score_/, '');
    acc[col] = scored[key] === undefined ? null : scored[key];
    return acc;
  }, {});
  const beh = behaviorData || {};
  const snap = chatSnapshot || { chat_turn_count: 0, chat_transcript: [] };

  return {
    // ── Convenience fields: kept in local storage + CSV, stripped before the Supabase insert
    //    (the table has no column for these). task_id/url are also preserved inside task_data. ──
    tool:              'pageguide',
    task_id:           task.id,
    url:               task.url,
    total_tasks:       totalTasks,
    completed_at:      new Date().toISOString(),

    // ── Supabase study_task_results columns ──
    session_id:        sessionId ?? null,
    participant_id:    participantId,
    block_index:       blockIndex ?? 0,
    task_index:        taskIndex,
    question_index:    questionIndex ?? 0,
    task_type:         taskType,
    condition:         condition || STUDY_CONDITION,
    time_ms:           elapsedMs,
    notes_time_ms:     notesElapsedMs ?? null,
    // answer_time_ms is the whole Answer screen. The two halves below split it at the moment the
    // participant commits to their Yes/No: everything before is reading the agent's answer and
    // deciding whether it is right, everything after is finding the evidence for that judgement on
    // the page. They are different acts, and averaging them together hides which one the grounding
    // actually helped.
    //
    // `answer_multiple_choice_ms` is a HISTORICAL name — it is the time-to-verdict now, and the
    // column is kept rather than renamed because study_task_results already holds V1 rows under it.
    // The V2 table calls the same number `verdict_time_ms`; see _buildFindV2ResultRow.
    answer_time_ms:    answerElapsedMs ?? null,
    answer_multiple_choice_ms: answerChoiceMs ?? null,
    find_supporting_answer_ms: findSupportingMs ?? null,
    // Guide tasks only. `guide_errors` is a LIST even when it is empty: "the participant found no
    // error" and "the participant was never asked" are different findings, and null vs [] is the
    // only thing that tells them apart.
    guide_answer_correct: guideAnswer ? guideAnswer.correct : null,
    // The SCORED Q1b answer. A list even when empty, for the same reason as guide_errors: "picked
    // no problem" and "was never asked" are different findings.
    guide_answer_problems: guideAnswer ? (guideAnswer.problems || []) : null,
    // The optional elaboration beside it — read, never scored.
    guide_answer_problem: guideAnswer ? (guideAnswer.problem || '') : null,
    guide_errors:         guideAnswer ? (guideAnswer.errors || []) : null,
    // Graded against the trajectory's ground truth, the same way the find half is graded against
    // task.answer above. Null throughout when no ground truth was recorded — see _scoreGuideAnswer.
    ...guideScores,
    evidence_responses: Array.isArray(evidenceResponses) ? evidenceResponses : [],
    answer:            answer,
    answer_correct:    answerCorrect,
    question_or_task:  questionOrTask,
    // ── The V2 assignment, carried on the V1 row too ──
    // `study_task_results` has no column for these, so they are stripped before that insert and
    // survive inside task_data (below). They are top level here because the CSV is what gets
    // analysed first, and a verdict whose cell is not beside it cannot be interpreted at all: the
    // same question is correct for one participant and incorrect for the next.
    variant_key:        variantKey || null,
    participant_verdict: findVerdict,
    // The wording that produced the verdict. Stored per row because the item can be re-authored
    // later, and a judgement is only meaningful against the exact text that was judged — the same
    // reason supabase_schema_v2.sql keeps claim_text_snapshot.
    claim_text_snapshot: claimTextSnapshot || null,
    confidence:        confidence || null,
    helpfulness:       helpfulness || null,
    chat_turn_count:   snap.chat_turn_count || 0,
    chat_transcript:   snap.chat_transcript || [],
    // Recall ("hide") task is not part of this find/guide study.
    user_hidden_selectors: null,
    guide_screenshot:  null,
    scroll_user_count:  beh.scroll_user_count  || 0,
    scroll_agent_count: beh.scroll_agent_count || 0,
    ctrl_f_count:       beh.ctrl_f_count       || 0,
    text_select_count:  beh.text_select_count  || 0,
    click_count:        beh.click_count        || 0,
    mouse_move_px:      beh.mouse_move_px      || 0,
    agent_think_ms:     beh.agent_think_ms     || [],
    page_visit_count:   beh.page_visit_count   || 0,
    page_visit_urls:    beh.page_visit_urls    || [],
    // The assignment rides along inside task_data so a V1 row is self-describing even though the
    // table has no columns for it.
    task_data:          Object.assign({}, task, {
      variant_key: variantKey || null,
      participant_verdict: findVerdict,
      claim_text_snapshot: claimTextSnapshot || null,
    }),
  };
}

const STUDY_CSV_COLUMNS = [
  'tool', 'participant_id', 'session_id', 'condition', 'block_index', 'task_index',
  'question_index', 'task_id', 'task_type', 'question_or_task', 'url', 'time_ms',
  'notes_time_ms', 'answer_time_ms', 'answer_multiple_choice_ms', 'find_supporting_answer_ms',
  'evidence_responses', 'guide_answer_correct', 'guide_answer_problems', 'guide_answer_problem',
  'guide_errors', ...GUIDE_SCORE_COLUMNS, 'answer',
  'answer_correct', 'variant_key', 'participant_verdict', 'confidence', 'helpfulness', 'chat_turn_count',
  'scroll_user_count', 'scroll_agent_count', 'ctrl_f_count', 'text_select_count', 'click_count',
  'mouse_move_px', 'agent_think_ms', 'page_visit_count', 'page_visit_urls', 'completed_at',
];

function _escapeStudyCSVValue(v) {
  const str = (v === undefined || v === null) ? ''
    : Array.isArray(v) ? JSON.stringify(v)
    : String(v);
  return str.includes(',') || str.includes('"') || str.includes('\n')
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

/** Builds the full CSV text (header + one row per result). Pure — easy to unit test. */
function _buildStudyResultsCSV(results) {
  const lines = [STUDY_CSV_COLUMNS.join(',')];
  (results || []).forEach(r => {
    lines.push(STUDY_CSV_COLUMNS.map(c => _escapeStudyCSVValue(r[c])).join(','));
  });
  return lines.join('\n');
}

/**
 * Strip the chat-only and researcher-only chrome out of an answer bubble before the study overlay
 * replays it.
 *
 * The overlay copies a message's innerHTML verbatim (snapshotLlmAnswers), which drags along the
 * chat's own chrome: the 🐞/💾/✏️ chip row and the bulky "Evidence on the page" card. All of it goes.
 * The crops add nothing here (every marker in the answer points at the live page instead), and the
 * chips are replaced by the arm tabs, which say which condition an action writes to.
 *
 * @param {string} html - the message's innerHTML
 * @returns {string} sanitized HTML
 */
function _sanitizeStudyAnswerHtml(html) {
  const raw = String(html == null ? '' : html);
  if (typeof document === 'undefined' || !raw) return raw;
  const box = document.createElement('div');
  box.innerHTML = raw;
  // The whole chip row goes: the Answer screen does its authoring from the arm tabs, where the tab
  // you are on already says which condition you are saving to.
  box.querySelectorAll('.pageguide-debug-answer-row').forEach(el => el.remove());
  box.querySelectorAll('.pageguide-find-evidence, .pageguide-recap-hero').forEach(el => el.remove());
  return box.innerHTML;
}

/** The readable text left in a fragment of HTML — how the overlay decides a bubble is worth showing. */
function _studyAnswerTextFromHtml(html) {
  const raw = String(html == null ? '' : html);
  if (typeof document === 'undefined' || !raw) return raw.trim();
  const box = document.createElement('div');
  box.innerHTML = raw;
  box.querySelectorAll('.pageguide-debug-answer-row').forEach(el => el.remove());
  return (box.textContent || '').trim();
}

/**
 * Whether a rendered answer should respond to a click.
 *
 * Clicking an answer opens its citations out into the sentences they point at — a grounding
 * affordance. The non-grounded arm has no citations, so a clickable bubble there offers a gesture
 * that does nothing and then announces "click to collapse citations" about citations that do not
 * exist. That is grounding chrome in the arm defined by its absence.
 *
 * @param {string} html - the answer as rendered
 * @returns {boolean}
 */
function _studyAnswerIsClickable(html) {
  return /pageguide-citation|citation-index/.test(String(html || ''));
}

if (typeof window !== 'undefined') {
  window._studyAnswerIsClickable = _studyAnswerIsClickable;
  window._sanitizeStudyAnswerHtml = _sanitizeStudyAnswerHtml;
  window._studyAnswerTextFromHtml = _studyAnswerTextFromHtml;
  window.studyConditionLabel = studyConditionLabel;
  window._formatStudyTime = _formatStudyTime;
  window._buildTaskQueue = _buildTaskQueue;
  window._gradeFindAnswer = _gradeFindAnswer;
  window.STUDY_FIND_GROUPS = STUDY_FIND_GROUPS;
  window.STUDY_FIND_CELLS = STUDY_FIND_CELLS;
  window._findTaskStyle = _findTaskStyle;
  window._studyGroupForSlot = _studyGroupForSlot;
  window._balancedFindCount = _balancedFindCount;
  window._rotateForSlot = _rotateForSlot;
  window._dealFindVariants = _dealFindVariants;
  window._gradeFindVerdict = _gradeFindVerdict;
  window._assignFindSession = _assignFindSession;
  window._studyEvidencePrompts = _studyEvidencePrompts;
  window._buildStudyResultRecord = _buildStudyResultRecord;
  window._buildStudyResultsCSV = _buildStudyResultsCSV;
}

// ─────────────────────────────────────────────────────────────────
// Stateful study overlay (DOM + chrome.* — not unit tested directly)
// ─────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // TWO MODES, one overlay.
  //
  //   'record' — the researcher's pass. Walks the task list to bank each question's grounded and
  //              non-grounded answer and its ground truth. Shows the arm tabs, Save/Edit, the
  //              ground-truth panel and Next; runs the task live so there is an answer to record.
  //   'study'  — the participant's pass. No chat, no live run: each question opens its page and
  //              shows ONE recorded answer — the arm chosen at the start — then asks the question.
  //
  // The authoring affordances key off the MODE, not off debug mode. Debug decides who can reach the
  // recorder; it must not put a Save chip in front of a participant whose machine happens to have
  // debug on.
  const s = {
    mode: 'record',
    arm: 'grounding',   // which recorded answer a participant reads (study mode only)
    taskFilter: 'all',  // debug only: examine just one half of the study
    participantId: '',
    sessionId: null, // study_sessions.id once the session row is created (null if Supabase off)
    // V2 assignment. `assignmentSlot` is the counterbalancing counter — from the V2 project when it
    // is configured, from a local counter otherwise — and everything else about what this
    // participant sees is derived from it: their group, and the cell dealt to each question.
    assignmentSlot: null,
    group: null,        // 'A' (Find x Text) | 'B' (Find x Visual)
    heldBack: 0,        // questions the bank had but a balanced sitting could not use
    v2SessionId: null,  // pageguide_find_v2_sessions.id, for the verdict rows
    queue: [],       // ordered [{taskType, task, variantKey}, ...]
    idx: 0,          // current position in queue
    results: [],
    timerInterval: null,
    timerStart: null,
    currentNotes: '',
    lastNotesElapsed: 0,  // carried across a Back-to-chat round trip, which stops the timer twice
    guideScreenshot: null,
    llmAnswersSnapshot: null,
    open: false,
  };

  let overlay = null;
  let miniBar = null;

  function $(id) { return document.getElementById(id); }
  function setHTML(html) { overlay.innerHTML = html; }
  function escapeHTML(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escapeAttr(s) { return escapeHTML(s); }

  async function loadTasks() {
    try {
      const url = chrome.runtime.getURL('user_study_data/tasks.json');
      const shipped = await fetch(url).then(r => r.json());
      // The researcher's question/answer edits go on FIRST, so everything downstream — the queue,
      // the recorder screen, grading, and the publish bundle — reads one wording. See the overlay
      // note in study_responses.js for why the edits are not written back into tasks.json.
      const data = (typeof listStudyTaskEdits === 'function' && typeof _applyStudyTaskEdits === 'function')
        ? _applyStudyTaskEdits(shipped, await listStudyTaskEdits())
        : shipped;
      const queue = _buildTaskQueue(data);
      // The guide half is whatever has been captured and edited — a trajectory is authored in the
      // panel, so making the researcher also hand-write it into tasks.json would be two sources of
      // truth for one thing.
      if (s.mode === 'study' && typeof listReadyGuideTrajectories === 'function') {
        const trajectories = await listReadyGuideTrajectories();
        trajectories.forEach(t => queue.push({
          taskType: 'guide',
          // `condition` rides along so a saved result records which half of the design the
          // participant actually saw, rather than it having to be looked up afterwards from a
          // trajectory that may since have been re-assigned.
          task: {
            id: t.id, type: 'GUIDE', title: t.title, url: '', task: t.goal,
            trajectory_id: t.id, condition: t.condition || '',
          },
        }));
      }
      // tasks.json is the source of truth for which questions exist, so a question deleted from it
      // takes its banked answers with it. Only ever runs off a queue that actually loaded — see the
      // guard in pruneStudyResponses.
      const ids = queue.map(entry => entry.task?.id);
      if (queue.length && typeof pruneStudyResponses === 'function') {
        await pruneStudyResponses(ids);
      }
      if (queue.length && typeof pruneStudyGroundTruth === 'function') {
        await pruneStudyGroundTruth(ids);
      }
      if (queue.length && typeof pruneStudyTaskEdits === 'function') {
        await pruneStudyTaskEdits(ids);
      }
      return queue;
    } catch (e) {
      console.error('[Study] Failed to load user_study_data/tasks.json:', e);
      return [];
    }
  }

  // ── Timer ──
  function startTimer() {
    s.timerStart = Date.now();
    s.timerInterval = setInterval(() => {
      const elapsed = Date.now() - s.timerStart;
      const remaining = Math.max(0, STUDY_TASK_TIME_LIMIT_MS - elapsed);
      const t = _formatStudyTime(remaining);
      const urgent = remaining <= 30_000;
      const el = $('study-timer');
      if (el) { el.textContent = t; el.style.color = urgent ? '#ff4757' : ''; }
      const mini = $('study-mini-timer');
      if (mini) { mini.textContent = t; mini.style.color = urgent ? '#ff4757' : ''; }
      if (remaining <= 0) {
        const doneBtn = $('study-done-btn') || $('study-mini-done');
        if (doneBtn) doneBtn.click();
      }
    }, 1000);
  }

  function stopTimer() {
    if (s.timerInterval) { clearInterval(s.timerInterval); s.timerInterval = null; }
    const elapsed = s.timerStart ? (Date.now() - s.timerStart) : 0;
    s.timerStart = null;
    return elapsed;
  }

  // ── Tab navigation ──
  async function openTaskPage(url) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs[0]) await chrome.tabs.update(tabs[0].id, { url });
    } catch (e) {
      console.error('[Study] Could not navigate tab:', e);
    }
  }

  // ── Behavior tracking ──
  async function startBehaviorTracking() {
    try {
      chrome.runtime.sendMessage({ action: 'studyTracker_start' }).catch(() => {});
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: 'studyTracker_start' }).catch(() => {});
    } catch (e) {}
  }

  // Returns behavior counts already shaped to the study_task_results column names.
  async function stopBehaviorTracking() {
    const out = {
      scroll_user_count: 0, scroll_agent_count: 0, ctrl_f_count: 0, text_select_count: 0,
      click_count: 0, mouse_move_px: 0, agent_think_ms: [], page_visit_count: 0, page_visit_urls: [],
    };
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) await chrome.tabs.sendMessage(tabs[0].id, { action: 'studyTracker_stop' }).catch(() => {});
      const d = await chrome.runtime.sendMessage({ action: 'studyTracker_getData' });
      if (d) {
        out.scroll_user_count  = d.scrollUser  || 0;
        out.scroll_agent_count = d.scrollAgent || 0;
        out.ctrl_f_count       = d.ctrlF       || 0;
        out.text_select_count  = d.textSelect  || 0;
        out.click_count        = d.click       || 0;
        out.mouse_move_px      = d.mouseMove   || 0;
        out.agent_think_ms     = d.agentThinkMs || [];
        out.page_visit_count   = (d.pages || []).length;
        out.page_visit_urls    = (d.pages || []).map(p => p.url);
      }
    } catch (e) {
      console.error('[Study] stopBehaviorTracking:', e);
    }
    return out;
  }

  function snapshotChat() {
    const msgs = (typeof chatMessages !== 'undefined' && Array.isArray(chatMessages)) ? chatMessages : [];
    return {
      chat_turn_count: msgs.filter(m => m.type === 'user').length,
      chat_transcript: msgs.map(m => ({ role: m.type, content: m.content, ts: m.timestamp })),
    };
  }

  function isNonGroundingStudySnapshot() {
    try {
      return typeof _isPanelNonGrounding === 'function' && _isPanelNonGrounding();
    } catch (e) {
      return false;
    }
  }

  function snapshotLlmAnswers() {
    const container = document.getElementById('pageguide-messages');
    const groundingEnabled = !isNonGroundingStudySnapshot();
    const nodes = container
      ? Array.from(container.querySelectorAll('.pageguide-message.assistant'))
      : [];
    const answers = nodes
      .map(node => {
        const rawText = (node.textContent || '').trim();
        if (!rawText) return null;
        if (!groundingEnabled) return { text: rawText };
        // The chips are about to be stripped, but their answer id is the handle on the parked
        // result — the only place the answer still exists with its markers intact, which is what
        // "Save as Grounded" has to record.
        const answerId = node.querySelector('.pageguide-study-save-chip')?.dataset.answerId || null;
        const html = _sanitizeStudyAnswerHtml(node.innerHTML);
        const text = _studyAnswerTextFromHtml(html);
        // A bubble that was ONLY the "Evidence on the page" card has nothing left to show.
        if (!text) return null;
        return { html, text, className: node.className, answerId };
      })
      .filter(Boolean);
    return { groundingEnabled, answers };
  }

  function renderLlmAnswers(snapshot) {
    const answers = snapshot?.answers || [];
    // The box is still worth rendering with no live answer: in authoring mode the tabs are how the
    // banked Grounded / Non-grounded records are read back, and a run that produced nothing is
    // exactly when you want to look at what is already recorded.
    if (!answers.length && !_studyRecording()) return '';
    const groundingEnabled = !!snapshot?.groundingEnabled;
    // A run often leaves more than one answer in the chat — a first attempt and a re-ask, say — and
    // only one of them is the one to bank. With a choice to make, each answer gets a picker; with a
    // single answer there is nothing to choose and the control would only be noise.
    const pickable = _studyRecording() && answers.length > 1;
    const rows = answers.map((answer, i) => {
      const body = (groundingEnabled && answer.html)
        ? `<div class="study-llm-answer-message ${escapeAttr(answer.className || 'pageguide-message assistant')}">${answer.html}</div>`
        : `<div class="study-llm-answer-message study-llm-answer-plain">${escapeHTML(answer.text)}</div>`;
      if (!pickable) return body;
      // Last by default: a re-ask is normally the one worth keeping.
      const checked = i === answers.length - 1 ? ' checked' : '';
      return `<div class="study-live-answer" data-live-index="${i}">
        <label class="study-live-pick"><input type="radio" name="study-live-pick" value="${i}"${checked}><span>Answer ${i + 1}</span></label>
        ${body}
      </div>`;
    }).join('');
    return `
      <div class="study-llm-answers" id="study-llm-answers">
        <div class="study-llm-answers-head">
          <div class="study-llm-answers-title">LLM answers</div>
          ${studyAnswerArmSwitchHtml()}
        </div>
        <div class="study-llm-answers-list" id="study-llm-answers-list">${rows}</div>
        ${_studyRecording() ? '<div class="study-arm-actions" id="study-arm-actions"></div>' : ''}
        <div class="study-llm-answers-note" id="study-llm-answers-note"></div>
      </div>`;
  }

  /**
   * A participant's answer box: exactly one recorded answer, no tabs and no actions. Which arm it is
   * was decided once at the start of the run — showing both would let the same answer be read twice
   * over, in two forms, which is the one thing the two arms exist to keep apart.
   */
  function renderPlaybackAnswer(record) {
    return `
      <div class="study-llm-answers" id="study-llm-answers">
        <div class="study-llm-answers-head">
          <div class="study-llm-answers-title">Agent answer</div>
        </div>
        <div class="study-llm-answers-list" id="study-llm-answers-list">${studySavedAnswerHtml(record)}</div>
      </div>`;
  }

  /**
   * Researcher-only authoring surface over the LLM answers box. Debug mode only.
   *
   * Three tabs, and the tab you are on IS the thing you act on: Live is the answer this run just
   * produced, Grounded and Non-grounded are the two banked records for this question. The pipeline
   * runs left to right —
   *
   *   run the task grounded → 💾 Save as Grounded → ✂️ Strip → ✏️ Edit the bare draft → 💾 Save as
   *   Non-grounded
   *
   * — so both arms come from ONE generation and differ only in grounding, which is the point of
   * recording them at all. A stripped answer is an in-memory draft until it is saved, so a strip
   * that reads badly costs nothing.
   */
  function studyAnswerArmSwitchHtml() {
    if (!_studyRecording()) return '';
    const cells = STUDY_V2_VARIANTS.map(v =>
      `<button class="study-arm-btn" data-arm="${v}">${_armLabel(v)} `
      + `<span class="study-arm-badge" data-badge="${v}">–</span></button>`).join('');
    return `
      <div class="study-answer-arm-switch" id="study-answer-arm-switch">
        <button class="study-arm-btn study-arm-btn-active" data-arm="live">Live</button>
        ${cells}
      </div>`;
  }

  /** The V1 arm names, still what the participant-facing screens label by. */
  const STUDY_ARM_LABELS = { grounding: 'Grounded', nongrounding: 'Non-grounded' };

  /**
   * What to call one arm or one V2 cell, so each is spelt once. V2 authors four rather than two —
   * see STUDY_V2_VARIANTS in study_responses.js for why.
   *
   * Resolved at CALL time, not at load time: study_responses.js owns V2_VARIANT_LABELS and this
   * file is loaded before it, so folding the two tables together up here threw a ReferenceError
   * on every panel open.
   */
  function _armLabel(name) {
    return STUDY_ARM_LABELS[name]
      || (typeof V2_VARIANT_LABELS !== 'undefined' ? V2_VARIANT_LABELS[name] : null)
      || name;
  }

  /** • saved · ✎ unsaved draft · – nothing yet. */
  function _studyArmBadge(arm) {
    if (arm.dirty) return '✎';
    return arm.record ? '•' : '–';
  }

  /** The text an arm currently holds: its unsaved draft if there is one, else what is banked. */
  function _studyArmText(arm) {
    if (arm.draft != null) return arm.draft;
    return arm.record?.answer_display || arm.record?.answer_raw || '';
  }

  /**
   * One answer, rendered the way the chat would render it: markers live, crops left out.
   *
   * `evidence` is separate from the text on purpose. An unsaved draft — a live answer just edited,
   * or a banked one being rewritten — is a bare string, and _expandEvidenceKeyCitations DELETES any
   * [ev:key] it cannot resolve. Rendering a draft without its arm's evidence therefore made every
   * annotation marker disappear the moment the answer was edited, which reads exactly like the edit
   * having thrown them away.
   *
   * @param {object|string} record - a stored record, or the raw text of a draft
   * @param {Array<object>} [evidence] - overrides the record's own; required for a draft
   */
  function studySavedAnswerHtml(record, evidence) {
    const answer = typeof record === 'string'
      ? record
      : (record?.answer_display || record?.answer_raw || '');
    const shots = Array.isArray(evidence)
      ? evidence
      : (Array.isArray(record?.evidence) ? record.evidence : []);
    let body = escapeHTML(answer);
    try {
      if (typeof parseMarkdown === 'function' && typeof parseCitations === 'function') {
        body = parseCitations(parseMarkdown(answer));
        if (typeof _expandEvidenceKeyCitations === 'function') {
          body = _expandEvidenceKeyCitations(body, shots);
        }
      }
    } catch (e) {
      body = escapeHTML(answer);
    }
    // pageguide-clickable so a banked answer behaves like the live one: click it and every citation
    // opens out into the sentence it points at. Only when there ARE citations — see
    // _studyAnswerIsClickable.
    const clickable = _studyAnswerIsClickable(body) ? ' pageguide-clickable' : '';
    return `<div class="study-llm-answer-message pageguide-message assistant${clickable}">${body}</div>`;
  }

  /**
   * Wire the tabs and their per-arm actions. Only the answer list and the action row are re-rendered,
   * so the delegated click handlers bound by bindStudyLlmAnswerLinks keep working on whatever shows.
   */
  async function bindStudyAnswerArmSwitch(task, snapshot) {
    const sw = $('study-answer-arm-switch');
    const list = $('study-llm-answers-list');
    if (!sw || !list) return;
    const note = $('study-llm-answers-note');
    const actions = $('study-arm-actions');
    let liveHtml = list.innerHTML;
    const taskId = task?.id || '';

    // The live answers with their markers intact, plus their evidence — parked by the panel when
    // each bubble was rendered. Without a payload (debug off at answer time, or it aged out) the
    // grounded record would be a text-only shell, so Save is refused rather than saving that.
    const liveAnswerIds = (snapshot?.answers || []).map(a => a.answerId ?? null);
    // Which of them the Live actions apply to; the radios in the list drive this. Last by default,
    // matching the checked radio rendered above.
    let liveIndex = Math.max(0, liveAnswerIds.length - 1);
    const parkedLive = () => {
      const id = liveAnswerIds[liveIndex];
      return (id != null && typeof _getAnswerPayload === 'function') ? _getAnswerPayload(id) : null;
    };

    const arms = {};
    for (const variant of STUDY_V2_VARIANTS) {
      arms[variant] = {
        record: taskId ? await getStudyResponse(taskId, variant) : null,
        draft: null,
        dirty: false
      };
    }
    // With no live answer this run, open on whichever cell actually has something to read rather
    // than on an empty Live tab.
    const hasLive = !!(snapshot?.answers || []).length;
    let active = hasLive
      ? 'live'
      : (STUDY_V2_VARIANTS.find(v => arms[v].record) || 'live');

    const setNote = (msg) => { if (note) note.textContent = msg || ''; };

    /**
     * Put the shown answer's OWN evidence marks on the page.
     *
     * Without this the page keeps whatever the last live capture drew, so a banked record's [ev]
     * markers jumped to another run's marks — the answer on screen and the evidence on the page
     * were from different answers. Each record carries its marks for exactly this. The non-grounded
     * arm has none, which clears them: a bare answer must leave no evidence on the page.
     */
    const syncEvidenceMarks = (marks) => {
      if (typeof sendToContentScript !== 'function') return;
      sendToContentScript({ action: 'showStudyEvidenceMarks', marks: marks || [] }).catch(() => {});
    };

    /**
     * Make the page match the answer on screen: replay banked Grounded citations, hide them for the
     * non-grounded arm, and draw the arm's own visual evidence marks.
     */
    const syncPageForArm = (name) => {
      if (typeof sendToContentScript !== 'function') return;
      // Read grounded-ness off the cell rather than matching a name, so the incorrect-grounded
      // cell replays its citations too — a wrong answer with real citations is the whole point of
      // the incorrect arm, and matching 'grounding' exactly would have shown it bare.
      if (name !== 'live' && _variantIsGrounded(name)) {
        const record = arms[name]?.record;
        const answer = record?.answer_raw || record?.answer_display || '';
        const anchors = Array.isArray(record?.citation_anchors) ? record.citation_anchors : [];
        if (answer && (anchors.length || /\[\d+:"/.test(answer))) {
          sendToContentScript({ action: 'showSavedGrounding', anchors, answer }).catch(() => {});
        }
      } else if (name !== 'live') {
        sendToContentScript({ action: 'showSavedGrounding', anchors: [], answer: '' }).catch(() => {});
        sendToContentScript({ action: 'setAnswerHighlightsVisible', visible: false }).catch(() => {});
      } else {
        sendToContentScript({ action: 'setAnswerHighlightsVisible', visible: true }).catch(() => {});
      }
      syncEvidenceMarks(marksForArm(name));
    };

    const marksForArm = (name) => {
      if (name === 'live') {
        const shots = parkedLive()?.result?.findEvidenceShots;
        return (Array.isArray(shots) ? shots : []).map(item => item?.marks).filter(Boolean);
      }
      const evidence = arms[name]?.record?.evidence;
      return (Array.isArray(evidence) ? evidence : []).map(item => item?.marks).filter(Boolean);
    };

    const refreshBadges = () => {
      sw.querySelectorAll('.study-arm-badge').forEach(el => {
        el.textContent = _studyArmBadge(arms[el.dataset.badge]);
      });
    };

    function actionsHtml() {
      if (!actions) return '';
      if (active === 'live') {
        // Name the target when there is a choice, so it is never ambiguous which answer is banked.
        const which = liveAnswerIds.length > 1 ? ` (answer ${liveIndex + 1})` : '';
        // TWO targets, because which cell a live run belongs in is a judgement the researcher makes
        // and the panel cannot: the same question run on a weaker model produces the incorrect arm's
        // answer, and it arrives here looking exactly like the correct one.
        return `<button class="study-act-btn study-act-primary" data-act="save-live" data-variant="correct_grounding">💾 Save as ${_armLabel('correct_grounding')}${which}</button>` +
          `<button class="study-act-btn" data-act="save-live" data-variant="incorrect_grounding">💾 Save as ${_armLabel('incorrect_grounding')}${which}</button>` +
          `<button class="study-act-btn" data-act="edit">✏️ Edit</button>`;
      }
      const arm = arms[active];
      const hasText = !!_studyArmText(arm);
      // Strips down its own row of the 2x2 — see _bareTwinOf. A wrong answer with the citations
      // taken out is still the wrong answer, not the correct arm's bare version.
      const strip = _variantIsGrounded(active) && hasText
        ? `<button class="study-act-btn" data-act="strip">✂️ Strip → ${_armLabel(_bareTwinOf(active))}</button>` : '';
      const edit = hasText ? `<button class="study-act-btn" data-act="edit">✏️ Edit</button>` : '';
      const save = arm.dirty
        ? `<button class="study-act-btn study-act-primary" data-act="save-arm">💾 Save as ${_armLabel(active)}</button>` : '';
      return strip + edit + save;
    }

    function render() {
      list.dataset.studyActiveArm = active;
      list._studyArms = arms;
      if (active === 'live') {
        list.innerHTML = hasLive
          ? liveHtml
          : '<div class="study-llm-answer-message study-llm-answer-plain">No live answer this run.</div>';
        // liveHtml is the original markup, so re-rendering resets the radios to their default.
        const picked = list.querySelector(`.study-live-answer[data-live-index="${liveIndex}"] input`);
        if (picked) picked.checked = true;
      } else {
        const arm = arms[active];
        const text = _studyArmText(arm);
        list.innerHTML = text
          ? studySavedAnswerHtml(arm.draft != null ? arm.draft : arm.record, arm.record?.evidence)
          : `<div class="study-llm-answer-message study-llm-answer-plain">Nothing recorded for the ${_armLabel(active)} cell yet.</div>`;
      }
      if (actions) actions.innerHTML = actionsHtml();
      sw.querySelectorAll('.study-arm-btn').forEach(b => {
        b.classList.toggle('study-arm-btn-active', b.dataset.arm === active);
      });
      refreshBadges();
      // The page follows the tab: whatever answer is on screen, its highlights and its evidence are
      // what the page shows.
      syncPageForArm(active);
    }

    const show = (arm) => { active = arm; setNote(''); render(); };

    /**
     * Write one arm's current text to storage.
     *
     * The three cases differ in what happens to the EVIDENCE, which is the part that is easy to
     * lose: it carries the marks every [ev] marker scrolls to, and a record rebuilt from edited
     * text alone keeps the prose and its [N:"…"] spans while silently dropping the annotations.
     * _buildStudyArmRecord is where that decision lives.
     */
    async function persist(armName, { fromParked = false } = {}) {
      if (!taskId) { setNote('This task has no id, so there is nothing to file the answer under.'); return false; }
      const arm = arms[armName];
      const parked = fromParked ? parkedLive() : null;
      const toSave = _buildStudyArmRecord({
        taskId,
        condition: armName,
        url: parked?.url || arm.record?.url || task?.url || '',
        question: parked?.question || arm.record?.question || task?.question || '',
        existing: arm.record || null,
        result: fromParked ? (parked?.result || {}) : null,
        text: _studyArmText(arm)
      });
      let anchorNote = '';
      const citationCount = _studyCitationCount(toSave.answer_raw || toSave.answer_display || '');
      const anchorCount = Array.isArray(toSave.citation_anchors) ? toSave.citation_anchors.length : 0;
      if (_variantIsGrounded(armName) && /\[\d+:"/.test(toSave.answer_raw || toSave.answer_display || '')
        && anchorCount < citationCount
        && typeof _attachCitationAnchors === 'function') {
        const anchored = await _attachCitationAnchors(toSave);
        anchorNote = anchored.total
          ? ` Anchored ${anchored.resolved}/${anchored.total} citation${anchored.total === 1 ? '' : 's'}`
            + `${anchored.reason ? ` (${anchored.reason})` : ''}.`
          : '';
      }
      // Only a record built from a fresh result carries crops worth downscaling.
      const res = await saveStudyResponse(toSave, { downscale: fromParked });
      if (!res.saved) { setNote(`Could not save: ${res.error || 'unknown error'}`); return false; }
      arm.record = toSave;
      arm.draft = null;
      arm.dirty = false;
      setNote(`Saved ${_armLabel(armName)} answer for ${taskId}${res.synced ? ' (synced)' : ' (local)'}.${anchorNote}`);
      return true;
    }

    sw.addEventListener('click', (e) => {
      const btn = e.target.closest('.study-arm-btn');
      if (btn) show(btn.dataset.arm);
    });

    // Picking which live answer the Live actions target. Only the action row is redrawn — a full
    // re-render would collapse any citations the researcher had opened out to compare the two.
    list.addEventListener('change', (e) => {
      const radio = e.target.closest('input[name="study-live-pick"]');
      if (!radio) return;
      liveIndex = Number(radio.value) || 0;
      setNote('');
      if (actions) actions.innerHTML = actionsHtml();
      syncPageForArm('live');
    });

    actions?.addEventListener('click', async (e) => {
      const btn = e.target.closest('.study-act-btn');
      if (!btn) return;
      const act = btn.dataset.act;

      if (act === 'save-live') {
        const variant = btn.dataset.variant || 'correct_grounding';
        if (!parkedLive()?.result) {
          setNote('The live answer is no longer in memory — re-run the question, then save.');
          return;
        }
        if (await persist(variant, { fromParked: true })) show(variant);
        else render();
        return;
      }

      if (act === 'strip') {
        const source = _studyArmText(arms[active]);
        if (!source) return;
        const target = _bareTwinOf(active);
        arms[target].draft = _stripStudyGrounding(source);
        arms[target].dirty = true;
        show(target);
        setNote(`Stripped from the ${_armLabel(active)} answer — edit it, then save. `
          + 'Nothing is stored until you do.');
        return;
      }

      if (act === 'edit') {
        const parked = active === 'live' ? parkedLive() : null;
        const current = active === 'live'
          ? (parked?.result?.findAnswer || parked?.result?.answer || '')
          : _studyArmText(arms[active]);
        if (active === 'live' && !parked?.result) {
          setNote('The live answer is no longer in memory — re-run the question to edit it.');
          return;
        }
        const next = await openStudyAnswerEditor(current, {
          title: active === 'live' ? 'Edit the live answer' : `Edit the ${_armLabel(active)} answer`,
          hint: 'Markers are live: <code>[N:"…"]</code> scrolls to a highlighted span, <code>[ev:key]</code> to an annotation on the page.'
        });
        if (next == null) return;
        if (active === 'live') {
          // Keep the panel's copy in step, so a later Save as Grounded records the edited text.
          if (parked.result.findAnswer) parked.result.findAnswer = next;
          parked.result.answer = next;
          // Replace only the answer that was edited: the others, and the pickers beside them, stay.
          const slot = list.querySelector(`.study-live-answer[data-live-index="${liveIndex}"] .study-llm-answer-message`)
            || list.querySelector('.study-llm-answer-message');
          const shots = Array.isArray(parked.result.findEvidenceShots) ? parked.result.findEvidenceShots : [];
          if (slot) slot.outerHTML = studySavedAnswerHtml(next, shots);
          else list.innerHTML = studySavedAnswerHtml(next, shots);
          liveHtml = list.innerHTML; // so switching away and back shows the edit, not the original
          return;
        }
        arms[active].draft = next;
        arms[active].dirty = true;
        render();
        return;
      }

      if (act === 'save-arm') {
        await persist(active);
        render();
      }
    });

    render();
  }

  function bindStudyLlmAnswerLinks(snapshot) {
    const box = $('study-llm-answers');
    // Bound whether or not the live answer is grounded: the arm switch can put a grounded recording
    // in this box during a non-grounding session, and its markers have to work.
    if (!box) return;
    // Hovering a citation pulses the span it points at, so the reader can see where a click lands
    // before making it — the same behaviour as in the chat.
    if (typeof bindCitationHoverPreview === 'function') bindCitationHoverPreview(box);
    box.addEventListener('click', async (e) => {
      // Authoring chips (debug mode only — they are not rendered otherwise). Same dialogs the chat
      // panel opens; the parked payload they read lives in panel.js and is keyed by answer id.
      const saveChip = e.target.closest('.pageguide-study-save-chip');
      if (saveChip) {
        e.stopPropagation();
        if (typeof openStudySaveDialog === 'function') openStudySaveDialog(saveChip.dataset.answerId);
        return;
      }
      const editChip = e.target.closest('.pageguide-study-edit-chip');
      if (editChip) {
        e.stopPropagation();
        if (typeof openStudyEditDialog === 'function') openStudyEditDialog(editChip.dataset.answerId);
        return;
      }

      // [N] of an [ev] marker → the annotation drawn on the live page. Must come before the generic
      // .pageguide-citation branch below: an evidence citation carries both classes but has no
      // data-index, so it would fall through to scrollToIndex(NaN) and do nothing.
      const evCit = e.target.closest('.pageguide-evidence-citation');
      if (evCit) {
        e.stopPropagation();
        if (typeof sendToContentScript === 'function') {
          sendToContentScript({ action: 'scrollToEvidenceMark', index: Number(evCit.dataset.evidenceNum) });
        }
        return;
      }

      const pdfCit = e.target.closest('.pageguide-pdf-citation');
      if (pdfCit) {
        e.stopPropagation();
        const rangesJson = pdfCit.dataset.ranges;
        const pageNum = pdfCit.dataset.page ? parseInt(pdfCit.dataset.page, 10) : null;
        const searchText = pdfCit.dataset.text;
        let message = null;
        if (rangesJson) {
          try {
            const ranges = JSON.parse(rangesJson);
            message = { action: 'highlightByRanges', ranges };
          } catch (err) {}
        } else if (pageNum && searchText) {
          message = { action: 'navigateToPdfPage', page: pageNum, searchText };
        }
        if (message) {
          try {
            const tabs = await chrome.tabs.query({});
            const pdfViewerTab = tabs.find(t => t.url?.includes('pdf-viewer/viewer.html'));
            if (pdfViewerTab) {
              chrome.tabs.sendMessage(pdfViewerTab.id, message);
              chrome.tabs.update(pdfViewerTab.id, { active: true });
            } else if (typeof sendToContentScript === 'function') {
              sendToContentScript(message);
            }
          } catch (err) {
            if (typeof sendToContentScript === 'function') sendToContentScript(message);
          }
        }
        return;
      }

      const webCit = e.target.closest('.pageguide-citation');
      if (webCit) {
        e.stopPropagation();
        const index = parseInt(webCit.dataset.index, 10);
        if (typeof sendToContentScript === 'function') {
          const activeArm = _studyArmForRenderedCitation(webCit);
          const record = _studyRecordForRenderedCitation(webCit);
          const anchor = _studyAnchorForRenderedCitation(
            record,
            webCit.dataset.citation,
            webCit.dataset.index,
            _studyRenderedCitationQuote(webCit)
          );
          if (anchor && activeArm === 'grounding') {
            sendToContentScript({ action: 'scrollToCitationAnchor', anchor });
          } else if (Number.isFinite(index)) {
            // The citation number, so the jump lands on the span this marker created rather than the
            // paragraph around it — one paragraph often carries several citations.
            sendToContentScript({ action: 'scrollToIndex', index, citation: webCit.dataset.citation });
          }
        }
        return;
      }

      const msg = e.target.closest('.pageguide-message.pageguide-clickable');
      if (msg && !e.target.closest('button')) msg.classList.toggle('citations-expanded');
    });
  }

  async function _loadStudyOptions(action) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) return { success: false, options: [] };
      const resp = await chrome.tabs.sendMessage(tabs[0].id, { action });
      return {
        success: !!resp?.success,
        options: Array.isArray(resp?.options) ? resp.options : [],
        url: resp?.url || tabs[0].url || null,
      };
    } catch (e) {
      return { success: false, options: [] };
    }
  }

  // Both lists are read at Done time off the live page: paragraphs for the "which sentence?" hops,
  // images for the FIND × VISUAL "which image?" hop.
  async function loadStudyParagraphOptions() {
    const paragraphs = await _loadStudyOptions('getStudyParagraphOptions');
    const images = await _loadStudyOptions('getStudyImageOptions');
    return Object.assign({}, paragraphs, { images: images.options || [] });
  }

  /** The option list a hop is answered from. */
  function _studyHopOptions(hopKind, paragraphOptions) {
    return hopKind === 'image'
      ? (Array.isArray(paragraphOptions?.images) ? paragraphOptions.images : [])
      : (Array.isArray(paragraphOptions?.options) ? paragraphOptions.options : []);
  }

  /**
   * Resolve what the participant left in a hop's field back to an option.
   *
   * The control is type-or-pick, so the value is a label rather than an index: a flat dropdown of
   * 250 paragraphs was unreadable, and a participant could not tell which entry referred to what on
   * the page. Anything that does not match a known option is kept as their own words.
   */
  function _matchStudyEvidenceOption(value, options) {
    const v = String(value || '').replace(/\s+/g, ' ').trim();
    if (!v) return null;
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = norm(v);
    return (options || []).find(o => norm(o.label) === target || norm(o.text) === target) || null;
  }

  // ── Pointing at the page ──
  // One pick can be in flight at a time, and whoever armed it owns the result. The alternative —
  // each caller filtering the broadcast by the `channel` it asked for — quietly fails whenever the
  // tab is running a content script from before `channel` existed: the echo comes back as the
  // default and the caller ignores its own pick. It also let a researcher's ground-truth pick land
  // in the participant's evidence field, since that listener matched on hop alone.

  // Must match PG_STUDY_PICK_VERSION in content/functions/study_pick.js. A tab loaded before the
  // current picker keeps running the old one across an extension reload, so an out-of-date answer
  // here means "reload the page", not "the picker is broken".
  const STUDY_PICK_VERSION = 7;

  let _studyPendingPick = null;
  let _studyStalePickerWarned = false;

  function _studyCancelPendingPick() {
    if (!_studyPendingPick) return;
    chrome.runtime.onMessage.removeListener(_studyPendingPick.listener);
    _studyPendingPick.resolve(null);
    _studyPendingPick = null;
    if (typeof sendToContentScript === 'function') {
      sendToContentScript({ action: 'cancelStudyPick' }).catch(() => {});
    }
  }

  /**
   * Arm the page picker and wait for the confirmed pick.
   *
   * @param {{hop: number, kind: string, channel: string}} req
   * @returns {Promise<object|null>} the pick, null if it was superseded, or false if it never armed
   */
  async function _studyAwaitPick(req) {
    _studyCancelPendingPick();

    let resolve;
    const done = new Promise(r => { resolve = r; });
    const listener = (msg) => {
      if (msg?.action !== 'studyPickResult') return;
      if (Number(msg.hop) !== Number(req.hop)) return;
      chrome.runtime.onMessage.removeListener(listener);
      _studyPendingPick = null;
      // Idempotent, and the reason it is here: pick mode mutes the page's highlights for its
      // duration, so a picker that ended without unmuting — an older content script, a page that
      // navigated mid-pick — would leave the page stripped for the rest of the session.
      if (typeof sendToContentScript === 'function') {
        sendToContentScript({ action: 'cancelStudyPick' }).catch(() => {});
      }
      resolve(msg);
    };
    _studyPendingPick = { listener, resolve };
    chrome.runtime.onMessage.addListener(listener);

    let res = null;
    try {
      res = typeof sendToContentScript === 'function' ? await sendToContentScript(req) : null;
    } catch (e) {
      res = null;
    }
    if (!res?.success) {
      chrome.runtime.onMessage.removeListener(listener);
      if (_studyPendingPick?.listener === listener) _studyPendingPick = null;
      return false;
    }
    // Logged, not surfaced: a version gap is something to check in devtools when picking behaves
    // oddly, not a warning to put in front of someone mid-task.
    if (Number(res.version) !== STUDY_PICK_VERSION && !_studyStalePickerWarned) {
      _studyStalePickerWarned = true;
      console.warn(`[Study] the page is running picker v${res.version || 'unknown'}, this panel expects v${STUDY_PICK_VERSION} — reload the tab.`);
    }
    return done;
  }

  /**
   * The supporting-evidence block. Each hop is answered by POINTING at the page: "✏️ Annotate" puts
   * the tab into pick mode (content/functions/study_pick.js), the participant hovers and clicks the
   * sentence — or, for the image hop, the picture or its caption — and confirms with Done there.
   *
   * Neither typing nor a dropdown, and for opposite reasons. A dropdown of every paragraph on the
   * page hands over the candidate set, so a participant can land on the right answer by recognising
   * it rather than by having read the page. Free text was honest about that but slow to give and
   * fuzzy to score — a paraphrase is not the sentence. Pointing records exactly one element of the
   * page, with the same index the citations use, so the response can be scored directly.
   *
   * One selection per hop, which is what the study asks for; picking again replaces it.
   */
  function renderStudyEvidenceControls(task, paragraphOptions) {
    const prompts = _studyEvidencePrompts(task);

    return `
      <div class="study-evidence-section" id="study-evidence-section">
        <div class="study-evidence-title">Supporting evidence</div>
        ${prompts.map(({ hop, prompt, kind, hint }) => {
          const empty = kind === 'image'
            ? 'Nothing picked yet — use Annotate, then click the image or its caption on the page.'
            : 'Nothing picked yet — use Annotate, then click the sentence on the page.';
          return `
          <div class="study-evidence-item" data-hop="${hop}">
            <label class="study-evidence-label">${escapeHTML(prompt)}</label>
            ${hint ? `<p class="study-evidence-hint">${escapeHTML(hint)}</p>` : ''}
            <div class="study-evidence-picked study-evidence-picked-empty" id="study-evidence-hop-${hop}"
                 data-hop="${hop}" data-kind="${escapeAttr(kind || 'paragraph')}" data-text="" data-index="">${escapeHTML(empty)}</div>
            <div class="study-evidence-actions">
              <button type="button" class="study-evidence-annotate" data-study-pick="${hop}">✏️ Annotate</button>
              <button type="button" class="study-evidence-clear" data-study-locate="${hop}" hidden>📍 Show me where</button>
              <button type="button" class="study-evidence-clear" data-study-pick-clear="${hop}" hidden>Clear</button>
            </div>
          </div>`;
        }).join('')}
      </div>
    `;
  }

  /**
   * Take the reader back to what a recorded answer was picked from: scroll to it and put the page's
   * own "PageGuide highlight" badge on it. Cleared after a few seconds — it is a pointer, not a
   * state, and a badge left behind would compete with the answer's own highlights.
   */
  let _studyLocateTimer = null;
  let _studyHoverTimer = null;
  // Selectors currently pinned on the page by "Show on page". Hovering an entry marks that one
  // instead for as long as the pointer is on it; letting go puts the set back rather than leaving
  // the page bare, which would read as the button having switched itself off.
  let _studyShownSelectors = [];

  function locatePickedTarget(selector, { scroll = 'always', clearAfter = 4000 } = {}) {
    if (!selector || typeof sendToContentScript !== 'function') return;
    if (_studyLocateTimer) { clearTimeout(_studyLocateTimer); _studyLocateTimer = null; }
    sendToContentScript({ action: 'markPickedTarget', selector, scroll }).catch(() => {});
    if (clearAfter) {
      _studyLocateTimer = setTimeout(() => {
        sendToContentScript({ action: 'markPickedTarget', on: false }).catch(() => {});
        _studyLocateTimer = null;
      }, clearAfter);
    }
  }

  function clearLocatedTarget() {
    if (_studyHoverTimer) { clearTimeout(_studyHoverTimer); _studyHoverTimer = null; }
    if (_studyLocateTimer) { clearTimeout(_studyLocateTimer); _studyLocateTimer = null; }
    if (typeof sendToContentScript !== 'function') return;
    if (_studyShownSelectors.length) {
      sendToContentScript({ action: 'markPickedTarget', selectors: _studyShownSelectors, scroll: 'never' })
        .catch(() => {});
      return;
    }
    sendToContentScript({ action: 'markPickedTarget', on: false }).catch(() => {});
  }

  /** Pin every accepted answer on the page at once, or take them all off. */
  function showTargetsOnPage(selectors) {
    if (typeof sendToContentScript !== 'function') return Promise.resolve(null);
    if (_studyLocateTimer) { clearTimeout(_studyLocateTimer); _studyLocateTimer = null; }
    _studyShownSelectors = Array.isArray(selectors) ? selectors.filter(Boolean) : [];
    if (!_studyShownSelectors.length) {
      return sendToContentScript({ action: 'markPickedTarget', on: false }).catch(() => null);
    }
    return sendToContentScript({ action: 'markPickedTarget', selectors: _studyShownSelectors, scroll: 'ifNeeded' })
      .catch(() => null);
  }

  /**
   * Hovering a recorded pick marks it on the page, and brings it into view only if it is not
   * already there. An image pick reads as a short name — "Image: A team photograph" — so "which one
   * was that?" has to be answerable without leaving the panel; scrolling a page that is already
   * showing it would answer a question nobody asked.
   */
  function bindLocateOnHover(el, getSelector) {
    el.addEventListener('mouseenter', () => {
      const selector = getSelector();
      if (!selector) return;
      if (_studyHoverTimer) clearTimeout(_studyHoverTimer);
      // The pointer crosses these on its way elsewhere; only a deliberate hover should move a page.
      _studyHoverTimer = setTimeout(() => locatePickedTarget(selector, { scroll: 'ifNeeded', clearAfter: 0 }), 160);
    });
    el.addEventListener('mouseleave', clearLocatedTarget);
  }

  /** Write a picked element into its hop, or clear it back to the empty state. */
  function _setStudyPickedEvidence(hop, picked) {
    const field = $(`study-evidence-hop-${hop}`);
    if (!field) return;
    const clearBtn = overlay.querySelector(`[data-study-pick-clear="${hop}"]`);
    const locateBtn = overlay.querySelector(`[data-study-locate="${hop}"]`);
    const annotateBtn = overlay.querySelector(`[data-study-pick="${hop}"]`);
    if (!picked) {
      field.dataset.text = '';
      field.dataset.index = '';
      field.dataset.url = '';
      field.classList.add('study-evidence-picked-empty');
      field.textContent = field.dataset.kind === 'image'
        ? 'Nothing picked yet — use Annotate, then click the image or its caption on the page.'
        : 'Nothing picked yet — use Annotate, then click the sentence on the page.';
      if (clearBtn) clearBtn.hidden = true;
      if (locateBtn) locateBtn.hidden = true;
      if (annotateBtn) annotateBtn.textContent = '✏️ Annotate';
      return;
    }
    field.dataset.text = picked.text || '';
    field.dataset.index = picked.index == null ? '' : String(picked.index);
    field.dataset.url = picked.url || '';
    field.classList.remove('study-evidence-picked-empty');
    field.textContent = picked.text || '';
    if (clearBtn) clearBtn.hidden = false;
    if (locateBtn) locateBtn.hidden = !picked.selector;
    if (annotateBtn) annotateBtn.textContent = '✏️ Pick again';
  }

  /**
   * Wire the Annotate buttons and listen for the confirmed pick.
   *
   * The result arrives as a runtime message rather than as the reply to startStudyPick: the
   * participant takes as long as they like to find their sentence, and a held-open sendMessage
   * channel would not survive that.
   */
  function bindStudyEvidenceControls() {
    overlay.querySelectorAll('[data-study-pick]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const hop = Number(btn.dataset.studyPick);
        const kind = $(`study-evidence-hop-${hop}`)?.dataset.kind || 'paragraph';

        overlay.querySelectorAll('.study-evidence-annotate').forEach(b => b.classList.remove('is-picking'));
        btn.classList.add('is-picking');

        const picked = await _studyAwaitPick({ action: 'startStudyPick', hop, kind, channel: 'evidence' });
        btn.classList.remove('is-picking');

        if (picked === false) {
          // A restricted page, or one with nothing pickable on it. Say so on the button rather than
          // leaving it looking armed when nothing is listening on the page.
          const label = btn.textContent;
          btn.textContent = '⚠️ Nothing to annotate here';
          setTimeout(() => { btn.textContent = label; }, 2000);
          return;
        }
        if (picked) _setStudyPickedEvidence(hop, picked);
      });
    });

    overlay.querySelectorAll('[data-study-pick-clear]').forEach(btn => {
      btn.addEventListener('click', () => _setStudyPickedEvidence(Number(btn.dataset.studyPickClear), null));
    });

    // Clicking what was recorded takes you back to it on the page — the answer to "which one did I
    // pick?", which a short image label cannot give on its own.
    overlay.querySelectorAll('.study-evidence-picked').forEach(field => {
      field.addEventListener('click', () => locatePickedTarget(field.dataset.selector));
      bindLocateOnHover(field, () => field.dataset.selector);
    });

    // An explicit way back to what was chosen. Hovering the recorded text does the same thing, but
    // only once you know it does; a button says so.
    overlay.querySelectorAll('[data-study-locate]').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = $(`study-evidence-hop-${btn.dataset.studyLocate}`);
        locatePickedTarget(field?.dataset.selector);
      });
    });
  }

  // ── Citation picker (Record User Study only) ──
  // Writing a grounded answer by hand means writing markers by hand, and a marker is only correct if
  // its index and its quoted text agree: [N:"text"] searches for the text INSIDE the element N
  // points at, so a guessed N silently highlights nothing (or the whole paragraph). Pointing at the
  // page is the only way to get both halves right at once.

  function renderStudyCitationPicker() {
    if (!_studyRecording()) return '';
    return `
      <div class="study-cite-section" id="study-cite-section">
        <div class="study-truth-head">
          <span class="study-cite-title">Citation picker</span>
          <span class="study-truth-note" id="study-cite-note"></span>
        </div>
        <div class="study-cite-out" id="study-cite-out">Pick something on the page to get a marker you can paste into the answer.</div>
        <div class="study-evidence-actions">
          <button type="button" class="study-evidence-annotate" id="study-cite-pick">🎯 Pick from the page</button>
          <button type="button" class="study-evidence-clear" id="study-cite-copy" hidden>📋 Copy marker</button>
        </div>
      </div>`;
  }

  function bindStudyCitationPicker() {
    const section = $('study-cite-section');
    if (!section) return;
    const out = $('study-cite-out');
    const note = $('study-cite-note');
    const copyBtn = $('study-cite-copy');
    let marker = '';

    const setNote = (msg) => { if (note) note.textContent = msg || ''; };

    section.addEventListener('click', async (e) => {
      if (e.target.closest('#study-cite-copy')) {
        if (!marker) return;
        try {
          await navigator.clipboard.writeText(marker);
          copyBtn.textContent = '✅ Copied';
          setTimeout(() => { copyBtn.textContent = '📋 Copy marker'; }, 1500);
        } catch (err) { setNote('Could not copy — select the marker and copy it by hand.'); }
        return;
      }

      const pick = e.target.closest('#study-cite-pick');
      if (!pick) {
        // Clicking the marker itself takes you back to what it points at.
        if (out?.dataset.selector && e.target.closest('#study-cite-out')) locatePickedTarget(out.dataset.selector);
        return;
      }

      pick.classList.add('is-picking');
      // hop 0 keeps this out of the two supporting-evidence hops, which listen on 1 and 2.
      const picked = await _studyAwaitPick({ action: 'startStudyPick', hop: 0, kind: 'paragraph', channel: 'citation' });
      pick.classList.remove('is-picking');
      if (picked === false) { setNote('Nothing on this page can be picked.'); return; }
      if (!picked) return;

      const text = String(picked.text || '').replace(/"/g, '\u201d');
      const index = picked.index;
      if (index == null) {
        marker = '';
        out.textContent = text;
        out.dataset.selector = picked.selector || '';
        if (copyBtn) copyBtn.hidden = true;
        setNote('No index for this element, so it cannot be cited as [N:"…"]. Pick a sentence inside a paragraph instead.');
        return;
      }
      marker = `[${index}:"${text}"]`;
      out.textContent = marker;
      out.dataset.selector = picked.selector || '';
      if (copyBtn) copyBtn.hidden = false;
      setNote(`Index ${index} · click the marker to see it on the page`);
    });
  }

  // ── Ground truth for the supporting questions (researcher-only) ──
  // Authored the same way a participant answers: by pointing at the page. A LIST per hop, because
  // the answer to a supporting question is often stated in more than one place, and marking a
  // participant wrong for pointing at the other one would be scoring the page, not the participant.

  /** The ground-truth panel's markup. Empty outside debug mode — participants never see it. */
  function renderStudyGroundTruth(task) {
    if (!_studyRecording()) return '';
    const prompts = _studyEvidencePrompts(task);
    return `
      <div class="study-truth-section" id="study-truth-section">
        <div class="study-truth-head">
          <span class="study-truth-title">Ground truth${task?.id ? ` · ${escapeHTML(task.id)}` : ''}</span>
          <span class="study-truth-note" id="study-truth-note"></span>
        </div>
        ${prompts.map(({ hop, prompt, kind, hint }) => `
          <div class="study-truth-hop" data-hop="${hop}" data-kind="${escapeAttr(kind || 'paragraph')}">
            <div class="study-truth-prompt">${escapeHTML(prompt)}</div>
            ${hint ? `<p class="study-evidence-hint">${escapeHTML(hint)}</p>` : ''}
            <div class="study-truth-list" id="study-truth-list-${hop}"></div>
            <div class="study-evidence-actions">
              <button type="button" class="study-evidence-annotate" data-truth-add="${hop}">➕ Add by annotating</button>
              <button type="button" class="study-evidence-clear" data-truth-type="${hop}">⌨️ Add by typing</button>
            </div>
          </div>`).join('')}
        <div class="study-evidence-actions study-truth-save-row">
          <button type="button" class="study-evidence-clear" id="study-truth-show">👁 Show on page</button>
          <button type="button" class="study-act-btn study-act-primary" id="study-truth-save">💾 Save ground truth</button>
        </div>
      </div>`;
  }

  function bindStudyGroundTruth(task) {
    const section = $('study-truth-section');
    if (!section || !task?.id) return;
    const note = $('study-truth-note');
    const prompts = _studyEvidencePrompts(task);
    const hops = {};
    prompts.forEach(({ hop }) => { hops[hop] = []; });
    // Whether anything has been added, removed or edited since this screen opened. The stored record
    // arrives asynchronously, and the researcher can be adding sentences before it does — applying
    // it then would wipe what they just pointed at, and the next Save would write the empty result
    // back over the record. So a late load defers to work in progress.
    let touched = false;

    const setNote = (msg) => { if (note) note.textContent = msg || ''; };

    /** The pinned set is a snapshot; changing the list makes it stale, so the toggle goes back off. */
    const resetShowOnPage = () => {
      const btn = $('study-truth-show');
      if (!btn || btn.dataset.on !== '1') return;
      btn.dataset.on = '';
      btn.textContent = '👁 Show on page';
      showTargetsOnPage([]);
    };

    const renderList = (hop) => {
      const list = $(`study-truth-list-${hop}`);
      if (!list) return;
      const entries = hops[hop] || [];
      list.innerHTML = entries.length
        ? entries.map((entry, i) => `
            <div class="study-truth-item" data-hop="${hop}" data-i="${i}">
              <span class="study-truth-item-text${entry.selector ? ' study-truth-item-locatable' : ''}"
                    data-truth-locate="${escapeAttr(entry.selector || '')}"
                    title="${entry.selector ? 'Click to go back to this on the page' : ''}">${escapeHTML(entry.text)}</span>
              <button type="button" class="study-truth-item-btn" data-truth-edit="${hop}:${i}" title="Edit this sentence">✏️</button>
              <button type="button" class="study-truth-item-btn" data-truth-remove="${hop}:${i}" title="Remove this sentence">✕</button>
            </div>`).join('')
        : '<div class="study-truth-empty">Nothing accepted yet — annotate on the page, or type/paste the sentence(s) that count as correct.</div>';
      // Re-bound each render: the list is rebuilt from scratch on every add, edit and remove.
      list.querySelectorAll('[data-truth-locate]').forEach(el => {
        if (el.dataset.truthLocate) bindLocateOnHover(el, () => el.dataset.truthLocate);
      });
    };

    prompts.forEach(({ hop }) => renderList(hop));
    getStudyGroundTruth(task.id).then(record => {
      if (!record || touched) return;
      let total = 0;
      Object.keys(hops).forEach(hop => {
        hops[hop] = Array.isArray(record.hops?.[String(hop)]) ? record.hops[String(hop)].slice() : [];
        total += hops[hop].length;
        renderList(hop);
      });
      setNote(`${total} accepted sentence${total === 1 ? '' : 's'} loaded${record.updated_at ? ` · saved ${new Date(record.updated_at).toLocaleString()}` : ''}`);
    }).catch(e => setNote(`Could not read the saved ground truth: ${e?.message || e}`));

    section.addEventListener('click', async (e) => {
      const add = e.target.closest('[data-truth-add]');
      if (add) {
        const hop = Number(add.dataset.truthAdd);
        const kind = section.querySelector(`.study-truth-hop[data-hop="${hop}"]`)?.dataset.kind || 'paragraph';

        section.querySelectorAll('[data-truth-add]').forEach(b => b.classList.remove('is-picking'));
        add.classList.add('is-picking');

        const picked = await _studyAwaitPick({ action: 'startStudyPick', hop, kind, channel: 'groundtruth' });
        add.classList.remove('is-picking');

        if (picked === false) { setNote('Nothing on this page can be annotated.'); return; }
        if (!picked) return;
        touched = true;
        resetShowOnPage();
        hops[hop] = (hops[hop] || []).concat([{
          text: picked.text, index: picked.index ?? null, url: picked.url || '', selector: picked.selector || ''
        }]);
        renderList(hop);
        setNote('Added — remember to save.');
        return;
      }

      // Typed or pasted, for anything the picker cannot reach — a sentence split across elements, a
      // page that fights the hover, or simply faster when the wording is already on the clipboard.
      // Only ground truth gets this: a participant's answer has to come off the page (see
      // renderStudyEvidenceControls), but ground truth is authored, not measured.
      const typed = e.target.closest('[data-truth-type]');
      if (typed) {
        const hop = Number(typed.dataset.truthType);
        const next = await openStudyAnswerEditor('', {
          title: 'Add an accepted sentence',
          hint: 'Paste or type the sentence exactly as it appears on the page. It is matched on its words, so it carries no page index.'
        });
        const text = String(next == null ? '' : next).replace(/\s+/g, ' ').trim();
        if (!text) return;
        touched = true;
        resetShowOnPage();
        hops[hop] = (hops[hop] || []).concat([{ text, index: null, url: task?.url || '' }]);
        renderList(hop);
        setNote('Added — remember to save.');
        return;
      }

      const locate = e.target.closest('[data-truth-locate]');
      if (locate && locate.dataset.truthLocate) {
        locatePickedTarget(locate.dataset.truthLocate);
        return;
      }

      const remove = e.target.closest('[data-truth-remove]');
      if (remove) {
        const [hop, i] = remove.dataset.truthRemove.split(':').map(Number);
        touched = true;
        resetShowOnPage();
        hops[hop].splice(i, 1);
        renderList(hop);
        setNote('Removed — remember to save.');
        return;
      }

      const edit = e.target.closest('[data-truth-edit]');
      if (edit) {
        const [hop, i] = edit.dataset.truthEdit.split(':').map(Number);
        const current = hops[hop]?.[i];
        if (!current) return;
        const next = await openStudyAnswerEditor(current.text, { title: 'Edit the accepted sentence' });
        if (next == null) return;
        // Hand-edited text no longer corresponds to the element it was picked from, so the index
        // goes with it — scoring falls back to the words, which is what was edited.
        touched = true;
        resetShowOnPage();
        hops[hop][i] = { text: String(next).trim(), index: null, url: current.url || '' };
        if (!hops[hop][i].text) hops[hop].splice(i, 1);
        renderList(hop);
        setNote('Edited — remember to save.');
        return;
      }

      // Every accepted answer at once — the paragraphs for the first question and the image for the
      // second, marked together. Reading them one hover at a time cannot show whether the set covers
      // the question or overlaps itself.
      const show = e.target.closest('#study-truth-show');
      if (show) {
        const on = show.dataset.on === '1';
        if (on) {
          show.dataset.on = '';
          show.textContent = '👁 Show on page';
          showTargetsOnPage([]);
          setNote('');
          return;
        }
        const entries = Object.values(hops).flat();
        const selectors = entries.map(entry => entry?.selector).filter(Boolean);
        if (!selectors.length) {
          setNote(entries.length
            ? 'These were typed, not picked, so there is nothing on the page to point at.'
            : 'Nothing accepted yet.');
          return;
        }
        show.dataset.on = '1';
        show.textContent = '🙈 Hide on page';
        const res = await showTargetsOnPage(selectors);
        const shown = Number(res?.count) || 0;
        setNote(shown === entries.length
          ? `Showing ${shown} on the page.`
          : `Showing ${shown} of ${entries.length} — the rest were typed, or the page has changed.`);
        return;
      }

      if (e.target.closest('#study-truth-save')) {
        const record = _buildGroundTruthRecord(task.id, hops);
        const total = Object.values(record.hops).reduce((n, list) => n + list.length, 0);
        const res = await saveStudyGroundTruth(record);
        if (res.saved) touched = false;
        setNote(res.saved
          ? `Saved ${total} sentence${total === 1 ? '' : 's'} for ${task.id}${res.synced ? ' (synced)' : ' (local)'}.`
          : `Could not save: ${res.error || 'unknown error'}`);
      }
    });
  }

  /**
   * Read both supporting-evidence hops. Each holds one element the participant pointed at, with the
   * page index it was picked from — so the response is scored against the page directly rather than
   * by matching prose. Both hops stay mandatory.
   */
  function collectStudyEvidenceResponses(taskType, task, paragraphOptions) {
    if (taskType !== 'find') return { valid: true, responses: [] };

    const prompts = _studyEvidencePrompts(task);
    const responses = [];

    for (const { hop, prompt, kind } of prompts) {
      const field = $(`study-evidence-hop-${hop}`);
      if (!field) return { valid: false, responses: [] };

      const text = String(field.dataset.text || '').trim();
      if (!text) return { valid: false, responses: [] };

      const index = parseInt(field.dataset.index, 10);
      // The catalog still has the final say on `role`, since the picker only knows what it pointed at.
      const opt = _matchStudyEvidenceOption(text, _studyHopOptions(kind, paragraphOptions));
      responses.push({
        hop,
        prompt,
        kind: kind || 'paragraph',
        index: Number.isFinite(index) ? index : (opt ? opt.index : null),
        role: opt ? (opt.role || null) : (kind === 'image' ? 'image' : 'picked'),
        text,
        url: field.dataset.url || paragraphOptions?.url || task?.url || null,
      });
    }

    return { valid: true, responses };
  }

  // Best-effort screenshot for guide-task completion; participant can decline.
  async function captureGuideScreenshot() {
    const allowed = await new Promise(resolve => {
      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);';
      modal.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid rgba(255,190,132,0.34);border-radius:12px;padding:24px 20px;max-width:260px;text-align:center;font-family:system-ui;color:#fff;">
          <div style="font-size:32px;margin-bottom:10px">📸</div>
          <div style="font-weight:700;font-size:15px;margin-bottom:8px">Take a screenshot?</div>
          <div style="font-size:13px;color:#aaa;margin-bottom:20px;line-height:1.5">We'd like to capture the current page to record your guide result.</div>
          <div style="display:flex;gap:8px">
            <button id="study-ss-deny" style="flex:1;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:#ccc;cursor:pointer;font-size:13px">No thanks</button>
            <button id="study-ss-allow" style="flex:1;padding:10px;border-radius:8px;border:none;background:#ffbe84;color:#fff;cursor:pointer;font-size:13px;font-weight:700">Allow</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.querySelector('#study-ss-allow').onclick = () => { modal.remove(); resolve(true); };
      modal.querySelector('#study-ss-deny').onclick  = () => { modal.remove(); resolve(false); };
    });
    if (!allowed) return null;
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'captureScreenshot' });
      return resp?.imageBase64 || null;
    } catch (e) { return null; }
  }

  // sidepanel/supabase_config.js defines these globals (gitignored, not present by default).
  function _supabaseConfigured() {
    return typeof SUPABASE_URL !== 'undefined' && SUPABASE_URL && !SUPABASE_URL.includes('YOUR_PROJECT');
  }

  function _supabaseHeaders(prefer) {
    return {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': prefer,
    };
  }

  // Best-effort insert into a Supabase table. Returns the created row when the anon role can read
  // it back (needs a SELECT policy), else null. No-ops when Supabase isn't configured.
  async function supabaseInsert(table, data) {
    if (!_supabaseConfigured()) return null;
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: _supabaseHeaders('return=representation'),
        body: JSON.stringify(data),
      });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        return (Array.isArray(json) && json[0]) || null;
      }
      // return=representation adds a RETURNING clause that RLS blocks when there's no anon SELECT
      // policy, rejecting the whole insert. Retry without RETURNING so the row is still created
      // (we just can't capture its id). A genuine INSERT-policy violation will fail again — fine.
      if (res.status === 401 || res.status === 403) {
        await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
          method: 'POST',
          headers: _supabaseHeaders('return=minimal'),
          body: JSON.stringify(data),
        }).catch(() => {});
      } else {
        console.error(`[Study] Supabase ${res.status} on ${table}:`, await res.text().catch(() => ''));
      }
    } catch (e) {
      console.warn(`[Study] Supabase insert into ${table} failed:`, e);
    }
    return null;
  }
  // study_responses.js reuses this rather than standing up a second Supabase client — it already
  // handles the anon key and the return=representation → return=minimal retry under RLS.
  window.supabaseInsert = supabaseInsert;

  // Create the parent study_sessions row at study start so task rows can reference session_id.
  /**
   * Where a participant's assignment slot comes from when the V2 project is not configured.
   *
   * A local counter is NOT as good as the server's: two machines running participants at once each
   * keep their own count, so the groups stay balanced on each machine but not across them. It
   * exists so the study still runs offline, not as an equal alternative — when V2 is configured the
   * atomic RPC is used instead.
   */
  const STUDY_LOCAL_SLOT_KEY = 'pageguide_study_local_slot';

  async function _nextLocalSlot() {
    try {
      const data = await chrome.storage.local.get(STUDY_LOCAL_SLOT_KEY);
      const slot = Math.max(0, Math.floor(Number(data?.[STUDY_LOCAL_SLOT_KEY]) || 0));
      await chrome.storage.local.set({ [STUDY_LOCAL_SLOT_KEY]: slot + 1 });
      return slot;
    } catch (e) {
      console.warn('[Study] local slot counter unreadable, falling back to 0:', e);
      return 0;
    }
  }

  /**
   * Deal this participant their group and their four questions, and cut the queue down to them.
   *
   * Runs once, at Start. Everything it decides is derived from ONE number — the slot — so the whole
   * assignment is reproducible from the recorded `assignment_slot` alone, without having to store
   * the deal alongside it.
   *
   * Guide tasks are left alone: the groups are a Find design, and a guide trajectory has no
   * correctness cell to deal. They keep riding on `s.arm`.
   *
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async function _dealStudyQueue() {
    const claimed = typeof claimFindV2Session === 'function'
      ? await claimFindV2Session(s.participantId)
      : null;
    s.assignmentSlot = claimed ? claimed.slot : await _nextLocalSlot();
    s.v2SessionId = claimed ? claimed.sessionId : null;

    const findTasks = s.queue.filter(e => e.taskType === 'find').map(e => e.task);
    const guideEntries = s.queue.filter(e => e.taskType === 'guide');
    const assignment = _assignFindSession(findTasks, s.assignmentSlot);

    s.group = assignment.group;
    s.heldBack = assignment.heldBack;
    // s.arm still exists for the guide half and for anything that labels a row by condition; for
    // Find it is now per QUESTION, so it is derived from the first cell rather than chosen.
    s.arm = assignment.variants.length && !_variantIsGrounded(assignment.variants[0])
      ? 'nongrounding'
      : 'grounding';

    if (!assignment.tasks.length && findTasks.length) {
      return {
        ok: false,
        error: `Group ${assignment.group} needs at least ${STUDY_FIND_CELLS.length} `
          + `${STUDY_FIND_GROUPS[assignment.group].label} questions to run a balanced sitting, but `
          + `only ${findTasks.filter(t => _findTaskStyle(t) === assignment.taskStyle).length} are in `
          + 'the bank. Author more, or run the other group.'
      };
    }

    s.queue = assignment.tasks
      .map((task, i) => ({ taskType: 'find', task, variantKey: assignment.variants[i] }))
      .concat(guideEntries);

    if (!s.queue.length) return { ok: false, error: 'No tasks are ready to run.' };
    return { ok: true };
  }

  /** The cell dealt to the question at a queue position, or null for a guide task. */
  function _studyVariantAt(idx) {
    return s.queue[idx]?.variantKey || null;
  }

  async function startSession(participantId) {
    s.sessionId = null;
    const row = await supabaseInsert('study_sessions', {
      participant_id: participantId,
      condition_order: studyConditionLabel(s.mode === 'study' ? s.arm : null),
    });
    if (row && row.id) s.sessionId = row.id;
  }

  /**
   * Build the V2 verdict row. Pure, so the mapping is testable without a network.
   *
   * The V2 results table is not the V1 one with columns added: it records the JUDGEMENT (what was
   * shown, what they said, whether that was right) where V1 recorded a produced answer. So this is
   * a mapping, not a copy.
   *
   * @param {object} result - the local row from _buildStudyResultRecord
   * @param {{sessionId: number|null, clientRunId: string, evidenceScores: object|null}} ctx
   */
  function _buildFindV2ResultRow(result, ctx = {}) {
    const variantKey = result.variant_key || 'correct_grounding';
    const ev = ctx.evidenceScores || {};
    return {
      // Idempotency handle. The schema makes it unique and grants anon UPDATE so a retry after a
      // dropped connection lands on the same row rather than counting the participant twice.
      result_key: `${ctx.clientRunId || 'run'}::${result.participant_id}::${result.task_id}::${result.task_index}`,
      client_run_id: ctx.clientRunId || null,
      session_id: ctx.sessionId ?? null,
      participant_id: result.participant_id,
      claim_id: result.task_id,
      task_index: result.task_index,
      question_index: result.question_index,
      task_style: _findTaskStyle(result.task_data || {}),
      condition: result.condition,
      variant_key: variantKey,
      question: result.question_or_task || '',
      claim_text_snapshot: result.claim_text_snapshot || '',
      // What the item WAS, as shown — read off the cell, not off the question.
      claim_correct_snapshot: !String(variantKey).startsWith('incorrect'),
      participant_verdict: !!result.participant_verdict,
      verdict_correct: !!result.answer_correct,
      answer_time_ms: result.answer_time_ms ?? 0,
      verdict_time_ms: result.answer_multiple_choice_ms ?? null,
      evidence_time_ms: result.find_supporting_answer_ms ?? null,
      evidence_responses: result.evidence_responses || [],
      score_evidence_precision: ev.precision ?? null,
      score_evidence_recall: ev.recall ?? null,
      score_evidence_exact: ev.exact ?? null,
      score_evidence_hop_exact: ev.hop_exact ?? null,
      confidence: result.confidence || null,
      helpfulness: result.helpfulness || null,
      notes: null,
      interaction_summary: null,
      // Nullable and NOT defaulted to zero, deliberately — the schema says so: a row whose
      // instrumentation never started observed nothing, and a 0 would average in as a participant
      // who sat perfectly still.
      scroll_user_count: result.scroll_user_count ?? null,
      ctrl_f_count: result.ctrl_f_count ?? null,
      text_select_count: result.text_select_count ?? null,
      click_count: result.click_count ?? null,
      mouse_move_px: result.mouse_move_px ?? null,
    };
  }
  window._buildFindV2ResultRow = _buildFindV2ResultRow;

  /** One id per sitting, so a retried submit is recognisable as the same attempt. */
  let _studyClientRunId = null;

  /**
   * Mirror one Find verdict to the V2 project. Guide tasks are skipped — they belong to the guide
   * table, which this design does not touch.
   *
   * Best effort and never throws: the row is already in chrome.storage.local and in the CSV, and a
   * participant must not be stopped mid-study by a network failure.
   */
  async function _persistFindV2Result(result, { taskType, variantKey } = {}) {
    if (taskType !== 'find' || !variantKey) return false;
    if (typeof submitFindV2Result !== 'function') return false;
    if (!_studyClientRunId) {
      _studyClientRunId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }
    const row = _buildFindV2ResultRow(result, {
      sessionId: s.v2SessionId,
      clientRunId: _studyClientRunId,
    });
    return submitFindV2Result(row);
  }

  // ── Persistence: chrome.storage.local (always) + Supabase (best-effort, if configured) ──
  async function persistResult(result) {
    try {
      const data = await chrome.storage.local.get(STUDY_RESULTS_STORAGE_KEY);
      const all = Array.isArray(data[STUDY_RESULTS_STORAGE_KEY]) ? data[STUDY_RESULTS_STORAGE_KEY] : [];
      all.push(result);
      await chrome.storage.local.set({ [STUDY_RESULTS_STORAGE_KEY]: all });
    } catch (e) {
      console.error('[Study] Failed to save result to chrome.storage.local:', e);
    }

    // Post only the actual table columns; the local record also carries convenience fields.
    try {
      if (_supabaseConfigured()) {
        const supaData = {};
        SUPABASE_TASK_COLUMNS.forEach(col => { if (result[col] !== undefined) supaData[col] = result[col]; });
        await fetch(`${SUPABASE_URL}/rest/v1/study_task_results`, {
          method: 'POST',
          headers: _supabaseHeaders('return=minimal'),
          body: JSON.stringify(supaData),
        });
      }
    } catch (e) {
      console.warn('[Study] Supabase insert failed (result is still saved locally):', e);
    }
  }

  function downloadResultsCSV() {
    const csv = _buildStudyResultsCSV(s.results);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `study_results_${s.participantId || 'anon'}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── PAGE SNAPSHOTS ──
  // A Find task asks a participant to check an answer against a page, and the website cannot show
  // the live one: most sites refuse to be framed, and a cross-origin frame cannot be scripted even
  // when it loads — so the grounded arm would have nothing to highlight. A snapshot served from the
  // study's own origin is same-origin, and therefore a working DOM. See content/functions/page_snapshot.js.

  const STUDY_PAGES_KEY = 'pageguide_study_task_pages';

  async function listStudyPages() {
    try {
      const data = await chrome.storage.local.get(STUDY_PAGES_KEY);
      const all = data[STUDY_PAGES_KEY];
      return (all && typeof all === 'object') ? all : {};
    } catch (e) {
      console.warn('[Study] page snapshot read failed:', e);
      return {};
    }
  }

  /**
   * Bank one page snapshot, REPLACING any previous capture of the same task.
   *
   * Keyed on task_id at both layers — here, and on the primary key when published — so re-capturing
   * is how a snapshot is corrected. That matters more than it sounds: a page captured before the
   * lazy-image fix has blurred placeholders baked into it, and the only way to repair it is to
   * capture again. Appending instead would leave the broken one in place and give no way to say
   * which of the two a participant should see.
   */
  /** A task that already has this exact page captured under a different id, or null. */
  async function _pageSharedWith(taskId, url) {
    if (!url) return null;
    const all = await listStudyPages();
    const hit = Object.values(all).find(p => p && p.url === url && p.task_id !== String(taskId) && p.html);
    return hit ? hit.task_id : null;
  }

  /**
   * Resolve this task's recorded answers against the page that is open, and bank the locators.
   *
   * WHY IT HANGS OFF CAPTURE. A citation is `[69:"…"]` — element 69 in the index the ANSWER RUN
   * built. That index is the only thing that gives 69 a meaning, it is discarded on reload, and it
   * cannot be rebuilt (createPageIndex renumbers; see pageguideExistingIndexMap in utils.js). So the
   * mapping has to be read while the answer's own page is still standing. Capture is exactly that
   * moment — the researcher is looking at the page with the grounded answer on it — which makes one
   * press enough and makes re-capturing the way to repair an answer whose anchors are missing.
   *
   * Locators are stored ON THE ANSWER rather than stamped into the snapshot, so a later re-capture
   * cannot silently strip them, and a page captured before any of this existed still resolves.
   *
   * Soft, and reported: an answer that cannot be anchored is left as it was, and the count is shown
   * rather than swallowed — a missing locator is invisible until it misplaces evidence on the site.
   */
  async function _anchorRecordedAnswers(taskId, tabId) {
    const out = { updated: 0, resolved: 0, total: 0, summary: 'no recorded answers to anchor' };
    if (typeof listStudyResponses !== 'function' || typeof _attachCitationAnchors !== 'function') {
      return out;
    }
    const all = await listStudyResponses() || {};
    const mine = Object.values(all).filter(r => r && String(r.task_id) === String(taskId));
    for (const record of mine) {
      const r = await _attachCitationAnchors(record, tabId);
      if (!r.total) continue;                        // nothing cited — the non-grounded arm
      out.total += r.total;
      out.resolved += r.resolved;
      if (r.resolved) { await saveStudyResponse(record, { downscale: false }); out.updated++; }
    }
    out.summary = out.total
      ? `${out.resolved}/${out.total} citations anchored across ${out.updated} recorded answer`
        + `${out.updated === 1 ? '' : 's'}`
      : 'no citations to anchor';
    return out;
  }

  async function saveStudyPage(taskId, snapshot) {
    try {
      const all = await listStudyPages();
      all[String(taskId)] = {
        task_id: String(taskId),
        url: snapshot.url || '',
        title: snapshot.title || '',
        html: snapshot.html || '',
        bytes: snapshot.bytes || 0,
        captured_at: new Date().toISOString(),
      };
      await chrome.storage.local.set({ [STUDY_PAGES_KEY]: all });
      return { saved: true };
    } catch (e) {
      // Quota is the realistic failure: an inlined article is megabytes, and chrome.storage.local
      // is capped unless unlimitedStorage is granted (it is, in this manifest) — but a bank of
      // twenty of them is still worth failing loudly about rather than silently dropping.
      console.error('[Study] page snapshot save failed:', e);
      return { saved: false, error: e?.message || 'save failed' };
    }
  }

  /** Human-readable size, so a 20MB capture is obvious before it is published. */
  function _fmtSnapshotSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
  window._fmtSnapshotSize = _fmtSnapshotSize;

  // ── EXPORTING STIMULI FOR THE STUDY WEBSITE ──
  //
  // The browser version of the study (user_study_website) reads its material from Supabase. Nothing
  // else puts it there, so this is the bridge between what a researcher authors on their machine and
  // what a participant sees at a URL.
  //
  // WHY AN EXPORT RATHER THAN A DIRECT UPLOAD. The stimulus tables are anon-READ only: the extension
  // and the site both ship the anon key, so an anon write policy would let anyone holding either
  // overwrite the study's material mid-run. Writing therefore needs the secret/service_role key —
  // and Supabase now REFUSES that key outright from any browser context:
  //
  //     401 "Forbidden use of secret API key in browser"
  //
  // A side panel is a browser. So the privileged half of the job moves to where a privileged key is
  // allowed to live: this button writes a plain JSON bundle, and scripts/publish.mjs in the website
  // repo uploads it from a terminal. The secret key never enters this process at all, which is a
  // better arrangement than the one it replaces — there is no field to paste it into and nothing to
  // forget to clear.

  /**
   * Everything a participant needs, both halves, as one JSON bundle. Pure apart from its reads.
   *
   * Guide and Find go together on purpose: they are one study, and a site with the trajectories but
   * not the Find questions silently runs half of it.
   */
  async function _buildStimulusBundle(trajectoryRows, half = 'all', onlyTaskId = null) {
    const now = new Date().toISOString();
    // One task at a time is for CHECKING, not for the real publish: a ten-page bundle is a slow and
    // miserable way to discover that the anchors did not land. Narrowing to one keeps the round trip
    // short enough to iterate on, and every row is still keyed the same way, so a single-task
    // publish is simply a subset of the full one rather than a different code path.
    const only = onlyTaskId ? String(onlyTaskId) : null;
    const wantGuide = !only && (half === 'all' || half === 'guide');
    const wantFind = half === 'all' || half === 'find';

    // Only what a participant would actually walk. Exporting an excluded or step-less trajectory
    // puts a row on the site that its own queue then filters out — confusing to debug later.
    const trajectories = (wantGuide ? (trajectoryRows || []) : [])
      .filter(t => _guideTrajectoryInStudy(t) && t.arms?.grounding?.steps?.length)
      .map(t => ({
        id: t.id,
        source_session_id: t.source_session_id || null,
        goal: t.goal || t.title || '',
        title: t.title || '',
        condition: t.condition || null,
        in_study: true,
        ground_truth: t.ground_truth || null,
        arms: t.arms || {},
        captured_at: t.captured_at || null,
        updated_at: now,
      }));

    // tasks.json stays the AUTHORING format; this is its published copy. Two hand-editable copies of
    // the question set is exactly the drift that shows a participant a question the analysis lacks.
    let tasks = [];
    try {
      if (!wantFind) throw { skip: true };
      const shipped = await fetch(chrome.runtime.getURL('user_study_data/tasks.json')).then(r => r.json());
      // Published with the researcher's edits applied — the site has to carry the question the
      // participant was actually asked, not the one that happened to ship in the file.
      const data = (typeof listStudyTaskEdits === 'function' && typeof _applyStudyTaskEdits === 'function')
        ? _applyStudyTaskEdits(shipped, await listStudyTaskEdits())
        : shipped;
      tasks = (data?.find || []).map((t, i) => ({
        id: t.id,
        task_type: 'find',
        type: t.type || null,
        title: t.title || '',
        url: t.url || '',
        question: t.question || '',
        answer: t.answer || null,
        distractors: Array.isArray(t.distractors) ? t.distractors : [],
        in_study: true,
        task_index: i,
        updated_at: now,
      }));
    } catch (e) {
      if (!e?.skip) console.warn('[Study] could not read tasks.json for export:', e);
    }
    if (only) tasks = tasks.filter(t => String(t.id) === only);

    // The recorded agent answers, one per (task × condition).
    let canned = [];
    if (wantFind && typeof listStudyResponses === 'function') {
      // The bank is FLAT: keyed "taskId::condition", and each value IS the record. It was read here
      // as though each entry held a nested `arms` object, which silently yielded an empty list — so
      // every recorded Find answer was dropped at publish time and study_canned_responses stayed
      // empty no matter how many were banked. Nothing failed; there was simply never anything to send.
      canned = Object.values(await listStudyResponses() || {})
        .filter(r => r && r.task_id && r.condition)
        .filter(r => !only || String(r.task_id) === only)
        .map(r => ({
          task_id: r.task_id,
          condition: r.condition,
          url: r.url || null,
          question: r.question || null,
          answer_raw: r.answer_raw || null,
          answer_display: r.answer_display || null,
          evidence: r.evidence || [],
          // Where each [N:"…"] points, resolved on the live page when the answer was recorded or
          // when the page was captured. Travels with the ANSWER, so it keeps working across
          // re-captures — see content/functions/citation_anchors.js.
          citation_anchors: r.citation_anchors || null,
          highlight_count: r.highlight_count ?? null,
          edited: !!r.edited,
        }));
    }

    // The Find accepted-sentence ground truth, per task.
    let groundTruth = [];
    if (wantFind && typeof listStudyGroundTruth === 'function') {
      groundTruth = Object.values(await listStudyGroundTruth() || {})
        .filter(t => t && t.task_id)
        .filter(t => !only || String(t.task_id) === only)
        .map(t => ({ task_id: t.task_id, hops: t.hops || {}, updated_at: now }));
    }

    // The captured pages, so a participant can see what the question is about.
    let pages = [];
    if (wantFind) {
      // ONE ROW PER URL. Two tasks can be the same page under different conditions (MUFC-V1 and
      // MUFC-V1-TEXT are the same Wikipedia article), and a snapshot is megabytes — so publishing
      // both would upload the same article twice and let the copies drift apart, which would make
      // the conditions differ in the page rather than only in the grounding. The site looks a page
      // up by URL when a task has no row of its own.
      const seenUrls = new Set();
      pages = Object.values(await listStudyPages())
        .filter(p => p && p.task_id && p.html)
        // Narrowed by TASK ID and not by URL, even though a page can be shared between two tasks
        // (MUFC-V1 and MUFC-V1-TEXT are one article). study_task_pages.task_id is a foreign key
        // into study_tasks, so shipping the sibling's row in a bundle that does not carry the
        // sibling's task would be rejected — and re-keying it to this task would quietly create the
        // second copy the dedupe above exists to prevent.
        .filter(p => !only || String(p.task_id) === only)
        .filter(p => {
          if (!p.url) return true;               // no URL to dedupe on: keep it
          if (seenUrls.has(p.url)) return false;
          seenUrls.add(p.url);
          return true;
        })
        .map(p => ({
          task_id: p.task_id, url: p.url || null, title: p.title || null,
          html: p.html, bytes: p.bytes || null, captured_at: p.captured_at || now,
        }));
    }

    return {
      exported_at: now,
      study_guide_trajectories: trajectories,
      study_tasks: tasks,
      study_canned_responses: canned,
      study_ground_truth: groundTruth,
      study_task_pages: pages,
    };
  }
  window.listStudyPages = listStudyPages;   // study_v2_publish.js needs the captured page
  window._buildStimulusBundle = _buildStimulusBundle;

  /** One line per table, so the export says what it actually contains. Pure. */
  function _describeStimulusBundle(bundle) {
    const b = bundle || {};
    const n = (k) => (Array.isArray(b[k]) ? b[k].length : 0);
    return `${n('study_guide_trajectories')} trajector${n('study_guide_trajectories') === 1 ? 'y' : 'ies'} · `
      + `${n('study_tasks')} find task(s) · ${n('study_canned_responses')} find answer(s) · `
      + `${n('study_ground_truth')} find ground truth · ${n('study_task_pages')} page(s)`;
  }
  window._describeStimulusBundle = _describeStimulusBundle;

  // Where the local publish helper listens (scripts/publish.mjs --serve). Loopback only: it holds
  // the secret key, so it has no business being reachable from anywhere but this machine.
  const PUBLISH_HELPER = 'http://127.0.0.1:8790/publish';

  /**
   * Build the bundle and hand it to the local helper.
   *
   * Shared by both recorders, each publishing ITS OWN half: the Guide recorder sends trajectories,
   * the Find recorder sends the questions, recorded answers and ground truth. One implementation
   * either way — two copies of this would drift, and a publish that silently sent the wrong half is
   * the kind of failure nobody notices until a participant sees the wrong study.
   *
   * @param {Array<object>} trajectoryRows - every banked trajectory (filtered inside the builder)
   * @param {(msg: string, tone?: string) => void} note - where to report
   * @param {'all'|'guide'|'find'} half - which half to send
   */
  async function _publishStimuliVia(trajectoryRows, note, half = 'all', onlyTaskId = null) {
    const bundle = await _buildStimulusBundle(trajectoryRows, half, onlyTaskId);
    const empty = !bundle.study_guide_trajectories.length && !bundle.study_tasks.length
      && !bundle.study_canned_responses.length && !bundle.study_ground_truth.length;
    if (empty) {
      note(onlyTaskId
        ? `Nothing to publish for ${onlyTaskId} — no recorded answer or question was found for it.`
        : half === 'guide'
          ? 'Nothing to publish — no included trajectory has steps.'
          : 'Nothing to publish — no Find tasks or recorded answers were found.', 'bad');
      return;
    }
    const anchorGaps = _findCannedAnchorGaps(bundle.study_canned_responses);
    if (anchorGaps.length) {
      note('Cannot publish yet — these recorded answers have citation chips without saved page '
        + `anchors: ${anchorGaps.map(g => `${g.task_id}/${g.condition} (${g.anchored}/${g.cited})`).join(', ')}. `
        + 'Open each task page, press Show grounding or Capture page to repair the anchors, then publish again.', 'bad');
      return;
    }
    // Said before the upload, not after: a one-task publish that carries no page is the likely
    // shape when the page belongs to this task's twin, and it looks like success otherwise.
    if (onlyTaskId && !bundle.study_task_pages.length) {
      note(`Publishing ${onlyTaskId} WITHOUT a page — nothing is captured under this task id. `
        + 'If it shares a page with another task, capture it here or publish that task too.');
    }
    note(`Publishing ${_describeStimulusBundle(bundle)}…`);

    // SENT IN PIECES, and in this order. One POST carrying everything gave no way to say what was
    // happening — a nine-page bundle is tens of megabytes, each row a separate slow insert, and the
    // panel sat on one unchanging line for minutes looking exactly like a hang. Splitting it lets
    // each step be named as it goes, keeps any single request small enough not to trip Postgres's
    // statement timeout, and means a failure names the table it happened in.
    //
    // Pages go ONE AT A TIME because they are the megabytes: a page row is the only thing here big
    // enough for "which one is it stuck on?" to be a real question.
    const steps = [];
    const add = (label, payload) => {
      const rows = Object.values(payload)[0];
      if (Array.isArray(rows) && rows.length) steps.push({ label, payload });
    };
    // study_tasks first: study_task_pages.task_id is a foreign key into it, so a page sent before
    // its task is rejected. This ordering is the same one the helper applies internally.
    add('find questions', { study_tasks: bundle.study_tasks });
    add('guide trajectories', { study_guide_trajectories: bundle.study_guide_trajectories });
    add('recorded answers', { study_canned_responses: bundle.study_canned_responses });
    add('find ground truth', { study_ground_truth: bundle.study_ground_truth });
    (bundle.study_task_pages || []).forEach((page, i, all) => {
      const size = page.bytes ? ` (${_fmtSnapshotSize(page.bytes)})` : '';
      steps.push({
        label: `page ${i + 1} of ${all.length} — ${page.task_id}${size}`,
        payload: { study_task_pages: [page] },
      });
    });

    const summaries = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      note(`Publishing ${i + 1}/${steps.length}: ${step.label}…`);

      let res;
      try {
        res = await fetch(PUBLISH_HELPER, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ exported_at: bundle.exported_at }, step.payload)),
        });
      } catch (e) {
        // The helper is the only thing that can do this: Supabase refuses a secret key sent from a
        // browser, so there is no in-panel fallback to offer — only instructions.
        note('The publish helper is not running. In a terminal:  '
          + 'cd user_study_website && node scripts/publish.mjs --serve  '
          + '— then press Publish again.', 'bad');
        return;
      }

      const out = await res.json().catch(() => null);
      if (!res.ok || !out) { note(`The helper returned ${res.status} on ${step.label}.`, 'bad'); return; }
      // Stopped at the first failure rather than pressing on: the later steps depend on the earlier
      // ones, and a wall of errors hides which one actually broke.
      if (out.help) { note(`Failed on ${step.label}: ${out.summary}. ${out.help}`, 'bad'); return; }
      if (out.summary) summaries.push(out.summary);
    }

    note(`Published — ${summaries.join(' · ')}.`, 'ok');
  }

  function _findCannedAnchorGaps(rows) {
    return (Array.isArray(rows) ? rows : []).map(r => {
      const cited = _studyUniqueCitationCount(r?.answer_raw || r?.answer_display || '');
      if (!cited) return null;
      const anchors = Array.isArray(r?.citation_anchors) ? r.citation_anchors : [];
      return anchors.length >= cited ? null : {
        task_id: r.task_id || '?',
        condition: r.condition || '?',
        cited,
        anchored: anchors.length,
      };
    }).filter(Boolean);
  }

  function _studyCitationCount(answer) {
    let count = 0;
    String(answer || '').replace(/\[(\d+):"([^"]*)"\]/g, () => {
      count += 1;
      return '';
    });
    return count;
  }

  function _studyUniqueCitationCount(answer) {
    const seen = new Set();
    String(answer || '').replace(/\[(\d+):"([^"]*)"\]/g, (m, index, quote) => {
      seen.add(`${index}:${quote}`);
      return m;
    });
    return seen.size;
  }

  function _describeStudyCitationAnchors(anchors) {
    return (Array.isArray(anchors) ? anchors : []).map((anchor) => {
      const quote = _studyClip(anchor?.quote || '', 34);
      const target = _studyClip(anchor?.text || '', 72);
      const tag = String(anchor?.tag || '?').toLowerCase();
      return `[${anchor?.index ?? '?'}] "${quote}" -> ${tag} "${target}"`;
    }).join('; ');
  }

  function _studyArmForRenderedCitation(webCit) {
    const list = webCit?.closest?.('#study-llm-answers-list');
    return list?.dataset?.studyActiveArm || '';
  }

  function _studyRecordForRenderedCitation(webCit) {
    const list = webCit?.closest?.('#study-llm-answers-list');
    if (!list) return null;
    if (list._studyPlaybackRecord) return list._studyPlaybackRecord;
    const activeArm = list.dataset?.studyActiveArm || '';
    return list._studyArms?.[activeArm]?.record || null;
  }

  function _studyRenderedCitationQuote(webCit) {
    return webCit?.querySelector?.('.citation-text')?.textContent || '';
  }

  function _studyAnchorForRenderedCitation(record, renderedCitation, renderedIndex, renderedQuote) {
    const shown = Number(renderedCitation);
    if (!Number.isFinite(shown) || shown < 1) return null;
    const anchors = Array.isArray(record?.citation_anchors) ? record.citation_anchors : [];
    const markerIndex = Number(renderedIndex);
    const markerQuote = String(renderedQuote || '');
    if (Number.isFinite(markerIndex) && markerQuote) {
      const exact = anchors.find(anchor =>
        Number(anchor?.index) === markerIndex && String(anchor?.quote || '') === markerQuote);
      if (exact) return exact;
    }
    return anchors[shown - 1] || null;
  }

  function _studyClip(value, max) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
  }

  // ── Guide trajectories (Record Guide User Study) ──
  // A captured run is raw material, not a stimulus. The editor exists because a study needs
  // trajectories with KNOWN properties — a specific error, at a specific step, with a screenshot that
  // shows it — and what the agent happened to do on the day is only a starting point.

  const GUIDE_ARM_LABELS = { grounding: 'Grounded', nongrounding: 'Non-grounded' };

  // Which condition the list is showing. Kept across re-renders (assigning a condition re-renders
  // the list, and a filter that reset itself on every assignment would be unusable for exactly the
  // job it exists for: working through the unassigned ones).
  let _guideTrajFilter = 'all';

  /**
   * WHICH SUPABASE PROJECT THE LIST IS ABOUT. V2 by default.
   *
   * V1 and V2 are different projects with different tables, different privilege models and
   * different transports — V1 goes through the loopback helper that holds the secret key, V2 goes
   * straight to a password-gated RPC. So "publish" means two different things, and the researcher
   * has to be able to see which one they are about to do BEFORE pressing it rather than after.
   * Making it a visible switch rather than two adjacent buttons is the difference between choosing
   * a target and mis-clicking one.
   *
   * V2 is the default because it is the study that is being run; V1 stays reachable because its
   * data is still being collected and a published V1 trajectory occasionally needs replacing.
   */
  let _guideTrajSource = 'v2';

  /**
   * What V2 already holds, keyed by local trajectory id. Cached for the life of the panel screen
   * rather than re-fetched on every render: switching a filter or ticking a checkbox re-renders,
   * and a network round trip on each of those would make the list stutter for no new information.
   * Publishing and the ⟳ button both clear it, which are the only two ways it goes stale.
   */
  let _guideV2Index = null;

  async function _loadGuideV2Index({ force = false } = {}) {
    if (_guideV2Index && !force) return _guideV2Index;
    if (typeof listGuideV2Tasks !== 'function') {
      _guideV2Index = { ok: false, error: 'guide_v2_publish.js did not load.', byId: {}, rows: [] };
      return _guideV2Index;
    }
    _guideV2Index = await listGuideV2Tasks();
    return _guideV2Index;
  }

  /**
   * The V2 row one banked trajectory will be published into, or null for a new one.
   *
   * Delegates to guide_v2_publish.js rather than matching here, so the chip on a row and the row
   * the publish actually writes cannot disagree — a preview that matches by different rules than
   * the publish is worse than no preview.
   */
  function _guideV2RowFor(index, record) {
    if (typeof matchGuideV2Row !== 'function') return null;
    return matchGuideV2Row(index?.rows || [], record);
  }

  /**
   * What V2 holds for this trajectory, as one chip. Pure.
   *
   * Three states rather than two, because "published but not live" is the state that actually
   * bites: the row is on V2, so nothing looks missing, and the participant never sees it. It gets
   * the warn colour for exactly that reason. The step count is shown when it disagrees with the
   * local one — that is the cheapest visible sign that an edited trajectory was never re-published.
   */
  function _guideV2ChipHtml(v2Row, record) {
    const ticked = _guideTrajectoryInStudy(record);
    if (!v2Row) {
      return ticked
        ? '<span class="study-traj-tag study-traj-tag-ok" title="Not on V2 yet — Publish guide will create it">will create</span>'
        : '<span class="study-traj-tag study-traj-tag-none" title="Not on V2, and not ticked — Publish guide will leave it alone">not published</span>';
    }
    const localSteps = record?.arms?.grounding?.steps?.length || 0;
    const drift = Number(v2Row.step_count) !== localSteps
      ? ` V2 has ${v2Row.step_count} step${v2Row.step_count === 1 ? '' : 's'}, this has ${localSteps}.`
      : '';
    const when = v2Row.updated_at ? new Date(v2Row.updated_at).toLocaleString() : 'unknown';
    // Named on the chip, because the id it updates is the one thing that cannot be guessed from
    // here: the rows already on V2 use a different id scheme than this bank, so "which row" is a
    // real question and matching by goal is what answers it.
    const where = `Row ${v2Row.id}, last published ${when}.${drift}`;
    if (!ticked) {
      // Unticked means "not published", never "unpublished". Said plainly on the chip for the one
      // case where the difference bites: the row is live, and leaving it unticked will NOT take it
      // down. A researcher who reads "will remove" and gets a row still in the queue has been
      // misled by the panel rather than by Supabase.
      return v2Row.in_study
        ? `<span class="study-traj-tag study-traj-tag-warn"
            title="${escapeAttr(`Unticked here, but this row is LIVE on V2 and publishing will not `
              + `change that — only ticked trajectories are written. Remove it in Supabase if it `
              + `should not be walked. ${where}`)}"
            >live on V2 ⚠ not publishing</span>`
        : `<span class="study-traj-tag study-traj-tag-none"
            title="${escapeAttr(`Unticked, and a draft on V2. Nothing will be written. ${where}`)}"
            >V2 draft · skipped</span>`;
    }
    return `<span class="study-traj-tag ${drift ? 'study-traj-tag-warn' : 'study-traj-tag-ok'}"
      title="${escapeAttr(`Publish guide will update this row in place, not add a second one. ${where}`)}"
      >will update${drift ? ' ⚠' : ''}</span>`;
  }

  // ── Record Annotation Trajectories ──
  // The annotator-website bank (sidepanel/annotation_trajectories.js). Deliberately a much smaller
  // screen than the guide recorder above: nothing here is edited, because the annotators grade the
  // run as it happened. Tick what to publish, publish or export, delete what was a false start.
  /** The 12 tasks the annotation trajectories are recorded for (annotate/tasks.json). */
  async function loadAnnotationTasks() {
    try {
      const data = await fetch(chrome.runtime.getURL('annotate/tasks.json')).then(r => r.json());
      return Array.isArray(data?.guide) ? data.guide : [];
    } catch (e) {
      console.warn('[Study] Could not load annotate/tasks.json:', e);
      return [];
    }
  }

  /**
   * Start one task: navigate the tab to its starting site, put the instruction in the chat box,
   * and remember which task is running so the 📝 capture can tag the trajectory with it.
   */
  async function startAnnotationTask(task) {
    await chrome.storage.local.set({ pageguide_annotation_current_task: { id: task.id, name: task.name, task: task.task, url: task.url } });
    await openTaskPage(task.url);
    closeStudyPanel();
    const chatInput = document.getElementById('pageguide-input');
    if (chatInput) { chatInput.value = task.task; chatInput.focus(); }
  }

  /**
   * What the annotator site is actually showing: the live rows of pageguide_annotation_trajectories
   * (anon select is limited to in_annotation = true by RLS). Keyed by the row id AND by the bank id
   * it was published from, so a banked capture can be matched either way. Empty when Supabase is
   * not configured or unreachable.
   */
  let _liveLoadError = '';
  async function _loadLiveAnnotationRows() {
    _liveLoadError = '';
    if (!(typeof window._v2Configured === 'function' && window._v2Configured())) { _liveLoadError = 'V2 Supabase is not configured'; return null; }
    try {
      // Only the answer evidence is selected out of `arms` (a JSON-path select): the whole column
      // carries every step screenshot — ~30 MB for 12 rows — which the side panel cannot hold.
      const res = await fetch(`${SUPABASE_V2_URL}/rest/v1/pageguide_annotation_trajectories?select=id,source_task_id,source_trajectory_id,title,goal,url,step_count,agent_answer,evidence:arms->grounding->answer_evidence,task_index,created_at&order=task_index.asc`, { headers: window._v2Headers() });
      if (!res.ok) { _liveLoadError = `annotation rows: HTTP ${res.status}`; return null; }
      const rows = await res.json();
      return rows.map(r => Object.assign(r, { arms: { grounding: { answer_evidence: Array.isArray(r.evidence) ? r.evidence : [] } } }));
    } catch (e) { _liveLoadError = `annotation rows: ${e.message}`; return null; }
  }

  let _annotFilter = 'shown';   // 'shown' = live on the annotator site · 'all' = everything banked

  async function renderAnnotationTrajectoryList() {
    const all = await listAnnotationTrajectories();
    const allRows = Object.values(all).sort((a, b) => String(b.captured_at || '').localeCompare(String(a.captured_at || '')));
    const live = await _loadLiveAnnotationRows();
    const liveIds = new Set((live || []).flatMap(r => [r.id, r.source_trajectory_id].filter(Boolean)));
    const isShown = (t) => live ? (liveIds.has(t.id) || liveIds.has(_annotationId(t.id))) : t.in_annotation !== false;
    const shownRows = allRows.filter(isShown);
    const rows = _annotFilter === 'shown' ? shownRows : allRows;
    const ticked = rows.filter(t => t.in_annotation !== false).length;
    const configured = typeof window._v2Configured === 'function' && window._v2Configured();
    const tasks = await loadAnnotationTasks();
    const shownTaskIds = new Set(shownRows.map(t => t.task_id).filter(Boolean));
    const current = (await chrome.storage.local.get('pageguide_annotation_current_task')).pageguide_annotation_current_task || null;
    const capturedFor = (id) => rows.filter(t => t.task_id === id).length;

    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">📝 Record Annotation Trajectories</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-body">
          ${tasks.length ? `
          <div class="study-traj-group-head" title="Press ▶ to open the starting site with the instruction in the chat box. Run Guide, then press 📝 on the journey card.">
            Tasks to record <span class="study-traj-filter-n">${tasks.length}</span>
          </div>
          <div id="study-annot-tasks">
            ${tasks.map((t, i) => {
              const n = capturedFor(t.id);
              return `
              <div class="study-traj-row${n ? ' study-traj-row-out' : ''}${current?.id === t.id ? ' study-annot-task-current' : ''}">
                <span class="study-traj-step-n">${i + 1}</span>
                <div class="study-traj-main">
                  <div class="study-traj-title">${escapeHTML(t.name)}${current?.id === t.id ? ' <span class="study-traj-filter-n">running</span>' : ''}${t.status === 'rerun' ? ' <span class="study-traj-filter-n study-annot-rerun" title="The study answer was wrong — needs a fresh run">↻ rerun</span>' : (t.status === 'correct' ? ' <span class="study-traj-filter-n" title="The study answer was correct and is already in the annotation queue">✓ kept</span>' : '')}</div>
                  <div class="study-traj-meta">${escapeHTML(t.task)}</div>
                  <div class="study-traj-meta">${escapeHTML(t.url)}${n ? ` · ${n} captured` : ''}</div>
                </div>
                <button class="study-evidence-clear" data-annot-start="${escapeAttr(t.id)}" title="Open the site and put the task in the chat box">▶</button>
              </div>`;
            }).join('')}
          </div>
          <div class="study-traj-group-head">Captured runs <span class="study-traj-filter-n">${rows.length}</span></div>` : ''}
          <div class="study-traj-filters">
            <button class="study-traj-filter${_annotFilter === 'shown' ? ' study-traj-filter-on' : ''}" data-annot-filter="shown"
              title="${live ? 'The rows the annotator site is showing right now (live on Supabase)' : 'Ticked in this bank (Supabase not reachable, so this is the local tick)'}">
              Shown to annotators <span class="study-traj-filter-n">${shownRows.length}</span>${shownTaskIds.size ? ` · ${shownTaskIds.size} of ${tasks.length} tasks` : ''}</button>
            <button class="study-traj-filter${_annotFilter === 'all' ? ' study-traj-filter-on' : ''}" data-annot-filter="all">
              All captured <span class="study-traj-filter-n">${allRows.length}</span></button>
          </div>
          <p class="study-intro">${rows.length
            ? `Guide runs captured for the annotator website. <strong>${ticked} of ${rows.length}</strong> ticked.
               Publishing upserts them into <code>pageguide_annotation_trajectories</code>
               (see <code>supabase_schema_annotation.sql</code>)${configured ? '' : ' — V2 Supabase is not configured, so use Export'}.`
            : 'Nothing captured yet. Run a guide task, then press 📝 on its journey card to capture it.'}</p>
          ${rows.length ? `
          <div class="study-traj-bulk">
            <button class="study-evidence-clear" data-annot-bulk="in">Select all</button>
            <button class="study-evidence-clear" data-annot-bulk="out">Deselect all</button>
            <button class="study-evidence-clear" id="study-annot-publish" ${configured ? '' : 'disabled'}
              title="Upsert every ticked trajectory into pageguide_annotation_trajectories">⬆ Publish → Supabase</button>
            <button class="study-evidence-clear" id="study-annot-export"
              title="Save the ticked trajectories as a JSON file the annotator website can load directly">⬇ Export JSON</button>
          </div>
          <div class="study-llm-answers-note" id="study-annot-note"></div>
          <div id="study-annot-list">
            ${rows.map(t => {
              const steps = t.arms?.grounding?.steps || [];
              const shots = steps.filter(st => st.screenshot).length;
              const on = t.in_annotation !== false;
              return `
              <div class="study-traj-row${on ? '' : ' study-traj-row-out'}" data-annot-id="${escapeAttr(t.id)}">
                <input type="checkbox" class="study-annot-tick" data-annot-tick="${escapeAttr(t.id)}" ${on ? 'checked' : ''}
                  title="Include in the annotators' queue">
                <div class="study-traj-main">
                  <div class="study-traj-title">${t.task_name ? `<span class="study-traj-filter-n">${escapeHTML(t.task_name)}</span> ` : ''}${escapeHTML(t.title || t.goal || t.id)}</div>
                  <div class="study-traj-meta">${steps.length} step${steps.length === 1 ? '' : 's'} · ${shots} screenshot${shots === 1 ? '' : 's'}
                    · ${t.arms?.grounding?.answer ? 'answer recorded' : 'no answer'}
                    · ${escapeHTML(String(t.captured_at || '').slice(0, 16).replace('T', ' '))}</div>
                </div>
                <button class="study-evidence-clear" data-annot-delete="${escapeAttr(t.id)}" title="Remove from this bank">🗑</button>
              </div>`;
            }).join('')}
          </div>` : ''}
        </div>
      </div>
    `);
    $('study-close').onclick = closeStudyPanel;
    overlay.querySelectorAll('[data-annot-start]').forEach(btn => {
      btn.onclick = () => { const t = tasks.find(x => x.id === btn.dataset.annotStart); if (t) startAnnotationTask(t); };
    });
    overlay.querySelectorAll('[data-annot-filter]').forEach(btn => {
      btn.onclick = () => { _annotFilter = btn.dataset.annotFilter; renderAnnotationTrajectoryList(); };
    });
    if (!rows.length) return;

    const note = (msg) => { const el = $('study-annot-note'); if (el) el.textContent = msg; };
    const setTick = async (id, on) => {
      const rec = await getAnnotationTrajectory(id);
      if (!rec) return;
      rec.in_annotation = !!on;
      await saveAnnotationTrajectory(rec, { downscale: false });
    };
    overlay.querySelectorAll('[data-annot-tick]').forEach(cb => {
      cb.onchange = async () => { await setTick(cb.dataset.annotTick, cb.checked); renderAnnotationTrajectoryList(); };
    });
    overlay.querySelectorAll('[data-annot-bulk]').forEach(btn => {
      btn.onclick = async () => {
        for (const t of rows) await setTick(t.id, btn.dataset.annotBulk === 'in');
        renderAnnotationTrajectoryList();
      };
    });
    overlay.querySelectorAll('[data-annot-delete]').forEach(btn => {
      btn.onclick = async () => { await deleteAnnotationTrajectory(btn.dataset.annotDelete); renderAnnotationTrajectoryList(); };
    });
    const pub = $('study-annot-publish');
    if (pub) pub.onclick = async () => {
      pub.disabled = true;
      note('Publishing…');
      const res = await publishAnnotationTrajectories(rows);
      note(res.ok ? describeAnnotationPublish(res.rows) : `Could not publish: ${res.error}`);
      pub.disabled = false;
    };
    const exp = $('study-annot-export');
    if (exp) exp.onclick = () => {
      const bundle = buildAnnotationBundle(rows);
      const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'annotation_trajectories.json';
      a.click();
      URL.revokeObjectURL(a.href);
      note(`Exported ${bundle.trajectories.length} trajectories. Load the file on the annotator website (annotate/).`);
    };
  }

  // ── Record Model Performance ──
  // The third bank (sidepanel/model_performance_trajectories.js): the same 12 tasks as the
  // annotation recorder, run once per model, captured with what each run cost. Same screen shape
  // as the annotation recorder — launcher, captured runs, publish/export/delete — plus the model
  // and cost on every row, and a per-task count of which models have been run.
  async function renderModelPerformanceTrajectoryList() {
    const all = await listModelPerformanceTrajectories();
    const rows = Object.values(all).sort((a, b) => String(b.captured_at || '').localeCompare(String(a.captured_at || '')));
    const ticked = rows.filter(t => t.in_report !== false).length;
    const configured = typeof window._v2Configured === 'function' && window._v2Configured();
    const tasks = await loadAnnotationTasks();
    const current = (await chrome.storage.local.get('pageguide_annotation_current_task')).pageguide_annotation_current_task || null;
    const runsFor = (id) => rows.filter(t => t.task_id === id);
    const modelOf = (t) => t.run_meta?.model || t.run_meta?.provider || '';
    const costOf = (t) => {
      const m = t.run_meta || {};
      if (!m.calls) return 'no cost recorded';
      const money = m.cost_usd ? `$${Number(m.cost_usd).toFixed(4)}` : 'unpriced';
      const secs = m.duration_ms ? ` · ${Math.round(m.duration_ms / 1000)}s` : '';
      return `${money} · ${m.calls} call${m.calls === 1 ? '' : 's'} · ${((m.prompt_tokens || 0) + (m.completion_tokens || 0)).toLocaleString()} tok${secs}`;
    };
    const models = [...new Set(rows.map(modelOf).filter(Boolean))].sort();
    // The judge's verdicts (Model Comparison), so the launcher says which tasks still need a rerun:
    // per task and model, the latest judgment of the latest run.
    const judgmentsAll = Object.values(await _loadJudgments());
    const verdictFor = (taskId, model) => judgmentsAll
      .filter(j => j.task_id === taskId && (j.run_model || '') === model)
      .sort((a, b) => String(b.judged_at || '').localeCompare(String(a.judged_at || '')))[0] || null;
    const taskVerdicts = (taskId) => [...new Set(runsFor(taskId).map(modelOf).filter(Boolean))].map(m => ({ model: m, j: verdictFor(taskId, m) }));
    const needsRerun = (taskId) => taskVerdicts(taskId).some(v => v.j && v.j.answer_correct === false);
    const rerunCount = tasks.filter(t => needsRerun(t.id)).length;
    const verdictHtml = (taskId) => taskVerdicts(taskId).map(v => v.j
      ? `<span class="study-traj-filter-n ${v.j.answer_correct === false ? 'study-annot-rerun' : (v.j.answer_correct === true ? 'study-perf-ok' : '')}" title="${escapeAttr(`${v.model} judged by ${v.j.judge_model}: ${v.j.answer_reason || ''} · snippet F1 ${Number(v.j.f1 || 0).toFixed(2)}`)}">${escapeHTML(v.model.split('/').pop())}: ${v.j.answer_correct === false ? '✗ incorrect — rerun' : (v.j.answer_correct === true ? '✓ correct' : '? unjudged')}</span>`
      : `<span class="study-traj-filter-n" title="Not judged yet — ⋯ → Model Comparison → Judge">${escapeHTML(v.model.split('/').pop())}: not judged</span>`).join(' ');

    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">📈 Record Model Performance</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-body">
          ${tasks.length ? `
          <div class="study-traj-group-head" title="Pick the model in Options first. Press ▶ to open the starting site with the instruction in the chat box. Run Guide, then press 📈 on the journey card.">
            Tasks to run <span class="study-traj-filter-n">${tasks.length}</span>${models.length ? ` <span class="study-traj-meta">· models so far: ${models.map(escapeHTML).join(', ')}</span>` : ''}${rerunCount ? ` <span class="study-traj-filter-n study-annot-rerun">${rerunCount} judged incorrect — rerun</span>` : ''}
          </div>
          <div id="study-perf-tasks">
            ${tasks.map((t, i) => {
              const runs = runsFor(t.id);
              const ran = [...new Set(runs.map(modelOf).filter(Boolean))];
              return `
              <div class="study-traj-row${runs.length && !needsRerun(t.id) ? ' study-traj-row-out' : ''}${needsRerun(t.id) ? ' study-perf-rerun-row' : ''}${current?.id === t.id ? ' study-annot-task-current' : ''}">
                <span class="study-traj-step-n">${i + 1}</span>
                <div class="study-traj-main">
                  <div class="study-traj-title">${escapeHTML(t.name)}${current?.id === t.id ? ' <span class="study-traj-filter-n">running</span>' : ''}${needsRerun(t.id) ? ' <span class="study-traj-filter-n study-annot-rerun">↻ rerun</span>' : ''}</div>
                  <div class="study-traj-meta">${escapeHTML(t.task)}</div>
                  <div class="study-traj-meta">${escapeHTML(t.url)}${runs.length ? ` · ${runs.length} run${runs.length === 1 ? '' : 's'}${ran.length ? ` (${ran.map(escapeHTML).join(', ')})` : ''}` : ''}</div>
                  ${runs.length ? `<div class="study-traj-meta study-perf-verdicts">${verdictHtml(t.id)}</div>` : ''}
                </div>
                <button class="study-evidence-clear${needsRerun(t.id) ? ' study-cmp-rerun' : ''}" data-perf-start="${escapeAttr(t.id)}" title="${needsRerun(t.id) ? 'Judged incorrect — rerun: ' : ''}Open the site and put the task in the chat box">${needsRerun(t.id) ? '↻ Rerun' : '▶'}</button>
              </div>`;
            }).join('')}
          </div>
          <div class="study-traj-group-head">Captured runs <span class="study-traj-filter-n">${rows.length}</span></div>` : ''}
          <p class="study-intro">${rows.length
            ? `Guide runs captured per model. <strong>${ticked} of ${rows.length}</strong> ticked${rows.some(t => !t.task_id) ? ` · <span class="study-annot-rerun">${rows.filter(t => !t.task_id).length} not assigned to a task</span>` : ''}.
               Publishing upserts them into <code>pageguide_model_performance_trajectories</code>
               (see <code>supabase_schema_model_performance.sql</code>)${configured ? '' : ' — V2 Supabase is not configured, so use Export'}.`
            : 'Nothing captured yet. Pick a model in Options, run a task, then press 📈 on its journey card to capture it.'}</p>
          ${rows.length ? `
          <div class="study-traj-bulk">
            <button class="study-evidence-clear" data-perf-bulk="in">Select all</button>
            <button class="study-evidence-clear" data-perf-bulk="out">Deselect all</button>
            <button class="study-evidence-clear" id="study-perf-publish" ${configured ? '' : 'disabled'}
              title="Upsert every ticked run into pageguide_model_performance_trajectories">⬆ Publish → Supabase</button>
            <button class="study-evidence-clear" id="study-perf-export"
              title="Save the ticked runs as a JSON file">⬇ Export JSON</button>
          </div>
          <div class="study-llm-answers-note" id="study-perf-note"></div>
          <div id="study-perf-list">
            ${rows.map(t => {
              const steps = t.arms?.grounding?.steps || [];
              const on = t.in_report !== false;
              return `
              <div class="study-traj-row${on ? '' : ' study-traj-row-out'}" data-perf-id="${escapeAttr(t.id)}">
                <input type="checkbox" class="study-annot-tick" data-perf-tick="${escapeAttr(t.id)}" ${on ? 'checked' : ''}
                  title="Include in the report">
                <div class="study-traj-main">
                  <div class="study-traj-title">${modelOf(t) ? `<span class="study-traj-filter-n study-perf-model">${escapeHTML(modelOf(t))}</span> ` : ''}${escapeHTML(t.title || t.goal || t.id)}</div>
                <div class="study-traj-meta study-perf-assign">Task:
                  <select data-perf-task="${escapeAttr(t.id)}" title="Which of the 12 tasks this run is a run of — the comparison pairs runs with their task's annotation baseline">
                    <option value="">— not assigned —</option>
                    ${tasks.map(k => `<option value="${escapeAttr(k.id)}" ${k.id === t.task_id ? 'selected' : ''}>${escapeHTML(k.name)}</option>`).join('')}
                    ${t.task_id && !tasks.some(k => k.id === t.task_id) ? `<option value="${escapeAttr(t.task_id)}" selected>${escapeHTML(t.task_id)} (not in tasks.json)</option>` : ''}
                  </select>${t.task_id ? '' : ' <span class="study-annot-rerun">⚠ unassigned — will not appear in Model Comparison</span>'}
                </div>
                  <div class="study-traj-meta">${steps.length} step${steps.length === 1 ? '' : 's'}
                    · ${t.arms?.grounding?.answer ? 'answer recorded' : 'no answer'}
                    · ${escapeHTML(costOf(t))}
                    · ${escapeHTML(String(t.captured_at || '').slice(0, 16).replace('T', ' '))}</div>
                </div>
                <button class="study-evidence-clear" data-perf-delete="${escapeAttr(t.id)}" title="Remove from this bank">🗑</button>
              </div>`;
            }).join('')}
          </div>` : ''}
        </div>
      </div>
    `);
    $('study-close').onclick = closeStudyPanel;
    overlay.querySelectorAll('[data-perf-start]').forEach(btn => {
      btn.onclick = () => { const t = tasks.find(x => x.id === btn.dataset.perfStart); if (t) startAnnotationTask(t); };
    });
    if (!rows.length) return;

    const note = (msg) => { const el = $('study-perf-note'); if (el) el.textContent = msg; };
    const setTick = async (id, on) => {
      const rec = await getModelPerformanceTrajectory(id);
      if (!rec) return;
      rec.in_report = !!on;
      await saveModelPerformanceTrajectory(rec, { downscale: false });
    };
    overlay.querySelectorAll('[data-perf-tick]').forEach(cb => {
      cb.onchange = async () => { await setTick(cb.dataset.perfTick, cb.checked); renderModelPerformanceTrajectoryList(); };
    });
    overlay.querySelectorAll('[data-perf-bulk]').forEach(btn => {
      btn.onclick = async () => {
        for (const t of rows) await setTick(t.id, btn.dataset.perfBulk === 'in');
        renderModelPerformanceTrajectoryList();
      };
    });
    overlay.querySelectorAll('[data-perf-delete]').forEach(btn => {
      btn.onclick = async () => { await deleteModelPerformanceTrajectory(btn.dataset.perfDelete); renderModelPerformanceTrajectoryList(); };
    });
    // Assign / reassign the task a run belongs to. Saved at once; a re-publish updates the row's
    // source_task_id in place, so a run captured under the wrong task is fixed here, not re-recorded.
    overlay.querySelectorAll('[data-perf-task]').forEach(sel => {
      sel.onchange = async () => {
        const rec = await getModelPerformanceTrajectory(sel.dataset.perfTask);
        if (!rec) return;
        const task = tasks.find(k => k.id === sel.value);
        rec.task_id = task ? task.id : '';
        rec.task_name = task ? task.name : '';
        await saveModelPerformanceTrajectory(rec, { downscale: false });
        note(task ? `Assigned to ${task.name}. Publish again to update Supabase.` : 'Unassigned.');
        renderModelPerformanceTrajectoryList();
      };
    });
    const pub = $('study-perf-publish');
    if (pub) pub.onclick = async () => {
      pub.disabled = true;
      note('Publishing…');
      const res = await publishModelPerformanceTrajectories(rows);
      note(res.ok ? describeModelPerformancePublish(res.rows) : `Could not publish: ${res.error}`);
      pub.disabled = false;
    };
    const exp = $('study-perf-export');
    if (exp) exp.onclick = () => {
      const bundle = buildModelPerformanceBundle(rows);
      const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'model_performance_trajectories.json';
      a.click();
      URL.revokeObjectURL(a.href);
      note(`Exported ${bundle.trajectories.length} runs.`);
    };
  }

  // ── Model Comparison ──
  // The 12 tasks side by side: the run the annotators are grading (pageguide_annotation_trajectories,
  // with the annotators' evidence verdicts from pageguide_annotation_results) against every
  // model-performance run of the same task (pageguide_model_performance_trajectories, or this
  // bank's unpublished captures). Read-only; everything comes from Supabase, with the local
  // model-performance bank filled in for runs not yet published.
  let _compareModel = 'all';
  let _compareOpen = new Set();
  let _compareShowAll = new Set();                    // task ids whose non-final runs are unfolded
  const COMPARE_FINAL_KEY = 'pageguide_compare_final_runs';   // { "<task id>|<model>": run id }
  async function _loadFinalRuns() {
    try { const d = await chrome.storage.local.get(COMPARE_FINAL_KEY); return (d[COMPARE_FINAL_KEY] && typeof d[COMPARE_FINAL_KEY] === 'object') ? d[COMPARE_FINAL_KEY] : {}; }
    catch (e) { return {}; }
  }
  async function _setFinalRun(taskId, model, runId) {
    const all = await _loadFinalRuns();
    all[`${taskId}|${model}`] = runId;
    await chrome.storage.local.set({ [COMPARE_FINAL_KEY]: all });
  }
  const JUDGMENTS_KEY = 'pageguide_llm_judgments';   // { "<baseline id>|<run id>": judgment }
  let _judgeChoice = null;                            // { provider, model } — defaults to JUDGE_MODELS[0]
  let _judging = false;

  async function _loadJudgments() {
    try {
      const d = await chrome.storage.local.get(JUDGMENTS_KEY);
      const stored = (d[JUDGMENTS_KEY] && typeof d[JUDGMENTS_KEY] === 'object') ? d[JUDGMENTS_KEY] : {};
      const migrated = migrateJudgments(stored);
      // Judgments are kept per judge model, so a second opinion never overwrites the first.
      if (Object.keys(migrated).some(k => !(k in stored))) await chrome.storage.local.set({ [JUDGMENTS_KEY]: migrated });
      return migrated;
    } catch (e) { return {}; }
  }
  /** The OpenAI key lives where Options keeps it; the judge bar can set it when it is missing. */
  async function _openaiKeySet() {
    try { const st = await chrome.storage.sync.get('openaiApiKey'); return !!String(st.openaiApiKey || '').trim(); } catch (e) { return false; }
  }
  async function _saveJudgment(pairKey, judgment) {
    const all = await _loadJudgments();
    all[pairKey] = judgment;
    await chrome.storage.local.set({ [JUDGMENTS_KEY]: all });
  }

  /** Evidence items with the note the judge reads (key + what the agent said the crop shows). */
  function _evidenceItemsOf(answer, arms, stepUrls = null) {
    const notes = new Map(), steps = new Map();
    (arms?.grounding?.answer_evidence || []).forEach((e, i) => {
      const k = _evidenceKeysOf('', { grounding: { answer_evidence: [e] } })[0]?.key;
      if (k) { notes.set(k, String(e?.note || '')); if (e?.step != null) steps.set(k, Number(e.step)); }
    });
    const items = _evidenceKeysOf(answer, arms).map(e => ({ key: e.key, note: notes.get(e.key) || (e.crop ? '' : '(cited in the answer, no crop saved)'), step: steps.has(e.key) ? steps.get(e.key) : null }));
    return stepUrls ? _attachEvidenceUrls(items, stepUrls) : items;
  }
  /** Step URLs for a run: the RPC map for published rows, the banked steps for local ones. */
  function _stepUrlsFor(row, map) {
    if (row?.local && row.arms?.grounding?.steps) return row.arms.grounding.steps.map((st, i) => ({ n: st?.n ?? i + 1, url: st?.url || '' }));
    return (map && (map.get(row?.id) || map.get(row?.source_trajectory_id))) || null;
  }
  const GT_ANNOTATOR = 'A';   // whose verdicts define the ground-truth evidence

  /**
   * Judge one (baseline, run) pair with the chosen model. The ground truth is the baseline's answer
   * and the evidence items the annotators kept; the candidate is the run's answer and evidence.
   * Stores the parsed judgment plus the P/R/F1 it scores to, keyed by the pair.
   */
  async function _judgePair(task, base, run, results) {
    const judge = _judgeChoice || JUDGE_MODELS[0];
    const baseItems = _evidenceItemsOf(base.agent_answer, base.arms);
    const verdicts = results.filter(r => r.trajectory_id === base.id).flatMap(r => (Array.isArray(r.evidence_labels) ? r.evidence_labels : []).map(l => ({ key: l?.key, correct: l?.correct, annotator: r.annotator_id })));
    const gt = groundTruthEvidence(baseItems, verdicts, GT_ANNOTATOR);
    const cand = _evidenceItemsOf(run.agent_answer, run.arms);
    const systemPrompt = buildJudgeSystemPrompt();
    const userPrompt = buildJudgeUserPrompt({ task: task.task, groundTruth: { answer: _stripEv(base.agent_answer), evidence: gt }, candidate: { answer: _stripEv(run.agent_answer), evidence: cand }, candidateModel: run.model || run.provider || '' });
    const res = await chrome.runtime.sendMessage({
      action: 'callLLM', systemPrompt, messages: [{ role: 'user', content: userPrompt }],
      overrides: { provider: judge.provider, model: judge.model },
      metadata: { mode: 'judge', task: task.id, baseline: base.id, run: run.id, judge: judge.model, prompt_version: JUDGE_PROMPT_VERSION },
    });
    if (!res || res.error) throw new Error(res?.error || 'No response from the judge');
    const parsed = parseJudgeResponse(res.content);
    if (!parsed) throw new Error('Judge returned no JSON');
    const score = scoreJudgment(parsed, gt.map(e => e.key), cand.map(e => e.key));
    const judgment = Object.assign({ task_id: task.id, baseline_id: base.id, run_id: run.id, run_model: run.model || run.provider || '',
      judge_provider: judge.provider, judge_model: judge.model, prompt_version: JUDGE_PROMPT_VERSION, judged_at: new Date().toISOString(), gt_annotator: GT_ANNOTATOR,
      answer_reason: parsed.answer_reason, gt_keys: gt.map(e => e.key), candidate_keys: cand.map(e => e.key), raw: parsed }, score);
    await _saveJudgment(judgmentKey(base.id, run.id, judge.model), judgment);
    return judgment;
  }

  async function _loadAnnotationResults() {
    if (!(typeof window._v2Configured === 'function' && window._v2Configured())) return [];
    try {
      const res = await fetch(`${SUPABASE_V2_URL}/rest/v1/pageguide_annotation_results?select=trajectory_id,annotator_id,evidence_labels,evidence_count,answer_correct`, { headers: window._v2Headers() });
      return res.ok ? await res.json() : [];
    } catch (e) { return []; }
  }
  /** [{n,url}] per live run, by run id — from the step-url RPCs (supabase_migration_step_urls.sql). */
  let _stepUrlsError = '';
  async function _loadStepUrls(fn) {
    if (!(typeof window._v2Configured === 'function' && window._v2Configured())) return new Map();
    try {
      const res = await fetch(`${SUPABASE_V2_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: window._v2Headers(), body: '{}' });
      if (!res.ok) { if (res.status === 404) _stepUrlsError = 'run supabase_migration_step_urls.sql for page-level metrics'; return new Map(); }
      const rows = await res.json();
      return new Map(rows.map(r => [r.id, Array.isArray(r.step_urls) ? r.step_urls : []]));
    } catch (e) { return new Map(); }
  }
  /** The URL an evidence item came from: its step's page, else the run's last page. */
  function _attachEvidenceUrls(items, stepUrls) {
    const byN = new Map((stepUrls || []).map(su => [Number(su?.n), String(su?.url || '')]));
    const last = (stepUrls || []).length ? String(stepUrls[stepUrls.length - 1]?.url || '') : '';
    return items.map(e => Object.assign({}, e, { url: (e.step != null && byN.get(Number(e.step))) || last }));
  }

  let _perfLoadError = '';
  async function _loadModelPerfRows() {
    _perfLoadError = '';
    if (!(typeof window._v2Configured === 'function' && window._v2Configured())) return [];
    try {
      const res = await fetch(`${SUPABASE_V2_URL}/rest/v1/pageguide_model_performance_trajectories?select=id,source_task_id,source_trajectory_id,title,goal,step_count,agent_answer,provider,model,calls,cost_usd,prompt_tokens,completion_tokens,duration_ms,evidence:arms->grounding->answer_evidence,captured_at&order=captured_at.asc`, { headers: window._v2Headers() });
      if (!res.ok) { _perfLoadError = `model runs: HTTP ${res.status}`; return []; }
      const rows = await res.json();
      return rows.map(r => Object.assign(r, { arms: { grounding: { answer_evidence: Array.isArray(r.evidence) ? r.evidence : [] } } }));
    } catch (e) { _perfLoadError = `model runs: ${e.message}`; return []; }
  }

  /** Evidence items of a run: saved crops + cited markers without a crop (same rule as the site). */
  function _evidenceKeysOf(answer, arms) {
    const norm = (k) => String(k == null ? '' : k).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
    const keys = [];
    const seen = new Set();
    (arms?.grounding?.answer_evidence || []).forEach((e, i) => { const k = norm(e?.key == null ? i + 1 : e.key); if (k && !seen.has(k)) { seen.add(k); keys.push({ key: k, crop: !!(e?.screenshot) }); } });
    const re = /\[ev:\s*([^\]]+?)\s*\]/g; let m;
    while ((m = re.exec(String(answer || '')))) { const k = norm(m[1]); if (k && !seen.has(k)) { seen.add(k); keys.push({ key: k, crop: false }); } }
    return keys;
  }

  /** The annotators' verdicts on one baseline run: per annotator, correct / graded. */
  function _evidenceVerdicts(results, trajectoryId) {
    return results.filter(r => r.trajectory_id === trajectoryId).map(r => {
      const labels = Array.isArray(r.evidence_labels) ? r.evidence_labels : [];
      const graded = labels.filter(l => l && l.correct !== null && l.correct !== undefined);
      return { who: r.annotator_id, correct: graded.filter(l => l.correct === true).length, graded: graded.length, total: Number(r.evidence_count) || graded.length,
        bad: graded.filter(l => l.correct === false).map(l => `${l.key}${l.problem ? ` (${l.problem})` : ''}`) };
    }).sort((a, b) => String(a.who).localeCompare(String(b.who)));
  }

  const _fmtMoney = (v) => (v == null || !isFinite(Number(v))) ? '—' : `$${Number(v).toFixed(4)}`;
  const _fmtSecs = (ms) => (ms == null || !isFinite(Number(ms))) ? '—' : `${Math.round(Number(ms) / 1000)}s`;
  const _stripEv = (t) => String(t || '').replace(/\s*\[ev:[^\]]+\]/g, '').trim();

  async function renderModelComparison() {
    setHTML(`<div class="study-screen"><div class="study-header"><span class="study-title">📊 Model Comparison</span><button class="study-close-btn" id="study-close">✕</button></div><div class="study-body"><p class="study-intro">Loading…</p></div></div>`);
    $('study-close').onclick = closeStudyPanel;
    _stepUrlsError = '';
    const [tasks, live, results, perfRemote, perfLocalAll, judgments, baseUrls, perfUrls, finalRuns, openaiKeySet] = await Promise.all([
      loadAnnotationTasks(), _loadLiveAnnotationRows(), _loadAnnotationResults(), _loadModelPerfRows(), listModelPerformanceTrajectories(), _loadJudgments(),
      _loadStepUrls('pageguide_annotation_step_urls'), _loadStepUrls('pageguide_model_performance_step_urls'), _loadFinalRuns(), _openaiKeySet(),
    ]);
    // Page-level scores are deterministic, so they are computed here from the current data rather
    // than stored with the judgment: ground truth = the baseline items annotator A kept.
    const pageScoreFor = (base, run) => {
      if (!base || !run) return null;
      const bu = _stepUrlsFor(base, baseUrls), ru = _stepUrlsFor(run, perfUrls);
      if (!bu || !ru) return null;
      const verdicts = results.filter(r => r.trajectory_id === base.id).flatMap(r => (Array.isArray(r.evidence_labels) ? r.evidence_labels : []).map(l => ({ key: l?.key, correct: l?.correct, annotator: r.annotator_id })));
      const gt = groundTruthEvidence(_evidenceItemsOf(base.agent_answer, base.arms, bu), verdicts, GT_ANNOTATOR);
      return pageLevelScore(gt, _evidenceItemsOf(run.agent_answer, run.arms, ru));
    };
    const judge = _judgeChoice || JUDGE_MODELS[0];
    // The selected judge's verdicts drive the cells, the table and the means; other judges' verdicts
    // on the same pair are listed beside them and compared in the judge bar.
    const judgmentBy = (base, run, judgeModel) => (base && run) ? judgments[judgmentKey(base.id, run.id, judgeModel)] || null : null;
    const judgmentFor = (base, run) => {
      const j = judgmentBy(base, run, judge.model);
      if (!j) return null;
      return Object.assign({}, j, pageScoreFor(base, run) || {});
    };
    const otherJudges = [...new Set(Object.values(judgments).map(j => j.judge_model).filter(m => m && m !== judge.model))].sort();
    const otherOpinions = (base, run) => otherJudges.map(m => ({ judge: m, j: judgmentBy(base, run, m) })).filter(o => o.j);
    const pct = (v) => v == null ? '—' : `${Math.round(v * 100)}%`;
    const f2 = (v) => v == null ? '—' : Number(v).toFixed(2);
    const configured = typeof window._v2Configured === 'function' && window._v2Configured();
    // Local captures not yet published, shaped like the remote rows.
    const remoteIds = new Set(perfRemote.map(r => r.source_trajectory_id || r.id));
    const perfLocal = Object.values(perfLocalAll).filter(t => !remoteIds.has(t.id) && !remoteIds.has(_modelPerfId(t.id))).map(t => {
      const m = t.run_meta || {};
      return { id: t.id, source_task_id: t.task_id || '', title: t.title, goal: t.goal, step_count: (t.arms?.grounding?.steps || []).length,
        agent_answer: t.arms?.grounding?.answer || '', provider: m.provider || '', model: m.model || '', calls: m.calls, cost_usd: m.cost_usd,
        prompt_tokens: m.prompt_tokens, completion_tokens: m.completion_tokens, duration_ms: m.duration_ms, arms: t.arms, captured_at: t.captured_at, local: true };
    });
    const perf = perfRemote.concat(perfLocal);
    const models = [...new Set(perf.map(r => r.model || r.provider).filter(Boolean))].sort();
    // One run per task × model counts toward the table and the means: the one you picked (★), else
    // the most recent capture. Reruns therefore replace the earlier attempt by default, and the
    // earlier attempts fold away under "show N other runs".
    const modelKey = (r) => r.model || r.provider || '';
    const isFinal = (r) => {
      const group = perf.filter(x => x.source_task_id === r.source_task_id && modelKey(x) === modelKey(r));
      const chosen = finalRuns[`${r.source_task_id}|${modelKey(r)}`];
      if (chosen && group.some(x => x.id === chosen)) return r.id === chosen;
      const latest = group.slice().sort((a, b) => String(b.captured_at || '').localeCompare(String(a.captured_at || '')))[0];
      return latest && latest.id === r.id;
    };
    const shownPerf = _compareModel === 'all' ? perf : perf.filter(r => (r.model || r.provider) === _compareModel);
    const baselineFor = (taskId) => (live || []).filter(r => r.source_task_id === taskId).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null;

    const answerBlock = (label, text, extra = '') => `
      <div class="study-cmp-answer"><div class="study-cmp-kicker">${label}</div><div class="study-cmp-text">${escapeHTML(_stripEv(text) || '(no answer recorded)')}</div>${extra}</div>`;

    const rowsHtml = tasks.map((t, i) => {
      const base = baselineFor(t.id);
      const baseEv = base ? _evidenceKeysOf(base.agent_answer, base.arms) : [];
      const verdicts = base ? _evidenceVerdicts(results, base.id) : [];
      const allRuns = shownPerf.filter(r => r.source_task_id === t.id).sort((a, b) => String(a.captured_at || '').localeCompare(String(b.captured_at || '')));
      const finalRunsHere = allRuns.filter(isFinal);
      const otherRuns = allRuns.filter(r => !isFinal(r));
      const showAll = _compareShowAll.has(t.id);
      const runs = showAll ? allRuns : finalRunsHere;
      const open = _compareOpen.has(t.id);
      const finalTag = (r) => isFinal(r)
        ? '<span class="study-traj-filter-n study-cmp-final" title="This run counts toward the table and the means">★ final</span>'
        : `<button class="study-evidence-clear study-cmp-makefinal" data-cmp-final="${escapeAttr(r.id)}" data-cmp-final-task="${escapeAttr(t.id)}" data-cmp-final-model="${escapeAttr(modelKey(r))}" title="Use this run as ${escapeAttr(modelKey(r))}'s final run for this task instead">☆ make final</button>`;
      const judgeCell = (r) => {
        const j = judgmentFor(base, r);
        if (!base) return '';
        if (!j) return `<div class="study-cmp-judge"><button class="study-evidence-clear" data-judge-run="${escapeAttr(r.id)}" data-judge-task="${escapeAttr(t.id)}" ${_judging ? 'disabled' : ''} title="Ask ${escapeAttr(judge.model)} to grade this run against the baseline">⚖ Judge</button></div>`;
        const ans = j.answer_correct === true ? '<span class="study-cmp-ok">answer ✓</span>' : (j.answer_correct === false ? '<span class="study-cmp-bad">answer ✗</span>' : 'answer ?');
        const rerun = j.answer_correct === false
          ? `<button class="study-evidence-clear study-cmp-rerun" data-cmp-rerun="${escapeAttr(t.id)}" title="Open ${escapeAttr(t.url)} with the task in the chat box; the next 📈 capture is tagged ${escapeAttr(t.name)}">↻ Rerun task</button>`
          : '';
        const others = otherOpinions(base, r).map(o => `<span class="study-cmp-other" title="${escapeAttr(`${o.judge}: ${o.j.answer_reason || ''}`)}">${escapeHTML(o.judge.split('/').pop())}: ${o.j.answer_correct === true ? '<span class="study-cmp-ok">✓</span>' : (o.j.answer_correct === false ? '<span class="study-cmp-bad">✗</span>' : '?')} F1 ${f2(o.j.f1)}</span>`).join('');
        return `<div class="study-cmp-judge" title="${escapeAttr(`${j.judge_model} · ${j.answer_reason || ''}\nGT evidence: ${(j.gt_keys || []).join(', ') || '—'}\nmissed: ${(j.unmatched_gt || []).join(', ') || '—'}\nextra: ${(j.unmatched_candidate || []).join(', ') || '—'}`)}">
          <span class="study-cmp-other" title="${escapeAttr(judge.model)}">${escapeHTML(judge.model.split('/').pop())}:</span> ${ans} · P ${f2(j.precision)} · R ${f2(j.recall)} · F1 ${f2(j.f1)}
          <button class="study-evidence-clear study-cmp-rejudge" data-judge-run="${escapeAttr(r.id)}" data-judge-task="${escapeAttr(t.id)}" ${_judging ? 'disabled' : ''} title="Re-judge with ${escapeAttr(judge.model)}">↻</button>
          ${rerun}
        </div>${others ? `<div class="study-cmp-judge study-cmp-others">${others}</div>` : ''}`;
      };
      const verdictHtml = verdicts.length
        ? verdicts.map(v => `<span class="study-traj-filter-n" title="${escapeAttr(v.bad.length ? `Marked not correct: ${v.bad.join(', ')}` : 'All evidence marked correct')}">${escapeHTML(v.who)}: ${v.correct}/${v.graded}${v.graded < v.total ? ` of ${v.total}` : ''} ✓</span>`).join(' ')
        : '<span class="study-traj-meta">not graded yet</span>';
      return `
        <div class="study-traj-row study-cmp-row${open ? ' study-cmp-open' : ''}" data-cmp-task="${escapeAttr(t.id)}">
          <span class="study-traj-step-n">${i + 1}</span>
          <div class="study-traj-main">
            <div class="study-traj-title">${escapeHTML(t.name)} <span class="study-traj-meta">${escapeHTML(t.task)}</span></div>
            <div class="study-cmp-grid">
              <div class="study-cmp-cell study-cmp-base">
                <div class="study-cmp-kicker">Annotation run (baseline)</div>
                ${base
                  ? `<div class="study-traj-meta">${base.step_count} steps · ${baseEv.length} evidence (${baseEv.filter(e => e.crop).length} with crop)</div>
                     <div class="study-cmp-verdicts">${verdictHtml}</div>`
                  : '<div class="study-traj-meta">not on the annotator site</div>'}
              </div>
              ${runs.length ? runs.map(r => `
              <div class="study-cmp-cell">
                <div class="study-cmp-kicker">${escapeHTML(r.model || r.provider || 'model ?')}${r.local ? ' <span class="study-traj-filter-n" title="Captured in this extension, not published yet">local</span>' : ''} ${finalTag(r)}</div>
                <div class="study-traj-meta">${escapeHTML(String(r.captured_at || '').slice(0, 16).replace('T', ' '))}</div>
                <div class="study-traj-meta">${r.step_count} steps${base ? ` (${r.step_count - base.step_count >= 0 ? '+' : ''}${r.step_count - base.step_count})` : ''} · ${_evidenceKeysOf(r.agent_answer, r.arms).length} evidence</div>
                <div class="study-traj-meta">${_fmtMoney(r.cost_usd)} · ${r.calls != null ? `${r.calls} calls` : '— calls'} · ${((Number(r.prompt_tokens) || 0) + (Number(r.completion_tokens) || 0)).toLocaleString()} tok · ${_fmtSecs(r.duration_ms)}</div>
                ${judgeCell(r)}
              </div>`).join('') : `<div class="study-cmp-cell study-traj-meta">no model run yet${_compareModel === 'all' ? '' : ` for ${escapeHTML(_compareModel)}`}</div>`}
            </div>
            ${otherRuns.length ? `<button class="study-evidence-clear study-cmp-showall" data-cmp-showall="${escapeAttr(t.id)}">${showAll ? `▴ hide ${otherRuns.length} earlier run${otherRuns.length === 1 ? '' : 's'}` : `▾ show ${otherRuns.length} other run${otherRuns.length === 1 ? '' : 's'} (not counted)`}</button>` : ''}
            ${open ? `
            <div class="study-cmp-answers">
              ${base ? answerBlock('Baseline answer', base.agent_answer) : ''}
              ${runs.map(r => answerBlock(`${escapeHTML(r.model || r.provider || 'model ?')} answer`, r.agent_answer)).join('')}
            </div>` : ''}
          </div>
          <button class="study-evidence-clear" data-cmp-toggle="${escapeAttr(t.id)}" title="${open ? 'Hide the answers' : 'Show the answers side by side'}">${open ? '▴' : '▾'}</button>
        </div>`;
    }).join('');

    const withBase = tasks.filter(t => baselineFor(t.id)).length;
    const withRun = tasks.filter(t => shownPerf.some(r => r.source_task_id === t.id)).length;
    // Pairs to judge: every shown run whose task has a baseline. Aggregate over the ones judged.
    const pairs = shownPerf.filter(isFinal).map(r => ({ run: r, base: baselineFor(r.source_task_id), task: tasks.find(t => t.id === r.source_task_id) })).filter(p => p.base && p.task);
    // Judge buttons on folded-away runs still work one at a time.
    const anyPair = (runId, taskId) => { const r = shownPerf.find(x => x.id === runId); const t = tasks.find(x => x.id === taskId); const b = r && baselineFor(r.source_task_id); return (r && t && b) ? { run: r, task: t, base: b } : null; };
    const unjudged = pairs.filter(p => !judgmentFor(p.base, p.run));
    const judged = pairs.map(p => Object.assign({}, p, { j: judgmentFor(p.base, p.run) })).filter(p => p.j);
    const agg = aggregateJudgments(judged.map(p => p.j));
    const tableHtml = judged.length ? `
      <div class="study-cmp-tablewrap">
        <table class="study-cmp-table">
          <thead>
            <tr><th rowspan="2">#</th><th rowspan="2">Task</th><th rowspan="2">Model</th><th rowspan="2">Answer</th><th colspan="3">Page-level</th><th colspan="3">Snippet-level</th></tr>
            <tr><th>Precision</th><th>Recall</th><th>F1</th><th>Precision</th><th>Recall</th><th>F1</th></tr>
          </thead>
          <tbody>
            ${judged.sort((a, b) => tasks.indexOf(a.task) - tasks.indexOf(b.task)).map(p => `
            <tr>
              <td>${tasks.indexOf(p.task) + 1}</td><td>${escapeHTML(p.task.name)}</td><td>${escapeHTML(p.run.model || p.run.provider || '')}</td>
              <td class="${p.j.answer_correct === true ? 'study-cmp-ok' : (p.j.answer_correct === false ? 'study-cmp-bad' : '')}">${p.j.answer_correct === true ? '✓' : (p.j.answer_correct === false ? '✗' : '—')}</td>
              <td>${f2(p.j.page_precision)}</td><td>${f2(p.j.page_recall)}</td><td>${f2(p.j.page_f1)}</td>
              <td>${f2(p.j.precision)}</td><td>${f2(p.j.recall)}</td><td>${f2(p.j.f1)}</td>
            </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr><td></td><td colspan="2"><strong>Mean</strong> (${agg.runs} runs${_compareModel === 'all' ? '' : ` · ${escapeHTML(_compareModel)}`})</td>
              <td><strong>${agg.answer_correct}/${agg.answer_judged}</strong></td>
              <td><strong>${f2(agg.mean_page_precision)}</strong></td><td><strong>${f2(agg.mean_page_recall)}</strong></td><td><strong>${f2(agg.mean_page_f1)}</strong></td>
              <td><strong>${f2(agg.mean_precision)}</strong></td><td><strong>${f2(agg.mean_recall)}</strong></td><td><strong>${f2(agg.mean_f1)}</strong></td></tr>
          </tfoot>
        </table>
        <div class="study-traj-meta">${judged.filter(p => p.j.answer_correct === false).length ? `<span class="study-cmp-bad">${judged.filter(p => p.j.answer_correct === false).length} incorrect</span> — press ↻ Rerun task on a run to redo it; the new capture is tagged with that task automatically. · ` : ''}One run per task and model counts (★ final — the latest capture unless you pick another). Ground truth = annotator ${GT_ANNOTATOR}'s kept evidence on the annotation run. Page = origin + path of the step each evidence item came from${_stepUrlsError ? ` — <span class="study-cmp-bad">${escapeHTML(_stepUrlsError)}</span>` : ''}. Snippet = the judge's fact-level pairing. <button class="study-evidence-clear" id="study-cmp-csv">⬇ CSV</button></div>
      </div>` : '';
    const aggHtml = agg.runs ? `
      <div class="study-cmp-agg">
        <div class="study-cmp-stat"><div class="study-cmp-stat-n">${agg.answer_correct}/${agg.answer_judged}</div><div class="study-cmp-stat-l">final answer correct (${pct(agg.answer_accuracy)})</div></div>
        <div class="study-cmp-stat"><div class="study-cmp-stat-n">${f2(agg.mean_precision)}</div><div class="study-cmp-stat-l">evidence precision (mean · micro ${f2(agg.micro_precision)})</div></div>
        <div class="study-cmp-stat"><div class="study-cmp-stat-n">${f2(agg.mean_recall)}</div><div class="study-cmp-stat-l">evidence recall (mean · micro ${f2(agg.micro_recall)})</div></div>
        <div class="study-cmp-stat"><div class="study-cmp-stat-n">${f2(agg.mean_f1)}</div><div class="study-cmp-stat-l">evidence F1 (mean · micro ${f2(agg.micro_f1)})</div></div>
        <div class="study-traj-meta">${agg.runs} run${agg.runs === 1 ? '' : 's'} judged${_compareModel === 'all' ? ' across all models' : ` for ${escapeHTML(_compareModel)}`}</div>
      </div>` : '';
    const judgeBar = `
      <div class="study-cmp-judgebar">
        <label class="study-traj-meta">⚖ Judge model
          <select id="study-cmp-judge-model">
            ${JUDGE_MODELS.map(m => `<option value="${escapeAttr(`${m.provider}|${m.model}`)}" ${m.provider === judge.provider && m.model === judge.model ? 'selected' : ''}>${escapeHTML(m.model)}${m.provider !== 'openrouter' ? ` (${escapeHTML(m.provider)})` : ''}</option>`).join('')}
          </select>
        </label>
        <button class="study-evidence-clear" id="study-cmp-judge-all" ${_judging || !unjudged.length ? 'disabled' : ''} title="Judge every shown run that has a baseline and no judgment yet">⚖ Judge ${unjudged.length} unjudged</button>
        <button class="study-evidence-clear" id="study-cmp-judge-redo" ${_judging || !pairs.length ? 'disabled' : ''} title="Judge every shown run again with the selected judge model">↻ Re-judge all ${pairs.length}</button>
        <button class="study-evidence-clear" id="study-cmp-judge-export" ${!agg.runs ? 'disabled' : ''} title="Download every stored judgment as JSON">⬇ Judgments</button>
        <span class="study-traj-meta" id="study-cmp-judge-note">${_judging ? 'Judging…' : `Prompt: sidepanel/llm_judge.js (${JUDGE_PROMPT_VERSION}) · text-only, ground truth = annotator ${GT_ANNOTATOR}'s kept evidence`}</span>
      </div>
      ${judge.provider === 'openai' ? `
      <div class="study-cmp-judgebar study-cmp-keybar">
        <span class="study-traj-meta">OpenAI API key: ${openaiKeySet
          ? '<span class="study-cmp-ok">✓ set</span> in Options → OpenAI — the judge uses it directly; your agent stays on its own provider.'
          : `<span class="study-cmp-bad">not set</span> — ${escapeHTML(judge.model)} needs it. Paste it under Options → OpenAI → API key, then come back.`}</span>
        <button class="study-evidence-clear" id="study-cmp-open-options">Open Options</button>
      </div>` : ''}
      ${otherJudges.length ? `
      <div class="study-cmp-judgebar">
        <span class="study-traj-meta">Judges on record: <strong>${escapeHTML(judge.model)}</strong> (${Object.values(judgments).filter(j => j.judge_model === judge.model).length})${otherJudges.map(m => {
          const ag = judgeAgreement(Object.values(judgments).filter(j => j.judge_model === judge.model), Object.values(judgments).filter(j => j.judge_model === m));
          return ` · ${escapeHTML(m)} (${Object.values(judgments).filter(j => j.judge_model === m).length})${ag.pairs ? ` — agree on answer ${ag.answer_agree}/${ag.answer_compared}${ag.mean_abs_f1_diff != null ? `, mean |ΔF1| ${f2(ag.mean_abs_f1_diff)}` : ''}` : ''}`;
        }).join('')}. Switch the judge above to see the other opinion's table.</span>
      </div>` : ''}`;
    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">📊 Model Comparison</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-body">
          <p class="study-intro">${configured
            ? `The ${tasks.length} annotation tasks: the run the annotators are grading against each model run of the same task. <strong>${withBase}</strong> have a baseline on the annotator site · <strong>${withRun}</strong> have a model run${_compareModel === 'all' ? '' : ` from ${escapeHTML(_compareModel)}`}. Evidence verdicts are the annotators' (✓ = correct &amp; relevant).`
            : 'V2 Supabase is not configured — only this extension\'s unpublished model runs are shown.'}
            ${_liveLoadError || _perfLoadError ? `<br><span class="study-cmp-bad">Could not load ${escapeHTML([_liveLoadError, _perfLoadError].filter(Boolean).join(' · '))} — press ⟳ to retry.</span>` : ''}</p>
          <div class="study-traj-filters">
            <button class="study-traj-filter${_compareModel === 'all' ? ' study-traj-filter-on' : ''}" data-cmp-model="all">All models <span class="study-traj-filter-n">${perf.length}</span></button>
            ${models.map(m => `<button class="study-traj-filter${_compareModel === m ? ' study-traj-filter-on' : ''}" data-cmp-model="${escapeAttr(m)}">${escapeHTML(m)} <span class="study-traj-filter-n">${perf.filter(r => (r.model || r.provider) === m).length}</span></button>`).join('')}
            <button class="study-traj-filter" id="study-cmp-refresh" title="Re-read Supabase">⟳</button>
          </div>
          ${judgeBar}
          ${tableHtml}
          ${aggHtml}
          ${rowsHtml}
        </div>
      </div>`);
    $('study-close').onclick = closeStudyPanel;
    $('study-cmp-refresh').onclick = renderModelComparison;
    overlay.querySelectorAll('[data-cmp-model]').forEach(b => { b.onclick = () => { _compareModel = b.dataset.cmpModel; renderModelComparison(); }; });
    overlay.querySelectorAll('[data-cmp-toggle]').forEach(b => {
      b.onclick = () => { const id = b.dataset.cmpToggle; _compareOpen.has(id) ? _compareOpen.delete(id) : _compareOpen.add(id); renderModelComparison(); };
    });
    overlay.querySelectorAll('[data-cmp-showall]').forEach(b => {
      b.onclick = () => { const id = b.dataset.cmpShowall; _compareShowAll.has(id) ? _compareShowAll.delete(id) : _compareShowAll.add(id); renderModelComparison(); };
    });
    overlay.querySelectorAll('[data-cmp-final]').forEach(b => {
      b.onclick = async () => { await _setFinalRun(b.dataset.cmpFinalTask, b.dataset.cmpFinalModel, b.dataset.cmpFinal); renderModelComparison(); };
    });
    overlay.querySelectorAll('[data-cmp-rerun]').forEach(b => {
      b.onclick = () => { const t = tasks.find(x => x.id === b.dataset.cmpRerun); if (t) startAnnotationTask(t); };
    });
    const sel = $('study-cmp-judge-model');
    if (sel) sel.onchange = () => { const [provider, model] = sel.value.split('|'); _judgeChoice = { provider, model }; renderModelComparison(); };
    const judgeNote = (msg) => { const el = $('study-cmp-judge-note'); if (el) el.textContent = msg; };
    // Judge calls are independent, so "all" runs JUDGE_CONCURRENCY of them at once; each pair's
    // judgment is saved as it lands (_judgePair), so a failure or a closed panel loses only its own.
    const runJudge = async (list) => {
      if (_judging || !list.length) return;
      _judging = true;
      let done = 0, failed = 0;
      const failures = [];
      overlay.querySelectorAll('[data-judge-run], #study-cmp-judge-all, #study-cmp-judge-redo').forEach(b => { b.disabled = true; });
      judgeNote(`Judging ${list.length} run${list.length === 1 ? '' : 's'} with ${judge.model}, ${Math.min(JUDGE_CONCURRENCY, list.length)} at a time…`);
      await runWithConcurrency(list, JUDGE_CONCURRENCY, (p) => _judgePair(p.task, p.base, p.run, results), (p, r) => {
        if (r.ok) done++; else { failed++; failures.push(`${p.task.name}: ${r.error?.message || r.error}`); console.warn('[Compare] judge failed:', p.run.id, r.error); }
        judgeNote(`Judged ${done + failed} / ${list.length}${failed ? ` (${failed} failed)` : ''} — last: ${p.task.name} · ${p.run.model || p.run.provider || 'run'}`);
      });
      _judging = false;
      renderModelComparison().then(() => judgeNote(`Judged ${done}${failed ? `, ${failed} failed — ${failures.join('; ')}` : ''} with ${judge.model}.`));
    };
    overlay.querySelectorAll('[data-judge-run]').forEach(b => {
      b.onclick = () => { const p = anyPair(b.dataset.judgeRun, b.dataset.judgeTask); if (p) runJudge([p]); };
    });
    const allBtn = $('study-cmp-judge-all'); if (allBtn) allBtn.onclick = () => runJudge(unjudged);
    const redoBtn = $('study-cmp-judge-redo'); if (redoBtn) redoBtn.onclick = () => runJudge(pairs);
    const openOpts = $('study-cmp-open-options'); if (openOpts) openOpts.onclick = () => {
      try { chrome.runtime.openOptionsPage(); } catch (e) { window.open(chrome.runtime.getURL('options/options.html'), '_blank'); }
    };
    const csvBtn = $('study-cmp-csv'); if (csvBtn) csvBtn.onclick = () => {
      const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
      const head = ['task_id', 'task', 'model', 'run_id', 'answer_correct', 'page_precision', 'page_recall', 'page_f1', 'snippet_precision', 'snippet_recall', 'snippet_f1', 'judge_model', 'gt_annotator', 'judged_at'];
      const lines = [head.join(',')].concat(judged.map(p => [p.task.id, p.task.name, p.run.model || p.run.provider || '', p.run.id, p.j.answer_correct, p.j.page_precision, p.j.page_recall, p.j.page_f1, p.j.precision, p.j.recall, p.j.f1, p.j.judge_model, p.j.gt_annotator || GT_ANNOTATOR, p.j.judged_at].map(q).join(',')));
      const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'model_comparison.csv'; a.click(); URL.revokeObjectURL(a.href);
    };
    const expBtn = $('study-cmp-judge-export'); if (expBtn) expBtn.onclick = async () => {
      const all = await _loadJudgments();
      const blob = new Blob([JSON.stringify({ kind: 'pageguide_llm_judgments', exported_at: new Date().toISOString(), judgments: Object.values(all) }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'llm_judgments.json'; a.click(); URL.revokeObjectURL(a.href);
    };
  }

  async function renderGuideTrajectoryList() {
    const all = await listGuideTrajectories();
    const rows = Object.values(all).sort((a, b) => String(b.captured_at || '').localeCompare(String(a.captured_at || '')));
    // The order a participant walks, which is what task_index has to mean. The list itself is newest
    // first because that is the useful order to author in; publishing must not inherit that, or the
    // queue would run backwards.
    const queue = rows.slice().sort((a, b) => String(a.captured_at || '').localeCompare(String(b.captured_at || '')));
    const onV2 = _guideTrajSource === 'v2';
    const v2Index = onV2 ? await _loadGuideV2Index() : null;
    const counts = { all: rows.length, unassigned: rows.filter(t => !t.condition).length };
    GUIDE_CONDITIONS.forEach(c => { counts[c.id] = rows.filter(t => t.condition === c.id).length; });
    const filters = [{ id: 'all', label: 'All' }]
      .concat(GUIDE_CONDITIONS)
      .concat([{ id: 'unassigned', label: 'Unassigned' }]);
    const shown = rows.filter(t => _guideTrajFilter === 'all'
      || (_guideTrajFilter === 'unassigned' ? !t.condition : t.condition === _guideTrajFilter));
    // Counted over the WHOLE bank, not the filtered view: this is the number a participant will
    // walk, and it must not appear to change just because the list is filtered.
    const inStudy = rows.filter(t => _guideTrajectoryInStudy(t) && t.arms?.grounding?.steps?.length).length;

    // WHAT PRESSING PUBLISH WOULD DO, worked out by the same function that will do it. The headline
    // is a preview rather than a description of the bank, because the two differ in exactly the case
    // that matters — an edited trajectory whose V2 row is still the old one.
    const plan = (onV2 && v2Index?.ok && typeof planGuideV2Publish === 'function')
      ? planGuideV2Publish(queue, v2Index.rows)
      : [];
    const nCreate = plan.filter(p => p.action === 'create').length;
    const nUpdate = plan.filter(p => p.action === 'update').length;
    // Ticked but already live on V2 under a row this bank cannot see as its own — nothing here can
    // take those down, so they are counted separately rather than folded into the headline.
    const nSkippedLive = onV2 && v2Index?.ok
      ? rows.filter(t => !_guideTrajectoryInStudy(t) && _guideV2RowFor(v2Index, t)?.in_study).length
      : 0;
    // Rows on V2 that no trajectory here claims. A LIVE one is the case worth acting on: it is in
    // the participant's queue, nothing in this bank can update it, and publishing will not take it
    // down. Drafts are inert and are counted only so the total adds up.
    const v2Unmatched = (onV2 && v2Index?.ok && typeof unmatchedGuideV2Rows === 'function')
      ? unmatchedGuideV2Rows(rows, v2Index.rows)
      : [];
    const v2UnmatchedLive = v2Unmatched.filter(r => r.in_study);

    /**
     * The list, split into what V2 already has and what this run captured.
     *
     * TWO GROUPS RATHER THAN ONE FLAT LIST, because they are two different publishes: the first
     * group updates rows participants may already be walking, the second adds rows that do not
     * exist yet. Seeing which is which before pressing publish is the whole point — a capture that
     * looks new but is really an edit of a live task is exactly how the duplicate rows on V2
     * happened.
     *
     * V1 has no such distinction and stays a flat list.
     */
    function _guideTrajGroupsHtml(list, renderRow) {
      if (!onV2 || !v2Index?.ok) return list.map(renderRow).join('');
      const known = [];
      const fresh = [];
      list.forEach(t => (_guideV2RowFor(v2Index, t) ? known : fresh).push(t));
      const section = (label, hint, group) => group.length
        ? `<div class="study-traj-group-head" title="${escapeAttr(hint)}">${escapeHTML(label)}`
          + ` <span class="study-traj-filter-n">${group.length}</span></div>`
          + group.map(renderRow).join('')
        : '';
      return section('Already on V2', 'Matched to a row that is already published. Publishing '
          + 'updates that row in place rather than adding a second one.', known)
        + section('New from this run', 'No row on V2 yet. Publishing creates one.', fresh);
    }

    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">🧭 Record Guide User Study</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-body">
          <p class="study-intro">${rows.length
            ? `Captured guide runs. Edit one into the trajectory the study should show, then save it.
               ${onV2
                 ? (v2Index?.ok
                   ? `Publishing would <strong>update ${nUpdate}</strong> row${nUpdate === 1 ? '' : 's'}
                      already on <strong>V2</strong>, <strong>create ${nCreate}</strong> new one${nCreate === 1 ? '' : 's'}
                      from the ${plan.length} ticked here — ${v2Index.rows.length} row${v2Index.rows.length === 1 ? '' : 's'} on V2 today.
                      ${nSkippedLive ? `<strong>${nSkippedLive}</strong> unticked trajector${nSkippedLive === 1 ? 'y is' : 'ies are'}
                        still live on V2; publishing will not take ${nSkippedLive === 1 ? 'it' : 'them'} down.` : ''}`
                   : `Could not read V2: ${escapeHTML(v2Index?.error || 'unknown error')}`)
                 : `<strong>${inStudy} of ${rows.length}</strong> will appear in the Guide User Study.`}`
            : 'Nothing captured yet. Run a guide task, then press 🎬 on its journey card to capture it.'}</p>
          ${rows.length ? `
          <div class="study-traj-filters" id="study-traj-filters">
            ${filters.map(f => `
              <button class="study-traj-filter${f.id === _guideTrajFilter ? ' study-traj-filter-on' : ''}"
                data-traj-filter="${escapeAttr(f.id)}">${escapeHTML(f.label)}
                <span class="study-traj-filter-n">${counts[f.id] || 0}</span></button>`).join('')}
          </div>
          <div class="study-traj-bulk">
            <span class="study-traj-sub">Publish to:</span>
            <button class="study-traj-filter${onV2 ? ' study-traj-filter-on' : ''}" data-traj-source="v2"
              title="The four-variant V2 project — pageguide_guide_v2_tasks, written straight from here">V2</button>
            <button class="study-traj-filter${onV2 ? '' : ' study-traj-filter-on'}" data-traj-source="v1"
              title="The original project — study_guide_trajectories, written through the local publish helper">V1</button>
            ${onV2 ? '<button class="study-evidence-clear" id="study-traj-v2-refresh" title="Re-read what V2 currently holds">⟳</button>' : ''}
          </div>
          <div class="study-traj-bulk">
            <span class="study-traj-sub">${_guideTrajFilter === 'all'
              ? 'All trajectories:'
              : 'Shown here only:'}</span>
            <button class="study-evidence-clear" data-traj-bulk="in">Select all</button>
            <button class="study-evidence-clear" data-traj-bulk="out">Deselect all</button>
            ${onV2
              ? `<button class="study-evidence-clear" id="study-traj-publish-v2" title="Upsert every captured trajectory into the V2 pageguide_guide_v2_tasks table. Trajectories that are incomplete or excluded go up as drafts (in_study = false) and are named in the report.">⬆ Publish guide → V2</button>`
              : `<button class="study-evidence-clear" id="study-traj-publish" title="Publish the GUIDE trajectories via the local publish helper">⬆ Publish guide → V1</button>
                 <button class="study-evidence-clear" id="study-traj-export" title="Save the guide bundle to a file, to upload later with scripts/publish.mjs">⬇ Export instead</button>`}
          </div>
          <div class="study-llm-answers-note${v2UnmatchedLive.length ? ' study-note-bad' : ''}"
            id="study-traj-list-note">${v2Unmatched.length
              ? escapeHTML(`${v2Unmatched.length} row(s) on V2 match no trajectory here`
                + `${v2UnmatchedLive.length
                  ? `, and ${v2UnmatchedLive.length} of them ${v2UnmatchedLive.length === 1 ? 'is' : 'are'} LIVE: `
                    + `${v2UnmatchedLive.map(r => r.id).join(', ')}. Participants are walking `
                    + `${v2UnmatchedLive.length === 1 ? 'it' : 'them'} and publishing from here will not `
                    + 'change that — they were published from another bank. Edit or remove them in Supabase.'
                  : ' (all drafts, so nothing is walking them).'}`)
              : ''}</div>` : ''}
          ${shown.length ? _guideTrajGroupsHtml(shown, t => {
            const g = t.arms?.grounding;
            const ng = t.arms?.nongrounding;
            const gtProblem = _guideGroundTruthProblem(t.ground_truth);
            const included = _guideTrajectoryInStudy(t);
            const usable = !!g?.steps?.length;
            return `
            <div class="study-traj-row${included && usable ? '' : ' study-traj-row-out'}" data-traj="${escapeAttr(t.id)}">
              <label class="study-traj-pick" title="${usable
                ? 'Show this trajectory in the Guide User Study'
                : 'This trajectory has no steps, so it cannot be shown'}">
                <input type="checkbox" data-traj-in="${escapeAttr(t.id)}"${included ? ' checked' : ''}${usable ? '' : ' disabled'}>
              </label>
              <div class="study-traj-main">
                <div class="study-traj-title">${escapeHTML(t.title || t.goal || t.id)}</div>
                <div class="study-traj-meta">${g?.steps?.length || 0} steps ·
                  ${g?.answer ? 'answer ✓' : 'no answer'} ·
                  ${ng ? 'both arms' : 'grounded only'} ·
                  ${t.updated_at ? new Date(t.updated_at).toLocaleString() : ''}</div>
                <div class="study-traj-tags">
                  <span class="study-traj-tag${t.condition ? ' study-traj-tag-' + escapeAttr(t.condition) : ' study-traj-tag-none'}"
                    >${escapeHTML(guideConditionLabel(t.condition))}</span>
                  <span class="study-traj-tag${gtProblem ? ' study-traj-tag-warn' : ' study-traj-tag-ok'}"
                    title="${escapeAttr(gtProblem || 'Ground truth recorded')}"
                    >${gtProblem ? '⚠ ground truth' : '✓ ground truth'}</span>
                  ${onV2 && v2Index?.ok ? _guideV2ChipHtml(_guideV2RowFor(v2Index, t), t) : ''}
                </div>
              </div>
              <button class="study-evidence-annotate" data-traj-open="${escapeAttr(t.id)}">Edit</button>
              <button class="study-truth-item-btn" data-traj-delete="${escapeAttr(t.id)}" title="Delete this trajectory">✕</button>
            </div>`;
          }) : (rows.length ? '<div class="study-truth-empty">No trajectory in this condition yet.</div>' : '')}
        </div>
      </div>`);
    $('study-close').onclick = closeStudyPanel;

    overlay.querySelectorAll('[data-traj-filter]').forEach(btn => {
      btn.onclick = () => { _guideTrajFilter = btn.dataset.trajFilter; renderGuideTrajectoryList(); };
    });

    // Inclusion is saved on the spot rather than on some later Save: the checkbox IS the decision,
    // and a list of pending toggles that could be lost by closing the panel would be a worse
    // version of the same feature. Written with downscale:false — the screenshots are already
    // downscaled in the bank, and re-encoding every one of them to flip a boolean is pure cost.
    const setInStudy = async (id, value) => {
      const record = await getGuideTrajectory(id);
      if (!record) return;
      record.in_study = !!value;
      await saveGuideTrajectory(record, { downscale: false });
    };

    // ── Publish to the study website ──
    // The site reads study_guide_trajectories; nothing else puts rows there. Upserts by id, so
    // re-publishing an edited trajectory replaces it rather than duplicating it.
    const listNote = (msg, tone = '') => {
      const n = $('study-traj-list-note');
      if (!n) return;
      n.textContent = msg || '';
      n.className = `study-llm-answers-note${tone ? ' study-note-' + tone : ''}`;
    };

    // The V1/V2 switch. Re-renders rather than toggling classes, because the two sources show
    // different buttons and different chips — half-updating that is how a V1 publish gets pressed
    // on a screen that says V2.
    overlay.querySelectorAll('[data-traj-source]').forEach(btn => {
      btn.onclick = () => { _guideTrajSource = btn.dataset.trajSource; renderGuideTrajectoryList(); };
    });

    const v2Refresh = $('study-traj-v2-refresh');
    if (v2Refresh) v2Refresh.onclick = async () => {
      v2Refresh.disabled = true;
      listNote('Re-reading V2…');
      await _loadGuideV2Index({ force: true });
      renderGuideTrajectoryList();
    };

    // ── Publish to V2 ──
    // Straight to the password-gated RPC, not through the loopback helper: V2's save function is
    // SECURITY DEFINER and granted to anon, so the anon key plus a typed password is enough and no
    // secret key or terminal is involved. See guide_v2_publish.js.
    const publishV2Btn = $('study-traj-publish-v2');
    if (publishV2Btn) publishV2Btn.onclick = async () => {
      if (typeof publishGuideV2 !== 'function') {
        listNote('guide_v2_publish.js did not load.', 'bad');
        return;
      }
      publishV2Btn.disabled = true;
      listNote(`Publishing the ${plan.length} ticked trajector${plan.length === 1 ? 'y' : 'ies'} to V2`
        + ` — ${nUpdate} update, ${nCreate} new…`);
      try {
        // The whole bank, in queue order — planGuideV2Publish keeps only the ticked ones and works
        // out, for each, whether it lands on an existing row or a new one. Queue order comes from
        // the full bank rather than the ticked subset, so ticking one more later does not renumber
        // everything a participant walks.
        const res = await publishGuideV2(queue, { v2Rows: v2Index?.ok ? v2Index.rows : null });
        if (!res.ok) { listNote(res.error, 'bad'); return; }
        const failed = res.rows.filter(r => !r.ok).length;
        const drafts = res.rows.filter(r => r.ok && !r.in_study).length;
        const live = res.rows.filter(r => r.ok && r.in_study).length;
        listNote(`${live} live · ${drafts} draft · ${failed} failed`
          + `\n${describeGuideV2Publish(res.rows)}`, failed ? 'bad' : 'ok');
        // The chips are now wrong by definition, so re-read before they are looked at again.
        await _loadGuideV2Index({ force: true });
        const note = $('study-traj-list-note');
        const held = note ? { text: note.textContent, cls: note.className } : null;
        await renderGuideTrajectoryList();
        // renderGuideTrajectoryList rebuilds the note element, and the report is the one thing on
        // this screen that cannot be recovered by looking again.
        const fresh = $('study-traj-list-note');
        if (fresh && held) { fresh.textContent = held.text; fresh.className = held.cls; }
      } catch (e) {
        listNote(`Could not publish to V2: ${e?.message || e}`, 'bad');
      } finally {
        publishV2Btn.disabled = false;
      }
    };

    const publishBtn = $('study-traj-publish');
    if (publishBtn) publishBtn.onclick = async () => {
      publishBtn.disabled = true;
      listNote('Building the bundle…');
      try {
        await _publishStimuliVia(rows, listNote, 'guide');
      } catch (e) {
        listNote(`Could not publish: ${e?.message || e}`, 'bad');
      } finally {
        publishBtn.disabled = false;
      }
    };

    const exportBtn = $('study-traj-export');
    if (exportBtn) exportBtn.onclick = async () => {
      exportBtn.disabled = true;
      listNote('Building the bundle…');
      try {
        const bundle = await _buildStimulusBundle(rows, 'guide');
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'study_stimuli.json';
        a.click();
        URL.revokeObjectURL(a.href);
        listNote(`Exported ${_describeStimulusBundle(bundle)}. `
          + 'Upload with: node scripts/publish.mjs ~/Downloads/study_stimuli.json', 'ok');
      } catch (e) {
        listNote(`Could not build the bundle: ${e?.message || e}`, 'bad');
      } finally {
        exportBtn.disabled = false;
      }
    };

    overlay.querySelectorAll('[data-traj-in]').forEach(box => {
      box.onchange = async () => {
        await setInStudy(box.dataset.trajIn, box.checked);
        renderGuideTrajectoryList();
      };
    });

    // Bulk over WHAT IS ON SCREEN, so the filter doubles as the selector: filter to GUIDE × TEXT,
    // press Exclude all, and you have held back that whole half without touching the other.
    overlay.querySelectorAll('[data-traj-bulk]').forEach(btn => {
      btn.onclick = async () => {
        const value = btn.dataset.trajBulk === 'in';
        for (const t of shown) await setInStudy(t.id, value);
        renderGuideTrajectoryList();
      };
    });
    overlay.querySelectorAll('[data-traj-open]').forEach(btn => {
      btn.onclick = () => renderGuideTrajectoryEditor(btn.dataset.trajOpen);
    });
    overlay.querySelectorAll('[data-traj-delete]').forEach(btn => {
      btn.onclick = async () => {
        await deleteGuideTrajectory(btn.dataset.trajDelete);
        renderGuideTrajectoryList();
      };
    });
  }

  async function renderGuideTrajectoryEditor(id) {
    const record = await getGuideTrajectory(id);
    if (!record) { renderGuideTrajectoryList(); return; }
    // Edited in memory and written on Save, so an abandoned edit changes nothing.
    const draft = JSON.parse(JSON.stringify(record));
    if (!draft.arms.grounding) draft.arms.grounding = _stripGuideArm({});
    let arm = 'grounding';

    const armData = () => draft.arms[arm] || (draft.arms[arm] = _stripGuideArm(draft.arms.grounding));

    /** The two bookend states. Editable in both arms, because both arms show them. */
    const stateRow = (key, caption) => {
      const st = armData()[key] || {};
      return `
        <div class="study-traj-ev">
          <div class="study-traj-step-head">
            <span class="study-traj-step-n">${escapeHTML(caption)}</span>
            ${st.screenshot ? `<button class="study-truth-item-btn" data-state-del="${key}" title="Remove this screenshot">🗑</button>` : ''}
          </div>
          <div class="study-traj-shot">
            ${st.screenshot
              ? `<img src="data:image/jpeg;base64,${st.screenshot}" alt="${escapeAttr(caption)}">`
              : '<div class="study-traj-shot-empty">No screenshot — this run was captured before before/after states were kept, so re-capture it.</div>'}
            <button class="study-evidence-clear" data-state-shot="${key}">⬆ Replace</button>
          </div>
        </div>`;
    };

    const stepRows = () => armData().steps.map((step, i) => `
      <div class="study-traj-step" data-i="${i}">
        <div class="study-traj-step-head">
          <span class="study-traj-step-n">Step ${step.n}</span>
          <span class="study-traj-step-tools">
            <button class="study-truth-item-btn" data-step-up="${i}" title="Move up">↑</button>
            <button class="study-truth-item-btn" data-step-down="${i}" title="Move down">↓</button>
            <button class="study-truth-item-btn" data-step-del="${i}" title="Delete this step">🗑</button>
          </span>
        </div>
        <textarea class="study-field" data-step-text="${i}" rows="2" placeholder="What the agent did">${escapeHTML(step.instruction || '')}</textarea>
        ${arm === 'grounding' ? `
          <div class="study-traj-shot">
            ${step.screenshot
              ? `<img src="data:image/jpeg;base64,${step.screenshot}" alt="step ${step.n}">`
              : '<div class="study-traj-shot-empty">No screenshot</div>'}
            <button class="study-evidence-clear" data-step-shot="${i}">⬆ Replace</button>
          </div>` : ''}
        <button class="study-evidence-clear study-traj-insert" data-step-insert="${i}">+ insert step here</button>
      </div>`).join('');

    const evidenceRows = () => (armData().answer_evidence || []).map((ev, i) => `
      <div class="study-traj-ev" data-i="${i}">
        <div class="study-traj-step-head">
          <span class="study-traj-step-n">${escapeHTML(ev.key || `evidence ${i + 1}`)}${ev.step != null ? ` · step ${escapeHTML(String(ev.step))}` : ''}</span>
          <button class="study-truth-item-btn" data-ev-del="${i}" title="Remove this evidence">🗑</button>
        </div>
        <textarea class="study-field" data-ev-note="${i}" rows="2" placeholder="What this shows">${escapeHTML(ev.note || '')}</textarea>
        <div class="study-traj-shot">
          ${ev.screenshot
            ? `<img src="data:image/jpeg;base64,${ev.screenshot}" alt="${escapeAttr(ev.key || 'evidence')}">`
            : '<div class="study-traj-shot-empty">No image</div>'}
          <button class="study-evidence-clear" data-ev-shot="${i}">⬆ Replace</button>
        </div>
      </div>`).join('');

    const milestoneRows = () => (armData().trail?.milestones || []).map((m, i) => `
      <div class="study-traj-ms" data-i="${i}">
        <input class="study-field study-field-tiny" data-ms-step="${i}" value="${escapeAttr(String(m.step ?? ''))}" placeholder="step">
        <textarea class="study-field" data-ms-text="${i}" rows="2" placeholder="What the agent did at this step">${escapeHTML(m.text || '')}</textarea>
        <input class="study-field study-field-small" data-ms-label="${i}" value="${escapeAttr(m.errorLabel || '')}" placeholder="error label (optional)">
        <button class="study-truth-item-btn" data-ms-del="${i}" title="Remove this milestone">🗑</button>
      </div>`).join('');

    /**
     * THE GROUND TRUTH BLOCK: the researcher's own answers, in the participant's vocabulary.
     *
     * Deliberately the same controls the participant gets — the same success/failure choice, the
     * same three error types, the same per-error step buttons. Anything else (a free-text "step 3,
     * loop") would have to be translated by hand at analysis time, which is where the comparison
     * this whole study rests on would quietly go wrong.
     */
    const groundTruthBlock = () => {
      const gt = draft.ground_truth || (draft.ground_truth = _buildGuideGroundTruth(null));
      const stepCount = (draft.arms.grounding?.steps || []).length;
      const problem = _guideGroundTruthProblem(gt);
      const errorRows = gt.errors.map((e, i) => `
        <div class="study-truth-err" data-gt-i="${i}">
          <div class="study-truth-err-head">
            <select class="study-field study-field-small" data-gt-type="${i}">
              ${GUIDE_ERROR_TYPES.map(t => `
                <option value="${escapeAttr(t.id)}"${t.id === e.type ? ' selected' : ''}>${escapeHTML(t.label)}</option>`).join('')}
            </select>
            <button class="study-truth-item-btn" data-gt-del="${i}" title="Remove this error">🗑</button>
          </div>
          <div class="study-truth-steps">
            ${stepCount
              ? Array.from({ length: stepCount }, (_, n) => n + 1).map(n => `
                  <button class="study-step-chip${e.steps.includes(n) ? ' study-step-chip-on' : ''}"
                    data-gt-step="${i}" data-gt-n="${n}">${n}</button>`).join('')
              : '<span class="study-traj-sub">This trajectory has no steps yet.</span>'}
          </div>
        </div>`).join('');

      return `
        <div class="study-truth-title" style="margin-top:14px;">Ground truth
          <span class="study-traj-sub">the correct answers — what a participant is scored against</span></div>
        ${problem ? `<div class="study-truth-warn">⚠ ${escapeHTML(problem)}</div>` : ''}

        <label class="study-evidence-label">Did the agent complete the task?</label>
        <div class="study-radio-group" id="study-gt-correct">
          ${[['success', 'Yes — it completed the task'], ['failure', 'No — it did not']].map(([id, label]) => `
            <label class="study-radio-btn"><input type="radio" name="study-gt-correct" value="${id}"${gt.correctness === id ? ' checked' : ''}><span>${escapeHTML(label)}</span></label>`).join('')}
        </div>

        <label class="study-evidence-label">What was the problem?</label>
        <div class="study-radio-group" id="study-gt-problems">
          ${GUIDE_PROBLEM_TYPES.map(t => {
            const [name, ...rest] = String(t.label).split('—');
            const detail = rest.join('—').trim();
            return `
            <label class="study-radio-btn study-error-opt">
              <input type="checkbox" name="study-gt-problem-type" value="${escapeAttr(t.id)}"${gt.problems.includes(t.id) ? ' checked' : ''}>
              <span class="study-error-body">
                <span class="study-error-name">${escapeHTML(name.trim())}</span>
                ${detail ? `<span class="study-error-detail">${escapeHTML(detail)}</span>` : ''}
              </span>
            </label>`;
          }).join('')}
        </div>
        <label class="study-evidence-label study-optional">Anything to add? <span class="study-traj-sub">optional — not scored</span></label>
        <textarea class="study-field" id="study-gt-problem" rows="2"
          placeholder="e.g. It gave the phone number instead of the email address">${escapeHTML(gt.problem || '')}</textarea>

        <label class="study-evidence-label">Which errors, and at which steps?</label>
        <div id="study-gt-errors">${errorRows
          || '<div class="study-truth-empty">No error recorded yet — add one, or tick “No error” below.</div>'}</div>
        <button class="study-evidence-annotate" id="study-gt-add"${gt.no_error ? ' disabled' : ''}>+ add an error</button>
        <!-- The same affirmative answer the participant gives. Without it, an empty error list
             means either "there were none" or "not filled in yet", and those two score alike. -->
        <label class="study-radio-btn study-error-none">
          <input type="checkbox" id="study-gt-no-error"${gt.no_error ? ' checked' : ''}>
          <span>No error — the agent did this correctly</span>
        </label>`;
    };

    const render = () => {
      const a = armData();
      setHTML(`
        <div class="study-screen">
          <div class="study-header">
            <span class="study-title">🧭 ${escapeHTML(draft.title || draft.id)}</span>
            <button class="study-close-btn" id="study-close">✕</button>
          </div>
          <div class="study-progress">
            <button class="study-evidence-clear" id="study-traj-back">← All trajectories</button>
            <span class="study-answer-arm-switch" id="study-traj-arms">
              ${Object.keys(GUIDE_ARM_LABELS).map(name => `
                <button class="study-arm-btn${name === arm ? ' study-arm-btn-active' : ''}" data-traj-arm="${name}">
                  ${GUIDE_ARM_LABELS[name]} <span class="study-arm-badge">${draft.arms[name] ? '•' : '–'}</span>
                </button>`).join('')}
            </span>
          </div>
          <div class="study-body">
            <label class="study-evidence-label">Task shown to the participant</label>
            <textarea class="study-field" id="study-traj-goal" rows="2" placeholder="The task the agent was given">${escapeHTML(draft.goal || '')}</textarea>

            <label class="study-evidence-label">Condition
              <span class="study-traj-sub">which half of the design this trajectory belongs to</span></label>
            <div class="study-radio-group" id="study-traj-condition">
              ${GUIDE_CONDITIONS.map(c => `
                <label class="study-radio-btn"><input type="radio" name="study-traj-cond" value="${escapeAttr(c.id)}"${draft.condition === c.id ? ' checked' : ''}><span>${escapeHTML(c.label)}</span></label>`).join('')}
            </div>

            <div class="study-truth-title" style="margin-top:10px;">Before and after
              <span class="study-traj-sub">shown in both arms — the outcome is not the manipulation</span></div>
            ${stateRow('initial_state', 'Before the agent started')}
            ${stateRow('final_state', 'After the agent finished')}

            <div class="study-truth-title" style="margin-top:10px;">Steps</div>
            <div id="study-traj-steps">${stepRows()}</div>
            <button class="study-evidence-annotate" id="study-traj-append">+ add a step at the end</button>

            <div class="study-traj-title-row">The agent's answer</div>
            <textarea class="study-field" id="study-traj-answer" rows="4" placeholder="What the agent said when it finished">${escapeHTML(a.answer || '')}</textarea>

            ${arm === 'grounding' ? `
              <div class="study-traj-title-row">Answer evidence
                <span class="study-traj-sub">what the answer rests on</span></div>
              <div id="study-traj-evidence">${evidenceRows() || '<div class="study-truth-empty">No evidence saved with this answer — add one to give the grounded arm something to check against.</div>'}</div>
              <button class="study-evidence-annotate" id="study-traj-ev-add">+ add evidence</button>` : ''}

            <div class="study-traj-title-row">Reasoning trail</div>
            <textarea class="study-field" id="study-traj-trail" rows="3" placeholder="The agent's summary of what it did">${escapeHTML(a.trail?.summary || '')}</textarea>
            <div id="study-traj-milestones">${milestoneRows()}</div>
            <button class="study-evidence-annotate" id="study-traj-ms-add">+ add a milestone</button>

            <div class="study-traj-title-row">Questions</div>
            <label class="study-evidence-label">1 — correctness</label>
            <textarea class="study-field" id="study-traj-q1" rows="2">${escapeHTML(a.questions?.correctness || '')}</textarea>
            <label class="study-evidence-label">1b — what is the problem</label>
            <textarea class="study-field" id="study-traj-q1b" rows="2">${escapeHTML(a.questions?.problem || '')}</textarea>
            <label class="study-evidence-label">2 — which error, at which steps</label>
            <textarea class="study-field" id="study-traj-q2" rows="2">${escapeHTML(a.questions?.errors || '')}</textarea>

            ${groundTruthBlock()}

            <div class="study-evidence-actions study-truth-save-row">
              <button class="study-evidence-clear" id="study-traj-preview" title="Open this trajectory in a tab, exactly as a participant reads it">👁 Preview as participant</button>
              ${arm === 'grounding'
                ? '<button class="study-evidence-clear" id="study-traj-recapture" title="Re-read this run from the live store, keeping your question wording">↻ Re-capture</button>' +
                  '<button class="study-evidence-clear" id="study-traj-strip">✂️ Strip → Non-grounded</button>' : ''}
              <button class="study-act-btn study-act-primary" id="study-traj-save">💾 Save trajectory</button>
            </div>
            <div class="study-llm-answers-note" id="study-traj-note"></div>
          </div>
        </div>`);
      bind();
    };

    /** Read every field back into the draft before anything re-renders or saves. */
    const collect = () => {
      const a = armData();
      draft.goal = $('study-traj-goal')?.value ?? draft.goal;

      // Condition and ground truth live on the RECORD, not the arm: both arms show the same run, so
      // they are graded against the same truth and belong to the same half of the design.
      const cond = overlay.querySelector('input[name="study-traj-cond"]:checked');
      if (cond) draft.condition = cond.value;
      const gt = draft.ground_truth || (draft.ground_truth = _buildGuideGroundTruth(null));
      const verdict = overlay.querySelector('input[name="study-gt-correct"]:checked');
      if (verdict) gt.correctness = verdict.value;
      gt.problem = $('study-gt-problem')?.value ?? gt.problem;
      if (overlay.querySelector('[name="study-gt-problem-type"]')) {
        gt.problems = [...overlay.querySelectorAll('[name="study-gt-problem-type"]:checked')].map(el => el.value);
      }
      overlay.querySelectorAll('[data-gt-type]').forEach(el => {
        const i = Number(el.dataset.gtType);
        if (gt.errors[i]) gt.errors[i].type = el.value;
      });
      const noErrBox = $('study-gt-no-error');
      if (noErrBox) gt.no_error = noErrBox.checked;
      a.answer = $('study-traj-answer')?.value ?? a.answer;
      a.trail = a.trail || {};
      a.trail.summary = $('study-traj-trail')?.value ?? a.trail.summary;
      a.questions = a.questions || {};
      a.questions.correctness = $('study-traj-q1')?.value ?? a.questions.correctness;
      a.questions.problem = $('study-traj-q1b')?.value ?? a.questions.problem;
      a.questions.errors = $('study-traj-q2')?.value ?? a.questions.errors;
      overlay.querySelectorAll('[data-step-text]').forEach(el => {
        const i = Number(el.dataset.stepText);
        if (a.steps[i]) a.steps[i].instruction = el.value;
      });
      a.answer_evidence = a.answer_evidence || [];
      overlay.querySelectorAll('[data-ev-note]').forEach(el => {
        const i = Number(el.dataset.evNote);
        if (a.answer_evidence[i]) a.answer_evidence[i].note = el.value;
      });
      a.trail.milestones = a.trail.milestones || [];
      overlay.querySelectorAll('[data-ms-text]').forEach(el => {
        const i = Number(el.dataset.msText);
        if (a.trail.milestones[i]) a.trail.milestones[i].text = el.value;
      });
      overlay.querySelectorAll('[data-ms-step]').forEach(el => {
        const i = Number(el.dataset.msStep);
        const n = parseInt(el.value, 10);
        if (a.trail.milestones[i]) a.trail.milestones[i].step = Number.isFinite(n) ? n : null;
      });
      overlay.querySelectorAll('[data-ms-label]').forEach(el => {
        const i = Number(el.dataset.msLabel);
        if (a.trail.milestones[i]) a.trail.milestones[i].errorLabel = el.value;
      });
    };

    /**
     * The editor's one status line.
     *
     * `tone` colours it: 'ok' for something that landed, 'bad' for something that did not, and the
     * default for plain narration. A save used to report itself in the same grey as every other
     * note, which is indistinguishable from the note that was already there — so pressing Save
     * twice, unsure whether the first press registered, was the normal way to use this screen.
     */
    let noteTimer = null;
    const setNote = (msg, tone = '') => {
      const n = $('study-traj-note');
      if (!n) return;
      if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
      n.textContent = msg || '';
      n.className = `study-llm-answers-note${tone ? ' study-note-' + tone : ''}`;
      // Success fades back to nothing; a failure stays until something replaces it, because it is
      // still true and still needs acting on.
      if (tone === 'ok' && msg) {
        noteTimer = setTimeout(() => {
          const el = $('study-traj-note');
          if (el && el.textContent === msg) { el.textContent = ''; el.className = 'study-llm-answers-note'; }
        }, 4000);
      }
    };

    /**
     * Flash the button that was just pressed: a tick, the word, and a colour, for a moment.
     *
     * The note alone is easy to miss — it is small, it sits below the fold on a long trajectory,
     * and the eye is on the button that was just clicked. Confirming AT the button is what makes a
     * save unmistakable without a dialog to dismiss.
     */
    const flashButton = (id, label = '✓ Saved') => {
      const btn = $(id);
      if (!btn) return;
      if (btn.dataset.flashing === '1') return;   // a second press mid-flash must not eat the label
      const original = btn.innerHTML;
      btn.dataset.flashing = '1';
      btn.classList.add('study-btn-saved');
      btn.innerHTML = label;
      setTimeout(() => {
        // The editor re-renders on almost any interaction; a button that has gone from under us
        // has nothing to restore, and writing to it would resurrect a stale label.
        if (!btn.isConnected) return;
        btn.innerHTML = original;
        btn.classList.remove('study-btn-saved');
        delete btn.dataset.flashing;
      }, 1600);
    };

    /** Ask for an image file and hand back bare base64 — the form every other study image is in. */
    const pickImageInto = (apply) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          collect();
          apply(String(reader.result || '').replace(/^data:[^,]+,/, ''));
          render();
        };
        reader.readAsDataURL(file);
      };
      input.click();
    };

    function bind() {
      $('study-close').onclick = closeStudyPanel;
      $('study-traj-back').onclick = () => { collect(); renderGuideTrajectoryList(); };

      overlay.querySelectorAll('[data-traj-arm]').forEach(btn => {
        btn.onclick = () => { collect(); arm = btn.dataset.trajArm; render(); };
      });

      overlay.querySelectorAll('[data-step-up]').forEach(btn => {
        btn.onclick = () => { collect(); const i = Number(btn.dataset.stepUp); armData().steps = _moveGuideStep(armData().steps, i, i - 1); render(); };
      });
      overlay.querySelectorAll('[data-step-down]').forEach(btn => {
        btn.onclick = () => { collect(); const i = Number(btn.dataset.stepDown); armData().steps = _moveGuideStep(armData().steps, i, i + 1); render(); };
      });
      overlay.querySelectorAll('[data-step-del]').forEach(btn => {
        btn.onclick = () => {
          collect();
          const a = armData();
          a.steps.splice(Number(btn.dataset.stepDel), 1);
          a.steps = _renumberGuideSteps(a.steps);
          render();
        };
      });
      overlay.querySelectorAll('[data-step-insert]').forEach(btn => {
        btn.onclick = () => {
          collect();
          const a = armData();
          a.steps.splice(Number(btn.dataset.stepInsert) + 1, 0, { instruction: '', action: '', target_text: '', url: '', screenshot: null });
          a.steps = _renumberGuideSteps(a.steps);
          render();
        };
      });
      const append = $('study-traj-append');
      if (append) append.onclick = () => {
        collect();
        const a = armData();
        a.steps.push({ instruction: '', action: '', target_text: '', url: '', screenshot: null });
        a.steps = _renumberGuideSteps(a.steps);
        render();
      };

      overlay.querySelectorAll('[data-step-shot]').forEach(btn => {
        btn.onclick = () => pickImageInto(shot => {
          const i = Number(btn.dataset.stepShot);
          armData().steps[i].screenshot = shot;
          setNote(`Replaced the screenshot for step ${i + 1} — remember to save.`, 'warn');
        });
      });

      overlay.querySelectorAll('[data-state-shot]').forEach(btn => {
        btn.onclick = () => pickImageInto(shot => {
          const key = btn.dataset.stateShot;
          const a = armData();
          a[key] = Object.assign({ url: '' }, a[key] || {}, { screenshot: shot });
          setNote('Replaced the state screenshot — remember to save.', 'warn');
        });
      });
      overlay.querySelectorAll('[data-state-del]').forEach(btn => {
        btn.onclick = () => {
          collect();
          const a = armData();
          a[btn.dataset.stateDel] = Object.assign({ url: '' }, a[btn.dataset.stateDel] || {}, { screenshot: null });
          render();
        };
      });

      overlay.querySelectorAll('[data-ev-del]').forEach(btn => {
        btn.onclick = () => { collect(); armData().answer_evidence.splice(Number(btn.dataset.evDel), 1); render(); };
      });
      const evAdd = $('study-traj-ev-add');
      if (evAdd) evAdd.onclick = () => {
        collect();
        const a = armData();
        a.answer_evidence = a.answer_evidence || [];
        a.answer_evidence.push({ key: `evidence_${a.answer_evidence.length + 1}`, note: '', step: null, cited: true, screenshot: null });
        render();
      };
      overlay.querySelectorAll('[data-ev-shot]').forEach(btn => {
        btn.onclick = () => pickImageInto(shot => {
          const i = Number(btn.dataset.evShot);
          armData().answer_evidence[i].screenshot = shot;
          setNote('Replaced the evidence image — remember to save.', 'warn');
        });
      });

      overlay.querySelectorAll('[data-ms-del]').forEach(btn => {
        btn.onclick = () => { collect(); armData().trail.milestones.splice(Number(btn.dataset.msDel), 1); render(); };
      });
      const msAdd = $('study-traj-ms-add');
      if (msAdd) msAdd.onclick = () => {
        collect();
        const a = armData();
        a.trail.milestones = a.trail.milestones || [];
        a.trail.milestones.push({ step: null, text: '', status: '', errorLabel: '' });
        render();
      };

      // A trajectory banked before the projection understood something — the finish answer, its
      // evidence — is stale. Re-reading the run fixes it without throwing away the wording, which is
      // the part that took work.
      const recapture = $('study-traj-recapture');
      if (recapture) recapture.onclick = async () => {
        collect();
        const stepsBefore = draft.arms.grounding.steps.length;
        if (typeof readTrajectoryFromSession !== 'function') { setNote('Re-capture is not available in this panel.', 'bad'); return; }
        const fresh = await readTrajectoryFromSession(draft.source_session_id || draft.id);
        if (!fresh) {
          setNote('That run is no longer in the live store — it has been evicted, or the chat was cleared.', 'bad');
          return;
        }
        const keptQuestions = Object.assign({}, draft.arms.grounding.questions);
        draft.arms.grounding = Object.assign(fresh.arms.grounding, { questions: keptQuestions });
        draft.goal = draft.goal || fresh.goal;

        // The bookends DO cross to the non-grounded arm, unlike everything else re-capture reads.
        // They are the one part both arms show, so leaving a hand-edited non-grounded arm without
        // them would make the arms differ in the outcome they reveal — silently, and in the one
        // place nobody thinks to look after pressing a button labelled "re-capture".
        _syncGuideBookends(draft);

        arm = 'grounding';
        render();
        const ev = draft.arms.grounding.answer_evidence.length;
        const states = [draft.arms.grounding.initial_state?.screenshot && 'before', draft.arms.grounding.final_state?.screenshot && 'after'].filter(Boolean);
        // Ground truth and condition are top-level, so re-capture leaves them alone — but a
        // re-read that changes the step count silently re-points every step number in the ground
        // truth at a different step. Say so rather than let it pass.
        const gtSteps = (draft.ground_truth?.errors || []).some(e => e.steps?.length);
        const stepsChanged = draft.arms.grounding.steps.length !== stepsBefore;
        setNote(`Re-read the run: ${draft.arms.grounding.steps.length} step(s), ${ev} piece(s) of evidence, ` +
          `${states.length ? states.join(' + ') + ' state' : 'no before/after state — this run predates them'}. ` +
          'Your question wording was kept; the non-grounded arm keeps its own text, but now shares the before/after shots.' +
          (stepsChanged && gtSteps
            ? ` ⚠ The step count changed (was ${stepsBefore}) — check the ground truth's step numbers still point at the right steps.`
            : ''),
          stepsChanged && gtSteps ? 'warn' : 'ok');
      };

      // The steps at a size where a wrong one can actually be spotted — which is the whole job when
      // writing ground truth, and impossible in a 400px column. This is the SAME page the
      // participant reads (study/trajectory_view.html), in its own tab beside the panel, so what
      // the researcher judges is exactly what the participant will judge.
      //
      // Saves first: the page renders the BANKED record, so previewing an unsaved edit would show
      // the previous version and quietly contradict the form next to it.
      const preview = $('study-traj-preview');
      if (preview) preview.onclick = async () => {
        collect();
        const res = await saveGuideTrajectory(draft);
        if (!res.saved) { setNote(`Could not save before previewing: ${res.error || 'unknown error'}`, 'bad'); return; }
        const url = chrome.runtime.getURL(
          `study/trajectory_view.html?id=${encodeURIComponent(draft.id)}&arm=${encodeURIComponent(arm)}`);
        try {
          await chrome.tabs.create({ url, active: true });
          flashButton('study-traj-preview', '✓ Saved');
          setNote('Saved, and opened in a tab as the participant sees it.', 'ok');
        } catch (e) {
          setNote(`Saved, but the preview tab could not be opened: ${e?.message || e}`, 'bad');
        }
      };

      // Ground truth: add / remove an error, and toggle the steps it happened at. Each toggle goes
      // through collect() first so a half-typed problem statement is not lost to the re-render.
      const gtAdd = $('study-gt-add');
      if (gtAdd) gtAdd.onclick = () => {
        collect();
        // Adding an error answers Q2 the other way, so the "none" tick goes with it — the same
        // exclusivity the participant's checkboxes enforce.
        draft.ground_truth.no_error = false;
        draft.ground_truth.errors.push({ type: GUIDE_ERROR_TYPES[0].id, steps: [] });
        render();
      };

      const noError = $('study-gt-no-error');
      if (noError) noError.onchange = () => {
        collect();
        if (noError.checked) draft.ground_truth.errors = [];
        draft.ground_truth.no_error = noError.checked;
        render();
      };
      overlay.querySelectorAll('[data-gt-del]').forEach(btn => {
        btn.onclick = () => {
          collect();
          draft.ground_truth.errors.splice(Number(btn.dataset.gtDel), 1);
          render();
        };
      });
      overlay.querySelectorAll('[data-gt-step]').forEach(btn => {
        btn.onclick = () => {
          collect();
          const err = draft.ground_truth.errors[Number(btn.dataset.gtStep)];
          if (!err) return;
          const n = Number(btn.dataset.gtN);
          err.steps = err.steps.includes(n) ? err.steps.filter(s => s !== n) : [...err.steps, n].sort((x, y) => x - y);
          render();
        };
      });
      // A verdict of "success" makes the error list meaningless, and vice versa — re-render so the
      // warning line tracks the choice instead of going stale until the next save.
      overlay.querySelectorAll('input[name="study-gt-correct"]').forEach(el => {
        el.onchange = () => { collect(); render(); };
      });

      const strip = $('study-traj-strip');
      if (strip) strip.onclick = () => {
        collect();
        draft.arms.nongrounding = _stripGuideArm(draft.arms.grounding);
        arm = 'nongrounding';
        render();
        setNote('Derived from the grounded arm with the screenshots removed — edit it, then save.', 'warn');
      };

      $('study-traj-save').onclick = async () => {
        collect();
        const btn = $('study-traj-save');
        if (btn) btn.disabled = true;   // downscaling a dozen screenshots is not instant
        const res = await saveGuideTrajectory(draft);
        if (btn) btn.disabled = false;
        if (res.saved) {
          flashButton('study-traj-save');
          // Says what was saved, not just that something was: the count and the timestamp are how
          // a researcher working through a bank of these tells one save from the last.
          const gt = _guideGroundTruthProblem(draft.ground_truth);
          setNote(`Saved ${draft.arms.grounding.steps.length} step(s) at ${new Date().toLocaleTimeString()}.` +
            (gt ? ` Ground truth still incomplete — ${gt}` : ' Ground truth complete.'), 'ok');
        } else {
          setNote(`Could not save: ${res.error || 'unknown error'}`, 'bad');
        }
      };
    }

    render();
  }

  // ── Screens ──

  function renderWelcome() {
    const recording = _studyRecording();
    // The arm is chosen once, at the start, and every question then shows that ONE recorded answer.
    // Offering both per question would let a participant read the answer twice over.
    // Debug only: a real run is the whole study in order. This is for looking at one half without
    // walking the other one first.
    const halfPicker = (recording || !window.__pgDebugEnabled) ? '' : `
          <p class="study-question-text" style="margin-top:12px;">Which tasks? <span class="study-traj-sub">debug only</span></p>
          <div class="study-radio-group" id="study-half-group">
            <label class="study-radio-btn"><input type="radio" name="study-half" value="all" checked><span>Everything — find questions, then guide trajectories</span></label>
            <label class="study-radio-btn"><input type="radio" name="study-half" value="find"><span>🔍 Find tasks only</span></label>
            <label class="study-radio-btn"><input type="radio" name="study-half" value="guide"><span>📘 Guide trajectories only</span></label>
          </div>`;

    // NOT a picker any more. Which group a participant is in, and which cell each of their
    // questions carries, is dealt from their assignment slot — see _assignFindSession. Leaving it
    // as a choice let the person running the session pick, and a counterbalance that someone
    // chooses is not a counterbalance. Shown, not chosen, so the researcher can still see it.
    const armPicker = recording ? '' : `
          <p class="study-question-text" style="margin-top:12px;">Assignment</p>
          <p class="study-traj-sub" id="study-assignment-note">Group and answer order are dealt automatically when the study starts, alternating between Find &times; Text and Find &times; Visual.</p>`;

    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">${recording ? '🎬 Record User Study' : '🎓 PageGuide User Study'}</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-body">
          <p class="study-intro">${recording
            ? `Walk all <strong>${s.queue.length} tasks</strong>, recording each question's four answers — correct and incorrect, grounded and bare — and its ground truth.`
            : 'For each question you\'ll see a page and an answer an AI agent gave. Your job is to decide whether that answer is <strong>correct</strong>, and then point at what on the page told you.'}</p>
          <label class="study-question-text" for="study-pid-input" style="margin-top:8px;">Participant ID (optional)</label>
          <input type="text" class="study-input" id="study-pid-input" placeholder="e.g. P07">
          ${armPicker}
          ${halfPicker}
          <button class="study-btn study-btn-primary" id="study-start-btn" style="margin-top:16px;">${recording ? 'Start Recording →' : 'Start Study →'}</button>
        </div>
      </div>
    `);
    $('study-close').onclick = closeStudyPanel;
    $('study-start-btn').onclick = async () => {
      const btn = $('study-start-btn');
      btn.disabled = true;
      btn.textContent = 'Starting…';
      if (!s.queue.length) s.queue = await loadTasks();
      if (!s.queue.length) {
        setHTML(`<div class="study-screen"><div class="study-body"><p class="study-error">Could not load user_study_data/tasks.json. Please reload the extension and try again.</p></div></div>`);
        return;
      }
      s.participantId = ($('study-pid-input')?.value || '').trim() || 'anon';
      s.taskFilter = overlay.querySelector('input[name="study-half"]:checked')?.value || 'all';
      if (s.taskFilter !== 'all') {
        s.queue = s.queue.filter(entry => entry.taskType === s.taskFilter);
        if (!s.queue.length) {
          setHTML(`<div class="study-screen"><div class="study-body"><p class="study-error">No ${escapeHTML(s.taskFilter)} tasks are ready to run.</p></div></div>`);
          return;
        }
      }
      // Participants are dealt; a recording pass walks the whole bank as authored.
      if (!recording) {
        const dealt = await _dealStudyQueue();
        if (!dealt.ok) {
          setHTML(`<div class="study-screen"><div class="study-body"><p class="study-error">${escapeHTML(dealt.error)}</p></div></div>`);
          return;
        }
      }
      s.idx = 0;
      s.results = [];
      await startSession(s.participantId);
      renderTaskSetup();
    };
  }

  /**
   * Researcher-only row for looking at what has already been banked for a task, per arm. Shown on
   * the setup screen (before the run) and again on the Answer screen (beside the live answer, to
   * compare what each arm will read). Debug mode only — a participant never sees it.
   *
   * Only one study screen is on the DOM at a time, so the ids are safe to reuse across both.
   */
  function studySavedAnswersRowHtml() {
    if (!_studyRecording()) return '';
    return `
      <div class="study-saved-answers" id="study-saved-answers">
        <span class="study-saved-answers-label">Saved answer</span>
        <button class="study-saved-answers-btn" id="study-saved-grounded">Grounded</button>
        <button class="study-saved-answers-btn" id="study-saved-nongrounded">Non-grounded</button>
        <span class="study-saved-answers-note" id="study-saved-answers-note"></span>
      </div>`;
  }

  function bindStudySavedAnswerPreview(task) {
    const row = $('study-saved-answers');
    if (!row) return;
    const note = $('study-saved-answers-note');
    const show = async (kind) => {
      // getStudyResponse falls back to the pre-collapse grounding-visual / grounding-text slots.
      const record = await getStudyResponse(task.id, kind === 'nongrounding' ? 'nongrounding' : 'grounding');
      if (!record) {
        if (note) note.textContent = `No saved ${kind === 'nongrounding' ? 'non-grounded' : 'grounded'} answer for ${task.id} yet.`;
        return;
      }
      if (note) note.textContent = '';
      if (typeof openStudyResponsePreview === 'function') {
        openStudyResponsePreview(record, kind === 'nongrounding' ? 'Non-grounded' : 'Grounded');
      }
    };
    $('study-saved-grounded').onclick = () => show('grounded');
    $('study-saved-nongrounded').onclick = () => show('nongrounding');
  }

  // ── Capture size presets ──────────────────────────────────────────────────────
  //
  // A page has to be small enough to be WRITTEN, not just captured: two of the ten Find items
  // failed to publish with Postgres's statement timeout (57014) while every other page went up at
  // 3–5 MB. Shrinking the defaults for all ten would be the wrong trade — a Find question can turn
  // on a detail inside an engraving — so the smaller budgets are offered PER CAPTURE, and only the
  // page that will not fit gives anything up.
  //
  // Values are requests, not commands: the content script clamps them (see _pgCaptureLimits) and
  // reports back what it actually used.
  const STUDY_CAPTURE_PRESETS = [
    { id: 'full',    label: 'Full quality',  hint: '1600px · 0.82 — the default' },
    { id: 'smaller', label: 'Smaller',       hint: '1200px · 0.70 — about half the bytes',
      options: { imgMaxWidth: 1200, imgQuality: 0.7 } },
    { id: 'small',   label: 'Smallest',      hint: '900px · 0.60 — for a page that will not publish',
      options: { imgMaxWidth: 900, imgQuality: 0.6 } },
  ];

  /** The capture options for a preset id. Pure. An unknown id means the defaults. */
  function _studyCapturePresetOptions(id) {
    return STUDY_CAPTURE_PRESETS.find(p => p.id === id)?.options || null;
  }

  // ── Editing a Find question in place ──────────────────────────────────────────
  //
  // V1 wrote the question and its four options together, so a question could lean on the options
  // ("...which of the following?") and be perfectly clear. V2 shows no options — the participant
  // judges the agent's answer — which leaves those questions dangling mid-sentence, and leaves the
  // stored `answer` as the only statement of what is correct. Both now have to be fixable against
  // the live page, in the same sitting as the recording, so the researcher is not editing
  // tasks.json in a different window and reloading the extension between every wording change.
  //
  // Recorder only. A participant editing the question would be editing the stimulus.

  /** The shipped task, straight from tasks.json — the baseline an edit is diffed against. */
  async function _shippedFindTask(taskId) {
    try {
      const data = await fetch(chrome.runtime.getURL('user_study_data/tasks.json')).then(r => r.json());
      return (data?.find || []).find(t => String(t?.id) === String(taskId)) || null;
    } catch (e) {
      console.warn('[Study] could not read tasks.json to diff an edit:', e);
      return null;
    }
  }

  function renderStudyTaskEditor(task) {
    const answer = String(task?.answer == null ? '' : task.answer);
    return `
      <div class="study-task-edit" id="study-task-edit">
        <div class="study-task-edit-answer">
          <span class="study-task-edit-label">Correct answer</span>
          <span class="study-task-edit-value">${answer ? escapeHTML(answer) : '<em>not set</em>'}</span>
        </div>
        <div class="study-evidence-actions">
          <button type="button" class="study-evidence-clear" id="study-edit-question" title="Reword this question. Saved here, not in tasks.json.">✏️ Edit question</button>
          <button type="button" class="study-evidence-clear" id="study-edit-answer" title="Change what counts as the correct answer">✏️ Edit answer</button>
          <button type="button" class="study-evidence-clear" id="study-edit-reset"${
            Array.isArray(task?.edited_fields) && task.edited_fields.length ? '' : ' hidden'
          } title="Drop the edits and go back to the wording in tasks.json">↩ Reset to file</button>
        </div>
        <div class="study-llm-answers-note" id="study-task-edit-note"></div>
      </div>`;
  }

  function bindStudyTaskEditor(task) {
    const section = $('study-task-edit');
    if (!section || !task?.id) return;
    const note = (msg, tone = '') => {
      const n = $('study-task-edit-note');
      if (!n) return;
      n.textContent = msg || '';
      n.className = `study-llm-answers-note${tone ? ' study-note-' + tone : ''}`;
    };

    /**
     * Write one field. Both current values go in every time, diffed against the shipped task, so
     * editing the answer cannot drop an earlier question edit — and an edit typed back to the
     * shipped wording clears itself rather than pinning the old text (see _buildStudyTaskEdit).
     */
    const apply = async (field, value) => {
      const shipped = await _shippedFindTask(task.id);
      if (!shipped) { note('Could not read tasks.json — nothing saved.', 'bad'); return; }
      const next = { question: task.question, answer: task.answer, [field]: value };
      const record = _buildStudyTaskEdit(shipped, next);
      const res = await saveStudyTaskEdit(task.id, record);
      if (!res?.saved) { note(`Could not save: ${res?.error || 'unknown error'}`, 'bad'); return; }
      // Re-render off the merged task so the screen shows exactly what a participant would get.
      s.queue[s.idx].task = _applyStudyTaskEdit(shipped, record);
      renderTaskSetup();
      const n = $('study-task-edit-note');
      if (n) {
        n.textContent = record ? `Saved — ${field} is edited here, not in tasks.json.` : 'Back to the wording in tasks.json.';
        n.className = 'study-llm-answers-note';
      }
    };

    $('study-edit-question')?.addEventListener('click', async () => {
      const next = await openStudyAnswerEditor(String(task.question || ''), {
        title: 'Edit the question',
        hint: 'The participant sees this wording and no options, so it has to stand on its own — '
          + 'a question ending "…which of the following?" has nothing to point at.'
      });
      if (next == null) return;
      const text = String(next).replace(/\s+/g, ' ').trim();
      if (!text) { note('A question cannot be blank — nothing saved.', 'bad'); return; }
      await apply('question', text);
    });

    $('study-edit-answer')?.addEventListener('click', async () => {
      const next = await openStudyAnswerEditor(String(task.answer || ''), {
        title: 'Edit the correct answer',
        hint: 'What the participant\'s Yes/No verdict is judged against, and what the wrong-answer '
          + 'variants are authored away from.'
      });
      if (next == null) return;
      const text = String(next).replace(/\s+/g, ' ').trim();
      if (!text) { note('An answer cannot be blank — nothing saved.', 'bad'); return; }
      await apply('answer', text);
    });

    $('study-edit-reset')?.addEventListener('click', async () => {
      const shipped = await _shippedFindTask(task.id);
      if (!shipped) { note('Could not read tasks.json — nothing changed.', 'bad'); return; }
      await saveStudyTaskEdit(task.id, null);
      s.queue[s.idx].task = shipped;
      renderTaskSetup();
    });
  }

  function renderTaskSetup() {
    showTargetsOnPage([]); // nothing pinned by the ground-truth panel outlives its screen
    const entry = s.queue[s.idx];
    const { taskType, task } = entry;
    const taskQuestion = taskType === 'find' ? task.question : task.task;
    const taskUrl = task.url;
    // Let the panel's Edit dialog record straight to this task without a picker.
    window.__pgStudyCurrentTask = { id: task.id, url: taskUrl || '', question: taskQuestion || '' };
    s.lastNotesElapsed = 0;

    const savedAnswersRow = studySavedAnswersRowHtml();

    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">${STUDY_TASK_LABELS[taskType]}</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-progress">Task ${s.idx + 1}/${s.queue.length} · ${STUDY_TASK_LABELS[taskType]}${studyTaskNavHtml()}</div>
        <div class="study-body">
          <div class="study-task-card">
            <div class="study-task-type-badge">${STUDY_TASK_LABELS[taskType]}${
              _studyRecording() && Array.isArray(task.edited_fields) && task.edited_fields.length
                ? ` <span class="study-task-edited-badge" title="Edited here, not in tasks.json: ${escapeAttr(task.edited_fields.join(', '))}">✏️ edited</span>`
                : ''}</div>
            <p class="study-task-desc">${_studyRecording()
              ? escapeHTML(taskQuestion || STUDY_TASK_DESCRIPTIONS[taskType])
              : STUDY_TASK_DESCRIPTIONS[taskType]}</p>
          </div>
          ${_studyRecording() && taskType === 'find' ? renderStudyTaskEditor(task) : ''}
          ${savedAnswersRow}
          ${_studyRecording() ? `
            <!-- The SAME action as the Guide recorder's button, not a Find-only one: the stimuli are
                 one study and go up together. It lives here too because a researcher working
                 through the Find half had no way to know that, and an unreachable action is an
                 action nobody runs. -->
            <div class="study-traj-bulk" style="justify-content:flex-end;">
              <button class="study-evidence-clear" id="study-capture-page" title="Freeze this task's page so the study website can show it — the live page cannot be framed or scripted">📄 Capture page</button>
              <!-- Per capture, not a setting: only the page that cannot be written should lose
                   pixels. See STUDY_CAPTURE_PRESETS. -->
              <select class="study-capture-preset" id="study-capture-preset" title="How hard to shrink this page's images. Lower it only for a page that fails to publish.">
                ${STUDY_CAPTURE_PRESETS.map(p =>
                  `<option value="${p.id}">${escapeHTML(p.label)} — ${escapeHTML(p.hint)}</option>`).join('')}
              </select>
              <!-- One task, for CHECKING. A ten-page bundle is a slow and miserable way to find out
                   that the anchors did not land, and it re-uploads nine pages that were already
                   right. Same rows, same keys, same upsert — just this task's — so what it proves
                   about one page holds for the full publish. -->
              <!-- What a participant will actually see, drawn on the real page from the BANKED
                   record — not from a fresh ask, which would make a different answer and a new
                   index and so show something other than what the study shows. Because it resolves
                   through the same locators the site uses, a highlight that lands wrong here lands
                   wrong there: this is the check, not a preview. -->
              <button class="study-evidence-clear" id="study-show-grounding" title="Draw the saved grounded answer's highlights and evidence marks on this page, exactly as the study site will">👁 Show grounding</button>
              <button class="study-evidence-clear" id="study-publish-find-one" title="Publish ONLY this task — its question, recorded answers, ground truth and captured page. For checking one page before sending the lot.">⬆ Publish this find</button>
              <button class="study-evidence-clear" id="study-publish-find" title="Publish the FIND questions, recorded answers, ground truth and captured pages via the local publish helper">⬆ Publish find</button>
              <!-- V2 goes straight to Supabase rather than through the loopback helper: its save
                   function is SECURITY DEFINER and granted to anon, gated on an admin password, so
                   no secret key is needed in the browser. See study_v2_publish.js. -->
              <button class="study-evidence-clear" id="study-publish-v2-one" title="Upsert ONLY this task into the V2 four-variant claims table, with all four authored answers, the ground truth and the captured page">⬆ V2 this find</button>
              <button class="study-evidence-clear" id="study-publish-v2" title="Upsert every FIND task into the V2 four-variant claims table. Items missing a cell go up as drafts (in_study = false) and are named in the report.">⬆ V2 all find</button>
            </div>
            <div class="study-llm-answers-note" id="study-find-publish-note"></div>` : ''}
          ${_studyRecording() ? `
            <!-- TWO BUTTONS WHILE RECORDING, one while participating.
                 A researcher needs the page open WITHOUT starting the ask: 📄 Capture page reads
                 the tab, and the combined button used to reset the chat and move the panel to the
                 running screen in the same click — so there was no moment at which the page was
                 open and the recorder was still on this screen. A participant gets one button,
                 because a choice here is a way to do the task wrong. -->
            <div class="study-open-row">
              <button class="study-btn" id="study-open-only-btn">🌐 Open page</button>
              <button class="study-btn study-btn-primary" id="study-open-btn">💬 Ask PageGuide</button>
            </div>`
            : `<button class="study-btn study-btn-primary" id="study-open-btn">${
              taskType === 'guide' && task?.trajectory_id
                ? 'Review what the agent did →'
                : `Open ${escapeHTML(task.name || 'Page')} &amp; Read the Answer`}</button>`}
        </div>
      </div>
    `);
    $('study-close').onclick = closeStudyPanel;
    bindStudyTaskNav();
    bindStudySavedAnswerPreview(task);
    if (_studyRecording() && taskType === 'find') bindStudyTaskEditor(task);

    // Freeze the page this task is about. Runs in the content script, on the tab the participant
    // would be looking at, so what is captured is the page as it actually rendered.
    const capturePage = $('study-capture-page');
    if (capturePage) capturePage.onclick = async () => {
      const note = (msg, tone = '') => {
        const n = $('study-find-publish-note');
        if (!n) return;
        n.textContent = msg || '';
        n.className = `study-llm-answers-note${tone ? ' study-note-' + tone : ''}`;
      };
      capturePage.disabled = true;
      note('Capturing the page — inlining styles and images…');

      // Inlining is a fetch and often a re-encode per image, so a big article genuinely takes a
      // while. Without a running count that wait is indistinguishable from a hang — which is how it
      // was read, and reasonably so. Torn down in `finally`, so it cannot outlive the capture.
      const onProgress = (msg) => {
        if (msg?.action !== 'captureProgress') return;
        note(`Capturing the page — image ${msg.done} of ${msg.total}…`);
      };
      chrome.runtime.onMessage.addListener(onProgress);

      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) { note('No active tab to capture.', 'bad'); return; }
        const preset = $('study-capture-preset')?.value || 'full';
        const snapshot = await chrome.tabs.sendMessage(tab.id, {
          action: 'capturePageSnapshot',
          options: _studyCapturePresetOptions(preset)
        });
        if (!snapshot || snapshot.error) {
          note(`Could not capture: ${snapshot?.error || 'the page did not respond'}. `
            + 'Open the task page first, and reload it if PageGuide was installed after it loaded.', 'bad');
          return;
        }
        if (snapshot.truncated) {
          note(`That page came to ${_fmtSnapshotSize(snapshot.bytes)}, over the limit — nothing was `
            + 'saved. It is almost always one huge image or video.', 'bad');
          return;
        }
        // The same press resolves this task's RECORDED ANSWERS against the page in front of it.
        // Capturing is the one moment both halves are available at once — the live index that gives
        // `[N:"…"]` its meaning, and the snapshot the site will show — so binding them here means a
        // researcher never has to get an order of operations right, and answers banked long ago get
        // their anchors backfilled by re-capturing rather than by being recorded again.
        const anchored = await _anchorRecordedAnswers(task.id, tab.id);

        const sharedWith = await _pageSharedWith(task.id, snapshot.url);
        const res = await saveStudyPage(task.id, snapshot);
        if (!res.saved) { note(`Captured, but could not store it: ${res.error}`, 'bad'); return; }
        // The size used is named whenever it is not the default, so a page that was shrunk cannot
        // quietly stay shrunk through later re-captures without anyone noticing.
        const shrunk = snapshot.limits && snapshot.limits.imgMaxWidth < 1600
          ? ` at ${snapshot.limits.imgMaxWidth}px/${snapshot.limits.imgQuality}`
          : '';
        note(`Captured ${_fmtSnapshotSize(snapshot.bytes)}${shrunk} from ${snapshot.url} — `
          + `${anchored.summary}. `
          + (sharedWith
            ? `${sharedWith} already has this same page — only one copy is published, and both tasks read it.`
            : 'Publish find to send it to the website.'), 'ok');
      } catch (e) {
        note(`Could not capture: ${e?.message || e}. Make sure the task page is the active tab.`, 'bad');
      } finally {
        chrome.runtime.onMessage.removeListener(onProgress);
        capturePage.disabled = false;
      }
    };

    const findPublish = $('study-publish-find');
    if (findPublish) findPublish.onclick = async () => {
      const note = (msg, tone = '') => {
        const n = $('study-find-publish-note');
        if (!n) return;
        n.textContent = msg || '';
        n.className = `study-llm-answers-note${tone ? ' study-note-' + tone : ''}`;
      };
      findPublish.disabled = true;
      note('Building the bundle…');
      try {
        await _publishStimuliVia([], note, 'find');
      } catch (e) {
        note(`Could not publish: ${e?.message || e}`, 'bad');
      } finally {
        findPublish.disabled = false;
      }
    };
    // Replay the banked grounding onto the live page.
    //
    // Reads the RECORD, never the live result: the researcher is checking what a participant gets,
    // and a fresh ask would answer a different question — literally, since the model may word it
    // differently and the page would be re-indexed underneath it.
    const showGrounding = $('study-show-grounding');
    if (showGrounding) showGrounding.onclick = async () => {
      const note = (msg, tone = '') => {
        const n = $('study-find-publish-note');
        if (!n) return;
        n.textContent = msg || '';
        n.className = `study-llm-answers-note${tone ? ' study-note-' + tone : ''}`;
      };
      showGrounding.disabled = true;
      try {
        const record = await getStudyResponse(task.id, 'grounding');
        if (!record) { note(`No grounded answer is banked for ${task.id} yet.`, 'bad'); return; }
        const anchors = Array.isArray(record.citation_anchors) ? record.citation_anchors : [];
        const answer = record.answer_raw || record.answer_display || '';
        if (!anchors.length && !/\[\d+:"/.test(answer)) {
          note(`The grounded answer for ${task.id} has no citations in it, so there is nothing to `
            + 'place on the page.', 'bad');
          return;
        }
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) { note('No active tab to draw on.', 'bad'); return; }

        // The tab must BE the page this answer is about. `[69:"…"]` is element 69 in one page's
        // index, and every page has an element 69 — so resolving against the wrong tab does not
        // fail, it returns a real element from the wrong article and banks it as fact. SVSF-V1's
        // anchors were written this way with the Public Domain Review page open, and pointed at a
        // paragraph that is not in the Aeon article at all.
        const pageUrl = record.url || task.url || '';
        if (pageUrl && tab.url && !_sameStudyPage(tab.url, pageUrl)) {
          note(`That tab is ${_shortUrl(tab.url)}, but this answer was recorded on `
            + `${_shortUrl(pageUrl)}. Open the right page first — resolving against the wrong one `
            + 'produces anchors that look fine and point at the wrong article.', 'bad');
          return;
        }

        // The answer goes with the anchors: when the record has none — every answer banked before
        // anchoring existed — the page derives them from its own live index. Refusing instead made
        // this button useless exactly when it mattered, since the only other way to get locators was
        // to capture, so the check could not run before the thing it was meant to check.
        const res = await chrome.tabs.sendMessage(tab.id,
          { action: 'showSavedGrounding', anchors, answer });
        if (!res || res.error) { note(`Could not draw: ${res?.error || 'no response'}`, 'bad'); return; }
        if (!res.shown && !res.misses?.length) {
          note('Nothing could be placed. The answer run\'s page index is gone, so there is nothing '
            + 'to resolve against — press 💬 Ask PageGuide on this tab first.', 'bad');
          return;
        }

        // Derived locators are BANKED here only when every citation resolved. A partial set is useful
        // to inspect, but saving it reads as if the grounding is complete while one marker still has
        // no place to land.
        const hasMisses = !!(res.misses && res.misses.length);
        let savedDerived = false;
        if (res.derived && !hasMisses && Array.isArray(res.anchors) && res.anchors.length) {
          record.citation_anchors = res.anchors;
          await saveStudyResponse(record, { downscale: false });
          savedDerived = true;
        }

        // The visual evidence goes up with it: the marks are the other half of what the grounded
        // arm sees, and showing only the text highlights would check only half the stimulus.
        let drawn = 0;
        // ONE marks OBJECT per evidence item — `marks` is {annotations, region_bbox, geometry, …}
        // (gv2BuildFindEvidence), not a list. Flattening it as though it were an array yielded
        // nothing at all, so this drew no evidence and looked like the marks were missing.
        const marks = (Array.isArray(record.evidence) ? record.evidence : [])
          .map(item => item?.marks).filter(Boolean);
        if (marks.length) {
          const ev = await chrome.tabs.sendMessage(tab.id, { action: 'showStudyEvidenceMarks', marks });
          drawn = Number(ev?.drawn) || 0;
        }

        // Misses are NAMED, not counted. "2 could not be placed" sends a researcher hunting; the
        // quotes say which ones, and a quote that cannot be placed here will be misplaced on the site.
        const miss = (res.misses || []).map(m => `[${m.index}] "${String(m.quote).slice(0, 40)}"`);
        const placed = _describeStudyCitationAnchors(res.anchors || []);
        const placedLabel = savedDerived ? 'Saved anchors' : 'Placed anchors';
        // Counted against what was actually RESOLVED, not against the record's stored list — that
        // list is empty on the derive path, and "Drew 9/0" is worse than no number at all.
        const total = res.shown + (res.misses?.length || 0);
        note(`Drew ${res.shown}/${total} citation highlight${total === 1 ? '' : 's'}`
          + `${marks.length ? ` and ${drawn} evidence mark${drawn === 1 ? '' : 's'}` : ''}`
          + (savedDerived ? ' (anchors resolved and saved just now)'
            : (res.derived && hasMisses ? ' (not saved because some citations could not be placed)' : ''))
          + (placed ? `. ${placedLabel}: ${placed}` : '')
          + (miss.length ? `. Could not place: ${miss.join(', ')}` : '. This is what the site will show.'),
          miss.length ? 'bad' : 'ok');
      } catch (e) {
        note(`Could not draw: ${e?.message || e}. Open the task page first.`, 'bad');
      } finally {
        showGrounding.disabled = false;
      }
    };

    // Same publisher, narrowed to this task. Deliberately NOT a separate path: a check that ran
    // different code from the real publish would prove nothing about the real publish.
    const findPublishOne = $('study-publish-find-one');
    if (findPublishOne) findPublishOne.onclick = async () => {
      const note = (msg, tone = '') => {
        const n = $('study-find-publish-note');
        if (!n) return;
        n.textContent = msg || '';
        n.className = `study-llm-answers-note${tone ? ' study-note-' + tone : ''}`;
      };
      findPublishOne.disabled = true;
      note(`Building the bundle for ${task.id}…`);
      try {
        await _publishStimuliVia([], note, 'find', task.id);
      } catch (e) {
        note(`Could not publish: ${e?.message || e}`, 'bad');
      } finally {
        findPublishOne.disabled = false;
      }
    };

    // ── Publishing into the V2 four-variant schema ──
    //
    // Separate from _publishStimuliVia, and it has to be: that one writes the V1 tables through the
    // loopback helper, while V2 is a different project with a different shape (four authored
    // answers in one jsonb, one row per item) and a different privilege model. Routing them through
    // one function would mean a change for one silently altering the other.
    const _v2Note = (msg, tone = '') => {
      const n = $('study-find-publish-note');
      if (!n) return;
      n.textContent = msg || '';
      n.className = `study-llm-answers-note${tone ? ' study-note-' + tone : ''}`;
    };

    async function _runV2Publish(button, onlyTaskId) {
      if (typeof publishFindV2 !== 'function') {
        _v2Note('study_v2_publish.js did not load.', 'bad');
        return;
      }
      button.disabled = true;
      _v2Note(onlyTaskId ? `Publishing ${onlyTaskId} to V2…` : 'Publishing every find task to V2…');
      try {
        // tasks.json is the authoring format and stays the single list — reading it here rather
        // than keeping a second copy is the same rule _buildStimulusBundle follows.
        const data = await fetch(chrome.runtime.getURL('user_study_data/tasks.json')).then(r => r.json());
        const res = await publishFindV2(data?.find || [], onlyTaskId);
        if (!res.ok) { _v2Note(res.error, 'bad'); return; }
        const failed = res.rows.filter(r => !r.ok).length;
        const drafts = res.rows.filter(r => r.ok && !r.in_study).length;
        const live = res.rows.filter(r => r.ok && r.in_study).length;
        _v2Note(`${live} live · ${drafts} draft · ${failed} failed\n${describeFindV2Publish(res.rows)}`,
          failed ? 'bad' : 'ok');
      } catch (e) {
        _v2Note(`Could not publish to V2: ${e?.message || e}`, 'bad');
      } finally {
        button.disabled = false;
      }
    }

    const v2PublishOne = $('study-publish-v2-one');
    if (v2PublishOne) v2PublishOne.onclick = () => _runV2Publish(v2PublishOne, task.id);

    const v2PublishAll = $('study-publish-v2');
    if (v2PublishAll) v2PublishAll.onclick = () => _runV2Publish(v2PublishAll, null);

    const openOnly = $('study-open-only-btn');
    if (openOnly) openOnly.onclick = async () => {
      const note = (msg, tone = '') => {
        const n = $('study-find-publish-note');
        if (!n) return;
        n.textContent = msg || '';
        n.className = `study-llm-answers-note${tone ? ' study-note-' + tone : ''}`;
      };
      openOnly.disabled = true;
      try {
        await openTaskPage(taskUrl);
        // Deliberately does NOT reset the chat or leave this screen: the point is to have the page
        // open while the recorder stays here, so 📄 Capture page can read it.
        note('Page opened. Capture it, or press Ask PageGuide when you are ready to record.', 'ok');
      } catch (e) {
        note(`Could not open the page: ${e?.message || e}`, 'bad');
      } finally {
        openOnly.disabled = false;
      }
    };

    $('study-open-btn').onclick = async () => {
      // A guide trajectory is the stimulus itself: nothing to open, nothing to run.
      if (!_studyRecording() && taskType === 'guide' && task?.trajectory_id) {
        startBehaviorTracking();
        renderGuideTrajectoryTask(task);
        return;
      }
      if (typeof resetChat === 'function') resetChat(false);
      openTaskPage(taskUrl);

      // The countdown exists to start a participant's timed run fairly. A recording pass is not
      // timed and is re-entered constantly, so counting to three every time is just three seconds.
      if (_studyRecording()) {
        startBehaviorTracking();
        renderTaskRunning(taskType, taskQuestion, task);
        return;
      }

      setHTML(`
        <div class="study-screen">
          <div class="study-header"><span class="study-title">${STUDY_TASK_LABELS[taskType]}</span></div>
          <div class="study-progress">Task ${s.idx + 1}/${s.queue.length} · ${STUDY_TASK_LABELS[taskType]}</div>
          <div class="study-body" style="align-items:center;text-align:center;justify-content:center;gap:16px;">
            <p style="color:#aaa;font-size:14px;margin:0;">Loading the page… timer starts in</p>
            <span class="study-timer" id="study-timer" style="font-size:52px;font-weight:700;">3</span>
          </div>
        </div>
      `);

      let countdown = 3;
      const cdInterval = setInterval(() => {
        countdown--;
        const el = $('study-timer');
        if (el) el.textContent = countdown > 0 ? String(countdown) : 'Go!';
        if (countdown <= 0) {
          clearInterval(cdInterval);
          startBehaviorTracking();
          if (_studyRecording()) {
            startTimer();
            renderTaskRunning(taskType, taskQuestion, task);
          } else {
            // A participant does not run the task: the answer was recorded once so everyone reads
            // the same one. Straight to the question, with that arm's answer above it.
            renderTaskPlayback(taskType, task);
          }
        }
      }, 1000);
    };
  }

  /**
   * Jump straight to any question. Recording only.
   *
   * A recording pass is not a run: the researcher re-visits questions out of order — to redo an
   * answer, to fill in a missing arm, to fix ground truth — and walking the list from the top to
   * reach question 9 is the difference between a usable tool and a tedious one. A participant's run
   * stays strictly sequential, which is why this is gated on the mode.
   */
  function studyTaskNavHtml() {
    if (!_studyRecording() || s.queue.length < 2) return '';
    const options = s.queue.map((entry, i) =>
      `<option value="${i}"${i === s.idx ? ' selected' : ''}>${i + 1}. ${escapeHTML(entry.task?.id || `Task ${i + 1}`)}</option>`).join('');
    return `
      <span class="study-task-nav" id="study-task-nav">
        <button type="button" class="study-task-nav-btn" data-task-nav="prev" title="Previous question"${s.idx === 0 ? ' disabled' : ''}>◀</button>
        <select class="study-task-nav-select" data-task-nav="pick" title="Jump to a question">${options}</select>
        <button type="button" class="study-task-nav-btn" data-task-nav="next" title="Next question"${s.idx >= s.queue.length - 1 ? ' disabled' : ''}>▶</button>
      </span>`;
  }

  /**
   * @param {Function} [cleanup] - run before leaving the current screen (stop timers, cancel a pick)
   */
  function bindStudyTaskNav(cleanup) {
    const nav = $('study-task-nav');
    if (!nav) return;
    const go = (idx) => {
      const next = Math.max(0, Math.min(s.queue.length - 1, idx));
      if (next === s.idx && nav.querySelector('[data-task-nav="pick"]')?.value === String(s.idx)) return;
      if (typeof cleanup === 'function') cleanup();
      _studyCancelPendingPick();
      s.idx = next;
      renderTaskSetup();
    };
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.study-task-nav-btn');
      if (!btn || btn.disabled) return;
      go(btn.dataset.taskNav === 'prev' ? s.idx - 1 : s.idx + 1);
    });
    nav.querySelector('[data-task-nav="pick"]')?.addEventListener('change', (e) => go(Number(e.target.value)));
  }

  /** Authoring affordances — arm tabs, Save/Edit, ground truth, Next — belong to the recorder. */
  function _studyRecording() { return s.mode === 'record' || s.mode === 'record-guide'; }

  /** The guide-trajectory editor is its own mode: it edits banked runs, it does not run tasks. */
  function _studyRecordingGuide() { return s.mode === 'record-guide'; }

  /**
   * Whether this run may skip a task without answering it.
   *
   * Always true for the recorder, who is walking the list rather than taking it. Also true for a
   * participant run in Debug Mode, so the researcher can step through the study as a participant
   * sees it without answering twenty questions to reach the last one. Never for a real participant:
   * a skipped task records nothing, and a run full of holes is worse than a short one.
   */
  function _studyCanSkip() { return _studyRecording() || !!window.__pgDebugEnabled; }

  function studySkipButtonHtml() {
    if (!_studyCanSkip()) return '';
    return '<button class="study-btn study-btn-secondary study-btn-skip" id="study-next-btn" title="Debug: move to the next task without answering it">Next ⏭</button>';
  }

  /** @param {Function} [cleanup] - stop this screen's timers before leaving it */
  function bindStudySkipButton(cleanup) {
    const btn = $('study-next-btn');
    if (!btn) return;
    btn.onclick = () => {
      if (typeof cleanup === 'function') cleanup();
      _studyCancelPendingPick();
      showTargetsOnPage([]);
      s.guideScreenshot = null;
      s.currentNotes = '';
      s.llmAnswersSnapshot = null;
      s.idx++;
      if (s.idx < s.queue.length) renderTaskSetup();
      else renderStudyComplete();
    };
  }

  const STUDY_MINI_Q_HEIGHT_KEY = 'pageguide_study_mini_q_height';

  /**
   * The task question sits above the chat for the whole run, so its default height is a compromise:
   * long enough to read a two-line question at a glance, short enough to leave the chat usable. It
   * is resizable (CSS `resize`) because the questions vary from one line to six, and the chosen
   * height is remembered — re-dragging it on every task would be its own annoyance.
   */
  function bindStudyMiniQuestionSize() {
    const q = $('study-mini-q');
    if (!q) return;
    if (s.miniQHeight) q.style.height = `${s.miniQHeight}px`;
    else {
      chrome.storage.local.get(STUDY_MINI_Q_HEIGHT_KEY).then(r => {
        const h = Number(r?.[STUDY_MINI_Q_HEIGHT_KEY]);
        if (Number.isFinite(h) && h > 0) { s.miniQHeight = h; q.style.height = `${h}px`; }
      }).catch(() => {});
    }
    if (typeof ResizeObserver !== 'function') return;
    let saveTimer = null;
    new ResizeObserver(() => {
      const h = Math.round(q.getBoundingClientRect().height);
      if (!h || h === s.miniQHeight) return;
      s.miniQHeight = h;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        chrome.storage.local.set({ [STUDY_MINI_Q_HEIGHT_KEY]: h }).catch(() => {});
      }, 400);
    }).observe(q);
  }

  const TASK_PREFIX = { find: '/find', guide: '/guide' };

  function renderTaskRunning(taskType, taskQuestion, task) {
    showTargetsOnPage([]); // nothing pinned by the ground-truth panel outlives its screen
    overlay.style.display = 'none';
    const prefix = TASK_PREFIX[taskType] || '';

    miniBar.innerHTML = `
      <div class="study-mini-top">
        <span class="study-mini-label">Task ${s.idx + 1}/${s.queue.length} · ${STUDY_TASK_LABELS[taskType]}</span>
        <span class="study-mini-timer" id="study-mini-timer">${_formatStudyTime(STUDY_TASK_TIME_LIMIT_MS)}</span>
      </div>
      <div class="study-mini-bottom">
        <span class="study-mini-q" id="study-mini-q" title="Drag the bottom edge to resize">${escapeHTML(taskQuestion)}</span>
        <div class="study-mini-actions">
          <button class="study-mini-copy-btn" id="study-mini-copy" title="Copy task to clipboard">Copy</button>
          <button class="study-mini-done-btn" id="study-mini-done">✅ Done</button>
        </div>
      </div>
      ${taskType === 'find' ? `<textarea class="study-mini-notes" id="study-mini-notes" placeholder="📝 Take notes here…" rows="2"></textarea>` : ''}
    `;
    miniBar.style.display = 'flex';
    bindStudyMiniQuestionSize();

    const chatInput = document.getElementById('pageguide-input');
    if (chatInput) {
      chatInput.value = taskQuestion;
      if (prefix) chatInput.dataset.studyPrefix = prefix;
    }

    $('study-mini-copy').onclick = () => {
      const prefixed = prefix ? `${prefix} ${taskQuestion}` : taskQuestion;
      navigator.clipboard.writeText(prefixed).then(() => {
        const btn = $('study-mini-copy');
        if (btn) { btn.textContent = '✅ Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
      });
    };
    $('study-mini-done').onclick = async () => {
      const btn = $('study-mini-done');
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Processing…'; }
      // Second time through (the researcher went back to the chat to re-ask), the timer has already
      // been stopped, so keep the span measured the first time rather than recording zero.
      const measured = stopTimer();
      const notesElapsed = measured || s.lastNotesElapsed || 0;
      s.lastNotesElapsed = notesElapsed;
      const behaviorData = await stopBehaviorTracking();
      s.currentNotes = ($('study-mini-notes') || {}).value || '';
      s.guideScreenshot = taskType === 'guide' ? await captureGuideScreenshot() : null;
      const chatSnapshot = snapshotChat();
      s.llmAnswersSnapshot = snapshotLlmAnswers();
      const paragraphOptions = taskType === 'find' ? await loadStudyParagraphOptions() : null;
      miniBar.style.display = 'none';
      overlay.style.display = 'flex';
      renderTaskAnswer(taskType, task, notesElapsed, behaviorData, chatSnapshot, s.llmAnswersSnapshot, paragraphOptions);
    };
  }

  /**
   * A participant's question: the recorded answer for the chosen arm, then the question itself.
   *
   * No chat phase and no task timer — there is nothing to run, because the answer is the one the
   * researcher banked. Behaviour tracking is already going (it starts with the page), and it stops
   * at submit, so what it measures here is how the participant read the page while answering.
   */
  async function renderTaskPlayback(taskType, task) {
    // The CELL dealt to this question, not the session's arm: with correctness counterbalanced per
    // question, two questions in the same sitting read from different cells. Guide tasks have no
    // cell and fall back to the arm.
    const slot = _studyVariantAt(s.idx) || s.arm;
    const record = task?.id ? await getStudyResponse(task.id, slot) : null;
    if (!record) {
      const label = _armLabel(slot);
      setHTML(`
        <div class="study-screen">
          <div class="study-header"><span class="study-title">${STUDY_TASK_LABELS[taskType]}</span><button class="study-close-btn" id="study-close">✕</button></div>
          <div class="study-progress">Task ${s.idx + 1}/${s.queue.length}</div>
          <div class="study-body">
            <p class="study-error">No ${label.toLowerCase()} answer has been recorded for ${escapeHTML(task?.id || 'this question')}, so it cannot be shown.</p>
            <button class="study-btn study-btn-primary" id="study-skip-btn">Skip this question →</button>
          </div>
        </div>`);
      $('study-close').onclick = closeStudyPanel;
      $('study-skip-btn').onclick = async () => {
        await stopBehaviorTracking();
        s.idx++;
        if (s.idx < s.queue.length) renderTaskSetup();
        else renderStudyComplete();
      };
      return;
    }
    const paragraphOptions = taskType === 'find' ? await loadStudyParagraphOptions() : null;
    renderTaskAnswer(taskType, task, 0, null, snapshotChat(), null, paragraphOptions, record);
  }

  function renderTaskAnswer(taskType, task, notesElapsed, behaviorData, chatSnapshot, llmAnswersSnapshot, paragraphOptions, playbackRecord) {
    const answerStartedAt = Date.now();
    let answerTimerInterval = null;
    // A participant answers in two acts: read the agent's answer and commit to a choice, then find
    // the evidence for it on the page. Showing the supporting questions from the start collapses
    // them into one — the evidence is visible while the choice is still open, so the choice can be
    // made FROM it, and neither half can be timed. The recorder sees everything at once; they are
    // not being measured.
    const twoStage = !_studyRecording() && taskType === 'find';
    let choiceElapsed = null;
    let supportStartedAt = null;
    let supportTimerInterval = null;
    const taskQuestion = taskType === 'find' ? task.question : task.task;
    const questionCard = `<div class="study-task-card study-task-card-running" style="margin-bottom:10px;"><div class="study-task-question">${escapeHTML(taskQuestion)}</div></div>`;
    const llmAnswersHTML = playbackRecord
      ? renderPlaybackAnswer(playbackRecord)
      : renderLlmAnswers(llmAnswersSnapshot);

    let answerHTML = '';
    if (taskType === 'find') {
      const notesBlock = s.currentNotes ? `<div class="study-notes-display"><span class="study-notes-display-label">📝 Your notes</span><p class="study-notes-display-text">${escapeHTML(s.currentNotes)}</p></div>` : '';
      // VERIFY, do not find. The participant has the page and the agent's answer in front of them,
      // and the only question is whether that answer is right — which is a judgement about the
      // answer shown, so it is graded against the cell that was dealt (see _gradeFindVerdict) and
      // never against a fixed property of the question.
      //
      // The multiple-choice list that used to be here asked a different thing entirely: it asked
      // them to produce the answer, which the agent has already done, and it leaked the truth —
      // four options with one right one tells you the agent is wrong the moment its answer is not
      // among them.
      answerHTML = `
        ${notesBlock}
        ${llmAnswersHTML}
        <div class="study-question-card">
          <div class="study-question-head">
            <span class="study-question-badge">Q1</span>
            <p class="study-question-text">Is the agent's answer above correct?</p>
          </div>
          <div class="study-radio-group" id="study-answer-group">
            <label class="study-radio-btn"><input type="radio" name="study-answer" value="yes"><span>✅ Yes — the answer is correct</span></label>
            <label class="study-radio-btn"><input type="radio" name="study-answer" value="no"><span>❌ No — the answer is wrong</span></label>
          </div>
        </div>
        ${renderStudyCitationPicker()}
        <div id="study-support-stage"${twoStage ? ' hidden' : ''}>
          ${renderStudyEvidenceControls(task, paragraphOptions)}
        </div>
        ${renderStudyGroundTruth(task)}`;
    } else {
      answerHTML = `
        ${llmAnswersHTML}
        <p class="study-question-text">Did you complete the task?</p>
        <div class="study-radio-group" id="study-answer-group">
          <label class="study-radio-btn"><input type="radio" name="study-answer" value="completed"><span>✅ Yes, completed successfully</span></label>
          <label class="study-radio-btn"><input type="radio" name="study-answer" value="partial"><span>⚠️ Partially completed</span></label>
          <label class="study-radio-btn"><input type="radio" name="study-answer" value="failed"><span>❌ Could not complete</span></label>
        </div>`;
    }

    setHTML(`
      <div class="study-screen">
        <div class="study-header"><span class="study-title">Answer</span><button class="study-close-btn" id="study-close">✕</button></div>
        <div class="study-progress">Task ${s.idx + 1}/${s.queue.length} · ${STUDY_TASK_LABELS[taskType]}${studyTaskNavHtml()}</div>
        <div class="study-body">
          ${questionCard}
          <!-- One timer at a time — see the guide screen. -->
          <div class="study-answer-timers">
            <div class="study-timer-display study-answer-timer-display" id="study-answer-timer-row"><span class="study-timer-label">🔍 Finding the answer</span><span class="study-timer study-answer-timer" id="study-answer-timer">00:00</span></div>
            <div class="study-timer-display study-answer-timer-display" id="study-support-timer-row" hidden><span class="study-timer-label">🔎 Finding the evidence</span><span class="study-timer study-answer-timer" id="study-support-timer">00:00</span></div>
          </div>
          ${answerHTML}
          <div id="study-answer-error" class="study-error" style="display:none;">Please answer the question above.</div>
          ${_studyRecording() ? '<button class="study-btn study-btn-secondary study-btn-back" id="study-back-btn" title="Recording only: return to the chat to re-ask or refine the answer">← Back to chat</button>' : ''}
          <div class="study-answer-submit-row">
            ${twoStage ? '<button class="study-btn study-btn-primary" id="study-choice-next-btn">Next →</button>' : ''}
            <button class="study-btn study-btn-primary" id="study-submit-btn"${twoStage ? ' hidden' : ''}>Submit →</button>
            ${studySkipButtonHtml()}
          </div>
        </div>
      </div>
    `);
    answerTimerInterval = setInterval(() => {
      const el = $('study-answer-timer');
      if (el) el.textContent = _formatStudyTime(Date.now() - answerStartedAt);
    }, 1000);
    $('study-close').onclick = () => {
      if (answerTimerInterval) clearInterval(answerTimerInterval);
      if (supportTimerInterval) clearInterval(supportTimerInterval);
      _studyCancelPendingPick();
      // Recording: X is "I am done with this answer card", not "close the study". Back to the
      // question screen, where the arrows are — closing outright meant reopening and walking the
      // list again.
      if (_studyRecording()) renderTaskSetup();
      else closeStudyPanel();
    };
    bindStudyTaskNav(() => { if (answerTimerInterval) clearInterval(answerTimerInterval); });
    bindStudyLlmAnswerLinks(llmAnswersSnapshot);
    if (playbackRecord) {
      const list = $('study-llm-answers-list');
      if (list) {
        list.dataset.studyActiveArm = playbackRecord.condition || _studyVariantAt(s.idx) || s.arm || '';
        list._studyPlaybackRecord = playbackRecord;
      }
      // The answer on screen is this record's, so the page shows this record's evidence.
      const marks = (Array.isArray(playbackRecord.evidence) ? playbackRecord.evidence : [])
        .map(item => item?.marks).filter(Boolean);
      if (typeof sendToContentScript === 'function') {
        sendToContentScript({ action: 'showStudyEvidenceMarks', marks }).catch(() => {});
      }
    } else {
      bindStudyAnswerArmSwitch(task, llmAnswersSnapshot);
    }
    bindStudyCitationPicker();
    bindStudyEvidenceControls(paragraphOptions);
    bindStudyGroundTruth(task);
    // Stage 1 → 2. The choice is committed here: the multiple-choice time stops, the supporting
    // questions appear, and their own timer starts.
    const choiceNextBtn = $('study-choice-next-btn');
    if (choiceNextBtn) {
      choiceNextBtn.onclick = () => {
        const sel = overlay.querySelector('input[name="study-answer"]:checked');
        const errorEl = $('study-answer-error');
        if (!sel) {
          errorEl.textContent = 'Please select an answer.';
          errorEl.style.display = '';
          return;
        }
        errorEl.style.display = 'none';
        choiceElapsed = Math.max(0, Date.now() - answerStartedAt);
        supportStartedAt = Date.now();

        const stage = $('study-support-stage');
        if (stage) stage.hidden = false;
        choiceNextBtn.hidden = true;
        const submit = $('study-submit-btn');
        if (submit) submit.hidden = false;

        // The answer timer's span is banked in choiceElapsed; the total is recomputed at submit.
        if (answerTimerInterval) { clearInterval(answerTimerInterval); answerTimerInterval = null; }
        const answerRow = $('study-answer-timer-row');
        if (answerRow) answerRow.hidden = true;
        const row = $('study-support-timer-row');
        if (row) row.hidden = false;
        supportTimerInterval = setInterval(() => {
          const el = $('study-support-timer');
          if (el) el.textContent = _formatStudyTime(Date.now() - supportStartedAt);
        }, 1000);

        stage?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };
    }

    $('study-submit-btn').onclick = async () => {
      const sel = overlay.querySelector('input[name="study-answer"]:checked');
      const errorEl = $('study-answer-error');
      if (!sel) {
        errorEl.textContent = taskType === 'find'
          ? 'Please say whether the answer is correct.'
          : 'Please select an answer.';
        errorEl.style.display = '';
        return;
      }
      const evidence = collectStudyEvidenceResponses(taskType, task, paragraphOptions);
      if (!evidence.valid) {
        errorEl.textContent = 'Please use Annotate to point at the evidence for both questions.';
        errorEl.style.display = '';
        return;
      }
      const answerElapsed = Math.max(0, Date.now() - answerStartedAt);
      if (answerTimerInterval) clearInterval(answerTimerInterval);
      if (supportTimerInterval) clearInterval(supportTimerInterval);
      // One stage means the whole span was the choice; there was no separate evidence phase.
      const answerChoiceMs = choiceElapsed == null ? answerElapsed : choiceElapsed;
      const findSupportingMs = supportStartedAt == null ? null : Math.max(0, Date.now() - supportStartedAt);
      // Playback keeps tracking running until here — there was no Done click to stop it at.
      const behavior = behaviorData || await stopBehaviorTracking();
      renderTaskPost(taskType, task, {
        notesElapsed,
        answerElapsed,
        answerChoiceMs,
        findSupportingMs,
        totalElapsed: notesElapsed + answerElapsed,
        evidenceResponses: evidence.responses,
      }, sel.value, behavior, chatSnapshot);
    };

    // Recording only: an answer worth banking often takes two or three attempts, so the way back to
    // the chat has to exist. The task timer is NOT restarted — a recording pass is not timed, and
    // restarting it would fire the 3-minute auto-Done in the middle of a re-ask. Coming back through
    // Done re-snapshots the chat, so the new answer is the one on the Live tab.
    const backBtn = $('study-back-btn');
    if (backBtn) {
      backBtn.onclick = () => {
        if (answerTimerInterval) clearInterval(answerTimerInterval);
      if (supportTimerInterval) clearInterval(supportTimerInterval);
        _studyCancelPendingPick();
        startBehaviorTracking(); // Done stopped it on the way here; the re-ask is page activity too
        renderTaskRunning(taskType, taskQuestion, task);
      };
    }

    // Nothing is recorded when a task is skipped — a row of blanks in the results is worse than no
    // row at all. Submit is untouched; this is a separate way out. See _studyCanSkip.
    bindStudySkipButton(() => {
      if (answerTimerInterval) clearInterval(answerTimerInterval);
      if (supportTimerInterval) clearInterval(supportTimerInterval);
    });
  }

  /**
   * A participant's guide task: the trajectory the researcher banked, then two questions about it.
   *
   * Nothing is run and no page is opened — a guide trajectory IS the stimulus, and every participant
   * has to see the same one. The arm decides how much of it they see: grounded shows a screenshot per
   * step, non-grounded shows the same steps as text.
   */
  async function renderGuideTrajectoryTask(task) {
    const record = task?.trajectory_id ? await getGuideTrajectory(task.trajectory_id) : null;
    // The requested arm or nothing. Falling back to the grounded arm would hand a non-grounded
    // participant the exact material their condition withholds, silently and unrecorded. Deriving
    // the non-grounded arm from the grounded one is not that fallback — _stripGuideArm is what the
    // arm IS, so a trajectory nobody stripped by hand still runs, and runs as text.
    let arm = record?.arms?.[s.arm] || null;
    if (!arm && s.arm === 'nongrounding' && record?.arms?.grounding) arm = _stripGuideArm(record.arms.grounding);
    if (!arm) {
      setHTML(`
        <div class="study-screen">
          <div class="study-header"><span class="study-title">📘 Review the task</span><button class="study-close-btn" id="study-close">✕</button></div>
          <div class="study-body">
            <p class="study-error">This task has no ${escapeHTML(GUIDE_ARM_LABELS[s.arm] || s.arm)} trajectory recorded, so it cannot be shown.</p>
            <button class="study-btn study-btn-primary" id="study-skip-btn">Skip this task →</button>
          </div>
        </div>`);
      $('study-close').onclick = closeStudyPanel;
      $('study-skip-btn').onclick = async () => {
        await stopBehaviorTracking();
        s.idx++;
        if (s.idx < s.queue.length) renderTaskSetup(); else renderStudyComplete();
      };
      return;
    }

    const startedAt = Date.now();
    let timerInterval = null;
    let choiceElapsed = null;
    let errorsStartedAt = null;
    let errorsTimerInterval = null;
    const q = arm.questions || GUIDE_STUDY_QUESTIONS;

    // NOTHING the participant is asked to JUDGE is rendered here — not the steps, not the answer,
    // not the reasoning trail. All of it lives in the tab beside this panel, laid out like the live
    // run's View Journey card, at a size where the agent's clicks can actually be checked. This
    // panel is the instrument: the task, one timer, and the questions. Carrying a second copy of
    // the material in a 400px column would be the same trajectory twice, once unreadably, and would
    // push the questions down a scroll a participant is least likely to reach.

    setHTML(`
      <div class="study-screen">
        <div class="study-header"><span class="study-title">📘 Review the task</span><button class="study-close-btn" id="study-close">✕</button></div>
        <div class="study-progress">Task ${s.idx + 1}/${s.queue.length} · 📘 Follow a Guide</div>
        <div class="study-body" id="study-guide-body" style="position:relative;">
          <div class="study-task-card study-task-card-running" style="margin-bottom:10px;">
            <div class="study-task-question">${escapeHTML(record.goal || task.title || '')}</div>
          </div>
          <!-- One timer at a time: the participant is doing one thing at a time, and two counters
               racing each other reads as being measured twice. The total is kept in the background
               (answer time = finding the answer + finding the errors) and never shown as a third. -->
          <div class="study-answer-timers">
            <div class="study-timer-display study-answer-timer-display" id="study-answer-timer-row"><span class="study-timer-label">🔍 Finding the answer</span><span class="study-timer study-answer-timer" id="study-answer-timer">00:00</span></div>
            <div class="study-timer-display study-answer-timer-display" id="study-support-timer-row" hidden><span class="study-timer-label">🔎 Finding the errors</span><span class="study-timer study-answer-timer" id="study-support-timer">00:00</span></div>
          </div>


          <div class="study-question-card">
            <div class="study-question-head">
              <span class="study-question-badge">Q1</span>
              <p class="study-question-text">${escapeHTML(q.correctness || GUIDE_STUDY_QUESTIONS.correctness)}</p>
            </div>
            <div class="study-radio-group" id="study-guide-correct">
              <!-- The options answer the question as asked. "Yes, the answer is correct" under
                   "did the agent complete the task?" is a different question again, and a
                   participant reading only the options would answer the wrong one. -->
              <label class="study-radio-btn"><input type="radio" name="guide-correct" value="yes"><span>Yes, it completed the task</span></label>
              <label class="study-radio-btn"><input type="radio" name="guide-correct" value="no"><span>No, it did not</span></label>
            </div>
            <div id="study-guide-problem-wrap" hidden>
              <label class="study-evidence-label" style="margin-top:8px;">${escapeHTML(q.problem || GUIDE_STUDY_QUESTIONS.problem)}</label>
              <!-- A closed list, not a text box. The same options the ground truth is written in,
                   so the two can be compared without a human reading both and deciding whether
                   they meant the same thing. The box below stays for anything the options miss —
                   optional, and never scored. -->
              <div class="study-radio-group" id="study-guide-problems">
                ${GUIDE_PROBLEM_TYPES.map(t => {
                  const [name, ...rest] = String(t.label).split('—');
                  const detail = rest.join('—').trim();
                  return `
                  <label class="study-radio-btn study-error-opt">
                    <input type="checkbox" name="guide-problem" value="${escapeAttr(t.id)}">
                    <span class="study-error-body">
                      <span class="study-error-name">${escapeHTML(name.trim())}</span>
                      ${detail ? `<span class="study-error-detail">${escapeHTML(detail)}</span>` : ''}
                    </span>
                  </label>`;
                }).join('')}
              </div>
              <label class="study-evidence-label study-optional">Anything to add? <span class="study-traj-sub">optional</span></label>
              <textarea class="study-field" id="study-guide-problem" rows="2" placeholder="Only if the options above miss something"></textarea>
            </div>
          </div>

          <div id="study-guide-errors-stage" class="study-question-card" hidden>
            <div class="study-question-head">
              <span class="study-question-badge">Q2</span>
              <p class="study-question-text">${escapeHTML(q.errors || GUIDE_STUDY_QUESTIONS.errors)}</p>
            </div>
            <div class="study-radio-group" id="study-guide-errors">
              ${GUIDE_ERROR_TYPES.map((t, i) => {
                // The labels already carry "name — explanation"; splitting at render keeps the two
                // halves legible without a second copy of the wording in the data.
                const [name, ...rest] = String(t.label).split('—');
                const detail = rest.join('—').trim();
                return `
                <div class="study-error-block">
                  <label class="study-radio-btn study-error-opt">
                    <input type="checkbox" name="guide-error" value="${escapeAttr(t.id)}">
                    <span class="study-error-num">${i + 1}</span>
                    <span class="study-error-body">
                      <span class="study-error-name">${escapeHTML(name.trim())}</span>
                      ${detail ? `<span class="study-error-detail">${escapeHTML(detail)}</span>` : ''}
                    </span>
                  </label>
                  <!-- The steps are BUTTONS, not a text field. A field asks the participant to
                       recall a number and type it in a format nobody specified ("3, 5"? "3 and 5"?
                       "step 3"), then asks us to parse whatever comes back and decide whether "2-3"
                       means two steps or three. The steps are a known, short, closed set: showing
                       them makes the wrong answer unwritable and the right one one click. -->
                  <div class="study-error-steps" data-steps-for="${escapeAttr(t.id)}" hidden>
                    <label class="study-evidence-label">at step(s)</label>
                    <div class="study-step-picks">
                      ${(arm.steps || []).map(step => `
                        <button type="button" class="study-step-pick" data-pick-for="${escapeAttr(t.id)}" data-step="${escapeAttr(String(step.n))}" title="${escapeAttr(step.instruction || '')}">${escapeHTML(String(step.n))}</button>`).join('')}
                    </div>
                  </div>
                </div>`;
              }).join('')}
              <label class="study-radio-btn study-error-none">
                <input type="checkbox" name="guide-error" value="none">
                <span>No error — the agent did this correctly</span>
              </label>
            </div>
          </div>

          <div id="study-answer-error" class="study-error" style="display:none;"></div>
          <div class="study-answer-submit-row">
            <button class="study-btn study-btn-primary" id="study-guide-next-btn">Next →</button>
            <button class="study-btn study-btn-primary" id="study-submit-btn" hidden>Submit →</button>
            ${studySkipButtonHtml()}
          </div>
        </div>
      </div>`);

    // Fill the rest of the screen with the same trajectory at a readable size. Both arms get the
    // page — the non-grounded one simply has no pictures in it — so the arms differ in grounding and
    // not in how much of the screen the task occupies.
    openTaskPage(chrome.runtime.getURL(
      `study/trajectory_view.html?id=${encodeURIComponent(task.trajectory_id)}&arm=${encodeURIComponent(s.arm)}`
    ));

    timerInterval = setInterval(() => {
      const el = $('study-answer-timer');
      if (el) el.textContent = _formatStudyTime(Date.now() - startedAt);
    }, 1000);

    const stopTimers = () => {
      if (timerInterval) clearInterval(timerInterval);
      if (errorsTimerInterval) clearInterval(errorsTimerInterval);
    };

    $('study-close').onclick = () => { stopTimers(); closeStudyPanel(); };
    bindStudySkipButton(stopTimers);

    overlay.querySelectorAll('input[name="guide-correct"]').forEach(input => {
      input.addEventListener('change', () => {
        const wrap = $('study-guide-problem-wrap');
        if (wrap) wrap.hidden = input.value !== 'no';
      });
    });

    // Ticking an error type asks where it happened; "No error" is exclusive of the rest.
    overlay.querySelectorAll('input[name="guide-error"]').forEach(input => {
      input.addEventListener('change', () => {
        if (input.value === 'none' && input.checked) {
          overlay.querySelectorAll('input[name="guide-error"]').forEach(other => {
            if (other !== input) { other.checked = false; }
          });
        } else if (input.checked) {
          const none = overlay.querySelector('input[name="guide-error"][value="none"]');
          if (none) none.checked = false;
        }
        overlay.querySelectorAll('[data-steps-for]').forEach(wrap => {
          const box = overlay.querySelector(`input[name="guide-error"][value="${wrap.dataset.stepsFor}"]`);
          wrap.hidden = !box?.checked;
          // Un-ticking a type clears its steps: leaving them selected would bank steps for an error
          // the participant has just said did not happen.
          if (wrap.hidden) wrap.querySelectorAll('.study-step-pick.is-on').forEach(b => b.classList.remove('is-on'));
        });
      });
    });

    overlay.querySelectorAll('.study-step-pick').forEach(btn => {
      btn.onclick = () => {
        btn.classList.toggle('is-on');
        btn.setAttribute('aria-pressed', btn.classList.contains('is-on') ? 'true' : 'false');
      };
    });

    /** Which steps are ticked for one error type, as numbers, in order. */
    const pickedSteps = (typeId) => Array.from(overlay.querySelectorAll(`.study-step-pick.is-on[data-pick-for="${typeId}"]`))
      .map(b => Number(b.dataset.step))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    $('study-guide-next-btn').onclick = () => {
      const sel = overlay.querySelector('input[name="guide-correct"]:checked');
      const errorEl = $('study-answer-error');
      if (!sel) {
        errorEl.textContent = 'Please say whether the agent completed the task.';
        errorEl.style.display = '';
        return;
      }
      // Q1b is required now that it is a closed list — "it did not complete the task" with no
      // problem named is the same half-answer the step-less error type is, and it is the half the
      // ground truth is compared against. The free-text box beside it stays optional.
      if (sel.value === 'no' && !overlay.querySelector('input[name="guide-problem"]:checked')) {
        errorEl.textContent = 'Please choose what the problem was.';
        errorEl.style.display = '';
        return;
      }
      errorEl.style.display = 'none';
      choiceElapsed = Math.max(0, Date.now() - startedAt);
      errorsStartedAt = Date.now();
      $('study-guide-errors-stage').hidden = false;
      $('study-guide-next-btn').hidden = true;
      $('study-submit-btn').hidden = false;
      // Hand over: the answer timer's span is already banked in choiceElapsed, and the total keeps
      // counting from startedAt regardless of what is on screen.
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      const answerRow = $('study-answer-timer-row');
      if (answerRow) answerRow.hidden = true;
      const row = $('study-support-timer-row');
      if (row) row.hidden = false;
      errorsTimerInterval = setInterval(() => {
        const el = $('study-support-timer');
        if (el) el.textContent = _formatStudyTime(Date.now() - errorsStartedAt);
      }, 1000);
      $('study-guide-errors-stage').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };

    $('study-submit-btn').onclick = async () => {
      const errorEl = $('study-answer-error');
      const checked = Array.from(overlay.querySelectorAll('input[name="guide-error"]:checked'));
      if (!checked.length) {
        errorEl.textContent = 'Please choose an error type, or “No error”.';
        errorEl.style.display = '';
        return;
      }
      const errors = checked
        .filter(box => box.value !== 'none')
        .map(box => ({ type: box.value, steps: pickedSteps(box.value) }));

      // An error type with no step is half an answer: it says something went wrong and withholds
      // where. Cheap to catch now, impossible to reconstruct later.
      const problem = _guideErrorsProblem(errors);
      if (problem) {
        errorEl.textContent = problem;
        errorEl.style.display = '';
        return;
      }
      errorEl.style.display = 'none';

      stopTimers();
      const answerElapsed = Math.max(0, Date.now() - startedAt);
      const behavior = await stopBehaviorTracking();
      const correctSel = overlay.querySelector('input[name="guide-correct"]:checked');
      renderTaskPost('guide', task, {
        notesElapsed: 0,
        answerElapsed,
        answerChoiceMs: choiceElapsed == null ? answerElapsed : choiceElapsed,
        findSupportingMs: errorsStartedAt == null ? null : Math.max(0, Date.now() - errorsStartedAt),
        totalElapsed: answerElapsed,
        evidenceResponses: [],
        guideAnswer: {
          correct: correctSel?.value === 'yes',
          // The scored answer, and the free-text elaboration beside it.
          problems: [...overlay.querySelectorAll('input[name="guide-problem"]:checked')].map(el => el.value),
          problem: $('study-guide-problem')?.value || '',
          errors,
        },
      }, correctSel?.value === 'yes' ? 'correct' : 'incorrect', behavior, snapshotChat());
    };
  }

  function renderTaskPost(taskType, task, timings, answer, behaviorData, chatSnapshot) {
    showTargetsOnPage([]); // nothing pinned by the ground-truth panel outlives its screen
    setHTML(`
      <div class="study-screen">
        <div class="study-header"><span class="study-title">Quick Questions</span><button class="study-close-btn" id="study-close">✕</button></div>
        <div class="study-body">
          <p class="study-question-text">How confident are you in your answer / completion?</p>
          <div class="study-radio-group" id="study-conf-group">
            <label class="study-radio-btn"><input type="radio" name="study-conf" value="very"><span>😎 Very confident</span></label>
            <label class="study-radio-btn"><input type="radio" name="study-conf" value="somewhat"><span>🙂 Somewhat confident</span></label>
            <label class="study-radio-btn"><input type="radio" name="study-conf" value="notsure"><span>😐 Not sure</span></label>
            <label class="study-radio-btn"><input type="radio" name="study-conf" value="guessed"><span>🤷 Just guessing</span></label>
          </div>
          <p class="study-question-text" style="margin-top:16px;">How helpful was PageGuide for this task?</p>
          <div class="study-radio-group" id="study-help-group">
            <label class="study-radio-btn"><input type="radio" name="study-help" value="very"><span>⭐⭐⭐ Very helpful</span></label>
            <label class="study-radio-btn"><input type="radio" name="study-help" value="somewhat"><span>⭐⭐ Somewhat helpful</span></label>
            <label class="study-radio-btn"><input type="radio" name="study-help" value="not"><span>⭐ Not helpful</span></label>
            <label class="study-radio-btn"><input type="radio" name="study-help" value="unused"><span>🚫 I didn't use it</span></label>
          </div>
          <div id="study-post-error" class="study-error" style="display:none;">Please answer both questions.</div>
          <button class="study-btn study-btn-primary" id="study-next-btn">${s.idx < s.queue.length - 1 ? 'Next Task →' : 'Finish Study'}</button>
        </div>
      </div>
    `);
    $('study-close').onclick = closeStudyPanel;
    $('study-next-btn').onclick = async () => {
      const confSel = overlay.querySelector('input[name="study-conf"]:checked');
      const helpSel = overlay.querySelector('input[name="study-help"]:checked');
      if (!confSel || !helpSel) { $('study-post-error').style.display = ''; return; }

      // question_index = 0-based position of this task within its own type (find/guide); there is
      // a single block in this study, so block_index stays 0.
      const questionIndex = s.queue.slice(0, s.idx).filter(e => e.taskType === taskType).length;
      // The ground truth is read HERE, not inside the record builder — the builder is pure so its
      // grading stays unit-testable, exactly as it is for the find half. Read at submit rather than
      // at task start so a ground truth corrected mid-session still applies to the run it describes.
      let groundTruth = null;
      if (taskType === 'guide' && task?.trajectory_id && typeof getGuideTrajectory === 'function') {
        try {
          groundTruth = (await getGuideTrajectory(task.trajectory_id))?.ground_truth || null;
        } catch (e) {
          console.warn('[Study] Could not read ground truth for scoring:', e);
        }
      }
      // The cell this question was dealt, and the wording the participant actually judged. Read
      // from the queue entry rather than from `s.arm`: correctness is counterbalanced per question,
      // so the session has no single answer to either.
      const variantKey = _studyVariantAt(s.idx);
      const shownRecord = (taskType === 'find' && task?.id && variantKey)
        ? await getStudyResponse(task.id, variantKey)
        : null;
      const claimTextSnapshot = shownRecord
        ? (shownRecord.answer_display || shownRecord.answer_raw || '')
        : null;
      const result = _buildStudyResultRecord({
        participantId: s.participantId,
        sessionId: s.sessionId,
        taskIndex: s.idx,
        blockIndex: 0,
        questionIndex,
        totalTasks: s.queue.length,
        taskType,
        task,
        variantKey,
        claimTextSnapshot,
        // The grounding half of the cell, so plain by-arm queries stay readable — the same split
        // supabase_schema_v2.sql keeps `condition` for beside `variant_key`.
        condition: variantKey
          ? studyConditionLabel(_variantIsGrounded(variantKey) ? 'grounding' : 'nongrounding')
          : studyConditionLabel(s.mode === 'study' ? s.arm : null),
        elapsedMs: timings.totalElapsed,
        notesElapsedMs: timings.notesElapsed,
        answerElapsedMs: timings.answerElapsed,
        answerChoiceMs: timings.answerChoiceMs,
        findSupportingMs: timings.findSupportingMs,
        guideAnswer: timings.guideAnswer || null,
        groundTruth,
        evidenceResponses: timings.evidenceResponses || [],
        answer,
        confidence: confSel.value,
        helpfulness: helpSel.value,
        chatSnapshot,
        behaviorData,
      });
      if (s.guideScreenshot) result.guide_screenshot = s.guideScreenshot;
      s.guideScreenshot = null;
      s.currentNotes = '';
      s.llmAnswersSnapshot = null;

      s.results.push(result);
      await persistResult(result);
      await _persistFindV2Result(result, { task, variantKey, timings, taskType });

      s.idx++;
      if (s.idx < s.queue.length) {
        renderTaskSetup();
      } else {
        renderStudyComplete();
      }
    };
  }

  function renderStudyComplete() {
    const supaConfigured = typeof SUPABASE_URL !== 'undefined' && SUPABASE_URL && !SUPABASE_URL.includes('YOUR_PROJECT');
    setHTML(`
      <div class="study-screen">
        <div class="study-header"><span class="study-title">Study Complete!</span></div>
        <div class="study-body" style="text-align:center;">
          <p style="font-size:15px;">🎉 Thank you for completing all ${s.queue.length} tasks.</p>
          <p class="study-save-status" style="color:${supaConfigured ? '#ffbe84' : '#ffce9c'};">
            ${supaConfigured ? '✅ Results saved to Supabase after each task.' : 'ℹ️ Results are saved locally in this browser. Download the CSV to keep a copy.'}
          </p>
          <button class="study-btn study-btn-primary" id="study-download-btn">⬇ Download Results CSV</button>
          <button class="study-btn" id="study-close-final-btn" style="margin-top:8px;">Close</button>
        </div>
      </div>
    `);
    $('study-download-btn').onclick = downloadResultsCSV;
    $('study-close-final-btn').onclick = closeStudyPanel;
  }

  // ── Panel open/close ──

  window.openStudyPanel = async function openStudyPanel(mode) {
    if (s.open) return;
    s.open = true;
    s.mode = (mode === 'study' || mode === 'record-guide' || mode === 'record-annotation' || mode === 'record-model-performance' || mode === 'compare') ? mode : 'record';
    overlay = document.getElementById('study-overlay');
    miniBar = document.getElementById('study-mini-bar');
    if (!overlay || !miniBar) {
      console.error('[Study] Missing #study-overlay / #study-mini-bar in panel.html');
      s.open = false;
      return;
    }
    overlay.style.display = 'flex';
    if (s.mode === 'record-guide') {
      renderGuideTrajectoryList();
      return;
    }
    if (s.mode === 'record-annotation') {
      renderAnnotationTrajectoryList();
      return;
    }
    if (s.mode === 'record-model-performance') {
      renderModelPerformanceTrajectoryList();
      return;
    }
    if (s.mode === 'compare') {
      renderModelComparison();
      return;
    }
    s.queue = await loadTasks();
    if (s.mode === 'record' && s.queue.length) {
      // The recorder is not taking the survey — there is no participant to name and no run to
      // start, so the welcome screen is pure friction. Straight to the question list, at whichever
      // question this session was last on.
      s.participantId = s.participantId || 'recorder';
      s.idx = Math.max(0, Math.min(s.idx, s.queue.length - 1));
      renderTaskSetup();
      return;
    }
    renderWelcome();
  };

  window.closeStudyPanel = function closeStudyPanel() {
    s.open = false;
    window.__pgStudyCurrentTask = null; // no session → the Edit dialog falls back to matching
    if (s.timerInterval) { clearInterval(s.timerInterval); s.timerInterval = null; }
    if (overlay) overlay.style.display = 'none';
    if (miniBar) miniBar.style.display = 'none';
  };
})();
