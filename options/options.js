// PageGuide Options Page Script
// Supports Gemini, OpenRouter, and OpenAI providers

let currentProvider = 'gemini';

// Provider display names
const PROVIDER_NAMES = {
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  openai: 'OpenAI'
};

// OpenRouter models that accept TEXT ONLY, per openrouter.ai/api/v1/models.
//
// This matters because nothing downstream checks: background/service-worker.js pushes an
// `image_url` part onto every OpenRouter request whenever Vision is on, with no per-model
// capability test, so one of these models comes back as an opaque API error rather than as
// "that model cannot see". Rather than silently dropping the screenshot — which would change
// what the agent is answering from without saying so — the picker warns and leaves the choice
// alone. A text-only model is the right pick for a text-only task.
//
// Must stay in step with the "(text only)" labels in options.html; a unit test pins that.
const TEXT_ONLY_OPENROUTER_MODELS = [
  'qwen/qwen3.7-max',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v3.2',
  'moonshotai/kimi-k2-thinking'
];
window.TEXT_ONLY_OPENROUTER_MODELS = TEXT_ONLY_OPENROUTER_MODELS;

/**
 * The warning to show under the OpenRouter picker, or '' for nothing to say. Pure.
 *
 * Only the combination is a problem: a text-only model with Vision off is fine, and a
 * vision model with Vision on is fine.
 *
 * @param {string} model - the selected OpenRouter model id
 * @param {boolean} visionEnabled - the Vision (Screenshot) toggle
 * @returns {string}
 */
function openrouterVisionWarning(model, visionEnabled) {
  if (!visionEnabled) return '';
  if (!TEXT_ONLY_OPENROUTER_MODELS.includes(String(model || ''))) return '';
  return `\u26a0\ufe0f ${model} takes text only, but Vision (Screenshot) is on. `
    + 'Requests that attach a screenshot will be rejected by OpenRouter \u2014 turn Vision off '
    + 'for this model, or pick one that reads images.';
}
window.openrouterVisionWarning = openrouterVisionWarning;

/** Paint the warning under the picker from whatever the two controls currently hold. */
function refreshOpenrouterVisionWarning() {
  const box = document.getElementById('openrouterVisionWarning');
  const select = document.getElementById('openrouterModel');
  const vision = document.getElementById('visionEnabled');
  if (!box || !select || !vision) return;
  const message = openrouterVisionWarning(select.value, vision.checked);
  box.textContent = message;
  box.hidden = !message;
}

