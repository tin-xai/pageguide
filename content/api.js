// XWebAgent - API Functions
// Handles communication with Gemini LLM - Indexed highlighting approach

// Store highlighted elements for scrolling
window._xwebagentHighlights = [];

/**
 * Safe wrapper for chrome.runtime.sendMessage
 * Handles "Extension context invalidated" error gracefully
 */
async function safeSendMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (e) {
    if (e.message?.includes('Extension context invalidated')) {
      return { error: '🔄 Extension was updated. Please refresh the page (F5).' };
    }
    throw e;
  }
}

/**
 * Detect the approximate background color of the page
 */
function getPageBackground() {
  const body = document.body;
  const html = document.documentElement;
  
  // Try to get computed background
  const bodyBg = window.getComputedStyle(body).backgroundColor;
  const htmlBg = window.getComputedStyle(html).backgroundColor;
  
  // Parse RGB values
  const parseRgb = (color) => {
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      return { r: parseInt(match[1]), g: parseInt(match[2]), b: parseInt(match[3]) };
    }
    return null;
  };
  
  let bg = parseRgb(bodyBg) || parseRgb(htmlBg);
  
  // Default to white if transparent/not found
  if (!bg || (bg.r === 0 && bg.g === 0 && bg.b === 0 && bodyBg.includes('0)'))) {
    bg = { r: 255, g: 255, b: 255 };
  }
  
  // Calculate luminance to determine if dark or light
  const luminance = (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) / 255;
  
  return {
    rgb: `rgb(${bg.r}, ${bg.g}, ${bg.b})`,
    isDark: luminance < 0.5,
    luminance: luminance.toFixed(2)
  };
}

/**
 * Scroll to a highlighted element by index
 */
function scrollToHighlight(index = 0) {
  const highlights = window._xwebagentHighlights;
  if (highlights.length === 0) {
    console.log('🤖 No highlights to scroll to');
    return;
  }
  
  // Cycle through highlights
  const targetIndex = index % highlights.length;
  const element = highlights[targetIndex];
  
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Flash effect
    const originalBg = element.style.backgroundColor;
    element.style.backgroundColor = 'rgba(255, 200, 0, 0.8)';
    setTimeout(() => {
      element.style.backgroundColor = originalBg || 'rgba(255, 255, 0, 0.5)';
    }, 500);
  }
}

/**
 * Capture screenshot of current viewport
 * @returns {Promise<string|null>} Base64 image data or null
 */
async function captureScreenshot() {
  try {
    console.log('📸 Capturing screenshot...');
    const response = await safeSendMessage({ action: 'captureScreenshot' });
    
    if (response?.error) {
      console.warn('📸 Screenshot failed:', response.error);
      return null;
    }
    
    if (response?.imageBase64) {
      console.log('📸 Screenshot captured successfully');
      return response.imageBase64;
    }
    
    return null;
  } catch (e) {
    console.warn('📸 Screenshot error:', e);
    return null;
  }
}

/**
 * Scroll the viewport in a direction
 * @param {string} direction - 'up' or 'down'
 * @returns {boolean} Whether scroll was successful
 */
