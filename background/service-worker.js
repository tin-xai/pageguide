// PageGuide Background Service Worker
// Handles API calls to multiple LLM providers (Gemini, OpenRouter, OpenAI)

console.log('🤖 PageGuide Service Worker started');

// ===== Keep-Alive Mechanism =====
// Prevents service worker from going inactive during long LLM calls
let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    // Simple operation to keep service worker alive
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000); // Every 20 seconds
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// PDF extraction is handled via offscreen document (PDF.js needs DOM)

// ===== Configuration =====
const CONFIG = {
  providers: {
    gemini: {
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
      defaultModel: 'gemini-2.5-flash',
      defaultApiKey: (typeof CONFIG_KEYS !== 'undefined' && CONFIG_KEYS.GEMINI_KEY) || ''
    },
    openrouter: {
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      defaultModel: 'anthropic/claude-3.5-sonnet',
      defaultApiKey: (typeof CONFIG_KEYS !== 'undefined' && CONFIG_KEYS.OPENROUTER_KEY) || ''
    },
    openai: {
      endpoint: 'https://api.openai.com/v1/chat/completions',
      defaultModel: 'gpt-4o',
      defaultApiKey: (typeof CONFIG_KEYS !== 'undefined' && CONFIG_KEYS.OPENAI_KEY) || ''
    }
  },
  defaultProvider: 'gemini'
};

// Content script files (in order - dependencies first)
const CONTENT_SCRIPTS = [
  'content/prompts.js',
  'content/utils.js',
  'rewind/rewind_store.js',
  'content/functions/capture_screenshot.js',
  'content/functions/highlight.js',
  'content/functions/highlight_pdf.js',
  'content/functions/scroll.js',
  'content/functions/main_router.js',
  'content/tasks/protection.js',
  'content/tasks/guidev2.js',
  'content/tasks/ask.js',
  'content/tasks/ask_pdf.js',
  'content/tasks/image_ask.js',
  'content/study_tracker.js',
  'content/content.js'
];

// Track if side panel is open
let sidePanelOpen = false;

// ===== Guidance V2 State (SeeAct-inspired) =====
// Primary state store — survives page navigations as long as the SW is alive.
// Content scripts read this by connecting a 'guidev2' port on every page load.
// Session storage in guidev2.js is the fallback if the SW was killed.
//
// Keyed by tabId (NOT a single global) so multiple tabs can each run their own,
// fully isolated guide session at the same time. Before this, _gv2State/_gv2TabId were single
// globals: starting (or even just resetting the chat on) a second tab would silently overwrite
// the first tab's entry, so the first guide would fail to resume after its next navigation, or
// briefly become "ownerless" and think it had been stopped elsewhere.
let _gv2Sessions = new Map(); // tabId -> { active, question, previousSteps, pendingResume, lastUrl }
// Per-tab timestamps for the "guided click about to open a new tab" watch window — used to
// transfer ownership to the new tab when openerTabId is unavailable (e.g. noopener links).
// Also keyed by tabId so two tabs guiding concurrently don't stomp on each other's click watch.
let _gv2PreClickTsByTab = new Map(); // tabId -> timestamp

// ===== Extension Icon Click - Toggle Side Panel =====
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  
  try {
    if (sidePanelOpen) {
      // Close the panel by sending message to it
      try {
        await chrome.runtime.sendMessage({ action: 'closePanel' });
      } catch (e) {
        // Panel might already be closed
      }
      sidePanelOpen = false;
    } else {
      // Open the side panel
      await chrome.sidePanel.open({ tabId: tab.id });
      sidePanelOpen = true;
      
      // Inject content scripts only if not already loaded (check via manifest injection)
      if (tab.url?.startsWith('http')) {
        try {
          // Check if content scripts are already loaded
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => typeof window._pageguideLoaded !== 'undefined'
          });
          
          // Only inject if not already loaded
          if (!result?.result) {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: CONTENT_SCRIPTS
            });
            await chrome.scripting.insertCSS({
              target: { tabId: tab.id },
              files: ['content/content.css']
            });
          }
        } catch (err) {
          // Scripts might already be injected or page doesn't allow scripts
          console.log('Script injection skipped:', err.message);
        }
      }
    }
  } catch (err) {
    console.error('Could not toggle side panel:', err);
  }
});

// ===== Port-based Panel Close Detection =====
// The panel opens a persistent port named 'sidepanel' on load.
// When the panel is destroyed (X button, keyboard shortcut, etc.) the port
// disconnects synchronously, which is far more reliable than beforeunload + sendMessage.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    sidePanelOpen = true;
    port.onDisconnect.addListener(() => {
      sidePanelOpen = false;
      // Clear page highlights on the active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id;
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { action: 'reset' }).catch(() => {});
        }
      });
    });
    return;
  }

  if (port.name === 'guidev2') {
    // A content script just loaded on a (possibly new) page.
    // Send it the current guidance state immediately so it can decide whether to resume.
    // Only share state with THIS tab's own session — each tab has its own map entry, so one
    // tab's content script can never see or resume another tab's in-progress guide.
    const senderTabId = port.sender?.tab?.id;
    const session = senderTabId ? _gv2Sessions.get(senderTabId) : null;
    const stateForThisTab = session?.active ? session : null;

    try {
      port.postMessage({ type: 'swState', state: stateForThisTab });
    } catch (e) {
      // Port may have closed already (rare race on fast navigations)
    }
  }
});

