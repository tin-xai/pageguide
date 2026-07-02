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
    window._pageguideIndex = window._pageguideIndex || {};
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

// Rewind feature (Slice 1): static DOM snapshot serializer.
// Verifies that runtime form state (which outerHTML omits) is captured into the
// snapshot, that scripts are stripped, and that a <base> is injected.
describe('gv2SerializeDom (content/utils.js)', () => {
  beforeAll(() => {
    loadScript('content/utils.js');
  });

  test('captures runtime values, selected option, contenteditable, strips scripts, injects base', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.body.innerHTML = [
      '<input id="t" type="text">',
      '<input id="c" type="checkbox">',
      '<textarea id="ta"></textarea>',
      '<select id="s"><option value="a">A</option><option value="b">B</option></select>',
      '<div id="ce" contenteditable="true"></div>',
      '<scr' + 'ipt>alert(1)</scr' + 'ipt>'
    ].join('');
    doc.getElementById('t').value = 'hello world';
    doc.getElementById('c').checked = true;
    doc.getElementById('ta').value = 'multi line text';
    doc.getElementById('s').value = 'b';
    doc.getElementById('ce').innerHTML = '<b>rich content</b>';

    const html = window.gv2SerializeDom(doc.documentElement, 'https://example.com/');

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('value="hello world"');   // text input value reflected
    expect(html).toContain('checked');               // checkbox state reflected
    expect(html).toContain('multi line text');        // textarea content reflected
    expect(html).toMatch(/<option value="b"[^>]*selected/); // selected option reflected
    expect(html).toContain('<b>rich content</b>');    // contenteditable content reflected
    expect(html).not.toContain('alert(1)');           // scripts stripped
    expect(html).toContain('<base href="https://example.com/"'); // base injected
  });

  test('never serializes password field values', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.body.innerHTML = '<input id="p" type="password">';
    doc.getElementById('p').value = 'secret-password-123';
    const html = window.gv2SerializeDom(doc.documentElement, 'https://example.com/');
    expect(html).not.toContain('secret-password-123');
  });
});

// Rewind/resume: capture + re-apply the page's restorable state (web storage, scroll, form
// values) so "Steer from here" on a fresh load can rebuild the page condition. Passwords are
// never captured, and apply must be resilient to missing fields / empty input.
describe('gv2CaptureRestoreState / gv2ApplyRestoreState (content/utils.js)', () => {
  beforeAll(() => {
    loadScript('content/utils.js');
  });

  function makeRoot() {
    const doc = document.implementation.createHTMLDocument('t');
    doc.body.innerHTML = [
      '<input id="name" type="text">',
      '<input id="pw" type="password">',
      '<input id="agree" type="checkbox">',
      '<textarea name="bio"></textarea>',
      '<select id="color"><option value="r">Red</option><option value="g">Green</option></select>',
      '<input type="text">'  // no id/name → not addressable, skipped
    ].join('');
    doc.getElementById('name').value = 'Ada';
    doc.getElementById('pw').value = 'secret123';
    doc.getElementById('agree').checked = true;
    doc.querySelector('textarea[name="bio"]').value = 'hello';
    doc.getElementById('color').value = 'g';
    return doc.documentElement;
  }

  test('captures form values, excludes passwords, skips unidentifiable fields', () => {
    const st = window.gv2CaptureRestoreState(window, makeRoot());
    const bySel = Object.fromEntries(st.forms.map(f => [f.sel, f]));
    expect(bySel['#name'].value).toBe('Ada');
    expect(bySel['textarea[name="bio"]'].value).toBe('hello');
    expect(bySel['#agree'].checked).toBe(true);
    expect(bySel['#color'].selectedIndex).toBe(1);
    // password value never captured
    expect(JSON.stringify(st.forms)).not.toContain('secret123');
    expect(st.forms.find(f => f.sel === '#pw')).toBeUndefined();
    // text input with no id/name is skipped (4 captured: name, agree, bio, color)
    expect(st.forms.length).toBe(4);
  });

  test('captures web storage and scroll', () => {
    window.localStorage.clear();
    window.localStorage.setItem('tok', 'abc');
    const st = window.gv2CaptureRestoreState(window, makeRoot());
    expect(st.localStorage.tok).toBe('abc');
    expect(st.scroll).toEqual({ x: 0, y: 0 });
  });

  test('apply restores storage + form state onto a fresh page, skipping missing fields', () => {
    window.localStorage.clear();
    const restore = {
      localStorage: { tok: 'xyz' },
      sessionStorage: {},
      scroll: { x: 0, y: 0 },
      forms: [
        { sel: '#name', value: 'Grace' },
        { sel: '#agree', checked: true },
        { sel: '#color', selectedIndex: 1 },
        { sel: '#missing', value: 'nope' }  // not present → skipped, no throw
      ]
    };
    const doc = document.implementation.createHTMLDocument('t');
    doc.body.innerHTML = [
      '<input id="name" type="text">',
      '<input id="agree" type="checkbox">',
      '<select id="color"><option value="r">Red</option><option value="g">Green</option></select>'
    ].join('');
    const applied = window.gv2ApplyRestoreState(restore, window, doc.documentElement);
    expect(window.localStorage.getItem('tok')).toBe('xyz');
    expect(doc.getElementById('name').value).toBe('Grace');
    expect(doc.getElementById('agree').checked).toBe(true);
    expect(doc.getElementById('color').selectedIndex).toBe(1);
    expect(applied.localStorage).toBe(1);
    expect(applied.forms).toBe(3);  // #missing not counted
  });

  test('gv2FieldSelector prefers id, then name, else null', () => {
    const a = document.createElement('input'); a.id = 'x';
    expect(window.gv2FieldSelector(a)).toBe('#x');
    const b = document.createElement('input'); b.setAttribute('name', 'y');
    expect(window.gv2FieldSelector(b)).toBe('input[name="y"]');
    expect(window.gv2FieldSelector(document.createElement('input'))).toBeNull();
  });

  test('apply tolerates null restore and returns a zeroed tally', () => {
    expect(window.gv2ApplyRestoreState(null, window, document.documentElement))
      .toEqual({ localStorage: 0, sessionStorage: 0, forms: 0, scroll: false });
  });

  test('apply populates the log array (one entry per item, with ok flags) without changing the return shape', () => {
    window.localStorage.clear();
    const restore = {
      localStorage: { tok: 'xyz' },
      sessionStorage: {},
      scroll: { x: 0, y: 0 },
      forms: [
        { sel: '#name', value: 'Grace' },
        { sel: '#missing', value: 'nope' }  // not present → logged as ok:false
      ]
    };
    const doc = document.implementation.createHTMLDocument('t');
    doc.body.innerHTML = '<input id="name" type="text">';
    const log = [];
    const applied = window.gv2ApplyRestoreState(restore, window, doc.documentElement, log);
    // Return shape unchanged.
    expect(applied).toEqual({ localStorage: 1, sessionStorage: 0, forms: 1, scroll: true });
    // One entry per applied item: 1 localStorage + 2 forms + 1 scroll = 4.
    expect(log.length).toBe(4);
    const ls = log.find(e => e.kind === 'localStorage');
    expect(ls).toMatchObject({ kind: 'localStorage', key: 'tok', value: 'xyz', ok: true });
    expect(log.find(e => e.kind === 'form' && e.sel === '#name').ok).toBe(true);
    expect(log.find(e => e.kind === 'form' && e.sel === '#missing').ok).toBe(false);
    expect(log.find(e => e.kind === 'scroll').ok).toBe(true);
  });
});

// Restore action log formatting (content/utils.js): pure, used by the panel confirm card and
// the full-page inspector to print each action the agent re-applied during a steer.
describe('gv2DescribeRestoreAction (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('formats each kind with a ✓ / ✗ status mark', () => {
    expect(window.gv2DescribeRestoreAction({ kind: 'localStorage', key: 'tok', value: 'abc', ok: true }))
      .toBe('✓ localStorage[tok] → "abc"');
    expect(window.gv2DescribeRestoreAction({ kind: 'sessionStorage', key: 's', value: '1', ok: true }))
      .toBe('✓ sessionStorage[s] → "1"');
    expect(window.gv2DescribeRestoreAction({ kind: 'scroll', value: '0,120', ok: true }))
      .toBe('✓ Scroll to 0,120');
    expect(window.gv2DescribeRestoreAction({ kind: 'form', sel: '#email', value: 'a@b.c', ok: true }))
      .toBe('✓ Set #email → "a@b.c"');
    expect(window.gv2DescribeRestoreAction({ kind: 'form', sel: '#missing', value: 'x', ok: false }))
      .toBe('✗ Set #missing → "x"');
  });

  test('formats replay actions by verb and target', () => {
    expect(window.gv2DescribeRestoreAction({ kind: 'replay', action: 'type', sel: '#q', value: 'hi', ok: true }))
      .toBe('✓ Type into #q → "hi"');
    expect(window.gv2DescribeRestoreAction({ kind: 'replay', action: 'click', target: { text: 'Continue' }, ok: true }))
      .toBe('✓ Click Continue');
  });

  test('renders a note verbatim and is safe on empty input', () => {
    expect(window.gv2DescribeRestoreAction({ kind: 'note', value: 'Live page — preserved', ok: true }))
      .toBe('✓ Live page — preserved');
    expect(window.gv2DescribeRestoreAction(null)).toBe('');
    expect(window.gv2DescribeRestoreAction({})).toBe('');
  });

  test('friendly labels hide raw Cloudflare-style selectors by default', () => {
    const entry = {
      kind: 'form',
      sel: '#cf-chl-widget-tdsao_response',
      value: '1.Q8s-f1r2GqAG9b5ON-S4BgSO96KfC-rgZJdljScFwaZ1pSea3DR85pLTOwhVQA02SB6Ydg',
      ok: false
    };

    expect(window.gv2FriendlyRestoreAction(entry)).toBe('Skipped a hidden page security field');
    expect(window.gv2IsHiddenRestoreField(entry)).toBe(true);
    expect(window.gv2FriendlyRestoreAction({ kind: 'localStorage', key: 'tok', ok: true }))
      .toBe('Restored saved page settings');
    expect(window.gv2FriendlyRestoreAction({ kind: 'form', sel: '#email_address', ok: true }))
      .toBe('Restored “email address” field');
    expect(window.gv2FriendlyRestoreAction({ kind: 'replay', action: 'click', target: { text: 'Account menu' }, ok: true }))
      .toBe('Opened “Account menu”');

    const technical = window.gv2RestoreTechnicalDetail(entry);
    expect(technical).toContain('#cf-chl-widget-tdsao_response');
    expect(technical.length).toBeLessThan(140);
  });
});

