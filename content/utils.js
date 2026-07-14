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
      const dest = e.dropTarget && (e.dropTarget.text || e.dropTarget);
      if (String(e.action || '').toLowerCase() === 'drag_drop') {
        return `${mark} Drag ${typeof tgt === 'string' ? tgt : JSON.stringify(tgt)} to ${dest ? (typeof dest === 'string' ? dest : JSON.stringify(dest)) : 'drop target'}`;
      }
      const verb = ({ type: 'Type into', select: 'Select in', check: 'Toggle', toggle: 'Toggle' })[e.action] || 'Click';
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
      if (action === 'select') return ok ? `Selected “${target}”` : `Select “${target}” did not apply`;
      if (action === 'check' || action === 'toggle') return ok ? `Toggled “${target}”` : `Toggle “${target}” did not apply`;
      if (action === 'drag_drop') {
        const dest = gv2TruncateRestoreText((e.dropTarget && e.dropTarget.text) || e.dropTarget || 'the drop target');
        return ok ? `Dragged “${target}” to “${dest}”` : `Drag “${target}” to “${dest}” did not apply`;
      }
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
 * @returns {'high'|'med'|null} 'high' (≥threshold, green), 'med' (<threshold, yellow), null (unknown)
 */
function gv2ConfidenceTier(confidence, threshold = 0.7) {
  if (typeof confidence !== 'number' || !isFinite(confidence)) return null;
  const t = (typeof threshold === 'number' && isFinite(threshold))
    ? Math.max(0, Math.min(1, threshold))
    : 0.7;
  return confidence >= t ? 'high' : 'med';
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
// Confidence is derived from two execution signals:
//   C_t = clip( grounding × (1 − 0.5 × loopFraction), 0, 1 )
//
//   grounding    ∈ [0, 1] cosine similarity between the LLM element text and the
//                actual accessible text of the resolved DOM element.
//   loopFraction ∈ [0, 1] number of previous matching DOM element texts / 10.
//
// Steps with no element target (e.g. a `done` step) are excluded.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Loop score for the current step: the fraction of PREVIOUS actions that share this
 * step's normalized DOM element text, divided by 10.
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
  return Math.min(1, matches / 10);
}

const GV2_LOOP_PENALTY = 0.5;

function gv2CosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return null;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (!isFinite(x) || !isFinite(y)) return null;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  if (aa <= 0 || bb <= 0) return null;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(aa) * Math.sqrt(bb))));
}