function scrollViewport(direction) {
  const scrollAmount = window.innerHeight * 0.8; // 80% of viewport height
  const beforeScroll = window.scrollY;
  
  if (direction === 'down') {
    window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
  } else if (direction === 'up') {
    window.scrollBy({ top: -scrollAmount, behavior: 'smooth' });
  }
  
  // Check if scroll position actually changed (with small delay for smooth scroll)
  return new Promise(resolve => {
    setTimeout(() => {
      const afterScroll = window.scrollY;
      const didScroll = Math.abs(afterScroll - beforeScroll) > 10;
      console.log('📜 Scrolled', direction, '- Position changed:', didScroll);
      resolve(didScroll);
    }, 500);
  });
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
  
  // Step 2: Capture screenshot for vision
  const screenshot = await captureScreenshot();
  const hasVision = screenshot !== null;
  console.log('🤖 Vision enabled:', hasVision);
  
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

IMPORTANT: The screenshot shows only the current viewport. If you need to see something visually (icons, images, layout) that's not in the screenshot, set needsScroll: true.
Choose highlight colors that CONTRAST with the ${pageBg.isDark ? 'dark' : 'light'} background.${history.length > 0 ? ' Use conversation history for context if relevant.' : ''}`
      }]
    });
    
    if (response?.error) {
      return { success: false, error: response.error };
    }
    
    if (response?.content) {
      console.log('🤖 LLM Raw Response:', response.content);
      
      // Parse and check if scrolling is needed
      const result = processLLMResponseWithScroll(response.content);
      
      // Handle scroll request
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
        
        console.log('📜 LLM requested scroll:', result.scrollDirection, '(attempt', scrollAttempts + 1, 'of', MAX_SCROLL_ATTEMPTS, ')');
        
        // Perform scroll
        const didScroll = await scrollViewport(result.scrollDirection || 'down');
        
        if (didScroll) {
          // Wait a bit for page to settle after scroll
          await new Promise(r => setTimeout(r, 300));
          
          // Recursively call with incremented scroll attempts
          const scrollResult = await handleAsk(query, history, scrollAttempts + 1);
          
          // Prepend scroll message if we found something after scrolling
          if (scrollResult.success && !scrollResult.needsScroll) {
            scrollResult.scrolledToFind = true;
            scrollResult.scrollAttempts = scrollAttempts + 1;
          }
          
          return scrollResult;
        } else {
          // Can't scroll anymore (reached end of page)
          const direction = result.scrollDirection || 'down';
          const reachedMsg = direction === 'down' ? 'bottom' : 'top';
          console.log('📜 Reached', reachedMsg, 'of page, cannot scroll further');
          
          return {
            success: true,
            answer: `📄 I've reached the ${reachedMsg} of the page. ${result.answer || "I couldn't find what you're looking for visually on this page."}`,
            highlightCount: 0,
            hasHighlights: false,
            reachedEnd: true,
            scrollAttempts: scrollAttempts
          };
        }
      }
      
      // Handle expand request
      if (result.needsExpand) {
        console.log('📦 LLM requested content expansion');
        
        // Call the expandContent action (defined in actions.js)
        if (typeof actionExpandContent === 'function') {
          const expandResult = await actionExpandContent(2); // Max 2 clicks
          console.log('📦 Expand result:', expandResult);
          
          if (expandResult.success && expandResult.clickCount > 0) {
            // Wait for content to load
            await new Promise(r => setTimeout(r, 500));
            
            // Re-run the query with the expanded content
            const expandedQueryResult = await handleAsk(query, history, scrollAttempts);
            
            // Add expansion info to the result
            expandedQueryResult.expandedContent = true;
            expandedQueryResult.expandClickCount = expandResult.clickCount;
            
            return expandedQueryResult;
          } else {
            // No expand buttons found, return original answer
            return {
              success: true,
              answer: result.answer || 'No "See more" or "Show more" buttons found on this page.',
              highlightCount: 0,
              hasHighlights: false,
              expandAttempted: true,
              expandFound: false
            };
          }
        } else {
          console.warn('📦 actionExpandContent function not available');
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
  
  try {
    // Clean up JSON from markdown code blocks
    let jsonStr = content.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');
    
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) jsonStr = match[0];
    
    const result = JSON.parse(jsonStr);
    console.log('🤖 Parsed result:', result);
    
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
    
    // Get global style if provided
    const globalStyle = result.style || {};
    
    // Handle element selector (for "show me images" etc.)
    if (result.selector) {
      highlightCount = applyElementHighlight(result.selector, globalStyle);
    }
    
    // Handle indexed highlights with individual styles
    if (result.highlights && Array.isArray(result.highlights)) {
      console.log('🤖 LLM requested highlights:', result.highlights);
      result.highlights.forEach(h => {
        if (h.index) {
          // Each highlight can have its own color and animation
          const style = {
            color: h.color || globalStyle.color || '#ffd93d',
            animation: h.animation || globalStyle.animation || 'pulse'
          };
          console.log('🤖 Applying highlight:', h.index, h.text, style);
          const count = applyIndexedHighlight(h.index, h.text, style);
          highlightCount += count;
        }
      });
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
 * Clear all existing highlights
 */
function clearHighlights() {
  // Clear highlights array
  window._xwebagentHighlights = [];
  
  // Remove ALL xwebagent highlight-related classes
  document.querySelectorAll('[class*="xwebagent-highlight"], [class*="xwebagent-guide"]').forEach(el => {
    const classes = Array.from(el.classList).filter(c => 
      c.startsWith('xwebagent-highlight') || c.startsWith('xwebagent-guide')
    );
    classes.forEach(c => el.classList.remove(c));
    el.style.removeProperty('--xwebagent-color');
    el.removeAttribute('data-xwebagent-styled');
    // Also remove inline styles that might have been added
    el.style.removeProperty('background-color');
    el.style.removeProperty('outline');
    el.style.removeProperty('box-shadow');
  });
  
  // Unwrap highlight spans
  document.querySelectorAll('.xwebagent-highlight').forEach(span => {
    const parent = span.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(span.textContent), span);
      parent.normalize();
    }
  });
  
  console.log('🧹 All highlights cleared');
}

/**
 * Highlight text within an indexed element with LLM-chosen style
 * @param {number} index - The index from page index
 * @param {string} text - Optional: specific text within the element to highlight
 * @param {object} style - { color: '#hex', animation: 'name' }
 */
function applyIndexedHighlight(index, text, style = {}) {
  const element = getIndexedElement(index);
  if (!element) {
    console.warn('🤖 Index', index, 'not found!');
    return 0;
  }
  
  const color = style.color || '#ffd93d';
  const animation = style.animation || 'pulse';
  
  console.log('🤖 Highlighting index', index, 'with color:', color, 'animation:', animation);
  
  // If specific text provided, highlight only that text within the element
  if (text && text.trim()) {
    return highlightTextInElement(element, text.trim(), color, animation);
  }
  
  // Otherwise highlight the whole element
  applyAnimatedHighlight(element, color, animation);
  window._xwebagentHighlights.push(element);
  return 1;
}

/**
 * Apply animated highlight to an element
 */
function applyAnimatedHighlight(element, color, animation) {
  // Set CSS variable for the color
  element.style.setProperty('--xwebagent-color', color);
  
  // Add animation class
  const animClass = `xwebagent-highlight-${animation}`;
  element.classList.add('xwebagent-highlight', animClass);
  element.setAttribute('data-xwebagent-styled', 'true');
  
  // For block elements using shimmer, use the block variant
  const display = window.getComputedStyle(element).display;
  if (animation === 'shimmer' && display !== 'inline') {
    element.classList.remove(animClass);
    element.classList.add('xwebagent-highlight-shimmer-block');
  }
}

/**
 * Highlight specific text within a specific element only
 * Uses LLM-chosen color and animation
 */
function highlightTextInElement(element, searchText, color = '#ffd93d', animation = 'pulse') {
  const searchLower = searchText.toLowerCase();
  let count = 0;
  
  // Try exact match first, then try key parts (for dates like "October 27, 2017" -> try "October 2017")
  const searchVariants = [searchLower];
  
  // For dates, also try without the day number
  const dateMatch = searchText.match(/(\w+)\s+\d+,?\s+(\d{4})/);
  if (dateMatch) {
    searchVariants.push(`${dateMatch[1]} ${dateMatch[2]}`.toLowerCase());
  }
  
  // Also try just the year for partial matching
  const yearMatch = searchText.match(/\d{4}/);
  if (yearMatch) {
    searchVariants.push(yearMatch[0]);
  }
  
  // Walk through text nodes within this element only
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const nodeTextLower = node.textContent.toLowerCase();
    
    for (const variant of searchVariants) {
      if (nodeTextLower.includes(variant)) {
        textNodes.push({ node, searchTerm: variant });
        break;
      }
    }
  }
  
  console.log('🤖 Found', textNodes.length, 'text nodes to highlight');
  
  // Process text nodes
  textNodes.forEach(({ node: textNode, searchTerm }) => {
    const text = textNode.textContent;
    const lowerText = text.toLowerCase();
    const idx = lowerText.indexOf(searchTerm);
    
    if (idx === -1) return;
    
    // Split and wrap
    const before = text.slice(0, idx);
    const match = text.slice(idx, idx + searchTerm.length);
    const after = text.slice(idx + searchTerm.length);
    
    // Create highlight span with LLM-chosen style
    const span = document.createElement('span');
    span.className = `xwebagent-highlight xwebagent-highlight-${animation}`;
    span.style.setProperty('--xwebagent-color', color);
    span.style.backgroundColor = `color-mix(in srgb, ${color} 30%, transparent)`;
    span.style.borderRadius = '3px';
    span.style.padding = '1px 4px';
    span.setAttribute('data-xwebagent-styled', 'true');
    span.textContent = match;
    
    const fragment = document.createDocumentFragment();
    if (before) fragment.appendChild(document.createTextNode(before));
    fragment.appendChild(span);
    if (after) fragment.appendChild(document.createTextNode(after));
    
    textNode.parentNode.replaceChild(fragment, textNode);
    
    // Store reference for scrolling
    window._xwebagentHighlights.push(span);
    count++;
  });
  
  // If no text nodes matched, highlight the whole element
  if (count === 0) {
    console.log('🤖 No text match, highlighting whole element');
    applyAnimatedHighlight(element, color, animation);
    window._xwebagentHighlights.push(element);
    count = 1;
  }
  
  return count;
}

