// XWebAgent Options Page Script
// Supports Gemini, OpenRouter, and OpenAI providers

let currentProvider = 'gemini';

// Provider display names
const PROVIDER_NAMES = {
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  openai: 'OpenAI'
};

// Load saved settings
async function loadSettings() {
  const settings = await chrome.storage.sync.get([
    'provider',
    'geminiApiKey', 'geminiModel',
    'openrouterApiKey', 'openrouterModel',
    'openaiApiKey', 'openaiModel',
    'visionEnabled'
  ]);
  
  // Set current provider
  currentProvider = settings.provider || 'gemini';
  updateProviderUI(currentProvider);
  
  // Load Gemini settings
  document.getElementById('geminiApiKey').value = settings.geminiApiKey || '';
  document.getElementById('geminiModel').value = settings.geminiModel || 'gemini-2.5-flash';
  
  // Load OpenRouter settings
  document.getElementById('openrouterApiKey').value = settings.openrouterApiKey || '';
  document.getElementById('openrouterModel').value = settings.openrouterModel || 'google/gemini-2.5-flash';
  
  // Load OpenAI settings
  document.getElementById('openaiApiKey').value = settings.openaiApiKey || '';
  document.getElementById('openaiModel').value = settings.openaiModel || 'gpt-4o';
  
  // Load Vision setting (default: enabled)
  document.getElementById('visionEnabled').checked = settings.visionEnabled !== false;
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
  resultDiv.style.display = 'none';
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
    visionEnabled: document.getElementById('visionEnabled').checked
  };
  
  await chrome.storage.sync.set(settings);
  showStatus('Settings saved!', 'success');
}

// Test API connection based on current provider
async function testApi() {
  const resultDiv = document.getElementById('testResult');
  
  resultDiv.textContent = '🔄 Testing...';
  resultDiv.className = 'status info';
  
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
      generationConfig: { maxOutputTokens: 10 }
    })
  });
  
  const data = await response.json();
  
  if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
    resultDiv.textContent = '✅ Gemini API connected!';
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
      'X-Title': 'XWebAgent'
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: 'Say "OK" only.' }],
      max_tokens: 10
    })
  });
  
  const data = await response.json();
  
  if (response.ok && data.choices?.[0]?.message?.content) {
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
      max_tokens: 10
    })
  });
  
  const data = await response.json();
  
  if (response.ok && data.choices?.[0]?.message?.content) {
    resultDiv.textContent = `✅ OpenAI connected! (${model})`;
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
