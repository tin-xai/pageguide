// XWebAgent - Step-by-Step Guidance System
// Handles interactive step-by-step guidance with cross-page persistence

// ===== GUIDANCE STATE =====

// Store guidance session state (will be synced with storage)
window._xwebagentGuidance = {
  active: false,
  question: '',
  currentStep: 0,
  previousSteps: [],
  waitingForAction: null,
  pendingResume: false  // Set to true when user takes action; cleared after next step is generated
};

// ===== PERSISTENCE FUNCTIONS =====

/**
 * Save guidance state to chrome.storage.session for cross-page persistence
 */
async function saveGuidanceState() {
  const guidance = window._xwebagentGuidance;
  try {
    await chrome.storage.session.set({
      xwebagentGuidance: {
        active: guidance.active,
        question: guidance.question,
        currentStep: guidance.currentStep,
        previousSteps: guidance.previousSteps,
        waitingForAction: guidance.waitingForAction,
        pendingResume: guidance.pendingResume || false,
        lastUrl: window.location.href,
        timestamp: Date.now()
      }
    });
    console.log('🎯 Guidance state saved:', guidance.active ? 'active' : 'inactive');
  } catch (e) {
    console.warn('🎯 Failed to save guidance state:', e);
  }
}

/**
 * Load guidance state from chrome.storage.session
 */
async function loadGuidanceState() {
  try {
    const result = await chrome.storage.session.get('xwebagentGuidance');
    if (result.xwebagentGuidance) {
      const saved = result.xwebagentGuidance;
      // Only restore if session is less than 10 minutes old
      const age = Date.now() - (saved.timestamp || 0);
      if (age < 10 * 60 * 1000) {
        window._xwebagentGuidance = {
          active: saved.active,
          question: saved.question,
          currentStep: saved.currentStep,
          previousSteps: saved.previousSteps || [],
          waitingForAction: saved.waitingForAction,
          pendingResume: saved.pendingResume || false
        };
        console.log('🎯 Guidance state restored:', saved.active ? 'active' : 'inactive', 'step', saved.currentStep);
        return saved;
      } else {
        console.log('🎯 Guidance session expired (', Math.round(age / 60000), 'min old)');
        await clearGuidanceState();
      }
    }
  } catch (e) {
    console.warn('🎯 Failed to load guidance state:', e);
  }
  return null;
}

/**
 * Clear guidance state from storage
 */
async function clearGuidanceState() {
  try {
    await chrome.storage.session.remove('xwebagentGuidance');
    console.log('🎯 Guidance state cleared');
  } catch (e) {
    console.warn('🎯 Failed to clear guidance state:', e);
  }
}

/**
 * Wait for page to be fully loaded before indexing.
 * Event-driven: resolves as soon as readyState is 'complete' + buffer,
 * instead of always waiting a fixed delay.
 */
async function waitForPageReady(maxWait = 4000, buffer = 500) {
  await new Promise(resolve => {
    if (document.readyState === 'complete') {
      setTimeout(resolve, buffer);
      return;
    }
    const onComplete = () => setTimeout(resolve, buffer);
    window.addEventListener('load', onComplete, { once: true });
    document.addEventListener('readystatechange', () => {
      if (document.readyState === 'complete') onComplete();
    }, { once: true });
    // Hard fallback in case load never fires (e.g. error page)
    setTimeout(resolve, maxWait);
  });
}

/**
 * Resume guidance after a URL change (full navigation or SPA pushState).
 * Called both on page load and on SPA URL changes.
 *
 * Two conditions can trigger a resume:
 *  1. URL changed — classic full-page or SPA navigation
 *  2. pendingResume flag — set by continueToNextStep() before any async work,
 *     survives cases where page A saved the new URL before its context died
 */