function gv2GroundingScore(parts) {
  if (!parts || !parts.hasTarget) return null;
  const v = parts.grounding;
  if (typeof v !== 'number' || !isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * Combine the mechanical grounding + loop signals into a single confidence score.
 * Returns null (excluded step) when grounding is null.
 *
 * @param {{hasTarget:boolean, grounding:number, priorKeys:string[], currentKey:string}} parts
 * @returns {{confidence:number|null, grounding:number|null, loop:number|null, loopMatches:number}}
 */
function gv2ComputeMechanicalConfidence(parts) {
  const clip01 = v => Math.max(0, Math.min(1, v));
  if (!parts || !parts.hasTarget) return { confidence: null, grounding: null, loop: null, loopMatches: 0 };
  const grounding = (typeof parts.grounding === 'number' && isFinite(parts.grounding))
    ? clip01(parts.grounding)
    : 0;
  const prior = Array.isArray(parts.priorKeys) ? parts.priorKeys : [];
  const currentKey = parts.currentKey || '';
  const loopMatches = currentKey ? prior.filter(k => k === currentKey).length : 0;
  const loop = gv2LoopScore(parts?.priorKeys, parts?.currentKey) ?? 0;
  return { confidence: clip01(grounding * (1 - GV2_LOOP_PENALTY * loop)), grounding, loop, loopMatches };
}

/**
 * Derive the loop "action key" for a step: the first non-empty of the element text,
 * element description, description, or instruction, stripped + lowercased. Faithful
 * port of the reference `_action_key` — text-based, NOT page-scoped and NOT index-based.
 * Two steps loop when this string matches. Returns '' when none (excluded by loop score).
 *
 * @param {{element?:{text?:string, desc?:string}, description?:string, instruction?:string}} step
 * @returns {string} normalized action key, or '' when none
 */
function gv2ElementKey(step) {
  if (!step) return '';
  const el = step.element || {};
  const candidates = [el.text, el.desc, step.description, step.instruction];
  for (const v of candidates) {
    if (v && String(v).trim()) return String(v).trim().toLowerCase();
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

// Normalize a viewport-CSS-px target rect to [0,1] fractions of the viewport, so a marker box can
// be drawn on a full-viewport screenshot regardless of devicePixelRatio (captureVisibleTab spans
// exactly the viewport). Returns { x, y, w, h } clamped to [0,1], or null on bad input.
function gv2TargetNormRect(rect, viewportW, viewportH) {
  if (!rect) return null;
  const W = Number(viewportW), H = Number(viewportH);
  if (!(W > 0) || !(H > 0)) return null;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const x = clamp01((Number(rect.left) || 0) / W);
  const y = clamp01((Number(rect.top) || 0) / H);
  const w = clamp01((Number(rect.width) || 0) / W);
  const h = clamp01((Number(rect.height) || 0) / H);
  // Don't let the box spill past the right/bottom edge.
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}

// Normalize a viewport-CSS-px target rect to [0,1] fractions WITHIN a regionShot crop, given the
// crop { sx, sy, sw, sh } (image px) and devicePixelRatio used to produce it. Lets a marker box be
// drawn on the cropped thumbnail. Returns { x, y, w, h } clamped to [0,1], or null on bad input.
function gv2RegionMarkerRect(rect, crop, dpr) {
  if (!rect || !crop) return null;
  const scale = (typeof dpr === 'number' && dpr > 0) ? dpr : 1;
  const sw = Number(crop.sw), sh = Number(crop.sh);
  if (!(sw > 0) || !(sh > 0)) return null;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  // Element position in image px, relative to the crop origin.
  const mx = (Number(rect.left) || 0) * scale - (Number(crop.sx) || 0);
  const my = (Number(rect.top) || 0) * scale - (Number(crop.sy) || 0);
  const mw = (Number(rect.width) || 0) * scale;
  const mh = (Number(rect.height) || 0) * scale;
  const x = clamp01(mx / sw);
  const y = clamp01(my / sh);
  return { x, y, w: Math.min(clamp01(mw / sw), 1 - x), h: Math.min(clamp01(mh / sh), 1 - y) };
}

if (typeof window !== 'undefined') {
  window.gv2ConfidenceTier = gv2ConfidenceTier;
  window.gv2ComputeConfidence = gv2ComputeConfidence;
  window.gv2GroundingScore = gv2GroundingScore;
  window.gv2CosineSimilarity = gv2CosineSimilarity;
  window.gv2LoopScore = gv2LoopScore;
  window.gv2ComputeMechanicalConfidence = gv2ComputeMechanicalConfidence;
  window.gv2ElementKey = gv2ElementKey;
  window.gv2CropRect = gv2CropRect;
  window.gv2TargetNormRect = gv2TargetNormRect;
  window.gv2RegionMarkerRect = gv2RegionMarkerRect;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports.gv2ConfidenceTier = gv2ConfidenceTier;
  module.exports.gv2ComputeConfidence = gv2ComputeConfidence;
  module.exports.gv2GroundingScore = gv2GroundingScore;
  module.exports.gv2CosineSimilarity = gv2CosineSimilarity;
  module.exports.gv2LoopScore = gv2LoopScore;
  module.exports.gv2ComputeMechanicalConfidence = gv2ComputeMechanicalConfidence;
  module.exports.gv2ElementKey = gv2ElementKey;
  module.exports.GV2_LAMBDA_L = GV2_LAMBDA_L;
  module.exports.GV2_LAMBDA_P = GV2_LAMBDA_P;
  module.exports.GV2_LOOP_PENALTY = GV2_LOOP_PENALTY;
  module.exports.gv2CropRect = gv2CropRect;
  module.exports.gv2TargetNormRect = gv2TargetNormRect;
  module.exports.gv2RegionMarkerRect = gv2RegionMarkerRect;
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
  json = json.replace(/("(?:thought|instruction|riskReason|answer))(\s+[\s\S]*?)("\s*,\s*"(?:step|instruction|element|dropTarget|evidence|visualEvidence|confirmationEvidence|action|typeText|url|findQuery|answer|isLastStep|confidence|grounded|loop|progress|risk|riskReason|confirmation)"\s*:)/g, (match, key, val, next) => {
    return `${key}": "${escapeJsonVal(val)}` + next;
  });

  // Fix 2: Missing quotes on value, e.g. "thought": The user wants..."
  json = json.replace(/("(?:thought|instruction|riskReason|answer)"\s*:\s*)([a-zA-Z][\s\S]*?)("\s*,\s*"(?:step|instruction|element|dropTarget|evidence|visualEvidence|confirmationEvidence|action|typeText|url|findQuery|answer|isLastStep|confidence|grounded|loop|progress|risk|riskReason|confirmation)"\s*:)/g, (match, keyCol, val, next) => {
    return `${keyCol}"${escapeJsonVal(val)}` + next;
  });

  try { return JSON.parse(json); } catch (e) {
    try {
      // Fix 3: Escape unescaped double quotes in middle of double-quoted text fields
      let fixedJson = json.replace(/("(?:thought|instruction|riskReason|answer)"\s*:\s*")([\s\S]*?)("\s*,\s*"(?:step|instruction|element|dropTarget|evidence|visualEvidence|confirmationEvidence|action|typeText|url|findQuery|answer|isLastStep|confidence|grounded|loop|progress|risk|riskReason|confirmation)"\s*:)/g, (match, prefix, val, suffix) => {
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

  // Finding reads the page and highlights text; it never mutates the DOM or submits
  // anything, so it stays low risk even if the goal mentions a sensitive keyword
  // (e.g. "find out how to delete your account"). visual_highlight is likewise read-only —
  // it just crops a screenshot region to show the user.
  if (step.action === 'find' || step.action === 'visual_highlight' || step.action === 'save_evidence' || step.action === 'finish') return 'low';

  if (step.risk === 'high') return 'high';

  // Clearing a text field is inherently a safe, reversible client-side action.
  if (step.action === 'clear_text') return 'low';

  const text = [
    step.instruction,
    step.typeText,
    step.value,              // canonical ACT value (Slice 5) — carries typed/selected text
    step.element && step.element.text,
    step.dropTarget && step.dropTarget.text,
    step.riskReason
  ].filter(Boolean).join(' ');

  // Filter out safe phrases that contain risky words (e.g. "remove the search text", "delete the input")
  // so they don't falsely trigger the high-risk scanner.
  const safeText = text.replace(/\b(delete|remove)\b(?=\s+(the\s+)?(text|search|input|query|field|entry|content|filter)\b)/gi, '');

  const match = safeText.match(_GV2_RISKY_PATTERN);
  if (match) {
    step.riskReason = `Safety scanner detected sensitive keyword: "${match[0]}"`;
    return 'high';
  }
  return 'low';
}

if (typeof window !== 'undefined') window.gv2AssessRisk = gv2AssessRisk;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2AssessRisk = gv2AssessRisk;

/**
 * Normalize a raw LLM action string to its canonical form.
 *
 * @param {string} action
 * @param {boolean} isLastStep - used to pick the default when action is missing
 * @returns {string}
 */
function gv2NormalizeAction(action, isLastStep = false) {
  const raw = String(action || (isLastStep ? 'finish' : 'click')).trim();
  const norm = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if (norm === 'done') return 'finish';
  if (norm === 'navigate' || norm === 'go_to_url' || norm === 'goto_url' || norm === 'open_url') return 'goto_url';
  if (norm === 'watch_video' || norm === 'watch_youtube') return 'watch_video';
  return norm;
}

if (typeof window !== 'undefined') window.gv2NormalizeAction = gv2NormalizeAction;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2NormalizeAction = gv2NormalizeAction;

/**
 * Normalize a normalized bounding box { x, y, w, h } (fractions of the screenshot) — clamps each
 * component to 0..1 and requires a positive width and height. Returns the rect or null.
 *
 * @param {object} r
 * @returns {{x:number, y:number, w:number, h:number}|null}
 */
function gv2NormalizeRect(r) {
  if (!r || typeof r !== 'object') return null;
  const clamp = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null; };
  const x = clamp(r.x), y = clamp(r.y), w = clamp(r.w), h = clamp(r.h);
  if (x == null || y == null || w == null || h == null) return null;
  if (!(w > 0) || !(h > 0)) return null;
  return { x, y, w, h };
}

if (typeof window !== 'undefined') window.gv2NormalizeRect = gv2NormalizeRect;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2NormalizeRect = gv2NormalizeRect;

function gv2NormalizeEvidenceKey(key) {
  const raw = String(key == null ? '' : key).trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw) ? raw : '';
}

function gv2NormalizeEvidenceBbox(box) {
  if (!box || typeof box !== 'object') return null;
  const round = (v) => Number(Number(v).toFixed(6));
  const viewportSize = () => {
    try {
      if (typeof window !== 'undefined') {
        const vw = Number(window.innerWidth);
        const vh = Number(window.innerHeight);
        if (Number.isFinite(vw) && vw > 0 && Number.isFinite(vh) && vh > 0) return { vw, vh };
      }
    } catch (e) {}
    return { vw: 0, vh: 0 };
  };
  if (Array.isArray(box) && box.length >= 4) {
    box = { x: box[0], y: box[1], w: box[2], h: box[3] };
  }
  const firstDefined = (...vals) => vals.find(v => v != null && v !== '');
  const xRaw = firstDefined(box.x, box.left, box.l, box.x1);
  const yRaw = firstDefined(box.y, box.top, box.t, box.y1);
  let wRaw = firstDefined(box.w, box.width);
  let hRaw = firstDefined(box.h, box.height);
  const x2 = firstDefined(box.x2, box.right, box.r);
  const y2 = firstDefined(box.y2, box.bottom, box.b);
  if ((wRaw == null || wRaw === '') && x2 != null && xRaw != null) wRaw = Number(x2) - Number(xRaw);
  if ((hRaw == null || hRaw === '') && y2 != null && yRaw != null) hRaw = Number(y2) - Number(yRaw);
  if ((wRaw == null || hRaw == null || wRaw === '' || hRaw === '') && !Array.isArray(box)) {
    const nums = Object.values(box).map(Number).filter(Number.isFinite);
    if (nums.length >= 4) {
      if (wRaw == null || wRaw === '') wRaw = nums[2];
      if (hRaw == null || hRaw === '') hRaw = nums[3];
    }
  }
  let normX = Number(xRaw), normY = Number(yRaw), normW = Number(wRaw), normH = Number(hRaw);
  if (![normX, normY, normW, normH].every(Number.isFinite)) return null;
  const looksPixelish = [normX, normY, normW, normH].some(v => Math.abs(v) > 1);
  if (looksPixelish) {
    const { vw, vh } = viewportSize();
    if (vw > 0 && vh > 0) {
      normX = normX / vw;
      normW = normW / vw;
      normY = normY / vh;
      normH = normH / vh;
    }
  }
  const rect = gv2NormalizeRect({
    x: normX,
    y: normY,
    w: normW,
    h: normH
  });
  if (!rect) return null;
  const w = Math.min(rect.w, 1 - rect.x);
  const h = Math.min(rect.h, 1 - rect.y);
  if (!(w > 0) || !(h > 0)) return null;
  return {
    x: round(rect.x),
    y: round(rect.y),
    w: round(w),
    h: round(h)
  };
}

function gv2NormalizeEvidencePoint(point) {
  if (!point || typeof point !== 'object') return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y))
  };
}

function gv2NormalizeEvidenceColor(color) {
  const raw = String(color == null ? '' : color).trim().slice(0, 32);
  if (!raw) return null;
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(raw)) return raw;
  const named = raw.toLowerCase().replace(/\s+/g, '');
  const allow = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'cyan', 'white', 'black']);
  return allow.has(named) ? named : null;
}