// Restore card v2: the error summary that names the first concrete action that failed to restore,
// so "Retry restore" can report e.g. "the menu dropdown could not be applied".
describe('gv2RestoreErrorSummary (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('summarizes the first failed concrete action', () => {
    const log = [
      { kind: 'localStorage', key: 'tok', value: 'a', ok: true },
      { kind: 'replay', action: 'click', target: { text: 'Idiomas' }, ok: false },
      { kind: 'replay', action: 'click', target: { text: 'Other' }, ok: false }
    ];
    const out = window.gv2RestoreErrorSummary(log);
    expect(out).toContain('Click');
    expect(out).toContain('did not apply');
    expect(out).toContain('Idiomas'); // names the first failed action
  });

  test('summarizes hidden security-field failures without leaking raw selector or value', () => {
    const out = window.gv2RestoreErrorSummary([
      {
        kind: 'form',
        sel: '#cf-chl-widget-tdsao_response',
        value: '1.Q8s-f1r2GqAG9b5ON-S4BgSO96KfC-rgZJdljScFwaZ1pSea3DR85pLTOwhVQA02SB6Ydg',
        ok: false
      }
    ]);
    expect(out).toContain('hidden page state');
    expect(out).not.toContain('cf-chl');
    expect(out).not.toContain('Q8s');
  });

  test('returns empty string when nothing actionable failed (notes are advisory)', () => {
    expect(window.gv2RestoreErrorSummary([{ kind: 'replay', action: 'click', target: { text: 'X' }, ok: true }])).toBe('');
    expect(window.gv2RestoreErrorSummary([{ kind: 'note', value: '⚠ mismatch', ok: false }])).toBe('');
    expect(window.gv2RestoreErrorSummary([])).toBe('');
    expect(window.gv2RestoreErrorSummary(null)).toBe('');
  });
});

describe('gv2 restore screenshot comparison helpers (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('prompt asks for comparison JSON and mentions both screenshot roles', () => {
    const prompt = window.gv2BuildRestoreComparePrompt({ redoStep: 3, newGoal: 'open account menu' });
    expect(prompt).toContain('saved target state before step 3');
    expect(prompt).toContain('current page after PageGuide tried to restore');
    expect(prompt).toContain('"notRestored"');
    expect(prompt).toContain('open account menu');
  });

  test('parser handles fenced JSON and clamps confidence', () => {
    const parsed = window.gv2ParseRestoreComparison('```json\n{"summary":"Mostly restored","restored":["menu open"],"notRestored":["language not selected"],"recommendation":"Tell the agent what is missing.","confidence":1.4}\n```');
    expect(parsed.summary).toBe('Mostly restored');
    expect(parsed.restored).toEqual(['menu open']);
    expect(parsed.notRestored).toEqual(['language not selected']);
    expect(parsed.confidence).toBe(1);
  });

  test('parser falls back gracefully for malformed responses', () => {
    const parsed = window.gv2ParseRestoreComparison('The page looks similar but I cannot produce JSON.');
    expect(parsed.summary).toContain('The page looks similar');
    expect(parsed.restored).toEqual([]);
    expect(parsed.notRestored).toEqual([]);
    expect(parsed.confidence).toBeNull();
  });
});

// Phase 1 (observation/timeline): confidence tier (green ≥0.7 / yellow <0.7, never red) and the
// screenshot crop-rect math used to crop a viewport capture to the highlighted element's region.
describe('gv2ConfidenceTier (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('high at ≥0.7, med below 0.7 — never a red/low tier', () => {
    expect(window.gv2ConfidenceTier(0.7)).toBe('high');
    expect(window.gv2ConfidenceTier(0.95)).toBe('high');
    expect(window.gv2ConfidenceTier(0.69)).toBe('med');
    expect(window.gv2ConfidenceTier(0.2)).toBe('med');   // low confidence is YELLOW, not red
    expect(window.gv2ConfidenceTier(0)).toBe('med');
  });

  test('null/NaN/non-number → null (unknown)', () => {
    expect(window.gv2ConfidenceTier(null)).toBeNull();
    expect(window.gv2ConfidenceTier(undefined)).toBeNull();
    expect(window.gv2ConfidenceTier(NaN)).toBeNull();
    expect(window.gv2ConfidenceTier('0.8')).toBeNull();
  });
});

describe('gv2ComputeConfidence (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  // Defaults: λ_L = 0.8, λ_P = 0.3
  test('full vs reduced are identical when progress = 0', () => {
    const parts = { grounded: 0.9, loop: 0.2, progress: 0 };
    const full = window.gv2ComputeConfidence(parts, 'full');
    const reduced = window.gv2ComputeConfidence(parts, 'reduced');
    expect(full.confidence).toBeCloseTo(reduced.confidence, 6);
    // 0.9 * (1 - 0.8*0.2) = 0.9 * 0.84 = 0.756
    expect(full.confidence).toBeCloseTo(0.756, 6);
  });

  test('full differs from reduced when progress ≠ 0', () => {
    const parts = { grounded: 0.8, loop: 0.1, progress: 0.5 };
    const full = window.gv2ComputeConfidence(parts, 'full');
    const reduced = window.gv2ComputeConfidence(parts, 'reduced');
    expect(full.confidence).not.toBeCloseTo(reduced.confidence, 6);
    // reduced: 0.8 * (1 - 0.8*0.1) = 0.8 * 0.92 = 0.736
    expect(reduced.confidence).toBeCloseTo(0.736, 6);
    // full: 0.736 * (1 + 0.3*0.5) = 0.736 * 1.15 = 0.8464
    expect(full.confidence).toBeCloseTo(0.8464, 6);
  });

  test('positive progress raises full above reduced; negative lowers it', () => {
    const base = { grounded: 0.7, loop: 0.0 };
    const pos = window.gv2ComputeConfidence({ ...base, progress: 0.8 }, 'full');
    const neg = window.gv2ComputeConfidence({ ...base, progress: -0.8 }, 'full');
    const reduced = window.gv2ComputeConfidence({ ...base, progress: -0.8 }, 'reduced');
    expect(pos.confidence).toBeGreaterThan(reduced.confidence);
    expect(neg.confidence).toBeLessThan(reduced.confidence);
  });

  test('loop = 1 applies full penalty: confidence ≈ 0.2·G', () => {
    const r = window.gv2ComputeConfidence({ grounded: 0.9, loop: 1, progress: 0 }, 'full');
    // 0.9 * (1 - 0.8*1) = 0.9 * 0.2 = 0.18
    expect(r.confidence).toBeCloseTo(0.18, 6);
  });

  test('noloop formula keeps grounding + progress and ignores loop entirely', () => {
    // 0.8 * (1 + 0.3*0.5) = 0.8 * 1.15 = 0.92 — independent of loop.
    const a = window.gv2ComputeConfidence({ grounded: 0.8, loop: 0.9, progress: 0.5 }, 'noloop');
    const b = window.gv2ComputeConfidence({ grounded: 0.8, loop: 0.1, progress: 0.5 }, 'noloop');
    expect(a.confidence).toBeCloseTo(0.92, 6);
    expect(b.confidence).toBeCloseTo(0.92, 6); // loop has no effect in noloop
  });

  test('the three formulas differ when loop and progress are both nonzero', () => {
    const parts = { grounded: 0.9, loop: 0.5, progress: 0.5 };
    const full = window.gv2ComputeConfidence(parts, 'full').confidence;       // 0.9*0.6*1.15 = 0.621
    const reduced = window.gv2ComputeConfidence(parts, 'reduced').confidence; // 0.9*0.6      = 0.54
    const noloop = window.gv2ComputeConfidence(parts, 'noloop').confidence;   // 0.9*1.15 = 1.035 → clip 1
    expect(full).toBeCloseTo(0.621, 6);
    expect(reduced).toBeCloseTo(0.54, 6);
    expect(noloop).toBe(1);
  });

  test('output is clipped to [0,1]', () => {
    const hi = window.gv2ComputeConfidence({ grounded: 1, loop: 0, progress: 1 }, 'full');
    expect(hi.confidence).toBe(1); // 1 * 1 * 1.3 = 1.3 → clipped to 1
    const lo = window.gv2ComputeConfidence({ grounded: 0, loop: 0, progress: 0 }, 'full');
    expect(lo.confidence).toBe(0);
  });

  test('missing grounded → confidence null (caller falls back to legacy)', () => {
    const r = window.gv2ComputeConfidence({ loop: 0.5, progress: 0.5 }, 'full');
    expect(r.confidence).toBeNull();
    expect(r.grounded).toBeNull();
  });

  test('out-of-range inputs are clamped (G,L→[0,1], P→[-1,1])', () => {
    const r = window.gv2ComputeConfidence({ grounded: 5, loop: -3, progress: 9 }, 'full');
    // G→1, L→0, P→1 : 1 * (1-0) * (1+0.3) = 1.3 → clip 1
    expect(r.confidence).toBe(1);
    expect(r.grounded).toBe(1);
    expect(r.loop).toBe(0);
    expect(r.progress).toBe(1);
  });

  test('weight overrides are respected', () => {
    const r = window.gv2ComputeConfidence({ grounded: 1, loop: 0.5, progress: 0 }, 'reduced', { lambdaL: 0.4 });
    // 1 * (1 - 0.4*0.5) = 0.8
    expect(r.confidence).toBeCloseTo(0.8, 6);
  });
});

