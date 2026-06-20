// PageGuide Side Panel Script
// Handles chat UI and communicates with content scripts

let chatMessages = [];
let conversationHistory = []; // Stores {role: 'user'|'assistant', content: string, hasImage?: boolean}
let currentTabId = null;
let uploadedImageBase64 = null; // Stores the uploaded image
let hasImageInConversation = false; // Track if image was used in conversation
let uploadedFileContent = null; // Text content of an attached file
let uploadedFileName = null;    // Display name of the attached file
let currentSelectedText = null; // Stores text selected on the webpage
let guideActive = false; // True while guide is generating steps (shows stop button)
let guidePaused = false; // True when an active guide is paused and can be resumed
let noPageContext = false; // When true, skip page scraping and answer from AI knowledge only
let panelForcedMode = null; // Sticky route chosen by Find / Guide / Hide tabs; null = Auto
let panelLastRoute = null;  // Last route returned by the router, used only for tab highlight
let currentGoal = null;
let currentGuidePlan = [];
let currentGuideTitle = '';
let currentGuideStep = 0;
let currentGuideRecords = [];
let currentGuideInitial = null; // Phase 1: the "Initial state" node (step 0), kept out of the dot count
let currentGuideVerifications = {};
let currentGuideWarnings = {};
let panelRunning = false;        // True while the agent is generating (send button shows Stop)
let cancelRequested = false;     // Set when the user hits Stop during a non-guide run
let guideStopped = false;        // True after Stop: drop late "still working" messages from an
                                 // in-flight content script until a new send / user-initiated steer
const _journeyBtnSessions = new Set(); // Guide sessions that already have a "View journey" button
const _journeysBySession = {}; // sessionId -> { title, steps:[meta] } accumulated from guideStepRecord
let visibleJourneySessionId = null;
let visibleJourneyTitle = '';
let visibleJourneyRecalled = false;
let currentTreeScale = 1.0;
let isPanning = false;
let startX = 0;
let startY = 0;
let scrollLeft = 0;
let scrollTop = 0;
let wasDragging = false;

// Per-tab chat sessions so switching back to a tab restores its conversation.
// Keys are tab IDs; values are { chatMessages, conversationHistory, hasImageInConversation, html }.
// Cleared when the tab is closed, navigates to a new URL, or the user manually resets.
const _tabSessions = new Map();
const _hiddenTabChips = new Set();

// Open a persistent port to the service worker.
// When the panel is closed (by any means — X button, keyboard shortcut, etc.)
// the port disconnects and the service worker's onDisconnect handler fires reliably,
// clearing the page highlights. This is more reliable than beforeunload + sendMessage.
chrome.runtime.connect({ name: 'sidepanel' });

const ROUTE_ICONS = { ask: '🔍', find: '🔍', guide: '🔒', hide: '🙈', image_ask: '🖼️', pdf_ask: '📄', pdf_viewer: '📄' };
const UI_ICONS = {
  attach: '<span class="pageguide-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.4 11.6-8.8 8.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg></span>',
  image: '<span class="pageguide-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10.5" r="1.5"/><path d="m21 15-5-5L5 19"/></svg></span>',
  file: '<span class="pageguide-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg></span>',
  globe: '<span class="pageguide-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20"/><path d="M12 2a15 15 0 0 0 0 20"/></svg></span>',
  pageOff: '<span class="pageguide-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18"/><path d="M10.6 2.2A10 10 0 0 1 21.8 13.4"/><path d="M13.4 21.8A10 10 0 0 1 2.2 10.6"/><path d="M2 12h10"/><path d="M12 2a15 15 0 0 1 2.3 9.8"/></svg></span>',
  bolt: '<span class="pageguide-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7Z"/></svg></span>',
  hand: '<span class="pageguide-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 11V7a2 2 0 0 0-4 0v4"/><path d="M14 10V5a2 2 0 0 0-4 0v7"/><path d="M10 11V6a2 2 0 0 0-4 0v8"/><path d="M6 14v-2a2 2 0 0 0-4 0v3a7 7 0 0 0 7 7h4a7 7 0 0 0 7-7v-4a2 2 0 0 0-2-2Z"/></svg></span>',
  quote: '<span class="pageguide-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10"/><path d="M7 12h7"/><path d="M5 20h14"/><path d="M4 4h16v12H4z"/></svg></span>',
  gauge: '<span class="pageguide-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a4 4 0 1 0-4-4"/><path d="M12 14v-4"/><path d="M3 21a9 9 0 0 1 18 0"/></svg></span>'
};

function _truncateText(text, max = 72) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function _tabChipFallbackIcon() {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#7857ff"/><path d="M7 7h10v10H7z" fill="white" opacity=".9"/></svg>'
  );
}

function hideWorkingTabChip() {
  if (currentTabId != null) _hiddenTabChips.add(currentTabId);
  const chip = document.getElementById('pageguide-tab-chip');
  if (chip) chip.style.display = 'none';
}

function renderWorkingTabChip(tab) {
  const chip = document.getElementById('pageguide-tab-chip');
  if (!chip || !tab || _hiddenTabChips.has(tab.id)) {
    if (chip) chip.style.display = 'none';
    return;
  }
  const title = tab.title || tab.url || 'Current tab';
  const url = tab.url || '';
  const favicon = document.getElementById('pageguide-tab-chip-favicon');
  const label = document.getElementById('pageguide-tab-chip-title');
  if (favicon) {
    favicon.src = tab.favIconUrl || _tabChipFallbackIcon();
    favicon.style.display = '';
  }
  if (label) label.textContent = `Working on “${_truncateText(title, 58)}”`;
  chip.title = [title, url].filter(Boolean).join('\n');
  chip.style.display = '';
}

async function refreshWorkingTabChip(tabId = currentTabId) {
  try {
    let tab = null;
    if (tabId != null && chrome.tabs?.get) {
      try { tab = await chrome.tabs.get(tabId); } catch (e) {}
    }
    if (!tab) {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = active || null;
      if (tab?.id != null) currentTabId = tab.id;
    }
    renderWorkingTabChip(tab);
  } catch (e) {
    const chip = document.getElementById('pageguide-tab-chip');
    if (chip) chip.style.display = 'none';
  }
}

function _normalizeRouteForTab(route) {
  if (route === 'image_ask' || route === 'pdf_ask' || route === 'pdf_viewer') return 'ask';
  if (route === 'protection') return 'hide';
  return route;
}

function updateRouteTabs() {
  // Route tabs were removed from the visible UI; routing stays automatic, with
  // slash commands still able to force a route for one message.
}

function getGuideStepMeta(step) {
  return currentGuideRecords.find(r => Number(r.step) === Number(step) || Number(r.planStep) === Number(step)) || null;
}

function getGuideStepLabel(step) {
  const meta = getGuideStepMeta(step);
  const plan = currentGuidePlan.find(p => Number(p.n) === Number(step));
  return meta?.instruction || plan?.goal || `Step ${step}`;
}

function hideGoalStepPreview() {
  document.getElementById('pageguide-goal-step-preview')?.remove();
}

function closeMemoryShotLightbox() {
  document.getElementById('pageguide-memory-shot-lightbox')?.remove();
}

function openMemoryShotLightbox(base64, title = 'Before action — what PageGuide saw before this step') {
  if (!base64) return;
  closeMemoryShotLightbox();
  const overlay = document.createElement('div');
  overlay.id = 'pageguide-memory-shot-lightbox';
  overlay.className = 'pageguide-memory-shot-lightbox';
  overlay.innerHTML = `
    <div class="pageguide-memory-shot-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="pageguide-memory-shot-head">
        <span>${escapeHtml(title)}</span>
        <button type="button" class="pageguide-memory-shot-close" aria-label="Close screenshot preview">×</button>
      </div>
      <img src="data:image/jpeg;base64,${base64}" alt="${escapeHtml(title)}">
    </div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.pageguide-memory-shot-close')) closeMemoryShotLightbox();
  });
  document.body.appendChild(overlay);
}

// Compute all three confidence formula versions for a step from its stored LLM signals
// (grounded/loop/progress). Pure — no LLM call — so Full vs No-progress vs No-loop can be compared
// at a glance. Returns { full, reduced, noloop } (each 0..1 or null), or null when no signals.
function _dualConfidence(rec) {
  if (!rec || typeof gv2ComputeConfidence !== 'function') return null;
  if (rec.grounded == null && rec.loop == null && rec.progress == null) return null;
  const signals = { grounded: rec.grounded, loop: rec.loop, progress: rec.progress };
  const full = gv2ComputeConfidence(signals, 'full').confidence;
  const reduced = gv2ComputeConfidence(signals, 'reduced').confidence;
  const noloop = gv2ComputeConfidence(signals, 'noloop').confidence;
  if (full == null && reduced == null && noloop == null) return null;
  return { full, reduced, noloop };
}

async function showGoalStepPreview(step, anchor) {
  hideGoalStepPreview();
  const isInitialNode = Number(step) === 0;
  const meta = isInitialNode ? currentGuideInitial : getGuideStepMeta(step);
  const label = isInitialNode ? 'Initial state' : getGuideStepLabel(step);
  let rec = null;
  try {
    if (meta && typeof rewindGetRecord === 'function') {
      rec = await rewindGetRecord(meta.sessionId, meta.step != null ? meta.step : (isInitialNode ? 0 : step));
    }
  } catch (e) {}

  // Confidence status (green ≥70%, yellow <70%) — no red for confidence.
  const conf = meta?.confidence;
  const tier = (typeof gv2ConfidenceTier === 'function') ? gv2ConfidenceTier(conf) : null;
  // Confidence pinned to the top-left corner of the card.
  const confHtml = (tier && conf != null)
    ? `<div class="pageguide-goal-step-conf ${tier === 'high' ? 'conf-high' : 'conf-med'}">Confidence: ${Math.round(conf * 100)}%</div>`
    : '';
  // Debug-only: all three formula versions side by side (Full / No-progress / No-loop).
  const dual = window.__pgDebugEnabled ? _dualConfidence(meta) : null;
  const pctOf = (c) => (c != null) ? Math.round(c * 100) + '%' : '—';
  const dualHtml = dual
    ? `<div class="pageguide-goal-step-dual">🐞 Full: <b>${pctOf(dual.full)}</b> · No-progress: <b>${pctOf(dual.reduced)}</b> · No-loop: <b>${pctOf(dual.noloop)}</b></div>`
    : '';
  const url = meta?.url || rec?.url || '';
  // Show the URL as a compact "link" hyperlink rather than the full (often long) address.
  const urlHtml = url ? `<a class="pageguide-goal-step-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="${escapeHtml(url)}">🔗 link</a>` : '';
  const allowSteer = !!meta && !isInitialNode;

  // Card layout: the REGION-around-the-target crop is the picture on top; the full BEFORE-action
  // screenshot is tucked into a collapsible below it. (Falls back to the before-shot on top when
  // there's no region crop — e.g. the initial-state node.) The AFTER-action shot is in "Inspect more".
  const PLACEHOLDER_SHOT = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  let beforeShot = rec?.screenshotBefore || rec?.screenshot || null;
  if (beforeShot === PLACEHOLDER_SHOT) beforeShot = null;
  let regionShot = rec?.regionShot || null;
  if (regionShot === PLACEHOLDER_SHOT) regionShot = null;
  const topShot = regionShot || beforeShot;
  const topImg = topShot
    ? `<img src="data:image/jpeg;base64,${topShot}" alt="" ${(!regionShot && beforeShot) ? 'class="pageguide-memory-shot-trigger" data-shot-kind="before"' : ''}>`
    : '<div class="pageguide-goal-step-preview-empty">No screenshot yet</div>';
  // Only show the collapsible before-shot when it isn't already the top image.
  const beforeHtml = (beforeShot && regionShot)
    ? `<details class="pageguide-goal-step-before"><summary>Before action screenshot</summary>
        <img class="pageguide-memory-shot-trigger" data-shot-kind="before" src="data:image/jpeg;base64,${beforeShot}" alt="before action"></details>`
    : '';

  const preview = document.createElement('div');
  preview.id = 'pageguide-goal-step-preview';
  preview.className = 'pageguide-goal-step-preview';
  preview.innerHTML = `
    ${confHtml}
    ${topImg}
    <div class="pageguide-goal-step-preview-title">${isInitialNode ? 'Initial state' : 'Step ' + step}</div>
    <div class="pageguide-goal-step-preview-text">${escapeHtml(label)}</div>
    ${dualHtml}
    ${urlHtml}
    ${beforeHtml}
    ${meta?.durationMs != null ? `<div class="pageguide-goal-step-preview-meta">${_formatDuration(meta.durationMs)}</div>` : ''}
    ${meta ? '<button type="button" class="pageguide-goal-step-inspect">Inspect more</button>' : ''}
    ${allowSteer ? '<button type="button" class="pageguide-goal-step-steer">Restore here</button>' : ''}
  `;

  preview.addEventListener('click', async (e) => {
    e.stopPropagation();
    const target = e.target;
    // Let the "link" hyperlink open normally; don't also open the inspector.
    if (target.closest('.pageguide-goal-step-link')) return;
    if (target.closest('.pageguide-memory-shot-trigger')) {
      openMemoryShotLightbox(beforeShot, isInitialNode ? 'Initial state — saved page memory' : 'Before action — what PageGuide saw before this step');
      return;
    }
    // Let the collapsible "Before action" toggle natively; don't open the inspector.
    if (target.closest('.pageguide-goal-step-before')) return;
    if (target.closest('.pageguide-goal-step-steer')) {
      const restoreBtn = target.closest('button');
      if (restoreBtn) restoreBtn.disabled = true;
      guideStopped = false;
      if (meta && typeof RewindTimeline !== 'undefined' && typeof RewindTimeline.steerFromStep === 'function') {
        await RewindTimeline.steerFromStep(meta, '');
      }
      hideGoalStepPreview();
      return;
    }
    // "Inspect more" opens the full-page inspector tab (full memory record: restore log,
    // captured state, URL, raw JSON). Has its own handler so it isn't conflated with a
    // generic card click.
    if (target.closest('.pageguide-goal-step-inspect')) {
      hideGoalStepPreview();
      if (meta && typeof RewindTimeline !== 'undefined' && typeof RewindTimeline.openFullPageStep === 'function') {
        RewindTimeline.openFullPageStep(meta);
      }
      return;
    }

    // Clicks inside the steer box (e.g. the textarea) should not open the inspector.
    // Default: open the in-panel inspector (snapshot + Restore here), which restores THIS
    // working tab and still offers "Open detailed view ↗" for the full-page view.
    if (meta && typeof RewindTimeline !== 'undefined') {
      hideGoalStepPreview();
      if (typeof RewindTimeline.openStep === 'function') RewindTimeline.openStep(meta);
      else if (typeof RewindTimeline.openFullPageStep === 'function') RewindTimeline.openFullPageStep(meta);
    }
  });

  document.body.appendChild(preview);
  const r = anchor.getBoundingClientRect();
  const top = Math.min(window.innerHeight - preview.offsetHeight - 8, r.bottom + 10);
  preview.style.top = Math.max(8, top) + 'px';
  preview.style.left = Math.max(8, Math.min(r.left - 98, window.innerWidth - preview.offsetWidth - 8)) + 'px';
}

document.addEventListener('click', (e) => {
  if (!e.target.closest?.('#pageguide-goal-step-preview, .pageguide-goal-dot, #pageguide-memory-shot-lightbox')) {
    hideGoalStepPreview();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMemoryShotLightbox();
});

function renderGoalDots(current, total) {
  const dots = document.getElementById('pageguide-goal-dots');
  if (!dots) return;
  dots.innerHTML = '';

  // Derive each dot's state by PLAN step, aggregating the concrete step records that
  // belong to it (fixes the plan-vs-concrete-step conflation that left dots perma-gray).
  // gv2DotState is the unit-tested pure helper shared from content/utils.js.
  const states = (typeof gv2DotState === 'function')
    ? gv2DotState({
        plan: currentGuidePlan,
        records: currentGuideRecords,
        verifications: currentGuideVerifications,
        current,
        guideActive
      })
    : [];

  // Initial-state node (step 0): a distinct first dot, never counted as a step.
  if (currentGuideInitial) {
    const idot = document.createElement('button');
    idot.type = 'button';
    idot.className = 'pageguide-goal-dot initial';
    idot.dataset.step = '0';
    idot.title = 'Initial state';
    idot.addEventListener('click', (e) => { e.stopPropagation(); showGoalStepPreview(0, idot); });
    dots.appendChild(idot);
  }

  // Always render at least `total` dots so the count matches the "Step X of N" text.
  const count = Math.max(total || 0, states.length);
  for (let i = 1; i <= count; i++) {
    const st = states[i - 1] || { status: i < current ? 'done' : (i === current ? 'current' : 'pending'), review: false, verify: null };
    const rec = getGuideStepMeta(i);
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'pageguide-goal-dot';
    dot.dataset.step = String(i);
    dot.title = getGuideStepLabel(i);
    if (st.status === 'done') dot.classList.add('done');
    else if (st.status === 'current') dot.classList.add('current');
    // Confidence status (green ≥70%, yellow <70%) — NO red for confidence.
    const tier = (typeof gv2ConfidenceTier === 'function') ? gv2ConfidenceTier(rec?.confidence) : null;
    if (tier === 'high') dot.classList.add('conf-high');
    else if (tier === 'med') dot.classList.add('conf-med');
    // Red is reserved for verification failures and low *grounding* (not confidence).
    if (rec && typeof rec.grounding === 'number' && rec.grounding < 0.5) dot.classList.add('review');
    if (st.verify) dot.classList.add(`verify-${st.verify}`);
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      showGoalStepPreview(i, dot);
    });
    dots.appendChild(dot);
  }
}

const CONF_CHART_SPECS = {
  full: { label: 'Full (G·loop·progress)', color: '#7857ff' },
  reduced: { label: 'No-progress (G·loop)', color: '#ff8a3d' },
  noloop: { label: 'No-loop (G·progress)', color: '#1bbf9c' }
};
let confChartVisibleVersions = { full: true, reduced: true, noloop: true };

function _normalizeChartVisible(next, changedKey) {
  const clean = {
    full: next?.full !== false,
    reduced: next?.reduced !== false,
    noloop: next?.noloop !== false
  };
  if (!clean.full && !clean.reduced && !clean.noloop) clean[changedKey || 'full'] = true;
  return clean;
}

function _confidenceChartRows(records) {
  if (typeof gv2ComputeConfidence !== 'function') return [];
  return (Array.isArray(records) ? records : [])
    .slice()
    .sort((a, b) => Number(a.step) - Number(b.step))
    .map(r => {
      if (r.grounded == null && r.loop == null && r.progress == null) return null;
      const signals = { grounded: r.grounded, loop: r.loop, progress: r.progress };
      const full = gv2ComputeConfidence(signals, 'full').confidence;
      const reduced = gv2ComputeConfidence(signals, 'reduced').confidence;
      const noloop = gv2ComputeConfidence(signals, 'noloop').confidence;
      return (full != null || reduced != null || noloop != null) ? { step: r.step, full, reduced, noloop } : null;
    })
    .filter(Boolean);
}

function _confChartFilterHtml() {
  return `<div class="pageguide-conf-chart-filters" role="group" aria-label="Confidence chart versions">
    ${Object.keys(CONF_CHART_SPECS).map(key => `
      <button type="button" class="pageguide-conf-chart-filter${confChartVisibleVersions[key] ? ' active' : ''}" data-chart-version="${key}" aria-pressed="${confChartVisibleVersions[key] ? 'true' : 'false'}">
        <i style="background:${CONF_CHART_SPECS[key].color}"></i>${escapeHtml(CONF_CHART_SPECS[key].label)}
      </button>`).join('')}
  </div>`;
}

