// PageGuide Side Panel Script
// Handles chat UI and communicates with content scripts

let chatMessages = [];
let conversationHistory = []; // Stores {role: 'user'|'assistant', content: string, hasImage?: boolean}
let currentTabId = null;
let uploadedImageBase64 = null; // Stores the uploaded image (pure base64, no data-URL prefix)
let uploadedImageDataUrl = null; // Full data URL for the chip thumbnail
let uploadedImageMeta = null;   // { name, type, size } for the image chip label
let hasImageInConversation = false; // Track if image was used in conversation
let uploadedFileContent = null; // Text content of an attached file
let uploadedFileName = null;    // Display name of the attached file
let uploadedFileSize = null;    // Byte size of the attached file (for the chip label)
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
let currentGuideSessionId = null;
let currentGuideVerifications = {};
let currentGuideWarnings = {};
let currentGuideWorkingStatus = '';
let currentGuideStatusShownAt = 0;
let currentGuideStatusTimer = null;
let pendingGuideWorkingStatus = '';
const GUIDE_WORKING_STATUS_MIN_MS = 1200;
let goalDotsExpanded = false;
let guideTimelineCheckpointSteps = null;
let _lastFindMessageStep = null; // Step number whose find answer was already posted to chat
let _lastVisualHighlightStep = null; // Step whose visual_highlight image was already posted to chat
let _lastWatchVideoMessageStep = null; // Step number whose watch_video answer was already posted to chat
let _lastRecapKey = null; // sessionId:step of the last recap posted, so it isn't posted twice
let _lastAnswerCardKey = null; // sessionId:step of the last finish(answer) card posted
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
let guideConfidenceThreshold = 0.7;

function _normalizeConfidenceThreshold(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.7;
}

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

function _savedEvidencePreviewEntries(meta, rec) {
  const out = [];
  const push = (item) => {
    if (!item) return;
    const key = String(item.key || item.evidenceKey || '').trim();
    const note = String(item.note || item.evidenceNote || '').replace(/\s+/g, ' ').trim();
    if (!key && !note) return;
    out.push({ key, note });
  };
  (Array.isArray(rec?.savedEvidenceEntries) ? rec.savedEvidenceEntries : []).forEach(push);
  (Array.isArray(rec?.savedEvidenceCaptures) ? rec.savedEvidenceCaptures : []).forEach(push);
  if (rec?.evidenceKey || rec?.evidenceNote) push({ key: rec.evidenceKey, note: rec.evidenceNote });
  if (meta?.evidenceKey || meta?.evidenceNote) push({ key: meta.evidenceKey, note: meta.evidenceNote });
  const seen = new Set();
  return out.filter(item => {
    const k = `${item.key}|${item.note}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function _savedEvidencePreviewHtml(meta, rec) {
  const entries = _savedEvidencePreviewEntries(meta, rec);
  if (!entries.length) return '';
  const count = entries.length;
  const first = entries[0].note || entries[0].key || 'Saved evidence';
  const clippedRaw = first.length > 100 ? `${first.slice(0, 97).trim()}...` : first;
  const clipped = clippedRaw.replace(/[.!?]+$/g, '');
  return `<div class="pageguide-goal-step-evidence">
    <b>${escapeHtml(count === 1 ? 'Saved evidence' : `Saved ${count} evidence`)}</b>
    <span>${escapeHtml(clipped)}</span>
  </div>`;
}

function _savedAnnotationsPreviewEntries(meta, rec) {
  const out = [];
  const push = (item, force = false) => {
    if (!item) return;
    const isAnn = force || item.need_annotation || item.needAnnotation || (Array.isArray(item.annotations) && item.annotations.length > 0) || item.annotation_prompt || item.annotationPrompt;
    if (!isAnn) return;
    const key = String(item.key || item.evidenceKey || '').trim();
    const note = String(item.note || item.evidenceNote || '').replace(/\s+/g, ' ').trim();
    if (!key && !note) return;
    out.push({ key, note });
  };
  (Array.isArray(rec?.savedEvidenceEntries) ? rec.savedEvidenceEntries : []).forEach(item => push(item));
  (Array.isArray(rec?.savedEvidenceCaptures) ? rec.savedEvidenceCaptures : []).forEach(item => push(item));
  (Array.isArray(rec?.visualEvidenceItems) ? rec.visualEvidenceItems : []).forEach(item => push(item));
  (Array.isArray(rec?.annotations) ? rec.annotations : []).forEach(item => push(item, true));
  (Array.isArray(meta?.annotations) ? meta.annotations : []).forEach(item => push(item, true));
  if (meta?.evidenceKey || meta?.evidenceNote) {
    if (meta.need_annotation || meta.needAnnotation) {
      push({ key: meta.evidenceKey, note: meta.evidenceNote });
    }
  }
  const seen = new Set();
  return out.filter(item => {
    const k = `${item.key}|${item.note}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function _savedAnnotationsPreviewHtml(meta, rec) {
  const entries = _savedAnnotationsPreviewEntries(meta, rec);
  if (!entries.length) return '';
  const count = entries.length;
  const first = entries[0].note || entries[0].key || 'Visual annotation';
  const clippedRaw = first.length > 100 ? `${first.slice(0, 97).trim()}...` : first;
  const clipped = clippedRaw.replace(/[.!?]+$/g, '');
  return `<div class="pageguide-goal-step-annotations">
    <b>${escapeHtml(count === 1 ? 'Annotated' : `Annotated ${count} items`)}</b>
    <span>${escapeHtml(clipped)}</span>
  </div>`;
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

function _isGuideWorkingContext() {
  return !!(guideActive || currentGuideWorkingStatus || currentGoal?.route === 'guide' || currentGuideStep || currentGuidePlan.length || currentGuideRecords.length);
}

function updateTypingIndicatorText(text = '') {
  const typing = document.querySelector('.pageguide-typing');
  if (!typing) return;
  const label = typing.querySelector('.pageguide-typing-text');
  if (label) label.textContent = text || 'Agent thinking…';
}

function setGuideWorkingStatus(status = '') {
  const next = String(status || '').trim();
  if (!next) {
    if (currentGuideStatusTimer) {
      clearTimeout(currentGuideStatusTimer);
      currentGuideStatusTimer = null;
    }
    pendingGuideWorkingStatus = '';
    currentGuideWorkingStatus = '';
    currentGuideStatusShownAt = 0;
    return;
  }
  const apply = (value) => {
    currentGuideWorkingStatus = value;
    currentGuideStatusShownAt = Date.now();
    if (panelRunning) showTyping(value);
    else updateTypingIndicatorText(value);
  };
  if (!currentGuideWorkingStatus) {
    apply(next);
    return;
  }
  if (next === currentGuideWorkingStatus) return;
  pendingGuideWorkingStatus = next;
  const elapsed = Date.now() - currentGuideStatusShownAt;
  const wait = Math.max(0, GUIDE_WORKING_STATUS_MIN_MS - elapsed);
  if (currentGuideStatusTimer) clearTimeout(currentGuideStatusTimer);
  currentGuideStatusTimer = setTimeout(() => {
    currentGuideStatusTimer = null;
    const pending = pendingGuideWorkingStatus;
    pendingGuideWorkingStatus = '';
    if (pending) apply(pending);
  }, wait);
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

// Hover support for the checkpoint (goal-dot) preview: a short grace period on mouse-out so the
// user can move from the dot onto the preview card without it vanishing. Reused by both the
// dots and the preview card itself.
let _goalPreviewHideTimer = null;
function _cancelGoalPreviewHide() {
  if (_goalPreviewHideTimer) { clearTimeout(_goalPreviewHideTimer); _goalPreviewHideTimer = null; }
}
function _scheduleGoalPreviewHide() {
  _cancelGoalPreviewHide();
  _goalPreviewHideTimer = setTimeout(() => hideGoalStepPreview(), 220);
}
function _attachDotHoverPreview(dot, step) {
  dot.addEventListener('mouseenter', () => { _cancelGoalPreviewHide(); showGoalStepPreview(step, dot); });
  dot.addEventListener('mouseleave', () => { _scheduleGoalPreviewHide(); });
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

const RECAP_PLACEHOLDER_SHOT = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
function _recapPickShot(v) { return (!v || v === RECAP_PLACEHOLDER_SHOT) ? null : v; }

// Pick the pre-action "marked" evidence for a step. The region crop has the SoM marker baked
// into its pixels (the "region of action"), so it is the primary evidence and needs no overlay.
// Falls back to the full aligned shot (with an overlay box from targetNormRect), then before/after.
// Returns { src, marker } — marker is a normalized rect to overlay, or null when already baked in.
function _recapMarkedEvidence(rec) {
  if (!rec) return null;
  const region = _recapPickShot(rec.regionShot);
  if (region) return { src: `data:image/jpeg;base64,${region}`, marker: null };
  const marked = _recapPickShot(rec.markedShot);
  if (marked && rec.targetNormRect) return { src: `data:image/jpeg;base64,${marked}`, marker: rec.targetNormRect };
  const before = _recapPickShot(rec.screenshotBefore || rec.screenshot);
  if (before) return { src: `data:image/jpeg;base64,${before}`, marker: rec.targetNormRect || null };
  const after = _recapPickShot(rec.screenshotAfter);
  if (after) return { src: `data:image/jpeg;base64,${after}`, marker: null };
  return null;
}

// Pick the SEPARATE visual-evidence shot for a step (the on-page proof that justifies the action,
// e.g. a "Sort by: Price: Low to High" control). The crop already has a pink SoM marker baked in,
// so it needs no overlay; falls back to a normRect overlay on the before-shot. Returns { src, marker }.
function _recapVisualEvidence(rec) {
  if (!rec) return null;
  const shot = _recapPickShot(rec.visualEvidenceShot);
  if (shot) return { src: `data:image/jpeg;base64,${shot}`, marker: null };
  const before = _recapPickShot(rec.screenshotBefore || rec.screenshot);
  if (before && rec.visualEvidenceNormRect) return { src: `data:image/jpeg;base64,${before}`, marker: rec.visualEvidenceNormRect };
  return null;
}

function _recapVisualEvidenceItems(rec) {
  if (!rec) return [];
  const before = _recapPickShot(rec.screenshotBefore || rec.screenshot);
  // Keep only items backed by real evidence (a captured crop or a marker rect), matching the link
  // filter in renderGuideRecap — so a hovered/clicked link's data-evidence-item index lines up with
  // this list. Reason-only items are excluded (they'd be "fake" links that show nothing).
  const rawItems = (Array.isArray(rec.visualEvidenceItems) ? rec.visualEvidenceItems.slice(0, 5) : [])
    .filter(item => item && (item.visualEvidenceShot || item.visualEvidenceNormRect));
  const items = rawItems.map((item) => {
    const shot = _recapPickShot(item.visualEvidenceShot);
    const marker = item.visualEvidenceNormRect || null;
    const ev = shot
      ? { src: `data:image/jpeg;base64,${shot}`, marker: null }
      : (before && marker ? { src: `data:image/jpeg;base64,${before}`, marker } : null);
    return {
      ev,
      number: item.visualEvidenceIndex != null ? item.visualEvidenceIndex : null,
      reason: item.visualEvidenceReason || '',
      text: item.visualEvidenceText || ''
    };
  });
  if (items.length) return items;
  const single = _recapVisualEvidence(rec);
  if (!single) return [];
  return [{
    ev: single,
    number: rec.visualEvidenceIndex != null ? rec.visualEvidenceIndex : null,
    reason: rec.visualEvidenceReason || '',
    text: rec.visualEvidenceText || ''
  }];
}

function _recapSavedEvidenceCapture(rec, key) {
  const needle = String(key || '').trim().toLowerCase();
  if (!rec || !needle) return null;
  const cap = (Array.isArray(rec.savedEvidenceCaptures) ? rec.savedEvidenceCaptures : [])
    .find(item => item && String(item.key || '').trim().toLowerCase() === needle);
  const confirmationCap = (Array.isArray(rec.visualEvidenceItems) ? rec.visualEvidenceItems : [])
    .find(item => item && String(item.key || '').trim().toLowerCase() === needle);
  const shot = _recapPickShot(cap?.shot || confirmationCap?.visualEvidenceShot);
  if (!shot) return null;
  const originalShot = _recapPickShot(
    cap?.originalShot ||
    cap?.annotationOriginalShot ||
    confirmationCap?.visualEvidenceOriginalShot ||
    // Older saved evidence did not store a same-crop clean image, so keep the previous fallback.
    cap?.annotationScreenshot ||
    rec?.screenshotBefore ||
    rec?.screenshot
  );
  // Saved evidence crops already have the visual proof baked in: DOM/SoM captures include the
  // highlighted marker, while bbox captures include the region marker and relationship annotations.
  return {
    src: `data:image/jpeg;base64,${shot}`,
    originalSrc: originalShot ? `data:image/jpeg;base64,${originalShot}` : null,
    marker: null,
    number: null,
    note: cap?.note || confirmationCap?.note || ''
  };
}

// SOM marker overlay: an absolutely-positioned box + number badge, placed from a normalized
// { x, y, w, h } rect (fractions of the image). Empty string when there's no geometry.
function _recapMarkerHtml(normRect, number) {
  if (!normRect) return '';
  const pct = (v) => (Math.max(0, Math.min(1, Number(v) || 0)) * 100).toFixed(2) + '%';
  const num = (number != null && number !== '')
    ? `<span class="pageguide-recap-marker-num">${escapeHtml(String(number))}</span>` : '';
  return `<span class="pageguide-recap-marker-box" style="left:${pct(normRect.x)};top:${pct(normRect.y)};width:${pct(normRect.w)};height:${pct(normRect.h)};">${num}</span>`;
}

// An <img> wrapped in a positioned figure with the marker overlay drawn on top.
function _recapFigureHtml(src, marker, number, alt) {
  return `<span class="pageguide-recap-figure"><img src="${src}" alt="${escapeHtml(alt || '')}">${_recapMarkerHtml(marker, number)}</span>`;
}

// Hover popover shown when the pointer is over an inline recap phrase-link. A short grace timer
// lets the pointer travel from the link onto the popover without it vanishing.
let _recapEvidenceHideTimer = null;
function _cancelRecapEvidenceHide() { if (_recapEvidenceHideTimer) { clearTimeout(_recapEvidenceHideTimer); _recapEvidenceHideTimer = null; } }
function hideRecapEvidencePopover() { document.getElementById('pageguide-recap-evidence-pop')?.remove(); }
function _scheduleRecapEvidenceHide() { _cancelRecapEvidenceHide(); _recapEvidenceHideTimer = setTimeout(hideRecapEvidencePopover, 200); }

async function _showRecapEvidencePopover(anchor, sessionId, step) {
  _cancelRecapEvidenceHide();
  hideRecapEvidencePopover();
  let rec = null;
  try { if (typeof rewindGetRecord === 'function') rec = await rewindGetRecord(sessionId, step); } catch (e) {}
  // A visual-evidence link (the justification text) shows the SEPARATE proof region + its reason;
  // the milestone-phrase links keep showing the action's targeted region + Action line.
  const isVisual = anchor?.dataset?.evidence === 'visual';
  const isScratchpad = anchor?.dataset?.evidence === 'scratchpad';
  const visualItems = isVisual ? _recapVisualEvidenceItems(rec) : [];
  const requestedItem = Number(anchor?.dataset?.evidenceItem);
  const selectedVisual = Number.isFinite(requestedItem) && requestedItem >= 0 && requestedItem < visualItems.length
    ? visualItems[requestedItem]
    : visualItems[0];
  let scratchEv = null;
  if (isScratchpad) {
    let bbox = null;
    try { bbox = JSON.parse(anchor?.dataset?.bbox || 'null'); } catch (e) { bbox = null; }
    scratchEv = _recapSavedEvidenceCapture(rec, anchor?.dataset?.key);
    if (!scratchEv && bbox) {
      const shot = _recapPickShot(rec?.screenshotBefore || rec?.screenshot || rec?.markedShot || rec?.regionShot);
      if (shot) scratchEv = { src: `data:image/jpeg;base64,${shot}`, marker: bbox };
    }
  }
  const ev = isScratchpad ? (scratchEv || _recapMarkedEvidence(rec)) : (isVisual ? (selectedVisual?.ev || null) : _recapMarkedEvidence(rec));
  const number = isScratchpad ? null : (isVisual ? selectedVisual?.number : (rec?.target?.resolvedIndex ?? rec?.resolvedIndex));
  const caption = isScratchpad ? 'Saved evidence' : (isVisual ? 'Visual evidence' : 'Targeted region');
  const detail = isScratchpad
    ? `<div class="pageguide-recap-pop-action"><b>Evidence:</b> ${escapeHtml(anchor?.dataset?.note || 'Saved evidence')}</div>`
    : (isVisual
    ? (selectedVisual
        ? `<div class="pageguide-recap-pop-action"><b>Why:</b> ${escapeHtml(selectedVisual.reason || selectedVisual.text || 'Visual evidence')}</div>`
        : '')
    : `<div class="pageguide-recap-pop-action"><b>Action:</b> ${_recapActionHtml(rec)}</div>`);
  const pop = document.createElement('div');
  pop.id = 'pageguide-recap-evidence-pop';
  pop.className = 'pageguide-recap-evidence-pop' + (isVisual ? ' is-visual' : '');
  const beforeFig = ev
    ? `<figure class="pageguide-recap-pop-fig"><figcaption>${caption}</figcaption>${_recapFigureHtml(ev.src, ev.marker, number, caption.toLowerCase())}</figure>` : '';
  pop.innerHTML = (ev || (isVisual && visualItems.length))
    ? `${beforeFig}${detail}<div class="pageguide-recap-pop-cap">Step ${escapeHtml(String(step))} · click to inspect</div>`
    : `<div class="pageguide-recap-pop-empty">No screenshot for step ${escapeHtml(String(step))}</div>`;
  pop.addEventListener('mouseenter', _cancelRecapEvidenceHide);
  pop.addEventListener('mouseleave', _scheduleRecapEvidenceHide);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const top = Math.min(window.innerHeight - pop.offsetHeight - 8, r.bottom + 8);
  pop.style.top = Math.max(8, top) + 'px';
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
}

// The color-matched "Action: click ⟨N⟩ "text"" line for a step. The ⟨N⟩ badge and the text use the
// SoM marker color (--pg-som) so they match the marker in the screenshot and the recap links.
function _recapActionHtml(rec) {
  const number = rec?.target?.resolvedIndex ?? rec?.resolvedIndex;
  const action = rec?.action || '';
  const typeText = rec?.typeText || '';
  const targetText = rec?.target?.text || rec?.domElementText || rec?.llmElementText || '';
  if (!action) return '<span class="pageguide-recap-action-val">—</span>';
  const numHtml = (number != null && number !== '') ? ` <span class="pageguide-recap-marker-num inline">${escapeHtml(String(number))}</span>` : '';
  const textHtml = targetText ? ` <span class="pageguide-recap-action-target">“${escapeHtml(targetText)}”</span>` : '';
  const typeHtml = (action === 'type' && typeText) ? `: <span class="pageguide-recap-action-target">“${escapeHtml(typeText)}”</span>` : '';
  const navigateUrl = rec?.navigateUrl || '';
  const navigateHtml = ((action === 'goto_url' || action === 'navigate') && navigateUrl) ? `: <span class="pageguide-recap-action-target">${escapeHtml(navigateUrl)}</span>` : '';
  return `<span class="pageguide-recap-action-verb">${escapeHtml(action)}</span>${numHtml}${textHtml}${typeHtml}${navigateHtml}`;
}

// Checkpoint detail overlay: the marked pre-action shot (SOM box on the chosen element) + the
// post-action outcome shot, plus the step instruction and the action taken. Reuses the shared
// memory-shot lightbox shell (so Escape / backdrop close still work).
async function _recapNavigationSteps(sessionId, preferredSteps) {
  const clean = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : [])
    .map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0))).sort((a, b) => a - b);
  let steps = clean(preferredSteps);
  if (steps.length) return steps;
  try {
    if (sessionId && typeof rewindGetIndex === 'function') {
      const idx = await rewindGetIndex(sessionId);
      steps = clean((idx?.steps || []).filter(m => !m.isInitial).map(m => m.step));
    }
  } catch (e) {}
  return steps;
}

async function openRecapCheckpoint(sessionId, step, stepList) {
  closeMemoryShotLightbox();
  hideRecapEvidencePopover();
  let rec = null;
  try { if (typeof rewindGetRecord === 'function') rec = await rewindGetRecord(sessionId, step); } catch (e) {}
  const navSteps = await _recapNavigationSteps(sessionId, stepList);
  const navIndex = navSteps.indexOf(Number(step));
  const prevStep = navIndex > 0 ? navSteps[navIndex - 1] : null;
  const nextStep = navIndex >= 0 && navIndex < navSteps.length - 1 ? navSteps[navIndex + 1] : null;
  const ev = _recapMarkedEvidence(rec);
  const number = rec?.target?.resolvedIndex ?? rec?.resolvedIndex;
  const after = _recapPickShot(rec?.screenshotAfter);
  const instruction = rec?.instruction || '';
  const actionLabel = _recapActionHtml(rec);
  // The SEPARATE visual evidence (proof that justified the action), shown as a third figure.
  const visualItems = _recapVisualEvidenceItems(rec);
  const visReason = visualItems.map((item, i) => `${i + 1}. ${item.reason || item.text || 'Visual evidence'}`).join('\n');
  const visualFiguresHtml = visualItems.map((item, i) => item.ev
    ? `<figure class="pageguide-recap-detail-fig pageguide-recap-detail-evidence-fig"><figcaption>Why ${escapeHtml(String(i + 1))} — visual evidence</figcaption>${_recapFigureHtml(item.ev.src, item.ev.marker, item.number, 'visual evidence')}</figure>`
    : ''
  ).join('');

  const overlay = document.createElement('div');
  overlay.id = 'pageguide-memory-shot-lightbox';
  overlay.className = 'pageguide-memory-shot-lightbox';
  overlay.dataset.recapSession = sessionId || '';
  overlay.dataset.recapStep = String(step);
  overlay.dataset.recapSteps = JSON.stringify(navSteps);
  overlay.innerHTML = `
    <div class="pageguide-memory-shot-dialog pageguide-recap-detail" role="dialog" aria-modal="true" aria-label="Step ${escapeHtml(String(step))} detail">
      <div class="pageguide-memory-shot-head">
        <span>Step ${escapeHtml(String(step))} — visual evidence</span>
        <div class="pageguide-recap-nav">
          <button type="button" class="pageguide-recap-nav-btn" data-step="${prevStep == null ? '' : escapeHtml(String(prevStep))}" aria-label="Previous checkpoint" ${prevStep == null ? 'disabled' : ''}>‹</button>
          <button type="button" class="pageguide-recap-nav-btn" data-step="${nextStep == null ? '' : escapeHtml(String(nextStep))}" aria-label="Next checkpoint" ${nextStep == null ? 'disabled' : ''}>›</button>
          <button type="button" class="pageguide-memory-shot-close" aria-label="Close">×</button>
        </div>
      </div>
      <div class="pageguide-recap-detail-body">
        <div class="pageguide-recap-detail-shots">
          <figure class="pageguide-recap-detail-fig">
            <figcaption>Before — chosen element</figcaption>
            ${ev ? _recapFigureHtml(ev.src, ev.marker, number, 'before action') : '<div class="pageguide-recap-pop-empty">No screenshot</div>'}
          </figure>
          <figure class="pageguide-recap-detail-fig">
            <figcaption>After — result</figcaption>
            ${after ? `<span class="pageguide-recap-figure"><img src="data:image/jpeg;base64,${after}" alt="after action"></span>` : '<div class="pageguide-recap-pop-empty">No screenshot</div>'}
          </figure>
          ${visualFiguresHtml}
        </div>
        <div class="pageguide-recap-detail-text">
          ${instruction ? `<div class="pageguide-recap-detail-instruction">${escapeHtml(instruction)}</div>` : ''}
          <div class="pageguide-recap-detail-action"><b>Action:</b> ${actionLabel}</div>
          ${visReason ? `<div class="pageguide-recap-detail-evidence"><b>Why:</b> ${escapeHtml(visReason).replace(/\n/g, '<br>')}</div>` : ''}
        </div>
      </div>
    </div>`;
  overlay.addEventListener('click', (e) => {
    const nav = e.target.closest('.pageguide-recap-nav-btn');
    if (nav && nav.dataset.step) {
      e.stopPropagation();
      openRecapCheckpoint(sessionId, Number(nav.dataset.step), navSteps);
      return;
    }
    if (e.target === overlay || e.target.closest('.pageguide-memory-shot-close')) closeMemoryShotLightbox();
  });
  document.body.appendChild(overlay);
}

async function openScratchpadEvidenceView(anchor, sessionId, step) {
  closeMemoryShotLightbox();
  hideRecapEvidencePopover();
  let rec = null;
  try { if (typeof rewindGetRecord === 'function') rec = await rewindGetRecord(sessionId, step); } catch (e) {}
  let bbox = null;
  try { bbox = JSON.parse(anchor?.dataset?.bbox || 'null'); } catch (e) { bbox = null; }
  const note = anchor?.dataset?.note || 'Saved evidence';
  const saved = _recapSavedEvidenceCapture(rec, anchor?.dataset?.key);
  const fallbackShot = _recapPickShot(rec?.screenshotBefore || rec?.screenshot || rec?.markedShot || rec?.regionShot);
  const ev = saved || (fallbackShot ? { src: `data:image/jpeg;base64,${fallbackShot}`, marker: bbox } : null);
  const canToggleOriginal = !!(ev?.originalSrc && ev.originalSrc !== ev.src);
  const toggleHtml = canToggleOriginal
    ? `<div class="pageguide-evidence-view-toggle" role="group" aria-label="Evidence screenshot view">
        <button type="button" class="active" data-view="annotated">Annotated</button>
        <button type="button" data-view="original">Original</button>
      </div>`
    : '';
  const imgHtml = ev
    ? `<div class="pageguide-evidence-shot-wrap" data-annotated-src="${escapeHtml(ev.src)}" data-original-src="${escapeHtml(ev.originalSrc || '')}">
        ${toggleHtml}
        ${_recapFigureHtml(ev.src, ev.marker, ev.number ?? null, 'saved evidence')}
      </div>`
    : '<div class="pageguide-recap-pop-empty">No screenshot</div>';
  const overlay = document.createElement('div');
  overlay.id = 'pageguide-memory-shot-lightbox';
  overlay.className = 'pageguide-memory-shot-lightbox';
  overlay.innerHTML = `
    <div class="pageguide-memory-shot-dialog pageguide-recap-detail" role="dialog" aria-modal="true" aria-label="Saved evidence">
      <div class="pageguide-memory-shot-head">
        <span>Saved evidence — step ${escapeHtml(String(step))}</span>
        <button type="button" class="pageguide-memory-shot-close" aria-label="Close">×</button>
      </div>
      <div class="pageguide-recap-detail-body">
        ${imgHtml}
        <div class="pageguide-recap-detail-text">
          <div class="pageguide-recap-detail-evidence"><b>Evidence:</b> ${escapeHtml(note)}</div>
        </div>
      </div>
    </div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.pageguide-memory-shot-close')) closeMemoryShotLightbox();
    const btn = e.target.closest('.pageguide-evidence-view-toggle button');
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      const wrap = btn.closest('.pageguide-evidence-shot-wrap');
      const fig = wrap?.querySelector('.pageguide-recap-figure');
      const img = fig?.querySelector('img');
      if (!wrap || !fig || !img) return;
      const view = btn.dataset.view === 'original' ? 'original' : 'annotated';
      const src = view === 'original' ? wrap.dataset.originalSrc : wrap.dataset.annotatedSrc;
      if (!src) return;
      img.src = src;
      fig.classList.toggle('hide-marker', view === 'original');
      wrap.querySelectorAll('.pageguide-evidence-view-toggle button').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
    }
  });
  document.body.appendChild(overlay);
}

// Draw the model's Final-State annotations (bounding boxes + text labels) over a screenshot, as
// absolutely-positioned overlays from normalized {x,y,w,h} rects. Colored with --pg-som.
function _recapAnnotationsHtml(annotations) {
  if (!Array.isArray(annotations) || !annotations.length) return '';
  const pct = (v) => (Math.max(0, Math.min(1, Number(v) || 0)) * 100).toFixed(2) + '%';
  return annotations.map((a, i) => {
    const label = a && a.label ? a.label : '';
    const labelHtml = label ? `<span class="pageguide-recap-annot-label">${escapeHtml(label)}</span>` : '';
    return `<span class="pageguide-recap-annot-box" style="left:${pct(a.x)};top:${pct(a.y)};width:${pct(a.w)};height:${pct(a.h)};">${labelHtml}</span>`;
  }).join('');
}

const RECAP_VERDICTS = {
  completed: { icon: '✅', label: 'Completed', cls: 'ok' },
  failed:    { icon: '❌', label: 'Incompleted', cls: 'fail' },
  unclear:   { icon: '⚠️', label: 'Unsure', cls: 'unclear' }
};

function _recapStatusText(recap) {
  const verdictKey = recap?.final?.verdict || recap?.finalVerdict || 'unclear';
  const verdict = RECAP_VERDICTS[verdictKey] || RECAP_VERDICTS.unclear;
  const summary = String(recap?.summary || '').trim();
  const lower = summary.toLowerCase();
  let title = summary;
  if (lower.startsWith('i have completed the task.')) title = summary.slice('I have completed the task.'.length).trim();
  if (lower.startsWith('i could not complete the task.')) title = summary.slice('I could not complete the task.'.length).trim();
  title = title || summary || verdict.label;
  return { verdictKey, verdict, title, summary };
}

function _recapFinalButtonHtml(sessionId, step, verdictKey) {
  const verdict = RECAP_VERDICTS[verdictKey] || RECAP_VERDICTS.unclear;
  return `<button type="button" class="pageguide-recap-final-link pageguide-recap-final-btn ${verdict.cls}" data-session="${escapeHtml(String(sessionId || ''))}" data-step="${escapeHtml(String(step))}" title="Final state: ${escapeHtml(verdict.label)}">F</button>`;
}

// Final State view: the final page screenshot annotated with the model's bounding-box evidence,
// plus the completed/failed verdict and reason. Reuses the memory-shot lightbox shell.
async function openFinalStateView(sessionId, step) {
  closeMemoryShotLightbox();
  hideRecapEvidencePopover();
  let rec = null;
  try { if (typeof rewindGetRecord === 'function') rec = await rewindGetRecord(sessionId, step); } catch (e) {}
  const shot = _recapPickShot(rec?.finalShot) || _recapPickShot(rec?.screenshotAfter) || _recapPickShot(rec?.screenshot) || _recapPickShot(rec?.screenshotBefore);
  const verdict = RECAP_VERDICTS[rec?.finalVerdict] || RECAP_VERDICTS.unclear;
  const reason = rec?.finalReason || '';
  const annotations = Array.isArray(rec?.finalAnnotations) ? rec.finalAnnotations : [];
  const imgHtml = shot
    ? `<span class="pageguide-recap-figure pageguide-final-figure"><img src="data:image/jpeg;base64,${shot}" alt="final state">${_recapAnnotationsHtml(annotations)}</span>`
    : '<div class="pageguide-recap-pop-empty">No final screenshot</div>';

  const overlay = document.createElement('div');
  overlay.id = 'pageguide-memory-shot-lightbox';
  overlay.className = 'pageguide-memory-shot-lightbox';
  overlay.innerHTML = `
    <div class="pageguide-memory-shot-dialog pageguide-recap-detail" role="dialog" aria-modal="true" aria-label="Final state">
      <div class="pageguide-memory-shot-head">
        <span>Final State — visual evidence</span>
        <button type="button" class="pageguide-memory-shot-close" aria-label="Close">×</button>
      </div>
      <div class="pageguide-recap-detail-body">
        <div class="pageguide-final-verdict ${verdict.cls}">${verdict.icon} ${escapeHtml(verdict.label)}</div>
        ${reason ? `<div class="pageguide-final-reason">${escapeHtml(reason)}</div>` : ''}
        ${imgHtml}
      </div>
    </div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.pageguide-memory-shot-close')) closeMemoryShotLightbox();
  });
  document.body.appendChild(overlay);
}

