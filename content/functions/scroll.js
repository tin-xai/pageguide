// XWebAgent - Scroll Functions
// Scroll utilities for navigation and highlighting

// Store highlighted elements for scrolling (shared across modules)
window._xwebagentHighlights = window._xwebagentHighlights || [];

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
    window._xwaAgentScrolling = true;
    clearTimeout(window._xwaAgentScrollTimer);
    window._xwaAgentScrollTimer = setTimeout(() => { window._xwaAgentScrolling = false; }, 800);
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
 * Scroll to an element by its page index number
 * @param {number} index - The index from the page index (e.g., 324, 721)
 */
function scrollToIndex(index) {
  const element = getIndexedElement(index);
  
  if (!element) {
    console.log('🤖 Index', index, 'not found in _xwebagentIndex');
    return false;
  }
  
  console.log('🤖 Scrolling to index', index, ':', element.tagName, element.textContent?.slice(0, 30));

  window._xwaAgentScrolling = true;
  clearTimeout(window._xwaAgentScrollTimer);
  window._xwaAgentScrollTimer = setTimeout(() => { window._xwaAgentScrolling = false; }, 800);

  // Scroll to the element
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  
  // Flash effect to highlight it temporarily
  const originalOutline = element.style.outline;
  const originalOutlineOffset = element.style.outlineOffset;
  const originalBg = element.style.backgroundColor;
  
  element.style.outline = '4px solid #ffd93d';
  element.style.outlineOffset = '2px';
  element.style.backgroundColor = 'rgba(255, 217, 61, 0.3)';
  
  setTimeout(() => {
    element.style.outline = originalOutline;
    element.style.outlineOffset = originalOutlineOffset;
    element.style.backgroundColor = originalBg;
  }, 1500);
  
  return true;
}

/**
 * Scroll the viewport in a direction
 * @param {string} direction - 'up' or 'down'
 * @returns {Promise<boolean>} Whether scroll was successful
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

console.log('📜 scroll.js loaded');