describe('gv2 mechanical confidence — rule-based "no-LLM" scoring (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  describe('gv2GroundingScore', () => {
    test('indexed element uses element-step cosine thresholds', () => {
      expect(window.gv2GroundingScore({ action: 'click', hasIndex: true, elementStepSimilarity: 0.84 })).toBe(1.0);
      expect(window.gv2GroundingScore({ action: 'click', hasIndex: true, elementStepSimilarity: 0.83 })).toBe(0.5);
      expect(window.gv2GroundingScore({ action: 'click', hasIndex: true, elementStepSimilarity: 0.78 })).toBe(0.5);
      expect(window.gv2GroundingScore({ action: 'click', hasIndex: true, elementStepSimilarity: 0.77 })).toBe(0.1);
    });
    test('text only, no index → 0.0', () => {
      expect(window.gv2GroundingScore({ action: 'click', hasIndex: false, hasText: true })).toBe(0.0);
    });
    test('click with no index or text → 0.0', () => {
      expect(window.gv2GroundingScore({ action: 'click', hasIndex: false, hasText: false })).toBe(0.0);
    });
    test('scroll / done / initial → null (excluded step)', () => {
      expect(window.gv2GroundingScore({ action: 'done', hasIndex: true, hasText: true })).toBeNull();
      expect(window.gv2GroundingScore({ action: 'scroll_down', hasIndex: true })).toBeNull();
      expect(window.gv2GroundingScore({ isInitial: true, hasIndex: true })).toBeNull();
      expect(window.gv2GroundingScore(null)).toBeNull();
    });
  });

  describe('gv2LoopScore', () => {
    test('no previous actions → 0', () => {
      expect(window.gv2LoopScore([], 'a')).toBe(0);
    });
    test('no matching prior key → 0', () => {
      expect(window.gv2LoopScore(['b', 'c'], 'a')).toBe(0);
    });
    test('repeated key → matches / 10', () => {
      // two prior "a", current "a": 2 / 10 = 0.2
      expect(window.gv2LoopScore(['a', 'a'], 'a')).toBeCloseTo(0.2, 6);
      // one prior "a" among 3 previous: 1 / 10 = 0.1
      expect(window.gv2LoopScore(['a', 'b', 'c'], 'a')).toBeCloseTo(0.1, 6);
      // reference worked example: prev ["search","filters"], current "search" → 1/10 = 0.1
      expect(window.gv2LoopScore(['search', 'filters'], 'search')).toBeCloseTo(0.1, 6);
    });
    test('result is capped at 1.0', () => {
      const longPrior = Array(12).fill('a');
      expect(window.gv2LoopScore(longPrior, 'a')).toBe(1.0);
    });
    test('no current key → 0 (reference returns 0, not null)', () => {
      expect(window.gv2LoopScore(['a'], '')).toBe(0);
      expect(window.gv2LoopScore(['a'], null)).toBe(0);
    });
  });

  describe('gv2ComputeMechanicalConfidence', () => {
    test('C_t = G × (1 − λ_L·L_t), default λ_L = 0.5', () => {
      // G=1.0, no prior → L=0 → 1.0
      expect(window.gv2ComputeMechanicalConfidence({ action: 'click', hasIndex: true, elementStepSimilarity: 0.84, priorKeys: [], currentKey: 'a' }).confidence).toBeCloseTo(1.0, 6);
      // G=0.5 (medium cosine), L=0 → 0.5
      expect(window.gv2ComputeMechanicalConfidence({ action: 'click', hasIndex: true, elementStepSimilarity: 0.78, priorKeys: [], currentKey: 'a' }).confidence).toBeCloseTo(0.5, 6);
      // no valid index → 0.0
      expect(window.gv2ComputeMechanicalConfidence({ action: 'click', hasIndex: false, hasText: true, priorKeys: [], currentKey: 'a' }).confidence).toBeCloseTo(0.0, 6);
    });
    test('loop penalty lowers confidence: G=1.0, one prior repeat (L=0.1, λ=0.5) → 0.95', () => {
      // priorKeys ['a'], currentKey 'a' → L = 1/10 = 0.1; C = 1.0 * (1 - 0.5*0.1) = 0.95
      const r = window.gv2ComputeMechanicalConfidence({ action: 'click', hasIndex: true, elementStepSimilarity: 0.84, priorKeys: ['a'], currentKey: 'a' });
      expect(r.loop).toBeCloseTo(0.1, 6);
      expect(r.confidence).toBeCloseTo(0.95, 6);
    });
    test('reference example step 3: prev [search,filters], L=0.1 → C=0.95', () => {
      const r = window.gv2ComputeMechanicalConfidence({ action: 'click', hasIndex: true, elementStepSimilarity: 0.84, priorKeys: ['search', 'filters'], currentKey: 'search' });
      expect(r.loop).toBeCloseTo(0.1, 6);
      expect(r.confidence).toBeCloseTo(0.95, 6);
    });
    test('grounding zero → confidence 0 (hard floor)', () => {
      const r = window.gv2ComputeMechanicalConfidence({ action: 'click', hasIndex: false, priorKeys: ['a', 'a'], currentKey: 'a' });
      expect(r.grounding).toBe(0);
      expect(r.confidence).toBe(0);
    });
    test('done step → null confidence (excluded)', () => {
      const r = window.gv2ComputeMechanicalConfidence({ action: 'done', priorKeys: [], currentKey: '' });
      expect(r.confidence).toBeNull();
      expect(r.grounding).toBeNull();
      expect(r.loop).toBeNull();
    });
    test('λ_L override is respected', () => {
      // G=1.0, prior ['a'] current 'a' → L=0.1; λ=10.0 → 1.0*(1-10.0*0.1)=0
      const r = window.gv2ComputeMechanicalConfidence({ action: 'click', hasIndex: true, elementStepSimilarity: 0.84, priorKeys: ['a'], currentKey: 'a' }, { lambdaL: 10.0 });
      expect(r.confidence).toBeCloseTo(0.0, 6);
    });
  });

  describe('gv2WarningDecision', () => {
    test('grounding warning fires below threshold only when enabled', () => {
      expect(window.gv2WarningDecision({
        groundingEnabled: true,
        loopEnabled: false,
        elementStepSimilarity: 0.79,
        loopScore: 0,
        groundingThreshold: 0.8,
        loopThreshold: 0.3
      })).toMatchObject({ inject: true, types: ['grounding'] });
      expect(window.gv2WarningDecision({
        groundingEnabled: true,
        loopEnabled: false,
        elementStepSimilarity: 0.8,
        loopScore: 0,
        groundingThreshold: 0.8,
        loopThreshold: 0.3
      })).toMatchObject({ inject: false, types: [] });
      expect(window.gv2WarningDecision({
        groundingEnabled: false,
        loopEnabled: false,
        elementStepSimilarity: 0.2,
        loopScore: 0
      })).toMatchObject({ inject: false, types: [] });
    });

    test('missing grounding similarity does not coerce to zero or trigger grounding warning', () => {
      expect(window.gv2WarningDecision({
        groundingEnabled: true,
        loopEnabled: false,
        elementStepSimilarity: null,
        loopScore: null,
        groundingThreshold: 0.8,
        loopThreshold: 0.3
      })).toMatchObject({ inject: false, types: [] });
      expect(window.gv2WarningDecision({
        groundingEnabled: true,
        loopEnabled: false,
        elementStepSimilarity: undefined,
        loopScore: undefined,
        groundingThreshold: 0.8,
        loopThreshold: 0.3
      })).toMatchObject({ inject: false, types: [] });
      expect(window.gv2WarningDecision({
        groundingEnabled: true,
        loopEnabled: true,
        elementStepSimilarity: null,
        loopScore: 0.3,
        groundingThreshold: 0.8,
        loopThreshold: 0.3
      })).toMatchObject({ inject: true, types: ['loop'] });
    });

    test('loop warning fires at threshold and combines with grounding', () => {
      expect(window.gv2WarningDecision({
        groundingEnabled: true,
        loopEnabled: true,
        elementStepSimilarity: 0.7,
        loopScore: 0.3,
        groundingThreshold: 0.8,
        loopThreshold: 0.3
      })).toMatchObject({ inject: true, types: ['grounding', 'loop'] });
      expect(window.gv2WarningDecision({
        groundingEnabled: false,
        loopEnabled: true,
        elementStepSimilarity: 1,
        loopScore: 0.29,
        loopThreshold: 0.3
      })).toMatchObject({ inject: false, types: [] });
    });
  });

  describe('gv2ElementKey', () => {
    test('uses element.text, stripped and lowercased', () => {
      expect(window.gv2ElementKey({ element: { text: '  Search ' }, instruction: 'x' })).toBe('search');
    });
    test('element text wins over instruction', () => {
      expect(window.gv2ElementKey({ element: { text: 'Search' }, instruction: 'Click the search button' })).toBe('search');
    });
    test('falls back to instruction when no element text', () => {
      expect(window.gv2ElementKey({ instruction: 'Click Save' })).toBe('click save');
    });
    test('includes action type when present so clear/type/click are distinct', () => {
      expect(window.gv2ElementKey({ action: 'click', element: { text: 'Search' } })).toBe('click: search');
      expect(window.gv2ElementKey({ action: 'type', element: { text: 'Search' } })).toBe('type: search');
      expect(window.gv2ElementKey({ action: 'clear_text', element: { text: 'Search' } })).toBe('clear_text: search');
    });
    test('returns empty string when neither present', () => {
      expect(window.gv2ElementKey({})).toBe('');
      expect(window.gv2ElementKey(null)).toBe('');
    });
  });
});

describe('gv2ResolveRegionElement (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('prefers the active highlight node over currentTargetEl', () => {
    const highlight = { getBoundingClientRect: () => ({}) };
    const container = { getBoundingClientRect: () => ({}) };
    window._pageguideHighlights = [highlight];
    window._guidev2 = { currentTargetEl: container };
    const doc = { contains: (el) => el === highlight || el === container, querySelector: () => null };
    expect(window.gv2ResolveRegionElement(doc)).toBe(highlight);
  });

  test('falls back to currentTargetEl then data-pageguide-styled', () => {
    window._pageguideHighlights = [];
    const styled = { id: 'styled' };
    const container = { id: 'container' };
    window._guidev2 = { currentTargetEl: container };
    const doc = {
      contains: (el) => el === container || el === styled,
      querySelector: (sel) => (sel === '[data-pageguide-styled]' ? styled : null),
    };
    expect(window.gv2ResolveRegionElement(doc)).toBe(container);
    window._guidev2 = {};
    expect(window.gv2ResolveRegionElement(doc)).toBe(styled);
  });
});

describe('gv2ResolveRegionTarget (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('prefers currentTargetEl over highlight span for region crop bounds', () => {
    const highlight = { getBoundingClientRect: () => ({}) };
    const container = { getBoundingClientRect: () => ({}) };
    window._pageguideHighlights = [highlight];
    window._guidev2 = { currentTargetEl: container };
    const doc = { contains: (el) => el === highlight || el === container, querySelector: () => null };
    expect(window.gv2ResolveRegionTarget(doc)).toBe(container);
  });
});

describe('gv2PickTargetIndex (content/tasks/guidev2.js)', () => {
  beforeAll(() => {
    window.getAccessibleName = (el) => el._name || el.textContent || '';
    loadScript('content/tasks/guidev2.js');
  });

  test('keeps LLM index when its accessible name also matches the search text', () => {
    window._pageguideIndex = {
      10: { _name: 'High Impact', textContent: 'High Impact' },
      20: { _name: 'High Impact filter', textContent: 'High Impact' },
    };
    expect(window.gv2PickTargetIndex('High Impact', 10)).toBe(10);
  });

  test('uses text match when LLM index does not match the search text', () => {
    window._pageguideIndex = {
      10: { _name: 'Purple filter', textContent: 'Purple' },
      20: { _name: 'High Impact', textContent: 'High Impact' },
    };
    expect(window.gv2PickTargetIndex('High Impact', 10)).toBe(20);
  });

  test('_gv2QuestionHasOraclePlan detects the annotated oracle plan marker', () => {
    expect(window._gv2QuestionHasOraclePlan(
      'Buy a gift card\n\nORACLE PLAN FROM THE ANNOTATED DATASET:\n1. Visit site')).toBe(true);
    expect(window._gv2QuestionHasOraclePlan('Buy a gift card')).toBe(false);
    expect(window._gv2QuestionHasOraclePlan(null)).toBe(false);
  });
});

