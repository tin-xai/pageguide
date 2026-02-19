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
  
  // Animation options (removed underline)
  const animations = ['pulse', 'spotlight', 'shimmer', 'bounce', 'glow'];
  
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
 * Strategy: First try to find child elements (links, spans) that match, then fall back to text nodes
 */
function highlightTextInElement(element, searchText, color = '#ffd93d', animation = 'pulse') {
  const searchLower = searchText.toLowerCase().trim();
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
  
  console.log('🔍 Searching for:', searchVariants, 'in element:', element.tagName);
  
  // STRATEGY 1: Find child elements (links, spans, etc.) that contain the text
  // This is better because it highlights the actual semantic element
  const childSelectors = ['a', 'span', 'strong', 'em', 'b', 'i', 'mark', 'time'];
  for (const selector of childSelectors) {
    const children = element.querySelectorAll(selector);
    for (const child of children) {
      const childText = child.textContent?.toLowerCase().trim();
      for (const variant of searchVariants) {
        if (childText === variant || (childText && childText.includes(variant) && childText.length < variant.length + 20)) {
          // Found a matching child element - highlight it directly
          console.log('🎯 Found matching child element:', child.tagName, child.textContent?.slice(0, 30));
          applyAnimatedHighlight(child, color, animation);
          
          // Also add inline styles for visibility
          child.style.backgroundColor = `color-mix(in srgb, ${color} 30%, transparent)`;
          child.style.borderRadius = '3px';
          child.style.padding = '1px 4px';
          
          window._xwebagentHighlights.push(child);
          count++;
          break;
        }
      }
      if (count > 0) break; // Found one, don't highlight duplicates
    }
    if (count > 0) break;
  }
  
  // STRATEGY 2: Find the deepest/smallest container holding the text, then wrap its text node.
  // This is critical for X/Twitter, Facebook, LinkedIn, and Wikipedia where content lives
  // inside nested divs/spans that aren't directly indexed.
  if (count === 0) {
    // Step 2a: Walk all descendants to find the smallest element whose textContent
    // still contains the search text. This narrows an article/section down to the
    // actual tweet-text div, post-body span, or paragraph.
    let targetEl = element;
    let targetLen = (element.textContent?.length || 0) + 1;

    const descWalker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
    let descEl;
    while ((descEl = descWalker.nextNode())) {
      if (isXWebAgentElement(descEl)) continue;
      const descLen = descEl.textContent?.length || 0;
      if (descLen < targetLen) {
        const descTextLower = descEl.textContent?.toLowerCase().trim() || '';
        for (const variant of searchVariants) {
          if (descTextLower.includes(variant)) {
            targetLen = descLen;
            targetEl = descEl;
            break;
          }
        }
      }
    }

    if (targetEl !== element) {
      const label = targetEl.getAttribute('data-testid') ||
                    (typeof targetEl.className === 'string' ? targetEl.className.slice(0, 30) : '');
      console.log('🎯 Narrowed to container:', targetEl.tagName, label, targetEl.textContent?.slice(0, 50));
    }

    // Step 2b: Walk text nodes within the (possibly narrowed) target element.
    const nodeWalker = document.createTreeWalker(targetEl, NodeFilter.SHOW_TEXT);
    const textNodes = [];

    while (nodeWalker.nextNode()) {
      const node = nodeWalker.currentNode;
      const nodeTextLower = node.textContent.toLowerCase();
      for (const variant of searchVariants) {
        if (nodeTextLower.includes(variant)) {
          textNodes.push({ node, searchTerm: variant });
          break;
        }
      }
    }

    console.log('🤖 Found', textNodes.length, 'text nodes in', targetEl.tagName);

    // Process text nodes (limit to first match to avoid over-highlighting)
    const maxHighlights = 1;
    for (const { node: textNode, searchTerm } of textNodes) {
      if (count >= maxHighlights) break;

      const text = textNode.textContent;
      const lowerText = text.toLowerCase();
      const idx = lowerText.indexOf(searchTerm);

      if (idx === -1) continue;

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
      window._xwebagentHighlights.push(span);
      count++;
    }

    // Step 2c: Text is split across sibling elements (e.g. a tweet with embedded
    // @mentions / #hashtags rendered as separate <a>/<span> nodes). No single text
    // node matched, but the narrowed container IS the right element — highlight it
    // directly instead of falling all the way back to the giant root element.
    if (count === 0 && targetEl !== element) {
      console.log('🤖 Cross-span text detected, highlighting narrowed container:', targetEl.tagName);
      applyAnimatedHighlight(targetEl, color, animation);
      targetEl.style.backgroundColor = `color-mix(in srgb, ${color} 30%, transparent)`;
      targetEl.style.borderRadius = '3px';
      window._xwebagentHighlights.push(targetEl);
      count++;
    }
  }
  
  // STRATEGY 3: If still nothing matched, highlight the whole element
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

/**
 * Check if element or its parent/child is already highlighted
 */
function isAlreadyHighlighted(element, highlightedElements) {
  if (highlightedElements.has(element)) return true;
  
  // Check parents
  let parent = element.parentElement;
  while (parent) {
    if (highlightedElements.has(parent)) return true;
    parent = parent.parentElement;
  }
  
  // Check children
  for (const highlighted of highlightedElements) {
    if (element.contains(highlighted)) return true;
  }
  
  return false;
}

// ===== SET OF MARKS (SoM) =====
// Visual overlay showing indexed elements with their numbers

/**
 * Check if SoM is enabled in settings
 */
async function isSomEnabled() {
  try {
    const settings = await chrome.storage.sync.get(['somEnabled']);
    return settings.somEnabled === true;
  } catch (e) {
    return false;
  }
}

/**
 * Show Set of Marks - numbered labels on all indexed elements
 * @param {object} pageIndex - The page index from createPageIndex()
 */
function showSetOfMarks(pageIndex) {
  // Remove existing SoM first
  hideSetOfMarks();
  
  const indexMap = pageIndex?.indexMap || window._xwebagentIndex || {};
  const container = document.createElement('div');
  container.id = 'xwebagent-som-container';
  container.style.cssText = 'position: absolute; top: 0; left: 0; width: 0; height: 0; pointer-events: none; z-index: 999999;';
  
  // Color palette for variety
  const colors = [
    '#e74c3c', // red
    '#9b59b6', // purple
    '#3498db', // blue
    '#27ae60', // green
    '#f39c12', // orange
    '#1abc9c', // teal
    '#e91e63', // pink
    '#00bcd4', // cyan
  ];
  
  let count = 0;
  
  for (const [idx, element] of Object.entries(indexMap)) {
    try {
      const rect = element.getBoundingClientRect();
      
      // Skip elements not in viewport or too small
      if (rect.width < 5 || rect.height < 5) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      if (rect.right < 0 || rect.left > window.innerWidth) continue;
      
      // Pick color based on index for consistency
      const colorIndex = parseInt(idx) % colors.length;
      const bgColor = colors[colorIndex];
      
      // Calculate absolute positions
      const top = rect.top + window.scrollY;
      const left = rect.left + window.scrollX;
      
      // Create bounding box around the element
      const box = document.createElement('div');
      box.className = 'xwebagent-som-box';
      box.dataset.somIndex = idx;
      box.style.cssText = `
        position: absolute;
        top: ${top}px;
        left: ${left}px;
        width: ${rect.width}px;
        height: ${rect.height}px;
        border: 2px solid ${bgColor};
        background: ${bgColor}15;
        z-index: 999998;
        pointer-events: none;
        box-sizing: border-box;
      `;
      container.appendChild(box);
      
      // Create mark label - positioned at top-right of element
      const mark = document.createElement('div');
      mark.className = 'xwebagent-som-mark';
      mark.dataset.somIndex = idx;
      mark.textContent = idx;
      
      mark.style.cssText = `
        position: absolute;
        top: ${top}px;
        left: ${left + rect.width}px;
        background: ${bgColor};
        color: white;
        font-size: 9px;
        font-weight: bold;
        font-family: monospace;
        padding: 1px 3px;
        border-radius: 3px;
        z-index: 999999;
        pointer-events: none;
        line-height: 1.2;
        white-space: nowrap;
      `;
      
      container.appendChild(mark);
      count++;
    } catch (e) {
      // Element might not be visible
    }
  }
  
  document.body.appendChild(container);
  console.log('🏷️ SoM shown with', count, 'marks');
  
  return count;
}

/**
 * Hide/remove Set of Marks
 */
function hideSetOfMarks() {
  const container = document.getElementById('xwebagent-som-container');
  if (container) {
    container.remove();
    console.log('🏷️ SoM hidden');
  }
}

/**
 * Update SoM positions (call on scroll/resize)
 */
function updateSetOfMarks() {
  const container = document.getElementById('xwebagent-som-container');
  if (!container) return;
  
  const indexMap = window._xwebagentIndex || {};
  
  // Update marks
  container.querySelectorAll('.xwebagent-som-mark').forEach(mark => {
    const idx = mark.dataset.somIndex;
    const element = indexMap[idx];
    if (element) {
      const rect = element.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      const left = rect.left + window.scrollX;
      
      mark.style.top = `${top}px`;
      mark.style.left = `${left + rect.width}px`;
      
      // Hide if out of viewport
      const hidden = rect.bottom < 0 || rect.top > window.innerHeight ||
                     rect.right < 0 || rect.left > window.innerWidth;
      mark.style.display = hidden ? 'none' : '';
    }
  });
  
  // Update boxes
  container.querySelectorAll('.xwebagent-som-box').forEach(box => {
    const idx = box.dataset.somIndex;
    const element = indexMap[idx];
    if (element) {
      const rect = element.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      const left = rect.left + window.scrollX;
      
      box.style.top = `${top}px`;
      box.style.left = `${left}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      
      // Hide if out of viewport
      const hidden = rect.bottom < 0 || rect.top > window.innerHeight ||
                     rect.right < 0 || rect.left > window.innerWidth;
      box.style.display = hidden ? 'none' : '';
    }
  });
}

/**
 * Show SoM if enabled in settings
 */
async function showSomIfEnabled(pageIndex) {
  const enabled = await isSomEnabled();
  if (enabled) {
    showSetOfMarks(pageIndex);
    
    // Update on scroll
    const scrollHandler = () => updateSetOfMarks();
    window.addEventListener('scroll', scrollHandler, { passive: true });
    
    // Store handler for cleanup
    window._xwebagentSomScrollHandler = scrollHandler;
  }
  return enabled;
}

/**
 * Cleanup SoM (call when task completes)
 */
function cleanupSom() {
  hideSetOfMarks();
  
  // Remove scroll listener
  if (window._xwebagentSomScrollHandler) {
    window.removeEventListener('scroll', window._xwebagentSomScrollHandler);
    window._xwebagentSomScrollHandler = null;
  }
}

console.log('🎨 highlight.js loaded');