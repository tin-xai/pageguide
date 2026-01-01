// XWebAgent - Utility Functions
// Helper functions for page analysis and content extraction

/**
 * Get simplified HTML structure for LLM context
 * Removes scripts, styles, XWebAgent elements, and unnecessary attributes
 */
function getSimplifiedHTML(maxLength = 10000) {
  const clone = document.body.cloneNode(true);
  
  // Remove non-content elements
  ['script', 'style', 'noscript', 'iframe', 'svg'].forEach(sel => {
    clone.querySelectorAll(sel).forEach(el => el.remove());
  });
  
  // Remove XWebAgent elements (chat panel and all children)
  // Use multiple selectors to catch all our elements
  const xwebagentSelectors = [
    '#xwebagent-chat-panel',
    '#xwebagent-toggle-btn', 
    '#xwebagent-custom-style',
    '[id*="xwebagent"]',
    '[class*="xwebagent"]',
    '[data-xwebagent-styled]'
  ];
  clone.querySelectorAll(xwebagentSelectors.join(',')).forEach(el => el.remove());
  
  // Keep only important attributes
  const keepAttrs = ['id', 'class', 'href', 'src', 'alt', 'title', 'type', 'name'];
  clone.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      if (!keepAttrs.includes(attr.name)) el.removeAttribute(attr.name);
    });
  });
  
  // Clean and truncate
  let html = clone.innerHTML.replace(/\s+/g, ' ').replace(/>\s+</g, '><');
  return html.length > maxLength ? html.slice(0, maxLength) + '...' : html;
}

/**
 * Get a summary of page structure (element counts)
 * Excludes XWebAgent elements
 */
function getPageStructure() {
  // Helper to count elements excluding XWebAgent
  const countExcluding = (selector) => {
    return Array.from(document.querySelectorAll(selector))
      .filter(el => !el.closest('[id^="xwebagent"]'))
      .length;
  };
  
  const counts = {
    'images': countExcluding('img'),
    'links': countExcluding('a'),
    'buttons': countExcluding('button'),
    'headings': countExcluding('h1,h2,h3,h4,h5,h6'),
    'inputs': countExcluding('input,textarea,select'),
  };
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${count} ${name}`)
    .join(', ');
}

/**
 * Find all links on the page (excludes XWebAgent elements)
 */
function findLinks(limit = 20) {
  return Array.from(document.querySelectorAll('a[href]'))
    .filter(a => !a.closest('[id^="xwebagent"]'))
    .slice(0, limit)
    .map(a => ({
      text: (a.innerText || '').slice(0, 50) || a.href.slice(0, 50),
      href: a.href
    }));
}

/**
 * Detect if query is asking to modify page styling
 */
function detectStylingCommand(query) {
  const q = query.toLowerCase();
  const hasStyleWord = STYLING_KEYWORDS.style.some(w => q.includes(w));
  const hasActionWord = STYLING_KEYWORDS.action.some(w => q.includes(w));
  return hasStyleWord && hasActionWord;
}

