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

    case 'studyLockPage': {
      if (!document.getElementById('xwa-study-lock')) {
        const lock = document.createElement('div');
        lock.id = 'xwa-study-lock';
        lock.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.45);cursor:not-allowed;';
        lock.addEventListener('wheel',     e => e.preventDefault(), { passive: false });
        lock.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
        document.documentElement.style.overflow = 'hidden';
        document.body.appendChild(lock);
      }
      return { success: true };
    }

    case 'studyUnlockPage': {
      const lock = document.getElementById('xwa-study-lock');
      if (lock) lock.remove();
      document.documentElement.style.overflow = '';
      return { success: true };
    }

    case 'studyHideControlEnd': {
      const { count: hiddenCount, selectors: hiddenSelectors } = _cleanupStudyHideControl();
      return { success: true, hiddenCount, hiddenSelectors };
    }

    case 'studyHideCheckAccuracy': {
      const selectors = request.selectors || [];

      // Pages like YouTube reuse the same id (e.g. "sections", "contents") across
      // multiple custom elements / former shadow roots.  document.querySelector()
      // only returns the first match, which is often the wrong section.
      // This helper tries all elements that share the same leading #id so that
      // we don't miss the correct ancestor.
      function _findGTEl(sel) {
        try {
          const el = document.querySelector(sel);
          if (el) return [el];
        } catch (e) {}
        // Fallback: sel starts with #id > ...  — try every element with that id
        const m = sel.match(/^#([\w-]+)\s*>([\s\S]*)$/);
        if (!m) return [];
        const allRoots = document.querySelectorAll('[id="' + m[1] + '"]');
        const results = [];
        for (const root of allRoots) {
          try {
            const found = root.querySelectorAll(':scope >' + m[2]);
            results.push(...found);
          } catch (e) {}
        }
        return results;
      }

      function _isElHidden(el) {
        // Check ancestors: protection.js hides a parent container
        let node = el;
        while (node && node !== document.documentElement) {
          if (node.hasAttribute('data-xwebagent-hidden')) return true;
          if (node.dataset && node.dataset.xwaStudyHide === 'hidden') return true;
          const cs = window.getComputedStyle(node);
          if (cs.display === 'none' || cs.visibility === 'hidden') return true;
          node = node.parentElement;
        }
        // Check descendants: protection.js may hide a child element inside the
        // annotated container (e.g. hides a comment body inside a comment wrapper)
        return !!(
          el.querySelector('[data-xwebagent-hidden]') ||
          el.querySelector('[data-xwa-study-hide="hidden"]')
        );
      }

      let matched = 0;
      for (const sel of selectors) {
        try {
          const candidates = _findGTEl(sel);
          if (candidates.some(_isElHidden)) matched++;
        } catch (e) {}
      }
      const hiddenCount = document.querySelectorAll('[data-xwebagent-hidden]').length;
      return { matched, total: selectors.length, hiddenCount };
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

// Generate a unique-enough CSS selector for a DOM element.
// Used to record which elements the user manually hid so precision/recall/F1
// can be computed against the ground-truth hidden_elements selectors offline.
function _generateSelector(el) {
  if (!el || el === document.documentElement) return '';
  if (el.id) return '#' + CSS.escape(el.id);
  const parts = [];
  let node = el;
  while (node && node !== document.documentElement && node !== document.body) {
    if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
      if (siblings.length > 1) {
        parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')');
      } else {
        parts.unshift(tag);
      }
    } else {
      parts.unshift(tag);
    }
    node = node.parentElement;
  }
  if (node === document.body) parts.unshift('body');
  return parts.join(' > ');
}