// Standalone Final-State card for failed/stopped runs (no recap milestones). A one-line verdict
// with a View button that opens the annotated final-state view.
function renderGuideFinalStateCard(message) {
  const container = document.getElementById('pageguide-messages');
  if (!container || !message || message.step == null) return;
  const verdict = RECAP_VERDICTS[message.verdict] || RECAP_VERDICTS.unclear;
  const msg = document.createElement('div');
  msg.className = 'pageguide-message assistant pageguide-recap-message';
  msg.innerHTML = `
    <div class="pageguide-recap" data-session="${escapeHtml(String(message.sessionId || ''))}" data-steps="${escapeHtml(JSON.stringify([Number(message.step)].filter(Number.isFinite)))}">
      <div class="pageguide-recap-final">${_recapFinalButtonHtml(message.sessionId, message.step, message.verdict)}<span class="pageguide-final-verdict ${verdict.cls} inline">${escapeHtml(verdict.label)}</span></div>
      ${message.reason ? `<div class="pageguide-final-reason">${escapeHtml(message.reason)}</div>` : ''}
    </div>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

// Render a visual_highlight answer as a persistent assistant bubble: the cropped screenshot region
// (with the pink evidence box baked in) plus its caption. Reuses the recap figure/bubble styling.
function renderVisualHighlightAnswer(result) {
  const container = document.getElementById('pageguide-messages');
  if (!container || !result || !result.visualHighlightImage) return;
  const src = `data:image/jpeg;base64,${result.visualHighlightImage}`;
  const caption = result.visualHighlightCaption || '';
  const msg = document.createElement('div');
  msg.className = 'pageguide-message assistant pageguide-recap-message';
  msg.innerHTML = `
    <div class="pageguide-recap pageguide-visual-highlight" style="border: 2px solid var(--pg-som);">
      <div class="pageguide-recap-hero" style="background: color-mix(in srgb, var(--pg-som) 12%, var(--pg-bg)); border-bottom: 1px solid color-mix(in srgb, var(--pg-som) 30%, var(--pg-border)); padding: 12px 16px;">
        <div class="pageguide-recap-kicker" style="color: var(--pg-som); font-size: 11px;">Visual Highlight Answer</div>
      </div>
      <div style="padding: 16px; background: var(--pg-bg); display: flex; flex-direction: column; gap: 8px;">
        <figure class="pageguide-recap-detail-fig pageguide-recap-detail-evidence-fig" style="margin: 0;">${_recapFigureHtml(src, null, null, caption || 'visual answer')}</figure>
        ${caption ? `<div style="font-size: 13px; line-height: 1.4; color: var(--pg-text); font-weight: 500;"><b>Why:</b> ${escapeHtml(caption)}</div>` : ''}
      </div>
    </div>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

// Render a find answer as a persistent assistant bubble using the recap styling.
function renderFindAnswer(result) {
  const container = document.getElementById('pageguide-messages');
  if (!container || !result || !result.findAnswer) return;
  const answerText = parseCitations(parseMarkdown(result.findAnswer));
  const msg = document.createElement('div');
  msg.className = 'pageguide-message assistant pageguide-recap-message';
  msg.innerHTML = `
    <div class="pageguide-recap pageguide-find-answer" style="border: 2px solid var(--pg-som);">
      <div class="pageguide-recap-hero" style="background: color-mix(in srgb, var(--pg-som) 12%, var(--pg-bg)); border-bottom: 1px solid color-mix(in srgb, var(--pg-som) 30%, var(--pg-border)); padding: 12px 16px;">
        <div class="pageguide-recap-kicker" style="color: var(--pg-som); font-size: 11px;">Highlight Answer</div>
      </div>
      <div style="font-size: 14px; line-height: 1.5; color: var(--pg-text); padding: 16px; background: var(--pg-bg); font-weight: 500;">
        ${answerText}
      </div>
    </div>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function renderWatchVideoAnswer(result) {
  const container = document.getElementById('pageguide-messages');
  if (!container || !result) return;
  const raw = result.watchVideoAnswer || result.watchVideoError || '';
  if (!raw) return;
  const answerText = result.watchVideoError
    ? escapeHtml(result.watchVideoError)
    : parseCitations(parseMarkdown(raw));
  const videoUrl = result.watchVideoUrl
    ? `<div style="font-size: 12px; line-height: 1.4; color: var(--pg-muted); padding: 0 16px 14px; background: var(--pg-bg); overflow-wrap: anywhere;">${escapeHtml(result.watchVideoUrl)}</div>`
    : '';
  const msg = document.createElement('div');
  msg.className = 'pageguide-message assistant pageguide-recap-message';
  msg.innerHTML = `
    <div class="pageguide-recap pageguide-find-answer" style="border: 2px solid var(--pg-som);">
      <div class="pageguide-recap-hero" style="background: color-mix(in srgb, var(--pg-som) 12%, var(--pg-bg)); border-bottom: 1px solid color-mix(in srgb, var(--pg-som) 30%, var(--pg-border)); padding: 12px 16px;">
        <div class="pageguide-recap-kicker" style="color: var(--pg-som); font-size: 11px;">Video Answer</div>
      </div>
      <div style="font-size: 14px; line-height: 1.5; color: var(--pg-text); padding: 16px; background: var(--pg-bg); font-weight: 500;">
        ${answerText}
      </div>
      ${videoUrl}
    </div>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function _compactAnswerMarkdown(text) {
  let s = String(text || '').replace(/\r\n/g, '\n');
  // Keep paragraph breaks generally, but collapse blank lines between adjacent bullets so the
  // answer card reads like a compact summary instead of spaced-out sections.
  s = s.replace(/\n{2,}(\s*[-*]\s+)/g, '\n$1');
  s = s.replace(/(\n\s*[-*]\s+[^\n]+)\n{2,}(?=\s*[-*]\s+)/g, '$1\n');
  return s.trim();
}

function _buildAnswerEvidenceModel(answer, scratchpad, answerEvidence) {
  const normEvKey = (value) => {
    if (typeof gv2NormalizeEvidenceKey === 'function') return gv2NormalizeEvidenceKey(value);
    return String(value || '').toLowerCase();
  };
  const byKey = {};
  (Array.isArray(scratchpad) ? scratchpad : []).forEach(e => {
    const key = normEvKey(e?.key);
    if (e && key) byKey[key] = e;
  });
  const answerEvidenceList = Array.isArray(answerEvidence) ? answerEvidence : [];
  const answerEvidenceByKey = {};
  answerEvidenceList.forEach(it => {
    if (!it || !it.key || !Number.isFinite(Number(it.step))) return;
    const key = normEvKey(it.key);
    if (!key || answerEvidenceByKey[key]) return;
    answerEvidenceByKey[key] = {
      ref_step_id: Number(it.step),
      region_bbox: it.region_bbox || null,
      note: it.note || it.key || 'Visual evidence',
      key,
      source: it.source || ''
    };
  });
  const confirmationQueue = answerEvidenceList
    .filter(it => it && it.source === 'confirmation' && Number.isFinite(Number(it.step)))
    .map(it => ({
      ref_step_id: Number(it.step),
      region_bbox: it.region_bbox || null,
      note: it.note || 'Confirmation',
      key: normEvKey(it.key),
      source: it.source || ''
    }));
  let confirmationQueueIndex = 0;
  const evidence = [];
  const byEvidenceKey = {};
  const text = (typeof gv2ExpandBareEvidenceCitations === 'function')
    ? gv2ExpandBareEvidenceCitations(answer, scratchpad)
    : String(answer || '');
  const compactText = _compactAnswerMarkdown(text);
  const re = /\[ev:([a-zA-Z0-9_-]+)\]/g;
  const chips = [];
  const tokenized = compactText.replace(re, (full, rawKey) => {
    const key = normEvKey(rawKey);
    const fallbackConfirmation = confirmationQueue[confirmationQueueIndex] || null;
    const ev = byKey[key] || answerEvidenceByKey[key] || fallbackConfirmation;
    if (ev && ev.ref_step_id != null) {
      if (!byKey[key] && !answerEvidenceByKey[key] && fallbackConfirmation) confirmationQueueIndex += 1;
      if (!byEvidenceKey[key]) {
        const entry = Object.assign({}, ev, { key: ev.key || key });
        byEvidenceKey[key] = { number: evidence.length + 1, key, entry };
        evidence.push(byEvidenceKey[key]);
      }
      const item = byEvidenceKey[key];
      const label = ev.note || key;
      const bbox = ev.region_bbox ? JSON.stringify(ev.region_bbox) : '';
      const chip = `<span class="pageguide-recap-link pageguide-answer-citation-chip" data-evidence="scratchpad" data-key="${escapeHtml(key)}" data-step="${escapeHtml(String(ev.ref_step_id))}" data-bbox="${escapeHtml(bbox)}" data-note="${escapeHtml(label)}" title="${escapeHtml(label)}">📷 ${escapeHtml(String(item.number))}</span>`;
      const idx = chips.push(chip) - 1;
      return `\uE000${idx}\uE001`;
    }
    const idx = chips.push(`<span class="pageguide-evidence-missing" hidden></span>`) - 1;
    return `\uE000${idx}\uE001`;
  });
  let answerHtml = parseMarkdown(tokenized)
    .replace(/\uE000(\d+)\uE001/g, (_, idx) => chips[Number(idx)] || '');
  const appended = [];
  const hasSavedAnswerEvidence = answerEvidenceList.some(it => it && (it.source === 'cited' || it.source === 'scratchpad'));
  answerEvidenceList.forEach((it) => {
    if (!it || !Number.isFinite(Number(it.step))) return;
    const source = String(it.source || '');
    const key = normEvKey(it.key);
    if ((source === 'cited' || source === 'scratchpad') && key && byEvidenceKey[key]) return;
    if (source === 'confirmation' && (hasSavedAnswerEvidence || evidence.length)) return;
    const step = Number(it.step);
    const ev = key ? (byKey[key] || answerEvidenceByKey[key]) : null;
    const note = it.note || ev?.note || key || (source === 'confirmation' ? 'Confirmation' : 'Visual evidence');
    const bboxObj = it.region_bbox || ev?.region_bbox || null;
    const bbox = bboxObj ? JSON.stringify(bboxObj) : '';
    let label = '';
    if (source === 'cited' || source === 'scratchpad') {
      const num = evidence.length + 1;
      if (key && !byEvidenceKey[key]) {
        byEvidenceKey[key] = { number: num, key, entry: ev || { ref_step_id: step, region_bbox: bboxObj, note, key } };
        evidence.push(byEvidenceKey[key]);
      }
      label = `📷 ${escapeHtml(String(num))}`;
    } else {
      label = appended.length ? '📷' : '📷';
    }
    appended.push(`<span class="pageguide-recap-link pageguide-answer-citation-chip" data-evidence="scratchpad" data-key="${escapeHtml(key)}" data-step="${escapeHtml(String(step))}" data-bbox="${escapeHtml(bbox)}" data-note="${escapeHtml(note)}" title="${escapeHtml(note)}">${label}</span>`);
  });
  if (appended.length) {
    answerHtml += ` <span class="pageguide-answer-evidence-tail"><span>Evidence:</span> ${appended.join(' ')}</span>`;
  }
  return { answerHtml, evidence };
}

function _stripEvidenceRefs(text) {
  return String(text || '').replace(/\s*\[ev:[a-zA-Z0-9_-]+\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

function _answerVerdictInfo(result) {
  const recap = result?.recap || {};
  // Verdict is deterministic: a finish answer is a completed run. Fall back to that when the recap
  // (which only builds with Visual Recap on) is absent, rather than showing "Unsure".
  const verdictKey = recap?.final?.verdict || recap?.finalVerdict || (result?.isFinish ? 'completed' : 'unclear');
  const verdict = RECAP_VERDICTS[verdictKey] || RECAP_VERDICTS.unclear;
  return { verdictKey, verdict };
}

function _answerReasoningTrailHtml(recap, sessionId) {
  const milestones = Array.isArray(recap?.milestones) ? recap.milestones.filter(m => m && m.goalRelated !== false) : [];
  const summaryHtml = _answerTrailSummaryHtml(recap, sessionId, milestones);
  if (!milestones.length && !summaryHtml) return '';
  const rows = milestones.map((m, idx) => {
    const step = m.firstStep != null ? m.firstStep : m.step;
    const stepLabel = Number.isFinite(Number(step)) ? String(Number(step)) : String(idx + 1);
    const status = String(m.status || '').toLowerCase();
    const cls = status === 'wrong' ? 'is-wrong' : (status === 'unclear' ? 'is-unclear' : 'is-ok');
    const score = m.errorLabel ? `<span class="pageguide-answer-trail-pill">${escapeHtml(m.errorLabel)}</span>` : '';
    const completed = status === 'wrong' ? '' : (status === 'unclear'
      ? '<span class="pageguide-answer-trail-pill is-unclear">Review</span>'
      : (idx === milestones.length - 1 ? '<span class="pageguide-answer-trail-pill is-complete">Completed</span>' : ''));
    return `<div class="pageguide-answer-trail-row ${cls}">
      <span class="pageguide-answer-trail-dot">${escapeHtml(stepLabel)}</span>
      <span class="pageguide-answer-trail-text-wrap">
        <span class="pageguide-recap-link pageguide-answer-trail-text" data-session="${escapeHtml(String(sessionId || ''))}" data-step="${escapeHtml(String(step || ''))}">${escapeHtml(m.text || '')}</span>
      </span>
      ${score || completed}
    </div>`;
  }).join('');
  return `<details class="pageguide-reasoning-trail">
    <summary><span>Reasoning Trail</span><span class="pageguide-reasoning-trail-chevron">⌄</span></summary>
    <div class="pageguide-reasoning-trail-body">${summaryHtml}${rows}</div>
  </details>`;
}

function _answerStepScreenshotChip(sessionId, step, label = '') {
  const n = Number(step);
  if (!Number.isFinite(n) || n <= 0) return '';
  const chipLabel = label || `Step ${n}`;
  return `<span class="pageguide-recap-link pageguide-answer-summary-chip pageguide-answer-trail-shot" data-session="${escapeHtml(String(sessionId || ''))}" data-step="${escapeHtml(String(n))}" title="Open ${escapeHtml(chipLabel)} screenshot">📷 ${escapeHtml(chipLabel)}</span>`;
}

function _answerSummarySegmentLink(segment, sessionId, label) {
  const step = Number(segment?.step);
  if (!Number.isFinite(step) || step <= 0) return escapeHtml(label);
  const evidenceKey = String(segment?.evidenceKey || segment?.evidence_key || '').trim();
  const bbox = segment?.region_bbox ? JSON.stringify(segment.region_bbox) : '';
  const note = segment?.note || segment?.text || label;
  const evidenceAttrs = evidenceKey
    ? ` data-evidence="scratchpad" data-key="${escapeHtml(evidenceKey)}" data-bbox="${escapeHtml(bbox)}" data-note="${escapeHtml(note)}"`
    : '';
  return `<span class="pageguide-recap-link pageguide-answer-summary-ref" data-session="${escapeHtml(String(sessionId || ''))}" data-step="${escapeHtml(String(step))}"${evidenceAttrs}>${escapeHtml(label)}</span>`;
}

function _answerSummarySegmentHtml(segment, sessionId) {
  const text = String(segment?.text || '').trim();
  if (!text) return '';
  const phrase = String(segment?.phrase || '').trim();
  if (phrase && text.toLowerCase().includes(phrase.toLowerCase())) {
    const idx = text.toLowerCase().indexOf(phrase.toLowerCase());
    return `${escapeHtml(text.slice(0, idx))}${_answerSummarySegmentLink(segment, sessionId, text.slice(idx, idx + phrase.length))}${escapeHtml(text.slice(idx + phrase.length))}`;
  }
  return _answerSummarySegmentLink(segment, sessionId, text);
}

function _answerLinkedSummaryHtml(summaryText, segments, sessionId) {
  const text = String(summaryText || '').trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  const ranges = [];
  (Array.isArray(segments) ? segments : []).forEach((segment) => {
    const phrase = String(segment?.phrase || '').trim();
    if (!phrase) return;
    const start = lower.indexOf(phrase.toLowerCase());
    if (start < 0) return;
    const end = start + phrase.length;
    if (ranges.some(r => start < r.end && end > r.start)) return;
    ranges.push({ start, end, segment });
  });
  if (!ranges.length) return escapeHtml(text);
  ranges.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  ranges.forEach((range) => {
    out += escapeHtml(text.slice(cursor, range.start));
    out += _answerSummarySegmentLink(range.segment, sessionId, text.slice(range.start, range.end));
    cursor = range.end;
  });
  out += escapeHtml(text.slice(cursor));
  return out;
}

function _answerConciseSummaryText(recap) {
  const summary = String(recap?.summary || '').trim();
  const statusInfo = _recapStatusText(recap || {});
  let text = String(statusInfo.title || summary || '').trim();
  text = text.replace(/^I have completed (?:the|your) task\.?\s*/i, '').trim();
  text = text.replace(/^I completed (?:the|your) task\.?\s*/i, '').trim();
  text = text.replace(/^I could not complete (?:the|your) task\.?\s*/i, '').trim();
  text = text || summary;
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  text = sentences.slice(0, 2).join(' ').replace(/\s+/g, ' ').trim();
  if (text.length > 220) text = text.slice(0, 217).replace(/\s+\S*$/, '') + '...';
  return text;
}

function _answerTrailSummaryHtml(recap, sessionId, milestones = []) {
  const meaningful = milestones
    .filter(m => m && Number.isFinite(Number(m.firstStep != null ? m.firstStep : m.step)))
    .slice(0, 4);
  const segments = (Array.isArray(recap?.summarySegments) ? recap.summarySegments : [])
    .filter(s => s && String(s.text || '').trim() && Number.isFinite(Number(s.step)))
    .slice(0, 5);
  const summaryText = _answerConciseSummaryText(recap);
  if (!summaryText && !meaningful.length && !segments.length) return '';
  const linkedSummaryLine = summaryText
    ? `<div class="pageguide-answer-trail-summary-text">${_answerLinkedSummaryHtml(summaryText, segments, sessionId)}</div>`
    : (segments.length
      ? `<div class="pageguide-answer-trail-summary-text">${segments.map(s => _answerSummarySegmentHtml(s, sessionId)).filter(Boolean).join(' ')}</div>`
      : '');
  const summaryLine = (!linkedSummaryLine && summaryText)
    ? `<div class="pageguide-answer-trail-summary-text">${escapeHtml(summaryText)}</div>`
    : '';
  const visualLine = (!linkedSummaryLine && meaningful.length)
    ? `<div class="pageguide-answer-trail-summary-steps">${meaningful.map((m) => {
        const step = m.firstStep != null ? m.firstStep : m.step;
        const text = String(m.phrase || m.text || `Step ${step}`).trim();
        return `<span class="pageguide-answer-trail-summary-step"><span>${escapeHtml(text)}</span>${_answerStepScreenshotChip(sessionId, step, `Step ${step}`)}</span>`;
      }).join('')}</div>`
    : '';
  return `<section class="pageguide-answer-trail-summary">${linkedSummaryLine || summaryLine}${visualLine}</section>`;
}

async function _answerEvidenceFigureHtml(item, sessionId) {
  const entry = item?.entry || {};
  const step = Number(entry.ref_step_id);
  let rec = null;
  try { if (sessionId && Number.isFinite(step) && typeof rewindGetRecord === 'function') rec = await rewindGetRecord(sessionId, step); } catch (e) {}
  const savedCapture = (Array.isArray(rec?.savedEvidenceCaptures) ? rec.savedEvidenceCaptures : [])
    .find(cap => cap && entry.key && String(cap.key || '').toLowerCase() === String(entry.key || '').toLowerCase());
  const confirmationCapture = (Array.isArray(rec?.visualEvidenceItems) ? rec.visualEvidenceItems : [])
    .find(cap => cap && entry.key && String(cap.key || '').toLowerCase() === String(entry.key || '').toLowerCase());
  const dedicatedShot = _recapPickShot(savedCapture?.shot || confirmationCapture?.visualEvidenceShot);
  const shot = dedicatedShot || _recapPickShot(rec?.screenshotBefore || rec?.screenshot || rec?.markedShot || rec?.regionShot);
  const bbox = entry.region_bbox || confirmationCapture?.visualEvidenceNormRect || null;
  const note = entry.note || entry.key || 'Saved evidence';
  const bboxData = bbox ? JSON.stringify(bbox) : '';
  const marker = dedicatedShot ? null : bbox;
  const markerNumber = dedicatedShot ? null : (confirmationCapture?.visualEvidenceIndex ?? savedCapture?.som_id ?? null);
  const figure = shot
    ? _recapFigureHtml(`data:image/jpeg;base64,${shot}`, marker, markerNumber, note)
    : '<div class="pageguide-recap-pop-empty">No screenshot for this evidence</div>';
  return `<section class="pageguide-answer-evidence-item">
    <div class="pageguide-answer-evidence-shot">${figure}</div>
    <div class="pageguide-answer-evidence-caption">${escapeHtml(note)}</div>
    <div class="pageguide-answer-evidence-links">
      <span>Captured at checkpoint ${escapeHtml(String(step || ''))}</span>
      <span class="pageguide-recap-link" data-evidence="scratchpad" data-key="${escapeHtml(String(entry.key || ''))}" data-session="${escapeHtml(String(sessionId || ''))}" data-step="${escapeHtml(String(step || ''))}" data-bbox="${escapeHtml(bboxData)}" data-note="${escapeHtml(note)}">Open full screenshot ↗</span>
    </div>
  </section>`;
}

async function _fallbackActionEvidenceHtml(result, sessionId) {
  const recap = result?.recap || {};
  const finalStep = Number.isFinite(Number(recap.finalStep)) ? Number(recap.finalStep) : Number(result?.step);
  if (!sessionId || !Number.isFinite(finalStep)) return '';
  let rec = null;
  try { if (typeof rewindGetRecord === 'function') rec = await rewindGetRecord(sessionId, finalStep); } catch (e) {}
  const ev = _recapMarkedEvidence(rec) || (() => {
    const shot = _recapPickShot(rec?.screenshotAfter || rec?.screenshotBefore || rec?.screenshot);
    return shot ? { src: `data:image/jpeg;base64,${shot}`, marker: null } : null;
  })();
  if (!ev) return '';
  const caption = rec?.instruction || 'Final task evidence';
  return `<section class="pageguide-answer-evidence-item">
    <div class="pageguide-answer-evidence-shot">${_recapFigureHtml(ev.src, ev.marker, rec?.target?.resolvedIndex ?? rec?.resolvedIndex, caption)}</div>
    <div class="pageguide-answer-evidence-caption">${escapeHtml(caption)}</div>
    <div class="pageguide-answer-evidence-links">
      <span>Captured at checkpoint ${escapeHtml(String(finalStep))}</span>
      <span class="pageguide-recap-link" data-session="${escapeHtml(String(sessionId))}" data-step="${escapeHtml(String(finalStep))}">Open full screenshot ↗</span>
    </div>
  </section>`;
}

// Render a single action-grounding figure (the SoM-marked screenshot of a clicked/targeted step).
// Used for the "action-fallback" descriptor — navigate-only tasks or answers the model did not
// cite — so the card always has a visual link even with no saved scratchpad evidence.
async function _answerActionGroundingHtml(step, note, sessionId) {
  const stepNum = Number(step);
  if (!sessionId || !Number.isFinite(stepNum)) return '';
  let rec = null;
  try { if (typeof rewindGetRecord === 'function') rec = await rewindGetRecord(sessionId, stepNum); } catch (e) {}
  const ev = _recapMarkedEvidence(rec) || (() => {
    const shot = _recapPickShot(rec?.screenshotAfter || rec?.screenshotBefore || rec?.screenshot);
    return shot ? { src: `data:image/jpeg;base64,${shot}`, marker: null } : null;
  })();
  const caption = note || rec?.instruction || 'Final task evidence';
  const figure = ev
    ? _recapFigureHtml(ev.src, ev.marker, rec?.target?.resolvedIndex ?? rec?.resolvedIndex, caption)
    : '<div class="pageguide-recap-pop-empty">No screenshot for this step</div>';
  return `<section class="pageguide-answer-evidence-item">
    <div class="pageguide-answer-evidence-shot">${figure}</div>
    <div class="pageguide-answer-evidence-caption">${escapeHtml(caption)}</div>
    <div class="pageguide-answer-evidence-links">
      <span>Captured at checkpoint ${escapeHtml(String(stepNum))}</span>
      <span class="pageguide-recap-link" data-evidence="scratchpad" data-session="${escapeHtml(String(sessionId))}" data-step="${escapeHtml(String(stepNum))}" data-note="${escapeHtml(caption)}">Open full screenshot ↗</span>
    </div>
  </section>`;
}

// Render the guaranteed evidence strip from a gv2BuildAnswerEvidence() descriptor list. Cited /
// scratchpad items resolve to a screenshot cropped to their region_bbox; action-fallback items
// resolve to the clicked step's marked screenshot. Non-empty whenever `items` is non-empty.
async function _answerEvidenceStripHtml(items, sessionId) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '';
  const parts = await Promise.all(list.map((it) => {
    if (it && it.source === 'action-fallback') {
      return _answerActionGroundingHtml(it.step, it.note, sessionId);
    }
    const item = {
      number: it.number || null,
      key: it.key || '',
      entry: { ref_step_id: it.step, region_bbox: it.region_bbox || null, note: it.note, key: it.key || '' }
    };
    return _answerEvidenceFigureHtml(item, sessionId);
  }));
  return parts.join('');
}

async function renderGuideFinalAnswer(result) {
  const container = document.getElementById('pageguide-messages');
  if (!container || !result || !result.finalAnswer) return;
  const sessionId = result.sessionId || result.recap?.sessionId || '';
  const model = _buildAnswerEvidenceModel(result.finalAnswer, result.evidenceScratchpad || [], result.answerEvidence || []);
  const { verdict, verdictKey } = _answerVerdictInfo(result);
  const trailHtml = _answerReasoningTrailHtml(result.recap, sessionId);
  const checkpointSteps = Array.isArray(result.recap?.milestones)
    ? result.recap.milestones.map(m => Number(m.step)).filter(n => Number.isFinite(n) && n > 0)
    : [];
  if (checkpointSteps.length) {
    guideTimelineCheckpointSteps = checkpointSteps;
    goalDotsExpanded = false;
    if (currentGuideStep) renderGoalCard({ route: 'guide', step: currentGuideStep, title: currentGuideTitle });
  }
  const msg = document.createElement('div');
  msg.className = 'pageguide-message assistant pageguide-recap-message';
  msg.innerHTML = `
    <div class="pageguide-recap pageguide-answer-card" data-session="${escapeHtml(String(sessionId || ''))}" data-steps="${escapeHtml(JSON.stringify(result.recap?.steps || result.recap?.milestones?.map(m => m.step) || []))}">
      <div class="pageguide-answer-head">
        <div class="pageguide-recap-kicker">Answer</div>
        <span class="pageguide-answer-status ${escapeHtml(verdict.cls)}">${escapeHtml(verdict.label)}</span>
      </div>
      <div class="pageguide-answer-copy">${model.answerHtml}</div>
      ${trailHtml}
      <span class="pageguide-answer-verdict-key" hidden>${escapeHtml(verdictKey)}</span>
    </div>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}



// Render an end-of-task Visual Recap into the chat: an LLM summary, milestone lines whose key
// phrase is an inline hover-link (hover → the step's marked screenshot pops up), and a row of
// numbered checkpoint cards that open a before/after detail view with the SOM marker + action.
async function renderGuideRecap(recap) {
  const container = document.getElementById('pageguide-messages');
  if (!container || !recap || !recap.summary) return;
  const milestones = Array.isArray(recap.milestones) ? recap.milestones : [];
  const sessionId = recap.sessionId;
  guideTimelineCheckpointSteps = milestones.map(m => Number(m.step)).filter(n => Number.isFinite(n) && n > 0);
  goalDotsExpanded = false;
  if (currentGuideStep) renderGoalCard({ route: 'guide', step: currentGuideStep, title: currentGuideTitle });

  const msg = document.createElement('div');
  msg.className = 'pageguide-message assistant pageguide-recap-message';

  const displayMilestones = milestones.filter((m) => m && m.goalRelated !== false);

  const collapsedMilestones = [];
  for (let i = 0; i < displayMilestones.length; i++) {
    const current = displayMilestones[i];
    const isScrollDown = String(current.text || '').toLowerCase().includes('scroll down');
    if (isScrollDown) {
      let j = i + 1;
      while (j < displayMilestones.length) {
        const next = displayMilestones[j];
        const nextIsScrollDown = String(next.text || '').toLowerCase().includes('scroll down');
        if (nextIsScrollDown) {
          j++;
        } else {
          break;
        }
      }
      const count = j - i;
      if (count > 1) {
        collapsedMilestones.push({
          ...current,
          step: `${current.step} - ${displayMilestones[j - 1].step}`,
          firstStep: current.step,
          isCollapsedScroll: true,
          mergedEvidenceSteps: displayMilestones.slice(i, j).map(m => m.step)
        });
        i = j - 1;
      } else {
        collapsedMilestones.push({
          ...current,
          firstStep: current.step
        });
      }
    } else {
      collapsedMilestones.push({
        ...current,
        firstStep: current.step
      });
    }
  }

  const rowsHtml = collapsedMilestones.map((m) => {
    const text = m.text || '';
    const phrase = (m.phrase && text.toLowerCase().includes(m.phrase.toLowerCase())) ? m.phrase : '';
    const clickStep = m.firstStep != null ? m.firstStep : m.step;
    const link = (label) => `<span class="pageguide-recap-link" data-session="${escapeHtml(String(sessionId || ''))}" data-step="${escapeHtml(String(clickStep))}">${escapeHtml(label)}</span>`;
    const status = String(m.status || '').toLowerCase();
    const errorLabel = String(m.errorLabel || '').trim();
    const reason = String(m.reason || '').trim();
    const labelHtml = status === 'wrong' && errorLabel
      ? `<span class="pageguide-recap-error-label" title="${escapeHtml(reason)}">(${escapeHtml(errorLabel)})</span>`
      : (status === 'unclear' ? `<span class="pageguide-recap-error-label unclear" title="${escapeHtml(reason)}">(unclear)</span>` : '');
    const stepValue = String(m.step || '');
    const stepNumHtml = stepValue
      ? `<button type="button" class="pageguide-recap-step-num" data-session="${escapeHtml(String(sessionId || ''))}" data-step="${escapeHtml(String(clickStep))}" title="Open step ${escapeHtml(stepValue)} checkpoint">${escapeHtml(stepValue)}</button>`
      : '';
    let inner;
    if (phrase) {
      const idx = text.toLowerCase().indexOf(phrase.toLowerCase());
      inner = `${escapeHtml(text.slice(0, idx))}${link(text.slice(idx, idx + phrase.length))}${escapeHtml(text.slice(idx + phrase.length))}`;
    } else {
      inner = link(text);
    }
    // Merge in the captured visual evidence for this step
    let evidenceHtml = '';
    if (m.isCollapsedScroll) {
      const allEvItems = [];
      (m.mergedEvidenceSteps || []).forEach(stepNum => {
        const ev = recap.evidenceByStep && recap.evidenceByStep[stepNum];
        // Only real evidence (a captured shot or a marker rect) becomes a link. Reason-only items
        // have nothing to show on hover/click — they render as "fake" links, so drop them.
        const items = (Array.isArray(ev?.items) ? ev.items : []).filter(it => it.hasShot || it.hasRect);
        allEvItems.push(...items.map(item => ({ ...item, stepNum })));
      });
      const evidenceItems = allEvItems.slice(0, 5);
      if (evidenceItems.length) {
        evidenceHtml = `<div class="pageguide-recap-evidence"><div class="pageguide-recap-evidence-label">Visual evidence</div>${evidenceItems.map((item, i) => `<span class="pageguide-recap-link pageguide-recap-evidence-link" data-evidence="visual" data-evidence-item="${escapeHtml(String(i))}" data-session="${escapeHtml(String(sessionId || ''))}" data-step="${escapeHtml(String(item.stepNum))}" title="Visual evidence ${escapeHtml(String(i + 1))} for step ${escapeHtml(String(item.stepNum))}">${escapeHtml(`${i + 1}. ${item.index != null ? `[${item.index}] ` : ''}${item.reason || 'Why this step is correct'}`)}</span>`).join(' ')}</div>`;
      }
    } else {
      const evidence = recap.evidenceByStep && recap.evidenceByStep[m.step];
      // Only real evidence (a captured shot or marker rect) becomes a clickable link; reason-only
      // items are dropped so they don't render as "fake" links that pop nothing on hover/click.
      const evidenceItems = (Array.isArray(evidence?.items) ? evidence.items : []).filter(it => it.hasShot || it.hasRect).slice(0, 5);
      evidenceHtml = evidenceItems.length
        ? `<div class="pageguide-recap-evidence"><div class="pageguide-recap-evidence-label">Visual evidence</div>${evidenceItems.map((item, i) => `<span class="pageguide-recap-link pageguide-recap-evidence-link" data-evidence="visual" data-evidence-item="${escapeHtml(String(i))}" data-session="${escapeHtml(String(sessionId || ''))}" data-step="${escapeHtml(String(m.step))}" title="Visual evidence ${escapeHtml(String(i + 1))} for step ${escapeHtml(String(m.step))}">${escapeHtml(`${i + 1}. ${item.index != null ? `[${item.index}] ` : ''}${item.reason || 'Why this step is correct'}`)}</span>`).join(' ')}</div>`
        : (evidence && evidence.hasShot
            ? `<div class="pageguide-recap-evidence"><div class="pageguide-recap-evidence-label">Visual evidence</div><span class="pageguide-recap-link pageguide-recap-evidence-link" data-evidence="visual" data-session="${escapeHtml(String(sessionId || ''))}" data-step="${escapeHtml(String(m.step))}" title="Visual evidence for step ${escapeHtml(String(m.step))}">${escapeHtml(evidence.reason || 'Why this step is correct')}</span></div>`
            : '');
    }
    return `<div class="pageguide-recap-row ${status ? `is-${escapeHtml(status)}` : ''}">
      <div class="pageguide-recap-row-head">${stepNumHtml}<span class="pageguide-recap-text">${inner} ${labelHtml}</span></div>
      ${evidenceHtml}
    </div>`;
  }).join('');

  // Final State links to the last checkpoint reached, and is displayed at the end of the checkpoint row.
  const finalStep = Number.isFinite(Number(recap.finalStep)) ? Number(recap.finalStep)
    : (milestones.length ? milestones[milestones.length - 1].step : null);
  const finalVerdict = recap?.final?.verdict || recap?.finalVerdict || 'unclear';
  const finalChipHtml = (finalStep != null) ? _recapFinalButtonHtml(sessionId, finalStep, finalVerdict) : '';
  const statusInfo = _recapStatusText(recap);
  const bodyNote = (statusInfo.summary && statusInfo.summary !== statusInfo.title && !statusInfo.summary.endsWith(statusInfo.title))
    ? statusInfo.summary
    : '';
  const chipsHtml = milestones.map((m) =>
    `<button type="button" class="pageguide-recap-checkpoint" data-session="${escapeHtml(String(sessionId || ''))}" data-step="${escapeHtml(String(m.step))}" title="Open step ${escapeHtml(String(m.step))} detail">${escapeHtml(String(m.step))}</button>`
  ).join('') + finalChipHtml;
  const recapSteps = recap.steps || milestones.map(m => m.step);
  msg.innerHTML = `
    <div class="pageguide-recap" data-session="${escapeHtml(String(sessionId || ''))}" data-steps="${escapeHtml(JSON.stringify(recapSteps))}">
      <div class="pageguide-recap-hero">
        <div class="pageguide-recap-kicker">${escapeHtml(statusInfo.verdictKey === 'completed' ? 'Task Complete' : (statusInfo.verdictKey === 'failed' ? 'Task Incomplete' : 'Task Review'))}</div>
        <div class="pageguide-recap-summary">${escapeHtml(statusInfo.title)}</div>
        <span class="pageguide-final-verdict ${escapeHtml(statusInfo.verdict.cls)}">${escapeHtml(statusInfo.verdict.label)}</span>
      </div>
      ${bodyNote ? `<div class="pageguide-recap-body-note">${escapeHtml(bodyNote)}</div>` : ''}
      ${displayMilestones.length ? `<div class="pageguide-recap-list">${rowsHtml}</div>` : ''}
      ${(milestones.length || finalChipHtml) ? `<div class="pageguide-recap-checkpoints-label">Checkpoints</div><div class="pageguide-recap-checkpoints">${chipsHtml}</div>` : ''}
    </div>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
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

function _shouldShowGuideActionScores(source = {}, isInitialNode = false) {
  if (isInitialNode) return false;
  const action = String(source.action || '').toLowerCase();
  const pageTargetActions = new Set(['click', 'type', 'clear_text', 'drag_drop']);
  if (!pageTargetActions.has(action)) return false;
  const hasScore = [source.mechGrounding, source.grounded, source.mechLoop, source.loop]
    .some(v => typeof v === 'number' && Number.isFinite(v));
  return hasScore;
}

function _guideStepReviewInfo(source = {}) {
  const grounding = source?.mechGrounding ?? source?.grounding ?? source?.grounded;
  const loop = source?.mechLoop ?? source?.loop;
  const labels = [];
  const provided = Array.isArray(source?.reviewLabels) ? source.reviewLabels : [];
  if (provided.includes('misgrounded')) labels.push({ key: 'misgrounded', label: 'Misgrounded', detail: 'Grounding is below the review threshold.' });
  if (provided.includes('loop')) labels.push({ key: 'loop', label: 'Loop', detail: 'Loop score is above the review threshold.' });
  if (typeof grounding === 'number' && Number.isFinite(grounding) && grounding < 0.5) {
    const existing = labels.find(item => item.key === 'misgrounded');
    if (existing) existing.detail = `Grounding ${grounding.toFixed(2)} is below 0.50.`;
    else labels.push({ key: 'misgrounded', label: 'Misgrounded', detail: `Grounding ${grounding.toFixed(2)} is below 0.50.` });
  }
  if (typeof loop === 'number' && Number.isFinite(loop) && loop >= 0.3) {
    const existing = labels.find(item => item.key === 'loop');
    if (existing) existing.detail = `Loop ${loop.toFixed(2)} is at or above 0.30.`;
    else labels.push({ key: 'loop', label: 'Loop', detail: `Loop ${loop.toFixed(2)} is at or above 0.30.` });
  }
  return labels;
}

function _timelineWordClip(text, maxWords = 50) {
  const full = String(text || '').replace(/\s+/g, ' ').trim();
  if (!full) return { full: '', short: '', clipped: false };
  const words = full.split(' ');
  if (words.length <= maxWords) return { full, short: full, clipped: false };
  return { full, short: `${words.slice(0, maxWords).join(' ')}...`, clipped: true };
}

function _timelineDetailTextHtml(label, text) {
  const clipped = _timelineWordClip(text, 50);
  if (!clipped.full) return '';
  if (!clipped.clipped) {
    return `<div>${escapeHtml(label)}: <b>${escapeHtml(clipped.short)}</b></div>`;
  }
  return `<div class="pageguide-goal-step-score-text">
    ${escapeHtml(label)}:
    <b>${escapeHtml(clipped.short)}</b>
    <details class="pageguide-goal-step-expandable">
      <summary>Show full text</summary>
      <div>${escapeHtml(clipped.full)}</div>
    </details>
  </div>`;
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
  const tier = (typeof gv2ConfidenceTier === 'function') ? gv2ConfidenceTier(conf, guideConfidenceThreshold) : null;
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
  const scoreSource = rec || meta || {};
  const reviewInfo = _guideStepReviewInfo(scoreSource);
  const reviewHtml = reviewInfo.length
    ? `<div class="pageguide-goal-step-review-status">
        <div>Status: ${reviewInfo.map(item => `<b>${escapeHtml(item.label)}</b>`).join(' · ')}</div>
        ${reviewInfo.map(item => `<div>${escapeHtml(item.detail)}</div>`).join('')}
      </div>`
    : '';
  const fmtScore = (v) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(2) : '—';
  const loopMatches = scoreSource.loopMatches != null ? Number(scoreSource.loopMatches) : null;
  const planDone = scoreSource.planCompleted != null ? Number(scoreSource.planCompleted) : null;
  const planTotal = scoreSource.planTotal != null ? Number(scoreSource.planTotal) : currentGuidePlan.length;
  const scoreHtml = _shouldShowGuideActionScores(scoreSource, isInitialNode)
    ? `<div class="pageguide-goal-step-scores">
        <div>Grounding: <b>${fmtScore(scoreSource.mechGrounding ?? scoreSource.grounded)}</b></div>
        <div>Loop: <b>${fmtScore(scoreSource.mechLoop)}</b>${loopMatches != null ? ` (${loopMatches}/10 matches)` : ''}</div>
        <div>Plan: <b>${Number.isFinite(planDone) && planTotal ? `${Math.min(planDone, planTotal)}/${planTotal}` : '—'}</b></div>
        ${_timelineDetailTextHtml('LLM text', scoreSource.llmElementText)}
        ${_timelineDetailTextHtml('DOM text', scoreSource.domElementText)}
      </div>`
    : '';
  const url = meta?.url || rec?.url || '';
  // Show the URL as a compact "link" hyperlink rather than the full (often long) address.
  const urlHtml = url ? `<a class="pageguide-goal-step-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="${escapeHtml(url)}">🔗 link</a>` : '';
  const evidenceHtml = _savedEvidencePreviewHtml(meta, rec);
  const annotationsHtml = _savedAnnotationsPreviewHtml(meta, rec);
  const allowSteer = !!meta && !isInitialNode;

  // Card layout: the REGION-around-the-target crop is the picture on top; the full BEFORE-action
  // screenshot is tucked into a collapsible below it. (Falls back to the before-shot on top when
  // there's no region crop — e.g. the initial-state node.) The AFTER-action shot is in "Inspect more".
  const PLACEHOLDER_SHOT = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  let beforeShot = rec?.screenshotBefore || rec?.screenshot || null;
  if (beforeShot === PLACEHOLDER_SHOT) beforeShot = null;
  let regionShot = rec?.regionShot || null;
  if (regionShot === PLACEHOLDER_SHOT) regionShot = null;
  let afterShot = rec?.screenshotAfter || null;
  if (afterShot === PLACEHOLDER_SHOT) afterShot = null;
  const topShot = regionShot || beforeShot || afterShot;
  const topImg = topShot
    ? `<img src="data:image/jpeg;base64,${topShot}" alt="" ${(!regionShot && (beforeShot || afterShot)) ? `class="pageguide-memory-shot-trigger" data-shot-kind="${beforeShot ? 'before' : 'after'}"` : ''}>`
    : '';
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
    ${evidenceHtml}
    ${annotationsHtml}
    ${reviewHtml}
    ${scoreHtml}
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
    if (target.closest('.pageguide-goal-step-expandable')) return;
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

  // Keep the preview open while the pointer is over it (hover flow); hide shortly after leaving.
  preview.addEventListener('mouseenter', _cancelGoalPreviewHide);
  preview.addEventListener('mouseleave', _scheduleGoalPreviewHide);

  // This function is async (awaits rewindGetRecord), so hover-mouseenter and click can each have
  // an in-flight call. Remove any preview appended by an earlier call right before appending, so
  // only the latest card survives (the initial hide at the top runs before the awaits).
  hideGoalStepPreview();
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
  if (e.key === 'Escape') { closeMemoryShotLightbox(); hideRecapEvidencePopover(); return; }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const overlay = document.getElementById('pageguide-memory-shot-lightbox');
  if (!overlay || !overlay.dataset.recapSession) return;
  let steps = [];
  try { steps = JSON.parse(overlay.dataset.recapSteps || '[]'); } catch (err) { steps = []; }
  const current = Number(overlay.dataset.recapStep);
  const idx = steps.indexOf(current);
  const target = e.key === 'ArrowLeft' ? steps[idx - 1] : steps[idx + 1];
  if (Number.isFinite(Number(target))) {
    e.preventDefault();
    openRecapCheckpoint(overlay.dataset.recapSession, Number(target), steps);
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

  // Initial-state node (step 0): a distinct first dot, never counted as a step.
  if (currentGuideInitial) {
    const idot = document.createElement('button');
    idot.type = 'button';
    idot.className = 'pageguide-goal-dot initial';
    idot.dataset.step = '0';
    idot.title = 'Initial state';
    idot.addEventListener('click', (e) => { e.stopPropagation(); showGoalStepPreview(0, idot); });
    _attachDotHoverPreview(idot, 0);
    dots.appendChild(idot);
  }

  // Always render at least `total` dots so the count matches the "Step X of N" text.
  const count = Math.max(total || 0, states.length);
  const checkpointSteps = Array.isArray(guideTimelineCheckpointSteps)
    ? guideTimelineCheckpointSteps.filter(n => Number.isFinite(Number(n)) && Number(n) >= 1 && Number(n) <= count).map(n => Number(n))
    : [];
  const compact = !goalDotsExpanded && count > 8 && checkpointSteps.length > 0 && !guideActive;
  const important = new Set([1, current, count]);
  checkpointSteps.forEach(n => important.add(n));
  currentGuideRecords.forEach(r => {
    const n = Number(r.step);
    if (!Number.isFinite(n) || n < 1 || n > count) return;
    const hasAnn = (Array.isArray(r.savedEvidenceCaptures) && r.savedEvidenceCaptures.some(c => c.need_annotation || (Array.isArray(c.annotations) && c.annotations.length > 0))) || (Array.isArray(r.annotations) && r.annotations.length > 0);
    if (r.evidenceKey || r.hasVisualEvidence || r.isLastStep || r.finalVerdict || r.verification || hasAnn) important.add(n);
  });
  const visibleSteps = compact
    ? Array.from(important).filter(n => Number.isFinite(n)).sort((a, b) => a - b).slice(0, 10)
    : Array.from({ length: count }, (_, i) => i + 1);
  dots.classList.toggle('is-compact', compact);
  dots.title = compact ? 'Showing checkpoints. Use Show all steps to expand.' : '';
  for (const i of visibleSteps) {
    const st = states[i - 1] || { status: i < current ? 'done' : (i === current ? 'current' : 'pending'), review: false, verify: null };
    const rec = getGuideStepMeta(i);
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'pageguide-goal-dot';
    dot.dataset.step = String(i);
    dot.title = getGuideStepLabel(i);
    if (compact && count > 1) {
      dot.style.setProperty('--pg-dot-pos', String(Math.max(0, Math.min(1, (i - 1) / (count - 1)))));
    }
    if (st.status === 'done') dot.classList.add('done');
    else if (st.status === 'current') dot.classList.add('current');
    // Confidence status (green ≥70%, yellow <70%) — NO red for confidence.
    const tier = (typeof gv2ConfidenceTier === 'function') ? gv2ConfidenceTier(rec?.confidence, guideConfidenceThreshold) : null;
    if (tier === 'high') dot.classList.add('conf-high');
    else if (tier === 'med') dot.classList.add('conf-med');
    const reviewInfo = _guideStepReviewInfo(rec || st || {});
    if (reviewInfo.length) {
      dot.classList.add('review');
      dot.dataset.review = reviewInfo.map(item => item.key).join(',');
      dot.title = `${dot.title} — ${reviewInfo.map(item => item.label).join(', ')}`;
    }
    if (st.verify) dot.classList.add(`verify-${st.verify}`);
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      showGoalStepPreview(i, dot);
    });
    _attachDotHoverPreview(dot, i);
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
  const planList = document.getElementById('pageguide-plan-list');

  if (icon) icon.textContent = ROUTE_ICONS[activeRoute] || ROUTE_ICONS[normalized] || '🎯';
  if (titleEl) titleEl.textContent = titleText;

  const totalSteps = Math.max(currentGuidePlan.length, currentGuideRecords.length, currentGuideStep || 0);
  let planCompleted = 0;
  let highestDone = 0;
  
  currentGuideRecords.forEach(r => {
    const cps = Number(r.completedPlanStep) || Number(r.meta?.completedPlanStep) || 0;
    if (cps > highestDone) highestDone = cps;
  });

  if (isGuide && totalSteps > 0 && currentGuideStep > 0) {
    const safeStep = Math.max(1, Math.min(currentGuideStep, totalSteps));
    const planTotal = currentGuidePlan.length;
    planCompleted = highestDone;
    const concreteCount = Math.max(currentGuideRecords.length, safeStep);
    if (progress) progress.style.display = 'flex';
    if (stepText) {
      stepText.textContent = planTotal
        ? `Plan ${Math.min(planCompleted, planTotal)}/${planTotal} · Step ${concreteCount}`
        : `Step ${safeStep} of ${totalSteps}`;
    }
    if (fill) fill.style.width = `${Math.round(((planTotal ? Math.min(planCompleted, planTotal) : safeStep) / (planTotal || totalSteps)) * 100)}%`;
    let dotsToggle = document.getElementById('pageguide-goal-dots-toggle');
    const hasSummaryCheckpoints = Array.isArray(guideTimelineCheckpointSteps) && guideTimelineCheckpointSteps.length > 0 && !guideActive;
    if (progress && totalSteps > 8 && hasSummaryCheckpoints) {
      if (!dotsToggle) {
        dotsToggle = document.createElement('button');
        dotsToggle.type = 'button';
        dotsToggle.id = 'pageguide-goal-dots-toggle';
        dotsToggle.className = 'pageguide-goal-dots-toggle';
        dotsToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          goalDotsExpanded = !goalDotsExpanded;
          renderGoalCard({ route: 'guide', step: currentGuideStep, title: currentGuideTitle });
        });
        progress.insertBefore(dotsToggle, document.getElementById('pageguide-goal-dots'));
      }
      dotsToggle.textContent = goalDotsExpanded ? 'Show checkpoints' : 'Show all steps';
      dotsToggle.style.display = '';
    } else if (dotsToggle) {
      dotsToggle.style.display = 'none';
    }
    renderGoalDots(safeStep, totalSteps);
    renderConfChart();
  } else if (progress) {
    progress.style.display = 'none';
  }
  
  if (planList) {
    if (isGuide && currentGuidePlan.length) {
      planList.style.display = 'flex';
      planList.innerHTML = currentGuidePlan.map((p, i) => {
        const n = Number(p?.n || i + 1) || i + 1;
        const goal = String(p?.goal || p?.description || p?.step || '').trim();
        const isDone = n <= highestDone;
        const isCurrent = !isDone && n === highestDone + 1;
        const cls = isDone ? ' done' : (isCurrent ? ' current' : '');
        return `<div class="pageguide-plan-row${cls}"><span class="pageguide-plan-num">${escapeHtml(String(n))}.</span><span class="pageguide-plan-goal">${escapeHtml(goal)}</span></div>`;
      }).join('');
    } else {
      planList.style.display = 'none';
      planList.innerHTML = '';
    }
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

function resetLiveGuideTimelineForSession(sessionId, options = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid || currentGuideSessionId === sid) return false;
  currentGuideSessionId = sid;
  currentGuidePlan = Array.isArray(options.plan) ? options.plan : [];
  currentGuideTitle = options.title || '';
  currentGuideStep = 0;
  currentGuideRecords = [];
  currentGuideInitial = null;
  currentGuideVerifications = {};
  currentGuideWarnings = {};
  goalDotsExpanded = false;
  guideTimelineCheckpointSteps = null;
  visibleJourneySessionId = null;
  visibleJourneyTitle = '';
  visibleJourneyRecalled = false;
  hideGoalStepPreview();
  return true;
}

function clearGoalAndStepPanel() {
  guidePaused = false;
  currentGoal = null;
  currentGuidePlan = [];
  currentGuideTitle = '';
  currentGuideStep = 0;
  currentGuideRecords = [];
  currentGuideInitial = null;
  currentGuideSessionId = null;
  currentGuideVerifications = {};
  currentGuideWarnings = {};
  goalDotsExpanded = false;
  guideTimelineCheckpointSteps = null;
  _lastFindMessageStep = null;
  _lastVisualHighlightStep = null;
  _lastWatchVideoMessageStep = null;
  _lastRecapKey = null;
  _lastAnswerCardKey = null;
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
  const stopBtn = document.getElementById('pageguide-guide-stop-paused');
  if (!btn) return;
  const show = !!(guideActive || guidePaused);
  btn.style.display = show ? '' : 'none';
  btn.classList.toggle('is-resume', !!guidePaused);
  btn.textContent = guidePaused ? 'Resume' : 'Pause';
  btn.title = guidePaused ? 'Resume guide' : 'Pause guide';
  btn.setAttribute('aria-label', guidePaused ? 'Resume guide' : 'Pause guide');
  btn.disabled = false;
  if (stopBtn) {
    stopBtn.style.display = guidePaused ? '' : 'none';
    stopBtn.disabled = false;
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const local = await chrome.storage.local.get(['guideConfidenceThreshold']);
    guideConfidenceThreshold = _normalizeConfidenceThreshold(local.guideConfidenceThreshold);
  } catch (e) {}

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
    if (currentGuideWorkingStatus) return;
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
  document.getElementById('pageguide-guide-stop-paused')?.addEventListener('click', () => {
    stopPausedGuideWithRecap();
  });
  initGuideModeToggle();
  initGuideVisualInputToggle();
  initEndSummaryToggle();
  initVisualRecapToggle();
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

  if (imageUpload) imageUpload.addEventListener('change', handleUpload);
  if (removeImageBtn) removeImageBtn.addEventListener('click', clearUploadedImage);

  // File / selected-text chips are (re)built dynamically, so their remove buttons
  // are wired via one delegated listener on the chip row.
  const chipRow = document.getElementById('pageguide-attachment-chips');
  if (chipRow) {
    chipRow.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-chip-remove]');
      if (!btn) return;
      const kind = btn.getAttribute('data-chip-remove');
      if (kind === 'file') clearUploadedFile();
      else if (kind === 'text') clearSelectedText();
    });
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
    const settings = await chrome.storage.sync.get(['debugEnabled', 'alwaysShowPromptBtn']);
    updateDebugButtonVisibility(settings.debugEnabled === true, settings.alwaysShowPromptBtn === true);
  } catch (e) {}

  // Listen for sync storage changes to update debug button visibility
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && ('debugEnabled' in changes || 'alwaysShowPromptBtn' in changes)) {
      chrome.storage.sync.get(['debugEnabled', 'alwaysShowPromptBtn']).then(s => {
        updateDebugButtonVisibility(s.debugEnabled === true, s.alwaysShowPromptBtn === true);
      });
    }
    if (namespace === 'local' && changes.guideConfidenceThreshold) {
      guideConfidenceThreshold = _normalizeConfidenceThreshold(changes.guideConfidenceThreshold.newValue);
      renderGoalCard({ route: currentGoal?.route || 'guide', step: currentGuideStep });
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
  result = result.replace(/<br>\s*(<ul>)/g, '$1');
  result = result.replace(/(<\/ul>)\s*<br>/g, '$1');
  
  // Wrap in paragraph if not already wrapped with a block element
  if (!result.startsWith('<h') && !result.startsWith('<ul') && !result.startsWith('<pre') && !result.startsWith('<p')) {
    if (result.includes('<ul>')) {
      result = result.replace(/^([\s\S]*?)(<ul>)/, (full, before, listStart) => {
        const intro = before.replace(/<br>$/g, '').trim();
        return intro ? `<p>${intro}</p>${listStart}` : listStart;
      });
    } else {
      result = '<p>' + result + '</p>';
    }
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

    // 1. Visual recap links/checkpoints/final-state. Delegated so restored chat HTML after a
    // tab switch still has working screenshot hover/click behavior.
    const recapFinal = e.target.closest('.pageguide-recap-final-link');
    if (recapFinal) {
      e.stopPropagation();
      const wrap = recapFinal.closest('.pageguide-recap');
      const sid = recapFinal.dataset.session || wrap?.dataset.session || '';
      if (sid) openFinalStateView(sid, Number(recapFinal.dataset.step));
      return;
    }

    const recapEl = e.target.closest('.pageguide-recap-checkpoint, .pageguide-recap-link, .pageguide-recap-step-num');
    if (recapEl) {
      e.stopPropagation();
      const wrap = recapEl.closest('.pageguide-recap');
      const sid = recapEl.dataset.session || wrap?.dataset.session || '';
      let steps = [];
      try { steps = JSON.parse(wrap?.dataset.steps || '[]'); } catch (err) { steps = []; }
      if (sid && recapEl.dataset.evidence === 'scratchpad') {
        openScratchpadEvidenceView(recapEl, sid, Number(recapEl.dataset.step));
      } else if (sid) {
        openRecapCheckpoint(sid, Number(recapEl.dataset.step), steps);
      }
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

  container.addEventListener('mouseover', (e) => {
    const link = e.target.closest('.pageguide-recap-link');
    if (!link || !container.contains(link)) return;
    if (link.contains(e.relatedTarget)) return;
    const wrap = link.closest('.pageguide-recap');
    const sid = link.dataset.session || wrap?.dataset.session || '';
    if (sid) _showRecapEvidencePopover(link, sid, Number(link.dataset.step));
  });

  container.addEventListener('mouseout', (e) => {
    const link = e.target.closest('.pageguide-recap-link');
    if (!link || !container.contains(link)) return;
    if (link.contains(e.relatedTarget)) return;
    _scheduleRecapEvidenceHide();
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
  msg.innerHTML = `
    <button type="button" class="pageguide-journey-recall-btn" data-session="${escapeHtml(sessionId)}">
      <span class="pageguide-journey-recall-ico">↗</span>
      <span class="pageguide-journey-recall-text">
        <span class="pageguide-journey-recall-title">${escapeHtml(label || 'View journey')}</span>
        <span class="pageguide-journey-recall-sub">Replay every step of this task</span>
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
      const verb = ({ type: 'Typed into', clear_text: 'Cleared text in', select: 'Selected', check: 'Toggled', toggle: 'Toggled' })[e.action] || 'Clicked';
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
    <div class="pageguide-steer-reason-wrap" style="margin: 8px 12px; display: flex; flex-direction: column; gap: 8px;">
      <textarea id="pageguide-steer-reason-input" class="pageguide-input" placeholder="Why did you restore at this step?" style="min-height: 50px; resize: vertical; margin: 0; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--pg-border); background: var(--pg-bg-input); color: var(--pg-fg); font-family: inherit; font-size: 13px;"></textarea>
      <div style="display: flex; gap: 6px; margin-bottom: 4px;">
        <button type="button" class="pageguide-mode-btn active" id="pageguide-steer-mode-wrong" style="flex: 1; padding: 4px; font-size: 11px; border-radius: 4px; border: 1px solid var(--pg-border); background: var(--pg-bg); color: var(--pg-fg); cursor: pointer; text-align: center;">Fixing an error</button>
        <button type="button" class="pageguide-mode-btn" id="pageguide-steer-mode-intent" style="flex: 1; padding: 4px; font-size: 11px; border-radius: 4px; border: 1px solid transparent; background: transparent; color: var(--pg-fg-muted); cursor: pointer; text-align: center;">Updating goal</button>
      </div>
      <label id="pageguide-steer-fixed-wrap" style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; color: var(--pg-fg-muted);">
        <input type="checkbox" id="pageguide-steer-fixed-cb" style="margin: 0; cursor: pointer;">
        I already corrected the error manually
      </label>
    </div>
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

  const btnWrong = card.querySelector('#pageguide-steer-mode-wrong');
  const btnIntent = card.querySelector('#pageguide-steer-mode-intent');
  const fixedWrap = card.querySelector('#pageguide-steer-fixed-wrap');
  let selectedMode = 'wrong';

  if (btnWrong && btnIntent) {
    btnWrong.addEventListener('click', () => {
      selectedMode = 'wrong';
      btnWrong.style.borderColor = 'var(--pg-border)';
      btnWrong.style.background = 'var(--pg-bg)';
      btnWrong.style.color = 'var(--pg-fg)';
      btnIntent.style.borderColor = 'transparent';
      btnIntent.style.background = 'transparent';
      btnIntent.style.color = 'var(--pg-fg-muted)';
      if (fixedWrap) fixedWrap.style.display = 'flex';
    });
    btnIntent.addEventListener('click', () => {
      selectedMode = 'intent';
      btnIntent.style.borderColor = 'var(--pg-border)';
      btnIntent.style.background = 'var(--pg-bg)';
      btnIntent.style.color = 'var(--pg-fg)';
      btnWrong.style.borderColor = 'transparent';
      btnWrong.style.background = 'transparent';
      btnWrong.style.color = 'var(--pg-fg-muted)';
      if (fixedWrap) fixedWrap.style.display = 'none';
    });
  }

  card.querySelector('.pageguide-steer-restore-confirm')?.addEventListener('click', (e) => {
    e.stopPropagation();
    
    const reasonText = card.querySelector('#pageguide-steer-reason-input')?.value || '';
    const isFixed = card.querySelector('#pageguide-steer-fixed-cb')?.checked || false;

    card.querySelectorAll('button').forEach(b => { b.disabled = true; });
    showTyping();
    sendToContentScript({ 
      action: 'confirmSteerRestore',
      reason: reasonText,
      mode: selectedMode,
      isFixed: isFixed
    });
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
  let steps = null, title = '', plan = [];
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
        plan = Array.isArray(idx.guidePlan) ? idx.guidePlan : (Array.isArray(idx.plan) ? idx.plan : []);
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
  currentGuidePlan = Array.isArray(plan) ? plan : [];
  currentGuideSessionId = sessionId || currentGuideSessionId;
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
  currentGuideSessionId = null;
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
  return currentGuideSessionId || visibleJourneySessionId || currentGuideInitial?.sessionId || (currentGuideRecords[0] ? currentGuideRecords[0].sessionId : null);
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
        const isGood = conf >= guideConfidenceThreshold;
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
      let afterShot = rec?.screenshotAfter || null;
      if (afterShot === PLACEHOLDER_SHOT) afterShot = null;
      const topShot = regionShot || beforeShot || afterShot;
      const imgHtml = topShot 
        ? `<img src="data:image/jpeg;base64,${topShot}" alt="" ${(!regionShot && (beforeShot || afterShot)) ? `class="pageguide-memory-shot-trigger" data-shot-kind="${beforeShot ? 'before' : 'after'}"` : ''}>` 
        : '';

      const beforeHtml = (beforeShot && regionShot)
        ? `<details class="pageguide-goal-step-before"><summary>Before action screenshot</summary>
            <img class="pageguide-memory-shot-trigger" data-shot-kind="before" src="data:image/jpeg;base64,${beforeShot}" alt="before action"></details>`
        : '';

      const conf = node.meta.confidence;
      const tier = (typeof gv2ConfidenceTier === 'function') ? gv2ConfidenceTier(conf, guideConfidenceThreshold) : null;
      const badgeHtml = (tier && conf != null)
        ? `<div class="pageguide-goal-step-conf ${tier === 'high' ? 'conf-high' : 'conf-med'}">Confidence: ${Math.round(conf * 100)}%</div>`
        : '';

      const actionText = node.meta.action ? `[${node.meta.action.toUpperCase()}] ` : '';
      const instruction = node.meta.instruction || 'Initial state';

      const url = node.meta.url || rec?.url || '';
      const urlHtml = url ? `<a class="pageguide-goal-step-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="${escapeHtml(url)}">🔗 link</a>` : '';
      const evidenceHtml = _savedEvidencePreviewHtml(node.meta, rec);

      const allowSteer = node.stepNum > 0;

      card.innerHTML = `
        ${badgeHtml}
        ${imgHtml}
        <div class="pageguide-goal-step-preview-title">${node.stepNum === 0 ? 'Initial State' : 'Step ' + node.stepNum}</div>
        <div class="pageguide-goal-step-preview-text"><b>${actionText}</b>${escapeHtml(instruction)}</div>
        ${evidenceHtml}
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
// Manual: the user clicks each highlighted step. Auto modes let the agent perform steps itself.
// The "no ask" level bypasses risk/confirmation gates, while confidence and loop guards stay on.
const GUIDE_AUTO_MODE_KEY = 'guideAutoMode';
const GUIDE_AUTONOMY_LEVEL_KEY = 'guideAutonomyLevel';

function _normalizeGuideAutonomyMode(mode, auto = false) {
  const raw = String(mode || '').trim();
  if (raw === 'auto_no_ask' || raw === 'auto') return raw;
  return auto === true ? 'auto' : 'manual';
}

function _renderGuideMode(btn, mode) {
  const normalized = _normalizeGuideAutonomyMode(mode);
  const auto = normalized !== 'manual';
  const label = normalized === 'auto_no_ask' ? 'Auto: No Ask' : (auto ? 'Auto: Ask' : 'Manual');
  btn.innerHTML = auto ? `${UI_ICONS.bolt}${label} ▾` : `${UI_ICONS.hand}${label} ▾`;
  btn.classList.toggle('pageguide-mode-auto', auto);
  btn.classList.toggle('pageguide-mode-noask', normalized === 'auto_no_ask');
  btn.title = normalized === 'auto_no_ask'
    ? 'Auto: No Ask bypasses risk and confirmation pauses; confidence and loop guards remain on.'
    : (auto
      ? 'Auto: Ask completes low-risk steps and pauses for confirmation or sensitive actions.'
      : 'Manual mode: you do each step yourself.');
  document.querySelectorAll('.pageguide-mode-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.mode === normalized);
  });
}

function initGuideModeToggle() {
  const btn = document.getElementById('pageguide-mode-toggle');
  const menu = document.getElementById('pageguide-mode-menu');
  if (!btn) return;
  chrome.storage.local.get([GUIDE_AUTO_MODE_KEY, GUIDE_AUTONOMY_LEVEL_KEY])
    .then(r => _renderGuideMode(btn, _normalizeGuideAutonomyMode(r[GUIDE_AUTONOMY_LEVEL_KEY], r[GUIDE_AUTO_MODE_KEY] === true)))
    .catch(() => _renderGuideMode(btn, 'manual'));

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  menu?.addEventListener('click', async (e) => {
    const option = e.target.closest('.pageguide-mode-option');
    if (!option) return;
    e.stopPropagation();
    const mode = _normalizeGuideAutonomyMode(option.dataset.mode);
    try {
      await chrome.storage.local.set({
        [GUIDE_AUTO_MODE_KEY]: mode !== 'manual',
        [GUIDE_AUTONOMY_LEVEL_KEY]: mode
      });
    } catch (e) {}
    _renderGuideMode(btn, mode);
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
  return v === 'llm' ? 'llm' : 'mechanical';
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
    .catch(() => _renderConfSource(btn, 'mechanical'));

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

// Target-region capture mode (debug-only): legacy vs scroll+aligned fresh crop.
const GUIDE_REGION_CAPTURE_KEY = 'guideDebugRegionCapture';
const GUIDE_REGION_CAPTURE_MODES = {
  legacy: {
    label: 'Legacy',
    title: 'Crop the carried before-shot using immediate element bounds.',
  },
  aligned: {
    label: 'Aligned',
    title: 'Scroll the target into view, capture a fresh screenshot, then crop (before action).',
  },
};

function _normalizeRegionCaptureMode(v) {
  return v === 'aligned' ? 'aligned' : 'legacy';
}

function _renderRegionCaptureMode(btn, mode) {
  mode = _normalizeRegionCaptureMode(mode);
  const spec = GUIDE_REGION_CAPTURE_MODES[mode];
  btn.innerHTML = `${UI_ICONS.image}Target: ${spec.label} ▾`;
  btn.title = spec.title;
  document.querySelectorAll('#pageguide-regioncap-menu .pageguide-mode-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.mode === mode);
  });
}

function initRegionCaptureToggle() {
  const btn = document.getElementById('pageguide-regioncap-toggle');
  const menu = document.getElementById('pageguide-regioncap-menu');
  if (!btn) return;
  chrome.storage.local.get(GUIDE_REGION_CAPTURE_KEY)
    .then(r => _renderRegionCaptureMode(btn, _normalizeRegionCaptureMode(r[GUIDE_REGION_CAPTURE_KEY])))
    .catch(() => _renderRegionCaptureMode(btn, 'legacy'));

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  menu?.addEventListener('click', async (e) => {
    const option = e.target.closest('.pageguide-mode-option');
    if (!option) return;
    e.stopPropagation();
    const mode = _normalizeRegionCaptureMode(option.dataset.mode);
    try { await chrome.storage.local.set({ [GUIDE_REGION_CAPTURE_KEY]: mode }); } catch (err) {}
    _renderRegionCaptureMode(btn, mode);
    menu.style.display = 'none';
  });
}

// Pass History mode (debug-only): whether to include previous steps in LLM prompt.
const GUIDE_PASS_HISTORY_KEY = 'guideDebugPassHistory';
const GUIDE_PASS_HISTORY_MODES = {
  not_passing: {
    label: 'No',
    title: 'Do not pass history to LLM (default).',
  },
  passing: {
    label: 'Yes',
    title: 'Pass past observed number of steps and user redirection to LLM.',
  },
};

function _normalizePassHistoryMode(v) {
  return v === 'not_passing' ? 'not_passing' : 'passing'; // passing is default
}

function _renderPassHistoryMode(btn, mode) {
  mode = _normalizePassHistoryMode(mode);
  const spec = GUIDE_PASS_HISTORY_MODES[mode];
  btn.innerHTML = `<span class="pageguide-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg></span>History: ${spec.label} ▾`;
  btn.title = spec.title;
  document.querySelectorAll('#pageguide-passhistory-menu .pageguide-mode-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.mode === mode);
  });
}

function initPassHistoryToggle() {
  const btn = document.getElementById('pageguide-passhistory-toggle');
  const menu = document.getElementById('pageguide-passhistory-menu');
  if (!btn) return;
  chrome.storage.local.get(GUIDE_PASS_HISTORY_KEY)
    .then(r => _renderPassHistoryMode(btn, _normalizePassHistoryMode(r[GUIDE_PASS_HISTORY_KEY])))
    .catch(() => _renderPassHistoryMode(btn, 'passing'));

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  menu?.addEventListener('click', async (e) => {
    const option = e.target.closest('.pageguide-mode-option');
    if (!option) return;
    e.stopPropagation();
    const mode = _normalizePassHistoryMode(option.dataset.mode);
    try { await chrome.storage.local.set({ [GUIDE_PASS_HISTORY_KEY]: mode }); } catch (err) {}
    _renderPassHistoryMode(btn, mode);
    menu.style.display = 'none';
  });
}

// Visual Recap mode (debug-only): whether to post an end-of-task recap with screenshot
// evidence when the end summary agent is enabled. Stored in chrome.storage.local so the content
// script (guidev2.js) reads the same value. Default ON.
const GUIDE_VISUAL_RECAP_KEY = 'guideVisualRecap';
const GUIDE_END_SUMMARY_KEY = 'guideEndSummaryAgent';

// Visual input mode (debug-only): both modes use the same 5000-element Guide index; Visual On
// also sends a screenshot with matching numbered SoM markers. Default OFF.
const GUIDE_VISUAL_INPUT_KEY = 'guideVisualInput';

function _normalizeVisualInput(v) {
  return v === 'on' ? 'on' : 'off';
}

function _renderVisualInput(btn, val) {
  val = _normalizeVisualInput(val);
  btn.innerHTML = `<span class="pageguide-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 21 21 8"/><path d="M15 3h6v6"/><circle cx="8.5" cy="8.5" r="1.5"/></svg></span>Visual: ${val === 'on' ? 'On' : 'Off'} ▾`;
  btn.title = val === 'on'
    ? 'Guide prompts include a screenshot with up to 5000 numbered SoM markers.'
    : 'Guide prompts are text-only with the same 5000-element PAGE INDEX.';
  document.querySelectorAll('#pageguide-visualinput-menu .pageguide-mode-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.visualinput === val);
  });
}

function initGuideVisualInputToggle() {
  const btn = document.getElementById('pageguide-visualinput-toggle');
  const menu = document.getElementById('pageguide-visualinput-menu');
  if (!btn) return;
  chrome.storage.local.get(GUIDE_VISUAL_INPUT_KEY)
    .then(r => _renderVisualInput(btn, _normalizeVisualInput(r[GUIDE_VISUAL_INPUT_KEY])))
    .catch(() => _renderVisualInput(btn, 'off'));

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  menu?.addEventListener('click', async (e) => {
    const option = e.target.closest('.pageguide-mode-option');
    if (!option) return;
    e.stopPropagation();
    const val = _normalizeVisualInput(option.dataset.visualinput);
    try { await chrome.storage.local.set({ [GUIDE_VISUAL_INPUT_KEY]: val }); } catch (err) {}
    _renderVisualInput(btn, val);
    menu.style.display = 'none';
  });
}

function _normalizeEndSummary(v) {
  return v === 'on' ? 'on' : 'off';
}

function _renderEndSummary(btn, val) {
  val = _normalizeEndSummary(val);
  btn.innerHTML = `<span class="pageguide-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16"/><path d="M4 12h12"/><path d="M4 19h8"/><path d="m17 16 2 2 4-4"/></svg></span>Summary: ${val === 'on' ? 'On' : 'Off'} ▾`;
  btn.title = val === 'on'
    ? 'Run the extra end-of-task summarizer/diagnostic agent.'
    : 'Finish without the extra end summarization call.';
  document.querySelectorAll('#pageguide-summaryagent-menu .pageguide-mode-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.summaryagent === val);
  });
}

function initEndSummaryToggle() {
  const btn = document.getElementById('pageguide-summaryagent-toggle');
  const menu = document.getElementById('pageguide-summaryagent-menu');
  if (!btn) return;
  chrome.storage.local.get(GUIDE_END_SUMMARY_KEY)
    .then(r => _renderEndSummary(btn, _normalizeEndSummary(r[GUIDE_END_SUMMARY_KEY])))
    .catch(() => _renderEndSummary(btn, 'off'));

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  menu?.addEventListener('click', async (e) => {
    const option = e.target.closest('.pageguide-mode-option');
    if (!option) return;
    e.stopPropagation();
    const val = _normalizeEndSummary(option.dataset.summaryagent);
    try { await chrome.storage.local.set({ [GUIDE_END_SUMMARY_KEY]: val }); } catch (err) {}
    _renderEndSummary(btn, val);
    menu.style.display = 'none';
  });
}

function _normalizeRecap(v) {
  return v === 'off' ? 'off' : 'on'; // on is default
}

function _renderRecap(btn, val) {
  val = _normalizeRecap(val);
  btn.innerHTML = `<span class="pageguide-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg></span>Recap: ${val === 'on' ? 'On' : 'Off'} ▾`;
  btn.title = val === 'on'
    ? 'A visual recap with screenshot evidence is posted when a guide task finishes.'
    : 'No recap is posted; the task ends on its final step.';
  document.querySelectorAll('#pageguide-recap-menu .pageguide-mode-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.recap === val);
  });
}

function initVisualRecapToggle() {
  const btn = document.getElementById('pageguide-recap-toggle');
  const menu = document.getElementById('pageguide-recap-menu');
  if (!btn) return;
  chrome.storage.local.get(GUIDE_VISUAL_RECAP_KEY)
    .then(r => _renderRecap(btn, _normalizeRecap(r[GUIDE_VISUAL_RECAP_KEY])))
    .catch(() => _renderRecap(btn, 'on'));

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  menu?.addEventListener('click', async (e) => {
    const option = e.target.closest('.pageguide-mode-option');
    if (!option) return;
    e.stopPropagation();
    const val = _normalizeRecap(option.dataset.recap);
    try { await chrome.storage.local.set({ [GUIDE_VISUAL_RECAP_KEY]: val }); } catch (err) {}
    _renderRecap(btn, val);
    menu.style.display = 'none';
  });
}

// Read the Visual Recap flag for the render path (default ON). Async — resolves the flag
// from chrome.storage.local; used to gate the end-of-task recap message.
async function _panelIsVisualRecapOn() {
  try {
    const r = await chrome.storage.local.get(GUIDE_VISUAL_RECAP_KEY);
    return _normalizeRecap(r[GUIDE_VISUAL_RECAP_KEY]) === 'on';
  } catch (e) {
    return true;
  }
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
  const stopBtn = document.getElementById('pageguide-guide-stop-paused');
  if (btn) btn.disabled = true;
  if (stopBtn) stopBtn.disabled = true;
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
      if (stopBtn) stopBtn.disabled = false;
    }
    addMessage(`Could not resume the guide: ${err.message}`, 'system');
  }
}

