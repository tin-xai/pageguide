// PageGuide - Scroll Functions
// Scroll utilities for navigation and highlighting

// Store highlighted elements for scrolling (shared across modules)
window._pageguideHighlights = window._pageguideHighlights || [];

/**
 * Scroll to a highlighted element by index
 * @param {number} index - Which highlight to scroll to (cycles through window._pageguideHighlights)
 * @param {boolean} applyFlash - Whether to flash the element's background. Callers pass false in
 *   Non-grounding baseline mode (isNonGroundingModeOn), since this flash is itself a form of
 *   on-page highlighting, independent of applyHighlightsFromCitations/applyIndexedHighlight.
 */
function scrollToHighlight(index = 0, applyFlash = true) {
  const highlights = window._pageguideHighlights;
  if (highlights.length === 0) {
    console.log('🤖 No highlights to scroll to');
    return;
  }

  // Cycle through highlights
  const targetIndex = index % highlights.length;
  const element = highlights[targetIndex];

  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (!applyFlash) return;
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
 * @param {boolean} applyFlash - Whether to flash an outline/background on the element. Callers
 *   pass false in Non-grounding baseline mode (isNonGroundingModeOn) — see scrollToHighlight.
 */
function scrollToIndex(index, applyFlash = true) {
  const element = getIndexedElement(index);

  if (!element) {
    console.log('🤖 Index', index, 'not found in _pageguideIndex');
    return false;
  }

  console.log('🤖 Scrolling to index', index, ':', element.tagName, element.textContent?.slice(0, 30));

  // Scroll to the element
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (!applyFlash) return true;

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

console.log('📜 scroll.js loaded');
