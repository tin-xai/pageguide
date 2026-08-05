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
 * @param {number} [citation] - the citation's display number, so a marker lands on the span it
 *   created rather than the paragraph around it.
 */
function scrollToIndex(index, applyFlash = true, citation) {
  // The span the citation created, when there is one — see pageguideResolveCitationTarget. Hover
  // and click must land on the same thing.
  const element = typeof pageguideResolveCitationTarget === 'function'
    ? pageguideResolveCitationTarget(index, citation)
    : getIndexedElement(index);

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

// ===== WHAT A SCROLL SHOULD MOVE =====
//
// A scroll used to always go to the page root:
//
//   document.scrollingElement.scrollTop += amount
//
// which does nothing whenever the thing that needs scrolling is not the page. An open filter popup
// is the case that matters: modals routinely lock body scroll (overflow:hidden on html/body) and
// keep their options in their own overflow container. The root "scrolls", nothing moves, the next
// screenshot is identical to the last — so the agent either repeats the step or drives its own loop
// score up until the run pauses. From the outside it looks like an agent stuck scrolling a page
// that will not move.
//
// The rule below is not "find a scrollable container", it is "find one that can actually move in
// the direction asked for". Those differ exactly where it counts: a popup already scrolled to its
// bottom is scrollable but cannot go down, and treating it as the answer would reintroduce the same
// silent no-op one level in.

/** Computed overflow-y values that mean "this element scrolls its own content". */
const _PG_SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);

/** The page's own scroller — the last resort, and the right answer for an ordinary page. */
function _pgRootScroller() {
  return document.scrollingElement || document.documentElement || document.body;
}

/**
 * Can this element scroll its own content at all?
 *
 * BOTH halves are load-bearing. Overflow alone matches every `overflow:auto` wrapper on a page,
 * most of which have nothing to scroll; the size comparison alone matches elements that clip their
 * overflow rather than scroll it. The 2px slack absorbs sub-pixel layout rounding, which otherwise
 * reports a container as scrollable by a fraction of a pixel.
 */
function pgIsScrollable(el) {
  if (!el || el.nodeType !== 1) return false;
  const root = _pgRootScroller();
  if (el === root || el === document.body || el === document.documentElement) {
    return (el.scrollHeight || 0) > (el.clientHeight || 0) + 2;
  }
  let overflowY = '';
  try { overflowY = (getComputedStyle(el).overflowY || '').trim(); } catch (e) { return false; }
  if (!_PG_SCROLLABLE_OVERFLOW.has(overflowY)) return false;
  return (el.scrollHeight || 0) > (el.clientHeight || 0) + 2;
}

/**
 * Can it move in THIS direction? The property that kills the silent no-op — a candidate already at
 * the end of its travel is skipped so the next one gets a turn.
 */
function pgCanScroll(el, direction) {
  if (!pgIsScrollable(el)) return false;
  const top = el.scrollTop || 0;
  if (direction === 'up') return top > 1;
  return top + (el.clientHeight || 0) < (el.scrollHeight || 0) - 1;
}

/** The nearest ancestor of `el` (itself included) that can move in `direction`, or null. */
function pgScrollableAncestor(el, direction) {
  let node = el;
  while (node && node.nodeType === 1) {
    if (pgCanScroll(node, direction)) return node;
    node = node.parentElement;
  }
  return null;
}

/** Is the page itself scroll-locked? The tell that a modal is holding the page still. */
function pgBodyScrollLocked() {
  try {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const s = getComputedStyle(el);
      if ((s.overflow || '').includes('hidden') || (s.overflowY || '').includes('hidden')) return true;
    }
  } catch (e) { /* best-effort */ }
  return false;
}

/** Open popups, innermost first — a menu inside a dialog should win over the dialog. */
function _pgOpenPopups() {
  const selectors = (typeof PAGEGUIDE_POPUP_SELECTORS !== 'undefined' && PAGEGUIDE_POPUP_SELECTORS)
    || (typeof window !== 'undefined' && window.PAGEGUIDE_POPUP_SELECTORS)
    || [];
  let found = [];
  try { found = Array.from(document.querySelectorAll(selectors.join(','))); }
  catch (e) { return []; }
  return found
    .filter(el => {
      if (typeof isPageGuideElement === 'function' && isPageGuideElement(el)) return false;
      try { if (typeof isHiddenElement === 'function' && isHiddenElement(el)) return false; }
      catch (e) { return false; }
      return true;
    })
    // Innermost first: depth stands in for "on top of", without reading z-index off elements that
    // mostly do not set one.
    .sort((a, b) => _pgDepth(b) - _pgDepth(a));
}

