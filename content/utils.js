// XWebAgent - Utility Functions
// Helper functions for page analysis and content extraction

/**
 * Get simplified HTML structure for LLM context
 * Removes scripts, styles, and unnecessary attributes
 */
function getSimplifiedHTML(maxLength = 10000) {
  const clone = document.body.cloneNode(true);
  
  // Remove non-content elements
  ['script', 'style', 'noscript', 'iframe', 'svg'].forEach(sel => {
    clone.querySelectorAll(sel).forEach(el => el.remove());
  });
  
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
 */
function getPageStructure() {
  const counts = {
    'images': document.querySelectorAll('img').length,
    'links': document.querySelectorAll('a').length,
    'buttons': document.querySelectorAll('button').length,
    'headings': document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
    'inputs': document.querySelectorAll('input,textarea,select').length,
  };
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${count} ${name}`)
    .join(', ');
}

/**
 * Find all links on the page
 */
function findLinks(limit = 20) {
  return Array.from(document.querySelectorAll('a[href]'))
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

