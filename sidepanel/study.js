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

/**
 * Fisher-Yates shuffle. `rng` is injectable (defaults to Math.random) so tests can get a
 * deterministic order.
 */
function _shuffleStudyOptions(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
  } = ctx;

  const questionOrTask = taskType === 'find' ? task.question : task.task;
  const answerCorrect = taskType === 'find' ? _gradeFindAnswer(answer, task.answer) : null;
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
    // participant commits to a multiple-choice answer: everything before is reading the agent's
    // answer and deciding, everything after is finding the evidence for it on the page. They are
    // different acts, and averaging them together hides which one the grounding actually helped.
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
    task_data:          task,
  };
}

const STUDY_CSV_COLUMNS = [
  'tool', 'participant_id', 'session_id', 'condition', 'block_index', 'task_index',
  'question_index', 'task_id', 'task_type', 'question_or_task', 'url', 'time_ms',
  'notes_time_ms', 'answer_time_ms', 'answer_multiple_choice_ms', 'find_supporting_answer_ms',
  'evidence_responses', 'guide_answer_correct', 'guide_answer_problems', 'guide_answer_problem',
  'guide_errors', ...GUIDE_SCORE_COLUMNS, 'answer',
  'answer_correct', 'confidence', 'helpfulness', 'chat_turn_count',
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
  window._shuffleStudyOptions = _shuffleStudyOptions;
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
    queue: [],       // ordered [{taskType, task}, ...]
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
      const data = await fetch(url).then(r => r.json());
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
    return `
      <div class="study-answer-arm-switch" id="study-answer-arm-switch">
        <button class="study-arm-btn study-arm-btn-active" data-arm="live">Live</button>
        <button class="study-arm-btn" data-arm="grounding">Grounded <span class="study-arm-badge" data-badge="grounding">–</span></button>
        <button class="study-arm-btn" data-arm="nongrounding">Non-grounded <span class="study-arm-badge" data-badge="nongrounding">–</span></button>
      </div>`;
  }

  /** Labels used in buttons and notices, so "Grounded"/"Non-grounded" is spelt once. */
  const STUDY_ARM_LABELS = { grounding: 'Grounded', nongrounding: 'Non-grounded' };

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

    const arms = {
      grounding: { record: taskId ? await getStudyResponse(taskId, 'grounding') : null, draft: null, dirty: false },
      nongrounding: { record: taskId ? await getStudyResponse(taskId, 'nongrounding') : null, draft: null, dirty: false }
    };
    // With no live answer this run, open on whichever arm actually has something to read rather
    // than on an empty Live tab.
    const hasLive = !!(snapshot?.answers || []).length;
    let active = hasLive ? 'live'
      : (arms.grounding.record ? 'grounding' : (arms.nongrounding.record ? 'nongrounding' : 'live'));

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
     * Make the page match the answer on screen: show or hide the citation highlights for this arm,
     * and draw its evidence marks.
     *
     * The highlights are SHOWN or HIDDEN, never redrawn. Redrawing them means resolving [N] through
     * window._pageguideIndex, which is rebuilt from the DOM every run — and the highlight spans
     * themselves change what that walk indexes — so the numbers address different elements
     * afterwards and the highlights land in the wrong places. The spans the run drew are still
     * there and still right; only their visibility belongs to the arm.
     */
    const syncPageForArm = (name) => {
      if (typeof sendToContentScript !== 'function') return;
      sendToContentScript({ action: 'setAnswerHighlightsVisible', visible: name !== 'nongrounding' })
        .catch(() => {});
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
        return `<button class="study-act-btn study-act-primary" data-act="save-grounded">💾 Save as Grounded${which}</button>` +
          `<button class="study-act-btn" data-act="edit">✏️ Edit</button>`;
      }
      const arm = arms[active];
      const hasText = !!_studyArmText(arm);
      const strip = active === 'grounding' && hasText
        ? `<button class="study-act-btn" data-act="strip">✂️ Strip → Non-grounded</button>` : '';
      const edit = hasText ? `<button class="study-act-btn" data-act="edit">✏️ Edit</button>` : '';
      const save = arm.dirty
        ? `<button class="study-act-btn study-act-primary" data-act="save-arm">💾 Save as ${STUDY_ARM_LABELS[active]}</button>` : '';
      return strip + edit + save;
    }

    function render() {
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
          : `<div class="study-llm-answer-message study-llm-answer-plain">Nothing recorded for the ${STUDY_ARM_LABELS[active].toLowerCase()} arm yet.</div>`;
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
      // Only a record built from a fresh result carries crops worth downscaling.
      const res = await saveStudyResponse(toSave, { downscale: fromParked });
      if (!res.saved) { setNote(`Could not save: ${res.error || 'unknown error'}`); return false; }
      arm.record = toSave;
      arm.draft = null;
      arm.dirty = false;
      setNote(`Saved ${STUDY_ARM_LABELS[armName].toLowerCase()} answer for ${taskId}${res.synced ? ' (synced)' : ' (local)'}.`);
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

      if (act === 'save-grounded') {
        if (!parkedLive()?.result) {
          setNote('The live answer is no longer in memory — re-run the question, then save.');
          return;
        }
        if (await persist('grounding', { fromParked: true })) show('grounding');
        else render();
        return;
      }

      if (act === 'strip') {
        const source = _studyArmText(arms.grounding);
        if (!source) return;
        arms.nongrounding.draft = _stripStudyGrounding(source);
        arms.nongrounding.dirty = true;
        show('nongrounding');
        setNote('Stripped from the grounded answer — edit it, then save. Nothing is stored until you do.');
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
          title: active === 'live' ? 'Edit the live answer' : `Edit the ${STUDY_ARM_LABELS[active].toLowerCase()} answer`,
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
        if (typeof sendToContentScript === 'function' && Number.isFinite(index)) {
          // The citation number, so the jump lands on the span this marker created rather than the
          // paragraph around it — one paragraph often carries several citations.
          sendToContentScript({ action: 'scrollToIndex', index, citation: webCit.dataset.citation });
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
        <div style="background:#1a1a2e;border:1px solid rgba(155,132,255,0.34);border-radius:12px;padding:24px 20px;max-width:260px;text-align:center;font-family:system-ui;color:#fff;">
          <div style="font-size:32px;margin-bottom:10px">📸</div>
          <div style="font-weight:700;font-size:15px;margin-bottom:8px">Take a screenshot?</div>
          <div style="font-size:13px;color:#aaa;margin-bottom:20px;line-height:1.5">We'd like to capture the current page to record your guide result.</div>
          <div style="display:flex;gap:8px">
            <button id="study-ss-deny" style="flex:1;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:#ccc;cursor:pointer;font-size:13px">No thanks</button>
            <button id="study-ss-allow" style="flex:1;padding:10px;border-radius:8px;border:none;background:#9b84ff;color:#fff;cursor:pointer;font-size:13px;font-weight:700">Allow</button>
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
  async function startSession(participantId) {
    s.sessionId = null;
    const row = await supabaseInsert('study_sessions', {
      participant_id: participantId,
      condition_order: studyConditionLabel(s.mode === 'study' ? s.arm : null),
    });
    if (row && row.id) s.sessionId = row.id;
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
  async function _buildStimulusBundle(trajectoryRows, half = 'all') {
    const now = new Date().toISOString();
    const wantGuide = half === 'all' || half === 'guide';
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
      const data = await fetch(chrome.runtime.getURL('user_study_data/tasks.json')).then(r => r.json());
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

    // The recorded agent answers, one per (task × condition).
    let canned = [];
    if (wantFind && typeof listStudyResponses === 'function') {
      // The bank is FLAT: keyed "taskId::condition", and each value IS the record. It was read here
      // as though each entry held a nested `arms` object, which silently yielded an empty list — so
      // every recorded Find answer was dropped at publish time and study_canned_responses stayed
      // empty no matter how many were banked. Nothing failed; there was simply never anything to send.
      canned = Object.values(await listStudyResponses() || {})
        .filter(r => r && r.task_id && r.condition)
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
  async function _publishStimuliVia(trajectoryRows, note, half = 'all') {
    const bundle = await _buildStimulusBundle(trajectoryRows, half);
    const empty = !bundle.study_guide_trajectories.length && !bundle.study_tasks.length
      && !bundle.study_canned_responses.length && !bundle.study_ground_truth.length;
    if (empty) {
      note(half === 'guide'
        ? 'Nothing to publish — no included trajectory has steps.'
        : 'Nothing to publish — no Find tasks or recorded answers were found.', 'bad');
      return;
    }
    note(`Publishing ${_describeStimulusBundle(bundle)}…`);

    let res;
    try {
      res = await fetch(PUBLISH_HELPER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bundle),
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
    if (!res.ok || !out) { note(`The helper returned ${res.status}.`, 'bad'); return; }
    if (out.help) { note(`${out.summary}. ${out.help}`, 'bad'); return; }
    note(`Published — ${out.summary}.`, 'ok');
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

  async function renderGuideTrajectoryList() {
    const all = await listGuideTrajectories();
    const rows = Object.values(all).sort((a, b) => String(b.captured_at || '').localeCompare(String(a.captured_at || '')));
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

    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">🧭 Record Guide User Study</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-body">
          <p class="study-intro">${rows.length
            ? `Captured guide runs. Edit one into the trajectory the study should show, then save it.
               <strong>${inStudy} of ${rows.length}</strong> will appear in the Guide User Study.`
            : 'Nothing captured yet. Run a guide task, then press 🎬 on its journey card to capture it.'}</p>
          ${rows.length ? `
          <div class="study-traj-filters" id="study-traj-filters">
            ${filters.map(f => `
              <button class="study-traj-filter${f.id === _guideTrajFilter ? ' study-traj-filter-on' : ''}"
                data-traj-filter="${escapeAttr(f.id)}">${escapeHTML(f.label)}
                <span class="study-traj-filter-n">${counts[f.id] || 0}</span></button>`).join('')}
          </div>
          <div class="study-traj-bulk">
            <span class="study-traj-sub">${_guideTrajFilter === 'all'
              ? 'All trajectories:'
              : 'Shown here only:'}</span>
            <button class="study-evidence-clear" data-traj-bulk="in">Include all</button>
            <button class="study-evidence-clear" data-traj-bulk="out">Exclude all</button>
            <button class="study-evidence-clear" id="study-traj-publish" title="Publish the GUIDE trajectories via the local publish helper">⬆ Publish guide</button>
            <button class="study-evidence-clear" id="study-traj-export" title="Save the guide bundle to a file, to upload later with scripts/publish.mjs">⬇ Export instead</button>
          </div>
          <div class="study-llm-answers-note" id="study-traj-list-note"></div>` : ''}
          ${shown.length ? shown.map(t => {
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
                </div>
              </div>
              <button class="study-evidence-annotate" data-traj-open="${escapeAttr(t.id)}">Edit</button>
              <button class="study-truth-item-btn" data-traj-delete="${escapeAttr(t.id)}" title="Delete this trajectory">✕</button>
            </div>`;
          }).join('') : (rows.length ? '<div class="study-truth-empty">No trajectory in this condition yet.</div>' : '')}
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

    const armPicker = recording ? '' : `
          <p class="study-question-text" style="margin-top:12px;">Which answers should this participant read?</p>
          <div class="study-radio-group" id="study-arm-group">
            ${STUDY_ARM_CHOICES.map((c, i) => `
              <label class="study-radio-btn"><input type="radio" name="study-arm" value="${c.id}"${i === 0 ? ' checked' : ''}><span>${c.label} — <em>${c.note}</em></span></label>`).join('')}
          </div>`;

    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">${recording ? '🎬 Record User Study' : '🎓 PageGuide User Study'}</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-body">
          <p class="study-intro">${recording
            ? `Walk all <strong>${s.queue.length} tasks</strong>, recording each question's grounded and non-grounded answer and its ground truth.`
            : `You'll answer <strong>${s.queue.length} questions</strong>. For each one you'll read the agent's answer, then say what you found on the page.`}</p>
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
      s.arm = overlay.querySelector('input[name="study-arm"]:checked')?.value || 'grounding';
      s.taskFilter = overlay.querySelector('input[name="study-half"]:checked')?.value || 'all';
      if (s.taskFilter !== 'all') {
        s.queue = s.queue.filter(entry => entry.taskType === s.taskFilter);
        if (!s.queue.length) {
          setHTML(`<div class="study-screen"><div class="study-body"><p class="study-error">No ${escapeHTML(s.taskFilter)} tasks are ready to run.</p></div></div>`);
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
            <div class="study-task-type-badge">${STUDY_TASK_LABELS[taskType]}</div>
            <p class="study-task-desc">${_studyRecording()
              ? escapeHTML(taskQuestion || STUDY_TASK_DESCRIPTIONS[taskType])
              : STUDY_TASK_DESCRIPTIONS[taskType]}</p>
          </div>
          ${savedAnswersRow}
          ${_studyRecording() ? `
            <!-- The SAME action as the Guide recorder's button, not a Find-only one: the stimuli are
                 one study and go up together. It lives here too because a researcher working
                 through the Find half had no way to know that, and an unreachable action is an
                 action nobody runs. -->
            <div class="study-traj-bulk" style="justify-content:flex-end;">
              <button class="study-evidence-clear" id="study-capture-page" title="Freeze this task's page so the study website can show it — the live page cannot be framed or scripted">📄 Capture page</button>
              <button class="study-evidence-clear" id="study-publish-find" title="Publish the FIND questions, recorded answers, ground truth and captured pages via the local publish helper">⬆ Publish find</button>
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
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) { note('No active tab to capture.', 'bad'); return; }
        const snapshot = await chrome.tabs.sendMessage(tab.id, { action: 'capturePageSnapshot' });
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
        note(`Captured ${_fmtSnapshotSize(snapshot.bytes)} from ${snapshot.url} — `
          + `${anchored.summary}. `
          + (sharedWith
            ? `${sharedWith} already has this same page — only one copy is published, and both tasks read it.`
            : 'Publish find to send it to the website.'), 'ok');
      } catch (e) {
        note(`Could not capture: ${e?.message || e}. Make sure the task page is the active tab.`, 'bad');
      } finally {
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

  const STUDY_ARM_CHOICES = [
    { id: 'grounding', label: 'Grounded', note: 'The answer keeps its citations and evidence markers.' },
    { id: 'nongrounding', label: 'Non-grounded', note: 'The same answer, with every marker removed.' },
  ];

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
    const record = task?.id ? await getStudyResponse(task.id, s.arm) : null;
    if (!record) {
      const label = STUDY_ARM_LABELS[s.arm] || s.arm;
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
      const options = _shuffleStudyOptions([task.answer, ...(task.distractors || [])]);
      const notesBlock = s.currentNotes ? `<div class="study-notes-display"><span class="study-notes-display-label">📝 Your notes</span><p class="study-notes-display-text">${escapeHTML(s.currentNotes)}</p></div>` : '';
      answerHTML = `
        ${notesBlock}
        ${llmAnswersHTML}
        <div class="study-question-card">
          <div class="study-question-head">
            <span class="study-question-badge">Q1</span>
            <p class="study-question-text">Select the answer you found:</p>
          </div>
          <div class="study-radio-group" id="study-answer-group">
            ${options.map(opt => `<label class="study-radio-btn"><input type="radio" name="study-answer" value="${escapeAttr(opt)}"><span>${escapeHTML(opt)}</span></label>`).join('')}
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
          <div id="study-answer-error" class="study-error" style="display:none;">Please select an answer.</div>
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
        errorEl.textContent = 'Please select an answer.';
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
      const result = _buildStudyResultRecord({
        participantId: s.participantId,
        sessionId: s.sessionId,
        taskIndex: s.idx,
        blockIndex: 0,
        questionIndex,
        totalTasks: s.queue.length,
        taskType,
        task,
        condition: studyConditionLabel(s.mode === 'study' ? s.arm : null),
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
          <p class="study-save-status" style="color:${supaConfigured ? '#9b84ff' : '#b89cff'};">
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
    s.mode = (mode === 'study' || mode === 'record-guide') ? mode : 'record';
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
