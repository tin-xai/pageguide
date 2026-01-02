// XWebAgent - Utility Functions
// Comprehensive page content extraction

// Store element references globally
window._xwebagentIndex = window._xwebagentIndex || {};

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
 * Get ALL page content as text
 * Includes: headings, paragraphs, links, buttons, inputs, lists, tables, etc.
 */
function getVisibleText(maxLength = 15000) {
  const lines = [];
  
  // Comprehensive selectors - everything that might have content
  // const selectors = [
  //   // Text content
  //   'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  //   'p', 'span', 'div',
  //   'li', 'dt', 'dd',
  //   'td', 'th', 'caption',
  //   'blockquote', 'pre', 'code',
  //   'figcaption', 'label',
  //   // Interactive elements
  //   'a', 'button',
  //   'input', 'textarea', 'select',
  // ];
  const selectors = [
    // Headings first
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    // Main content
    'p',
    'article',    // ← ADD
    'section',    // ← ADD
    // Interactive - important for actions
    'button', 'a[href]',
    '[role="button"]',     // ← ADD
    '[role="link"]',       // ← ADD
    '[onclick]',           // ← ADD (elements with click handlers)
    'input', 'textarea', 'select',
    // Lists
    'li',
    // Tables
    'td', 'th',
    // Media
    'img[alt]',   // ← ADD
    // Other content
    'figcaption', 'blockquote', 'label',
  ];
  
  const seen = new Set();
  
  document.querySelectorAll(selectors.join(',')).forEach(el => {
    // Skip our UI
    if (isXWebAgentElement(el)) return;
    
    // Skip hidden elements
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    
    // Get text content
    let text = '';
    const tag = el.tagName.toLowerCase();
    
    if (tag === 'input') {
      const type = el.type || 'text';
      const placeholder = el.placeholder || '';
      const value = el.value || '';
      text = `[input:${type}] ${placeholder} ${value}`.trim();
    } else if (tag === 'select') {
      const selected = el.options[el.selectedIndex];
      text = `[select] ${selected ? selected.text : ''}`;
    } else if (tag === 'textarea') {
      text = `[textarea] ${el.value || el.placeholder || ''}`;
    } else if (tag === 'button') {
      text = `[button] ${el.innerText || ''}`.trim();
    } else if (tag === 'a') {
      text = el.innerText?.trim() || '';
      if (text && el.href) text = `${text} (link)`;
    } else {
      text = (el.innerText || '').trim();
    }
    
    // Clean up whitespace
    text = text.replace(/\s+/g, ' ').trim();
    
    // Skip empty, too short, or duplicates
    if (text.length < 2) return;
    if (seen.has(text)) return;
    seen.add(text);
    
    lines.push(text);
  });
  
  let result = lines.join('\n');
  return result.length > maxLength ? result.slice(0, maxLength) + '...' : result;
}

/**
 * Create indexed list of ALL interactive and content elements
 * Returns: { indexText, indexMap, count }
 */
function createPageIndex(maxItems = 150) {
  const indexMap = {};
  const indexLines = [];
  let idx = 1;
  
  // ALL element types we want to index
  const selectors = [
    // Headings first
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    
    // Main content
    'p',
    'article',        // ← ADD: Semantic articles
    'section',        // ← ADD: Semantic sections
    
    // Interactive - important for actions
    'button', 
    'a[href]',
    '[role="button"]',      // ← ADD: Divs/spans acting as buttons
    '[role="link"]',        // ← ADD: Divs/spans acting as links
    '[onclick]',            // ← ADD: Elements with click handlers
    'input', 'textarea', 'select',
    
    // Lists
    'li',
    
    // Tables
    'td', 'th',
    
    // Media
    'img[alt]',       // ← ADD: Images with alt text (context)
    
    // Other content
    'figcaption', 'blockquote', 'label',
  ];
  
  const seen = new Set();
  const seenText = new Set();
  
  for (const selector of selectors) {
    if (idx > maxItems) break;
    
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      if (idx > maxItems) break;
      
      // Skip our UI
      if (isXWebAgentElement(el)) continue;
      
      // Skip already indexed elements
      if (seen.has(el)) continue;
      seen.add(el);
      
      // Skip hidden
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      
      // Check if element has cursor:pointer (clickable)
      const isClickable = style.cursor === 'pointer' || 
      el.onclick || 
      el.hasAttribute('onclick') ||
      el.getAttribute('role') === 'button' ||
      el.getAttribute('role') === 'link';
      // Mark interactive elements in the index
      if (isClickable && !isXWebAgentElement(el)) {
        // Index this clickable element
        seen.add(el);
        const textClickable = (el.innerText || '').trim().slice(0, 100);
        if (textClickable.length > 1) {
          indexMap[idx] = el;
          indexLines.push(`[${idx}] (clickable) ${textClickable}`);
          idx++;
        }
      }

      // Get element info
      const tag = el.tagName.toLowerCase();
      let text = '';
      let type = tag;
      
      if (tag === 'input') {
        const inputType = el.type || 'text';
        text = el.placeholder || el.value || el.name || '';
        type = `input:${inputType}`;
      } else if (tag === 'select') {
        const selected = el.options[el.selectedIndex];
        text = selected ? selected.text : (el.name || '');
        type = 'select';
      } else if (tag === 'textarea') {
        text = el.placeholder || el.value?.slice(0, 50) || el.name || '';
        type = 'textarea';
      } else if (tag === 'button') {
        text = (el.innerText || el.value || '').trim();
        type = 'button';
      } else if (tag === 'a') {
        text = (el.innerText || '').trim();
        type = 'link';
        // Skip edit links, cite links
        const href = el.href || '';
        if (href.includes('#cite') || href.includes('action=edit') || 
            text === 'edit' || text === '[edit]') continue;
      } else {
        text = (el.innerText || '').trim();
      }
      
      // Clean whitespace
      text = text.replace(/\s+/g, ' ').trim();
      
      // Skip empty
      if (text.length < 1) continue;
      
      // Skip duplicates by text
      if (seenText.has(text)) continue;
      seenText.add(text);
      
      // Store element
      indexMap[idx] = el;
      
      // Truncate for display
      const maxLen = (tag === 'p') ? 300 : 120;
      const displayText = text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
      
      indexLines.push(`[${idx}] (${type}) ${displayText}`);
      idx++;
    }
  }
  
  // Store globally
  window._xwebagentIndex = indexMap;
  
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
