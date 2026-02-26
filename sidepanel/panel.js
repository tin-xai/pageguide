// XWebAgent Side Panel Script
// Handles chat UI and communicates with content scripts

let chatMessages = [];
let conversationHistory = []; // Stores {role: 'user'|'assistant', content: string, hasImage?: boolean}
let currentTabId = null;
let uploadedImageBase64 = null; // Stores the uploaded image
let hasImageInConversation = false; // Track if image was used in conversation
let guideActive = false; // True while guide is generating steps (shows stop button)

// Open a persistent port to the service worker.
// When the panel is closed (by any means — X button, keyboard shortcut, etc.)
// the port disconnects and the service worker's onDisconnect handler fires reliably,
// clearing the page highlights. This is more reliable than beforeunload + sendMessage.
chrome.runtime.connect({ name: 'sidepanel' });

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;
  
  // Attach event listeners
  document.getElementById('xwebagent-settings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('xwebagent-new-chat')?.addEventListener('click', () => resetChat());
  
  document.getElementById('xwebagent-send').addEventListener('click', sendMessage);
  document.getElementById('xwebagent-input').addEventListener('keypress', e => {
    if (e.key === 'Enter') {
      const menu = document.getElementById('xwebagent-slash-menu');
      // If slash menu is open and an item is selected, let the keydown handler handle it
      if (menu && menu.style.display !== 'none' && _slashMenuIndex >= 0) return;
      sendMessage();
    }
  });
  
  // Quick action buttons
  document.querySelectorAll('.xwebagent-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => handleQuickAction(btn.dataset.action));
  });
  
  // PDF Reader button
  document.getElementById('xwebagent-pdf-reader')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pdf-viewer/viewer.html') });
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

  // Wire up slash command autocomplete
  _initSlashAutocomplete();

  // Show current model status on open
  showModelStatus();

  // Listen for tab changes
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    currentTabId = activeInfo.tabId;
  });
});

/**
 * Parse citations in text and make them clickable
 * Supports two formats:
 * 1. Web page citations: [N:"text"] or [N] - scrolls to indexed element
 * 2. PDF citations: [Page N: "text"] - navigates to PDF page
 */
