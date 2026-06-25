// PageGuide - Utility Functions
// Uses accessibility-inspired approach to find ALL interactive/content elements

// Store element references globally
window._pageguideIndex = window._pageguideIndex || {};

/**
 * Return true if the element is effectively hidden and should be excluded from
 * the page index / SoM.  Uses the modern checkVisibility() API (Chrome 105+)
 * when available for a comprehensive single-call check that handles opacity,
 * content-visibility, display:none and visibility:hidden — including values
 * inherited from ancestor elements.  Falls back to manual checks on older builds.
 */
function isHiddenElement(el) {
  // HTML hidden attribute (fastest, no style lookup needed)
  if (el.hidden) return true;

  // Modern comprehensive check (Chrome 105+)
  if (typeof el.checkVisibility === 'function') {
    return !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }

  // Legacy fallback
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;

  // Zero rendered size: use OR so either dimension alone is enough to discard
  if (el.offsetWidth === 0 || el.offsetHeight === 0) return true;

  return false;
}


function isElementInteractive(el) {
  // Has click handler
  if (el.onclick || el.hasAttribute('onclick')) return true;
  
  // Cursor pointer
  const style = window.getComputedStyle(el);
  if (style.cursor === 'pointer') return true;
  
  // Has tabindex (focusable)
  if (el.hasAttribute('tabindex') && el.tabIndex >= 0) return true;
  
  return false;
}

/**
 * Check if element is noise that should be skipped in indexing
 * (Wikipedia citations, edit links, footnotes, etc.)
 */
function isNoiseElement(el, name) {
  // Only check href if element is a link
  if (el.tagName === 'A') {
    const href = el.getAttribute('href') || '';
    if (href.includes('#cite') || 
        href.includes('#ref') || 
        href.includes('#note') ||
        href.startsWith('#cite_') ||
        href.startsWith('#ref-') ||
        href.match(/^\[\d+\]$/)) { // matches [1], [2], etc.
      return true;
    }
  }
  
  return false;
}

/**
 * Get the accessible role of an element (approximates AXTree)
 */
function getAccessibleRole(el) {
  // Explicit ARIA role takes precedence
  const ariaRole = el.getAttribute('role');
  if (ariaRole) return ariaRole;
  
  // Implicit roles based on tag
  const tag = el.tagName.toLowerCase();
  const roleMap = {
    'a': el.hasAttribute('href') ? 'link' : null,
    'button': 'button',
    'input': getInputRole(el),
    'select': 'combobox',
    'textarea': 'textbox',
    'img': 'image',
    'h1': 'heading', 'h2': 'heading', 'h3': 'heading',
    'h4': 'heading', 'h5': 'heading', 'h6': 'heading',
    'p': 'paragraph',
    'li': 'listitem',
    'ul': 'list', 'ol': 'list',
    'table': 'table',
    'tr': 'row',
    'td': 'cell', 'th': 'columnheader',
    'nav': 'navigation',
    'main': 'main',
    'article': 'article',
    'aside': 'complementary',
    'footer': 'contentinfo',
    'header': 'banner',
    'form': 'form',
    'dialog': 'dialog',
    'section': 'region',
    'time': 'time',
    'mark': 'mark',
    'code': 'code',
    'pre': 'code',
    'summary': 'button',  // <details><summary> is clickable
    'menu': 'menu',
    'menuitem': 'menuitem',
    'option': 'option',
    'label': 'label',  // ← Important for form context
  };
  
  if (roleMap[tag]) return roleMap[tag]; // If role is already defined, return it
  if (isElementInteractive(el)) {
    return 'button'; // Treat as button
  }

  return null;
}

function getInputRole(el) {
  // Ensure type is a string (el.type can be an object on SVG/custom elements)
  const type = (typeof el.type === 'string' ? el.type : 'text').toLowerCase();
  const inputRoles = {
    'button': 'button',
    'submit': 'button',
    'reset': 'button',
    'checkbox': 'checkbox',
    'radio': 'radio',
    'range': 'slider',
    'search': 'searchbox',
  };
  return inputRoles[type] || 'textbox';
}

/**
 * Get accessible name of an element (what screen readers announce)
 */
function getAccessibleName(el) {
  // aria-label takes precedence
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;
  
  // aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.textContent?.trim();
  }
  
  // For inputs, check associated label
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
    const parentLabel = el.closest('label');
    if (parentLabel) return parentLabel.textContent?.trim();
  
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent?.trim();
    }
  }  
  
  // For images, use alt text
  if (el.tagName === 'IMG') {
    return el.alt || el.title || '';
  }
  
  // For buttons/links, use text content
  const text = el.textContent?.trim();
  if (text) return text;
  
  // Fallback to title or placeholder
  return el.title || el.placeholder || '';
}

/**
 * Check if element is part of PageGuide UI
 */
function isPageGuideElement(el) {
  if (!el) return false;
  return el.closest('[id^="pageguide"]') || 
         el.closest('[class*="pageguide"]') ||
         el.hasAttribute('data-pageguide-styled');
}

/**
 * Check if element is visible in viewport
 */
function isInViewport(el) {
  const rect = el.getBoundingClientRect();
  return (
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * Get ALL page content as text using accessibility approach
 * Walks entire DOM and extracts accessible names
 * Falls back to innerText for SPAs with minimal accessible content
 */
function getVisibleText(maxLength = 20000) {
  const lines = [];
  const seen = new Set();
  
  // Walk ALL elements
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);

  let el;
  while ((el = walker.nextNode())) {
    // Skip our UI
    if (isPageGuideElement(el)) continue;
    
    // Skip hidden
    try {
      if (isHiddenElement(el)) continue;
    } catch (e) { continue; }
    
    // Get accessible role and name
    const role = getAccessibleRole(el);
    if (!role) continue;
    
    let name = getAccessibleName(el);
    if (!name || name.length < 2) continue;
    
    // Clean up
    name = name.replace(/\s+/g, ' ').trim();

    // Only skip duplicates for non-interactive elements
    if (!isElementInteractive(el) && seen.has(name)) continue;
    seen.add(name);
    
    // Format based on role for better LLM understanding
    if (role === 'button') {
      lines.push(`[Button: ${name}]`);
    } else if (role === 'link') {
      lines.push(`${name} (link)`);
    } else if (role === 'textbox' || role === 'searchbox') {
      lines.push(`[Input: ${name}]`);
    } else if (role === 'image') {
      lines.push(`[Image: ${name}]`);
    } else {
      lines.push(name);
    }
  }
  
  let result = lines.join('\n');
  
  // Fallback for SPAs: if we got very little content, use innerText
  // This handles React/Vue/Angular apps where accessibility tree is sparse
  if (result.length < 200) {
    console.log('🤖 Sparse accessible content, falling back to innerText');
    
    // Get raw innerText, clean it up
    let innerTextContent = document.body.innerText || '';
    
    // Remove excessive whitespace
    innerTextContent = innerTextContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');
    
    // If innerText is more useful, use it
    if (innerTextContent.length > result.length) {
      result = '[Page text (SPA fallback)]:\n' + innerTextContent;
    }
  }
  
  return result.length > maxLength ? result.slice(0, maxLength) + '...' : result;
}

/**
 * Create indexed list of ALL elements using accessibility-inspired approach
 * No predefined selectors - walks entire DOM and uses accessible roles
 * Returns: { indexText, indexMap, count }
 */
/**
 * Roles that correspond to interactive widgets.
 * Used by createPageIndex when interactiveOnly=true.
 */
const _INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'slider',
  'searchbox', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'treeitem', 'listbox', 'menu', 'dialog',
  'alertdialog', 'gridcell',
]);

/**
 * Return a short landmark label for the element's nearest landmark ancestor.
 * Used to annotate the page index text so the LLM can distinguish navigation
 * links from main-content links (e.g. "[nav] History" vs "[main] Video title").
 */
function _getLandmarkLabel(el) {
  let node = el.parentElement;
  while (node && node !== document.body) {
    const tag = node.tagName?.toLowerCase();
    const role = node.getAttribute?.('role');
    if (role === 'navigation' || tag === 'nav') return '[nav]';
    if (role === 'banner'     || tag === 'header') return '[header]';
    if (role === 'complementary' || tag === 'aside') return '[sidebar]';
    if (role === 'dialog' || role === 'alertdialog') return '[dialog]';
    if (role === 'main' || tag === 'main') return '[main]';
    node = node.parentElement;
  }
  return '';
}

