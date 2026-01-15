// XWebAgent - Ask Functionality
// Single prompt approach: Answer with inline citations
// Supports vision-based answering for visual questions

// Configuration
const VISION_CONFIG = {
  maxScrollSteps: 5,        // Maximum number of scroll steps
  scrollDelayMs: 500,       // Delay between scrolls for rendering
  viewportOverlap: 0.2      // 20% overlap between screenshots
};

/**
 * Route query to determine if vision (screenshots) is needed
 * @param {string} query - User's question
 * @returns {Promise<{needsVision: boolean, confidence: number, reason: string}>}
 */
async function routeVisionQuery(query) {
  console.log('👁️ Checking if vision is needed for:', query);
  
  try {
    const response = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: PROMPTS.VISION_ROUTER,
      messages: [{
        role: 'user',
        content: `Query: "${query}"\n\nClassify this query and return JSON only.`
      }]
    });
    
    if (response?.error) {
      console.warn('👁️ Vision router error, defaulting to text-only:', response.error);
      return { needsVision: false, confidence: 0.5, reason: 'Router error, using text-only' };
    }
    
    if (response?.content) {
      // Parse JSON response
      let jsonStr = response.content.trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '');
      
      const match = jsonStr.match(/\{[\s\S]*\}/);
      if (match) jsonStr = match[0];
      
      const result = JSON.parse(jsonStr);
      console.log('👁️ Vision router decision:', result);
      
      return {
        needsVision: result.needsVision === true,
        confidence: result.confidence || 0.5,
        reason: result.reason || ''
      };
    }
    
    return { needsVision: false, confidence: 0.5, reason: 'No response from router' };
    
  } catch (e) {
    console.error('👁️ Vision router parse error:', e);
    return { needsVision: false, confidence: 0.5, reason: 'Parse error, using text-only' };
  }
}

// Note: captureScreenshot() is defined in capture_screenshot.js

/**
 * Get current scroll position as a descriptive string
 */
function getScrollPosition() {
  const scrollY = window.scrollY;
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  
  if (maxScroll <= 0) return 'single page (no scroll needed)';
  
  const percent = Math.round((scrollY / maxScroll) * 100);
  
  if (percent <= 5) return 'top of page';
  if (percent >= 95) return 'bottom of page';
  return `${percent}% down the page`;
}

/**
 * Scroll the page in a direction
 * @param {string} direction - 'up' or 'down'
 * @returns {boolean} Whether scroll was possible
 */
function scrollPage(direction) {
  const viewportHeight = window.innerHeight;
  const scrollAmount = viewportHeight * 0.8; // 80% of viewport
  const maxScroll = document.documentElement.scrollHeight - viewportHeight;
  
  if (direction === 'down') {
    if (window.scrollY >= maxScroll) return false;
    window.scrollTo({ 
      top: Math.min(window.scrollY + scrollAmount, maxScroll), 
      behavior: 'smooth' 
    });
    return true;
  } else if (direction === 'up') {
    if (window.scrollY <= 0) return false;
    window.scrollTo({ 
      top: Math.max(window.scrollY - scrollAmount, 0), 
      behavior: 'smooth' 
    });
    return true;
  }
  return false;
}

/**
 * Parse vision agent response
 */
function parseVisionResponse(content) {
  try {
    let jsonStr = content.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');
    
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) jsonStr = match[0];
    
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('👁️ Failed to parse vision response:', e);
    return null;
  }
}

/**
 * Handle question using vision with navigation loop
 * Agent takes screenshot, decides if it can answer or needs to scroll
 * @param {string} query - User's question
 * @returns {Promise<object>} Result with answer
 */
