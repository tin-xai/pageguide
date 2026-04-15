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
 * Expand truncated social media posts and other "show more" content before indexing.
 * Clicks visible expand buttons (See more, Show more, Read more, etc.) silently.
 * Returns a promise that resolves after all clicks + a short settle delay.
 */
async function expandTruncatedContent() {
  // X/Twitter: "Show more" on a tweet is a JS-driven navigation to the tweet's permalink
  // (via history.pushState / React Router), NOT an inline expand. It is rendered as a
  // <span role="button"> with no href, so the anchor-href check below can't catch it.
  // Clicking it during an LLM call kills the message channel → error. Skip entirely.
  const _h = window.location.hostname;
  if (_h === 'x.com' || _h === 'twitter.com' ||
      _h.endsWith('.x.com') || _h.endsWith('.twitter.com')) {
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