function _buildConfChartSvg(data, visible = confChartVisibleVersions) {
  visible = _normalizeChartVisible(visible);
  const keys = Object.keys(CONF_CHART_SPECS).filter(k => visible[k]);
  const W = 300, H = 130, padL = 26, padR = 10, padT = 12, padB = 22;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = data.length;
  const xAt = (i) => n <= 1 ? padL + innerW / 2 : padL + (i / (n - 1)) * innerW;
  const yAt = (v) => padT + (1 - Math.max(0, Math.min(1, Number(v) || 0))) * innerH;
  const validFor = (key) => data.filter(d => d[key] != null);
  const line = (key) => {
    const pts = data.map((d, i) => d[key] == null ? null : `${xAt(i).toFixed(1)},${yAt(d[key]).toFixed(1)}`).filter(Boolean);
    return pts.length ? `<polyline data-version="${key}" points="${pts.join(' ')}" fill="none" stroke="${CONF_CHART_SPECS[key].color}" stroke-width="1.8"/>` : '';
  };
  const dots = (key) => validFor(key).map(d => {
    const i = data.indexOf(d);
    return `<circle data-version="${key}" cx="${xAt(i).toFixed(1)}" cy="${yAt(d[key]).toFixed(1)}" r="2.4" fill="${CONF_CHART_SPECS[key].color}"/>`;
  }).join('');
  const grid = [0, 0.5, 1].map(v => {
    const y = yAt(v).toFixed(1);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(128,128,128,.25)" stroke-width="1"/>`
      + `<text x="${padL - 4}" y="${(yAt(v) + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="currentColor" opacity=".55">${Math.round(v * 100)}</text>`;
  }).join('');
  const xlabels = data.map((d, i) => `<text x="${xAt(i).toFixed(1)}" y="${H - 7}" text-anchor="middle" font-size="8" fill="currentColor" opacity=".55">${escapeHtml(String(d.step))}</text>`).join('');
  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Confidence comparison chart">
      ${grid}
      ${keys.map(line).join('')}
      ${keys.map(dots).join('')}
      ${xlabels}
    </svg>
    <div class="pageguide-conf-chart-legend">
      ${keys.map(k => `<span><i style="background:${CONF_CHART_SPECS[k].color}"></i>${escapeHtml(CONF_CHART_SPECS[k].label)}</span>`).join('')}
    </div>`;
}

async function _refreshConfChartFromStore() {
  if (!visibleJourneySessionId || typeof rewindGetIndex !== 'function') return;
  try {
    let idx = null;
    if (typeof rewindVerifyScreenshots === 'function') idx = await rewindVerifyScreenshots(visibleJourneySessionId);
    else idx = await rewindGetIndex(visibleJourneySessionId);
    if (idx && Array.isArray(idx.steps)) {
      currentGuideRecords = idx.steps.filter(m => !(m.isInitial || Number(m.step) === 0)).map(m => Object.assign({}, m, { sessionId: visibleJourneySessionId }));
      currentGuideInitial = idx.steps.find(m => m.isInitial || Number(m.step) === 0) || currentGuideInitial;
    }
  } catch (e) {}
}

function _renderConfChartBody() {
  const body = document.getElementById('pageguide-conf-chart-body');
  if (!body) return;
  const data = _confidenceChartRows(currentGuideRecords);
  if (!data.length) {
    body.innerHTML = '<div class="pageguide-conf-chart-empty">No steps with confidence signals yet.</div>';
    return;
  }
  body.innerHTML = _buildConfChartSvg(data, confChartVisibleVersions);
}

// Debug-only chart: collapsed by default and rendered lazily when opened.
function renderConfChart() {
  const box = document.getElementById('pageguide-conf-chart');
  if (!box) return;
  if (!window.__pgDebugEnabled) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const data = _confidenceChartRows(currentGuideRecords);
  if (!data.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const wasOpen = !!box.querySelector('#pageguide-conf-chart-wrap')?.open;
  box.innerHTML = `
    <details id="pageguide-conf-chart-wrap" ${wasOpen ? 'open' : ''}>
      <summary class="pageguide-conf-chart-summary">📈 Confidence chart</summary>
      <div class="pageguide-conf-chart-title">Confidence by step — Full vs No-progress vs No-loop</div>
      <div class="pageguide-conf-chart-actions">
        <button type="button" class="pageguide-conf-chart-refresh" id="pageguide-conf-chart-refresh">Refresh chart</button>
      </div>
      ${_confChartFilterHtml()}
      <div id="pageguide-conf-chart-body"></div>
    </details>`;
  const wrap = box.querySelector('#pageguide-conf-chart-wrap');
  const drawIfOpen = () => { if (wrap.open) _renderConfChartBody(); };
  wrap.addEventListener('toggle', drawIfOpen);
  box.querySelector('#pageguide-conf-chart-refresh')?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!window.confirm('Refresh the confidence chart from the latest saved step data?')) return;
    await _refreshConfChartFromStore();
    _renderConfChartBody();
  });
  box.querySelectorAll('[data-chart-version]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.chartVersion;
      confChartVisibleVersions = _normalizeChartVisible({ ...confChartVisibleVersions, [key]: !confChartVisibleVersions[key] }, key);
      renderConfChart();
    });
  });
  if (wasOpen) _renderConfChartBody();
  box.style.display = '';
}

function renderGoalCard({ prompt, route, title, step, total } = {}) {
  const card = document.getElementById('pageguide-goal');
  if (!card) return;

  if (prompt != null || route != null) {
    currentGoal = {
      prompt: prompt != null ? prompt : currentGoal?.prompt || '',
      route: route || currentGoal?.route || null
    };
  }
  if (title != null) currentGuideTitle = title || '';
  if (typeof step === 'number') currentGuideStep = step;
  if (typeof total === 'number') {
    currentGuidePlan = Array.from({ length: total }, (_, i) => currentGuidePlan[i] || { n: i + 1, goal: '' });
  }

  const activeRoute = currentGoal?.route || panelLastRoute || panelForcedMode;
  const normalized = _normalizeRouteForTab(activeRoute);
  const isGuide = normalized === 'guide' || currentGuidePlan.length > 0 || currentGuideStep > 0;
  document.body.classList.toggle('pageguide-guide-mode', !!isGuide);
  if (normalized === 'find' || normalized === 'hide') {
    card.style.display = 'none';
    refreshGuideOnlyActions();
    return;
  }
  const promptText = currentGoal?.prompt || '';
  const titleText = isGuide ? (currentGuideTitle || _truncateText(promptText)) : _truncateText(promptText);
  if (!titleText) {
    card.style.display = 'none';
    return;
  }

  const icon = document.getElementById('pageguide-goal-icon');
  const titleEl = document.getElementById('pageguide-goal-title');
  const progress = document.getElementById('pageguide-goal-progress');
  const stepText = document.getElementById('pageguide-goal-steptext');
  const fill = document.getElementById('pageguide-goal-bar-fill');

  if (icon) icon.textContent = ROUTE_ICONS[activeRoute] || ROUTE_ICONS[normalized] || '🎯';
  if (titleEl) titleEl.textContent = titleText;

  const totalSteps = Math.max(currentGuidePlan.length, currentGuideRecords.length, currentGuideStep || 0);
  if (isGuide && totalSteps > 0 && currentGuideStep > 0) {
    const safeStep = Math.max(1, Math.min(currentGuideStep, totalSteps));
    if (progress) progress.style.display = 'flex';
    if (stepText) stepText.textContent = `Step ${safeStep} of ${totalSteps}`;
    if (fill) fill.style.width = `${Math.round((safeStep / totalSteps) * 100)}%`;
    renderGoalDots(safeStep, totalSteps);
    renderConfChart();
  } else if (progress) {
    progress.style.display = 'none';
  }

  if (isGuide) _ensureGoalCollapseBtn();
  card.style.display = '';
  refreshGuideOnlyActions();
  checkShowBranchButton();
}

// Steer / rebranch: drop timeline steps AFTER `step` so the UI matches the truncated rewind
// store. Steps 1…step stay; the agent appends new steps as it re-runs from step+1.
function pruneGuideAfter(step) {
  const n = Number(step);
  if (!Number.isFinite(n)) return;
  currentGuideRecords = currentGuideRecords.filter(r => Number(r.step) <= n);
  if (Array.isArray(currentGuidePlan) && currentGuidePlan.length > n) currentGuidePlan = currentGuidePlan.slice(0, n);
  if (currentGuideVerifications) {
    Object.keys(currentGuideVerifications).forEach(k => { if (Number(k) > n) delete currentGuideVerifications[k]; });
  }
  currentGuideStep = n;
  renderGoalCard({ route: 'guide', step: n });
}
if (typeof window !== 'undefined') window.pruneGuideAfter = pruneGuideAfter;

function clearGoalAndStepPanel() {
  guidePaused = false;
  currentGoal = null;
  currentGuidePlan = [];
  currentGuideTitle = '';
  currentGuideStep = 0;
  currentGuideRecords = [];
  currentGuideInitial = null;
  currentGuideVerifications = {};
  currentGuideWarnings = {};
  visibleJourneySessionId = null;
  visibleJourneyTitle = '';
  visibleJourneyRecalled = false;
  hideGoalStepPreview();
  const goal = document.getElementById('pageguide-goal');
  const stepPanel = document.getElementById('pageguide-step-panel');
  const exportBtn = document.getElementById('pageguide-export-pdf');
  const cardExportBtn = document.getElementById('pageguide-card-export-pdf');
  if (goal) goal.style.display = 'none';
  if (stepPanel) {
    stepPanel.style.display = 'none';
    stepPanel.innerHTML = '';
  }
  if (exportBtn) exportBtn.disabled = true;
  if (cardExportBtn) cardExportBtn.disabled = true;
  const cardSaveBtn = document.getElementById('pageguide-card-save-trajectory');
  if (cardSaveBtn) cardSaveBtn.disabled = true;
  refreshGuideOnlyActions();
}

function setExportEnabled(on) {
  const btn = document.getElementById('pageguide-export-pdf');
  if (btn) btn.disabled = !on;
  const cardBtn = document.getElementById('pageguide-card-export-pdf');
  if (cardBtn) cardBtn.disabled = !on;
  const saveBtn = document.getElementById('pageguide-card-save-trajectory');
  if (saveBtn) saveBtn.disabled = !on;
  refreshGuideOnlyActions();
}

function moveMoreMenuForGuideMode(hasGuide) {
  const wrap = document.getElementById('pageguide-more-wrap');
  if (!wrap) return;
  const guideActions = document.getElementById('pageguide-guide-card-actions');
  const inputActions = document.querySelector('.pageguide-input-actions');
  const sendBtn = document.getElementById('pageguide-send');
  if (hasGuide && guideActions && wrap.parentElement !== guideActions) {
    guideActions.appendChild(wrap);
  } else if (!hasGuide && inputActions && wrap.parentElement !== inputActions) {
    inputActions.insertBefore(wrap, sendBtn || null);
  }
}

function refreshGuideOnlyActions() {
  const hasGuide = !!(currentGuidePlan.length || currentGuideRecords.length || currentGuideStep);
  document.body.classList.toggle('pageguide-guide-mode', hasGuide);
  moveMoreMenuForGuideMode(hasGuide);
  hideMoreMenu();
  document.querySelectorAll('.pageguide-guide-only-action').forEach(el => {
    el.style.display = hasGuide ? '' : 'none';
  });
  updateGuidePauseButton();
}

function updateGuidePauseButton() {
  const btn = document.getElementById('pageguide-guide-pause');
  if (!btn) return;
  const show = !!(guideActive || guidePaused);
  btn.style.display = show ? '' : 'none';
  btn.classList.toggle('is-resume', !!guidePaused);
  btn.textContent = guidePaused ? 'Resume' : 'Pause';
  btn.title = guidePaused ? 'Resume guide' : 'Pause guide';
  btn.setAttribute('aria-label', guidePaused ? 'Resume guide' : 'Pause guide');
  btn.disabled = false;
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;
  renderWorkingTabChip(tab);
  
  // Attach event listeners
  document.getElementById('pageguide-settings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('pageguide-close')?.addEventListener('click', () => window.close());

  // Theme toggle (light / dark mode)
  const themeToggleBtn = document.getElementById('pageguide-theme-toggle');
  const themeIcon = (isLight) => isLight
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.5A8 8 0 1 1 9.5 3.5 6.5 6.5 0 0 0 20.5 14.5Z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.9 19.1 1.4-1.4"/><path d="m17.7 6.3 1.4-1.4"/></svg>';
  const applyTheme = (isLight) => {
    document.body.classList.toggle('light-mode', isLight);
    if (themeToggleBtn) themeToggleBtn.innerHTML = themeIcon(isLight);
  };
  const savedTheme = localStorage.getItem('pageguide-theme');
  applyTheme(savedTheme ? savedTheme === 'light' : true);
  themeToggleBtn?.addEventListener('click', () => {
    const isLight = !document.body.classList.contains('light-mode');
    applyTheme(isLight);
    localStorage.setItem('pageguide-theme', isLight ? 'light' : 'dark');
  });

  document.getElementById('pageguide-new-chat')?.addEventListener('click', () => resetChat());
  document.getElementById('pageguide-tab-chip-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    hideWorkingTabChip();
  });

  document.getElementById('pageguide-show-branch-btn')?.addEventListener('click', () => {
    const backdrop = document.getElementById('pageguide-branch-backdrop');
    if (backdrop) backdrop.style.display = 'block';
    showBranchTree();
  });
  
  const closeBranchOverlay = () => {
    _hideBranchTreeHover(true);
    const overlay = document.getElementById('pageguide-branch-overlay');
    const backdrop = document.getElementById('pageguide-branch-backdrop');
    if (overlay) overlay.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
  };

  document.addEventListener('click', (e) => {
    if (_branchTreeHoverCard && !e.target.closest('.pg-tree-hovercard') && !e.target.closest('.pg-tree-node')) {
      _hideBranchTreeHover(true);
    }
  });
  
  document.getElementById('pageguide-branch-close')?.addEventListener('click', closeBranchOverlay);
  document.getElementById('pageguide-branch-backdrop')?.addEventListener('click', closeBranchOverlay);

  const updateTreeScale = (scale) => {
    currentTreeScale = Math.max(0.5, Math.min(2.0, scale));
    const content = document.getElementById('pg-tree-content');
    const label = document.getElementById('pg-zoom-label');
    if (content) content.style.transform = `scale(${currentTreeScale})`;
    if (label) label.textContent = `${Math.round(currentTreeScale * 100)}%`;
  };

  document.getElementById('pg-zoom-in')?.addEventListener('click', () => {
    updateTreeScale(currentTreeScale + 0.1);
  });
  document.getElementById('pg-zoom-out')?.addEventListener('click', () => {
    updateTreeScale(currentTreeScale - 0.1);
  });
  document.getElementById('pg-zoom-reset')?.addEventListener('click', () => {
    updateTreeScale(1.0);
  });
  
  document.getElementById('pageguide-send').addEventListener('click', () => {
    if (panelRunning) stopRun(); else sendMessage();
  });
  document.getElementById('pageguide-guide-pause')?.addEventListener('click', () => {
    if (guidePaused) resumeGuideFromPanel();
    else pauseGuide('Guide paused. Resume when you are ready.');
  });
  initGuideModeToggle();
  initConfidenceFormulaToggle();
  initConfidenceSourceToggle();
  initPanelMenus();
  document.getElementById('pageguide-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const menu = document.getElementById('pageguide-slash-menu');
      // If slash menu is open and an item is selected, let the keydown handler handle it
      if (menu && menu.style.display !== 'none' && _slashMenuIndex >= 0) return;
      e.preventDefault();
      sendMessage();
    }
  });
  
  // Quick action buttons
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => handleQuickAction(btn.dataset.action));
  });
  
  // PDF Reader button
  document.getElementById('pageguide-pdf-reader')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pdf-viewer/viewer.html') });
    hideMoreMenu();
  });
  
  // Chat history
  document.getElementById('pageguide-open-history')?.addEventListener('click', showHistoryPanel);
  document.getElementById('pageguide-history-close')?.addEventListener('click', hideHistoryPanel);
  document.getElementById('pageguide-history-back')?.addEventListener('click', () => renderHistoryList());
  document.getElementById('pageguide-save-chat')?.addEventListener('click', async () => {
    hideMoreMenu();
    await saveCurrentChat();
  });
  document.getElementById('pageguide-export-pdf')?.addEventListener('click', () => {
    hideMoreMenu();
    exportJourneyPdf();
  });
  document.getElementById('pageguide-card-export-pdf')?.addEventListener('click', () => {
    exportJourneyPdf();
  });
  document.getElementById('pageguide-card-save-trajectory')?.addEventListener('click', () => {
    saveTrajectoryToRepo();
  });
  setExportEnabled(false);
  try {
    if (typeof rewindGetIndex === 'function') {
      const idx = await rewindGetIndex();
      setExportEnabled(!!idx?.steps?.length);
    }
  } catch (e) {}

  // No-page-context toggle
  document.getElementById('pageguide-no-page-ctx')?.addEventListener('click', () => {
    noPageContext = !noPageContext;
    const btn = document.getElementById('pageguide-no-page-ctx');
    if (btn) {
      btn.textContent = noPageContext ? '💭 Page: Off' : '🌐 Page: On';
      btn.innerHTML = noPageContext ? `${UI_ICONS.pageOff}Page: Off` : `${UI_ICONS.globe}Page: On`;
      btn.classList.toggle('pageguide-quick-btn--active', noPageContext);
      btn.title = noPageContext
        ? 'Page context OFF — answers from AI knowledge only. Click to re-enable.'
        : 'Toggle: answer from AI knowledge only (ignore current page)';
    }
    hideMoreMenu();
  });

  // Combined upload handling (images + text files share one button)
  const imageUpload = document.getElementById('pageguide-image-upload');
  const removeImageBtn = document.getElementById('pageguide-remove-image');
  const removeFileBtn = document.getElementById('pageguide-remove-file');
  const removeSelectedTextBtn = document.getElementById('pageguide-remove-selected-text');

  if (imageUpload) imageUpload.addEventListener('change', handleUpload);
  if (removeImageBtn) removeImageBtn.addEventListener('click', clearUploadedImage);
  if (removeFileBtn) removeFileBtn.addEventListener('click', clearUploadedFile);
  if (removeSelectedTextBtn) {
    removeSelectedTextBtn.addEventListener('click', clearSelectedText);
  }

  // Paste image support (Ctrl+V / Cmd+V)
  document.addEventListener('paste', handlePasteImage);
  
  // Focus input
  document.getElementById('pageguide-input')?.focus();

  // Wire up delegated click handler for message container.
  // A single listener on the container survives innerHTML replacement during
  // session restore, keeping citations and highlights clickable after tab switches.
  const messagesContainer = document.getElementById('pageguide-messages');
  if (messagesContainer) _setupMessageContainerDelegate(messagesContainer);

  // Wire up slash command autocomplete
  _initSlashAutocomplete();

  // Show current model status on open
  showModelStatus();

  // Listen for tab changes.
  // Save the outgoing tab's session, then restore the incoming tab's session
  // (or start fresh if this is the first time visiting that tab).
  // Guide-triggered tab transitions are left untouched (guideActive guard).
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const prevTabId = currentTabId;
    currentTabId = activeInfo.tabId;
    _hiddenTabChips.delete(activeInfo.tabId);
    refreshWorkingTabChip(activeInfo.tabId);

    if (!_shouldResetOnTabSwitch(prevTabId, activeInfo.tabId, guideActive)) return;

    // Snapshot the outgoing tab's conversation
    _saveTabSession(prevTabId);

    // NOTE: we intentionally do NOT clear highlights on the old tab here.
    // Highlights live in each tab's own DOM and persist naturally until the
    // user explicitly clears them (Clear All), the tab navigates to a new URL,
    // or the panel is closed.

    // Restore a previous session for this tab, or start a fresh one
    const saved = _tabSessions.get(activeInfo.tabId);
    if (saved) {
      _restoreTabSession(saved);
    } else {
      await resetChat(false);
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabId !== currentTabId) return;
    if (!('title' in changeInfo) && !('favIconUrl' in changeInfo) && !('url' in changeInfo) && changeInfo.status !== 'complete') return;
    renderWorkingTabChip(tab);
  });

  // Clean up sessions for closed tabs to avoid memory leaks
  chrome.tabs.onRemoved.addListener((tabId) => {
    _tabSessions.delete(tabId);
    _hiddenTabChips.delete(tabId);
  });

  // Debug prompt button listener
  const debugPromptBtn = document.getElementById('pageguide-debug-prompt-btn');
  if (debugPromptBtn) {
    debugPromptBtn.addEventListener('click', async () => {
      try {
        const local = await chrome.storage.local.get(['debugPrompts', 'lastDebugPrompt']);
        const livePrompts = Array.isArray(local.debugPrompts) ? local.debugPrompts : [];
        if (livePrompts.length === 0 && local.lastDebugPrompt) {
          livePrompts.push(local.lastDebugPrompt);
        }

        let savedSessions = [];
        if (typeof rewindGetSessions === 'function') {
          try {
            savedSessions = await rewindGetSessions();
          } catch (e) {
            console.warn('Failed to fetch saved sessions:', e);
          }
        }

        if (livePrompts.length > 0 || savedSessions.length > 0) {
          const defaultSessionId = visibleJourneySessionId || (typeof RewindTimeline !== 'undefined' && typeof RewindTimeline.getSessionId === 'function' ? RewindTimeline.getSessionId() : null);
          openDebugPromptLightbox(livePrompts, savedSessions, defaultSessionId);
        } else {
          alert('No prompt has been sent or saved in this session yet.');
        }
      } catch (e) {
        console.error('Failed to load debug prompts:', e);
      }
    });
  }

  // Load debugEnabled setting initially
  try {
    const settings = await chrome.storage.sync.get(['debugEnabled']);
    updateDebugButtonVisibility(settings.debugEnabled === true);
  } catch (e) {}

  // Listen for sync storage changes to update debug button visibility
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && 'debugEnabled' in changes) {
      updateDebugButtonVisibility(changes.debugEnabled.newValue === true);
    }
  });
});

/**
 * Parse citations in text and make them clickable
 * Supports two formats:
 * 1. Web page citations: [N:"text"] or [N] - scrolls to indexed element
 * 2. PDF citations: [Page N: "text"] - navigates to PDF page
 */
function parseCitations(text, isPdf = false) {
  // Normalize curly/smart quotes to straight quotes first
  const normalizedText = text
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'");
  
  // Use normalized text for parsing
  text = normalizedText;
  
  let result = '';
  let lastIndex = 0;
  let citationCount = 0;
  
  // First, check for indexed citations: [idx:N], [idx:N-M], or [idx:N-M, X-Y, ...]
  const indexedCitationPattern = /\[idx:([^\]]+)\]/gi;
  const hasIndexedCitations = indexedCitationPattern.test(text);
  indexedCitationPattern.lastIndex = 0;
  
  if (hasIndexedCitations) {
    let match;
    
    while ((match = indexedCitationPattern.exec(text)) !== null) {
      citationCount++;
      const rangesStr = match[1]; // e.g., "1-2, 38-42, 58-59" or "57"
      
      // Parse all ranges
      const ranges = [];
      const rangeParts = rangesStr.split(/[,;]\s*/);
      for (const part of rangeParts) {
        const rangeMatch = part.trim().match(/(\d+)(?:-(\d+))?/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1]);
          const end = rangeMatch[2] ? parseInt(rangeMatch[2]) : start;
          ranges.push({ start, end });
        }
      }
      
      // Add text before this citation (already HTML from parseMarkdown)
      result += text.slice(lastIndex, match.index);
      
      // Store all ranges as JSON in data attribute
      const rangesJson = JSON.stringify(ranges);
      const tooltipText = ranges.map(r => r.start === r.end ? r.start : `${r.start}-${r.end}`).join(', ');
      result += `<span class="pageguide-pdf-citation" data-ranges='${rangesJson}' data-citation="${citationCount}" title="Elements: ${tooltipText}">[${citationCount}]</span>`;
      
      lastIndex = match.index + match[0].length;
    }
    
    // Add remaining text (already HTML from parseMarkdown)
    result += text.slice(lastIndex);
    return result;
  }
  
  // Second, handle PDF page citations: [Page N: "text"] or [Page N: 'text']
  const pdfCitationPattern = /\[Page\s*(\d+):\s*["']([^"']+)["']\]/gi;
  
  // Check if there are PDF citations
  const hasPdfCitations = pdfCitationPattern.test(text);
  pdfCitationPattern.lastIndex = 0; // Reset regex
  
  if (hasPdfCitations) {
    let match;
    
    while ((match = pdfCitationPattern.exec(text)) !== null) {
      citationCount++;
      const pageNum = match[1];
      const quoteText = match[2];
      
      // Add text before this citation (already HTML from parseMarkdown)
      result += text.slice(lastIndex, match.index);
      
      // Add clickable PDF citation - show index only, store quote for highlighting
      // Truncate quote for tooltip (first 60 chars)
      const tooltipText = quoteText.length > 60 ? quoteText.slice(0, 60) + '...' : quoteText;
      result += `<span class="pageguide-pdf-citation" data-page="${pageNum}" data-text="${escapeHtml(quoteText)}" data-citation="${citationCount}" title="Page ${pageNum}: ${escapeHtml(tooltipText)}">[${citationCount}]</span>`;
      
      lastIndex = match.index + match[0].length;
    }
    
    // Add remaining text (already HTML from parseMarkdown)
    result += text.slice(lastIndex);
    return result;
  }
  
  // Handle regular web citations: [N], [N:"text"], or [N, M, ...] (multiple indices)
  // Pattern matches: [517], [517:"text"], [517, 519], [517, 519:"text"]
  const citationPattern = /\[([\d,\s]+)(?::\s*(?:"([^"]+)"|'([^']+)'|([^\]]+)))?\]/g;
  
  let match;
  let webCitationCount = 0;
  while ((match = citationPattern.exec(text)) !== null) {
    const indicesStr = match[1]; // Could be "517" or "517, 519" or "517,519"
    // Text could be in group 2 (double quoted), 3 (single quoted), or 4 (unquoted)
    const explicitText = match[2] || match[3] || match[4];
    
    // Parse all indices (handle comma-separated)
    const indices = indicesStr.split(/[,\s]+/).filter(s => s.match(/^\d+$/));
    
    const textBefore = text.slice(lastIndex, match.index);
    result += textBefore;
    
    // Create citation with toggleable text and index
    // Default: collapsed (show only index), click to expand (show text + index)
    indices.forEach((idx, i) => {
      webCitationCount++;
      if (explicitText) {
        // Has citation text - make it toggleable
        result += `<span class="pageguide-citation pageguide-citation-idx" data-index="${idx}" data-citation="${webCitationCount}"><span class="citation-text">${escapeHtml(explicitText)}</span><sup class="citation-index">[${webCitationCount}]</sup></span>`;
      } else {
        // No text - just show index
        result += `<span class="pageguide-citation pageguide-citation-idx" data-index="${idx}" data-citation="${webCitationCount}"><sup class="citation-index">[${webCitationCount}]</sup></span>`;
      }
    });
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text (already HTML from parseMarkdown)
  result += text.slice(lastIndex);
  
  return result;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Parse markdown formatting to HTML
 * Supports: **bold**, *italic*, `code`, - lists, numbered lists, headers
 */
function parseMarkdown(text) {
  // First escape HTML to prevent XSS
  let result = escapeHtml(text);
  
  // Code blocks with triple backticks (must be done before inline code)
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  
  // Inline code with single backticks
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // Bold with **text** (must be done before italic)
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  
  // Bullet lists (- item or * item at start of line)
  result = result.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  
  // Collapse spaces/newlines between list items
  result = result.replace(/<\/li>\s*<li>/g, '</li><li>');
  
  // Wrap consecutive <li> elements in <ul>
  result = result.replace(/(<li>[\s\S]*?<\/li>)+/g, '<ul>$&</ul>');
  
  // Italic with *text* (single asterisks, not part of **)
  // Stop at newline so it doesn't span multiple paragraphs/list items
  result = result.replace(/(?<!\*)\*([^*^\n]+)\*(?!\*)/g, '<em>$1</em>');
  
  // Links [text](url) - handle markdown links (with up to 1 level of nested parentheses in URL)
  result = result.replace(/\[([^\]]+)\]\(((?:[^()]+|\([^()]*\))+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="pageguide-markdown-link">$1</a>');
  
  // Raw URLs (basic linkify for URLs not inside existing tags or markdown links)
  // Be careful not to replace URLs that are already part of an href attribute or markdown link.
  // Supports up to 1 level of nested parentheses in URL
  const rawUrlRegex = /(^|\s)(https?:\/\/(?:[^\s\(\)<>]+|\([^\s\(\)<>]+\))+)/g;
  result = result.replace(rawUrlRegex, '$1<a href="$2" target="_blank" rel="noopener noreferrer" class="pageguide-markdown-link">$2</a>');
  
  // Headers
  result = result.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  result = result.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  result = result.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  
  // Numbered lists (1. item, 2. item, etc.)
  result = result.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  
  // Line breaks (convert \n to <br> but preserve paragraph structure)
  result = result.replace(/\n\n/g, '</p><p>');
  result = result.replace(/\n/g, '<br>');
  
  // Clean up any empty paragraphs and fix structure
  result = result.replace(/<p><\/p>/g, '');
  result = result.replace(/<br><br>/g, '</p><p>');
  
  // Wrap in paragraph if not already wrapped with a block element
  if (!result.startsWith('<h') && !result.startsWith('<ul') && !result.startsWith('<pre') && !result.startsWith('<p')) {
    result = '<p>' + result + '</p>';
  }
  
  return result;
}

/**
 * Read stored settings and show the active provider + model in the chat.
 * If no key is configured, prompt the user to open Settings.
 */
async function showModelStatus() {
  const PROVIDER_LABELS = {
    gemini: 'Gemini',
    openrouter: 'OpenRouter',
    openai: 'OpenAI'
  };

  let settings = {};
  try {
    settings = await chrome.storage.sync.get([
      'provider',
      'geminiApiKey', 'geminiModel',
      'openrouterApiKey', 'openrouterModel',
      'openaiApiKey', 'openaiModel'
    ]);
  } catch (e) { /* storage unavailable */ }

  const provider = settings.provider || 'gemini';
  const providerLabel = PROVIDER_LABELS[provider] || provider;

  let apiKey = '';
  let modelRaw = '';

  if (provider === 'gemini') {
    apiKey = settings.geminiApiKey || '';
    modelRaw = settings.geminiModel || 'gemini-2.5-flash';
  } else if (provider === 'openrouter') {
    apiKey = settings.openrouterApiKey || '';
    modelRaw = settings.openrouterModel || '';
  } else if (provider === 'openai') {
    apiKey = settings.openaiApiKey || '';
    modelRaw = settings.openaiModel || '';
  }

  // Shorten "org/model-name" → "model-name" for display
  const modelDisplay = modelRaw.includes('/') ? modelRaw.split('/').pop() : modelRaw;

  if (!apiKey) {
    addMessage(
      `⚙️ No API key configured. Click **⚙️ Settings** to add your ${providerLabel} key and get started.`,
      'system'
    );
  } else {
    addMessage(
      `🤖 Using **${providerLabel}** · ${modelDisplay}`,
      'system'
    );
  }
}

/**
 * Set up a single delegated click handler on the messages container.
 * This survives innerHTML replacement during session restore, so all
 * citation and highlight links remain clickable after tab switching.
 * Call once at startup (DOMContentLoaded).
 */
function _setupMessageContainerDelegate(container) {
  container.addEventListener('click', async (e) => {
    // 0. "View journey" recall button. Delegated (not a per-button listener) so it keeps working
    // after a tab switch, which restores the chat via innerHTML and would drop direct listeners.
    const recallBtn = e.target.closest('.pageguide-journey-recall-btn');
    if (recallBtn) {
      e.stopPropagation();
      const sid = recallBtn.dataset.session;
      if (sid) showStoredJourney(sid);
      return;
    }

    // 1. PDF citation → PDF navigation (with range cycling)
    const pdfCit = e.target.closest('.pageguide-pdf-citation');
    if (pdfCit) {
      e.stopPropagation();

      const rangesJson = pdfCit.dataset.ranges;
      const pageNum = pdfCit.dataset.page ? parseInt(pdfCit.dataset.page, 10) : null;
      const searchText = pdfCit.dataset.text;

      let message;
      if (rangesJson) {
        const ranges = JSON.parse(rangesJson);
        if (ranges.length > 1) {
          const currentIdx = parseInt(pdfCit.dataset.currentRangeIdx || '0', 10);
          const nextIdx = (currentIdx + 1) % ranges.length;
          pdfCit.dataset.currentRangeIdx = String(nextIdx);

          let counter = pdfCit.querySelector('.citation-range-counter');
          if (!counter) {
            counter = document.createElement('span');
            counter.className = 'citation-range-counter';
            pdfCit.appendChild(counter);
          }
          counter.textContent = `${currentIdx + 1}/${ranges.length}`;
          pdfCit.title = `Evidence ${currentIdx + 1} of ${ranges.length} — click to cycle`;

          message = { action: 'highlightByRanges', ranges: [ranges[currentIdx]] };
        } else {
          message = { action: 'highlightByRanges', ranges };
        }
      } else if (pageNum && searchText) {
        message = { action: 'navigateToPdfPage', page: pageNum, searchText };
      } else {
        console.warn('Invalid citation data');
        return;
      }

      const tabs = await chrome.tabs.query({});
      const pdfViewerTab = tabs.find(t => t.url?.includes('pdf-viewer/viewer.html'));
      if (pdfViewerTab) {
        chrome.tabs.sendMessage(pdfViewerTab.id, message);
        chrome.tabs.update(pdfViewerTab.id, { active: true });
      } else {
        sendToContentScript(message);
      }
      return;
    }

    // 2. Web citation → scroll to index
    const webCit = e.target.closest('.pageguide-citation');
    if (webCit) {
      e.stopPropagation();
      const index = parseInt(webCit.dataset.index, 10);
      sendToContentScript({ action: 'scrollToIndex', index });
      return;
    }

    // 3. Clickable message (guide/ask-step → scrollToHighlight; assistant → toggle citations)
    const msg = e.target.closest('.pageguide-message.pageguide-clickable');
    if (!msg || e.target.closest('button')) return;

    if (msg.classList.contains('guide') || msg.classList.contains('ask-step')) {
      sendToContentScript({ action: 'scrollToHighlight' });
    } else {
      msg.classList.toggle('citations-expanded');
    }
  });
}

/**
 * Add a message to the chat
 */
function addMessage(content, type = 'assistant', clickable = false, context = null) {
  const container = document.getElementById('pageguide-messages');
  if (!container) return;
  
  hideTyping();
  
  const msg = document.createElement('div');
  msg.className = `pageguide-message ${type}`;
  
  let innerHTML = '';

  // Prepend context pill if provided
  if (type === 'user' && context) {
    if (context.type === 'selectedText') {
      const snippet = context.text.length > 80 ? context.text.substring(0, 80) + '...' : context.text;
      const wordCount = context.text.split(/\\s+/).filter(w => w.length > 0).length;
      innerHTML += `
        <div class="pageguide-msg-context-pill pageguide-msg-context-selected">
          <span class="pageguide-msg-context-icon">📝</span>
          <span class="pageguide-msg-context-text" title="${escapeHtml(context.text)}">
            "${escapeHtml(snippet)}" (${wordCount} words)
          </span>
        </div>
      `;
    } else if (context.type === 'file') {
      innerHTML += `
        <div class="pageguide-msg-context-pill pageguide-msg-context-file">
          <span class="pageguide-msg-context-icon">📎</span>
          <span class="pageguide-msg-context-text">${escapeHtml(context.name)}</span>
        </div>
      `;
    } else if (context.type === 'image') {
      innerHTML += `
        <div class="pageguide-msg-context-pill pageguide-msg-context-image">
          <span class="pageguide-msg-context-icon">📷</span>
          <span class="pageguide-msg-context-text">Attached Image</span>
        </div>
      `;
    }
  }

  if (clickable) {
    msg.classList.add('pageguide-clickable');
    // Parse markdown first, then citations
    const markdownParsed = parseMarkdown(content);
    // Parse citations to make them clickable (handles both web and PDF citations)
    const parsedContent = parseCitations(markdownParsed);
    innerHTML += parsedContent;
  } else {
    // Apply markdown parsing for non-clickable messages too
    innerHTML += parseMarkdown(content);
  }
  
  msg.innerHTML = innerHTML;
  // Click handlers for citations and message toggle are handled by the
  // delegated listener on the container (_setupMessageContainerDelegate).
  
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;

  chatMessages.push({ content, type, timestamp: Date.now(), context });
}

function isGuideParseError(text) {
  return /Could not parse step JSON/i.test(String(text || ''));
}

function addGuideRetryMessage(errorText) {
  const container = document.getElementById('pageguide-messages');
  if (!container) return;
  hideTyping();
  container.querySelector('.pageguide-guide-retry-card')?.remove();
  const card = document.createElement('div');
  card.className = 'pageguide-guide-retry-card';
  card.innerHTML = `
    <div class="pageguide-guide-retry-title">Guide step could not be parsed</div>
    <div class="pageguide-guide-retry-body">${escapeHtml(errorText || 'The agent returned an invalid step response.')}</div>
    <button type="button" class="pageguide-step-next-btn pageguide-guide-retry-btn">Try again</button>`;
  card.querySelector('.pageguide-guide-retry-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.disabled = true;
    showTyping();
    try {
      const res = await sendToContentScript({ action: 'retryGuideStep' });
      if (!res || res.success === false) throw new Error(res?.error || 'Could not retry guide step');
      card.remove();
    } catch (err) {
      hideTyping();
      btn.disabled = false;
      addMessage(`Could not retry the guide step: ${err.message}`, 'system');
    }
  });
  container.appendChild(card);
  container.scrollTop = container.scrollHeight;
}

/**
 * Append a small chat message with a "View journey" button that re-displays a past guide's
 * task-panel journey (dots + snapshots) so its context isn't lost as new prompts come in.
 */
function addJourneyRecallMessage(sessionId, title, label = 'View journey') {
  const container = document.getElementById('pageguide-messages');
  if (!container || !sessionId) return;
  const msg = document.createElement('div');
  msg.className = 'pageguide-journey-recall';
  const sub = title ? `<span class="pageguide-journey-recall-sub">${escapeHtml(_truncateText(title))}</span>` : '';
  msg.innerHTML = `
    <button type="button" class="pageguide-journey-recall-btn" data-session="${escapeHtml(sessionId)}">
      <span class="pageguide-journey-recall-ico">🧭</span>
      <span class="pageguide-journey-recall-text">
        <span class="pageguide-journey-recall-title">${escapeHtml(label || 'View journey')}</span>
        ${sub}
      </span>
      <span class="pageguide-journey-recall-arrow">→</span>
    </button>`;
  // Click is handled by the delegated container listener (_setupMessageContainerDelegate) via the
  // button's data-session, so it survives the innerHTML restore that happens on tab switches.
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

/**
 * Concise, action-first label for one restore log entry, so the checklist reads cleanly (the
 * action up front; storage keys / selectors are secondary detail). Pure.
 */
function _steerActionLabel(e) {
  if (!e) return '';
  if (typeof gv2FriendlyRestoreAction === 'function') return gv2FriendlyRestoreAction(e);
  const t = (e.target && e.target.text) || e.sel || 'element';
  switch (e.kind) {
    case 'note':           return e.value || '';
    case 'localStorage':
    case 'sessionStorage': return `Restored saved setting${e.key ? ` "${e.key}"` : ''}`;
    case 'scroll':         return 'Restored scroll position';
    case 'form':           return `Refilled ${e.sel || 'a field'}`;
    case 'replay': {
      const verb = ({ type: 'Typed into', select: 'Selected', check: 'Toggled', toggle: 'Toggled' })[e.action] || 'Clicked';
      return `${verb} "${t}"`;
    }
    default:               return e.kind;
  }
}

function _steerActionIcon(e) {
  if (!e || e.ok === false) return '!';
  if (e.kind === 'scroll') return '↕';
  if (e.kind === 'form') return 'T';
  if (e.kind === 'replay') return '↗';
  return '•';
}

function _steerDisplayLog(log) {
  return (Array.isArray(log) ? log : []).filter(e => {
    if (!e) return false;
    if ((e.kind === 'localStorage' || e.kind === 'sessionStorage') && e.ok !== false) return false;
    const label = _steerActionLabel(e).trim().toLowerCase();
    if (!label) return false;
    if (label === 'restored saved page settings' || label === 'restore saved page settings') return false;
    return true;
  });
}

function _steerTechnicalLabel(e) {
  if (typeof gv2RestoreTechnicalDetail === 'function') return gv2RestoreTechnicalDetail(e);
  if (typeof gv2DescribeRestoreAction === 'function') return gv2DescribeRestoreAction(e);
  return _steerActionLabel(e);
}

function renderRestoreComparison(comparison) {
  const restored = Array.isArray(comparison?.restored) ? comparison.restored.filter(Boolean) : [];
  const notRestored = Array.isArray(comparison?.notRestored) ? comparison.notRestored.filter(Boolean) : [];
  const confidence = typeof comparison?.confidence === 'number' ? comparison.confidence : null;
  const needsReview = notRestored.length > 0 || (confidence != null && confidence < 0.65);
  const list = (items, empty) => items.length
    ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : `<div class="pageguide-steer-compare-empty">${escapeHtml(empty)}</div>`;
  const conf = confidence != null ? `<span>${Math.round(confidence * 100)}% confident</span>` : '';
  return `
    <div class="pageguide-steer-compare-card ${needsReview ? 'needs-review' : 'looks-restored'}">
      <div class="pageguide-steer-compare-head">
        <strong>${needsReview ? 'Needs review' : 'Looks restored'}</strong>
        ${conf}
      </div>
      <div class="pageguide-steer-compare-summary">${escapeHtml(comparison?.summary || 'Comparison complete.')}</div>
      <div class="pageguide-steer-compare-grid">
        <div><b>Restored</b>${list(restored, 'No clear restored items were identified.')}</div>
        <div><b>Still different</b>${list(notRestored, 'No meaningful visible differences found.')}</div>
      </div>
      ${comparison?.recommendation ? `<div class="pageguide-steer-compare-rec">${escapeHtml(comparison.recommendation)}</div>` : ''}
    </div>`;
}

/**
 * Steer restore confirmation card: after the agent rebuilds the recorded state for a steered step,
 * it pauses and shows the target "before step N" screenshot, a clean action checklist (with
 * advisory checkboxes), a hover snapshot of the live restored page, and recovery controls
 * (retry once / tell the agent what's wrong). The agent does NOT continue until the user acts.
 */
function addSteerRestoreCard(message) {
  const container = document.getElementById('pageguide-messages');
  if (!container) return;
  // Replace any stale card from a previous steer (also how retry/fix re-render in place).
  container.querySelector('.pageguide-steer-restore')?.remove();

  const log = _steerDisplayLog(message.log);

  const lines = log.length
    ? log.map((e) => {
        const ok = e.ok !== false;
        return `<li class="pageguide-steer-restore-item${ok ? '' : ' failed'}">
          <span class="pageguide-steer-restore-icon" aria-hidden="true">${escapeHtml(_steerActionIcon(e))}</span>
          <span class="pageguide-steer-restore-action">${escapeHtml(_steerActionLabel(e))}</span>
        </li>`;
      }).join('')
    : '<li class="pageguide-steer-restore-empty">No page actions were needed.</li>';

  const stepLabel = escapeHtml(String(message.redoStep != null ? message.redoStep : message.fromStep));
  // The recorded "before step N" screenshot — the exact target state we're restoring to.
  const targetImg = message.redoBeforeShot
    ? `<div class="pageguide-steer-restore-target">
         <div class="pageguide-steer-restore-target-cap">Target — page before step ${stepLabel}</div>
         <img class="pageguide-memory-shot-trigger" data-shot-kind="restore-target" alt="Before step ${stepLabel}" src="data:image/jpeg;base64,${message.redoBeforeShot}">
       </div>`
    : '';
  const snapBtn = message.restoreShot
    ? `<span class="pageguide-steer-restore-snap-wrap">
         <button type="button" class="pageguide-steer-restore-snap" title="Hover to preview the live restored page">📷 Live</button>
         <div class="pageguide-steer-restore-snap-pop"><img alt="Restored page" src="data:image/jpeg;base64,${message.restoreShot}"></div>
       </span>`
    : '';
  const errHtml = message.error
    ? `<div class="pageguide-steer-restore-error">${escapeHtml(message.error)}</div>`
    : '';
  const card = document.createElement('div');
  card.className = 'pageguide-step-card pageguide-steer-restore';
  card.innerHTML = `
    <div class="pageguide-guide-step pageguide-steer-restore-hdr">
      <span class="pageguide-step-badge">Restored</span>
      <span class="pageguide-step-text">Review the restored state before step ${stepLabel}.</span>
      ${snapBtn}
    </div>
    ${targetImg}
    ${message.url ? `<div class="pageguide-step-meta">🔗 ${escapeHtml(message.url)}</div>` : ''}
    <ul class="pageguide-steer-restore-log">${lines}</ul>
    ${errHtml}
    <div class="pageguide-step-btn-row">
      <button type="button" class="pageguide-step-next-btn pageguide-steer-restore-confirm">Confirm</button>
      <button type="button" class="pageguide-step-stop-btn pageguide-steer-restore-manual">Do it yourself</button>
    </div>`;

  // Re-enable the card's controls and surface an inline error when the content script can't be
  // reached — so the buttons never get stuck disabled.
  const recover = (msg) => {
    hideTyping();
    card.querySelectorAll('button').forEach(b => { b.disabled = false; });
    let errEl = card.querySelector('.pageguide-steer-restore-error');
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.className = 'pageguide-steer-restore-error';
      card.querySelector('.pageguide-step-btn-row')?.before(errEl);
    }
    errEl.textContent = msg;
  };

  card.querySelector('.pageguide-steer-restore-confirm')?.addEventListener('click', (e) => {
    e.stopPropagation();
    card.querySelectorAll('button').forEach(b => { b.disabled = true; });
    showTyping();
    sendToContentScript({ action: 'confirmSteerRestore' });
    card.remove();
  });
  card.querySelector('.pageguide-steer-restore-journey')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (message.sessionId) await showStoredJourney(message.sessionId);
  });
  card.querySelector('.pageguide-steer-restore-target img')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openMemoryShotLightbox(message.redoBeforeShot, `Before action — saved state before step ${stepLabel}`);
  });
  card.querySelector('.pageguide-steer-restore-manual')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const res = await sendToContentScript({ action: 'manualRestoreHere' });
      if (!res || res.success === false) throw new Error(res?.error || 'unavailable');
    } catch (err) {
      recover('Could not unlock manual restore. Try again.');
    } finally {
      btn.disabled = false;
    }
  });

  container.appendChild(card);
  container.scrollTop = container.scrollHeight;
}

/**
 * Load prefix steps of a session into memory.
 */
async function loadSessionSteps(sessionId) {
  let steps = null, title = '';
  if (sessionId && typeof rewindVerifyScreenshots === 'function') {
    try { await rewindVerifyScreenshots(sessionId); } catch (e) {}
  }
  const mem = _journeysBySession[sessionId];
  try {
    if (typeof rewindGetIndex === 'function') {
      const idx = await rewindGetIndex(sessionId);
      if (idx && idx.steps && idx.steps.length) {
        steps = idx.steps;
        title = idx.branchLabel || idx.goal || '';
      }
    }
  } catch (e) {}
  if ((!steps || !steps.length) && mem && mem.steps && mem.steps.length) {
    steps = mem.steps;
    title = mem.title || '';
  }
  if (!steps || !steps.length) return;

  const withSid = steps.map(m => Object.assign({}, m, { sessionId }));
  const voidSteps = withSid.filter(m => m.hasShot === false && !(m.isInitial || Number(m.step) === 0));
  const valid = withSid.filter(m => !voidSteps.includes(m));
  currentGuideInitial = valid.find(m => m.isInitial || Number(m.step) === 0) || null;
  currentGuideRecords = valid.filter(m => !(m.isInitial || Number(m.step) === 0));
  currentGuideTitle = title || '';
}

/**
 * Re-populate the task panel with a guide session's journey (read-only). Steps come from the
 * in-memory copy accumulated this session (robust to storage-shape changes); falls back to the
 * persisted index. Each dot opens its snapshot via showGoalStepPreview → rewindGetRecord. On
 * success it shows the journey card (no chat notification); only true unavailability posts an
 * error to the chat.
 */
async function showStoredJourney(sessionId) {
  let steps = null, title = '', isBranchJourney = false;
  if (sessionId && typeof rewindVerifyScreenshots === 'function') {
    try { await rewindVerifyScreenshots(sessionId); } catch (e) {}
  }
  const mem = _journeysBySession[sessionId];
  try {
    if (typeof rewindGetIndex === 'function') {
      const idx = await rewindGetIndex(sessionId);
      if (idx && idx.steps && idx.steps.length) {
        steps = idx.steps;
        title = idx.branchLabel || idx.goal || '';
        isBranchJourney = !!idx.parentSessionId;
      }
    }
  } catch (e) {}
  if ((!steps || !steps.length) && mem && mem.steps && mem.steps.length) { steps = mem.steps; title = mem.title || ''; }
  if (!steps || !steps.length) {
    addMessage('ℹ️ That journey is no longer available.', 'system');
    return;
  }
  // Attach sessionId to each meta so the dot preview can resolve its record. Split out the
  // initial-state node (step 0) so it doesn't inflate the step/dot count.
  const withSid = steps.map(m => Object.assign({}, m, { sessionId }));
  const voidSteps = withSid.filter(m => m.hasShot === false && !(m.isInitial || Number(m.step) === 0));
  const valid = withSid.filter(m => !voidSteps.includes(m));
  currentGuideInitial = valid.find(m => m.isInitial || Number(m.step) === 0) || null;
  currentGuideRecords = valid.filter(m => !(m.isInitial || Number(m.step) === 0));
  currentGuidePlan = [];
  currentGuideVerifications = {};
  currentGuideTitle = title || 'Guide journey';
  const lastStep = currentGuideRecords.length ? currentGuideRecords[currentGuideRecords.length - 1].step : 0;
  currentGuideStep = lastStep;
  guideActive = false; // recalled journey is a past, read-only view
  guidePaused = false;
  visibleJourneySessionId = sessionId;
  visibleJourneyTitle = currentGuideTitle;
  visibleJourneyRecalled = true;
  renderGoalCard({ route: 'guide', step: lastStep, title: currentGuideTitle });
  _setJourneyRecalledMode(true);
  updateGuidePauseButton();
}
if (typeof window !== 'undefined') window.showStoredJourney = showStoredJourney;

function removeGuideStepRecord(sessionId, step) {
  const n = Number(step);
  if (!Number.isFinite(n)) return;
  currentGuideRecords = currentGuideRecords.filter(r => Number(r.step) !== n);
  if (currentGuideInitial && Number(currentGuideInitial.step) === n) currentGuideInitial = null;
  if (sessionId && _journeysBySession[sessionId]?.steps) {
    _journeysBySession[sessionId].steps = _journeysBySession[sessionId].steps.filter(s => Number(s.step) !== n);
  }
  const last = currentGuideRecords.length ? currentGuideRecords[currentGuideRecords.length - 1].step : 0;
  currentGuideStep = last;
  renderGoalCard({ route: 'guide', step: last });
}
if (typeof window !== 'undefined') window.removeGuideStepRecord = removeGuideStepRecord;

function getActiveSessionId() {
  return visibleJourneySessionId || currentGuideInitial?.sessionId || (currentGuideRecords[0] ? currentGuideRecords[0].sessionId : null);
}

async function checkShowBranchButton() {
  const btn = document.getElementById('pageguide-show-branch-btn');
  if (!btn) return;

  const activeSessionId = getActiveSessionId();
  if (!activeSessionId) {
    btn.style.display = 'none';
    return;
  }

  btn.style.display = 'inline-flex';
}

let _branchTreeHoverCard = null;
let _hovercardPinned = false;
let _hovercardHideTimeout = null;
let _hovercardActiveNodeEl = null;

function _hideBranchTreeHover(force = false) {
  if (_hovercardPinned && !force) return;
  if (_branchTreeHoverCard) {
    _branchTreeHoverCard.remove();
    _branchTreeHoverCard = null;
  }
  if (force) {
    _hovercardPinned = false;
    _hovercardActiveNodeEl = null;
    if (_hovercardHideTimeout) {
      clearTimeout(_hovercardHideTimeout);
      _hovercardHideTimeout = null;
    }
  }
}

async function showBranchTree(keepZoom = false) {
  const overlay = document.getElementById('pageguide-branch-overlay');
  const body = document.getElementById('pageguide-branch-body');
  if (!overlay || !body) return;

  if (!keepZoom) {
    body.innerHTML = '<div style="opacity: 0.7; padding: 20px;">Building tree view...</div>';
  }
  overlay.style.display = 'flex';

  if (!keepZoom) {
    // Reset scale to 1.0 when opening
    currentTreeScale = 1.0;
  }
  const zoomLabel = document.getElementById('pg-zoom-label');
  if (zoomLabel) zoomLabel.textContent = `${Math.round(currentTreeScale * 100)}%`;

  const activeSessionId = getActiveSessionId();
  if (!activeSessionId) {
    body.innerHTML = '<div style="opacity: 0.7; padding: 20px;">No active guide session found.</div>';
    return;
  }

  try {
    const sessions = await rewindGetSessions();
    const sessionsMap = {};
    for (const s of sessions) {
      sessionsMap[s.sessionId] = s;
    }

    let rootSessionId = activeSessionId;
    while (sessionsMap[rootSessionId]?.parentSessionId) {
      rootSessionId = sessionsMap[rootSessionId].parentSessionId;
    }

    const related = sessions.filter(s => {
      let tempId = s.sessionId;
      while (tempId && tempId !== rootSessionId) {
        tempId = sessionsMap[tempId]?.parentSessionId;
      }
      return tempId === rootSessionId;
    });

    const indices = await Promise.all(related.map(s => rewindGetIndex(s.sessionId)));
    const validIndices = indices.filter(idx => idx && Array.isArray(idx.steps) && idx.steps.length > 0);

    if (validIndices.length === 0) {
      body.innerHTML = '<div style="opacity: 0.7; padding: 20px;">No steps available for this tree.</div>';
      return;
    }

    const canonicalNodes = {};

    function getCanonicalKey(sessionId, stepNum) {
      let sess = sessionsMap[sessionId];
      while (sess && sess.parentSessionId && stepNum <= sess.branchFromStep) {
        sessionId = sess.parentSessionId;
        sess = sessionsMap[sessionId];
      }
      return `${sessionId}::${stepNum}`;
    }

    for (const idx of validIndices) {
      for (const s of idx.steps) {
        const stepNum = Number(s.step);
        const key = getCanonicalKey(idx.sessionId, stepNum);
        if (!canonicalNodes[key]) {
          canonicalNodes[key] = {
            key,
            sessionId: key.split('::')[0],
            stepNum,
            meta: s,
            children: new Set()
          };
        }
      }
    }

    for (const idx of validIndices) {
      const sortedSteps = idx.steps.slice().sort((a, b) => Number(a.step) - Number(b.step));
      for (let i = 1; i < sortedSteps.length; i++) {
        const parentStep = sortedSteps[i - 1];
        const childStep = sortedSteps[i];
        const parentKey = getCanonicalKey(idx.sessionId, Number(parentStep.step));
        const childKey = getCanonicalKey(idx.sessionId, Number(childStep.step));
        if (parentKey !== childKey) {
          canonicalNodes[parentKey].children.add(childKey);
        }
      }
    }

    const rootKey = getCanonicalKey(rootSessionId, 0);
    if (!canonicalNodes[rootKey]) {
      const keys = Object.keys(canonicalNodes);
      if (keys.length === 0) {
        body.innerHTML = '<div style="opacity: 0.7; padding: 20px;">No steps available for this tree.</div>';
        return;
      }
    }

    function renderTreeNode(key) {
      const node = canonicalNodes[key];
      if (!node) return '';

      const childrenKeys = Array.from(node.children).sort();
      const isCurrent = (key === getCanonicalKey(activeSessionId, currentGuideStep));
      const stepLabel = node.stepNum === 0 ? 'Initial' : `Step ${node.stepNum}`;

      // Check if this node is the starting point of a branch diversion
      const S = sessionsMap[node.sessionId];
      const isBranchStart = S && S.parentSessionId && (node.stepNum === S.branchFromStep + 1);
      let branchBadgeHtml = '';
      if (isBranchStart) {
        const branchTitle = S.branchLabel || S.goal || 'Diverted';
        let ageText = '';
        let isRecent = false;
        if (S.startedAt) {
          const ageMs = Date.now() - S.startedAt;
          if (ageMs < 120000) {
            ageText = 'just now';
            isRecent = true;
          } else {
            const ageMin = Math.round(ageMs / 60000);
            if (ageMin < 60) {
              ageText = `${ageMin}m ago`;
            } else {
              const ageHr = Math.round(ageMin / 60);
              ageText = `${ageHr}h ago`;
            }
          }
        }
        const badgeLabel = ageText ? `${branchTitle} (${ageText})` : branchTitle;
        branchBadgeHtml = `<span class="pg-tree-branch-badge ${isRecent ? 'recent-branch' : ''}" title="${escapeHtml(branchTitle)}">${escapeHtml(badgeLabel)}</span>`;
      }

      const conf = node.meta.confidence;
      let statusDotHtml = '';
      if (conf != null) {
        const isGood = conf >= 0.7;
        const color = isGood ? '#22c55e' : '#eab308';
        const title = `Confidence: ${Math.round(conf * 100)}%`;
        statusDotHtml = `<span class="pg-tree-node-status-dot" style="background: ${color};" title="${title}"></span>`;
      }

      const isOriginal = (node.sessionId === rootSessionId);

      let childrenHtml = '';
      if (childrenKeys.length > 0) {
        childrenHtml = `
          <div class="pg-tree-children ${isOriginal ? 'original-path' : 'diverted-path'}">
            ${childrenKeys.map(childKey => renderTreeNode(childKey)).join('')}
          </div>
        `;
      }

      return `
        <div class="pg-tree-branch ${isOriginal ? 'original-path' : 'diverted-path'}">
          <div class="pg-tree-node ${isCurrent ? 'active-session-step' : ''} ${isOriginal ? 'original-path' : 'diverted-path'}" data-key="${key}">
            ${statusDotHtml}
            <span class="pg-tree-node-label">${stepLabel}</span>
            <span class="pg-tree-node-desc">${escapeHtml(_truncateText(node.meta.instruction || ''))}</span>
            ${branchBadgeHtml}
          </div>
          ${childrenHtml}
        </div>
      `;
    }

    const oldViewport = body.querySelector('#pg-tree-viewport');
    const oldScrollLeft = oldViewport ? oldViewport.scrollLeft : 0;
    const oldScrollTop = oldViewport ? oldViewport.scrollTop : 0;

    body.innerHTML = `
      <div class="pg-tree-viewport" id="pg-tree-viewport" style="width: 100%; height: 100%; overflow: auto;">
        <div class="pg-tree-content" id="pg-tree-content" style="transform: scale(${currentTreeScale}); transform-origin: top left; display: inline-block; padding: 20px;">
          ${renderTreeNode(rootKey)}
        </div>
      </div>
    `;

    // Canvas Panning dragging event handling
    const viewport = body.querySelector('#pg-tree-viewport');
    if (viewport && keepZoom) {
      viewport.scrollLeft = oldScrollLeft;
      viewport.scrollTop = oldScrollTop;
    }
    if (viewport) {
      viewport.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isPanning = true;
        wasDragging = false;
        startX = e.pageX - viewport.offsetLeft;
        startY = e.pageY - viewport.offsetTop;
        scrollLeft = viewport.scrollLeft;
        scrollTop = viewport.scrollTop;
      });

      const onMouseMove = (e) => {
        if (!isPanning) return;
        const x = e.pageX - viewport.offsetLeft;
        const y = e.pageY - viewport.offsetTop;
        const walkX = x - startX;
        const walkY = y - startY;
        if (Math.abs(walkX) > 3 || Math.abs(walkY) > 3) {
          wasDragging = true;
        }
        viewport.scrollLeft = scrollLeft - walkX;
        viewport.scrollTop = scrollTop - walkY;
      };

      const onMouseUp = () => {
        isPanning = false;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }

    const showCard = async (nodeEl) => {
      const key = nodeEl.dataset.key;
      const node = canonicalNodes[key];
      if (!node) return;

      let rec = null;
      try {
        rec = await rewindGetRecord(node.sessionId, node.stepNum);
      } catch (e) {}

      if (_branchTreeHoverCard && _hovercardActiveNodeEl === nodeEl) return;

      if (_branchTreeHoverCard) {
        _branchTreeHoverCard.remove();
        _branchTreeHoverCard = null;
      }

      const card = document.createElement('div');
      card.className = 'pg-tree-hovercard pageguide-goal-step-preview';

      const PLACEHOLDER_SHOT = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      let beforeShot = rec?.screenshotBefore || rec?.screenshot || null;
      if (beforeShot === PLACEHOLDER_SHOT) beforeShot = null;
      let regionShot = rec?.regionShot || null;
      if (regionShot === PLACEHOLDER_SHOT) regionShot = null;
      const topShot = regionShot || beforeShot;
      const imgHtml = topShot 
        ? `<img src="data:image/jpeg;base64,${topShot}" alt="" ${(!regionShot && beforeShot) ? 'class="pageguide-memory-shot-trigger" data-shot-kind="before"' : ''}>` 
        : '<div class="pageguide-goal-step-preview-empty">No screenshot yet</div>';

      const beforeHtml = (beforeShot && regionShot)
        ? `<details class="pageguide-goal-step-before"><summary>Before action screenshot</summary>
            <img class="pageguide-memory-shot-trigger" data-shot-kind="before" src="data:image/jpeg;base64,${beforeShot}" alt="before action"></details>`
        : '';

      const conf = node.meta.confidence;
      const tier = (typeof gv2ConfidenceTier === 'function') ? gv2ConfidenceTier(conf) : null;
      const badgeHtml = (tier && conf != null)
        ? `<div class="pageguide-goal-step-conf ${tier === 'high' ? 'conf-high' : 'conf-med'}">Confidence: ${Math.round(conf * 100)}%</div>`
        : '';

      const actionText = node.meta.action ? `[${node.meta.action.toUpperCase()}] ` : '';
      const instruction = node.meta.instruction || 'Initial state';

      const url = node.meta.url || rec?.url || '';
      const urlHtml = url ? `<a class="pageguide-goal-step-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="${escapeHtml(url)}">🔗 link</a>` : '';

      const allowSteer = node.stepNum > 0;

      card.innerHTML = `
        ${badgeHtml}
        ${imgHtml}
        <div class="pageguide-goal-step-preview-title">${node.stepNum === 0 ? 'Initial State' : 'Step ' + node.stepNum}</div>
        <div class="pageguide-goal-step-preview-text"><b>${actionText}</b>${escapeHtml(instruction)}</div>
        ${urlHtml}
        ${beforeHtml}
        ${node.meta.durationMs != null ? `<div class="pageguide-goal-step-preview-meta">${_formatDuration(node.meta.durationMs)}</div>` : ''}
        <button type="button" class="pageguide-goal-step-inspect">Inspect more</button>
        ${allowSteer ? '<button type="button" class="pageguide-goal-step-steer">Restore here</button>' : ''}
      `;

      if (allowSteer) {
        const steerBtn = card.querySelector('.pageguide-goal-step-steer');

        steerBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          steerBtn.disabled = true;
          
          if (typeof RewindTimeline !== 'undefined' && typeof RewindTimeline.steerFromStep === 'function') {
            const ok = await RewindTimeline.steerFromStep({
              sessionId: node.sessionId,
              step: node.stepNum,
              url: node.meta.url
            }, '');
            if (ok) {
              _hideBranchTreeHover(true);
            } else {
              steerBtn.disabled = false;
            }
          }
        });
      }

      const inspectBtn = card.querySelector('.pageguide-goal-step-inspect');
      if (inspectBtn) {
        inspectBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          _hideBranchTreeHover(true);
          if (typeof RewindTimeline !== 'undefined' && typeof RewindTimeline.openStep === 'function') {
            RewindTimeline.openStep(node.meta);
          }
        });
      }

      card.addEventListener('click', (e) => {
        const target = e.target;
        if (target.closest('button') || 
            target.closest('textarea') || 
            target.closest('a')) {
          return;
        }
        if (target.closest('.pageguide-memory-shot-trigger')) {
          const isInitialNode = node.stepNum === 0;
          if (typeof openMemoryShotLightbox === 'function') {
            openMemoryShotLightbox(beforeShot, isInitialNode ? 'Initial state — saved page memory' : 'Before action — what PageGuide saw before this step');
          }
          return;
        }
        if (target.closest('.pageguide-goal-step-before')) {
          return;
        }
        _hideBranchTreeHover(true);
        if (typeof RewindTimeline !== 'undefined' && typeof RewindTimeline.openStep === 'function') {
          RewindTimeline.openStep(node.meta);
        }
      });

      document.body.appendChild(card);
      _branchTreeHoverCard = card;
      _hovercardActiveNodeEl = nodeEl;

      const r = nodeEl.getBoundingClientRect();
      let left = r.right + 10;
      let top = Math.max(8, Math.min(r.top, window.innerHeight - card.offsetHeight - 8));

      if (left + card.offsetWidth > window.innerWidth) {
        left = Math.max(8, r.left - card.offsetWidth - 10);
      }

      card.style.left = left + 'px';
      card.style.top = top + 'px';

      card.addEventListener('mouseenter', () => {
        cancelHideTimer();
      });
      card.addEventListener('mouseleave', () => {
        startHideTimer();
      });
    };

    const cancelHideTimer = () => {
      if (_hovercardHideTimeout) {
        clearTimeout(_hovercardHideTimeout);
        _hovercardHideTimeout = null;
      }
    };

    const startHideTimer = () => {
      if (_hovercardPinned) return;
      cancelHideTimer();
      _hovercardHideTimeout = setTimeout(() => {
        _hideBranchTreeHover();
      }, 300);
    };

    body.querySelectorAll('.pg-tree-node').forEach(nodeEl => {
      nodeEl.addEventListener('mouseenter', async () => {
        cancelHideTimer();
        if (_hovercardPinned && _hovercardActiveNodeEl === nodeEl) return;
        await showCard(nodeEl);
      });

      nodeEl.addEventListener('mouseleave', () => {
        startHideTimer();
      });

      nodeEl.addEventListener('click', async (e) => {
        if (wasDragging) return;
        e.stopPropagation();
        
        cancelHideTimer();
        _hovercardPinned = true;
        
        if (!_branchTreeHoverCard || _hovercardActiveNodeEl !== nodeEl) {
          await showCard(nodeEl);
        }
      });
    });

  } catch (e) {
    console.error('Failed to build branch tree:', e);
    body.innerHTML = `<div style="color: var(--pg-danger); padding: 20px;">Failed to load branch tree: ${escapeHtml(e.message)}</div>`;
  }
}
if (typeof window !== 'undefined') {
  window.checkShowBranchButton = checkShowBranchButton;
  window.showBranchTree = showBranchTree;
}