function createPageIndex(maxItems = 200, interactiveOnly = false) {
  const indexMap = {};
  const indexLines = [];
  let idx = 1;
  
  const seen = new Set();
  const seenText = new Set();
  
  // Helper to walk a root element
  function walkRoot(root) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          // Skip our UI
          if (isPageGuideElement(node)) return NodeFilter.FILTER_REJECT;

          // Skip hidden (opacity:0, display:none, visibility:hidden, el.hidden, zero-size, etc.)
          if (isHiddenElement(node)) return NodeFilter.FILTER_REJECT;

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    return walker;
  }
  
  // Walk main document body
  const walker = walkRoot(document.body);
  
  let el;
  while ((el = walker.nextNode()) && idx <= maxItems) {
    // Skip our UI
    if (isPageGuideElement(el)) continue;
    
    // Skip already seen
    if (seen.has(el)) continue;
    
    // Skip hidden elements
    try {
      if (isHiddenElement(el)) continue;
    } catch (e) { continue; }
    
    // Get accessible role - if no role, skip (not interesting)
    const role = getAccessibleRole(el);
    if (!role) continue;

    // In interactive-only mode (used by the guide), skip purely structural/text
    // elements (headings, paragraphs, list items, etc.) so the LLM index only
    // contains elements the user can actually click or type into.
    if (interactiveOnly && !_INTERACTIVE_ROLES.has(role) && !isElementInteractive(el)) continue;

    // Get accessible name
    let name = getAccessibleName(el);
    if (!name || name.length < 2) continue;

    // Clean up
    name = name.replace(/\s+/g, ' ').trim();

    // Only skip duplicates for non-interactive elements
    if (!isElementInteractive(el) && seenText.has(name)) continue;
    
    // Skip common noise elements
    if (isNoiseElement(el, name)) continue;
    
    seen.add(el);
    seenText.add(name);
    
    // Store element
    indexMap[idx] = el;
    
    // Truncate long text
    const maxLen = (role === 'paragraph' || role === 'article') ? 300 : 120;
    const displayText = name.length > maxLen ? name.slice(0, maxLen) + '...' : name;

    // In guide mode use a clean format: just the index and text.
    // In find/hide mode keep the role annotation for LLM context.
    if (interactiveOnly) {
      indexLines.push(`[${idx}] ${displayText}`);
    } else {
      indexLines.push(`[${idx}] (${role}) ${displayText}`);
    }
    idx++;
  }
  
  // Second pass: Look for popup/overlay containers that might have menus
  // YouTube, Google, and many SPAs render popups in special containers
  const popupSelectors = [
    '[role="menu"]',
    '[role="dialog"]',
    '[role="listbox"]',
    'ytd-popup-container',
    'ytd-menu-popup-renderer',
    'tp-yt-iron-dropdown',
    '[class*="popup"]',
    '[class*="dropdown"]',
    '[class*="menu"][style*="display: block"]',
    '[class*="menu"][style*="visibility: visible"]',
    '[aria-expanded="true"]',
    '.MuiMenu-paper',
    '.MuiPopover-paper',
    '[data-radix-popper-content-wrapper]'
  ];
  
  const processElement = (el) => {
    if (idx > maxItems) return;
    if (isPageGuideElement(el)) return;
    if (seen.has(el)) return;
    
    try {
      if (isHiddenElement(el)) return;
    } catch (e) { return; }

    const role = getAccessibleRole(el);
    if (!role) return;

    let name = getAccessibleName(el);
    if (!name || name.length < 2) return;
    name = name.replace(/\s+/g, ' ').trim();

    if (!isElementInteractive(el) && seenText.has(name)) return;
    if (name === 'edit' || name === '[edit]' || name.includes('#cite')) return;
    
    seen.add(el);
    seenText.add(name);
    indexMap[idx] = el;
    
    const maxLen = (role === 'paragraph' || role === 'article') ? 300 : 120;
    const displayText = name.length > maxLen ? name.slice(0, maxLen) + '...' : name;
    indexLines.push(`[${idx}] (${role}) ${displayText}`);
    idx++;
  };
  
  // Find popup containers and their children
  popupSelectors.forEach(selector => {
    try {
      document.querySelectorAll(selector).forEach(popup => {
        // Process the popup itself
        processElement(popup);
        // Process all children with roles
        popup.querySelectorAll('[role], button, a, [tabindex]').forEach(processElement);
      });
    } catch (e) { /* invalid selector */ }
  });
  
  // Third pass: Social media text containers
  // Facebook, X/Twitter, and LinkedIn all use dir="auto"/"ltr" on post/tweet text
  // containers, but those elements carry no ARIA role and are skipped by the
  // main accessibility-tree walk above. Index them directly so the LLM can cite
  // the exact paragraph instead of a distant parent.
  const socialMediaSelectors = [
    '[data-testid="tweetText"]',   // X/Twitter tweet body
    '[data-testid="tweet-text"]',  // X/Twitter alternative
    'div[dir="auto"]',             // Facebook / X / LinkedIn post text
    'div[dir="ltr"]',              // LinkedIn post text
    'span[dir="auto"]',            // Nested social media text
    'span[dir="ltr"]',             // LinkedIn span containers
  ];

  socialMediaSelectors.forEach(selector => {
    if (idx > maxItems) return;
    try {
      document.querySelectorAll(selector).forEach(el => {
        if (idx > maxItems) return;
        if (isPageGuideElement(el)) return;
        if (seen.has(el)) return;

        try {
          if (isHiddenElement(el)) return;
        } catch (e) { return; }

        let name = (el.textContent || '').replace(/\s+/g, ' ').trim();

        // Only index meaningful text blocks — skip buttons, tiny labels, and huge
        // feed-level containers (those are already caught by article/section above).
        if (name.length < 30 || name.length > 1500) return;
        if (seenText.has(name)) return;

        seen.add(el);
        seenText.add(name);
        indexMap[idx] = el;

        const displayText = name.length > 300 ? name.slice(0, 300) + '...' : name;
        indexLines.push(`[${idx}] (paragraph) ${displayText}`);
        idx++;
      });
    } catch (e) { /* invalid selector */ }
  });

  // SPA Fallback: If we found very few elements, try broader selectors
  // This helps with React/Vue/Angular apps that may not have proper accessibility
  if (idx < 10) {
    console.log('🤖 Few elements found, trying SPA fallback selectors');
    
    // Common interactive elements in SPAs
    const spaSelectors = [
      'button', 'a', 'input', 'textarea', 'select',
      '[onclick]', '[data-testid]', '[data-cy]',
      'svg', 'img[alt]',
      'h1', 'h2', 'h3', 'h4', 'p',
      'span[class]', 'div[class*="button"]', 'div[class*="btn"]',
      '[class*="icon"]', '[class*="menu"]', '[class*="nav"]'
    ];
    
    spaSelectors.forEach(selector => {
      if (idx > maxItems) return;
      try {
        document.querySelectorAll(selector).forEach(el => {
          if (idx > maxItems) return;
          if (seen.has(el)) return;
          if (isPageGuideElement(el)) return;
          
          let name = el.textContent?.trim() || el.getAttribute('aria-label') || 
                     el.getAttribute('alt') || el.getAttribute('title') || '';
          name = name.replace(/\s+/g, ' ').trim();
          
          if (name.length < 2 || name.length > 200) return;
          if (seenText.has(name)) return;
          
          seen.add(el);
          seenText.add(name);
          indexMap[idx] = el;
          
          const tag = el.tagName.toLowerCase();
          indexLines.push(`[${idx}] (${tag}) ${name.slice(0, 100)}`);
          idx++;
        });
      } catch (e) { /* invalid selector */ }
    });
  }
  
  // Store globally
  window._pageguideIndex = indexMap;
  
  console.log('🤖 Indexed', idx - 1, 'elements (including fallbacks)');
  console.log('🤖 Index keys stored:', Object.keys(indexMap).slice(0, 10), '...');
  
  return {
    indexText: indexLines.join('\n'),
    indexMap: indexMap,
    count: idx - 1
  };
}

