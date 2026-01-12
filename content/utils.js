// XWebAgent - Utility Functions
// Uses accessibility-inspired approach to find ALL interactive/content elements

// Store element references globally
window._xwebagentIndex = window._xwebagentIndex || {};


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
  // Skip [edit] links
  if (name === 'edit' || name === '[edit]') return true;
  
  // Skip citation references like [1], [99], [100]
  if (/^\[\d+\]$/.test(name)) return true;
  
  // Skip elements with cite/reference classes (Wikipedia)
  const className = el.className || '';
  if (className.includes('reference') || className.includes('cite')) return true;
  
  // Skip links to citations/footnotes
  const href = el.getAttribute('href') || '';
  if (href.includes('#cite') || href.includes('#ref') || href.includes('#note')) return true;
  
  // Skip superscript citation containers
  if (el.tagName === 'SUP' && el.querySelector('a[href*="cite"]')) return true;
  
  // Skip very short numeric-only text (likely footnote numbers)
  if (/^\d+$/.test(name) && name.length <= 3) return true;
  
  // Skip common Wikipedia noise
  if (name.includes('#cite') || name.includes('↑') || name === '^') return true;
  
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
  const type = (el.type || 'text').toLowerCase();
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
 * Check if element is part of XWebAgent UI
 */
function isXWebAgentElement(el) {
  if (!el) return false;
  return el.closest('[id^="xwebagent"]') || 
         el.closest('[class*="xwebagent"]') ||
         el.hasAttribute('data-xwebagent-styled');
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
 */
function getVisibleText(maxLength = 20000) {
  const lines = [];
  const seen = new Set();
  
  // Walk ALL elements
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);

  let el;
  while ((el = walker.nextNode())) {
    // Skip our UI
    if (isXWebAgentElement(el)) continue;
    
    // Skip hidden
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
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
  return result.length > maxLength ? result.slice(0, maxLength) + '...' : result;
}

/**
 * Create indexed list of ALL elements using accessibility-inspired approach
 * No predefined selectors - walks entire DOM and uses accessible roles
 * Returns: { indexText, indexMap, count }
 */
function createPageIndex(maxItems = 200) {
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
          if (isXWebAgentElement(node)) return NodeFilter.FILTER_REJECT;
          
          // Skip hidden
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') {
            return NodeFilter.FILTER_REJECT;
          }
          
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
    if (isXWebAgentElement(el)) continue;
    
    // Skip already seen
    if (seen.has(el)) continue;
    
    // Skip hidden elements
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
    } catch (e) { continue; }
    
    // Get accessible role - if no role, skip (not interesting)
    const role = getAccessibleRole(el);
    if (!role) continue;
    
    // Get accessible name
    let name = getAccessibleName(el);
    if (!name || name.length < 2) continue;
    
    // Clean up
    name = name.replace(/\s+/g, ' ').trim();
    
    // Only skip duplicates for non-interactive elements
    if (!isElementInteractive(el) && seenText.has(name)) continue;
    
    // Skip common noise elements
    // if (isNoiseElement(el, name)) continue;
    
    seen.add(el);
    seenText.add(name);
    
    // Store element
    indexMap[idx] = el;
    
    // Truncate long text
    const maxLen = (role === 'paragraph' || role === 'article') ? 300 : 120;
    const displayText = name.length > maxLen ? name.slice(0, maxLen) + '...' : name;
    
    // Format: [idx] (role) text
    indexLines.push(`[${idx}] (${role}) ${displayText}`);
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
    if (isXWebAgentElement(el)) return;
    if (seen.has(el)) return;
    
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
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
  
  // Store globally
  window._xwebagentIndex = indexMap;
  
  console.log('🤖 Indexed', idx - 1, 'elements (including popups)');
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
  return window._xwebagentIndex[idx] || null;
}