async function checkAndResumeGuidance() {
  const saved = await loadGuidanceState();

  const urlChanged = saved && saved.active && saved.lastUrl !== window.location.href;
  const pendingResume = saved && saved.active && saved.pendingResume;

  if (!urlChanged && !pendingResume) return;

  // Only one resume at a time — SPA nav + click handler can both fire simultaneously
  if (_guidanceContinuing) {
    console.log('🎯 Guide already resuming, skipping duplicate navigation trigger');
    return;
  }
  _guidanceContinuing = true;

  console.log('🎯 Resuming guidance...', { urlChanged, pendingResume });
  console.log('🎯 Saved URL:', saved.lastUrl, '→ Current URL:', window.location.href);

  try {
    // Show typing indicator immediately so user knows we're working
    try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (e) {}

    // Wait for page to actually finish loading instead of a fixed delay
    await waitForPageReady(4000, 500);

    console.log('🎯 Page ready, continuing to next step...');
    const result = await continueGuidance();

    if (result && result.success !== false) {
      // Success — send guide step to panel
      try {
        chrome.runtime.sendMessage({ action: 'guideStep', result });
      } catch (e) {
        console.log('🎯 Could not send guideStep to panel:', e.message);
      }
    } else if (result && result.success === false) {
      // LLM error — show message and clear state so we don't loop
      console.error('🎯 Guide step generation failed:', result.error);
      try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
      try {
        chrome.runtime.sendMessage({
          action: 'addMessage',
          content: `❌ Could not generate next step: ${result.error || 'Unknown error'}`,
          type: 'error'
        });
      } catch (e) {}
      // Clear state so we don't keep retrying
      window._xwebagentGuidance.active = false;
      await clearGuidanceState();
    } else {
      // continueGuidance returned null (guidance became inactive mid-await)
      try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e) {}
    }
  } catch (e) {
    console.error('🎯 Error during guide resume:', e);
    try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e2) {}
  } finally {
    _guidanceContinuing = false;
  }
}

// Initialize guidance on page load (full navigation)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkAndResumeGuidance);
} else {
  // DOM already loaded, run after a short delay
  setTimeout(checkAndResumeGuidance, 500);
}

// ===== SPA NAVIGATION DETECTION =====
// SPAs change the URL via pushState/replaceState without reloading the page,
// so the DOMContentLoaded / setTimeout path above never fires.
// Intercept history methods to catch these URL changes.
let _guidanceLastUrl = window.location.href;
// Prevent concurrent guide resume calls (SPA nav + click handler can both fire)
let _guidanceContinuing = false;
// Detect full page navigation (vs SPA pushState which keeps the page alive)
let _guidancePageHiding = false;
window.addEventListener('pagehide', () => {
  console.log('🎯 Page hiding — full navigation detected');
  _guidancePageHiding = true;
});

function _onSpaNavigation() {
  // Small delay so the new URL is committed before we read it
  setTimeout(async () => {
    const newUrl = window.location.href;
    if (newUrl !== _guidanceLastUrl) {
      _guidanceLastUrl = newUrl;
      console.log('🎯 SPA navigation detected:', newUrl);
      await checkAndResumeGuidance();
    }
  }, 50);
}

// Wrap pushState / replaceState
(function () {
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (...args) { origPush(...args); _onSpaNavigation(); };
  history.replaceState = function (...args) { origReplace(...args); _onSpaNavigation(); };
})();

// Also handle browser back/forward
window.addEventListener('popstate', _onSpaNavigation);

// ===== MAIN GUIDANCE FUNCTIONS =====

/**
 * Start or continue step-by-step guidance
 */
