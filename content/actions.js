// XWebAgent - Actions Module
// Defines available actions and provides execution functions

/**
 * Available actions the agent can perform
 */
const AVAILABLE_ACTIONS = [
  {
    name: 'click',
    description: 'Click on an element by its index number',
    args: [{ name: 'index', type: 'number', description: 'Element index from PAGE INDEX' }]
  },
  {
    name: 'hover',
    description: 'Hover mouse over an element',
    args: [{ name: 'index', type: 'number', description: 'Element index from PAGE INDEX' }]
  },
  {
    name: 'type',
    description: 'Type text into an input field',
    args: [
      { name: 'index', type: 'number', description: 'Input element index' },
      { name: 'text', type: 'string', description: 'Text to type' }
    ]
  },
  {
    name: 'scroll',
    description: 'Scroll the page',
    args: [{ name: 'direction', type: 'string', description: 'up, down, left, right' }]
  },
  {
    name: 'goto',
    description: 'Navigate to a URL',
    args: [{ name: 'url', type: 'string', description: 'URL to navigate to' }]
  },
  {
    name: 'back',
    description: 'Go back to previous page',
    args: []
  },
  {
    name: 'forward',
    description: 'Go forward to next page',
    args: []
  },
  {
    name: 'refresh',
    description: 'Refresh current page',
    args: []
  },
  {
    name: 'select',
    description: 'Select an option from a dropdown',
    args: [
      { name: 'index', type: 'number', description: 'Select element index' },
      { name: 'value', type: 'string', description: 'Option value or text' }
    ]
  },
  {
    name: 'wait',
    description: 'Wait for a specified time',
    args: [{ name: 'ms', type: 'number', description: 'Milliseconds to wait' }]
  },
  {
    name: 'expandContent',
    description: 'Click "See more", "Show more", "Load more" buttons to expand hidden content (max 2 times)',
    args: [{ name: 'maxClicks', type: 'number', description: 'Maximum expand clicks (default 2)' }]
  }
];

/**
 * Get formatted action list for LLM prompt
 */
function getActionsForPrompt() {
  return AVAILABLE_ACTIONS.map(action => {
    const argsStr = action.args.map(a => `${a.name}: ${a.type}`).join(', ');
    return `- ${action.name}(${argsStr}): ${action.description}`;
  }).join('\n');
}

/**
 * Execute an action
 * @param {string} actionName - Name of the action
 * @param {object} args - Action arguments
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function executeAction(actionName, args = {}) {
  console.log('🤖 Executing action:', actionName, args);
  
  try {
    switch (actionName.toLowerCase()) {
      case 'click':
        return await actionClick(args.index);
      
      case 'hover':
        return await actionHover(args.index);
      
      case 'type':
        return await actionType(args.index, args.text);
      
      case 'scroll':
        return await actionScroll(args.direction);
      
      case 'goto':
        return await actionGoto(args.url);
      
      case 'back':
        return await actionBack();
      
      case 'forward':
        return await actionForward();
      
      case 'refresh':
        return await actionRefresh();
      
      case 'select':
        return await actionSelect(args.index, args.value);
      
      case 'wait':
        return await actionWait(args.ms);
      
      case 'expandcontent':
        return await actionExpandContent(args.maxClicks);
      
      default:
        return { success: false, message: `Unknown action: ${actionName}` };
    }
  } catch (error) {
    console.error('🤖 Action error:', error);
    return { success: false, message: error.message };
  }
}

// ===== Action Implementations =====

/**
 * Click on an element by index
 */
async function actionClick(index) {
  const element = getIndexedElement(index);
  if (!element) {
    return { success: false, message: `Element [${index}] not found` };
  }
  
  // Scroll element into view
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(300);
  
  // Highlight before clicking
  highlightElement(element, 'click');
  await sleep(200);
  
  // Save session before click (in case it navigates)
  if (typeof saveSession === 'function') {
    await saveSession();
  }
  
  // Simulate click
  element.click();
  
  return { success: true, message: `Clicked on [${index}]` };
}