async function registerBranchJourney(sessionId, label) {
  if (!sessionId) return;
  const title = label || 'View branch journey';
  if (!_journeysBySession[sessionId]) _journeysBySession[sessionId] = { title, steps: [] };
  _journeysBySession[sessionId].title = title;
  if (!_journeyBtnSessions.has(sessionId)) {
    _journeyBtnSessions.add(sessionId);
    addJourneyRecallMessage(sessionId, title, title);
  }
  checkShowBranchButton();
}
if (typeof window !== 'undefined') window.registerBranchJourney = registerBranchJourney;
if (typeof window !== 'undefined') window.addJourneyRecallMessage = addJourneyRecallMessage;

// Mark the goal card as a recalled (read-only) view — used only for styling (hides the caret).
function _setJourneyRecalledMode(on) {
  const card = document.getElementById('pageguide-goal');
  if (card) card.classList.toggle('pageguide-goal--recalled', !!on);
  if (!on) {
    visibleJourneySessionId = null;
    visibleJourneyTitle = '';
    visibleJourneyRecalled = false;
  }
}

// Ensure the journey/goal card has a collapse (✕) button that hides it. Present in every guide
// mode (live or recalled), so the user can always collapse the journey.
function _ensureGoalCollapseBtn() {
  const card = document.getElementById('pageguide-goal');
  if (!card || document.getElementById('pageguide-goal-collapse')) return;
  const row = card.querySelector('.pageguide-goal-title-row');
  if (!row) return;
  const btn = document.createElement('button');
  btn.id = 'pageguide-goal-collapse';
  btn.type = 'button';
  btn.className = 'pageguide-goal-collapse';
  btn.title = 'Collapse journey';
  btn.setAttribute('aria-label', 'Collapse journey');
  btn.textContent = '✕';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    card.style.display = 'none';
    visibleJourneySessionId = null;
    visibleJourneyTitle = '';
    visibleJourneyRecalled = false;
  });
  row.appendChild(btn);
}