async function handleStepByStepGuide(question, continueFromStep = false) {
  const guidance = window._xwebagentGuidance;
  
  if (!continueFromStep) {
    // Start new guidance session
    guidance.active = true;
    guidance.question = question;
    guidance.currentStep = 1;
    guidance.previousSteps = [];
    guidance.waitingForAction = null;
    guidance.pendingResume = false;
    await saveGuidanceState(); // Persist new session
  } else {
    guidance.currentStep++;
    // NOTE: Do NOT save state here. The only correct save happens in processGuideResponse()
    // after a successful LLM response. Saving here would write lastUrl = new page's URL
    // (navigation may have already started), breaking the new page's resume detection.
  }
  
  console.log('🎯 Guidance step', guidance.currentStep, 'for:', guidance.question);
  
  // Get fresh page index (DOM may have changed after user action)
  const pageIndex = createPageIndex(5000);
  const pageBg = getPageBackground();
  
  // Show SoM if enabled
  await showSomIfEnabled(pageIndex);
  
  console.log('🎯 Page index refreshed with', pageIndex.count, 'elements');
  
  try {
    const response = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: PROMPTS.STEP_BY_STEP_GUIDE,
      messages: [{
        role: 'user',
        content: `PAGE BACKGROUND: ${pageBg.isDark ? 'DARK' : 'LIGHT'}
CURRENT URL: ${window.location.href}

=== PAGE INDEX ===
${pageIndex.indexText}

=== USER QUESTION ===
${guidance.question}

=== CURRENT STEP ===
Step ${guidance.currentStep}

=== PREVIOUS STEPS COMPLETED ===
${guidance.previousSteps.length > 0 ? guidance.previousSteps.join('\n') : 'None (this is the first step)'}

Provide the next step. Return JSON only.`
      }]
    });
    
    if (response?.error) {
      // Do NOT clear guidance state here — this context might be dying (navigation).
      // checkAndResumeGuidance() on the new page will handle the error and clear state.
      console.warn('🎯 LLM error:', response.error);
      return { success: false, error: response.error };
    }

    if (response?.content) {
      console.log('🎯 Guide response:', response.content);
      return processGuideResponse(response.content);
    }

    console.warn('🎯 No content in LLM response');
    return { success: false, error: 'No response from AI' };

  } catch (e) {
    console.error('🎯 Guide error:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Process guidance response and apply highlighting
 */
async function processGuideResponse(content) {
  const guidance = window._xwebagentGuidance;
  
  try {
    let jsonStr = content.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');
    
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) jsonStr = match[0];
    
    const result = JSON.parse(jsonStr);
    console.log('🎯 Parsed guide step:', result);
    
    // Clear previous highlights
    clearHighlights();
    window._xwebagentHighlights = [];
    
    // Apply highlight for this step with random style
    let highlightCount = 0;
    if (result.highlight && result.highlight.index) {
      const pageBg = getPageBackground();
      const style = getRandomHighlightStyle(pageBg.isDark);
      highlightCount = applyIndexedHighlight(
        result.highlight.index, 
        result.highlight.text,
        style
      );
      
      // Scroll to highlighted element
      if (window._xwebagentHighlights.length > 0) {
        setTimeout(() => scrollToHighlight(0), 300);
      }
    }
    
    // Update guidance state
    guidance.waitingForAction = result.waitFor;
    // Step successfully generated — clear the pendingResume flag
    guidance.pendingResume = false;

    // Clean up SoM after step is processed (will show again on next step)
    cleanupSom();

    if (result.isLastStep) {
      guidance.previousSteps.push(`Step ${result.step}: ${result.instruction} ✓`);
      guidance.active = false;
      await clearGuidanceState(); // Clear storage when complete
    } else {
      guidance.previousSteps.push(`Step ${result.step}: ${result.instruction}`);
      await saveGuidanceState(); // Persist updated state (pendingResume:false, lastUrl:current)
    }
    
    // Set up listener for user action if needed
    if (result.waitFor && !result.isLastStep) {
      setupActionListener(result.waitFor);
    }
    
    return {
      success: true,
      answer: result.instruction,
      step: result.step,
      isLastStep: result.isLastStep,
      nextStepHint: result.nextStepHint,
      waitFor: result.waitFor,
      highlightCount,
      hasHighlights: highlightCount > 0,
      isGuide: true
    };
    
  } catch (e) {
    console.error('🎯 Guide parse error:', e);
    guidance.active = false;
    await clearGuidanceState();
    cleanupSom();
    return {
      success: true,
      answer: content,
      isGuide: false
    };
  }
}

// ===== ACTION LISTENERS =====

/**
 * Set up listener for user action to continue guidance
 * Supports: click, input, scroll
 */
function setupActionListener(actionType) {
  const guidance = window._xwebagentGuidance;
  
  // Remove any existing listeners
  removeActionListener();
  
  // Store handlers so we can remove them later
  window._xwebagentActionHandlers = [];
  
  const continueToNextStep = async (delay = 1200) => {
    console.log('🎯 User completed action, continuing to next step...');

    // If SPA nav already triggered a resume, skip to avoid double-processing
    if (_guidanceContinuing) {
      console.log('🎯 Guide already resuming via SPA nav, skipping click trigger');
      removeActionListener();
      return;
    }
    _guidanceContinuing = true;

    const startUrl = window.location.href;

    // Mark pendingResume=true BEFORE the delay so that if a full page navigation
    // happens, the new page's checkAndResumeGuidance() can detect it even if the
    // URL comparison fails (because this context may save lastUrl = new page URL).
    try {
      window._xwebagentGuidance.pendingResume = true;
      await saveGuidanceState(); // Saves pendingResume:true, lastUrl:startUrl (old URL)
    } catch (e) {
      // Context might already be dying — ignore; URL comparison is the fallback
    }

    // Show typing indicator immediately
    try { chrome.runtime.sendMessage({ action: 'showTyping' }); } catch (err) {}

    removeActionListener();

    try {
      // Wait for DOM to update (menu open, SPA render, etc.)
      await new Promise(r => setTimeout(r, delay));

      // ── Navigation detection ──────────────────────────────────────────────
      // _guidancePageHiding = true  → full page navigation (pagehide fired).
      //   The new page's content script will call checkAndResumeGuidance().
      //   Don't call continueGuidance() here — this context is being torn down
      //   and would corrupt state.
      //
      // URL changed + page still alive → SPA navigation (pushState).
      //   _onSpaNavigation was blocked by _guidanceContinuing; release the lock
      //   and delegate to checkAndResumeGuidance() ourselves.
      // ─────────────────────────────────────────────────────────────────────
      if (_guidancePageHiding) {
        console.log('🎯 Full page navigation — new page will resume guide');
        // Typing indicator stays visible during the page load (good UX).
        // The new page sends showTyping again and eventually guideStep.
        return; // _guidanceContinuing reset in finally
      }

      if (window.location.href !== startUrl) {
        console.log('🎯 SPA navigation detected, delegating to checkAndResumeGuidance');
        _guidanceContinuing = false; // Release lock before calling
        await checkAndResumeGuidance();
        return;
      }

      // Same page — continue normally (non-navigation action like dropdown open)
      const result = await continueGuidance();
      if (result && result.success !== false) {
        try {
          chrome.runtime.sendMessage({ action: 'guideStep', result });
        } catch (err) {
          console.log('🎯 Could not send to panel:', err.message);
        }
      } else {
        try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (err) {}
      }
    } catch (err) {
      console.error('🎯 Error in continueToNextStep:', err);
      try { chrome.runtime.sendMessage({ action: 'hideTyping' }); } catch (e2) {}
    } finally {
      _guidanceContinuing = false;
    }
  };
  
  if (actionType === 'click') {
    // Click handler - wait for click on highlighted element
    const clickHandler = async (e) => {
      const isHighlighted = e.target.closest('[data-xwebagent-styled]') || 
                            e.target.hasAttribute('data-xwebagent-styled');
      if (!isHighlighted) return;
      
      console.log('🎯 User clicked highlighted element');
      await continueToNextStep(1200); // Longer delay for menus to render
    };
    
    document.addEventListener('click', clickHandler, true);
    window._xwebagentActionHandlers.push({ event: 'click', handler: clickHandler, capture: true });
    console.log('🎯 Listening for click on highlighted element...');
    
  } else if (actionType === 'input') {
    // Input handler - wait for user to type and then blur/Enter
    const inputHandler = async (e) => {
      const isHighlighted = e.target.closest('[data-xwebagent-styled]') || 
                            e.target.hasAttribute('data-xwebagent-styled');
      if (!isHighlighted) return;
      
      // For input fields, wait until user finishes (blur or Enter)
      console.log('🎯 User is typing in highlighted field...');
    };
    
    const blurHandler = async (e) => {
      const isHighlighted = e.target.closest('[data-xwebagent-styled]') || 
                            e.target.hasAttribute('data-xwebagent-styled');
      if (!isHighlighted) return;
      
      // Only continue if field has value
      if (e.target.value && e.target.value.trim()) {
        console.log('🎯 User finished typing (blur)');
        await continueToNextStep(500);
      }
    };
    
    const keydownHandler = async (e) => {
      if (e.key !== 'Enter') return;
      
      const isHighlighted = e.target.closest('[data-xwebagent-styled]') || 
                            e.target.hasAttribute('data-xwebagent-styled');
      if (!isHighlighted) return;
      
      console.log('🎯 User finished typing (Enter)');
      await continueToNextStep(500);
    };
    
    document.addEventListener('input', inputHandler, true);
    document.addEventListener('blur', blurHandler, true);
    document.addEventListener('keydown', keydownHandler, true);
    
    window._xwebagentActionHandlers.push({ event: 'input', handler: inputHandler, capture: true });
    window._xwebagentActionHandlers.push({ event: 'blur', handler: blurHandler, capture: true });
    window._xwebagentActionHandlers.push({ event: 'keydown', handler: keydownHandler, capture: true });
    console.log('🎯 Listening for input in highlighted field (blur or Enter to continue)...');
    
  } else if (actionType === 'scroll') {
    // Scroll handler - wait for user to scroll
    let scrollTimeout = null;
    
    const scrollHandler = async () => {
      // Debounce - wait for scrolling to stop
      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(async () => {
        console.log('🎯 User finished scrolling');
        await continueToNextStep(500);
      }, 800);
    };
    
    window.addEventListener('scroll', scrollHandler, true);
    window._xwebagentActionHandlers.push({ event: 'scroll', handler: scrollHandler, capture: true, target: window });
    console.log('🎯 Listening for scroll...');
    
  } else {
    // Default: just listen for any click on highlighted element
    const defaultHandler = async (e) => {
      const isHighlighted = e.target.closest('[data-xwebagent-styled]') || 
                            e.target.hasAttribute('data-xwebagent-styled');
      if (!isHighlighted) return;
      
      console.log('🎯 User interacted with highlighted element');
      await continueToNextStep(1000);
    };
    
    document.addEventListener('click', defaultHandler, true);
    window._xwebagentActionHandlers.push({ event: 'click', handler: defaultHandler, capture: true });
    console.log('🎯 Listening for interaction with highlighted element...');
  }
}

/**
 * Remove all action listeners
 */
function removeActionListener() {
  if (window._xwebagentActionHandlers) {
    window._xwebagentActionHandlers.forEach(({ event, handler, capture, target }) => {
      const el = target || document;
      el.removeEventListener(event, handler, capture);
    });
    window._xwebagentActionHandlers = [];
  }
  
  // Legacy cleanup
  if (window._xwebagentActionHandler) {
    document.removeEventListener('click', window._xwebagentActionHandler, true);
    window._xwebagentActionHandler = null;
  }
}

/**
 * Continue guidance after user action
 * Includes retry logic for slow-rendering menus
 */
async function continueGuidance() {
  const guidance = window._xwebagentGuidance;
  
  if (!guidance.active) {
    console.log('🎯 No active guidance session');
    return null;
  }
  
  // Check if page has meaningful interactive content before proceeding.
  // Threshold >10 avoids false-positives from near-empty loading skeletons.
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 600;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const pageIndex = createPageIndex(1000);
    console.log('🎯 Attempt', attempt + 1, '- Page index has', pageIndex.count, 'elements');

    if (pageIndex.count > 10) {
      return handleStepByStepGuide(guidance.question, true);
    }

    // Page seems empty/loading, wait a bit more
    console.log('🎯 Page index seems sparse, waiting for content...');
    await new Promise(r => setTimeout(r, RETRY_DELAY));
  }
  
  // Proceed anyway after retries
  console.log('🎯 Proceeding after retries');
  return handleStepByStepGuide(guidance.question, true);
}

console.log('📋 api-guide.js loaded');
