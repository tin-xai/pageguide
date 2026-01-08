// XWebAgent - Chat Panel UI
// Handles the chat interface and user interactions

// State (guarded against double-loading)
if (typeof chatMessages === 'undefined') var chatMessages = [];
if (typeof chatPanelOpen === 'undefined') var chatPanelOpen = false;

// ===== SESSION PERSISTENCE =====

/**
 * Save session state to chrome.storage.session
 */
async function saveSession() {
  try {
    const guidance = window._xwebagentGuidance || {};
    await chrome.storage.session.set({
      xwebagent_session: {
        chatMessages: chatMessages.slice(-20), // Keep last 20 messages
        panelOpen: chatPanelOpen,
        guidance: {
          active: guidance.active,
          question: guidance.question,
          currentStep: guidance.currentStep,
          previousSteps: guidance.previousSteps
        },
        timestamp: Date.now()
      }
    });
    console.log('💾 Session saved');
  } catch (e) {
    console.log('💾 Could not save session:', e.message);
  }
}

/**
 * Load session state from chrome.storage.session
 */
async function loadSession() {
  try {
    const data = await chrome.storage.session.get('xwebagent_session');
    const session = data.xwebagent_session;
    
    if (!session) return null;
    
    // Check if session is recent (within 5 minutes)
    const age = Date.now() - (session.timestamp || 0);
    if (age > 5 * 60 * 1000) {
      console.log('💾 Session expired');
      await chrome.storage.session.remove('xwebagent_session');
      return null;
    }
    
    console.log('💾 Session loaded:', session);
    return session;
  } catch (e) {
    console.log('💾 Could not load session:', e.message);
    return null;
  }
}

/**
 * Clear session
 */
async function clearSession() {
  try {
    await chrome.storage.session.remove('xwebagent_session');
    console.log('💾 Session cleared');
  } catch (e) {
    console.log('💾 Could not clear session');
  }
}

/**
 * Restore chat messages from session
 */
function restoreChatMessages(messages) {
  const container = document.getElementById('xwebagent-messages');
  if (!container || !messages) return;
  
  chatMessages = messages;
  
  messages.forEach(msg => {
    const div = document.createElement('div');
    div.className = `xwebagent-message ${msg.type}`;
    div.textContent = msg.content;
    container.appendChild(div);
  });
  
  container.scrollTop = container.scrollHeight;
}

/**
 * Restore guidance state from session
 */
function restoreGuidance(guidanceState) {
  if (!guidanceState || !guidanceState.active) return;
  
  window._xwebagentGuidance = {
    active: guidanceState.active,
    question: guidanceState.question,
    currentStep: guidanceState.currentStep,
    previousSteps: guidanceState.previousSteps || [],
    waitingForAction: null
  };
  
  console.log('🎯 Guidance restored:', window._xwebagentGuidance);
  
  // Add a message that we're continuing
  addChatMessage('📍 Continuing from previous page...', 'system');
  
  // Continue guidance on the new page after a short delay
  setTimeout(async () => {
    const result = await continueGuidance();
    if (result && result.success) {
      addGuideStep(result);
    }
  }, 1000);
}

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
    </div>
    
    <div class="xwebagent-chat-input-area">
      <div class="xwebagent-quick-actions">
        <button class="xwebagent-quick-btn" data-action="safety" title="Scan for dark patterns & ads">🛡️ Safety</button>
        <button class="xwebagent-quick-btn" data-action="hideAds" title="Hide ads">🚫 Ads</button>
        <button class="xwebagent-quick-btn" data-action="reset" title="Clear all markings">🧹 Clear</button>
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
  
  // Restore session from previous page
  restoreSessionOnLoad();
}

/**
 * Restore session when panel loads
 */
