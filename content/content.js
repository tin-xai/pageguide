// XWebAgent Content Script - Main Entry Point
// Initializes the extension and handles message routing

// Prevent double-loading
if (!window._xwebagentLoaded) {
  window._xwebagentLoaded = true;
  console.log('🤖 XWebAgent loaded');

  // ===== Message Handler =====
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleMessage(request).then(sendResponse);
    return true;
  });
}

async function handleMessage(request) {
  switch (request.action) {
    case 'handleQuery':
      if (typeof handleSmartQuery === 'function') {
        return await handleSmartQuery(request.query, request.history || []);
      }
      return { success: false, error: 'Query handler not loaded' };
    
    case 'reset':
      if (typeof resetCustomStyles === 'function') resetCustomStyles();
      if (typeof clearMarkings === 'function') clearMarkings();
      if (typeof clearHighlights === 'function') clearHighlights();
      return { success: true };
    
    case 'scrollToHighlight':
      if (typeof scrollToHighlight === 'function') scrollToHighlight(0);
      return { success: true };
    
    case 'continueGuidance':
      if (typeof continueGuidance === 'function') {
        return await continueGuidance();
      }
      return { success: false, error: 'Guidance not available' };
    
    default:
      return { error: 'Unknown action' };
  }
}
