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

  const QUESTIONS_PER_TYPE = 2;         // questions per task type per block
  const TASK_TIME_LIMIT_MS = 3 * 60 * 1000; // 3-minute countdown per question

  const s = {
    participantId: '',
    sessionId: null,
    conditionOrder: [],   // 6-entry array, one condition per task in taskSequence
    taskSequence: [],     // [{taskType, questionIdx}, …] — 6 entries
    seqIdx: 0,            // current position in taskSequence (0-5)
    datasets: { find: [], guide: [], hide: [] },
    sampledTasks: [
      { find: [], guide: [], hide: [] },  // block 0 — arrays of QUESTIONS_PER_TYPE
    ],
    results: [],          // all collected task results
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

  // Returns the deduplication key (website) for a task entry.
  function taskSiteKey(type, task) {
    if (type === 'find')  return task.url || '';
    if (type === 'guide') return task.website_url || '';
    if (type === 'hide')  return task.html_file || '';
    return '';
  }

  // Deterministic task selection: participant N gets a rolling 3-task slice.
  // offset = ((N-1) * 3) % poolSize  →  gcd(3,10)=1 so all 10 offsets are hit
  // across 10 consecutive participants, giving fair coverage with no randomness.
  // Within each feature, no two selected questions share the same website.
  function sampleTasks(N) {
    TASK_TYPES.forEach(type => {
      const pool = s.datasets[type];
      if (!pool.length) return;
      const offset = ((N - 1) * QUESTIONS_PER_TYPE) % pool.length;
      const tasks = [];
      const seenSites = new Set();
      for (let i = 0; i < pool.length && tasks.length < QUESTIONS_PER_TYPE; i++) {
        const task = pool[(offset + i) % pool.length];
        const site = taskSiteKey(type, task);
        if (!seenSites.has(site)) {
          seenSites.add(site);
          tasks.push(task);
        }
      }
      s.sampledTasks[0][type] = tasks;
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
    const out = { scroll_user_count: 0, scroll_agent_count: 0, ctrl_f_count: 0, text_select_count: 0, click_count: 0, mouse_move_px: 0, agent_think_ms: [], page_visit_count: 0, page_visit_urls: [] };
    try {
      // Flush content script batch before reading SW totals
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) {
        await chrome.tabs.sendMessage(tabs[0].id, { action: 'studyTracker_stop' }).catch(() => {});
      }
      const data = await chrome.runtime.sendMessage({ action: 'studyTracker_getData' });
      if (data) {
        out.scroll_user_count  = data.scrollUser   || 0;
        out.scroll_agent_count = data.scrollAgent  || 0;
        out.ctrl_f_count       = data.ctrlF        || 0;
        out.text_select_count  = data.textSelect   || 0;
        out.click_count        = data.click        || 0;
        out.mouse_move_px      = data.mouseMove    || 0;
        out.agent_think_ms     = data.agentThinkMs || [];
        out.page_visit_count   = (data.pages || []).length;
        out.page_visit_urls    = (data.pages || []).map(p => p.url);
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
      'scroll_user_count','scroll_agent_count','ctrl_f_count','text_select_count','click_count','mouse_move_px','agent_think_ms','page_visit_count','page_visit_urls',
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
          <p class="study-intro">Welcome! You will complete <strong>6 tasks</strong> across 3 feature types: Find, Guide, and Hide.</p>
          <div id="study-pid-error" class="study-error" style="display:none;"></div>
          <button class="study-btn study-btn-primary" id="study-start-btn">Start Study →</button>
        </div>
      </div>
    `);
    $('study-close').onclick = closeStudyPanel;
    $('study-start-btn').onclick = async () => {
      const name = 'Anon';
      $('study-pid-error').style.display = 'none';

      const btn = $('study-start-btn');
      btn.disabled = true;
      btn.textContent = 'Starting…';

      // If datasets didn't load at init time (e.g. sidepanel opened before SW ready), retry now.
      if (!s.datasets.find.length || !s.datasets.guide.length || !s.datasets.hide.length) {
        await loadDatasets();
      }
      if (!s.datasets.find.length || !s.datasets.guide.length || !s.datasets.hide.length) {
        $('study-pid-error').textContent = 'Could not load task data. Please reload the extension and try again.';
        $('study-pid-error').style.display = '';
        btn.disabled = false;
        btn.textContent = 'Start Study →';
        return;
      }

      s.participantId = name;

      // Insert session first to get an atomic, globally-unique participant number (N = row.id).
      // Two simultaneous inserts always get different IDs from Postgres serial, preventing
      // condition/task collisions even if two users start at the same time.
      const row = await supabaseInsert('study_sessions', {
        participant_id: name,
        condition_order: 'pending',
      });

      let N;
      if (row && row.id) {
        N = row.id;
        s.sessionId = row.id;
      } else {
        // Fallback when Supabase is not configured: local counter
        const localN = parseInt(localStorage.getItem('xwa_study_n') || '0', 10) + 1;
        localStorage.setItem('xwa_study_n', String(localN));
        N = localN;
      }

      // Each participant alternates which condition comes first (odd vs even N).
      // For every feature type the participant does one task control + one task extension.
      const condFirst  = N % 2 === 0 ? 'control' : 'extension';
      const condSecond = condFirst === 'control' ? 'extension' : 'control';
      // 6 tasks: find×2, guide×2, hide×2 — each pair is condFirst then condSecond
      s.conditionOrder = [condFirst, condSecond, condFirst, condSecond, condFirst, condSecond];
      s.taskSequence = [
        { taskType: 'find',  questionIdx: 0 },
        { taskType: 'find',  questionIdx: 1 },
        { taskType: 'guide', questionIdx: 0 },
        { taskType: 'guide', questionIdx: 1 },
        { taskType: 'hide',  questionIdx: 0 },
        { taskType: 'hide',  questionIdx: 1 },
      ];

      // Update session row with resolved condition order (fire and forget)
      if (row && row.id && SUPABASE_URL && !SUPABASE_URL.includes('YOUR_PROJECT')) {
        fetch(`${SUPABASE_URL}/rest/v1/study_sessions?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ condition_order: `${condFirst},${condSecond}` }),
        }).catch(() => {});
      }

      sampleTasks(N);
      s.seqIdx = 0;
      renderTaskSetup();
    };
  }

  function renderTaskSetup() {
    const seqIdx     = s.seqIdx;
    const seqEntry   = s.taskSequence[seqIdx];
    const taskType   = seqEntry.taskType;
    const questionIdx = seqEntry.questionIdx;
    const condition  = s.conditionOrder[seqIdx];
    const task       = s.sampledTasks[0][taskType][questionIdx];

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
        <div class="study-progress">Task ${seqIdx + 1}/6 · ${TASK_LABELS[taskType]} &nbsp;${condLabel}</div>
        <div class="study-body">
          <div class="study-task-card">
            <div class="study-task-type-badge">${TASK_LABELS[taskType]}</div>
            <p class="study-task-desc">${
              taskType === 'hide' && condition === 'control'
                ? 'Hover over any element on the page — a 🙈 hide icon will appear. Click it to hide that element. Repeat until all specified content is hidden.'
                : TASK_DESCRIPTIONS[taskType]
            }</p>
          </div>
          <div style="padding:12px 14px;background:rgba(255,200,0,0.08);border:1px solid rgba(255,200,0,0.3);border-radius:8px;font-size:12px;color:#e0c97f;line-height:1.6;margin-bottom:4px;">
            <div style="font-weight:700;margin-bottom:4px;">⚠️ Important Reminders</div>
            <div>• Once in the experiment, please <strong>DO NOT use the Back button</strong>, or close the window.</div>
            <div>• Please <strong>DO NOT randomly click on the choices</strong> — it will bias the study results.</div>
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
      if (condition === 'control' && taskType === 'hide') {
        try { await chrome.storage.local.set({ studyHideControl: { active: true, criteria: taskQuestion } }); } catch (e) {}
      }
      openTaskPage(taskUrl);

      // Replace screen with a countdown + rules view (hides the task question)
      const condLabel = condition === 'extension'
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
          <div class="study-progress">Task ${seqIdx + 1}/6 · ${TASK_LABELS[taskType]} &nbsp;${condLabel}</div>
          <div class="study-body" style="align-items:center;text-align:center;justify-content:center;gap:16px;">
            <p style="color:#aaa;font-size:14px;margin:0;">Loading the website… timer starts in</p>
            <div class="study-timer-display">
              <span class="study-timer" id="study-timer" style="font-size:52px;font-weight:700;">5</span>
            </div>
            <div style="font-size:11px;color:#555;word-break:break-all;max-width:100%;padding:0 8px;line-height:1.4;">
              ${escapeHTML(taskUrl)}
            </div>
            <div id="study-load-fail" style="display:none;padding:10px 14px;background:rgba(248,113,113,0.1);
                 border:1px solid rgba(248,113,113,0.3);border-radius:8px;text-align:center;">
              <p style="margin:0 0 8px;color:#f87171;font-size:13px;">The page didn't load?</p>
              <button id="study-load-manually-btn"
                      style="padding:7px 16px;border:none;border-radius:6px;
                             background:#f87171;color:#fff;font-size:13px;font-weight:600;
                             cursor:pointer;">
                Load manually →
              </button>
            </div>
            ${ruleText ? `<div style="padding:12px 16px;background:rgba(255,255,255,0.05);border-radius:8px;font-size:13px;color:#ccc;max-width:300px;line-height:1.5;">${ruleText}</div>` : ''}
          </div>
        </div>
      `);

      // Show "Load manually" if the tab ends up on an error page
      try {
        const _loadTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (_loadTabs[0]) {
          const _tabId = _loadTabs[0].id;
          const _tabLoadListener = (tid, changeInfo, tab) => {
            if (tid !== _tabId) return;
            if (changeInfo.status !== 'complete') return;
            chrome.tabs.onUpdated.removeListener(_tabLoadListener);
            const isError = tab.url && (
              tab.url.startsWith('chrome-error://') ||
              tab.url.startsWith('about:') ||
              tab.url.includes('net::ERR_')
            );
            if (isError) {
              const failDiv = $('study-load-fail');
              if (failDiv) failDiv.style.display = 'block';
            }
          };
          chrome.tabs.onUpdated.addListener(_tabLoadListener);
          // Also reveal the button after 8 s as a safety net
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(_tabLoadListener);
            const failDiv = $('study-load-fail');
            if (failDiv && failDiv.style.display === 'none') failDiv.style.display = 'block';
          }, 8000);
        }
      } catch (e) {}

      // Wire up the manual load button (may be clicked before countdown finishes)
      overlay.addEventListener('click', function _manualLoadHandler(e) {
        if (e.target && e.target.id === 'study-load-manually-btn') {
          openTaskPage(taskUrl);
          overlay.removeEventListener('click', _manualLoadHandler);
          const failDiv = $('study-load-fail');
          if (failDiv) failDiv.style.display = 'none';
        }
      });

      let countdown = 5;
      const cdInterval = setInterval(() => {
        countdown--;
        const timerEl = $('study-timer');
        if (timerEl) timerEl.textContent = countdown > 0 ? String(countdown) : 'Go!';
        if (countdown <= 0) {
          clearInterval(cdInterval);
          startTimer();
          startBehaviorTracking();
          renderTaskRunning(seqIdx, taskType, taskQuestion, task);
        }
      }, 1000);
    };
  }

  function renderTaskRunning(block, taskType, taskQuestion, task) {
    const condition = s.conditionOrder[block];

    if (condition === 'extension') {
      // Hide overlay so the chat is accessible; show a compact mini bar instead
      overlay.style.display = 'none';
      showMiniBar(block, taskType, taskQuestion, task);
    } else {
      // Control condition: keep overlay up so participant can't use the chat
      const condLabel = '<span class="study-tag study-tag-ctrl">🙅 WITHOUT Extension AI</span>';
      setHTML(`
        <div class="study-screen">
          <div class="study-header">
            <span class="study-title">${TASK_LABELS[taskType]}</span>
            <button class="study-close-btn" id="study-close">✕</button>
          </div>
          <div class="study-progress">Task ${block + 1}/6 · ${TASK_LABELS[taskType]} &nbsp;${condLabel}</div>
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
        const doneBtn = $('study-done-btn');
        if (doneBtn) { doneBtn.disabled = true; doneBtn.textContent = 'Processing…'; }
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
        renderTaskAnswer(block, taskType, task, elapsed);
      };
    }
  }

  // Slash-command prefix per task type — forces correct routing in the extension
  const TASK_PREFIX = { find: '/find', guide: '/guide', hide: '/hide' };

  function showMiniBar(block, taskType, taskQuestion, task) {
    const prefix = TASK_PREFIX[taskType] || '';
    const prefixedQuery = prefix ? `${prefix} ${taskQuestion}` : taskQuestion;

    miniBar.innerHTML = `
      <div class="study-mini-top">
        <span class="study-mini-label">Task ${block + 1}/6 · ${TASK_LABELS[taskType]}</span>
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
      const miniDoneBtn = $('study-mini-done');
      if (miniDoneBtn) { miniDoneBtn.disabled = true; miniDoneBtn.textContent = '⏳ Processing…'; }
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
      renderTaskAnswer(block, taskType, task, elapsed);
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

  function renderTaskAnswer(block, taskType, task, elapsed) {
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
        <div class="study-progress">Task ${block + 1}/6 · ${TASK_LABELS[taskType]} &nbsp;${condLabel}</div>
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
      renderTaskPost(block, taskType, task, elapsed, sel.value);
    };
  }

  function renderTaskPost(block, taskType, task, elapsed, answer) {
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
            block < s.taskSequence.length - 1 ? 'Next Task →' : 'Finish Study'
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
      const result = {
        participant_id:   s.participantId,
        session_id:       s.sessionId,
        block_index:      block,
        task_index:       TASK_TYPES.indexOf(taskType),
        question_index:   s.taskSequence[block].questionIdx,
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
        scroll_user_count:  beh.scroll_user_count  || 0,
        scroll_agent_count: beh.scroll_agent_count || 0,
        ctrl_f_count:       beh.ctrl_f_count       || 0,
        text_select_count:  beh.text_select_count  || 0,
        click_count:        beh.click_count        || 0,
        mouse_move_px:      beh.mouse_move_px      || 0,
        agent_think_ms:     beh.agent_think_ms     || [],
        page_visit_count:   beh.page_visit_count   || 0,
        page_visit_urls:    beh.page_visit_urls    || [],
      };
      s.results.push(result);

      // Save to Supabase async
      const supaData = { ...result };
      delete supaData.task_data;
      supaData.task_data = task; // will be serialised as JSONB
      supabaseInsert('study_task_results', supaData);

      // Advance to next task, or finish
      s.seqIdx++;
      if (s.seqIdx < s.taskSequence.length) {
        renderTaskSetup();
      } else {
        renderStudyComplete();
      }
    };
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
            <p>You completed all 6 tasks across 3 feature types.</p>
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
