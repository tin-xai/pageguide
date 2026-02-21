// XWebAgent - Web Protection Module
// Detects and hides unwanted content using LLM, then auto-hides new matches on scroll.

// ===== AUTO-HIDE (MutationObserver for infinite scroll) =====

window._xwebagentAutoHide = null;
let _autoHideObserver = null;
let _autoHidePending = new Set();
let _autoHideTimer = null;
let _autoHideRunning = false; // prevent overlapping LLM calls

let _autoHideToastTimer = null;

function _showAutoHideToast(count) {
  // Reuse existing toast if still visible, just update the count
  let toast = document.getElementById('xwebagent-autohide-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'xwebagent-autohide-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #1a1a2e;
      color: #e0e0e0;
      font-family: system-ui, sans-serif;
      font-size: 13px;
      padding: 10px 16px;
      border-radius: 8px;
      border-left: 3px solid #667eea;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      z-index: 999999;
      pointer-events: none;
      transition: opacity 0.3s;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = `🫥 Auto-hid ${count} new item${count === 1 ? '' : 's'}`;
  toast.style.opacity = '1';

  clearTimeout(_autoHideToastTimer);
  _autoHideToastTimer = setTimeout(() => {
    if (toast) { toast.style.opacity = '0'; setTimeout(() => toast?.remove(), 300); }
  }, 2500);
}

async function _flushAutoHideQueue() {
  _autoHideTimer = null;
  const state = window._xwebagentAutoHide;
  if (!state || _autoHidePending.size === 0) { _autoHidePending.clear(); return; }
  if (_autoHideRunning) return; // skip if LLM call already in progress

  // Snapshot pending nodes and clear the set immediately
  const newNodes = [..._autoHidePending];
  _autoHidePending.clear();

  // Build mini index of only new, connected, substantial nodes
  const indexLines = [];
  const nodeMap = new Map(); // idx → DOM node
  let idx = 0;

  for (const node of newNodes) {
    if (!node.isConnected) continue;
    if (node.hasAttribute?.('data-xwebagent-hidden')) continue; // already hidden
    const text = (node.textContent || '').trim();
    if (text.length < 15) continue;
    indexLines.push(`[${idx}] ${text.substring(0, 300)}`);
    nodeMap.set(idx, node);
    idx++;
  }

  if (indexLines.length === 0) return;

  _autoHideRunning = true;
  try {
    const response = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: PROMPTS.PROTECTION,
      messages: [{
        role: 'user',
        content: `USER REQUEST: "${state.query}"\n\nNEW CONTENT TO CHECK:\n${indexLines.join('\n')}`
      }]
    });

    if (!response?.content) return;

    let result;
    try {
      let json = response.content.replace(/```json\s*/gi, '').replace(/```\s*/gi, '');
      const match = json.match(/\{[\s\S]*\}/);
      if (match) json = match[0];
      result = JSON.parse(json);
    } catch (e) { return; }

    if (!result.found || result.found.length === 0) return;

    let hiddenCount = 0;
    for (const item of result.found) {
      const node = nodeMap.get(item.index);
      if (!node || !node.isConnected) continue;
      const container = findContainer(node);
      if (container && !container.hasAttribute('data-xwebagent-hidden')) {
        container.style.display = 'none';
        container.setAttribute('data-xwebagent-hidden', 'true');
        hiddenCount++;
        console.log('🛡️ Auto-hid new content:', item.snippet);
      }
    }

    if (hiddenCount > 0) _showAutoHideToast(hiddenCount);
  } finally {
    _autoHideRunning = false;
  }
}

function startAutoHide(query) {
  stopAutoHide(); // clear any previous session

  window._xwebagentAutoHide = { query };
  console.log('🛡️ Auto-hide active — will re-check new content against:', query);

  _autoHideObserver = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;           // elements only
        if ((node.textContent || '').length < 15) continue; // skip tiny UI nodes
        _autoHidePending.add(node);
      }
    }
    if (_autoHidePending.size > 0) {
      clearTimeout(_autoHideTimer);
      _autoHideTimer = setTimeout(_flushAutoHideQueue, 1500); // longer debounce for LLM call
    }
  });
  _autoHideObserver.observe(document.body, { childList: true, subtree: true });
}

function stopAutoHide() {
  if (_autoHideObserver) { _autoHideObserver.disconnect(); _autoHideObserver = null; }
  clearTimeout(_autoHideTimer);
  clearTimeout(_autoHideToastTimer);
  _autoHideTimer = null;
  _autoHidePending.clear();
  _autoHideRunning = false;
  window._xwebagentAutoHide = null;
  document.getElementById('xwebagent-autohide-toast')?.remove();
}

// Stop when the user navigates away (full-page nav)
window.addEventListener('pagehide', stopAutoHide, { once: true });

// ===== MAIN HANDLER =====

/**
 * Main handler for hide queries (routed by LLM coordinator)
 */