/**
 * Add a collapsible debug/info section
 * Uses native <details>/<summary> so the toggle is always reliably clickable.
 */
function addCollapsibleDebug(lines) {
  const container = document.getElementById('pageguide-messages');
  if (!container) return;

  const details = document.createElement('details');
  details.className = 'pageguide-debug-wrapper';

  const summary = document.createElement('summary');
  summary.className = 'pageguide-debug-toggle';
  summary.innerHTML = `<span class="pageguide-debug-label">Details</span>`;

  const content = document.createElement('div');
  content.className = 'pageguide-debug-content';

  lines.forEach(line => {
    const lineEl = document.createElement('div');
    lineEl.className = 'pageguide-debug-line';
    lineEl.textContent = line;
    content.appendChild(lineEl);
  });

  details.appendChild(summary);
  details.appendChild(content);
  container.appendChild(details);
  container.scrollTop = container.scrollHeight;
}

// ===== Guide Mode Toggle (Manual vs Auto) =====
// Manual: the user clicks each highlighted step. Auto: the agent performs reversible,
// low-risk steps itself and hands control back for sensitive ones. The flag lives in
// chrome.storage.local so the content script (guidev2.js) reads the same value.
const GUIDE_AUTO_MODE_KEY = 'guideAutoMode';

function _renderGuideMode(btn, auto) {
  btn.innerHTML = auto ? `${UI_ICONS.bolt}Auto ▾` : `${UI_ICONS.hand}Manual ▾`;
  btn.classList.toggle('pageguide-mode-auto', !!auto);
  btn.title = auto
    ? 'Autonomous mode: the agent completes low-risk steps and pauses for sensitive ones.'
    : 'Manual mode: you do each step yourself.';
  document.querySelectorAll('.pageguide-mode-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.mode === (auto ? 'auto' : 'manual'));
  });
}