function parseCitations(text, isPdf = false) {
  // Normalize curly/smart quotes to straight quotes first
  const normalizedText = text
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'");
  
  // Use normalized text for parsing
  text = normalizedText;
  
  let result = '';
  let lastIndex = 0;
  let citationCount = 0;
  
  // First, check for indexed citations: [idx:N], [idx:N-M], or [idx:N-M, X-Y, ...]
  const indexedCitationPattern = /\[idx:([^\]]+)\]/gi;
  const hasIndexedCitations = indexedCitationPattern.test(text);
  indexedCitationPattern.lastIndex = 0;
  
  if (hasIndexedCitations) {
    let match;
    
    while ((match = indexedCitationPattern.exec(text)) !== null) {
      citationCount++;
      const rangesStr = match[1]; // e.g., "1-2, 38-42, 58-59" or "57"
      
      // Parse all ranges
      const ranges = [];
      const rangeParts = rangesStr.split(/[,;]\s*/);
      for (const part of rangeParts) {
        const rangeMatch = part.trim().match(/(\d+)(?:-(\d+))?/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1]);
          const end = rangeMatch[2] ? parseInt(rangeMatch[2]) : start;
          ranges.push({ start, end });
        }
      }
      
      // Add text before this citation (already HTML from parseMarkdown)
      result += text.slice(lastIndex, match.index);
      
      // Store all ranges as JSON in data attribute
      const rangesJson = JSON.stringify(ranges);
      const tooltipText = ranges.map(r => r.start === r.end ? r.start : `${r.start}-${r.end}`).join(', ');
      result += `<span class="xwebagent-pdf-citation" data-ranges='${rangesJson}' data-citation="${citationCount}" title="Elements: ${tooltipText}">[${citationCount}]</span>`;
      
      lastIndex = match.index + match[0].length;
    }
    
    // Add remaining text (already HTML from parseMarkdown)
    result += text.slice(lastIndex);
    return result;
  }
  
  // Second, handle PDF page citations: [Page N: "text"] or [Page N: 'text']
  const pdfCitationPattern = /\[Page\s*(\d+):\s*["']([^"']+)["']\]/gi;
  
  // Check if there are PDF citations
  const hasPdfCitations = pdfCitationPattern.test(text);
  pdfCitationPattern.lastIndex = 0; // Reset regex
  
  if (hasPdfCitations) {
    let match;
    
    while ((match = pdfCitationPattern.exec(text)) !== null) {
      citationCount++;
      const pageNum = match[1];
      const quoteText = match[2];
      
      // Add text before this citation (already HTML from parseMarkdown)
      result += text.slice(lastIndex, match.index);
      
      // Add clickable PDF citation - show index only, store quote for highlighting
      // Truncate quote for tooltip (first 60 chars)
      const tooltipText = quoteText.length > 60 ? quoteText.slice(0, 60) + '...' : quoteText;
      result += `<span class="xwebagent-pdf-citation" data-page="${pageNum}" data-text="${escapeHtml(quoteText)}" data-citation="${citationCount}" title="Page ${pageNum}: ${escapeHtml(tooltipText)}">[${citationCount}]</span>`;
      
      lastIndex = match.index + match[0].length;
    }
    
    // Add remaining text (already HTML from parseMarkdown)
    result += text.slice(lastIndex);
    return result;
  }
  
  // Handle regular web citations: [N], [N:"text"], or [N, M, ...] (multiple indices)
  // Pattern matches: [517], [517:"text"], [517, 519], [517, 519:"text"]
  const citationPattern = /\[([\d,\s]+)(?::\s*(?:"([^"]+)"|'([^']+)'|([^\]]+)))?\]/g;
  
  let match;
  let webCitationCount = 0;
  while ((match = citationPattern.exec(text)) !== null) {
    const indicesStr = match[1]; // Could be "517" or "517, 519" or "517,519"
    // Text could be in group 2 (double quoted), 3 (single quoted), or 4 (unquoted)
    const explicitText = match[2] || match[3] || match[4];
    
    // Parse all indices (handle comma-separated)
    const indices = indicesStr.split(/[,\s]+/).filter(s => s.match(/^\d+$/));
    
    const textBefore = text.slice(lastIndex, match.index);
    result += textBefore;
    
    // Create citation with toggleable text and index
    // Default: collapsed (show only index), click to expand (show text + index)
    indices.forEach((idx, i) => {
      webCitationCount++;
      if (explicitText) {
        // Has citation text - make it toggleable
        result += `<span class="xwebagent-citation xwebagent-citation-idx" data-index="${idx}" data-citation="${webCitationCount}"><span class="citation-text">${escapeHtml(explicitText)}</span><sup class="citation-index">[${webCitationCount}]</sup></span>`;
      } else {
        // No text - just show index
        result += `<span class="xwebagent-citation xwebagent-citation-idx" data-index="${idx}" data-citation="${webCitationCount}"><sup class="citation-index">[${webCitationCount}]</sup></span>`;
      }
    });
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text (already HTML from parseMarkdown)
  result += text.slice(lastIndex);
  
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
 * Parse markdown formatting to HTML
 * Supports: **bold**, *italic*, `code`, - lists, numbered lists, headers
 */
function parseMarkdown(text) {
  // First escape HTML to prevent XSS
  let result = escapeHtml(text);
  
  // Code blocks with triple backticks (must be done before inline code)
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  
  // Inline code with single backticks
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // Bold with **text** (must be done before italic)
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  
  // Italic with *text* (single asterisks, not part of **)
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  
  // Headers
  result = result.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  result = result.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  result = result.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  
  // Bullet lists (- item or * item at start of line)
  result = result.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  // Wrap consecutive <li> elements in <ul>
  result = result.replace(/(<li>[\s\S]*?<\/li>)(?:\n|<br>)?(<li>)/g, '$1$2');
  result = result.replace(/(?:^|[^>])(<li>[\s\S]*?<\/li>)(?:[^<]|$)/g, '<ul>$1</ul>');
  
  // Numbered lists (1. item, 2. item, etc.)
  result = result.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  
  // Line breaks (convert \n to <br> but preserve paragraph structure)
  result = result.replace(/\n\n/g, '</p><p>');
  result = result.replace(/\n/g, '<br>');
  
  // Clean up any empty paragraphs and fix structure
  result = result.replace(/<p><\/p>/g, '');
  result = result.replace(/<br><br>/g, '</p><p>');
  
  // Wrap in paragraph if not already wrapped with a block element
  if (!result.startsWith('<h') && !result.startsWith('<ul') && !result.startsWith('<pre') && !result.startsWith('<p')) {
    result = '<p>' + result + '</p>';
  }
  
  return result;
}

/**
 * Read stored settings and show the active provider + model in the chat.
 * If no key is configured, prompt the user to open Settings.
 */
async function showModelStatus() {
  const PROVIDER_LABELS = {
    gemini: 'Gemini',
    openrouter: 'OpenRouter',
    openai: 'OpenAI'
  };

  let settings = {};
  try {
    settings = await chrome.storage.sync.get([
      'provider',
      'geminiApiKey', 'geminiModel',
      'openrouterApiKey', 'openrouterModel',
      'openaiApiKey', 'openaiModel'
    ]);
  } catch (e) { /* storage unavailable */ }

  const provider = settings.provider || 'gemini';
  const providerLabel = PROVIDER_LABELS[provider] || provider;

  let apiKey = '';
  let modelRaw = '';

  if (provider === 'gemini') {
    apiKey = settings.geminiApiKey || '';
    modelRaw = settings.geminiModel || 'gemini-2.5-flash';
  } else if (provider === 'openrouter') {
    apiKey = settings.openrouterApiKey || '';
    modelRaw = settings.openrouterModel || '';
  } else if (provider === 'openai') {
    apiKey = settings.openaiApiKey || '';
    modelRaw = settings.openaiModel || '';
  }

  // Shorten "org/model-name" → "model-name" for display
  const modelDisplay = modelRaw.includes('/') ? modelRaw.split('/').pop() : modelRaw;

  if (!apiKey) {
    addMessage(
      `⚙️ No API key configured. Click **⚙️ Settings** to add your ${providerLabel} key and get started.`,
      'system'
    );
  } else {
    addMessage(
      `🤖 Using **${providerLabel}** · ${modelDisplay}`,
      'system'
    );
  }
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
    // Parse markdown first, then citations
    const markdownParsed = parseMarkdown(content);
    // Parse citations to make them clickable (handles both web and PDF citations)
    const parsedContent = parseCitations(markdownParsed);
    
    msg.innerHTML = parsedContent;
    
    // Add click handler for web citations
    msg.querySelectorAll('.xwebagent-citation').forEach(citation => {
      citation.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = parseInt(citation.dataset.index, 10);
        sendToContentScript({ action: 'scrollToIndex', index });
      });
    });
    
    // Add click handler for PDF citations (both indexed and text-based)
    msg.querySelectorAll('.xwebagent-pdf-citation').forEach(citation => {
      citation.addEventListener('click', async (e) => {
        e.stopPropagation();

        // Check if this is an indexed citation with ranges
        const rangesJson = citation.dataset.ranges;
        const pageNum = citation.dataset.page ? parseInt(citation.dataset.page, 10) : null;
        const searchText = citation.dataset.text;

        let message;
        if (rangesJson) {
          // New format with multiple ranges — cycle through one at a time
          const ranges = JSON.parse(rangesJson);

          if (ranges.length > 1) {
            // Get the index of the range to show on THIS click, then advance
            const currentIdx = parseInt(citation.dataset.currentRangeIdx || '0', 10);
            const nextIdx = (currentIdx + 1) % ranges.length;
            citation.dataset.currentRangeIdx = String(nextIdx);

            // Update or create the (k/n) counter inside the citation span
            let counter = citation.querySelector('.citation-range-counter');
            if (!counter) {
              counter = document.createElement('span');
              counter.className = 'citation-range-counter';
              citation.appendChild(counter);
            }
            counter.textContent = `${currentIdx + 1}/${ranges.length}`;
            citation.title = `Evidence ${currentIdx + 1} of ${ranges.length} — click to cycle`;

            message = { action: 'highlightByRanges', ranges: [ranges[currentIdx]] };
          } else {
            message = { action: 'highlightByRanges', ranges: ranges };
          }
        } else if (pageNum && searchText) {
          // Old format with page and text
          message = { action: 'navigateToPdfPage', page: pageNum, searchText: searchText };
        } else {
          console.warn('Invalid citation data');
          return;
        }

        // Send to the PDF viewer tab
        const tabs = await chrome.tabs.query({});
        const pdfViewerTab = tabs.find(t => t.url?.includes('pdf-viewer/viewer.html'));

        if (pdfViewerTab) {
          chrome.tabs.sendMessage(pdfViewerTab.id, message);
          chrome.tabs.update(pdfViewerTab.id, { active: true });
        } else {
          sendToContentScript(message);
        }
      });
    });
    
    // Click on message (not citation) toggles citation text visibility
    msg.addEventListener('click', (e) => {
      // Don't toggle if clicking on a citation (let citation click handler handle it)
      if (e.target.closest('.xwebagent-citation') || 
          e.target.closest('.xwebagent-pdf-citation')) {
        return;
      }
      // Toggle expanded state for citations
      msg.classList.toggle('citations-expanded');
    });
  } else {
    // Apply markdown parsing for non-clickable messages too
    msg.innerHTML = parseMarkdown(content);
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

  guideActive = !result.isLastStep;
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
    ${!result.isLastStep ? `<div class="xwebagent-guide-waiting">${result.action === 'click' ? '👆 Click the highlighted element, or press Next below' : '👆 Complete this step, then I\'ll show you the next one'}</div>` : ''}
  `;

  if (!result.isLastStep) {
    const btnRow = document.createElement('div');
    btnRow.className = 'xwebagent-step-btn-row';

    const stopHereBtn = document.createElement('button');
    stopHereBtn.className = 'xwebagent-step-stop-btn';
    stopHereBtn.textContent = '⏹ Stop here';
    stopHereBtn.title = 'Stop the guide at this step';
    stopHereBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't trigger scroll-to-highlight
      stopGuide(`✅ Stopped after step ${result.step}. Ask me again whenever you need more help.`);
    });

    if (result.action === 'click') {
      const nextBtn = document.createElement('button');
      nextBtn.className = 'xwebagent-step-next-btn';
      nextBtn.textContent = 'Next →';
      nextBtn.title = 'Mark this step as done and get the next one';
      nextBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        nextBtn.disabled = true;
        stopHereBtn.disabled = true;
        showTyping();
        try {
          await sendToContentScript({ action: 'nextGuideStep' });
        } catch (err) { /* ignore */ }
      });
      btnRow.appendChild(nextBtn);
    }

    btnRow.appendChild(stopHereBtn);
    msg.appendChild(btnRow);
  }

  if (result.hasHighlights) {
    msg.classList.add('xwebagent-clickable');
    msg.addEventListener('click', () => {
      sendToContentScript({ action: 'scrollToHighlight' });
    });
  }

  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;

  // On step 1, show the matched tutorial reference in a collapsible Details section
  if (result.tutorialMatch) {
    const { task, website, steps, reason } = result.tutorialMatch;
    const lines = [
      `📚 Tutorial: ${website}`,
      `🔍 Matched: "${task}"`,
      `💡 Reason: ${reason}`,
      ``,
      `📋 Reference steps:`,
      ...steps.map(s => `  ${s}`)
    ];
    addCollapsibleDebug(lines);
  }
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
 * Show typing indicator. In guide mode, appends a Stop button.
 */
function showTyping() {
  const container = document.getElementById('xwebagent-messages');
  if (!container || container.querySelector('.xwebagent-typing')) return;

  const typing = document.createElement('div');
  typing.className = 'xwebagent-typing';
  typing.innerHTML = '<span></span><span></span><span></span>';

  if (guideActive) {
    const stopBtn = document.createElement('button');
    stopBtn.className = 'xwebagent-guide-stop-btn';
    stopBtn.textContent = '⏹ Stop';
    stopBtn.addEventListener('click', (e) => { e.stopPropagation(); stopGuide(); });
    typing.appendChild(stopBtn);
  }

  container.appendChild(typing);
  container.scrollTop = container.scrollHeight;
}

/**
 * Stop an in-progress guide session.
 * @param {string} [message] - Optional message shown in chat; defaults to generic stop notice.
 */
async function stopGuide(message = '⏹ Guide stopped.') {
  guideActive = false;
  hideTyping();
  try {
    await sendToContentScript({ action: 'stopGuide' });
  } catch (e) { /* content script may not be reachable */ }
  // Also clear SW state directly so the next page load won't resume
  try { chrome.runtime.sendMessage({ action: 'guidanceV2_clearState' }); } catch (e) {}
  addMessage(message, 'system');
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

  // Hide preview and clear region overlays
  const preview = document.getElementById('xwebagent-image-preview');
  const wrapper = document.getElementById('xwebagent-image-wrapper');
  const uploadLabel = document.getElementById('xwebagent-upload-label');
  const input = document.getElementById('xwebagent-input');
  const fileInput = document.getElementById('xwebagent-image-upload');
  const label = document.getElementById('xwebagent-image-label');

  if (preview) preview.style.display = 'none';
  if (wrapper) {
    wrapper.classList.remove('has-regions');
    wrapper.querySelectorAll('.xwebagent-image-region').forEach(el => el.remove());
  }
  if (label) label.textContent = '📷 Image ready — ask about it!';
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
 * Render clickable region overlays on the image preview wrapper.
 * Called after a successful image_ask response that includes imageRegions.
 * Each region is grounded to the LLM's answer: clicking scrolls to the
 * already-highlighted page element (no new LLM call).
 * @param {Array} regions - [{label, citationIndex, bbox:{x,y,w,h}}]
 */
function renderImageRegions(regions) {
  const wrapper = document.getElementById('xwebagent-image-wrapper');
  const label = document.getElementById('xwebagent-image-label');
  if (!wrapper) return;

  // Remove any existing regions
  wrapper.querySelectorAll('.xwebagent-image-region').forEach(el => el.remove());
  wrapper.classList.add('has-regions');

  regions.forEach(item => {
    const { bbox, citationIndex, label: itemLabel } = item;
    if (!bbox) return;

    const region = document.createElement('div');
    region.className = 'xwebagent-image-region';
    region.style.left   = `${bbox.x}%`;
    region.style.top    = `${bbox.y}%`;
    region.style.width  = `${bbox.w}%`;
    region.style.height = `${bbox.h}%`;

    const tooltip = document.createElement('span');
    tooltip.className = 'xwebagent-region-label';
    tooltip.textContent = itemLabel || '';
    region.appendChild(tooltip);

    region.addEventListener('click', async () => {
      try {
        await sendToContentScript({ action: 'scrollToIndex', index: citationIndex });
      } catch (e) {
        console.warn('🖼️ scrollToIndex failed:', e);
      }
    });

    wrapper.appendChild(region);
  });

  if (label) label.textContent = `🎯 ${regions.length} highlight${regions.length !== 1 ? 's' : ''} found — click to jump`;
}

// ---------------------------------------------------------------------------
// Slash command system
// ---------------------------------------------------------------------------

const SLASH_COMMANDS = [
  { command: '/stop',       args: '',        description: 'Immediately cancel the current run' },
  { command: '/reset',      args: '',        description: 'Clear conversation and context' },
  { command: '/new',        args: '',        description: 'Clear conversation and context (alias of /reset)' },
  { command: '/help',       args: '',        description: 'Show available commands and examples' },
  { command: '/status',     args: '',        description: 'Show current model, SOM, and vision settings' },
  { command: '/som',        args: 'on|off',  description: 'Enable or disable Set of Marks overlay' },
  { command: '/vision',     args: 'on|off',  description: 'Enable or disable vision (screenshot) mode' },
];

/**
 * Handle slash commands. Returns true if the input was a command (caller should not continue).
 */
async function handleSlashCommand(input) {
  if (!input.startsWith('/')) return false;

  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts[1]?.toLowerCase();

  switch (cmd) {
    case '/stop':
      await stopGuide('⏹ Stopped.');
      return true;

    case '/reset':
    case '/new':
      await resetChat(false);
      addMessage('🧹 Conversation reset. Ready for a new task!', 'system');
      return true;

    case '/help':
      addMessage(
        '**Available Commands**\n\n' +
        '`/stop` — Immediately cancel the current run\n' +
        '`/reset` or `/new` — Clear conversation and context\n' +
        '`/status` — Show current model, SOM, and vision settings\n' +
        '`/som on` / `/som off` — Toggle Set of Marks overlay\n' +
        '`/vision on` / `/vision off` — Toggle vision (screenshot) mode\n' +
        '`/help` — Show this help message',
        'system'
      );
      return true;

    case '/status': {
      let s = {};
      try { s = await chrome.storage.sync.get(['provider','geminiModel','openrouterModel','openaiModel','visionEnabled','somEnabled']); } catch (e) {}
      const prov = s.provider || 'gemini';
      const provLabel = { gemini: 'Gemini', openrouter: 'OpenRouter', openai: 'OpenAI' }[prov] || prov;
      const modelRaw = prov === 'gemini' ? (s.geminiModel || 'gemini-2.5-flash')
                     : prov === 'openrouter' ? (s.openrouterModel || '')
                     : (s.openaiModel || '');
      const model = modelRaw.includes('/') ? modelRaw.split('/').pop() : modelRaw;
      const vision = s.visionEnabled === false ? 'OFF' : 'ON';
      const som = s.somEnabled === true ? 'ON' : 'OFF';
      addMessage(
        `**Status**\n\n🤖 Provider: **${provLabel}** · ${model}\n📸 Vision: **${vision}**\n🔢 Set of Marks: **${som}**`,
        'system'
      );
      return true;
    }

    case '/som':
      if (arg === 'on' || arg === 'off') {
        await chrome.storage.sync.set({ somEnabled: arg === 'on' });
        addMessage(`🔢 Set of Marks: **${arg.toUpperCase()}**`, 'system');
      } else {
        addMessage('Usage: `/som on` or `/som off`', 'system');
      }
      return true;

    case '/vision':
      if (arg === 'on' || arg === 'off') {
        await chrome.storage.sync.set({ visionEnabled: arg === 'on' });
        addMessage(`📸 Vision: **${arg.toUpperCase()}**`, 'system');
      } else {
        addMessage('Usage: `/vision on` or `/vision off`', 'system');
      }
      return true;

    default:
      addMessage(`❓ Unknown command: \`${cmd}\`. Type \`/help\` to see available commands.`, 'system');
      return true;
  }
}

