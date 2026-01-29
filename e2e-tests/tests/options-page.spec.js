// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.join(__dirname, '../../XWebAgent-Extension');

/**
 * Test suite for options/settings page
 * Tests configuration and settings persistence
 */

test.describe('Options Page', () => {
  let context;
  let extensionId;
  let optionsPage;

  test.beforeAll(async () => {
    const userDataDir = path.join(__dirname, '../.test-user-data-opts-' + Date.now());
    
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-gpu',
      ],
    });
    
    await new Promise(r => setTimeout(r, 3000));
    
    // Get extension ID
    let serviceWorkers = context.serviceWorkers();
    for (const worker of serviceWorkers) {
      const url = worker.url();
      if (url.includes('chrome-extension://')) {
        extensionId = url.split('/')[2];
        break;
      }
    }
    
    if (!extensionId) {
      const pages = context.backgroundPages();
      for (const page of pages) {
        const url = page.url();
        if (url.includes('chrome-extension://')) {
          extensionId = url.split('/')[2];
          break;
        }
      }
    }
  });

  test.beforeEach(async () => {
    test.skip(!extensionId, 'Extension ID not found');
    optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
    await optionsPage.waitForLoadState('domcontentloaded');
    await optionsPage.waitForTimeout(500);
  });

  test.afterEach(async () => {
    if (optionsPage) {
      try {
        // Try to close with short timeout to avoid hanging
        await Promise.race([
          optionsPage.close(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 5000))
        ]);
      } catch (e) {
        // If close fails, just continue - the browser context cleanup will handle it
        console.log('Page close timed out, continuing...');
      }
    }
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('API key input field exists and is editable', async () => {
    // Options page has provider-specific API keys (gemini is default active)
    const apiKeyInput = optionsPage.locator('#geminiApiKey');
    
    await expect(apiKeyInput).toBeVisible({ timeout: 10000 });
    await expect(apiKeyInput).toBeEditable();
    
    // Should be password type for security
    const inputType = await apiKeyInput.getAttribute('type');
    expect(inputType).toBe('password');
  });

  test('can enter and mask API key', async () => {
    const apiKeyInput = optionsPage.locator('#geminiApiKey');
    
    await apiKeyInput.fill('test-api-key-12345');
    
    // Value should be set but displayed as dots (password field)
    await expect(apiKeyInput).toHaveValue('test-api-key-12345');
  });

  test('model selection dropdown exists', async () => {
    // Gemini model selector (default provider)
    const modelSelect = optionsPage.locator('#geminiModel');
    
    await expect(modelSelect).toBeVisible({ timeout: 10000 });
    
    // Should have options
    const optionCount = await modelSelect.locator('option').count();
    expect(optionCount).toBeGreaterThan(0);
  });

  test('model dropdown has expected options', async () => {
    const modelSelect = optionsPage.locator('#geminiModel');
    const options = await modelSelect.locator('option').allTextContents();
    
    // Should include Gemini models
    expect(options.length).toBeGreaterThan(0);
    
    // Check for expected Gemini model options
    const optionsText = options.join(' ').toLowerCase();
    expect(optionsText).toContain('gemini');
  });

  test('save button exists', async () => {
    const saveBtn = optionsPage.locator('#saveBtn');
    
    await expect(saveBtn).toBeVisible();
    const buttonText = await saveBtn.textContent();
    expect(buttonText?.toLowerCase()).toContain('save');
  });

  test('settings form has proper structure', async () => {
    // Check for section containers
    const sections = await optionsPage.locator('.section').count();
    expect(sections).toBeGreaterThan(0);
    
    // Check for labels
    const labels = await optionsPage.locator('label').count();
    expect(labels).toBeGreaterThan(0);
    
    // Check for form elements
    const inputs = await optionsPage.locator('input').count();
    expect(inputs).toBeGreaterThan(0);
  });

  test('provider tabs exist and are clickable', async () => {
    const providerTabs = optionsPage.locator('.provider-tab');
    const tabCount = await providerTabs.count();
    
    expect(tabCount).toBeGreaterThanOrEqual(2); // At least Gemini and one other
    
    // Click on OpenRouter tab
    const openrouterTab = optionsPage.locator('.provider-tab[data-provider="openrouter"]');
    if (await openrouterTab.count() > 0) {
      await openrouterTab.click();
      
      // OpenRouter config should become visible
      const openrouterConfig = optionsPage.locator('#config-openrouter');
      await expect(openrouterConfig).toHaveClass(/active/);
    }
  });

  test('page does not have JavaScript errors', async () => {
    const errors = [];
    const errorHandler = error => errors.push(error.message);
    optionsPage.on('pageerror', errorHandler);
    
    // Interact with page to trigger any potential errors
    const apiKey = optionsPage.locator('#geminiApiKey');
    const model = optionsPage.locator('#geminiModel');
    
    await apiKey.fill('test-api-key');
    await optionsPage.waitForTimeout(300);
    
    await model.click();
    await optionsPage.waitForTimeout(300);
    
    // Remove the listener before test ends to prevent cleanup issues
    optionsPage.off('pageerror', errorHandler);
    
    // Filter for actual errors (not warnings or network errors from external images)
    const realErrors = errors.filter(e => 
      !e.includes('warning') && 
      !e.includes('net::') &&
      !e.includes('Failed to load resource') &&
      !e.includes('favicon')
    );
    expect(realErrors).toHaveLength(0);
  });

  test('vision toggle exists', async () => {
    // The checkbox input is hidden, but the toggle switch container is visible
    const visionToggle = optionsPage.locator('#visionEnabled');
    // Check it exists in DOM (even if visually hidden due to CSS toggle styling)
    await expect(visionToggle).toBeAttached();
    
    // Also verify the toggle label/wrapper is visible
    const toggleSwitch = optionsPage.locator('#visionEnabled').locator('..'); // parent
    await expect(toggleSwitch).toBeVisible();
  });

  test('SoM toggle exists', async () => {
    // The checkbox input is hidden, but the toggle switch container is visible
    const somToggle = optionsPage.locator('#somEnabled');
    // Check it exists in DOM (even if visually hidden due to CSS toggle styling)
    await expect(somToggle).toBeAttached();
    
    // Also verify the toggle label/wrapper is visible
    const toggleSwitch = optionsPage.locator('#somEnabled').locator('..'); // parent
    await expect(toggleSwitch).toBeVisible();
  });

  test('test connection button exists', async () => {
    const testBtn = optionsPage.locator('#testApiBtn');
    await expect(testBtn).toBeVisible();
    
    const buttonText = await testBtn.textContent();
    expect(buttonText?.toLowerCase()).toContain('test');
  });
});