// ===== New Tab Detection for Guidance =====
// When a guided tab opens a link in a new tab (target="_blank" or window.open),
// openerTabId on the created tab identifies the originating tab.
// We transfer THAT tab's session to the new tab so its content script can resume — every other
// tab's session (there may be several running concurrently) is left completely untouched.
chrome.tabs.onCreated.addListener((tab) => {
  // 1. openerTabId — reliable when Chrome sets it (most target="_blank" links).
  let sourceTabId = (tab.openerTabId != null && _gv2Sessions.get(tab.openerTabId)?.active)
    ? tab.openerTabId
    : null;

  // 2. Fallback for links where openerTabId is absent (e.g. window.open with noopener,
  //    JS-redirected links): the most recently-armed pre-click watch, if still within 2s.
  if (sourceTabId == null) {
    let newestTs = 0;
    for (const [tabId, ts] of _gv2PreClickTsByTab) {
      if (Date.now() - ts < 2000 && ts > newestTs && _gv2Sessions.get(tabId)?.active) {
        newestTs = ts;
        sourceTabId = tabId;
      }
    }
  }

  if (sourceTabId == null) return;

  const detectedBy = tab.openerTabId === sourceTabId ? '(openerTabId)' : '(preClick watch)';
  console.log('[SW guidev2] New tab', tab.id, 'opened from guided tab', sourceTabId, detectedBy, '— transferring guidance');
  const session = _gv2Sessions.get(sourceTabId);
  _gv2Sessions.delete(sourceTabId);
  _gv2Sessions.set(tab.id, { ...session, pendingResume: true });
  _gv2PreClickTsByTab.delete(sourceTabId); // consume the flag — one transfer per click
  detachDebugger(sourceTabId); // the old tab is no longer the agent's — drop its debugger session
});

// ===== User Study Behavior Tracker =====
// Accumulates per-task behavioral events (from content/study_tracker.js) across page
// navigations, since a single task can span multiple pages. Reset by studyTracker_start,
// read + cleared by studyTracker_getData (called once the participant hits "Done").
let _studyTracker = null; // { active, scrollUser, scrollAgent, ctrlF, textSelect, click, mouseMove, agentThinkMs: [], pages: [{url, ts}] }

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (_studyTracker && _studyTracker.active && changeInfo.url) {
    _studyTracker.pages.push({ url: changeInfo.url, ts: Date.now() });
  }
});

// Append a debug prompt history entry, capping at 50 to avoid quota storage issues.
// Returns the entry id so the caller can attach the model's response once the call settles.
let _debugPromptSeq = 0;
async function appendDebugPrompt(promptData) {
  const id = `${Date.now()}-${++_debugPromptSeq}`;
  const entry = { id, ...promptData };
  try {
    const result = await chrome.storage.local.get('debugPrompts');
    const list = Array.isArray(result.debugPrompts) ? result.debugPrompts : [];
    list.push(entry);
    if (list.length > 50) {
      list.shift(); // remove oldest entries
    }
    await chrome.storage.local.set({
      debugPrompts: list,
      lastDebugPrompt: entry
    });
  } catch (e) {
    console.error('[SW debug] Failed to append debug prompt:', e);
  }
  return id;
}

/**
 * Attach the model's answer to a debug entry once the call settles. Debugging a wrong answer means
 * reading the prompts AND what came back; the entry is written before the call, so the response has
 * to be patched in afterwards.
 *
 * @param {Promise<string>|string} idPromise - id from appendDebugPrompt
 * @param {{rawResponse?: string, ok?: boolean, durationMs?: number}} patch
 */
async function updateDebugPrompt(idPromise, patch) {
  try {
    const id = await idPromise;
    if (!id) return;
    const result = await chrome.storage.local.get(['debugPrompts', 'lastDebugPrompt']);
    const list = Array.isArray(result.debugPrompts) ? result.debugPrompts : [];
    const idx = list.findIndex(e => e && e.id === id);
    if (idx === -1) return; // rolled off the 50-entry cap
    list[idx] = { ...list[idx], ...patch };
    const update = { debugPrompts: list };
    if (result.lastDebugPrompt && result.lastDebugPrompt.id === id) {
      update.lastDebugPrompt = list[idx];
    }
    await chrome.storage.local.set(update);
  } catch (e) {
    console.error('[SW debug] Failed to update debug prompt:', e);
  }
}

/** Wrap an LLM call so its result (or error) lands on the debug entry. Never changes the result. */
function _withDebugResponse(idPromise, startedAt, promise) {
  return promise.then(
    (res) => {
      updateDebugPrompt(idPromise, {
        rawResponse: res?.content != null ? res.content : (res?.error || ''),
        ok: !res?.error,
        durationMs: Date.now() - startedAt
      }).catch(() => {});
      return res;
    },
    (err) => {
      updateDebugPrompt(idPromise, {
        rawResponse: err?.message || String(err),
        ok: false,
        durationMs: Date.now() - startedAt
      }).catch(() => {});
      throw err;
    }
  );
}

