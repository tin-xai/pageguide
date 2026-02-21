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
}

async function handleMessage(request) {
  switch (request.action) {
    case 'handleQuery':
      if (typeof handleSmartQuery === 'function') {
        return await handleSmartQuery(
          request.query, 
          request.history || [],
          request.hasImage || false,
          request.hasImageInHistory || false
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
      if (typeof gv2ClearState === 'function') gv2ClearState();
      if (window._guidev2) window._guidev2.active = false;
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