/**
 * Get element by index number
 */
function getIndexedElement(idx) {
  return window._pageguideIndex[idx] || null;
}

/**
 * Match a stored target text against a page index's `indexText` to find the element index
 * to act on during Rewind action-replay. Lines look like "[3] Sign in" (guide/interactive
 * mode) or "[3] (button) Sign in" (annotated mode). Returns the numeric index of the best
 * match, or null when none is good enough.
 *
 * Strategy (most → least strict): exact normalized equality → one is a prefix of the other
 * (handles "…" truncation) → substring containment. Pure + exported so it is unit-testable.
 *
 * @param {string} indexText - the `indexText` from createPageIndex
 * @param {string} target - the stored target.text to locate
 * @returns {number|null}
 */
function gv2MatchIndexText(indexText, target) {
  const norm = (s) => String(s == null ? '' : s).replace(/\.\.\.$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(target);
  if (!want || !indexText) return null;

  const rows = [];
  String(indexText).split('\n').forEach((line) => {
    const m = line.match(/^\s*\[(\d+)\]\s*(?:\([^)]*\)\s*)?(.*)$/);
    if (m) rows.push({ idx: parseInt(m[1], 10), text: norm(m[2]) });
  });
  if (!rows.length) return null;

  // 1) exact
  for (const r of rows) if (r.text === want) return r.idx;
  // 2) prefix either direction (truncation-tolerant)
  for (const r of rows) if (r.text && (r.text.startsWith(want) || want.startsWith(r.text))) return r.idx;
  // 3) containment
  for (const r of rows) if (r.text && (r.text.includes(want) || want.includes(r.text))) return r.idx;
  return null;
}
if (typeof window !== 'undefined') window.gv2MatchIndexText = gv2MatchIndexText;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2MatchIndexText = gv2MatchIndexText;

/**
 * Expand truncated social media posts and other "show more" content before indexing.
 * Clicks visible expand buttons (See more, Show more, Read more, etc.) silently.
 * Returns a promise that resolves after all clicks + a short settle delay.
 */
async function expandTruncatedContent() {
  // X/Twitter: "Show more" on a tweet is a JS-driven navigation to the tweet's permalink
  // (via history.pushState / React Router), NOT an inline expand. It is rendered as a
  // <span role="button"> with no href, so the anchor-href check below can't catch it.
  // Clicking it during an LLM call kills the message channel → error. Skip entirely.
  //
  // Google Search: AI Overview "Show more" / "See more" buttons are also JS-driven and
  // can navigate the tab to a different page or expand in a way that triggers navigation.
  const _h = window.location.hostname;
  if (_h === 'x.com' || _h === 'twitter.com' ||
      _h.endsWith('.x.com') || _h.endsWith('.twitter.com') ||
      _h === 'google.com' || _h.endsWith('.google.com')) {
    return;
  }

  // Text patterns that indicate a "show more" / expand trigger (case-insensitive).
  // Kept intentionally conservative — patterns that could match navigation links are excluded.
  // Removed: /^more$/i          → matches X/Twitter sidebar "More" (navigates)
  // Removed: /^see more replies$/i → matches X/Twitter reply-count link (navigates to tweet page)
  // Removed: /^load more$/i     → triggers infinite-scroll pagination (can cause navigation)
  // Removed: /^expand$/i        → too generic
  const expandPatterns = [
    /^see more$/i,
    /^show more$/i,
    /^read more$/i,
    /^view more$/i,
    /^see full post$/i,
    /^\.\.\.\s*more$/i,
    /^continue reading$/i,
  ];

  // Tags that can be expand triggers
  const candidateTags = new Set(['button', 'a', 'span', 'div']);

  // Structural ancestors that indicate a navigation context.
  // Elements inside these should never be auto-clicked.
  const isInsideNav = (node) => {
    let p = node.parentElement;
    while (p && p !== document.body) {
      const t = p.tagName.toLowerCase();
      if (t === 'nav' || t === 'header' || t === 'footer' || t === 'aside') return true;
      const r = p.getAttribute('role');
      if (r === 'navigation' || r === 'banner' || r === 'complementary') return true;
      p = p.parentElement;
    }
    return false;
  };

  // Walk all visible interactive-ish elements and collect matches
  const toClick = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let el;
  while ((el = walker.nextNode())) {
    // Skip extension-own elements
    if (el.classList?.contains('pageguide') || el.id?.startsWith('pageguide')) continue;

    const tag = el.tagName.toLowerCase();
    if (!candidateTags.has(tag)) continue;

    // Must be visible
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

    // Must look interactive (role, tag, or cursor)
    const role = el.getAttribute('role');
    const isInteractive =
      tag === 'button' ||
      tag === 'a' ||
      role === 'button' ||
      role === 'link' ||
      style.cursor === 'pointer';
    if (!isInteractive) continue;

    // Skip <a> tags that point to a different URL path — those are navigation links,
    // not inline expand buttons. Real expanders are buttons or href-less anchors.
    if (tag === 'a' && el.href) {
      try {
        const dest = new URL(el.href);
        const here = new URL(window.location.href);
        if (dest.origin !== here.origin || dest.pathname !== here.pathname) continue;
      } catch (e) { /* ignore URL parse errors */ }
    }

    // Skip elements inside nav / header / footer / sidebar
    if (isInsideNav(el)) continue;

    // Match text
    const text = (el.innerText || el.textContent || '').trim();
    if (text.length === 0 || text.length > 40) continue; // Expand buttons are short labels
    if (expandPatterns.some(re => re.test(text))) {
      toClick.push(el);
    }
  }

  if (toClick.length === 0) return;

  console.log('🤖 expandTruncatedContent: clicking', toClick.length, 'expand button(s)');

  for (const btn of toClick) {
    try {
      btn.click();
    } catch (e) {
      // ignore
    }
    // Small delay between clicks so the DOM can update
    await new Promise(r => setTimeout(r, 120));
  }

  // Final settle delay so expanded content is in the DOM before indexing
  await new Promise(r => setTimeout(r, 300));
}

/**
 * Serialize the current page into a static, self-contained HTML string for the
 * Rewind inspector (Slice 1).
 *
 * outerHTML alone is NOT enough: live form values (what the user/agent typed),
 * checkbox/radio/select state, and contenteditable content are runtime properties
 * that do not appear in serialized markup. We clone the tree and copy those values
 * onto the clone so the snapshot shows the page exactly as it looked after the step.
 *
 * The result is rendered READ-ONLY in a sandboxed <iframe> with no script execution,
 * so we strip <script> tags here as defense-in-depth.
 *
 * Known fidelity gaps (documented intentionally): cross-origin stylesheets/images may
 * not load under the iframe sandbox/CSP; shadow DOM and <canvas> pixels are not
 * captured; lazy/virtualized content reflects only what was mounted at capture time.
 *
 * @param {Element} [rootEl] - root to serialize (default <html>); injectable for tests
 * @param {string}  [baseHref] - base URL for resolving relative asset URLs
 * @returns {string} a full HTML document string
 */