function gv2NormalizeEvidenceAnnotations(input, maxItems = 5) {
  const raw = Array.isArray(input) ? input : [];
  const cap = Math.max(1, Math.min(5, Number(maxItems) || 5));
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '').toLowerCase();
    const label = String(item.label == null ? '' : item.label).replace(/\s+/g, ' ').trim().slice(0, 60);
    const color = gv2NormalizeEvidenceColor(item.color);
    if (type === 'box' || type === 'rect' || type === 'rectangle') {
      const bbox = gv2NormalizeEvidenceBbox(item.bbox || item.region_bbox || item.region || item);
      if (!bbox) continue;
      out.push(Object.assign({ type: 'box', bbox, label }, color ? { color } : {}));
    } else if (type === 'circle' || type === 'ellipse') {
      const bbox = gv2NormalizeEvidenceBbox(item.bbox || item.region_bbox || item.region || item);
      if (!bbox) continue;
      out.push(Object.assign({ type: 'ellipse', bbox, label }, color ? { color } : {}));
    } else if (type === 'arrow') {
      const from = gv2NormalizeEvidencePoint(item.from);
      const to = gv2NormalizeEvidencePoint(item.to);
      if (!from || !to) continue;
      out.push(Object.assign({ type: 'arrow', from, to, label }, color ? { color } : {}));
    } else if (type === 'line') {
      const from = gv2NormalizeEvidencePoint(item.from);
      const to = gv2NormalizeEvidencePoint(item.to);
      if (!from || !to) continue;
      out.push(Object.assign({ type: 'line', from, to, label }, color ? { color } : {}));
    }
    if (out.length >= cap) break;
  }
  return out;
}

function gv2NormalizeEvidenceAnnotationResult(input) {
  const obj = input && typeof input === 'object' ? input : {};
  const crop = obj.crop && typeof obj.crop === 'object'
    ? gv2NormalizeRect(obj.crop)
    : null;
  const region_bbox = crop
    ? {
        x: Number(crop.x.toFixed(6)),
        y: Number(crop.y.toFixed(6)),
        w: Number(Math.min(crop.w, 1 - crop.x).toFixed(6)),
        h: Number(Math.min(crop.h, 1 - crop.y).toFixed(6))
      }
    : gv2NormalizeEvidenceBbox(obj.region_bbox || obj.region || obj.bbox);
  return {
    region_bbox,
    annotations: gv2NormalizeEvidenceAnnotations(obj.annotations, 5),
    note: String(obj.note == null ? '' : obj.note).replace(/\s+/g, ' ').trim().slice(0, 220)
  };
}

function gv2NormalizeEvidenceEntry(input, ctx = {}) {
  const obj = input && typeof input === 'object' ? input : {};
  const key = gv2NormalizeEvidenceKey(obj.key);
  const note = String(obj.note == null ? '' : obj.note).replace(/\s+/g, ' ').trim().slice(0, 220);
  const ref = Number(ctx.ref_step_id != null ? ctx.ref_step_id : obj.ref_step_id);
  const ref_step_id = Number.isFinite(ref) && ref >= 0 ? Math.floor(ref) : null;
  const region_bbox = gv2NormalizeEvidenceBbox(obj.region_bbox || obj.region || obj.bbox);
  const somRaw = obj.som_id != null ? String(obj.som_id).trim() : '';
  const som_id = somRaw ? somRaw.slice(0, 80) : null;
  const annotations = (!som_id && region_bbox) ? gv2NormalizeEvidenceAnnotations(obj.annotations, 5) : [];
  const need_annotation = !som_id && (obj.need_annotation === true || obj.needs_annotation === true || obj.needAnnotation === true);
  const annotation_prompt = String(obj.annotation_prompt || obj.annotationPrompt || obj.annotation_request || obj.annotationRequest || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const errors = [];
  if (!key) errors.push('key');
  if (!note) errors.push('note');
  if (ref_step_id == null) errors.push('ref_step_id');
  if (obj.region_bbox || obj.region || obj.bbox) {
    if (!region_bbox) errors.push('region_bbox');
  }
  return errors.length ? { ok: false, errors, entry: null } : {
    ok: true,
    errors: [],
    entry: { key, note, ref_step_id, updated_at_step_id: ref_step_id, previous_ref_step_ids: [], region_bbox, som_id, annotations, need_annotation, annotation_prompt }
  };
}

function gv2NormalizeEvidenceList(input, ctx = {}) {
  const raw = Array.isArray(input) ? input : (input && typeof input === 'object' ? [input] : []);
  const requestedMax = Number(ctx.maxItems);
  const cap = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.floor(requestedMax)
    : raw.length;
  const entries = [];
  const errors = [];
  const usedKeys = new Set((Array.isArray(ctx.existingKeys) ? ctx.existingKeys : [])
    .map(k => gv2NormalizeEvidenceKey(k))
    .filter(Boolean));
  const uniqueKey = (base) => {
    const root = gv2NormalizeEvidenceKey(base);
    if (!root) return '';
    if (!usedKeys.has(root)) {
      usedKeys.add(root);
      return root;
    }
    const prefix = root.slice(0, 58).replace(/_+$/g, '') || 'ev';
    for (let i = 2; i < 1000; i++) {
      const candidate = `${prefix}_${i}`;
      if (!usedKeys.has(candidate)) {
        usedKeys.add(candidate);
        return candidate;
      }
    }
    return '';
  };
  const capped = raw.slice(0, cap);
  for (let i = 0; i < capped.length; i++) {
    const normalized = gv2NormalizeEvidenceEntry(capped[i], ctx);
    if (!normalized.ok) {
      errors.push({ index: i, errors: normalized.errors || [] });
      continue;
    }
    const key = uniqueKey(normalized.entry.key);
    if (!key) {
      errors.push({ index: i, errors: ['key_unique'] });
      continue;
    }
    entries.push(Object.assign({}, normalized.entry, { key }));
  }
  return {
    ok: entries.length > 0,
    entries,
    errors,
    truncated: raw.length > cap
  };
}

function gv2EvidenceMemoryText(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const clean = list
    .filter(e => e && e.key && e.note)
    .map(e => `- evidenceKey="${e.key}": ${e.note}, captured at step ${e.ref_step_id}`);
  return clean.length ? clean.join('\n') : '(none)';
}

function gv2ParseEvidenceRefs(text) {
  const out = [];
  const seen = new Set();
  const re = /\[ev:([a-zA-Z0-9_-]+)\]/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const key = gv2NormalizeEvidenceKey(m[1]);
    if (key && !seen.has(key)) { seen.add(key); out.push(key); }
  }
  return out;
}

