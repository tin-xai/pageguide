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
  
  console.log('🤖 Visible text length:', visibleText.length);
  console.log('🤖 VISIBLE TEXT:\n', visibleText.slice(0, 500) + '...');
  console.log('🤖 Created page index with', pageIndex.count, 'items');
  
  const pageTitle = document.title;
  
  try {
    // Step 2: Send BOTH visible text and index to LLM
    const response = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: PROMPTS.ANSWER_AND_HIGHLIGHT,
      messages: [{
        role: 'user',
        content: `Page: ${pageTitle}

=== VISIBLE SCREEN TEXT ===
${visibleText}

=== INDEXED ELEMENTS (for highlighting) ===
${pageIndex.indexText}

=== QUESTION ===
${query}

Answer based on VISIBLE SCREEN TEXT. Use index numbers from INDEXED ELEMENTS for highlights.`
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
 * Process LLM response: parse JSON, apply indexed highlighting
 */
function processLLMResponse(content) {
  // Clear previous highlights
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
    
    // Handle element selector (for "show me images" etc.)
    if (result.selector) {
      highlightCount = applyElementHighlight(result.selector);
    }
    
    // Handle indexed highlights
    if (result.highlights && Array.isArray(result.highlights)) {
      console.log('🤖 LLM requested highlights:', result.highlights);
      if (result.highlights.length === 0) {
        console.log('🤖 LLM returned empty highlights array');
      }
      result.highlights.forEach(h => {
        if (h.index) {
          console.log('🤖 Applying highlight for index', h.index, 'text:', h.text);
          const count = applyIndexedHighlight(h.index, h.text);
          highlightCount += count;
        }
      });
    } else {
      console.log('🤖 No highlights array in response');
    }
    
    console.log('🤖 Highlighted:', highlightCount, 'items, stored:', window._xwebagentHighlights.length);
    
    return {
      success: true,
      answer: result.answer || 'Done',
      highlightCount,
      hasHighlights: window._xwebagentHighlights.length > 0
    };
    
  } catch (e) {
    console.error('🤖 Parse error:', e, 'Content:', content);
    // If JSON parsing fails, treat as plain text answer
    return {
      success: true,
      answer: content,
      highlightCount: 0,
      hasHighlights: false
    };
  }
}

/**
 * Highlight text within an indexed element
 * @param {number} index - The index from page index
 * @param {string} text - Optional: specific text within the element to highlight
 */
function applyIndexedHighlight(index, text) {
  const element = getIndexedElement(index);
  if (!element) {
    console.warn('🤖 Index', index, 'not found in map! Available indices:', Object.keys(window._xwebagentIndex).join(','));
    return 0;
  }
  
  console.log('🤖 Found element for index', index, ':', element.tagName, element.innerText?.slice(0, 50));
  
  // If specific text provided, highlight only that text within the element
  if (text && text.trim()) {
    return highlightTextInElement(element, text.trim());
  }
  
  // Otherwise highlight the whole element
  applyInlineStyles(element, { 
    backgroundColor: 'rgba(255, 255, 0, 0.4)',
    outline: '2px solid #ffc107'
  });
  return 1;
}

/**
 * Highlight specific text within a specific element only
 * Falls back to highlighting the whole element if text not found
 */
function highlightTextInElement(element, searchText) {
  const searchLower = searchText.toLowerCase();
  let count = 0;
  
  // Style for highlights
  const styleString = 'background-color: rgba(255, 255, 0, 0.5); font-weight: bold; border-radius: 2px; padding: 0 2px;';
  
  // Try exact match first, then try key parts (for dates like "October 27, 2017" -> try "October 2017")
  const searchVariants = [searchLower];
  
  // For dates, also try without the day number
  const dateMatch = searchText.match(/(\w+)\s+\d+,?\s+(\d{4})/);
  if (dateMatch) {
    searchVariants.push(`${dateMatch[1]} ${dateMatch[2]}`.toLowerCase()); // "October 2017"
  }
  
  // Also try just the year for partial matching
  const yearMatch = searchText.match(/\d{4}/);
  if (yearMatch) {
    searchVariants.push(yearMatch[0]); // "2017"
  }
  
  console.log('🤖 Search variants:', searchVariants);
  
  // Walk through text nodes within this element only
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  
  let matchingVariant = null;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const nodeTextLower = node.textContent.toLowerCase();
    
    // Try each variant
    for (const variant of searchVariants) {
      if (nodeTextLower.includes(variant)) {
        textNodes.push({ node, searchTerm: variant });
        matchingVariant = variant;
        break;
      }
    }
  }
  
  console.log('🤖 Found', textNodes.length, 'text nodes matching');
  
  // Process text nodes
  textNodes.forEach(({ node: textNode, searchTerm }) => {
    const text = textNode.textContent;
    const lowerText = text.toLowerCase();
    const index = lowerText.indexOf(searchTerm);
    
    if (index === -1) return;
    
    // Split and wrap
    const before = text.slice(0, index);
    const match = text.slice(index, index + searchTerm.length);
    const after = text.slice(index + searchTerm.length);
    
    const span = document.createElement('span');
    span.className = 'xwebagent-highlight';
    span.setAttribute('style', styleString);
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
  
  // If no text nodes matched, highlight the whole element with visible style
  if (count === 0) {
    console.log('🤖 No text match, highlighting whole element');
    element.style.backgroundColor = 'rgba(255, 255, 0, 0.4)';
    element.style.outline = '2px solid #ffc107';
    element.setAttribute('data-xwebagent-styled', 'true');
    // Store element reference for scrolling
    window._xwebagentHighlights.push(element);
    count = 1;
  }
  
  return count;
}

/**
 * Highlight elements by CSS selector
 */
function applyElementHighlight(selector) {
  let count = 0;
  try {
    document.querySelectorAll(selector).forEach(el => {
      if (!isXWebAgentElement(el)) {
        applyInlineStyles(el, { outline: '3px solid red', outlineOffset: '2px' });
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
