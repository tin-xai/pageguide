// XWebAgent Content Script - Main Entry Point
// Initializes the extension and handles message routing

// Prevent double-loading
if (!window._xwebagentLoaded) {
  window._xwebagentLoaded = true;
  console.log('🤖 XWebAgent loaded');

  // ===== Message Handler =====
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleMessage(request)
      .then(sendResponse)
      .catch(err => {
        console.error('🤖 Message handler error:', err);
        sendResponse({ success: false, error: err.message || 'Unknown error' });
      });
    return true;
  });

  // Auto-inject study click-to-hide UI if the study set the flag before navigating here
  chrome.storage.local.get('studyHideControl', (data) => {
    if (data.studyHideControl && data.studyHideControl.active) {
      setTimeout(() => _injectStudyHideControl(data.studyHideControl.criteria), 700);
    }
  });
}

async function handleMessage(request) {
  switch (request.action) {
    case 'handleQuery':
      if (typeof handleSmartQuery === 'function') {
        return await handleSmartQuery(
          request.query, 
          request.history || [],
          request.hasImage || false,
          request.hasImageInHistory || false,
          request.forcedRoute || null
        );
      }
      return { success: false, error: 'Query handler not loaded' };
    
    case 'reset':
      if (typeof resetCustomStyles === 'function') resetCustomStyles();
      if (typeof clearMarkings === 'function') clearMarkings();
      if (typeof clearHighlights === 'function') clearHighlights();
      if (typeof clearPdfHighlights === 'function') clearPdfHighlights();
      if (typeof clearGuidanceState === 'function') clearGuidanceState();
      // Also reset in-memory guidance state
      if (window._xwebagentGuidance) {
        window._xwebagentGuidance.active = false;
        window._xwebagentGuidance.question = '';
        window._xwebagentGuidance.currentStep = 0;
        window._xwebagentGuidance.previousSteps = [];
        window._xwebagentGuidance.waitingForAction = null;
      }
      // Reset guidev2 state
      if (typeof gv2StopGuide === 'function') gv2StopGuide();
      else if (window._guidev2) window._guidev2.active = false;
      // Stop auto-hide session
      if (typeof stopAutoHide === 'function') stopAutoHide();
      // Clear uploaded image
      if (typeof clearUploadedImage === 'function') clearUploadedImage();
      return { success: true };
    
    case 'scrollToHighlight':
      if (typeof scrollToHighlight === 'function') scrollToHighlight(0);
      return { success: true };
    
    case 'scrollToIndex':
      if (typeof scrollToIndex === 'function') {
        const scrolled = scrollToIndex(request.index);
        return { success: scrolled };
      }
      return { success: false, error: 'Scroll function not loaded' };
    
    case 'navigateToPdfPage':
      if (typeof navigateToPdfPage === 'function') {
        const navigated = await navigateToPdfPage(request.page, request.searchText);
        return { success: navigated };
      }
      return { success: false, error: 'PDF navigation not available' };
    
    case 'stopGuide':
      if (typeof gv2StopGuide === 'function') gv2StopGuide();
      else if (window._guidev2) window._guidev2.active = false;
      return { success: true };

    case 'nextGuideStep':
      if (typeof gv2NextStep === 'function') {
        gv2NextStep();
        return { success: true };
      }
      return { success: false, error: 'Guide not active' };

    case 'continueGuidance':
      if (typeof continueGuidance === 'function') {
        return await continueGuidance();
      }
      return { success: false, error: 'Guidance not available' };
    
    case 'setUploadedImage':
      if (typeof setUploadedImage === 'function') {
        setUploadedImage(request.imageBase64);
        return { success: true };
      }
      return { success: false, error: 'Image upload not available' };
    
    case 'clearUploadedImage':
      if (typeof clearUploadedImage === 'function') {
        clearUploadedImage();
        return { success: true };
      }
      return { success: true }; // Silently succeed even if function not loaded

    case 'studyHideControlEnd': {
      const hiddenCount = _cleanupStudyHideControl();
      return { success: true, hiddenCount };
    }

    default:
      return { error: 'Unknown action' };
  }
}

// Track selection changes to send context to sidepanel
let selectionTimeout = null;
document.addEventListener('selectionchange', () => {
  // Clear any pending timeout
  if (selectionTimeout) {
    clearTimeout(selectionTimeout);
  }
  
  // Debounce to avoid spamming messages while user is dragging
  selectionTimeout = setTimeout(() => {
    const selection = window.getSelection();
    // Only send if we're not inside an input/textarea to avoid interfering with normal typing
    const activeEl = document.activeElement;
    const isInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);
    
    if (!isInput) {
      const selectedText = selection.toString().trim();
      try {
        chrome.runtime.sendMessage({ 
          action: 'selectedText', 
          text: selectedText 
        });
      } catch (err) {
        // Extension context might be invalidated, ignore
      }
    }
  }, 300); // 300ms debounce
});

// ─────────────────────────────────────────────────────────────────
// Study: Click-to-hide control (Option A manual hide for control condition)
// ─────────────────────────────────────────────────────────────────