describe('gv2CosineSimilarity / gv2BuildPredictFinalGoalPrompt (content/utils.js)', () => {
  beforeAll(() => {
    loadScript('content/utils.js');
  });

  test('gv2BuildPredictFinalGoalPrompt includes task and url', () => {
    const p = window.gv2BuildPredictFinalGoalPrompt('Change language to French', 'https://example.com');
    expect(p).toContain('Change language to French');
    expect(p).toContain('https://example.com');
    expect(p).toMatch(/final goal STATE/i);
  });

  test('gv2CosineSimilarity returns 1 for identical vectors and 0 for orthogonal', () => {
    expect(window.gv2CosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1);
    expect(window.gv2CosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0);
  });

  test('gv2CosineSimilarity clamps negative cosine to 0', () => {
    expect(window.gv2CosineSimilarity([1, 0], [-1, 0])).toBe(0);
  });
});

describe('_gv2ShouldUseAlignedRegionCapture (content/tasks/guidev2.js)', () => {
  beforeAll(() => {
    global.chrome = {
      storage: {
        local: {
          get: jest.fn(async () => ({ guideDebugRegionCapture: 'legacy' })),
        },
      },
    };
    loadScript('content/tasks/guidev2.js');
  });

  test('forces aligned capture during auto mode regardless of debug toggle', async () => {
    await expect(window._gv2ShouldUseAlignedRegionCapture({ autoMode: true })).resolves.toBe(true);
  });

  test('respects debug aligned toggle in manual mode', async () => {
    chrome.storage.local.get.mockResolvedValueOnce({ guideDebugRegionCapture: 'aligned' });
    await expect(window._gv2ShouldUseAlignedRegionCapture({ autoMode: false })).resolves.toBe(true);

    chrome.storage.local.get.mockResolvedValueOnce({ guideDebugRegionCapture: 'legacy' });
    await expect(window._gv2ShouldUseAlignedRegionCapture({ autoMode: false })).resolves.toBe(false);
  });
});

describe('_gv2ElementStepSimilarityResult (content/tasks/guidev2.js)', () => {
  beforeAll(() => {
    loadScript('content/utils.js');
    loadScript('content/tasks/guidev2.js');
  });

  beforeEach(() => {
    delete window.safeSendMessage;
    if (window._gv2ResetEmbedState) window._gv2ResetEmbedState();
    // Force the direct content-script fetch to fail so these tests exercise the SW fallback
    // path (the direct path is covered separately).
    window.chrome = { storage: { sync: { get: jest.fn(() => Promise.reject(new Error('no storage'))) } } };
  });

  test('returns ok with the cosine value on a successful embed', async () => {
    window.safeSendMessage = jest.fn(async () => ({ embeddings: [[1, 0, 0], [1, 0, 0]] }));
    const r = await window._gv2ElementStepSimilarityResult('search location', 'location', true);
    expect(r.reason).toBe('ok');
    expect(r.value).toBeCloseTo(1);
  });

  test('a service-worker error response is classified embed_error, not exception', async () => {
    window.safeSendMessage = jest.fn(async () => ({ error: '🔄 Connection lost. Please refresh the page (F5).' }));
    const r = await window._gv2ElementStepSimilarityResult('search location', 'location', true);
    expect(r.value).toBeNull();
    expect(r.reason).toBe('embed_error');
    expect(r.detail).toContain('Connection lost');
  });

  test('an undefined/no response is classified no_response, not exception', async () => {
    window.safeSendMessage = jest.fn(async () => undefined);
    const r = await window._gv2ElementStepSimilarityResult('search location', 'location', true);
    expect(r.value).toBeNull();
    expect(r.reason).toBe('no_response');
  });

  test('short non-empty element text still embeds (length is not the failure cause)', async () => {
    const send = jest.fn(async () => ({ embeddings: [[1, 0], [0, 1]] }));
    window.safeSendMessage = send;
    const r = await window._gv2ElementStepSimilarityResult('Enter the value', 'location', true);
    expect(send).toHaveBeenCalled();
    expect(r.reason).toBe('ok');
  });

  test('retries once on a transient failure then succeeds', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce({ error: 'Extension context invalidated' })
      .mockResolvedValueOnce({ embeddings: [[1, 0, 0], [1, 0, 0]] });
    window.safeSendMessage = send;
    const r = await window._gv2ElementStepSimilarityResult('search location', 'location', true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(r.reason).toBe('ok');
  });

  test('empty element text short-circuits without attempting an embed', async () => {
    const send = jest.fn();
    window.safeSendMessage = send;
    const r = await window._gv2ElementStepSimilarityResult('search location', '', true);
    expect(send).not.toHaveBeenCalled();
    expect(r.reason).toBe('empty_element_text');
  });

  test('recovers from a transient undefined response within the retry budget', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ embeddings: [[1, 0, 0], [1, 0, 0]] });
    window.safeSendMessage = send;
    const r = await window._gv2ElementStepSimilarityResult('search location', 'location', true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(r.reason).toBe('ok');
    expect(r.value).toBeCloseTo(1);
  });

  test('gives up with no_response only after exhausting all retries', async () => {
    const send = jest.fn(async () => undefined);
    window.safeSendMessage = send;
    const r = await window._gv2ElementStepSimilarityResult('search location', 'location', true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(r.reason).toBe('no_response');
  });
});

describe('_gv2CallEmbed serialization + memoization (content/tasks/guidev2.js)', () => {
  beforeAll(() => {
    loadScript('content/utils.js');
    loadScript('content/tasks/guidev2.js');
  });

  beforeEach(() => {
    delete window.safeSendMessage;
    window._gv2ResetEmbedState();
    // Force the direct fetch to fail so serialization/memoization is measured on the SW path.
    window.chrome = { storage: { sync: { get: jest.fn(() => Promise.reject(new Error('no storage'))) } } };
  });

  test('never sends more than one callEmbed message concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    window.safeSendMessage = jest.fn(async ({ texts }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight -= 1;
      return { embeddings: texts.map(() => [1, 0, 0]) };
    });
    // Fire several embeds at once, each with distinct texts so the cache can't collapse them.
    const results = await Promise.all([
      window._gv2CallEmbed(['a1', 'b1']),
      window._gv2CallEmbed(['a2', 'b2']),
      window._gv2CallEmbed(['a3', 'b3']),
      window._gv2CallEmbed(['a4', 'b4']),
    ]);
    expect(maxInFlight).toBe(1);
    results.forEach(r => expect(r.embeddings).toHaveLength(2));
  });

  test('memoizes per text — a repeated text is not re-embedded', async () => {
    const send = jest.fn(async ({ texts }) => ({ embeddings: texts.map(() => [1, 0, 0]) }));
    window.safeSendMessage = send;
    await window._gv2CallEmbed(['shared', 'one']);
    await window._gv2CallEmbed(['shared', 'two']); // 'shared' cached; only 'two' is new
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].texts).toEqual(['shared', 'one']);
    expect(send.mock.calls[1][0].texts).toEqual(['two']);
  });

  test('all-cached call makes no service-worker request', async () => {
    const send = jest.fn(async ({ texts }) => ({ embeddings: texts.map(() => [1, 0, 0]) }));
    window.safeSendMessage = send;
    await window._gv2CallEmbed(['x', 'y']);
    send.mockClear();
    const r = await window._gv2CallEmbed(['x', 'y']);
    expect(send).not.toHaveBeenCalled();
    expect(r.embeddings).toEqual([[1, 0, 0], [1, 0, 0]]);
  });

  test('a failed embed is not cached — a later call re-embeds the same text', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce(undefined)   // attempt 1
      .mockResolvedValueOnce(undefined);  // attempt 2 → fails, must not cache
    window.safeSendMessage = send;
    const failed = await window._gv2CallEmbed(['fresh']);
    expect(failed).toBeUndefined();

    send.mockResolvedValue({ embeddings: [[1, 0, 0]] });
    const ok = await window._gv2CallEmbed(['fresh']); // re-embeds because nothing was cached
    expect(ok.embeddings).toEqual([[1, 0, 0]]);
    expect(send.mock.calls.length).toBeGreaterThan(2);
  });

  test('embeds directly from the content script (fetch) without touching the SW', async () => {
    // Working storage key + fetch → the direct path succeeds and safeSendMessage is never used.
    window.chrome = { storage: { sync: { get: jest.fn(async () => ({ provider: 'openrouter', openrouterApiKey: 'sk-test' })) } } };
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [1, 0, 0] }, { index: 1, embedding: [0, 1, 0] }] }),
    }));
    global.fetch = fetchMock;
    window.fetch = fetchMock;
    const send = jest.fn();
    window.safeSendMessage = send;
    const r = await window._gv2CallEmbed(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/embeddings');
    expect(send).not.toHaveBeenCalled();
    expect(r.embeddings).toEqual([[1, 0, 0], [0, 1, 0]]);
    delete global.fetch;
    delete window.fetch;
  });
});

describe('scrollToHighlight (content/functions/scroll.js)', () => {
  beforeAll(() => {
    loadScript('content/functions/scroll.js');
  });

  beforeEach(() => {
    delete window._guidev2;
    window._pageguideHighlights = [];
  });

  test('uses smooth scroll in manual mode', () => {
    const el = { scrollIntoView: jest.fn(), style: {} };
    window._pageguideHighlights = [el];
    window.scrollToHighlight(0);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  test('uses instant scroll during auto guide', () => {
    window._guidev2 = { autoMode: true };
    const el = { scrollIntoView: jest.fn(), style: {} };
    window._pageguideHighlights = [el];
    window.scrollToHighlight(0);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'instant', block: 'center' });
  });
});

describe('scrollToHighlightAndWait (content/functions/scroll.js)', () => {
  beforeAll(() => {
    loadScript('content/functions/scroll.js');
  });

  beforeEach(() => {
    delete window._guidev2;
    window._pageguideHighlights = [];
  });

  test('resolves false when there is no highlight', async () => {
    window._pageguideHighlights = [];
    await expect(window.scrollToHighlightAndWait()).resolves.toBe(false);
  });

  test('scrolls the highlight and resolves true', async () => {
    const el = {
      scrollIntoView: jest.fn(),
      style: {},
    };
    window._pageguideHighlights = [el];
    await expect(window.scrollToHighlightAndWait(0, 20)).resolves.toBe(true);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });
});