/**
 * Highlight elements by CSS selector with LLM-chosen style
 */
function applyElementHighlight(selector, style = {}) {
  const color = style.color || '#ff6b6b';
  const animation = style.animation || 'glow';
  let count = 0;
  
  try {
    document.querySelectorAll(selector).forEach(el => {
      if (!isXWebAgentElement(el)) {
        applyAnimatedHighlight(el, color, animation);
        window._xwebagentHighlights.push(el);
        count++;
      }
    });
  } catch (e) {
    console.error('Invalid selector:', selector);
  }
  return count;
}

// Legacy function for backwards compatibility
async function handleStylingCommand(query) {
  return handleAsk(query);
}

// ===== AGENT MODE - Navigation & Actions =====

/**
 * Handle agent mode - can perform actions on the page
 * @param {string} task - User's task/command
 * @returns {Promise<{success, answer, action, thought}>}
 */
async function handleAgentTask(task) {
  console.log('🤖 Agent processing task:', task);
  
  // Create page index for element references
  const pageIndex = createPageIndex(150);
  const currentUrl = window.location.href;
  const pageTitle = document.title;
  
  console.log('🤖 Page index created with', pageIndex.count, 'elements');
  
  try {
    const response = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: PROMPTS.AGENT_ACTION,
      messages: [{
        role: 'user',
        content: `CURRENT URL: ${currentUrl}
PAGE TITLE: ${pageTitle}

=== PAGE INDEX ===
${pageIndex.indexText}

=== USER TASK ===
${task}

Respond with JSON: {"thought": "...", "action": "actionName(args)" or null, "answer": "..."}`
      }]
    });
    
    if (response?.error) {
      return { success: false, error: response.error };
    }
    
    if (response?.content) {
      console.log('🤖 Agent Raw Response:', response.content);
      return processAgentResponse(response.content);
    }
    
    return { success: false, error: 'No response from AI' };
  } catch (e) {
    console.error('🤖 Agent error:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Process agent LLM response and execute actions
 */
async function processAgentResponse(content) {
  try {
    // Clean up JSON
    let jsonStr = content.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');
    
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) jsonStr = match[0];
    
    const result = JSON.parse(jsonStr);
    console.log('🤖 Agent parsed result:', result);
    
    let actionResult = null;
    
    // Execute action if present
    if (result.action && result.action !== 'null' && result.action !== null) {
      const parsed = parseAction(result.action);
      if (parsed) {
        console.log('🤖 Executing action:', parsed.name, parsed.args);
        actionResult = await executeAction(parsed.name, parsed.args);
        console.log('🤖 Action result:', actionResult);
      }
    }
    
    return {
      success: true,
      thought: result.thought || '',
      action: result.action,
      answer: result.answer || actionResult?.message || 'Done',
      actionResult
    };
    
  } catch (e) {
    console.error('🤖 Agent parse error:', e, 'Content:', content);
    return {
      success: true,
      answer: content,
      thought: '',
      action: null
    };
  }
}

// ===== STEP-BY-STEP GUIDANCE SYSTEM =====

// Store guidance session state
window._xwebagentGuidance = {
  active: false,
  question: '',
  currentStep: 0,
  previousSteps: [],
  waitingForAction: null
};

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
  } else {
    guidance.currentStep++;
  }
  
  console.log('🎯 Guidance step', guidance.currentStep, 'for:', guidance.question);
  
  // Get fresh page index (DOM may have changed after user action)
  const pageIndex = createPageIndex(150);
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
      return { success: false, error: response.error };
    }
    
    if (response?.content) {
      console.log('🎯 Guide response:', response.content);
      return processGuideResponse(response.content);
    }
    
    guidance.active = false;
    return { success: false, error: 'No response from AI' };
    
  } catch (e) {
    console.error('🎯 Guide error:', e);
    guidance.active = false;
    return { success: false, error: e.message };
  }
}

