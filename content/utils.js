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
  
  // ⭐ Use TreeWalker instead of querySelectorAll('*')
  const walker = document.createTreeWalker(
    document.body,
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
    
    // Skip common noise
    if (name === 'edit' || name === '[edit]' || name.includes('#cite')) continue;
    
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
  
  // Store globally
  window._xwebagentIndex = indexMap;
  
  console.log('🤖 Indexed', idx - 1, 'elements using accessibility approach');
  
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

/**
 * Find all links on the page (for quick actions)
 */
function findLinks(limit = 20) {
  return Array.from(document.querySelectorAll('a[href]'))
    .filter(a => !isXWebAgentElement(a))
    .slice(0, limit)
    .map(a => ({
      text: (a.innerText || '').slice(0, 50) || a.href.slice(0, 50),
      href: a.href
    }));
}
