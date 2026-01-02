// XWebAgent - Chat Panel UI
// Handles the chat interface and user interactions

// State (guarded against double-loading)
if (typeof chatMessages === 'undefined') var chatMessages = [];
if (typeof chatPanelOpen === 'undefined') var chatPanelOpen = false;

/**
 * Create the chat panel UI
 */
function createChatPanel() {
  if (document.getElementById('xwebagent-chat-panel')) return;
  
  const panel = document.createElement('div');
  panel.id = 'xwebagent-chat-panel';
  panel.innerHTML = `
    <div class="xwebagent-chat-header">
      <div class="xwebagent-header-left">
        <img src="${chrome.runtime.getURL('icons/icon128.png')}" alt="XWebAgent" class="xwebagent-logo">
        <div class="xwebagent-header-text">
          <h2>XWebAgent</h2>
          <p>AI Web Assistant - Safe, Fun, Efficient</p>
        </div>
      </div>
      <div class="xwebagent-header-right">
        <button class="xwebagent-settings-btn" id="xwebagent-settings" title="Settings">⚙️</button>
        <button class="xwebagent-close-btn" id="xwebagent-close" title="Close">✕</button>
      </div>
    </div>
    
    <div class="xwebagent-chat-messages" id="xwebagent-messages">
      <div class="xwebagent-message system">
        👋 Hi! I can help you find information or style elements on this page.
      </div>
    </div>
    
    <div class="xwebagent-chat-input-area">
      <div class="xwebagent-quick-actions">
        <button class="xwebagent-quick-btn" data-action="summarize">📝 Summarize</button>
        <button class="xwebagent-quick-btn" data-action="links">🔗 Links</button>
        <button class="xwebagent-quick-btn" data-action="images">🖼️ Images</button>
        <button class="xwebagent-quick-btn" data-action="reset">🧹 Reset</button>
      </div>
      <div class="xwebagent-input-row">
        <input type="text" class="xwebagent-chat-input" id="xwebagent-input" placeholder="Ask anything...">
        <button class="xwebagent-send-btn" id="xwebagent-send">➤</button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);
  
  // Attach event listeners
  document.getElementById('xwebagent-close').addEventListener('click', toggleChatPanel);
  document.getElementById('xwebagent-settings').addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage({ action: 'openOptions' });
    } catch (e) {
      alert('Extension was updated. Please refresh the page.');
    }
  });
  document.getElementById('xwebagent-send').addEventListener('click', sendChatMessage);
  document.getElementById('xwebagent-input').addEventListener('keypress', e => {
    if (e.key === 'Enter') sendChatMessage();
  });
  
  // Quick action buttons
  document.querySelectorAll('.xwebagent-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => handleQuickAction(btn.dataset.action));
  });
}

/**
 * Toggle chat panel open/closed
 */
function toggleChatPanel() {
  const panel = document.getElementById('xwebagent-chat-panel');
  if (!panel) return;
  
  chatPanelOpen = !chatPanelOpen;
  panel.classList.toggle('open', chatPanelOpen);
  document.body.classList.toggle('xwebagent-panel-open', chatPanelOpen);
  
  if (chatPanelOpen) {
    setTimeout(() => document.getElementById('xwebagent-input')?.focus(), 300);
  }
}

/**
 * Add a message to the chat
 * @param {string} content - Message text
 * @param {string} type - Message type (user, assistant, system, error)
 * @param {boolean} clickable - If true, clicking scrolls to highlights
 */
function addChatMessage(content, type = 'assistant', clickable = false) {
  const container = document.getElementById('xwebagent-messages');
  if (!container) return;
  
  // Remove typing indicator
  hideTyping();
  
  const msg = document.createElement('div');
  msg.className = `xwebagent-message ${type}`;
  
  if (clickable) {
    // Make message clickable to scroll to highlights
    msg.classList.add('xwebagent-clickable');
    msg.innerHTML = `${content} <span class="xwebagent-scroll-hint">👆 Click to scroll</span>`;
    
    let clickIndex = 0;
    msg.addEventListener('click', () => {
      scrollToHighlight(clickIndex);
      clickIndex++;
    });
  } else {
    msg.textContent = content;
  }
  
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  
  chatMessages.push({ content, type, timestamp: Date.now() });
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
 * Send a chat message
 */
async function sendChatMessage() {
  const input = document.getElementById('xwebagent-input');
  const btn = document.getElementById('xwebagent-send');
  if (!input?.value.trim()) return;
  
  const query = input.value.trim();
  input.value = '';
  btn.disabled = true;
  
  addChatMessage(query, 'user');
  showTyping();
  
  try {
    // Unified approach: handleAsk answers AND highlights
    const result = await handleAsk(query);
    hideTyping();
    
    if (result.success) {
      let message = result.answer;
      // Add highlight count if any elements were highlighted
      if (result.highlightCount > 0) {
        message += ` ✨ (${result.highlightCount} highlighted)`;
      }
      // Make clickable if there are highlights to scroll to
      const hasHighlights = result.hasHighlights || result.highlightCount > 0;
      addChatMessage(message, 'assistant', hasHighlights);
    } else {
      addChatMessage(`❌ ${result.error}`, 'error');
    }
  } catch (e) {
    hideTyping();
    addChatMessage(`Error: ${e.message}`, 'error');
  }
  
  btn.disabled = false;
}

/**
 * Handle quick action buttons
 */
async function handleQuickAction(action) {
  showTyping();
  
  try {
    switch (action) {
      case 'summarize':
        addChatMessage('Summarize this page', 'user');
        const summary = await handleAsk('Summarize this page in 2-3 sentences');
        hideTyping();
        addChatMessage(
          summary.success ? summary.answer : 'Could not summarize',
          summary.success ? 'assistant' : 'error'
        );
        break;
        
      case 'links':
        addChatMessage('Find links', 'user');
        const links = findLinks();
        hideTyping();
        const linkText = links.slice(0, 5).map(l => l.text).filter(t => t).join(', ');
        addChatMessage(`Found ${links.length} links: ${linkText}...`, 'assistant');
        break;
        
      case 'images':
        addChatMessage('Highlight images', 'user');
        const imgResult = applyQuickStyle('images');
        hideTyping();
        addChatMessage(`✨ Highlighted ${imgResult.count} images`, 'system');
        break;
        
      case 'reset':
        addChatMessage('Reset styles', 'user');
        const resetResult = resetCustomStyles();
        hideTyping();
        addChatMessage(`🧹 Reset ${resetResult.count} elements`, 'system');
        break;
    }
  } catch (e) {
    hideTyping();
    addChatMessage(`Error: ${e.message}`, 'error');
  }
}