/**
 * Process guidance response and apply highlighting
 */
function processGuideResponse(content) {
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
    
    // Apply highlight for this step
    let highlightCount = 0;
    if (result.highlight && result.highlight.index) {
      const style = {
        color: result.highlight.color || '#ff6b6b',
        animation: result.highlight.animation || 'bounce'
      };
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
    } else {
      guidance.previousSteps.push(`Step ${result.step}: ${result.instruction}`);
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
    return {
      success: true,
      answer: content,
      isGuide: false
    };
  }
}

/**
 * Set up listener for user action to continue guidance
 */
function setupActionListener(actionType) {
  const guidance = window._xwebagentGuidance;
  
  // Remove any existing listener
  removeActionListener();
  
  const handler = async (e) => {
    // Check if click was on a highlighted element or inside one
    const isHighlighted = e.target.closest('[data-xwebagent-styled]') || 
                          e.target.hasAttribute('data-xwebagent-styled');
    
    if (isHighlighted || actionType === 'click') {
      console.log('🎯 User completed action, continuing to next step...');
      
      // Small delay for DOM to update (menus opening, etc.)
      await new Promise(r => setTimeout(r, 500));
      
      removeActionListener();
      
      // Continue guidance and send result to side panel
      const result = await continueGuidance();
      if (result) {
        try {
          // Send to side panel via runtime message
          chrome.runtime.sendMessage({ action: 'guideStep', result });
        } catch (e) {
          console.log('🎯 Could not send to panel:', e.message);
        }
      }
      
      // Also dispatch event for injected chat panel (backwards compatibility)
      window.dispatchEvent(new CustomEvent('xwebagent-continue-guide'));
    }
  };
  
  window._xwebagentActionHandler = handler;
  document.addEventListener('click', handler, true);
  
  console.log('🎯 Listening for user', actionType, 'action...');
}

