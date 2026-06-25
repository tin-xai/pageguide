// PageGuide - Scroll Functions
// Scroll utilities for navigation and highlighting

// Store highlighted elements for scrolling (shared across modules)
window._pageguideHighlights = window._pageguideHighlights || [];

/** Smooth scroll fights the side-panel viewport resize; use instant during auto guide. */
function _pageguideScrollBehavior() {
  return window._guidev2?.autoMode === true ? 'instant' : 'smooth';
}

/**
 * Scroll to a highlighted element by index
 */
function scrollToHighlight(index = 0) {
  const highlights = window._pageguideHighlights;
  if (highlights.length === 0) {
    console.log('🤖 No highlights to scroll to');
    return;
  }
  
  // Cycle through highlights
  const targetIndex = index % highlights.length;
  const element = highlights[targetIndex];
  
  if (element) {
    element.scrollIntoView({ behavior: _pageguideScrollBehavior(), block: 'center' });
    // Flash effect
    const originalBg = element.style.backgroundColor;
    element.style.backgroundColor = 'rgba(255, 200, 0, 0.8)';
    setTimeout(() => {
      element.style.backgroundColor = originalBg || 'rgba(255, 200, 0, 0.5)';
    }, 500);
  }
}

/**
 * Scroll the highlighted target into view and wait for smooth scrolling to settle.
 * Used by debug "aligned" target-region capture before taking a fresh screenshot.
 *
 * @param {number} [index=0]
 * @param {number} [settleMs=500]
 * @returns {Promise<boolean>} true when an element was scrolled
 */
function scrollToHighlightAndWait(index = 0, settleMs = 500) {
  return new Promise((resolve) => {
    const highlights = window._pageguideHighlights || [];
    if (!highlights.length) return resolve(false);
    const element = highlights[index % highlights.length];
    if (!element || typeof element.scrollIntoView !== 'function') return resolve(false);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(!!ok);
    };
    const instant = _pageguideScrollBehavior() === 'instant';
    const waitMs = instant ? 50 : settleMs;
    const maxWait = Math.max(200, waitMs + 200);
    const timer = setTimeout(() => finish(true), maxWait);
    try {
      element.scrollIntoView({ behavior: instant ? 'instant' : 'smooth', block: 'center' });
      setTimeout(() => {
        clearTimeout(timer);
        finish(true);
      }, waitMs);
    } catch (e) {
      clearTimeout(timer);
      finish(false);
    }
  });
}
if (typeof window !== 'undefined') window.scrollToHighlightAndWait = scrollToHighlightAndWait;
if (typeof module !== 'undefined' && module.exports) module.exports.scrollToHighlightAndWait = scrollToHighlightAndWait;

/**
 * Scroll to an element by its page index number
 * @param {number} index - The index from the page index (e.g., 324, 721)
 */
function scrollToIndex(index) {
  const element = getIndexedElement(index);
  
  if (!element) {
    console.log('🤖 Index', index, 'not found in _pageguideIndex');
    return false;
  }
  
  console.log('🤖 Scrolling to index', index, ':', element.tagName, element.textContent?.slice(0, 30));
  
  // Scroll to the element
  element.scrollIntoView({ behavior: _pageguideScrollBehavior(), block: 'center' });
  
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