// ---------------------------------------------------------------------------
// Slash command autocomplete
// ---------------------------------------------------------------------------

let _slashMenuIndex = -1;

function _buildSlashMenuItems(inputVal) {
  // Match commands whose full form starts with the typed text (e.g. "/s" matches /stop, /status, /som)
  const lower = inputVal.toLowerCase();
  return SLASH_COMMANDS.filter(c => c.command.startsWith(lower));
}

function _renderSlashMenu(items) {
  const menu = document.getElementById('xwebagent-slash-menu');
  if (!menu) return;
  menu.innerHTML = '';
  if (items.length === 0) { menu.style.display = 'none'; return; }

  items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'xwebagent-slash-item' + (idx === _slashMenuIndex ? ' active' : '');
    row.innerHTML =
      `<span class="slash-cmd">${item.command}${item.args ? ' <em>' + item.args + '</em>' : ''}</span>` +
      `<span class="slash-desc">${item.description}</span>`;
    row.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent blur before we can set value
      _applySlashItem(item);
    });
    menu.appendChild(row);
  });
  menu.style.display = 'block';
}

function _applySlashItem(item) {
  const input = document.getElementById('xwebagent-input');
  if (!input) return;
  // Commands that take args: insert command + space so user can type the arg
  if (item.args) {
    input.value = item.command + ' ';
  } else {
    input.value = item.command;
  }
  _hideSlashMenu();
  input.focus();
}