function gv2SerializeDom(rootEl, baseHref) {
  rootEl = rootEl || (typeof document !== 'undefined' ? document.documentElement : null);
  if (!rootEl) return '';
  if (!baseHref) {
    if (typeof document !== 'undefined' && document.baseURI) baseHref = document.baseURI;
    else if (typeof location !== 'undefined' && location.href) baseHref = location.href;
    else baseHref = '';
  }

  const ownerDoc = rootEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const clone = rootEl.cloneNode(true);

  // Copy runtime values outerHTML omits. cloneNode preserves order, so we can zip the
  // live controls with their clones by index using the same selector on both trees.
  const SEL = 'input, textarea, select, [contenteditable]';
  const live = rootEl.querySelectorAll(SEL);
  const copy = clone.querySelectorAll(SEL);
  for (let i = 0; i < live.length; i++) {
    const l = live[i];
    const c = copy[i];
    if (!c) continue;
    const tag = l.tagName;
    if (tag === 'INPUT') {
      const type = (l.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (l.checked) c.setAttribute('checked', ''); else c.removeAttribute('checked');
      } else if (type === 'password') {
        // Privacy: never serialize password values into a stored snapshot.
        c.setAttribute('value', '');
      } else {
        c.setAttribute('value', l.value != null ? l.value : '');
      }
    } else if (tag === 'TEXTAREA') {
      c.textContent = l.value != null ? l.value : '';
    } else if (tag === 'SELECT') {
      const lOpts = l.querySelectorAll('option');
      const cOpts = c.querySelectorAll('option');
      for (let j = 0; j < cOpts.length; j++) {
        if (lOpts[j] && lOpts[j].selected) cOpts[j].setAttribute('selected', '');
        else cOpts[j].removeAttribute('selected');
      }
    } else {
      // contenteditable (true / "")
      const ce = l.getAttribute('contenteditable');
      const editable = (typeof l.isContentEditable === 'boolean' && l.isContentEditable) || ce === '' || ce === 'true';
      if (editable) c.innerHTML = l.innerHTML;
    }
  }

  // Strip scripts — the inspector iframe runs without allow-scripts, but remove anyway.
  clone.querySelectorAll('script').forEach(s => s.remove());

  // Inject a single <base> so relative CSS/image URLs resolve against the original page.
  if (ownerDoc) {
    const head = clone.querySelector('head');
    if (head) {
      head.querySelectorAll('base').forEach(b => b.remove());
      const base = ownerDoc.createElement('base');
      base.setAttribute('href', baseHref);
      head.insertBefore(base, head.firstChild);
    }
  }

  return '<!DOCTYPE html>\n' + clone.outerHTML;
}

if (typeof window !== 'undefined') window.gv2SerializeDom = gv2SerializeDom;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2SerializeDom = gv2SerializeDom;

/**
 * Build a best-effort, reasonably stable selector for a form field so its value can be
 * re-applied on a fresh load (rewind/resume). Prefers id, then name. Returns null when
 * neither exists — such fields are skipped (we can't reliably re-target them).
 */