function initGuideModeToggle() {
  const btn = document.getElementById('pageguide-mode-toggle');
  const menu = document.getElementById('pageguide-mode-menu');
  if (!btn) return;
  chrome.storage.local.get(GUIDE_AUTO_MODE_KEY)
    .then(r => _renderGuideMode(btn, r[GUIDE_AUTO_MODE_KEY] === true))
    .catch(() => _renderGuideMode(btn, false));

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  menu?.addEventListener('click', async (e) => {
    const option = e.target.closest('.pageguide-mode-option');
    if (!option) return;
    e.stopPropagation();
    const auto = option.dataset.mode === 'auto';
    try { await chrome.storage.local.set({ [GUIDE_AUTO_MODE_KEY]: auto }); } catch (e) {}
    _renderGuideMode(btn, auto);
    menu.style.display = 'none';
  });
}

// ===== Confidence Formula Toggle (Full / No-progress / No-loop) =====
// Full:        C = grounded × (1 − λ_L·loop) × (1 + λ_P·progress).
// No-progress: C = grounded × (1 − λ_L·loop)              (drops progress).
// No-loop:     C = grounded × (1 + λ_P·progress)          (drops loop penalty).
// Stored in chrome.storage.local so the content script (guidev2.js) reads the same value.
const GUIDE_CONF_FORMULA_KEY = 'guideConfidenceFormula';
const GUIDE_CONF_FORMULAS = {
  full:    { label: 'Full',        title: 'Full: confidence = grounding × loop penalty × progress.' },
  reduced: { label: 'No-progress', title: 'No-progress: confidence = grounding × loop penalty (no progress term).' },
  noloop:  { label: 'No-loop',     title: 'No-loop: confidence = grounding × progress (no loop penalty).' }
};

function _normalizeConfFormula(v) {
  return (v === 'reduced' || v === 'noloop') ? v : 'full';
}

function _renderConfFormula(btn, formula) {
  formula = _normalizeConfFormula(formula);
  const spec = GUIDE_CONF_FORMULAS[formula];
  btn.innerHTML = `${UI_ICONS.gauge}Confidence: ${spec.label} ▾`;
  btn.title = spec.title;
  document.querySelectorAll('#pageguide-conf-menu .pageguide-mode-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.formula === formula);
  });
}

function initConfidenceFormulaToggle() {
  const btn = document.getElementById('pageguide-conf-toggle');
  const menu = document.getElementById('pageguide-conf-menu');
  if (!btn) return;
  chrome.storage.local.get(GUIDE_CONF_FORMULA_KEY)
    .then(r => _renderConfFormula(btn, _normalizeConfFormula(r[GUIDE_CONF_FORMULA_KEY])))
    .catch(() => _renderConfFormula(btn, 'full'));

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  menu?.addEventListener('click', async (e) => {
    const option = e.target.closest('.pageguide-mode-option');
    if (!option) return;
    e.stopPropagation();
    const formula = _normalizeConfFormula(option.dataset.formula);
    try { await chrome.storage.local.set({ [GUIDE_CONF_FORMULA_KEY]: formula }); } catch (e) {}
    _renderConfFormula(btn, formula);
    menu.style.display = 'none';
  });
}

// Confidence SOURCE toggle (debug-only): which score drives the timeline tier / pause / red highlight.
const GUIDE_CONF_SOURCE_KEY = 'guideConfidenceSource';
const GUIDE_CONF_SOURCES = {
  llm:        { label: 'LLM',    title: 'Confidence from the model\'s self-reported grounded/loop/progress.' },
  mechanical: { label: 'No-LLM', title: 'Rule-based confidence: SoM grounding × loop penalty (no model self-grading).' }
};

function _normalizeConfSource(v) {
  return v === 'mechanical' ? 'mechanical' : 'llm';
}

function _renderConfSource(btn, source) {
  source = _normalizeConfSource(source);
  const spec = GUIDE_CONF_SOURCES[source];
  btn.innerHTML = `${UI_ICONS.gauge}Source: ${spec.label} ▾`;
  btn.title = spec.title;
  document.querySelectorAll('#pageguide-confsrc-menu .pageguide-mode-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.source === source);
  });
}

function initConfidenceSourceToggle() {
  const btn = document.getElementById('pageguide-confsrc-toggle');
  const menu = document.getElementById('pageguide-confsrc-menu');
  if (!btn) return;
  chrome.storage.local.get(GUIDE_CONF_SOURCE_KEY)
    .then(r => _renderConfSource(btn, _normalizeConfSource(r[GUIDE_CONF_SOURCE_KEY])))
    .catch(() => _renderConfSource(btn, 'llm'));

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  menu?.addEventListener('click', async (e) => {
    const option = e.target.closest('.pageguide-mode-option');
    if (!option) return;
    e.stopPropagation();
    const source = _normalizeConfSource(option.dataset.source);
    try { await chrome.storage.local.set({ [GUIDE_CONF_SOURCE_KEY]: source }); } catch (e) {}
    _renderConfSource(btn, source);
    menu.style.display = 'none';
  });
}

function hideMoreMenu() {
  const menu = document.getElementById('pageguide-more-menu');
  if (menu) menu.style.display = 'none';
}

function initPanelMenus() {
  const moreBtn = document.getElementById('pageguide-more-btn');
  const moreMenu = document.getElementById('pageguide-more-menu');
  const infoBtn = document.getElementById('pageguide-info');
  const infoPop = document.getElementById('pageguide-info-pop');

  moreBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (moreMenu) moreMenu.style.display = moreMenu.style.display === 'none' ? 'block' : 'none';
    if (infoPop) infoPop.style.display = 'none';
  });

  infoBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (infoPop) infoPop.style.display = infoPop.style.display === 'none' ? 'block' : 'none';
    hideMoreMenu();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.pageguide-menu-wrap')) hideMoreMenu();
    if (!e.target.closest('.pageguide-footer')) {
      const pop = document.getElementById('pageguide-info-pop');
      if (pop) pop.style.display = 'none';
    }
    // Close any open mode/confidence dropdown whose wrap the click landed outside of.
    document.querySelectorAll('.pageguide-mode-wrap').forEach(wrap => {
      if (!wrap.contains(e.target)) {
        const menu = wrap.querySelector('.pageguide-mode-menu');
        if (menu) menu.style.display = 'none';
      }
    });
  });
}

function renderStepWarning(step) {
  const warning = currentGuideWarnings[step] || currentGuideWarnings[currentGuideStep];
  if (!warning) return '';
  const label = warning.status === 'blocked' ? 'Needs your attention' : 'Verification warning';
  return `
    <div class="pageguide-step-warning">
      <div class="pageguide-step-warning-title">⚠️ ${escapeHtml(label)}</div>
      ${warning.reason ? `<div class="pageguide-step-warning-reason">${escapeHtml(warning.reason)}</div>` : ''}
    </div>`;
}

function clearGuideWarning(step) {
  if (step == null) {
    currentGuideWarnings = {};
  } else {
    delete currentGuideWarnings[step];
    const meta = getGuideStepMeta(step);
    if (meta?.planStep != null) delete currentGuideWarnings[meta.planStep];
  }
  const card = document.querySelector('#pageguide-step-panel .pageguide-step-card');
  card?.querySelector('.pageguide-step-warning')?.remove();
  card?.querySelector('.pageguide-step-verify-actions')?.remove();
}

function withGuideNextTimeout(promise, timeoutMs = 30000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Guide continuation timed out')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function addGuidePausedMessage(reason = '') {
  document.querySelector('.pageguide-guide-resume-card')?.remove();
  if (reason) {
    const container = document.getElementById('pageguide-messages');
    const duplicate = container
      ? Array.from(container.querySelectorAll('.pageguide-message.system')).some(el => el.textContent.trim() === reason)
      : false;
    if (!duplicate) addMessage(reason, 'system');
  }
  guidePaused = true;
  guideActive = false;
  updateGuidePauseButton();
}

async function resumeGuideFromPanel() {
  const btn = document.getElementById('pageguide-guide-pause');
  if (btn) btn.disabled = true;
  showTyping();
  try {
    const res = await sendToContentScript({ action: 'resumeGuide' });
    if (!res || res.success === false) throw new Error(res?.error || 'Could not resume guide');
    guidePaused = false;
    guideActive = true;
    updateGuidePauseButton();
  } catch (err) {
    hideTyping();
    if (/Guide not active/i.test(String(err.message || ''))) {
      guidePaused = false;
      guideActive = false;
      updateGuidePauseButton();
    } else if (btn) {
      btn.disabled = false;
    }
    addMessage(`Could not resume the guide: ${err.message}`, 'system');
  }
}

async function pauseGuide(message = 'Guide paused.') {
  const btn = document.getElementById('pageguide-guide-pause');
  if (btn) btn.disabled = true;
  try {
    const res = await sendToContentScript({ action: 'pauseGuide', reason: message });
    if (!res || res.success === false) throw new Error(res?.error || 'Guide not active');
    guidePaused = true;
    guideActive = false;
    hideTyping();
    updateGuidePauseButton();
  } catch (e) {
    if (btn) btn.disabled = false;
    addMessage(`Could not pause the guide: ${e.message}`, 'system');
  }
}

/**
 * Add a guide step message
 */
function addGuideStep(result) {
  const panel = document.getElementById('pageguide-step-panel');
  if (!panel) return;

  guideActive = !result.isLastStep;
  guidePaused = false;
  hideTyping();
  updateGuidePauseButton();
  _setJourneyRecalledMode(false); // a live step replaces any recalled read-only view

  // Timeline is concrete-step indexed (one dot per step taken), so track the concrete step.
  currentGuideStep = result.step || result.planStep || currentGuideStep;
  if (result.step != null) delete currentGuideWarnings[result.step];
  if (result.isLastStep) clearGuideWarning();
  renderGoalCard({
    route: 'guide',
    step: currentGuideStep,
    total: currentGuidePlan.length || result.totalSteps || undefined
  });

  if (result.autoMode && !result.isLastStep) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  const stepBadge = result.isLastStep ? '✅' : `Step ${result.step}`;
  const targetRow = result.targetText
    ? `<div class="pageguide-step-meta-row"><span>Target</span><b>${escapeHtml(result.targetText)}</b></div>`
    : '';
  const warning = renderStepWarning(result.step);

  panel.innerHTML = `
    <div class="pageguide-step-card ${result.hasHighlights ? 'pageguide-clickable' : ''}">
      <button type="button" class="pageguide-step-collapse" title="Collapse" aria-label="Collapse step panel">✕</button>
      <div class="pageguide-guide-step">
        <span class="pageguide-step-badge">${escapeHtml(stepBadge)}</span>
        <span class="pageguide-step-text">${escapeHtml(result.answer || '')}</span>
      </div>
      <div class="pageguide-step-meta">
        ${targetRow}
      </div>
      ${warning}
      <div class="pageguide-step-btn-row"></div>
    </div>
  `;
  panel.style.display = '';
  panel.onclick = (e) => {
    if (e.target.closest('button')) return;
    if (result.hasHighlights) sendToContentScript({ action: 'scrollToHighlight' });
  };
  // Collapse (✕) hides the current-step panel in guide mode.
  panel.querySelector('.pageguide-step-collapse')?.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.style.display = 'none';
  });

  if (!result.isLastStep) {
    const btnRow = panel.querySelector('.pageguide-step-btn-row');

    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'pageguide-step-stop-btn';
    pauseBtn.textContent = 'Pause';
    pauseBtn.title = 'Pause the guide at this step';
    pauseBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't trigger scroll-to-highlight
      pauseGuide(`Paused after step ${result.step}. Resume when you want the agent to continue.`);
    });

    // Manual mode: every non-final step gets a Next button, so the user can do
    // the action on the page and then ask for the next step.
    const nextBtn = document.createElement('button');
    nextBtn.className = 'pageguide-step-next-btn';
    nextBtn.textContent = 'Next →';
    nextBtn.title = 'Continue after you complete this step';
    nextBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      nextBtn.disabled = true;
      pauseBtn.disabled = true;
      showTyping();
      try {
        const response = await withGuideNextTimeout(
          sendToContentScript({ action: 'nextGuideStep', source: 'panel' })
        );
        if (!response || response.success === false || response.progressed === false) {
          throw new Error(response?.error || 'Guide did not advance');
        }
      } catch (err) {
        hideTyping();
        if (nextBtn.isConnected) nextBtn.disabled = false;
        if (pauseBtn.isConnected) pauseBtn.disabled = false;
        if (!String(err.message || '').startsWith('Stopped after 15 steps')) {
          addMessage(`Could not continue the guide: ${err.message}. Try Next again, or stop here.`, 'system');
        }
      }
    });
    btnRow.appendChild(nextBtn);

    if (btnRow) btnRow.appendChild(pauseBtn);
  } else {
    const row = panel.querySelector('.pageguide-step-btn-row');
    if (row) row.remove();
  }

  // On step 1, show the matched tutorial reference in a collapsible Details section
  if (result.tutorialMatch) {
    const { task, website, steps, reason } = result.tutorialMatch;
    const lines = [
      `📚 Tutorial: ${website}`,
      `🔍 Matched: "${task}"`,
      `💡 Reason: ${reason}`,
      ``,
      `📋 Reference steps:`,
      ...steps.map(s => `  ${s}`)
    ];
    addCollapsibleDebug(lines);
  }
}

/**
 * Add an ask step message (for scroll/expand actions)
 */
function addAskStep(result) {
  const container = document.getElementById('pageguide-messages');
  if (!container) return;
  
  hideTyping();
  
  const msg = document.createElement('div');
  msg.className = 'pageguide-message ask-step';
  
  // Different icons for different action types
  const actionIcon = result.actionType === 'scroll' ? '📜' : '📦';
  const actionHint = result.actionType === 'scroll' 
    ? '⏳ Auto-scrolling in 2 seconds...' 
    : '👆 Click the highlighted button';
  
  msg.innerHTML = `
    <div class="pageguide-ask-step">
      <span class="pageguide-action-icon">${actionIcon}</span>
      <span class="pageguide-step-text">${result.answer}</span>
    </div>
    <div class="pageguide-action-hint">${actionHint}</div>
  `;
  
  if (result.hasHighlights) {
    msg.classList.add('pageguide-clickable');
    // Click handler handled by delegated listener (_setupMessageContainerDelegate).
  }

  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

/**
 * Show typing indicator. In guide mode, appends a Stop button.
 */
// Morph the send button (➤) into a square Stop (■) while the agent is running, and back.
// `panelRunning` is the single source of truth used by the click handler to route to stop.
function setRunning(on) {
  panelRunning = !!on;
  const btn = document.getElementById('pageguide-send');
  if (!btn) return;
  btn.disabled = false; // stays clickable — it's the Stop control while running
  btn.classList.toggle('pageguide-send-btn--stop', panelRunning);
  btn.textContent = panelRunning ? '■' : '➤';
  btn.title = panelRunning ? 'Stop' : 'Send';
  btn.setAttribute('aria-label', panelRunning ? 'Stop' : 'Send');
}

// Stop whatever is running. A guide is aborted for real (stopGuide → gv2StopGuide, also clears
// SW state); other routes just cancel the UI (the in-flight LLM result is discarded via
// cancelRequested). stopGuide is called unconditionally because a guide may already be running
// in the content script even before guideActive flips on the first step — harmless otherwise.
function stopRun() {
  cancelRequested = true;
  setRunning(false);
  stopGuide('⏹ Stopped.');
}

function showTyping() {
  setRunning(true);
  const container = document.getElementById('pageguide-messages');
  if (!container || container.querySelector('.pageguide-typing')) return;

  const typing = document.createElement('div');
  typing.className = 'pageguide-typing';
  typing.innerHTML = '<span></span><span></span><span></span>';

  container.appendChild(typing);
  container.scrollTop = container.scrollHeight;
}

/**
 * Stop an in-progress guide session.
 * @param {string} [message] - Optional message shown in chat; defaults to generic stop notice.
 */
async function stopGuide(message = '⏹ Guide stopped.') {
  guideActive = false;
  guidePaused = false;
  guideStopped = true; // suppress any late running-state messages from an in-flight content script
  hideTyping();
  updateGuidePauseButton();
  // Set the Stop tombstone + clear the resume fallback BEFORE messaging the content script, so
  // Stop is authoritative even if the content script is already gone (mid-navigation): the next
  // page load reads the tombstone and refuses to resume. Keys match guidev2.js (_GV2_STOP_KEY /
  // _GV2_KEY).
  try { await chrome.storage.session.set({ pageguideGuidanceV2Stopped: Date.now() }); } catch (e) {}
  try { await chrome.storage.session.remove('pageguideGuidanceV2'); } catch (e) {}
  // Clear SW state directly so it won't tell the next page to resume.
  try { chrome.runtime.sendMessage({ action: 'guidanceV2_clearState' }); } catch (e) {}
  try {
    await sendToContentScript({ action: 'stopGuide' });
  } catch (e) { /* content script may not be reachable */ }
  addMessage(message, 'system');
}

/**
 * Hide typing indicator
 */
function hideTyping() {
  document.querySelector('.pageguide-typing')?.remove();
  setRunning(false);
}

/**
 * Send message to content script
 */
async function sendToContentScript(message) {
  if (!currentTabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab?.id;
  }
  
  if (!currentTabId) {
    throw new Error('No active tab found');
  }
  
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(currentTabId, message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Handle paste image (Ctrl+V / Cmd+V)
 */
async function handlePasteImage(event) {
  const clipboardItems = event.clipboardData?.items;
  if (!clipboardItems) return;
  
  // Look for image in clipboard
  for (const item of clipboardItems) {
    if (item.type.startsWith('image/')) {
      event.preventDefault();
      
      const file = item.getAsFile();
      if (!file) continue;
      
      // Validate file size (max 10MB)
      if (file.size > 10 * 1024 * 1024) {
        addMessage('❌ Image too large. Max size is 10MB', 'error');
        return;
      }
      
      try {
        // Convert to base64
        const reader = new FileReader();
        reader.onload = async (e) => {
          const base64 = e.target.result;
          // Remove data URL prefix to get pure base64
          uploadedImageBase64 = base64.split(',')[1];
          
          // Show preview
          const preview = document.getElementById('pageguide-image-preview');
          const previewImg = document.getElementById('pageguide-preview-img');
          const uploadLabel = document.getElementById('pageguide-upload-label');
          
          if (preview && previewImg) {
            previewImg.src = base64;
            preview.style.display = 'flex';
          }
          
          // Highlight upload button and show image icon
          if (uploadLabel) uploadLabel.classList.add('has-image');
          _setUploadIcon('📷');
          
          // Send image to content script
          try {
            await sendToContentScript({
              action: 'setUploadedImage',
              imageBase64: uploadedImageBase64
            });
            console.log('🖼️ Pasted image sent to content script');
          } catch (err) {
            console.warn('🖼️ Could not send pasted image to content script:', err);
          }

          // Update placeholder to hint about asking
          const input = document.getElementById('pageguide-input');
          if (input) {
            input.placeholder = 'Ask about the pasted image...';
            input.focus();
          }

          addMessage('📋 Image pasted! Ask me to find it on the page.', 'system');
        };
        
        reader.readAsDataURL(file);
        return; // Only handle first image
      } catch (err) {
        addMessage(`❌ Error pasting image: ${err.message}`, 'error');
      }
    }
  }
}

/**
 * Route file uploads: images go to handleImageUpload, everything else to handleFileUpload.
 */
async function handleUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.type.startsWith('image/')) {
    await handleImageUpload(event);
  } else {
    await handleFileUpload(event);
  }
}

/** Update the combined upload button icon */
function _setUploadIcon(kind) {
  const icon = document.getElementById('pageguide-upload-icon');
  if (!icon) return;
  const key = kind === '📷' || kind === 'image' ? 'image' : (kind === 'file' ? 'file' : 'attach');
  icon.innerHTML = UI_ICONS[key].replace(/^<span class="pageguide-inline-icon">|<\/span>$/g, '');
}

/**
 * Handle image upload
 */
async function handleImageUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  
  // Validate file type
  if (!file.type.startsWith('image/')) {
    addMessage('❌ Please upload an image file', 'error');
    return;
  }
  
  // Validate file size (max 10MB)
  if (file.size > 10 * 1024 * 1024) {
    addMessage('❌ Image too large. Max size is 10MB', 'error');
    return;
  }
  
  try {
    // Convert to base64
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = e.target.result;
      // Remove data URL prefix to get pure base64
      uploadedImageBase64 = base64.split(',')[1];
      
      // Show preview
      const preview = document.getElementById('pageguide-image-preview');
      const previewImg = document.getElementById('pageguide-preview-img');
      const uploadLabel = document.getElementById('pageguide-upload-label');
      
      if (preview && previewImg) {
        previewImg.src = base64;
        preview.style.display = 'flex';
      }
      
      // Highlight upload button and show image icon
      if (uploadLabel) uploadLabel.classList.add('has-image');
      _setUploadIcon('📷');

      // Send image to content script
      try {
        await sendToContentScript({
          action: 'setUploadedImage',
          imageBase64: uploadedImageBase64
        });
        console.log('🖼️ Image sent to content script');
      } catch (err) {
        console.warn('🖼️ Could not send image to content script:', err);
      }

      // Update placeholder to hint about asking
      const input = document.getElementById('pageguide-input');
      if (input) {
        input.placeholder = 'Ask about the uploaded image...';
      }

      addMessage('📷 Image uploaded! Ask me to find it on the page.', 'system');
    };
    
    reader.readAsDataURL(file);
  } catch (err) {
    addMessage(`❌ Error uploading image: ${err.message}`, 'error');
  }
}