// ===== Message Handler =====
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'panelClosed') {
    // Kept for backward compatibility; actual close detection is port-based above.
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'callRouterLLM') {
    // Fast router - always uses Gemini 2.5 Flash for quick routing decisions
    callRouterLLM(request.messages, request.systemPrompt)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (request.action === 'callLLM') {
    const userPrompt = request.messages?.length > 0 ? request.messages[request.messages.length - 1].content : '';
    const debugId = appendDebugPrompt({
      timestamp: Date.now(),
      action: 'callLLM',
      systemPrompt: request.systemPrompt || '',
      userPrompt: userPrompt,
      messages: request.messages || [],
      imageBase64: request.imageBase64 || null,
      metadata: request.metadata || {}
    }).catch(() => null);

    _withDebugResponse(debugId, Date.now(), callLLM(request.messages, request.systemPrompt, request.imageBase64))
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (request.action === 'callLLMWithImages') {
    const userPrompt = request.messages?.length > 0 ? request.messages[request.messages.length - 1].content : '';
    const debugId = appendDebugPrompt({
      timestamp: Date.now(),
      action: 'callLLMWithImages',
      systemPrompt: request.systemPrompt || '',
      userPrompt: userPrompt,
      messages: request.messages || [],
      images: request.images || null,
      metadata: request.metadata || {}
    }).catch(() => null);

    _withDebugResponse(debugId, Date.now(), callLLMWithImages(request.messages, request.systemPrompt, request.images))
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (request.action === 'watchVideo') {
    const debugId = appendDebugPrompt({
      timestamp: Date.now(),
      action: 'watchVideo',
      systemPrompt: '',
      userPrompt: request.query || '',
      messages: [],
      videoUrl: request.videoUrl || '',
      metadata: request.metadata || {}
    }).catch(() => null);

    _withDebugResponse(debugId, Date.now(), watchVideoWithGemini(request.videoUrl, request.query, request.metadata || {}))
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (request.action === 'callEmbed') {
    callOpenAIEmbeddings(request.texts || [])
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (request.action === 'captureScreenshot') {
    const targetTabId = request.tabId || sender.tab?.id;
    const targetWindowId = sender.tab?.windowId;
    captureScreenshot(targetTabId, targetWindowId)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (request.action === 'studyTracker_start') {
    _studyTracker = { active: true, scrollUser: 0, scrollAgent: 0, ctrlF: 0, textSelect: 0, click: 0, mouseMove: 0, agentThinkMs: [], pages: [] };
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'studyTracker_batch') {
    if (_studyTracker && _studyTracker.active) {
      _studyTracker.scrollUser  += request.scrollUser  || 0;
      _studyTracker.scrollAgent += request.scrollAgent || 0;
      _studyTracker.ctrlF       += request.ctrlF       || 0;
      _studyTracker.textSelect  += request.textSelect  || 0;
      _studyTracker.click       += request.click       || 0;
      _studyTracker.mouseMove   += request.mouseMove   || 0;
    }
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'studyTracker_agentThink') {
    // One entry per agent LLM "thinking" turn (ms), emitted from safeSendMessage.
    if (_studyTracker && _studyTracker.active) {
      _studyTracker.agentThinkMs.push(request.durationMs || 0);
    }
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'studyTracker_getData') {
    const data = _studyTracker
      ? { scrollUser: _studyTracker.scrollUser, scrollAgent: _studyTracker.scrollAgent, ctrlF: _studyTracker.ctrlF, textSelect: _studyTracker.textSelect, click: _studyTracker.click, mouseMove: _studyTracker.mouseMove, agentThinkMs: [..._studyTracker.agentThinkMs], pages: [..._studyTracker.pages] }
      : { scrollUser: 0, scrollAgent: 0, ctrlF: 0, textSelect: 0, click: 0, mouseMove: 0, agentThinkMs: [], pages: [] };
    _studyTracker = null;
    sendResponse(data);
    return true;
  }
  if (request.action === 'extractPdfText') {
    extractPdfText(request.pdfUrl, request.maxPages || 15)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (request.action === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'navigateTab') {
    // Navigate current tab to a new URL (used for PDF page navigation)
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.update(tabs[0].id, { url: request.url });
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'No active tab' });
      }
    });
    return true;
  }
  if (request.action === 'openSidePanel') {
    // Open side panel from PDF viewer
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]?.id) {
        try {
          await chrome.sidePanel.open({ tabId: tabs[0].id });
          sendResponse({ success: true });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      }
    });
    return true;
  }
  if (request.action === 'guidanceV2_setState') {
    // Content script saves guidance state to SW memory, keyed by ITS OWN tab id.
    // Kept in sync by guidev2.js whenever the step changes. Setting/clearing one tab's entry
    // never touches any other tab's — that's the whole point of keying by tabId.
    const targetTabId = request.tabId ?? sender.tab?.id;
    if (targetTabId != null) {
      if (request.state) _gv2Sessions.set(targetTabId, request.state);
      else _gv2Sessions.delete(targetTabId);
    }
    // Synchronous response — do NOT return true (that keeps the channel open and
    // causes "message channel closed before response received" warnings).
    sendResponse({ success: true });
    return false;
  }
  if (request.action === 'guidanceV2_clearState') {
    // Messages from a content script carry no explicit tabId (sender.tab.id is authoritative);
    // messages from the side panel (no sender.tab) must pass one explicitly — see panel.js's
    // stopGuide/stopPausedGuideWithRecap/resetChat, which all target guideTabId/currentTabId.
    const targetTabId = request.tabId ?? sender.tab?.id;
    if (targetTabId != null) {
      _gv2Sessions.delete(targetTabId);
      detachDebugger(targetTabId); // release any background-capture debugger session for this tab
    }
    chrome.storage.local.remove(['debugPrompts', 'lastDebugPrompt']).catch(() => {});
    sendResponse({ success: true });
    return false;
  }
  if (request.action === 'guidanceV2_isOwner') {
    // Content script asks: does this tab still have an active guidance session?
    // Used to detect when a click transferred guidance to a new tab (see chrome.tabs.onCreated
    // above, which deletes the source tab's entry as part of the transfer).
    const senderTabId = sender.tab?.id;
    sendResponse({ isOwner: !!senderTabId && !!_gv2Sessions.get(senderTabId)?.active });
    return false;
  }
  if (request.action === 'guidanceV2_preClick') {
    // Content script signals that a guided click is about to fire.
    // Arm this tab's pre-click watch window so onCreated can transfer guidance
    // even when tab.openerTabId is not available.
    const senderTabId = sender.tab?.id;
    if (senderTabId != null) _gv2PreClickTsByTab.set(senderTabId, Date.now());
    sendResponse({ success: true });
    return false;
  }
});