async function restoreSessionOnLoad() {
  const session = await loadSession();
  
  if (session) {
    // Restore chat messages
    if (session.chatMessages && session.chatMessages.length > 0) {
      restoreChatMessages(session.chatMessages);
    }
    
    // Restore panel state
    if (session.panelOpen) {
      const panel = document.getElementById('xwebagent-chat-panel');
      if (panel) {
        chatPanelOpen = true;
        panel.classList.add('open');
        document.body.classList.add('xwebagent-panel-open');
      }
    }
    
    // Restore guidance if active
    if (session.guidance && session.guidance.active) {
      restoreGuidance(session.guidance);
    }
  }
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
  
  // Save session state
  saveSession();
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
  
  // Save session after adding message
  saveSession();
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
 * Add a step-by-step guide message
 */
function addGuideStep(result) {
  const container = document.getElementById('xwebagent-messages');
  if (!container) return;
  
  const msg = document.createElement('div');
  msg.className = 'xwebagent-message guide';
  
  // Step indicator
  const stepBadge = result.isLastStep ? '✅' : `Step ${result.step}`;
  
  msg.innerHTML = `
    <div class="xwebagent-guide-step">
      <span class="xwebagent-step-badge">${stepBadge}</span>
      <span class="xwebagent-step-text">${result.answer}</span>
    </div>
    ${result.nextStepHint && !result.isLastStep ? `<div class="xwebagent-next-hint">💡 ${result.nextStepHint}</div>` : ''}
    ${!result.isLastStep ? `<div class="xwebagent-guide-waiting">👆 Complete this step, then I'll show you the next one</div>` : ''}
  `;
  
  // Make clickable to scroll to highlight
  if (result.hasHighlights) {
    msg.classList.add('xwebagent-clickable');
    msg.addEventListener('click', () => scrollToHighlight(0));
  }
  
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

/**
 * Continue guidance after user action
 */
async function handleContinueGuide() {
  showTyping();
  
  const result = await continueGuidance();
  hideTyping();
  
  if (result) {
    if (result.success) {
      addGuideStep(result);
    } else {
      addChatMessage(`❌ ${result.error}`, 'error');
    }
  }
}

// Listen for continue guidance events
window.addEventListener('xwebagent-continue-guide', () => {
  console.log('🎯 Continue guide event received');
  handleContinueGuide();
});

// Save session before page unloads (navigation)
window.addEventListener('beforeunload', () => {
  console.log('💾 Saving session before unload...');
  saveSession();
});

// Also save on visibility change (tab switching)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    saveSession();
  }
});

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
    // Smart routing: action commands go to agent, how-to goes to guide, else Q&A
    const result = await handleSmartQuery(query);
    hideTyping();
    
    if (result.success) {
      // Check if this is a step-by-step guide
      if (result.isGuide) {
        addGuideStep(result);
      }
      // Check if this was an agent action
      else if (result.action && result.action !== null) {
        if (result.thought) {
          addChatMessage(`💭 ${result.thought}`, 'system');
        }
        addChatMessage(`⚡ ${result.action}`, 'action');
        addChatMessage(result.answer, 'assistant', result.hasHighlights);
      }
      // Regular Q&A response
      else {
        let message = result.answer;
        if (result.highlightCount > 0) {
          message += ` ✨ (${result.highlightCount} highlighted)`;
        }
        const hasHighlights = result.hasHighlights || result.highlightCount > 0;
        addChatMessage(message, 'assistant', hasHighlights);
      }
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
        addChatMessage('Clear all markings', 'user');
        // Clear custom styles
        if (typeof resetCustomStyles === 'function') {
          resetCustomStyles();
        }
        // Clear protection markings
        if (typeof clearProtectionMarkings === 'function') {
          clearProtectionMarkings();
        }
        // Clear highlights
        if (typeof clearHighlights === 'function') {
          clearHighlights();
        }
        hideTyping();
        addChatMessage('🧹 Cleared all highlights and markings', 'system');
        break;
      
      case 'safety':
        addChatMessage('🛡️ Scanning for dark patterns & ads...', 'user');
        if (typeof applyProtection === 'function') {
          const results = await applyProtection();
          hideTyping();
          const report = generateSafetyReport(results);
          addChatMessage(report, 'assistant');
        } else {
          hideTyping();
          addChatMessage('Protection module not loaded', 'error');
        }
        break;
      
      case 'hideAds':
        addChatMessage('🚫 Hiding ads...', 'user');
        if (typeof detectAds === 'function' && typeof hideAds === 'function') {
          const ads = detectAds();
          const count = hideAds(ads, 'blur');
          hideTyping();
          addChatMessage(
            count > 0 
              ? `🛡️ Blurred ${count} ads on this page`
              : '✅ No ads detected',
            'system'
          );
        } else {
          hideTyping();
          addChatMessage('Protection module not loaded', 'error');
        }
        break;
    }
  } catch (e) {
    hideTyping();
    addChatMessage(`Error: ${e.message}`, 'error');
  }
}

