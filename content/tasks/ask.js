// XWebAgent - Ask Functionality
// Single prompt approach: Answer with inline citations

/**
 * Main handler for user questions
 * Uses single LLM call with inline citations [N]
 * Falls back to simple answer if highlighting fails
 * @param {string} query - User's question
 * @param {Array} history - Conversation history (unused for now)
 */
async function handleAsk(query, history = []) {
  console.log('🤖 handleAsk:', query);
  
  // Get page content and index
  const pageContent = getVisibleText(Infinity); 
  const pageIndex = createPageIndex(Infinity);    
  
  console.log('🤖 Page content length:', pageContent.length);
  console.log('🤖 Page index count:', pageIndex.count);
  
  // Show Set of Marks if enabled in settings
  await showSomIfEnabled(pageIndex);
  
  let result;
  
  // Try with highlighting first
  try {
    result = await handleAskWithHighlight(query, pageContent, pageIndex);
    if (result.success && result.answer) {
      // Hide SoM when task completes
      cleanupSom();
      return result;
    }
  } catch (error) {
    console.log('🤖 Error:', error);
  }
  
  // Fallback: simple answer without highlighting
  console.log('🤖 Falling back to simple answer...');
  result = await handleSimpleAsk(query, pageContent);
  
  // Hide SoM when task completes
  cleanupSom();
  
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
 * Simple ask without highlighting (fallback)
 */
async function handleSimpleAsk(query, pageContent) {
  const prompt = PROMPTS.SIMPLE_ANSWER_PROMPT.replace('{pageContent}', pageContent).replace('{question}', query);
  
  const response = await safeSendMessage({
    action: 'callLLM',
    systemPrompt: '',
    messages: [{ role: 'user', content: prompt }]
  });
  
  if (response?.error) {
    console.log('🤖 Simple answer error:', response.error);
    return { success: false, error: response.error, answer: "Could not answer the question" };
  }
  
  const answer = response?.content?.trim();
  if (!answer) {
    console.log('🤖 Simple answer no answer');
    return { success: false, error: 'No answer from AI', answer: "Could not answer the question" };
  }
  
  console.log('🤖 Simple answer:', answer);
  
  return {
    success: true,
    answer: answer,
    highlightCount: 0,
    hasHighlights: false
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
  
  // Find all [N:"text"] patterns (with text) and [N] patterns (without text, for backwards compatibility)
  // Pattern: [N:"text"] or [N:'text'] or [N]
  const citationWithTextPattern = /\[(\d+):\s*["']([^"']+)["']\]/g;
  const citationSimplePattern = /\[(\d+)\](?!:)/g;
  
  const matchesWithText = [...answer.matchAll(citationWithTextPattern)];
  const matchesSimple = [...answer.matchAll(citationSimplePattern)];
  
  if (matchesWithText.length === 0 && matchesSimple.length === 0) {
    console.log('🤖 No citations found in answer');
    return 0;
  }
  
  console.log('🤖 Found', matchesWithText.length, 'citations with text,', matchesSimple.length, 'simple citations');
  
  const pageBg = getPageBackground();
  const highlightedElements = new Set();
  const seenIndices = new Set();
  let count = 0;
  
  // Process citations with text first (higher priority)
  for (const match of matchesWithText) {
    const index = parseInt(match[1], 10);
    const textToHighlight = match[2];
    
    // Skip duplicate indices
    if (seenIndices.has(index)) continue;
    seenIndices.add(index);
    
    const element = getIndexedElement(index);
    if (!element) {
      console.log('🤖 Index', index, 'not found in _xwebagentIndex');
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
