// PageGuide - Highlight Functions
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
 * Get the highlight style (color + effect) for a page.
 *
 * Deliberately deterministic despite the legacy name: it used to pick a random color out of three
 * purples and a random animation out of four (pulse / spotlight / left-to-right shimmer / glow)
 * *per citation*, so a single answer lit the page up in several colors moving in several
 * different ways at once. One answer now reads as one thing — a single accent, a single calm
 * effect (see .pageguide-highlight in content/content.css). The only variation left is page
 * background: a lighter orange on dark pages so the tint stays legible.
 *
 * @param {boolean} isDarkPage - from getPageBackground().isDark
 * @returns {{color: string, animation: string}} accent color + effect name
 */
function getRandomHighlightStyle(isDarkPage = false) {
  // Keep PageGuide highlights in the same orange family as the side panel.
  return {
    color: isDarkPage ? '#ffce9c' : '#ffa657',
    animation: 'soft'
  };
}

/** Span-level vs block-level tint strength. Blocks stay lighter so cited phrases nested inside a
 *  whole-element highlight still read against it. */
const PAGEGUIDE_TINT_SPAN = 16;
const PAGEGUIDE_TINT_BLOCK = 8;

/**
 * Background tint for a highlight, in the accent color.
 * @param {string} color - accent color
 * @param {boolean} block - true for whole-element highlights (lighter)
 * @returns {string} a color-mix() background value
 */
function pageguideHighlightTint(color, block = false) {
  const strength = block ? PAGEGUIDE_TINT_BLOCK : PAGEGUIDE_TINT_SPAN;
  return `color-mix(in srgb, ${color} ${strength}%, transparent)`;
}

/**
 * Reset all custom styles applied by PageGuide
 */
function resetCustomStyles() {
  let count = 0;
  
  // Remove injected style tag
  const style = document.getElementById('pageguide-custom-style');
  if (style) style.remove();
  
  // Remove highlight spans (unwrap them back to text)
  document.querySelectorAll('span.pageguide-highlight').forEach(span => {
    const text = document.createTextNode(span.textContent);
    span.parentNode.replaceChild(text, span);
    count++;
  });
  
  // Reset inline styles on marked elements
  const styledProps = ['color', 'backgroundColor', 'fontWeight', 'outline', 
    'outlineOffset', 'border', 'textDecoration', 'boxShadow'];
  
  document.querySelectorAll('[data-pageguide-styled]').forEach(el => {
    styledProps.forEach(prop => el.style[prop] = '');
    el.removeAttribute('data-pageguide-styled');
    count++;
  });
  
  return { success: true, count };
}

/**
 * Clear all existing highlights
 */