describe('gv2CropRect (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('scales CSS px by devicePixelRatio, adds padding, clamps to image bounds', () => {
    // rect 100,50 size 40x20; dpr 2; pad 0 → 200,100 size 80x40 in image px.
    const c = window.gv2CropRect({ left: 100, top: 50, width: 40, height: 20 }, 2, 1000, 1000, 0);
    expect(c).toEqual({ sx: 200, sy: 100, sw: 80, sh: 40 });
  });

  test('clamps a rect that runs past the image edge', () => {
    const c = window.gv2CropRect({ left: 990, top: 990, width: 40, height: 40 }, 1, 1000, 1000, 0);
    expect(c.sx).toBe(990);
    expect(c.sy).toBe(990);
    expect(c.sw).toBe(10); // 1000 - 990
    expect(c.sh).toBe(10);
  });

  test('applies default padding (8 CSS px) around the element', () => {
    const c = window.gv2CropRect({ left: 100, top: 100, width: 50, height: 50 }, 1, 1000, 1000);
    expect(c).toEqual({ sx: 92, sy: 92, sw: 66, sh: 66 }); // 50 + 2*8 = 66
  });

  test('returns null for invalid rect or zero-size crop', () => {
    expect(window.gv2CropRect(null, 1, 100, 100)).toBeNull();
    expect(window.gv2CropRect({ left: 200, top: 0, width: 10, height: 10 }, 1, 100, 100, 0)).toBeNull();
  });
});

// Plan/confidence (Slice 2): tolerant JSON-object extractor used for plan,
// confidence, and verification parsing.
describe('gv2ExtractJsonObject (content/utils.js)', () => {
  beforeAll(() => {
    loadScript('content/utils.js');
  });

  test('parses a ```json fenced object', () => {
    const out = window.gv2ExtractJsonObject('```json\n{"plan":["a","b","c"]}\n```');
    expect(out).toEqual({ plan: ['a', 'b', 'c'] });
  });

  test('extracts an object embedded in surrounding prose', () => {
    const out = window.gv2ExtractJsonObject('Sure! Here is the step:\n{"step":2,"confidence":0.8,"planStep":1}\nHope that helps.');
    expect(out.step).toBe(2);
    expect(out.confidence).toBe(0.8);
    expect(out.planStep).toBe(1);
  });

  test('returns null for malformed JSON', () => {
    expect(window.gv2ExtractJsonObject('not json at all')).toBeNull();
    expect(window.gv2ExtractJsonObject('{ broken: ')).toBeNull();
    expect(window.gv2ExtractJsonObject(null)).toBeNull();
  });

  test('successfully repairs and parses malformed LLM JSON outputs', () => {
    // Test case 1: Missing colon and quotes after key, containing unescaped double quotes
    const malformed1 = `{ "step": 2, "thought The user wants to type "funny cat" into the search bar. ", "instruction": "Type 'funny cat' into the search bar.", "element": { "index": 41, "text": "Pesquisar" }, "action": "type", "typeText": "funny cat", "isLastStep": false }`;
    const parsed1 = window.gv2ExtractJsonObject(malformed1);
    expect(parsed1).not.toBeNull();
    expect(parsed1.step).toBe(2);
    expect(parsed1.thought).toContain('funny cat');
    expect(parsed1.instruction).toBe("Type 'funny cat' into the search bar.");

    // Test case 2: Missing quotes on value
    const malformed2 = `{ "step": 3, "thought": The user wants to click search. ", "instruction": "Click search.", "action": "click", "isLastStep": false }`;
    const parsed2 = window.gv2ExtractJsonObject(malformed2);
    expect(parsed2).not.toBeNull();
    expect(parsed2.step).toBe(3);
    expect(parsed2.thought).toContain('The user wants to click search.');

    // Test case 3: Unescaped double quotes inside value
    const malformed3 = `{ "step": 4, "thought": "The user wants to find the "pink sofa" on the screen.", "instruction": "Find the sofa.", "action": "done", "isLastStep": true }`;
    const parsed3 = window.gv2ExtractJsonObject(malformed3);
    expect(parsed3).not.toBeNull();
    expect(parsed3.step).toBe(4);
    expect(parsed3.thought).toBe('The user wants to find the \"pink sofa\" on the screen.');
  });
});

// Autonomous mode (mode toggle): risk assessment that gates auto-execution.
describe('gv2AssessRisk (content/utils.js)', () => {
  beforeAll(() => {
    loadScript('content/utils.js');
  });

  test('honors model high-risk self-assessment', () => {
    expect(window.gv2AssessRisk({ risk: 'high', instruction: 'Open the menu' })).toBe('high');
  });

  test('escalates obviously destructive/sensitive actions even if model says low', () => {
    expect(window.gv2AssessRisk({ risk: 'low', instruction: 'Delete your account' })).toBe('high');
    expect(window.gv2AssessRisk({ risk: 'low', instruction: 'Click Pay now' })).toBe('high');
    expect(window.gv2AssessRisk({ risk: 'low', action: 'type', typeText: 'hunter2', element: { text: 'Password' } })).toBe('high');
    expect(window.gv2AssessRisk({ risk: 'low', action: 'clear_text', element: { text: 'Password' } })).toBe('high');
    expect(window.gv2AssessRisk({ risk: 'low', instruction: 'Send the message' })).toBe('high');
  });

  test('escalates on the canonical ACT value field (Slice 5)', () => {
    // A canonical ACT/type step carries the sensitive text in `value`, not `typeText`.
    expect(window.gv2AssessRisk({ risk: 'low', verb: 'ACT', operation: 'click', element: { text: 'Delete account' } })).toBe('high');
    expect(window.gv2AssessRisk({ risk: 'low', verb: 'ACT', operation: 'type', value: 'unsubscribe', element: { text: 'Confirm' } })).toBe('high');
    // A benign ACT/select stays low.
    expect(window.gv2AssessRisk({ risk: 'low', verb: 'ACT', operation: 'select', value: 'United States', element: { text: 'Country' } })).toBe('low');
  });

  test('treats reversible/routine actions as low risk', () => {
    expect(window.gv2AssessRisk({ risk: 'low', instruction: 'Open the Settings menu' })).toBe('low');
    expect(window.gv2AssessRisk({ instruction: 'Toggle dark mode on' })).toBe('low');
    expect(window.gv2AssessRisk(null)).toBe('low');
  });
});

// Auto-mode Gate 2: page-change detection.
describe('gv2PageSignature + gv2StateChanged (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('identical page → identical signature → no change', () => {
    const idx = { count: 12, indexText: 'A\nB\nC' };
    const a = window.gv2PageSignature(idx, 'https://x.com/p');
    const b = window.gv2PageSignature({ count: 12, indexText: 'A\nB\nC' }, 'https://x.com/p');
    expect(a).toBe(b);
    expect(window.gv2StateChanged(a, b)).toBe(false);
  });

  test('URL change, element-count change, or content change → different signature', () => {
    const base = window.gv2PageSignature({ count: 12, indexText: 'A\nB' }, 'https://x.com/p');
    expect(window.gv2PageSignature({ count: 12, indexText: 'A\nB' }, 'https://x.com/q')).not.toBe(base); // url
    expect(window.gv2PageSignature({ count: 13, indexText: 'A\nB' }, 'https://x.com/p')).not.toBe(base); // count
    expect(window.gv2PageSignature({ count: 12, indexText: 'A\nC' }, 'https://x.com/p')).not.toBe(base); // content
    expect(window.gv2StateChanged(base, window.gv2PageSignature({ count: 99, indexText: 'Z' }, 'https://x.com/p'))).toBe(true);
  });

  test('missing signatures fail open (treated as changed)', () => {
    expect(window.gv2StateChanged(null, 'sig')).toBe(true);
    expect(window.gv2StateChanged('sig', undefined)).toBe(true);
  });
});

describe('gv2DotState (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('renders one dot per concrete step — never fewer than the step count', () => {
    // Plan estimated 4 steps, but the agent has taken 10 concrete steps.
    const plan = Array.from({ length: 4 }, (_, i) => ({ n: i + 1, goal: 'g' + (i + 1) }));
    const records = Array.from({ length: 10 }, (_, i) => ({ step: i + 1, planStep: Math.min(i + 1, 4), confidence: 0.9 }));
    const dots = window.gv2DotState({ plan, records, verifications: {}, current: 6, guideActive: true });
    expect(dots).toHaveLength(10);            // all 10 steps shown, not capped to the plan
    expect(dots[4].status).toBe('done');      // step 5 < current(6) → done
    expect(dots[5].status).toBe('current');   // step 6 in progress
    expect(dots[6].status).toBe('pending');   // step 7 not started
  });

  test('marks low-confidence and low-grounding steps for review', () => {
    const records = [
      { step: 1, confidence: 0.3 },              // low self-confidence
      { step: 2, confidence: 0.9, grounding: 0.2 } // low grounding
    ];
    const dots = window.gv2DotState({ plan: [], records, verifications: {}, current: 2, guideActive: true });
    expect(dots[0].review).toBe(true);
    expect(dots[1].review).toBe(true);
  });

  test('surfaces verification status per concrete step (success + error)', () => {
    const records = [{ step: 1 }, { step: 2 }];
    const verifications = { 1: { status: 'success' }, 2: { status: 'failed' } };
    const dots = window.gv2DotState({ plan: [], records, verifications, current: 2, guideActive: true });
    expect(dots[0].verify).toBe('success');
    expect(dots[1].verify).toBe('failed');
  });

  test('finished guide marks every step done (not stuck current)', () => {
    const records = [{ step: 1 }, { step: 2 }];
    const dots = window.gv2DotState({ plan: [], records, verifications: {}, current: 2, guideActive: false });
    expect(dots.map(d => d.status)).toEqual(['done', 'done']);
  });
});

describe('gv2NormalizeStepNumber (content/utils.js)', () => {
  test('keeps the expected step when the model is correct', () => {
    const r = window.gv2NormalizeStepNumber({ step: 2 }, ['Step 1: open']);
    expect(r).toEqual({ expectedStep: 2, llmStep: 2, stepNumberCorrected: false });
  });

  test('corrects skipped model step numbers to the next concrete step', () => {
    const r = window.gv2NormalizeStepNumber({ step: 3 }, ['Step 1: open']);
    expect(r).toEqual({ expectedStep: 2, llmStep: 3, stepNumberCorrected: true });
  });

  test('uses the expected step when the model omits or malforms step', () => {
    const r = window.gv2NormalizeStepNumber({}, ['Step 1: open', 'Step 2: pick']);
    expect(r).toEqual({ expectedStep: 3, llmStep: null, stepNumberCorrected: true });
  });
});

