// XWebAgent Side Panel Script
// Handles chat UI and communicates with content scripts

let chatMessages = [];
let conversationHistory = []; // Stores {role: 'user'|'assistant', content: string}
let currentTabId = null;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;
  
  // Attach event listeners
  document.getElementById('xwebagent-settings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  
  document.getElementById('xwebagent-send').addEventListener('click', sendMessage);
  document.getElementById('xwebagent-input').addEventListener('keypress', e => {
    if (e.key === 'Enter') sendMessage();
  });
  
  // Quick action buttons
  document.querySelectorAll('.xwebagent-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => handleQuickAction(btn.dataset.action));
  });
  
  // Focus input
  document.getElementById('xwebagent-input')?.focus();
  
  // Listen for tab changes
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    currentTabId = activeInfo.tabId;
  });
});

/**
 * Add a message to the chat
 */
function addMessage(content, type = 'assistant', clickable = false) {
  const container = document.getElementById('xwebagent-messages');
  if (!container) return;
  
  hideTyping();
  
  const msg = document.createElement('div');
  msg.className = `xwebagent-message ${type}`;
  
  if (clickable) {
    msg.classList.add('xwebagent-clickable');
    msg.innerHTML = `${content} <span class="xwebagent-scroll-hint">👆 Click to scroll</span>`;
    msg.addEventListener('click', () => {
      sendToContentScript({ action: 'scrollToHighlight' });
    });
  } else {
    msg.textContent = content;
  }
  
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  
  chatMessages.push({ content, type, timestamp: Date.now() });
}

/**
 * Add a guide step message
 */
function addGuideStep(result) {
  const container = document.getElementById('xwebagent-messages');
  if (!container) return;
  
  hideTyping();
  
  const msg = document.createElement('div');
  msg.className = 'xwebagent-message guide';
  
  const stepBadge = result.isLastStep ? '✅' : `Step ${result.step}`;
  
  msg.innerHTML = `
    <div class="xwebagent-guide-step">
      <span class="xwebagent-step-badge">${stepBadge}</span>
      <span class="xwebagent-step-text">${result.answer}</span>
    </div>
    ${result.nextStepHint && !result.isLastStep ? `<div class="xwebagent-next-hint">💡 ${result.nextStepHint}</div>` : ''}
    ${!result.isLastStep ? `<div class="xwebagent-guide-waiting">👆 Complete this step, then I'll show you the next one</div>` : ''}
  `;
  
  if (result.hasHighlights) {
    msg.classList.add('xwebagent-clickable');
    msg.addEventListener('click', () => {
      sendToContentScript({ action: 'scrollToHighlight' });
    });
  }
  
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

/**
 * Show typing indicator
 */
function showTyping() {
  const container = document.getElementById('xwebagent-messages');
  if (!container || container.querySelector('.xwebagent-typing')) return;
  
  const typing = document.createElement('div');
  typing.className = 'xwebagent-typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  container.appendChild(typing);
  container.scrollTop = container.scrollHeight;
}

/**
 * Hide typing indicator
 */
function hideTyping() {
  document.querySelector('.xwebagent-typing')?.remove();
}

/**
 * Send message to content script
 */
async function sendToContentScript(message) {
  if (!currentTabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab?.id;
  }
  
  if (!currentTabId) {
    throw new Error('No active tab found');
  }
  
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(currentTabId, message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Send a chat message
 */
async function sendMessage() {
  const input = document.getElementById('xwebagent-input');
  const btn = document.getElementById('xwebagent-send');
  if (!input?.value.trim()) return;
  
  const query = input.value.trim();
  input.value = '';
  btn.disabled = true;
  
  // Add to conversation history
  conversationHistory.push({ role: 'user', content: query });
  
  addMessage(query, 'user');
  showTyping();
  
  try {
    const result = await sendToContentScript({ 
      action: 'handleQuery', 
      query: query,
      history: conversationHistory.slice(0, -1) // Send history without current query
    });
    
    hideTyping();
    
    if (result && result.success) {
      // Show routing decision
      if (result.routedTo) {
        const confidence = Math.round((result.routeConfidence || 0) * 100);
        const handlerEmoji = {
          'ask': '💬',
          'guide': '📋',
          'protection': '🛡️'
        }[result.routedTo] || '🎯';
        addMessage(`${handlerEmoji} Routed to: ${result.routedTo} (${confidence}% - ${result.routeReason})`, 'system');
      }
      
      // Add assistant response to history
      if (result.answer) {
        conversationHistory.push({ role: 'assistant', content: result.answer });
      }
      
      if (result.isGuide) {
        addGuideStep(result);
      } else {
        let message = result.answer;
        if (result.highlightCount > 0) {
          message += ` ✨ (${result.highlightCount} highlighted)`;
        }
        const hasHighlights = result.hasHighlights || result.highlightCount > 0;
        addMessage(message, 'assistant', hasHighlights);
      }
    } else {
      addMessage(`❌ ${result?.error || 'Unknown error'}`, 'error');
      // Remove failed query from history
      conversationHistory.pop();
    }
  } catch (e) {
    hideTyping();
    addMessage(`Error: ${e.message}`, 'error');
    // Remove failed query from history
    conversationHistory.pop();
  }
  
  btn.disabled = false;
  input.focus();
}

/**
 * Handle quick action buttons
 */
async function handleQuickAction(action) {
  if (action === 'reset') {
    try {
      // Clear highlights on page
      await sendToContentScript({ action: 'reset' });
    } catch (e) {
      // Page might not have content script loaded
    }
    
    // Clear chat and history
    conversationHistory = [];
    chatMessages = [];
    const container = document.getElementById('xwebagent-messages');
    if (container) container.innerHTML = '';
    
    addMessage('🧹 Cleared chat and highlights', 'system');
  }
}

// Listen for messages from content script and background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'guideStep') {
    hideTyping();
    addGuideStep(message.result);
  } else if (message.action === 'addMessage') {
    addMessage(message.content, message.type, message.clickable);
  } else if (message.action === 'closePanel') {
    window.close();
  }
});

// Notify background when panel is closed
window.addEventListener('beforeunload', () => {
  try {
    chrome.runtime.sendMessage({ action: 'panelClosed' });
  } catch (e) {
    // Extension context might be invalidated
  }
});
