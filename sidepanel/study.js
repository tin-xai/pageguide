// XWebAgent User Study
// Self-contained study overlay: state machine, data loading, timer, Supabase save, CSV download.
// Exposes window.openStudyPanel() and window.closeStudyPanel().

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────────────────────────

  const TASK_TYPES = ['find', 'guide', 'hide'];

  const TASK_LABELS = {
    find:  '🔍 Find Information',
    guide: '📘 Follow a Guide',
    hide:  '🙈 Hide Content',
  };

  const TASK_DESCRIPTIONS = {
    find:  'Find the answer to the question on the Wikipedia page.',
    guide: 'Complete the task described below on the website.',
    hide:  'Use the extension to hide the specified content from the page.',
  };



  // ─────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────

  const QUESTIONS_PER_TYPE = 3;         // questions per task type per block
  const TASK_TIME_LIMIT_MS = 3 * 60 * 1000; // 3-minute countdown per question

  const s = {
    participantId: '',
    sessionId: null,
    conditionOrder: [],   // ['control','extension'] or reversed
    datasets: { find: [], guide: [], hide: [] },
    sampledTasks: [
      { find: [], guide: [], hide: [] },  // block 0 — arrays of QUESTIONS_PER_TYPE
      { find: [], guide: [], hide: [] },  // block 1
    ],
    results: [],          // all collected task results
    block: 0,             // current block (0 or 1)
    taskIdx: 0,           // current task type index within block (0-2)
    questionIdx: 0,       // current question within task type (0 to QUESTIONS_PER_TYPE-1)
    timerInterval: null,
    timerStart: null,
    timerElapsed: 0,      // ms when timer was stopped
    currentAnswer: null,  // selected radio value
    currentPost: {},      // { confidence, helpfulness }
    _guideScreenshot: null, // base64 screenshot taken at guide task completion
    open: false,
  };

  // ─────────────────────────────────────────────────────────────────
  // DOM helpers
  // ─────────────────────────────────────────────────────────────────

  let overlay = null;
  let miniBar = null;

  function $(id) { return document.getElementById(id); }

  function setHTML(html) {
    overlay.innerHTML = html;
  }

  // ─────────────────────────────────────────────────────────────────
  // CSV parser (handles quoted fields with embedded commas/newlines)
  // ─────────────────────────────────────────────────────────────────

  function parseCSV(text) {
    const rows = [];
    let col = 0, row = [], inQuote = false, field = '';
    // normalise line endings
    const t = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (inQuote) {
        if (ch === '"') {
          if (t[i + 1] === '"') { field += '"'; i++; }
          else { inQuote = false; }
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuote = true;
        } else if (ch === ',') {
          row.push(field); field = ''; col++;
        } else if (ch === '\n') {
          row.push(field); field = ''; col = 0;
          rows.push(row); row = [];
        } else {
          field += ch;
        }
      }
    }
    if (field || col > 0) { row.push(field); rows.push(row); }

    if (rows.length < 2) return [];
    const headers = rows[0].map(h => h.trim());
    return rows.slice(1).filter(r => r.length >= headers.length).map(r => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (r[i] || '').trim(); });
      return obj;
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Dataset loading
  // ─────────────────────────────────────────────────────────────────

  async function loadDatasets() {
    const base = chrome.runtime.getURL('user_study_data/');
    try {
      const [findText, guideText, hideText] = await Promise.all([
        fetch(base + 'find_wiki_data.csv').then(r => r.text()),
        fetch(base + 'guide_data.csv').then(r => r.text()),
        fetch(base + 'selected_hide_data.json').then(r => r.text()),
      ]);
      // Parse find_wiki_data.csv — one row may yield 1 or 2 task entries (Q1/Q2)
      // Columns: Website URL, Q1, Q2, A1, A2, D1_1, D1_2, D1_3, D2_1, D2_2, D2_3
      const findRows = parseCSV(findText);
      s.datasets.find = [];
      findRows.forEach(row => {
        const baseEntry = { url: (row['Website URL'] || '').trim() };
        if (row['Q1'] && row['A1']) {
          s.datasets.find.push({
            ...baseEntry,
            question:      row['Q1'].trim(),
            short_answers: row['A1'].trim(),
            distractors:   [row['D1_1'], row['D1_2'], row['D1_3']].map(d => (d || '').trim()).filter(Boolean),
          });
        }
        if (row['Q2'] && row['A2']) {
          s.datasets.find.push({
            ...baseEntry,
            question:      row['Q2'].trim(),
            short_answers: row['A2'].trim(),
            distractors:   [row['D2_1'], row['D2_2'], row['D2_3']].map(d => (d || '').trim()).filter(Boolean),
          });
        }
      });
      s.datasets.guide = parseCSV(guideText).filter(r => r.Task && r['Website URL']).map(r => ({
        name:        r.Name.trim(),
        level:       r.Level.trim(),
        task:        r.Task.trim(),
        website_url: r['Website URL'].trim(),
      }));
      const hideRaw    = JSON.parse(hideText);
      // Flatten annotations into individual tasks
      hideRaw.forEach(page => {
        (page.annotations || []).forEach(ann => {
          s.datasets.hide.push({
            page_title: page.page_title,
            html_file:  page.html_file,
            ...ann,
          });
        });
      });
    } catch (e) {
      console.error('[Study] Failed to load datasets:', e);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Task sampling — different rows for each block
  // ─────────────────────────────────────────────────────────────────

  function sampleTasks() {
    TASK_TYPES.forEach(type => {
      const pool = s.datasets[type];
      if (!pool.length) return;
      // Shuffle indices and take up to QUESTIONS_PER_TYPE * 2 unique ones
      const indices = shuffle([...Array(pool.length).keys()]);
      const need = QUESTIONS_PER_TYPE * 2; // 3 per block × 2 blocks
      const picked = indices.slice(0, Math.min(need, pool.length));
      // If pool is smaller than needed, repeat with wrap-around
      while (picked.length < need) picked.push(picked[picked.length % pool.length]);
      s.sampledTasks[0][type] = picked.slice(0, QUESTIONS_PER_TYPE).map(i => pool[i]);
      s.sampledTasks[1][type] = picked.slice(QUESTIONS_PER_TYPE, need).map(i => pool[i]);
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Distractors for Find task
  // ─────────────────────────────────────────────────────────────────

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function getDistractors(correct, pool, n) {
    const others = pool
      .map(r => r.short_answers)
      .filter(a => a && a.trim() && a.trim().toLowerCase() !== correct.toLowerCase());
    return shuffle(others).slice(0, n);
  }

  // ─────────────────────────────────────────────────────────────────
  // Timer
  // ─────────────────────────────────────────────────────────────────

  function startTimer() {
    s.timerStart = Date.now();
    s.timerElapsed = 0;
    s.timerInterval = setInterval(() => {
      const elapsed   = Date.now() - s.timerStart;
      const remaining = Math.max(0, TASK_TIME_LIMIT_MS - elapsed);
      const t = formatTime(remaining);
      const urgent = remaining <= 30_000;

      const el = $('study-timer');
      if (el) { el.textContent = t; el.style.color = urgent ? '#ff4757' : ''; }
      const mini = $('study-mini-timer');
      if (mini) { mini.textContent = t; mini.style.color = urgent ? '#ff4757' : ''; }

      // Auto-submit when time runs out
      if (remaining <= 0) {
        const doneBtn = $('study-done-btn') || $('study-mini-done');
        if (doneBtn) doneBtn.click();
      }
    }, 1000);
  }

  function stopTimer() {
    if (s.timerInterval) { clearInterval(s.timerInterval); s.timerInterval = null; }
    s.timerElapsed = s.timerStart ? (Date.now() - s.timerStart) : 0;
    s.timerStart = null;
    return s.timerElapsed;
  }

  function formatTime(ms) {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60).toString().padStart(2, '0');
    const sec = (total % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  // ─────────────────────────────────────────────────────────────────
  // Tab navigation
  // ─────────────────────────────────────────────────────────────────

  async function openTaskPage(url) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs[0]) {
        await chrome.tabs.update(tabs[0].id, { url });
      }
    } catch (e) {
      console.error('[Study] Could not navigate tab:', e);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Supabase REST
  // ─────────────────────────────────────────────────────────────────

  async function supabaseInsert(table, data) {
    if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR_PROJECT')) return null;
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        const json = await res.json();
        return json[0] || null;
      } else {
        const errText = await res.text();
        console.error(`[Study] Supabase ${res.status} on ${table}:`, errText);
      }
    } catch (e) {
      console.error('[Study] Supabase error:', e);
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────
  // Behavior tracking helpers
  // ─────────────────────────────────────────────────────────────────

  let _sidepanelCtrlFListener = null;

  // Inject a full-screen blocking overlay on the active tab so the page stays
  // visible but the participant cannot scroll or interact with it.
  async function lockTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) await chrome.tabs.sendMessage(tabs[0].id, { action: 'studyLockPage' });
    } catch (e) {}
  }

  // Ask the participant for screenshot permission and, if granted, capture the
  // current tab via the existing captureScreenshot service-worker action.
  async function captureGuideScreenshot() {
    const allowed = await new Promise(resolve => {
      const modal = document.createElement('div');
      modal.style.cssText = [
        'position:fixed;inset:0;z-index:99999',
        'display:flex;align-items:center;justify-content:center',
        'background:rgba(0,0,0,0.72)',
      ].join(';');
      modal.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid rgba(0,217,255,0.3);border-radius:12px;
                    padding:24px 20px;max-width:260px;text-align:center;font-family:system-ui;color:#fff;">
          <div style="font-size:32px;margin-bottom:10px">📸</div>
          <div style="font-weight:700;font-size:15px;margin-bottom:8px">Take a screenshot?</div>
          <div style="font-size:13px;color:#aaa;margin-bottom:20px;line-height:1.5">
            We'd like to capture the current page to record your guide result.
            No personal data outside the visible tab is collected.
          </div>
          <div style="display:flex;gap:8px">
            <button id="ss-deny"  style="flex:1;padding:10px;border-radius:8px;
              border:1px solid rgba(255,255,255,0.2);background:transparent;color:#ccc;
              cursor:pointer;font-size:13px">No thanks</button>
            <button id="ss-allow" style="flex:1;padding:10px;border-radius:8px;
              border:none;background:#00d9ff;color:#000;cursor:pointer;
              font-size:13px;font-weight:700">Allow</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.querySelector('#ss-allow').onclick = () => { modal.remove(); resolve(true);  };
      modal.querySelector('#ss-deny').onclick  = () => { modal.remove(); resolve(false); };
    });

    if (!allowed) return null;
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'captureScreenshot' });
      return resp?.imageBase64 || null;
    } catch (e) { return null; }
  }

  async function startBehaviorTracking() {
    try {
      chrome.runtime.sendMessage({ action: 'studyTracker_start' }).catch(() => {});
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'studyTracker_start' }).catch(() => {});
      }
    } catch (e) {}

    // Also track Ctrl/Cmd+F pressed while the sidepanel has focus
    if (_sidepanelCtrlFListener) {
      window.removeEventListener('keydown', _sidepanelCtrlFListener, true);
    }
    _sidepanelCtrlFListener = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        chrome.runtime.sendMessage({ action: 'studyTracker_batch', scroll: 0, ctrlF: 1, textSelect: 0 }).catch(() => {});
      }
    };
    window.addEventListener('keydown', _sidepanelCtrlFListener, true);
  }

  async function stopBehaviorTracking() {
    if (_sidepanelCtrlFListener) {
      window.removeEventListener('keydown', _sidepanelCtrlFListener, true);
      _sidepanelCtrlFListener = null;
    }
    const out = { scroll_count: 0, ctrl_f_count: 0, text_select_count: 0, click_count: 0, mouse_move_px: 0, page_visit_count: 0, page_visit_urls: [] };
    try {
      // Flush content script batch before reading SW totals
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) {
        await chrome.tabs.sendMessage(tabs[0].id, { action: 'studyTracker_stop' }).catch(() => {});
      }
      const data = await chrome.runtime.sendMessage({ action: 'studyTracker_getData' });
      if (data) {
        out.scroll_count      = data.scroll      || 0;
        out.ctrl_f_count      = data.ctrlF       || 0;
        out.text_select_count = data.textSelect  || 0;
        out.click_count       = data.click       || 0;
        out.mouse_move_px     = data.mouseMove   || 0;
        out.page_visit_count  = (data.pages || []).length;
        out.page_visit_urls   = (data.pages || []).map(p => p.url);
      }
    } catch (e) {
      console.error('[Study] stopBehaviorTracking:', e);
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────────
  // CSV download
  // ─────────────────────────────────────────────────────────────────

  function downloadResultsCSV() {
    const cols = [
      'participant_id','block_index','task_index','task_type',
      'condition','time_ms','answer','answer_correct',
      'question_index','confidence','helpfulness','chat_turn_count','hidden_count','hide_recall','user_hidden_selectors','guide_screenshot','question_or_task',
      'scroll_count','ctrl_f_count','text_select_count','click_count','mouse_move_px','page_visit_count','page_visit_urls',
    ];
    const esc = v => {
      const str = (v === undefined || v === null) ? ''
        : Array.isArray(v) ? JSON.stringify(v)
        : String(v);
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    };
    const lines = [cols.join(',')];
    s.results.forEach(r => {
      lines.push(cols.map(c => esc(r[c])).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `study_results_${s.participantId}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─────────────────────────────────────────────────────────────────
  // Screen renderers
  // ─────────────────────────────────────────────────────────────────

  function renderWelcome() {
    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">🎓 XWebAgent User Study</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-body">
          <p class="study-intro">Welcome! This study has <strong>2 blocks × 3 tasks</strong>. You will do each task type once <em>without</em> the AI assistant, and once <em>with</em> it.</p>
          <label class="study-label" for="study-pid">Participant ID</label>
          <input class="study-input" id="study-pid" type="text" placeholder="e.g. P01" autocomplete="off">
          <div id="study-pid-error" class="study-error" style="display:none;">Please enter a participant ID.</div>
          <button class="study-btn study-btn-primary" id="study-start-btn">Start Study →</button>
        </div>
      </div>
    `);
    $('study-close').onclick = closeStudyPanel;
    $('study-start-btn').onclick = () => {
      const pid = $('study-pid').value.trim();
      if (!pid) { $('study-pid-error').style.display = ''; return; }
      $('study-pid-error').style.display = 'none';
      s.participantId = pid;
      // Determine condition order by numeric suffix (or whole string if numeric)
      const num = parseInt(pid.replace(/\D/g, ''), 10);
      const isOdd = isNaN(num) ? true : (num % 2 !== 0);
      s.conditionOrder = isOdd ? ['control', 'extension'] : ['extension', 'control'];
      sampleTasks();
      s.block = 0;
      s.taskIdx = 0;
      // Save session to Supabase (async, don't block)
      supabaseInsert('study_sessions', {
        participant_id: s.participantId,
        condition_order: s.conditionOrder.join('_then_'),
      }).then(row => { if (row) s.sessionId = row.id; });
      renderBlockIntro();
    };
    // Allow Enter key on input
    $('study-pid').onkeydown = (e) => { if (e.key === 'Enter') $('study-start-btn').click(); };
  }

  function renderBlockIntro() {
    const block = s.block;
    const condition = s.conditionOrder[block];
    const isExtension = condition === 'extension';
    const condLabel = isExtension
      ? '<span class="study-tag study-tag-ext">🤖 WITH Extension AI</span>'
      : '<span class="study-tag study-tag-ctrl">🙅 WITHOUT Extension AI</span>';
    const condNote = isExtension
      ? 'Use the <strong>XWebAgent chat</strong> to help you complete each task.'
      : 'Complete each task <strong>on your own</strong> — do not use the chat.';

    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">Block ${block + 1} of 2</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-body">
          <div class="study-condition-card">
            <div class="study-condition-label">Condition</div>
            ${condLabel}
            <p class="study-condition-note">${condNote}</p>
          </div>
          <div class="study-task-preview">
            <div class="study-task-preview-title">You will complete:</div>
            <div class="study-task-pill">🔍 Find Information (Wikipedia)</div>
            <div class="study-task-pill">📘 Follow a Guide (various sites)</div>
            <div class="study-task-pill">🙈 Hide Content</div>
          </div>
          <button class="study-btn study-btn-primary" id="study-begin-btn">Begin Block ${block + 1} →</button>
        </div>
      </div>
    `);
    $('study-close').onclick = closeStudyPanel;
    $('study-begin-btn').onclick = () => {
      s.taskIdx = 0;
      s.questionIdx = 0;
      renderTaskSetup();
    };
  }

  function renderTaskSetup() {
    const block = s.block;
    const taskIdx = s.taskIdx;
    const questionIdx = s.questionIdx;
    const taskType = TASK_TYPES[taskIdx];
    const condition = s.conditionOrder[block];
    const task = s.sampledTasks[block][taskType][questionIdx];

    if (!task) {
      setHTML(`<div class="study-screen"><div class="study-body"><p class="study-error">No task data available for ${taskType}. Please check the datasets.</p></div></div>`);
      return;
    }

    let taskUrl = '';
    let taskQuestion = '';
    let openBtnLabel = 'Open Page & Start Timer';

    if (taskType === 'find') {
      taskUrl = task.url;
      taskQuestion = task.question;
      openBtnLabel = 'Open Page & Start Timer';
    } else if (taskType === 'guide') {
      taskUrl = task.website_url;
      taskQuestion = task.task;
      openBtnLabel = `Open ${task.name || 'Website'} & Start Timer`;
    } else if (taskType === 'hide') {
      taskUrl = 'https://tin-xai.github.io/html_data/selected_hide_data/' + task.html_file;
      taskQuestion = task.hide_query;
      openBtnLabel = 'Open Page & Start Timer';
    }

    const condLabel = condition === 'extension'
      ? '<span class="study-tag study-tag-ext">🤖 WITH Extension AI</span>'
      : '<span class="study-tag study-tag-ctrl">🙅 WITHOUT Extension AI</span>';

    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">${TASK_LABELS[taskType]}</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-progress">Block ${block + 1} · ${TASK_LABELS[taskType]} · Q${questionIdx + 1}/${QUESTIONS_PER_TYPE} &nbsp;${condLabel}</div>
        <div class="study-body">
          <div class="study-task-card">
            <div class="study-task-type-badge">${TASK_LABELS[taskType]}</div>
            <p class="study-task-desc">${TASK_DESCRIPTIONS[taskType]}</p>
          </div>
          <button class="study-btn study-btn-primary" id="study-open-btn">${openBtnLabel}</button>
        </div>
      </div>
    `);
    $('study-close').onclick = closeStudyPanel;
    $('study-open-btn').onclick = async () => {
      // Reset chat so each task starts with a clean conversation
      if (typeof resetChat === 'function') resetChat(false);
      // For control hide task: set storage flag so content script auto-injects click-to-hide UI
      if (s.conditionOrder[block] === 'control' && taskType === 'hide') {
        try { await chrome.storage.local.set({ studyHideControl: { active: true, criteria: taskQuestion } }); } catch (e) {}
      }
      openTaskPage(taskUrl);

      // Replace screen with a countdown + rules view (hides the task question)
      const condLabel = s.conditionOrder[block] === 'extension'
        ? '<span class="study-tag study-tag-ext">🤖 WITH Extension AI</span>'
        : '<span class="study-tag study-tag-ctrl">🙅 WITHOUT Extension AI</span>';
      const TASK_RULES = {
        find:  '🚫 Do not use Google, ChatGPT, or any external search tools.',
        guide: '✅ You may use Google, ChatGPT, or other tools if needed.',
        hide:  '',
      };
      const ruleText = TASK_RULES[taskType] || '';
      setHTML(`
        <div class="study-screen">
          <div class="study-header">
            <span class="study-title">${TASK_LABELS[taskType]}</span>
          </div>
          <div class="study-progress">Block ${block + 1} · ${TASK_LABELS[taskType]} · Q${questionIdx + 1}/${QUESTIONS_PER_TYPE} &nbsp;${condLabel}</div>
          <div class="study-body" style="align-items:center;text-align:center;justify-content:center;gap:16px;">
            <p style="color:#aaa;font-size:14px;margin:0;">Page loading — timer starts in</p>
            <div class="study-timer-display">
              <span class="study-timer" id="study-timer" style="font-size:52px;font-weight:700;">5</span>
            </div>
            ${ruleText ? `<div style="padding:12px 16px;background:rgba(255,255,255,0.05);border-radius:8px;font-size:13px;color:#ccc;max-width:300px;line-height:1.5;">${ruleText}</div>` : ''}
          </div>
        </div>
      `);

      let countdown = 5;
      const cdInterval = setInterval(() => {
        countdown--;
        const timerEl = $('study-timer');
        if (timerEl) timerEl.textContent = countdown > 0 ? String(countdown) : 'Go!';
        if (countdown <= 0) {
          clearInterval(cdInterval);
          startTimer();
          startBehaviorTracking();
          renderTaskRunning(block, taskIdx, taskType, taskQuestion, task);
        }
      }, 1000);
    };
  }

  function renderTaskRunning(block, taskIdx, taskType, taskQuestion, task) {
    const condition = s.conditionOrder[block];

    if (condition === 'extension') {
      // Hide overlay so the chat is accessible; show a compact mini bar instead
      overlay.style.display = 'none';
      showMiniBar(block, taskIdx, taskType, taskQuestion, task);
    } else {
      // Control condition: keep overlay up so participant can't use the chat
      const condLabel = '<span class="study-tag study-tag-ctrl">🙅 WITHOUT Extension AI</span>';
      setHTML(`
        <div class="study-screen">
          <div class="study-header">
            <span class="study-title">${TASK_LABELS[taskType]}</span>
            <button class="study-close-btn" id="study-close">✕</button>
          </div>
          <div class="study-progress">Block ${block + 1} · ${TASK_LABELS[taskType]} · Q${s.questionIdx + 1}/${QUESTIONS_PER_TYPE} &nbsp;${condLabel}</div>
          <div class="study-body">
            <div class="study-task-card study-task-card-running">
              <div class="study-task-question">${escapeHTML(taskQuestion)}</div>
            </div>
            <div class="study-timer-display study-timer-running">
              <span class="study-timer-label">⏳ Remaining</span>
              <span class="study-timer" id="study-timer">03:00</span>
            </div>
            ${taskType === 'find' ? `<textarea class="study-notes-textarea" id="study-notes" placeholder="📝 Take notes here…" rows="3"></textarea>` : ''}
            <button class="study-btn study-btn-done" id="study-done-btn">I'm Done — Stop Timer</button>
          </div>
        </div>
      `);
      $('study-close').onclick = closeStudyPanel;
      $('study-done-btn').onclick = async () => {
        const elapsed = stopTimer();
        s._behaviorData = await stopBehaviorTracking();
        s._taskNotes = (overlay.querySelector('#study-notes') || {}).value || '';
        s._guideScreenshot = null;
        if (taskType === 'guide') s._guideScreenshot = await captureGuideScreenshot();
        s._chatSnap = snapshotChat();
        s._hiddenCount = 0;
        s._hideAccuracy = null;
        s._hiddenSelectors = [];
        // For control hide task: check accuracy first, then clean up click-to-hide UI
        if (taskType === 'hide') {
          try {
            await chrome.storage.local.set({ studyHideControl: { active: false } });
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0]) {
              // Check accuracy BEFORE cleanup restores element visibility
              if (task.hidden_elements && task.hidden_elements.length) {
                const accResp = await chrome.tabs.sendMessage(tabs[0].id, {
                  action: 'studyHideCheckAccuracy',
                  selectors: task.hidden_elements,
                });
                if (accResp) s._hideAccuracy = { matched: accResp.matched, total: accResp.total };
              }
              const resp = await chrome.tabs.sendMessage(tabs[0].id, { action: 'studyHideControlEnd' });
              s._hiddenCount = resp && resp.hiddenCount ? resp.hiddenCount : 0;
              s._hiddenSelectors = resp && resp.hiddenSelectors ? resp.hiddenSelectors : [];
            }
          } catch (e) {}
        }
        s.currentAnswer = null;
        s.currentPost = {};
        await lockTab();
        overlay.style.display = 'flex';
        renderTaskAnswer(block, taskIdx, taskType, task, elapsed);
      };
    }
  }

  // Slash-command prefix per task type — forces correct routing in the extension
  const TASK_PREFIX = { find: '/find', guide: '/guide', hide: '/hide' };

  function showMiniBar(block, taskIdx, taskType, taskQuestion, task) {
    const prefix = TASK_PREFIX[taskType] || '';
    const prefixedQuery = prefix ? `${prefix} ${taskQuestion}` : taskQuestion;

    miniBar.innerHTML = `
      <div class="study-mini-top">
        <span class="study-mini-label">${TASK_LABELS[taskType]} · Block ${block + 1} · Q${s.questionIdx + 1}/${QUESTIONS_PER_TYPE}</span>
        <span class="study-mini-timer" id="study-mini-timer">03:00</span>
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

    // Pre-fill the chat input with the clean task text.
    // Store the routing prefix in a data attribute so sendMessage() can apply it
    // invisibly — the prefix never appears in the input box or chat bubble.
    const chatInput = document.getElementById('xwebagent-input');
    if (chatInput) {
      chatInput.value = taskQuestion;
      if (prefix) chatInput.dataset.studyPrefix = prefix;
    }

    // Copy button copies the prefixed version so pasting into chat also routes correctly
    $('study-mini-copy').onclick = () => {
      navigator.clipboard.writeText(prefixedQuery).then(() => {
        const btn = $('study-mini-copy');
        if (btn) { btn.textContent = '✅ Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
      });
    };
    $('study-mini-done').onclick = async () => {
      const elapsed = stopTimer();
      s._behaviorData = await stopBehaviorTracking();
      s._taskNotes = ($('study-mini-notes') || {}).value || '';
      s._guideScreenshot = null;
      if (taskType === 'guide') s._guideScreenshot = await captureGuideScreenshot();
      s._chatSnap = snapshotChat();
      s._hiddenCount = 0;
      s._hideAccuracy = null;
      // For extension hide tasks: check accuracy against ground truth annotations
      if (taskType === 'hide' && task.hidden_elements && task.hidden_elements.length) {
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]) {
            const accResp = await chrome.tabs.sendMessage(tabs[0].id, {
              action: 'studyHideCheckAccuracy',
              selectors: task.hidden_elements,
            });
            if (accResp) {
              s._hideAccuracy = { matched: accResp.matched, total: accResp.total };
              s._hiddenCount = accResp.hiddenCount || 0;
            }
          }
        } catch (e) {}
      }
      hideMiniBar();
      await lockTab();
      overlay.style.display = 'flex';
      s.currentAnswer = null;
      s.currentPost = {};
      renderTaskAnswer(block, taskIdx, taskType, task, elapsed);
    };
  }

  function hideMiniBar() {
    if (miniBar) miniBar.style.display = 'none';
  }

  // ─────────────────────────────────────────────────────────────────
  // Chat snapshot (collected when Done is clicked)
  // ─────────────────────────────────────────────────────────────────

  function snapshotChat() {
    const msgs = (typeof chatMessages !== 'undefined' && Array.isArray(chatMessages))
      ? chatMessages
      : [];
    return {
      chat_turn_count: msgs.filter(m => m.type === 'user').length,
      chat_transcript: msgs.map(m => ({ role: m.type, content: m.content, ts: m.timestamp })),
    };
  }

  function renderTaskAnswer(block, taskIdx, taskType, task, elapsed) {
    const condition = s.conditionOrder[block];
    const condLabel = condition === 'extension'
      ? '<span class="study-tag study-tag-ext">🤖 WITH Extension AI</span>'
      : '<span class="study-tag study-tag-ctrl">🙅 WITHOUT Extension AI</span>';

    const taskQuestion = taskType === 'find' ? task.question
                       : taskType === 'guide' ? task.task
                       : task.hide_query;
    const questionCard = `
      <div class="study-task-card study-task-card-running" style="margin-bottom:10px;">
        <div class="study-task-question">${escapeHTML(taskQuestion)}</div>
      </div>`;

    let answerHTML = '';

    if (taskType === 'find') {
      const correct = task.short_answers;
      const distractors = (task.distractors && task.distractors.length)
        ? task.distractors.slice(0, 3)
        : getDistractors(correct, s.datasets.find, 3);
      const options = shuffle([correct, ...distractors]);
      const notesBlock = s._taskNotes ? `
        <div class="study-notes-display">
          <span class="study-notes-display-label">📝 Your notes</span>
          <p class="study-notes-display-text">${escapeHTML(s._taskNotes)}</p>
        </div>` : '';
      answerHTML = `
        ${notesBlock}
        <p class="study-question-text">Select the answer you found:</p>
        <div class="study-radio-group" id="study-answer-group">
          ${options.map((opt) => `
            <label class="study-radio-btn">
              <input type="radio" name="study-answer" value="${escapeAttr(opt)}">
              <span>${escapeHTML(opt)}</span>
            </label>
          `).join('')}
        </div>
      `;
    } else if (taskType === 'guide') {
      answerHTML = `
        <p class="study-question-text">Did you complete the task?</p>
        <div class="study-radio-group" id="study-answer-group">
          <label class="study-radio-btn"><input type="radio" name="study-answer" value="completed"><span>✅ Yes, completed successfully</span></label>
          <label class="study-radio-btn"><input type="radio" name="study-answer" value="partial"><span>⚠️ Partially completed</span></label>
          <label class="study-radio-btn"><input type="radio" name="study-answer" value="failed"><span>❌ Could not complete</span></label>
        </div>
      `;
    } else if (taskType === 'hide') {
      answerHTML = `
        <p class="study-question-text">Did you successfully hide the content?</p>
        <div class="study-radio-group" id="study-answer-group">
          <label class="study-radio-btn"><input type="radio" name="study-answer" value="completed"><span>✅ Yes, all specified content hidden</span></label>
          <label class="study-radio-btn"><input type="radio" name="study-answer" value="partial"><span>⚠️ Partially hidden</span></label>
          <label class="study-radio-btn"><input type="radio" name="study-answer" value="failed"><span>❌ Could not hide it</span></label>
        </div>
      `;
    }

    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">Answer</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-progress">Block ${block + 1} · ${TASK_LABELS[taskType]} · Q${s.questionIdx + 1}/${QUESTIONS_PER_TYPE} &nbsp;${condLabel}</div>
        <div class="study-body">
          ${questionCard}
          <div class="study-timer-display">
            <span class="study-timer-label">⏱ Time used</span>
            <span class="study-timer study-timer-stopped">${formatTime(elapsed)}</span>
          </div>
          ${answerHTML}
          <div id="study-answer-error" class="study-error" style="display:none;">Please select an answer.</div>
          <button class="study-btn study-btn-primary" id="study-submit-btn">Submit →</button>
        </div>
      </div>
    `);


    $('study-close').onclick = closeStudyPanel;
    $('study-submit-btn').onclick = () => {
      const sel = overlay.querySelector('input[name="study-answer"]:checked');
      if (!sel) { $('study-answer-error').style.display = ''; return; }
      $('study-answer-error').style.display = 'none';
      s.currentAnswer = sel.value;
      renderTaskPost(block, taskIdx, taskType, task, elapsed, sel.value);
    };
  }

  function renderTaskPost(block, taskIdx, taskType, task, elapsed, answer) {
    const condition = s.conditionOrder[block];
    const isExtension = condition === 'extension';

    const helpHTML = isExtension ? `
      <p class="study-question-text" style="margin-top:16px;">How helpful was the XWebAgent assistant?</p>
      <div class="study-radio-group" id="study-help-group">
        <label class="study-radio-btn"><input type="radio" name="study-help" value="very"><span>⭐⭐⭐ Very helpful</span></label>
        <label class="study-radio-btn"><input type="radio" name="study-help" value="somewhat"><span>⭐⭐ Somewhat helpful</span></label>
        <label class="study-radio-btn"><input type="radio" name="study-help" value="not"><span>⭐ Not helpful</span></label>
        <label class="study-radio-btn"><input type="radio" name="study-help" value="unused"><span>🚫 I didn't use it</span></label>
      </div>
    ` : '';

    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">Quick Questions</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-body">
          <p class="study-question-text">How confident were you in your answer / completion?</p>
          <div class="study-radio-group" id="study-conf-group">
            <label class="study-radio-btn"><input type="radio" name="study-conf" value="very"><span>😎 Very confident</span></label>
            <label class="study-radio-btn"><input type="radio" name="study-conf" value="somewhat"><span>🙂 Somewhat confident</span></label>
            <label class="study-radio-btn"><input type="radio" name="study-conf" value="notsure"><span>😐 Not sure</span></label>
            <label class="study-radio-btn"><input type="radio" name="study-conf" value="guessed"><span>🤷 Just guessing</span></label>
          </div>
          ${helpHTML}
          <div id="study-post-error" class="study-error" style="display:none;">Please answer all questions.</div>
          <button class="study-btn study-btn-primary" id="study-next-btn">${
            s.questionIdx < QUESTIONS_PER_TYPE - 1 ? `Next Question → (${s.questionIdx + 2}/${QUESTIONS_PER_TYPE})` :
            taskIdx < 2 ? 'Next Task →' : 'Finish Block'
          }</button>
        </div>
      </div>
    `);
    $('study-close').onclick = closeStudyPanel;
    $('study-next-btn').onclick = () => {
      const confSel = overlay.querySelector('input[name="study-conf"]:checked');
      const helpSel = overlay.querySelector('input[name="study-help"]:checked');
      if (!confSel || (isExtension && !helpSel)) {
        $('study-post-error').style.display = '';
        return;
      }
      $('study-post-error').style.display = 'none';

      // Determine correct answer for find task
      let answerCorrect = undefined;
      if (taskType === 'find') {
        answerCorrect = answer.toLowerCase().trim() === (task.short_answers || '').toLowerCase().trim();
      }

      // Build question_or_task summary for CSV
      let questionOrTask = '';
      if (taskType === 'find') questionOrTask = task.question;
      else if (taskType === 'guide') questionOrTask = task.task;
      else if (taskType === 'hide') questionOrTask = task.hide_query;

      const snap = s._chatSnap || { chat_turn_count: 0, chat_transcript: [] };
      s._chatSnap = null;
      const beh = s._behaviorData || {};
      s._behaviorData = null;
      const hideAcc = s._hideAccuracy;
      s._hideAccuracy = null;
      const hiddenSelectors = s._hiddenSelectors || [];
      s._hiddenSelectors = [];
      const guideScreenshot = s._guideScreenshot || null;
      s._guideScreenshot = null;
      const questionIdx = s.questionIdx; // capture before advancing

      const result = {
        participant_id:   s.participantId,
        session_id:       s.sessionId,
        block_index:      block,
        task_index:       taskIdx,
        question_index:   questionIdx,
        task_type:        taskType,
        condition:        condition,
        time_ms:          elapsed,
        answer:           answer,
        answer_correct:   answerCorrect,
        confidence:       confSel.value,
        helpfulness:      helpSel ? helpSel.value : null,
        chat_turn_count:  snap.chat_turn_count,
        chat_transcript:  snap.chat_transcript,
        hidden_count:           s._hiddenCount || 0,
        hide_recall:            hideAcc ? parseFloat((hideAcc.matched / hideAcc.total).toFixed(3)) : null,
        user_hidden_selectors:  hiddenSelectors,
        guide_screenshot:       guideScreenshot,
        task_data:         task,
        question_or_task:  questionOrTask,
        scroll_count:      beh.scroll_count      || 0,
        ctrl_f_count:      beh.ctrl_f_count      || 0,
        text_select_count: beh.text_select_count || 0,
        click_count:       beh.click_count       || 0,
        mouse_move_px:     beh.mouse_move_px     || 0,
        page_visit_count:  beh.page_visit_count  || 0,
        page_visit_urls:   beh.page_visit_urls   || [],
      };
      s.results.push(result);

      // Save to Supabase async
      const supaData = { ...result };
      delete supaData.task_data;
      supaData.task_data = task; // will be serialised as JSONB
      supabaseInsert('study_task_results', supaData);

      // Advance: question within type → type → block
      if (s.questionIdx < QUESTIONS_PER_TYPE - 1) {
        s.questionIdx++;
        renderTaskSetup();
      } else if (taskIdx < 2) {
        s.questionIdx = 0;
        s.taskIdx = taskIdx + 1;
        renderTaskSetup();
      } else {
        s.questionIdx = 0;
        renderBlockDone(block);
      }
    };
  }

  function renderBlockDone(block) {
    const blockResults = s.results.filter(r => r.block_index === block);
    const rows = blockResults.map(r => {
      let correctDisplay;
      if (r.task_type === 'find') {
        correctDisplay = r.answer_correct === true ? '✅' : r.answer_correct === false ? '❌' : '—';
      } else if (r.task_type === 'hide' && r.hide_recall != null) {
        correctDisplay = Math.round(r.hide_recall * 100) + '% recall';
      } else {
        correctDisplay = '—';
      }
      return `
        <tr>
          <td>${TASK_LABELS[r.task_type]}</td>
          <td>${formatTime(r.time_ms)}</td>
          <td>${r.answer || '—'}</td>
          <td>${correctDisplay}</td>
        </tr>
      `;
    }).join('');

    const isLastBlock = block === 1;

    const hideResults = blockResults.filter(r => r.task_type === 'hide' && r.hide_recall != null);
    const avgAccHTML = hideResults.length ? (() => {
      const avg = hideResults.reduce((sum, r) => sum + r.hide_recall, 0) / hideResults.length;
      return `
        <div style="background:rgba(0,217,255,0.07);border:1px solid rgba(0,217,255,0.25);border-radius:10px;padding:10px 14px;margin-top:12px;">
          <div style="font-size:11px;font-weight:700;color:rgba(0,217,255,0.7);text-transform:uppercase;letter-spacing:0.06em;">🎯 Hide Task — Avg Accuracy</div>
          <p style="margin:4px 0 0;font-size:14px;color:rgba(255,255,255,0.9);">${Math.round(avg * 100)}% <span style="font-size:12px;color:#aaa;">(across ${hideResults.length} question${hideResults.length > 1 ? 's' : ''})</span></p>
        </div>`;
    })() : '';

    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">Block ${block + 1} Complete!</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-body">
          <table class="study-results-table">
            <thead><tr><th>Task</th><th>Time</th><th>Answer</th><th>Correct</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          ${avgAccHTML}
          ${isLastBlock
            ? '<button class="study-btn study-btn-primary" id="study-final-btn">Finish Study →</button>'
            : '<button class="study-btn study-btn-primary" id="study-next-block-btn">Begin Block 2 →</button>'
          }
        </div>
      </div>
    `);
    $('study-close').onclick = closeStudyPanel;
    if (isLastBlock) {
      $('study-final-btn').onclick = () => renderStudyComplete();
    } else {
      $('study-next-block-btn').onclick = () => {
        s.block = 1;
        s.taskIdx = 0;
        s.questionIdx = 0;
        renderBlockIntro();
      };
    }
  }

  function renderStudyComplete() {
    const supaConfigured = SUPABASE_URL && !SUPABASE_URL.includes('YOUR_PROJECT');
    const saveStatusHTML = supaConfigured
      ? '<p class="study-save-status" style="color:#4caf50;">✅ Results saved to Supabase after each task.</p>'
      : '<p class="study-save-notice">⚠️ Supabase not configured — download the CSV to keep your results.</p>';

    setHTML(`
      <div class="study-screen">
        <div class="study-header">
          <span class="study-title">Study Complete!</span>
          <button class="study-close-btn" id="study-close">✕</button>
        </div>
        <div class="study-body">
          <div class="study-complete-msg">
            <div class="study-complete-emoji">🎉</div>
            <p>Thank you, <strong>${escapeHTML(s.participantId)}</strong>!</p>
            <p>You completed all 6 tasks across 2 conditions.</p>
            ${saveStatusHTML}
          </div>
          <button class="study-btn study-btn-primary" id="study-download-btn">⬇️ Download Results CSV</button>
          <button class="study-btn study-btn-secondary" id="study-close-final">Close Panel</button>
        </div>
      </div>
    `);
    $('study-close').onclick = closeStudyPanel;
    $('study-download-btn').onclick = downloadResultsCSV;
    $('study-close-final').onclick = closeStudyPanel;
  }

  // ─────────────────────────────────────────────────────────────────
  // Escape helpers
  // ─────────────────────────────────────────────────────────────────

  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(str) {
    return escapeHTML(str);
  }


  // ─────────────────────────────────────────────────────────────────
  // Open / Close
  // ─────────────────────────────────────────────────────────────────

  async function openStudyPanel() {
    if (!overlay) return;
    // Save current SOM state then disable it for the study
    try {
      const stored = await chrome.storage.sync.get('somEnabled');
      s._prevSom = stored.somEnabled;
      await chrome.storage.sync.set({ somEnabled: false });
    } catch (e) {}
    overlay.style.display = 'flex';
    s.open = true;
    renderWelcome();
  }

  async function closeStudyPanel() {
    if (!overlay) return;
    overlay.style.display = 'none';
    hideMiniBar();
    s.open = false;
    stopTimer();
    // Restore SOM to whatever it was before the study
    try {
      await chrome.storage.sync.set({ somEnabled: s._prevSom === true });
    } catch (e) {}
    // Clear any lingering hide-control flag (in case study is closed mid-task)
    try { await chrome.storage.local.set({ studyHideControl: { active: false } }); } catch (e) {}
  }

  // ─────────────────────────────────────────────────────────────────
  // Init
  // ─────────────────────────────────────────────────────────────────

  async function init() {
    overlay  = $('study-overlay');
    miniBar  = $('study-mini-bar');
    if (!overlay) return;
    await loadDatasets();
    // Wire the header button
    const btn = $('study-header-btn');
    if (btn) btn.onclick = openStudyPanel;
  }

  document.addEventListener('DOMContentLoaded', init);

  // Public API
  window.openStudyPanel  = openStudyPanel;
  window.closeStudyPanel = closeStudyPanel;

})();
