// PageGuide - Scroll Functions
// Scroll utilities for navigation and highlighting

// Store highlighted elements for scrolling (shared across modules)
window._pageguideHighlights = window._pageguideHighlights || [];

/**
 * Scroll to a highlighted element by index
 * @param {number} index - Which highlight to scroll to (cycles through window._pageguideHighlights)
 * @param {boolean} applyFlash - Kept for the Non-grounding baseline callers (isNonGroundingModeOn),
 *   which pass false. Nothing flashes either way now: this used to blink the element bright yellow
 *   for 500ms and then leave it yellow for good, overriding the tint it already carried.
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

  // Every element in _pageguideHighlights is already tinted, so scrolling is all that's needed.
  if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  // Mark it with the same flat tint every other highlight uses. This used to be a yellow 4px
  // outline plus a yellow background that appeared and then vanished after 1.5s — a flash, in a
  // colour nothing else on the page used. The tint just stays until the next answer clears
  // highlights, so nothing blinks and the marked element matches the cited spans around it.
  const isDark = typeof getPageBackground === 'function' ? getPageBackground().isDark : false;
  const style = typeof getRandomHighlightStyle === 'function'
    ? getRandomHighlightStyle(isDark)
    : { color: '#7857ff', animation: 'soft' };

  if (typeof applyAnimatedHighlight === 'function') {
    applyAnimatedHighlight(element, style.color, style.animation, { block: true });
  } else {
    element.style.backgroundColor = `color-mix(in srgb, ${style.color} 8%, transparent)`;
  }
  window._pageguideHighlights = window._pageguideHighlights || [];
  window._pageguideHighlights.push(element);

  return true;
}

console.log('📜 scroll.js loaded');
