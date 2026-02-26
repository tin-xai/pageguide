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
    const { confirmed, selectedSet } = await showHideDialog(result.found.length, result.message, result.found);

    if (confirmed) {
      hideContent(result.found, selectedSet);
      startAutoHide(query);
      cleanupSom();
      return {
        success: true,
        answer: `🫥 Hidden ${selectedSet.size} of ${result.found.length} item${result.found.length !== 1 ? 's' : ''}. I'll keep hiding new matches as you scroll.`,
        isProtection: true
      };
    } else {
      clearMarkings();
      cleanupSom();
      return {
        success: true,
        answer: `Found ${result.found.length} item${result.found.length !== 1 ? 's' : ''}. Content remains visible.`,
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
 * Mark found content with visual indicator + numbered badge
 */
function markContent(items) {
  const seen = new Set();
  let badgeNum = 0;

  items.forEach(item => {
    const el = getIndexedElement(item.index);
    if (!el) return;

    const container = findContainer(el);
    if (container.hasAttribute('data-xwebagent-marked') || seen.has(container)) return;
    seen.add(container);

    badgeNum++;
    container.setAttribute('data-xwebagent-marked', String(badgeNum));
    container.style.outline = '2px solid rgba(255,71,87,0.8)';
    container.style.outlineOffset = '2px';
    container.style.backgroundColor = 'rgba(255,71,87,0.05)';

    // Make container relatively positioned so the badge can anchor to it
    const computedPos = getComputedStyle(container).position;
    if (computedPos === 'static') {
      container.style.position = 'relative';
      container.setAttribute('data-xwebagent-pos-changed', 'true');
    }

    // Inject numbered badge
    const badge = document.createElement('div');
    badge.className = 'xwebagent-hide-badge';
    Object.assign(badge.style, {
      position: 'absolute',
      top: '6px',
      left: '6px',
      background: '#ff4757',
      color: 'white',
      fontSize: '11px',
      fontWeight: '700',
      fontFamily: 'system-ui, sans-serif',
      padding: '2px 8px',
      borderRadius: '999px',
      zIndex: '2147483640',
      pointerEvents: 'none',
      lineHeight: '1.6',
      boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
      whiteSpace: 'nowrap',
    });
    badge.textContent = `🛡️ ${badgeNum}`;
    container.prepend(badge);
  });
}

/**
 * Hide marked content. selectedSet is a Set of 1-based badge numbers to hide;
 * if null/undefined all items are hidden (legacy behaviour).
 */
function hideContent(items, selectedSet) {
  const hidden = new Set();
  let badgeNum = 0;

  items.forEach(item => {
    const el = getIndexedElement(item.index);
    if (!el) return;

    const container = findContainer(el);
    if (hidden.has(container)) return;
    hidden.add(container);
    badgeNum++;

    if (selectedSet && !selectedSet.has(badgeNum)) return; // user unchecked this one

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
 * Clear all markings (outlines, badges, background tints)
 */
function clearMarkings() {
  document.querySelectorAll('[data-xwebagent-marked]').forEach(el => {
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.style.backgroundColor = '';
    if (el.hasAttribute('data-xwebagent-pos-changed')) {
      el.style.position = '';
      el.removeAttribute('data-xwebagent-pos-changed');
    }
    el.removeAttribute('data-xwebagent-marked');
  });

  document.querySelectorAll('.xwebagent-hide-badge').forEach(el => el.remove());

  document.querySelectorAll('[data-xwebagent-hidden]').forEach(el => {
    el.style.display = '';
    el.removeAttribute('data-xwebagent-hidden');
  });
}

/**
 * Briefly flash an element so it's visible behind the dialog overlay.
 * Alternates between bright yellow and red outlines 3 times.
 */
function _flashElement(el) {
  const origOutline = el.style.outline;
  const origBg      = el.style.backgroundColor;
  let tick = 0;
  const iv = setInterval(() => {
    tick++;
    if (tick % 2 === 1) {
      el.style.outline          = '3px solid #ffe600';
      el.style.backgroundColor  = 'rgba(255,230,0,0.25)';
    } else {
      el.style.outline          = '3px solid rgba(255,71,87,0.9)';
      el.style.backgroundColor  = 'rgba(255,71,87,0.12)';
    }
    if (tick >= 6) {
      clearInterval(iv);
      el.style.outline         = origOutline;
      el.style.backgroundColor = origBg;
    }
  }, 220);
}

/**
 * Minimal HTML escape for dialog content (prevents XSS from snippet/reason text)
 */
function _escDialog(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Show confirmation dialog with a per-item checklist.
 * Resolves with { confirmed: bool, selectedSet: Set<number> } where
 * selectedSet contains the 1-based badge numbers the user kept checked.
 */
function showHideDialog(count, message, items) {
  return new Promise(resolve => {
    const dialog = document.createElement('div');
    dialog.id = 'xwebagent-dialog';

    // Build checklist rows (one per unique container; badge number = row index + 1)
    const rows = (items || []).map((item, i) => {
      const num = i + 1;
      const snippet = _escDialog((item.snippet || '').substring(0, 120));
      const reason  = _escDialog(item.reason  || '');
      return `
        <label data-row="${num}" style="display:flex;gap:10px;align-items:flex-start;
               padding:8px 10px;border-radius:6px;background:rgba(255,255,255,0.04);
               cursor:pointer;margin-bottom:6px;transition:background 0.15s;">
          <input type="checkbox" data-num="${num}" checked
                 style="margin-top:3px;flex-shrink:0;accent-color:#667eea;width:14px;height:14px;cursor:pointer;">
          <div style="min-width:0;flex:1;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap;">
              <span style="background:#ff4757;color:white;font-size:10px;font-weight:700;
                           padding:1px 7px;border-radius:999px;white-space:nowrap;flex-shrink:0;">🛡️ ${num}</span>
              ${reason ? `<span style="color:#a78bfa;font-size:11px;line-height:1.4;">${reason}</span>` : ''}
            </div>
            <div style="color:#ccc;font-size:12px;line-height:1.45;word-break:break-word;">
              &ldquo;${snippet}${(item.snippet || '').length > 120 ? '&hellip;' : ''}&rdquo;
            </div>
          </div>
          <button data-jump="${num}" title="Scroll to this element on the page"
                  style="flex-shrink:0;align-self:center;background:transparent;
                         border:1px solid #444;color:#999;border-radius:4px;
                         padding:2px 8px;font-size:12px;cursor:pointer;line-height:1.6;">↗</button>
        </label>`;
    }).join('');

    dialog.innerHTML = `
      <div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.55);
                  z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;">
        <div style="background:#1a1a2e;padding:22px 24px 20px;border-radius:14px;
                    max-width:460px;width:100%;color:white;font-family:system-ui,sans-serif;
                    box-shadow:0 8px 32px rgba(0,0,0,0.6);">

          <h3 style="margin:0 0 4px;font-size:17px;color:#a78bfa;">🛡️ Found ${count} item${count !== 1 ? 's' : ''} to hide</h3>
          <p style="margin:0 0 14px;color:#aaa;font-size:13px;">${_escDialog(message || 'Uncheck any item you want to keep visible.')}</p>

          <!-- checklist -->
          <div id="xwebagent-hide-list"
               style="max-height:260px;overflow-y:auto;padding-right:2px;margin-bottom:14px;">
            ${rows}
          </div>

          <!-- select all / none -->
          <div style="display:flex;gap:8px;margin-bottom:14px;">
            <button id="xwebagent-select-all"
                    style="flex:1;padding:6px;border:1px solid #444;border-radius:6px;
                           background:transparent;color:#ccc;font-size:12px;cursor:pointer;">
              ☑ Select all
            </button>
            <button id="xwebagent-select-none"
                    style="flex:1;padding:6px;border:1px solid #444;border-radius:6px;
                           background:transparent;color:#ccc;font-size:12px;cursor:pointer;">
              ☐ Deselect all
            </button>
          </div>

          <!-- action buttons -->
          <div style="display:flex;gap:12px;">
            <button id="xwebagent-cancel"
                    style="flex:1;padding:10px;border:none;border-radius:6px;
                           background:#2a2a40;color:#ccc;cursor:pointer;font-size:14px;">
              Keep visible
            </button>
            <button id="xwebagent-confirm"
                    style="flex:1;padding:10px;border:none;border-radius:6px;
                           background:#667eea;color:white;cursor:pointer;font-size:14px;font-weight:600;">
              Hide selected (<span id="xwebagent-hide-count">${count}</span>)
            </button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(dialog);

    // --- helpers ---
    const getChecked = () =>
      new Set([...dialog.querySelectorAll('input[data-num]:checked')]
        .map(cb => parseInt(cb.dataset.num, 10)));

    const updateCount = () => {
      const n = getChecked().size;
      dialog.querySelector('#xwebagent-hide-count').textContent = n;
      dialog.querySelector('#xwebagent-confirm').disabled = n === 0;
    };

    const highlightRow = (num, on) => {
      const row = dialog.querySelector(`label[data-row="${num}"]`);
      if (row) row.style.background = on ? 'rgba(102,126,234,0.15)' : 'rgba(255,255,255,0.04)';
    };

    // Sync checkbox state → page badge highlight
    dialog.querySelector('#xwebagent-hide-list').addEventListener('change', e => {
      if (e.target.type !== 'checkbox') return;
      const num = parseInt(e.target.dataset.num, 10);
      // Dim the badge on the page when unchecked
      const badge = document.querySelector(`.xwebagent-hide-badge:nth-of-type(1)`);
      // Find the container with this badge number
      const container = [...document.querySelectorAll('[data-xwebagent-marked]')]
        .find(el => el.getAttribute('data-xwebagent-marked') === String(num));
      if (container) {
        container.style.outline = e.target.checked
          ? '2px solid rgba(255,71,87,0.8)'
          : '2px dashed rgba(255,71,87,0.25)';
        container.style.backgroundColor = e.target.checked
          ? 'rgba(255,71,87,0.05)' : 'transparent';
        const b = container.querySelector('.xwebagent-hide-badge');
        if (b) b.style.opacity = e.target.checked ? '1' : '0.3';
      }
      updateCount();
    });

    // Jump-to button: scroll page to the element and flash it
    dialog.querySelector('#xwebagent-hide-list').addEventListener('click', e => {
      const jumpBtn = e.target.closest('[data-jump]');
      if (!jumpBtn) return;
      e.preventDefault();
      const num = parseInt(jumpBtn.dataset.jump, 10);
      const container = [...document.querySelectorAll('[data-xwebagent-marked]')]
        .find(el => el.getAttribute('data-xwebagent-marked') === String(num));
      if (container) {
        container.scrollIntoView({ behavior: 'smooth', block: 'center' });
        _flashElement(container);
      }
    });

    dialog.querySelector('#xwebagent-select-all').onclick = () => {
      dialog.querySelectorAll('input[data-num]').forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event('change', {bubbles:true})); });
    };
    dialog.querySelector('#xwebagent-select-none').onclick = () => {
      dialog.querySelectorAll('input[data-num]').forEach(cb => { cb.checked = false; cb.dispatchEvent(new Event('change', {bubbles:true})); });
    };

    dialog.querySelector('#xwebagent-confirm').onclick = () => {
      const sel = getChecked();
      dialog.remove();
      resolve({ confirmed: sel.size > 0, selectedSet: sel });
    };
    dialog.querySelector('#xwebagent-cancel').onclick = () => {
      dialog.remove();
      resolve({ confirmed: false, selectedSet: new Set() });
    };
  });
}
