// XWebAgent Options Page Script

// Load saved settings
async function loadSettings() {
  const settings = await chrome.storage.sync.get(['geminiApiKey', 'model']);
  
  document.getElementById('apiKey').value = settings.geminiApiKey || '';
  document.getElementById('model').value = settings.model || 'gemini-2.0-flash-exp';
  
  if (!settings.geminiApiKey) {
    document.getElementById('apiKey').placeholder = 'Enter your API key (or loaded from config.js)';
  }
}

// Save settings
async function saveSettings() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const model = document.getElementById('model').value;
  
  await chrome.storage.sync.set({
    geminiApiKey: apiKey,
    model: model
  });
  
  showStatus('Settings saved!', 'success');
}

// Test API connection
async function testApi() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const model = document.getElementById('model').value;
  const resultDiv = document.getElementById('testResult');
  
  if (!apiKey) {
    resultDiv.textContent = '❌ Please enter an API key first';
    resultDiv.className = 'status error';
    return;
  }
  
  resultDiv.textContent = '🔄 Testing...';
  resultDiv.className = 'status';
  resultDiv.style.display = 'block';
  resultDiv.style.background = 'rgba(255,255,255,0.05)';
  resultDiv.style.color = '#aaa';
  
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Say "Hello! API working!" in exactly those words.' }] }],
        generationConfig: { maxOutputTokens: 50 }
      })
    });
    
    const data = await response.json();
    
    if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
      resultDiv.textContent = '✅ API connection successful!';
      resultDiv.className = 'status success';
    } else {
      resultDiv.textContent = `❌ Error: ${data.error?.message || 'Unknown error'}`;
      resultDiv.className = 'status error';
    }
  } catch (error) {
    resultDiv.textContent = `❌ Network error: ${error.message}`;
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
  
  document.getElementById('saveBtn').addEventListener('click', saveSettings);
  document.getElementById('testApiBtn').addEventListener('click', testApi);
});