// Load saved settings
async function loadSettings() {
  const settings = await chrome.storage.sync.get([
    'provider',
    'geminiApiKey', 'geminiModel',
    'openrouterApiKey', 'openrouterModel',
    'openaiApiKey', 'openaiModel',
    'visionEnabled',
    'somEnabled',
    'debugEnabled',
    'debugSteerContextEnabled',
    'alwaysShowPromptBtn',
    'maxSteps',
    'personalizationEnabled',
    'personalizationFacts',
    'personalizedProfile'
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

  // Load Vision setting (default: enabled)
  document.getElementById('visionEnabled').checked = settings.visionEnabled !== false;

  // Load SoM setting (default: disabled)
  document.getElementById('somEnabled').checked = settings.somEnabled === true;

  // Load Max Steps setting (default: 20)
  document.getElementById('maxSteps').value = settings.maxSteps || 20;

  // Load Personalization settings (default: disabled)
  document.getElementById('personalizationEnabled').checked = settings.personalizationEnabled === true;
  document.getElementById('personalizationFacts').value = settings.personalizationFacts || '';
  renderPersonalizedProfile(settings.personalizedProfile);

  // Load Debug setting (default: disabled)
  const debugEnabled = settings.debugEnabled === true;
  document.getElementById('debugEnabled').checked = debugEnabled;
  document.getElementById('debugSteerContextEnabled').checked = settings.debugSteerContextEnabled === true;
  document.getElementById('alwaysShowPromptBtn').checked = settings.alwaysShowPromptBtn === true;
  if (debugEnabled) {
    document.getElementById('debugCode').value = 'PAGEGUIDE2026';
    document.getElementById('debugToggleGroup').style.display = 'block';
  }

  // Load Rewind capture setting from local storage (default: enabled).
  // Kept in chrome.storage.local (not sync) because the capture writes large
  // snapshots locally and the content script reads the flag from local too.
  try {
    const local = await chrome.storage.local.get(['rewindCaptureEnabled', 'guidePlanningEnabled', 'guideConfidenceThreshold', 'guideLowConfidenceActionThreshold', 'guideLoopStepThreshold']);
    document.getElementById('rewindCaptureEnabled').checked = local.rewindCaptureEnabled !== false;
    const planningToggle = document.getElementById('guidePlanningEnabled');
    if (planningToggle) planningToggle.checked = local.guidePlanningEnabled === true;
    const thresholdInput = document.getElementById('guideConfidenceThreshold');
    if (thresholdInput) thresholdInput.value = Number.isFinite(Number(local.guideConfidenceThreshold)) ? Number(local.guideConfidenceThreshold) : 0.7;
    const actionThresholdInput = document.getElementById('guideLowConfidenceActionThreshold');
    if (actionThresholdInput) actionThresholdInput.value = Number.isFinite(Number(local.guideLowConfidenceActionThreshold)) ? Number(local.guideLowConfidenceActionThreshold) : 5;
    const loopStepInput = document.getElementById('guideLoopStepThreshold');
    // Default 6 — see _gv2LoopStepThreshold. One over-threshold step is a coincidence, not a loop.
    if (loopStepInput) loopStepInput.value = Number.isFinite(Number(local.guideLoopStepThreshold)) ? Number(local.guideLoopStepThreshold) : 6;
  } catch (e) {}

  // After both controls it reads are populated, or a saved text-only model would look fine on load
  // and only warn once something was touched.
  refreshOpenrouterVisionWarning();
}

// Render the read-only "what PageGuide has learned about you" viewer
function renderPersonalizedProfile(profile) {
  const view = document.getElementById('personalizedProfileView');
  const meta = document.getElementById('personalizedProfileMeta');
  if (!view || !meta) return;
  const summary = profile?.summary || '';
  if (!summary) {
    view.textContent = 'Nothing learned yet.';
    meta.textContent = '';
    return;
  }
  view.textContent = summary;
  const updatedAt = profile?.updatedAt ? new Date(profile.updatedAt).toLocaleString() : 'unknown';
  meta.textContent = `Last updated ${updatedAt}, v${profile?.version || 0}`;
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
    visionEnabled: document.getElementById('visionEnabled').checked,
    somEnabled: document.getElementById('somEnabled').checked,
    maxSteps: parseInt(document.getElementById('maxSteps').value, 10) || 20,
    personalizationFacts: document.getElementById('personalizationFacts').value.trim(),
    debugEnabled: document.getElementById('debugEnabled').checked,
    debugSteerContextEnabled: document.getElementById('debugSteerContextEnabled').checked,
    alwaysShowPromptBtn: document.getElementById('alwaysShowPromptBtn').checked
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
      max_completion_tokens: 100,
      ...(/^o\d/.test(model) ? {} : { temperature: 0.1 })
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

  // Rewind capture toggle persists immediately to local storage on change.
  const rewindToggle = document.getElementById('rewindCaptureEnabled');
  if (rewindToggle) {
    rewindToggle.addEventListener('change', async () => {
      try {
        await chrome.storage.local.set({ rewindCaptureEnabled: rewindToggle.checked });
        showStatus(rewindToggle.checked ? 'Rewind capture enabled' : 'Rewind capture disabled', 'success');
      } catch (e) {}
    });
  }

  const planningToggle = document.getElementById('guidePlanningEnabled');
  if (planningToggle) {
    planningToggle.addEventListener('change', async () => {
      try {
        await chrome.storage.local.set({ guidePlanningEnabled: planningToggle.checked });
        showStatus(planningToggle.checked ? 'Guide planning enabled' : 'Guide planning disabled', 'success');
      } catch (e) {}
    });
  }

  const confidenceThresholdInput = document.getElementById('guideConfidenceThreshold');
  if (confidenceThresholdInput) {
    confidenceThresholdInput.addEventListener('change', async () => {
      const raw = Number(confidenceThresholdInput.value);
      const value = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.7;
      confidenceThresholdInput.value = value;
      try {
        await chrome.storage.local.set({ guideConfidenceThreshold: value });
        showStatus(`Confidence threshold set to ${value}`, 'success');
      } catch (e) {}
    });
  }

  const actionThresholdInput = document.getElementById('guideLowConfidenceActionThreshold');
  if (actionThresholdInput) {
    actionThresholdInput.addEventListener('change', async () => {
      const raw = Number(actionThresholdInput.value);
      const value = Number.isFinite(raw) ? Math.max(1, Math.round(raw)) : 5;
      actionThresholdInput.value = value;
      try {
        await chrome.storage.local.set({ guideLowConfidenceActionThreshold: value });
        showStatus(`Low confidence action threshold set to ${value}`, 'success');
      } catch (e) {}
    });
  }

  const loopStepThresholdInput = document.getElementById('guideLoopStepThreshold');
  if (loopStepThresholdInput) {
    loopStepThresholdInput.addEventListener('change', async () => {
      const raw = Number(loopStepThresholdInput.value);
      const value = Number.isFinite(raw) ? Math.max(1, Math.round(raw)) : 6;
      loopStepThresholdInput.value = value;
      try {
        await chrome.storage.local.set({ guideLoopStepThreshold: value });
        showStatus(value === 1
          ? 'Guide stops on the first looping step'
          : `Guide stops after ${value} looping steps in a row`, 'success');
      } catch (e) {}
    });
  }

  // Personalization toggle persists immediately (no "test" step like the API key flow)
  const personalizationToggle = document.getElementById('personalizationEnabled');
  if (personalizationToggle) {
    personalizationToggle.addEventListener('change', async () => {
      try {
        await chrome.storage.sync.set({ personalizationEnabled: personalizationToggle.checked });
        showStatus(personalizationToggle.checked ? 'Personalization enabled' : 'Personalization disabled', 'success');
      } catch (e) {}
    });
  }

  const clearProfileBtn = document.getElementById('clearProfileBtn');
  if (clearProfileBtn) {
    clearProfileBtn.addEventListener('click', async () => {
      const resetProfile = { summary: '', updatedAt: 0, version: 0 };
      try {
        await chrome.storage.sync.set({ personalizedProfile: resetProfile });
        renderPersonalizedProfile(resetProfile);
        showStatus('Learned profile cleared', 'success');
      } catch (e) {}
    });
  }

  // The text-only warning follows either control that can create the mismatch.
  const openrouterModelSelect = document.getElementById('openrouterModel');
  const visionToggle = document.getElementById('visionEnabled');
  if (openrouterModelSelect) openrouterModelSelect.addEventListener('change', refreshOpenrouterVisionWarning);
  if (visionToggle) visionToggle.addEventListener('change', refreshOpenrouterVisionWarning);

  // Debug code entry event listener
  const debugCodeInput = document.getElementById('debugCode');
  const debugToggleGroup = document.getElementById('debugToggleGroup');
  const debugEnabledToggle = document.getElementById('debugEnabled');
  const debugSteerContextToggle = document.getElementById('debugSteerContextEnabled');
  if (debugCodeInput && debugToggleGroup && debugEnabledToggle) {
    debugCodeInput.addEventListener('input', () => {
      if (debugCodeInput.value.trim() === 'PAGEGUIDE2026') {
        debugToggleGroup.style.display = 'block';
      } else {
        debugToggleGroup.style.display = 'none';
        debugEnabledToggle.checked = false;
        if (debugSteerContextToggle) debugSteerContextToggle.checked = false;
      }
    });
  }
});
