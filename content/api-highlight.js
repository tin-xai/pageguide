// XWebAgent - Highlight Functions
// All highlighting related functionality

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
  console.log('🎨 applyIndexedHighlight called with index:', index, 'text:', text);
  console.log('🎨 Current _xwebagentIndex keys:', Object.keys(window._xwebagentIndex || {}));
  
  const element = getIndexedElement(index);
  if (!element) {
    console.warn('🤖 Index', index, 'not found in _xwebagentIndex!');
    console.warn('🤖 Available indices:', Object.keys(window._xwebagentIndex || {}));
    return 0;
  }
  
  console.log('🎨 Found element for index', index, ':', element.tagName, element.textContent?.slice(0, 50));
  
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

console.log('🎨 api-highlight.js loaded');