async function pauseGuide(message = 'Guide paused.') {
  const btn = document.getElementById('pageguide-guide-pause');
  const stopBtn = document.getElementById('pageguide-guide-stop-paused');
  if (btn) btn.disabled = true;
  if (stopBtn) stopBtn.disabled = true;
  try {
    const res = await sendToContentScript({ action: 'pauseGuide', reason: message });
    if (!res || res.success === false) throw new Error(res?.error || 'Guide not active');
    guidePaused = true;
    guideActive = false;
    hideTyping();
    updateGuidePauseButton();
  } catch (e) {
    if (btn) btn.disabled = false;
    if (stopBtn) stopBtn.disabled = false;
    addMessage(`Could not pause the guide: ${e.message}`, 'system');
  }
}

async function stopPausedGuideWithRecap() {
  const resumeBtn = document.getElementById('pageguide-guide-pause');
  const stopBtn = document.getElementById('pageguide-guide-stop-paused');
  if (resumeBtn) resumeBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = true;
  showTyping();
  try {
    const res = await sendToContentScript({ action: 'stopGuideWithRecap' });
    if (!res || res.success === false) throw new Error(res?.error || 'Could not stop guide');
    guideActive = false;
    guidePaused = false;
    guideStopped = true;
    hideTyping();
    updateGuidePauseButton();
    try { await chrome.storage.session.set({ pageguideGuidanceV2Stopped: Date.now() }); } catch (e) {}
    try { await chrome.storage.session.remove('pageguideGuidanceV2'); } catch (e) {}
    try { chrome.runtime.sendMessage({ action: 'guidanceV2_clearState' }); } catch (e) {}
    if (res.recap && res.recap.summary) {
      await renderGuideRecap(res.recap);
    } else {
      addMessage('⏹ Guide stopped.', 'system');
    }
  } catch (err) {
    hideTyping();
    guideStopped = false;
    if (resumeBtn) resumeBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = false;
    addMessage(`Could not stop the guide: ${err.message}`, 'system');
  }
}

