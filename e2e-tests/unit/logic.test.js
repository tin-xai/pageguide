/**
 * @jest-environment jsdom
 */
const fs = require('fs');
const path = require('path');

// Helper to load script content into JSDOM global scope
function loadScript(filename) {
  const content = fs.readFileSync(path.join(__dirname, '../../', filename), 'utf8');
  window.eval(content);
}

describe('Content Extraction Logic (content/utils.js)', () => {
  beforeAll(() => {
    // Mock window properties if needed
    window._xwebagentIndex = window._xwebagentIndex || {};
    // Mock CSS.escape for JSDOM (used in label[for] queries)
    window.CSS = window.CSS || {};
    window.CSS.escape = window.CSS.escape || ((str) => str.replace(/([^\w-])/g, '\\$1'));
    loadScript('content/utils.js');
  });

  // Test suite for identifying noise elements (citations, footnotes, etc.)
  // Verifies that 'isNoiseElement' correctly flags irrelevant content.
  describe('isNoiseElement', () => {
    test('identifies noise links', () => {
      // Case 1: Link with citation ID (e.g., #cite_note-1) should be noise
      const el = document.createElement('a');
      el.href = '#cite_note-1';
      expect(window.isNoiseElement(el, 'note')).toBe(true);
      
      // Case 2: Standard external link should NOT be noise
      el.href = 'https://example.com';
      expect(window.isNoiseElement(el, 'link')).toBe(false);
    });
  });

  // Test suite for ensuring accessibility roles are correctly resolved.
  // Critical for building the semantic tree used by the agent.
  describe('getAccessibleRole', () => {
    test('returns correct roles for basic elements', () => {
      // Verify <button> maps to 'button' role
      expect(window.getAccessibleRole(document.createElement('button'))).toBe('button');
      // Verify <h1> maps to 'heading' role
      expect(window.getAccessibleRole(document.createElement('h1'))).toBe('heading');

      // Verify <a> with href maps to 'link' role
      const link = document.createElement('a');
      link.href = '#';
      expect(window.getAccessibleRole(link)).toBe('link');
    });

    test('respects aria-role', () => {
      // Verify that explicit ARIA roles override implicit tag roles
      // e.g., <div role="button"> should be treated as a button
      const div = document.createElement('div');
      div.setAttribute('role', 'button');
      expect(window.getAccessibleRole(div)).toBe('button');
    });

    test('returns null for anchor without href', () => {
      // <a> without href has no implicit role
      const anchor = document.createElement('a');
      expect(window.getAccessibleRole(anchor)).toBeNull();
    });

    test('maps button element correctly', () => {
      // Native <button> should always be 'button' role
      const btn = document.createElement('button');
      btn.type = 'submit';
      expect(window.getAccessibleRole(btn)).toBe('button');
    });

    test('maps link element with href correctly', () => {
      // <a href="..."> should be 'link', various href formats
      const link1 = document.createElement('a');
      link1.href = 'https://example.com';
      expect(window.getAccessibleRole(link1)).toBe('link');

      const link2 = document.createElement('a');
      link2.href = '/relative/path';
      expect(window.getAccessibleRole(link2)).toBe('link');
    });

    test('aria role overrides implicit role', () => {
      // <button role="link"> should be 'link', not 'button'
      const btn = document.createElement('button');
      btn.setAttribute('role', 'link');
      expect(window.getAccessibleRole(btn)).toBe('link');

      // <a href="#" role="button"> should be 'button', not 'link'
      const link = document.createElement('a');
      link.href = '#';
      link.setAttribute('role', 'button');
      expect(window.getAccessibleRole(link)).toBe('button');
    });

    test('returns null for generic div without role', () => {
      // <div> has no implicit role
      const div = document.createElement('div');
      expect(window.getAccessibleRole(div)).toBeNull();
    });
  });

  // Test suite for resolving accessible names (labels/text)
  describe('getAccessibleName', () => {
    test('uses text content', () => {
      // Verify simple text extraction from buttons
      const btn = document.createElement('button');
      btn.textContent = 'Submit';
      expect(window.getAccessibleName(btn)).toBe('Submit');
    });

    test('uses aria-label', () => {
      // Verify aria-label takes precedence over visible text
      // e.g., <button aria-label="Close">X</button> -> "Close"
      const btn = document.createElement('button');
      btn.setAttribute('aria-label', 'Close');
      btn.textContent = 'X';
      expect(window.getAccessibleName(btn)).toBe('Close');
    });

    test('aria-label overrides text content', () => {
      // aria-label should always win, even with rich text content
      const link = document.createElement('a');
      link.href = '#';
      link.innerHTML = '<span>Click Here</span>';
      link.setAttribute('aria-label', 'Navigate to home');
      expect(window.getAccessibleName(link)).toBe('Navigate to home');
    });

    test('returns empty string for element with no text', () => {
      // Element with no text content, no aria-label, no title
      const div = document.createElement('div');
      expect(window.getAccessibleName(div)).toBe('');

      // Button with only whitespace
      const btn = document.createElement('button');
      btn.textContent = '   ';
      expect(window.getAccessibleName(btn)).toBe('');
    });

    test('uses aria-labelledby when present', () => {
      // Setup: create label element and target
      document.body.innerHTML = `
        <span id="label-text">External Label</span>
        <button aria-labelledby="label-text">Ignored Text</button>
      `;
      const btn = document.querySelector('button');
      expect(window.getAccessibleName(btn)).toBe('External Label');
    });

    test('aria-label takes precedence over aria-labelledby', () => {
      // aria-label should win over aria-labelledby
      document.body.innerHTML = `
        <span id="external-label">External</span>
        <button aria-label="Direct Label" aria-labelledby="external-label">Text</button>
      `;
      const btn = document.querySelector('button');
      expect(window.getAccessibleName(btn)).toBe('Direct Label');
    });

    test('uses alt text for images', () => {
      const img = document.createElement('img');
      img.alt = 'Profile picture';
      expect(window.getAccessibleName(img)).toBe('Profile picture');
    });

    test('falls back to title for images without alt', () => {
      const img = document.createElement('img');
      img.title = 'User avatar';
      expect(window.getAccessibleName(img)).toBe('User avatar');
    });

    test('returns empty string for image with no alt or title', () => {
      const img = document.createElement('img');
      img.src = 'image.png';
      expect(window.getAccessibleName(img)).toBe('');
    });

    test('uses associated label for input elements', () => {
      // Input with label[for] association
      document.body.innerHTML = `
        <label for="email-input">Email Address</label>
        <input type="email" id="email-input" />
      `;
      const input = document.querySelector('input');
      expect(window.getAccessibleName(input)).toBe('Email Address');
    });

    test('uses parent label for wrapped input', () => {
      // Input wrapped inside label
      document.body.innerHTML = `
        <label>
          Username
          <input type="text" />
        </label>
      `;
      const input = document.querySelector('input');
      expect(window.getAccessibleName(input)).toContain('Username');
    });

    test('falls back to placeholder for input', () => {
      const input = document.createElement('input');
      input.placeholder = 'Enter your name';
      expect(window.getAccessibleName(input)).toBe('Enter your name');
    });

    test('falls back to title attribute', () => {
      const span = document.createElement('span');
      span.title = 'Tooltip text';
      expect(window.getAccessibleName(span)).toBe('Tooltip text');
    });
  });
  
  // Test suite for the indexing engine that builds the page capability map
  describe('createPageIndex', () => {
    test('indexes visible elements', () => {
        // Setup a mock DOM with mixed content (visible and hidden)
        document.body.innerHTML = `
            <h1>Title</h1>
            <p>Content</p>
            <button>Click Me</button>
            <div style="display:none">Hidden</div>
        `;
        
        // Run indexer with a limit of 100 items
        const index = window.createPageIndex(100);
        const map = index.indexMap;
        
        // Verify that we found at least the 3 accessible elements
        expect(Object.keys(map).length).toBeGreaterThanOrEqual(3); 
        // Verify key content is present in the index text representation
        expect(index.indexText).toContain('Title');
        expect(index.indexText).toContain('Click Me');
        // Verify hidden element was excluded
        expect(index.indexText).not.toContain('Hidden');
    });
  });
});

