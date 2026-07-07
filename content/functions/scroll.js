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
    if (typeof pgScrollIntoViewReliably === 'function') {
      pgScrollIntoViewReliably(element, { behavior: _pageguideScrollBehavior() });
    } else {
      element.scrollIntoView({ behavior: _pageguideScrollBehavior(), block: 'center' });
    }
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

/**
 * Nearest scrollable ancestor of `el` (an overflow:auto/scroll element that actually overflows),
 * falling back to the page scroller. Used so we can move the RIGHT scroller when scrollIntoView
 * doesn't land the element in the viewport (nested containers / transformed scrollers).
 */
function pgScrollableAncestor(el) {
  let node = el && el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    try {
      const oy = getComputedStyle(node).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight > node.clientHeight + 1) {
        return node;
      }
    } catch (e) { /* cross-origin / detached — skip */ }
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}
if (typeof window !== 'undefined') window.pgScrollableAncestor = pgScrollableAncestor;

/** True when `el`'s box is meaningfully inside the viewport (below `headerOffset`, above the fold). */
function pgElementInViewport(el, headerOffset = 0) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  if (r.width <= 0 || r.height <= 0) return false;
  const vertOk = r.bottom > headerOffset + 1 && r.top < vh - 1;
  const horizOk = r.right > 0 && r.left < vw;
  return vertOk && horizOk;
}
if (typeof window !== 'undefined') window.pgElementInViewport = pgElementInViewport;

/**
 * Reliably bring `el` into the viewport for screenshot/click. Tries scrollIntoView(center), then
 * VERIFIES the element is actually visible; if not (nested/transformed scroller, sticky header),
 * explicitly adjusts the nearest scrollable ancestor's scrollTop to center it and retries once.
 * Returns true when the element is visibly in the viewport afterwards.
 * @returns {Promise<boolean>}
 */
async function pgScrollIntoViewReliably(el, opts = {}) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const behavior = opts.behavior || (window._guidev2?.autoMode === true ? 'instant' : 'smooth');
  const headerOffset = opts.headerOffset || 0;
  const settleMs = opts.settleMs != null ? opts.settleMs : (behavior === 'instant' ? 60 : 350);
  const settle = () => new Promise(r => setTimeout(r, settleMs));

  try {
    el.scrollIntoView({ behavior, block: 'center', inline: 'nearest' });
  } catch (e) {
    try { el.scrollIntoView(); } catch (e2) { /* ignore */ }
  }
  await settle();
  if (pgElementInViewport(el, headerOffset)) return true;

  // Fallback: move the real scroll container so the element lands near the center of its viewport.
  const scroller = pgScrollableAncestor(el);
  try {
    const rect = el.getBoundingClientRect();
    if (scroller === document.scrollingElement || scroller === document.documentElement) {
      const targetTop = (window.scrollY || 0) + rect.top - (window.innerHeight / 2) + (rect.height / 2);
      window.scrollTo({ top: Math.max(0, targetTop), behavior });
    } else {
      const sRect = scroller.getBoundingClientRect();
      const delta = (rect.top - sRect.top) - (scroller.clientHeight / 2) + (rect.height / 2);
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
    }
  } catch (e) { /* best-effort */ }
  await settle();
  return pgElementInViewport(el, headerOffset);
}
if (typeof window !== 'undefined') window.pgScrollIntoViewReliably = pgScrollIntoViewReliably;
if (typeof module !== 'undefined' && module.exports) {
  module.exports.pgScrollIntoViewReliably = pgScrollIntoViewReliably;
  module.exports.pgScrollableAncestor = pgScrollableAncestor;
  module.exports.pgElementInViewport = pgElementInViewport;
}

console.log('📜 scroll.js loaded');