/**
 * Hover over an element
 */
async function actionHover(index) {
  const element = getIndexedElement(index);
  if (!element) {
    return { success: false, message: `Element [${index}] not found` };
  }
  
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(300);
  
  highlightElement(element, 'hover');
  
  // Dispatch mouse events
  element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  
  return { success: true, message: `Hovering on [${index}]` };
}

/**
 * Type text into an input
 */
async function actionType(index, text) {
  const element = getIndexedElement(index);
  if (!element) {
    return { success: false, message: `Element [${index}] not found` };
  }
  
  // Check if it's an input element
  const tag = element.tagName.toLowerCase();
  if (!['input', 'textarea'].includes(tag) && !element.isContentEditable) {
    return { success: false, message: `Element [${index}] is not an input field` };
  }
  
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(300);
  
  highlightElement(element, 'type');
  
  // Focus and clear
  element.focus();
  
  if (element.isContentEditable) {
    element.innerHTML = '';
  } else {
    element.value = '';
  }
  
  // Type character by character for realistic effect
  for (const char of text) {
    if (element.isContentEditable) {
      element.innerHTML += char;
    } else {
      element.value += char;
    }
    
    // Dispatch input event
    element.dispatchEvent(new InputEvent('input', { 
      bubbles: true, 
      data: char,
      inputType: 'insertText'
    }));
    
    await sleep(30); // Typing speed
  }
  
  // Dispatch change event
  element.dispatchEvent(new Event('change', { bubbles: true }));
  
  return { success: true, message: `Typed "${text}" into [${index}]` };
}

/**
 * Scroll the page
 */
async function actionScroll(direction) {
  const scrollAmount = window.innerHeight * 0.7;
  
  let x = 0, y = 0;
  switch (direction?.toLowerCase()) {
    case 'up':
      y = -scrollAmount;
      break;
    case 'down':
      y = scrollAmount;
      break;
    case 'left':
      x = -scrollAmount;
      break;
    case 'right':
      x = scrollAmount;
      break;
    default:
      y = scrollAmount; // Default to scroll down
  }
  
  window.scrollBy({ left: x, top: y, behavior: 'smooth' });
  await sleep(500);
  
  return { success: true, message: `Scrolled ${direction || 'down'}` };
}

/**
 * Navigate to URL
 */
async function actionGoto(url) {
  if (!url) {
    return { success: false, message: 'No URL provided' };
  }
  
  // Add protocol if missing
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  
  // Save session before navigating
  if (typeof saveSession === 'function') {
    await saveSession();
  }
  
  window.location.href = url;
  return { success: true, message: `Navigating to ${url}` };
}

/**
 * Go back
 */
async function actionBack() {
  window.history.back();
  return { success: true, message: 'Going back' };
}

/**
 * Go forward
 */
async function actionForward() {
  window.history.forward();
  return { success: true, message: 'Going forward' };
}

/**
 * Refresh page
 */
async function actionRefresh() {
  window.location.reload();
  return { success: true, message: 'Refreshing page' };
}

/**
 * Select option from dropdown
 */
async function actionSelect(index, value) {
  const element = getIndexedElement(index);
  if (!element) {
    return { success: false, message: `Element [${index}] not found` };
  }
  
  if (element.tagName.toLowerCase() !== 'select') {
    return { success: false, message: `Element [${index}] is not a select dropdown` };
  }
  
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  highlightElement(element, 'select');
  
  // Find option by value or text
  const options = Array.from(element.options);
  const option = options.find(opt => 
    opt.value === value || 
    opt.text.toLowerCase().includes(value.toLowerCase())
  );
  
  if (!option) {
    return { success: false, message: `Option "${value}" not found` };
  }
  
  element.value = option.value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
  
  return { success: true, message: `Selected "${option.text}"` };
}

/**
 * Wait for specified time
 */
