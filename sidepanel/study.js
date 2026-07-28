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
const STUDY_CONDITION = 'extension';

/**
 * The condition label for a row: the base label plus the evidence-mode arm currently selected.
 * Falls back to the base label alone if storage is unavailable.
 * @returns {Promise<string>}
 */
async function studyConditionLabel() {
  try {
    const r = await chrome.storage.local.get('pageguideEvidenceMode');
    return `${STUDY_CONDITION}-${r.pageguideEvidenceMode === 'text' ? 'text' : 'visual'}`;
  } catch (e) {
    return STUDY_CONDITION;
  }
}
// The exact column list on the Supabase `study_task_results` table. persistResult() posts only
// these keys so the insert matches the table even though the local/CSV record carries extra
// convenience fields (tool, task_id, url, total_tasks, completed_at).
const SUPABASE_TASK_COLUMNS = [
  'session_id', 'participant_id', 'block_index', 'task_index', 'question_index', 'task_type',
  'condition', 'time_ms', 'notes_time_ms', 'answer_time_ms', 'evidence_responses', 'answer', 'answer_correct', 'question_or_task', 'confidence',
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

function _studyEvidencePrompts(task) {
  const custom = Array.isArray(task?.evidence_questions)
    ? task.evidence_questions.map(q => String(q || '').trim()).filter(Boolean)
    : [];
  const prompts = custom.length >= 2 ? custom.slice(0, 2) : STUDY_EVIDENCE_PROMPTS;
  return prompts.map((prompt, i) => ({ hop: i + 1, prompt }));
}

/**
 * Assemble the persisted record for one completed task. Pure function of its inputs so the
 * shape (and the answer_correct grading) can be unit tested without any DOM/chrome mocking.
 */
function _buildStudyResultRecord(ctx) {
  const {
    participantId, sessionId, taskIndex, blockIndex, questionIndex, totalTasks,
    taskType, task, condition, elapsedMs, answer,
    notesElapsedMs, answerElapsedMs, evidenceResponses, confidence, helpfulness, chatSnapshot, behaviorData,
  } = ctx;

  const questionOrTask = taskType === 'find' ? task.question : task.task;
  const answerCorrect = taskType === 'find' ? _gradeFindAnswer(answer, task.answer) : null;
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
    answer_time_ms:    answerElapsedMs ?? null,
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
  'notes_time_ms', 'answer_time_ms', 'evidence_responses', 'answer',
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

if (typeof window !== 'undefined') {
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

  const s = {
    participantId: '',
    sessionId: null, // study_sessions.id once the session row is created (null if Supabase off)
    queue: [],       // ordered [{taskType, task}, ...]
    idx: 0,          // current position in queue
    results: [],
    timerInterval: null,
    timerStart: null,
    currentNotes: '',
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
      return _buildTaskQueue(data);
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
        const text = (node.textContent || '').trim();
        if (!text) return null;
        return groundingEnabled
          ? { html: node.innerHTML, text, className: node.className }
          : { text };
      })
      .filter(Boolean);
    return { groundingEnabled, answers };
  }

  function renderLlmAnswers(snapshot) {
    const answers = snapshot?.answers || [];
    if (!answers.length) return '';
    const groundingEnabled = !!snapshot.groundingEnabled;
    const rows = answers.map(answer => {
      if (groundingEnabled && answer.html) {
        const cls = answer.className || 'pageguide-message assistant';
        return `<div class="study-llm-answer-message ${escapeAttr(cls)}">${answer.html}</div>`;
      }
      return `<div class="study-llm-answer-message study-llm-answer-plain">${escapeHTML(answer.text)}</div>`;
    }).join('');
    return `
      <div class="study-llm-answers" id="study-llm-answers">
        <div class="study-llm-answers-title">LLM answers</div>
        <div class="study-llm-answers-list">${rows}</div>
      </div>`;
  }

  function bindStudyLlmAnswerLinks(snapshot) {
    const box = $('study-llm-answers');
    if (!box || !snapshot?.groundingEnabled) return;
    box.addEventListener('click', async (e) => {
      const evChip = e.target.closest('.pageguide-find-evidence-chip');
      if (evChip) {
        e.stopPropagation();
        if (typeof openFindEvidenceView === 'function') {
          openFindEvidenceView(evChip.closest('.pageguide-find-evidence'), evChip.dataset.evidenceNum);
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
          sendToContentScript({ action: 'scrollToIndex', index });
        }
        return;
      }

      const msg = e.target.closest('.pageguide-message.pageguide-clickable');
      if (msg && !e.target.closest('button')) msg.classList.toggle('citations-expanded');
    });
  }

  async function loadStudyParagraphOptions() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) return { success: false, options: [] };
      const resp = await chrome.tabs.sendMessage(tabs[0].id, { action: 'getStudyParagraphOptions' });
      return {
        success: !!resp?.success,
        options: Array.isArray(resp?.options) ? resp.options : [],
        url: resp?.url || tabs[0].url || null,
      };
    } catch (e) {
      return { success: false, options: [] };
    }
  }

  function renderStudyEvidenceControls(task, paragraphOptions) {
    const prompts = _studyEvidencePrompts(task);
    const options = Array.isArray(paragraphOptions?.options) ? paragraphOptions.options : [];
    const hasOptions = options.length > 0;
    const optionHTML = options.map(opt =>
      `<option value="${escapeAttr(String(opt.index))}">${escapeHTML(opt.label || `[${opt.index}] ${opt.text || ''}`)}</option>`
    ).join('');

    return `
      <div class="study-evidence-section" id="study-evidence-section">
        <div class="study-evidence-title">Supporting evidence</div>
        ${prompts.map(({ hop, prompt }) => `
          <div class="study-evidence-item">
            <label class="study-evidence-label" for="study-evidence-hop-${hop}">${escapeHTML(prompt)}</label>
            ${hasOptions ? `
              <div class="study-evidence-select-row">
                <select class="study-evidence-select" id="study-evidence-hop-${hop}" data-hop="${hop}">
                  <option value="">Select a paragraph on the page...</option>
                  ${optionHTML}
                </select>
                <button type="button" class="study-evidence-jump" data-study-evidence-jump="${hop}" title="Jump to selected paragraph">Jump</button>
              </div>
            ` : `
              <textarea class="study-evidence-textarea" id="study-evidence-hop-${hop}" data-hop="${hop}" rows="3" placeholder="Paste or describe the supporting paragraph."></textarea>
            `}
          </div>
        `).join('')}
      </div>
    `;
  }

  function bindStudyEvidenceControls() {
    overlay.querySelectorAll('[data-study-evidence-jump]').forEach(btn => {
      btn.addEventListener('click', () => {
        const hop = btn.dataset.studyEvidenceJump;
        const select = $(`study-evidence-hop-${hop}`);
        const index = parseInt(select?.value, 10);
        if (typeof sendToContentScript === 'function' && Number.isFinite(index)) {
          sendToContentScript({ action: 'scrollToIndex', index });
        }
      });
    });
  }

  function collectStudyEvidenceResponses(taskType, task, paragraphOptions) {
    if (taskType !== 'find') return { valid: true, responses: [] };

    const prompts = _studyEvidencePrompts(task);
    const options = Array.isArray(paragraphOptions?.options) ? paragraphOptions.options : [];
    const byIndex = new Map(options.map(opt => [String(opt.index), opt]));
    const responses = [];

    for (const { hop, prompt } of prompts) {
      const field = $(`study-evidence-hop-${hop}`);
      if (!field) return { valid: false, responses: [] };

      if (options.length) {
        const value = String(field.value || '');
        if (!value) return { valid: false, responses: [] };
        const opt = byIndex.get(value);
        if (!opt) return { valid: false, responses: [] };
        responses.push({
          hop,
          prompt,
          index: opt.index,
          role: opt.role || null,
          text: opt.text || '',
          url: opt.url || paragraphOptions?.url || task?.url || null,
        });
      } else {
        const text = String(field.value || '').trim();
        if (!text) return { valid: false, responses: [] };
        responses.push({
          hop,
          prompt,
          index: null,
          role: 'manual',
          text,
          url: paragraphOptions?.url || task?.url || null,
        });
      }
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

  // Create the parent study_sessions row at study start so task rows can reference session_id.
  async function startSession(participantId) {
    s.sessionId = null;
    const row = await supabaseInsert('study_sessions', {
      participant_id: participantId,
      condition_order: await studyConditionLabel(),
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

  // ── Screens ──

  function renderWelcome() {
    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">🎓 PageGuide User Study</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-body">
          <p class="study-intro">You'll complete <strong>${s.queue.length} tasks</strong>: Find-information tasks and Guide tasks, always using PageGuide.</p>
          <label class="study-question-text" for="study-pid-input" style="margin-top:8px;">Participant ID (optional)</label>
          <input type="text" class="study-input" id="study-pid-input" placeholder="e.g. P07">
          <button class="study-btn study-btn-primary" id="study-start-btn" style="margin-top:16px;">Start Study →</button>
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
      s.idx = 0;
      s.results = [];
      await startSession(s.participantId);
      renderTaskSetup();
    };
  }

  function renderTaskSetup() {
    const entry = s.queue[s.idx];
    const { taskType, task } = entry;
    const taskQuestion = taskType === 'find' ? task.question : task.task;
    const taskUrl = task.url;

    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">${STUDY_TASK_LABELS[taskType]}</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-progress">Task ${s.idx + 1}/${s.queue.length} · ${STUDY_TASK_LABELS[taskType]}</div>
        <div class="study-body">
          <div class="study-task-card">
            <div class="study-task-type-badge">${STUDY_TASK_LABELS[taskType]}</div>
            <p class="study-task-desc">${STUDY_TASK_DESCRIPTIONS[taskType]}</p>
          </div>
          <button class="study-btn study-btn-primary" id="study-open-btn">Open ${escapeHTML(task.name || 'Page')} & Start Timer</button>
        </div>
      </div>
    `);
    $('study-close').onclick = closeStudyPanel;
    $('study-open-btn').onclick = async () => {
      if (typeof resetChat === 'function') resetChat(false);
      openTaskPage(taskUrl);

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
          startTimer();
          startBehaviorTracking();
          renderTaskRunning(taskType, taskQuestion, task);
        }
      }, 1000);
    };
  }

  const TASK_PREFIX = { find: '/find', guide: '/guide' };

  function renderTaskRunning(taskType, taskQuestion, task) {
    overlay.style.display = 'none';
    const prefix = TASK_PREFIX[taskType] || '';

    miniBar.innerHTML = `
      <div class="study-mini-top">
        <span class="study-mini-label">Task ${s.idx + 1}/${s.queue.length} · ${STUDY_TASK_LABELS[taskType]}</span>
        <span class="study-mini-timer" id="study-mini-timer">${_formatStudyTime(STUDY_TASK_TIME_LIMIT_MS)}</span>
      </div>
      <div class="study-mini-bottom">
        <span class="study-mini-q">${escapeHTML(taskQuestion)}</span>
        <div class="study-mini-actions">
          <button class="study-mini-copy-btn" id="study-mini-copy" title="Copy task to clipboard">Copy</button>
          <button class="study-mini-done-btn" id="study-mini-done">✅ Done</button>
        </div>
      </div>
      ${taskType === 'find' ? `<textarea class="study-mini-notes" id="study-mini-notes" placeholder="📝 Take notes here…" rows="2"></textarea>` : ''}
    `;
    miniBar.style.display = 'flex';

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
      const notesElapsed = stopTimer();
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

  function renderTaskAnswer(taskType, task, notesElapsed, behaviorData, chatSnapshot, llmAnswersSnapshot, paragraphOptions) {
    const answerStartedAt = Date.now();
    let answerTimerInterval = null;
    const taskQuestion = taskType === 'find' ? task.question : task.task;
    const questionCard = `<div class="study-task-card study-task-card-running" style="margin-bottom:10px;"><div class="study-task-question">${escapeHTML(taskQuestion)}</div></div>`;
    const llmAnswersHTML = renderLlmAnswers(llmAnswersSnapshot);

    let answerHTML = '';
    if (taskType === 'find') {
      const options = _shuffleStudyOptions([task.answer, ...(task.distractors || [])]);
      const notesBlock = s.currentNotes ? `<div class="study-notes-display"><span class="study-notes-display-label">📝 Your notes</span><p class="study-notes-display-text">${escapeHTML(s.currentNotes)}</p></div>` : '';
      answerHTML = `
        ${notesBlock}
        ${llmAnswersHTML}
        <p class="study-question-text">Select the answer you found:</p>
        <div class="study-radio-group" id="study-answer-group">
          ${options.map(opt => `<label class="study-radio-btn"><input type="radio" name="study-answer" value="${escapeAttr(opt)}"><span>${escapeHTML(opt)}</span></label>`).join('')}
        </div>
        ${renderStudyEvidenceControls(task, paragraphOptions)}`;
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
        <div class="study-progress">Task ${s.idx + 1}/${s.queue.length} · ${STUDY_TASK_LABELS[taskType]}</div>
        <div class="study-body">
          ${questionCard}
          <div class="study-answer-timers">
            <div class="study-timer-display"><span class="study-timer-label">⏱ Time used</span><span class="study-timer study-timer-stopped">${_formatStudyTime(notesElapsed)}</span></div>
            <div class="study-timer-display study-answer-timer-display"><span class="study-timer-label">Answer time</span><span class="study-timer study-answer-timer" id="study-answer-timer">00:00</span></div>
          </div>
          ${answerHTML}
          <div id="study-answer-error" class="study-error" style="display:none;">Please select an answer.</div>
          <button class="study-btn study-btn-primary" id="study-submit-btn">Submit →</button>
        </div>
      </div>
    `);
    answerTimerInterval = setInterval(() => {
      const el = $('study-answer-timer');
      if (el) el.textContent = _formatStudyTime(Date.now() - answerStartedAt);
    }, 1000);
    $('study-close').onclick = () => {
      if (answerTimerInterval) clearInterval(answerTimerInterval);
      closeStudyPanel();
    };
    bindStudyLlmAnswerLinks(llmAnswersSnapshot);
    bindStudyEvidenceControls();
    $('study-submit-btn').onclick = () => {
      const sel = overlay.querySelector('input[name="study-answer"]:checked');
      const errorEl = $('study-answer-error');
      if (!sel) {
        errorEl.textContent = 'Please select an answer.';
        errorEl.style.display = '';
        return;
      }
      const evidence = collectStudyEvidenceResponses(taskType, task, paragraphOptions);
      if (!evidence.valid) {
        errorEl.textContent = 'Please select both supporting paragraphs.';
        errorEl.style.display = '';
        return;
      }
      const answerElapsed = Math.max(0, Date.now() - answerStartedAt);
      if (answerTimerInterval) clearInterval(answerTimerInterval);
      renderTaskPost(taskType, task, {
        notesElapsed,
        answerElapsed,
        totalElapsed: notesElapsed + answerElapsed,
        evidenceResponses: evidence.responses,
      }, sel.value, behaviorData, chatSnapshot);
    };
  }

  function renderTaskPost(taskType, task, timings, answer, behaviorData, chatSnapshot) {
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
      const result = _buildStudyResultRecord({
        participantId: s.participantId,
        sessionId: s.sessionId,
        taskIndex: s.idx,
        blockIndex: 0,
        questionIndex,
        totalTasks: s.queue.length,
        taskType,
        task,
        condition: await studyConditionLabel(),
        elapsedMs: timings.totalElapsed,
        notesElapsedMs: timings.notesElapsed,
        answerElapsedMs: timings.answerElapsed,
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

  window.openStudyPanel = async function openStudyPanel() {
    if (s.open) return;
    s.open = true;
    overlay = document.getElementById('study-overlay');
    miniBar = document.getElementById('study-mini-bar');
    if (!overlay || !miniBar) {
      console.error('[Study] Missing #study-overlay / #study-mini-bar in panel.html');
      s.open = false;
      return;
    }
    overlay.style.display = 'flex';
    s.queue = await loadTasks();
    renderWelcome();
  };

  window.closeStudyPanel = function closeStudyPanel() {
    s.open = false;
    if (s.timerInterval) { clearInterval(s.timerInterval); s.timerInterval = null; }
    if (overlay) overlay.style.display = 'none';
    if (miniBar) miniBar.style.display = 'none';
  };
})();