describe('gv2NextStep manual continuation (content/tasks/guidev2.js)', () => {
  beforeAll(() => {
    window.chrome = {
      runtime: {
        connect: jest.fn(() => ({
          onMessage: { addListener: jest.fn() },
          onDisconnect: { addListener: jest.fn() }
        })),
        sendMessage: jest.fn()
      },
      storage: {
        session: {
          get: jest.fn(async () => ({})),
          set: jest.fn(async () => {}),
          remove: jest.fn(async () => {})
        },
        local: {
          get: jest.fn(async () => ({})),
          set: jest.fn(async () => {})
        }
      }
    };
    loadScript('content/tasks/guidev2.js');
  });

  beforeEach(() => {
    window.chrome.runtime.sendMessage.mockClear();
    window._guidev2 = {
      active: true,
      question: 'answer a form question',
      previousSteps: ['Step 1: Choose Yes'],
      currentPlanStep: 1,
      autoMode: false,
      _currentStep: { action: 'click', instruction: 'Choose Yes' }
    };
  });

  test('active manual guide continues even when no click-wait flag is set', async () => {
    const continueGuide = jest.fn(async () => ({ success: true, progressed: true }));

    const result = await window.gv2NextStep({ source: 'panel', generateAndDispatch: continueGuide });

    expect(continueGuide).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, progressed: true });
  });

  test('returns a recoverable no-progress response when there is no active step', async () => {
    window._guidev2._currentStep = null;

    const result = await window.gv2NextStep({ source: 'panel' });

    expect(result.success).toBe(false);
    expect(result.progressed).toBe(false);
  });

  test('stop clears pending auto-click and auto-type timers', () => {
    window._guidev2._autoClickTimer = setTimeout(() => {}, 1000);
    window._guidev2._autoTypeTimer = setTimeout(() => {}, 1000);

    window.gv2StopGuide();

    expect(window._guidev2._autoClickTimer).toBeNull();
    expect(window._guidev2._autoTypeTimer).toBeNull();
    expect(window._guidev2.active).toBe(false);
  });

  test('guide prompt teaches clear_text action', () => {
    expect(window.GUIDE_V2_PROMPT).toContain('"clear_text"');
    expect(window.GUIDE_V2_PROMPT).toContain('action="clear_text"');
  });

  test('initial planning prompt includes matched tutorial reference before asking planner', async () => {
    window.safeSendMessage = jest.fn(async () => ({
      content: JSON.stringify({
        planTitle: 'Disable autoplay',
        steps: [{ goal: 'Open settings' }, { goal: 'Turn off autoplay' }]
      })
    }));
    window.rewindUpdateSessionMeta = jest.fn(async () => {});

    const g = {
      active: true,
      planningMode: 'planning',
      question: 'How do I turn off autoplay on Spotify?',
      sessionId: 'planning-tutorial-test',
      tutorialRef: {
        task: 'How do I turn off autoplay on Spotify?',
        website: 'Spotify - Disable autoplay',
        content: {
          steps: [
            'Step 1: Click your profile picture at the top, and select Settings.',
            'Step 2: Scroll down to Autoplay and switch it off.'
          ]
        }
      }
    };

    const ok = await window._gv2GenerateInitialPlan(
      g,
      { indexText: '[1] Profile\n[2] Settings\n[3] Autoplay' },
      { isDark: false }
    );

    expect(ok).toBe(true);
    expect(window.safeSendMessage).toHaveBeenCalledTimes(1);
    const request = window.safeSendMessage.mock.calls[0][0];
    const planningPrompt = request.messages[0].content;
    expect(request.action).toBe('callLLM');
    expect(request.systemPrompt).toBe(window.GUIDE_V2_PLANNING_PROMPT);
    expect(planningPrompt).toContain('=== TUTORIAL REFERENCE ===');
    expect(planningPrompt).toContain('Pre-verified steps for "How do I turn off autoplay on Spotify?"');
    expect(planningPrompt).toContain('Step 1: Click your profile picture at the top, and select Settings.');
    expect(planningPrompt).toContain('Use these as a reference guide but map the plan to the actual elements visible in the PAGE INDEX above.');
    expect(g.plan).toEqual([
      { n: 1, goal: 'Open settings', status: 'pending' },
      { n: 2, goal: 'Turn off autoplay', status: 'pending' }
    ]);

    const meta = window.rewindUpdateSessionMeta.mock.calls[0][1];
    expect(meta.planningSystemPrompt).toBe(window.GUIDE_V2_PLANNING_PROMPT);
    expect(meta.planningPrompt).toContain('=== TUTORIAL REFERENCE ===');
  });

  test('initial planning continues without tutorial reference when none is matched', async () => {
    window.safeSendMessage = jest.fn(async () => ({
      content: JSON.stringify({
        planTitle: 'Search',
        steps: [{ goal: 'Enter search query' }]
      })
    }));
    window.rewindUpdateSessionMeta = jest.fn(async () => {});

    const g = {
      active: true,
      planningMode: 'planning',
      question: 'Search for a product',
      sessionId: 'planning-no-tutorial-test',
      tutorialRef: null
    };

    const ok = await window._gv2GenerateInitialPlan(
      g,
      { indexText: '[1] Search' },
      { isDark: true }
    );

    expect(ok).toBe(true);
    const planningPrompt = window.safeSendMessage.mock.calls[0][0].messages[0].content;
    expect(planningPrompt).not.toContain('=== TUTORIAL REFERENCE ===');
    expect(planningPrompt).toContain('PAGE BACKGROUND: DARK');
    expect(g.plan).toEqual([{ n: 1, goal: 'Enter search query', status: 'pending' }]);
  });

  test('grounding warning diagnostic names the step instruction and resolved DOM element', () => {
    const prompt = window._gv2WarningPromptBlock({
      step: { instruction: 'Submit button' },
      reportedElementText: 'Submit',
      resolvedElementText: 'Cancel',
      elementStepSimilarity: 0.74
    }, { types: ['grounding'] });

    expect(prompt).toContain('It failed grounding (similarity 0.74): you described "Submit button" but the page resolved "Cancel".');
    expect(prompt).toContain('Only reference SoM labels that are actually visible');
    expect(prompt).not.toContain('You described "Submit"');
  });

  test('grounding warning diagnostic renders missing similarity as unknown instead of 0.00', () => {
    const prompt = window._gv2WarningPromptBlock({
      step: { instruction: 'Click submit' },
      reportedElementText: 'Submit',
      resolvedElementText: 'Submit',
      elementStepSimilarity: null
    }, { types: ['grounding'] });

    expect(prompt).toContain('It failed grounding (similarity unknown): you described "Click submit" but the page resolved "Submit".');
    expect(prompt).not.toContain('similarity 0.00');
  });

  test('reflector retry prompt folds the diagnostic into a Reflection and asks for a different action', () => {
    const diagnostic = window._gv2WarningPromptBlock({
      currentKey: 'click: search',
      loopMatchCount: 3
    }, { types: ['loop'] });
    const prompt = window._gv2WarningRetryPrompt('ORIGINAL PROMPT BODY', diagnostic, '{"action":"click"}', 7);

    expect(prompt).toContain('ORIGINAL PROMPT BODY');
    expect(prompt).toContain('Reflection: This is not your first attempt to generate the next action.');
    expect(prompt).toContain('It repeated the target "click: search" in 3 previous step(s) without progress.');
    expect(prompt).toContain('Here are some previously generated next actions:');
    expect(prompt).toContain('{"action":"click"}');
    expect(prompt).toContain('generate a new action that is DIFFERENT from all previously generated next actions');
    expect(prompt).toContain('Return corrected JSON for Step 7.');
    expect(prompt).not.toContain('WARNING BEFORE EXECUTION');
  });

  test('live grounding similarity reports why no score was available', async () => {
    const result = await window._gv2ElementStepSimilarityResult('Click submit', 'Submit', false);

    expect(result).toEqual(expect.objectContaining({
      value: null,
      reason: 'no_index'
    }));
    expect(window.chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'callEmbed'
    }));
  });

  test('clear_text helper empties input and dispatches input/change events', () => {
    const input = document.createElement('input');
    input.value = 'old value';
    const events = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    document.body.appendChild(input);

    expect(window._gv2SetEditableValue(input, '')).toBe(true);

    expect(input.value).toBe('');
    expect(events).toEqual(['input', 'change']);
    input.remove();
  });

  test('clear_text helper empties contenteditable and dispatches change', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.textContent = 'draft';
    const events = [];
    editable.addEventListener('input', () => events.push('input'));
    editable.addEventListener('change', () => events.push('change'));
    document.body.appendChild(editable);

    expect(window._gv2SetEditableValue(editable, '')).toBe(true);

    expect(editable.textContent).toBe('');
    expect(events).toContain('change');
    editable.remove();
  });

  test('stop unlocks the auto-mode page overlay immediately', () => {
    window.gv2ShowAutoOverlay();
    const overlay = document.getElementById('pageguide-gv2-auto');
    expect(overlay).toBeTruthy();
    expect(overlay.classList.contains('on')).toBe(true);

    window.gv2StopGuide();

    expect(overlay.classList.contains('on')).toBe(false);
    expect(overlay.style.pointerEvents).toBe('none');
  });

  test('blocks step 16 before generating another guide step', async () => {
    window._guidev2 = {
      active: true,
      question: 'long running guide',
      previousSteps: Array.from({ length: 15 }, (_, i) => `Step ${i + 1}: done`),
      currentPlanStep: 15,
      autoMode: true,
      _currentStep: { action: 'click', instruction: 'Keep going' }
    };

    const result = await window.handleStepByStepGuide('long running guide', true);

    expect(result.success).toBe(false);
    expect(result.progressed).toBe(false);
    expect(result.stoppedByMaxSteps).toBe(true);
    expect(result.error).toContain('autonomous loop');
    expect(window.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'addMessage',
      content: expect.stringContaining('Stopped after 15 steps')
    }));
  });

  test('restore comparison returns a recoverable error when screenshots are missing', async () => {
    window._guidev2 = {
      active: true,
      _awaitingRestoreConfirm: true,
      _restoreContext: { redoStep: 2, redoBeforeShot: null, restoreShot: 'CURRENT' }
    };

    const result = await window.gv2CompareSteerRestoreState();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Need both saved and current screenshots');
    expect(window.chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'callLLMWithImages'
    }));
  });
});

