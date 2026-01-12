// XWebAgent - Step-by-Step Guidance System
// Handles interactive step-by-step guidance with cross-page persistence

// ===== GUIDANCE STATE =====

// Store guidance session state (will be synced with storage)
window._xwebagentGuidance = {
  active: false,
  question: '',
  currentStep: 0,
  previousSteps: [],
  waitingForAction: null
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
          waitingForAction: saved.waitingForAction
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
 * Check and resume guidance after page navigation
 */
async function checkAndResumeGuidance() {
  const saved = await loadGuidanceState();
  
  if (saved && saved.active && saved.waitingForAction) {
    console.log('🎯 Resuming guidance after navigation...');
    console.log('🎯 Previous URL:', saved.lastUrl);
    console.log('🎯 Current URL:', window.location.href);
    
    // URL changed = user navigated, continue guidance
    if (saved.lastUrl !== window.location.href) {
      // Show typing indicator immediately so user knows we're working
      try {
        chrome.runtime.sendMessage({ action: 'showTyping' });
      } catch (e) {
        // Panel might not be open
      }
      
      // Small delay for page to fully load
      setTimeout(async () => {
        console.log('🎯 Page navigation detected, continuing to next step...');
        const result = await continueGuidance();
        if (result) {
          try {
            chrome.runtime.sendMessage({ action: 'guideStep', result });
          } catch (e) {
            console.log('🎯 Could not send to panel:', e.message);
          }
        }
      }, 1000);
    }
  }
}

// Initialize guidance on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkAndResumeGuidance);
} else {
  // DOM already loaded, run after a short delay
  setTimeout(checkAndResumeGuidance, 500);
}

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
    await saveGuidanceState(); // Persist new session
  } else {
    guidance.currentStep++;
    await saveGuidanceState(); // Persist step change
  }
  
  console.log('🎯 Guidance step', guidance.currentStep, 'for:', guidance.question);
  
  // Get fresh page index (DOM may have changed after user action)
  const pageIndex = createPageIndex(Infinity);
  const pageBg = getPageBackground();
  
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
      guidance.active = false;
      await clearGuidanceState();
      return { success: false, error: response.error };
    }
    
    if (response?.content) {
      console.log('🎯 Guide response:', response.content);
      return processGuideResponse(response.content);
    }
    
    guidance.active = false;
    await clearGuidanceState();
    return { success: false, error: 'No response from AI' };
    
  } catch (e) {
    console.error('🎯 Guide error:', e);
    guidance.active = false;
    await clearGuidanceState();
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
    
    if (result.isLastStep) {
      guidance.previousSteps.push(`Step ${result.step}: ${result.instruction} ✓`);
      guidance.active = false;
      await clearGuidanceState(); // Clear storage when complete
    } else {
      guidance.previousSteps.push(`Step ${result.step}: ${result.instruction}`);
      await saveGuidanceState(); // Persist updated state
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
    
    // Show typing indicator immediately
    try {
      chrome.runtime.sendMessage({ action: 'showTyping' });
    } catch (err) {
      // Panel might not be open
    }
    
    removeActionListener();
    
    // Wait for DOM to update
    await new Promise(r => setTimeout(r, delay));
    
    // Continue guidance
    const result = await continueGuidance();
    if (result) {
      try {
        chrome.runtime.sendMessage({ action: 'guideStep', result });
      } catch (err) {
        console.log('🎯 Could not send to panel:', err.message);
      }
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
  
  // Check if new interactive elements appeared (menu opened)
  // If not, wait a bit more and retry
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 800;
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const pageIndex = createPageIndex(Infinity);
    console.log('🎯 Attempt', attempt + 1, '- Page index has', pageIndex.count, 'elements');
    
    // If we have a reasonable number of elements, proceed
    // YouTube menus usually add 5-15 new items
    if (pageIndex.count > 5) {
      return handleStepByStepGuide(guidance.question, true);
    }
    
    // Page seems empty, wait for content to load
    console.log('🎯 Page index seems sparse, waiting for content...');
    await new Promise(r => setTimeout(r, RETRY_DELAY));
  }
  
  // Proceed anyway after retries
  console.log('🎯 Proceeding after retries');
  return handleStepByStepGuide(guidance.question, true);
}

console.log('📋 api-guide.js loaded');
