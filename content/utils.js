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
 * position, and visible form-field values. Lets a later "Steer from here" on a fresh load
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
      const verb = ({ type: 'Type into', select: 'Select in', check: 'Toggle', toggle: 'Toggle' })[e.action] || 'Click';
      return `${mark} ${verb} ${typeof tgt === 'string' ? tgt : JSON.stringify(tgt)}${val}`;
    }
    default:               return `${mark} ${e.kind}${val}`;
  }
}

if (typeof window !== 'undefined') {
  window.gv2FieldSelector = gv2FieldSelector;
  window.gv2SetFieldValue = gv2SetFieldValue;
  window.gv2CaptureRestoreState = gv2CaptureRestoreState;
  window.gv2ApplyRestoreState = gv2ApplyRestoreState;
  window.gv2DescribeRestoreAction = gv2DescribeRestoreAction;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports.gv2FieldSelector = gv2FieldSelector;
  module.exports.gv2SetFieldValue = gv2SetFieldValue;
  module.exports.gv2CaptureRestoreState = gv2CaptureRestoreState;
  module.exports.gv2ApplyRestoreState = gv2ApplyRestoreState;
  module.exports.gv2DescribeRestoreAction = gv2DescribeRestoreAction;
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
  try { return JSON.parse(json); } catch (e) { return null; }
}

if (typeof window !== 'undefined') window.gv2ExtractJsonObject = gv2ExtractJsonObject;
if (typeof module !== 'undefined' && module.exports) module.exports.gv2ExtractJsonObject = gv2ExtractJsonObject;

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
