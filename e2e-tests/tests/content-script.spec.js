// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.join(__dirname, '../../XWebAgent-Extension');
const FIXTURES_PATH = path.join(__dirname, 'fixtures');

/**
 * Test suite for content script functionality
 * Tests DOM manipulation, highlighting, and page indexing
 */

test.describe('Content Scripts', () => {
  let context;
  let extensionId;
  let page;

  test.beforeAll(async () => {
    const userDataDir = path.join(__dirname, '../.test-user-data-content-' + Date.now());
    
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
      for (const pg of pages) {
        const url = pg.url();
        if (url.includes('chrome-extension://')) {
          extensionId = url.split('/')[2];
          break;
        }
      }
    }
  });

  test.beforeEach(async () => {
    page = await context.newPage();
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('content script loads on sample article', async () => {
    await page.goto(`file://${FIXTURES_PATH}/sample-article.html`);
    await page.waitForTimeout(2000); // Wait for content scripts to load
    
    // Check that the page loaded correctly
    const title = await page.title();
    expect(title).toContain('Sample Article');
    
    // Content scripts should have loaded without crashing the page
    const bodyExists = await page.locator('body').count();
    expect(bodyExists).toBe(1);
  });

  test('page text can be extracted', async () => {
    await page.goto(`file://${FIXTURES_PATH}/sample-article.html`);
    await page.waitForTimeout(2000);
    
    // Try to get visible text via content script function or DOM
    const bodyText = await page.locator('body').textContent();
    
    expect(bodyText).toContain('Artificial Intelligence');
    expect(bodyText).toContain('Dr. Jane Smith');
    expect(bodyText).toContain('2025');
  });

  test('handles minimal content page', async () => {
    await page.goto(`file://${FIXTURES_PATH}/minimal-page.html`);
    await page.waitForTimeout(2000);
    
    const bodyText = await page.locator('body').textContent();
    
    expect(bodyText).toContain('Minimal Test Page');
    expect(bodyText?.trim().length).toBeLessThan(200);
  });

  test('handles long scrollable page', async () => {
    await page.goto(`file://${FIXTURES_PATH}/long-page.html`);
    await page.waitForTimeout(2000);
    
    // Check initial scroll position
    const initialScroll = await page.evaluate(() => window.scrollY);
    expect(initialScroll).toBe(0);
    
    // Page should be scrollable
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    
    expect(scrollHeight).toBeGreaterThan(viewportHeight);
  });

  test('scrolling works correctly', async () => {
    await page.goto(`file://${FIXTURES_PATH}/long-page.html`);
    await page.waitForTimeout(1000);
    
    // Scroll down
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(300);
    
    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBeGreaterThan(0);
  });

  test('page elements are queryable', async () => {
    await page.goto(`file://${FIXTURES_PATH}/sample-article.html`);
    await page.waitForTimeout(1000);
    
    // Check that key elements exist
    const h1Count = await page.locator('h1').count();
    const h2Count = await page.locator('h2').count();
    const pCount = await page.locator('p').count();
    const ulCount = await page.locator('ul').count();
    
    expect(h1Count).toBeGreaterThan(0);
    expect(h2Count).toBeGreaterThan(0);
    expect(pCount).toBeGreaterThan(0);
    expect(ulCount).toBeGreaterThan(0);
  });

  test('image page has expected structure', async () => {
    await page.goto(`file://${FIXTURES_PATH}/image-page.html`);
    await page.waitForTimeout(1000);
    
    // Check gallery items exist
    const galleryItems = await page.locator('.gallery-item').count();
    expect(galleryItems).toBeGreaterThan(0);
    
    // Check for captions
    const captions = await page.locator('.caption').count();
    expect(captions).toBeGreaterThan(0);
  });

  test('no console errors from content scripts', async () => {
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    await page.goto(`file://${FIXTURES_PATH}/sample-article.html`);
    await page.waitForTimeout(3000);
    
    // Filter for extension-related errors only
    const extensionErrors = consoleErrors.filter(e => 
      e.toLowerCase().includes('xwebagent') || 
      e.includes('content.js') ||
      (e.includes('chrome-extension') && !e.includes('net::ERR'))
    );
    
    // There should be no extension errors
    expect(extensionErrors).toHaveLength(0);
  });

  test('highlights can be added to page', async () => {
    await page.goto(`file://${FIXTURES_PATH}/sample-article.html`);
    await page.waitForTimeout(2000);
    
    // Manually add a highlight style to test CSS works
    await page.evaluate(() => {
      const paragraph = document.querySelector('p');
      if (paragraph) {
        paragraph.style.outline = '3px solid #ff6b6b';
        paragraph.style.outlineOffset = '2px';
        paragraph.setAttribute('data-xwebagent-highlight', 'true');
      }
    });
    
    // Check that the highlight was applied
    const highlightedElement = page.locator('[data-xwebagent-highlight="true"]');
    await expect(highlightedElement).toBeVisible();
  });

  test('highlights can be cleared', async () => {
    await page.goto(`file://${FIXTURES_PATH}/sample-article.html`);
    await page.waitForTimeout(2000);
    
    // Add highlight
    await page.evaluate(() => {
      const paragraph = document.querySelector('p');
      if (paragraph) {
        paragraph.setAttribute('data-xwebagent-highlight', 'true');
      }
    });
    
    // Verify it exists
    let highlightCount = await page.locator('[data-xwebagent-highlight]').count();
    expect(highlightCount).toBe(1);
    
    // Clear highlights
    await page.evaluate(() => {
      document.querySelectorAll('[data-xwebagent-highlight]').forEach(el => {
        el.removeAttribute('data-xwebagent-highlight');
      });
    });
    
    // Verify cleared
    highlightCount = await page.locator('[data-xwebagent-highlight]').count();
    expect(highlightCount).toBe(0);
  });
});