// ===== PDF Text Extraction via Offscreen Document =====
let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');
  
  // Check if offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });
  
  if (existingContexts.length > 0) {
    return;
  }
  
  // Create offscreen document if not exists
  if (creatingOffscreen) {
    await creatingOffscreen;
  } else {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ['DOM_PARSER'],
      justification: 'Parse PDF files using PDF.js which requires DOM APIs'
    });
    await creatingOffscreen;
    creatingOffscreen = null;
  }
}

async function extractPdfText(pdfUrl, maxPages = 15) {
  console.log('📄 Extracting PDF text via offscreen document:', pdfUrl);
  
  try {
    // Ensure offscreen document is ready
    await ensureOffscreenDocument();
    
    // Send message to offscreen document
    const result = await chrome.runtime.sendMessage({
      action: 'extractPdfTextOffscreen',
      pdfUrl: pdfUrl,
      maxPages: maxPages
    });
    
    return result;
    
  } catch (e) {
    console.error('📄 PDF extraction error:', e);
    return { error: `Failed to extract PDF: ${e.message}` };
  }
}

// ===== Screenshot Capture =====
// Chrome rate-limits chrome.tabs.captureVisibleTab to ~2 calls/sec. In Guide mode we capture a
// BEFORE shot and an AFTER shot per step (plus an initial-state shot), and step N's before-shot
// fires right after step N-1's after-shot — so back-to-back calls otherwise hit
// "MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND" and the second one (typically step 2's screenshot)
// comes back empty. Serialize every capture through a single chain and enforce a minimum gap so
// no call is ever dropped.
const _CAPTURE_MIN_GAP_MS = 650;
let _captureChain = Promise.resolve();
let _lastCaptureTs = 0;

function captureScreenshot(tabId, windowId) {
  const run = _captureChain.then(() => _doCaptureScreenshot(tabId, windowId));
  // Keep the chain alive regardless of individual success/failure.
  _captureChain = run.then(() => {}, () => {});
  return run;
}

// ===== Background-tab screenshots via chrome.debugger (CDP) =====
// chrome.tabs.captureVisibleTab can only grab the *front* tab of a window. When the agent's tab is
// backgrounded — the user switched to another tab in the same window to do their own thing — we
// attach the debugger to the agent's tab and use Page.captureScreenshot, so the guide keeps seeing
// its own page without stealing the user's focus. Attach is lazy (first background capture only),
// so if the user never switches away, no debugger and no "…is debugging this browser" banner.
const _debuggerAttached = new Set(); // tabIds we currently hold a debugger session on
const _DEBUGGER_PROTOCOL = '1.3';

async function _ensureDebuggerAttached(tabId) {
  if (_debuggerAttached.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, _DEBUGGER_PROTOCOL);
    _debuggerAttached.add(tabId);
    return true;
  } catch (e) {
    // "Another debugger is already attached" → something else (e.g. open DevTools) owns the tab; we
    // can't drive it. Any other failure (restricted page, tab gone) is also non-recoverable here.
    console.warn('[SW capture] debugger attach failed:', e?.message || e);
    return false;
  }
}

async function detachDebugger(tabId) {
  if (tabId == null || !_debuggerAttached.has(tabId)) return;
  _debuggerAttached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch (e) { /* tab may already be gone */ }
}

async function _captureViaDebugger(tabId) {
  const ok = await _ensureDebuggerAttached(tabId);
  if (!ok) return { error: 'Could not attach debugger to capture background tab' };
  try {
    const res = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    if (res && res.data) return { success: true, imageBase64: res.data, format: 'jpeg' };
    return { error: 'Debugger capture returned no data' };
  } catch (e) {
    return { error: `Debugger capture failed: ${e?.message || e}` };
  }
}

// If the user dismisses the debugging banner (or the tab closes), drop our bookkeeping so we
// re-attach cleanly next time rather than assuming a stale session is still live.
if (chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source?.tabId != null) _debuggerAttached.delete(source.tabId);
  });
}
// Detach if the agent's tab is closed while we hold a debugger session on it.
chrome.tabs.onRemoved.addListener((tabId) => { detachDebugger(tabId); });

