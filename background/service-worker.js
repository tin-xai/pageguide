// XWebAgent Background Service Worker
// Handles API calls to Gemini and extension icon clicks

console.log('🤖 XWebAgent Service Worker started');

// Load API keys from config.js
try {
  importScripts('../config.js');
  console.log('🤖 Loaded config.js');
} catch (e) {
  console.warn('🤖 config.js not found');
}

// ===== Configuration =====
const CONFIG = {
  geminiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
  defaultModel: 'gemini-2.0-flash-exp',
  defaultApiKey: (typeof CONFIG_KEYS !== 'undefined' && CONFIG_KEYS.GEMINI_KEY) || ''
};

// Content script files (in order)
const CONTENT_SCRIPTS = [
  'content/prompts.js',
  'content/utils.js', 
  'content/styling.js',
  'content/api.js',
  'content/chat.js',
  'content/content.js'
];

// ===== Extension Icon Click =====
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url?.startsWith('http')) return;
  
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'toggleChatPanel' });
  } catch (e) {
    // Inject content scripts if not loaded
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: CONTENT_SCRIPTS
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content/content.css']
      });
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { action: 'toggleChatPanel' });
      }, 100);
    } catch (err) {
      console.error('Could not inject:', err);
    }
  }
});

// ===== Message Handler =====
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'callLLM') {
    callGemini(request.messages, request.systemPrompt)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (request.action === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return true;
  }
});

// ===== Gemini API Call =====
async function callGemini(messages, systemPrompt) {
  let settings;
  try {
    settings = await chrome.storage.sync.get(['geminiApiKey', 'model']);
  } catch (e) {
    return { error: 'Failed to load settings' };
  }
  
  const apiKey = (settings.geminiApiKey || CONFIG.defaultApiKey).trim();
  if (!apiKey) {
    return { error: 'API key not configured. Click ⚙️ Settings.' };
  }
  
  const model = settings.model || CONFIG.defaultModel;
  const url = `${CONFIG.geminiEndpoint}/${model}:generateContent?key=${apiKey}`;
  
  try {
    let userContent = systemPrompt ? `[Instructions]\n${systemPrompt}\n\n` : '';
    if (messages?.length > 0) {
      userContent += messages[messages.length - 1].content;
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userContent }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      return { error: `API error: ${data.error?.message || response.status}` };
    }
    
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return { error: 'Empty response from Gemini' };
    }
    
    return { content: text };
  } catch (error) {
    return { error: `Network error: ${error.message}` };
  }
}