/**
 * Clear uploaded image
 */
async function clearUploadedImage() {
  uploadedImageBase64 = null;

  // Hide preview and clear region overlays
  const preview = document.getElementById('pageguide-image-preview');
  const wrapper = document.getElementById('pageguide-image-wrapper');
  const uploadLabel = document.getElementById('pageguide-upload-label');
  const input = document.getElementById('pageguide-input');
  const fileInput = document.getElementById('pageguide-image-upload');
  const label = document.getElementById('pageguide-image-label');

  if (preview) preview.style.display = 'none';
  if (wrapper) {
    wrapper.classList.remove('has-regions');
    wrapper.querySelectorAll('.pageguide-image-region').forEach(el => el.remove());
  }
  if (label) label.textContent = '📷 Image ready — ask about it!';
  if (uploadLabel) uploadLabel.classList.remove('has-image');
  _setUploadIcon('📎');
  if (input) input.placeholder = 'Ask anything...';
  if (fileInput) fileInput.value = '';

  // Clear from content script
  try {
    await sendToContentScript({ action: 'clearUploadedImage' });
  } catch (err) {
    console.warn('🖼️ Could not clear image in content script:', err);
  }

  addMessage('🗑️ Image removed', 'system');
}

/**
 * Handle text-file upload (.txt, .md, .csv, .json, etc.)
 */
async function handleFileUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  // Max 2 MB for text files
  if (file.size > 2 * 1024 * 1024) {
    addMessage('❌ File too large. Max size is 2 MB.', 'error');
    event.target.value = '';
    return;
  }

  try {
    const text = await file.text();
    uploadedFileContent = text;
    uploadedFileName = file.name;

    // Show preview badge
    const preview = document.getElementById('pageguide-file-preview');
    const label = document.getElementById('pageguide-file-label');
    const uploadLabel = document.getElementById('pageguide-upload-label');
    const input = document.getElementById('pageguide-input');

    if (preview) preview.style.display = 'flex';
    if (label) label.textContent = `📎 ${file.name}`;
    if (uploadLabel) uploadLabel.classList.add('has-image');
    _setUploadIcon('📎');
    if (input) input.placeholder = `Ask about ${file.name}…`;

    addMessage(`📎 File attached: ${file.name}`, 'system');
  } catch (err) {
    addMessage(`❌ Could not read file: ${err.message}`, 'error');
  }
}

/**
 * Clear the attached text file
 */
function clearUploadedFile() {
  uploadedFileContent = null;
  uploadedFileName = null;

  const preview = document.getElementById('pageguide-file-preview');
  const label = document.getElementById('pageguide-file-label');
  const uploadLabel = document.getElementById('pageguide-upload-label');
  const input = document.getElementById('pageguide-input');
  const fileInput = document.getElementById('pageguide-image-upload');

  if (preview) preview.style.display = 'none';
  if (label) label.textContent = '📎 File attached';
  if (uploadLabel) uploadLabel.classList.remove('has-image');
  _setUploadIcon('📎');
  if (input) input.placeholder = 'Ask anything…';
  if (fileInput) fileInput.value = '';

  addMessage('🗑️ File removed', 'system');
}

/**
 * Clear the selected text
 */
function clearSelectedText() {
  currentSelectedText = null;
  const preview = document.getElementById('pageguide-selected-text-preview');
  if (preview) preview.style.display = 'none';
  const input = document.getElementById('pageguide-input');
  if (input) input.focus();
}

/**
 * Render clickable region overlays on the image preview wrapper.
 * Called after a successful image_ask response that includes imageRegions.
 * Each region is grounded to the LLM's answer: clicking scrolls to the
 * already-highlighted page element (no new LLM call).
 * @param {Array} regions - [{label, citationIndex, bbox:{x,y,w,h}}]
 */
function renderImageRegions(regions) {
  const wrapper = document.getElementById('pageguide-image-wrapper');
  const label = document.getElementById('pageguide-image-label');
  if (!wrapper) return;

  // Remove any existing regions
  wrapper.querySelectorAll('.pageguide-image-region').forEach(el => el.remove());
  wrapper.classList.add('has-regions');

  regions.forEach(item => {
    const { bbox, citationIndex, label: itemLabel } = item;
    if (!bbox) return;

    const region = document.createElement('div');
    region.className = 'pageguide-image-region';
    region.style.left   = `${bbox.x}%`;
    region.style.top    = `${bbox.y}%`;
    region.style.width  = `${bbox.w}%`;
    region.style.height = `${bbox.h}%`;

    const tooltip = document.createElement('span');
    tooltip.className = 'pageguide-region-label';
    tooltip.textContent = itemLabel || '';
    region.appendChild(tooltip);

    region.addEventListener('click', async () => {
      try {
        await sendToContentScript({ action: 'scrollToIndex', index: citationIndex });
      } catch (e) {
        console.warn('🖼️ scrollToIndex failed:', e);
      }
    });

    wrapper.appendChild(region);
  });

  if (label) label.textContent = `🎯 ${regions.length} highlight${regions.length !== 1 ? 's' : ''} found — click to jump`;
}

// ---------------------------------------------------------------------------
// Slash command system
// ---------------------------------------------------------------------------

const SLASH_COMMANDS = [
  { command: '/stop',       args: '',        description: 'Immediately cancel the current run' },
  { command: '/reset',      args: '',        description: 'Clear conversation and context' },
  { command: '/new',        args: '',        description: 'Clear conversation and context (alias of /reset)' },
  { command: '/help',       args: '',        description: 'Show available commands and examples' },
  { command: '/status',     args: '',        description: 'Show current model, SOM, and vision settings' },
  { command: '/som',        args: 'on|off',  description: 'Enable or disable Set of Marks overlay' },
  { command: '/vision',     args: 'on|off',  description: 'Enable or disable vision (screenshot) mode' },
  { command: '/find',       args: '<text>',  description: 'Force the agent to find information on the page' },
  { command: '/guide',      args: '<text>',  description: 'Force the agent into step-by-step guide mode' },
  { command: '/hide',       args: '<text>',  description: 'Force the agent to hide elements on the page' },
];

/**
 * Handle slash commands. Returns true if the input was a command (caller should not continue).
 */
async function handleSlashCommand(input) {
  if (!input.startsWith('/')) return false;

  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts[1]?.toLowerCase();

  switch (cmd) {
    case '/stop':
      await stopGuide('⏹ Stopped.');
      return true;

    case '/reset':
    case '/new':
      await resetChat(false);
      addMessage('🧹 Conversation reset. Ready for a new task!', 'system');
      return true;

    case '/help':
      addMessage(
        '**Available Commands**\n\n' +
        '`/stop` — Immediately cancel the current run\n' +
        '`/reset` or `/new` — Clear conversation and context\n' +
        '`/status` — Show current model, SOM, and vision settings\n' +
        '`/som on` / `/som off` — Toggle Set of Marks overlay\n' +
        '`/vision on` / `/vision off` — Toggle vision (screenshot) mode\n' +
        '`/help` — Show this help message',
        'system'
      );
      return true;

    case '/status': {
      let s = {};
      try { s = await chrome.storage.sync.get(['provider','geminiModel','openrouterModel','openaiModel','visionEnabled','somEnabled']); } catch (e) {}
      const prov = s.provider || 'gemini';
      const provLabel = { gemini: 'Gemini', openrouter: 'OpenRouter', openai: 'OpenAI' }[prov] || prov;
      const modelRaw = prov === 'gemini' ? (s.geminiModel || 'gemini-2.5-flash')
                     : prov === 'openrouter' ? (s.openrouterModel || '')
                     : (s.openaiModel || '');
      const model = modelRaw.includes('/') ? modelRaw.split('/').pop() : modelRaw;
      const vision = s.visionEnabled === false ? 'OFF' : 'ON';
      const som = s.somEnabled === true ? 'ON' : 'OFF';
      addMessage(
        `**Status**\n\n🤖 Provider: **${provLabel}** · ${model}\n📸 Vision: **${vision}**\n🔢 Set of Marks: **${som}**`,
        'system'
      );
      return true;
    }

    case '/som':
      if (arg === 'on' || arg === 'off') {
        await chrome.storage.sync.set({ somEnabled: arg === 'on' });
        addMessage(`🔢 Set of Marks: **${arg.toUpperCase()}**`, 'system');
      } else {
        addMessage('Usage: `/som on` or `/som off`', 'system');
      }
      return true;

    case '/vision':
      if (arg === 'on' || arg === 'off') {
        await chrome.storage.sync.set({ visionEnabled: arg === 'on' });
        addMessage(`📸 Vision: **${arg.toUpperCase()}**`, 'system');
      } else {
        addMessage('Usage: `/vision on` or `/vision off`', 'system');
      }
      return true;

    default:
      addMessage(`❓ Unknown command: \`${cmd}\`. Type \`/help\` to see available commands.`, 'system');
      return true;
  }
}

// ---------------------------------------------------------------------------
// Slash command autocomplete
// ---------------------------------------------------------------------------

let _slashMenuIndex = -1;

function _buildSlashMenuItems(inputVal) {
  // Match commands whose full form starts with the typed text (e.g. "/s" matches /stop, /status, /som)
  const lower = inputVal.toLowerCase();
  return SLASH_COMMANDS.filter(c => c.command.startsWith(lower));
}

function _renderSlashMenu(items) {
  const menu = document.getElementById('pageguide-slash-menu');
  if (!menu) return;
  menu.innerHTML = '';
  if (items.length === 0) { menu.style.display = 'none'; return; }

  items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'pageguide-slash-item' + (idx === _slashMenuIndex ? ' active' : '');
    row.innerHTML =
      `<span class="slash-cmd">${item.command}${item.args ? ' <em>' + item.args + '</em>' : ''}</span>` +
      `<span class="slash-desc">${item.description}</span>`;
    row.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent blur before we can set value
      _applySlashItem(item);
    });
    menu.appendChild(row);
  });
  menu.style.display = 'block';
}

function _applySlashItem(item) {
  const input = document.getElementById('pageguide-input');
  if (!input) return;
  // Commands that take args: insert command + space so user can type the arg
  if (item.args) {
    input.value = item.command + ' ';
  } else {
    input.value = item.command;
  }
  _hideSlashMenu();
  input.focus();
}

function _hideSlashMenu() {
  const menu = document.getElementById('pageguide-slash-menu');
  if (menu) menu.style.display = 'none';
  _slashMenuIndex = -1;
}

function _initSlashAutocomplete() {
  const input = document.getElementById('pageguide-input');
  if (!input) return;

  input.addEventListener('input', () => {
    const val = input.value;
    if (!val.startsWith('/')) { _hideSlashMenu(); return; }
    // Only show the menu while user is still on the first "word" (command name)
    if (val.includes(' ') && val.split(' ').length > 1 && val.split(' ')[1] !== '') {
      _hideSlashMenu(); return;
    }
    _slashMenuIndex = -1;
    _renderSlashMenu(_buildSlashMenuItems(val));
  });

  input.addEventListener('keydown', (e) => {
    const menu = document.getElementById('pageguide-slash-menu');
    const visible = menu && menu.style.display !== 'none';
    if (!visible) return;

    const items = menu.querySelectorAll('.pageguide-slash-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _slashMenuIndex = Math.min(_slashMenuIndex + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === _slashMenuIndex));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _slashMenuIndex = Math.max(_slashMenuIndex - 1, -1);
      items.forEach((el, i) => el.classList.toggle('active', i === _slashMenuIndex));
    } else if (e.key === 'Tab' || (e.key === 'Enter' && _slashMenuIndex >= 0)) {
      e.preventDefault();
      const idx = _slashMenuIndex >= 0 ? _slashMenuIndex : 0;
      const cmdIdx = [...items].indexOf(items[idx]);
      const matched = _buildSlashMenuItems(input.value);
      if (matched[cmdIdx]) _applySlashItem(matched[cmdIdx]);
    } else if (e.key === 'Escape') {
      _hideSlashMenu();
    }
  });

  input.addEventListener('blur', () => {
    // Small delay so mousedown on menu item fires first
    setTimeout(_hideSlashMenu, 150);
  });
}

/**
 * Send a chat message
 */
async function sendMessage() {
  const input = document.getElementById('pageguide-input');
  const btn = document.getElementById('pageguide-send');

  if (panelRunning) return; // already running — the send button is acting as Stop

  const query = input?.value.trim() || '';

  // Only return early if we have no query AND no attached context
  if (!query && !uploadedFileContent && !uploadedImageBase64 && !currentSelectedText) {
    return;
  }

  _hideSlashMenu();
  if (input) input.value = '';
  cancelRequested = false;
  guideStopped = false; // a fresh send re-arms the panel for running-state messages

  // Track if a specific routing is forced by the user
  // Default to the sticky route chosen via the Find/Guide/Hide tabs (null = Auto).
  // A slash command in this message overrides it below.
  let forcedRoute = panelForcedMode;
  let displayRoute = forcedRoute;
  let activeQuery = query;

  // Handle slash commands before routing to agent
  if (query.startsWith('/')) {
    // If it's a routing override command, strip it and set the forcedRoute flag
    const lowerQuery = query.toLowerCase();
    if (lowerQuery.startsWith('/find ') || lowerQuery === '/find') {
      forcedRoute = 'ask';
      displayRoute = 'find';
      activeQuery = query.substring(5).trim();
      if (!activeQuery && !uploadedFileContent && !uploadedImageBase64 && !currentSelectedText) {
        addMessage('Please provide a query after /find', 'system');
        if (btn) btn.disabled = false;
        return;
      }
    } else if (lowerQuery.startsWith('/guide ') || lowerQuery === '/guide') {
      forcedRoute = 'guide';
      displayRoute = 'guide';
      activeQuery = query.substring(6).trim();
      if (!activeQuery && !uploadedFileContent && !uploadedImageBase64 && !currentSelectedText) {
        addMessage('Please provide a query after /guide', 'system');
        if (btn) btn.disabled = false;
        return;
      }
    } else if (lowerQuery.startsWith('/hide ') || lowerQuery === '/hide') {
      forcedRoute = 'hide';
      displayRoute = 'hide';
      activeQuery = query.substring(5).trim();
      if (!activeQuery && !uploadedFileContent && !uploadedImageBase64 && !currentSelectedText) {
        addMessage('Please provide a query after /hide', 'system');
        if (btn) btn.disabled = false;
        return;
      }
    } else {
      // Handle normal system slash commands that bypass LLM entirely
      if (btn) btn.disabled = false;
      if (input) input.focus();
      await handleSlashCommand(query);
      return;
    }
  }
  
  // Check if current message has an image attached
  const currentMessageHasImage = !!uploadedImageBase64;
  if (currentMessageHasImage) {
    hasImageInConversation = true;
  }

  // If a text file is attached or text is selected, build an augmented query
  // The original user-visible message stays clean; the enriched version goes to the LLM.
  let effectiveQuery = activeQuery;
  
  if (uploadedFileContent || currentSelectedText) {
    const parts = [];
    
    if (uploadedFileContent) {
      const MAX_FILE_CHARS = 40000;
      const snippet = uploadedFileContent.length > MAX_FILE_CHARS
        ? uploadedFileContent.slice(0, MAX_FILE_CHARS) + '\n… [truncated]'
        : uploadedFileContent;
      parts.push(`[Attached file: ${uploadedFileName}]\n---\n${snippet}\n---`);
    }
    
    if (currentSelectedText) {
      const MAX_SELECTION_CHARS = 20000;
      const selectionSnippet = currentSelectedText.length > MAX_SELECTION_CHARS
        ? currentSelectedText.slice(0, MAX_SELECTION_CHARS) + '\n… [truncated]'
        : currentSelectedText;
      parts.push(`[Selected text from page]\n---\n${selectionSnippet}\n---`);
    }
    
    if (activeQuery) {
      effectiveQuery = `${parts.join('\n\n')}\n\nUser question: ${activeQuery}`;
    } else {
      // If user hit send with just context and no question, provide a default prompt
      effectiveQuery = `${parts.join('\n\n')}\n\nPlease analyze or explain the provided content.`;
    }
  } else if (forcedRoute) {
    // If no context was attached, just use the stripped query
    effectiveQuery = activeQuery;
  }

  // Add to conversation history (mark if this message has an image)
  conversationHistory.push({
    role: 'user',
    content: effectiveQuery,
    hasImage: currentMessageHasImage
  });

  // Determine context for UI display
  let msgContext = null;
  if (currentSelectedText) {
    msgContext = { type: 'selectedText', text: currentSelectedText };
    clearSelectedText();
  } else if (uploadedFileContent) {
    msgContext = { type: 'file', name: uploadedFileName };
  } else if (uploadedImageBase64) {
    msgContext = { type: 'image' };
  }

  addMessage(activeQuery || query, 'user', false, msgContext);
  renderGoalCard({
    prompt: activeQuery || query,
    route: displayRoute || 'ask'
  });
  showTyping();
  
  try {
    // Check if current tab is the PDF viewer
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isOnPdfViewer = currentTab?.url?.includes('pdf-viewer/viewer.html');
    
    let result;
    
    if (noPageContext) {
      // User explicitly disabled page context — answer from AI knowledge only
      const systemPrompt = PROMPTS.KNOWLEDGE_ONLY || PROMPTS.ANSWER_AND_HIGHLIGHT
        .replace('{pageContent}', '(No page context — user asked for AI knowledge only)')
        .replace('{pageIndex}', '(No elements indexed)');

      const messages = [
        ...conversationHistory.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: effectiveQuery }
      ];

      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'callLLM',
          systemPrompt,
          messages,
          metadata: {
            mode: 'ask_panel_knowledge',
            url: currentTab?.url || ''
          }
        }, (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res);
        });
      });

      if (response && !response.error) {
        result = {
          success: true,
          answer: response.content || 'Could not generate an answer.',
          highlightCount: 0,
          hasHighlights: false
        };
      } else {
        throw new Error(response?.error || 'Failed to call LLM');
      }
    } else if (isOnPdfViewer) {
      // Get PDF context from storage
      const pdfContext = await chrome.storage.session.get(['pdfViewerActive', 'pdfName', 'pdfTotalPages', 'pdfText']);
      
      console.log('📄 PDF context from storage:', {
        active: pdfContext.pdfViewerActive,
        name: pdfContext.pdfName,
        pages: pdfContext.pdfTotalPages,
        textPages: pdfContext.pdfText?.length
      });
      
      if (pdfContext.pdfText?.length > 0) {
        // Handle PDF question directly
        result = await handlePdfQuestion(effectiveQuery, pdfContext);
      } else {
        // No PDF loaded yet - show friendly message
        result = { 
          success: true, 
          answer: '📄 Please load a PDF first!\n\nUpload a PDF file or paste a URL in the viewer, then ask me questions about it.',
          isPdf: false
        };
      }
    } else if (currentTab?.url && (currentTab.url.startsWith('chrome://') || currentTab.url.startsWith('chrome-extension://') || currentTab.url.startsWith('edge://'))) {
      // Restricted page - cannot run content scripts. Default to Knowledge Base fallback.
      console.log('🛡️ Restricted page detected. Bypassing content script and using Knowledge Base.');
      
      const systemPrompt = PROMPTS.ANSWER_AND_HIGHLIGHT
        .replace('{pageContent}', '(No text content found - restricted browser page)')
        .replace('{pageIndex}', '(No elements indexed)');
        
      const messages = [
        ...conversationHistory.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: effectiveQuery }
      ];
      
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'callLLM',
          systemPrompt: systemPrompt,
          messages: messages,
          metadata: {
            mode: 'ask_panel_restricted',
            url: currentTab?.url || ''
          }
        }, (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res);
        });
      });
      
      if (response && !response.error) {
        result = {
          success: true,
          answer: response.content || "Could not generate an answer.",
          highlightCount: 0,
          hasHighlights: false
        };
      } else {
        throw new Error(response?.error || 'Failed to call LLM');
      }
    } else {
      // Normal routing via content script
      // Pass hasImage flag so router knows if image_ask is valid
      result = await sendToContentScript({
        action: 'handleQuery',
        query: effectiveQuery,
        history: conversationHistory.slice(0, -1),
        hasImage: currentMessageHasImage,
        hasImageInHistory: hasImageInConversation,
        forcedRoute: forcedRoute
      });
    }
    
    hideTyping();

    // User pressed Stop while this (non-guide) request was in flight → discard the result.
    if (cancelRequested) { cancelRequested = false; return; }

    if (result && result.success) {
      const routedTo = result.routedTo || forcedRoute || (noPageContext ? 'ask' : null);
      if (routedTo) {
        panelLastRoute = routedTo;
        updateRouteTabs(routedTo);
        renderGoalCard({
          prompt: activeQuery || query,
          route: displayRoute || routedTo
        });
      }

      // Build debug info for collapsible section
      const debugLines = [];
      
      // Routing decision
      if (result.routedTo && result.routedTo !== 'guide') {
        const confidence = Math.round((result.routeConfidence || 0) * 100);
        const handlerEmoji = {
          'ask': '💬',
          'protection': '🛡️',
          'image_ask': '🖼️',
          'pdf_ask': '📄'
        }[result.routedTo] || '🎯';
        debugLines.push(`${handlerEmoji} Routed to: ${result.routedTo} (${confidence}%)`);
      }
      
      // Image ask info
      if (result.isImageAsk) {
        if (result.imageAskSteps) {
          debugLines.push(`🔍 Image search steps: ${result.imageAskSteps}`);
        }
        if (result.imageAskActions && result.imageAskActions.length > 0) {
          debugLines.push(`🧭 Image search navigation:`);
          result.imageAskActions.forEach(action => {
            debugLines.push(`  • ${action}`);
          });
        }
        // Render clickable regions on the uploaded image grounded to the answer
        if (result.imageRegions?.length > 0) {
          renderImageRegions(result.imageRegions);
        }
      }
      
      // PDF info
      if (result.isPdf) {
        debugLines.push(`📄 PDF mode: ${result.extractedPages || '?'}/${result.totalPages || '?'} pages extracted`);
        if (result.pdfJsMode) {
          debugLines.push(`🔧 Method: PDF.js client-side extraction`);
        }
      }
      
      // Vision decision
      if (result.visionDecision) {
        const vd = result.visionDecision;
        const visionConfidence = Math.round((vd.confidence || 0) * 100);
        const visionEmoji = vd.needsVision ? '📸' : '📝';
        const visionMode = vd.needsVision ? 'Vision' : 'Text-only';
        debugLines.push(`${visionEmoji} Mode: ${visionMode} (${visionConfidence}%)`);
        
        if (result.useVision && result.visionSteps) {
          debugLines.push(`🔍 Steps: ${result.visionSteps}`);
        }
        
        if (result.visionActions && result.visionActions.length > 0) {
          debugLines.push(`🧭 Navigation:`);
          result.visionActions.forEach(action => {
            debugLines.push(`  • ${action}`);
          });
        }
      }
      
      // Add collapsible debug section if there's debug info
      if (debugLines.length > 0) {
        addCollapsibleDebug(debugLines);
      }
      
      // Add assistant response to history (but not for intermediate steps)
      if (result.answer && !result.isAskStep) {
        conversationHistory.push({ role: 'assistant', content: result.answer });
      }
      
      if (result.isGuide) {
        addGuideStep(result);
      } else if (result.isAskStep) {
        // Ask mode step (scroll/expand needed)
        addAskStep(result);
      } else {
        let message = result.answer;
        if (result.highlightCount > 0) {
          message += ` ✨ (${result.highlightCount} highlighted)`;
        }
        // Make clickable if has highlights OR is a PDF response (has citations)
        const hasHighlights = result.hasHighlights || result.highlightCount > 0;
        const hasPdfCitations = result.isPdf && (
          result.answer?.includes('[Page ') || 
          result.answer?.includes('[idx:')
        );
        addMessage(message, 'assistant', hasHighlights || hasPdfCitations);
      }
    } else {
      const errText = result?.error || 'Unknown error';
      if (isGuideParseError(errText)) addGuideRetryMessage(`Could not parse step JSON. ${errText}`);
      else addMessage(`❌ ${errText}`, 'error');
      // Remove failed query from history
      conversationHistory.pop();
    }
  } catch (e) {
    hideTyping();
    const msg = e.message || '';
    if (msg.includes('back/forward cache') || msg.includes('bfcache')) {
      // Guide navigated the tab to a new page; Chrome bfcached the old page and
      // closed its extension port. The new page's content script sends guide
      // results via chrome.runtime.onMessage — nothing to show here.
      return;
    }
    if (msg.includes('Could not establish connection') ||
        msg.includes('Receiving end does not exist') ||
        msg.includes('Cannot access') ||
        msg.includes('No active tab')) {
      addMessage('⚠️ This extension cannot run on this page.\n\nPlease navigate to a regular website (not `chrome://` or extension pages) and try again.', 'error');
    } else {
      if (isGuideParseError(msg)) addGuideRetryMessage(`Could not parse step JSON. ${msg}`);
      else addMessage(`❌ ${msg || 'Unknown error'}`, 'error');
    }
    // Remove failed query from history
    conversationHistory.pop();
  }

  setRunning(false); // ensure the send button is restored (guide runs reset via their own flow)
  input.focus();
}

