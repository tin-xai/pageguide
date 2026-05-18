// PageGuide Options Page Script
// Supports Gemini, OpenRouter, and OpenAI providers

let currentProvider = 'gemini';

// Provider display names
const PROVIDER_NAMES = {
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  togetherai: 'Together AI'
};

// Load saved settings
async function loadSettings() {
  const settings = await chrome.storage.sync.get([
    'provider',
    'geminiApiKey', 'geminiModel',
    'openrouterApiKey', 'openrouterModel',
    'openaiApiKey', 'openaiModel',
    'togetheraiApiKey', 'togetheraiModel',
    'visionEnabled',
    'somEnabled'
  ]);
  
  // Set current provider
  currentProvider = settings.provider || 'gemini';
  updateProviderUI(currentProvider);
  
  // Load Gemini settings (model falls back to <select> first option if not saved)
  document.getElementById('geminiApiKey').value = settings.geminiApiKey || '';
  if (settings.geminiModel) document.getElementById('geminiModel').value = settings.geminiModel;

  // Load OpenRouter settings
  document.getElementById('openrouterApiKey').value = settings.openrouterApiKey || '';
  if (settings.openrouterModel) document.getElementById('openrouterModel').value = settings.openrouterModel;

  // Load OpenAI settings
  document.getElementById('openaiApiKey').value = settings.openaiApiKey || '';
  if (settings.openaiModel) document.getElementById('openaiModel').value = settings.openaiModel;

  // Load TogetherAI settings
  document.getElementById('togetheraiApiKey').value = settings.togetheraiApiKey || '';
  if (settings.togetheraiModel) document.getElementById('togetheraiModel').value = settings.togetheraiModel;

  // Load Vision setting (default: enabled)
  document.getElementById('visionEnabled').checked = settings.visionEnabled !== false;
  
  // Load SoM setting (default: disabled)
  document.getElementById('somEnabled').checked = settings.somEnabled === true;
}

// Update UI to show selected provider
function updateProviderUI(provider) {
  currentProvider = provider;
  
  // Update tabs
  document.querySelectorAll('.provider-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.provider === provider);
  });
  
  // Update config sections
  document.querySelectorAll('.provider-config').forEach(config => {
    config.classList.toggle('active', config.id === `config-${provider}`);
  });
  
  // Update current provider display
  document.getElementById('currentProvider').textContent = `Current: ${PROVIDER_NAMES[provider]}`;
  
  // Clear test result
  const resultDiv = document.getElementById('testResult');
  resultDiv.className = 'status';
  resultDiv.style.display = '';
}

// Save settings
async function saveSettings() {
  const settings = {
    provider: currentProvider,
    geminiApiKey: document.getElementById('geminiApiKey').value.trim(),
    geminiModel: document.getElementById('geminiModel').value,
    openrouterApiKey: document.getElementById('openrouterApiKey').value.trim(),
    openrouterModel: document.getElementById('openrouterModel').value,
    openaiApiKey: document.getElementById('openaiApiKey').value.trim(),
    openaiModel: document.getElementById('openaiModel').value,
    togetheraiApiKey: document.getElementById('togetheraiApiKey').value.trim(),
    togetheraiModel: document.getElementById('togetheraiModel').value,
    visionEnabled: document.getElementById('visionEnabled').checked,
    somEnabled: document.getElementById('somEnabled').checked
  };
  
  await chrome.storage.sync.set(settings);
  showStatus('Settings saved!', 'success');
}

// Test API connection based on current provider
async function testApi() {
  const resultDiv = document.getElementById('testResult');

  resultDiv.textContent = '🔄 Testing...';
  resultDiv.className = 'status info';

  // Settings are saved ONLY on success (inside each test function).
  // This prevents a bad/untested key from being persisted and shown as "active" in the chat.
  try {
    switch (currentProvider) {
      case 'gemini':
        await testGemini(resultDiv);
        break;
      case 'openrouter':
        await testOpenRouter(resultDiv);
        break;
      case 'openai':
        await testOpenAI(resultDiv);
        break;
      case 'togetherai':
        await testTogetherAI(resultDiv);
        break;
    }
  } catch (error) {
    resultDiv.textContent = `❌ Network error: ${error.message}`;
    resultDiv.className = 'status error';
  }
}