/**
 * Add a guide step message
 */
function addGuideStep(result) {
  const panel = document.getElementById('pageguide-step-panel');
  if (!panel) return;

  if (result?.sessionId && getActiveSessionId() !== result.sessionId) {
    resetLiveGuideTimelineForSession(result.sessionId, { title: currentGoal?.prompt || result.title || result.instruction || '' });
  }
  if (result?.sessionId) currentGuideSessionId = result.sessionId;
  guidePaused = !!result.paused;
  guideActive = !result.isLastStep && !guidePaused;
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

  // Auto mode hides intermediate step cards, but a find/visual_highlight answer IS the deliverable.
  if (result.autoMode && !result.isLastStep && !result.isFind && !result.isVisualHighlight && !result.isWatchVideo) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  const isFinishNotice = !!(result.isFinish || (result.isLastStep && !result.isVisualHighlight && !result.isFind && !result.isWatchVideo));
  const stepBadge = result.isFind ? '🔎 Highlight'
    : (result.isVisualHighlight ? '🖼 Answer' : (result.isWatchVideo ? '▶ Video' : (isFinishNotice ? '' : `Step ${result.step}`)));
  const targetRow = (!isFinishNotice && result.targetText)
    ? `<div class="pageguide-step-meta-row"><span>Target</span><b>${escapeHtml(result.targetText)}</b></div>`
    : '';
  const warning = renderStepWarning(result.step);
  const urlRow = ((result.action === 'goto_url' || result.action === 'navigate') && result.navigateUrl)
    ? `<div class="pageguide-step-meta-row"><span>URL</span><b>${escapeHtml(result.navigateUrl)}</b></div>`
    : (result.isWatchVideo && result.watchVideoUrl)
    ? `<div class="pageguide-step-meta-row"><span>Video</span><b>${escapeHtml(result.watchVideoUrl)}</b></div>`
    : '';

  // A find answer carries [N:"text"] citations and markdown; render them as clickable chips
  // (already escaped by parseMarkdown). visual_highlight shows its caption (the image goes to the
  // chat bubble below). Everything else stays plain escaped text.
  let stepText = '';
  const rawAnswer = result.findAnswer || result.answer || '';
  const isTruncated = false;

  if (result.isFind) {
    stepText = 'I have completed your request. Please see the answer in the chatbox.';
  } else if (result.isWatchVideo) {
    stepText = 'I watched the video. Please see the answer in the chatbox.';
  } else if (result.isFinish && result.finalAnswer) {
    // The full answer lives in the chatbox ANSWER card (with its guaranteed evidence link); the
    // under-timeline box is just a terse pointer so it doesn't duplicate the whole answer.
    stepText = 'I have completed your task. Please see the answer in the chatbox.';
  } else if (result.isLastStep && !result.isVisualHighlight) {
    // Navigate-only / terminal completion: keep the under-timeline status to one quiet line.
    stepText = 'I have completed your task. Please see the answer in the chatbox.';
  } else {
    const displayAnswer = result.isVisualHighlight ? (result.visualHighlightCaption || result.answer || '') : (result.answer || '');
    stepText = escapeHtml(_stripEvidenceRefs(displayAnswer));
  }

  const metaHtml = (targetRow || urlRow)
    ? `<div class="pageguide-step-meta">${targetRow}${urlRow}</div>`
    : '';

  panel.innerHTML = `
    <div class="pageguide-step-card ${isFinishNotice ? 'pageguide-step-card-finish' : ''} ${result.hasHighlights && !isFinishNotice ? 'pageguide-clickable' : ''}">
      <button type="button" class="pageguide-step-collapse" title="Collapse" aria-label="Collapse step panel">✕</button>
      <div class="pageguide-guide-step">
        ${stepBadge ? `<span class="pageguide-step-badge">${escapeHtml(stepBadge)}</span>` : ''}
        <span class="pageguide-step-text">${stepText}</span>
      </div>
      ${metaHtml}
      ${warning}
      <div class="pageguide-step-btn-row"></div>
    </div>
  `;
  panel.style.display = '';

  if (isTruncated) {
    const expandBtn = panel.querySelector('.pageguide-step-expand');
    expandBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const contentSpan = panel.querySelector('.pageguide-step-text-content');
      if (contentSpan) {
        contentSpan.innerHTML = parseCitations(parseMarkdown(rawAnswer));
      }
      expandBtn.style.display = 'none';
    });
  }
  panel.onclick = (e) => {
    if (e.target.closest('button')) return;
    // The messages-container delegate doesn't cover this panel, so handle find's citation
    // chips here: a chip scrolls to its own passage, not to the first highlight.
    const cit = e.target.closest('.pageguide-citation');
    if (cit) {
      e.stopPropagation();
      sendToContentScript({ action: 'scrollToIndex', index: parseInt(cit.dataset.index, 10) });
      return;
    }
    if (result.hasHighlights) sendToContentScript({ action: 'scrollToHighlight' });
  };
  // Collapse (✕) hides the current-step panel in guide mode.
  panel.querySelector('.pageguide-step-collapse')?.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.style.display = 'none';
  });

  // Post the find answer to the chat so it survives collapsing the card or ending the guide.
  // Keyed by step so a re-render of the same step doesn't post it twice.
  if (result.isFind && result.findAnswer && _lastFindMessageStep !== result.step) {
    _lastFindMessageStep = result.step;
    renderFindAnswer(result);
  }

  // visual_highlight: the answer is a cropped screenshot region. parseMarkdown escapes <img>, so
  // render a dedicated assistant bubble (like the recap) rather than addMessage.
  if (result.isVisualHighlight && result.visualHighlightImage && _lastVisualHighlightStep !== result.step) {
    _lastVisualHighlightStep = result.step;
    renderVisualHighlightAnswer(result);
  }

  if (result.isWatchVideo && (result.watchVideoAnswer || result.watchVideoError) && _lastWatchVideoMessageStep !== result.step) {
    _lastWatchVideoMessageStep = result.step;
    renderWatchVideoAnswer(result);
  }

  if (result.isFinish && result.finalAnswer) {
    const answerKey = `${result.sessionId || result.recap?.sessionId || ''}:${result.step}`;
    if (_lastAnswerCardKey !== answerKey) {
      _lastAnswerCardKey = answerKey;
      renderGuideFinalAnswer(result).catch((e) => console.warn('[panel] answer card render failed:', e));
    }
  }

  // Terminal step: post the standalone Task Review recap card (summary + hoverable per-step
  // evidence) once. The working agent always finishes via action="finish" now, so this branch is
  // unreachable for normal completions (they get the unified answer card above, whose Reasoning
  // Trail already surfaces the same per-step evidence). It only still fires for find/visual_highlight
  // terminals, which coerce isLastStep=true without going through finish. The content script only
  // attaches result.recap when the mode is on; re-check the panel toggle too.
  if (result.isLastStep && result.recap && result.recap.summary && !(result.isFinish && result.finalAnswer)) {
    const recapKey = `${result.recap.sessionId || ''}:${result.step}`;
    if (_lastRecapKey !== recapKey) {
      _lastRecapKey = recapKey;
      renderGuideRecap(result.recap);
    }
  }

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

