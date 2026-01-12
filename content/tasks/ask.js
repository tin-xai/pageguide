// XWebAgent - Ask Functionality
// Handles user questions with vision, scrolling, and expand support

/**
 * Check if vision mode is enabled in settings
 * @returns {Promise<boolean>} Whether vision is enabled
 */
async function isVisionEnabled() {
  try {
    const response = await safeSendMessage({ action: 'getVisionSetting' });
    // Default to true if not set
    return response?.visionEnabled !== false;
  } catch (e) {
    console.warn('🤖 Could not get vision setting, defaulting to enabled:', e);
    return true;
  }
}

/**
 * Main handler for all user queries with vision support
 * Uses indexed approach: create page index, capture screenshot, send to LLM, highlight by index
 * Supports automatic scrolling if content not found in current viewport
 * @param {string} query - User's query
 * @param {Array} history - Conversation history [{role, content}, ...]
 * @param {number} scrollAttempts - Number of scroll attempts made (internal use)
 */
async function handleAsk(query, history = [], scrollAttempts = 0) {
  const MAX_SCROLL_ATTEMPTS = 5; // Maximum times to scroll before giving up
  
  console.log('🤖 Processing query:', query);
  console.log('🤖 History length:', history.length);
  console.log('🤖 Scroll attempt:', scrollAttempts);
  
  // Step 1: Get visible text and create index
  const visibleText = getVisibleText(Infinity);
  const pageIndex = createPageIndex(Infinity);
  const pageBg = getPageBackground();
  
  console.log('🤖 Visible text length:', visibleText.length);
  console.log('🤖 Page background:', pageBg);
  console.log('🤖 Created page index with', pageIndex.count, 'items');
  
  // Step 2: Check if vision is enabled in settings, then capture screenshot if so
  const visionSettingEnabled = await isVisionEnabled();
  let screenshot = null;
  if (visionSettingEnabled) {
    screenshot = await captureScreenshot();
  }
  const hasVision = screenshot !== null;
  console.log('🤖 Vision setting enabled:', visionSettingEnabled);
  console.log('🤖 Vision active (screenshot captured):', hasVision);
  
  const pageTitle = document.title;
  const scrollY = window.scrollY;
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  const scrollPercent = maxScroll > 0 ? Math.round((scrollY / maxScroll) * 100) : 0;
  const viewportInfo = `Viewport: ${window.innerWidth}x${window.innerHeight} | Scroll: ${scrollY}px of ${maxScroll}px (${scrollPercent}% down the page)`;
  
  // Build conversation history string
  let historyText = '';
  if (history.length > 0) {
    historyText = '\n=== CONVERSATION HISTORY ===\n';
    history.slice(-6).forEach(msg => { // Keep last 6 messages (3 exchanges)
      historyText += `${msg.role.toUpperCase()}: ${msg.content}\n`;
    });
    historyText += '\n';
  }
  
  try {
    // Step 3: Send text, index, screenshot, and background info to LLM
    const response = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: PROMPTS.ANSWER_AND_HIGHLIGHT,
      imageBase64: screenshot,  // Include screenshot for vision
      messages: [{
        role: 'user',
        content: `Page: ${pageTitle}
${viewportInfo}
PAGE BACKGROUND: ${pageBg.isDark ? 'DARK' : 'LIGHT'} (${pageBg.rgb})

📸 SCREENSHOT: ${hasVision ? 'Attached - shows ONLY the current viewport (what user sees now)' : 'Not available'}
📄 TEXT BELOW: Contains ALL text from the entire page (may include content not visible in screenshot)

=== FULL PAGE TEXT (AXTree) ===
${visibleText}

=== INDEXED ELEMENTS (for highlighting) ===
${pageIndex.indexText}
${historyText}
=== CURRENT QUESTION ===
${query}

IMPORTANT: The screenshot shows only the current viewport. If you need to see something visually (icons, images, layout) that's not in the screenshot, set needsScroll: true.${history.length > 0 ? ' Use conversation history for context if relevant.' : ''}`
      }]
    });
    
    if (response?.error) {
      return { success: false, error: response.error };
    }
    
    if (response?.content) {
      console.log('🤖 LLM Raw Response:', response.content);
      
      // Parse and check if scrolling is needed
      const result = processLLMResponseWithScroll(response.content);
      
      // Handle scroll request - show as a step to user
      if (result.needsScroll) {
        // Check if we've hit the max scroll attempts
        if (scrollAttempts >= MAX_SCROLL_ATTEMPTS) {
          console.log('📜 Max scroll attempts reached (', MAX_SCROLL_ATTEMPTS, ')');
          return {
            success: true,
            answer: `🔍 I've scrolled through the page ${scrollAttempts} times but couldn't find what you're looking for visually. ${result.answer || "The content might not be visible on this page."}`,
            highlightCount: 0,
            hasHighlights: false,
            maxScrollReached: true
          };
        }
        
        const direction = result.scrollDirection || 'down';
        console.log('📜 LLM requested scroll:', direction, '(attempt', scrollAttempts + 1, 'of', MAX_SCROLL_ATTEMPTS, ')');
        
        // Store the ask session for continuation
        window._xwebagentAskSession = {
          active: true,
          query: query,
          history: history,
          scrollAttempts: scrollAttempts + 1,
          action: 'scroll',
          direction: direction
        };
        
        // Set up scroll listener to continue after user scrolls
        setupAskActionListener('scroll', direction);
        
        // Return as a step so user sees what's happening
        return {
          success: true,
          answer: `📜 I need to scroll ${direction} to find what you're looking for. Scroll ${direction} or I'll do it for you...`,
          step: scrollAttempts + 1,
          isAskStep: true,
          actionType: 'scroll',
          actionDirection: direction,
          highlightCount: 0,
          hasHighlights: false,
          waitingForAction: true
        };
      }
      
      // Handle expand request - show as a step to user
      if (result.needsExpand) {
        console.log('📦 LLM requested content expansion');
        
        // Find expand buttons to highlight
        let expandButtons = findExpandButtons();
        
        // If no buttons found, try scrolling down to find them
        if (expandButtons.length === 0) {
          console.log('📦 No expand buttons visible, trying to scroll...');
          const didScroll = await scrollViewport('down');
          if (didScroll) {
            await new Promise(r => setTimeout(r, 500));
            expandButtons = findExpandButtons();
          }
        }
        
        if (expandButtons.length > 0) {
          const expandBtn = expandButtons[0];
          
          // Highlight the first expand button
          const bgInfo = getPageBackground();
          const style = getRandomHighlightStyle(bgInfo.isDark);
          
          clearHighlights();
          window._xwebagentHighlights = [];
          
          expandBtn.style.setProperty('--xwebagent-color', style.color);
          expandBtn.classList.add('xwebagent-highlight', `xwebagent-highlight-${style.animation}`);
          expandBtn.setAttribute('data-xwebagent-styled', 'true');
          window._xwebagentHighlights.push(expandBtn);
          
          // Scroll to the button immediately so user can see it
          expandBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          
          // Store the ask session for continuation
          window._xwebagentAskSession = {
            active: true,
            query: query,
            history: history,
            scrollAttempts: scrollAttempts,
            action: 'expand'
          };
          
          // Set up click listener on the expand button
          setupAskActionListener('click');
          
          // Get button text for more descriptive message
          const btnText = (expandBtn.textContent || expandBtn.getAttribute('aria-label') || 'Show more').trim().slice(0, 30);
          
          return {
            success: true,
            answer: `📦 I found a "${btnText}" button. Click it to see more content, then I'll continue...`,
            step: 1,
            isAskStep: true,
            actionType: 'expand',
            highlightCount: 1,
            hasHighlights: true,
            waitingForAction: true
          };
        } else {
          // No expand buttons found even after scrolling
          // Re-query with a modified prompt that expansion isn't available
          console.log('📦 No expand buttons found, retrying with current content...');
          
          // Send a message to the panel
          try {
            chrome.runtime.sendMessage({ 
              action: 'addMessage', 
              content: '📄 No "Show more" buttons found. Answering with current content...', 
              type: 'system' 
            });
          } catch (e) {}
          
          // Add context that expansion isn't available and re-query
          const modifiedHistory = [...history, {
            role: 'system',
            content: 'Note: Content expansion is not available on this page (no "Show more" buttons found). Please answer with the currently visible content.'
          }];
          
          // Short delay then retry
          await new Promise(r => setTimeout(r, 500));
          
          // Retry with scroll attempts incremented to prevent infinite loops
          return handleAsk(query, modifiedHistory, scrollAttempts + 1);
        }
      }
      
      return result;
    }
    
    return { success: false, error: 'No response from AI' };
  } catch (e) {
    console.error('🤖 API error:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Process LLM response with scroll detection
 */
function processLLMResponseWithScroll(content) {
  // Clear previous highlights
  clearHighlights();
  window._xwebagentHighlights = [];
  
  console.log('🤖 processLLMResponseWithScroll - Raw content:', content);
  
  try {
    // Clean up JSON from markdown code blocks
    let jsonStr = content.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');
    
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) jsonStr = match[0];
    
    console.log('🤖 Cleaned JSON string:', jsonStr);
    
    const result = JSON.parse(jsonStr);
    console.log('🤖 Parsed result:', JSON.stringify(result, null, 2));
    console.log('🤖 needsScroll:', result.needsScroll, 'scrollDirection:', result.scrollDirection);
    
    // Check for scroll request
    if (result.needsScroll) {
      return {
        success: true,
        answer: result.answer || 'Searching...',
        needsScroll: true,
        scrollDirection: result.scrollDirection || 'down',
        highlightCount: 0,
        hasHighlights: false
      };
    }
    
    // Check for expand request
    if (result.needsExpand) {
      return {
        success: true,
        answer: result.answer || 'Expanding content...',
        needsExpand: true,
        highlightCount: 0,
        hasHighlights: false
      };
    }
    
    let highlightCount = 0;
    
    // Get page background for random style selection
    const pageBg = getPageBackground();
    
    // Handle element selector (for "show me images" etc.)
    if (result.selector) {
      const style = getRandomHighlightStyle(pageBg.isDark);
      highlightCount = applyElementHighlight(result.selector, style);
    }
    
    // Handle indexed highlights with random styles
    if (result.highlights && Array.isArray(result.highlights)) {
      console.log('🤖 LLM requested highlights:', JSON.stringify(result.highlights));
      console.log('🤖 Current index has', Object.keys(window._xwebagentIndex || {}).length, 'entries');
      result.highlights.forEach(h => {
        console.log('🤖 Processing highlight item:', JSON.stringify(h));
        if (h.index) {
          // Get random style for each highlight (fun variety!)
          const style = getRandomHighlightStyle(pageBg.isDark);
          console.log('🤖 Applying highlight:', h.index, h.text, 'style:', style);
          const count = applyIndexedHighlight(h.index, h.text, style);
          console.log('🤖 Highlight applied, count:', count);
          highlightCount += count;
        } else {
          console.warn('🤖 Highlight item has no index:', h);
        }
      });
    } else {
      console.log('🤖 No highlights in result or not an array:', result.highlights);
    }
    
    console.log('🤖 Highlighted:', highlightCount, 'items');
    
    return {
      success: true,
      answer: result.answer || 'Done',
      highlightCount,
      hasHighlights: window._xwebagentHighlights.length > 0,
      needsScroll: false
    };
    
  } catch (e) {
    console.error('🤖 Parse error:', e, 'Content:', content);
    
    // Try to detect scroll/expand intent from raw text
    const lowerContent = content.toLowerCase();
    if (lowerContent.includes('scroll') || lowerContent.includes('let me scroll')) {
      console.log('🤖 Detected scroll intent from text, treating as needsScroll');
      return {
        success: true,
        answer: content,
        needsScroll: true,
        scrollDirection: lowerContent.includes('up') ? 'up' : 'down',
        highlightCount: 0,
        hasHighlights: false
      };
    }
    
    if (lowerContent.includes('expand') || lowerContent.includes('show more') || lowerContent.includes('load more')) {
      console.log('🤖 Detected expand intent from text, treating as needsExpand');
      return {
        success: true,
        answer: content,
        needsExpand: true,
        highlightCount: 0,
        hasHighlights: false
      };
    }
    
    return {
      success: true,
      answer: content,
      highlightCount: 0,
      hasHighlights: false,
      needsScroll: false
    };
  }
}

/**
 * Find "Show more" / "See more" / "Load more" buttons on the page
 */
function findExpandButtons() {
  const expandPatterns = [
    /see\s*more/i,
    /show\s*more/i,
    /load\s*more/i,
    /view\s*more/i,
    /SHOW\s*MORE/i,
    /read\s*more/i,
    /expand/i,
    /show\s*all/i,
    /view\s*all/i
  ];
  
  const buttons = [];
  
  // Find clickable elements with expand-like text
  const clickables = document.querySelectorAll('button, a, [role="button"], [onclick], [tabindex="0"]');
  
  clickables.forEach(el => {
    if (typeof isXWebAgentElement === 'function' && isXWebAgentElement(el)) return;
    
    const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
    
    for (const pattern of expandPatterns) {
      if (pattern.test(text) && text.length < 50) { // Avoid long text blocks
        // Check if visible
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          buttons.push(el);
          break;
        }
      }
    }
  });
  
  console.log('📦 Found', buttons.length, 'expand buttons');
  return buttons;
}

