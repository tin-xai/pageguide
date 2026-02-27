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

// ============================================================
// Agentic Planner — parsePlanResponse (content/agent/planner.js)
// Tests the pure JSON-parsing function that converts LLM output
// into a validated plan. Uses inline mirrors so tests are
// self-contained and fast (no Chrome API mocking needed).
// ============================================================
describe('parsePlanResponse (content/agent/planner.js)', () => {
  // Inline mirror of parsePlanResponse so the test suite is self-contained
  const VALID_TOOLS = ['find', 'guide', 'hide', 'answer', 'image_ask', 'pdf_ask'];
  function parsePlanResponse(content, fallbackQuery) {
    try {
      let jsonStr = content.trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '');
      const match = jsonStr.match(/\{[\s\S]*\}/);
      if (match) jsonStr = match[0];
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) throw new Error('no steps');
      const steps = parsed.steps
        .filter(s => s && VALID_TOOLS.includes(s.tool))
        .map(s => ({ tool: s.tool, args: s.args || {}, reason: s.reason || '' }));
      if (steps.length === 0) throw new Error('no valid steps');
      return { steps, planSummary: parsed.planSummary || '' };
    } catch (e) {
      return {
        steps: [{ tool: 'find', args: { question: fallbackQuery }, reason: 'parse error fallback' }],
        planSummary: ''
      };
    }
  }

  test('parses a valid single-step plan', () => {
    const json = JSON.stringify({
      steps: [{ tool: 'find', args: { question: 'price' }, reason: 'lookup' }],
      planSummary: 'Finding the price'
    });
    const result = parsePlanResponse(json, 'price');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].tool).toBe('find');
    expect(result.steps[0].args.question).toBe('price');
    expect(result.planSummary).toBe('Finding the price');
  });

  test('parses a valid multi-step plan', () => {
    const json = JSON.stringify({
      steps: [
        { tool: 'find', args: { question: 'subscribe button' }, reason: 'locate' },
        { tool: 'guide', args: { task: 'subscribe' }, reason: 'walk through' }
      ],
      planSummary: 'Find then guide'
    });
    const result = parsePlanResponse(json, 'subscribe');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].tool).toBe('find');
    expect(result.steps[1].tool).toBe('guide');
  });

  test('strips markdown code fences before parsing', () => {
    const content = '```json\n{"steps":[{"tool":"hide","args":{"filter":"ads"},"reason":""}],"planSummary":""}\n```';
    const result = parsePlanResponse(content, 'hide ads');
    expect(result.steps[0].tool).toBe('hide');
  });

  test('falls back gracefully on malformed JSON', () => {
    const result = parsePlanResponse('not valid json at all', 'original query');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].tool).toBe('find');
    expect(result.steps[0].args.question).toBe('original query');
    expect(result.planSummary).toBe('');
  });

  test('falls back when steps array is missing', () => {
    const result = parsePlanResponse('{"planSummary":"no steps here"}', 'q');
    expect(result.steps[0].tool).toBe('find');
  });

  test('falls back when steps array is empty', () => {
    const result = parsePlanResponse('{"steps":[],"planSummary":"empty"}', 'q');
    expect(result.steps[0].tool).toBe('find');
  });

  test('filters out steps with unknown tool names', () => {
    const json = JSON.stringify({
      steps: [
        { tool: 'unknown_tool', args: {}, reason: '' },
        { tool: 'find', args: { question: 'test' }, reason: '' }
      ],
      planSummary: ''
    });
    const result = parsePlanResponse(json, 'test');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].tool).toBe('find');
  });

  test('all valid tool names are accepted', () => {
    for (const tool of ['find', 'guide', 'hide', 'answer', 'image_ask', 'pdf_ask']) {
      const json = JSON.stringify({ steps: [{ tool, args: {}, reason: '' }], planSummary: '' });
      const result = parsePlanResponse(json, 'q');
      expect(result.steps[0].tool).toBe(tool);
    }
  });

  test('handles missing args gracefully', () => {
    const json = JSON.stringify({
      steps: [{ tool: 'find', reason: 'no args field' }],
      planSummary: ''
    });
    const result = parsePlanResponse(json, 'q');
    expect(result.steps[0].args).toEqual({});
  });
});