/**
 * Handle PDF question using stored PDF context
 */
async function handlePdfQuestion(query, pdfContext) {
  console.log('📄 Handling PDF question:', query);
  
  // Use indexed text if available, otherwise fall back to regular text
  const hasIndexedText = pdfContext.pdfText.some(p => p.indexedText);
  
  const pdfTextContent = pdfContext.pdfText.map(p => {
    if (hasIndexedText && p.indexedText) {
      return `[Page ${p.page}]\n${p.indexedText}`;
    }
    return `[Page ${p.page}]\n${p.text}`;
  }).join('\n\n');
  
  const systemPrompt = hasIndexedText 
    ? `You are a helpful assistant that answers questions about PDF documents.
Consider conversation history for context, but always answer based on the CURRENT document content.

CRITICAL RULES:
1. The text below has index markers like "[42]Hello [43]World" - these are for YOUR reference only
2. NEVER include these markers [N] in your response text
3. Write naturally, then add citations using ONLY this format: [idx:N] or [idx:N-M]
4. Place citations AFTER the relevant phrase, not mixed into text

CORRECT: "The TRUE dataset is the first explainable video fact-checking dataset [idx:462-464]"
WRONG: "[462]TRUE [464]dataset is..."

Keep answers clear and concise with citations for key claims.

Document: ${pdfContext.pdfName}
Total Pages: ${pdfContext.pdfTotalPages}

PDF Content (with reference indices):
${pdfTextContent}`
    : `You are a helpful assistant that answers questions about PDF documents.
Consider conversation history for context, but always answer based on the CURRENT document content.
When answering, ALWAYS cite specific passages using this exact format: [Page N: "exact quote from the document"]
Keep quotes concise (under 50 words) but include enough context to be useful.
If you can't find relevant information, say so clearly.

Document: ${pdfContext.pdfName}
Total Pages: ${pdfContext.pdfTotalPages}

PDF Content:
${pdfTextContent}`;
  
  // Build messages (without system prompt - it goes separately)
  const messages = [
    ...conversationHistory.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: query }
  ];
  
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'callLLM',
      messages: messages,
      systemPrompt: systemPrompt,
      metadata: {
        mode: 'ask_panel_pdf',
        url: pdfContext?.pdfUrl || ''
      }
    });
    
    if (response.error) {
      return { success: false, error: response.error };
    }
    
    // Add to conversation history
    conversationHistory.push({ role: 'assistant', content: response.content });
    
    return {
      success: true,
      answer: response.content,
      isPdf: true,
      routedTo: 'pdf_viewer',
      routeConfidence: 1.0
    };
  } catch (e) {
    console.error('PDF question error:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Decide whether switching from prevTabId to newTabId should trigger a chat reset.
 * Exposed on window so unit tests can call it directly.
 *
 * Rules:
 *  - Never reset while the guide agent is active (it manages its own tab transitions).
 *  - Never reset on the very first activation (prevTabId is null).
 *  - Never reset when the same tab is re-activated (shouldn't normally happen).
 *  - Reset in every other case (user opened/switched to a real new tab).
 */
function _shouldResetOnTabSwitch(prevTabId, newTabId, isGuideActive) {
  if (isGuideActive) return false;
  if (!prevTabId || prevTabId === newTabId) return false;
  return true;
}
window._shouldResetOnTabSwitch = _shouldResetOnTabSwitch;

/**
 * Snapshot the current tab's chat into _tabSessions so it can be restored later.
 */
function _saveTabSession(tabId) {
  if (!tabId) return;
  const container = document.getElementById('pageguide-messages');
  _tabSessions.set(tabId, {
    chatMessages: [...chatMessages],
    conversationHistory: [...conversationHistory],
    hasImageInConversation,
    html: container ? container.innerHTML : '',
    visibleJourneySessionId,
    visibleJourneyTitle,
    visibleJourneyRecalled
  });
}

/**
 * Restore a previously saved session for the tab being switched to.
 * Image upload state is always cleared (blobs are not serializable).
 */
function _restoreTabSession(session) {
  chatMessages = [...session.chatMessages];
  conversationHistory = [...session.conversationHistory];
  hasImageInConversation = session.hasImageInConversation;

  const container = document.getElementById('pageguide-messages');
  if (container) {
    container.innerHTML = session.html;
    container.scrollTop = container.scrollHeight;
  }

  // Clear image upload UI (blobs aren't saved in the session)
  uploadedImageBase64 = null;
  const preview = document.getElementById('pageguide-image-preview');
  const uploadLabel = document.getElementById('pageguide-upload-label');
  const fileInput = document.getElementById('pageguide-image-upload');
  if (preview) preview.style.display = 'none';
  if (uploadLabel) uploadLabel.classList.remove('has-image');
  if (fileInput) fileInput.value = '';

  // Clear text-file upload UI
  uploadedFileContent = null;
  uploadedFileName = null;
  const filePreview = document.getElementById('pageguide-file-preview');
  if (filePreview) filePreview.style.display = 'none';

  visibleJourneySessionId = session.visibleJourneySessionId || null;
  visibleJourneyTitle = session.visibleJourneyTitle || '';
  visibleJourneyRecalled = !!session.visibleJourneyRecalled;
  if (visibleJourneyRecalled && visibleJourneySessionId) {
    showStoredJourney(visibleJourneySessionId);
  } else {
    clearGoalAndStepPanel();
  }
}

/**
 * Reset all chat state and clear page highlights.
 * @param {boolean} showMessage - Whether to show a confirmation message in the chat.
 */
let _resettingChat = false;

async function resetChat(showMessage = true) {
  if (_resettingChat) return;
  _resettingChat = true;
  guideActive = false;
  guidePaused = false;

  // Rewind (Slice 1): clear the step timeline (content 'reset' clears the store).
  if (typeof RewindTimeline !== 'undefined') RewindTimeline.clear();
  clearGoalAndStepPanel();
  updateGuidePauseButton();

  // Discard any saved session for this tab so switching away+back starts fresh
  _tabSessions.delete(currentTabId);

  // Clear the debug prompts list
  try {
    chrome.storage.local.remove(['debugPrompts', 'lastDebugPrompt']).catch(() => {});
  } catch (e) {}

  // Clear guide state in SW directly (doesn't depend on content script being available)
  try { chrome.runtime.sendMessage({ action: 'guidanceV2_clearState' }); } catch (e) {}

  // Clear highlights on the active page
  try {
    await sendToContentScript({ action: 'reset' });
  } catch (e) {
    // Page might not have a content script loaded
  }

  // Clear highlights in PDF viewer if open
  try {
    const tabs = await chrome.tabs.query({});
    const pdfViewerTab = tabs.find(t => t.url?.includes('pdf-viewer/viewer.html'));
    if (pdfViewerTab) {
      chrome.tabs.sendMessage(pdfViewerTab.id, { action: 'clearPdfHighlights' });
    }
  } catch (e) {
    // PDF viewer might not be open
  }

  // Clear chat and conversation history
  conversationHistory = [];
  chatMessages = [];
  hasImageInConversation = false;
  const container = document.getElementById('pageguide-messages');
  if (container) container.innerHTML = '';

  // Clear uploaded image state
  uploadedImageBase64 = null;
  const preview = document.getElementById('pageguide-image-preview');
  const uploadLabel = document.getElementById('pageguide-upload-label');
  const input = document.getElementById('pageguide-input');
  const fileInput = document.getElementById('pageguide-image-upload');

  if (preview) preview.style.display = 'none';
  if (uploadLabel) uploadLabel.classList.remove('has-image');
  if (input) input.placeholder = 'Ask anything...';
  if (fileInput) fileInput.value = '';

  // Clear text-file upload state
  uploadedFileContent = null;
  uploadedFileName = null;
  const filePreview = document.getElementById('pageguide-file-preview');
  if (filePreview) filePreview.style.display = 'none';

  // Clear selected text state
  currentSelectedText = null;
  const selectedTextPreview = document.getElementById('pageguide-selected-text-preview');
  if (selectedTextPreview) selectedTextPreview.style.display = 'none';

  try {
    await sendToContentScript({ action: 'clearUploadedImage' });
  } catch (e) {
    // Ignore
  }

  if (showMessage) {
    addMessage('🧹 Cleared chat, highlights, and uploaded image', 'system');
  }

  // Always show the current model status after clearing
  showModelStatus();

  _resettingChat = false;
}

/**
 * Handle quick action buttons
 */
async function handleQuickAction(action) {
  if (action === 'reset') {
    hideMoreMenu();
    await resetChat(true);
  }
}

function _formatDuration(ms) {
  if (ms == null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function exportJourneyPdf() {
  let index = null;
  try {
    if (typeof rewindGetIndex === 'function') index = await rewindGetIndex();
    if (index?.sessionId && typeof rewindVerifyScreenshots === 'function') index = await rewindVerifyScreenshots(index.sessionId);
  } catch (e) {}

  if (!index?.steps?.length) {
    addMessage('ℹ️ No guide journey to export yet.', 'system');
    setExportEnabled(false);
    return;
  }

  const records = [];
  for (const meta of index.steps) {
    let rec = null;
    try {
      if (typeof rewindGetRecord === 'function') rec = await rewindGetRecord(index.sessionId, meta.step);
    } catch (e) {}
    const shot = typeof rewindResolveScreenshot === 'function'
      ? rewindResolveScreenshot(rec)
      : (rec && (rec.screenshotBefore || rec.screenshot || rec.screenshotAfter));
    if (rec && (meta.isInitial || Number(meta.step) === 0 || shot)) records.push(rec);
  }

  const title = currentGuideTitle || index.title || _truncateText(index.goal || 'PageGuide Journey', 90);
  const goal = index.goal || currentGoal?.prompt || '';
  const stepHtml = records.map(rec => {
    const bits = [];
    if (rec.durationMs != null) bits.push(`Duration: ${_formatDuration(rec.durationMs)}`);
    if (rec.verification?.status) bits.push(`Verification: ${rec.verification.status}`);
    if (rec.url) bits.push(`URL: ${escapeHtml(rec.url)}`);
    return `
      <section class="step">
        <h2>Step ${escapeHtml(rec.step)}</h2>
        <p class="instruction">${escapeHtml(rec.instruction || '')}</p>
        ${rec.target?.text ? `<p><strong>Target:</strong> ${escapeHtml(rec.target.text)}</p>` : ''}
        ${bits.length ? `<p class="meta">${bits.join(' · ')}</p>` : ''}
        ${(() => {
          let shot = typeof rewindResolveScreenshot === 'function'
            ? rewindResolveScreenshot(rec)
            : (rec.screenshotBefore || rec.screenshot || rec.screenshotAfter);
          if (shot === 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7') shot = null;
          return shot ? `<img src="data:image/jpeg;base64,${shot}" alt="Step ${escapeHtml(rec.step)} screenshot">` : '';
        })()}
      </section>`;
  }).join('');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:32px;color:#1f2430}
    h1{font-size:24px;margin:0 0 6px}
    .goal{color:#5f6778;margin:0 0 24px}
    .step{break-inside:avoid;border-top:1px solid #d9dde7;padding:18px 0}
    h2{font-size:16px;margin:0 0 8px}
    .instruction{font-size:15px;font-weight:600;margin:0 0 8px}
    .meta{color:#697386;font-size:12px}
    img{max-width:100%;border:1px solid #d9dde7;border-radius:8px;margin-top:10px}
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${goal ? `<p class="goal">${escapeHtml(goal)}</p>` : ''}
  ${stepHtml}
  <script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));<\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) {
    addMessage('❌ Could not open print window. Allow popups for PageGuide and try again.', 'error');
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
}

/**
 * Save the current guide trajectory to local Flask server.
 */
async function saveTrajectoryToRepo() {
  let index = null;
  try {
    if (typeof rewindGetIndex === 'function') index = await rewindGetIndex();
    if (index?.sessionId && typeof rewindVerifyScreenshots === 'function') index = await rewindVerifyScreenshots(index.sessionId);
  } catch (e) {}

  if (!index?.steps?.length) {
    addMessage('ℹ️ No guide journey to save yet.', 'system');
    return;
  }

  addMessage('Saving trajectory to current repository...', 'system');

  const records = [];
  for (const meta of index.steps) {
    let rec = null;
    try {
      if (typeof rewindGetRecord === 'function') rec = await rewindGetRecord(index.sessionId, meta.step);
    } catch (e) {}
    if (rec) records.push(rec);
  }

  const settings = await chrome.storage.sync.get(['provider', 'geminiModel', 'openrouterModel']);
  const provider = settings.provider || 'gemini';
  let modelStr = '';
  if (provider === 'gemini') {
    modelStr = settings.geminiModel || 'gemini-2.5-flash';
  } else if (provider === 'openrouter') {
    modelStr = settings.openrouterModel || 'google/gemini-2.5-flash';
  } else {
    modelStr = 'unknown';
  }
  const llmSource = `${provider.charAt(0).toUpperCase() + provider.slice(1)} - ${modelStr}`;

  const localSettings = await chrome.storage.local.get(['guideConfidenceSource']);
  const confSourceVal = localSettings.guideConfidenceSource || 'llm';
  const confSource = confSourceVal === 'mechanical' ? 'No-LLM' : 'LLM Report';

  const payload = {
    sessionId: index.sessionId,
    goal: index.goal || currentGoal?.prompt || '',
    startedAt: index.startedAt || Date.now(),
    steps: records,
    llm_source: llmSource,
    conf_source: confSource
  };

  try {
    const response = await fetch('http://localhost:5000/api/save_trajectory', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = await response.json();
      addMessage(`💾 Trajectory saved successfully to the repository! File: ${data.filename}`, 'system');
    } else {
      const errText = await response.text();
      addMessage(`❌ Flask server error: ${errText}`, 'error');
    }
  } catch (err) {
    console.error('Error saving trajectory:', err);
    addMessage('❌ Could not connect to the local Flask server. Please make sure the Flask server is running on port 5000 (`python eval_server/app.py`).', 'error');
  }
}

// ---------------------------------------------------------------------------
// Chat History
// ---------------------------------------------------------------------------

const HISTORY_STORAGE_KEY = 'pageguide_history';
const HISTORY_MAX_ITEMS = 50;

/**
 * Save the current chat to history in chrome.storage.local.
 * Only saves text messages (user / assistant / system) — no HTML or highlights.
 */
async function saveCurrentChat() {
  const textMessages = chatMessages.filter(m => m.content && m.content.trim());
  if (textMessages.length === 0) {
    addMessage('ℹ️ Nothing to save — chat is empty.', 'system');
    return;
  }

  // Derive a title from the first user message
  const firstUser = textMessages.find(m => m.type === 'user');
  const rawTitle = firstUser ? firstUser.content : textMessages[0].content;
  const title = rawTitle.length > 60 ? rawTitle.slice(0, 60) + '…' : rawTitle;

  const entry = {
    id: String(Date.now()),
    title,
    savedAt: new Date().toLocaleString(),
    messages: textMessages.map(m => ({ content: m.content, type: m.type, timestamp: m.timestamp }))
  };

  try {
    const data = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
    const history = Array.isArray(data[HISTORY_STORAGE_KEY]) ? data[HISTORY_STORAGE_KEY] : [];
    history.unshift(entry); // newest first
    if (history.length > HISTORY_MAX_ITEMS) history.length = HISTORY_MAX_ITEMS;
    await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: history });
    addMessage('💾 Chat saved to history.', 'system');
  } catch (err) {
    addMessage(`❌ Could not save chat: ${err.message}`, 'error');
  }
}

/**
 * Show the history overlay and render the list view.
 */
function showHistoryPanel() {
  const overlay = document.getElementById('pageguide-history');
  if (overlay) overlay.style.display = 'flex';
  renderHistoryList();
}

/**
 * Hide the history overlay.
 */
function hideHistoryPanel() {
  const overlay = document.getElementById('pageguide-history');
  if (overlay) overlay.style.display = 'none';
}

/**
 * Render the list of saved chats in the history body.
 */
async function renderHistoryList() {
  const body = document.getElementById('pageguide-history-body');
  const backBtn = document.getElementById('pageguide-history-back');
  const titleEl = document.getElementById('pageguide-history-hdr-title');
  if (!body) return;

  if (backBtn) backBtn.style.visibility = 'hidden';
  if (titleEl) titleEl.textContent = 'Chat History';

  body.innerHTML = '<div class="pageguide-history-empty">Loading…</div>';

  let history = [];
  try {
    const data = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
    history = Array.isArray(data[HISTORY_STORAGE_KEY]) ? data[HISTORY_STORAGE_KEY] : [];
  } catch (err) {
    body.innerHTML = `<div class="pageguide-history-empty">❌ Could not load history: ${err.message}</div>`;
    return;
  }

  if (history.length === 0) {
    body.innerHTML = '<div class="pageguide-history-empty">No saved chats yet.<br>Use 💾 Save to save a chat.</div>';
    return;
  }

  body.innerHTML = '';
  history.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'pageguide-history-item';

    const main = document.createElement('div');
    main.className = 'pageguide-history-item-main';
    main.addEventListener('click', () => renderHistoryDetail(entry));

    const titleSpan = document.createElement('div');
    titleSpan.className = 'pageguide-history-item-title';
    titleSpan.textContent = entry.title;

    const meta = document.createElement('div');
    meta.className = 'pageguide-history-item-meta';
    meta.textContent = `${entry.savedAt} · ${entry.messages.length} messages`;

    main.appendChild(titleSpan);
    main.appendChild(meta);

    const delBtn = document.createElement('button');
    delBtn.className = 'pageguide-history-delete-btn';
    delBtn.title = 'Delete this chat';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryItem(entry.id);
    });

    item.appendChild(main);
    item.appendChild(delBtn);
    body.appendChild(item);
  });
}

/**
 * Render the detail view for a single saved chat.
 * @param {Object} entry - { id, title, savedAt, messages }
 */
function renderHistoryDetail(entry) {
  const body = document.getElementById('pageguide-history-body');
  const backBtn = document.getElementById('pageguide-history-back');
  const titleEl = document.getElementById('pageguide-history-hdr-title');
  if (!body) return;

  if (backBtn) backBtn.style.visibility = 'visible';
  if (titleEl) titleEl.textContent = entry.title.length > 30 ? entry.title.slice(0, 30) + '…' : entry.title;

  body.innerHTML = '';

  // "Load Chat" button
  const loadBar = document.createElement('div');
  loadBar.className = 'pageguide-history-load-bar';
  const loadBtn = document.createElement('button');
  loadBtn.className = 'pageguide-history-load-btn';
  loadBtn.textContent = '↩ Load this chat';
  loadBtn.addEventListener('click', () => {
    loadHistoryChat(entry);
    hideHistoryPanel();
  });
  loadBar.appendChild(loadBtn);
  body.appendChild(loadBar);

  // Messages
  entry.messages.forEach(msg => {
    const bubble = document.createElement('div');
    bubble.className = `pageguide-history-msg pageguide-history-msg--${msg.type || 'system'}`;
    bubble.textContent = msg.content;
    body.appendChild(bubble);
  });
}

/**
 * Delete a saved chat entry by id and re-render the list.
 * @param {string} id
 */
async function deleteHistoryItem(id) {
  try {
    const data = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
    const history = Array.isArray(data[HISTORY_STORAGE_KEY]) ? data[HISTORY_STORAGE_KEY] : [];
    const updated = history.filter(e => e.id !== id);
    await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: updated });
    renderHistoryList();
  } catch (err) {
    console.warn('History delete failed:', err);
  }
}

