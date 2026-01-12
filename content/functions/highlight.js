// XWebAgent - Highlight Functions
// All highlighting related functionality

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
 * Get random highlight style (color + animation)
 * Automatically picks contrasting colors based on page background
 */
function getRandomHighlightStyle(isDarkPage = false) {
  // Colors that contrast with dark backgrounds
  const darkPageColors = ['#00ff88', '#ff6b6b', '#ffd93d', '#6bcfff', '#ff85c0', '#a29bfe'];
  // Colors that contrast with light backgrounds  
  const lightPageColors = ['#ff4757', '#2ed573', '#1e90ff', '#9b59b6', '#e84393', '#00b894'];
  
  // Animation options
  const animations = ['pulse', 'spotlight', 'shimmer', 'bounce', 'glow', 'underline'];
  
  const colors = isDarkPage ? darkPageColors : lightPageColors;
  const color = colors[Math.floor(Math.random() * colors.length)];
  const animation = animations[Math.floor(Math.random() * animations.length)];
  
  return { color, animation };
}

/**
 * Reset all custom styles applied by XWebAgent
 */
function resetCustomStyles() {
  let count = 0;
  
  // Remove injected style tag
  const style = document.getElementById('xwebagent-custom-style');
  if (style) style.remove();
  
  // Remove highlight spans (unwrap them back to text)
  document.querySelectorAll('span.xwebagent-highlight').forEach(span => {
    const text = document.createTextNode(span.textContent);
    span.parentNode.replaceChild(text, span);
    count++;
  });
  
  // Reset inline styles on marked elements
  const styledProps = ['color', 'backgroundColor', 'fontWeight', 'outline', 
    'outlineOffset', 'border', 'textDecoration', 'boxShadow'];
  
  document.querySelectorAll('[data-xwebagent-styled]').forEach(el => {
    styledProps.forEach(prop => el.style[prop] = '');
    el.removeAttribute('data-xwebagent-styled');
    count++;
  });
  
  return { success: true, count };
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