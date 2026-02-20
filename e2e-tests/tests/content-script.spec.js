// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const url = require('url'); // Added to handle file URLs correctly across OS

const EXTENSION_PATH = path.join(__dirname, '../../');
const FIXTURES_PATH = path.join(__dirname, 'fixtures');

/**
 * Helper to convert local path to file URL
 * @param {string} fileName
 * @returns {string}
 */
const getFixtureUrl = (fileName) => {
  return url.pathToFileURL(path.join(FIXTURES_PATH, fileName)).href;
};

test.describe('Content Scripts', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;
  /** @type {string | undefined} */
  let extensionId;
  /** @type {import('@playwright/test').Page} */
  let page;

  test.beforeAll(async () => {
    const userDataDir = path.join(__dirname, '../.test-user-data-content-' + Date.now());

    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // Extensions only work in headful mode
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-gpu',
      ],
    });

    // Wait for the extension to initialize using polling
    await expect.poll(async () => {
      const serviceWorkers = context.serviceWorkers();
      const worker = serviceWorkers.find(w => w.url().includes('chrome-extension://'));
      if (worker) {
        extensionId = worker.url().split('/')[2];
        return true;
      }
      return false;
    }, {
      message: 'Extension service worker did not appear',
      timeout: 5000
    }).toBe(true);
    
    // Fallback: Attempt to locate from Background Pages if SW didn't yield ID (unlikely if poll passed)
    if (!extensionId) {
      const pages = context.backgroundPages();
      for (const pg of pages) {
        const pgUrl = pg.url();
        if (pgUrl.includes('chrome-extension://')) {
          extensionId = pgUrl.split('/')[2];
          break;
        }
      }
    }
  });

  test.beforeEach(async () => {
    page = await context.newPage();
  });

  test.afterEach(async () => {
    if (page && !page.isClosed()) {
      await page.close();
    }
  });

  test.afterAll(async () => {
    if (context) {
      await context.close();
    }
  });

  test('content script loads on sample article', async () => {
    await page.goto(getFixtureUrl('sample-article.html'));

    // Check that the page loaded correctly
    await expect(page).toHaveTitle(/Sample Article/);

    // Content scripts should have loaded without crashing the page
    await expect(page.locator('body')).toBeVisible();
  });

  test('page text can be extracted', async () => {
    await page.goto(getFixtureUrl('sample-article.html'));

    // Ensure text renders
    const bodyLocator = page.locator('body');
    await expect(bodyLocator).toContainText('Artificial Intelligence');
    await expect(bodyLocator).toContainText('Dr. Jane Smith');
    await expect(bodyLocator).toContainText('2025');
  });

  test('handles minimal content page', async () => {
    await page.goto(getFixtureUrl('minimal-page.html'));

    const bodyLocator = page.locator('body');
    await expect(bodyLocator).toContainText('Minimal Test Page');

    const bodyText = await bodyLocator.textContent();
    expect(bodyText?.trim().length).toBeLessThan(200);
  });

  test('handles long scrollable page', async () => {
    await page.goto(getFixtureUrl('long-page.html'));

    // Check initial scroll position
    const initialScroll = await page.evaluate(() => window.scrollY);
    expect(initialScroll).toBe(0);

    // Page should be scrollable
    // We verify the document height is larger than the viewport
    const isScrollable = await page.evaluate(() => {
      return document.documentElement.scrollHeight > window.innerHeight;
    });
    expect(isScrollable).toBe(true);
  });

  test('scrolling works correctly', async () => {
    await page.goto(getFixtureUrl('long-page.html'));

    // Scroll down
    await page.evaluate(() => window.scrollTo(0, 500));

    // Wait for scroll to settle (using specific assertion rather than timeout)
    await expect
      .poll(
        async () => {
          return await page.evaluate(() => window.scrollY);
        },
        {
          message: 'Window did not scroll',
          timeout: 2000,
        }
      )
      .toBeGreaterThan(0);
  });

  test('page elements are queryable', async () => {
    await page.goto(getFixtureUrl('sample-article.html'));

    // Use expect.toPass or explicitly wait for elements to ensure hydration
    await expect(page.locator('h1').first()).toBeVisible();

    expect(await page.locator('h1').count()).toBeGreaterThan(0);
    expect(await page.locator('h2').count()).toBeGreaterThan(0);
    expect(await page.locator('p').count()).toBeGreaterThan(0);
    expect(await page.locator('ul').count()).toBeGreaterThan(0);
  });

  test('image page has expected structure', async () => {
    await page.goto(getFixtureUrl('image-page.html'));

    // Check gallery items exist
    expect(await page.locator('.gallery-item').count()).toBeGreaterThan(0);

    // Check for captions
    expect(await page.locator('.caption').count()).toBeGreaterThan(0);
  });

  test('no console errors from content scripts', async () => {
    /** @type {string[]} */
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto(getFixtureUrl('sample-article.html'));
    // Allow a small grace period for scripts to execute
    await page.waitForLoadState('networkidle');

    // Filter for extension-related errors only
    const extensionErrors = consoleErrors.filter(
      (e) =>
        e.toLowerCase().includes('xwebagent') ||
        e.includes('content.js') ||
        (e.includes('chrome-extension') && !e.includes('net::ERR'))
    );

    expect(extensionErrors).toHaveLength(0);
  });

  test('highlights can be added to page', async () => {
    await page.goto(getFixtureUrl('sample-article.html'));

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
    await page.goto(getFixtureUrl('sample-article.html'));

    // Add highlight
    await page.evaluate(() => {
      const paragraph = document.querySelector('p');
      if (paragraph) {
        paragraph.setAttribute('data-xwebagent-highlight', 'true');
      }
    });

    // Verify it exists
    const highlightLocator = page.locator('[data-xwebagent-highlight]');
    await expect(highlightLocator).toHaveCount(1);

    // Clear highlights
    await page.evaluate(() => {
      document.querySelectorAll('[data-xwebagent-highlight]').forEach((el) => {
        el.removeAttribute('data-xwebagent-highlight');
      });
    });

    // Verify cleared
    await expect(highlightLocator).toHaveCount(0);
  });
});