function _hideSlashMenu() {
  const menu = document.getElementById('xwebagent-slash-menu');
  if (menu) menu.style.display = 'none';
  _slashMenuIndex = -1;
}

function _initSlashAutocomplete() {
  const input = document.getElementById('xwebagent-input');
  if (!input) return;

  input.addEventListener('input', () => {
    const val = input.value;
    if (!val.startsWith('/')) { _hideSlashMenu(); return; }
    // Only show the menu while user is still on the first "word" (command name)
    if (val.includes(' ') && val.split(' ').length > 1 && val.split(' ')[1] !== '') {
      _hideSlashMenu(); return;
    }
    _slashMenuIndex = -1;
    _renderSlashMenu(_buildSlashMenuItems(val));
  });

  input.addEventListener('keydown', (e) => {
    const menu = document.getElementById('xwebagent-slash-menu');
    const visible = menu && menu.style.display !== 'none';
    if (!visible) return;

    const items = menu.querySelectorAll('.xwebagent-slash-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _slashMenuIndex = Math.min(_slashMenuIndex + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === _slashMenuIndex));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _slashMenuIndex = Math.max(_slashMenuIndex - 1, -1);
      items.forEach((el, i) => el.classList.toggle('active', i === _slashMenuIndex));
    } else if (e.key === 'Tab' || (e.key === 'Enter' && _slashMenuIndex >= 0)) {
      e.preventDefault();
      const idx = _slashMenuIndex >= 0 ? _slashMenuIndex : 0;
      const cmdIdx = [...items].indexOf(items[idx]);
      const matched = _buildSlashMenuItems(input.value);
      if (matched[cmdIdx]) _applySlashItem(matched[cmdIdx]);
    } else if (e.key === 'Escape') {
      _hideSlashMenu();
    }
  });

  input.addEventListener('blur', () => {
    // Small delay so mousedown on menu item fires first
    setTimeout(_hideSlashMenu, 150);
  });
}

