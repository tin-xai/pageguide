// XWebAgent Background Service Worker
// Handles API calls to multiple LLM providers (Gemini, OpenRouter, OpenAI)

console.log('🤖 XWebAgent Service Worker started');

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

// Load API keys from config.js
try {
  importScripts('../config.js');
  console.log('🤖 Loaded config.js');
} catch (e) {
  console.warn('🤖 config.js not found');
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
  'content/functions/capture_screenshot.js',
  'content/functions/highlight.js',
  'content/functions/highlight_pdf.js',
  'content/functions/scroll.js',
  'content/functions/main_router.js',
  'content/tasks/protection.js',
  'content/tasks/guide.js',
  'content/tasks/ask.js',
  'content/tasks/ask_pdf.js',
  'content/tasks/image_ask.js',
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
      
      // Inject content scripts only if not already loaded (check via manifest injection)
      if (tab.url?.startsWith('http')) {
        try {
          // Check if content scripts are already loaded
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => typeof window._xwebagentLoaded !== 'undefined'
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

// ===== Message Handler =====
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'panelClosed') {
    sidePanelOpen = false;
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'callLLM') {
    callLLM(request.messages, request.systemPrompt, request.imageBase64)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (request.action === 'callLLMWithImages') {
    callLLMWithImages(request.messages, request.systemPrompt, request.images)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (request.action === 'captureScreenshot') {
    captureScreenshot(request.tabId)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (request.action === 'extractPdfText') {
    extractPdfText(request.pdfUrl, request.maxPages || 15)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (request.action === 'getVisionSetting') {
    chrome.storage.sync.get(['visionEnabled'])
      .then(settings => {
        // Default to true if not set
        sendResponse({ visionEnabled: settings.visionEnabled !== false });
      })
      .catch(err => sendResponse({ visionEnabled: true, error: err.message }));
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
async function captureScreenshot(tabId) {
  try {
    // Get the current active tab if no tabId provided
    if (!tabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id;
    }
    
    if (!tabId) {
      return { error: 'No active tab found' };
    }
    
    // Capture the visible area of the tab
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: 'jpeg',
      quality: 80  // Good balance between quality and size
    });
    
    // Remove the data URL prefix to get just the base64
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    
    console.log('📸 Screenshot captured, size:', Math.round(base64.length / 1024), 'KB');
    
    return { 
      success: true, 
      imageBase64: base64,
      format: 'jpeg'
    };
  } catch (error) {
    console.error('📸 Screenshot error:', error);
    return { error: `Screenshot failed: ${error.message}` };
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