async function handleAskWithVision(query) {
  console.log('👁️ Using vision navigation mode for:', query);
  
  const maxSteps = VISION_CONFIG.maxScrollSteps;
  const previousActions = [];
  let step = 1;
  let lastAnswer = null;
  
  // Create page index (will be refreshed after scrolls)
  let pageIndex = createPageIndex(500);
  console.log('👁️ Initial page index count:', pageIndex.count);
  
  // Show Set of Marks if enabled
  await showSomIfEnabled(pageIndex);
  
  while (step <= maxSteps) {
    console.log(`👁️ Vision step ${step}/${maxSteps}`);
    
    // Wait for any scroll animation to complete
    await new Promise(r => setTimeout(r, VISION_CONFIG.scrollDelayMs));
    
    // Refresh page index after scroll (elements may have changed)
    if (step > 1) {
      pageIndex = createPageIndex(500);
      await showSomIfEnabled(pageIndex);
    }
    
    // Capture screenshot at current position
    const screenshot = await captureScreenshot();
    if (!screenshot) {
      cleanupSom();
      return { 
        success: false, 
        error: 'Could not capture screenshot',
        useVision: true,
        visionSteps: step
      };
    }
    
    // Build the navigation prompt
    const prompt = PROMPTS.VISION_NAVIGATE
      .replace('{step}', step.toString())
      .replace('{maxSteps}', maxSteps.toString())
      .replace('{previousActions}', previousActions.length > 0 ? previousActions.join(' → ') : 'none')
      .replace('{scrollPosition}', getScrollPosition())
      .replace('{pageIndex}', pageIndex.indexText)
      .replace('{question}', query);
    
    // Send to LLM
    const response = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: '',
      messages: [{ role: 'user', content: prompt }],
      imageBase64: screenshot
    });
    
    if (response?.error) {
      cleanupSom();
      return { 
        success: false, 
        error: response.error,
        useVision: true,
        visionSteps: step
      };
    }
    
    // Parse the response
    const parsed = parseVisionResponse(response?.content || '');
    
    if (!parsed) {
      // If parsing failed, try to use raw response as answer
      cleanupSom();
      return {
        success: true,
        answer: response?.content || 'Could not parse response',
        useVision: true,
        visionSteps: step,
        highlightCount: 0,
        hasHighlights: false
      };
    }
    
    console.log('👁️ Vision agent response:', parsed);
    
    // Track action
    previousActions.push(`Step ${step}: ${parsed.action} (${parsed.reason})`);
    
    // If agent can answer, we're done!
    if (parsed.canAnswer && parsed.answer) {
      console.log('👁️ Found answer at step', step);
      lastAnswer = parsed.answer;
      
      // Apply highlights from citations
      const highlightCount = applyHighlightsFromCitations(parsed.answer);
      cleanupSom();
      
      return {
        success: true,
        answer: parsed.answer,
        useVision: true,
        visionSteps: step,
        visionActions: previousActions,
        highlightCount: highlightCount,
        hasHighlights: highlightCount > 0
      };
    }
    
    // Handle navigation actions
    if (parsed.action === 'scroll_down') {
      const scrolled = scrollPage('down');
      if (!scrolled) {
        console.log('👁️ Cannot scroll down further');
        previousActions.push('(hit bottom)');
      }
    } else if (parsed.action === 'scroll_up') {
      const scrolled = scrollPage('up');
      if (!scrolled) {
        console.log('👁️ Cannot scroll up further');
        previousActions.push('(hit top)');
      }
    } else if (parsed.action === 'not_found') {
      // Agent determined content doesn't exist
      console.log('👁️ Agent determined: not found');
      cleanupSom();
      
      return {
        success: true,
        answer: parsed.answer || "I couldn't find what you're looking for on this page.",
        useVision: true,
        visionSteps: step,
        visionActions: previousActions,
        highlightCount: 0,
        hasHighlights: false
      };
    }
    
    step++;
  }
  
  // Max steps reached
  console.log('👁️ Max steps reached');
  cleanupSom();
  
  return {
    success: true,
    answer: lastAnswer || "I've searched the visible page but couldn't find a definitive answer. Try scrolling to a different section and asking again.",
    useVision: true,
    visionSteps: step - 1,
    visionActions: previousActions,
    highlightCount: 0,
    hasHighlights: false
  };
}

/**
 * Main handler for user questions
 * Routes between text-only and vision-based approaches
 * @param {string} query - User's question
 * @param {Array} history - Conversation history (unused for now)
 */
async function handleAsk(query, history = []) {
  console.log('🤖 handleAsk:', query);
  
  // First, check if vision is needed
  const visionRoute = await routeVisionQuery(query);
  console.log('👁️ Vision decision:', visionRoute.needsVision ? 'YES' : 'NO', 
              `(${Math.round(visionRoute.confidence * 100)}% - ${visionRoute.reason})`);
  
  // If vision is needed, use screenshot-based approach
  if (visionRoute.needsVision) {
    const result = await handleAskWithVision(query);
    result.visionDecision = visionRoute;
    return result;
  }
  
  // Otherwise, use text-based approach
  // Get page content and index (limit to prevent performance issues on large pages)
  const pageContent = getVisibleText(50000); 
  const pageIndex = createPageIndex(500);    
  
  console.log('🤖 Page content length:', pageContent.length);
  console.log('🤖 Page index count:', pageIndex.count);
  
  // Show Set of Marks if enabled in settings
  await showSomIfEnabled(pageIndex);
  
  let result;
  
  // Try with highlighting first
  try {
    result = await handleAskWithHighlight(query, pageContent, pageIndex);
    if (result.success && result.answer) {
      // Hide SoM when task completes successfully
      cleanupSom();
      result.visionDecision = visionRoute;
      return result;
    }
  } catch (error) {
    console.log('🤖 Error:', error);
  }
  
  // Clean up SoM on failure
  cleanupSom();
  
  result = result || { success: false, error: 'Failed to process query' };
  result.visionDecision = visionRoute;
  return result;
}

/**
 * Ask with highlighting (main approach)
 */
