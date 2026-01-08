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
    
    case 'applySafety':
      if (typeof applyProtection === 'function') {
        const results = await applyProtection();
        const report = typeof generateSafetyReport === 'function' 
          ? generateSafetyReport(results) 
          : `Found ${results?.darkPatterns?.length || 0} issues`;
        return { success: true, report, results };
      }
      return { success: false, error: 'Protection module not loaded' };
    
    case 'hideAds':
      if (typeof detectAds === 'function' && typeof hideAds === 'function') {
        const ads = detectAds();
        const count = hideAds(ads, 'blur');
        return { success: true, count };
      }
      return { success: false, error: 'Ad detection not loaded' };
    
    case 'reset':
      if (typeof resetCustomStyles === 'function') resetCustomStyles();
      if (typeof clearProtectionMarkings === 'function') clearProtectionMarkings();
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