function gv2FieldSelector(el) {
  if (!el || !el.tagName) return null;
  const esc = (s) => (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1');
  if (el.id) return '#' + esc(el.id);
  const name = el.getAttribute && el.getAttribute('name');
  if (name) return el.tagName.toLowerCase() + '[name="' + String(name).replace(/"/g, '\\"') + '"]';
  return null;
}

/** Set a value into an input/textarea using the native setter + input/change events. */
function gv2SetFieldValue(el, text) {
  if (!el) return;
  try { el.focus(); } catch (e) {}
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
  if (setter) setter.call(el, text); else el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Capture the page's restorable state for the rewind/resume feature: web storage, scroll
 * position, and visible form-field values. Lets a later restore on a fresh load
 * rebuild the page's condition much closer to how it was when the step ran — without keeping
 * a live tab around. All reads are best-effort (cross-origin / disabled storage throws);
 * password values are intentionally excluded (privacy, mirrors gv2SerializeDom).
 *
 * @param {Window}  [win]  - window to read storage/scroll from (injectable for tests)
 * @param {Element} [root] - root to scan for form fields (default <html>; injectable for tests)
 * @returns {{localStorage:object, sessionStorage:object, scroll:{x:number,y:number}, forms:Array}}
 */
function gv2CaptureRestoreState(win, root) {
  win = win || (typeof window !== 'undefined' ? window : null);
  root = root || (win && win.document ? win.document.documentElement : (typeof document !== 'undefined' ? document.documentElement : null));
  const out = { localStorage: {}, sessionStorage: {}, scroll: { x: 0, y: 0 }, forms: [] };
  if (!win) return out;

  const readStore = (store, into) => {
    try {
      for (let i = 0; i < store.length; i++) { const k = store.key(i); into[k] = store.getItem(k); }
    } catch (e) { /* storage may be cross-origin or disabled */ }
  };
  try { if (win.localStorage) readStore(win.localStorage, out.localStorage); } catch (e) {}
  try { if (win.sessionStorage) readStore(win.sessionStorage, out.sessionStorage); } catch (e) {}

  try { out.scroll = { x: win.scrollX || 0, y: win.scrollY || 0 }; } catch (e) {}

  try {
    if (root && root.querySelectorAll) {
      root.querySelectorAll('input, textarea, select').forEach(el => {
        const sel = gv2FieldSelector(el);
        if (!sel) return;
        const tag = el.tagName;
        if (tag === 'INPUT') {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (type === 'checkbox' || type === 'radio') out.forms.push({ sel, checked: !!el.checked });
          else if (type === 'password') { /* never store secrets */ }
          else out.forms.push({ sel, value: el.value != null ? el.value : '' });
        } else if (tag === 'TEXTAREA') {
          out.forms.push({ sel, value: el.value != null ? el.value : '' });
        } else if (tag === 'SELECT') {
          out.forms.push({ sel, selectedIndex: el.selectedIndex });
        }
      });
    }
  } catch (e) { /* form scan is best-effort */ }

  return out;
}

/**
 * Re-apply a state captured by gv2CaptureRestoreState onto the current (freshly loaded) page.
 * Every step is best-effort and isolated in try/catch — a single failure (quota, missing
 * field) must never abort the resume. Returns a small tally for logging/tests.
 *
 * @param {object}  restore - shape produced by gv2CaptureRestoreState
 * @param {Window}  [win]   - window to write storage/scroll to (injectable for tests)
 * @param {Element} [root]  - root to scope form re-targeting (default <html>; injectable)
 * @param {Array}   [log]   - if provided, one entry per applied item is pushed for the
 *                            restore action log (verification / inspector). Shape:
 *                            { kind:'localStorage'|'sessionStorage'|'form'|'scroll', key?, sel?, value?, ok }
 * @returns {{localStorage:number, sessionStorage:number, forms:number, scroll:boolean}}
 */
function gv2ApplyRestoreState(restore, win, root, log) {
  win = win || (typeof window !== 'undefined' ? window : null);
  root = root || (win && win.document ? win.document.documentElement : (typeof document !== 'undefined' ? document.documentElement : null));
  const applied = { localStorage: 0, sessionStorage: 0, forms: 0, scroll: false };
  const rec = Array.isArray(log) ? (e) => { try { log.push(e); } catch (_) {} } : () => {};
  if (!restore || !win) return applied;

  const writeStore = (store, from, kind) => {
    if (!store || !from) return;
    Object.keys(from).forEach(k => {
      let ok = false;
      try { store.setItem(k, from[k]); applied[kind]++; ok = true; } catch (e) {}
      rec({ kind, key: k, value: from[k], ok });
    });
  };
  try { writeStore(win.localStorage, restore.localStorage, 'localStorage'); } catch (e) {}
  try { writeStore(win.sessionStorage, restore.sessionStorage, 'sessionStorage'); } catch (e) {}

  try {
    if (Array.isArray(restore.forms) && root && root.querySelector) {
      restore.forms.forEach(f => {
        if (!f || !f.sel) return;
        let el = null;
        try { el = root.querySelector(f.sel); } catch (e) {}
        if (!el) { rec({ kind: 'form', sel: f.sel, value: _gv2FormValue(f), ok: false }); return; }
        let ok = false;
        try {
          if (el.tagName === 'SELECT' && f.selectedIndex != null) {
            el.selectedIndex = f.selectedIndex;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            applied.forms++; ok = true;
          } else if (f.checked != null) {
            el.checked = !!f.checked;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            applied.forms++; ok = true;
          } else if (f.value != null) {
            gv2SetFieldValue(el, f.value);
            applied.forms++; ok = true;
          }
        } catch (e) { /* one field's failure must not abort the rest */ }
        rec({ kind: 'form', sel: f.sel, value: _gv2FormValue(f), ok });
      });
    }
  } catch (e) {}

  try {
    if (restore.scroll && typeof win.scrollTo === 'function') {
      win.scrollTo(restore.scroll.x || 0, restore.scroll.y || 0);
      applied.scroll = true;
      rec({ kind: 'scroll', value: (restore.scroll.x || 0) + ',' + (restore.scroll.y || 0), ok: true });
    }
  } catch (e) {}

  return applied;
}

/** Normalize a captured form field to a printable value (for the restore log). */
function _gv2FormValue(f) {
  if (!f) return '';
  if (f.checked != null) return f.checked ? 'checked' : 'unchecked';
  if (f.selectedIndex != null) return 'option#' + f.selectedIndex;
  return f.value != null ? f.value : '';
}

/**
 * Format one restore/replay log entry as a short human-readable line for the panel confirm
 * card and the inspector. Pure (no DOM) so it's unit-testable.
 *
 * @param {object} e - { kind, key?, sel?, action?, value?, ok }
 * @returns {string}
 */
function gv2DescribeRestoreAction(e) {
  if (!e || !e.kind) return '';
  const mark = e.ok === false ? '✗' : '✓';
  const val = (e.value != null && e.value !== '') ? ' → "' + String(e.value) + '"' : '';
  switch (e.kind) {
    case 'note':           return `${mark} ${e.value != null ? e.value : ''}`.trimEnd();
    case 'localStorage':   return `${mark} localStorage[${e.key}]${val}`;
    case 'sessionStorage': return `${mark} sessionStorage[${e.key}]${val}`;
    case 'scroll':         return `${mark} Scroll to ${e.value}`;
    case 'form':           return `${mark} Set ${e.sel}${val}`;
    case 'replay': {
      const tgt = e.sel || (e.target && e.target.text) || e.target || 'element';
      const verb = ({ type: 'Type into', clear_text: 'Clear text in', select: 'Select in', check: 'Toggle', toggle: 'Toggle' })[e.action] || 'Click';
      return `${mark} ${verb} ${typeof tgt === 'string' ? tgt : JSON.stringify(tgt)}${val}`;
    }
    default:               return `${mark} ${e.kind}${val}`;
  }
}

const _GV2_HIDDEN_RESTORE_FIELD_RE = /\b(cf-chl|captcha|challenge|token|csrf|recaptcha|hcaptcha|turnstile)\b/i;

function gv2IsHiddenRestoreField(e) {
  if (!e || e.kind !== 'form') return false;
  const haystack = [e.sel, e.key, e.name, e.id].filter(Boolean).join(' ');
  return _GV2_HIDDEN_RESTORE_FIELD_RE.test(haystack);
}

function gv2TruncateRestoreText(value, max = 72) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function gv2FriendlySelectorName(sel) {
  const s = String(sel == null ? '' : sel).trim();
  if (!s) return 'saved field';
  const clean = s
    .replace(/^#/, '')
    .replace(/^\[name=["']?([^"'\]]+)["']?\]$/, '$1')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || clean.length > 48 || /[>#:[\]]/.test(clean)) return 'saved field';
  return clean;
}

function gv2RestoreTechnicalDetail(e) {
  if (!e || !e.kind) return '';
  const copy = { ...e };
  ['key', 'sel', 'value'].forEach(k => {
    if (copy[k] != null) copy[k] = gv2TruncateRestoreText(copy[k]);
  });
  if (copy.target && typeof copy.target === 'object') {
    copy.target = { ...copy.target };
    if (copy.target.text != null) copy.target.text = gv2TruncateRestoreText(copy.target.text);
  }
  return gv2DescribeRestoreAction(copy);
}

function gv2FriendlyRestoreAction(e) {
  if (!e || !e.kind) return '';
  const ok = e.ok !== false;
  switch (e.kind) {
    case 'note':
      return String(e.value || '').replace(/^✓\s*/, '').trim();
    case 'localStorage':
    case 'sessionStorage':
      return ok ? 'Restored saved page settings' : 'Skipped saved page settings';
    case 'scroll':
      return ok ? 'Restored scroll position' : 'Could not restore scroll position';
    case 'form':
      if (gv2IsHiddenRestoreField(e)) {
        return ok ? 'Restored hidden page security state' : 'Skipped a hidden page security field';
      }
      return ok ? `Restored “${gv2FriendlySelectorName(e.sel)}” field` : `Could not restore “${gv2FriendlySelectorName(e.sel)}” field`;
    case 'replay': {
      const target = gv2TruncateRestoreText((e.target && e.target.text) || e.sel || e.target || 'the target');
      const action = String(e.action || 'click').toLowerCase();
      if (action === 'type') return ok ? `Filled “${target}”` : `Fill “${target}” did not apply`;
      if (action === 'clear_text') return ok ? `Cleared “${target}”` : `Clear “${target}” did not apply`;
      if (action === 'select') return ok ? `Selected “${target}”` : `Select “${target}” did not apply`;
      if (action === 'check' || action === 'toggle') return ok ? `Toggled “${target}”` : `Toggle “${target}” did not apply`;
      if (/\b(menu|dropdown|settings|panel)\b/i.test(target)) return ok ? `Opened “${target}”` : `Open “${target}” did not apply`;
      return ok ? `Clicked “${target}”` : `Click “${target}” did not apply`;
    }
    default:
      return ok ? `Restored ${e.kind}` : `Could not restore ${e.kind}`;
  }
}

/**
 * Summarize the first concrete restore action that failed into a short user-facing error, e.g.
 * "⚠ Couldn't apply: Click Idiomas". Returns '' when nothing actionable failed. `note` entries
 * are advisory and never counted as a hard failure. Pure (no DOM) so it's unit-testable.
 *
 * @param {Array<object>} log - restore log entries ({ kind, ok, ... })
 * @returns {string}
 */
function gv2RestoreErrorSummary(log) {
  if (!Array.isArray(log)) return '';
  const failed = log.filter(e => e && e.ok === false && e.kind && e.kind !== 'note');
  if (!failed.length) return '';
  const actionable = failed.find(e => !gv2IsHiddenRestoreField(e));
  if (!actionable) {
    return 'Some hidden page state could not be restored. This can happen when the site regenerates security fields.';
  }
  const what = gv2FriendlyRestoreAction(actionable) || 'Some page state could not be restored';
  return `${what}. Retry, continue if the page looks right, or tell the agent what is missing.`;
}

if (typeof window !== 'undefined') {
  window.gv2FieldSelector = gv2FieldSelector;
  window.gv2SetFieldValue = gv2SetFieldValue;
  window.gv2CaptureRestoreState = gv2CaptureRestoreState;
  window.gv2ApplyRestoreState = gv2ApplyRestoreState;
  window.gv2DescribeRestoreAction = gv2DescribeRestoreAction;
  window.gv2FriendlyRestoreAction = gv2FriendlyRestoreAction;
  window.gv2RestoreTechnicalDetail = gv2RestoreTechnicalDetail;
  window.gv2IsHiddenRestoreField = gv2IsHiddenRestoreField;
  window.gv2RestoreErrorSummary = gv2RestoreErrorSummary;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports.gv2FieldSelector = gv2FieldSelector;
  module.exports.gv2SetFieldValue = gv2SetFieldValue;
  module.exports.gv2CaptureRestoreState = gv2CaptureRestoreState;
  module.exports.gv2ApplyRestoreState = gv2ApplyRestoreState;
  module.exports.gv2DescribeRestoreAction = gv2DescribeRestoreAction;
  module.exports.gv2FriendlyRestoreAction = gv2FriendlyRestoreAction;
  module.exports.gv2RestoreTechnicalDetail = gv2RestoreTechnicalDetail;
  module.exports.gv2IsHiddenRestoreField = gv2IsHiddenRestoreField;
  module.exports.gv2RestoreErrorSummary = gv2RestoreErrorSummary;
}

/**
 * Map a step's LLM confidence (0–1, "how sure the model is that this step + element are correct",
 * judged from the pre-action screenshot/DOM + the chosen action) to a timeline status tier.
 * Two tiers only — there is intentionally NO red tier for confidence.
 *
 * @param {number} confidence - normalized 0..1, or null/NaN if unavailable
 * @returns {'high'|'med'|null} 'high' (≥0.7, green), 'med' (<0.7, yellow), null (unknown)
 */
function gv2ConfidenceTier(confidence) {
  if (typeof confidence !== 'number' || !isFinite(confidence)) return null;
  return confidence >= 0.7 ? 'high' : 'med';
}

// Weights for the decomposed confidence formula. Tunable here (not exposed in the UI).
const GV2_LAMBDA_L = 0.8;   // loop penalty weight
const GV2_LAMBDA_P = 0.3;   // progress reward/penalty weight

/**
 * Combine the three LLM-assessed signals into a single confidence score. Three formula versions:
 *   full:    C = clip(G · (1 − λ_L·L) · (1 + λ_P·P), 0, 1)   (all three signals)
 *   reduced: C = clip(G · (1 − λ_L·L), 0, 1)                 (no progress term)
 *   noloop:  C = clip(G · (1 + λ_P·P), 0, 1)                 (no loop term)
 *
 * Pure (no DOM/storage) so it is unit-testable. Inputs are clamped to their valid ranges:
 * G (grounded) ∈ [0,1], L (loop) ∈ [0,1], P (progress) ∈ [-1,1]. When grounded is missing
 * (not a finite number) the score is null so callers can fall back to legacy confidence.
 *
 * @param {{grounded:number, loop:number, progress:number}} parts - raw LLM component scores
 * @param {'full'|'reduced'|'noloop'} [formula='full'] - which formula version to apply
 * @param {{lambdaL?:number, lambdaP?:number}} [weights] - optional weight overrides
 * @returns {{confidence:number|null, grounded:number|null, loop:number, progress:number, formula:string}}
 */
function gv2ComputeConfidence(parts, formula = 'full', weights) {
  const clip01 = v => Math.max(0, Math.min(1, v));
  const num = (v, lo, hi, dflt) => (typeof v === 'number' && isFinite(v)) ? Math.max(lo, Math.min(hi, v)) : dflt;
  const G = num(parts?.grounded, 0, 1, null);
  const L = num(parts?.loop, 0, 1, 0);
  const P = num(parts?.progress, -1, 1, 0);
  const lamL = (weights && typeof weights.lambdaL === 'number') ? weights.lambdaL : GV2_LAMBDA_L;
  const lamP = (weights && typeof weights.lambdaP === 'number') ? weights.lambdaP : GV2_LAMBDA_P;
  if (G == null) return { confidence: null, grounded: null, loop: L, progress: P, formula };
  const useLoop = formula !== 'noloop';        // every version except 'noloop' applies the loop penalty
  const useProgress = formula !== 'reduced';   // every version except 'reduced' applies the progress term
  let c = G;
  if (useLoop) c = c * (1 - lamL * L);
  if (useProgress) c = c * (1 + lamP * P);
  return { confidence: clip01(c), grounded: G, loop: L, progress: P, formula };
}

// ───────────────────────────────────────────────────────────────────────────
// Mechanical ("no-LLM") step confidence
//
// An alternative to the LLM self-reported confidence above. Instead of asking the
// model to grade its own action, we derive confidence purely from execution signals
// that target the two failure modes mechanical signals can actually detect — element
// MISGROUNDING and action LOOPING:
//
//   C_t = clip( G_grounding × (1 − λ_L × L_t),  0, 1 )
//
//   G_grounding ∈ {0, 0.1, 0.5, 1.0} from element-step cosine similarity:
//   no valid element index → 0.0; similarity ≥ 0.8 → 1.0; ≥ 0.5 → 0.5;
//   otherwise → 0.1. Scroll/done/initial steps are excluded (null).
//   L_t         ∈ [0, 1]         fraction of prior target-bearing steps with the same element key
//   λ_L                          loop penalty weight (default 0.5)
//
// Steps with no element target (e.g. a `done` step) are EXCLUDED: grounding is null,
// confidence is null, and they are omitted from the loop denominator. Pure (no DOM /
// storage) so they're unit-testable.
// ───────────────────────────────────────────────────────────────────────────

const GV2_GROUNDING_LAMBDA_L = 0.5; // loop penalty weight for the mechanical formula
const GV2_NON_GROUNDING_ACTIONS = new Set(['scroll', 'scroll_up', 'scroll_down', 'done']);
const GV2_ELEMENT_GROUNDING_HIGH_THRESHOLD = 0.84;
const GV2_ELEMENT_GROUNDING_MEDIUM_THRESHOLD = 0.78;

/**
 * Element grounding score (G_ground). Matches eval `g_grounding()` after the
 * live step computes cosine(step instruction, target element text).
 *
 * @param {{action?:string, isInitial?:boolean, hasIndex?:boolean, elementStepSimilarity?:number|null}} parts
 * @returns {number|null}
 */
function gv2GroundingScore(parts) {
  if (!parts || parts.isInitial) return null;
  const action = String(parts.action || '').trim().toLowerCase();
  if (GV2_NON_GROUNDING_ACTIONS.has(action)) return null;
  if (!parts.hasIndex) return 0.0;
  const raw = Number(parts.elementStepSimilarity);
  if (!Number.isFinite(raw)) return 1.0; // back-compat for old callers
  const relevance = Math.round(Math.max(0, Math.min(1, raw)) * 100) / 100;
  if (relevance >= GV2_ELEMENT_GROUNDING_HIGH_THRESHOLD) return 1.0;
  if (relevance >= GV2_ELEMENT_GROUNDING_MEDIUM_THRESHOLD) return 0.5;
  return 0.1;
}

/**
 * Loop score for the current step: the fraction of PREVIOUS actions that share this
 * step's action key. L_t = |{ prev : key(prev) == key_t }| / |prev|.
 *
 * Faithful port of the reference `compute_loop_score`: the denominator is the number
 * of previous actions (every prior step, not just target-bearing ones), with no +1.
 * Returns 0.0 when there are no previous actions or the current step has no key.
 *
 * @param {string[]} priorKeys - action keys of every prior step (in order)
 * @param {string} currentKey  - action key of the current step
 * @returns {number} loop fraction in [0,1]
 */
function gv2LoopScore(priorKeys, currentKey) {
  const prior = Array.isArray(priorKeys) ? priorKeys : [];
  if (prior.length === 0) return 0.0;
  if (!currentKey) return 0.0;
  const matches = prior.filter(k => k === currentKey).length;
  return Math.min(1.0, matches / 10);
}

/**
 * Combine the mechanical grounding + loop signals into a single confidence score.
 * Returns null (excluded step) when grounding is null.
 *
 * @param {{action?:string, hasIndex?:boolean, elementStepSimilarity?:number|null, priorKeys:string[], currentKey:string}} parts
 * @param {{lambdaL?:number}} [weights]
 * @returns {{confidence:number|null, grounding:number|null, loop:number|null}}
 */
function gv2ComputeMechanicalConfidence(parts, weights) {
  const clip01 = v => Math.max(0, Math.min(1, v));
  const lamL = (weights && typeof weights.lambdaL === 'number') ? weights.lambdaL : GV2_GROUNDING_LAMBDA_L;
  const grounding = gv2GroundingScore(parts);
  if (grounding == null) return { confidence: null, grounding: null, loop: null };
  const loop = gv2LoopScore(parts?.priorKeys, parts?.currentKey) ?? 0;
  return { confidence: clip01(grounding * (1 - lamL * loop)), grounding, loop };
}

/**
 * Derive the loop "action key" for a step: normalized action type plus the first
 * non-empty element/action text. When no action is supplied, preserves the older
 * text-only key for compatibility with tests and historical callers.
 *
 * @param {{element?:{text?:string, desc?:string}, description?:string, instruction?:string}} step
 * @returns {string} normalized action key, or '' when none
 */
function gv2ElementKey(step) {
  if (!step) return '';
  const el = step.element || {};
  const candidates = [el.text, el.desc, step.description, step.instruction];
  const action = step.action ? String(step.action).trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  for (const v of candidates) {
    if (v && String(v).trim()) {
      const text = String(v).trim().toLowerCase();
      return action ? `${action}: ${text}` : text;
    }
  }
  return '';
}

/**
 * Compute the source-crop rectangle (in IMAGE pixels) for cropping a viewport screenshot down to
 * an element's region. `captureVisibleTab` returns an image at devicePixelRatio scale while
 * getBoundingClientRect is in CSS px, so we scale by dpr and clamp to the image bounds. Pure
 * (no DOM/canvas) so it's unit-testable.
 *
 * @param {{left:number,top:number,width:number,height:number}} rect - element CSS-px rect
 * @param {number} dpr   - devicePixelRatio (default 1)
 * @param {number} imgW  - screenshot width in image px
 * @param {number} imgH  - screenshot height in image px
 * @param {number} [pad] - extra CSS-px padding around the element (default 8)
 * @returns {{sx:number,sy:number,sw:number,sh:number}|null} crop in image px, or null if invalid
 */
function gv2CropRect(rect, dpr, imgW, imgH, pad) {
  if (!rect) return null;
  const scale = (typeof dpr === 'number' && dpr > 0) ? dpr : 1;
  pad = (typeof pad === 'number' && pad >= 0) ? pad : 8;
  const W = (typeof imgW === 'number' && imgW > 0) ? imgW : 0;
  const H = (typeof imgH === 'number' && imgH > 0) ? imgH : 0;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const left = (rect.left - pad) * scale;
  const top = (rect.top - pad) * scale;
  const w = (rect.width + pad * 2) * scale;
  const h = (rect.height + pad * 2) * scale;
  const sx = clamp(Math.round(left), 0, W);
  const sy = clamp(Math.round(top), 0, H);
  const sw = clamp(Math.round(w), 0, W - sx);
  const sh = clamp(Math.round(h), 0, H - sy);
  if (sw <= 0 || sh <= 0) return null;
  return { sx, sy, sw, sh };
}

/**
 * Pick the DOM node whose bounds should define the target-region crop.
 * Prefer the visible highlight span/element over the full indexed container.
 */
function gv2ResolveRegionElement(rootDoc) {
  const doc = rootDoc || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;
  const highlights = (typeof window !== 'undefined' && window._pageguideHighlights) || [];
  for (const node of highlights) {
    if (node && doc.contains(node)) return node;
  }
  const g = typeof window !== 'undefined' ? window._guidev2 : null;
  if (g?.currentTargetEl && doc.contains(g.currentTargetEl)) return g.currentTargetEl;
  return doc.querySelector('[data-pageguide-styled]');
}

/**
 * Element whose bounds should define the target-region crop for storage/inspector.
 * Prefer the resolved click target (currentTargetEl) so the crop matches the action.
 */
function gv2ResolveRegionTarget(rootDoc) {
  const doc = rootDoc || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;
  const g = typeof window !== 'undefined' ? window._guidev2 : null;
  if (g?.currentTargetEl && doc.contains(g.currentTargetEl)) return g.currentTargetEl;
  return gv2ResolveRegionElement(doc);
}

/**
 * Prompt for predicting the final goal STATE (used for goal-relevance embedding).
 * Mirrors eval_tool/step_confidence.py SpecProgressClient.predict_goal.
 */
function gv2BuildPredictFinalGoalPrompt(task, url) {
  const taskText = task != null ? String(task).trim() : '';
  const urlText = url != null ? String(url).trim() : '';
  return (
    'Predict the final goal STATE for this browser task in one concise sentence '
    + 'describing what the page should show when the task is complete.\n\n'
    + `Task: ${taskText}\n`
    + `Website: ${urlText}\n\n`
    + 'Return only the sentence, no preamble.'
  );
}

/** Cosine similarity in [0, 1] when vectors are non-zero (raw cosine may be negative). */
function gv2CosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return null;
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Math.max(0, Math.min(1, sim));
}

if (typeof window !== 'undefined') {
  window.gv2ConfidenceTier = gv2ConfidenceTier;
  window.gv2ComputeConfidence = gv2ComputeConfidence;
  window.gv2GroundingScore = gv2GroundingScore;
  window.gv2LoopScore = gv2LoopScore;
  window.gv2ComputeMechanicalConfidence = gv2ComputeMechanicalConfidence;
  window.gv2ElementKey = gv2ElementKey;
  window.gv2CropRect = gv2CropRect;
  window.gv2ResolveRegionElement = gv2ResolveRegionElement;
  window.gv2ResolveRegionTarget = gv2ResolveRegionTarget;
  window.gv2BuildPredictFinalGoalPrompt = gv2BuildPredictFinalGoalPrompt;
  window.gv2CosineSimilarity = gv2CosineSimilarity;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports.gv2ConfidenceTier = gv2ConfidenceTier;
  module.exports.gv2ComputeConfidence = gv2ComputeConfidence;
  module.exports.gv2GroundingScore = gv2GroundingScore;
  module.exports.gv2LoopScore = gv2LoopScore;
  module.exports.gv2ComputeMechanicalConfidence = gv2ComputeMechanicalConfidence;
  module.exports.gv2ElementKey = gv2ElementKey;
  module.exports.GV2_LAMBDA_L = GV2_LAMBDA_L;
  module.exports.GV2_LAMBDA_P = GV2_LAMBDA_P;
  module.exports.GV2_GROUNDING_LAMBDA_L = GV2_GROUNDING_LAMBDA_L;
  module.exports.gv2CropRect = gv2CropRect;
  module.exports.gv2ResolveRegionElement = gv2ResolveRegionElement;
  module.exports.gv2ResolveRegionTarget = gv2ResolveRegionTarget;
  module.exports.gv2BuildPredictFinalGoalPrompt = gv2BuildPredictFinalGoalPrompt;
  module.exports.gv2CosineSimilarity = gv2CosineSimilarity;
}

/**
 * Tolerant JSON-object extractor for LLM responses (shared by guidev2 plan,
 * confidence, and verification parsing). Handles ```json fences, leading/trailing
 * prose, and returns null on malformed input instead of throwing.
 *
 * @param {string} content - raw LLM text
 * @returns {object|null} parsed object, or null if none could be parsed
 */
function gv2ExtractJsonObject(content) {
  if (content == null) return null;
  let json = String(content).trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  const m = json.match(/\{[\s\S]*\}/);
  if (m) json = m[0];

  const escapeJsonVal = (str) => {
    return str.trim()
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  };

  // Fix 1: Missing colon and quotes after key, e.g. "thought The user wants..."
  json = json.replace(/("(?:thought|instruction|riskReason))(\s+[\s\S]*?)("\s*,\s*"(?:step|instruction|element|action|typeText|isLastStep|confidence|grounded|loop|progress|risk|riskReason|confirmation)"\s*:)/g, (match, key, val, next) => {
    return `${key}": "${escapeJsonVal(val)}` + next;
  });

  // Fix 2: Missing quotes on value, e.g. "thought": The user wants..."
  json = json.replace(/("(?:thought|instruction|riskReason)"\s*:\s*)([a-zA-Z][\s\S]*?)("\s*,\s*"(?:step|instruction|element|action|typeText|isLastStep|confidence|grounded|loop|progress|risk|riskReason|confirmation)"\s*:)/g, (match, keyCol, val, next) => {
    return `${keyCol}"${escapeJsonVal(val)}` + next;
  });

  try { return JSON.parse(json); } catch (e) {
    try {
      // Fix 3: Escape unescaped double quotes in middle of double-quoted text fields
      let fixedJson = json.replace(/("(?:thought|instruction|riskReason)"\s*:\s*")([\s\S]*?)("\s*,\s*"(?:step|instruction|element|action|typeText|isLastStep|confidence|grounded|loop|progress|risk|riskReason|confirmation)"\s*:)/g, (match, prefix, val, suffix) => {
        const escapedVal = val.replace(/(?<!\\)"/g, '\\"');
        return prefix + escapedVal + suffix;
      });
      return JSON.parse(fixedJson);
    } catch (err) {
      return null;
    }
  }
}

if (typeof window !== 'undefined') window.gv2ExtractJsonObject = gv2ExtractJsonObject;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2ExtractJsonObject = gv2ExtractJsonObject;

function gv2BuildRestoreComparePrompt(ctx = {}) {
  const step = ctx.redoStep != null ? ctx.redoStep : 'the selected';
  const goal = ctx.newGoal ? `\nUser redirection: ${ctx.newGoal}` : '';
  return `Compare two screenshots for PageGuide's restore check.

Image 1 is the saved target state before step ${step}.
Image 2 is the current page after PageGuide tried to restore that state.${goal}

Decide whether the visible page state has been restored closely enough for the user to continue.
Focus only on visible UI state: open menus/dialogs, selected options, filled visible fields, scroll position, and visible page location.
Ignore hidden security fields, tokens, analytics IDs, and anything that cannot be seen in the screenshots.

Return JSON only:
{
  "summary": "one short sentence",
  "restored": ["short visible thing that appears restored"],
  "notRestored": ["short visible thing missing or different"],
  "recommendation": "one sentence telling the user whether to continue, retry, or describe what is missing",
  "confidence": 0.0
}`;
}

function gv2ParseRestoreComparison(content) {
  const obj = gv2ExtractJsonObject(content);
  const asList = (v) => Array.isArray(v)
    ? v.map(x => gv2TruncateRestoreText(x, 140)).filter(Boolean).slice(0, 5)
    : [];
  if (!obj) {
    return {
      summary: gv2TruncateRestoreText(content || 'Could not parse the comparison.', 220),
      restored: [],
      notRestored: [],
      recommendation: 'Review the screenshots manually before continuing.',
      confidence: null
    };
  }
  const confidence = (typeof obj.confidence === 'number' && isFinite(obj.confidence))
    ? Math.max(0, Math.min(1, obj.confidence))
    : null;
  return {
    summary: gv2TruncateRestoreText(obj.summary || 'Comparison complete.', 220),
    restored: asList(obj.restored),
    notRestored: asList(obj.notRestored),
    recommendation: gv2TruncateRestoreText(obj.recommendation || 'Review the result before continuing.', 220),
    confidence
  };
}

if (typeof window !== 'undefined') {
  window.gv2BuildRestoreComparePrompt = gv2BuildRestoreComparePrompt;
  window.gv2ParseRestoreComparison = gv2ParseRestoreComparison;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports.gv2BuildRestoreComparePrompt = gv2BuildRestoreComparePrompt;
  module.exports.gv2ParseRestoreComparison = gv2ParseRestoreComparison;
}

// Patterns for actions that are sensitive or hard to undo. Used to ESCALATE a step's
// risk so the agent never auto-performs these in autonomous mode, even if the model
// reported "low". Defense-in-depth: we trust the model to flag risk, but never rely on
// it alone for safety.
const _GV2_RISKY_PATTERN = /\b(delete|remove|permanently|pay|buy|purchase|checkout|place\s+order|order\s+now|transfer|withdraw|deposit|password|log\s?out|sign\s?out|deactivate|unsubscribe|close\s+account|cancel\s+subscription|send|post|publish|submit\s+payment)\b/i;

/**
 * Decide whether a guide step is safe to auto-perform in autonomous mode.
 * Returns 'low' (reversible/routine — agent may auto-do) or 'high' (hand to user).
 *
 * Effective risk = max(model self-assessment, deterministic heuristic). The heuristic
 * can only escalate to 'high', never downgrade.
 *
 * @param {object} step - parsed step (may include risk, instruction, typeText, element)
 * @returns {'low'|'high'}
 */
function gv2AssessRisk(step) {
  if (!step) return 'low';
  if (step.risk === 'high') return 'high';
  const text = [
    step.instruction,
    step.typeText,
    step.value,              // canonical ACT value (Slice 5) — carries typed/selected text
    step.element && step.element.text,
    step.riskReason
  ].filter(Boolean).join(' ');
  if (_GV2_RISKY_PATTERN.test(text)) return 'high';
  return 'low';
}

if (typeof window !== 'undefined') window.gv2AssessRisk = gv2AssessRisk;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2AssessRisk = gv2AssessRisk;

/**
 * Compute the visual state of each timeline dot, indexed by PLAN step, aggregating the
 * concrete step records that belong to each plan step. Pure & DOM-free so it is unit-
 * testable and fixes the plan-vs-concrete-step conflation that left dots stuck gray.
 *
 * @param {object} args
 * @param {Array}  args.plan          - [{n, goal}] high-level plan (may be empty)
 * @param {Array}  args.records       - [{step, planStep, confidence, grounding, verification}]
 * @param {object} args.verifications - map: concrete-step|plan-step -> {status}
 * @param {number} args.current       - current plan step (1-based)
 * @param {boolean} args.guideActive  - false once the guide has finished
 * @returns {Array<{step:number, status:'done'|'current'|'pending', review:boolean, verify:('success'|'failed'|'blocked'|null)}>}
 */
function gv2DotState(args) {
  const a = args || {};
  const plan = Array.isArray(a.plan) ? a.plan : [];
  const records = Array.isArray(a.records) ? a.records : [];
  const verifications = a.verifications || {};
  const current = Number(a.current) || 0;
  const active = a.guideActive !== false; // default active unless explicitly false

  // Timeline is indexed by CONCRETE step (one dot per step the agent takes), so the dot
  // count always matches the "Step X of N" text. The plan length is only a lower bound (an
  // estimate of how many steps the task needs before any have run).
  let maxStep = 0;
  for (const r of records) {
    const n = Number(r.step) || 0;
    if (n > maxStep) maxStep = n;
  }
  const total = Math.max(plan.length, maxStep, current, records.length);

  const recOf = (i) => records.find(r => Number(r.step) === i) || null;
  const isLow = (x) => x != null && x < 0.5;

  const out = [];
  for (let i = 1; i <= total; i++) {
    const r = recOf(i);
    let status;
    if (i < current) status = 'done';
    else if (i === current) status = active ? 'current' : 'done';
    else status = 'pending';
    if (!active && i <= current) status = 'done'; // finished guide: everything up to current done

    const review = !!(r && (isLow(r.confidence) || isLow(r.grounding)));
    const verify = (verifications[i] && verifications[i].status) ||
                   (r && r.verification && r.verification.status) || null;
    out.push({ step: i, status, review, verify });
  }
  return out;
}

if (typeof window !== 'undefined') window.gv2DotState = gv2DotState;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2DotState = gv2DotState;

// ===== GUIDE STEP NUMBER NORMALIZATION =====

/**
 * The LLM may infer hidden/implicit steps and return a non-sequential `step` value
 * (e.g. Step 3 immediately after Step 1). Runtime-owned concrete step numbers must
 * stay contiguous so stored trajectories do not have missing Step 2/6/8 gaps.
 */
function gv2NormalizeStepNumber(step, previousSteps) {
  const count = Array.isArray(previousSteps) ? previousSteps.length : 0;
  const expectedStep = count + 1;
  const raw = step && step.step;
  const llmStep = Number.isFinite(Number(raw)) ? Number(raw) : null;
  const stepNumberCorrected = llmStep !== expectedStep;
  return {
    expectedStep,
    llmStep,
    stepNumberCorrected
  };
}

if (typeof window !== 'undefined') window.gv2NormalizeStepNumber = gv2NormalizeStepNumber;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2NormalizeStepNumber = gv2NormalizeStepNumber;

// ===== AUTO-MODE GATE HELPERS (Gate 2: state-change check) =====

/**
 * Cheap, deterministic string hash (djb2). Folds the page index text into a compact
 * signature. Pure & DOM-free.
 */
function _gv2HashStr(s) {
  let h = 5381;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Compact signature of the current page state (URL + interactive count + hash of the index
 * text). Equal signatures ⇒ the page did not meaningfully change. Pure & DOM-free.
 *
 * @param {object} pageIndex - { count, indexText } from createPageIndex
 * @param {string} url - window.location.href at capture time
 * @returns {string}
 */
function gv2PageSignature(pageIndex, url) {
  const count = (pageIndex && typeof pageIndex.count === 'number') ? pageIndex.count : 0;
  const text = (pageIndex && pageIndex.indexText) ? pageIndex.indexText : '';
  return `${url || ''}|${count}|${_gv2HashStr(text)}`;
}

if (typeof window !== 'undefined') window.gv2PageSignature = gv2PageSignature;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2PageSignature = gv2PageSignature;

/**
 * Gate 2: did the page change between two signatures? Returns true when it changed
 * (signatures differ). Unknown signatures fail OPEN (return true) so we never falsely flag
 * a step as "stuck". Pure & DOM-free.
 */
function gv2StateChanged(prevSig, curSig) {
  if (!prevSig || !curSig) return true;
  return prevSig !== curSig;
}

if (typeof window !== 'undefined') window.gv2StateChanged = gv2StateChanged;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2StateChanged = gv2StateChanged;