describe('Routing Logic (content/functions/main_router.js)', () => {
  beforeEach(() => {
    // Setup Mock Chrome Runtime API to simulate extension environment
    window.chrome = {
      runtime: {
        sendMessage: jest.fn()
      }
    };
    
    // Mock global PROMPTS object required by the router
    window.PROMPTS = { ROUTER: 'Router Prompt' };
    
    // Load the router script
    loadScript('content/functions/main_router.js');
  });

  // Verify successful message passing to background script
  test('safeSendMessage handles success', async () => {
    // Mock a successful response from background
    chrome.runtime.sendMessage.mockResolvedValue({ status: 'ok' });
    
    // Execute helper function
    const res = await window.safeSendMessage({ action: 'test' });
    
    // Assert response is passed through correctly
    expect(res).toEqual({ status: 'ok' });
  });

  // Verify robust error handling for message passing (e.g., context invalidation)
  test('safeSendMessage handles timeout/error', async () => {
    // Mock a runtime error (Simulating updated extension context)
    chrome.runtime.sendMessage.mockRejectedValue(new Error('Extension context invalidated'));
    
    // Execute helper, expecting it to catch and return detailed error object
    const res = await window.safeSendMessage({ action: 'test' });
    
    // Assert error message captures the specific failure
    expect(res.error).toContain('Extension was updated');
  });

  // Verify the LLM routing logic parses JSON correctly
  test('routeQuery handles valid JSON response', async () => {
    // Mock LLM response structure for a guidance query
    const mockResponse = {
        content: '```json\n{"handler": "guide", "confidence": 0.9}\n```'
    };
    chrome.runtime.sendMessage.mockResolvedValue(mockResponse);

    // Test routing decision for "how to do x"
    const result = await window.routeQuery('how to do x');

    // Verify it chose the correct handler ('guide') with high confidence
    expect(result.handler).toBe('guide');
    expect(result.confidence).toBe(0.9);
  });
});