async function actionWait(ms) {
  const waitTime = Math.min(ms || 1000, 10000); // Max 10 seconds
  await sleep(waitTime);
  return { success: true, message: `Waited ${waitTime}ms` };
}

/**
 * Expand content by clicking "See more", "Show more", "Load more" buttons
 * Limited to maxClicks to avoid infinite expansion
 */
async function actionExpandContent(maxClicks = 2) {
  const MAX_EXPAND_CLICKS = Math.min(maxClicks || 2, 5); // Cap at 5 to be safe
  
  // Common patterns for expand buttons (case insensitive)
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
    /^see\s*\d+\s*more$/i,      // "See 10 more"
    /^show\s*\d+\s*more$/i,     // "Show 10 more"
    /^load\s*\d+\s*more$/i,     // "Load 10 more"
    /^view\s*\d+\s*more$/i,     // "View 5 more"
    /^more$/i,
    /^…$/,                       // Ellipsis button
    /^\.\.\.$/,                  // Three dots
  ];
  
  // Selector for potential expand buttons
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
    // Find all potential expand buttons
    const candidates = document.querySelectorAll(EXPAND_SELECTORS.join(', '));
    let foundButton = null;
    
    for (const el of candidates) {
      // Skip if already clicked
      if (clickedElements.has(el)) continue;
      
      // Skip hidden elements
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
      
      // Skip our own UI
      if (isXWebAgentElement && isXWebAgentElement(el)) continue;
      
      // Get text content
      const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
      
      // Check if text matches expand patterns
      const matchesPattern = EXPAND_PATTERNS.some(pattern => pattern.test(text));
      
      // Also check class names and aria-labels for expand hints
      const classNames = (el.className || '').toLowerCase();
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      const hasExpandClass = /\b(more|expand|load-more|show-more|see-more|view-more)\b/.test(classNames);
      const hasExpandAria = /\b(more|expand|load|show|see)\b/.test(ariaLabel);
      
      if (matchesPattern || hasExpandClass || hasExpandAria) {
        // Make sure it's visible in viewport or scroll to it
        if (!isInViewport(el)) {
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
    
    // Mark as clicked before clicking (to avoid double-clicking same element)
    clickedElements.add(foundButton);
    
    const buttonText = (foundButton.textContent || '').trim().substring(0, 30);
    console.log('🤖 Found expand button:', buttonText);
    
    // Highlight the button
    highlightElement(foundButton, 'click');
    await sleep(300);
    
    // Click the button
    try {
      foundButton.click();
      clickCount++;
      expandedContent.push(buttonText || 'expand button');
      
      console.log('🤖 Clicked expand button', clickCount, '/', MAX_EXPAND_CLICKS);
      
      // Wait for content to load
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

// ===== Helper Functions =====

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
  
  // Add highlight effect
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
 * Parse action string from LLM response
 * Supports formats: "click(5)" or {"action": "click", "index": 5}
 */
function parseAction(actionStr) {
  // Try JSON format first
  if (typeof actionStr === 'object') {
    return {
      name: actionStr.action || actionStr.name,
      args: actionStr
    };
  }
  
  // Parse string format: "actionName(arg1, arg2)"
  const match = actionStr.match(/^(\w+)\(([^)]*)\)$/);
  if (!match) {
    return null;
  }
  
  const name = match[1];
  const argsStr = match[2].trim();
  
  // Parse arguments
  const args = {};
  if (argsStr) {
    const argParts = argsStr.split(',').map(s => s.trim());
    
    // Map to expected arg names based on action
    const action = AVAILABLE_ACTIONS.find(a => a.name === name);
    if (action) {
      argParts.forEach((val, i) => {
        if (action.args[i]) {
          // Remove quotes from string values
          let parsedVal = val.replace(/^["']|["']$/g, '');
          // Convert to number if needed
          if (action.args[i].type === 'number') {
            parsedVal = parseInt(parsedVal, 10);
          }
          args[action.args[i].name] = parsedVal;
        }
      });
    }
  }
  
  return { name, args };
}

