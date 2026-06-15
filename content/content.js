// PageGuide Content Script - Main Entry Point
// Initializes the extension and handles message routing

// Prevent double-loading
if (!window._pageguideLoaded) {
  window._pageguideLoaded = true;
  console.log('🤖 PageGuide loaded');

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
      if (window._pageguideGuidance) {
        window._pageguideGuidance.active = false;
        window._pageguideGuidance.question = '';
        window._pageguideGuidance.currentStep = 0;
        window._pageguideGuidance.previousSteps = [];
        window._pageguideGuidance.waitingForAction = null;
      }
      // Reset guidev2 state
      if (typeof gv2StopGuide === 'function') gv2StopGuide();
      else if (window._guidev2) window._guidev2.active = false;
      // Clear rewind capture records (🧹 Clear / New Chat ends the session)
      if (typeof rewindClear === 'function') { try { rewindClear(); } catch (e) {} }
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

    case 'guideVerifyRetry':
      if (typeof gv2VerifyRetry === 'function') { gv2VerifyRetry(); return { success: true }; }
      return { success: false, error: 'Guide not active' };

    case 'guideVerifyContinue':
      if (typeof gv2VerifyContinue === 'function') { gv2VerifyContinue(); return { success: true }; }
      return { success: false, error: 'Guide not active' };

    case 'guideAskHumanAnswer': // Slice 5: user answered an ASK_HUMAN / stuck prompt
      if (typeof gv2AskHumanAnswer === 'function') { gv2AskHumanAnswer(request.choice); return { success: true }; }
      return { success: false, error: 'Guide not active' };

    case 'guideSteer': // Slice 6: user redirected a low-confidence/errored step
      if (typeof gv2Steer === 'function') { gv2Steer(request.note, request.step, request.url); return { success: true }; }
      return { success: false, error: 'Guide not active' };

    case 'guideScoreGrounding': // on-demand: score a step's screenshot grounding
      if (typeof gv2ScoreStepGrounding === 'function' && typeof rewindGetRecord === 'function') {
        (async () => {
          try {
            const rec = await rewindGetRecord(request.sessionId, request.step);
            if (rec) gv2ScoreStepGrounding(rec);
          } catch (e) {}
        })();
        return { success: true };
      }
      return { success: false, error: 'Grounding unavailable' };

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

    default:
      return { error: 'Unknown action' };
  }
}

// When Chrome restores this page from bfcache, clean up any stale guide state
// (the guide has already moved to the new page; this page is just returning from bfcache)
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    if (typeof gv2StopGuide === 'function') gv2StopGuide();
    else if (window._guidev2) window._guidev2.active = false;
  }
});

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