/**
 * Set up listener for ask mode actions (scroll/expand)
 */
function setupAskActionListener(actionType, direction = 'down') {
  // Remove any existing listeners
  removeAskActionListener();
  
  window._xwebagentAskHandlers = [];
  
  const continueAfterAction = async (delay = 800) => {
    console.log('🔍 Action completed, continuing ask session...');
    
    // Show typing indicator
    try {
      chrome.runtime.sendMessage({ action: 'showTyping' });
    } catch (err) {}
    
    removeAskActionListener();
    
    await new Promise(r => setTimeout(r, delay));
    
    try {
      const result = await continueAskSession();
      
      if (result) {
        // Send as either a step or final answer
        if (result.isAskStep) {
          chrome.runtime.sendMessage({ action: 'askStep', result });
        } else {
          chrome.runtime.sendMessage({ action: 'askComplete', result });
        }
      } else {
        // No result - session might have been cleared
        console.log('🔍 No result from ask session');
        chrome.runtime.sendMessage({ 
          action: 'askComplete', 
          result: {
            success: true,
            answer: '🔍 Search completed.',
            highlightCount: 0,
            hasHighlights: false
          }
        });
      }
    } catch (err) {
      console.error('🔍 Error continuing ask session:', err);
      chrome.runtime.sendMessage({ 
        action: 'askComplete', 
        result: {
          success: false,
          error: err.message
        }
      });
    }
  };
  
  if (actionType === 'scroll') {
    // Auto-scroll after a short delay if user doesn't scroll
    const autoScrollTimeout = setTimeout(async () => {
      console.log('📜 Auto-scrolling', direction);
      const didScroll = await scrollViewport(direction);
      if (didScroll) {
        await continueAfterAction(500);
      } else {
        // Reached end of page
        const session = window._xwebagentAskSession;
        if (session) {
          session.active = false;
        }
        try {
          chrome.runtime.sendMessage({ 
            action: 'askComplete', 
            result: {
              success: true,
              answer: `📄 Reached the ${direction === 'down' ? 'bottom' : 'top'} of the page.`,
              highlightCount: 0,
              hasHighlights: false
            }
          });
        } catch (err) {}
      }
    }, 2000); // Wait 2 seconds before auto-scrolling
    
    // Also listen for user scroll
    let scrollTimeout = null;
    const scrollHandler = async () => {
      clearTimeout(autoScrollTimeout);
      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(async () => {
        await continueAfterAction(500);
      }, 600);
    };
    
    window.addEventListener('scroll', scrollHandler, true);
    window._xwebagentAskHandlers.push({ event: 'scroll', handler: scrollHandler, capture: true, target: window });
    window._xwebagentAskAutoTimeout = autoScrollTimeout;
    
    console.log('📜 Waiting for scroll or auto-scrolling in 2s...');
    
  } else if (actionType === 'click') {
    // Wait for click on highlighted element
    const clickHandler = async (e) => {
      const isHighlighted = e.target.closest('[data-xwebagent-styled]') || 
                            e.target.hasAttribute('data-xwebagent-styled');
      if (!isHighlighted) return;
      
      console.log('📦 User clicked expand button');
      await continueAfterAction(800);
    };
    
    document.addEventListener('click', clickHandler, true);
    window._xwebagentAskHandlers.push({ event: 'click', handler: clickHandler, capture: true });
    
    console.log('📦 Waiting for click on expand button...');
  }
}

/**
 * Remove ask action listeners
 */
function removeAskActionListener() {
  if (window._xwebagentAskAutoTimeout) {
    clearTimeout(window._xwebagentAskAutoTimeout);
    window._xwebagentAskAutoTimeout = null;
  }
  
  if (window._xwebagentAskHandlers) {
    window._xwebagentAskHandlers.forEach(({ event, handler, capture, target }) => {
      const el = target || document;
      el.removeEventListener(event, handler, capture);
    });
    window._xwebagentAskHandlers = [];
  }
}

/**
 * Continue ask session after user action
 */
async function continueAskSession() {
  const session = window._xwebagentAskSession;
  
  if (!session || !session.active) {
    console.log('🔍 No active ask session');
    return null;
  }
  
  // Mark session as inactive (will be reactivated if more actions needed)
  session.active = false;
  
  // Continue the ask query
  return handleAsk(session.query, session.history, session.scrollAttempts);
}

console.log('💬 api-ask.js loaded');