// Follow-up: on-demand grounding trigger + auto-step budget.
describe('RewindStore (rewind/rewind_store.js)', () => {
  let mem;
  beforeEach(() => {
    mem = {};
    window.chrome = {
      storage: {
        local: {
          get: (keys, cb) => {
            let res = {};
            if (keys == null) res = { ...mem };
            else if (typeof keys === 'string') { if (keys in mem) res[keys] = mem[keys]; }
            else if (Array.isArray(keys)) keys.forEach(k => { if (k in mem) res[k] = mem[k]; });
            cb(res);
          },
          set: (obj, cb) => { Object.assign(mem, obj); cb && cb(); },
          remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete mem[k]); cb && cb(); }
        }
      }
    };
    loadScript('rewind/rewind_store.js');
  });

  test('stores records and builds a step index', async () => {
    await window.rewindStartSession('s1', 'my goal');
    await window.rewindPutRecord({ sessionId: 's1', step: 1, instruction: 'first', screenshot: 'IMG', domSnapshot: '<html></html>' });
    await window.rewindPutRecord({ sessionId: 's1', step: 2, instruction: 'second' });

    const idx = await window.rewindGetIndex();
    expect(idx.sessionId).toBe('s1');
    expect(idx.goal).toBe('my goal');
    expect(idx.steps.map(s => s.step)).toEqual([1, 2]);

    const rec = await window.rewindGetRecord('s1', 1);
    expect(rec.instruction).toBe('first');
    expect(rec.screenshot).toBe('IMG');
  });

  test('overwriting a step updates its meta without duplicating', async () => {
    await window.rewindStartSession('s1', 'g');
    await window.rewindPutRecord({ sessionId: 's1', step: 1, instruction: 'before' });
    await window.rewindPutRecord({ sessionId: 's1', step: 1, instruction: 'after' });
    const idx = await window.rewindGetIndex();
    expect(idx.steps.length).toBe(1);
    expect(idx.steps[0].instruction).toBe('after');
  });

  test('clear removes index and all records', async () => {
    await window.rewindStartSession('s1', 'g');
    await window.rewindPutRecord({ sessionId: 's1', step: 1, instruction: 'a' });
    await window.rewindClear();
    expect(await window.rewindGetIndex()).toBeNull();
    expect(await window.rewindGetRecord('s1', 1)).toBeNull();
  });

  test('truncateAfter drops later steps from records and index', async () => {
    await window.rewindStartSession('s1', 'g');
    for (let i = 1; i <= 4; i++) await window.rewindPutRecord({ sessionId: 's1', step: i, instruction: 's' + i });
    await window.rewindTruncateAfter('s1', 2);
    const idx = await window.rewindGetIndex();
    expect(idx.steps.map(s => s.step)).toEqual([1, 2]);
    expect(await window.rewindGetRecord('s1', 2)).not.toBeNull();
    expect(await window.rewindGetRecord('s1', 3)).toBeNull();
  });

  test('createBranchSession copies prefix and leaves parent intact', async () => {
    await window.rewindStartSession('parent', 'original');
    for (let i = 0; i <= 5; i++) {
      await window.rewindPutRecord({
        sessionId: 'parent',
        step: i,
        instruction: i === 0 ? 'initial' : 's' + i,
        screenshot: 'IMG' + i,
        isInitial: i === 0
      });
    }

    const branch = await window.rewindCreateBranchSession('parent', 'branch', 3, {
      redoStep: 4,
      branchLabel: 'View journey before Step 4'
    });

    expect(branch.sessionId).toBe('branch');
    expect(branch.parentSessionId).toBe('parent');
    expect(branch.branchFromStep).toBe(3);
    expect(branch.redoStep).toBe(4);
    expect(branch.branchStatus).toBe('pending_restore');
    expect(branch.steps.map(s => s.step)).toEqual([0, 1, 2, 3]);

    const parent = await window.rewindGetIndex('parent');
    expect(parent.steps.map(s => s.step)).toEqual([0, 1, 2, 3, 4, 5]);
    expect((await window.rewindGetRecord('branch', 3)).sessionId).toBe('branch');
    expect(await window.rewindGetRecord('branch', 4)).toBeNull();
  });

  test('deleteRecord removes one step from records and index', async () => {
    await window.rewindStartSession('s1', 'g');
    for (let i = 1; i <= 3; i++) await window.rewindPutRecord({ sessionId: 's1', step: i, instruction: 's' + i });
    await window.rewindDeleteRecord('s1', 2);
    const idx = await window.rewindGetIndex('s1');
    expect(idx.steps.map(s => s.step)).toEqual([1, 3]);
    expect(await window.rewindGetRecord('s1', 2)).toBeNull();
    expect(await window.rewindGetRecord('s1', 1)).not.toBeNull();
  });

  test('index meta carries hasShot (true with a screenshot, false without) for void-step pruning', async () => {
    await window.rewindStartSession('shot', 'g');
    await window.rewindPutRecord({ sessionId: 'shot', step: 1, instruction: 'has', screenshot: 'AAAA' });
    await window.rewindPutRecord({ sessionId: 'shot', step: 2, instruction: 'void' }); // no screenshot
    const idx = await window.rewindGetIndex('shot');
    const m1 = idx.steps.find(s => s.step === 1);
    const m2 = idx.steps.find(s => s.step === 2);
    expect(m1.hasShot).toBe(true);
    expect(m2.hasShot).toBe(false);
  });

  test('resolveScreenshot accepts before, legacy, or after screenshots', () => {
    expect(window.rewindResolveScreenshot({ screenshotBefore: 'BEFORE', screenshot: 'LEGACY', screenshotAfter: 'AFTER' })).toBe('BEFORE');
    expect(window.rewindResolveScreenshot({ screenshot: 'LEGACY', screenshotAfter: 'AFTER' })).toBe('LEGACY');
    expect(window.rewindResolveScreenshot({ screenshotAfter: 'AFTER' })).toBe('AFTER');
    expect(window.rewindResolveScreenshot({})).toBeNull();
  });

  test('resolveRegionScreenshot prefers region crop then falls back to before shot', () => {
    expect(window.rewindResolveRegionScreenshot({ regionShot: 'REGION', screenshotBefore: 'BEFORE' })).toBe('REGION');
    expect(window.rewindResolveRegionScreenshot({ screenshotBefore: 'BEFORE' })).toBe('BEFORE');
    expect(window.rewindResolveRegionScreenshot({ regionShot: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', screenshotBefore: 'BEFORE' })).toBe('BEFORE');
    expect(window.rewindResolveRegionScreenshot({})).toBeNull();
  });

  test('verifyScreenshots removes non-initial records with no screenshot and keeps fallback shots', async () => {
    await window.rewindStartSession('verify', 'g');
    await window.rewindPutRecord({ sessionId: 'verify', step: 0, instruction: 'init', isInitial: true, domSnapshot: '<html></html>' });
    await window.rewindPutRecord({ sessionId: 'verify', step: 1, instruction: 'before', screenshotBefore: 'BEFORE' });
    await window.rewindPutRecord({ sessionId: 'verify', step: 2, instruction: 'void' });
    await window.rewindPutRecord({ sessionId: 'verify', step: 3, instruction: 'after', screenshotAfter: 'AFTER' });

    const idx = await window.rewindVerifyScreenshots('verify');
    expect(idx.steps.map(s => s.step)).toEqual([0, 1, 3]);
    expect(await window.rewindGetRecord('verify', 2)).toBeNull();
    expect((await window.rewindGetRecord('verify', 1)).screenshotBefore).toBe('BEFORE');
    expect((await window.rewindGetRecord('verify', 3)).screenshotAfter).toBe('AFTER');
  });

  test('steer handoff round-trips and clears (one-shot)', async () => {
    expect(await window.rewindGetSteerPending()).toBeNull();
    const payload = { sessionId: 's1', fromStep: 3, newGoal: 'do X instead', url: 'https://x.com/p', createdAt: 1 };
    await window.rewindSetSteerPending(payload);
    expect(await window.rewindGetSteerPending()).toEqual(payload);
    await window.rewindClearSteerPending();
    expect(await window.rewindGetSteerPending()).toBeNull();
  });

  test('retains multiple sessions; getIndex(id) recalls each, no-arg returns current', async () => {
    await window.rewindStartSession('A', 'goal A');
    await window.rewindPutRecord({ sessionId: 'A', step: 1, instruction: 'a1' });
    await window.rewindPutRecord({ sessionId: 'A', step: 2, instruction: 'a2' });
    await window.rewindStartSession('B', 'goal B');
    await window.rewindPutRecord({ sessionId: 'B', step: 1, instruction: 'b1' });

    // Earlier session A is NOT wiped by starting B.
    const a = await window.rewindGetIndex('A');
    expect(a.goal).toBe('goal A');
    expect(a.steps.map(s => s.step)).toEqual([1, 2]);
    expect(a.steps[0].sessionId).toBe('A'); // meta carries sessionId for recall
    expect(await window.rewindGetRecord('A', 2)).not.toBeNull();

    // No-arg getIndex returns the current (most-recent) session.
    const cur = await window.rewindGetIndex();
    expect(cur.goal).toBe('goal B');

    const sessions = await window.rewindGetSessions();
    expect(sessions.map(s => s.sessionId)).toEqual(['A', 'B']); // oldest→newest
  });

  test('prunes the oldest session beyond the cap (8)', async () => {
    for (let i = 1; i <= 9; i++) {
      await window.rewindStartSession('S' + i, 'g' + i);
      await window.rewindPutRecord({ sessionId: 'S' + i, step: 1, instruction: 'x' });
    }
    const sessions = await window.rewindGetSessions();
    expect(sessions.length).toBe(8);
    expect(sessions[0].sessionId).toBe('S2');           // S1 pruned
    expect(await window.rewindGetIndex('S1')).toBeNull();
    expect(await window.rewindGetRecord('S1', 1)).toBeNull();
    expect(await window.rewindGetIndex('S9')).not.toBeNull();
  });

  test('clear wipes every session', async () => {
    await window.rewindStartSession('A', 'g');
    await window.rewindPutRecord({ sessionId: 'A', step: 1, instruction: 'a1' });
    await window.rewindStartSession('B', 'g');
    await window.rewindClear();
    expect(await window.rewindGetIndex('A')).toBeNull();
    expect(await window.rewindGetIndex('B')).toBeNull();
    expect(await window.rewindGetIndex()).toBeNull();
    expect(await window.rewindGetSessions()).toEqual([]);
  });
});

// Rewind action-replay: resolve a stored target.text against a fresh page index.
describe('gv2MatchIndexText (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  const idxText = '[1] Sign in\n[2] (button) Create account\n[3] Search the catalogue for items';

  test('exact match (interactive line)', () => {
    expect(window.gv2MatchIndexText(idxText, 'Sign in')).toBe(1);
  });
  test('ignores the annotated role prefix', () => {
    expect(window.gv2MatchIndexText(idxText, 'Create account')).toBe(2);
  });
  test('case-insensitive', () => {
    expect(window.gv2MatchIndexText(idxText, 'SIGN IN')).toBe(1);
  });
  test('truncation-tolerant prefix match', () => {
    expect(window.gv2MatchIndexText(idxText, 'Search the catalogue...')).toBe(3);
  });
  test('containment fallback', () => {
    expect(window.gv2MatchIndexText(idxText, 'catalogue for items')).toBe(3);
  });
  test('no match returns null', () => {
    expect(window.gv2MatchIndexText(idxText, 'Checkout now')).toBeNull();
    expect(window.gv2MatchIndexText('', 'Sign in')).toBeNull();
  });
});

// Resume match gate (content/tasks/guidev2.js): after a reload-path steer restores the page,
// only auto-continue when it actually resembles the branch step. URL is the decisive signal;
// the page must also have rendered some interactive content. (guidev2.js is loaded by an
// earlier suite into the shared jsdom window.)
describe('_gv2VerifyResumeMatch (content/tasks/guidev2.js)', () => {
  test('passes when the URL matches and the page has actionable content', () => {
    document.body.innerHTML = '<button>Continue</button>';
    expect(window._gv2VerifyResumeMatch({ url: window.location.href }, window.location.href)).toBe(true);
  });

  test('fails when the landing URL does not match (hash ignored)', () => {
    document.body.innerHTML = '<button>Continue</button>';
    expect(window._gv2VerifyResumeMatch({}, 'https://elsewhere.example/other')).toBe(false);
  });

  test('is permissive when there is no landing URL to compare', () => {
    document.body.innerHTML = '<button>Continue</button>';
    expect(window._gv2VerifyResumeMatch(null, null)).toBe(true);
  });
});