async function _doCaptureScreenshot(tabId, windowId) {
  try {
    if (!tabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id;
      if (!windowId) windowId = tab?.windowId;
    }
    if (!tabId) return { error: 'No active tab found' };

    // chrome.tabs.captureVisibleTab takes a windowId, NOT a tabId — it always grabs whichever tab
    // is currently the active/visible one in that window. When the tab we actually want a shot of
    // (tabId, the tab the guide is working on) is NOT the front tab — the user switched to another
    // tab in the same window to do their own thing — captureVisibleTab would grab that OTHER tab.
    // In that case we screenshot the agent's real tab directly via the debugger (CDP) instead, so
    // the guide keeps working on the right page without pulling the user's focus.
    let targetIsActive = true;
    try {
      const targetTab = await chrome.tabs.get(tabId);
      targetIsActive = targetTab?.active !== false;
      if (!windowId) windowId = targetTab?.windowId;
    } catch (e) {
      // Tab may have been closed since; let the capture calls below surface their own error.
    }

    if (!targetIsActive) {
      const dbg = await _captureViaDebugger(tabId);
      _lastCaptureTs = Date.now();
      if (dbg.success) {
        console.log('📸 Background-tab screenshot via debugger, size:', Math.round(dbg.imageBase64.length / 1024), 'KB');
      }
      return dbg; // success, or an error the caller falls back on (cached/placeholder)
    }

    // Front tab → fast path, no debugger attach (and no banner).
    // Throttle: ensure at least _CAPTURE_MIN_GAP_MS since the previous capture.
    const since = Date.now() - _lastCaptureTs;
    if (since < _CAPTURE_MIN_GAP_MS) {
      await new Promise(r => setTimeout(r, _CAPTURE_MIN_GAP_MS - since));
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(windowId || null, { format: 'jpeg', quality: 80 });
    _lastCaptureTs = Date.now();
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    console.log('📸 Screenshot captured, size:', Math.round(base64.length / 1024), 'KB');
    return { success: true, imageBase64: base64, format: 'jpeg' };
  } catch (error) {
    _lastCaptureTs = Date.now();
    console.error('📸 Screenshot error:', error);
    return { error: `Screenshot failed: ${error.message}` };
  }
}

async function callOpenAIEmbeddings(texts = []) {
  let settings = {};
  try {
    settings = await chrome.storage.sync.get(['provider', 'openrouterApiKey', 'openaiApiKey']);
  } catch (e) {
    return { error: 'Failed to load embedding settings' };
  }

  const input = (Array.isArray(texts) ? texts : [texts])
    .map(t => String(t || '').trim())
    .filter(Boolean);
  if (!input.length) return { embeddings: [] };

  // Route the embedding call by provider. text-embedding-ada-002 is served by the OpenAI-compatible
  // /embeddings endpoint on BOTH OpenAI and OpenRouter — Gemini has no such endpoint here, so when
  // the LLM provider is Gemini (or lacks a key) we still send embeddings to whichever of OpenAI /
  // OpenRouter is configured. The model id differs per endpoint (OpenRouter needs the "openai/"
  // prefix). Previously this only hit OpenAI, so OpenRouter-only users silently fell back to 0.0.
  const provider = settings.provider || CONFIG.defaultProvider;
  const openaiKey = (settings.openaiApiKey || CONFIG.providers.openai.defaultApiKey || '').trim();
  const openrouterKey = (settings.openrouterApiKey || CONFIG.providers.openrouter.defaultApiKey || '').trim();

  let endpoint, apiKey, model;
  if (provider === 'openai' && openaiKey) {
    endpoint = 'https://api.openai.com/v1/embeddings';
    apiKey = openaiKey;
    model = 'text-embedding-ada-002';
  } else if (openrouterKey) {
    endpoint = 'https://openrouter.ai/api/v1/embeddings';
    apiKey = openrouterKey;
    model = 'openai/text-embedding-ada-002';
  } else if (openaiKey) {
    endpoint = 'https://api.openai.com/v1/embeddings';
    apiKey = openaiKey;
    model = 'text-embedding-ada-002';
  } else {
    return { error: 'Embedding API key not configured (OpenAI or OpenRouter). Click ⚙️ Settings.' };
  }

  startKeepAlive();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'chrome-extension://pageguide',
        'X-Title': 'PageGuide'
      },
      body: JSON.stringify({ model, input })
    });
    const data = await response.json();
    if (!response.ok) {
      return { error: `Embedding API error: ${data.error?.message || response.status}` };
    }
    const embeddings = Array.isArray(data.data)
      ? data.data.slice().sort((a, b) => (a.index || 0) - (b.index || 0)).map(item => item.embedding || [])
      : [];
    return { embeddings, model };
  } catch (error) {
    return { error: `Embedding network error: ${error.message}` };
  } finally {
    stopKeepAlive();
  }
}

// ===== Multi-Image LLM Router =====
// Supports multiple images for comparison tasks (e.g., image_ask)
async function callLLMWithImages(messages, systemPrompt, images = []) {
  // Start keep-alive to prevent service worker from going inactive
  startKeepAlive();
  
  let settings;
  try {
    settings = await chrome.storage.sync.get([
      'provider',
      'geminiApiKey', 'geminiModel',
      'openrouterApiKey', 'openrouterModel',
      'openaiApiKey', 'openaiModel'
    ]);
  } catch (e) {
    stopKeepAlive();
    return { error: 'Failed to load settings' };
  }

  const provider = settings.provider || CONFIG.defaultProvider;

  let result;
  try {
    switch (provider) {
      case 'gemini':
        result = await callGeminiMultiImage(messages, systemPrompt, settings, images);
        break;
      case 'openrouter':
        result = await callOpenRouterMultiImage(messages, systemPrompt, settings, images);
        break;
      case 'openai':
        result = await callOpenAIMultiImage(messages, systemPrompt, settings, images);
        break;

      default:
        result = { error: `Unknown provider: ${provider}` };
    }
  } catch (e) {
    result = { error: `LLM call failed: ${e.message}` };
  }

  // Stop keep-alive after LLM call completes
  stopKeepAlive();
  return result;
}