/**
 * Load a saved chat into the main panel, replacing the current conversation.
 * @param {Object} entry
 */
function loadHistoryChat(entry) {
  // Reset state first (silently)
  conversationHistory = [];
  chatMessages = [];
  hasImageInConversation = false;
  const container = document.getElementById('pageguide-messages');
  if (container) container.innerHTML = '';

  // Restore messages
  entry.messages.forEach(msg => {
    addMessage(msg.content, msg.type || 'system');
  });

  // Rebuild minimal conversation history for follow-up queries
  entry.messages.forEach(msg => {
    if (msg.type === 'user' || msg.type === 'assistant') {
      conversationHistory.push({ role: msg.type, content: msg.content });
    }
  });
}

// Listen for messages from content script and background
function handleContentMessage(message, sender, sendResponse) {
  // After a Stop, an in-flight content script can still emit "still working" messages. Drop them
  // so the running animation, the red Stop button, and the timeline dots don't re-arm themselves.
  // A new send (sendMessage) or a user-initiated steer (steerRestoreReady, handled below) clears it.
  if (guideStopped && (
        message.action === 'showTyping' ||
        message.action === 'guideStep' ||
        message.action === 'guideStepRecord' ||
        message.action === 'askStep')) {
    return;
  }
  if (message.action === 'guideStep') {
    hideTyping();
    addGuideStep(message.result);
  } else if (message.action === 'guidePaused') {
    if (!guideActive && !guidePaused) return;
    guideStopped = false;
    hideTyping();
    addGuidePausedMessage(message.reason);
  } else if (message.action === 'guideStepRecord') {
    if (message.meta && (message.meta.isInitial || Number(message.meta.step) === 0)) {
      // Initial-state node (step 0): tracked separately so it never inflates the step/dot count,
      // but still accumulated into the session journey so "View journey" can show it later.
      _setJourneyRecalledMode(false);
      currentGuideInitial = message.meta;
      renderGoalCard({ route: 'guide', step: currentGuideStep });
      const sid0 = message.meta.sessionId;
      if (sid0) {
        const j0 = _journeysBySession[sid0] || (_journeysBySession[sid0] = { title: '', steps: [] });
        if (!j0.steps.some(s => Number(s.step) === 0)) j0.steps.unshift(message.meta);
      }
    } else if (message.meta && message.meta.hasShot === false) {
      // Void step (no screenshot) — don't add it to the timeline or the journey.
    } else if (message.meta) {
      const handleRecord = async () => {
        const liveSessionId = message.meta.sessionId;
        if (liveSessionId && getActiveSessionId() !== liveSessionId) {
          await loadSessionSteps(liveSessionId);
        }
        _setJourneyRecalledMode(false); // a live step is arriving — leave recalled view
        const existing = currentGuideRecords.findIndex(r => Number(r.step) === Number(message.meta.step));
        if (existing >= 0) currentGuideRecords[existing] = Object.assign({}, currentGuideRecords[existing], message.meta);
        else currentGuideRecords.push(message.meta);
        currentGuideRecords.sort((a, b) => Number(a.step) - Number(b.step));
        currentGuideStep = message.meta.planStep || message.meta.step || currentGuideStep;
        renderGoalCard({ route: 'guide', step: currentGuideStep });
        setExportEnabled(true);

        // Accumulate this session's journey in memory so it can always be recalled later
        // (independent of the persisted index). Dedup by step.
        const sid = message.meta.sessionId;
        if (sid) {
          const j = _journeysBySession[sid] || (_journeysBySession[sid] = { title: '', steps: [] });
          const at = j.steps.findIndex(s => Number(s.step) === Number(message.meta.step));
          if (at >= 0) j.steps[at] = message.meta; else j.steps.push(message.meta);
          j.steps.sort((a, b) => Number(a.step) - Number(b.step));
          // Label the journey by THIS prompt (currentGoal.prompt), not the stale guide title,
          // so each prompt's button is distinguishable.
          if (!j.title) j.title = currentGoal?.prompt || message.meta.instruction || '';
          // First step of a new guide session → post a "View journey" recall button.
          if (Number(message.meta.step) === 1 && !_journeyBtnSessions.has(sid)) {
            _journeyBtnSessions.add(sid);
            addJourneyRecallMessage(sid, j.title);
          }
        }

        // If the branch tree overlay is open, update the tree in real time (preserving zoom/scroll)
        const overlay = document.getElementById('pageguide-branch-overlay');
        if (overlay && overlay.style.display !== 'none') {
          showBranchTree(true);
        }
      };
      handleRecord();
    }
  } else if (message.action === 'steerRestoreReady') {
    // The agent restored a steered step's state and is waiting for the user to confirm. A steer is
    // a deliberate user action, so it overrides a prior Stop.
    guideStopped = false;
    hideTyping();
    if (message.sessionId && message.branchLabel) {
      registerBranchJourney(message.sessionId, message.branchLabel);
    }
    addSteerRestoreCard(message);
  } else if (message.action === 'askStep') {
    // Ask mode step (scroll/expand)
    hideTyping();
    addAskStep(message.result);
  } else if (message.action === 'askComplete') {
    // Ask mode complete with final answer
    hideTyping();
    if (message.result?.error) {
      addMessage(`❌ ${message.result.error}`, 'error');
    } else if (message.result?.answer) {
      const hasHighlights = message.result.hasHighlights || message.result.highlightCount > 0;
      let answerText = message.result.answer;
      if (message.result.highlightCount > 0) {
        answerText += ` ✨ (${message.result.highlightCount} highlighted)`;
      }
      addMessage(answerText, 'assistant', hasHighlights);
    }
  } else if (message.action === 'showTyping') {
    showTyping();
  } else if (message.action === 'hideTyping') {
    hideTyping();
  } else if (message.action === 'addMessage') {
    if (isGuideParseError(message.content)) {
      addGuideRetryMessage(message.content);
    } else {
      addMessage(message.content, message.type, message.clickable);
    }
  } else if (message.action === 'closePanel') {
    window.close();
  } else if (message.action === 'selectedText') {
    // Handle text selection passed from the content script
    const preview = document.getElementById('pageguide-selected-text-preview');
    const label = document.getElementById('pageguide-selected-text-label');
    
    if (message.text && message.text.length > 0) {
      currentSelectedText = message.text;
      if (preview && label) {
        // Display snippet (max 80 chars)
        const snippet = message.text.length > 80 
          ? message.text.substring(0, 80) + '...' 
          : message.text;
        
        // Count words for better context hint
        const wordCount = message.text.split(/\s+/).filter(w => w.length > 0).length;
        
        label.innerHTML = `${UI_ICONS.quote}<span>"${escapeHtml(snippet)}" (${wordCount} words)</span>`;
        label.title = message.text; // Full text on hover
        preview.style.display = 'flex';
      }
    } else if (currentSelectedText) {
      // Clear selection only if they selected empty space on purpose
      // (content script might just send empty text when clicking around)
      // To not frustrate users, we only hide it when explicitly empty string.
      if (message.text === '') {
        currentSelectedText = null;
        if (preview) preview.style.display = 'none';
      }
    }
  }
}
chrome.runtime.onMessage.addListener(handleContentMessage);
if (typeof window !== 'undefined') window.handleContentMessage = handleContentMessage;

// Notify background when panel is closed.
// The service worker clears page highlights upon receiving panelClosed.
window.addEventListener('beforeunload', () => {
  try {
    chrome.runtime.sendMessage({ action: 'panelClosed' });
  } catch (e) {
    // Extension context might be invalidated
  }
});

function closeDebugPromptLightbox() {
  document.getElementById('pageguide-debug-prompt-lightbox')?.remove();
}

function openDebugPromptLightbox(livePrompts, savedSessions, defaultSessionId) {
  closeDebugPromptLightbox();
  const overlay = document.createElement('div');
  overlay.id = 'pageguide-debug-prompt-lightbox';
  overlay.className = 'pageguide-memory-shot-lightbox'; // reuse overlay styles for background blurring

  overlay.innerHTML = `
    <div class="pageguide-memory-shot-dialog" role="dialog" aria-modal="true" style="padding: 16px; overflow: auto; display: flex; flex-direction: column; height: 85vh; width: 90vw; max-width: 680px; box-sizing: border-box;">
      <div class="pageguide-memory-shot-head" style="margin-bottom: 12px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between;">
        <span style="font-size: 15px; font-weight: 800; color: var(--pg-text);">🐞 Debug Agent Prompt History</span>
        <button type="button" class="pageguide-memory-shot-close" id="pageguide-debug-prompt-close" aria-label="Close prompt viewer" style="font-size: 20px; border: 0; background: transparent; cursor: pointer; color: var(--pg-muted);">×</button>
      </div>
      <div style="margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <label for="pageguide-debug-session-select" style="font-size: 12px; font-weight: bold; color: var(--pg-text); white-space: nowrap; width: 85px;">Select Session:</label>
          <select id="pageguide-debug-session-select" style="flex: 1; padding: 6px; border-radius: 6px; background: var(--pg-bg); color: var(--pg-text); border: 1px solid var(--pg-border); outline: none; font-size: 11px; font-family: sans-serif;">
          </select>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <label for="pageguide-debug-step-select" style="font-size: 12px; font-weight: bold; color: var(--pg-text); white-space: nowrap; width: 85px;">Select Step:</label>
          <select id="pageguide-debug-step-select" style="flex: 1; padding: 6px; border-radius: 6px; background: var(--pg-bg); color: var(--pg-text); border: 1px solid var(--pg-border); outline: none; font-size: 11px; font-family: sans-serif;">
          </select>
        </div>
      </div>
      <div id="pageguide-debug-prompt-content" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; font-family: monospace; font-size: 11px;">
      </div>
    </div>`;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.id === 'pageguide-debug-prompt-close' || e.target.closest('#pageguide-debug-prompt-close')) {
      closeDebugPromptLightbox();
    }
  });

  document.body.appendChild(overlay);

  const sessionSelect = document.getElementById('pageguide-debug-session-select');
  const stepSelect = document.getElementById('pageguide-debug-step-select');
  const contentDiv = document.getElementById('pageguide-debug-prompt-content');

  // Populate Sessions Selector
  const sortedSaved = savedSessions.slice().sort((a, b) => b.startedAt - a.startedAt);

  if (livePrompts.length > 0) {
    const opt = document.createElement('option');
    opt.value = 'live';
    opt.textContent = `🟢 Active Chat Session (${livePrompts.length} steps)`;
    sessionSelect.appendChild(opt);
  }

  sortedSaved.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.sessionId;
    const timeStr = new Date(s.startedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    const goalLabel = s.goal ? ` (${s.goal.substring(0, 30)}...)` : '';
    opt.textContent = `💾 Saved Journey - ${timeStr}${goalLabel}`;
    sessionSelect.appendChild(opt);
  });

  // Pre-select based on defaultSessionId or default to live/first
  if (defaultSessionId) {
    const optToSelect = Array.from(sessionSelect.options).find(o => o.value === defaultSessionId);
    if (optToSelect) {
      optToSelect.selected = true;
    } else if (livePrompts.length > 0) {
      sessionSelect.selectedIndex = 0;
    }
  } else {
    sessionSelect.selectedIndex = 0;
  }

  let currentLoadedSteps = [];

  async function handleSessionChange() {
    const sid = sessionSelect.value;
    stepSelect.innerHTML = '';
    contentDiv.innerHTML = '<div style="padding: 12px; color: var(--pg-muted);">Loading step list...</div>';

    if (sid === 'live') {
      currentLoadedSteps = livePrompts.map((p, idx) => ({
        type: 'live',
        index: idx,
        data: p
      }));
      populateStepDropdown(currentLoadedSteps);
    } else {
      try {
        if (typeof rewindGetIndex === 'function') {
          const idx = await rewindGetIndex(sid);
          if (idx && idx.steps && idx.steps.length > 0) {
            currentLoadedSteps = idx.steps.map(s => ({
              type: 'saved',
              sessionId: sid,
              stepNum: s.step,
              planStep: s.planStep,
              instruction: s.instruction || s.action || '',
              action: s.action,
              timestamp: s.timestamp
            }));
            populateStepDropdown(currentLoadedSteps);
          } else {
            currentLoadedSteps = [];
            stepSelect.innerHTML = '<option value="">(No steps found)</option>';
            contentDiv.innerHTML = '<div style="padding: 12px; color: var(--pg-muted);">No steps recorded for this session.</div>';
          }
        } else {
          throw new Error('rewindGetIndex is not available');
        }
      } catch (err) {
        console.error('Failed to load session index:', err);
        contentDiv.innerHTML = `<div style="padding: 12px; color: #d32f2f;">Error: ${err.message}</div>`;
      }
    }
  }

  function populateStepDropdown(stepsList) {
    stepSelect.innerHTML = '';
    stepsList.forEach((s, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      
      let label = '';
      if (s.type === 'live') {
        const timeStr = new Date(s.data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const stepNum = s.data.metadata?.step !== undefined ? ` (Step ${s.data.metadata.step})` : '';
        const modeLabel = s.data.metadata?.mode ? `[${s.data.metadata.mode}]` : '';
        const actionLabel = s.data.action === 'callLLMWithImages' ? '📸' : '🤖';
        const previewText = s.data.userPrompt ? s.data.userPrompt.substring(0, 40).replace(/\s+/g, ' ') + '...' : '(empty)';
        label = `${actionLabel} ${timeStr} ${modeLabel}${stepNum} - ${previewText}`;
      } else {
        const timeStr = new Date(s.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const stepNum = `Step ${s.stepNum}`;
        const previewText = s.instruction ? s.instruction.substring(0, 40).replace(/\s+/g, ' ') + '...' : '(empty)';
        label = `🤖 ${timeStr} ${stepNum} - ${previewText}`;
      }

      opt.textContent = label;
      stepSelect.appendChild(opt);
    });

    stepSelect.selectedIndex = stepsList.length - 1;
    handleStepChange();
  }

  async function handleStepChange() {
    const idx = stepSelect.value;
    if (idx === '' || !currentLoadedSteps[idx]) {
      contentDiv.innerHTML = '<div style="padding: 12px; color: var(--pg-muted);">No step selected.</div>';
      return;
    }

    const stepInfo = currentLoadedSteps[idx];
    contentDiv.innerHTML = '<div style="padding: 12px; color: var(--pg-muted);">Loading step prompt details...</div>';

    if (stepInfo.type === 'live') {
      renderPromptDetails(stepInfo.data);
    } else {
      try {
        if (typeof rewindGetRecord === 'function') {
          const rec = await rewindGetRecord(stepInfo.sessionId, stepInfo.stepNum);
          if (rec) {
            const promptData = {
              timestamp: rec.timestamp || stepInfo.timestamp,
              action: rec.action ? 'callLLM' : 'unknown',
              systemPrompt: rec.systemPrompt || '',
              userPrompt: rec.userPrompt || rec.instruction || '',
              messages: rec.messages || [
                { role: 'user', content: rec.userPrompt || rec.instruction || '' }
              ],
              imageBase64: rec.screenshotBefore || rec.screenshot || null,
              metadata: {
                mode: rec.mode || 'guide',
                step: rec.step,
                url: rec.url
              }
            };
            renderPromptDetails(promptData);
          } else {
            contentDiv.innerHTML = '<div style="padding: 12px; color: var(--pg-muted);">Record not found in database.</div>';
          }
        } else {
          throw new Error('rewindGetRecord is not available');
        }
      } catch (err) {
        console.error('Failed to load step record:', err);
        contentDiv.innerHTML = `<div style="padding: 12px; color: #d32f2f;">Error loading record: ${err.message}</div>`;
      }
    }
  }

  function renderPromptDetails(p) {
    let html = '';

    // Step Info/Metadata Block
    const timeStr = new Date(p.timestamp).toLocaleString();
    html += `
      <div style="background: var(--pg-bg); border: 1px solid var(--pg-border); padding: 8px; border-radius: 8px; display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; line-height: 1.4;">
        <span style="font-weight: 700; color: var(--pg-muted);">Time:</span>
        <span style="color: var(--pg-text);">${timeStr}</span>
        <span style="font-weight: 700; color: var(--pg-muted);">Mode:</span>
        <span style="color: var(--pg-text); font-weight: bold;">${p.metadata?.mode || 'unknown'}</span>
        ${p.metadata?.step !== undefined ? `<span style="font-weight: 700; color: var(--pg-muted);">Step:</span><span style="color: var(--pg-text);">${p.metadata.step}</span>` : ''}
        <span style="font-weight: 700; color: var(--pg-muted);">Action:</span>
        <span style="color: var(--pg-text);">${p.action}</span>
        <span style="font-weight: 700; color: var(--pg-muted);">URL:</span>
        <span style="color: var(--pg-text); word-break: break-all;"><a href="${escapeHtml(p.metadata?.url || '')}" target="_blank" style="color: var(--pg-accent); text-decoration: none;">${escapeHtml(p.metadata?.url || 'N/A')}</a></span>
      </div>
    `;

    // System Prompt Block
    html += `
      <details open style="margin-top: 0; display: block; border: 1px solid var(--pg-border); border-radius: 8px; padding: 8px; background: var(--pg-card);">
        <summary style="font-weight: 700; cursor: pointer; padding: 4px; color: var(--pg-accent); outline: none;">System Prompt</summary>
        <pre style="white-space: pre-wrap; word-break: break-word; background: var(--pg-bg); padding: 8px; border-radius: 6px; margin-top: 6px; border: 1px solid var(--pg-border); max-height: 20vh; overflow-y: auto; color: var(--pg-text);">${escapeHtml(p.systemPrompt || '(none)')}</pre>
      </details>
    `;

    // Complete Messages History Block
    let messagesHtml = '';
    if (Array.isArray(p.messages)) {
      p.messages.forEach((m, idx) => {
        const roleColor = m.role === 'user' ? 'var(--pg-accent)' : m.role === 'system' ? '#d32f2f' : '#388e3c';
        messagesHtml += `
          <div style="border-bottom: 1px solid var(--pg-border); padding: 8px 0; margin-bottom: 8px;">
            <div style="font-weight: bold; color: ${roleColor}; margin-bottom: 4px; text-transform: uppercase;">[${m.role}] ${idx + 1}</div>
            <pre style="white-space: pre-wrap; word-break: break-word; background: var(--pg-bg); padding: 6px; border-radius: 4px; margin: 0; color: var(--pg-text); max-height: 25vh; overflow-y: auto;">${escapeHtml(m.content || '(empty)')}</pre>
          </div>
        `;
      });
    }
    html += `
      <details open style="margin-top: 0; display: block; border: 1px solid var(--pg-border); border-radius: 8px; padding: 8px; background: var(--pg-card);">
        <summary style="font-weight: 700; cursor: pointer; padding: 4px; color: var(--pg-accent); outline: none;">Message List Context (${p.messages?.length || 0} turns)</summary>
        <div style="margin-top: 6px; max-height: 40vh; overflow-y: auto;">
          ${messagesHtml || '<div style="padding: 4px; color: var(--pg-muted);">(no messages)</div>'}
        </div>
      </details>
    `;

    // Images / Media Block
    let imagesList = [];
    if (p.imageBase64) {
      const isPlaceholder = p.imageBase64 === 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      if (!isPlaceholder) {
        imagesList.push({ base64: p.imageBase64, label: 'Single viewport screenshot' });
      }
    }
    if (Array.isArray(p.images)) {
      p.images.forEach(img => {
        if (img.base64) {
          imagesList.push({ base64: img.base64, label: img.label || 'Image attachment' });
        }
      });
    }

    if (imagesList.length > 0) {
      let imgHtml = '';
      imagesList.forEach(img => {
        const src = img.base64.startsWith('data:') ? img.base64 : `data:image/jpeg;base64,${img.base64}`;
        imgHtml += `
          <div style="border: 1px solid var(--pg-border); border-radius: 6px; padding: 6px; background: var(--pg-bg); display: flex; flex-direction: column; gap: 4px; align-items: flex-start;">
            <span style="font-weight: bold; color: var(--pg-text); margin-bottom: 2px;">${escapeHtml(img.label)}</span>
            <img src="${src}" style="max-width: 100%; max-height: 250px; border-radius: 4px; border: 1px solid var(--pg-border); object-fit: contain; cursor: pointer;" onclick="window.open('${src}')" title="Click to view full size" />
          </div>
        `;
      });
      html += `
        <details open style="margin-top: 0; display: block; border: 1px solid var(--pg-border); border-radius: 8px; padding: 8px; background: var(--pg-card);">
          <summary style="font-weight: 700; cursor: pointer; padding: 4px; color: var(--pg-accent); outline: none;">Attached Screenshots/Images (${imagesList.length})</summary>
          <div style="margin-top: 6px; display: flex; flex-direction: column; gap: 8px;">
            ${imgHtml}
          </div>
        </details>
      `;
    }

    contentDiv.innerHTML = html;
  }

  sessionSelect.addEventListener('change', handleSessionChange);
  stepSelect.addEventListener('change', handleStepChange);

  // Trigger initial populate
  handleSessionChange();
}

function updateDebugButtonVisibility(enabled) {
  // Publish a global flag so other in-panel modules (e.g. the rewind inspector) can show
  // debug-only details like the confidence breakdown without re-reading storage.
  window.__pgDebugEnabled = !!enabled;
  const btn = document.getElementById('pageguide-debug-prompt-btn');
  if (btn) {
    btn.style.display = enabled ? 'inline-flex' : 'none';
  }
  // The confidence-formula and confidence-source toggles are debug/research controls —
  // only surface them in debug mode.
  const confWrap = document.querySelector('.pageguide-conf-wrap');
  if (confWrap) {
    confWrap.style.display = enabled ? '' : 'none';
  }
  const confSrcWrap = document.querySelector('.pageguide-confsrc-wrap');
  if (confSrcWrap) {
    confSrcWrap.style.display = enabled ? '' : 'none';
  }
}
