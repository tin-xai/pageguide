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
  
  // Text-based search and style (supports array or single string)
  if (styling.textSearch) {
    const searchTerms = Array.isArray(styling.textSearch) 
      ? styling.textSearch 
      : [styling.textSearch];
    
    searchTerms.forEach(term => {
      if (term && term.trim()) {
        count += highlightTextContent(term.trim(), styling.inlineStyles || {});
      }
    });
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
 * Find text and wrap matching portions in styled spans
 * This highlights only the exact matching text, not the whole parent element
 */
function highlightTextContent(searchText, styles = {}) {
  const searchLower = searchText.toLowerCase();
  let count = 0;
  
  // Default styles for the highlight span
  const defaultStyles = {
    color: styles.color || 'red',
    fontWeight: styles.fontWeight || 'bold',
    backgroundColor: styles.backgroundColor || 'rgba(255,255,0,0.4)',
    borderRadius: '2px',
    padding: '0 2px',
    ...styles
  };
  
  // Build inline style string
  const styleString = Object.entries(defaultStyles)
    .map(([key, value]) => `${key.replace(/([A-Z])/g, '-$1').toLowerCase()}: ${value}`)
    .join('; ');
  
  // Walk through all text nodes
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    
    // Skip script/style/xwebagent elements
    if (parent && 
        !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName) &&
        !isXWebAgentElement(parent) &&
        node.textContent.toLowerCase().includes(searchLower)) {
      textNodes.push(node);
    }
  }
  
  // Process text nodes (in reverse to avoid messing up walker)
  textNodes.forEach(textNode => {
    const text = textNode.textContent;
    const lowerText = text.toLowerCase();
    const index = lowerText.indexOf(searchLower);
    
    if (index === -1) return;
    
    // Split the text node and wrap the match in a span
    const before = text.slice(0, index);
    const match = text.slice(index, index + searchText.length);
    const after = text.slice(index + searchText.length);
    
    // Create elements
    const span = document.createElement('span');
    span.className = 'xwebagent-highlight';
    span.setAttribute('style', styleString);
    span.setAttribute('data-xwebagent-styled', 'true');
    span.textContent = match;
    
    // Create a document fragment with before + span + after
    const fragment = document.createDocumentFragment();
    if (before) fragment.appendChild(document.createTextNode(before));
    fragment.appendChild(span);
    if (after) fragment.appendChild(document.createTextNode(after));
    
    // Replace the original text node
    textNode.parentNode.replaceChild(fragment, textNode);
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
  
  // Remove highlight spans (unwrap them back to text)
  document.querySelectorAll('span.xwebagent-highlight').forEach(span => {
    const text = document.createTextNode(span.textContent);
    span.parentNode.replaceChild(text, span);
    count++;
  });
  
  // Reset inline styles on other marked elements
  const styledProps = ['color', 'backgroundColor', 'fontWeight', 'outline', 
    'outlineOffset', 'border', 'textDecoration', 'boxShadow'];
  
  document.querySelectorAll('[data-xwebagent-styled]').forEach(el => {
    styledProps.forEach(prop => el.style[prop] = '');
    el.removeAttribute('data-xwebagent-styled');
    count++;
  });
  
  return { success: true, count };
}

