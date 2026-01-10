// XWebAgent - Actions Module (Simplified)
// Contains utility actions for content expansion

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Highlight element during action
 */
function highlightElement(element, actionType) {
  const colors = {
    click: '#ff6b6b',
    hover: '#4ecdc4',
    type: '#ffe66d',
    select: '#95e1d3'
  };
  
  const color = colors[actionType] || '#00d9ff';
  
  element.style.outline = `3px solid ${color}`;
  element.style.outlineOffset = '2px';
  element.style.boxShadow = `0 0 20px ${color}`;
  element.setAttribute('data-xwebagent-action', actionType);
  
  // Remove after 2 seconds
  setTimeout(() => {
    element.style.outline = '';
    element.style.outlineOffset = '';
    element.style.boxShadow = '';
    element.removeAttribute('data-xwebagent-action');
  }, 2000);
}

/**
 * Expand content by clicking "See more", "Show more", "Load more" buttons
 * Used by handleAsk() when LLM requests content expansion
 * @param {number} maxClicks - Maximum number of expand buttons to click (default 2)
 */
async function actionExpandContent(maxClicks = 2) {
  const MAX_EXPAND_CLICKS = Math.min(maxClicks || 2, 5);
  
  // Common patterns for expand buttons
  const EXPAND_PATTERNS = [
    /^see\s*more$/i,
    /^show\s*more$/i,
    /^load\s*more$/i,
    /^view\s*more$/i,
    /^read\s*more$/i,
    /^more\s*results?$/i,
    /^show\s*all$/i,
    /^view\s*all$/i,
    /^expand$/i,
    /^expand\s*all$/i,
    /^\+\s*more$/i,
    /^see\s*\d+\s*more$/i,
    /^show\s*\d+\s*more$/i,
    /^load\s*\d+\s*more$/i,
    /^view\s*\d+\s*more$/i,
    /^more$/i,
    /^…$/,
    /^\.\.\.$/,
  ];
  
  // Selectors for potential expand buttons
  const EXPAND_SELECTORS = [
    'button',
    '[role="button"]',
    'a',
    '[class*="more"]',
    '[class*="expand"]',
    '[class*="load"]',
    '[data-testid*="more"]',
    '[data-testid*="expand"]',
    '[aria-label*="more"]',
    '[aria-label*="show"]',
    '[aria-label*="expand"]',
  ];
  
  let clickCount = 0;
  const clickedElements = new Set();
  const expandedContent = [];
  
  console.log('🤖 Starting content expansion (max', MAX_EXPAND_CLICKS, 'clicks)...');
  
  for (let attempt = 0; attempt < MAX_EXPAND_CLICKS; attempt++) {
    const candidates = document.querySelectorAll(EXPAND_SELECTORS.join(', '));
    let foundButton = null;
    
    for (const el of candidates) {
      if (clickedElements.has(el)) continue;
      
      // Skip hidden elements
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
      
      // Skip our UI
      if (typeof isXWebAgentElement === 'function' && isXWebAgentElement(el)) continue;
      
      // Get text content
      const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
      
      // Check if text matches expand patterns
      const matchesPattern = EXPAND_PATTERNS.some(pattern => pattern.test(text));
      
      // Also check class names and aria-labels
      const classNames = (el.className || '').toLowerCase();
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      const hasExpandClass = /\b(more|expand|load-more|show-more|see-more|view-more)\b/.test(classNames);
      const hasExpandAria = /\b(more|expand|load|show|see)\b/.test(ariaLabel);
      
      if (matchesPattern || hasExpandClass || hasExpandAria) {
        // Scroll to element if needed
        if (typeof isInViewport === 'function' && !isInViewport(el)) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(300);
        }
        
        foundButton = el;
        break;
      }
    }
    
    if (!foundButton) {
      console.log('🤖 No more expand buttons found after', clickCount, 'clicks');
      break;
    }
    
    clickedElements.add(foundButton);
    
    const buttonText = (foundButton.textContent || '').trim().substring(0, 30);
    console.log('🤖 Found expand button:', buttonText);
    
    highlightElement(foundButton, 'click');
    await sleep(300);
    
    try {
      foundButton.click();
      clickCount++;
      expandedContent.push(buttonText || 'expand button');
      console.log('🤖 Clicked expand button', clickCount, '/', MAX_EXPAND_CLICKS);
      await sleep(1000);
    } catch (error) {
      console.error('🤖 Error clicking expand button:', error);
      break;
    }
  }
  
  if (clickCount === 0) {
    return { 
      success: false, 
      message: 'No "See more" or "Show more" buttons found on this page' 
    };
  }
  
  return { 
    success: true, 
    message: `Expanded content ${clickCount} time(s): ${expandedContent.join(', ')}`,
    clickCount,
    expandedContent
  };
}