function _injectStudyHideControl(criteria) {
  if (window._studyHideActive) return;
  window._studyHideActive = true;
  window._studyHiddenElements = [];

  // Floating banner at top of page showing criteria + live count
  const banner = document.createElement('div');
  banner.id = 'xwa-study-hide-banner';
  banner.style.cssText = [
    'position:fixed;top:0;left:0;right:0;z-index:2147483647',
    'background:linear-gradient(90deg,#1a1a2e,#0d0d1a)',
    'color:#fff;padding:10px 16px',
    'font-family:system-ui,sans-serif;font-size:13px',
    'display:flex;align-items:center;gap:12px',
    'border-bottom:2px solid #00d9ff',
    'box-shadow:0 2px 16px rgba(0,0,0,0.5)',
  ].join(';');
  banner.innerHTML = `
    <span style="font-size:18px;flex-shrink:0">🙈</span>
    <div style="flex:1;min-width:0">
      <div style="font-weight:700;color:#00d9ff;font-size:10px;text-transform:uppercase;letter-spacing:0.07em">Study Task — Click items below to hide them</div>
      <div style="margin-top:2px;color:rgba(255,255,255,0.9);line-height:1.3">${criteria}</div>
    </div>
    <span id="xwa-study-count-badge" style="flex-shrink:0;background:rgba(0,217,255,0.12);border:1px solid rgba(0,217,255,0.35);border-radius:8px;padding:4px 12px;color:#00d9ff;font-weight:700;font-size:12px">0 hidden</span>
  `;
  document.body.insertBefore(banner, document.body.firstChild);
  // Push page content down
  document.body.style.setProperty('margin-top', banner.offsetHeight + 8 + 'px', 'important');

  // Candidate selectors for recipe/item cards — ordered by specificity
  const CARD_SELECTORS = [
    '[id^="mntl-card-list-card--extendable"]',
    '.card-list__item',
    '.mntl-document-card',
    '.comp.mntl-card-list-items',
    'article',
  ];
  let cards = [];
  for (const sel of CARD_SELECTORS) {
    const found = document.querySelectorAll(sel);
    if (found.length > 1) { cards = Array.from(found); break; }
  }

  cards.forEach((card, i) => {
    if (card.dataset.xwaStudyHide) return;
    card.dataset.xwaStudyHide = 'ready';
    // Ensure relative positioning so the button can be placed absolutely
    const pos = window.getComputedStyle(card).position;
    if (pos === 'static') card.style.position = 'relative';

    const btn = document.createElement('button');
    btn.className = 'xwa-study-hide-btn';
    btn.textContent = '🙈 Hide';
    btn.style.cssText = [
      'position:absolute;top:6px;right:6px;z-index:9999',
      'background:rgba(0,0,0,0.72);color:#fff',
      'border:1px solid rgba(255,255,255,0.28);border-radius:6px',
      'padding:4px 9px;cursor:pointer',
      'font-size:11px;font-weight:700;font-family:system-ui',
      'transition:background 0.15s,border-color 0.15s',
      'line-height:1.2',
    ].join(';');

    btn.addEventListener('mouseenter', () => {
      btn.style.background = card.dataset.xwaStudyHide === 'hidden'
        ? 'rgba(0,180,80,0.85)' : 'rgba(200,40,40,0.85)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = card.dataset.xwaStudyHide === 'hidden'
        ? 'rgba(0,150,60,0.75)' : 'rgba(0,0,0,0.72)';
    });

    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = card.id || `xwa-card-${i}`;
      if (card.dataset.xwaStudyHide === 'hidden') {
        // Restore
        card.dataset.xwaStudyHide = 'ready';
        card.style.opacity = '';
        card.style.pointerEvents = '';
        btn.textContent = '🙈 Hide';
        btn.style.background = 'rgba(0,0,0,0.72)';
        btn.style.borderColor = 'rgba(255,255,255,0.28)';
        const idx = window._studyHiddenElements.indexOf(id);
        if (idx > -1) window._studyHiddenElements.splice(idx, 1);
      } else {
        // Hide
        card.dataset.xwaStudyHide = 'hidden';
        card.style.opacity = '0.12';
        card.style.pointerEvents = 'none';
        btn.style.pointerEvents = 'auto'; // keep button clickable
        btn.textContent = '👁 Show';
        btn.style.background = 'rgba(0,150,60,0.75)';
        btn.style.borderColor = 'rgba(0,255,100,0.4)';
        window._studyHiddenElements.push(id);
      }
      const badge = document.getElementById('xwa-study-count-badge');
      if (badge) badge.textContent = window._studyHiddenElements.length + ' hidden';
    });

    card.appendChild(btn);
  });
}

function _cleanupStudyHideControl() {
  const count = window._studyHiddenElements ? window._studyHiddenElements.length : 0;
  window._studyHideActive = false;
  window._studyHiddenElements = [];

  const banner = document.getElementById('xwa-study-hide-banner');
  if (banner) banner.remove();
  document.body.style.removeProperty('margin-top');

  document.querySelectorAll('[data-xwa-study-hide]').forEach(card => {
    card.style.opacity = '';
    card.style.pointerEvents = '';
    if (card.dataset.xwaStudyHide !== 'ready') card.style.position = '';
    delete card.dataset.xwaStudyHide;
  });
  document.querySelectorAll('.xwa-study-hide-btn').forEach(btn => btn.remove());

  return count;
}
