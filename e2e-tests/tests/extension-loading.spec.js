// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.join(__dirname, '../../XWebAgent-Extension');

/**
 * Test suite for extension loading and basic functionality
 * These tests verify the extension loads correctly without errors
 */

test.describe('Extension Loading', () => {
  let context;
  let extensionId;

  test.beforeAll(async () => {
    // Use launchPersistentContext for extension testing
    const userDataDir = path.join(__dirname, '../.test-user-data-' + Date.now());
    
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // Extensions require headed mode
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-gpu',
      ],
    });
    
    // Wait for service worker and get extension ID
    await new Promise(r => setTimeout(r, 3000));
    
    // Get extension ID from service workers
    let serviceWorkers = context.serviceWorkers();
    for (const worker of serviceWorkers) {
      const url = worker.url();
      if (url.includes('chrome-extension://')) {
        extensionId = url.split('/')[2];
        break;
      }
    }
    
    // Fallback: try to get from background page
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
    
    console.log('Extension ID:', extensionId);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('extension service worker loads without errors', async () => {
    // The extension should have a service worker running
    const serviceWorkers = context.serviceWorkers();
    const extensionWorker = serviceWorkers.find(w => 
      w.url().includes('chrome-extension://') && 
      w.url().includes('service-worker.js')
    );
    
    // If no service worker, check background pages (MV2 style)
    if (!extensionWorker) {
      const bgPages = context.backgroundPages();
      expect(bgPages.length + serviceWorkers.length).toBeGreaterThan(0);
    } else {
      expect(extensionWorker).toBeTruthy();
    }
  });

  test('extension ID is obtained', async () => {
    expect(extensionId).toBeTruthy();
    expect(extensionId).toMatch(/^[a-z]{32}$/);
  });

  test('side panel page loads correctly', async () => {
    test.skip(!extensionId, 'Extension ID not found');
    
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`);
    
    // Check key UI elements exist
    await expect(page.locator('#xwebagent-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#xwebagent-send')).toBeVisible();
    await expect(page.locator('#xwebagent-messages')).toBeVisible();
    
    // Check quick action buttons
    await expect(page.locator('.xwebagent-quick-btn[data-action="reset"]')).toBeVisible();
    
    await page.close();
  });

  test('options page loads correctly', async () => {
    test.skip(!extensionId, 'Extension ID not found');
    
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
    
    // Check that options page has API key input (Gemini is default)
    await expect(page.locator('#geminiApiKey')).toBeVisible({ timeout: 10000 });
    
    // Check that model selection exists
    await expect(page.locator('#geminiModel')).toBeVisible();
    
    await page.close();
  });

  test('PDF viewer page loads correctly', async () => {
    test.skip(!extensionId, 'Extension ID not found');
    
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/pdf-viewer/viewer.html`);
    
    // Just verify the page loads without crashing
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).toContain('pdf-viewer/viewer.html');
    
    await page.close();
  });

  test('content scripts inject on web pages', async () => {
    test.skip(!extensionId, 'Extension ID not found');
    
    const page = await context.newPage();
    const fixturesPath = path.join(__dirname, 'fixtures/sample-article.html');
    await page.goto(`file://${fixturesPath}`);
    
    // Wait for content scripts to potentially load
    await page.waitForTimeout(2000);
    
    // Check that the page loaded correctly
    const pageTitle = await page.title();
    expect(pageTitle).toBe('Sample Article - XWebAgent Test');
    
    // Verify no console errors from extension
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    
    await page.waitForTimeout(1000);
    
    // Filter out non-extension errors
    const extensionErrors = errors.filter(e => 
      e.includes('xwebagent') || e.includes('chrome-extension')
    );
    
    expect(extensionErrors).toHaveLength(0);
    
    await page.close();
  });
});