// ===== Fast Router LLM =====
// Prefers Gemini 2.5 Flash for fast routing. If no Gemini key is set (e.g. an
// OpenRouter-only or OpenAI-only user), falls back to the user's selected provider
// so routing still works without requiring a separate Gemini key.
async function callRouterLLM(messages, systemPrompt) {
  const config = CONFIG.providers.gemini;
  const routerModel = 'gemini-2.5-flash';

  // Load all relevant settings in one call
  let settings = {};
  try {
    settings = await chrome.storage.sync.get([
      'geminiApiKey', 'provider',
      'openrouterApiKey', 'openrouterModel',
      'openaiApiKey', 'openaiModel'
    ]);
  } catch (e) { /* ignore */ }

  const apiKey = (settings.geminiApiKey || config.defaultApiKey || '').trim();

  // If no Gemini key, route via the user's selected provider instead
  if (!apiKey) {
    console.log('🎯 No Gemini key for router — using selected provider as fallback');
    return callLLM(messages, systemPrompt);
  }
  
  const url = `${config.endpoint}/${routerModel}:generateContent?key=${apiKey}`;
  
  try {
    let userContent = systemPrompt ? `[Instructions]\n${systemPrompt}\n\n` : '';
    if (messages?.length > 0) {
      userContent += messages[messages.length - 1].content;
    }
    
    console.log('🎯 Router LLM (Gemini 2.5 Flash) - prompt length:', userContent.length);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userContent }] }],
        generationConfig: { 
          temperature: 0.1, 
          maxOutputTokens: 256 // Router responses are short
        }
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      return { error: `Router API error: ${data.error?.message || response.status}` };
    }
    
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return { error: 'Empty response from router' };
    }
    
    return { content: text };
  } catch (error) {
    return { error: `Router network error: ${error.message}` };
  }
}

// ===== Main LLM Router =====
async function callLLM(messages, systemPrompt, imageBase64 = null) {
  // Start keep-alive to prevent service worker from going inactive
  startKeepAlive();
  
  let settings;
  try {
    settings = await chrome.storage.sync.get([
      'provider',
      'geminiApiKey', 'geminiModel',
      'openrouterApiKey', 'openrouterModel',
      'openaiApiKey', 'openaiModel'
    ]);
  } catch (e) {
    stopKeepAlive();
    return { error: 'Failed to load settings' };
  }

  const provider = settings.provider || CONFIG.defaultProvider;

  let result;
  try {
    switch (provider) {
      case 'gemini':
        result = await callGemini(messages, systemPrompt, settings, imageBase64);
        break;
      case 'openrouter':
        result = await callOpenRouter(messages, systemPrompt, settings, imageBase64);
        break;
      case 'openai':
        result = await callOpenAI(messages, systemPrompt, settings, imageBase64);
        break;

      default:
        result = { error: `Unknown provider: ${provider}` };
    }
  } catch (e) {
    result = { error: `LLM call failed: ${e.message}` };
  }

  // Stop keep-alive after LLM call completes
  stopKeepAlive();
  return result;
}

// ===== Gemini API Call =====
async function callGemini(messages, systemPrompt, settings, imageBase64 = null) {
  const config = CONFIG.providers.gemini;
  const apiKey = (settings.geminiApiKey || config.defaultApiKey).trim();
  
  if (!apiKey) {
    return { error: 'Gemini API key not configured. Click ⚙️ Settings.' };
  }
  
  const model = settings.geminiModel || config.defaultModel;
  const url = `${config.endpoint}/${model}:generateContent?key=${apiKey}`;
  
  try {
    let userContent = systemPrompt ? `[Instructions]\n${systemPrompt}\n\n` : '';
    if (messages?.length > 0) {
      userContent += messages[messages.length - 1].content;
    }
    
    // Build parts array - text first, then image if provided
    const parts = [{ text: userContent }];
    
    // Add image if provided (for vision capabilities)
    if (imageBase64) {
      console.log('🖼️ Adding image to Gemini request');
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: imageBase64
        }
      });
    }
    
    console.log('🤖 Gemini request - prompt length:', userContent.length, 'has image:', !!imageBase64);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: parts }],
        generationConfig: { 
          temperature: 0.1, 
          maxOutputTokens: 4096 
        },
        // Be more permissive with safety to avoid unnecessary blocks
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
        ]
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      return { error: `API error: ${data.error?.message || response.status}` };
    }
    
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      // Log more details for debugging
      console.warn('🤖 Gemini empty response. Full data:', JSON.stringify(data).slice(0, 500));
      
      // Check for safety blocks or other issues
      const finishReason = data.candidates?.[0]?.finishReason;
      const safetyRatings = data.candidates?.[0]?.safetyRatings;
      
      if (finishReason === 'SAFETY') {
        return { error: 'Response blocked by safety filters' };
      }
      if (finishReason === 'RECITATION') {
        return { error: 'Response blocked due to recitation' };
      }
      if (data.promptFeedback?.blockReason) {
        return { error: `Prompt blocked: ${data.promptFeedback.blockReason}` };
      }
      
      return { error: `Empty response from Gemini (reason: ${finishReason || 'unknown'})` };
    }
    
    return { content: text };
  } catch (error) {
    return { error: `Network error: ${error.message}` };
  }
}

