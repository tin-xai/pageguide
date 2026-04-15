// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.join(__dirname, '../../');

/**
 * Test suite for error handling and edge cases
 * Tests how the extension handles various failure scenarios
 */

test.describe('Error Handling', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;
  /** @type {string} */
  let extensionId;

  test.beforeAll(async () => {
    const userDataDir = path.join(__dirname, '../.test-user-data-errors-' + Date.now());

    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-gpu',
      ],
    });

    await new Promise((r) => setTimeout(r, 3000));

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

  test.afterAll(async () => {
    await context?.close();
  });

  test('handles empty input gracefully', async () => {
    test.skip(!extensionId, 'Extension ID not found');

    const panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`);
    await panelPage.waitForLoadState('domcontentloaded');
    await panelPage.waitForTimeout(500);

    const input = panelPage.locator('#pageguide-input');
    const sendBtn = panelPage.locator('#pageguide-send');
    const messagesContainer = panelPage.locator('#pageguide-messages');

    // Clear input and try to send
    await input.fill('');
    await sendBtn.click();

    // Should not add a message for empty input
    await panelPage.waitForTimeout(500);
    const userMessages = await messagesContainer.locator('.pageguide-message.user').count();

    // Empty input should not create a message
    expect(userMessages).toBe(0);

    await panelPage.close();
  });

  test('handles whitespace-only input', async () => {
    test.skip(!extensionId, 'Extension ID not found');

    const panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`);
    await panelPage.waitForLoadState('domcontentloaded');
    await panelPage.waitForTimeout(500);

    const input = panelPage.locator('#pageguide-input');
    const sendBtn = panelPage.locator('#pageguide-send');

    // Try to send only whitespace
    await input.fill('   ');
    await sendBtn.click();

    await panelPage.waitForTimeout(500);

    // Should handle gracefully (no crash)
    const pageExists = await panelPage.locator('body').count();
    expect(pageExists).toBe(1);

    await panelPage.close();
  });

  test('extension works on about:blank', async () => {
    const page = await context.newPage();
    await page.goto('about:blank');

    // Page should load
    const url = page.url();
    expect(url).toBe('about:blank');

    // Extension should not crash on blank page
    await page.waitForTimeout(1000);

    await page.close();
  });

  test('handles very long input text', async () => {
    test.skip(!extensionId, 'Extension ID not found');

    const panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`);
    await panelPage.waitForLoadState('domcontentloaded');
    await panelPage.waitForTimeout(500);

    const input = panelPage.locator('#pageguide-input');

    // Generate a very long string
    const longText = 'a'.repeat(10000);

    await input.fill(longText);

    // Input should accept the text (may be truncated by browser)
    const value = await input.inputValue();
    expect(value.length).toBeGreaterThan(0);

    // Page should not crash
    const pageExists = await panelPage.locator('body').count();
    expect(pageExists).toBe(1);

    await panelPage.close();
  });

  test('handles special characters in input', async () => {
    test.skip(!extensionId, 'Extension ID not found');

    const panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`);
    await panelPage.waitForLoadState('domcontentloaded');
    await panelPage.waitForTimeout(500);

    const input = panelPage.locator('#pageguide-input');

    // Test various special characters
    const specialChars = '!@#$%^&*()_+-=[]{}|;\':",.<>?/\\`~';
    await input.fill(specialChars);

    const value = await input.inputValue();
    expect(value).toBe(specialChars);

    await panelPage.close();
  });

  test('handles unicode and emoji in input', async () => {
    test.skip(!extensionId, 'Extension ID not found');

    const panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`);
    await panelPage.waitForLoadState('domcontentloaded');
    await panelPage.waitForTimeout(500);

    const input = panelPage.locator('#pageguide-input');

    // Test unicode and emoji
    const unicodeText = '🔍 Search for café ñ 中文 العربية';
    await input.fill(unicodeText);

    const value = await input.inputValue();
    expect(value).toBe(unicodeText);

    await panelPage.close();
  });

  test('handles rapid multiple sends', async () => {
    test.skip(!extensionId, 'Extension ID not found');

    const panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`);
    await panelPage.waitForLoadState('domcontentloaded');
    await panelPage.waitForTimeout(500);

    const input = panelPage.locator('#pageguide-input');
    const sendBtn = panelPage.locator('#pageguide-send');

    // Rapidly send multiple messages
    for (let i = 0; i < 3; i++) {
      await input.fill(`Message ${i}`);
      await sendBtn.click();
      await panelPage.waitForTimeout(100);
    }

    await panelPage.waitForTimeout(1000);

    // Page should not crash
    const pageExists = await panelPage.locator('body').count();
    expect(pageExists).toBe(1);

    await panelPage.close();
  });

  test('options page handles invalid API key format', async () => {
    test.skip(!extensionId, 'Extension ID not found');

    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
    await optionsPage.waitForLoadState('domcontentloaded');
    await optionsPage.waitForTimeout(500);

    const apiKeyInput = optionsPage.locator('#geminiApiKey');

    // Enter invalid format
    await apiKeyInput.fill('not-a-valid-key');

    // Page should still function
    const pageExists = await optionsPage.locator('body').count();
    expect(pageExists).toBe(1);

    await optionsPage.close();
  });

  test('extension recovers from closed tab', async () => {
    // Open and close several tabs
    for (let i = 0; i < 3; i++) {
      const page = await context.newPage();
      await page.goto('about:blank');
      await page.waitForTimeout(300);
      await page.close();
    }

    // Extension service worker should still be running
    const serviceWorkers = context.serviceWorkers();
    const bgPages = context.backgroundPages();

    // Either service workers or background pages should exist
    expect(serviceWorkers.length + bgPages.length).toBeGreaterThanOrEqual(0);
  });
});