function clearHighlights() {
  // Clear highlights array
  window._pageguideHighlights = [];

  // On-page evidence marks belong to the answer that drew them; a new answer replaces them.
  if (typeof pageguideClearEvidenceAnnotations === 'function') pageguideClearEvidenceAnnotations();
  
  // Remove ALL pageguide highlight-related classes
  document.querySelectorAll('[class*="pageguide-highlight"], [class*="pageguide-guide"]').forEach(el => {
    const classes = Array.from(el.classList).filter(c => 
      c.startsWith('pageguide-highlight') || c.startsWith('pageguide-guide')
    );
    classes.forEach(c => el.classList.remove(c));
    el.style.removeProperty('--pageguide-color');
    el.removeAttribute('data-pageguide-styled');
    // Also remove inline styles that might have been added
    el.style.removeProperty('background-color');
    el.style.removeProperty('outline');
    el.style.removeProperty('box-shadow');
  });
  
  // Unwrap highlight spans
  document.querySelectorAll('.pageguide-highlight').forEach(span => {
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
  console.log('🎨 Current _pageguideIndex keys:', Object.keys(window._pageguideIndex || {}));
  
  const element = getIndexedElement(index);
  if (!element) {
    console.warn('🤖 Index', index, 'not found in _pageguideIndex!');
    console.warn('🤖 Available indices:', Object.keys(window._pageguideIndex || {}));
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
  
  // Otherwise highlight the whole element (lighter tint — see pageguideHighlightTint)
  applyAnimatedHighlight(element, color, animation, { block: true });
  window._pageguideHighlights.push(element);
  return 1;
}

/**
 * Apply animated highlight to an element
 */
/**
 * Apply the highlight treatment to an element.
 * @param {Element} element
 * @param {string} color - accent color
 * @param {string} animation - effect name from getRandomHighlightStyle ('soft')
 * @param {{block?: boolean}} opts - block: this is a whole-element highlight, so tint it lighter
 */
function applyAnimatedHighlight(element, color, animation, opts = {}) {
  // Set CSS variable for the color
  element.style.setProperty('--pageguide-color', color);

  const animClass = `pageguide-highlight-${animation}`;
  element.classList.add('pageguide-highlight', animClass);
  if (opts.block) element.classList.add('pageguide-highlight-block');
  element.setAttribute('data-pageguide-styled', 'true');
}

/**
 * Flatten an element's text into one comparable string, keeping a map from each character back to
 * the (node, offsetInNode) that produced it. Whitespace runs collapse to one space so minor
 * formatting differences between a quote and the page don't defeat the match, and any text already
 * inside a PageGuide highlight/badge is skipped so re-highlighting an element can't fold PageGuide's
 * own injected text back into the search.
 *
 * The map is what makes it possible to locate a match that CROSSES sibling text nodes separated by
 * an inline tag — a citation reading "near aphelion and in conjunction with the Sun" spans two <a>
 * links, so no single text node (or even a single descendant element) ever contains the whole
 * phrase. Without this, that citation fell through every strategy below to "highlight the whole
 * element", which for a Wikipedia paragraph is not one sentence but the ENTIRE paragraph — including
 * whatever other citation had already been precisely highlighted inside it.
 */
function _pgFlattenTextWithMap(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '';
  const map = [];
  let node;
  let sawSpace = false;
  while ((node = walker.nextNode())) {
    if (typeof isPageGuideElement === 'function' && isPageGuideElement(node.parentElement)) continue;
    const value = node.nodeValue || '';
    for (let i = 0; i < value.length; i++) {
      let ch = value[i];
      if (/\s/.test(ch)) {
        if (sawSpace) continue;                // collapse this run to the one space already emitted
        sawSpace = true;
        ch = ' ';
      } else {
        sawSpace = false;
      }
      text += ch;
      map.push({ node, offset: i });
    }
  }
  return { text, map };
}

/**
 * Wrap `searchTerm` inside `root` even when it spans sibling text nodes — see
 * _pgFlattenTextWithMap. Finds the match in the flattened text, then uses the position map to build
 * a Range across the ACTUAL nodes and surrounds it. Any inline element fully between the two
 * endpoints (the <a> links in the example above) ends up inside the new highlight span, exactly as
 * a same-node match would.
 *
 * @returns {number} 1 if a highlight was created, 0 otherwise (caller falls back further)
 */
function _pgHighlightAcrossNodes(root, searchTerm, color, animation) {
  const needle = String(searchTerm || '').toLowerCase().trim();
  if (!needle || !root) return 0;
  const { text, map } = _pgFlattenTextWithMap(root);
  if (!map.length) return 0;
  const hit = text.toLowerCase().indexOf(needle);
  if (hit < 0) return 0;
  const startPos = map[hit];
  const endPos = map[hit + needle.length - 1];
  if (!startPos || !endPos) return 0;
  try {
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset + 1);
    const span = document.createElement('span');
    span.className = `pageguide-highlight pageguide-highlight-${animation}`;
    span.style.setProperty('--pageguide-color', color);
    span.style.backgroundColor = pageguideHighlightTint(color);
    span.style.borderRadius = '3px';
    span.setAttribute('data-pageguide-styled', 'true');
    range.surroundContents(span);
    window._pageguideHighlights.push(span);
    return 1;
  } catch (e) {
    // The range partially contained a non-Text node (malformed/overlapping markup) — fall through
    // to the caller's next strategy rather than leaving the DOM half-modified.
    return 0;
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
          child.style.backgroundColor = pageguideHighlightTint(color);
          child.style.borderRadius = '3px';
          child.style.padding = '1px 4px';
          
          window._pageguideHighlights.push(child);
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
      if (isPageGuideElement(descEl)) continue;
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
      span.className = `pageguide-highlight pageguide-highlight-${animation}`;
      span.style.setProperty('--pageguide-color', color);
      span.style.backgroundColor = pageguideHighlightTint(color);
      span.style.borderRadius = '3px';
      span.style.padding = '1px 4px';
      span.setAttribute('data-pageguide-styled', 'true');
      span.textContent = match;

      const fragment = document.createDocumentFragment();
      if (before) fragment.appendChild(document.createTextNode(before));
      fragment.appendChild(span);
      if (after) fragment.appendChild(document.createTextNode(after));

      textNode.parentNode.replaceChild(fragment, textNode);
      window._pageguideHighlights.push(span);
      count++;
    }

    // Step 2d: The quote's own text node search (2b) failed, and 2a couldn't narrow to a smaller
    // container either — the usual reason is that the phrase itself crosses an inline tag boundary
    // (a link, an <em>, ...), so no element or single text node ever holds it whole. Try wrapping it
    // across nodes before giving up to the block-level fallbacks below, which is what used to tint
    // an entire Wikipedia paragraph for a citation that only meant one sentence in it.
    if (count === 0) {
      for (const variant of searchVariants) {
        if (_pgHighlightAcrossNodes(targetEl, variant, color, animation)) { count++; break; }
      }
    }

    // Step 2c: Text is split across sibling elements (e.g. a tweet with embedded
    // @mentions / #hashtags rendered as separate <a>/<span> nodes). No single text
    // node matched, but the narrowed container IS the right element — highlight it
    // directly instead of falling all the way back to the giant root element.
    if (count === 0 && targetEl !== element) {
      console.log('🤖 Cross-span text detected, highlighting narrowed container:', targetEl.tagName);
      applyAnimatedHighlight(targetEl, color, animation, { block: true });
      targetEl.style.backgroundColor = pageguideHighlightTint(color, true);
      targetEl.style.borderRadius = '3px';
      window._pageguideHighlights.push(targetEl);
      count++;
    }
  }
  
  // STRATEGY 3: If still nothing matched, highlight the whole element
  if (count === 0) {
    console.log('🤖 No text match, highlighting whole element');
    applyAnimatedHighlight(element, color, animation, { block: true });
    window._pageguideHighlights.push(element);
    count = 1;
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

// ===== NON-GROUNDING BASELINE MODE =====
// A user-study A/B baseline: same agent, same routing, same LLM answers — but no on-page
// highlighting, marker overlays, or visual-highlight screenshots. Toggled from the side panel's
// "Grounding" button (sidepanel/panel.js), stored in chrome.storage.local so every content
// script (ask.js, guidev2.js) reads the same current value fresh, the same way isSomEnabled()
// and _gv2IsVisualRecapOn() already do for their own settings.
const PAGEGUIDE_NON_GROUNDING_KEY = 'pageguideNonGrounding';

/**
 * Check if Non-grounding baseline mode is on (default: off, i.e. normal grounding behavior).
 */
async function isNonGroundingModeOn() {
  try {
    const settings = await chrome.storage.local.get([PAGEGUIDE_NON_GROUNDING_KEY]);
    return settings[PAGEGUIDE_NON_GROUNDING_KEY] === 'on';
  } catch (e) {
    return false;
  }
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
  
  const indexMap = pageIndex?.indexMap || window._pageguideIndex || {};
  const container = document.createElement('div');
  container.id = 'pageguide-som-container';
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
      box.className = 'pageguide-som-box';
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
      mark.className = 'pageguide-som-mark';
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
  const container = document.getElementById('pageguide-som-container');
  if (container) {
    container.remove();
    console.log('🏷️ SoM hidden');
  }
}

/**
 * Update SoM positions (call on scroll/resize)
 */
function updateSetOfMarks() {
  const container = document.getElementById('pageguide-som-container');
  if (!container) return;
  
  const indexMap = window._pageguideIndex || {};
  
  // Update marks
  container.querySelectorAll('.pageguide-som-mark').forEach(mark => {
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
  container.querySelectorAll('.pageguide-som-box').forEach(box => {
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
    window._pageguideSomScrollHandler = scrollHandler;
  }
  return enabled;
}

/**
 * Cleanup SoM (call when task completes)
 */
function cleanupSom() {
  hideSetOfMarks();
  
  // Remove scroll listener
  if (window._pageguideSomScrollHandler) {
    window.removeEventListener('scroll', window._pageguideSomScrollHandler);
    window._pageguideSomScrollHandler = null;
  }
}

/**
 * Draw a single Set-of-Marks-style overlay the way nanobrowser does: a real DOM box (one per
 * client rect, so wrapped/multi-line elements get several boxes) plus a numeric label, drawn as
 * fixed-position DOM so a screenshot captures the marker NATURALLY — no canvas post-processing and
 * no geometry math that can drift. Used for recap evidence markers when Vision is on.
 *
 * @param {Element|{x:number,y:number,w:number,h:number}} target - a DOM element, or a normalized
 *        viewport rect (fractions of innerWidth/innerHeight) when there is no element.
 * @param {number|string|null} number - numeric label to show (e.g. the SoM index), or null.
 * @param {string} color - accent color for the box/label.
 * @returns {HTMLElement|null} the container to pass to gv2RemoveDomMarker() after capture.
 */
function gv2DrawDomMarker(target, number, color = '#ffa657') {
  try {
    const rects = [];
    if (target && typeof target.getClientRects === 'function') {
      for (const r of target.getClientRects()) {
        if (r.width >= 2 && r.height >= 2) rects.push({ left: r.left, top: r.top, width: r.width, height: r.height });
      }
      if (!rects.length && typeof target.getBoundingClientRect === 'function') {
        const b = target.getBoundingClientRect();
        if (b.width >= 2 && b.height >= 2) rects.push({ left: b.left, top: b.top, width: b.width, height: b.height });
      }
    } else if (target && typeof target === 'object' && Number.isFinite(target.x)) {
      rects.push({
        left: target.x * window.innerWidth, top: target.y * window.innerHeight,
        width: target.w * window.innerWidth, height: target.h * window.innerHeight
      });
    }
    if (!rects.length) return null;

    const container = document.createElement('div');
    container.className = 'pageguide-evidence-marker';
    container.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483646;';
    for (const r of rects) {
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px;border:2px solid ${color};background:${color}26;box-sizing:border-box;pointer-events:none;z-index:2147483646;`;
      container.appendChild(box);
    }
    if (number != null && number !== '') {
      const first = rects[0];
      const label = document.createElement('div');
      label.textContent = String(number);
      const top = Math.max(0, first.top);
      const left = Math.max(0, Math.min(first.left, window.innerWidth - 24));
      const transform = first.left >= 24 ? 'translateX(-100%)' : 'none';
      label.style.cssText = `position:fixed;top:${top}px;left:${left}px;transform:${transform};background:${color};color:#fff;font:700 12px/1.3 sans-serif;padding:1px 5px;border-radius:4px;pointer-events:none;white-space:nowrap;z-index:2147483647;`;
      container.appendChild(label);
    }
    document.body.appendChild(container);
    return container;
  } catch (e) {
    return null;
  }
}

/** Remove a marker overlay created by gv2DrawDomMarker(). */
function gv2RemoveDomMarker(container) {
  try { if (container && typeof container.remove === 'function') container.remove(); } catch (e) { /* noop */ }
}

// ===== EVIDENCE ANNOTATIONS ON THE LIVE PAGE =====
// The annotator draws boxes/arrows/labels onto a screenshot (see _gv2DrawEvidenceAnnotationsOnCanvas
// in guidev2.js). Those marks also belong on the real page: a participant can check evidence
// against the page itself instead of trusting a picture of it. Same shapes, same colours, placed in
// DOCUMENT space so they stay put while the page scrolls.

const PAGEGUIDE_EVIDENCE_OVERLAY_ID = 'pageguide-evidence-overlay';
const PAGEGUIDE_EVIDENCE_COLOR = '#ff2d78';

/**
 * Convert a screenshot-normalized box to document coordinates.
 *
 * Annotation coordinates are fractions of the capture screenshot, i.e. of the viewport as it stood
 * when the shot was taken. `geometry` is that moment ({x,y} scroll, {w,h} viewport), recorded by
 * gv2CaptureEvidenceItems. Pure.
 *
 * @param {{x:number,y:number,w:number,h:number}} bbox - fractions 0..1
 * @param {{x:number,y:number,w:number,h:number}} geometry - scroll + viewport at capture
 * @returns {{left:number,top:number,width:number,height:number}|null} null when unusable
 */
function gv2EvidenceDocRect(bbox, geometry) {
  if (!bbox || !geometry) return null;
  const vw = Number(geometry.w);
  const vh = Number(geometry.h);
  if (!(vw > 0) || !(vh > 0)) return null;
  const x = Number(bbox.x), y = Number(bbox.y), w = Number(bbox.w), h = Number(bbox.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (!(w > 0) || !(h > 0)) return null;
  return {
    left: x * vw + (Number(geometry.x) || 0),
    top: y * vh + (Number(geometry.y) || 0),
    width: w * vw,
    height: h * vh
  };
}

/** Document-space rect of a live element (getBoundingClientRect is viewport-space). */
function gv2ElementDocRect(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return null;
  return {
    left: r.left + (window.scrollX || 0),
    top: r.top + (window.scrollY || 0),
    width: r.width,
    height: r.height
  };
}

/**
 * The anchor for one evidence item: the live element it points at, if we can still find one.
 * Preferred over stored coordinates — an element survives reflow, a fraction of a viewport does not.
 */
function gv2ResolveEvidenceElement(item) {
  if (!item) return null;
  const idx = item.visualEvidenceIndex != null ? item.visualEvidenceIndex : item.evidenceIndex;
  if (idx != null && window._pageguideIndex && window._pageguideIndex[idx]) return window._pageguideIndex[idx];
  const selector = item.selector || item.targetSelector || null;
  if (selector) {
    try { return document.querySelector(selector); } catch (e) { /* stored selector may be invalid */ }
  }
  return null;
}

/** Remove the on-page evidence marks. */
function pageguideClearEvidenceAnnotations() {
  window._pageguideEvidenceMarks = [];
  document.getElementById(PAGEGUIDE_EVIDENCE_OVERLAY_ID)?.remove();
  if (window._pageguideEvidenceKeyHandler) {
    document.removeEventListener('keydown', window._pageguideEvidenceKeyHandler, true);
    window._pageguideEvidenceKeyHandler = null;
  }
}

/**
 * Draw evidence marks over the live page.
 *
 * Each item is anchored to its element when one still resolves, otherwise placed from the geometry
 * recorded at capture time. Items with annotations get those shapes; an item with only a region
 * gets that region outlined, so bounding-box evidence is visible too.
 *
 * Deliberately motionless — no pulse, no fade — matching the on-page highlight.
 *
 * @param {Array<object>} items - captured evidence items (gv2CaptureEvidenceItems shape)
 * @returns {number} how many marks were drawn
 */
function pageguideShowEvidenceAnnotations(items) {
  pageguideClearEvidenceAnnotations();
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return 0;

  const container = document.createElement('div');
  container.id = PAGEGUIDE_EVIDENCE_OVERLAY_ID;
  container.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483645;';

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', String(Math.max(document.documentElement.scrollWidth, window.innerWidth)));
  svg.setAttribute('height', String(Math.max(document.documentElement.scrollHeight, window.innerHeight)));
  svg.style.cssText = 'position:absolute;top:0;left:0;overflow:visible;pointer-events:none;';

  let drawn = 0;
  let firstRect = null;
  // The first rect drawn for the item currently being processed, so each item can be located again
  // afterwards (window._pageguideEvidenceMarks / pageguideScrollToEvidenceMark).
  let currentItemRect = null;

  /** Remember a drawn rect as the page anchor for this item, and for the whole batch. */
  const noteRect = (rect) => {
    if (!rect) return;
    if (!firstRect) firstRect = rect;
    if (!currentItemRect) currentItemRect = rect;
  };

  const addBox = (rect, color, label, shape) => {
    if (!rect) return;
    const box = document.createElement('div');
    const radius = shape === 'ellipse' ? '50%' : '4px';
    box.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
      `border:3px solid ${color};border-radius:${radius};background:${color}1f;box-sizing:border-box;pointer-events:none;`;
    container.appendChild(box);
    if (label) {
      const tag = document.createElement('div');
      tag.textContent = label;
      tag.style.cssText = `position:absolute;left:${rect.left}px;top:${Math.max(0, rect.top - 22)}px;` +
        `background:${color};color:#fff;font:700 12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;` +
        'padding:1px 7px;border-radius:4px;white-space:nowrap;pointer-events:none;';
      container.appendChild(tag);
    }
    drawn++;
    noteRect(rect);
  };

  /** A label chip at document coordinates. */
  const addLabel = (label, x, y, color, transform = '') => {
    if (!label) return;
    const tag = document.createElement('div');
    tag.textContent = label;
    tag.style.cssText = `position:absolute;left:${x}px;top:${y}px;` +
      `background:${color};color:#fff;font:700 12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;` +
      `padding:1px 7px;border-radius:4px;white-space:nowrap;pointer-events:none;${transform ? `transform:${transform};` : ''}`;
    container.appendChild(tag);
  };

  /** Triangular arrowhead at `to`, angled along the segment from `from`. */
  const addArrowHead = (from, to, color) => {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = 14;
    const p = (a) => `${to.x - head * Math.cos(angle - a)},${to.y - head * Math.sin(angle - a)}`;
    const tri = document.createElementNS(svgNS, 'polygon');
    tri.setAttribute('points', `${to.x},${to.y} ${p(Math.PI / 7)} ${p(-Math.PI / 7)}`);
    tri.setAttribute('fill', color);
    svg.appendChild(tri);
  };

  // Free-form stroke, mirroring _gv2DrawEvidenceAnnotationsOnCanvas: the same annotation must look
  // the same in the crop and on the page.
  const addPath = (ann, color, geometry) => {
    const pts = (Array.isArray(ann?.points) ? ann.points : [])
      .map(pt => gv2EvidenceDocRect({ ...(pt || {}), w: 0.001, h: 0.001 }, geometry))
      .filter(Boolean)
      .map(r => ({ x: r.left, y: r.top }));
    if (pts.length < 2) return;
    const path = document.createElementNS(svgNS, 'path');
    let d = `M ${pts[0].x} ${pts[0].y}`;
    if (ann.curved === false || pts.length === 2) {
      for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x} ${pts[i].y}`;
    } else {
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        d += ` Q ${pts[i].x} ${pts[i].y} ${mx} ${my}`;
      }
      d += ` L ${pts[pts.length - 1].x} ${pts[pts.length - 1].y}`;
    }
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '4');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    drawn++;
    noteRect({ left: pts[0].x - 20, top: pts[0].y - 20, width: 40, height: 40 });
    if (ann.arrow === true) {
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      addArrowHead(prev, last, color);
    }
    addLabel(ann.label, pts[0].x, pts[0].y, color, 'translate(0,-140%)');
  };

  const addArrow = (from, to, color, label, withHead = true) => {
    if (!from || !to) return;
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', String(from.x)); line.setAttribute('y1', String(from.y));
    line.setAttribute('x2', String(to.x)); line.setAttribute('y2', String(to.y));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '4');
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);
    if (withHead) addArrowHead(from, to, color); // 'line' is a plain connector, 'arrow' points
    drawn++;
    noteRect({ left: to.x - 20, top: to.y - 20, width: 40, height: 40 });
    addLabel(label, (from.x + to.x) / 2, (from.y + to.y) / 2, color, 'translate(-50%,-140%)');
  };

  const marks = [];

  list.forEach((item, i) => {
    const geometry = item?.annotationGeometry || item?.captureGeometry || null;
    const el = gv2ResolveEvidenceElement(item);
    const annotations = Array.isArray(item?.annotations) ? item.annotations.slice(0, 5) : [];
    currentItemRect = null;

    if (annotations.length) {
      // Annotation coordinates are relative to the capture viewport, so they need geometry — an
      // element anchor cannot place a box that sits beside the element (an arrow, a nearby label).
      annotations.forEach((ann) => {
        const color = String(ann?.color || '').trim() || PAGEGUIDE_EVIDENCE_COLOR;
        const type = ann?.type || 'box';
        if (type === 'path') {
          addPath(ann, color, geometry);
        } else if (type === 'arrow' || type === 'line') {
          const from = gv2EvidenceDocRect({ ...(ann.from || {}), w: 0.001, h: 0.001 }, geometry);
          const to = gv2EvidenceDocRect({ ...(ann.to || {}), w: 0.001, h: 0.001 }, geometry);
          addArrow(from && { x: from.left, y: from.top }, to && { x: to.left, y: to.top }, color, ann.label, type === 'arrow');
        } else {
          addBox(gv2EvidenceDocRect(ann?.bbox, geometry), color, ann?.label, type);
        }
      });
    } else {
      // No annotations: outline the region itself, so bounding-box evidence is checkable too.
      const rect = gv2ElementDocRect(el) || gv2EvidenceDocRect(item?.region_bbox || item?.visualEvidenceNormRect, geometry);
      addBox(rect, PAGEGUIDE_EVIDENCE_COLOR, item?.note || item?.key || '', 'box');
    }

    // Keyed on the panel's chip number, so clicking [ev:N] scrolls to the mark it belongs to.
    if (currentItemRect) {
      const num = Number(item?.evidenceNumber);
      marks.push({ index: Number.isFinite(num) ? num : i + 1, rect: currentItemRect });
    }
  });

  window._pageguideEvidenceMarks = marks;

  if (!drawn) return 0;

  if (svg.childNodes.length) container.appendChild(svg);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = '× Clear evidence marks';
  dismiss.style.cssText = 'position:fixed;right:16px;bottom:16px;pointer-events:auto;background:rgba(32,26,55,.96);' +
    'color:#fff;border:1px solid rgba(255, 190, 132,.4);border-radius:999px;padding:8px 14px;' +
    'font:700 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;z-index:2147483646;';
  dismiss.addEventListener('click', (e) => { e.stopPropagation(); pageguideClearEvidenceAnnotations(); });
  container.appendChild(dismiss);

  document.body.appendChild(container);

  const onKey = (e) => { if (e.key === 'Escape') pageguideClearEvidenceAnnotations(); };
  window._pageguideEvidenceKeyHandler = onKey;
  document.addEventListener('keydown', onKey, true);

  if (firstRect) {
    const y = Math.max(0, firstRect.top - (window.innerHeight || 600) / 3);
    try { window.scrollTo({ top: y, behavior: 'smooth' }); } catch (e) { /* best-effort */ }
  }
  return drawn;
}

/**
 * Scroll the page to evidence mark `index` — the counterpart of clicking [ev:N] in the side panel.
 * The rects were recorded by pageguideShowEvidenceAnnotations; an index with no mark is a no-op, so
 * a stale message from an older answer does nothing rather than jumping somewhere arbitrary.
 *
 * Frames the mark a third of the way down, the same way the batch does after drawing.
 *
 * @param {number|string} index - the chip number shown in the panel
 * @returns {boolean} whether a mark was found and scrolled to
 */
function pageguideScrollToEvidenceMark(index) {
  const num = Number(index);
  const marks = Array.isArray(window._pageguideEvidenceMarks) ? window._pageguideEvidenceMarks : [];
  const hit = marks.find(m => Number(m?.index) === num);
  if (!hit?.rect) return false;
  const y = Math.max(0, hit.rect.top - (window.innerHeight || 600) / 3);
  try { window.scrollTo({ top: y, behavior: 'smooth' }); } catch (e) { /* best-effort */ }
  return true;
}

/**
 * The page element a citation refers to — the span it created if there is one, else the element its
 * index points at.
 *
 * One resolver for every "take me to [N]" path (hover preview, click-to-scroll), because they must
 * agree: a citation that previews the span and then scrolls to the paragraph is worse than one that
 * does neither.
 *
 * Order matters. The citation NUMBER is exact: [N:"text"] wraps its quoted words in a span stamped
 * with that number, and one paragraph routinely carries several citations sharing an index, so the
 * number is the only thing that tells them apart. The index is the fallback for a whole-element
 * highlight, and getIndexedElement the fallback for a citation that never highlighted anything.
 *
 * @param {number|string} index - the page index inside [N:"…"]
 * @param {number|string} [citation] - the citation's display number, from data-citation
 * @returns {Element|null}
 */
function pageguideResolveCitationTarget(index, citation) {
  const c = Number(citation);
  if (Number.isFinite(c)) {
    const exact = document.querySelector(`[data-pageguide-citation="${c}"]`);
    if (exact) return exact;
  }
  const n = Number(index);
  if (Number.isFinite(n)) {
    const byIndex = document.querySelector(`[data-pageguide-index="${n}"]`);
    if (byIndex) return byIndex;
  }
  return typeof getIndexedElement === 'function' ? getIndexedElement(index) : null;
}

/**
 * Mark the element a citation points at, while the pointer is over that citation in the panel.
 *
 * Clicking [N] scrolls to its span, but when the whole paragraph around it is already tinted — which
 * is what PageGuide's own block highlight does whenever it cannot match the cited text to a single
 * text node — the span it landed on is indistinguishable from everything else, and the jump reads as
 * having gone nowhere. Marking it answers "which words?" BEFORE the click.
 *
 * The mark is the page's existing "PageGuide highlight" badge and outline (content.css), not an
 * effect of its own: the reader has already been taught what that badge means, and a second visual
 * language for "this one" would be one more thing to learn.
 *
 * @param {number|string} index - the page index inside [N:"text"]
 * @param {boolean} on - false clears whatever is pulsing
 * @returns {boolean} whether an element was found to pulse
 */
function pageguidePreviewIndex(index, on, citation) {
  // One preview at a time, whichever kind: the pointer moves from a [N] to an [ev] and back.
  document.getElementById(PAGEGUIDE_PREVIEW_BOX_ID)?.remove();
  document.querySelectorAll('.' + PAGEGUIDE_PREVIEW_CLASS)
    .forEach(el => el.classList.remove(PAGEGUIDE_PREVIEW_CLASS));
  if (!on) return true;
  const el = pageguideResolveCitationTarget(index, citation);
  if (!el || !el.classList) return false;
  el.classList.add(PAGEGUIDE_PREVIEW_CLASS);
  return true;
}

/**
 * Mark the EVIDENCE a citation points at, while the pointer is over that marker in the panel.
 *
 * The text-citation preview marks an element; evidence has no element to mark — it is a region the
 * annotator drew over a picture or a slab of the page — so this draws a box over the same rect the
 * mark was drawn at and hangs the badge off it. Same badge, same outline: from the reader's side
 * "hover a number, see where it points" works the same whether the answer read it or saw it.
 *
 * @param {number|string} index - the evidence's capture number (data-evidence-num)
 * @param {boolean} on
 * @returns {boolean} whether a mark was found
 */
function pageguidePreviewEvidenceMark(index, on) {
  document.getElementById(PAGEGUIDE_PREVIEW_BOX_ID)?.remove();
  if (!on) return true;
  const num = Number(index);
  const marks = Array.isArray(window._pageguideEvidenceMarks) ? window._pageguideEvidenceMarks : [];
  const hit = marks.find(m => Number(m?.index) === num);
  if (!hit?.rect) return false;

  const box = document.createElement('div');
  box.id = PAGEGUIDE_PREVIEW_BOX_ID;
  box.className = PAGEGUIDE_PREVIEW_CLASS;
  box.style.cssText = `position:absolute;left:${hit.rect.left}px;top:${hit.rect.top}px;` +
    `width:${hit.rect.width}px;height:${hit.rect.height}px;pointer-events:none;z-index:2147483646;`;
  document.documentElement.appendChild(box);
  return true;
}

const PAGEGUIDE_PREVIEW_BOX_ID = 'pageguide-preview-box';
const PAGEGUIDE_PREVIEW_CLASS = 'pageguide-preview-target';

if (typeof window !== 'undefined') {
  window.pageguideResolveCitationTarget = pageguideResolveCitationTarget;
  window.pageguidePreviewIndex = pageguidePreviewIndex;
  window.pageguidePreviewEvidenceMark = pageguidePreviewEvidenceMark;
  window.gv2DrawDomMarker = gv2DrawDomMarker;
  window.gv2RemoveDomMarker = gv2RemoveDomMarker;
  window.gv2EvidenceDocRect = gv2EvidenceDocRect;
  window.gv2ElementDocRect = gv2ElementDocRect;
  window.gv2ResolveEvidenceElement = gv2ResolveEvidenceElement;
  window.pageguideShowEvidenceAnnotations = pageguideShowEvidenceAnnotations;
  window.pageguideClearEvidenceAnnotations = pageguideClearEvidenceAnnotations;
  window.pageguideScrollToEvidenceMark = pageguideScrollToEvidenceMark;
}

console.log('🎨 highlight.js loaded');