describe('gv2ProcessResponse pause/handover conditions (content/tasks/guidev2.js)', () => {
  function getPauseMessage() {
    const call = window.chrome.runtime.sendMessage.mock.calls.find(
      c => c[0] && c[0].action === 'guidePaused'
    );
    return call ? call[0].reason : '';
  }

  beforeAll(() => {
    window.chrome = {
      runtime: {
        sendMessage: jest.fn()
      },
      storage: {
        session: {
          get: jest.fn(async () => ({})),
          set: jest.fn(async () => {}),
          remove: jest.fn(async () => {})
        }
      }
    };
    window.getPageBackground = () => ({ isDark: false });
    window.gv2FindElementByText = () => null;
    window.applyIndexedHighlight = () => 0;
    window.cleanupSom = () => {};
    window.clearHighlights = () => {};
    window.rewindPutRecord = jest.fn(async () => {});
    window.captureScreenshot = jest.fn(async () => 'PLACEHOLDER');
    loadScript('content/tasks/guidev2.js');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    window._guidev2 = {
      active: true,
      question: 'Test Goal',
      previousSteps: [],
      autoMode: true,
      paused: false,
      lowConfidenceCount: 0
    };
  });

  test('consecutive low confidence steps pause after 3 occurrences', async () => {
    const originalCompute = window.gv2ComputeConfidence;
    window.gv2ComputeConfidence = () => ({ confidence: 0.5, grounded: 0.5, loop: 0.0, progress: 0.0, formula: 'full' });

    try {
      const stepJson1 = JSON.stringify({
        step: 1,
        thought: 'First low confidence step',
        instruction: 'Do step 1',
        element: { index: 1, text: 'Button' },
        action: 'click'
      });
      await window.gv2ProcessResponse(stepJson1);
      expect(window._guidev2.lowConfidenceCount).toBe(1);
      expect(window._guidev2.paused).toBe(false);
      expect(getPauseMessage()).toBe('');

      const stepJson2 = JSON.stringify({
        step: 2,
        thought: 'Second low confidence step',
        instruction: 'Do step 2',
        element: { index: 2, text: 'Button 2' },
        action: 'click'
      });
      await window.gv2ProcessResponse(stepJson2);
      expect(window._guidev2.lowConfidenceCount).toBe(2);
      expect(window._guidev2.paused).toBe(false);
      expect(getPauseMessage()).toBe('');

      const stepJson3 = JSON.stringify({
        step: 3,
        thought: 'Third low confidence step',
        instruction: 'Do step 3',
        element: { index: 3, text: 'Button 3' },
        action: 'click'
      });
      await window.gv2ProcessResponse(stepJson3);
      expect(window._guidev2.lowConfidenceCount).toBe(3);
      expect(window._guidev2.paused).toBe(true);
      expect(getPauseMessage()).toBe('Page Guide paused: 3 low-confidence actions detected. Review and resume when ready.');
    } finally {
      window.gv2ComputeConfidence = originalCompute;
    }
  });

  test('high risk json action pauses immediately', async () => {
    const stepJson = JSON.stringify({
      step: 1,
      thought: 'High risk task',
      instruction: 'Enter bank password',
      element: { index: 1, text: 'Password input' },
      action: 'type',
      typeText: 'secret',
      risk: 'high'
    });

    await window.gv2ProcessResponse(stepJson);
    expect(window._guidev2.paused).toBe(true);
    expect(getPauseMessage()).toBe('This step is high risk. Please perform it yourself, then press Resume.');
  });

  test('confirmation needed pauses immediately', async () => {
    const stepJson = JSON.stringify({
      step: 1,
      thought: 'Needs confirmation',
      instruction: 'Submit application',
      element: { index: 2, text: 'Submit' },
      action: 'click',
      confirmation: 'needed'
    });

    await window.gv2ProcessResponse(stepJson);
    expect(window._guidev2.paused).toBe(true);
    expect(getPauseMessage()).toBe('Confirmation needed. Please verify and press Resume.');
  });

  test('normalizes skipped LLM step numbers before storing records', async () => {
    window._guidev2.previousSteps = ['Step 1: Enter pickup location'];
    window._guidev2.captureEnabled = true;
    window._guidev2.sessionId = 'step-normalize-test';

    const stepJson = JSON.stringify({
      step: 3,
      thought: 'The model skipped a hidden step number.',
      instruction: 'Select the pickup date',
      element: { index: 3, text: 'April 5' },
      action: 'click'
    });

    const result = await window.gv2ProcessResponse(stepJson);
    expect(result.step).toBe(2);
    expect(result.planStep).toBe(2);
    expect(window._guidev2.previousSteps[window._guidev2.previousSteps.length - 1]).toBe('Step 2: Select the pickup date');

    const recordCalls = window.rewindPutRecord.mock.calls;
    const record = recordCalls[recordCalls.length - 1][0];
    expect(record.step).toBe(2);
    expect(record.planStep).toBe(2);
    expect(record.llmStep).toBe(3);
    expect(record.expectedStep).toBe(2);
    expect(record.stepNumberCorrected).toBe(true);
  });

  test('resuming guide resets lowConfidenceCount to 0', async () => {
    window._guidev2.lowConfidenceCount = 2;
    window._guidev2.paused = true;
    window.safeSendMessage = jest.fn(async () => ({}));
    
    // Ignore internal errors or missing implementation details from _gv2GenerateAndDispatch
    try {
      await window.gv2ResumeGuide();
    } catch (e) {}
    
    expect(window._guidev2.lowConfidenceCount).toBe(0);
  });

  test('retrying guide step resets lowConfidenceCount to 0', async () => {
    window._guidev2.lowConfidenceCount = 2;
    window._guidev2.paused = true;
    window.safeSendMessage = jest.fn(async () => ({}));
    
    try {
      await window.gv2RetryGuideStep();
    } catch (e) {}

    expect(window._guidev2.lowConfidenceCount).toBe(0);
  });
});

describe('Dashboard UI helpers (eval_server/static/dashboard_ui.js)', () => {
  beforeAll(() => {
    loadScript('eval_server/static/dashboard_ui.js');
  });

  describe('sparklinePoints', () => {
    test('maps a 0..1 series to evenly-spaced, y-inverted [0,1] points', () => {
      const pts = window.DashboardUI.sparklinePoints([0, 0.5, 1], 84, 24, 2);
      // innerW=80, innerH=20, pad=2: x at 2, 42, 82; y inverted (0 -> 22 bottom, 1 -> 2 top).
      expect(pts).toBe('2,22 42,12 82,2');
    });

    test('drops null / non-finite entries but keeps original x spacing', () => {
      const pts = window.DashboardUI.sparklinePoints([0.5, null, 1], 84, 24, 2);
      // Two points remain at original indices 0 and 2 -> x at 2 and 82.
      expect(pts).toBe('2,12 82,2');
    });

    test('returns "" when fewer than two finite points remain', () => {
      expect(window.DashboardUI.sparklinePoints([0.5], 84, 24, 2)).toBe('');
      expect(window.DashboardUI.sparklinePoints([null, undefined], 84, 24, 2)).toBe('');
      expect(window.DashboardUI.sparklinePoints([], 84, 24, 2)).toBe('');
    });

    test('clamps values outside [0,1]', () => {
      const pts = window.DashboardUI.sparklinePoints([-1, 2], 84, 24, 2);
      // -1 clamps to 0 (y=22), 2 clamps to 1 (y=2).
      expect(pts).toBe('2,22 82,2');
    });
  });

  describe('sparklineDots', () => {
    test('returns one {x,y,v,i} per finite point, y-inverted and [0,1] scaled', () => {
      const dots = window.DashboardUI.sparklineDots([0, 0.5, 1], 84, 24, 2);
      expect(dots).toEqual([
        { i: 0, v: 0, x: 2, y: 22 },
        { i: 1, v: 0.5, x: 42, y: 12 },
        { i: 2, v: 1, x: 82, y: 2 },
      ]);
    });

    test('drops null / non-finite entries but keeps original x spacing', () => {
      const dots = window.DashboardUI.sparklineDots([0.5, null, 1], 84, 24, 2);
      expect(dots.map(d => d.i)).toEqual([0, 2]);
      expect(dots.map(d => d.x)).toEqual([2, 82]);
    });
  });

  describe('isYellowDot', () => {
    test('grounding is bad below 0.8', () => {
      expect(window.DashboardUI.isYellowDot('grounding', 0.79)).toBe(true);
      expect(window.DashboardUI.isYellowDot('grounding', 0.8)).toBe(false);
    });
    test('loop is bad at or above 0.3', () => {
      expect(window.DashboardUI.isYellowDot('loop', 0.3)).toBe(true);
      expect(window.DashboardUI.isYellowDot('loop', 0.29)).toBe(false);
    });
    test('uncertainty is bad above 0.5', () => {
      expect(window.DashboardUI.isYellowDot('uncertainty', 0.51)).toBe(true);
      expect(window.DashboardUI.isYellowDot('uncertainty', 0.5)).toBe(false);
    });
    test('null / non-finite / unknown metric are not flagged', () => {
      expect(window.DashboardUI.isYellowDot('grounding', null)).toBe(false);
      expect(window.DashboardUI.isYellowDot('loop', undefined)).toBe(false);
      expect(window.DashboardUI.isYellowDot('mystery', 0.9)).toBe(false);
    });
  });

  describe('runMatchesFeatureFilter', () => {
    test('empty selection matches every run', () => {
      expect(window.DashboardUI.runMatchesFeatureFilter({}, [])).toBe(true);
      expect(window.DashboardUI.runMatchesFeatureFilter({ planning: true }, [])).toBe(true);
    });

    test('AND semantics: all selected features must be present', () => {
      const flags = { planning: true, grounding: true, loop: false };
      expect(window.DashboardUI.runMatchesFeatureFilter(flags, ['planning', 'grounding'])).toBe(true);
      expect(window.DashboardUI.runMatchesFeatureFilter(flags, ['planning', 'loop'])).toBe(false);
      expect(window.DashboardUI.runMatchesFeatureFilter(flags, ['loop'])).toBe(false);
    });

    test('missing flag is treated as not-included', () => {
      expect(window.DashboardUI.runMatchesFeatureFilter({}, ['planning'])).toBe(false);
      expect(window.DashboardUI.runMatchesFeatureFilter(undefined, ['grounding'])).toBe(false);
    });
  });
});