function _injectStudyHideControl(criteria) {
  if (window._studyHideActive) return;
  window._studyHideActive = true;
  window._studyHiddenElements = [];
  window._studyHiddenSelectors = [];

  // Banner at top of page
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
      <div style="font-weight:700;color:#00d9ff;font-size:10px;text-transform:uppercase;letter-spacing:0.07em">Study Task — Hover any element and click Hide</div>
      <div style="margin-top:2px;color:rgba(255,255,255,0.9);line-height:1.3">${criteria}</div>
    </div>
    <span id="xwa-study-count-badge" style="flex-shrink:0;background:rgba(0,217,255,0.12);border:1px solid rgba(0,217,255,0.35);border-radius:8px;padding:4px 12px;color:#00d9ff;font-weight:700;font-size:12px">0 hidden</span>
  `;
  document.body.insertBefore(banner, document.body.firstChild);
  document.body.style.setProperty('margin-top', banner.offsetHeight + 8 + 'px', 'important');

  // Floating hide/unhide button that follows hover
  const floatBtn = document.createElement('button');
  floatBtn.id = 'xwa-study-hide-btn';
  floatBtn.textContent = '🙈 Hide';
  floatBtn.style.cssText = [
    'position:fixed;z-index:2147483646;display:none',
    'background:rgba(180,30,30,0.92);color:#fff',
    'border:1px solid rgba(255,100,100,0.5);border-radius:6px',
    'padding:5px 11px;cursor:pointer',
    'font-size:12px;font-weight:700;font-family:system-ui',
    'pointer-events:auto;line-height:1.2',
    'box-shadow:0 2px 8px rgba(0,0,0,0.5)',
  ].join(';');
  document.body.appendChild(floatBtn);

  // Tags that should never be hidden or used as targets
  const SKIP_TAGS = new Set(['HTML','BODY','HEAD','SCRIPT','STYLE','NOSCRIPT','META','LINK']);
  const SKIP_IDS = new Set(['xwa-study-hide-banner','xwa-study-hide-btn']);
  const MIN_AREA = 2000; // ~50×40 px minimum

  let currentTarget = null;
  const outlineModified = new Set(); // track elements we've set outline on for cleanup

  function applyHighlight(el) {
    if (el._xwaOrigOutline === undefined) {
      el._xwaOrigOutline = el.style.outline;
      el._xwaOrigOutlineOffset = el.style.outlineOffset;
    }
    el.style.outline = '2px solid #00d9ff';
    el.style.outlineOffset = '2px';
    outlineModified.add(el);
  }

  function removeHighlight(el) {
    if (!el) return;
    el.style.outline = el._xwaOrigOutline !== undefined ? el._xwaOrigOutline : '';
    el.style.outlineOffset = el._xwaOrigOutlineOffset !== undefined ? el._xwaOrigOutlineOffset : '';
    outlineModified.delete(el);
  }

  function isEligible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (SKIP_IDS.has(el.id)) return false;
    if (el.closest('#xwa-study-hide-banner')) return false;
    if (el.id === 'xwa-study-hide-btn') return false;
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area < MIN_AREA) return false;
    // Skip full-viewport-width wrappers (layout containers)
    if (rect.width >= window.innerWidth * 0.98) return false;
    return true;
  }

  const onMouseOver = (e) => {
    if (floatBtn.contains(e.target)) return; // hovering the button itself — keep current target
    let el = e.target;
    // Walk up to find the smallest eligible ancestor
    while (el && el !== document.documentElement) {
      if (isEligible(el)) {
        if (currentTarget !== el) {
          removeHighlight(currentTarget);
          currentTarget = el;
          applyHighlight(el);
        }
        const rect = el.getBoundingClientRect();
        floatBtn.style.top  = Math.max(rect.top + 4, banner.offsetHeight + 6) + 'px';
        floatBtn.style.left = (rect.right - floatBtn.offsetWidth - 8) + 'px';
        const isHidden = el.dataset.xwaStudyHide === 'hidden';
        floatBtn.textContent = isHidden ? '👁 Unhide' : '🙈 Hide';
        floatBtn.style.background = isHidden ? 'rgba(0,140,60,0.92)' : 'rgba(180,30,30,0.92)';
        floatBtn.style.display = 'block';
        return;
      }
      el = el.parentElement;
    }
    removeHighlight(currentTarget);
    floatBtn.style.display = 'none';
    currentTarget = null;
  };

  const onMouseOut = (e) => {
    // Hide button only when leaving to somewhere outside both target and button
    if (floatBtn.contains(e.relatedTarget)) return;
    if (currentTarget && currentTarget.contains(e.relatedTarget)) return;
    removeHighlight(currentTarget);
    floatBtn.style.display = 'none';
    currentTarget = null;
  };

  floatBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!currentTarget) return;
    const alreadyHidden = currentTarget.dataset.xwaStudyHide === 'hidden';
    removeHighlight(currentTarget);
    if (alreadyHidden) {
      currentTarget.style.opacity = '';
      delete currentTarget.dataset.xwaStudyHide;
      const idx = window._studyHiddenElements.indexOf(currentTarget);
      if (idx > -1) {
        window._studyHiddenElements.splice(idx, 1);
        window._studyHiddenSelectors.splice(idx, 1);
      }
    } else {
      currentTarget.dataset.xwaStudyHide = 'hidden';
      currentTarget.style.opacity = '0.08';
      // NOTE: intentionally no pointerEvents:none — keeps element hoverable so unhide works
      window._studyHiddenElements.push(currentTarget);
      window._studyHiddenSelectors.push(_generateSelector(currentTarget));
    }
    const badge = document.getElementById('xwa-study-count-badge');
    if (badge) badge.textContent = window._studyHiddenElements.length + ' hidden';
    floatBtn.style.display = 'none';
    currentTarget = null;
  });

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mouseout',  onMouseOut,  true);

  // Store listeners + outline set for cleanup
  window._studyHideListeners = { onMouseOver, onMouseOut, outlineModified };
}

function _cleanupStudyHideControl() {
  const count = window._studyHiddenElements ? window._studyHiddenElements.length : 0;
  const selectors = window._studyHiddenSelectors ? [...window._studyHiddenSelectors] : [];
  window._studyHideActive = false;

  // Remove event listeners and restore any lingering outlines
  if (window._studyHideListeners) {
    document.removeEventListener('mouseover', window._studyHideListeners.onMouseOver, true);
    document.removeEventListener('mouseout',  window._studyHideListeners.onMouseOut,  true);
    if (window._studyHideListeners.outlineModified) {
      window._studyHideListeners.outlineModified.forEach(el => {
        el.style.outline = el._xwaOrigOutline !== undefined ? el._xwaOrigOutline : '';
        el.style.outlineOffset = el._xwaOrigOutlineOffset !== undefined ? el._xwaOrigOutlineOffset : '';
      });
    }
    window._studyHideListeners = null;
  }

  const banner = document.getElementById('xwa-study-hide-banner');
  if (banner) banner.remove();
  document.body.style.removeProperty('margin-top');

  const floatBtn = document.getElementById('xwa-study-hide-btn');
  if (floatBtn) floatBtn.remove();

  // Restore hidden elements
  document.querySelectorAll('[data-xwa-study-hide]').forEach(el => {
    el.style.opacity = '';
    delete el.dataset.xwaStudyHide;
  });

  window._studyHiddenElements = [];
  window._studyHiddenSelectors = [];
  return { count, selectors };
}