function _pgDepth(el) {
  let d = 0;
  for (let n = el; n; n = n.parentElement) d++;
  return d;
}

/** The scrollable inside a popup: the popup itself, or the biggest scroller within it. */
function _pgScrollerWithin(container, direction) {
  if (pgCanScroll(container, direction)) return container;
  let best = null;
  let bestArea = 0;
  let candidates = [];
  try { candidates = Array.from(container.querySelectorAll('*')); } catch (e) { return null; }
  for (const el of candidates) {
    if (!pgCanScroll(el, direction)) continue;
    const area = (el.clientHeight || 0) * (el.clientWidth || 0);
    if (area > bestArea) { best = el; bestArea = area; }
  }
  return best;
}

/** The largest scroller intersecting the viewport — the fallback when the page itself is locked. */
function _pgLargestViewportScroller(direction) {
  let best = null;
  let bestArea = 0;
  let candidates = [];
  try { candidates = Array.from(document.body ? document.body.querySelectorAll('*') : []); }
  catch (e) { return null; }
  const vh = window.innerHeight || 0;
  for (const el of candidates) {
    if (typeof isPageGuideElement === 'function' && isPageGuideElement(el)) continue;
    if (!pgCanScroll(el, direction)) continue;
    let rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { continue; }
    if (rect.bottom <= 0 || rect.top >= vh) continue; // off-screen entirely
    const area = rect.width * rect.height;
    if (area > bestArea) { best = el; bestArea = area; }
  }
  return best;
}

/**
 * What this scroll should move, in priority order. Never returns null — the page root is the floor,
 * so a caller always has something to scroll even when nothing can actually move.
 *
 * @param {'up'|'down'} direction
 * @param {Element|null} hintEl - the agent's target, when the step named one
 * @returns {{el: Element, source: string}} source is why it was picked, for the rewind record
 */
function gv2PickScroller(direction, hintEl = null) {
  const dir = direction === 'up' ? 'up' : 'down';

  // 1. The agent said what it was looking at. It saw the page; trust it over any heuristic.
  if (hintEl) {
    const fromHint = pgScrollableAncestor(hintEl, dir);
    if (fromHint) return { el: fromHint, source: 'hint' };
  }

  // 2. An open popup is the thing in front of the user, so it is the thing a scroll means.
  for (const popup of _pgOpenPopups()) {
    const within = _pgScrollerWithin(popup, dir);
    if (within) return { el: within, source: 'popup' };
  }

  // 3. The page is held still by something. Whatever is scrolling instead is what to scroll.
  if (pgBodyScrollLocked()) {
    const largest = _pgLargestViewportScroller(dir);
    if (largest) return { el: largest, source: 'locked-body' };
  }

  // 4. An ordinary page. This is, and should stay, the common case.
  const root = _pgRootScroller();
  if (pgCanScroll(root, dir)) return { el: root, source: 'page' };

  // Nothing can move. Return the root anyway so the caller can report "did not move" rather than
  // branch on null — the distinction it needs is `scrolled`, below, not which element it got.
  return { el: root, source: 'none' };
}

/**
 * Scroll one viewport-ish step and say whether anything actually moved.
 *
 * `scrolled` is the honest answer the old code could not give: it compared nothing, so a scroll
 * into a locked page was indistinguishable from a successful one.
 *
 * @param {'up'|'down'} direction
 * @param {Element|null} hintEl
 * @returns {{scrolled: boolean, el: Element, source: string, before: number, after: number}}
 */
function gv2ScrollBy(direction, hintEl = null) {
  const dir = direction === 'up' ? 'up' : 'down';
  const { el, source } = gv2PickScroller(dir, hintEl);
  const amount = Math.max(240, Math.min(800, Math.round((window.innerHeight || 800) * 0.8)));
  const before = el?.scrollTop || 0;
  try { el.scrollTop = before + (dir === 'up' ? -amount : amount); } catch (e) { /* best-effort */ }
  const after = el?.scrollTop || 0;
  return { scrolled: Math.abs(after - before) > 1, el, source, before, after };
}

if (typeof window !== 'undefined') {
  window.pgIsScrollable = pgIsScrollable;
  window.pgCanScroll = pgCanScroll;
  window.pgScrollableAncestor = pgScrollableAncestor;
  window.pgBodyScrollLocked = pgBodyScrollLocked;
  window.gv2PickScroller = gv2PickScroller;
  window.gv2ScrollBy = gv2ScrollBy;
}

console.log('📜 scroll.js loaded');