/**
 * Send a chat message
 */
async function sendMessage() {
  const input = document.getElementById('xwebagent-input');
  const btn = document.getElementById('xwebagent-send');
  if (!input?.value.trim()) return;

  _hideSlashMenu();

  const query = input.value.trim();
  input.value = '';
  btn.disabled = true;

  // Handle slash commands before routing to agent
  if (query.startsWith('/')) {
    btn.disabled = false;
    input.focus();
    await handleSlashCommand(query);
    return;
  }
  
  // Check if current message has an image attached
  const currentMessageHasImage = !!uploadedImageBase64;
  if (currentMessageHasImage) {
    hasImageInConversation = true;
  }
  
  // Add to conversation history (mark if this message has an image)
  conversationHistory.push({ 
    role: 'user', 
    content: query,
    hasImage: currentMessageHasImage
  });
  
  addMessage(query, 'user');
  showTyping();
  
  try {
    // Check if current tab is the PDF viewer
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isOnPdfViewer = currentTab?.url?.includes('pdf-viewer/viewer.html');
    
    let result;
    
    if (isOnPdfViewer) {
      // Get PDF context from storage
      const pdfContext = await chrome.storage.session.get(['pdfViewerActive', 'pdfName', 'pdfTotalPages', 'pdfText']);
      
      console.log('📄 PDF context from storage:', {
        active: pdfContext.pdfViewerActive,
        name: pdfContext.pdfName,
        pages: pdfContext.pdfTotalPages,
        textPages: pdfContext.pdfText?.length
      });
      
      if (pdfContext.pdfText?.length > 0) {
        // Handle PDF question directly
        result = await handlePdfQuestion(query, pdfContext);
      } else {
        // No PDF loaded yet - show friendly message
        result = { 
          success: true, 
          answer: '📄 Please load a PDF first!\n\nUpload a PDF file or paste a URL in the viewer, then ask me questions about it.',
          isPdf: false
        };
      }
    } else {
      // Normal routing via content script
      // Pass hasImage flag so router knows if image_ask is valid
      result = await sendToContentScript({ 
        action: 'handleQuery', 
        query: query,
        history: conversationHistory.slice(0, -1),
        hasImage: currentMessageHasImage,
        hasImageInHistory: hasImageInConversation
      });
    }
    
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
          'image_ask': '🖼️',
          'pdf_ask': '📄'
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
        // Render clickable regions on the uploaded image grounded to the answer
        if (result.imageRegions?.length > 0) {
          renderImageRegions(result.imageRegions);
        }
      }
      
      // PDF info
      if (result.isPdf) {
        debugLines.push(`📄 PDF mode: ${result.extractedPages || '?'}/${result.totalPages || '?'} pages extracted`);
        if (result.pdfJsMode) {
          debugLines.push(`🔧 Method: PDF.js client-side extraction`);
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
        // Make clickable if has highlights OR is a PDF response (has citations)
        const hasHighlights = result.hasHighlights || result.highlightCount > 0;
        const hasPdfCitations = result.isPdf && (
          result.answer?.includes('[Page ') || 
          result.answer?.includes('[idx:')
        );
        addMessage(message, 'assistant', hasHighlights || hasPdfCitations);
      }
    } else {
      addMessage(`❌ ${result?.error || 'Unknown error'}`, 'error');
      // Remove failed query from history
      conversationHistory.pop();
    }
  } catch (e) {
    hideTyping();
    const msg = e.message || '';
    if (msg.includes('Could not establish connection') ||
        msg.includes('Receiving end does not exist') ||
        msg.includes('Cannot access') ||
        msg.includes('No active tab')) {
      addMessage('⚠️ This extension cannot run on this page.\n\nPlease navigate to a regular website (not `chrome://` or extension pages) and try again.', 'error');
    } else {
      addMessage(`❌ ${msg || 'Unknown error'}`, 'error');
    }
    // Remove failed query from history
    conversationHistory.pop();
  }
  
  btn.disabled = false;
  input.focus();
}

