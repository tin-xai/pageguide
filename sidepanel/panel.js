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
let noPageContext = false; // When true, skip page scraping and answer from AI knowledge only
let panelForcedMode = null; // Sticky route chosen by Find / Guide / Hide tabs; null = Auto
let panelLastRoute = null;  // Last route returned by the router, used only for tab highlight
let currentGoal = null;
let currentGuidePlan = [];
let currentGuideTitle = '';
let currentGuideStep = 0;
let currentGuideRecords = [];
let currentGuideVerifications = {};
let currentGuideWarnings = {};

// Per-tab chat sessions so switching back to a tab restores its conversation.
// Keys are tab IDs; values are { chatMessages, conversationHistory, hasImageInConversation, html }.
// Cleared when the tab is closed, navigates to a new URL, or the user manually resets.
const _tabSessions = new Map();

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
  quote: '<span class="pageguide-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10"/><path d="M7 12h7"/><path d="M5 20h14"/><path d="M4 4h16v12H4z"/></svg></span>'
};

function _truncateText(text, max = 72) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
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

async function showGoalStepPreview(step, anchor) {
  hideGoalStepPreview();
  const meta = getGuideStepMeta(step);
  const label = getGuideStepLabel(step);
  let rec = null;
  try {
    if (meta && typeof rewindGetRecord === 'function') {
      rec = await rewindGetRecord(meta.sessionId, meta.step);
    }
  } catch (e) {}
  const isReview = meta?.confidence != null && meta.confidence < 0.5;
  const reason = isReview
    ? 'PageGuide is less confident about this step, so it is marked for review.'
    : '';

  const preview = document.createElement('div');
  preview.id = 'pageguide-goal-step-preview';
  preview.className = 'pageguide-goal-step-preview';
  preview.innerHTML = `
    ${rec?.screenshot ? `<img src="data:image/jpeg;base64,${rec.screenshot}" alt="">` : '<div class="pageguide-goal-step-preview-empty">No screenshot yet</div>'}
    <div class="pageguide-goal-step-preview-title">Step ${step}</div>
    <div class="pageguide-goal-step-preview-text">${escapeHtml(label)}</div>
    ${reason ? `<div class="pageguide-goal-step-preview-reason">
      <b>Review note</b>
      <span>${escapeHtml(reason)}</span>
    </div>` : ''}
    ${meta?.durationMs != null ? `<div class="pageguide-goal-step-preview-meta">${_formatDuration(meta.durationMs)}</div>` : ''}
    ${meta ? '<button type="button" class="pageguide-goal-step-inspect">Inspect more</button>' : ''}
    ${meta ? '<button type="button" class="pageguide-goal-step-steer">⤳ Steer from here</button>' : ''}
    ${meta ? `<div class="pageguide-goal-step-steerbox" style="display:none">
      <textarea class="pageguide-goal-step-steer-input" rows="2" placeholder="What should the agent do differently from here?"></textarea>
      <div class="pageguide-goal-step-steer-row">
        <button type="button" class="pageguide-goal-step-steer-cancel">Cancel</button>
        <button type="button" class="pageguide-goal-step-steer-go">Branch &amp; run →</button>
      </div>
    </div>` : ''}
  `;

  preview.addEventListener('click', async (e) => {
    e.stopPropagation();
    const target = e.target;
    // Toggle the inline steer prompt.
    if (target.closest('.pageguide-goal-step-steer')) {
      const box = preview.querySelector('.pageguide-goal-step-steerbox');
      if (box) {
        const show = box.style.display === 'none';
        box.style.display = show ? '' : 'none';
        if (show) { const ta = box.querySelector('textarea'); if (ta) ta.focus(); }
      }
      return;
    }
    if (target.closest('.pageguide-goal-step-steer-cancel')) {
      const box = preview.querySelector('.pageguide-goal-step-steerbox');
      if (box) box.style.display = 'none';
      return;
    }
    if (target.closest('.pageguide-goal-step-steer-go')) {
      const ta = preview.querySelector('.pageguide-goal-step-steer-input');
      const goal = ta ? ta.value.trim() : '';
      if (!goal) { if (ta) ta.focus(); return; }
      const goBtn = target.closest('button');
      if (goBtn) goBtn.disabled = true;
      if (meta && typeof RewindTimeline !== 'undefined' && typeof RewindTimeline.steerFromStep === 'function') {
        await RewindTimeline.steerFromStep(meta, goal);
      }
      hideGoalStepPreview();
      return;
    }
    // Clicks inside the steer box (e.g. the textarea) should not open the inspector.
    if (target.closest('.pageguide-goal-step-steerbox')) return;

    // Default: open the in-panel inspector (snapshot + "Steer from here"), which steers THIS
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
  if (!e.target.closest?.('#pageguide-goal-step-preview, .pageguide-goal-dot')) {
    hideGoalStepPreview();
  }
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

  // Always render at least `total` dots so the count matches the "Step X of N" text.
  const count = Math.max(total || 0, states.length);
  for (let i = 1; i <= count; i++) {
    const st = states[i - 1] || { status: i < current ? 'done' : (i === current ? 'current' : 'pending'), review: false, verify: null };
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'pageguide-goal-dot';
    dot.dataset.step = String(i);
    dot.title = getGuideStepLabel(i);
    if (st.status === 'done') dot.classList.add('done');
    else if (st.status === 'current') dot.classList.add('current');
    if (st.review) dot.classList.add('review');
    if (st.verify) dot.classList.add(`verify-${st.verify}`);
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      showGoalStepPreview(i, dot);
    });
    dots.appendChild(dot);
  }
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
  } else if (progress) {
    progress.style.display = 'none';
  }

  card.style.display = '';
  refreshGuideOnlyActions();
}