// Test Gemini API
async function testGemini(resultDiv) {
  const apiKey = document.getElementById('geminiApiKey').value.trim();
  const model = document.getElementById('geminiModel').value;
  
  if (!apiKey) {
    resultDiv.textContent = '❌ Please enter a Gemini API key';
    resultDiv.className = 'status error';
    return;
  }
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Say "OK" only.' }] }],
      generationConfig: { maxOutputTokens: 500 }  // Higher for thinking models like 2.5 Pro
    })
  });
  
  const data = await response.json();
  
  if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
    await saveSettings(); // Only persist on success
    resultDiv.textContent = `✅ Gemini connected! (${model})`;
    resultDiv.className = 'status success';
  } else {
    resultDiv.textContent = `❌ ${data.error?.message || 'Unknown error'}`;
    resultDiv.className = 'status error';
  }
}

// Test OpenRouter API
async function testOpenRouter(resultDiv) {
  const apiKey = document.getElementById('openrouterApiKey').value.trim();
  const model = document.getElementById('openrouterModel').value;
  
  if (!apiKey) {
    resultDiv.textContent = '❌ Please enter an OpenRouter API key';
    resultDiv.className = 'status error';
    return;
  }
  
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': chrome.runtime.getURL(''),
      'X-Title': 'PageGuide'
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: 'Say "OK" only.' }],
      max_tokens: 100
    })
  });

  const data = await response.json();

  if (response.ok && data.choices?.[0]?.message?.content) {
    await saveSettings(); // Only persist on success
    resultDiv.textContent = `✅ OpenRouter connected! (${model.split('/')[1] || model})`;
    resultDiv.className = 'status success';
  } else {
    resultDiv.textContent = `❌ ${data.error?.message || 'Unknown error'}`;
    resultDiv.className = 'status error';
  }
}

// Test OpenAI API
async function testOpenAI(resultDiv) {
  const apiKey = document.getElementById('openaiApiKey').value.trim();
  const model = document.getElementById('openaiModel').value;
  
  if (!apiKey) {
    resultDiv.textContent = '❌ Please enter an OpenAI API key';
    resultDiv.className = 'status error';
    return;
  }
  
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: 'Say "OK" only.' }],
      max_tokens: 100
    })
  });

  const data = await response.json();

  if (response.ok && data.choices?.[0]?.message?.content) {
    await saveSettings(); // Only persist on success
    resultDiv.textContent = `✅ OpenAI connected! (${model})`;
    resultDiv.className = 'status success';
  } else {
    resultDiv.textContent = `❌ ${data.error?.message || 'Unknown error'}`;
    resultDiv.className = 'status error';
  }
}

// Test Together AI API
async function testTogetherAI(resultDiv) {
  const apiKey = document.getElementById('togetheraiApiKey').value.trim();
  const model = document.getElementById('togetheraiModel').value;

  if (!apiKey) {
    resultDiv.textContent = '❌ Please enter a Together AI API key';
    resultDiv.className = 'status error';
    return;
  }

  const response = await fetch('https://api.together.xyz/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: 'Say "OK" only.' }],
      max_tokens: 100
    })
  });

  const data = await response.json();

  if (response.ok && data.choices?.[0]?.message?.content) {
    await saveSettings(); // Only persist on success
    resultDiv.textContent = `✅ Together AI connected! (${model.split('/').pop()})`;
    resultDiv.className = 'status success';
  } else {
    resultDiv.textContent = `❌ ${data.error?.message || 'Unknown error'}`;
    resultDiv.className = 'status error';
  }
}

// Show status message
function showStatus(message, type) {
  const statusDiv = document.getElementById('status');
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
  
  setTimeout(() => {
    statusDiv.className = 'status';
  }, 3000);
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  
  // Provider tab clicks
  document.querySelectorAll('.provider-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      updateProviderUI(tab.dataset.provider);
    });
  });
  
  // Save and test buttons
  document.getElementById('saveBtn').addEventListener('click', saveSettings);
  document.getElementById('testApiBtn').addEventListener('click', testApi);
});