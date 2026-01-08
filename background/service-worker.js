// XWebAgent Background Service Worker
// Handles API calls to multiple LLM providers (Gemini, OpenRouter, OpenAI)

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
  providers: {
    gemini: {
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
      defaultModel: 'gemini-2.0-flash-exp',
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

// Content script files (in order)
const CONTENT_SCRIPTS = [
  'content/prompts.js',
  'content/utils.js', 
  'content/styling.js',
  'content/actions.js',
  'content/protection.js',  // Dark pattern & ad protection
  'content/api.js',
  'content/chat.js',
  'content/content.js'
];

// Track if side panel is open
let sidePanelOpen = false;

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
      
      // Inject content scripts if on a valid page
      if (tab.url?.startsWith('http')) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: CONTENT_SCRIPTS
          });
          await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['content/content.css']
          });
        } catch (err) {
          // Scripts might already be injected
        }
      }
    }
  } catch (err) {
    console.error('Could not toggle side panel:', err);
  }
});

// ===== Message Handler =====
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'panelClosed') {
    sidePanelOpen = false;
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'callLLM') {
    callLLM(request.messages, request.systemPrompt)
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

// ===== Main LLM Router =====
async function callLLM(messages, systemPrompt) {
  let settings;
  try {
    settings = await chrome.storage.sync.get([
      'provider',
      'geminiApiKey', 'geminiModel',
      'openrouterApiKey', 'openrouterModel',
      'openaiApiKey', 'openaiModel'
    ]);
  } catch (e) {
    return { error: 'Failed to load settings' };
  }
  
  const provider = settings.provider || CONFIG.defaultProvider;
  
  switch (provider) {
    case 'gemini':
      return callGemini(messages, systemPrompt, settings);
    case 'openrouter':
      return callOpenRouter(messages, systemPrompt, settings);
    case 'openai':
      return callOpenAI(messages, systemPrompt, settings);
    default:
      return { error: `Unknown provider: ${provider}` };
  }
}

// ===== Gemini API Call =====
async function callGemini(messages, systemPrompt, settings) {
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
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userContent }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
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

// ===== OpenRouter API Call =====
async function callOpenRouter(messages, systemPrompt, settings) {
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
    
    const chatMessages = [{ role: 'user', content: userContent }];
    
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': chrome.runtime.getURL(''),
        'X-Title': 'XWebAgent'
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
async function callOpenAI(messages, systemPrompt, settings) {
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
    
    const chatMessages = [{ role: 'user', content: userContent }];
    
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
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