/**
 * Remove action listener
 */
function removeActionListener() {
  if (window._xwebagentActionHandler) {
    document.removeEventListener('click', window._xwebagentActionHandler, true);
    window._xwebagentActionHandler = null;
  }
}

/**
 * Continue guidance after user action
 */
async function continueGuidance() {
  const guidance = window._xwebagentGuidance;
  
  if (!guidance.active) {
    console.log('🎯 No active guidance session');
    return null;
  }
  
  return handleStepByStepGuide(guidance.question, true);
}

/**
 * Smart handler that routes queries to the right feature
 */
async function handleSmartQuery(query, history = []) {
  // Check for protection/hide queries first (simple keyword check)
  if (typeof isProtectionQuery === 'function' && isProtectionQuery(query)) {
    console.log('🎯 Protection query detected');
    if (typeof handleProtectionQuery === 'function') {
      const result = await handleProtectionQuery(query);
      if (result) return result;
    }
  }
  
  // Check for "how to" questions
  if (isHowToQuery(query)) {
    return handleStepByStepGuide(query);
  }
  
  // Check for action commands
  if (isActionQuery(query)) {
    return handleAgentTask(query);
  }
  
  // Default to Q&A with highlighting
  return handleAsk(query, history);
}

// Legacy functions kept for backwards compatibility
function isActionQuery(query) {
  const actionPatterns = [
    /^(click|tap|press)\s/i,
    /^(go\s+to|navigate\s+to|open|visit)\s/i,
    /^(type|enter|input|write)\s/i,
    /^(scroll|swipe)\s/i,
    /^(search\s+for|find\s+and\s+click)\s/i,
    /^(submit|send)\s/i,
    /^(select|choose|pick)\s/i,
    /^(back|forward|refresh|reload)\s*$/i,
    /^(hover|mouseover)\s/i,
  ];
  return actionPatterns.some(pattern => pattern.test(query.trim()));
}

function isHowToQuery(query) {
  const howToPatterns = [
    /^how\s+(do\s+i|can\s+i|to)\s/i,
    /^where\s+(is|can\s+i\s+find|do\s+i)\s/i,
    /^tell\s+me\s+how\s+to\s/i,
    /^show\s+me\s+how\s+to\s/i,
    /^guide\s+me\s/i,
    /^help\s+me\s+(to\s+)?(find|do|report|delete|change|edit)/i,
    /\?\s*$/
  ];
  const actionWords = /(report|delete|block|mute|subscribe|unsubscribe|settings|preferences|account|profile|logout|sign\s*out)/i;
  return howToPatterns.some(p => p.test(query.trim())) || 
         (actionWords.test(query) && query.includes('?'));
}

/**
 * Cancel active guidance session
 */
function cancelGuidance() {
  const guidance = window._xwebagentGuidance;
  guidance.active = false;
  guidance.question = '';
  guidance.currentStep = 0;
  guidance.previousSteps = [];
  guidance.waitingForAction = null;
  removeActionListener();
  clearHighlights();
}
