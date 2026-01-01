// XWebAgent - Styling Functions
// Functions for modifying page CSS and element styles

/**
 * Check if element is part of XWebAgent UI (should not be styled)
 */
function isXWebAgentElement(el) {
  if (!el) return false;
  // Only check if inside our chat panel
  return el.closest('#xwebagent-chat-panel') !== null;
}

/**
 * Apply styling from LLM response
 */
function applyStyling(styling) {
  let count = 0;
  
  // Text-based search and style
  if (styling.textSearch) {
    count = highlightTextContent(styling.textSearch, styling.inlineStyles || {});
  }
  
  // CSS selector-based styling (using inline styles to avoid affecting our UI)
  if (styling.selector) {
    try {
      const elements = document.querySelectorAll(styling.selector);
      elements.forEach(el => {
        // Skip XWebAgent elements
        if (isXWebAgentElement(el)) return;
        applyInlineStyles(el, styling.inlineStyles || {});
        count++;
      });
    } catch (e) {
      console.error('Invalid selector:', styling.selector);
    }
  }
  
  // Inject raw CSS only if no selector/textSearch (fallback)
  if (styling.css && !styling.selector && !styling.textSearch) {
    injectCSS(styling.css);
  }
  
  return count;
}

/**
 * Find elements containing specific text and apply styles
 * Excludes XWebAgent UI elements
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
      // Skip script/style tags AND XWebAgent elements
      if (parent && 
          !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName) &&
          !isXWebAgentElement(parent)) {
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
 * Uses inline styles to avoid affecting XWebAgent UI
 */
function applyQuickStyle(type) {
  const presets = {
    images: { 
      selector: 'img', 
      styles: { outline: '3px solid red', outlineOffset: '2px' }
    },
    links: { 
      selector: 'a', 
      styles: { backgroundColor: 'yellow', color: 'black' }
    },
    buttons: { 
      selector: 'button, [role="button"], input[type="submit"]', 
      styles: { outline: '3px solid lime', outlineOffset: '2px' }
    },
    headings: { 
      selector: 'h1, h2, h3, h4, h5, h6', 
      styles: { color: '#00d9ff' }
    }
  };
  
  const preset = presets[type];
  if (!preset) return { count: 0 };
  
  let count = 0;
  document.querySelectorAll(preset.selector).forEach(el => {
    // Skip XWebAgent elements
    if (isXWebAgentElement(el)) return;
    applyInlineStyles(el, preset.styles);
    count++;
  });
  
  return { count };
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