function showTyping(statusText = '') {
  setRunning(true);
  const container = document.getElementById('pageguide-messages');
  if (!container) return;
  const existing = container.querySelector('.pageguide-typing');
  const label = statusText || currentGuideWorkingStatus || (_isGuideWorkingContext() ? 'Agent thinking…' : 'Thinking…');
  if (existing) {
    updateTypingIndicatorText(label);
    container.scrollTop = container.scrollHeight;
    return;
  }

  const typing = document.createElement('div');
  typing.className = 'pageguide-typing';
  typing.innerHTML = '<span class="pageguide-typing-spinner" aria-hidden="true"></span><span class="pageguide-typing-text"></span>';
  typing.querySelector('.pageguide-typing-text').textContent = label;

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
  if (currentGuideStatusTimer) {
    clearTimeout(currentGuideStatusTimer);
    currentGuideStatusTimer = null;
  }
  pendingGuideWorkingStatus = '';
  currentGuideWorkingStatus = '';
  currentGuideStatusShownAt = 0;
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

/** Human-readable byte size for chip labels. */
function _fmtBytes(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Rebuild the unified attachment chip row from the current attachment state
 * (image / text file / selected text). The image chip is static so its wrapper
 * survives region-overlay injection; the file and text chips are rebuilt each
 * call. The whole row hides when nothing is attached.
 */
function renderAttachmentChips() {
  const row = document.getElementById('pageguide-attachment-chips');
  if (!row) return;

  // --- Image chip (static element; toggled, not rebuilt) ---
  const imageChip = document.getElementById('pageguide-image-chip');
  const previewImg = document.getElementById('pageguide-preview-img');
  const nameEl = document.getElementById('pageguide-image-name');
  const metaEl = document.getElementById('pageguide-image-label');
  const wrapper = document.getElementById('pageguide-image-wrapper');
  if (imageChip) {
    if (uploadedImageBase64) {
      if (previewImg && uploadedImageDataUrl) previewImg.src = uploadedImageDataUrl;
      if (nameEl) nameEl.textContent = uploadedImageMeta?.name || 'Pasted image';
      // renderImageRegions() owns the label once regions are found — don't clobber it.
      if (metaEl && !wrapper?.classList.contains('has-regions')) {
        const parts = [];
        if (uploadedImageMeta?.type) parts.push(uploadedImageMeta.type.replace('image/', '').toUpperCase());
        if (uploadedImageMeta?.size) parts.push(_fmtBytes(uploadedImageMeta.size));
        metaEl.textContent = parts.length ? parts.join(' · ') : '📷 Ready — ask about it';
      }
      imageChip.style.display = 'flex';
    } else {
      imageChip.style.display = 'none';
    }
  }

  // --- Dynamic chips: clear then rebuild file + selected-text ---
  row.querySelectorAll('[data-chip-dynamic]').forEach(el => el.remove());

  if (uploadedFileContent != null) {
    const chip = document.createElement('div');
    chip.className = 'pageguide-attachment-chip pageguide-chip-file';
    chip.setAttribute('data-chip-dynamic', 'file');
    const metaParts = [];
    if (uploadedFileSize) metaParts.push(_fmtBytes(uploadedFileSize));
    chip.innerHTML = `
      <span class="pageguide-chip-icon">📎</span>
      <div class="pageguide-chip-info">
        <span class="pageguide-chip-name">${escapeHtml(uploadedFileName || 'File')}</span>
        <span class="pageguide-chip-meta">${escapeHtml(metaParts.join(' · ') || 'Text file')}</span>
      </div>
      <button class="pageguide-remove-image" data-chip-remove="file" title="Remove file">✕</button>`;
    row.appendChild(chip);
  }

  if (currentSelectedText) {
    const chip = document.createElement('div');
    chip.className = 'pageguide-attachment-chip pageguide-chip-text';
    chip.setAttribute('data-chip-dynamic', 'text');
    const wordCount = currentSelectedText.split(/\s+/).filter(w => w.length > 0).length;
    const snippet = currentSelectedText.length > 60
      ? currentSelectedText.slice(0, 60) + '…'
      : currentSelectedText;
    chip.innerHTML = `
      <span class="pageguide-chip-icon">${UI_ICONS.quote || '✎'}</span>
      <div class="pageguide-chip-info">
        <span class="pageguide-chip-name">Selected text</span>
        <span class="pageguide-chip-meta" title="${escapeHtml(currentSelectedText)}">“${escapeHtml(snippet)}” · ${wordCount}w</span>
      </div>
      <button class="pageguide-remove-image" data-chip-remove="text" title="Clear selection context">✕</button>`;
    row.appendChild(chip);
  }

  const anyVisible = !!uploadedImageBase64 || uploadedFileContent != null || !!currentSelectedText;
  row.style.display = anyVisible ? 'flex' : 'none';
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
          uploadedImageDataUrl = base64;
          uploadedImageMeta = { name: 'Pasted image', type: file.type, size: file.size };

          const uploadLabel = document.getElementById('pageguide-upload-label');

          // Render the chip row (image chip becomes visible)
          renderAttachmentChips();

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

          addMessage('📋 Image pasted! Ask me about it or to find it on the page.', 'system');
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
      uploadedImageDataUrl = base64;
      uploadedImageMeta = { name: file.name, type: file.type, size: file.size };

      const uploadLabel = document.getElementById('pageguide-upload-label');

      // Render the chip row (image chip becomes visible)
      renderAttachmentChips();

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

      addMessage('📷 Image uploaded! Ask me about it or to find it on the page.', 'system');
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
  uploadedImageDataUrl = null;
  uploadedImageMeta = null;

  // Clear region overlays before the chip re-renders
  const wrapper = document.getElementById('pageguide-image-wrapper');
  const uploadLabel = document.getElementById('pageguide-upload-label');
  const input = document.getElementById('pageguide-input');
  const fileInput = document.getElementById('pageguide-image-upload');
  const label = document.getElementById('pageguide-image-label');

  if (wrapper) {
    wrapper.classList.remove('has-regions');
    wrapper.querySelectorAll('.pageguide-image-region').forEach(el => el.remove());
  }
  if (label) label.textContent = '📷 Ready — ask about it';
  if (uploadLabel) uploadLabel.classList.remove('has-image');
  _setUploadIcon('📎');
  if (input) input.placeholder = 'Ask anything...';
  if (fileInput) fileInput.value = '';
  renderAttachmentChips();

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
    uploadedFileSize = file.size;

    const uploadLabel = document.getElementById('pageguide-upload-label');
    const input = document.getElementById('pageguide-input');

    renderAttachmentChips();
    if (uploadLabel) uploadLabel.classList.add('has-image');
    _setUploadIcon('📎');
    if (input) input.placeholder = `Ask about ${file.name}…`;

    // Forward the file text to the content script so a guide session can ingest it.
    try {
      await sendToContentScript({
        action: 'setUploadedFile',
        fileText: uploadedFileContent,
        fileName: uploadedFileName
      });
    } catch (err) {
      console.warn('📎 Could not send file to content script:', err);
    }

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
  uploadedFileSize = null;

  const uploadLabel = document.getElementById('pageguide-upload-label');
  const input = document.getElementById('pageguide-input');
  const fileInput = document.getElementById('pageguide-image-upload');

  if (uploadLabel) uploadLabel.classList.remove('has-image');
  _setUploadIcon('📎');
  if (input) input.placeholder = 'Ask anything…';
  if (fileInput) fileInput.value = '';
  renderAttachmentChips();

  // Clear from content script
  try {
    sendToContentScript({ action: 'clearUploadedFile' });
  } catch (err) {
    console.warn('📎 Could not clear file in content script:', err);
  }

  addMessage('🗑️ File removed', 'system');
}

/**
 * Clear the selected text
 */
function clearSelectedText() {
  currentSelectedText = null;
  renderAttachmentChips();
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

  // If a text file is attached or text is selected, build an augmented query.
  // The original user-visible message stays clean; the enriched version goes to the LLM.
  //   • effectiveQuery — full context (file + selection); used by ask/pdf/restricted paths.
  //   • guideQuery     — omits the file, because a guide session ingests the file ONCE
  //                      (summarized) instead of re-embedding it in every step's question.
  let effectiveQuery = activeQuery;
  let guideQuery = activeQuery;

  if (uploadedFileContent || currentSelectedText) {
    const parts = [];
    const guideParts = [];

    if (uploadedFileContent) {
      const MAX_FILE_CHARS = 40000;
      const snippet = uploadedFileContent.length > MAX_FILE_CHARS
        ? uploadedFileContent.slice(0, MAX_FILE_CHARS) + '\n… [truncated]'
        : uploadedFileContent;
      parts.push(`[Attached file: ${uploadedFileName}]\n---\n${snippet}\n---`);
      // guideParts intentionally omits the file — delivered via ingestion.
    }

    if (currentSelectedText) {
      const MAX_SELECTION_CHARS = 20000;
      const selectionSnippet = currentSelectedText.length > MAX_SELECTION_CHARS
        ? currentSelectedText.slice(0, MAX_SELECTION_CHARS) + '\n… [truncated]'
        : currentSelectedText;
      const block = `[Selected text from page]\n---\n${selectionSnippet}\n---`;
      parts.push(block);
      guideParts.push(block); // selection is small — keep it inline for the guide
    }

    const compose = (ps) => {
      if (!ps.length) return activeQuery;
      return activeQuery
        ? `${ps.join('\n\n')}\n\nUser question: ${activeQuery}`
        : `${ps.join('\n\n')}\n\nPlease analyze or explain the provided content.`;
    };
    effectiveQuery = compose(parts);
    guideQuery = compose(guideParts);
  } else if (forcedRoute) {
    // If no context was attached, just use the stripped query
    effectiveQuery = activeQuery;
    guideQuery = activeQuery;
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
      // Restricted page - cannot run content scripts directly.
      let route = forcedRoute;
      if (!route) {
        try {
          const routerResponse = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
              action: 'callLLM',
              systemPrompt: PROMPTS.ROUTER,
              messages: [{ role: 'user', content: effectiveQuery }],
              metadata: {
                mode: 'ask_panel_restricted_route',
                url: currentTab?.url || ''
              }
            }, (res) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(res);
            });
          });
          const cleanRoute = (routerResponse?.content || '').trim().replace(/```json|```/g, '').trim();
          const routeJson = JSON.parse(cleanRoute);
          route = routeJson.route;
        } catch (e) {
          route = 'ask';
        }
      }

      if (route === 'guide') {
        console.log('🛡️ Restricted page in Guide mode. Generating initial step directly from panel.');
        const systemPrompt = PROMPTS.GUIDE_V2_PROMPT;
        const userPrompt = `PAGE BACKGROUND: LIGHT
CURRENT URL: ${currentTab.url}
VISUAL SCREENSHOT PROVIDED: no

=== PAGE INDEX ===
(No elements indexed - restricted browser page)

=== USER GOAL ===
${effectiveQuery}

=== CURRENT STEP ===
Step 1
Previous steps: None`;

        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'callLLM',
            systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
            metadata: {
              mode: 'guide_restricted_init',
              url: currentTab.url
            }
          }, (res) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(res);
          });
        });

        if (response && !response.error) {
          const content = response.content?.trim() || '';
          try {
            const cleanJson = content.replace(/```json|```/g, '').trim();
            const step = JSON.parse(cleanJson);
            let normalizedAction = String(step.action || '').toLowerCase().replace(/[\s-]+/g, '_');
            if (normalizedAction === 'navigate' || normalizedAction === 'go_to_url' || normalizedAction === 'open_url') normalizedAction = 'goto_url';
            const targetUrl = step.url;

            if (normalizedAction === 'goto_url' && targetUrl) {
              const sessionId = 'gv2-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
              const autoModeResult = await chrome.storage.local.get([GUIDE_AUTO_MODE_KEY, GUIDE_AUTONOMY_LEVEL_KEY]);
              const autonomyLevel = _normalizeGuideAutonomyMode(autoModeResult[GUIDE_AUTONOMY_LEVEL_KEY], autoModeResult[GUIDE_AUTO_MODE_KEY] === true);
              const autoMode = autonomyLevel !== 'manual';
              
              let screenshotBefore = null;
              try {
                const capResponse = await new Promise((resolve) => {
                  chrome.runtime.sendMessage({ action: 'captureScreenshot' }, resolve);
                });
                if (capResponse && capResponse.success) {
                  screenshotBefore = capResponse.imageBase64;
                }
              } catch (err) {
                console.warn('Failed to capture initial screenshot:', err);
              }

              if (typeof rewindStartSession === 'function') {
                await rewindStartSession(sessionId, effectiveQuery);
              }

              const initialRecord = {
                sessionId,
                step: 0,
                planStep: 0,
                timestamp: Date.now(),
                url: currentTab.url,
                title: currentTab.title || 'New Tab',
                instruction: 'Initial state',
                action: null,
                isInitial: true,
                isLastStep: false,
                target: null,
                confidence: null,
                durationMs: 0,
                screenshot: screenshotBefore || null,
                screenshotBefore: screenshotBefore || null,
                domSnapshot: '',
                restore: null,
                rawLlmJson: '',
                systemPrompt: '',
                userPrompt: ''
              };
              if (typeof rewindPutRecord === 'function') {
                await rewindPutRecord(initialRecord);
              }

              const stepRecord = {
                sessionId,
                step: 1,
                planStep: 1,
                timestamp: Date.now(),
                url: currentTab.url,
                title: currentTab.title || 'New Tab',
                instruction: step.instruction || `Navigate to ${targetUrl}`,
                action: 'goto_url',
                navigateUrl: targetUrl,
                isLastStep: false,
                target: null,
                confidence: 1.0,
                durationMs: 0,
                screenshot: screenshotBefore || null,
                screenshotBefore: screenshotBefore || null,
                domSnapshot: '',
                restore: null,
                rawLlmJson: JSON.stringify(step),
                systemPrompt,
                userPrompt
              };
              if (typeof rewindPutRecord === 'function') {
                await rewindPutRecord(stepRecord);
              }

              try {
                chrome.runtime.sendMessage({
                  action: 'guideStepRecord',
                  meta: {
                    sessionId,
                    step: 0,
                    planStep: 0,
                    instruction: 'Initial state',
                    isInitial: true,
                    url: currentTab.url,
                    title: currentTab.title || 'New Tab',
                    timestamp: Date.now(),
                    hasShot: !!screenshotBefore
                  }
                });

                chrome.runtime.sendMessage({
                  action: 'guideStepRecord',
                  meta: {
                    sessionId,
                    step: 1,
                    planStep: 1,
                    instruction: step.instruction || `Navigate to ${targetUrl}`,
                    url: currentTab.url,
                    title: currentTab.title || 'New Tab',
                    timestamp: Date.now(),
                    action: 'goto_url',
                    navigateUrl: targetUrl,
                    hasShot: !!screenshotBefore
                  }
                });
              } catch (e) {
                console.warn('Failed to emit initial step records:', e);
              }

              const state = {
                active: true,
                question: effectiveQuery,
                previousSteps: [`Step 1: Navigate to ${targetUrl}`],
                sessionId,
                captureEnabled: true,
                autoMode: autoMode,
                autonomyLevel,
                currentPlanStep: 1,
                pendingResume: true,
                timestamp: Date.now()
              };

              await chrome.storage.session.set({ pageguideGuidanceV2: state });
              try {
                await new Promise((resolve) => {
                  chrome.runtime.sendMessage({
                    action: 'guidanceV2_setState',
                    state: state,
                    tabId: currentTab.id
                  }, resolve);
                });
              } catch (err) {
                console.warn('Failed to set SW state:', err);
              }
              chrome.tabs.update(currentTab.id, { url: targetUrl });

              result = {
                success: true,
                isGuide: true,
                autoMode: autoMode,
                autonomyLevel,
                answer: step.instruction || `Navigating to ${targetUrl}`,
                action: 'goto_url',
                navigateUrl: targetUrl,
                step: 1,
                isLastStep: false
              };
            } else {
              result = {
                success: true,
                isGuide: true,
                autoMode: autoMode,
                autonomyLevel,
                answer: step.instruction || 'Please navigate to the target site.',
                action: step.action || 'done',
                step: 1,
                isLastStep: step.isLastStep || false
              };
            }
          } catch (e) {
            console.error('Failed to parse Guide step JSON:', e);
            throw new Error('Guide generation failed: invalid response schema');
          }
        } else {
          throw new Error(response?.error || 'Failed to call LLM');
        }
      } else {
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
      }
    } else {
      // Normal routing via content script
      // Pass hasImage flag so router knows if image_ask is valid
      result = await sendToContentScript({
        action: 'handleQuery',
        query: effectiveQuery,
        cleanQuery: guideQuery, // guide route uses this (file kept out; delivered via ingestion)
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
    visibleJourneyRecalled,
    currentGuideSessionId,
    activeGuideRecords: [...currentGuideRecords],
    activeGuideInitial: currentGuideInitial,
    activeGuidePlan: [...currentGuidePlan],
    activeGuideStep: currentGuideStep,
    activeSessionId: typeof RewindTimeline !== 'undefined' && typeof RewindTimeline.getSessionId === 'function' ? RewindTimeline.getSessionId() : null,
    currentGoal: currentGoal,
    currentGuideTitle: currentGuideTitle,
    guidePaused: guidePaused
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

  // Clear attachment UI (blobs aren't saved in the session)
  uploadedImageBase64 = null;
  uploadedImageDataUrl = null;
  uploadedImageMeta = null;
  uploadedFileContent = null;
  uploadedFileName = null;
  uploadedFileSize = null;
  const uploadLabel = document.getElementById('pageguide-upload-label');
  const fileInput = document.getElementById('pageguide-image-upload');
  if (uploadLabel) uploadLabel.classList.remove('has-image');
  if (fileInput) fileInput.value = '';
  renderAttachmentChips();

  visibleJourneySessionId = session.visibleJourneySessionId || null;
  visibleJourneyTitle = session.visibleJourneyTitle || '';
  visibleJourneyRecalled = !!session.visibleJourneyRecalled;
  currentGuideSessionId = session.currentGuideSessionId || null;
  if (visibleJourneyRecalled && visibleJourneySessionId) {
    showStoredJourney(visibleJourneySessionId);
  } else {
    clearGoalAndStepPanel();
    if (session.activeSessionId && session.activeGuideRecords && typeof RewindTimeline !== 'undefined') {
      currentGuideSessionId = session.currentGuideSessionId || session.activeSessionId || null;
      currentGuideRecords = [...session.activeGuideRecords];
      currentGuideInitial = session.activeGuideInitial;
      currentGuidePlan = session.activeGuidePlan ? [...session.activeGuidePlan] : [];
      currentGuideStep = session.activeGuideStep || 0;
      currentGoal = session.currentGoal || null;
      currentGuideTitle = session.currentGuideTitle || '';
      guidePaused = session.guidePaused || false;
      
      RewindTimeline.clear();
      if (currentGuideInitial) RewindTimeline.addStep(currentGuideInitial);
      for (const rec of currentGuideRecords) {
        RewindTimeline.addStep(rec);
      }
      if (currentGuidePlan.length > 0) RewindTimeline.setPlan(currentGuidePlan);
      
      if (currentGoal) {
        renderGoalCard({ route: 'guide', step: currentGuideStep, title: currentGuideTitle });
      }
      updateGuidePauseButton();
    }
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

  // Clear all attachment state (image, file, selected text)
  uploadedImageBase64 = null;
  uploadedImageDataUrl = null;
  uploadedImageMeta = null;
  uploadedFileContent = null;
  uploadedFileName = null;
  uploadedFileSize = null;
  currentSelectedText = null;
  const uploadLabel = document.getElementById('pageguide-upload-label');
  const input = document.getElementById('pageguide-input');
  const fileInput = document.getElementById('pageguide-image-upload');
  const wrapper = document.getElementById('pageguide-image-wrapper');

  if (wrapper) {
    wrapper.classList.remove('has-regions');
    wrapper.querySelectorAll('.pageguide-image-region').forEach(el => el.remove());
  }
  if (uploadLabel) uploadLabel.classList.remove('has-image');
  if (input) input.placeholder = 'Ask anything...';
  if (fileInput) fileInput.value = '';
  renderAttachmentChips();

  try {
    await sendToContentScript({ action: 'clearUploadedImage' });
    await sendToContentScript({ action: 'clearUploadedFile' });
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
  const confSourceVal = localSettings.guideConfidenceSource || 'mechanical';
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
  } else if (message.action === 'guidePlan') {
    _setJourneyRecalledMode(false);
    if (message.sessionId) {
      resetLiveGuideTimelineForSession(message.sessionId, { title: message.title || currentGoal?.prompt || '', plan: message.plan });
    }
    currentGuidePlan = Array.isArray(message.plan) ? message.plan : [];
    currentGuideTitle = message.title || currentGuideTitle;
    if (message.sessionId) {
      const j = _journeysBySession[message.sessionId] || (_journeysBySession[message.sessionId] = { title: '', steps: [] });
      j.title = message.title || j.title || currentGoal?.prompt || '';
      j.plan = currentGuidePlan;
    }
    renderGoalCard({ route: 'guide', title: currentGuideTitle, step: currentGuideStep || 1 });
  } else if (message.action === 'guidePaused') {
    guideStopped = false;
    hideTyping();
    addGuidePausedMessage(message.reason);
  } else if (message.action === 'guideStepRecord') {
    if (message.meta && (message.meta.isInitial || Number(message.meta.step) === 0)) {
      // Initial-state node (step 0): tracked separately so it never inflates the step/dot count,
      // but still accumulated into the session journey so "View journey" can show it later.
      if (message.meta.sessionId && getActiveSessionId() !== message.meta.sessionId) {
        resetLiveGuideTimelineForSession(message.meta.sessionId, { title: currentGoal?.prompt || message.meta.title || '' });
      }
      if (message.meta.sessionId) currentGuideSessionId = message.meta.sessionId;
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
          resetLiveGuideTimelineForSession(liveSessionId, { title: currentGoal?.prompt || message.meta.title || message.meta.instruction || '' });
          await loadSessionSteps(liveSessionId);
        }
        if (liveSessionId) currentGuideSessionId = liveSessionId;
        _setJourneyRecalledMode(false); // a live step is arriving — leave recalled view
        const existing = currentGuideRecords.findIndex(r => Number(r.step) === Number(message.meta.step));
        if (existing >= 0) currentGuideRecords[existing] = Object.assign({}, currentGuideRecords[existing], message.meta);
        else currentGuideRecords.push(message.meta);
        currentGuideRecords.sort((a, b) => Number(a.step) - Number(b.step));
        currentGuideStep = message.meta.step || currentGuideStep;
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
  } else if (message.action === 'guideWorkingStatus') {
    setGuideWorkingStatus(message.status || '');
  } else if (message.action === 'addMessage') {
    if (isGuideParseError(message.content)) {
      addGuideRetryMessage(message.content);
    } else {
      addMessage(message.content, message.type, message.clickable);
    }
  } else if (message.action === 'guideFinalState') {
    renderGuideFinalStateCard(message);
  } else if (message.action === 'guideRecap') {
    // Full diagnostic recap for a failed run (e.g. hit the step cap). Content only sends this when
    // Visual Recap is on, so render it directly.
    if (message.recap) renderGuideRecap(message.recap);
  } else if (message.action === 'closePanel') {
    window.close();
  } else if (message.action === 'selectedText') {
    // Handle text selection passed from the content script
    if (message.text && message.text.length > 0) {
      currentSelectedText = message.text;
      renderAttachmentChips();
    } else if (currentSelectedText) {
      // Clear selection only if they selected empty space on purpose
      // (content script might just send empty text when clicking around)
      // To not frustrate users, we only hide it when explicitly empty string.
      if (message.text === '') {
        currentSelectedText = null;
        renderAttachmentChips();
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
      const rec = currentGuideRecords.find(r => Number(r.step) === Number(stepInfo.data.metadata?.step)) || {};
      const promptData = {
        ...stepInfo.data,
        verifyResult: (rec.verifyResultSystemPrompt || rec.verifyResultUserPrompt || rec.verifyResultRawResponse || rec.verifyResultShot) ? {
          systemPrompt: rec.verifyResultSystemPrompt || '',
          userPrompt: rec.verifyResultUserPrompt || '',
          rawResponse: rec.verifyResultRawResponse || '',
          screenshot: rec.verifyResultShot || null,
          action: rec.verifyResultAction || '',
          scrollY: rec.verifyResultScrollY,
          error: rec.verifyResultError || ''
        } : null,
        findSystemPrompt: rec.findSystemPrompt || '',
        findUserPrompt: rec.findUserPrompt || '',
        findRawResponse: rec.findRawResponse || '',
        visualFallbackSystemPrompt: rec.visualFallbackSystemPrompt || '',
        visualFallbackUserPrompt: rec.visualFallbackUserPrompt || '',
        visualFallbackRawResponse: rec.visualFallbackRawResponse || '',
        visualFallbackShot: rec.visualFallbackShot || null,
      };
      renderPromptDetails(promptData);
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
              },
              verifyResult: (rec.verifyResultSystemPrompt || rec.verifyResultUserPrompt || rec.verifyResultRawResponse || rec.verifyResultShot) ? {
                systemPrompt: rec.verifyResultSystemPrompt || '',
                userPrompt: rec.verifyResultUserPrompt || '',
                rawResponse: rec.verifyResultRawResponse || '',
                screenshot: rec.verifyResultShot || null,
                action: rec.verifyResultAction || '',
                scrollY: rec.verifyResultScrollY,
                error: rec.verifyResultError || ''
              } : null,
              finalVerify: (rec.finalVerifySystemPrompt || rec.finalVerifyUserPrompt || rec.finalVerifyResponse || rec.finalShot) ? {
                systemPrompt: rec.finalVerifySystemPrompt || '',
                userPrompt: rec.finalVerifyUserPrompt || '',
                rawResponse: rec.finalVerifyResponse || '',
                screenshot: rec.finalShot || null,
                verdict: rec.finalVerdict || ''
              } : null,
              findSystemPrompt: rec.findSystemPrompt || '',
              findUserPrompt: rec.findUserPrompt || '',
              findRawResponse: rec.findRawResponse || '',
              visualFallbackSystemPrompt: rec.visualFallbackSystemPrompt || '',
              visualFallbackUserPrompt: rec.visualFallbackUserPrompt || '',
              visualFallbackRawResponse: rec.visualFallbackRawResponse || '',
              visualFallbackShot: rec.visualFallbackShot || null,
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

    if (p.verifyResult) {
      const v = p.verifyResult;
      const vsrc = v.screenshot ? (v.screenshot.startsWith('data:') ? v.screenshot : `data:image/jpeg;base64,${v.screenshot}`) : '';
      html += `
        <details open style="margin-top: 0; display: block; border: 1px solid var(--pg-border); border-radius: 8px; padding: 8px; background: var(--pg-card);">
          <summary style="font-weight: 700; cursor: pointer; padding: 4px; color: var(--pg-accent); outline: none;">Verify Result (Mid-journey)</summary>
          <div style="margin-top: 6px; display: grid; gap: 8px;">
            <div style="font-size: 12px; color: var(--pg-muted);">Action: ${escapeHtml(v.action || 'terminal')} · Scroll Y: ${escapeHtml(String(v.scrollY ?? 'unknown'))}${v.error ? ` · Error: ${escapeHtml(v.error)}` : ''}</div>
            <div>
              <div style="font-weight: 700; color: var(--pg-text); margin-bottom: 4px;">System prompt sent to verification LLM</div>
              <pre style="white-space: pre-wrap; word-break: break-word; background: var(--pg-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--pg-border); max-height: 20vh; overflow-y: auto; color: var(--pg-text);">${escapeHtml(v.systemPrompt || '(none)')}</pre>
            </div>
            <div>
              <div style="font-weight: 700; color: var(--pg-text); margin-bottom: 4px;">User/Page prompt sent to verification LLM</div>
              <pre style="white-space: pre-wrap; word-break: break-word; background: var(--pg-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--pg-border); max-height: 20vh; overflow-y: auto; color: var(--pg-text);">${escapeHtml(v.userPrompt || '(none)')}</pre>
            </div>
            ${vsrc ? `<div><div style="font-weight: 700; color: var(--pg-text); margin-bottom: 4px;">Screenshot sent to verification LLM</div><img src="${vsrc}" style="max-width: 100%; max-height: 250px; border-radius: 4px; border: 1px solid var(--pg-border); object-fit: contain; cursor: pointer;" onclick="window.open('${vsrc}')" /></div>` : ''}
            <div>
              <div style="font-weight: 700; color: var(--pg-text); margin-bottom: 4px;">Raw verification LLM response</div>
              <pre style="white-space: pre-wrap; word-break: break-word; background: var(--pg-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--pg-border); max-height: 20vh; overflow-y: auto; color: var(--pg-text);">${escapeHtml(v.rawResponse || '(none)')}</pre>
            </div>
          </div>
        </details>
      `;
    }

    if (p.finalVerify) {
      const v = p.finalVerify;
      const vsrc = v.screenshot ? (v.screenshot.startsWith('data:') ? v.screenshot : `data:image/jpeg;base64,${v.screenshot}`) : '';
      html += `
        <details open style="margin-top: 0; display: block; border: 1px solid var(--pg-border); border-radius: 8px; padding: 8px; background: var(--pg-card);">
          <summary style="font-weight: 700; cursor: pointer; padding: 4px; color: var(--pg-accent); outline: none;">Final Verify Result</summary>
          <div style="margin-top: 6px; display: grid; gap: 8px;">
            <div style="font-size: 12px; color: var(--pg-muted);">Verdict: ${escapeHtml(v.verdict || 'unclear')}</div>
            <div>
              <div style="font-weight: 700; color: var(--pg-text); margin-bottom: 4px;">System prompt sent to final verification LLM</div>
              <pre style="white-space: pre-wrap; word-break: break-word; background: var(--pg-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--pg-border); max-height: 20vh; overflow-y: auto; color: var(--pg-text);">${escapeHtml(v.systemPrompt || '(none)')}</pre>
            </div>
            <div>
              <div style="font-weight: 700; color: var(--pg-text); margin-bottom: 4px;">User/Page prompt sent to final verification LLM</div>
              <pre style="white-space: pre-wrap; word-break: break-word; background: var(--pg-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--pg-border); max-height: 20vh; overflow-y: auto; color: var(--pg-text);">${escapeHtml(v.userPrompt || '(none)')}</pre>
            </div>
            ${vsrc ? `<div><div style="font-weight: 700; color: var(--pg-text); margin-bottom: 4px;">Screenshot sent to final verification LLM</div><img src="${vsrc}" style="max-width: 100%; max-height: 250px; border-radius: 4px; border: 1px solid var(--pg-border); object-fit: contain; cursor: pointer;" onclick="window.open('${vsrc}')" /></div>` : ''}
            <div>
              <div style="font-weight: 700; color: var(--pg-text); margin-bottom: 4px;">Raw final verification LLM response</div>
              <pre style="white-space: pre-wrap; word-break: break-word; background: var(--pg-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--pg-border); max-height: 20vh; overflow-y: auto; color: var(--pg-text);">${escapeHtml(v.rawResponse || '(none)')}</pre>
            </div>
          </div>
        </details>
      `;
    }

    if (p.findSystemPrompt || p.findUserPrompt || p.findRawResponse) {
      html += `
        <details open style="margin-top: 12px; display: block; border: 1px solid var(--pg-border); border-radius: 8px; padding: 8px; background: var(--pg-card);">
          <summary style="font-weight: 700; cursor: pointer; padding: 4px; color: var(--pg-accent); outline: none;">Highlight Reader Pass Details</summary>
          <div style="margin-top: 6px; display: grid; gap: 8px;">
            <div>
              <div style="font-weight: 700; color: var(--pg-text); margin-bottom: 4px;">System prompt sent to Highlight reader</div>
              <pre style="white-space: pre-wrap; word-break: break-word; background: var(--pg-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--pg-border); max-height: 20vh; overflow-y: auto; color: var(--pg-text);">${escapeHtml(p.findSystemPrompt || '(none)')}</pre>
            </div>
            <div>
              <div style="font-weight: 700; color: var(--pg-text); margin-bottom: 4px;">User prompt sent to Highlight reader</div>
              <pre style="white-space: pre-wrap; word-break: break-word; background: var(--pg-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--pg-border); max-height: 20vh; overflow-y: auto; color: var(--pg-text);">${escapeHtml(p.findUserPrompt || '(none)')}</pre>
            </div>
            <div>
              <div style="font-weight: 700; color: var(--pg-text); margin-bottom: 4px;">Raw Highlight reader response</div>
              <pre style="white-space: pre-wrap; word-break: break-word; background: var(--pg-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--pg-border); max-height: 20vh; overflow-y: auto; color: var(--pg-text);">${escapeHtml(p.findRawResponse || '(none)')}</pre>
            </div>
          </div>
        </details>
      `;
    }

    if (p.visualFallbackSystemPrompt || p.visualFallbackUserPrompt || p.visualFallbackRawResponse || p.visualFallbackShot) {
      const fsrc = p.visualFallbackShot ? (p.visualFallbackShot.startsWith('data:') ? p.visualFallbackShot : `data:image/jpeg;base64,${p.visualFallbackShot}`) : '';
      html += `
        <details open style="margin-top: 12px; display: block; border: 1px solid var(--pg-border); border-radius: 8px; padding: 8px; background: var(--pg-card);">
          <summary style="font-weight: 700; cursor: pointer; padding: 4px; color: var(--pg-accent); outline: none;">Visual Fallback Reader Details</summary>
          <div style="margin-top: 6px; display: grid; gap: 8px;">
            <div>
              <div style="font-weight: 700; color: var(--pg-text); margin-bottom: 4px;">System prompt sent to Visual fallback reader</div>
              <pre style="white-space: pre-wrap; word-break: break-word; background: var(--pg-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--pg-border); max-height: 20vh; overflow-y: auto; color: var(--pg-text);">${escapeHtml(p.visualFallbackSystemPrompt || '(none)')}</pre>
            </div>
            <div>
              <div style="font-weight: 700; color: var(--pg-text); margin-bottom: 4px;">User prompt sent to Visual fallback reader</div>
              <pre style="white-space: pre-wrap; word-break: break-word; background: var(--pg-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--pg-border); max-height: 20vh; overflow-y: auto; color: var(--pg-text);">${escapeHtml(p.visualFallbackUserPrompt || '(none)')}</pre>
            </div>
            ${fsrc ? `<div><div style="font-weight: 700; color: var(--pg-text); margin-bottom: 4px;">Screenshot (with SoM) sent to Visual fallback reader</div><img src="${fsrc}" style="max-width: 100%; max-height: 250px; border-radius: 4px; border: 1px solid var(--pg-border); object-fit: contain; cursor: pointer;" onclick="window.open('${fsrc}')" /></div>` : ''}
            <div>
              <div style="font-weight: 700; color: var(--pg-text); margin-bottom: 4px;">Raw Visual fallback reader response</div>
              <pre style="white-space: pre-wrap; word-break: break-word; background: var(--pg-bg); padding: 8px; border-radius: 6px; border: 1px solid var(--pg-border); max-height: 20vh; overflow-y: auto; color: var(--pg-text);">${escapeHtml(p.visualFallbackRawResponse || '(none)')}</pre>
            </div>
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

function updateDebugButtonVisibility(enabled, alwaysShowPromptBtn = false) {
  // Publish a global flag so other in-panel modules (e.g. the rewind inspector) can show
  // debug-only details like the confidence breakdown without re-reading storage.
  window.__pgDebugEnabled = !!enabled;
  const btn = document.getElementById('pageguide-debug-prompt-btn');
  if (btn) {
    btn.style.display = (enabled || alwaysShowPromptBtn) ? 'inline-flex' : 'none';
  }
  const visualInputWrap = document.querySelector('.pageguide-visualinput-wrap');
  if (visualInputWrap) {
    visualInputWrap.style.display = enabled ? '' : 'none';
  }
  const summaryAgentWrap = document.querySelector('.pageguide-summaryagent-wrap');
  if (summaryAgentWrap) {
    summaryAgentWrap.style.display = enabled ? '' : 'none';
  }
  const recapWrap = document.querySelector('.pageguide-recap-wrap');
  if (recapWrap) {
    recapWrap.style.display = enabled ? '' : 'none';
  }
}