function gv2EvidenceClaimText(entry) {
  const raw = String(entry?.note || entry?.key || '').replace(/\s+/g, ' ').trim();
  return raw.replace(/[.!?;:,\s]+$/g, '').slice(0, 180);
}

function gv2CitationTail(text, idx) {
  const prefix = String(text || '').slice(0, Math.max(0, idx));
  const prevCitation = prefix.lastIndexOf('[ev:');
  const cuts = ['.', '!', '?', ';', '\n'].map(ch => prefix.lastIndexOf(ch));
  const lastCut = Math.max(prevCitation, ...cuts);
  return prefix.slice(lastCut + 1);
}

function gv2CitationLooksBare(tail) {
  const s = String(tail || '').replace(/\s+/g, ' ').trim();
  if (!s) return true;
  if (/[:([]\s*$/.test(s)) return true;
  if (/\b(and|or|also|plus|with|see|source|evidence|article|item|result|one|another|first|second|third|titled|called|named)\s*:?$/i.test(s)) return true;
  if (/\b(one|another|first|second|third)\s+(titled|called|named|about|is)\s*:?$/i.test(s)) return true;
  const meaningful = s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => !/^(a|an|the|and|or|one|another|first|second|third|titled|called|named|about|is|are|was|were|with|of|to|in|on|for|this|that|these|those)$/.test(w));
  return meaningful.length < 2;
}

function gv2ExpandBareEvidenceCitations(answer, scratchpad) {
  const text = String(answer == null ? '' : answer);
  const entries = Array.isArray(scratchpad) ? scratchpad : [];
  const byKey = {};
  entries.forEach(e => {
    const k = gv2NormalizeEvidenceKey(e?.key);
    if (k && !byKey[k]) byKey[k] = e;
  });
  return text.replace(/\[ev:([a-zA-Z0-9_-]+)\]/g, (full, rawKey, offset) => {
    const key = gv2NormalizeEvidenceKey(rawKey);
    const entry = byKey[key];
    const claim = gv2EvidenceClaimText(entry);
    if (!entry || !claim) return full;
    const tail = gv2CitationTail(text, offset);
    const tailLower = tail.toLowerCase();
    const claimProbe = claim.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
    if (claimProbe && tailLower.includes(claimProbe)) return full;
    return gv2CitationLooksBare(tail) ? `${claim} ${full}` : full;
  });
}

/**
 * Build the guaranteed "answer evidence" link list for a finished guide task. This is the
 * single source of truth that ensures every terminal deliverable (answer card or navigate-only
 * summary card) links back to at least one on-page visual proof.
 *
 * Pure & synchronous (no DOM, no async) so it runs in the content-script context AND is unit
 * testable. It emits lightweight DESCRIPTORS only — the panel resolves the actual screenshot
 * bytes lazily by step number at render time.
 *
 * Aggregation order (deduped by step + region_bbox + evidence key):
 *   1. cited        — [ev:key] tokens in the answer that resolve to a scratchpad entry
 *   2. scratchpad   — any remaining saved evidence entry (the agent collected it but did not cite)
 *   3. confirmation — finish-time confirmationEvidence, used only when there is no saved
 *                     evidence trajectory (navigation/state-change-only tasks).
 *   4. action-fallback — the action-grounding step (e.g. the clicked button), used only when the
 *                        above produced nothing (e.g. navigate-only S3, or an uncited answer)
 *
 * Guarantee: callers pass a `fallbackStep`, so the result is non-empty. It returns [] only when
 * even `fallbackStep` is null (and there is no confirmation / scratchpad evidence).
 *
 * @param {{finalAnswer?:string, scratchpad?:Array, confirmation?:Array<{step:number, region_bbox?:object, note?:string}>, fallbackStep?:({step:number, note?:string}|null)}} input
 * @returns {Array<{source:string, step:number, region_bbox:(object|null), note:string, key?:string, number?:number}>}
 */
function gv2BuildAnswerEvidence(input) {
  const opts = input && typeof input === 'object' ? input : {};
  const finalAnswer = String(opts.finalAnswer == null ? '' : opts.finalAnswer);
  const scratchpad = Array.isArray(opts.scratchpad) ? opts.scratchpad : [];
  const confirmation = Array.isArray(opts.confirmation) ? opts.confirmation : [];
  const fallbackStep = opts.fallbackStep && typeof opts.fallbackStep === 'object' ? opts.fallbackStep : null;

  // Index scratchpad by normalized key; only entries pinned to a real step are linkable.
  const byKey = {};
  scratchpad.forEach(e => {
    if (!e || e.ref_step_id == null) return;
    const k = gv2NormalizeEvidenceKey(e.key);
    if (k && !byKey[k]) byKey[k] = e;
  });

  const items = [];
  const emittedKeys = new Set();
  const seenStepBbox = new Set();
	  const stepBboxKey = (step, bbox, key = '') => `${step}|${bbox ? JSON.stringify(bbox) : 'null'}|${key || ''}`;

  const push = (entry, source, extra) => {
    const step = Number(entry.ref_step_id);
    if (!Number.isFinite(step)) return;
	    const sbKey = stepBboxKey(step, entry.region_bbox || null, entry.key || extra?.key || '');
    if (seenStepBbox.has(sbKey)) return;
    seenStepBbox.add(sbKey);
    items.push(Object.assign({
      source,
      step,
      region_bbox: entry.region_bbox || null,
      note: entry.note || entry.key || 'Saved evidence'
    }, extra || {}));
  };

  // 1. Cited [ev:key], in citation order → numbered.
  gv2ParseEvidenceRefs(finalAnswer).forEach(key => {
    const entry = byKey[key];
    if (!entry || emittedKeys.has(key)) return;
    emittedKeys.add(key);
    push(entry, 'cited', { key, number: items.length + 1 });
  });

  // 2. Remaining scratchpad entries the agent saved but did not cite.
  scratchpad.forEach(e => {
    if (!e || e.ref_step_id == null) return;
    const key = gv2NormalizeEvidenceKey(e.key);
    if (!key || emittedKeys.has(key)) return;
    emittedKeys.add(key);
    push(e, 'scratchpad', { key });
  });

  // 3. Finish-time confirmation evidence — only when no saved evidence exists. This is the
  // navigation/state-change path: "completed X" gets a hoverable confirmation region, while
  // information tasks that saved evidence do not get a redundant final confirmation chip.
  if (items.length === 0) {
    const finalRefs = (typeof gv2ParseEvidenceRefs === 'function') ? gv2ParseEvidenceRefs(finalAnswer) : [];
    confirmation.forEach((c, idx) => {
      if (!c) return;
      const step = Number(c.step);
      if (!Number.isFinite(step)) return;
      const bbox = c.region_bbox || null;
      const refKey = finalRefs[idx] || '';
      const key = refKey || c.key || '';
      const sbKey = stepBboxKey(step, bbox, key);
      if (seenStepBbox.has(sbKey)) return;
      seenStepBbox.add(sbKey);
      items.push({ source: 'confirmation', step, region_bbox: bbox, note: c.note || 'Confirmation', key });
    });
  }

  // 4. Action grounding — only when nothing above resolved.
  if (items.length === 0 && fallbackStep && Number.isFinite(Number(fallbackStep.step))) {
    items.push({
      source: 'action-fallback',
      step: Number(fallbackStep.step),
      region_bbox: null,
      note: fallbackStep.note || 'Final step evidence'
    });
  }

  return items;
}

if (typeof window !== 'undefined') {
  window.gv2NormalizeEvidenceKey = gv2NormalizeEvidenceKey;
  window.gv2NormalizeEvidenceBbox = gv2NormalizeEvidenceBbox;
  window.gv2NormalizeEvidencePoint = gv2NormalizeEvidencePoint;
  window.gv2NormalizeEvidenceAnnotations = gv2NormalizeEvidenceAnnotations;
  window.gv2NormalizeEvidenceAnnotationResult = gv2NormalizeEvidenceAnnotationResult;
  window.gv2NormalizeEvidenceEntry = gv2NormalizeEvidenceEntry;
  window.gv2NormalizeEvidenceList = gv2NormalizeEvidenceList;
  window.gv2EvidenceMemoryText = gv2EvidenceMemoryText;
  window.gv2ParseEvidenceRefs = gv2ParseEvidenceRefs;
  window.gv2ExpandBareEvidenceCitations = gv2ExpandBareEvidenceCitations;
  window.gv2BuildAnswerEvidence = gv2BuildAnswerEvidence;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports.gv2NormalizeEvidenceKey = gv2NormalizeEvidenceKey;
  module.exports.gv2NormalizeEvidenceBbox = gv2NormalizeEvidenceBbox;
  module.exports.gv2NormalizeEvidencePoint = gv2NormalizeEvidencePoint;
  module.exports.gv2NormalizeEvidenceAnnotations = gv2NormalizeEvidenceAnnotations;
  module.exports.gv2NormalizeEvidenceAnnotationResult = gv2NormalizeEvidenceAnnotationResult;
  module.exports.gv2NormalizeEvidenceEntry = gv2NormalizeEvidenceEntry;
  module.exports.gv2NormalizeEvidenceList = gv2NormalizeEvidenceList;
  module.exports.gv2EvidenceMemoryText = gv2EvidenceMemoryText;
  module.exports.gv2ParseEvidenceRefs = gv2ParseEvidenceRefs;
  module.exports.gv2ExpandBareEvidenceCitations = gv2ExpandBareEvidenceCitations;
  module.exports.gv2BuildAnswerEvidence = gv2BuildAnswerEvidence;
}

/**
 * Normalize one LLM per-step confirmationEvidence item into { name, index, rect, text, reason,
 * need_annotation, annotation_prompt }, or null.
 *
 * confirmationEvidence is the SEPARATE on-page proof that justifies a step (e.g. a "Sort by:
 * Price: Low to High" control), distinct from the action target. The model points to it with
 * EITHER a SoM `index` OR a normalized `rect {x,y,w,h}` (when no marker fits). May also arrive as
 * a bare string (treated as the reason).
 *
 * @param {object|string} v
 * @returns {{name:(string|null), index:(number|null), rect:(object|null), text:(string|null), reason:(string|null), need_annotation:boolean, annotation_prompt:(string|null), annotations:Array}|null}
 */
function gv2NormalizeVisualEvidence(v) {
  const MAX = 280;
  const clean = (s) => {
    if (typeof s !== 'string') return null;
    const t = s.replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return t.length > MAX ? t.slice(0, MAX).trim() : t;
  };
  let obj = v;
  if (typeof v === 'string') obj = { reason: v };
  if (!obj || typeof obj !== 'object') return null;
  const n = Number(obj.index);
  const index = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  const name = gv2NormalizeEvidenceKey(obj.name || obj.key);
  const rect = gv2NormalizeRect(obj.rect || obj.region_bbox || obj.region || obj.bbox);
  const text = clean(obj.text);
  const reason = clean(obj.reason);
  const need_annotation = obj.need_annotation === true || obj.needs_annotation === true || obj.needAnnotation === true;
  const annotation_prompt = clean(obj.annotation_prompt || obj.annotationPrompt || obj.annotation_request || obj.annotationRequest);
  const annotations = typeof gv2NormalizeEvidenceAnnotations === 'function'
    ? gv2NormalizeEvidenceAnnotations(obj.annotations, 5)
    : [];
  if (!name && index == null && !rect && !text && !reason && !need_annotation && !annotation_prompt) return null;
  return { name: name || null, index, rect, text, reason, need_annotation, annotation_prompt, annotations };
}

if (typeof window !== 'undefined') window.gv2NormalizeVisualEvidence = gv2NormalizeVisualEvidence;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2NormalizeVisualEvidence = gv2NormalizeVisualEvidence;

/**
 * Normalize visual evidence into a capped array. Accepts either:
 * - a single object: { index, rect, text, reason }
 * - an array of those objects
 * - grouped fields: { indexes: [..], rects: [..], reasons: [..], texts: [..] }
 *
 * Each returned item may use either an SoM index or a rect. Indexes are preferred downstream; rects
 * remain per-item fallbacks when no usable marker exists.
 *
 * @param {object|string|Array} v
 * @param {number} maxItems
 * @returns {Array<{name:(string|null), index:(number|null), rect:(object|null), text:(string|null), reason:(string|null), need_annotation:boolean, annotation_prompt:(string|null), annotations:Array}>}
 */
function gv2NormalizeVisualEvidenceList(v, maxItems = 5) {
  const cap = Math.max(1, Math.min(5, Number(maxItems) || 5));
  if (v == null) return [];
  let raw = [];
  if (Array.isArray(v)) {
    raw = v;
  } else if (v && typeof v === 'object' && (Array.isArray(v.indexes) || Array.isArray(v.indices) || Array.isArray(v.rects))) {
    const indexes = Array.isArray(v.indexes) ? v.indexes : (Array.isArray(v.indices) ? v.indices : []);
    const rects = Array.isArray(v.rects) ? v.rects : [];
    const names = Array.isArray(v.names) ? v.names : (Array.isArray(v.keys) ? v.keys : []);
    const texts = Array.isArray(v.texts) ? v.texts : [];
    const reasons = Array.isArray(v.reasons) ? v.reasons : [];
    const count = Math.max(names.length, indexes.length, rects.length, texts.length, reasons.length);
    raw = Array.from({ length: count }, (_, i) => ({
      name: names[i],
      index: indexes[i],
      rect: rects[i],
      text: texts[i],
      reason: reasons[i]
    }));
  } else {
    raw = [v];
  }
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (out.length >= cap) break;
    const norm = gv2NormalizeVisualEvidence(item);
    if (!norm) continue;
    const key = norm.name
      ? `n:${norm.name}`
      : norm.index != null
      ? `i:${norm.index}`
      : (norm.rect ? `r:${norm.rect.x},${norm.rect.y},${norm.rect.w},${norm.rect.h}` : `t:${norm.text || ''}|${norm.reason || ''}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

if (typeof window !== 'undefined') window.gv2NormalizeVisualEvidenceList = gv2NormalizeVisualEvidenceList;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2NormalizeVisualEvidenceList = gv2NormalizeVisualEvidenceList;

/**
 * Does this step point at a single DOM element the agent must highlight and act on?
 *
 * `find` never does: it highlights whatever passages the reader pass cites, not one
 * element the planner picked, so it returns false even when the model wrongly
 * populates `element`.
 *
 * @param {object} step - {action, isLastStep, element:{index,text}}
 * @returns {boolean}
 */
function gv2StepHasTarget(step) {
  if (!step) return false;
  const action = gv2NormalizeAction(step.action, step.isLastStep);
  if (
    action === 'find' ||
    action === 'visual_highlight' ||
    action === 'finish' ||
    action === 'save_evidence' ||
    action === 'scroll_down' ||
    action === 'scroll_up' ||
    action === 'goto_url' ||
    action === 'watch_video' ||
    step.isLastStep
  ) return false;
  const hasIndex = step.element?.index != null && step.element?.index !== '';
  const hasText = !!(step.element?.text && String(step.element.text).trim());
  return hasIndex || hasText;
}

if (typeof window !== 'undefined') window.gv2StepHasTarget = gv2StepHasTarget;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2StepHasTarget = gv2StepHasTarget;

/**
 * Classify the reader pass's answer for action=find.
 *
 * `notOnPage` keys off the exact sentence PROMPTS.ANSWER_AND_HIGHLIGHT rule 9 mandates
 * when the page lacks the answer — in that case the model still answers from general
 * knowledge with markdown links, so we keep the text but skip on-page highlighting.
 *
 * @param {string} answer - raw LLM answer, possibly with [N:"text"] citations
 * @returns {{answer:string, notOnPage:boolean, hasCitations:boolean}}
 */
function gv2ParseFindResponse(answer) {
  const text = String(answer == null ? '' : answer);
  return {
    answer: text,
    notOnPage: /the information is not provided on this page/i.test(text),
    hasCitations: /\[\d+(?::[^\]]*)?\]/.test(text)
  };
}

if (typeof window !== 'undefined') window.gv2ParseFindResponse = gv2ParseFindResponse;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2ParseFindResponse = gv2ParseFindResponse;

/**
 * How should Rewind replay a recorded action? 'noop' means the step changed nothing on
 * the page (find only reads), so replay must skip it rather than fail to resolve a
 * target and abort the whole chain.
 *
 * @param {string} action
 * @returns {'noop'|'type'|'clear_text'|'select'|'check'|'drag_drop'|'click'}
 */
function gv2ReplayKind(action) {
  const a = gv2NormalizeAction(action || 'click');
  if (a === 'find' || a === 'visual_highlight' || a === 'save_evidence' || a === 'finish' || a === 'goto_url' || a === 'watch_video') return 'noop';
  if (a === 'type' || a === 'clear_text' || a === 'select') return a;
  if (a === 'drag_drop') return 'drag_drop';
  if (a === 'check' || a === 'toggle') return 'check';
  return 'click';
}

if (typeof window !== 'undefined') window.gv2ReplayKind = gv2ReplayKind;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2ReplayKind = gv2ReplayKind;

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
 * @returns {Array<{step:number, status:'done'|'current'|'pending', review:boolean, reviewLabels:string[], verify:('success'|'failed'|'blocked'|null)}>}
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
  const isLowGrounding = (x) => x != null && x < 0.5;
  const isHighLoop = (x) => x != null && x >= 0.3;

  const out = [];
  for (let i = 1; i <= total; i++) {
    const r = recOf(i);
    let status;
    if (i < current) status = 'done';
    else if (i === current) status = active ? 'current' : 'done';
    else status = 'pending';
    if (!active && i <= current) status = 'done'; // finished guide: everything up to current done

    const reviewLabels = [];
    if (r && (isLowGrounding(r.grounding) || isLowGrounding(r.mechGrounding))) reviewLabels.push('misgrounded');
    if (r && (isHighLoop(r.loop) || isHighLoop(r.mechLoop))) reviewLabels.push('loop');
    const review = reviewLabels.length > 0;
    const verify = (verifications[i] && verifications[i].status) ||
                   (r && r.verification && r.verification.status) || null;
    out.push({ step: i, status, review, reviewLabels, verify });
  }
  return out;
}

if (typeof window !== 'undefined') window.gv2DotState = gv2DotState;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2DotState = gv2DotState;

function gv2StepErrorLabelFromScores(rec) {
  const action = rec?.action || '';
  if (action && action !== 'click' && action !== 'type') return '';
  const num = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
  const grounded = num(rec?.mechGrounding ?? rec?.grounding ?? rec?.grounded);
  const loop = num(rec?.mechLoop ?? rec?.loop);
  const confidence = num(rec?.mechConfidence ?? rec?.confidence);
  if (loop != null && loop >= 0.6) return 'loop';
  if (grounded != null && grounded <= 0.45) return 'misgrounded';
  if (confidence != null && confidence < 0.5) return 'low-confidence';
  return 'other';
}

if (typeof window !== 'undefined') window.gv2StepErrorLabelFromScores = gv2StepErrorLabelFromScores;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2StepErrorLabelFromScores = gv2StepErrorLabelFromScores;

// Normalize a raw end-of-task recap into { summary, milestones:[{text, step}] }. Pure — no
// LLM/DOM — so it's unit-testable. `raw` is the parsed LLM JSON (or null). `ctx` supplies the
// ground truth used to validate and, if needed, synthesize a deterministic fallback:
//   ctx.validSteps  — array of step numbers that actually completed (milestones are pinned to these)
//   ctx.plan        — the guide plan [{ n, goal }] (used for the fallback milestone text)
//   ctx.planTitle   — optional task title (used for the fallback summary sentence)
//   ctx.steps       — completed-step strings ["Step 2: Click Create ✓", ...] (fallback text)
// Milestones are filtered to real completed steps, deduped by step, and clamped to 2–6. When the
// LLM output has no usable milestones, a deterministic recap is built from the plan / step list.
// Each milestone also carries `phrase` — the key noun phrase within `text` to turn into an inline
// hover-link. It's kept only when it is a case-insensitive substring of `text`, else '' (the whole
// line becomes the link at render time).
function gv2NormalizeRecap(raw, ctx) {
  const c = ctx || {};
  const validSteps = (Array.isArray(c.validSteps) ? c.validSteps : [])
    .map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0);
  const validSet = new Set(validSteps);
  const plan = Array.isArray(c.plan) ? c.plan : [];
  const stepStrings = Array.isArray(c.steps) ? c.steps : [];
  const clampText = (s) => String(s == null ? '' : s).trim().slice(0, 240);
  const stepRecords = Array.isArray(c.stepRecords) ? c.stepRecords : [];
  const scratchpad = Array.isArray(c.scratchpad) ? c.scratchpad : [];
  const evidenceByKey = {};
  for (const e of scratchpad) {
    const key = String(e?.key || '').trim();
    if (key) evidenceByKey[key] = e;
  }
  const rawVerdict = raw && (raw.verdict === 'completed' || raw.verdict === 'failed' || raw.verdict === 'unclear')
    ? raw.verdict : null;
  const finalVerdict = rawVerdict || (c.finalVerdict === 'completed' || c.finalVerdict === 'failed' || c.finalVerdict === 'unclear'
    ? c.finalVerdict : null);
  const finalReason = clampText(c.finalReason || '');
  // Keep the phrase only when it actually appears in the text (so the link can be placed inline).
  const validPhrase = (phrase, text) => {
    const p = String(phrase == null ? '' : phrase).trim().slice(0, 120);
    if (!p) return '';
    return text.toLowerCase().includes(p.toLowerCase()) ? p : '';
  };

  // 1) Try the LLM-provided milestones, keeping only those pinned to a real completed step.
  const seen = new Set();
  let milestones = [];
  const rawList = raw && Array.isArray(raw.stepEvaluations) ? raw.stepEvaluations
    : (raw && Array.isArray(raw.milestones) ? raw.milestones : []);
  const normalizeStatus = (status) => {
    const s = String(status || '').toLowerCase();
    return (s === 'correct' || s === 'wrong' || s === 'unclear') ? s : '';
  };
  const normalizeErrorLabel = (label, rec) => {
    const action = rec?.action || '';
    if (action && action !== 'click' && action !== 'type') return '';
    const s = String(label || '').toLowerCase().replace(/[^a-z-]/g, '');
    const known = ['misgrounded', 'loop', 'low-confidence', 'risky', 'incomplete', 'wrong-action', 'other'];
    if (known.includes(s)) return s;
    return rec ? gv2StepErrorLabelFromScores(rec) : '';
  };
  const normalizeGoalRelated = (m) => {
    if (typeof m?.goalRelated === 'boolean') return m.goalRelated;
    if (typeof m?.relatedToGoal === 'boolean') return m.relatedToGoal;
    if (typeof m?.isRelatedToGoal === 'boolean') return m.isRelatedToGoal;
    return null;
  };
  const recForStep = (step) => stepRecords.find(r => Number(r?.step) === Number(step)) || null;
  const normalizeSummarySegments = (items, fallbackMilestones = [], summaryText = '') => {
    const source = Array.isArray(items) ? items : [];
    const visibleSummary = clampText(summaryText);
    const out = [];
    const seenSeg = new Set();
    for (const item of source) {
      if (!item) continue;
      const text = clampText(item.text);
      const phrase = validPhrase(item.phrase, visibleSummary || text);
      if (!text && !phrase) continue;
      if (visibleSummary && !phrase) continue;
      const evidenceKey = String(item.evidenceKey || item.evidence_key || '').trim();
      const evidence = evidenceKey ? evidenceByKey[evidenceKey] : null;
      const rawStep = item.step != null ? item.step : evidence?.ref_step_id;
      const step = Number(rawStep);
      const hasValidStep = Number.isFinite(step) && validSet.has(step);
      const evidenceStep = Number(evidence?.ref_step_id);
      const hasValidEvidence = !!(evidence && Number.isFinite(evidenceStep) && validSet.has(evidenceStep));
      if (evidenceKey && !hasValidEvidence) continue;
      if (!hasValidStep && !hasValidEvidence) continue;
      const key = `${evidenceKey || step}:${(phrase || text).toLowerCase()}`;
      if (seenSeg.has(key)) continue;
      seenSeg.add(key);
      const segment = { text: text || phrase, step: hasValidStep ? step : evidenceStep, phrase };
      if (evidence) {
        segment.evidenceKey = evidenceKey;
        segment.note = clampText(evidence.note || '');
        segment.region_bbox = evidence.region_bbox || null;
      }
      out.push(segment);
      if (out.length >= 5) break;
    }
    if (out.length) return out;
    for (const m of fallbackMilestones) {
      const step = Number(m?.firstStep != null ? m.firstStep : m?.step);
      const text = clampText(m?.text || '');
      if (!text || !Number.isFinite(step) || !validSet.has(step)) continue;
      const key = `${step}:${text.toLowerCase()}`;
      if (seenSeg.has(key)) continue;
      seenSeg.add(key);
      out.push({ text, step, phrase: validPhrase(m?.phrase, text) });
      if (out.length >= 4) break;
    }
    return out;
  };
  for (const m of rawList) {
    if (!m) continue;
    const step = Number(m.step);
    const text = clampText(m.text);
    if (!text || !Number.isFinite(step) || !validSet.has(step) || seen.has(step)) continue;
    const rec = recForStep(step);
    const status = normalizeStatus(m.status);
    const item = { text, step, phrase: validPhrase(m.phrase, text) };
    const goalRelated = normalizeGoalRelated(m);
    if (goalRelated !== null) {
      item.goalRelated = goalRelated;
      item.goalRelatedReason = clampText(m.goalRelatedReason || m.relatedReason || '');
    }
    if (status) item.status = status;
    if (status === 'wrong') {
      item.errorLabel = normalizeErrorLabel(m.errorLabel || m.label, rec);
      item.reason = clampText(m.reason || '');
    }
    seen.add(step);
    milestones.push(item);
  }

  // 2) Fallback: synthesize milestones from the plan / completed-step strings.
  if (milestones.length === 0) {
    const parseStepString = (s) => {
      const mm = /^Step\s+(\d+)\s*:\s*(.*)$/.exec(String(s || '').trim());
      if (!mm) return null;
      return { step: Number(mm[1]), text: clampText(mm[2].replace(/\s*[✓✔]\s*$/, '')) };
    };
    const fromStrings = stepStrings.map(parseStepString).filter(x => x && validSet.has(x.step) && x.text);
    for (const x of fromStrings) {
      if (seen.has(x.step)) continue;
      seen.add(x.step);
      const rec = recForStep(x.step);
      const suspicious = finalVerdict !== 'completed' && rec && (rec.action === 'click' || rec.action === 'type') && (
        Number(rec.mechLoop ?? rec.loop) >= 0.6 ||
        Number(rec.mechGrounding ?? rec.grounding ?? rec.grounded) <= 0.45 ||
        Number(rec.mechConfidence ?? rec.confidence) < 0.5
      );
      const item = { text: x.text, step: x.step, phrase: '' };
      item.goalRelated = true;
      item.goalRelatedReason = 'Fallback from completed guide step.';
      if (suspicious) {
        item.status = 'wrong';
        item.errorLabel = gv2StepErrorLabelFromScores(rec);
        item.reason = 'Flagged by confidence signals.';
      } else if (finalVerdict === 'completed') {
        item.status = 'correct';
      }
      milestones.push(item);
    }
  }

  // 3) Clamp to a readable 2–6 (only trims — never invents steps that didn't happen).
  if (milestones.length > 6) milestones = milestones.slice(0, 6);

  // Summary: prefer the LLM's; otherwise a plain deterministic sentence.
  let summary = clampText(raw && raw.summary);
  if (summary && finalVerdict) {
    const donePrefix = 'I have completed the task';
    const failedPrefix = 'I could not complete the task';
    if (finalVerdict === 'completed' && !summary.toLowerCase().startsWith(donePrefix.toLowerCase())) {
      summary = `${donePrefix}. ${summary}`;
    } else if (finalVerdict !== 'completed' && !summary.toLowerCase().startsWith(failedPrefix.toLowerCase())) {
      summary = `${failedPrefix}. ${summary}`;
    }
  }
  if (!summary) {
    const n = milestones.length || validSteps.length;
    const title = c.planTitle ? ` for "${clampText(c.planTitle)}"` : '';
    const prefix = finalVerdict === 'completed' ? 'I have completed the task.'
      : 'I could not complete the task.';
    const reason = finalReason ? ` ${finalReason}` : '';
    summary = n > 0
      ? `${prefix}${reason} The guide recorded ${n} step${n === 1 ? '' : 's'}${title}.`
      : `${prefix}${reason}${title ? ` Task: ${title}.` : ''}`;
  }

  const rawSummarySegments = raw && (Array.isArray(raw.summarySegments) ? raw.summarySegments
    : (Array.isArray(raw.summary_segments) ? raw.summary_segments : []));
  const summarySegments = normalizeSummarySegments(rawSummarySegments, milestones, summary);

  return { summary, milestones, summarySegments };
}

if (typeof window !== 'undefined') window.gv2NormalizeRecap = gv2NormalizeRecap;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2NormalizeRecap = gv2NormalizeRecap;

// Builds the "=== ABOUT THIS USER ===" prompt block spliced into Guide step prompts, combining
// the user's manually-entered facts (settings) with the auto-learned rolling profile. Pure string
// logic — no storage access — so the guide loop can cache the result once per session instead of
// re-reading chrome.storage on every step.
function gv2BuildPersonalizationSection({ facts, learned } = {}) {
  const factsText = String(facts == null ? '' : facts).trim();
  const learnedText = String(learned == null ? '' : learned).trim();
  if (!factsText && !learnedText) return '';
  const lines = ['\n=== ABOUT THIS USER ===', 'Use this to tailor tone and answers, but never let it override the actual task or page content.'];
  if (factsText) lines.push(`Facts the user shared: ${factsText}`);
  if (learnedText) lines.push(`What you have learned from prior sessions: ${learnedText}`);
  return lines.join('\n') + '\n';
}
if (typeof window !== 'undefined') window.gv2BuildPersonalizationSection = gv2BuildPersonalizationSection;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2BuildPersonalizationSection = gv2BuildPersonalizationSection;

// Normalizes the LLM response from the post-trajectory personalization-profile-update call into a
// storable { summary, updatedAt, version } record. Returns null for anything unusable so a bad or
// malformed LLM response never overwrites a previously good learned profile.
const GV2_PERSONALIZATION_SUMMARY_MAX_CHARS = 1500;
function gv2NormalizeProfileUpdate(raw, priorProfile) {
  if (!raw || typeof raw.summary !== 'string') return null;
  let summary = raw.summary.trim();
  if (!summary) return null;
  if (summary.length > GV2_PERSONALIZATION_SUMMARY_MAX_CHARS) {
    const truncated = summary.slice(0, GV2_PERSONALIZATION_SUMMARY_MAX_CHARS);
    const lastSpace = truncated.lastIndexOf(' ');
    summary = (lastSpace > GV2_PERSONALIZATION_SUMMARY_MAX_CHARS * 0.6 ? truncated.slice(0, lastSpace) : truncated).trim();
  }
  const priorVersion = Number(priorProfile?.version);
  return {
    summary,
    updatedAt: Date.now(),
    version: (Number.isFinite(priorVersion) ? priorVersion : 0) + 1
  };
}
if (typeof window !== 'undefined') window.gv2NormalizeProfileUpdate = gv2NormalizeProfileUpdate;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2NormalizeProfileUpdate = gv2NormalizeProfileUpdate;

// Deterministic binary verdict: the WORKING agent's own terminal action decides success, not the
// summarization LLM. 'completed' only when the agent emitted a literal finish action (outcome
// 'completed'); every other ending — stopped early, hit the step cap, errored — is 'failed'.
// Pure — unit-testable. The summarization agent is now a summarizer/diagnoser, never the judge.
function gv2DeterministicVerdict(outcome) {
  return outcome === 'completed' ? 'completed' : 'failed';
}
if (typeof window !== 'undefined') window.gv2DeterministicVerdict = gv2DeterministicVerdict;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2DeterministicVerdict = gv2DeterministicVerdict;

// Normalize the Final-State vision verdict from the LLM into a safe, renderable shape. Pure — no
// LLM/DOM — so it's unit-testable. `raw` is the parsed JSON (or null). Returns:
//   { verdict: 'completed'|'failed'|'unclear', reason: string,
//     annotations: [{ x, y, w, h, label }] }   // x/y/w/h are [0,1] fractions of the screenshot
// Annotations are filtered to valid numeric rects clamped to [0,1] (no right/bottom spill), labels
// trimmed, count capped at 6. Malformed input yields an 'unclear' verdict with no annotations.
function gv2NormalizeFinalVerdict(raw) {
  const r = raw || {};
  const verdict = (r.verdict === 'completed' || r.verdict === 'failed') ? r.verdict : 'unclear';
  const reason = String(r.reason == null ? '' : r.reason).trim().slice(0, 400);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const list = Array.isArray(r.annotations) ? r.annotations : [];
  const annotations = [];
  for (const a of list) {
    if (!a) continue;
    const x = Number(a.x), y = Number(a.y), w = Number(a.w), h = Number(a.h);
    if (![x, y, w, h].every(n => Number.isFinite(n))) continue;
    const cx = clamp01(x), cy = clamp01(y);
    const cw = Math.min(clamp01(w), 1 - cx), ch = Math.min(clamp01(h), 1 - cy);
    if (cw <= 0 || ch <= 0) continue;
    const label = String(a.label == null ? '' : a.label).trim().slice(0, 60);
    annotations.push({ x: cx, y: cy, w: cw, h: ch, label });
    if (annotations.length >= 6) break;
  }
  return { verdict, reason, annotations };
}

if (typeof window !== 'undefined') window.gv2NormalizeFinalVerdict = gv2NormalizeFinalVerdict;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2NormalizeFinalVerdict = gv2NormalizeFinalVerdict;

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