// ===== Gemini Video URL Call =====
// Uses Gemini's fileData support for video URLs (for example YouTube links) to answer a query
// from both visual and audio content. This intentionally uses the Gemini key even when the user's
// selected chat provider is OpenRouter/OpenAI, because provider support for direct video URLs varies.
async function watchVideoWithGemini(videoUrl, query, metadata = {}) {
  startKeepAlive();

  let settings;
  try {
    settings = await chrome.storage.sync.get(['geminiApiKey', 'geminiModel']);
  } catch (e) {
    stopKeepAlive();
    return { error: 'Failed to load Gemini settings' };
  }

  const config = CONFIG.providers.gemini;
  const apiKey = (settings.geminiApiKey || config.defaultApiKey || '').trim();
  if (!apiKey) {
    stopKeepAlive();
    return { error: 'Gemini API key not configured. Add a Gemini key in Settings to use watch_video.' };
  }

  const urlText = String(videoUrl || '').trim();
  if (!/^https?:\/\//i.test(urlText)) {
    stopKeepAlive();
    return { error: 'watch_video needs a valid http(s) video URL.' };
  }

  const model = settings.geminiModel || config.defaultModel;
  const endpoint = `${config.endpoint}/${model}:generateContent?key=${apiKey}`;
  const prompt = `Watch the video and answer the user's query using only information supported by the video content (visuals, speech, captions, or on-screen text).

User query:
${String(query || 'Summarize the important information in this video.').trim()}

Return a concise answer. If the video does not answer the query, say so directly.`;

  try {
    console.log('🎬 Gemini watch_video request:', { model, videoUrl: urlText, url: metadata?.url || '' });
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { fileData: { fileUri: urlText } },
            { text: prompt }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return { error: `Video API error: ${data.error?.message || response.status}` };
    }

    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
    if (!text) {
      const finishReason = data.candidates?.[0]?.finishReason;
      if (finishReason === 'SAFETY') return { error: 'Video response blocked by safety filters' };
      if (data.promptFeedback?.blockReason) return { error: `Video prompt blocked: ${data.promptFeedback.blockReason}` };
      return { error: `Empty video response from Gemini (reason: ${finishReason || 'unknown'})` };
    }

    return { content: text };
  } catch (error) {
    return { error: `Video network error: ${error.message}` };
  } finally {
    stopKeepAlive();
  }
}

// ===== OpenRouter API Call =====
async function callOpenRouter(messages, systemPrompt, settings, imageBase64 = null) {
  const config = CONFIG.providers.openrouter;
  const apiKey = (settings.openrouterApiKey || config.defaultApiKey).trim();
  
  if (!apiKey) {
    return { error: 'OpenRouter API key not configured. Click ⚙️ Settings.' };
  }
  
  const model = settings.openrouterModel || config.defaultModel;
  
  try {
    // Build single-turn message (no conversation history)
    let userContent = systemPrompt ? `[Instructions]\n${systemPrompt}\n\n` : '';
    if (messages?.length > 0) {
      userContent += messages[messages.length - 1].content;
    }
    
    // Build content array for multimodal (text + image)
    let content;
    if (imageBase64) {
      console.log('🖼️ Adding image to OpenRouter request');
      content = [
        { type: 'text', text: userContent },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
      ];
    } else {
      content = userContent;
    }
    
    const chatMessages = [{ role: 'user', content: content }];
    
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': chrome.runtime.getURL(''),
        'X-Title': 'PageGuide'
      },
      body: JSON.stringify({
        model: model,
        messages: chatMessages,
        temperature: 0.1,
        max_tokens: 1024
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      return { error: `OpenRouter API error: ${data.error?.message || response.status}` };
    }
    
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      return { error: 'Empty response from OpenRouter' };
    }
    
    return { content: text };
  } catch (error) {
    return { error: `OpenRouter network error: ${error.message}` };
  }
}

// ===== OpenAI API Call =====
async function callOpenAI(messages, systemPrompt, settings, imageBase64 = null) {
  const config = CONFIG.providers.openai;
  const apiKey = (settings.openaiApiKey || config.defaultApiKey).trim();
  
  if (!apiKey) {
    return { error: 'OpenAI API key not configured. Click ⚙️ Settings.' };
  }
  
  const model = settings.openaiModel || config.defaultModel;
  
  try {
    // Build single-turn message (no conversation history)
    let userContent = systemPrompt ? `[Instructions]\n${systemPrompt}\n\n` : '';
    if (messages?.length > 0) {
      userContent += messages[messages.length - 1].content;
    }
    
    // Build content array for multimodal (text + image)
    let content;
    if (imageBase64) {
      console.log('🖼️ Adding image to OpenAI request');
      content = [
        { type: 'text', text: userContent },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'high' } }
      ];
    } else {
      content = userContent;
    }
    
    const chatMessages = [{ role: 'user', content: content }];
    
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: chatMessages,
        max_completion_tokens: 1024,
        // o-series models (o1, o3, o4-mini, …) don't support temperature
        ...(/^o\d/.test(model) ? {} : { temperature: 0.1 })
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return { error: `OpenAI API error: ${data.error?.message || response.status}` };
    }

    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      return { error: 'Empty response from OpenAI' };
    }
    
    return { content: text };
  } catch (error) {
    return { error: `OpenAI network error: ${error.message}` };
  }
}

