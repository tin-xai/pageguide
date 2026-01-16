// XWebAgent Side Panel Script
// Handles chat UI and communicates with content scripts

let chatMessages = [];
let conversationHistory = []; // Stores {role: 'user'|'assistant', content: string}
let currentTabId = null;
let uploadedImageBase64 = null; // Stores the uploaded image

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
  
  // Image upload handling
  const imageUpload = document.getElementById('xwebagent-image-upload');
  const removeImageBtn = document.getElementById('xwebagent-remove-image');
  
  if (imageUpload) {
    imageUpload.addEventListener('change', handleImageUpload);
  }
  
  if (removeImageBtn) {
    removeImageBtn.addEventListener('click', clearUploadedImage);
  }
  
  // Paste image support (Ctrl+V / Cmd+V)
  document.addEventListener('paste', handlePasteImage);
  
  // Focus input
  document.getElementById('xwebagent-input')?.focus();
  
  // Listen for tab changes
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    currentTabId = activeInfo.tabId;
  });
});

/**
 * Parse citations in text and make them clickable
 * Converts [N:"text"] or [N] to clickable spans showing the text (not the number)
 * For [N:"text"] format, removes duplicate text if it appears before the citation
 * For [N] format, extracts the preceding phrase as the clickable text
 */
function parseCitations(text) {
  // Normalize curly/smart quotes to straight quotes first
  const normalizedText = text
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'");
  
  // Match citations with various quote styles:
  // [N:"text"] - double quoted (text can contain apostrophes)
  // [N:'text'] - single quoted (text can contain double quotes)
  // [N:text] - unquoted
  // [N] - just index
  const citationPattern = /\[(\d+)(?::\s*(?:"([^"]+)"|'([^']+)'|([^\]]+)))?\]/g;
  
  // Use normalized text for parsing
  text = normalizedText;
  
  let lastIndex = 0;
  let result = '';
  let match;
  
  while ((match = citationPattern.exec(text)) !== null) {
    const index = match[1];
    // Text could be in group 2 (double quoted), 3 (single quoted), or 4 (unquoted)
    const explicitText = match[2] || match[3] || match[4];
    
    if (explicitText) {
      // Has explicit text: [N:"text"] format
      let textBefore = text.slice(lastIndex, match.index);
      
      // Check if the explicit text already appears right before the citation (avoid duplication)
      // e.g., "Queen's University [498:"Queen's University"]" -> just show "Queen's University" once
      const explicitLower = explicitText.toLowerCase().trim();
      const beforeLower = textBefore.toLowerCase();
      
      if (beforeLower.trimEnd().endsWith(explicitLower)) {
        // Text appears before citation - remove the duplicate and make it clickable
        const dupStart = textBefore.toLowerCase().lastIndexOf(explicitLower);
        const textBeforeDup = textBefore.slice(0, dupStart);
        result += escapeHtml(textBeforeDup);
        result += `<span class="xwebagent-citation" data-index="${index}" title="Click to scroll">${escapeHtml(explicitText)}</span>`;
      } else {
        // Text doesn't appear before - just add the citation as clickable
        result += escapeHtml(textBefore);
        result += `<span class="xwebagent-citation" data-index="${index}" title="Click to scroll">${escapeHtml(explicitText)}</span>`;
      }
    } else {
      // No explicit text: [N] format - extract preceding phrase
      const textBefore = text.slice(lastIndex, match.index);
      
      // Find the last phrase before the citation (after comma, period, or other delimiter)
      const phraseMatch = textBefore.match(/(?:^|[,.:;])\s*([^,.:;]+?)\s*$/);
      
      if (phraseMatch && phraseMatch[1].trim()) {
        // Found a phrase - make it clickable and remove the citation number
        const phrase = phraseMatch[1].trim();
        const textBeforePhrase = textBefore.slice(0, textBefore.lastIndexOf(phrase));
        
        result += escapeHtml(textBeforePhrase);
        result += `<span class="xwebagent-citation" data-index="${index}" title="Click to scroll">${escapeHtml(phrase)}</span>`;
      } else {
        // No clear phrase found - show text before and a small superscript number
        result += escapeHtml(textBefore);
        result += `<span class="xwebagent-citation xwebagent-citation-sup" data-index="${index}" title="Click to scroll"><sup>${index}</sup></span>`;
      }
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text
  result += escapeHtml(text.slice(lastIndex));
  
  return result;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

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
    // Parse citations to make them clickable
    const parsedContent = parseCitations(content);
    msg.innerHTML = `${parsedContent} <span class="xwebagent-scroll-hint">👆 Click citation to scroll</span>`;
    
    // Add click handler for citations
    msg.querySelectorAll('.xwebagent-citation').forEach(citation => {
      citation.addEventListener('click', (e) => {
        e.stopPropagation(); // Don't trigger parent click
        const index = parseInt(citation.dataset.index, 10);
        sendToContentScript({ action: 'scrollToIndex', index });
      });
    });
    
    // Click on message (not citation) scrolls to first highlight
    msg.addEventListener('click', (e) => {
      if (!e.target.classList.contains('xwebagent-citation')) {
        sendToContentScript({ action: 'scrollToHighlight' });
      }
    });
  } else {
    msg.textContent = content;
  }
  
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  
  chatMessages.push({ content, type, timestamp: Date.now() });
}

/**
 * Add a collapsible debug/info section
 * Collapsed by default, click to expand
 */
function addCollapsibleDebug(lines) {
  const container = document.getElementById('xwebagent-messages');
  if (!container) return;
  
  const wrapper = document.createElement('div');
  wrapper.className = 'xwebagent-debug-wrapper';
  
  const toggle = document.createElement('div');
  toggle.className = 'xwebagent-debug-toggle';
  toggle.innerHTML = `<span class="xwebagent-debug-arrow">▶</span> <span class="xwebagent-debug-label">Details</span>`;
  
  const content = document.createElement('div');
  content.className = 'xwebagent-debug-content';
  content.style.display = 'none';
  
  lines.forEach(line => {
    const lineEl = document.createElement('div');
    lineEl.className = 'xwebagent-debug-line';
    lineEl.textContent = line;
    content.appendChild(lineEl);
  });
  
  toggle.addEventListener('click', () => {
    const isOpen = content.style.display !== 'none';
    content.style.display = isOpen ? 'none' : 'block';
    toggle.querySelector('.xwebagent-debug-arrow').textContent = isOpen ? '▶' : '▼';
  });
  
  wrapper.appendChild(toggle);
  wrapper.appendChild(content);
  container.appendChild(wrapper);
  container.scrollTop = container.scrollHeight;
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
 * Add an ask step message (for scroll/expand actions)
 */
function addAskStep(result) {
  const container = document.getElementById('xwebagent-messages');
  if (!container) return;
  
  hideTyping();
  
  const msg = document.createElement('div');
  msg.className = 'xwebagent-message ask-step';
  
  // Different icons for different action types
  const actionIcon = result.actionType === 'scroll' ? '📜' : '📦';
  const actionHint = result.actionType === 'scroll' 
    ? '⏳ Auto-scrolling in 2 seconds...' 
    : '👆 Click the highlighted button';
  
  msg.innerHTML = `
    <div class="xwebagent-ask-step">
      <span class="xwebagent-action-icon">${actionIcon}</span>
      <span class="xwebagent-step-text">${result.answer}</span>
    </div>
    <div class="xwebagent-action-hint">${actionHint}</div>
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
 * Handle paste image (Ctrl+V / Cmd+V)
 */
async function handlePasteImage(event) {
  const clipboardItems = event.clipboardData?.items;
  if (!clipboardItems) return;
  
  // Look for image in clipboard
  for (const item of clipboardItems) {
    if (item.type.startsWith('image/')) {
      event.preventDefault();
      
      const file = item.getAsFile();
      if (!file) continue;
      
      // Validate file size (max 10MB)
      if (file.size > 10 * 1024 * 1024) {
        addMessage('❌ Image too large. Max size is 10MB', 'error');
        return;
      }
      
      try {
        // Convert to base64
        const reader = new FileReader();
        reader.onload = async (e) => {
          const base64 = e.target.result;
          // Remove data URL prefix to get pure base64
          uploadedImageBase64 = base64.split(',')[1];
          
          // Show preview
          const preview = document.getElementById('xwebagent-image-preview');
          const previewImg = document.getElementById('xwebagent-preview-img');
          const uploadLabel = document.getElementById('xwebagent-upload-label');
          
          if (preview && previewImg) {
            previewImg.src = base64;
            preview.style.display = 'flex';
          }
          
          // Highlight upload button to show image is attached
          if (uploadLabel) {
            uploadLabel.classList.add('has-image');
          }
          
          // Send image to content script
          try {
            await sendToContentScript({ 
              action: 'setUploadedImage', 
              imageBase64: uploadedImageBase64 
            });
            console.log('🖼️ Pasted image sent to content script');
          } catch (err) {
            console.warn('🖼️ Could not send pasted image to content script:', err);
          }
          
          // Update placeholder to hint about asking
          const input = document.getElementById('xwebagent-input');
          if (input) {
            input.placeholder = 'Ask about the pasted image...';
            input.focus();
          }
          
          addMessage('📋 Image pasted! Ask me to find it on the page.', 'system');
        };
        
        reader.readAsDataURL(file);
        return; // Only handle first image
      } catch (err) {
        addMessage(`❌ Error pasting image: ${err.message}`, 'error');
      }
    }
  }
}

/**
 * Handle image upload
 */
async function handleImageUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  
  // Validate file type
  if (!file.type.startsWith('image/')) {
    addMessage('❌ Please upload an image file', 'error');
    return;
  }
  
  // Validate file size (max 10MB)
  if (file.size > 10 * 1024 * 1024) {
    addMessage('❌ Image too large. Max size is 10MB', 'error');
    return;
  }
  
  try {
    // Convert to base64
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = e.target.result;
      // Remove data URL prefix to get pure base64
      uploadedImageBase64 = base64.split(',')[1];
      
      // Show preview
      const preview = document.getElementById('xwebagent-image-preview');
      const previewImg = document.getElementById('xwebagent-preview-img');
      const uploadLabel = document.getElementById('xwebagent-upload-label');
      
      if (preview && previewImg) {
        previewImg.src = base64;
        preview.style.display = 'flex';
      }
      
      // Highlight upload button to show image is attached
      if (uploadLabel) {
        uploadLabel.classList.add('has-image');
      }
      
      // Send image to content script
      try {
        await sendToContentScript({ 
          action: 'setUploadedImage', 
          imageBase64: uploadedImageBase64 
        });
        console.log('🖼️ Image sent to content script');
      } catch (err) {
        console.warn('🖼️ Could not send image to content script:', err);
      }
      
      // Update placeholder to hint about asking
      const input = document.getElementById('xwebagent-input');
      if (input) {
        input.placeholder = 'Ask about the uploaded image...';
      }
      
      addMessage('📷 Image uploaded! Ask me to find it on the page.', 'system');
    };
    
    reader.readAsDataURL(file);
  } catch (err) {
    addMessage(`❌ Error uploading image: ${err.message}`, 'error');
  }
}

/**
 * Clear uploaded image
 */
async function clearUploadedImage() {
  uploadedImageBase64 = null;
  
  // Hide preview
  const preview = document.getElementById('xwebagent-image-preview');
  const uploadLabel = document.getElementById('xwebagent-upload-label');
  const input = document.getElementById('xwebagent-input');
  const fileInput = document.getElementById('xwebagent-image-upload');
  
  if (preview) preview.style.display = 'none';
  if (uploadLabel) uploadLabel.classList.remove('has-image');
  if (input) input.placeholder = 'Ask anything...';
  if (fileInput) fileInput.value = '';
  
  // Clear from content script
  try {
    await sendToContentScript({ action: 'clearUploadedImage' });
  } catch (err) {
    console.warn('🖼️ Could not clear image in content script:', err);
  }
  
  addMessage('🗑️ Image removed', 'system');
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
      // Build debug info for collapsible section
      const debugLines = [];
      
      // Routing decision
      if (result.routedTo) {
        const confidence = Math.round((result.routeConfidence || 0) * 100);
        const handlerEmoji = {
          'ask': '💬',
          'guide': '📋',
          'protection': '🛡️',
          'image_ask': '🖼️'
        }[result.routedTo] || '🎯';
        debugLines.push(`${handlerEmoji} Routed to: ${result.routedTo} (${confidence}%)`);
      }
      
      // Image ask info
      if (result.isImageAsk) {
        if (result.imageAskSteps) {
          debugLines.push(`🔍 Image search steps: ${result.imageAskSteps}`);
        }
        if (result.imageAskActions && result.imageAskActions.length > 0) {
          debugLines.push(`🧭 Image search navigation:`);
          result.imageAskActions.forEach(action => {
            debugLines.push(`  • ${action}`);
          });
        }
      }
      
      // Vision decision
      if (result.visionDecision) {
        const vd = result.visionDecision;
        const visionConfidence = Math.round((vd.confidence || 0) * 100);
        const visionEmoji = vd.needsVision ? '📸' : '📝';
        const visionMode = vd.needsVision ? 'Vision' : 'Text-only';
        debugLines.push(`${visionEmoji} Mode: ${visionMode} (${visionConfidence}%)`);
        
        if (result.useVision && result.visionSteps) {
          debugLines.push(`🔍 Steps: ${result.visionSteps}`);
        }
        
        if (result.visionActions && result.visionActions.length > 0) {
          debugLines.push(`🧭 Navigation:`);
          result.visionActions.forEach(action => {
            debugLines.push(`  • ${action}`);
          });
        }
      }
      
      // Add collapsible debug section if there's debug info
      if (debugLines.length > 0) {
        addCollapsibleDebug(debugLines);
      }
      
      // Add assistant response to history (but not for intermediate steps)
      if (result.answer && !result.isAskStep) {
        conversationHistory.push({ role: 'assistant', content: result.answer });
      }
      
      if (result.isGuide) {
        addGuideStep(result);
      } else if (result.isAskStep) {
        // Ask mode step (scroll/expand needed)
        addAskStep(result);
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
    
    // Clear uploaded image
    uploadedImageBase64 = null;
    const preview = document.getElementById('xwebagent-image-preview');
    const uploadLabel = document.getElementById('xwebagent-upload-label');
    const input = document.getElementById('xwebagent-input');
    const fileInput = document.getElementById('xwebagent-image-upload');
    
    if (preview) preview.style.display = 'none';
    if (uploadLabel) uploadLabel.classList.remove('has-image');
    if (input) input.placeholder = 'Ask anything...';
    if (fileInput) fileInput.value = '';
    
    try {
      await sendToContentScript({ action: 'clearUploadedImage' });
    } catch (e) {
      // Ignore
    }
    
    addMessage('🧹 Cleared chat, highlights, and uploaded image', 'system');
  }
}

// Listen for messages from content script and background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'guideStep') {
    hideTyping();
    addGuideStep(message.result);
  } else if (message.action === 'askStep') {
    // Ask mode step (scroll/expand)
    hideTyping();
    addAskStep(message.result);
  } else if (message.action === 'askComplete') {
    // Ask mode complete with final answer
    hideTyping();
    if (message.result?.error) {
      addMessage(`❌ ${message.result.error}`, 'error');
    } else if (message.result?.answer) {
      const hasHighlights = message.result.hasHighlights || message.result.highlightCount > 0;
      let answerText = message.result.answer;
      if (message.result.highlightCount > 0) {
        answerText += ` ✨ (${message.result.highlightCount} highlighted)`;
      }
      addMessage(answerText, 'assistant', hasHighlights);
    }
  } else if (message.action === 'showTyping') {
    // Show typing indicator when guidance is continuing
    showTyping();
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