/**
 * Handle PDF question using stored PDF context
 */
async function handlePdfQuestion(query, pdfContext) {
  console.log('📄 Handling PDF question:', query);
  
  // Use indexed text if available, otherwise fall back to regular text
  const hasIndexedText = pdfContext.pdfText.some(p => p.indexedText);
  
  const pdfTextContent = pdfContext.pdfText.map(p => {
    if (hasIndexedText && p.indexedText) {
      return `[Page ${p.page}]\n${p.indexedText}`;
    }
    return `[Page ${p.page}]\n${p.text}`;
  }).join('\n\n');
  
  const systemPrompt = hasIndexedText 
    ? `You are a helpful assistant that answers questions about PDF documents.
Consider conversation history for context, but always answer based on the CURRENT document content.

CRITICAL RULES:
1. The text below has index markers like "[42]Hello [43]World" - these are for YOUR reference only
2. NEVER include these markers [N] in your response text
3. Write naturally, then add citations using ONLY this format: [idx:N] or [idx:N-M]
4. Place citations AFTER the relevant phrase, not mixed into text

CORRECT: "The TRUE dataset is the first explainable video fact-checking dataset [idx:462-464]"
WRONG: "[462]TRUE [464]dataset is..."

Keep answers clear and concise with citations for key claims.

Document: ${pdfContext.pdfName}
Total Pages: ${pdfContext.pdfTotalPages}

PDF Content (with reference indices):
${pdfTextContent}`
    : `You are a helpful assistant that answers questions about PDF documents.
Consider conversation history for context, but always answer based on the CURRENT document content.
When answering, ALWAYS cite specific passages using this exact format: [Page N: "exact quote from the document"]
Keep quotes concise (under 50 words) but include enough context to be useful.
If you can't find relevant information, say so clearly.

Document: ${pdfContext.pdfName}
Total Pages: ${pdfContext.pdfTotalPages}

PDF Content:
${pdfTextContent}`;
  
  // Build messages (without system prompt - it goes separately)
  const messages = [
    ...conversationHistory.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: query }
  ];
  
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'callLLM',
      messages: messages,
      systemPrompt: systemPrompt
    });
    
    if (response.error) {
      return { success: false, error: response.error };
    }
    
    // Add to conversation history
    conversationHistory.push({ role: 'assistant', content: response.content });
    
    return {
      success: true,
      answer: response.content,
      isPdf: true,
      routedTo: 'pdf_viewer',
      routeConfidence: 1.0
    };
  } catch (e) {
    console.error('PDF question error:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Reset all chat state and clear page highlights.
 * @param {boolean} showMessage - Whether to show a confirmation message in the chat.
 */
let _resettingChat = false;

async function resetChat(showMessage = true) {
  if (_resettingChat) return;
  _resettingChat = true;
  guideActive = false;

  // Clear guide state in SW directly (doesn't depend on content script being available)
  try { chrome.runtime.sendMessage({ action: 'guidanceV2_clearState' }); } catch (e) {}

  // Clear highlights on the active page
  try {
    await sendToContentScript({ action: 'reset' });
  } catch (e) {
    // Page might not have a content script loaded
  }

  // Clear highlights in PDF viewer if open
  try {
    const tabs = await chrome.tabs.query({});
    const pdfViewerTab = tabs.find(t => t.url?.includes('pdf-viewer/viewer.html'));
    if (pdfViewerTab) {
      chrome.tabs.sendMessage(pdfViewerTab.id, { action: 'clearPdfHighlights' });
    }
  } catch (e) {
    // PDF viewer might not be open
  }

  // Clear chat and conversation history
  conversationHistory = [];
  chatMessages = [];
  hasImageInConversation = false;
  const container = document.getElementById('xwebagent-messages');
  if (container) container.innerHTML = '';

  // Clear uploaded image state
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

  if (showMessage) {
    addMessage('🧹 Cleared chat, highlights, and uploaded image', 'system');
  }

  // Always show the current model status after clearing
  showModelStatus();

  _resettingChat = false;
}

/**
 * Handle quick action buttons
 */
async function handleQuickAction(action) {
  if (action === 'reset') {
    await resetChat(true);
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
    showTyping();
  } else if (message.action === 'hideTyping') {
    hideTyping();
  } else if (message.action === 'addMessage') {
    addMessage(message.content, message.type, message.clickable);
  } else if (message.action === 'closePanel') {
    window.close();
  }
});

// Notify background when panel is closed.
// The service worker clears page highlights upon receiving panelClosed.
window.addEventListener('beforeunload', () => {
  try {
    chrome.runtime.sendMessage({ action: 'panelClosed' });
  } catch (e) {
    // Extension context might be invalidated
  }
});
