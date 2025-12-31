// XWebAgent - Styling Functions
// Functions for modifying page CSS and element styles

/**
 * Apply styling from LLM response
 */
function applyStyling(styling) {
  let count = 0;
  
  // Inject raw CSS if provided
  if (styling.css) {
    injectCSS(styling.css);
  }
  
  // Text-based search and style
  if (styling.textSearch) {
    count = highlightTextContent(styling.textSearch, styling.inlineStyles || {});
  }
  
  // CSS selector-based styling
  if (styling.selector) {
    try {
      const elements = document.querySelectorAll(styling.selector);
      elements.forEach(el => {
        applyInlineStyles(el, styling.inlineStyles || {});
        count++;
      });
    } catch (e) {
      console.error('Invalid selector:', styling.selector);
    }
  }
  
  return count;
}

/**
 * Find elements containing specific text and apply styles
 */
function highlightTextContent(searchText, styles = {}) {
  const searchLower = searchText.toLowerCase();
  let count = 0;
  
  // Walk through all text nodes
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const elements = new Set();
  
  while (walker.nextNode()) {
    if (walker.currentNode.textContent.toLowerCase().includes(searchLower)) {
      const parent = walker.currentNode.parentElement;
      if (parent && !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) {
        elements.add(parent);
      }
    }
  }
  
  // Apply styles to found elements
  const defaultStyles = {
    color: styles.color || 'red',
    fontWeight: styles.fontWeight || 'bold',
    backgroundColor: styles.backgroundColor || 'rgba(255,0,0,0.1)',
    ...styles
  };
  
  elements.forEach(el => {
    applyInlineStyles(el, defaultStyles);
    count++;
  });
  
  return count;
}

/**
 * Apply inline styles to an element
 */
function applyInlineStyles(el, styles) {
  if (!styles || Object.keys(styles).length === 0) {
    el.style.outline = '3px solid red';
    el.style.outlineOffset = '2px';
  } else {
    Object.assign(el.style, styles);
  }
  el.setAttribute('data-xwebagent-styled', 'true');
}

/**
 * Inject CSS into the page
 */
function injectCSS(css) {
  let style = document.getElementById('xwebagent-custom-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'xwebagent-custom-style';
    document.head.appendChild(style);
  }
  style.textContent += '\n' + css;
}

/**
 * Quick style presets (no AI needed)
 */
function applyQuickStyle(type) {
  const styles = {
    images: { 
      selector: 'img', 
      css: 'img { outline: 3px solid red !important; outline-offset: 2px !important; }' 
    },
    links: { 
      selector: 'a', 
      css: 'a { background: yellow !important; color: black !important; }' 
    },
    buttons: { 
      selector: 'button, [role="button"], input[type="submit"]', 
      css: 'button, [role="button"], input[type="submit"] { outline: 3px solid lime !important; }' 
    },
    headings: { 
      selector: 'h1,h2,h3,h4,h5,h6', 
      css: 'h1,h2,h3,h4,h5,h6 { color: #00d9ff !important; }' 
    }
  };
  
  const s = styles[type];
  if (!s) return { count: 0 };
  
  injectCSS(s.css);
  return { count: document.querySelectorAll(s.selector).length };
}

/**
 * Reset all custom styles applied by XWebAgent
 */
function resetCustomStyles() {
  let count = 0;
  
  // Remove injected style tag
  const style = document.getElementById('xwebagent-custom-style');
  if (style) style.remove();
  
  // Reset inline styles on marked elements
  const styledProps = ['color', 'backgroundColor', 'fontWeight', 'outline', 
    'outlineOffset', 'border', 'textDecoration', 'boxShadow'];
  
  document.querySelectorAll('[data-xwebagent-styled]').forEach(el => {
    styledProps.forEach(prop => el.style[prop] = '');
    el.removeAttribute('data-xwebagent-styled');
    count++;
  });
  
  return { success: true, count };
}