async function handleAskWithHighlight(query, pageContent, pageIndex) {
  // Build prompt with page content and index
  const prompt = PROMPTS.ANSWER_AND_HIGHLIGHT
    .replace('{pageContent}', pageContent)
    .replace('{pageIndex}', pageIndex.indexText)
    .replace('{question}', query);
  
  // Single LLM call
  const response = await safeSendMessage({
    action: 'callLLM',
    systemPrompt: '',
    messages: [{ role: 'user', content: prompt }]
  });
  
  if (response?.error) {
    return { success: false, error: response.error, answer: "Could not answer the question with highlighting" };
  }
  
  const answer = response?.content?.trim();
  if (!answer) {
    return { success: false, error: 'No answer from AI', answer: "Could not answer the question with highlighting" };
  }
  
  console.log('🤖 Answer with citations:', answer);
  
  // Extract citations and apply highlights
  const highlightCount = applyHighlightsFromCitations(answer);
  
  return {
    success: true,
    answer: answer,
    highlightCount: highlightCount,
    hasHighlights: highlightCount > 0
  };
}

/**
 * Extract [N:"text"] citations from answer and apply highlights
 * @param {string} answer - Answer text with [N:"text"] citations
 * @returns {number} Number of elements highlighted
 */
function applyHighlightsFromCitations(answer) {
  // Clear previous highlights
  clearHighlights();
  window._xwebagentHighlights = [];
  
  // Find all citation patterns:
  // [N:"text"] or [N:'text'] - with quotes
  // [N:text] - without quotes (LLMs sometimes omit quotes)
  // [N] - simple index only
  const citationWithTextPattern = /\[(\d+):\s*["']?([^"'\]]+?)["']?\]/g;
  const citationSimplePattern = /\[(\d+)\](?!:)/g;
  
  const matchesWithText = [...answer.matchAll(citationWithTextPattern)];
  const matchesSimple = [...answer.matchAll(citationSimplePattern)];
  
  if (matchesWithText.length === 0 && matchesSimple.length === 0) {
    console.log('🤖 No citations found in answer');
    return 0;
  }
  
  console.log('🤖 Found', matchesWithText.length, 'citations with text,', matchesSimple.length, 'simple citations');
  console.log('🤖 Available indices in _xwebagentIndex:', Object.keys(window._xwebagentIndex || {}).length);
  
  const pageBg = getPageBackground();
  const highlightedElements = new Set();
  const seenIndices = new Set();
  const failedIndices = [];
  let count = 0;
  
  // Process citations with text first (higher priority)
  for (const match of matchesWithText) {
    const index = parseInt(match[1], 10);
    const textToHighlight = match[2];
    
    // Skip duplicate indices
    if (seenIndices.has(index)) continue;
    seenIndices.add(index);
    
    let element = getIndexedElement(index);
    
    if (!element) {
      console.log('🤖 Index', index, 'not found and text search failed');
      failedIndices.push(index);
      continue;
    }
    
    console.log('🤖 Found element for [' + index + ':"' + textToHighlight + '"]:', element.tagName, element.textContent?.slice(0, 30));
    
    // Skip if already highlighted or parent/child is highlighted
    if (isAlreadyHighlighted(element, highlightedElements)) {
      console.log('🤖 Skipping', index, '- overlapping element');
      continue;
    }
    
    // Apply highlight with specific text
    const style = getRandomHighlightStyle(pageBg.isDark);
    const highlighted = applyIndexedHighlight(index, textToHighlight, style);
    
    if (highlighted > 0) {
      highlightedElements.add(element);
      count += highlighted;
      console.log('🤖 Highlighted [' + index + ':"' + textToHighlight + '"] ✓');
    }
  }
  
  // Process simple citations (fallback, highlights entire element)
  for (const match of matchesSimple) {
    const index = parseInt(match[1], 10);
    
    // Skip duplicate indices
    if (seenIndices.has(index)) continue;
    seenIndices.add(index);
    
    const element = getIndexedElement(index);
    if (!element) {
      console.log('🤖 Index', index, 'not found in _xwebagentIndex');
      failedIndices.push(index);
      continue;
    }
    
    console.log('🤖 Found element for [' + index + ']:', element.tagName, element.textContent?.slice(0, 30));
    
    // Skip if already highlighted or parent/child is highlighted
    if (isAlreadyHighlighted(element, highlightedElements)) {
      console.log('🤖 Skipping', index, '- overlapping element');
      continue;
    }
    
    // Apply highlight to entire element (no specific text)
    const style = getRandomHighlightStyle(pageBg.isDark);
    applyAnimatedHighlight(element, style.color, style.animation);
    
    // Force inline styles as backup (in case CSS classes don't work)
    element.style.outline = `3px solid ${style.color}`;
    element.style.outlineOffset = '2px';
    element.style.backgroundColor = `${style.color}22`;
    
    window._xwebagentHighlights.push(element);
    highlightedElements.add(element);
    count++;
    
    console.log('🤖 Highlighted [' + index + '] ✓');
  }
  
  if (failedIndices.length > 0) {
    console.warn('🤖 Failed to highlight indices:', failedIndices);
  }
  
  // Scroll to first highlight
  if (window._xwebagentHighlights.length > 0) {
    window._xwebagentHighlights[0].scrollIntoView({ 
      behavior: 'smooth', 
      block: 'center' 
    });
  }
  
  return count;
}

console.log('💬 ask.js loaded');