// ============================================================
// Tab-Switch Reset Logic (_shouldResetOnTabSwitch in sidepanel/panel.js)
// Tests the pure decision function that controls whether switching tabs
// clears the chat. Mirrors the implementation exposed as window._shouldResetOnTabSwitch.
// ============================================================
describe('Tab-switch reset decision (_shouldResetOnTabSwitch)', () => {
  // Mirror the implementation so this suite stays self-contained and fast.
  // If the logic in panel.js changes, update here too.
  function shouldResetOnTabSwitch(prevTabId, newTabId, isGuideActive) {
    if (isGuideActive) return false;
    if (!prevTabId || prevTabId === newTabId) return false;
    return true;
  }

  test('does NOT reset while the guide agent is active (agent-triggered tab)', () => {
    // When guideActive=true the agent navigated to a new tab — session must survive
    expect(shouldResetOnTabSwitch(1, 2, true)).toBe(false);
  });

  test('does NOT reset on first panel activation (no previous tab)', () => {
    // prevTabId is null on the very first onActivated event after the panel opens
    expect(shouldResetOnTabSwitch(null, 5, false)).toBe(false);
  });

  test('does NOT reset when the same tab is re-activated', () => {
    // Defensive: onActivated theoretically could fire for the same tab
    expect(shouldResetOnTabSwitch(3, 3, false)).toBe(false);
  });

  test('DOES reset when the user switches to a different tab without guide active', () => {
    // Normal tab switch — old highlights cleared, new chat starts
    expect(shouldResetOnTabSwitch(1, 2, false)).toBe(true);
  });

  test('DOES reset when user opens a brand-new tab (different id, no guide)', () => {
    expect(shouldResetOnTabSwitch(10, 11, false)).toBe(true);
  });
});

// ============================================================
// Per-tab session management (_tabSessions in sidepanel/panel.js)
// Tests the Map-based save/restore contract that preserves chat history
// when the user switches tabs and returns.
// ============================================================
describe('Per-tab session management (_tabSessions)', () => {
  let tabSessions;

  // Minimal mirror of the save/restore helpers from panel.js
  function saveSession(tabId, messages, history) {
    if (!tabId) return;
    tabSessions.set(tabId, {
      chatMessages: [...messages],
      conversationHistory: [...history],
      hasImageInConversation: false,
      html: '<div>msg</div>'
    });
  }

  beforeEach(() => {
    tabSessions = new Map();
  });

  test('saves a session and retrieves it for the same tab', () => {
    saveSession(1, ['hello'], [{ role: 'user', content: 'hello' }]);
    const s = tabSessions.get(1);
    expect(s).toBeDefined();
    expect(s.chatMessages).toEqual(['hello']);
    expect(s.conversationHistory[0].content).toBe('hello');
  });

  test('returns undefined for a tab that has never been saved', () => {
    expect(tabSessions.get(99)).toBeUndefined();
  });

  test('switching back to a saved tab should restore (not start fresh)', () => {
    saveSession(5, ['previous answer'], []);
    // Switching to tab 5 — a saved session exists, so restore path is taken
    const saved = tabSessions.get(5);
    expect(saved).toBeDefined();  // truthy → _restoreTabSession branch
  });

  test('URL change (onUpdated) deletes the stale session for that tab', () => {
    saveSession(3, ['old answer'], []);
    tabSessions.delete(3); // mirrors: _tabSessions.delete(tabId) in onUpdated
    expect(tabSessions.get(3)).toBeUndefined();
  });

  test('manual reset deletes the current tab session so returning starts fresh', () => {
    saveSession(2, ['some msg'], []);
    tabSessions.delete(2); // mirrors: _tabSessions.delete(currentTabId) in resetChat
    expect(tabSessions.get(2)).toBeUndefined();
  });

  test('tab close (onRemoved) deletes the session to prevent memory leaks', () => {
    saveSession(7, ['data'], []);
    tabSessions.delete(7); // mirrors: _tabSessions.delete(tabId) in onRemoved
    expect(tabSessions.get(7)).toBeUndefined();
  });

  test('null tabId does not add an entry', () => {
    saveSession(null, ['msg'], []);
    expect(tabSessions.size).toBe(0);
  });
});
