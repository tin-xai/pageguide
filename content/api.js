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
 * Main handler for all user queries
 * Uses indexed approach: create page index, send to LLM, highlight by index
 */
async function handleAsk(query) {
  console.log('🤖 Processing query:', query);
  
  // Step 1: Get visible text and create index
  const visibleText = getVisibleText(Infinity);
  const pageIndex = createPageIndex(Infinity);
  const pageBg = getPageBackground();
  
  console.log('🤖 Visible text length:', visibleText.length);
  console.log('🤖 Page background:', pageBg);
  console.log('🤖 Created page index with', pageIndex.count, 'items');
  
  const pageTitle = document.title;
  
  try {
    // Step 2: Send text, index, and background info to LLM
    const response = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: PROMPTS.ANSWER_AND_HIGHLIGHT,
      messages: [{
        role: 'user',
        content: `Page: ${pageTitle}
PAGE BACKGROUND: ${pageBg.isDark ? 'DARK' : 'LIGHT'} (${pageBg.rgb})

=== VISIBLE SCREEN TEXT ===
${visibleText}

=== INDEXED ELEMENTS (for highlighting) ===
${pageIndex.indexText}

=== QUESTION ===
${query}

Choose highlight colors that CONTRAST with the ${pageBg.isDark ? 'dark' : 'light'} background.`
      }]
    });
    
    if (response?.error) {
      return { success: false, error: response.error };
    }
    
    if (response?.content) {
      console.log('🤖 LLM Raw Response:', response.content);
      return processLLMResponse(response.content);
    }
    
    return { success: false, error: 'No response from AI' };
  } catch (e) {
    console.error('🤖 API error:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Process LLM response: parse JSON, apply indexed highlighting with LLM-chosen styles
 */
function processLLMResponse(content) {
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
      hasHighlights: window._xwebagentHighlights.length > 0
    };
    
  } catch (e) {
    console.error('🤖 Parse error:', e, 'Content:', content);
    return {
      success: true,
      answer: content,
      highlightCount: 0,
      hasHighlights: false
    };
  }
}

/**
 * Clear all existing highlights
 */
function clearHighlights() {
  // Remove highlight classes
  document.querySelectorAll('[class*="xwebagent-highlight"]').forEach(el => {
    // Get all classes that start with xwebagent-highlight
    const classes = Array.from(el.classList).filter(c => c.startsWith('xwebagent-highlight'));
    classes.forEach(c => el.classList.remove(c));
    el.style.removeProperty('--xwebagent-color');
    el.removeAttribute('data-xwebagent-styled');
  });
  
  // Unwrap highlight spans
  document.querySelectorAll('.xwebagent-highlight').forEach(span => {
    const parent = span.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(span.textContent), span);
      parent.normalize();
    }
  });
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

/**
 * Detect if query is an action command vs information request
 */
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

/**
 * Detect if query is a "how to" question
 */
function isHowToQuery(query) {
  const howToPatterns = [
    /^how\s+(do\s+i|can\s+i|to)\s/i,
    /^where\s+(is|can\s+i\s+find|do\s+i)\s/i,
    /^tell\s+me\s+how\s+to\s/i,
    /^show\s+me\s+how\s+to\s/i,
    /^guide\s+me\s/i,
    /^help\s+me\s+(to\s+)?(find|do|report|delete|change|edit)/i,
    /\?\s*$/  // Ends with question mark
  ];
  
  // Also check for common action words that need guidance
  const actionWords = /(report|delete|block|mute|subscribe|unsubscribe|settings|preferences|account|profile|logout|sign\s*out)/i;
  
  return howToPatterns.some(p => p.test(query.trim())) || 
         (actionWords.test(query) && query.includes('?'));
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
      
      // Dispatch event to continue guidance
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
 * Smart handler that routes to info, action, guide, or protection mode
 */
async function handleSmartQuery(query) {
  // Check for protection/safety queries first
  if (typeof isProtectionQuery === 'function' && isProtectionQuery(query)) {
    const result = await handleProtectionQuery(query);
    if (result) return result;
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
  return handleAsk(query);
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