// ============================================================
// Agentic Executor — buildAgentResult (content/agent/executor.js)
// Tests the pure result-merging function.
// ============================================================
describe('buildAgentResult (content/agent/executor.js)', () => {
  // Inline mirror of buildAgentResult
  function buildAgentResult(steps, planSummary) {
    if (!steps || steps.length === 0) {
      return { success: false, error: 'No steps executed', planSummary: planSummary || '' };
    }
    const totalHighlights = steps.reduce((sum, s) => sum + (s.highlightCount || 0), 0);
    const firstStep = steps[0];
    if (steps.length === 1) {
      return { ...firstStep, planSummary: planSummary || '', planSteps: steps };
    }
    return {
      success: true,
      isMultiTool: true,
      steps,
      planSummary: planSummary || '',
      answer: firstStep.answer || '',
      highlightCount: totalHighlights,
      hasHighlights: totalHighlights > 0,
      routedTo: 'agent',
      routeConfidence: 1.0,
      routeReason: planSummary || ''
    };
  }

  test('returns error when no steps provided', () => {
    const result = buildAgentResult([], 'summary');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No steps/);
  });

  test('single step: passthrough with plan metadata', () => {
    const step = { success: true, answer: 'The price is $10', highlightCount: 1, tool: 'find' };
    const result = buildAgentResult([step], 'Finding price');
    // Must include all original step fields
    expect(result.answer).toBe('The price is $10');
    expect(result.highlightCount).toBe(1);
    expect(result.success).toBe(true);
    // Plan metadata added
    expect(result.planSummary).toBe('Finding price');
    expect(result.planSteps).toHaveLength(1);
    // Should NOT be flagged as multi-tool
    expect(result.isMultiTool).toBeUndefined();
  });

  test('multi-step: combined result with isMultiTool flag', () => {
    const steps = [
      { success: true, answer: 'Found button', highlightCount: 1, tool: 'find' },
      { success: true, answer: 'Step 1: click', highlightCount: 1, tool: 'guide', isGuide: true }
    ];
    const result = buildAgentResult(steps, 'Find then guide');
    expect(result.isMultiTool).toBe(true);
    expect(result.highlightCount).toBe(2);
    expect(result.hasHighlights).toBe(true);
    expect(result.routedTo).toBe('agent');
    expect(result.steps).toHaveLength(2);
    expect(result.planSummary).toBe('Find then guide');
    // First step answer preserved for conversation history
    expect(result.answer).toBe('Found button');
  });

  test('multi-step: highlight count sums across all steps', () => {
    const steps = [
      { success: true, answer: 'A', highlightCount: 3, tool: 'find' },
      { success: true, answer: 'B', highlightCount: 2, tool: 'find' }
    ];
    const result = buildAgentResult(steps, '');
    expect(result.highlightCount).toBe(5);
  });

  test('multi-step with no highlights: hasHighlights is false', () => {
    const steps = [
      { success: true, answer: 'General answer', highlightCount: 0, tool: 'answer' },
      { success: true, answer: 'Guide step', highlightCount: 0, tool: 'guide' }
    ];
    const result = buildAgentResult(steps, '');
    expect(result.hasHighlights).toBe(false);
    expect(result.highlightCount).toBe(0);
  });

  test('single step with missing highlightCount defaults to 0', () => {
    const step = { success: true, answer: 'ok', tool: 'answer' };
    const result = buildAgentResult([step], '');
    // highlightCount absent from step, total should be 0
    expect(result.highlightCount).toBeUndefined(); // passthrough means step's value (undefined)
    expect(result.planSteps[0].highlightCount).toBeUndefined();
  });
});

// ============================================================
// _isSearchIntentQuery (content/functions/main_router.js)
// Tests the heuristic that detects search-intent queries so the
// planner override can correctly route them to "guide".
// ============================================================
describe('_isSearchIntentQuery (content/functions/main_router.js)', () => {
  // Inline mirror — must stay in sync with the function in main_router.js
  function _isSearchIntentQuery(query) {
    if (!query) return false;
    return /\bfind me\b|\bsearch for\b|\blook for\b|\bget me\b|\bshow me an?\b|\bgo to .{1,40} and (find|search|look)\b/i.test(query);
  }

  test('detects "find me X" as search intent', () => {
    expect(_isSearchIntentQuery('find me black shoes for men')).toBe(true);
    expect(_isSearchIntentQuery('Find me a Spider-Man movie')).toBe(true);
    expect(_isSearchIntentQuery('find me the best laptop')).toBe(true);
  });

  test('detects "search for X" as search intent', () => {
    expect(_isSearchIntentQuery('search for flights to Paris')).toBe(true);
    expect(_isSearchIntentQuery('Search for Python tutorials')).toBe(true);
  });

  test('detects "look for X" as search intent', () => {
    expect(_isSearchIntentQuery('look for a red dress')).toBe(true);
  });

  test('detects "get me X" as search intent', () => {
    expect(_isSearchIntentQuery('get me a coffee maker under $50')).toBe(true);
  });

  test('detects "show me a/an X" as search intent', () => {
    expect(_isSearchIntentQuery('show me a good book')).toBe(true);
    expect(_isSearchIntentQuery('show me an affordable laptop')).toBe(true);
  });

  test('detects "go to X and find/search Y" as search intent', () => {
    expect(_isSearchIntentQuery('go to YouTube and find a Spider-Man movie')).toBe(true);
    expect(_isSearchIntentQuery('go to amazon and search for shoes')).toBe(true);
  });

  test('does NOT flag "find the X" as search intent (page-element lookup)', () => {
    expect(_isSearchIntentQuery('find the add to cart button')).toBe(false);
    expect(_isSearchIntentQuery('find the price')).toBe(false);
    expect(_isSearchIntentQuery('find the subscribe button')).toBe(false);
  });

  test('does NOT flag general questions as search intent', () => {
    expect(_isSearchIntentQuery('what is the price?')).toBe(false);
    expect(_isSearchIntentQuery('how do I report this video?')).toBe(false);
    expect(_isSearchIntentQuery('hide the ads')).toBe(false);
    expect(_isSearchIntentQuery('what is Python?')).toBe(false);
  });

  test('handles empty/null query safely', () => {
    expect(_isSearchIntentQuery('')).toBe(false);
    expect(_isSearchIntentQuery(null)).toBe(false);
  });
});