async function handleProtectionQuery(query) {
  console.log('🛡️ Hide query:', query);
  stopAutoHide(); // cancel any previous auto-hide session
  
  // Get page content
  const pageIndex = createPageIndex(5000);
  const visibleText = getVisibleText(50000);
  
  // Show SoM if enabled
  await showSomIfEnabled(pageIndex);
  
  // Capture screenshot
  let screenshot = null;
  try {
    const resp = await safeSendMessage({ action: 'captureScreenshot' });
    if (resp?.imageBase64) screenshot = resp.imageBase64;
  } catch (e) {}

  try {
    const response = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: PROMPTS.PROTECTION,
      imageBase64: screenshot,
      messages: [{
        role: 'user',
        content: `USER REQUEST: "${query}"\n\nPAGE: ${document.title}\n\n${visibleText}\n\nINDEXED ELEMENTS:\n${pageIndex.indexText}`
      }]
    });
    
    if (response?.error) {
      cleanupSom();
      return { success: true, answer: `Error: ${response.error}`, isProtection: true };
    }
    
    if (!response?.content) {
      cleanupSom();
      return { success: true, answer: 'Could not analyze page', isProtection: true };
    }
    
    console.log('🛡️ LLM response:', response.content);
    
    // Parse response
    let result;
    try {
      let json = response.content.replace(/```json\s*/gi, '').replace(/```\s*/gi, '');
      const match = json.match(/\{[\s\S]*\}/);
      if (match) json = match[0];
      result = JSON.parse(json);
    } catch (e) {
      // JSON was likely truncated (too many items). Salvage individual item objects
      // using a regex so we don't lose all the work the LLM already did.
      const salvaged = [...response.content.matchAll(
        /\{\s*"index"\s*:\s*(\d+)\s*,\s*"reason"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"snippet"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g
      )];
      if (salvaged.length > 0) {
        result = {
          found: salvaged.map(m => ({ index: parseInt(m[1]), reason: m[2], snippet: m[3] })),
          message: `Found ${salvaged.length} items to hide`
        };
      } else {
        cleanupSom();
        return { success: true, answer: 'Could not parse response. Try a more specific request.', isProtection: true };
      }
    }
    
    // Nothing found
    if (!result.found || result.found.length === 0) {
      cleanupSom();
      return { 
        success: true, 
        answer: `✅ ${result.message || 'No matching content found on this page.'}`,
        isProtection: true 
      };
    }
    
    // Found content - mark it and ask user
    markContent(result.found);
    const confirmed = await showHideDialog(result.found.length, result.message);
    
    if (confirmed) {
      hideContent(result.found);
      startAutoHide(query);
      cleanupSom();
      return {
        success: true,
        answer: `🫥 Hidden ${result.found.length} items. I'll keep hiding new matches as you scroll.`,
        isProtection: true
      };
    } else {
      clearMarkings();
      cleanupSom();
      return {
        success: true,
        answer: `Found ${result.found.length} items. Content remains visible.`,
        isProtection: true
      };
    }
    
  } catch (e) {
    console.error('🛡️ Error:', e);
    cleanupSom();
    return { success: true, answer: `Error: ${e.message}`, isProtection: true };
  }
}

/**
 * Mark found content with visual indicator
 */
function markContent(items) {
  items.forEach(item => {
    const el = getIndexedElement(item.index);
    if (!el) return;
    
    const container = findContainer(el);
    if (container.hasAttribute('data-xwebagent-marked')) return;
    
    container.setAttribute('data-xwebagent-marked', 'true');
    container.style.outline = '3px dashed #ff4757';
    container.style.outlineOffset = '2px';
  });
}

/**
 * Hide marked content
 */
function hideContent(items) {
  const hidden = new Set();
  
  items.forEach(item => {
    const el = getIndexedElement(item.index);
    if (!el) return;
    
    const container = findContainer(el);
    if (hidden.has(container)) return;
    hidden.add(container);
    
    // Completely hide the content
    container.style.display = 'none';
    container.setAttribute('data-xwebagent-hidden', 'true');
  });
}

/**
 * Find parent container (post/card) for an element
 */
function findContainer(el) {
  let current = el;
  let best = el;
  
  for (let i = 0; i < 8 && current && current !== document.body; i++) {
    // Check if this looks like a post/card container
    const tag = current.tagName.toLowerCase();
    const cls = (current.className || '').toLowerCase();
    
    if (tag === 'article' || 
        cls.includes('post') || 
        cls.includes('card') || 
        cls.includes('feed') ||
        cls.includes('item') ||
        current.querySelector('img, video')) {
      
      const rect = current.getBoundingClientRect();
      if (rect.height > 50 && rect.height < window.innerHeight * 0.8) {
        best = current;
      }
    }
    current = current.parentElement;
  }
  
  return best;
}

/**
 * Clear all markings
 */
function clearMarkings() {
  document.querySelectorAll('[data-xwebagent-marked]').forEach(el => {
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.removeAttribute('data-xwebagent-marked');
  });
  
  document.querySelectorAll('[data-xwebagent-hidden]').forEach(el => {
    el.style.display = '';
    el.removeAttribute('data-xwebagent-hidden');
  });
}

/**
 * Show simple confirmation dialog
 */
function showHideDialog(count, message) {
  return new Promise(resolve => {
    const dialog = document.createElement('div');
    dialog.id = 'xwebagent-dialog';
    dialog.innerHTML = `
      <div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;">
        <div style="background:#1a1a2e;padding:24px;border-radius:12px;max-width:400px;color:white;font-family:system-ui;">
          <h3 style="margin:0 0 12px;font-size:18px;color:#a78bfa;">🛡️ Found ${count} items</h3>
          <p style="margin:0 0 20px;color:#e0e0e0;font-size:14px;">${message || 'Content matching your request'}</p>
          <div style="display:flex;gap:12px;">
            <button id="xwebagent-cancel" style="flex:1;padding:10px;border:none;border-radius:6px;background:#333;color:white;cursor:pointer;">Keep visible</button>
            <button id="xwebagent-confirm" style="flex:1;padding:10px;border:none;border-radius:6px;background:#667eea;color:white;cursor:pointer;">Hide content</button>
          </div>
        </div>
      </div>
    `;
    
    document.body.appendChild(dialog);
    
    dialog.querySelector('#xwebagent-confirm').onclick = () => {
      dialog.remove();
      resolve(true);
    };
    
    dialog.querySelector('#xwebagent-cancel').onclick = () => {
      dialog.remove();
      resolve(false);
    };
  });
}
