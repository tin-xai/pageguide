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