// ===== Multi-Image Gemini API Call =====
async function callGeminiMultiImage(messages, systemPrompt, settings, images = []) {
  const config = CONFIG.providers.gemini;
  const apiKey = (settings.geminiApiKey || config.defaultApiKey).trim();
  
  if (!apiKey) {
    return { error: 'Gemini API key not configured. Click ⚙️ Settings.' };
  }
  
  const model = settings.geminiModel || config.defaultModel;
  const url = `${config.endpoint}/${model}:generateContent?key=${apiKey}`;
  
  try {
    let userContent = systemPrompt ? `[Instructions]\n${systemPrompt}\n\n` : '';
    if (messages?.length > 0) {
      userContent += messages[messages.length - 1].content;
    }
    
    // Build parts array - text first, then images
    const parts = [{ text: userContent }];
    
    // Add all images with labels
    if (images && images.length > 0) {
      console.log(`🖼️ Adding ${images.length} images to Gemini request`);
      for (const img of images) {
        // Add label as text before image if provided
        if (img.label) {
          parts.push({ text: `[${img.label}]:` });
        }
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: img.base64
          }
        });
      }
    }
    
    console.log('🤖 Gemini multi-image request - prompt length:', userContent.length, 'images:', images.length);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: parts }],
        generationConfig: { 
          temperature: 0.1, 
          maxOutputTokens: 4096 
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
        ]
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      return { error: `API error: ${data.error?.message || response.status}` };
    }
    
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      const finishReason = data.candidates?.[0]?.finishReason;
      if (finishReason === 'SAFETY') {
        return { error: 'Response blocked by safety filters' };
      }
      if (data.promptFeedback?.blockReason) {
        return { error: `Prompt blocked: ${data.promptFeedback.blockReason}` };
      }
      return { error: `Empty response from Gemini (reason: ${finishReason || 'unknown'})` };
    }
    
    return { content: text };
  } catch (error) {
    return { error: `Network error: ${error.message}` };
  }
}

// ===== Multi-Image OpenRouter API Call =====
async function callOpenRouterMultiImage(messages, systemPrompt, settings, images = []) {
  const config = CONFIG.providers.openrouter;
  const apiKey = (settings.openrouterApiKey || config.defaultApiKey).trim();
  
  if (!apiKey) {
    return { error: 'OpenRouter API key not configured. Click ⚙️ Settings.' };
  }
  
  const model = settings.openrouterModel || config.defaultModel;
  
  try {
    let userContent = systemPrompt ? `[Instructions]\n${systemPrompt}\n\n` : '';
    if (messages?.length > 0) {
      userContent += messages[messages.length - 1].content;
    }
    
    // Build content array for multimodal (text + images)
    const content = [{ type: 'text', text: userContent }];
    
    if (images && images.length > 0) {
      console.log(`🖼️ Adding ${images.length} images to OpenRouter request`);
      for (const img of images) {
        if (img.label) {
          content.push({ type: 'text', text: `[${img.label}]:` });
        }
        content.push({ 
          type: 'image_url', 
          image_url: { url: `data:image/jpeg;base64,${img.base64}` } 
        });
      }
    }
    
    const chatMessages = [{ role: 'user', content: content }];
    
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': chrome.runtime.getURL(''),
        'X-Title': 'PageGuide'
      },
      body: JSON.stringify({
        model: model,
        messages: chatMessages,
        temperature: 0.1,
        max_tokens: 1024
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      return { error: `OpenRouter API error: ${data.error?.message || response.status}` };
    }
    
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      return { error: 'Empty response from OpenRouter' };
    }
    
    return { content: text };
  } catch (error) {
    return { error: `OpenRouter network error: ${error.message}` };
  }
}

// ===== Multi-Image OpenAI API Call =====
async function callOpenAIMultiImage(messages, systemPrompt, settings, images = []) {
  const config = CONFIG.providers.openai;
  const apiKey = (settings.openaiApiKey || config.defaultApiKey).trim();
  
  if (!apiKey) {
    return { error: 'OpenAI API key not configured. Click ⚙️ Settings.' };
  }
  
  const model = settings.openaiModel || config.defaultModel;
  
  try {
    let userContent = systemPrompt ? `[Instructions]\n${systemPrompt}\n\n` : '';
    if (messages?.length > 0) {
      userContent += messages[messages.length - 1].content;
    }
    
    // Build content array for multimodal (text + images)
    const content = [{ type: 'text', text: userContent }];
    
    if (images && images.length > 0) {
      console.log(`🖼️ Adding ${images.length} images to OpenAI request`);
      for (const img of images) {
        if (img.label) {
          content.push({ type: 'text', text: `[${img.label}]:` });
        }
        content.push({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${img.base64}`, detail: 'high' }
        });
      }
    }

    const chatMessages = [{ role: 'user', content: content }];

    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: chatMessages,
        max_completion_tokens: 1024,
        // o-series models (o1, o3, o4-mini, …) don't support temperature
        ...(/^o\d/.test(model) ? {} : { temperature: 0.1 })
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return { error: `OpenAI API error: ${data.error?.message || response.status}` };
    }

    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      return { error: 'Empty response from OpenAI' };
    }

    return { content: text };
  } catch (error) {
    return { error: `OpenAI network error: ${error.message}` };
  }
}