function clearGoalAndStepPanel() {
  currentGoal = null;
  currentGuidePlan = [];
  currentGuideTitle = '';
  currentGuideStep = 0;
  currentGuideRecords = [];
  currentGuideVerifications = {};
  currentGuideWarnings = {};
  hideGoalStepPreview();
  const goal = document.getElementById('pageguide-goal');
  const stepPanel = document.getElementById('pageguide-step-panel');
  const exportBtn = document.getElementById('pageguide-export-pdf');
  if (goal) goal.style.display = 'none';
  if (stepPanel) {
    stepPanel.style.display = 'none';
    stepPanel.innerHTML = '';
  }
  if (exportBtn) exportBtn.disabled = true;
  refreshGuideOnlyActions();
}

function setExportEnabled(on) {
  const btn = document.getElementById('pageguide-export-pdf');
  if (btn) btn.disabled = !on;
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
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;
  
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
  
  document.getElementById('pageguide-send').addEventListener('click', sendMessage);
  initGuideModeToggle();
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


  // Clean up sessions for closed tabs to avoid memory leaks
  chrome.tabs.onRemoved.addListener((tabId) => {
    _tabSessions.delete(tabId);
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
    if (!e.target.closest('.pageguide-mode-wrap')) {
      const menu = document.getElementById('pageguide-mode-menu');
      if (menu) menu.style.display = 'none';
    }
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

/**
 * Add a guide step message
 */
function addGuideStep(result) {
  const panel = document.getElementById('pageguide-step-panel');
  if (!panel) return;

  guideActive = !result.isLastStep;
  hideTyping();

  // Timeline is concrete-step indexed (one dot per step taken), so track the concrete step.
  currentGuideStep = result.step || result.planStep || currentGuideStep;
  if (result.step != null) delete currentGuideWarnings[result.step];
  if (result.isLastStep) clearGuideWarning();
  renderGoalCard({
    route: 'guide',
    step: currentGuideStep,
    total: currentGuidePlan.length || result.totalSteps || undefined
  });

  const stepBadge = result.isLastStep ? '✅' : `Step ${result.step}`;
  const targetRow = result.targetText
    ? `<div class="pageguide-step-meta-row"><span>Target</span><b>${escapeHtml(result.targetText)}</b></div>`
    : '';
  const nextRow = result.nextStepHint && !result.isLastStep
    ? `<div class="pageguide-step-meta-row"><span>Next</span><b>${escapeHtml(result.nextStepHint)}</b></div>`
    : '';
  const warning = renderStepWarning(result.step);

  panel.innerHTML = `
    <div class="pageguide-step-card ${result.hasHighlights ? 'pageguide-clickable' : ''}">
      <div class="pageguide-guide-step">
        <span class="pageguide-step-badge">${escapeHtml(stepBadge)}</span>
        <span class="pageguide-step-text">${escapeHtml(result.answer || '')}</span>
      </div>
      <div class="pageguide-step-meta">
        ${targetRow}
        ${nextRow}
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

  if (!result.isLastStep) {
    const btnRow = panel.querySelector('.pageguide-step-btn-row');

    const stopHereBtn = document.createElement('button');
    stopHereBtn.className = 'pageguide-step-stop-btn';
    stopHereBtn.textContent = '⏹ Stop here';
    stopHereBtn.title = 'Stop the guide at this step';
    stopHereBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't trigger scroll-to-highlight
      stopGuide(`✅ Stopped after step ${result.step}. Ask me again whenever you need more help.`);
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
      stopHereBtn.disabled = true;
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
        if (stopHereBtn.isConnected) stopHereBtn.disabled = false;
        addMessage(`Could not continue the guide: ${err.message}. Try Next again, or stop here.`, 'system');
      }
    });
    btnRow.appendChild(nextBtn);

    if (btnRow) btnRow.appendChild(stopHereBtn);
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
function showTyping() {
  const container = document.getElementById('pageguide-messages');
  if (!container || container.querySelector('.pageguide-typing')) return;

  const typing = document.createElement('div');
  typing.className = 'pageguide-typing';
  typing.innerHTML = '<span></span><span></span><span></span>';

  if (guideActive) {
    const stopBtn = document.createElement('button');
    stopBtn.className = 'pageguide-guide-stop-btn';
    stopBtn.textContent = '⏹ Stop';
    stopBtn.addEventListener('click', (e) => { e.stopPropagation(); stopGuide(); });
    typing.appendChild(stopBtn);
  }

  container.appendChild(typing);
  container.scrollTop = container.scrollHeight;
}

/**
 * Stop an in-progress guide session.
 * @param {string} [message] - Optional message shown in chat; defaults to generic stop notice.
 */
async function stopGuide(message = '⏹ Guide stopped.') {
  guideActive = false;
  hideTyping();
  try {
    await sendToContentScript({ action: 'stopGuide' });
  } catch (e) { /* content script may not be reachable */ }
  // Also clear SW state directly so the next page load won't resume
  try { chrome.runtime.sendMessage({ action: 'guidanceV2_clearState' }); } catch (e) {}
  addMessage(message, 'system');
}

/**
 * Hide typing indicator
 */
function hideTyping() {
  document.querySelector('.pageguide-typing')?.remove();
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
  
  const query = input?.value.trim() || '';
  
  // Only return early if we have no query AND no attached context
  if (!query && !uploadedFileContent && !uploadedImageBase64 && !currentSelectedText) {
    return;
  }

  _hideSlashMenu();
  if (input) input.value = '';
  if (btn) btn.disabled = true;

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
          messages
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
          messages: messages
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
      if (result.routedTo) {
        const confidence = Math.round((result.routeConfidence || 0) * 100);
        const handlerEmoji = {
          'ask': '💬',
          'guide': '📋',
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
      addMessage(`❌ ${result?.error || 'Unknown error'}`, 'error');
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
      addMessage(`❌ ${msg || 'Unknown error'}`, 'error');
    }
    // Remove failed query from history
    conversationHistory.pop();
  }
  
  btn.disabled = false;
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
      systemPrompt: systemPrompt
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
    html: container ? container.innerHTML : ''
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

  // Rewind (Slice 1): clear the step timeline (content 'reset' clears the store).
  if (typeof RewindTimeline !== 'undefined') RewindTimeline.clear();
  clearGoalAndStepPanel();

  // Discard any saved session for this tab so switching away+back starts fresh
  _tabSessions.delete(currentTabId);

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
    records.push(rec || meta);
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
        ${rec.nextStepHint ? `<p><strong>Next:</strong> ${escapeHtml(rec.nextStepHint)}</p>` : ''}
        ${bits.length ? `<p class="meta">${bits.join(' · ')}</p>` : ''}
        ${rec.screenshot ? `<img src="data:image/jpeg;base64,${rec.screenshot}" alt="Step ${escapeHtml(rec.step)} screenshot">` : ''}
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'guideStep') {
    hideTyping();
    addGuideStep(message.result);
  } else if (message.action === 'guideStepRecord') {
    if (message.meta) {
      const existing = currentGuideRecords.findIndex(r => Number(r.step) === Number(message.meta.step));
      if (existing >= 0) currentGuideRecords[existing] = Object.assign({}, currentGuideRecords[existing], message.meta);
      else currentGuideRecords.push(message.meta);
      currentGuideRecords.sort((a, b) => Number(a.step) - Number(b.step));
      currentGuideStep = message.meta.planStep || message.meta.step || currentGuideStep;
      renderGoalCard({ route: 'guide', step: currentGuideStep });
      setExportEnabled(true);
    }
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
    addMessage(message.content, message.type, message.clickable);
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
});

// Notify background when panel is closed.
// The service worker clears page highlights upon receiving panelClosed.
window.addEventListener('beforeunload', () => {
  try {
    chrome.runtime.sendMessage({ action: 'panelClosed' });
  } catch (e) {
    // Extension context might be invalidated
  }
});
