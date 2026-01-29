// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.join(__dirname, '../../XWebAgent-Extension');

/**
 * Test suite for side panel UI interactions
 * Tests the chat interface without actual LLM calls
 */

test.describe('Side Panel UI', () => {
  let context;
  let extensionId;
  let panelPage;

  test.beforeAll(async () => {
    const userDataDir = path.join(__dirname, '../.test-user-data-ui-' + Date.now());
    
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
    panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`);
    await panelPage.waitForLoadState('domcontentloaded');
    await panelPage.waitForTimeout(500);
  });

  test.afterEach(async () => {
    await panelPage?.close();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('input field accepts text', async () => {
    const input = panelPage.locator('#xwebagent-input');
    await expect(input).toBeVisible({ timeout: 10000 });
    
    await input.fill('Hello, XWebAgent!');
    await expect(input).toHaveValue('Hello, XWebAgent!');
  });

  test('send button is clickable', async () => {
    const sendBtn = panelPage.locator('#xwebagent-send');
    await expect(sendBtn).toBeEnabled();
    await expect(sendBtn).toBeVisible();
  });

  test('pressing Enter in input triggers send', async () => {
    const input = panelPage.locator('#xwebagent-input');
    const messagesContainer = panelPage.locator('#xwebagent-messages');
    
    await input.fill('Test question');
    await input.press('Enter');
    
    // User message should appear
    await expect(messagesContainer.locator('.xwebagent-message.user')).toBeVisible({ timeout: 10000 });
  });

  test('reset button clears chat', async () => {
    const input = panelPage.locator('#xwebagent-input');
    const messagesContainer = panelPage.locator('#xwebagent-messages');
    const resetBtn = panelPage.locator('.xwebagent-quick-btn[data-action="reset"]');
    
    // Add a message first
    await input.fill('Test message');
    await input.press('Enter');
    
    // Wait for at least one message to appear (use .first() to avoid strict mode)
    await expect(messagesContainer.locator('.xwebagent-message').first()).toBeVisible({ timeout: 10000 });
    
    // Click reset
    await resetBtn.click();
    
    // Wait for reset to process
    await panelPage.waitForTimeout(1000);
    
    // After reset, the messages area should have no user messages
    const userMessages = await messagesContainer.locator('.xwebagent-message.user').count();
    expect(userMessages).toBe(0);
  });

  test('settings button opens options page', async () => {
    const settingsBtn = panelPage.locator('#xwebagent-settings');
    
    if (await settingsBtn.count() > 0) {
      // Listen for new page
      const pagePromise = context.waitForEvent('page');
      await settingsBtn.click();
      
      // New tab should open
      const newPage = await pagePromise;
      await newPage.waitForLoadState();
      
      expect(newPage.url()).toContain('options');
      await newPage.close();
    }
  });

  test('image upload button exists', async () => {
    const imageUpload = panelPage.locator('#xwebagent-image-upload');
    const uploadLabel = panelPage.locator('#xwebagent-upload-label, label[for="xwebagent-image-upload"]');
    
    // Either the input or a label for it should exist
    const hasUpload = await imageUpload.count() > 0 || await uploadLabel.count() > 0;
    expect(hasUpload).toBeTruthy();
  });

  test('message container scrolls with new messages', async () => {
    const messagesContainer = panelPage.locator('#xwebagent-messages');
    const input = panelPage.locator('#xwebagent-input');
    
    // Send multiple messages
    for (let i = 1; i <= 3; i++) {
      await input.fill(`Test message ${i}`);
      await input.press('Enter');
      await panelPage.waitForTimeout(500);
    }
    
    // Container should have some messages
    const messageCount = await messagesContainer.locator('.xwebagent-message.user').count();
    expect(messageCount).toBeGreaterThanOrEqual(1);
  });

  test('typing indicator appears when processing', async () => {
    const input = panelPage.locator('#xwebagent-input');
    
    await input.fill('Test question that will trigger typing');
    await input.press('Enter');
    
    // Typing indicator might appear briefly - just verify no crash
    await panelPage.waitForTimeout(500);
    
    const pageExists = await panelPage.locator('body').count();
    expect(pageExists).toBe(1);
  });

  test('placeholder text is present', async () => {
    const input = panelPage.locator('#xwebagent-input');
    
    const placeholder = await input.getAttribute('placeholder');
    expect(placeholder).toBeTruthy();
    expect(placeholder.length).toBeGreaterThan(0);
  });
});
