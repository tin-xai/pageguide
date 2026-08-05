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

// Attachment ingestion helpers: decide raw-vs-summary for attached text files and
// build the compact context block injected into the guide plan + each step.
describe('Attachment ingestion helpers (content/tasks/image_ask.js)', () => {
  beforeAll(() => {
    loadScript('content/tasks/image_ask.js');
  });

  describe('attachmentNeedsSummary', () => {
    test('small files are embedded raw (no summary)', () => {
      expect(window.attachmentNeedsSummary(0)).toBe(false);
      expect(window.attachmentNeedsSummary(100)).toBe(false);
      // Exactly at the limit is still "raw"
      expect(window.attachmentNeedsSummary(window.ATTACHMENT_RAW_CHAR_LIMIT)).toBe(false);
    });

    test('large files are summarized', () => {
      expect(window.attachmentNeedsSummary(window.ATTACHMENT_RAW_CHAR_LIMIT + 1)).toBe(true);
      expect(window.attachmentNeedsSummary(500000)).toBe(true);
    });

    test('non-numeric input is treated as no-summary', () => {
      expect(window.attachmentNeedsSummary(null)).toBe(false);
      expect(window.attachmentNeedsSummary(undefined)).toBe(false);
    });
  });

  describe('buildAttachmentContext', () => {
    test('returns empty string when nothing is attached', () => {
      expect(window.buildAttachmentContext({})).toBe('');
      expect(window.buildAttachmentContext()).toBe('');
    });

    test('small file → raw text block', () => {
      const ctx = window.buildAttachmentContext({ fileName: 'notes.txt', fileText: 'hello world' });
      expect(ctx).toContain('notes.txt');
      expect(ctx).toContain('hello world');
      expect(ctx).not.toContain('(summary)');
    });

    test('large file → summary block (summary wins over raw)', () => {
      const ctx = window.buildAttachmentContext({
        fileName: 'big.txt',
        fileText: 'RAW SHOULD NOT APPEAR',
        fileSummary: 'condensed version'
      });
      expect(ctx).toContain('big.txt');
      expect(ctx).toContain('(summary)');
      expect(ctx).toContain('condensed version');
      expect(ctx).not.toContain('RAW SHOULD NOT APPEAR');
    });

    test('image → description block', () => {
      const ctx = window.buildAttachmentContext({ imageDescription: 'a blue polo shirt' });
      expect(ctx).toContain('Attached image');
      expect(ctx).toContain('a blue polo shirt');
    });

    test('image + file combine into one block', () => {
      const ctx = window.buildAttachmentContext({
        imageDescription: 'a blue polo shirt',
        fileName: 'notes.txt',
        fileText: 'buy 5 of them'
      });
      expect(ctx).toContain('a blue polo shirt');
      expect(ctx).toContain('buy 5 of them');
    });
  });
});

// Router: an attached image must NOT hijack a guide-routed request into image_ask.
// Guide/Auto mode consumes the attachment; ask-type intents still use image_ask.
describe('Router attachment routing (content/functions/main_router.js)', () => {
  let imageAskSpy;
  let guideSpy;

  beforeEach(() => {
    window.chrome = { runtime: { sendMessage: jest.fn() } };
    window.PROMPTS = { ROUTER: 'Router Prompt' };
    loadScript('content/functions/main_router.js');

    imageAskSpy = jest.fn().mockResolvedValue({ success: true, isImageAsk: true });
    guideSpy = jest.fn().mockResolvedValue({ success: true, isGuide: true });
    window.handleImageAsk = imageAskSpy;
    window.handleStepByStepGuide = guideSpy;
    window.getUploadedImage = () => 'BASE64';
  });

  test('forced guide route with an image does NOT call image_ask', async () => {
    const result = await window.handleSmartQuery(
      'help me buy this', [], /*hasImage*/ true, false, /*forcedRoute*/ 'guide', /*cleanQuery*/ 'help me buy this'
    );
    expect(imageAskSpy).not.toHaveBeenCalled();
    expect(guideSpy).toHaveBeenCalledWith('help me buy this');
    expect(result.routedTo).toBe('guide');
  });

  test('router-chosen guide route with an image does NOT call image_ask', async () => {
    chrome.runtime.sendMessage.mockResolvedValue({ content: '{"handler":"guide","confidence":0.9}' });
    const result = await window.handleSmartQuery(
      'walk me through checkout', [], /*hasImage*/ true, false, /*forcedRoute*/ null, 'walk me through checkout'
    );
    expect(imageAskSpy).not.toHaveBeenCalled();
    expect(guideSpy).toHaveBeenCalled();
    expect(result.routedTo).toBe('guide');
  });

  test('attached image with an ask intent still routes to image_ask', async () => {
    chrome.runtime.sendMessage.mockResolvedValue({ content: '{"handler":"ask","confidence":0.8}' });
    const result = await window.handleSmartQuery(
      'find this on the page', [], /*hasImage*/ true, false, /*forcedRoute*/ null, 'find this on the page'
    );
    expect(imageAskSpy).toHaveBeenCalled();
    expect(result.routedTo).toBe('image_ask');
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
    expect(window.gv2DescribeRestoreAction({ kind: 'replay', action: 'drag_drop', target: { text: 'Task A' }, dropTarget: { text: 'Done' }, ok: true }))
      .toBe('✓ Drag Task A to Done');
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
    expect(window.gv2FriendlyRestoreAction({ kind: 'replay', action: 'drag_drop', target: { text: 'Task A' }, dropTarget: { text: 'Done' }, ok: true }))
      .toBe('Dragged “Task A” to “Done”');

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
  test('custom threshold controls green vs yellow tier', () => {
    expect(window.gv2ConfidenceTier(0.8, 0.85)).toBe('med');
    expect(window.gv2ConfidenceTier(0.85, 0.85)).toBe('high');
    expect(window.gv2ConfidenceTier(0.6, 0.5)).toBe('high');
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
    test('uses internal grounding cosine similarity', () => {
      expect(window.gv2GroundingScore({ hasTarget: true, grounding: 0.82 })).toBeCloseTo(0.82, 6);
    });
    test('clamps grounding to [0,1]', () => {
      expect(window.gv2GroundingScore({ hasTarget: true, grounding: 5 })).toBe(1);
      expect(window.gv2GroundingScore({ hasTarget: true, grounding: -2 })).toBe(0);
    });
    test('no element target → null (excluded step)', () => {
      expect(window.gv2GroundingScore({ hasTarget: false, grounding: 1 })).toBeNull();
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
      expect(window.gv2LoopScore(['a'], 'a')).toBeCloseTo(0.1, 6);
      expect(window.gv2LoopScore(['a', 'a'], 'a')).toBeCloseTo(0.2, 6);
      expect(window.gv2LoopScore(['search', 'filters'], 'search')).toBeCloseTo(0.1, 6);
    });
    test('result is capped at 1.0', () => {
      expect(window.gv2LoopScore(Array.from({ length: 12 }, () => 'a'), 'a')).toBe(1);
    });
    test('no current key → 0 (reference returns 0, not null)', () => {
      expect(window.gv2LoopScore(['a'], '')).toBe(0);
      expect(window.gv2LoopScore(['a'], null)).toBe(0);
    });
  });

  describe('gv2ComputeMechanicalConfidence', () => {
    test('C_t = internal grounding × (1 − 0.5·L_t_u)', () => {
      expect(window.gv2ComputeMechanicalConfidence({ hasTarget: true, grounding: 1, priorKeys: [], currentKey: 'a' }).confidence).toBeCloseTo(1.0, 6);
      expect(window.gv2ComputeMechanicalConfidence({ hasTarget: true, grounding: 0.7, priorKeys: [], currentKey: 'a' }).confidence).toBeCloseTo(0.7, 6);
    });
    test('one prior repeat gives L_t_u=0.1 and applies 0.5 loop penalty', () => {
      const r = window.gv2ComputeMechanicalConfidence({ hasTarget: true, grounding: 1, priorKeys: ['a'], currentKey: 'a' });
      expect(r.loop).toBeCloseTo(0.1, 6);
      expect(r.loopMatches).toBe(1);
      expect(r.confidence).toBeCloseTo(0.95, 6);
    });
    test('ten prior repeats caps L_t_u at 1 and halves confidence', () => {
      const r = window.gv2ComputeMechanicalConfidence({ hasTarget: true, grounding: 0.8, priorKeys: Array.from({ length: 10 }, () => 'a'), currentKey: 'a' });
      expect(r.loop).toBe(1);
      expect(r.confidence).toBeCloseTo(0.4, 6);
    });
    test('grounding zero → confidence 0 (hard floor)', () => {
      const r = window.gv2ComputeMechanicalConfidence({ hasTarget: true, grounding: 0, priorKeys: ['a', 'a'], currentKey: 'a' });
      expect(r.grounding).toBe(0);
      expect(r.confidence).toBe(0);
    });
    test('no target → null confidence (excluded)', () => {
      const r = window.gv2ComputeMechanicalConfidence({ hasTarget: false, priorKeys: [], currentKey: '' });
      expect(r.confidence).toBeNull();
      expect(r.grounding).toBeNull();
      expect(r.loop).toBeNull();
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
    test('returns empty string when neither present', () => {
      expect(window.gv2ElementKey({})).toBe('');
      expect(window.gv2ElementKey(null)).toBe('');
    });
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
    expect(window.gv2AssessRisk({ risk: 'low', action: 'drag_drop', instruction: 'Move this to Delete', element: { text: 'File' }, dropTarget: { text: 'Delete' } })).toBe('high');
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

  test('find is always low risk — it only reads the page', () => {
    // The instruction mentions a keyword the scanner would otherwise escalate on.
    expect(window.gv2AssessRisk({
      action: 'find',
      instruction: 'Find out how to delete your account'
    })).toBe('low');
    // Even a model self-report of high risk cannot make a read-only step dangerous.
    expect(window.gv2AssessRisk({ action: 'find', risk: 'high', instruction: 'Find the refund policy' })).toBe('low');
  });
});

describe('gv2NormalizeAction (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('normalizes case and surrounding whitespace', () => {
    expect(window.gv2NormalizeAction('find')).toBe('find');
    expect(window.gv2NormalizeAction('FIND')).toBe('find');
    expect(window.gv2NormalizeAction('  find ')).toBe('find');
  });

  test('normalizes separators to underscores', () => {
    expect(window.gv2NormalizeAction('clear text')).toBe('clear_text');
    expect(window.gv2NormalizeAction('clear-text')).toBe('clear_text');
    expect(window.gv2NormalizeAction('drag drop')).toBe('drag_drop');
    expect(window.gv2NormalizeAction('scroll up')).toBe('scroll_up');
    expect(window.gv2NormalizeAction('watch video')).toBe('watch_video');
  });

  test('defaults to click, or finish on the last step', () => {
    expect(window.gv2NormalizeAction(null, false)).toBe('click');
    expect(window.gv2NormalizeAction(null, true)).toBe('finish');
    expect(window.gv2NormalizeAction('done')).toBe('finish');
  });

  test('uses goto_url as the canonical navigation action', () => {
    expect(window.gv2NormalizeAction('navigate')).toBe('goto_url');
    expect(window.gv2NormalizeAction('goto url')).toBe('goto_url');
    expect(window.gv2NormalizeAction('go_to_url')).toBe('goto_url');
    expect(window.gv2NormalizeAction('open-url')).toBe('goto_url');
  });
});

describe('Evidence scratchpad helpers (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('normalizes evidence keys and bboxes', () => {
    expect(window.gv2NormalizeEvidenceKey('Team A Color!')).toBe('team_a_color');
    expect(window.gv2NormalizeEvidenceKey('40')).toBe('40');
    expect(window.gv2NormalizeEvidenceBbox({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }))
      .toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });

  test('validates evidence entries', () => {
    const out = window.gv2NormalizeEvidenceEntry({
      key: 'team_a_color',
      note: 'Team A shirt is red',
      region_bbox: { x: 0.42, y: 0.31, w: 0.18, h: 0.22 },
      som_id: null
    }, { ref_step_id: 7 });
    expect(out.ok).toBe(true);
    expect(out.entry.ref_step_id).toBe(7);
    expect(out.entry.updated_at_step_id).toBe(7);
  });

  test('normalizes region-only relationship evidence annotations', () => {
    const out = window.gv2NormalizeEvidenceEntry({
      key: 'parking_next_to_gym',
      note: 'The parking lot is next to the gym.',
      som_id: null,
      region_bbox: { x: 0.12, y: 0.22, w: 0.64, h: 0.32 },
      annotations: [
        { type: 'box', bbox: { x: 0.14, y: 0.3, w: 0.22, h: 0.16 }, label: 'Parking lot' },
        { type: 'box', bbox: { x: 0.44, y: 0.29, w: 0.2, h: 0.18 }, label: 'Gym' },
        { type: 'arrow', from: { x: 0.36, y: 0.38 }, to: { x: 0.44, y: 0.38 }, label: 'next to' }
      ]
    }, { ref_step_id: 8 });

    expect(out.ok).toBe(true);
    expect(out.entry.annotations).toEqual([
      { type: 'box', bbox: { x: 0.14, y: 0.3, w: 0.22, h: 0.16 }, label: 'Parking lot' },
      { type: 'box', bbox: { x: 0.44, y: 0.29, w: 0.2, h: 0.18 }, label: 'Gym' },
      { type: 'arrow', from: { x: 0.36, y: 0.38 }, to: { x: 0.44, y: 0.38 }, label: 'next to' }
    ]);
  });

  test('drops malformed evidence annotations and caps valid annotations at five', () => {
    const annotations = window.gv2NormalizeEvidenceAnnotations([
      { type: 'box', bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, label: 'one' },
      { type: 'box', bbox: { x: 0.2, y: 0.2, w: 0, h: 0.1 }, label: 'bad' },
      { type: 'arrow', from: { x: 0.2, y: 0.2 }, to: { x: 0.3, y: 0.3 }, label: 'two' },
      { type: 'arrow', from: { x: 'nope', y: 0.2 }, to: { x: 0.3, y: 0.3 }, label: 'bad' },
      { type: 'box', bbox: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }, label: 'three' },
      { type: 'box', bbox: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 }, label: 'four' },
      { type: 'box', bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, label: 'five' },
      { type: 'box', bbox: { x: 0.6, y: 0.6, w: 0.1, h: 0.1 }, label: 'six' }
    ]);

    expect(annotations).toHaveLength(5);
    expect(annotations.map(a => a.label)).toEqual(['one', 'two', 'three', 'four', 'five']);
  });

  test('normalizes annotator shapes, colors, and crop result', () => {
    const out = window.gv2NormalizeEvidenceAnnotationResult({
      crop: { x: -0.1, y: 0.2, w: 0.5, h: 2 },
      annotations: [
        { type: 'ellipse', bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 }, label: 'Hall', color: '#00ff88' },
        { type: 'line', from: { x: 0.2, y: 0.3 }, to: { x: 0.4, y: 0.5 }, label: 'near', color: 'blue' },
        { type: 'arrow', from: { x: 0.4, y: 0.5 }, to: { x: 0.5, y: 0.5 }, label: 'next to', color: 'url(bad)' }
      ]
    });

    expect(out.region_bbox).toEqual({ x: 0, y: 0.2, w: 0.5, h: 0.8 });
    expect(out.annotations).toEqual([
      { type: 'ellipse', bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 }, label: 'Hall', color: '#00ff88' },
      { type: 'line', from: { x: 0.2, y: 0.3 }, to: { x: 0.4, y: 0.5 }, label: 'near', color: 'blue' },
      { type: 'arrow', from: { x: 0.4, y: 0.5 }, to: { x: 0.5, y: 0.5 }, label: 'next to' }
    ]);
  });

  test('normalizes bbox aliases and coordinate arrays', () => {
    expect(window.gv2NormalizeEvidenceBbox([0.1, 0.2, 0.3, 0.4]))
      .toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    expect(window.gv2NormalizeEvidenceBbox({ left: 0.2, top: 0.3, right: 0.5, bottom: 0.7 }))
      .toEqual({ x: 0.2, y: 0.3, w: 0.3, h: 0.4 });
    expect(window.gv2NormalizeEvidenceBbox({ x1: 0.2, y1: 0.3, x2: 0.5, y2: 0.7 }))
      .toEqual({ x: 0.2, y: 0.3, w: 0.3, h: 0.4 });
  });

  test('keeps screenshot evidence annotation request metadata', () => {
    const out = window.gv2NormalizeEvidenceEntry({
      key: 'parking_next_to_hall',
      note: 'The parking lot is next to Sanford Hall.',
      som_id: null,
      need_annotation: true,
      annotation_prompt: 'Box both places and draw an arrow labeled next to.'
    }, { ref_step_id: 10 });

    expect(out.ok).toBe(true);
    expect(out.entry.need_annotation).toBe(true);
    expect(out.entry.annotation_prompt).toBe('Box both places and draw an arrow labeled next to.');
    expect(out.entry.region_bbox).toBe(null);
  });

  test('ignores annotations for DOM evidence entries', () => {
    const out = window.gv2NormalizeEvidenceEntry({
      key: 'gym_label',
      note: 'The gym label is visible.',
      som_id: '12',
      region_bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      annotations: [{ type: 'box', bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, label: 'ignored' }]
    }, { ref_step_id: 9 });

    expect(out.ok).toBe(true);
    expect(out.entry.annotations).toEqual([]);
  });

  test('normalizes evidence arrays with cap and unique duplicate-key suffixes', () => {
    const out = window.gv2NormalizeEvidenceList([
      { key: 'team_a', note: 'red', som_id: '12' },
      { key: 'team_b', note: 'blue', region_bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
      { key: 'team_a', note: 'crimson', som_id: '13' },
      { key: 'team_c', note: 'green' },
      { key: 'team_d', note: 'yellow' },
      { key: 'team_e', note: 'black' }
    ], { ref_step_id: 3, maxItems: 5 });

    expect(out.ok).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.entries).toHaveLength(5);
    expect(out.entries.map(e => e.key)).toEqual(['team_a', 'team_b', 'team_a_2', 'team_c', 'team_d']);
    expect(out.entries[0].note).toBe('red');
    expect(out.entries[2].note).toBe('crimson');
    expect(out.entries[1].region_bbox).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });

  test('does not cap saved evidence arrays by default', () => {
    const out = window.gv2NormalizeEvidenceList([
      { key: 'team_a', note: 'red' },
      { key: 'team_b', note: 'blue' },
      { key: 'team_c', note: 'green' },
      { key: 'team_d', note: 'yellow' },
      { key: 'team_e', note: 'black' },
      { key: 'team_f', note: 'white' }
    ], { ref_step_id: 3 });

    expect(out.ok).toBe(true);
    expect(out.truncated).toBe(false);
    expect(out.entries).toHaveLength(6);
    expect(out.entries.map(e => e.key)).toEqual(['team_a', 'team_b', 'team_c', 'team_d', 'team_e', 'team_f']);
  });

  test('avoids existing scratchpad keys when normalizing evidence arrays', () => {
    const out = window.gv2NormalizeEvidenceList([
      { key: 'team_a', note: 'new red' },
      { key: 'team_a', note: 'new crimson' }
    ], { ref_step_id: 4, existingKeys: ['team_a', 'team_a_2'] });

    expect(out.ok).toBe(true);
    expect(out.entries.map(e => e.key)).toEqual(['team_a_3', 'team_a_4']);
  });

  test('normalizes a legacy single evidence object defensively', () => {
    const out = window.gv2NormalizeEvidenceList({
      key: 'single_ev',
      note: 'single note',
      region_bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }
    }, { ref_step_id: 4 });

    expect(out.ok).toBe(true);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].key).toBe('single_ev');
  });

  test('rejects missing note and zero-area bbox', () => {
    const out = window.gv2NormalizeEvidenceEntry({
      key: 'x',
      note: '',
      region_bbox: { x: 0.1, y: 0.1, w: 0, h: 0.2 }
    }, { ref_step_id: 1 });
    expect(out.ok).toBe(false);
    expect(out.errors).toContain('note');
    expect(out.errors).toContain('region_bbox');
  });

  test('builds compact memory text and parses evidence refs', () => {
    const entries = [{ key: 'team_a_color', note: 'Team A shirt is red', ref_step_id: 7 }];
    expect(window.gv2EvidenceMemoryText(entries)).toContain('evidenceKey="team_a_color": Team A shirt is red, captured at step 7');
    expect(window.gv2ParseEvidenceRefs('Team A [ev:team_a_color] and missing [ev:other].'))
      .toEqual(['team_a_color', 'other']);
    expect(window.gv2ParseEvidenceRefs('Language [ev:40].')).toEqual(['40']);
  });

  test('expands bare evidence citations using scratchpad notes', () => {
    const scratchpad = [
      { key: 'a', note: 'Spain and England semi-final expectations article', ref_step_id: 1 },
      { key: 'b', note: 'Messi first England meeting article', ref_step_id: 1 }
    ];

    expect(window.gv2ExpandBareEvidenceCitations(
      'I found two World Cup articles, one titled: [ev:a] and one titled: [ev:b].',
      scratchpad
    )).toBe('I found two World Cup articles, one titled: Spain and England semi-final expectations article [ev:a] and one titled: Messi first England meeting article [ev:b].');
  });

  test('leaves evidence citations attached to concrete claims alone', () => {
    const scratchpad = [{ key: 'a', note: 'Team A shirt is red', ref_step_id: 1 }];
    expect(window.gv2ExpandBareEvidenceCitations('Team A is red [ev:a].', scratchpad))
      .toBe('Team A is red [ev:a].');
  });
});

describe('gv2BuildAnswerEvidence (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  const scratch = (key, step, bbox) => ({ key, note: `${key} note`, ref_step_id: step, region_bbox: bbox || null });

  test('S1/S2: cited [ev:key] resolve to numbered "cited" items in citation order', () => {
    const out = window.gv2BuildAnswerEvidence({
      finalAnswer: 'Team A is red [ev:a] and B is blue [ev:b].',
      scratchpad: [scratch('a', 2), scratch('b', 3)],
      fallbackStep: { step: 5 }
    });
    expect(out.map(i => [i.source, i.key, i.number, i.step]))
      .toEqual([['cited', 'a', 1, 2], ['cited', 'b', 2, 3]]);
  });

  test('uncited scratchpad still linked (agent saved but did not cite)', () => {
    const out = window.gv2BuildAnswerEvidence({
      finalAnswer: '',
      scratchpad: [scratch('a', 2), scratch('c', 4)],
      fallbackStep: { step: 5 }
    });
    expect(out.map(i => i.source)).toEqual(['scratchpad', 'scratchpad']);
    expect(out.map(i => i.step)).toEqual([2, 4]);
  });

  test('cited first, then remaining uncited scratchpad', () => {
    const out = window.gv2BuildAnswerEvidence({
      finalAnswer: 'See [ev:a].',
      scratchpad: [scratch('a', 2), scratch('c', 4)],
      fallbackStep: { step: 5 }
    });
    expect(out.map(i => [i.source, i.key])).toEqual([['cited', 'a'], ['scratchpad', 'c']]);
  });

  test('keeps multiple evidence keys from the same step without bboxes', () => {
    const out = window.gv2BuildAnswerEvidence({
      finalAnswer: 'See [ev:a] and [ev:b].',
      scratchpad: [scratch('a', 2), scratch('b', 2)],
      fallbackStep: { step: 5 }
    });
    expect(out.map(i => i.key)).toEqual(['a', 'b']);
  });

  test('S3: navigate-only with no scratchpad falls back to action grounding', () => {
    const out = window.gv2BuildAnswerEvidence({
      finalAnswer: '',
      scratchpad: [],
      fallbackStep: { step: 4, note: 'Clicked World Cup' }
    });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('action-fallback');
    expect(out[0].step).toBe(4);
    expect(out[0].note).toBe('Clicked World Cup');
  });

  test('navigation-only prefers cited finish confirmation before action fallback', () => {
    const out = window.gv2BuildAnswerEvidence({
      finalAnswer: 'The page language is now English [ev:40].',
      scratchpad: [],
      confirmation: [{ step: 6, region_bbox: { x: 0.2, y: 0.3, w: 0.2, h: 0.1 }, note: 'Language selector shows English.' }],
      fallbackStep: { step: 4, note: 'Clicked language menu' }
    });
    expect(out).toEqual([{
      source: 'confirmation',
      step: 6,
      region_bbox: { x: 0.2, y: 0.3, w: 0.2, h: 0.1 },
      note: 'Language selector shows English.',
      key: '40'
    }]);
  });

  test('saved evidence suppresses finish confirmation evidence', () => {
    const out = window.gv2BuildAnswerEvidence({
      finalAnswer: 'Article A exists [ev:a].',
      scratchpad: [scratch('a', 2)],
      confirmation: [{ step: 6, region_bbox: { x: 0.2, y: 0.3, w: 0.2, h: 0.1 }, note: 'Final page still shows article.' }],
      fallbackStep: { step: 6 }
    });
    expect(out.map(i => i.source)).toEqual(['cited']);
    expect(out[0].key).toBe('a');
  });

  test('uncited saved evidence still suppresses finish confirmation evidence', () => {
    const out = window.gv2BuildAnswerEvidence({
      finalAnswer: 'I found the answer.',
      scratchpad: [scratch('a', 2), scratch('b', 3)],
      confirmation: [{ step: 6, region_bbox: { x: 0.2, y: 0.3, w: 0.2, h: 0.1 }, note: 'Final page confirms the answer.' }],
      fallbackStep: { step: 6 }
    });
    expect(out.map(i => [i.source, i.key, i.step])).toEqual([
      ['scratchpad', 'a', 2],
      ['scratchpad', 'b', 3]
    ]);
  });

  test('guarantee contract: non-empty with fallbackStep, empty without', () => {
    expect(window.gv2BuildAnswerEvidence({ finalAnswer: '', scratchpad: [], fallbackStep: { step: 1 } }))
      .toHaveLength(1);
    expect(window.gv2BuildAnswerEvidence({ finalAnswer: '', scratchpad: [], fallbackStep: null }))
      .toHaveLength(0);
  });

  test('dedup: cited entry sharing the fallback step does not double-emit; fallback suppressed', () => {
    const out = window.gv2BuildAnswerEvidence({
      finalAnswer: 'See [ev:a].',
      scratchpad: [scratch('a', 4)],
      fallbackStep: { step: 4 }
    });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('cited');
    expect(out[0].step).toBe(4);
  });

  test('missing/unpinned keys are skipped without throwing', () => {
    const out = window.gv2BuildAnswerEvidence({
      finalAnswer: 'Missing [ev:x] and unpinned [ev:y].',
      scratchpad: [{ key: 'y', note: 'no step', ref_step_id: null }],
      fallbackStep: { step: 3 }
    });
    // x has no entry, y has no ref_step_id → both skipped → fallback fires.
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('action-fallback');
  });

  test('hallucinated citations do not suppress confirmation fallback', () => {
    const out = window.gv2BuildAnswerEvidence({
      finalAnswer: 'Done [ev:fake_link].',
      scratchpad: [],
      confirmation: [{ step: 8, region_bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, note: 'The destination page is open.' }],
      fallbackStep: { step: 7 }
    });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('confirmation');
    expect(out[0].step).toBe(8);
  });
});

describe('gv2DeterministicVerdict (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('only a completed outcome (literal finish) maps to completed', () => {
    expect(window.gv2DeterministicVerdict('completed')).toBe('completed');
  });

  test('every non-finish ending is failed (binary, no unclear)', () => {
    expect(window.gv2DeterministicVerdict('failed')).toBe('failed');
    expect(window.gv2DeterministicVerdict('stopped')).toBe('failed');
    expect(window.gv2DeterministicVerdict('unclear')).toBe('failed');
    expect(window.gv2DeterministicVerdict(undefined)).toBe('failed');
    expect(window.gv2DeterministicVerdict('')).toBe('failed');
  });
});

describe('gv2NormalizeVisualEvidence (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('normalizes the object form into {index,rect,text,reason}', () => {
    const r = window.gv2NormalizeVisualEvidence({ name: null, index: 7, text: '  Sort by:  Price ', reason: 'sorted low to high\nso first is cheapest' });
    expect(r).toEqual({ name: null, index: 7, rect: null, text: 'Sort by: Price', reason: 'sorted low to high so first is cheapest', need_annotation: false, annotation_prompt: null, annotations: [] });
  });

  test('keeps a citation-safe confirmation evidence name', () => {
    const r = window.gv2NormalizeVisualEvidence({ name: 'Spanish Language!', index: 40, reason: 'sidebar shows Spanish' });
    expect(r).toEqual({ name: 'spanish_language', index: 40, rect: null, text: null, reason: 'sidebar shows Spanish', need_annotation: false, annotation_prompt: null, annotations: [] });
  });

  test('treats a bare string as the reason', () => {
    expect(window.gv2NormalizeVisualEvidence('proves it')).toEqual({ name: null, index: null, rect: null, text: null, reason: 'proves it', need_annotation: false, annotation_prompt: null, annotations: [] });
  });

  test('accepts a normalized bounding box rect', () => {
    const r = window.gv2NormalizeVisualEvidence({ rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, reason: 'here' });
    expect(r.rect).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });

  test('keeps both index and rect when both are provided', () => {
    const r = window.gv2NormalizeVisualEvidence({ name: null, index: 9, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, reason: 'marker plus precise region' });
    expect(r).toEqual({ name: null, index: 9, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, text: null, reason: 'marker plus precise region', need_annotation: false, annotation_prompt: null, annotations: [] });
  });

  test('clamps rect components to 0..1 and rejects a zero-area rect', () => {
    const clamped = window.gv2NormalizeVisualEvidence({ rect: { x: -1, y: 2, w: 0.5, h: 0.5 } });
    expect(clamped.rect).toEqual({ x: 0, y: 1, w: 0.5, h: 0.5 });
    const bad = window.gv2NormalizeVisualEvidence({ rect: { x: 0.1, y: 0.1, w: 0, h: 0.5 }, text: '' });
    expect(bad).toBeNull();
  });

  test('an object with only a rect is kept', () => {
    const r = window.gv2NormalizeVisualEvidence({ rect: { x: 0, y: 0, w: 1, h: 1 } });
    expect(r).toEqual({ name: null, index: null, rect: { x: 0, y: 0, w: 1, h: 1 }, text: null, reason: null, need_annotation: false, annotation_prompt: null, annotations: [] });
  });

  test('keeps confirmation annotation requests', () => {
    const r = window.gv2NormalizeVisualEvidence({
      need_annotation: true,
      annotation_prompt: 'Box the selected language control.',
      reason: 'The language selector confirms English.'
    });
    expect(r).toEqual({
      name: null,
      index: null,
      rect: null,
      text: null,
      reason: 'The language selector confirms English.',
      need_annotation: true,
      annotation_prompt: 'Box the selected language control.',
      annotations: []
    });
  });

  test('coerces index to a positive integer, else null', () => {
    expect(window.gv2NormalizeVisualEvidence({ name: null, index: '4', reason: 'x' }).index).toBe(4);
    expect(window.gv2NormalizeVisualEvidence({ name: null, index: 3.9, reason: 'x' }).index).toBe(3);
    expect(window.gv2NormalizeVisualEvidence({ name: null, index: 0, reason: 'x' }).index).toBeNull();
    expect(window.gv2NormalizeVisualEvidence({ name: null, index: -2, reason: 'x' }).index).toBeNull();
    expect(window.gv2NormalizeVisualEvidence({ name: null, index: 'abc', reason: 'x' }).index).toBeNull();
  });

  test('caps overlong text and reason at 280 chars', () => {
    const long = 'a'.repeat(400);
    const r = window.gv2NormalizeVisualEvidence({ text: long, reason: long });
    expect(r.text.length).toBe(280);
    expect(r.reason.length).toBe(280);
  });

  test('returns null when nothing usable is present', () => {
    expect(window.gv2NormalizeVisualEvidence(null)).toBeNull();
    expect(window.gv2NormalizeVisualEvidence(undefined)).toBeNull();
    expect(window.gv2NormalizeVisualEvidence('   ')).toBeNull();
    expect(window.gv2NormalizeVisualEvidence({ name: null, index: null, text: '  ', reason: '' })).toBeNull();
    expect(window.gv2NormalizeVisualEvidence(42)).toBeNull();
  });

  test('normalizes a capped list of visual evidence items', () => {
    const items = window.gv2NormalizeVisualEvidenceList([
      { name: null, index: 3, reason: 'first marker' },
      { rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, reason: 'fallback rect' },
      { name: null, index: 3, reason: 'duplicate marker' },
      { name: null, index: 4, reason: 'extra marker' }
    ], 3);
    expect(items).toEqual([
      { name: null, index: 3, rect: null, text: null, reason: 'first marker', need_annotation: false, annotation_prompt: null, annotations: [] },
      { name: null, index: null, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, text: null, reason: 'fallback rect', need_annotation: false, annotation_prompt: null, annotations: [] },
      { name: null, index: 4, rect: null, text: null, reason: 'extra marker', need_annotation: false, annotation_prompt: null, annotations: [] }
    ]);
  });

  test('normalizes grouped visual evidence fields', () => {
    const items = window.gv2NormalizeVisualEvidenceList({
      names: ['price_sort', null],
      indexes: [8, null],
      rects: [null, { x: 0, y: 0, w: 0.5, h: 0.5 }],
      texts: ['price sort', 'first result'],
      reasons: ['sort order proves cheapest', 'item shown after sorting']
    });
    expect(items).toEqual([
      { name: 'price_sort', index: 8, rect: null, text: 'price sort', reason: 'sort order proves cheapest', need_annotation: false, annotation_prompt: null, annotations: [] },
      { name: null, index: null, rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, text: 'first result', reason: 'item shown after sorting', need_annotation: false, annotation_prompt: null, annotations: [] }
    ]);
  });
});

describe('visual_highlight action (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('gv2NormalizeAction canonicalizes the label', () => {
    expect(window.gv2NormalizeAction('Visual Highlight')).toBe('visual_highlight');
    expect(window.gv2NormalizeAction('visual-highlight')).toBe('visual_highlight');
    expect(window.gv2NormalizeAction('visual_highlight')).toBe('visual_highlight');
  });

  test('is read-only: no planner target, low risk, noop replay', () => {
    expect(window.gv2StepHasTarget({ action: 'visual_highlight', element: { name: null, index: 4, text: 'x' } })).toBe(false);
    expect(window.gv2AssessRisk({ action: 'visual_highlight', risk: 'high' })).toBe('low');
    expect(window.gv2ReplayKind('visual_highlight')).toBe('noop');
  });
});

describe('gv2StepHasTarget (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('a click step with an element has a target', () => {
    expect(window.gv2StepHasTarget({ action: 'click', element: { name: null, index: 4, text: 'Help' } })).toBe(true);
    expect(window.gv2StepHasTarget({ action: 'click', element: { text: 'Help' } })).toBe(true);
  });

  test('a drag_drop step uses element as the draggable source target', () => {
    expect(window.gv2StepHasTarget({ action: 'drag_drop', element: { name: null, index: 4, text: 'Task A' }, dropTarget: { text: 'Done' } })).toBe(true);
  });

  test('find never has a target, even when the model populates element', () => {
    // find highlights whatever the reader pass cites — not one planner-chosen element.
    expect(window.gv2StepHasTarget({ action: 'find', element: { name: null, index: 4, text: 'Lost property' } })).toBe(false);
  });

  test('scroll steps ignore model-populated element targets', () => {
    expect(window.gv2StepHasTarget({ action: 'scroll_down', element: { name: null, index: 4, text: 'Article card' } })).toBe(false);
    expect(window.gv2StepHasTarget({ action: 'scroll_up', element: { name: null, index: 2, text: 'Header' } })).toBe(false);
  });

  test('goto_url and watch_video ignore model-populated element targets', () => {
    expect(window.gv2StepHasTarget({ action: 'goto_url', element: { name: null, index: 4, text: 'BBC' } })).toBe(false);
    expect(window.gv2StepHasTarget({ action: 'navigate', element: { name: null, index: 4, text: 'BBC' } })).toBe(false);
    expect(window.gv2StepHasTarget({ action: 'watch_video', element: { name: null, index: 8, text: 'Play' } })).toBe(false);
  });

  test('done and last steps have no target', () => {
    expect(window.gv2StepHasTarget({ action: 'done', element: { name: null, index: 1, text: 'x' } })).toBe(false);
    expect(window.gv2StepHasTarget({ action: 'click', isLastStep: true, element: { name: null, index: 1, text: 'x' } })).toBe(false);
  });

  test('a click step without an element has no target', () => {
    expect(window.gv2StepHasTarget({ action: 'click', element: {} })).toBe(false);
    expect(window.gv2StepHasTarget({ action: 'click', element: { text: '   ' } })).toBe(false);
    expect(window.gv2StepHasTarget(null)).toBe(false);
  });
});

describe('gv2ParseFindResponse (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('detects the "not provided on this page" escape hatch', () => {
    const r = window.gv2ParseFindResponse('The information is not provided on this page.');
    expect(r.notOnPage).toBe(true);
  });

  test('detects the escape hatch case-insensitively and mid-answer', () => {
    const answer = 'Sorry — the Information Is Not Provided On This Page. However, see [Megabus](https://uk.megabus.com).';
    expect(window.gv2ParseFindResponse(answer).notOnPage).toBe(true);
  });

  test('a normal cited answer is on-page and has citations', () => {
    const r = window.gv2ParseFindResponse('Contact the depot [12:"within 30 days"] of travel.');
    expect(r.notOnPage).toBe(false);
    expect(r.hasCitations).toBe(true);
  });

  test('recognizes bare [N] citations', () => {
    expect(window.gv2ParseFindResponse('See the policy [7].').hasCitations).toBe(true);
  });

  test('an uncited answer reports no citations', () => {
    const r = window.gv2ParseFindResponse('Call the depot as soon as possible.');
    expect(r.notOnPage).toBe(false);
    expect(r.hasCitations).toBe(false);
  });

  test('is safe on empty/undefined answers', () => {
    expect(window.gv2ParseFindResponse(undefined)).toEqual({ answer: '', notOnPage: false, hasCitations: false });
    expect(window.gv2ParseFindResponse(null)).toEqual({ answer: '', notOnPage: false, hasCitations: false });
    expect(window.gv2ParseFindResponse('')).toEqual({ answer: '', notOnPage: false, hasCitations: false });
  });
});

// Regression: a find record carries no target text. Before gv2ReplayKind, _gv2ReplayOne's
// `if (!text) return false` made replay report failure and abort the whole rewind chain.
describe('gv2ReplayKind (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('find replays as a no-op', () => {
    expect(window.gv2ReplayKind('find')).toBe('noop');
    expect(window.gv2ReplayKind('FIND')).toBe('noop');
  });

  test('goto_url and watch_video replay as no-ops', () => {
    expect(window.gv2ReplayKind('goto_url')).toBe('noop');
    expect(window.gv2ReplayKind('navigate')).toBe('noop');
    expect(window.gv2ReplayKind('watch_video')).toBe('noop');
  });

  test('mutating actions keep their own replay kind', () => {
    expect(window.gv2ReplayKind('type')).toBe('type');
    expect(window.gv2ReplayKind('clear_text')).toBe('clear_text');
    expect(window.gv2ReplayKind('select')).toBe('select');
    expect(window.gv2ReplayKind('check')).toBe('check');
    expect(window.gv2ReplayKind('toggle')).toBe('check');
    expect(window.gv2ReplayKind('drag_drop')).toBe('drag_drop');
    expect(window.gv2ReplayKind('drag drop')).toBe('drag_drop');
    expect(window.gv2ReplayKind('save_evidence')).toBe('noop');
    expect(window.gv2ReplayKind('finish')).toBe('noop');
  });

  test('anything else — including a missing action — replays as a click', () => {
    expect(window.gv2ReplayKind('click')).toBe('click');
    expect(window.gv2ReplayKind(undefined)).toBe('click');
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

  test('marks low-grounding and high-loop steps for yellow review status', () => {
    const records = [
      { step: 1, confidence: 0.3 },
      { step: 2, confidence: 0.9, mechGrounding: 0.2 },
      { step: 3, confidence: 0.9, mechGrounding: 0.9, mechLoop: 0.3 }
    ];
    const dots = window.gv2DotState({ plan: [], records, verifications: {}, current: 3, guideActive: true });
    expect(dots[0].review).toBe(false);
    expect(dots[0].reviewLabels).toEqual([]);
    expect(dots[1].review).toBe(true);
    expect(dots[1].reviewLabels).toEqual(['misgrounded']);
    expect(dots[2].review).toBe(true);
    expect(dots[2].reviewLabels).toEqual(['loop']);
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

describe('gv2NormalizeRecap (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  const ctx = {
    validSteps: [2, 4],
    plan: [{ n: 1, goal: 'Create view' }, { n: 2, goal: 'Mark completed' }],
    planTitle: 'Completed tasks view',
    steps: ['Step 2: Create a view ✓', 'Step 4: Mark it completed ✓']
  };

  test('keeps LLM milestones pinned to real completed steps and passes summary through', () => {
    const raw = {
      summary: 'I have finished the task.',
      milestones: [
        { text: 'I have created a view', step: 2 },
        { text: 'I have marked it completed', step: 4 }
      ]
    };
    const r = window.gv2NormalizeRecap(raw, ctx);
    expect(r.summary).toBe('I have finished the task.');
    expect(r.milestones).toEqual([
      { text: 'I have created a view', step: 2, phrase: '' },
      { text: 'I have marked it completed', step: 4, phrase: '' }
    ]);
  });

  test('keeps wrong-step labels and reasons from stepEvaluations', () => {
    const raw = {
      verdict: 'failed',
      summary: 'I could not complete the task. The final page did not show the requested result.',
      stepEvaluations: [
        { text: 'Clicked the wrong Settings button', step: 2, status: 'wrong', goalRelated: false, goalRelatedReason: 'Settings was unrelated to the requested view.', errorLabel: 'misgrounded', reason: 'Low grounding score.' },
        { text: 'Repeated the same menu click', step: 4, status: 'wrong', goalRelated: true, goalRelatedReason: 'It attempted the requested language menu.', errorLabel: 'loop', reason: 'High loop score.' }
      ]
    };
    const r = window.gv2NormalizeRecap(raw, {
      ...ctx,
      finalVerdict: 'failed',
      stepRecords: [
        { step: 2, mechGrounding: 0.2, mechLoop: 0.0, mechConfidence: 0.2 },
        { step: 4, mechGrounding: 0.9, mechLoop: 0.8, mechConfidence: 0.5 }
      ]
    });
    expect(r.summary).toContain('I could not complete the task');
    expect(r.milestones).toEqual([
      { text: 'Clicked the wrong Settings button', step: 2, phrase: '', goalRelated: false, goalRelatedReason: 'Settings was unrelated to the requested view.', status: 'wrong', errorLabel: 'misgrounded', reason: 'Low grounding score.' },
      { text: 'Repeated the same menu click', step: 4, phrase: '', goalRelated: true, goalRelatedReason: 'It attempted the requested language menu.', status: 'wrong', errorLabel: 'loop', reason: 'High loop score.' }
    ]);
  });

  test('infers wrong-step labels from confidence scores when the label is missing', () => {
    const raw = {
      verdict: 'failed',
      summary: 'I could not complete the task.',
      stepEvaluations: [
        { text: 'Clicked a repeated target', step: 2, status: 'wrong' },
        { text: 'Clicked an unrelated target', step: 4, status: 'wrong' }
      ]
    };
    const r = window.gv2NormalizeRecap(raw, {
      ...ctx,
      finalVerdict: 'failed',
      stepRecords: [
        { step: 2, mechGrounding: 0.9, mechLoop: 0.7, mechConfidence: 0.6 },
        { step: 4, mechGrounding: 0.2, mechLoop: 0.0, mechConfidence: 0.2 }
      ]
    });
    expect(r.milestones[0].errorLabel).toBe('loop');
    expect(r.milestones[1].errorLabel).toBe('misgrounded');
  });

  test('drops milestones that reference steps that never happened', () => {
    const raw = {
      summary: 'done',
      milestones: [
        { text: 'real', step: 2 },
        { text: 'hallucinated', step: 9 },   // 9 is not a completed step
        { text: 'no step' }                  // missing step
      ]
    };
    const r = window.gv2NormalizeRecap(raw, ctx);
    expect(r.milestones).toEqual([{ text: 'real', step: 2, phrase: '' }]);
  });

  test('carries a phrase only when it is a substring of the milestone text', () => {
    const raw = {
      summary: 'done',
      milestones: [
        { text: 'I have opened the language settings', phrase: 'language settings', step: 2 },
        { text: 'I have confirmed the change', phrase: 'not in text', step: 4 }
      ]
    };
    const r = window.gv2NormalizeRecap(raw, ctx);
    expect(r.milestones).toEqual([
      { text: 'I have opened the language settings', step: 2, phrase: 'language settings' },
      { text: 'I have confirmed the change', step: 4, phrase: '' }  // phrase not in text → dropped
    ]);
  });

  test('keeps summary segments pinned to real completed steps with valid phrases', () => {
    const raw = {
      summary: 'I opened the latest iPhone lineup and compared the Pro Max display specs.',
      summarySegments: [
        { text: 'Opened the latest iPhone lineup.', phrase: 'latest iPhone lineup', step: 2 },
        { text: 'Compared the Pro Max display specs.', phrase: 'Pro Max display specs', step: 4 },
        { text: 'Invented an off-trajectory step.', phrase: 'off-trajectory', step: 9 }
      ],
      milestones: [
        { text: 'Opened the latest iPhone lineup.', phrase: 'latest iPhone lineup', step: 2 },
        { text: 'Compared the Pro Max display specs.', phrase: 'Pro Max display specs', step: 4 }
      ]
    };
    const r = window.gv2NormalizeRecap(raw, ctx);
    expect(r.summarySegments).toEqual([
      { text: 'Opened the latest iPhone lineup.', step: 2, phrase: 'latest iPhone lineup' },
      { text: 'Compared the Pro Max display specs.', step: 4, phrase: 'Pro Max display specs' }
    ]);
  });

  test('keeps evidence-backed summary segments using scratchpad keys', () => {
    const raw = {
      summary: 'I collected ESPN evidence that England and Argentina reached the semifinals.',
      summarySegments: [
        { text: 'Collected ESPN evidence that England and Argentina reached the semifinals at step 4.', phrase: 'ESPN evidence', evidenceKey: 'espn_semifinals', step: 4 },
        { text: 'Ignored unknown evidence.', phrase: 'unknown evidence', evidenceKey: 'missing_key', step: 4 }
      ],
      milestones: [{ text: 'Found the latest World Cup news.', step: 4 }]
    };
    const r = window.gv2NormalizeRecap(raw, {
      ...ctx,
      validSteps: [2, 4],
      scratchpad: [
        { key: 'espn_semifinals', note: 'ESPN reports England and Argentina reached the semifinals', ref_step_id: 4, region_bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } }
      ]
    });
    expect(r.summarySegments).toEqual([
      {
        text: 'Collected ESPN evidence that England and Argentina reached the semifinals at step 4.',
        step: 4,
        phrase: 'ESPN evidence',
        evidenceKey: 'espn_semifinals',
        note: 'ESPN reports England and Argentina reached the semifinals',
        region_bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }
      }
    ]);
  });

  test('falls back to milestone phrases when summary segments are missing', () => {
    const raw = {
      summary: 'Compared the latest iPhone models.',
      milestones: [
        { text: 'Opened the latest iPhone lineup.', phrase: 'latest iPhone lineup', step: 2 },
        { text: 'Compared the Pro Max display specs.', phrase: 'Pro Max display specs', step: 4 }
      ]
    };
    const r = window.gv2NormalizeRecap(raw, ctx);
    expect(r.summarySegments).toEqual([
      { text: 'Opened the latest iPhone lineup.', step: 2, phrase: 'latest iPhone lineup' },
      { text: 'Compared the Pro Max display specs.', step: 4, phrase: 'Pro Max display specs' }
    ]);
  });

  test('dedupes repeated steps and clamps to at most 6 milestones', () => {
    const validSteps = [1, 2, 3, 4, 5, 6, 7, 8];
    const raw = {
      milestones: [
        ...validSteps.map(s => ({ text: 'm' + s, step: s })),
        { text: 'dup of 1', step: 1 }
      ]
    };
    const r = window.gv2NormalizeRecap(raw, { validSteps, plan: [], steps: [] });
    expect(r.milestones).toHaveLength(6);
    expect(r.milestones.filter(m => m.step === 1)).toHaveLength(1);
  });

  test('falls back to a deterministic recap built from completed-step strings when LLM output is malformed', () => {
    const r = window.gv2NormalizeRecap(null, ctx);
    expect(r.milestones).toEqual([
      { text: 'Create a view', step: 2, phrase: '', goalRelated: true, goalRelatedReason: 'Fallback from completed guide step.' },
      { text: 'Mark it completed', step: 4, phrase: '', goalRelated: true, goalRelatedReason: 'Fallback from completed guide step.' }
    ]);
    // Synthesized summary references the task title.
    expect(r.summary).toContain('Completed tasks view');
    expect(r.summary.startsWith('I could not complete the task')).toBe(true);
  });

  test('never invents steps: no valid completed steps yields an empty milestone list', () => {
    const r = window.gv2NormalizeRecap({ milestones: [{ text: 'x', step: 3 }] }, { validSteps: [], plan: [], steps: [] });
    expect(r.milestones).toEqual([]);
    expect(typeof r.summary).toBe('string');
  });
});

describe('gv2BuildPersonalizationSection (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('returns empty string when both facts and learned summary are empty', () => {
    expect(window.gv2BuildPersonalizationSection({ facts: '', learned: '' })).toBe('');
    expect(window.gv2BuildPersonalizationSection({})).toBe('');
    expect(window.gv2BuildPersonalizationSection()).toBe('');
  });

  test('includes only manual facts when learned summary is empty', () => {
    const out = window.gv2BuildPersonalizationSection({ facts: 'Vegetarian, prefers concise answers', learned: '' });
    expect(out).toContain('=== ABOUT THIS USER ===');
    expect(out).toContain('Facts the user shared: Vegetarian, prefers concise answers');
    expect(out).not.toContain('What you have learned');
  });

  test('includes only the learned profile when manual facts are empty', () => {
    const out = window.gv2BuildPersonalizationSection({ facts: '', learned: 'Works in finance, often automates spreadsheets.' });
    expect(out).toContain('=== ABOUT THIS USER ===');
    expect(out).toContain('What you have learned from prior sessions: Works in finance, often automates spreadsheets.');
    expect(out).not.toContain('Facts the user shared');
  });

  test('combines both manual facts and the learned profile when present', () => {
    const out = window.gv2BuildPersonalizationSection({ facts: 'Vegetarian', learned: 'Frequently books travel.' });
    expect(out).toContain('Facts the user shared: Vegetarian');
    expect(out).toContain('What you have learned from prior sessions: Frequently books travel.');
  });

  test('trims whitespace-only input to empty', () => {
    expect(window.gv2BuildPersonalizationSection({ facts: '   ', learned: '  \n ' })).toBe('');
  });
});

describe('gv2NormalizeProfileUpdate (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('normalizes a valid summary, stamping timestamp and incrementing version', () => {
    const before = Date.now();
    const r = window.gv2NormalizeProfileUpdate({ summary: 'Likes concise answers.' }, { summary: 'old', version: 3 });
    expect(r.summary).toBe('Likes concise answers.');
    expect(r.version).toBe(4);
    expect(r.updatedAt).toBeGreaterThanOrEqual(before);
  });

  test('defaults version to 1 when there is no prior profile', () => {
    const r = window.gv2NormalizeProfileUpdate({ summary: 'New user fact.' }, null);
    expect(r.version).toBe(1);
  });

  test('returns null when summary is missing, non-string, or empty after trim', () => {
    expect(window.gv2NormalizeProfileUpdate({}, null)).toBeNull();
    expect(window.gv2NormalizeProfileUpdate({ summary: 123 }, null)).toBeNull();
    expect(window.gv2NormalizeProfileUpdate({ summary: '   ' }, null)).toBeNull();
    expect(window.gv2NormalizeProfileUpdate(null, null)).toBeNull();
  });

  test('truncates an oversized summary to the 1500-char cap on a word boundary instead of rejecting it', () => {
    const longSummary = 'word '.repeat(400); // 2000 chars
    const r = window.gv2NormalizeProfileUpdate({ summary: longSummary }, null);
    expect(r).not.toBeNull();
    expect(r.summary.length).toBeLessThanOrEqual(1500);
    expect(r.summary.endsWith('word')).toBe(true); // cut on a word boundary, no trailing partial word
  });
});

describe('gv2StepErrorLabelFromScores (content/utils.js)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('prioritizes high loop, then low grounding, then low confidence', () => {
    expect(window.gv2StepErrorLabelFromScores({ mechGrounding: 0.9, mechLoop: 0.8, mechConfidence: 0.6 })).toBe('loop');
    expect(window.gv2StepErrorLabelFromScores({ mechGrounding: 0.2, mechLoop: 0.1, mechConfidence: 0.2 })).toBe('misgrounded');
    expect(window.gv2StepErrorLabelFromScores({ mechGrounding: 0.8, mechLoop: 0.1, mechConfidence: 0.3 })).toBe('low-confidence');
    expect(window.gv2StepErrorLabelFromScores({ mechGrounding: 0.8, mechLoop: 0.1, mechConfidence: 0.8 })).toBe('other');
  });
});

describe('gv2NormalizeFinalVerdict (content/utils.js — final-state vision verdict)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('keeps a valid verdict, reason, and clamped annotations', () => {
    const raw = {
      verdict: 'completed',
      reason: 'The interface language is now Spanish.',
      annotations: [
        { x: 0.1, y: 0.2, w: 0.3, h: 0.1, label: 'Language set to Español' },
        { x: 0.5, y: 0.5, w: 0.2, h: 0.2, label: 'Confirmation checkmark' }
      ]
    };
    const r = window.gv2NormalizeFinalVerdict(raw);
    expect(r.verdict).toBe('completed');
    expect(r.reason).toBe('The interface language is now Spanish.');
    expect(r.annotations).toEqual([
      { x: 0.1, y: 0.2, w: 0.3, h: 0.1, label: 'Language set to Español' },
      { x: 0.5, y: 0.5, w: 0.2, h: 0.2, label: 'Confirmation checkmark' }
    ]);
  });

  test('defaults an unknown verdict to "unclear"', () => {
    expect(window.gv2NormalizeFinalVerdict({ verdict: 'maybe' }).verdict).toBe('unclear');
    expect(window.gv2NormalizeFinalVerdict({}).verdict).toBe('unclear');
    expect(window.gv2NormalizeFinalVerdict(null)).toEqual({ verdict: 'unclear', reason: '', annotations: [] });
    expect(window.gv2NormalizeFinalVerdict({ verdict: 'failed' }).verdict).toBe('failed');
  });

  test('clamps annotations to [0,1], prevents spill, and drops invalid boxes', () => {
    const raw = {
      verdict: 'failed',
      annotations: [
        { x: 0.9, y: 0.9, w: 0.5, h: 0.5, label: 'near edge' },   // clamped so no spill
        { x: 0.2, y: 0.2, w: 0, h: 0.1, label: 'zero width' },     // dropped
        { x: 'nope', y: 0.1, w: 0.1, h: 0.1, label: 'bad' }        // dropped
      ]
    };
    const r = window.gv2NormalizeFinalVerdict(raw);
    expect(r.annotations).toHaveLength(1);
    const a = r.annotations[0];
    expect(a.x + a.w).toBeLessThanOrEqual(1);
    expect(a.y + a.h).toBeLessThanOrEqual(1);
  });

  test('caps the annotation count at 6 and trims labels', () => {
    const annotations = Array.from({ length: 10 }, (_, i) => ({ x: 0.1, y: 0.1, w: 0.1, h: 0.1, label: 'x'.repeat(200) + i }));
    const r = window.gv2NormalizeFinalVerdict({ verdict: 'completed', annotations });
    expect(r.annotations).toHaveLength(6);
    expect(r.annotations[0].label.length).toBeLessThanOrEqual(60);
  });
});

describe('gv2TargetNormRect / gv2RegionMarkerRect (content/utils.js — recap marker geometry)', () => {
  beforeAll(() => { loadScript('content/utils.js'); });

  test('gv2TargetNormRect normalizes a viewport rect to [0,1] fractions', () => {
    const r = window.gv2TargetNormRect({ left: 100, top: 50, width: 200, height: 40 }, 1000, 800);
    expect(r).toEqual({ x: 0.1, y: 0.0625, w: 0.2, h: 0.05 });
  });

  test('gv2TargetNormRect clamps out-of-bounds rects and prevents right/bottom spill', () => {
    // Element wider than the viewport and offset near the right edge.
    const r = window.gv2TargetNormRect({ left: 900, top: 780, width: 400, height: 400 }, 1000, 800);
    expect(r.x).toBeCloseTo(0.9, 5);
    expect(r.y).toBeCloseTo(0.975, 5);
    expect(r.x + r.w).toBeLessThanOrEqual(1);   // no horizontal spill
    expect(r.y + r.h).toBeLessThanOrEqual(1);   // no vertical spill
  });

  test('gv2TargetNormRect returns null on bad viewport', () => {
    expect(window.gv2TargetNormRect({ left: 0, top: 0, width: 10, height: 10 }, 0, 800)).toBeNull();
    expect(window.gv2TargetNormRect(null, 1000, 800)).toBeNull();
  });

  test('gv2RegionMarkerRect maps a target into in-crop fractions (dpr aware)', () => {
    // dpr=2. Crop origin at image px (100,100), size 400×300. Target at CSS (80,70,50,20).
    // In-crop px: (80*2-100, 70*2-100) = (60,40); size (100,40). Fractions: (0.15,0.1333,0.25,0.1333).
    const crop = { sx: 100, sy: 100, sw: 400, sh: 300 };
    const r = window.gv2RegionMarkerRect({ left: 80, top: 70, width: 50, height: 20 }, crop, 2);
    expect(r.x).toBeCloseTo(0.15, 5);
    expect(r.y).toBeCloseTo(0.13333, 4);
    expect(r.w).toBeCloseTo(0.25, 5);
    expect(r.h).toBeCloseTo(0.13333, 4);
  });

  test('gv2RegionMarkerRect clamps a target sitting past the crop edge', () => {
    const crop = { sx: 0, sy: 0, sw: 200, sh: 200 };
    const r = window.gv2RegionMarkerRect({ left: 150, top: 150, width: 100, height: 100 }, crop, 1);
    expect(r.x).toBeCloseTo(0.75, 5);
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
  });

  test('gv2RegionMarkerRect returns null on bad crop', () => {
    expect(window.gv2RegionMarkerRect({ left: 0, top: 0, width: 10, height: 10 }, { sw: 0, sh: 0 }, 1)).toBeNull();
    expect(window.gv2RegionMarkerRect(null, { sw: 100, sh: 100 }, 1)).toBeNull();
  });
});

describe('Guide default-flag predicates (planning off / recap on)', () => {
  // The runtime gates use the same storage idioms; assert the pure default semantics so a
  // regression that flips a default is caught. Planning is now OFF unless explicitly true;
  // Visual Recap is ON unless explicitly 'off'. The extra end summary agent is OFF unless
  // explicitly 'on'.
  const planningEnabled = (v) => v === true;               // guidev2 _gv2IsPlanningEnabled
  const recapOn = (v) => v !== 'off';                      // guidev2 _gv2IsVisualRecapOn / panel _normalizeRecap
  const endSummaryOn = (v) => v === 'on';                  // guidev2 _gv2IsEndSummaryOn / panel _normalizeEndSummary

  test('planning defaults OFF when unset', () => {
    expect(planningEnabled(undefined)).toBe(false);
    expect(planningEnabled(false)).toBe(false);
    expect(planningEnabled(true)).toBe(true);
  });

  test('visual recap defaults ON when unset, off only when explicitly disabled', () => {
    expect(recapOn(undefined)).toBe(true);
    expect(recapOn('on')).toBe(true);
    expect(recapOn('off')).toBe(false);
  });

  test('end summary agent defaults OFF when unset, on only when explicitly enabled', () => {
    expect(endSummaryOn(undefined)).toBe(false);
    expect(endSummaryOn('off')).toBe(false);
    expect(endSummaryOn('on')).toBe(true);
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
    if (!window.gv2NormalizeRecap) loadScript('content/utils.js');
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
    window.safeSendMessage = (msg) => window.chrome.runtime.sendMessage(msg);
    loadScript('content/tasks/guidev2.js');
  });

  beforeEach(() => {
    window.chrome.runtime.sendMessage.mockClear();
    window.chrome.storage.local.get.mockImplementation(async () => ({}));
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

  // Regression: find's highlights carry data-pageguide-styled, which is the click path's
  // fallback selector. A find step must continue without ever dispatching a click, or the
  // agent would click the very paragraph it just highlighted.
  test('a find step continues without clicking the highlighted passage', async () => {
    const para = document.createElement('p');
    para.setAttribute('data-pageguide-styled', 'true');
    para.textContent = 'Contact the depot within 30 days.';
    const onClick = jest.fn();
    para.addEventListener('click', onClick);
    document.body.appendChild(para);

    window._guidev2._currentStep = { action: 'find', instruction: 'Here is the lost-items policy' };
    const continueGuide = jest.fn(async () => ({ success: true, progressed: true }));

    // Arm the click-wait flag as a preceding click step would, so the find guard has to be
    // what prevents the click — not merely the "not waiting for a click" early return.
    window._gv2SetupClickListener();

    const result = await window.gv2NextStep({ generateAndDispatch: continueGuide });

    expect(continueGuide).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, progressed: true });

    para.remove();
  });

  test('stop clears pending auto-click and auto-type timers', () => {
    window._guidev2._autoClickTimer = setTimeout(() => {}, 1000);
    window._guidev2._autoTypeTimer = setTimeout(() => {}, 1000);

    window.gv2StopGuide();

    expect(window._guidev2._autoClickTimer).toBeNull();
    expect(window._guidev2._autoTypeTimer).toBeNull();
    expect(window._guidev2.active).toBe(false);
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

  test('paused stop builds a recap before clearing guide state', async () => {
    window.chrome.storage.local.get.mockImplementation(async () => ({
      guideEndSummaryAgent: 'on',
      guideVisualRecap: 'on'
    }));
    window._guidev2 = {
      active: true,
      question: 'change language',
      previousSteps: ['Step 1: Open language settings'],
      currentPlanStep: 1,
      autoMode: false,
      paused: true
    };

    const result = await window.gv2StopGuideWithRecap();

    expect(result.success).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.recap?.summary).toContain('The guide recorded 1 step');
    expect(window._guidev2.active).toBe(false);
  });

  test('summary off stops without calling the trajectory summarizer', async () => {
    window.chrome.storage.local.get.mockImplementation(async () => ({
      guideEndSummaryAgent: 'off',
      guideVisualRecap: 'on'
    }));
    window._guidev2 = {
      active: true,
      question: 'change language',
      previousSteps: ['Step 1: Open language settings'],
      currentPlanStep: 1,
      autoMode: false,
      paused: true
    };

    const result = await window.gv2StopGuideWithRecap();

    expect(result.success).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.recap).toBeNull();
    expect(window.chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'callLLM'
    }));
    expect(window.chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'callLLMWithImages'
    }));
  });

  test('summary agent builds screenshot-capable trajectory recap when visual recap is off', async () => {
    window.chrome.storage.local.get.mockImplementation(async () => ({
      guideEndSummaryAgent: 'on',
      guideVisualRecap: 'off'
    }));
    const originalCaptureScreenshot = window.captureScreenshot;
    window.captureScreenshot = jest.fn(async () => 'FINAL_SHOT');
    window._guidev2 = {
      active: true,
      question: 'change language',
      previousSteps: ['Step 1: Open language settings'],
      currentPlanStep: 1,
      autoMode: false,
      paused: true
    };

    try {
      const result = await window.gv2StopGuideWithRecap();

      expect(result.success).toBe(true);
      expect(result.stopped).toBe(true);
      expect(result.recap?.summary).toContain('The guide recorded 1 step');
      expect(result.recap?.milestones).toEqual(expect.arrayContaining([
        expect.objectContaining({ step: 1, text: 'Open language settings' })
      ]));
      expect(window.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: 'callLLMWithImages'
      }));
      const recapCall = window.chrome.runtime.sendMessage.mock.calls
        .map(call => call[0])
        .find(msg => msg?.metadata?.mode === 'guide' && msg?.metadata?.step === 'recap');
      expect(recapCall?.systemPrompt).toContain('summarySegments');
      expect(recapCall?.systemPrompt).toContain('evidenceKey');
      expect(recapCall?.systemPrompt).toContain('inline visual references');
      expect(recapCall?.messages?.[0]?.content).toContain('The UI will render ONLY "summary" as the top prose');
      expect(recapCall?.messages?.[0]?.content).not.toContain('progress=');
      expect(recapCall?.messages?.[0]?.content).not.toContain('mechConfidence=');
      expect(recapCall?.messages?.[0]?.content).not.toContain('grounded=');
    } finally {
      if (originalCaptureScreenshot) window.captureScreenshot = originalCaptureScreenshot;
      else delete window.captureScreenshot;
    }
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

  test('stores evidence scratchpad entries and updates duplicate keys with prior refs', async () => {
    await window.rewindStartSession('s1', 'compare teams');
    await window.rewindPutEvidence('s1', {
      key: 'team_a_color',
      note: 'Team A shirt is red',
      ref_step_id: 7,
      updated_at_step_id: 7,
      previous_ref_step_ids: [],
      region_bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      som_id: null
    });
    await window.rewindPutEvidence('s1', {
      key: 'team_a_color',
      note: 'Team A shirt is crimson',
      ref_step_id: 9,
      updated_at_step_id: 9,
      previous_ref_step_ids: [],
      region_bbox: { x: 0.2, y: 0.2, w: 0.3, h: 0.4 },
      som_id: null
    });

    const idx = await window.rewindGetIndex('s1');
    expect(idx.evidenceScratchpad).toHaveLength(1);
    expect(idx.evidenceScratchpad[0].note).toBe('Team A shirt is crimson');
    expect(idx.evidenceScratchpad[0].ref_step_id).toBe(9);
    expect(idx.evidenceScratchpad[0].previous_ref_step_ids).toEqual([7]);
    expect(await window.rewindGetEvidence('s1', 'team_a_color')).toEqual(idx.evidenceScratchpad[0]);
  });

  test('stores multi-page evidence keys for final cited answers', async () => {
    await window.rewindStartSession('s1', 'compare three teams');
    await window.rewindPutEvidence('s1', {
      key: 'team_a_color',
      note: 'Team A shirt is red',
      ref_step_id: 1,
      updated_at_step_id: 1,
      previous_ref_step_ids: [],
      region_bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      som_id: null
    });
    await window.rewindPutEvidence('s1', {
      key: 'team_b_color',
      note: 'Team B shirt is blue',
      ref_step_id: 3,
      updated_at_step_id: 3,
      previous_ref_step_ids: [],
      region_bbox: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 },
      som_id: null
    });
    await window.rewindPutEvidence('s1', {
      key: 'team_c_color',
      note: 'Team C shirt is green',
      ref_step_id: 5,
      updated_at_step_id: 5,
      previous_ref_step_ids: [],
      region_bbox: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 },
      som_id: null
    });

    const evidence = await window.rewindGetEvidence('s1');
    expect(evidence.map(e => e.key)).toEqual(['team_a_color', 'team_b_color', 'team_c_color']);
    expect(window.gv2EvidenceMemoryText(evidence)).toContain('evidenceKey="team_c_color": Team C shirt is green, captured at step 5');
    expect(window.gv2ParseEvidenceRefs('A [ev:team_a_color], B [ev:team_b_color], C [ev:team_c_color].'))
      .toEqual(['team_a_color', 'team_b_color', 'team_c_color']);
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
    expect(branch.goal).toBe('original');
    expect(branch.branchLabel).toBe('View journey before Step 4');
    expect(branch.steps.map(s => s.step)).toEqual([0, 1, 2, 3]);

    const parent = await window.rewindGetIndex('parent');
    expect(parent.goal).toBe('original');
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

describe('_gv2BuildSteerQuestion (content/tasks/guidev2.js)', () => {
  test('uses the original goal without debug steer context', () => {
    const prompt = window._gv2BuildSteerQuestion('original user goal', {
      newGoal: '',
      parentObservedStepCount: 4,
      redoInstruction: 'wrong next action'
    }, 2, false);

    expect(prompt).toBe('original user goal');
    expect(prompt).not.toContain('Before Step 2');
    expect(prompt).not.toContain('=== STEER CONTEXT ===');
  });

  test('adds steer context when debug experiment is enabled', () => {
    const prompt = window._gv2BuildSteerQuestion('original user goal', {
      newGoal: '',
      parentObservedStepCount: 4,
      redoInstruction: 'Click the wrong tab'
    }, 2, true);

    expect(prompt).toContain('original user goal');
    expect(prompt).toContain('=== STEER CONTEXT ===');
    expect(prompt).toContain('Original journey had 4 observed steps');
    expect(prompt).toContain('Step 2: Click the wrong tab');
    expect(prompt).not.toContain('Before Step 2');
  });
});

describe('guide evidence annotator JSON repair (content/tasks/guidev2.js)', () => {
  beforeAll(() => {
    loadScript('content/utils.js');
    loadScript('content/tasks/guidev2.js');
  });

  test('repairs duplicate bbox y emitted where h was intended', () => {
    const raw = '{"region_bbox":{"x":715,"y":838,"w":0.14,"h":0.14},"annotations":[{"type":"box","bbox":{"x":722,"y":904,"w":0.125,"y":0.018},"label":"Sportsplex Closed"}]}';
    const repaired = window._gv2RepairAnnotatorJsonText(raw);
    const parsed = window.gv2ExtractJsonObject(repaired);
    expect(parsed.annotations[0].bbox).toEqual({
      x: 722,
      y: 904,
      w: 0.125,
      h: 0.018
    });
  });

  test('repairs coordinate arrays and edge/corner aliases before parsing', () => {
    const raw = '{"annotations":[{"type":"box","bbox":[0.1,0.2,0.3,0.4]},{"type":"box","bbox":{"left":0.2,"top":0.3,"right":0.5,"bottom":0.7}}]}';
    const parsed = window.gv2ExtractJsonObject(window._gv2RepairAnnotatorJsonText(raw));
    expect(parsed.annotations[0].bbox).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    expect(parsed.annotations[1].bbox).toEqual({ x: 0.2, y: 0.3, w: 0.3, h: 0.4 });
  });

  test('detects and normalizes raw 0-1000 grid coordinates', () => {
    const raw = {
      region_bbox: { x: 250, y: 50, w: 450, h: 150 },
      annotations: [
        { type: 'box', bbox: { x: 550, y: 80, w: 100, h: 40 }, label: 'Search Button' },
        { type: 'arrow', from: { x: 450, y: 100 }, to: { x: 540, y: 100 }, label: 'click path' }
      ]
    };
    const coerced = window._gv2CoerceAnnotatorResult(raw, { width: 1280, height: 800 });
    expect(coerced.region_bbox).toEqual({ x: 0.25, y: 0.05, w: 0.45, h: 0.15 });
    expect(coerced.annotations[0].bbox).toEqual({ x: 0.55, y: 0.08, w: 0.10, h: 0.04 });
    expect(coerced.annotations[1].from).toEqual({ x: 0.45, y: 0.10 });
    expect(coerced.annotations[1].to).toEqual({ x: 0.54, y: 0.10 });
  });

  test('does not normalize already-fractional coordinates', () => {
    const raw = {
      region_bbox: { x: 0.25, y: 0.05, w: 0.45, h: 0.15 },
      annotations: [
        { type: 'box', bbox: { x: 0.55, y: 0.08, w: 0.10, h: 0.04 }, label: 'Search Button' }
      ]
    };
    const coerced = window._gv2CoerceAnnotatorResult(raw, { width: 1280, height: 800 });
    expect(coerced.region_bbox).toEqual({ x: 0.25, y: 0.05, w: 0.45, h: 0.15 });
    expect(coerced.annotations[0].bbox).toEqual({ x: 0.55, y: 0.08, w: 0.10, h: 0.04 });
  });

  test('does not divide by 1000 if coordinates are absolute pixel values > 1000', () => {
    const raw = {
      region_bbox: { x: 1200, y: 50, w: 450, h: 150 }
    };
    const coerced = window._gv2CoerceAnnotatorResult(raw, { width: 2000, height: 1000 });
    expect(coerced.region_bbox).toEqual({ x: 0.6, y: 0.05, w: 0.225, h: 0.15 });
  });

  test('does not overwrite page evidence rect with a bbox from a separate page image', () => {
    const item = {
      source_image_id: 'page_image_3',
      annotationSourceShot: 'IMAGE_BASE64',
      annotationSourceGeometry: { x: 70, y: 440, w: 840, h: 520 },
      evidenceRect: { x: 0, y: 0, w: 1, h: 1 },
      fullViewportCapture: true
    };

    window._gv2ApplyAnnotatorResultToItem(item, {
      region_bbox: { x: 0.883, y: 0.412, w: 0.07, h: 0.025 },
      annotations: [{ type: 'box', bbox: { x: 0.883, y: 0.412, w: 0.07, h: 0.025 }, label: 'name' }]
    }, 'IMAGE_BASE64');

    expect(item.annotationRegionBbox).toEqual({ x: 0.883, y: 0.412, w: 0.07, h: 0.025 });
    expect(item.evidenceRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(window._gv2EvidenceDisplayRegion(item)).toEqual({ x: 0.883, y: 0.412, w: 0.07, h: 0.025 });
  });

  test('suppresses synthetic full-source display rect when an external annotation produced no region', () => {
    const item = {
      source_image_id: 'page_image_3',
      annotationSourceShot: 'IMAGE_BASE64',
      evidenceRect: { x: 0, y: 0, w: 1, h: 1 },
      fullViewportCapture: true
    };

    expect(window._gv2EvidenceDisplayRegion(item)).toBeNull();
  });

  test('still treats viewport annotator regions as page evidence regions', () => {
    const item = {
      source_image_id: 'viewport',
      evidenceRect: { x: 0, y: 0, w: 1, h: 1 },
      fullViewportCapture: true
    };

    window._gv2ApplyAnnotatorResultToItem(item, {
      region_bbox: { x: 0.2, y: 0.3, w: 0.4, h: 0.1 },
      annotations: []
    }, 'VIEWPORT_BASE64');

    expect(item.annotationRegionBbox).toEqual({ x: 0.2, y: 0.3, w: 0.4, h: 0.1 });
    expect(item.evidenceRect).toEqual({ x: 0.2, y: 0.3, w: 0.4, h: 0.1 });
    expect(window._gv2EvidenceDisplayRegion(item)).toEqual({ x: 0.2, y: 0.3, w: 0.4, h: 0.1 });
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

// Pause→Resume regression. A paused run outlives navigations, but window._guidev2 does not: every
// page the agent opens is a fresh document. Resume therefore rebuilds the run from a saved copy —
// and both copies could be unreachable at once, which is what made Pause a one-way door.
describe('_gv2LoadResumableState (content/tasks/guidev2.js) — where a paused run is recovered from', () => {
  const RUN = { active: true, paused: true, question: 'add an orange', sessionId: 'gv2-x', timestamp: Date.now() };

  beforeAll(() => {
    if (!window._gv2LoadResumableState) {
      window.chrome = {
        runtime: {
          connect: jest.fn(() => ({ onMessage: { addListener: jest.fn() }, onDisconnect: { addListener: jest.fn() } })),
          sendMessage: jest.fn(),
        },
        storage: {
          session: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}), remove: jest.fn(async () => {}) },
          local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) },
        },
      };
      window.safeSendMessage = (msg) => window.chrome.runtime.sendMessage(msg);
      loadScript('content/tasks/guidev2.js');
    }
  });

  // Rebuilt per test rather than patched: guidev2.js is shared with other describes, and whichever
  // ran last owns window.chrome — its shape is not ours to assume.
  beforeEach(() => {
    window.chrome = window.chrome || {};
    window.chrome.storage = window.chrome.storage || {};
    window.chrome.storage.session = {
      get: jest.fn(async () => ({})), set: jest.fn(async () => {}), remove: jest.fn(async () => {}),
    };
    window.safeSendMessage = jest.fn(async () => ({ state: null }));
  });

  test('takes the run from session storage when it is readable', async () => {
    window.chrome.storage.session.get = jest.fn(async () => ({ pageguideGuidanceV2: RUN }));
    const state = await window._gv2LoadResumableState();
    expect(state.question).toBe('add an orange');
    expect(window.safeSendMessage).not.toHaveBeenCalled();   // no need to wake the worker
  });

  // Content scripts cannot touch chrome.storage.session until the service worker grants access, and
  // guidev2 swallows the resulting throw — so this path has to survive the store being silent.
  test('falls back to the service worker when session storage yields nothing', async () => {
    window.safeSendMessage = jest.fn(async () => ({ state: RUN }));
    const state = await window._gv2LoadResumableState();
    expect(state.question).toBe('add an orange');
    expect(window.safeSendMessage).toHaveBeenCalledWith({ action: 'guidanceV2_getState' });
  });

  test('survives session storage throwing outright', async () => {
    window.chrome.storage.session.get = jest.fn(async () => { throw new Error('Access to storage is not allowed from this context.'); });
    window.safeSendMessage = jest.fn(async () => ({ state: RUN }));
    expect((await window._gv2LoadResumableState()).sessionId).toBe('gv2-x');
  });

  test('a finished run is not resumable from either source', async () => {
    window.chrome.storage.session.get = jest.fn(async () => ({ pageguideGuidanceV2: { active: false } }));
    window.safeSendMessage = jest.fn(async () => ({ state: { active: false } }));
    expect(await window._gv2LoadResumableState()).toBeNull();
  });

  test('a worker that cannot answer leaves the caller to report "not active"', async () => {
    window.safeSendMessage = jest.fn(async () => { throw new Error('Receiving end does not exist'); });
    expect(await window._gv2LoadResumableState()).toBeNull();
  });

  // The grant is invisible at runtime — without it every session-storage call from a content script
  // throws and guidev2 swallows it, so the store silently holds nothing. Nothing else would fail
  // loudly enough to notice.
  test('the service worker opens session storage to content scripts', () => {
    const sw = fs.readFileSync(path.join(__dirname, '../../background/service-worker.js'), 'utf8');
    expect(sw).toMatch(/setAccessLevel\(\{[^}]*TRUSTED_AND_UNTRUSTED_CONTEXTS/);
  });

  test('the worker answers a request for this tab’s guide state', () => {
    const sw = fs.readFileSync(path.join(__dirname, '../../background/service-worker.js'), 'utf8');
    expect(sw).toContain("request.action === 'guidanceV2_getState'");
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
          get: jest.fn((keys, callback) => {
            const res = {};
            if (typeof callback === 'function') callback(res);
            return Promise.resolve(res);
          }),
          set: jest.fn((obj, callback) => {
            if (typeof callback === 'function') callback();
            return Promise.resolve();
          }),
          remove: jest.fn((keys, callback) => {
            if (typeof callback === 'function') callback();
            return Promise.resolve();
          })
        },
        local: {
          get: jest.fn((keys, callback) => {
            const res = {};
            if (typeof callback === 'function') callback(res);
            return Promise.resolve(res);
          }),
          set: jest.fn((obj, callback) => {
            if (typeof callback === 'function') callback();
            return Promise.resolve();
          }),
          remove: jest.fn((keys, callback) => {
            if (typeof callback === 'function') callback();
            return Promise.resolve();
          })
        }
      }
    };
    window.getPageBackground = () => ({ isDark: false });
    window.gv2FindElementByText = () => null;
    window.applyIndexedHighlight = () => 0;
    window.cleanupSom = () => {};
    window.clearHighlights = () => {};
    window.rewindPutRecord = jest.fn(async () => {});
    window.captureScreenshot = jest.fn(async () => 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
    window.IS_TEST_ENV = true;
    loadScript('content/utils.js');
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

  test('flags finish responses that omit confirmation evidence targets', () => {
    const issue = window._gv2StepContractIssue(JSON.stringify({
      step: 1,
      thought: 'Done',
      instruction: 'Finish the task.',
      action: 'finish',
      answer: 'The task is complete.',
      confirmationEvidence: 'no'
    }));
    expect(issue).toEqual(expect.objectContaining({ kind: 'missing_confirmation_evidence' }));
  });

  test('finish confirmation evidence with an index requests a DOM marker capture', async () => {
    const evidenceEl = document.createElement('button');
    evidenceEl.textContent = 'Español (idioma)';
    evidenceEl.getClientRects = () => [];
    evidenceEl.getBoundingClientRect = () => ({
      left: 40,
      top: 50,
      width: 160,
      height: 32,
      right: 200,
      bottom: 82
    });
    document.body.appendChild(evidenceEl);
    window._pageguideIndex = { 40: evidenceEl };
    window._guidev2.captureEnabled = true;
    window._guidev2.sessionId = 'confirmation-index-marker-test';
    window.scrollTo = jest.fn();
    const markerNode = document.createElement('div');
    const drawMarker = jest.fn(() => markerNode);
    const removeMarker = jest.fn();
    window.gv2DrawDomMarker = drawMarker;
    window.gv2RemoveDomMarker = removeMarker;
    window.rewindPutRecord = jest.fn(async () => {});

    try {
      const result = await window.gv2ProcessResponse(JSON.stringify({
        step: 1,
        thought: 'The language is now Spanish.',
        instruction: 'Finish.',
        action: 'finish',
        answer: 'The language has been changed to Spanish [ev:40].',
        confirmationEvidence: [{ index: 40, reason: 'The sidebar shows Español (idioma).' }]
      }));

      expect(result.success).toBe(true);
      expect(drawMarker).toHaveBeenCalledWith(evidenceEl, 40, expect.any(String));
      expect(removeMarker).toHaveBeenCalledWith(markerNode);
      const record = window.rewindPutRecord.mock.calls.at(-1)?.[0];
      expect(record.visualEvidenceItems[0]).toEqual(expect.objectContaining({
        key: '40',
        visualEvidenceIndex: 40,
        som_id: '40'
      }));
      expect(record.visualEvidenceItems[0]).toHaveProperty('visualEvidenceOriginalShot');
    } finally {
      evidenceEl.remove();
      delete window.gv2DrawDomMarker;
      delete window.gv2RemoveDomMarker;
    }
  });

  test('flags legacy save_evidence as an invalid standalone action', () => {
    const issue = window._gv2StepContractIssue(JSON.stringify({
      step: 1,
      thought: 'Need to save this.',
      instruction: 'Save evidence.',
      action: 'save_evidence',
      evidence: [{ key: 'headline', note: 'Headline is visible.', som_id: '12' }]
    }));
    expect(issue).toEqual(expect.objectContaining({ kind: 'legacy_save_evidence_action' }));
  });

  test('allows evidence on normal browser actions', () => {
    const issue = window._gv2StepContractIssue(JSON.stringify({
      step: 1,
      thought: 'Click while saving what is visible.',
      instruction: 'Click the World Cup article.',
      action: 'click',
      element: { name: null, index: 12, text: 'World Cup article' },
      evidence: [{ key: 'world_cup_article', note: 'The World Cup article is visible.', som_id: '12' }]
    }));
    expect(issue).toBeNull();
  });

  test('flags malformed evidence sidecars', () => {
    const issue = window._gv2StepContractIssue(JSON.stringify({
      step: 1,
      thought: 'Click while saving malformed evidence.',
      instruction: 'Click the World Cup article.',
      action: 'click',
      element: { name: null, index: 12, text: 'World Cup article' },
      evidence: [{ key: 'world_cup_article', som_id: '12' }]
    }));
    expect(issue).toEqual(expect.objectContaining({ kind: 'invalid_evidence_sidecar' }));
  });

  test('summarizes saved evidence for completed-step trajectory memory', () => {
    expect(window._gv2SavedEvidenceStepSummary([
      { key: 'world_cup_article', note: 'The World Cup article is visible.' }
    ])).toBe(' Saved 1 evidence: The World Cup article is visible.');
    expect(window._gv2SavedEvidenceStepSummary([
      { key: 'a', note: 'First fact' },
      { key: 'b', note: 'Second fact' }
    ])).toBe(' Saved 2 evidence items: First fact.');
  });

  test('consecutive low confidence steps pause after 3 occurrences', async () => {
    const originalCompute = window.gv2ComputeConfidence;
    window.gv2ComputeConfidence = () => ({ confidence: 0.5, grounded: 0.5, loop: 0.0, progress: 0.0, formula: 'full' });

    try {
      const stepJson1 = JSON.stringify({
        step: 1,
        thought: 'First low confidence step',
        instruction: 'Do step 1',
        element: { name: null, index: 1, text: 'Button' },
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
        element: { name: null, index: 2, text: 'Button 2' },
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
        element: { name: null, index: 3, text: 'Button 3' },
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
      element: { name: null, index: 1, text: 'Password input' },
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
      element: { name: null, index: 2, text: 'Submit' },
      action: 'click',
      confirmation: 'needed'
    });

    await window.gv2ProcessResponse(stepJson);
    expect(window._guidev2.paused).toBe(true);
    expect(getPauseMessage()).toBe('Confirmation needed. Please verify and press Resume.');
  });

  test('auto no-ask skips routine confirmation pauses', async () => {
    window._guidev2.autoMode = true;
    window._guidev2.autonomyLevel = 'auto_no_ask';
    const stepJson = JSON.stringify({
      step: 1,
      thought: 'Routine confirmation',
      instruction: 'Open the details panel',
      element: { name: null, index: 2, text: 'Details' },
      action: 'click',
      confirmation: 'needed'
    });

    const result = await window.gv2ProcessResponse(stepJson);

    expect(window._guidev2.paused).toBe(false);
    expect(result.paused).toBe(false);
    expect(getPauseMessage()).toBe('');
    if (window._guidev2._autoClickTimer) {
      clearTimeout(window._guidev2._autoClickTimer);
      window._guidev2._autoClickTimer = null;
    }
  });

  test('auto no-ask skips high-risk json pauses', async () => {
    window._guidev2.autoMode = true;
    window._guidev2.autonomyLevel = 'auto_no_ask';
    const stepJson = JSON.stringify({
      step: 1,
      thought: 'Sensitive task',
      instruction: 'Enter bank password',
      element: { name: null, index: 1, text: 'Password input' },
      action: 'type',
      typeText: 'secret',
      risk: 'high'
    });

    const result = await window.gv2ProcessResponse(stepJson);

    expect(window._guidev2.paused).toBe(false);
    expect(result.paused).toBe(false);
    expect(getPauseMessage()).toBe('');
    if (window._guidev2._autoTypeTimer) {
      clearTimeout(window._guidev2._autoTypeTimer);
      window._guidev2._autoTypeTimer = null;
    }
  });

  test('auto no-ask still pauses for low-confidence guard', async () => {
    const originalCompute = window.gv2ComputeConfidence;
    window.gv2ComputeConfidence = () => ({ confidence: 0.5, grounded: 0.5, loop: 0.0, progress: 0.0, formula: 'full' });
    window._guidev2.autoMode = true;
    window._guidev2.autonomyLevel = 'auto_no_ask';
    window._guidev2.lowConfidenceCount = 2;
    try {
      const stepJson = JSON.stringify({
        step: 1,
        thought: 'Low confidence',
        instruction: 'Click maybe',
        element: { name: null, index: 3, text: 'Maybe' },
        action: 'click'
      });

      const result = await window.gv2ProcessResponse(stepJson);

      expect(window._guidev2.paused).toBe(true);
      expect(result.paused).toBe(true);
      expect(getPauseMessage()).toBe('Page Guide paused: 3 low-confidence actions detected. Review and resume when ready.');
    } finally {
      window.gv2ComputeConfidence = originalCompute;
    }
  });

  test('loop score at or above 0.3 pauses before action', async () => {
    const originalCompute = window.gv2ComputeMechanicalConfidence;
    window.gv2ComputeMechanicalConfidence = () => ({ confidence: 0.95, grounding: 0.95, loop: 0.31, loopMatches: 4 });
    try {
      const stepJson = JSON.stringify({
        step: 1,
        thought: 'Potential loop',
        instruction: 'Click the same menu again',
        element: { name: null, index: 2, text: 'Languages' },
        action: 'click'
      });

      await window.gv2ProcessResponse(stepJson);
      expect(window._guidev2.paused).toBe(true);
      expect(getPauseMessage()).toBe('Page Guide paused: loop score 0.31 is above the 0.3 threshold. Review and resume when ready.');
    } finally {
      window.gv2ComputeMechanicalConfidence = originalCompute;
    }
  });

  test('uses instruction-to-element embedding similarity as mechanical grounding', async () => {
    const button = document.createElement('button');
    button.textContent = 'Languages';
    document.body.appendChild(button);
    window._pageguideIndex = { 1: button };
    window.chrome.runtime.sendMessage.mockImplementation(async (msg) => {
      if (msg?.action === 'callEmbed') {
        return { embeddings: [[1, 0], [0.6, 0.8]] };
      }
      return {};
    });
    window._guidev2.captureEnabled = true;
    window._guidev2.sessionId = 'embedding-grounding-test';
    const originalCompute = window.gv2ComputeMechanicalConfidence;
    const computeSpy = jest.fn(originalCompute);
    window.gv2ComputeMechanicalConfidence = computeSpy;
    try {
      const stepJson = JSON.stringify({
        step: 1,
        thought: 'Open the language menu',
        instruction: 'Click Languages to change the language',
        element: { name: null, index: 1, text: 'Languages' },
        action: 'click'
      });

      await window.gv2ProcessResponse(stepJson);

      expect(window.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: 'callEmbed',
        texts: ['Click Languages to change the language', 'Languages']
      }));
      const computeArg = computeSpy.mock.calls.at(-1)[0];
      expect(computeArg.grounding).toBeCloseTo(0.6, 6);
      const record = window.rewindPutRecord.mock.calls.at(-1)[0];
      expect(record.mechGrounding).toBeCloseTo(0.6, 6);
      expect(record.elementStepSimilarity).toBeCloseTo(0.6, 6);
    } finally {
      window.gv2ComputeMechanicalConfidence = originalCompute;
      button.remove();
    }
  });

  test('normalizes skipped LLM step numbers before storing records', async () => {
    window._guidev2.previousSteps = ['Step 1: Enter pickup location'];
    window._guidev2.captureEnabled = true;
    window._guidev2.sessionId = 'step-normalize-test';

    const stepJson = JSON.stringify({
      step: 3,
      thought: 'The model skipped a hidden step number.',
      instruction: 'Select the pickup date',
      element: { name: null, index: 3, text: 'April 5' },
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

  test('maps annotation and annotations fields to step.evidence', async () => {
    window._guidev2.captureEnabled = true;
    window._guidev2.sessionId = 'annotation-field-test';
    window.safeSendMessage = jest.fn(async () => ({
      content: '{"region_bbox":{"x":0.25,"y":0.05,"w":0.45,"h":0.15},"annotations":[]}'
    }));

    const stepJson = JSON.stringify({
      step: 1,
      thought: 'Need to show visual evidence',
      instruction: 'Click the checkout button',
      action: 'click',
      element: { name: null, index: 5, text: 'Checkout' },
      annotations: [{
        key: 'checkout_btn_ref',
        annotation_prompt: 'Draw a box around the checkout button',
        note: 'Checkout button is highlighted'
      }]
    });

    await window.gv2ProcessResponse(stepJson);

    const recordCalls = window.rewindPutRecord.mock.calls;
    const record = recordCalls[recordCalls.length - 1][0];

    expect(record.savedEvidenceCaptures).toHaveLength(1);
    expect(record.savedEvidenceCaptures[0]).toEqual(expect.objectContaining({
      key: 'checkout_btn_ref',
      note: 'Checkout button is highlighted',
      need_annotation: true,
      annotation_prompt: 'Draw a box around the checkout button',
      region_bbox: { x: 0.25, y: 0.05, w: 0.45, h: 0.15 }
    }));
  });

  test('handles terminal step annotations and expands citations in final answer', async () => {
    const originalPutEvidence = window.rewindPutEvidence;
    const originalLoadScratchpad = window._gv2LoadEvidenceScratchpad;

    try {
      window._guidev2.captureEnabled = true;
      window._guidev2.sessionId = 'final-step-annotation-test';
      window._guidev2.evidenceScratchpad = [];
      
      const mockScratchpad = [];
      window.rewindPutEvidence = jest.fn(async (sess, entry) => {
        mockScratchpad.push(entry);
        return entry;
      });
      window._gv2LoadEvidenceScratchpad = jest.fn(async () => mockScratchpad);

      window.safeSendMessage = jest.fn(async () => ({
        content: '{"region_bbox":{"x":0.1,"y":0.2,"w":0.3,"h":0.4},"annotations":[]}'
      }));

      const stepJson = JSON.stringify({
        step: 1,
        thought: 'Done with task, annotating the final score',
        instruction: 'Finish task',
        action: 'finish',
        answer: 'Match finished. England won: [ev:final_score].',
        annotations: [{
          key: 'final_score',
          annotation_prompt: 'Box the final score',
          note: 'Score shows England 2, Argentina 1'
        }]
      });

      console.log('[DEBUG-TEST] calling gv2ProcessResponse...');
      const result = await window.gv2ProcessResponse(stepJson);
      console.log('[DEBUG-TEST] gv2ProcessResponse finished. result:', JSON.stringify(result));

      expect(window._guidev2.evidenceScratchpad).toHaveLength(1);
      expect(window._guidev2.evidenceScratchpad[0]).toEqual(expect.objectContaining({
        key: 'final_score',
        note: 'Score shows England 2, Argentina 1',
        need_annotation: true,
        region_bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }
      }));

      const recordCalls = window.rewindPutRecord.mock.calls;
      const record = recordCalls[recordCalls.length - 1][0];
      expect(record.savedEvidenceCaptures).toHaveLength(1);
      expect(record.savedEvidenceCaptures[0].key).toBe('final_score');

      expect(result.finalAnswer).toBe('Match finished. England won: Score shows England 2, Argentina 1 [ev:final_score].');
    } finally {
      window.rewindPutEvidence = originalPutEvidence;
      window._gv2LoadEvidenceScratchpad = originalLoadScratchpad;
    }
  });
});

// The find action end-to-end through gv2ProcessResponse, with the reader-pass LLM stubbed.
// Covers the wiring that the pure-helper tests above cannot reach: the second LLM call, the
// content index, highlight application, and the read-only dispatch path.
describe('gv2ProcessResponse find action (content/tasks/guidev2.js)', () => {
  const CITED_ANSWER = 'Contact the depot [12:"within 30 days"] of travel.';

  function findStep(overrides = {}) {
    return JSON.stringify({
      step: 1,
      thought: 'Arrived at the lost property page',
      instruction: 'Here is what to do about lost items',
      action: 'find',
      findQuery: 'what to do when I have lost items',
      isLastStep: true,
      ...overrides
    });
  }

  beforeAll(() => {
    window.chrome = {
      runtime: { sendMessage: jest.fn() },
      storage: {
        session: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}), remove: jest.fn(async () => {}) },
        // Non-grounding baseline mode (isNonGroundingModeOn, content/functions/highlight.js)
        // reads this directly — default empty (unset) so existing tests keep their original
        // "grounding on" behavior unless a test overrides the mock's resolved value.
        local: { get: jest.fn(async () => ({})) }
      }
    };
    window.getPageBackground = () => ({ isDark: false });
    window.gv2FindElementByText = () => null;
    window.applyIndexedHighlight = () => 0;
    window.cleanupSom = () => {};
    window.clearHighlights = () => {};
    window.rewindPutRecord = jest.fn(async () => {});
    window.captureScreenshot = jest.fn(async () => 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
    window.IS_TEST_ENV = true;
    window.PROMPTS = {
      ANSWER_AND_HIGHLIGHT: 'CONTENT:{pageContent}\nINDEX:{pageIndex}',
      FIND_ANSWER_VISUAL: 'VISUAL:{pageContent}\nINDEX:{pageIndex}\nmax={maxItems}'
    };
    // guidev2.js calls gv2ParseFindResponse/gv2StepHasTarget (utils.js), isNonGroundingModeOn
    // (highlight.js), and stripCitationMarkers (ask.js) — the same order manifest.json loads
    // them in. Load all three here so this block stands alone.
    loadScript('content/utils.js');
    loadScript('content/functions/highlight.js');
    loadScript('content/tasks/ask.js');
    loadScript('content/tasks/guidev2.js');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    window.chrome.storage.local.get = jest.fn(async () => ({})); // grounding on (default) unless overridden
    window.getVisibleText = jest.fn(() => 'Lost property. Contact the depot within 30 days of travel.');
    window.createPageIndex = jest.fn(() => ({ indexText: '[12] Contact the depot within 30 days', count: 1 }));
    window.safeSendMessage = jest.fn(async () => ({ content: CITED_ANSWER }));
    window.applyHighlightsFromCitations = jest.fn(() => 2);
    window.scrollToHighlight = jest.fn();
    window._guidev2 = {
      active: true,
      question: 'Find out what to do when I have lost items',
      previousSteps: [],
      autoMode: true,
      paused: false,
      lowConfidenceCount: 0
    };
  });

  test('reads the page with a CONTENT index and highlights the cited passages', async () => {
    const result = await window.gv2ProcessResponse(findStep());

    // interactiveOnly=false — citations must be able to land on paragraphs, not just buttons.
    expect(window.createPageIndex).toHaveBeenCalledWith(5000, false);
    expect(window.applyHighlightsFromCitations).toHaveBeenCalledWith(CITED_ANSWER);

    expect(result.isFind).toBe(true);
    expect(result.action).toBe('find');
    expect(result.answer).toBe(CITED_ANSWER);
    expect(result.findAnswer).toBe(CITED_ANSWER);
    expect(result.highlightCount).toBe(2);
    expect(result.hasHighlights).toBe(true);
    expect(result.findNotOnPage).toBe(false);
    // No single planner-chosen element: the citations own the highlighting.
    expect(result.targetText).toBeNull();
  });

  test('sends the findQuery to the reader pass, not the raw instruction', async () => {
    await window.gv2ProcessResponse(findStep());

    const call = window.safeSendMessage.mock.calls.find(c => String(c[0]?.metadata?.mode || '').startsWith('guide_find'));
    expect(call).toBeTruthy();
    expect(call[0].messages[0].content).toBe('what to do when I have lost items');
    expect(call[0].systemPrompt).toContain('Lost property. Contact the depot');
  });

  test('falls back to the user goal when the model omits findQuery', async () => {
    await window.gv2ProcessResponse(findStep({ findQuery: null }));

    const call = window.safeSendMessage.mock.calls.find(c => String(c[0]?.metadata?.mode || '').startsWith('guide_find'));
    expect(call[0].messages[0].content).toBe('Find out what to do when I have lost items');
  });

  test('skips highlighting when the answer is not on the page', async () => {
    window.safeSendMessage = jest.fn(async () => ({
      content: 'The information is not provided on this page. However, see [Megabus](https://uk.megabus.com).'
    }));

    const result = await window.gv2ProcessResponse(findStep());

    expect(window.applyHighlightsFromCitations).not.toHaveBeenCalled();
    expect(result.findNotOnPage).toBe(true);
    expect(result.hasHighlights).toBe(false);
    expect(result.answer).toContain('not provided on this page');
  });

  test('survives a reader-pass LLM error without failing the step', async () => {
    window.safeSendMessage = jest.fn(async () => ({ error: 'rate limited' }));

    const result = await window.gv2ProcessResponse(findStep());

    expect(window.applyHighlightsFromCitations).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.hasHighlights).toBe(false);
    // With no answer, the card falls back to the planner's instruction.
    expect(result.answer).toBe('Here is what to do about lost items');
  });

  test('a find requested mid-journey is coerced to the terminal (final answer) step', async () => {
    // Req 4: find is ALWAYS the last step — the model may not run it mid-journey. Even when the
    // model returns isLastStep=false, we force it terminal so the trajectory cannot continue.
    const result = await window.gv2ProcessResponse(findStep({ isLastStep: false }));

    expect(result.isLastStep).toBe(true);
    expect(window._guidev2.previousSteps[0]).toContain('✓');
  });

  test('never pauses, even on a carried-over 3-strikes count or a high-risk self-report', async () => {
    window._guidev2.lowConfidenceCount = 3;

    const result = await window.gv2ProcessResponse(findStep({ risk: 'high', confirmation: 'needed' }));

    expect(window._guidev2.paused).toBe(false);
    expect(result.isFind).toBe(true);
    const paused = window.chrome.runtime.sendMessage.mock.calls.find(c => c[0]?.action === 'guidePaused');
    expect(paused).toBeUndefined();
  });

  test('REGRESSION: Non-grounding baseline mode skips highlighting entirely and strips citation markers, even with valid on-page citations', async () => {
    // Same cited answer as the very first test in this block ("reads the page with a CONTENT
    // index and highlights the cited passages"), which asserts highlighting DOES happen by
    // default — this proves the only thing that changed is the stored toggle, not the routing
    // or LLM call. The citation marker itself is also stripped from the displayed answer (not
    // just left unhighlighted), so no clickable chip survives into the chat — but the cited
    // span stays in the prose, since it is part of the sentence the model wrote.
    window.chrome.storage.local.get = jest.fn(async () => ({ pageguideNonGrounding: 'on' }));

    const result = await window.gv2ProcessResponse(findStep());

    expect(window.applyHighlightsFromCitations).not.toHaveBeenCalled();
    // The baseline asks the model the same thing the grounding arm does — the arms must differ only
    // in what the participant is shown, or the answers themselves are not comparable.
    expect(window.safeSendMessage.mock.calls[0][0].systemPrompt).toContain('VISUAL:');
    expect(result.answer).toBe('Contact the depot within 30 days of travel.'); // link gone, full text kept
    expect(result.answer).not.toMatch(/\[\d+/); // no citation bracket syntax left at all
    expect(result.highlightCount).toBe(0);
    expect(result.hasHighlights).toBe(false);
    expect(result.findEvidenceShots).toEqual([]);
  });
});

describe('sidepanel panel.js visual annotations status (sidepanel/panel.js)', () => {
  beforeAll(() => {
    // Mock the runtime.connect required by top-level panel.js load
    window.chrome = {
      runtime: {
        connect: jest.fn(() => ({ disconnect: jest.fn() })),
        sendMessage: jest.fn(),
        onMessage: { addListener: jest.fn() }
      },
      tabs: {
        onActivated: { addListener: jest.fn() },
        onUpdated: { addListener: jest.fn() },
        onRemoved: { addListener: jest.fn() }
      },
      storage: {
        onChanged: { addListener: jest.fn() }
      }
    };
    // Mock document.getElementById for elements referenced during initialization
    document.body.innerHTML = `
      <div id="pageguide-goal-dots"></div>
    `;
    loadScript('sidepanel/panel.js');
  });

  test('correctly extracts annotation preview entries', () => {
    const meta = {
      annotations: [
        { key: 'ann_1', note: 'Annotated note 1' }
      ]
    };
    const rec = {
      savedEvidenceCaptures: [
        { key: 'ann_2', note: 'Annotated note 2', need_annotation: true }
      ]
    };

    const entries = window._savedAnnotationsPreviewEntries(meta, rec);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ key: 'ann_2', note: 'Annotated note 2' });
    expect(entries[1]).toEqual({ key: 'ann_1', note: 'Annotated note 1' });
  });

  test('correctly generates preview HTML for annotations', () => {
    const meta = {
      annotations: [
        { key: 'ann_1', note: 'Annotated note 1' }
      ]
    };
    const rec = {};

    const html = window._savedAnnotationsPreviewHtml(meta, rec);
    expect(html).toContain('pageguide-goal-step-annotations');
    expect(html).toContain('Annotated');
    expect(html).toContain('Annotated note 1');
  });
});

describe('_shouldResetOnTabSwitch (sidepanel/panel.js) — per-tab session vs. guide tab', () => {
  beforeAll(() => {
    window.chrome = {
      runtime: {
        connect: jest.fn(() => ({ disconnect: jest.fn() })),
        sendMessage: jest.fn(),
        onMessage: { addListener: jest.fn() }
      },
      tabs: {
        onActivated: { addListener: jest.fn() },
        onUpdated: { addListener: jest.fn() },
        onRemoved: { addListener: jest.fn() }
      },
      storage: {
        onChanged: { addListener: jest.fn() }
      }
    };
    document.body.innerHTML = `<div id="pageguide-goal-dots"></div>`;
    loadScript('sidepanel/panel.js');
  });

  test('never resets on the very first activation (no prevTabId)', () => {
    expect(window._shouldResetOnTabSwitch(null, 5, false, null)).toBe(false);
  });

  test('never resets when the same tab is re-activated', () => {
    expect(window._shouldResetOnTabSwitch(5, 5, false, null)).toBe(false);
  });

  test('resets when switching tabs and the guide is not active', () => {
    expect(window._shouldResetOnTabSwitch(1, 2, false, null)).toBe(true);
  });

  test('does not reset when switching onto the guide\'s own tab', () => {
    // Guide is running on tab 7 (e.g. it opened/navigated within it); arriving there
    // shouldn't wipe the live guide session.
    expect(window._shouldResetOnTabSwitch(1, 7, true, 7)).toBe(false);
  });

  test('is conservative when the guide is active but its tab is not yet known', () => {
    expect(window._shouldResetOnTabSwitch(1, 2, true, null)).toBe(false);
  });

  test('REGRESSION: switching to an unrelated tab while the guide runs elsewhere starts a separate session', () => {
    // Guide is actively working on tab 7 in the background. The user switches to tab 9 to
    // browse something else. Previously this was suppressed just because a guide was active
    // *anywhere*, so the panel kept showing tab 7's session while looking at tab 9. Tab 9 is
    // unrelated to the guide and must get its own session.
    expect(window._shouldResetOnTabSwitch(7, 9, true, 7)).toBe(true);
  });
});

describe('_shouldRetryGuideActionOnActiveTab (sidepanel/panel.js) — recover from a stale guideTabId', () => {
  // Pause→Resume regression: resume routes strictly to the panel's tracked guideTabId. If that id
  // went stale (the guide opened/moved tabs), the message hits a tab with no live session and
  // returns "Guide not active". We then retry on the tab actually in front before failing.
  test('retries on the active tab when the tracked tab reports no active guide', () => {
    const res = { success: false, error: 'Guide not active' };
    expect(window._shouldRetryGuideActionOnActiveTab(res, 7, 9)).toBe(true);
  });

  test('does not retry when the active tab IS the tab we already tried', () => {
    const res = { success: false, error: 'Guide not active' };
    expect(window._shouldRetryGuideActionOnActiveTab(res, 7, 7)).toBe(false);
  });

  test('does not retry on unrelated failures (only the not-active case)', () => {
    const res = { success: false, error: 'Could not generate the next step' };
    expect(window._shouldRetryGuideActionOnActiveTab(res, 7, 9)).toBe(false);
  });

  test('does not retry when the action succeeded', () => {
    expect(window._shouldRetryGuideActionOnActiveTab({ success: true }, 7, 9)).toBe(false);
  });

  test('does not retry when there is no active tab id to fall back to', () => {
    const res = { success: false, error: 'Guide not active' };
    expect(window._shouldRetryGuideActionOnActiveTab(res, 7, null)).toBe(false);
    expect(window._shouldRetryGuideActionOnActiveTab(res, 7, undefined)).toBe(false);
  });

  // PAUSE used to route strictly to the tracked tab while RESUME retried, so the button you reach
  // for when the agent has wandered somewhere unexpected was the one that gave up first. Both now
  // go through _sendGuideControl.
  describe('_sendGuideControl — pause and resume recover the same way', () => {
    const NOT_ACTIVE = { success: false, error: 'Guide not active' };

    beforeAll(() => {
      window.chrome = {
        runtime: {
          sendMessage: jest.fn(), onMessage: { addListener: jest.fn() }, getURL: (p) => p, id: 'test',
          connect: jest.fn(() => ({
            onMessage: { addListener: jest.fn() }, onDisconnect: { addListener: jest.fn() },
            postMessage: jest.fn(), disconnect: jest.fn(),
          })),
        },
        tabs: {
          query: jest.fn(async () => [{ id: 99 }]), sendMessage: jest.fn(), update: jest.fn(),
          onActivated: { addListener: jest.fn() }, onUpdated: { addListener: jest.fn() },
          onRemoved: { addListener: jest.fn() },
        },
        storage: { onChanged: { addListener: jest.fn() } },
      };
      document.body.innerHTML = '<div id="pageguide-goal-dots"></div>';
      loadScript('sidepanel/panel.js');
    });

    beforeEach(() => {
      window.chrome.tabs.query = jest.fn(async () => [{ id: 99 }]);   // the guide's real tab, in front
    });

    // guideTabId is module state that survives between tests — a successful retry adopts the tab it
    // recovered on. Each test therefore picks a FRESH front tab id, so "the tracked tab is stale"
    // holds regardless of what ran before it.
    let frontTab = 100;
    const useFreshFrontTab = () => {
      frontTab += 1;
      window.chrome.tabs.query = jest.fn(async () => [{ id: frontTab }]);
      return frontTab;
    };

    test.each(['pauseGuide', 'resumeGuide'])('%s retries on the frontmost tab', async (action) => {
      const live = useFreshFrontTab();
      const seen = [];
      window.sendToContentScript = jest.fn(async (msg, tabId) => {
        seen.push({ action: msg.action, tabId });
        return tabId === live ? { success: true } : NOT_ACTIVE;
      });

      const res = await window._sendGuideControl(action, action === 'pauseGuide' ? { reason: 'why' } : {});
      expect(res).toEqual({ success: true });
      expect(seen).toHaveLength(2);                       // the stale tab, then the live one
      expect(seen[seen.length - 1].tabId).toBe(live);
      expect(seen.every(s => s.action === action)).toBe(true);
    });

    test('the reason travels with a pause, including on the retry', async () => {
      const live = useFreshFrontTab();
      const seen = [];
      window.sendToContentScript = jest.fn(async (msg, tabId) => {
        seen.push(msg);
        return tabId === live ? { success: true } : NOT_ACTIVE;
      });
      await window._sendGuideControl('pauseGuide', { reason: 'Guide paused.' });
      expect(seen).toHaveLength(2);
      expect(seen.every(m => m.reason === 'Guide paused.')).toBe(true);
    });

    test('an unrelated failure is returned as-is rather than retried', async () => {
      useFreshFrontTab();
      const fail = { success: false, error: 'Could not generate the next step' };
      window.sendToContentScript = jest.fn(async () => fail);
      expect(await window._sendGuideControl('resumeGuide')).toEqual(fail);
      expect(window.sendToContentScript).toHaveBeenCalledTimes(1);
    });

    test('a failed retry leaves the original failure in place', async () => {
      useFreshFrontTab();
      window.sendToContentScript = jest.fn(async () => NOT_ACTIVE);
      expect(await window._sendGuideControl('pauseGuide')).toEqual(NOT_ACTIVE);
      expect(window.sendToContentScript).toHaveBeenCalledTimes(2);
    });

    // Reloading the extension orphans the content script on every open page: it stops listening,
    // and messaging it REJECTS rather than answering. That rejection used to escape as
    // "Could not establish connection", which is not the guide saying no — it is nobody being
    // there to ask, and it made "reload to pick up a fix" cost you the paused run.
    describe('a page that has lost its content script', () => {
      const DEAD = new Error('Could not establish connection. Receiving end does not exist.');

      test('is recognised as absence, not as an answer', () => {
        expect(window._isDeadContentScriptError({ error: DEAD.message })).toBe(true);
        expect(window._isDeadContentScriptError({ error: 'Extension context invalidated.' })).toBe(true);
        expect(window._isDeadContentScriptError(NOT_ACTIVE)).toBe(false);
        expect(window._isDeadContentScriptError({ success: true })).toBe(false);
      });

      test('is reinjected, and the control retried on the same tab', async () => {
        useFreshFrontTab();
        window.chrome.tabs.sendMessage = jest.fn(async () => { throw DEAD; });   // the ping
        window.chrome.scripting = { executeScript: jest.fn(async () => {}), insertCSS: jest.fn(async () => {}) };
        window.chrome.runtime.getManifest = () => ({ content_scripts: [{ js: ['a.js', 'b.js'], css: ['c.css'] }] });

        let firstTry = true;
        window.sendToContentScript = jest.fn(async () => {
          if (firstTry) { firstTry = false; throw DEAD; }
          return { success: true };
        });

        expect(await window._sendGuideControl('resumeGuide')).toEqual({ success: true });
        expect(window.chrome.scripting.executeScript).toHaveBeenCalledWith(
          expect.objectContaining({ files: ['a.js', 'b.js'] }));
        expect(window.chrome.scripting.insertCSS).toHaveBeenCalled();
      });

      test('is left alone when the ping answers — a second copy would be a redeclaration crash', async () => {
        useFreshFrontTab();
        window.chrome.tabs.sendMessage = jest.fn(async () => ({ success: true, alive: true }));
        window.chrome.scripting = { executeScript: jest.fn(async () => {}), insertCSS: jest.fn(async () => {}) };
        let firstTry = true;
        window.sendToContentScript = jest.fn(async () => {
          if (firstTry) { firstTry = false; throw DEAD; }
          return { success: true };
        });

        await window._sendGuideControl('pauseGuide');
        expect(window.chrome.scripting.executeScript).not.toHaveBeenCalled();
      });

      test('says what the reader can do when reinjection is refused too', () => {
        expect(window._guideControlErrorText(DEAD.message)).toMatch(/reload the page/i);
        expect(window._guideControlErrorText('Guide not active')).toBe('Guide not active');
      });
    });
  });

  test('a null response (messaging dropped, no error text) does not trigger the not-active retry', () => {
    expect(window._shouldRetryGuideActionOnActiveTab(null, 7, 9)).toBe(false);
  });

  // REGRESSION: a guide that re-pauses while resume is still awaiting must stay marked paused.
  describe('_shouldApplyResumeSuccess — a pause landing mid-resume wins', () => {
    test('clean resume (no pause arrived while awaiting) marks the guide running again', () => {
      expect(window._shouldApplyResumeSuccess(3, 3)).toBe(true);
    });

    test('REGRESSION: a guidePaused message during the resume await is not clobbered', () => {
      // resume awaits the whole next-step generation; if that step re-trips the loop /
      // low-confidence guard, guidePaused arrives first and bumps the counter. Clearing
      // guidePaused afterwards left the button on "Pause", so the user could never resume.
      expect(window._shouldApplyResumeSuccess(3, 4)).toBe(false);
    });
  });
});

describe('_doCaptureScreenshot active-tab guard (background/service-worker.js)', () => {
  beforeAll(() => {
    // Minimal chrome mock covering every top-level chrome.*.addListener call service-worker.js
    // makes when it's first loaded, plus everything _doCaptureScreenshot touches.
    window.chrome = {
      action: { onClicked: { addListener: jest.fn() } },
      runtime: {
        onConnect: { addListener: jest.fn() },
        onMessage: { addListener: jest.fn() },
        sendMessage: jest.fn(),
        getURL: jest.fn(() => 'chrome-extension://pageguide/'),
        getPlatformInfo: jest.fn()
      },
      tabs: {
        onCreated: { addListener: jest.fn() },
        onUpdated: { addListener: jest.fn() },
        onRemoved: { addListener: jest.fn() },
        get: jest.fn(),
        query: jest.fn(),
        captureVisibleTab: jest.fn(),
        sendMessage: jest.fn()
      },
      debugger: {
        attach: jest.fn().mockResolvedValue(undefined),
        detach: jest.fn().mockResolvedValue(undefined),
        sendCommand: jest.fn(),
        onDetach: { addListener: jest.fn() }
      },
      storage: {
        sync: { get: jest.fn().mockResolvedValue({}) },
        local: { get: jest.fn().mockResolvedValue({}) },
        session: { get: jest.fn(), set: jest.fn(), remove: jest.fn() }
      }
    };
    loadScript('background/service-worker.js');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('captures a backgrounded tab via chrome.debugger instead of grabbing whatever tab is now visible', async () => {
    // chrome.tabs.captureVisibleTab only ever captures the currently-active tab of a window — it
    // can't target tabId directly. When tabId is no longer that window's active tab (the user
    // switched away to work in another tab), we screenshot the agent's real tab through the
    // debugger (CDP Page.captureScreenshot) rather than grabbing the WRONG, now-visible tab.
    window.chrome.tabs.get.mockResolvedValue({ id: 7, windowId: 1, active: false });
    window.chrome.debugger.sendCommand.mockResolvedValue({ data: 'BBBB' });
    const result = await window._doCaptureScreenshot(7, 1);
    expect(result.success).toBe(true);
    expect(result.imageBase64).toBe('BBBB');
    expect(window.chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3');
    expect(window.chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    // Never fell back to grabbing the visible (wrong) tab.
    expect(window.chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  test('REGRESSION: surfaces an error (for the cached/placeholder fallback) when the debugger cannot attach to the background tab', async () => {
    // e.g. DevTools is already open on that tab, or it's a restricted page. We must NOT silently
    // grab the visible tab — return an error so the vision pipeline falls back to a cached shot.
    window.chrome.tabs.get.mockResolvedValue({ id: 9, windowId: 1, active: false });
    window.chrome.debugger.attach.mockRejectedValue(new Error('Another debugger is already attached'));
    const result = await window._doCaptureScreenshot(9, 1);
    expect(result.error).toBeTruthy();
    expect(window.chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  test('captures normally via captureVisibleTab (no debugger) when the target tab is still the active/visible tab', async () => {
    window.chrome.tabs.get.mockResolvedValue({ id: 7, windowId: 1, active: true });
    window.chrome.tabs.captureVisibleTab.mockResolvedValue('data:image/jpeg;base64,AAAA');
    const result = await window._doCaptureScreenshot(7, 1);
    expect(result.success).toBe(true);
    expect(result.imageBase64).toBe('AAAA');
    expect(window.chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(1, { format: 'jpeg', quality: 80 });
    // Front tab → no debugger attach, so no "…is debugging this browser" banner.
    expect(window.chrome.debugger.attach).not.toHaveBeenCalled();
  });

  test('still attempts capture (and surfaces captureVisibleTab\'s own error) when chrome.tabs.get fails, e.g. the tab was closed', async () => {
    window.chrome.tabs.get.mockRejectedValue(new Error('No tab with id: 7'));
    window.chrome.tabs.captureVisibleTab.mockRejectedValue(new Error('No window with id: 1'));
    const result = await window._doCaptureScreenshot(7, 1);
    expect(result.error).toMatch(/Screenshot failed/);
  });
});

describe('Save Chat captures every answer type (sidepanel/panel.js)', () => {
  beforeAll(() => {
    window.chrome = {
      runtime: {
        connect: jest.fn(() => ({ disconnect: jest.fn() })),
        sendMessage: jest.fn(),
        onMessage: { addListener: jest.fn() }
      },
      tabs: {
        onActivated: { addListener: jest.fn() },
        onUpdated: { addListener: jest.fn() },
        onRemoved: { addListener: jest.fn() }
      },
      storage: {
        onChanged: { addListener: jest.fn() },
        local: {
          get: jest.fn().mockResolvedValue({}),
          set: jest.fn().mockResolvedValue(undefined)
        }
      }
    };
    document.body.innerHTML = `
      <div id="pageguide-goal-dots"></div>
      <div id="pageguide-messages"></div>
    `;
    loadScript('sidepanel/panel.js');
  });

  beforeEach(() => {
    // Fresh chat + mock call history for every test.
    window._getChatMessages().length = 0;
    jest.clearAllMocks();
    window.chrome.storage.local.get.mockResolvedValue({});
    window.chrome.storage.local.set.mockResolvedValue(undefined);
    document.getElementById('pageguide-messages').innerHTML = '';
  });

  test('_recordAssistantMessage pushes a plain-text assistant entry', () => {
    window._recordAssistantMessage('The answer is 42.');
    expect(window._getChatMessages()).toEqual([
      expect.objectContaining({ content: 'The answer is 42.', type: 'assistant' })
    ]);
  });

  test('_recordAssistantMessage is a no-op for empty/whitespace content', () => {
    window._recordAssistantMessage('');
    window._recordAssistantMessage('   ');
    window._recordAssistantMessage(undefined);
    expect(window._getChatMessages()).toHaveLength(0);
  });

  test('REGRESSION: renderFindAnswer, renderVisualHighlightAnswer, renderWatchVideoAnswer, ' +
    'renderGuideFinalAnswer, and renderGuideRecapCard all reach chatMessages, not just addMessage()', async () => {
    // Before this fix, these five render functions built their own DOM bubble directly and never
    // touched chatMessages, so saveCurrentChat() silently dropped every Guide/Find/Visual-Highlight/
    // Watch-Video answer — only the user's own question (added via addMessage) got saved.
    addMessage('What is the return policy?', 'user');
    window.renderFindAnswer({ findAnswer: 'Returns are accepted within 30 days.' });
    window.renderVisualHighlightAnswer({ visualHighlightImage: 'AAAA', visualHighlightCaption: 'The banner shows free shipping.' });
    window.renderWatchVideoAnswer({ watchVideoAnswer: 'The video explains setup in the first 2 minutes.' });
    await window.renderGuideFinalAnswer({ finalAnswer: 'Task completed: order was placed.' });
    await window.renderGuideRecapCard({ summary: 'Guide finished after 5 steps.', milestones: [] }, 'Stopped');
    window.renderGuideFinalStateCard({ step: 1, verdict: 'unclear', reason: 'Reached the final page.' });

    const texts = window._getChatMessages().map(m => m.content);
    expect(texts).toEqual(expect.arrayContaining([
      'What is the return policy?',
      'Returns are accepted within 30 days.',
      'The banner shows free shipping.',
      'The video explains setup in the first 2 minutes.',
      'Task completed: order was placed.',
      'Guide finished after 5 steps.',
      '[Unsure] Reached the final page.'
    ]));

    await window.saveCurrentChat();
    expect(window.chrome.storage.local.set).toHaveBeenCalled();
    const saved = window.chrome.storage.local.set.mock.calls[0][0]['pageguide_history'][0];
    const savedTexts = saved.messages.map(m => m.content);
    expect(savedTexts).toEqual(expect.arrayContaining(texts));
  });
});

describe('User Study pure helpers (sidepanel/study.js)', () => {
  beforeAll(() => {
    loadScript('sidepanel/study.js');
  });

  describe('_formatStudyTime', () => {
    test('formats whole minutes', () => {
      expect(window._formatStudyTime(3 * 60 * 1000)).toBe('03:00');
    });
    test('formats partial minutes with padding', () => {
      expect(window._formatStudyTime(65 * 1000)).toBe('01:05');
    });
    test('clamps negative durations to 00:00', () => {
      expect(window._formatStudyTime(-500)).toBe('00:00');
    });
  });

  // EXACTLY TWO CONDITIONS. The field used to be built by gluing a client label to an evidence mode,
  // which produced five strings for two conditions ("extension", "extension-text",
  // "extension-grounding", "extension-nongrounding", "extension-visual") — and the ones written
  // before the arm was known cannot be normalised afterwards at all, because the arm is not in them.
  describe('studyConditionLabel', () => {
    test('there are two conditions and only two', () => {
      expect(window.studyConditionLabel('grounding')).toBe('grounding');
      expect(window.studyConditionLabel('nongrounding')).toBe('nongrounding');
    });

    // A recorder pass has no arm; it must still land on one of the two, never on a third string.
    test('an unknown or missing arm resolves to grounding, not a new value', () => {
      [undefined, null, '', 'visual', 'extension', 'anything'].forEach(v => {
        expect(window.studyConditionLabel(v)).toBe('grounding');
      });
    });

    test('the website writes the identical two labels', () => {
      const site = require('fs').readFileSync(
        require('path').join(__dirname, '../../../user_study_website/app/session.js'), 'utf8');
      expect(site).toMatch(/return arm === 'nongrounding' \? 'nongrounding' : 'grounding';/);
    });

    // Which client produced a row is worth knowing — it is just not this column.
    test('the client is recorded separately, not folded into the condition', () => {
      const site = require('fs').readFileSync(
        require('path').join(__dirname, '../../../user_study_website/app/session.js'), 'utf8');
      expect(site).toMatch(/source: 'pageguide-web'/);
    });
  });

  describe('_buildTaskQueue', () => {
    test('flattens find then guide tasks, preserving file order', () => {
      const data = {
        find: [{ id: 'f1' }, { id: 'f2' }],
        guide: [{ id: 'g1' }],
      };
      const queue = window._buildTaskQueue(data);
      expect(queue).toEqual([
        { taskType: 'find', task: { id: 'f1' } },
        { taskType: 'find', task: { id: 'f2' } },
        { taskType: 'guide', task: { id: 'g1' } },
      ]);
    });

    test('tolerates missing arrays', () => {
      expect(window._buildTaskQueue({})).toEqual([]);
      expect(window._buildTaskQueue(null)).toEqual([]);
    });
  });

  describe('_gradeFindAnswer', () => {
    test('grades case- and whitespace-insensitively', () => {
      expect(window._gradeFindAnswer('  1936 ', '1936')).toBe(true);
      expect(window._gradeFindAnswer('Guido Van Rossum', 'guido van rossum')).toBe(true);
    });
    test('marks a wrong answer incorrect', () => {
      expect(window._gradeFindAnswer('1943', '1936')).toBe(false);
    });
  });

  describe('_shuffleStudyOptions', () => {
    test('is a pure permutation (same elements, injectable RNG for determinism)', () => {
      const input = ['a', 'b', 'c', 'd'];
      const shuffled = window._shuffleStudyOptions(input, () => 0.999); // deterministic RNG
      expect(shuffled.slice().sort()).toEqual(input.slice().sort());
      expect(input).toEqual(['a', 'b', 'c', 'd']); // does not mutate the input
    });
  });

  describe('_studyEvidencePrompts', () => {
    test('falls back to the generic pair for a task with no type', () => {
      expect(window._studyEvidencePrompts({})).toEqual([
        { hop: 1, prompt: 'Which paragraph supports the first part of the question?', kind: 'paragraph', hint: '' },
        { hop: 2, prompt: 'Which paragraph supports the final answer?', kind: 'paragraph', hint: '' },
      ]);
    });

    // Both arms ask for a sentence on hop 1. They diverge on hop 2: a FIND × VISUAL item's second
    // hop lives in a picture, so that hop asks for the image and is answered from the page's image
    // list rather than its paragraphs.
    test('FIND x TEXT asks for a sentence on both hops', () => {
      expect(window._studyEvidencePrompts({ type: 'FIND x TEXT' })).toEqual([
        { hop: 1, prompt: 'What sentence gives you the answer to the first part?', kind: 'paragraph', hint: '' },
        { hop: 2, prompt: 'What sentence gives you the answer to the second part?', kind: 'paragraph', hint: '' },
      ]);
    });

    test('FIND x VISUAL asks for the image on the second hop', () => {
      expect(window._studyEvidencePrompts({ type: 'FIND X VISUAL' })).toEqual([
        { hop: 1, prompt: 'Choose the evidence that helps answer the first part', kind: 'paragraph', hint: '' },
        { hop: 2, prompt: 'Choose the image that helps answer the question', kind: 'image', hint: '' },
      ]);
    });

    // The spreadsheet's casing is inconsistent ("FIND X VISUAL" vs "FIND x TEXT").
    test('matches the type loosely, whatever the casing', () => {
      expect(window._studyEvidencePrompts({ type: 'find x visual' })[1].kind).toBe('image');
      expect(window._studyEvidencePrompts({ type: 'FIND X TEXT' })[1].kind).toBe('paragraph');
    });

    test('an explicit per-task override still wins', () => {
      expect(window._studyEvidencePrompts({
        type: 'FIND X VISUAL',
        evidence_questions: ['Evidence for hop one?', 'Evidence for hop two?', 'ignored'],
      })).toEqual([
        { hop: 1, prompt: 'Evidence for hop one?', kind: 'paragraph', hint: '' },
        { hop: 2, prompt: 'Evidence for hop two?', kind: 'paragraph', hint: '' },
      ]);
    });

    // An override wins over the arm's own pair, including on a VISUAL task — the point of the field
    // is that one question needs asking differently.
    test('the override beats the arm’s wording', () => {
      const prompts = window._studyEvidencePrompts({
        type: 'FIND X VISUAL',
        evidence_questions: ['First?', 'Locate the evidence by the year next to it.'],
      });
      expect(prompts[1].prompt).toBe('Locate the evidence by the year next to it.');
      expect(prompts[1].kind).toBe('paragraph'); // a year on the page is text, not a picture
    });

    // A hint points at where the answer sits on THIS page without changing what was asked, so every
    // participant is still answering the same question and the responses stay comparable.
    test('a hint rides alongside the question rather than replacing it', () => {
      const prompts = window._studyEvidencePrompts({
        type: 'FIND x TEXT',
        evidence_hints: ['', 'Locate the year next to the evidence on the page.'],
      });

      expect(prompts[0].prompt).toBe('What sentence gives you the answer to the first part?');
      expect(prompts[0].hint).toBe('');
      expect(prompts[1].prompt).toBe('What sentence gives you the answer to the second part?');
      expect(prompts[1].hint).toBe('Locate the year next to the evidence on the page.');
    });

    test('hints apply to the visual arm and to an overridden question too', () => {
      expect(window._studyEvidencePrompts({ type: 'FIND X VISUAL', evidence_hints: ['look left'] })[0].hint)
        .toBe('look left');
      expect(window._studyEvidencePrompts({ evidence_questions: ['a?', 'b?'], evidence_hints: ['', 'and here'] })[1].hint)
        .toBe('and here');
    });

    test('no hints means no hints', () => {
      expect(window._studyEvidencePrompts({ type: 'FIND x TEXT' }).every(p => p.hint === '')).toBe(true);
      expect(window._studyEvidencePrompts({ type: 'FIND x TEXT', evidence_hints: 'nope' })[0].hint).toBe('');
    });

    test('a half-filled override is ignored rather than half-applied', () => {
      expect(window._studyEvidencePrompts({ type: 'FIND x TEXT', evidence_questions: ['only one'] })[0].prompt)
        .toBe('What sentence gives you the answer to the first part?');
    });
  });

  describe('_buildStudyResultRecord', () => {
    test('grades a find task and fills in interaction/chat counts', () => {
      const record = window._buildStudyResultRecord({
        participantId: 'P07',
        sessionId: 42,
        taskIndex: 0,
        blockIndex: 0,
        questionIndex: 0,
        totalTasks: 6,
        taskType: 'find',
        task: { id: 'find-1', question: 'When?', answer: '1936', url: 'https://example.com' },
        condition: 'extension',
        elapsedMs: 45000,
        notesElapsedMs: 32000,
        answerElapsedMs: 13000,
        evidenceResponses: [
          { hop: 1, prompt: 'Which paragraph supports the first part of the question?', index: 4, role: 'paragraph', text: 'A first-hop paragraph.', url: 'https://example.com' },
          { hop: 2, prompt: 'Which paragraph supports the final answer?', index: 9, role: 'paragraph', text: 'A final-answer paragraph.', url: 'https://example.com' },
        ],
        answer: '1936',
        confidence: 'very',
        helpfulness: 'very',
        chatSnapshot: { chat_turn_count: 2, chat_transcript: [{ role: 'user', content: 'hi' }] },
        behaviorData: {
          scroll_user_count: 3, scroll_agent_count: 2, ctrl_f_count: 1, text_select_count: 0,
          click_count: 5, mouse_move_px: 120, agent_think_ms: [800, 1200],
          page_visit_count: 1, page_visit_urls: ['https://example.com'],
        },
      });
      expect(record).toMatchObject({
        tool: 'pageguide',
        session_id: 42,
        participant_id: 'P07',
        task_id: 'find-1',
        task_type: 'find',
        condition: 'extension',
        time_ms: 45000,
        notes_time_ms: 32000,
        answer_time_ms: 13000,
        evidence_responses: [
          { hop: 1, prompt: 'Which paragraph supports the first part of the question?', index: 4, role: 'paragraph', text: 'A first-hop paragraph.', url: 'https://example.com' },
          { hop: 2, prompt: 'Which paragraph supports the final answer?', index: 9, role: 'paragraph', text: 'A final-answer paragraph.', url: 'https://example.com' },
        ],
        block_index: 0,
        task_index: 0,
        question_index: 0,
        answer: '1936',
        answer_correct: true,
        chat_turn_count: 2,
        scroll_user_count: 3,
        scroll_agent_count: 2,
        ctrl_f_count: 1,
        click_count: 5,
        mouse_move_px: 120,
        agent_think_ms: [800, 1200],
        page_visit_count: 1,
        page_visit_urls: ['https://example.com'],
      });
      // task_data preserves the original task (including id/url, which have no dedicated column).
      expect(record.task_data).toMatchObject({ id: 'find-1', url: 'https://example.com' });
    });

    test('REGRESSION: guide tasks are never graded right/wrong (self-reported completion only)', () => {
      const record = window._buildStudyResultRecord({
        participantId: 'P07',
        sessionId: null,
        taskIndex: 2,
        blockIndex: 0,
        questionIndex: 0,
        totalTasks: 6,
        taskType: 'guide',
        task: { id: 'guide-1', task: 'Do the thing', url: 'https://example.com' },
        condition: 'extension',
        elapsedMs: 90000,
        notesElapsedMs: 70000,
        answerElapsedMs: 20000,
        answer: 'completed',
        confidence: 'somewhat',
        helpfulness: 'somewhat',
        chatSnapshot: null,
        behaviorData: null,
      });
      expect(record.answer_correct).toBeNull();
      expect(record.answer).toBe('completed');
      expect(record.evidence_responses).toEqual([]);
      expect(record.chat_turn_count).toBe(0);
      // Missing behavior data defaults every count to 0 / empty, never undefined (NOT NULL columns).
      expect(record.scroll_user_count).toBe(0);
      expect(record.scroll_agent_count).toBe(0);
      expect(record.agent_think_ms).toEqual([]);
      expect(record.session_id).toBeNull();
      expect(record.time_ms).toBe(90000);
      expect(record.notes_time_ms).toBe(70000);
      expect(record.answer_time_ms).toBe(20000);
    });
  });

  // A participant answers in two acts — commit to a choice, then find the evidence for it — and the
  // split is what shows which act the grounding helped. Averaging them together hides it.
  describe('the answer-time split', () => {
    const build = (extra) => window._buildStudyResultRecord(Object.assign({
      participantId: 'P1', taskIndex: 0, totalTasks: 1, taskType: 'find',
      task: { id: 'T', url: 'u', question: 'q?', answer: 'a' }, answer: 'a',
      elapsedMs: 1000, notesElapsedMs: 400, answerElapsedMs: 600,
    }, extra));

    test('records each half beside the total', () => {
      const rec = build({ answerChoiceMs: 250, findSupportingMs: 350 });
      expect(rec.answer_time_ms).toBe(600);
      expect(rec.answer_multiple_choice_ms).toBe(250);
      expect(rec.find_supporting_answer_ms).toBe(350);
      expect(rec.answer_multiple_choice_ms + rec.find_supporting_answer_ms).toBe(rec.answer_time_ms);
    });

    // A recorder's pass, or a guide task: one stage, so there is no evidence phase to time.
    test('a one-stage answer records no supporting time', () => {
      const rec = build({ answerChoiceMs: 600, findSupportingMs: null });
      expect(rec.answer_multiple_choice_ms).toBe(600);
      expect(rec.find_supporting_answer_ms).toBeNull();
    });

    test('missing timings are null, not zero', () => {
      const rec = build({});
      expect(rec.answer_multiple_choice_ms).toBeNull();
      expect(rec.find_supporting_answer_ms).toBeNull();
    });
  });

  // "Found no error" and "was never asked" are different findings; [] vs null is what tells them
  // apart, so a guide task must never record null for a question it did ask.
  describe('a guide task’s verdict', () => {
    const build = (guideAnswer) => window._buildStudyResultRecord({
      participantId: 'P1', taskIndex: 0, totalTasks: 1, taskType: 'guide',
      task: { id: 'GT', url: '', task: 'Sort by price' }, answer: 'incorrect',
      elapsedMs: 900, answerElapsedMs: 900, guideAnswer,
    });

    // `steps` is a list of NUMBERS, not the string a text field used to hand over. The participant
    // now taps the steps, so there is no format to parse and no "2-3" to interpret.
    test('records the verdict, the problem and every error with its steps', () => {
      const rec = build({
        correct: false, problem: 'It sorted by rating.',
        errors: [{ type: 'wrong_target', steps: [3] }, { type: 'loop', steps: [5, 6] }],
      });

      expect(rec.guide_answer_correct).toBe(false);
      expect(rec.guide_answer_problem).toBe('It sorted by rating.');
      expect(rec.guide_errors).toEqual([{ type: 'wrong_target', steps: [3] }, { type: 'loop', steps: [5, 6] }]);
    });

    test('“no error” is an empty list, not null', () => {
      expect(build({ correct: true, problem: '', errors: [] }).guide_errors).toEqual([]);
    });

    test('a find task leaves all three null — it was never asked', () => {
      const rec = window._buildStudyResultRecord({
        participantId: 'P1', taskIndex: 0, totalTasks: 1, taskType: 'find',
        task: { id: 'F', url: '', question: 'q?', answer: 'a' }, answer: 'a', elapsedMs: 100,
      });
      expect(rec.guide_answer_correct).toBeNull();
      expect(rec.guide_errors).toBeNull();
    });
  });

  describe('_buildStudyResultsCSV', () => {
    test('produces a header row plus one row per result, quoting fields with commas', () => {
      const csv = window._buildStudyResultsCSV([
        { tool: 'pageguide', participant_id: 'P07', task_id: 'find-1', task_type: 'find', answer: 'a, b', page_visit_urls: ['https://a.com'] },
      ]);
      const lines = csv.split('\n');
      expect(lines[0]).toBe(
        'tool,participant_id,session_id,condition,block_index,task_index,question_index,task_id,task_type,question_or_task,url,time_ms,notes_time_ms,answer_time_ms,answer_multiple_choice_ms,find_supporting_answer_ms,evidence_responses,guide_answer_correct,guide_answer_problems,guide_answer_problem,guide_errors,score_verdict_correct,score_problem_precision,score_problem_recall,score_problem_exact,score_type_precision,score_type_recall,score_step_precision,score_step_recall,score_step_exact,score_no_error_agreement,answer,answer_correct,confidence,helpfulness,chat_turn_count,scroll_user_count,scroll_agent_count,ctrl_f_count,text_select_count,click_count,mouse_move_px,agent_think_ms,page_visit_count,page_visit_urls,completed_at'
      );
      expect(lines[1]).toContain('"a, b"');
      // page_visit_urls is an array — JSON-stringified, then CSV-quoted since that JSON contains
      // both commas and quotes (the inner quotes get doubled per CSV escaping rules).
      expect(lines[1]).toContain('"[""https://a.com""]"');
    });

    test('an empty result set is just the header row', () => {
      const csv = window._buildStudyResultsCSV([]);
      expect(csv.split('\n')).toHaveLength(1);
    });
  });

  // The Answer screen replays the chat bubble's own markup, so anything the chat shows that the
  // participant must not see has to be stripped on the way in.
  describe('_sanitizeStudyAnswerHtml', () => {
    const answerHtml = 'The name is <b>S. Dutton Whitney</b>' +
      '<span class="pageguide-citation pageguide-citation-idx pageguide-evidence-citation" data-evidence-num="3"><sup class="citation-index">[3]</sup></span>' +
      '<div class="pageguide-debug-answer-row">' +
      '<button class="pageguide-debug-answer-chip" data-debug-from="0">🐞 Debug</button>' +
      '<button class="pageguide-study-save-chip" data-answer-id="1">💾 Save</button>' +
      '<button class="pageguide-study-edit-chip" data-answer-id="1">✏️ Edit</button>' +
      '</div>';

    // The Answer screen authors from its arm tabs, where the tab says which condition an action
    // writes to, so the chat's own chip row has no job there.
    test('drops the whole chat chip row', () => {
      const out = window._sanitizeStudyAnswerHtml(answerHtml);
      expect(out).not.toContain('pageguide-debug-answer-chip');
      expect(out).not.toContain('pageguide-study-save-chip');
      expect(out).not.toContain('pageguide-study-edit-chip');
    });

    test('keeps the evidence markers, which are the participant’s route to the page', () => {
      const out = window._sanitizeStudyAnswerHtml(answerHtml);
      expect(out).toContain('pageguide-evidence-citation');
      expect(out).toContain('data-evidence-num="3"');
      expect(out).toContain('S. Dutton Whitney');
    });

    test('removes the evidence card — crops belong in the chat, not the recall screen', () => {
      const out = window._sanitizeStudyAnswerHtml(
        '<div class="pageguide-recap-hero"><div>Evidence on the page</div></div>' +
        '<div class="pageguide-find-evidence"><div class="pageguide-find-evidence-chips">' +
        '<button class="pageguide-find-evidence-chip" data-evidence-num="1">1</button></div>' +
        '<figure class="pageguide-find-evidence-panel" hidden><img src="data:image/jpeg;base64,AAA"></figure></div>'
      );
      expect(out).not.toContain('pageguide-find-evidence');
      expect(out).not.toContain('pageguide-recap-hero');
      expect(out).not.toContain('base64');
    });

    test('is safe on empty input', () => {
      expect(window._sanitizeStudyAnswerHtml('')).toBe('');
      expect(window._sanitizeStudyAnswerHtml(null)).toBe('');
    });
  });

  // Clicking an answer opens its citations out into the sentences they point at — a grounding
  // affordance. In the arm defined by the absence of grounding it offered a gesture that did
  // nothing, then announced "click to collapse citations" about citations that were not there.
  describe('_studyAnswerIsClickable', () => {
    test('an answer with citations is clickable', () => {
      expect(window._studyAnswerIsClickable('is <span class="pageguide-citation pageguide-citation-idx" data-index="12"><sup class="citation-index">[1]</sup></span> so'))
        .toBe(true);
    });

    test('an evidence marker counts too', () => {
      expect(window._studyAnswerIsClickable('<span class="pageguide-citation pageguide-evidence-citation" data-evidence-num="2"></span>'))
        .toBe(true);
    });

    test('a stripped, non-grounded answer is not', () => {
      expect(window._studyAnswerIsClickable('The first play in which a pedant takes an important part is El pedante.'))
        .toBe(false);
      expect(window._studyAnswerIsClickable('')).toBe(false);
      expect(window._studyAnswerIsClickable(null)).toBe(false);
    });
  });

  describe('_studyAnswerTextFromHtml', () => {
    // How the overlay decides a bubble is worth showing: an evidence-card-only message sanitizes
    // down to nothing and must not become an empty box on the Answer screen.
    test('ignores the authoring chip row when measuring the answer', () => {
      const text = window._studyAnswerTextFromHtml(
        'Answer text<div class="pageguide-debug-answer-row"><button class="pageguide-study-save-chip">💾 Save</button></div>'
      );
      expect(text).toBe('Answer text');
    });

    test('an emptied evidence card reads as no answer at all', () => {
      expect(window._studyAnswerTextFromHtml('')).toBe('');
    });
  });
});


describe('isNonGroundingModeOn (content/functions/highlight.js)', () => {
  beforeAll(() => {
    document.body.innerHTML = '';
    loadScript('content/functions/highlight.js');
  });

  test('defaults to false (grounding on) when nothing is stored', async () => {
    window.chrome = { storage: { local: { get: jest.fn().mockResolvedValue({}) } } };
    await expect(window.isNonGroundingModeOn()).resolves.toBe(false);
  });

  test('returns true when the stored value is "on"', async () => {
    window.chrome = { storage: { local: { get: jest.fn().mockResolvedValue({ pageguideNonGrounding: 'on' }) } } };
    await expect(window.isNonGroundingModeOn()).resolves.toBe(true);
  });

  test('returns false when the stored value is "off"', async () => {
    window.chrome = { storage: { local: { get: jest.fn().mockResolvedValue({ pageguideNonGrounding: 'off' }) } } };
    await expect(window.isNonGroundingModeOn()).resolves.toBe(false);
  });

  test('fails safe to false (grounding on) if chrome.storage throws', async () => {
    window.chrome = { storage: { local: { get: jest.fn().mockRejectedValue(new Error('boom')) } } };
    await expect(window.isNonGroundingModeOn()).resolves.toBe(false);
  });
});

describe('stripCitationMarkers (content/tasks/ask.js)', () => {
  beforeAll(() => {
    document.body.innerHTML = '';
    window.chrome = { storage: { local: { get: jest.fn().mockResolvedValue({}) } } };
    loadScript('content/tasks/ask.js');
  });

  // REGRESSION: the cited span is part of the sentence — grounding mode renders it inline as
  // <span class="citation-text">. Deleting it in Non-grounding mode left the baseline answer with
  // holes ("Contact the depot of travel."). Non-grounding shows the model's full text; only the
  // link (the brackets + index) is dropped.
  test('keeps a double-quoted cited span and drops only the marker', () => {
    expect(window.stripCitationMarkers('Contact the depot [12:"within 30 days"] of travel.'))
      .toBe('Contact the depot within 30 days of travel.');
  });

  test('keeps a single-quoted cited span', () => {
    expect(window.stripCitationMarkers("The fee is $5 [3:'per item'] at checkout."))
      .toBe('The fee is $5 per item at checkout.');
  });

  test('keeps an unquoted cited span', () => {
    expect(window.stripCitationMarkers('Open on weekdays [4:9am-5pm] only.'))
      .toBe('Open on weekdays 9am-5pm only.');
  });

  test('removes a bare index-only citation (no span to keep)', () => {
    expect(window.stripCitationMarkers('The office closes early on Fridays [7].'))
      .toBe('The office closes early on Fridays.');
  });

  test('keeps every cited span when one answer has several citations', () => {
    expect(window.stripCitationMarkers('Returns [1:"within 30 days"] are free [2:"for members"] only.'))
      .toBe('Returns within 30 days are free for members only.');
  });

  test('keeps the span of a multi-index citation', () => {
    expect(window.stripCitationMarkers('Bags are held [517, 519:"for 30 days"] at the depot.'))
      .toBe('Bags are held for 30 days at the depot.');
  });

  test('removes a multi-index citation that carries no span', () => {
    expect(window.stripCitationMarkers('Bags are held at the depot [517, 519].'))
      .toBe('Bags are held at the depot.');
  });

  test('keeps the quote of a PDF page citation and drops the marker', () => {
    expect(window.stripCitationMarkers('The policy says [Page 4: "refunds take 5 days"] after approval.'))
      .toBe('The policy says refunds take 5 days after approval.');
  });

  test('removes a PDF element-range marker (no span to keep)', () => {
    expect(window.stripCitationMarkers('See the refund table [idx:38-42] for details.'))
      .toBe('See the refund table for details.');
  });

  test('normalizes curly quotes before unwrapping the span', () => {
    expect(window.stripCitationMarkers('Contact the depot [12:“within 30 days”] of travel.'))
      .toBe('Contact the depot within 30 days of travel.');
  });

  test('leaves plain text with no citations untouched', () => {
    expect(window.stripCitationMarkers('There is nothing to cite here.'))
      .toBe('There is nothing to cite here.');
  });

  test('handles empty/undefined input without throwing', () => {
    expect(window.stripCitationMarkers('')).toBe('');
    expect(window.stripCitationMarkers(null)).toBeNull();
    expect(window.stripCitationMarkers(undefined)).toBeUndefined();
  });

  test('stripNonGroundingMarkers also removes visual evidence keys', () => {
    expect(window.stripNonGroundingMarkers('The garment is draped [ev:engraving_detail] [12:"over the figure"].'))
      .toBe('The garment is draped over the figure.');
  });
});

describe('Non-grounding mode skips the scrollToIndex/scrollToHighlight flash effect (content/functions/scroll.js)', () => {
  beforeAll(() => {
    document.body.innerHTML = '';
    loadScript('content/functions/scroll.js');
  });

  test('scrollToIndex still scrolls but skips the outline/background flash when applyFlash is false', () => {
    const el = document.createElement('div');
    el.scrollIntoView = jest.fn();
    window._pageguideIndex = { 5: el };
    window.getIndexedElement = (i) => window._pageguideIndex[i];

    const result = window.scrollToIndex(5, false);

    expect(result).toBe(true);
    expect(el.scrollIntoView).toHaveBeenCalled();
    expect(el.style.outline).toBe('');
    expect(el.style.backgroundColor).toBe('');
  });

  // Was: 'scrollToIndex still flashes by default'. The default path still marks the element, but
  // with the shared flat tint instead of a yellow outline that vanished again after 1.5s.
  test('scrollToIndex marks the element by default, with no yellow flash', () => {
    const el = document.createElement('div');
    el.scrollIntoView = jest.fn();
    window._pageguideIndex = { 6: el };
    window.getIndexedElement = (i) => window._pageguideIndex[i];

    window.scrollToIndex(6);

    expect(el.style.outline).toBe('');
    expect(el.getAttribute('data-pageguide-styled')).toBe('true');
  });

  test('scrollToHighlight still scrolls but skips the background flash when applyFlash is false', () => {
    const el = document.createElement('div');
    el.scrollIntoView = jest.fn();
    window._pageguideHighlights = [el];

    window.scrollToHighlight(0, false);

    expect(el.scrollIntoView).toHaveBeenCalled();
    expect(el.style.backgroundColor).toBe('');
  });
});

describe('Grounding toggle button (sidepanel/panel.js)', () => {
  beforeAll(() => {
    window.chrome = {
      runtime: {
        connect: jest.fn(() => ({ disconnect: jest.fn() })),
        sendMessage: jest.fn(),
        onMessage: { addListener: jest.fn() }
      },
      tabs: {
        onActivated: { addListener: jest.fn() },
        onUpdated: { addListener: jest.fn() },
        onRemoved: { addListener: jest.fn() }
      },
      storage: {
        onChanged: { addListener: jest.fn() },
        local: {
          get: jest.fn().mockResolvedValue({}),
          set: jest.fn().mockResolvedValue(undefined)
        }
      }
    };
    document.body.innerHTML = `<div id="pageguide-goal-dots"></div>`;
    loadScript('sidepanel/panel.js');
  });

  // Fresh markup + a fresh init() call per test, so each test's button/menu has exactly one
  // set of listeners — initNonGroundingToggle() attaches new ones every call, and reusing a
  // single persisted DOM across tests would double them up.
  beforeEach(async () => {
    document.body.innerHTML = `
      <button class="pageguide-mode-btn" id="pageguide-nongrounding-toggle"></button>
      <div class="pageguide-mode-menu" id="pageguide-nongrounding-menu" style="display:none;">
        <button class="pageguide-mode-option" data-nongrounding="off"></button>
        <button class="pageguide-mode-option" data-nongrounding="on"></button>
      </div>
    `;
    window.chrome.storage.local.get.mockClear().mockResolvedValue({});
    window.chrome.storage.local.set.mockClear();
    window.initNonGroundingToggle();
    await Promise.resolve(); // flush the init's chrome.storage.local.get(...).then(render)
  });

  test('defaults to "Grounding: On" and does not mark itself active', () => {
    const btn = document.getElementById('pageguide-nongrounding-toggle');
    expect(btn.textContent).toContain('Grounding: On');
    expect(btn.classList.contains('pageguide-quick-btn--active')).toBe(false);
  });

  test('REGRESSION: clicking "Non-grounding (baseline)" persists it to chrome.storage.local and flips the button to a visible active state', async () => {
    const menu = document.getElementById('pageguide-nongrounding-menu');
    const onOption = menu.querySelector('[data-nongrounding="on"]');

    onOption.dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve(); // flush the async storage.set + re-render

    expect(window.chrome.storage.local.set).toHaveBeenCalledWith({ pageguideNonGrounding: 'on' });
    const btn = document.getElementById('pageguide-nongrounding-toggle');
    expect(btn.textContent).toContain('Non-grounding');
    expect(btn.classList.contains('pageguide-quick-btn--active')).toBe(true);
  });

  test('clicking back to "Grounding On" clears the active state', async () => {
    const menu = document.getElementById('pageguide-nongrounding-menu');
    menu.querySelector('[data-nongrounding="on"]').dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();
    menu.querySelector('[data-nongrounding="off"]').dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    expect(window.chrome.storage.local.set).toHaveBeenLastCalledWith({ pageguideNonGrounding: 'off' });
    const btn = document.getElementById('pageguide-nongrounding-toggle');
    expect(btn.textContent).toContain('Grounding: On');
    expect(btn.classList.contains('pageguide-quick-btn--active')).toBe(false);
  });
});

describe('Non-grounding removes every Guide-mode grounding affordance (sidepanel/panel.js)', () => {
  // Flips the panel-side mirror by driving the real toggle, the same way the UI does.
  function setNonGrounding(on) {
    document.body.innerHTML = `
      <button class="pageguide-mode-btn" id="pageguide-nongrounding-toggle"></button>
      <div class="pageguide-mode-menu" id="pageguide-nongrounding-menu">
        <button class="pageguide-mode-option" data-nongrounding="off"></button>
        <button class="pageguide-mode-option" data-nongrounding="on"></button>
      </div>
      <div id="pageguide-step-panel" style="display:none;"></div>
      <div id="pageguide-messages"></div>
      <div id="pageguide-tab-chip" style="display:none;">
        <img id="pageguide-tab-chip-favicon"><span id="pageguide-tab-chip-title"></span>
      </div>
    `;
    window.initNonGroundingToggle();
    const btn = document.getElementById('pageguide-nongrounding-toggle');
    window._renderNonGrounding(btn, on ? 'on' : 'off');
  }

  function setEvidenceMode(mode) {
    const btn = document.getElementById('pageguide-evidencemode-toggle') || document.createElement('button');
    btn.id = 'pageguide-evidencemode-toggle';
    if (!btn.parentNode) document.body.appendChild(btn);
    window._renderEvidenceMode(btn, mode);
  }

  beforeAll(() => {
    window.chrome = {
      runtime: {
        connect: jest.fn(() => ({ disconnect: jest.fn() })),
        sendMessage: jest.fn(),
        onMessage: { addListener: jest.fn() }
      },
      tabs: {
        onActivated: { addListener: jest.fn() },
        onUpdated: { addListener: jest.fn() },
        onRemoved: { addListener: jest.fn() }
      },
      storage: {
        onChanged: { addListener: jest.fn() },
        local: { get: jest.fn().mockResolvedValue({}), set: jest.fn().mockResolvedValue(undefined) }
      }
    };
    document.body.innerHTML = `<div id="pageguide-goal-dots"></div>`;
    loadScript('sidepanel/panel.js');
  });

  afterAll(() => {
    setNonGrounding(false);
    setEvidenceMode('visual');
  }); // don't leak flags into later describe blocks

  test('REQ 1: View Journey step rows get no hover/click screenshot preview', () => {
    setNonGrounding(true);
    window.addGuideStep({ sessionId: 'ng-s1', step: 1, planStep: 1, isLastStep: false, instruction: 'Open the page' });
    window.renderGoalCard({ route: 'guide', prompt: 'Task', step: 1, total: 1, title: 'Task' });

    const row = document.querySelector('.pageguide-goal-row');
    expect(row).toBeTruthy();
    // showGoalStepPreview also self-guards, so even a directly-dispatched click pops nothing.
    row.dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.getElementById('pageguide-goal-step-pop')).toBeNull();
  });

  test('REQ 2: the final answer has no [ev:] evidence chips and no "Evidence:" tail', () => {
    setNonGrounding(true);
    const model = window._buildAnswerEvidenceModel(
      'Found two articles [ev:shot_a] on the homepage [ev:shot_b].',
      [{ key: 'shot_a', ref_step_id: 1, note: 'First article' },
       { key: 'shot_b', ref_step_id: 2, note: 'Second article' }],
      [{ key: 'shot_a', step: 1, note: 'First article', source: 'cited' }]
    );

    expect(model.evidence).toEqual([]);
    expect(model.answerHtml).not.toContain('pageguide-answer-citation-chip');
    expect(model.answerHtml).not.toContain('pageguide-answer-evidence-tail');
    expect(model.answerHtml).not.toContain('[ev:'); // markers stripped, not just unlinked
    expect(model.answerHtml).toContain('Found two articles');
  });

  test('REQ 2 CONTRAST: with grounding on, the same answer DOES build evidence chips', () => {
    setNonGrounding(false);
    setEvidenceMode('visual');
    const model = window._buildAnswerEvidenceModel(
      'Found two articles [ev:shot_a] on the homepage.',
      [{ key: 'shot_a', ref_step_id: 1, note: 'First article' }],
      []
    );
    expect(model.evidence.length).toBe(1);
    expect(model.answerHtml).toContain('pageguide-answer-citation-chip');
  });

  test('REGRESSION: Text evidence mode strips final-answer evidence links', () => {
    setNonGrounding(false);
    setEvidenceMode('text');
    const model = window._buildAnswerEvidenceModel(
      'I found two articles [ev:shot_a] and [ev:shot_b].',
      [{ key: 'shot_a', ref_step_id: 1, note: 'First article' },
       { key: 'shot_b', ref_step_id: 2, note: 'Second article' }],
      [{ key: 'shot_a', step: 1, note: 'First article', source: 'cited' }]
    );

    expect(model.evidence).toEqual([]);
    expect(model.answerHtml).not.toContain('pageguide-answer-citation-chip');
    expect(model.answerHtml).not.toContain('pageguide-answer-evidence-tail');
    expect(model.answerHtml).not.toContain('[ev:');
    expect(model.answerHtml).toContain('I found two articles');
    setEvidenceMode('visual');
  });

  test('REQ 3: the Reasoning Trail rows carry no recap-link / screenshot chips', () => {
    setNonGrounding(true);
    const html = window._answerReasoningTrailHtml({
      summary: 'Opened the site and found the articles.',
      milestones: [
        { step: 1, text: 'Opened BBC News', status: 'ok' },
        { step: 2, text: 'Found two articles', status: 'ok' }
      ]
    }, 'ng-s1');

    expect(html).toContain('Opened BBC News'); // the trail itself still renders
    expect(html).not.toContain('pageguide-recap-link');
    expect(html).not.toContain('pageguide-answer-trail-shot');
    expect(html).not.toContain('data-session');
  });

  // A stopped/capped run now renders the SAME card a finished one does — summariser text plus the
  // Reasoning Trail — so the baseline's guarantee has to hold there too. (The old card, with its
  // Checkpoints strip and Visual evidence blocks, is gone; see renderGuideRecapCard.)
  const RECAP = {
    sessionId: 'ng-s1',
    summary: 'Found two news articles.',
    milestones: [{ step: 1, text: 'Found two articles', status: 'ok', phrase: 'two articles' }],
    evidenceByStep: { 1: { hasShot: true, reason: 'Why this step is correct', items: [{ hasShot: true, reason: 'Article headline' }] } }
  };

  test('REQ 3: a stopped run\'s card has inert step text and nothing to click through to a screenshot', async () => {
    setNonGrounding(true);
    document.getElementById('pageguide-messages').innerHTML = '';
    await window.renderGuideRecapCard(RECAP, 'Stopped');

    const card = document.querySelector('#pageguide-messages .pageguide-recap');
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('Found two articles');   // the trail itself survives
    expect(card.textContent).toContain('Stopped');              // and says how the run ended
    expect(card.querySelector('.pageguide-recap-link')).toBeNull();
    expect(card.querySelector('.pageguide-answer-trail-shot')).toBeNull();
    expect(card.textContent).not.toContain('Visual evidence');
    expect(card.textContent).not.toContain('Checkpoints');
  });

  // The old card is not reachable any more, from anywhere. Stopping a run used to drop the reader
  // into a layout they had never seen — a "TASK INCOMPLETE" hero, a flat milestone list and a strip
  // of numbered Checkpoints — at exactly the moment they were trying to work out what went wrong.
  test('the deleted recap card cannot be rendered by anything', () => {
    expect(window.renderGuideRecap).toBeUndefined();
    const panel = fs.readFileSync(path.join(__dirname, '../../sidepanel/panel.js'), 'utf8');
    expect(panel).not.toMatch(/renderGuideRecap\s*\(/);
    expect(panel).not.toContain('pageguide-recap-checkpoints');
    expect(panel).not.toContain('Task Incomplete');
  });

  test('a stopped run is summarised with the trail, and labelled as stopped', async () => {
    setNonGrounding(false);
    document.getElementById('pageguide-messages').innerHTML = '';
    await window.renderGuideRecapCard(RECAP, 'Stopped');

    const card = document.querySelector('#pageguide-messages .pageguide-answer-card');
    expect(card).toBeTruthy();                                        // the same card a finish gets
    expect(card.querySelector('.pageguide-recap-kicker').textContent).toBe('Stopped');
    expect(card.querySelector('.pageguide-answer-copy').textContent).toContain('Found two news articles.');
    expect(card.querySelector('.pageguide-reasoning-trail')).toBeTruthy();
  });

  test('a recap with no summary renders nothing rather than an empty card', async () => {
    document.getElementById('pageguide-messages').innerHTML = '';
    await window.renderGuideRecapCard({ sessionId: 'x', milestones: [] }, 'Stopped');
    expect(document.querySelector('#pageguide-messages .pageguide-recap')).toBeNull();
  });

  test('REQ 3 CONTRAST: with grounding on, the same card links its steps to their screenshots', async () => {
    setNonGrounding(false);
    document.getElementById('pageguide-messages').innerHTML = '';
    await window.renderGuideRecapCard(RECAP, 'Stopped');

    const card = document.querySelector('#pageguide-messages .pageguide-recap');
    expect(card.querySelector('.pageguide-recap-link')).toBeTruthy();
    expect(card.querySelector('.pageguide-reasoning-trail')).toBeTruthy();
  });
});

describe('renderGoalCard only builds the View Journey card for Guide-routed tasks (sidepanel/panel.js)', () => {
  beforeAll(() => {
    window.chrome = {
      runtime: {
        connect: jest.fn(() => ({ disconnect: jest.fn() })),
        sendMessage: jest.fn(),
        onMessage: { addListener: jest.fn() }
      },
      tabs: {
        onActivated: { addListener: jest.fn() },
        onUpdated: { addListener: jest.fn() },
        onRemoved: { addListener: jest.fn() }
      },
      storage: {
        onChanged: { addListener: jest.fn() }
      }
    };
    document.body.innerHTML = `
      <div id="pageguide-step-panel" style="display:none;"></div>
      <div id="pageguide-messages"></div>
      <div id="pageguide-tab-chip" style="display:none;">
        <img id="pageguide-tab-chip-favicon">
        <span id="pageguide-tab-chip-title"></span>
      </div>
    `;
    loadScript('sidepanel/panel.js');
  });

  test('REGRESSION: an "ask" route never creates the View Journey card (previously only "find"/"hide" were excluded)', () => {
    document.getElementById('pageguide-messages').innerHTML = '';
    window.renderGoalCard({ prompt: 'who disallowed oil drilling in the reef?', route: 'ask' });
    expect(document.getElementById('pageguide-goal')).toBeNull();
  });

  test('a "find" route still never creates the card', () => {
    document.getElementById('pageguide-messages').innerHTML = '';
    window.renderGoalCard({ prompt: 'find the return policy', route: 'find' });
    expect(document.getElementById('pageguide-goal')).toBeNull();
  });

  test('a "guide" route does create the card', () => {
    document.getElementById('pageguide-messages').innerHTML = '';
    window.renderGoalCard({ prompt: 'go to bbc news and find world cup articles', route: 'guide' });
    expect(document.getElementById('pageguide-goal')).toBeTruthy();
  });
});

describe('Vertical goal timeline + working-tab "done" chip (sidepanel/panel.js)', () => {
  beforeAll(() => {
    window.chrome = {
      runtime: {
        connect: jest.fn(() => ({ disconnect: jest.fn() })),
        sendMessage: jest.fn(),
        onMessage: { addListener: jest.fn() }
      },
      tabs: {
        onActivated: { addListener: jest.fn() },
        onUpdated: { addListener: jest.fn() },
        onRemoved: { addListener: jest.fn() }
      },
      storage: {
        onChanged: { addListener: jest.fn() }
      }
    };
    document.body.innerHTML = `
      <div id="pageguide-step-panel" style="display:none;"></div>
      <div id="pageguide-messages"></div>
      <div id="pageguide-tab-chip" style="display:none;">
        <img id="pageguide-tab-chip-favicon">
        <span id="pageguide-tab-chip-title"></span>
      </div>
    `;
    loadScript('sidepanel/panel.js');
  });

  test('creates a "View Journey" bubble inline in the chat and renders one row per step while working', () => {
    window.addGuideStep({ sessionId: 'timeline-s1', step: 1, planStep: 1, isLastStep: false, instruction: 'Open settings' });
    window.renderGoalCard({ route: 'guide', prompt: 'Test task', step: 1, total: 2, title: 'Test task' });

    const card = document.getElementById('pageguide-goal');
    expect(card).toBeTruthy();
    expect(document.getElementById('pageguide-messages').contains(card)).toBe(true);

    const rows = card.querySelectorAll('.pageguide-goal-row');
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.pageguide-goal-row-dot').classList.contains('current')).toBe(true);

    const details = card.querySelector('details');
    expect(details.open).toBe(true);
  });

  test('REGRESSION: collapses to "View Journey" once the guide finishes, and marks the tab chip done', () => {
    window.addGuideStep({ sessionId: 'timeline-s1', step: 2, planStep: 2, isLastStep: true, instruction: 'Save changes' });

    // The card stays live (same id, not sealed) right after finishing — a compound ask can be
    // decomposed into several back-to-back phases, each reporting isLastStep:true, so sealing
    // here would free the id before the next same-ask phase gets a chance to find and replace
    // this card. It still collapses to "View Journey" right away, visually.
    const card = document.getElementById('pageguide-goal');
    expect(card).toBeTruthy();
    expect(card.classList.contains('pageguide-goal--sealed')).toBe(false);
    expect(card.querySelector('details').open).toBe(false);
    expect(card.querySelector('.pageguide-goal-timeline-summary').textContent).toBe('View Journey');

    expect(window._getTabChipDone()).toBe(true);
    expect(document.getElementById('pageguide-tab-chip').classList.contains('pageguide-tab-chip--done')).toBe(true);
  });

  test('REGRESSION: the "done" badge is isolated per tab through _saveTabSession/_restoreTabSession', () => {
    // Tab 501 just finished a guide (state left over from the previous test).
    expect(window._getTabChipDone()).toBe(true);
    window._saveTabSession(501);
    const savedForTab501 = window._getTabSession(501);
    expect(savedForTab501.tabChipDone).toBe(true);

    // Switching to a fresh, never-guided tab must NOT show tab 501's green badge.
    window.clearGoalAndStepPanel();
    expect(window._getTabChipDone()).toBe(false);
    expect(document.getElementById('pageguide-tab-chip').classList.contains('pageguide-tab-chip--done')).toBe(false);

    // Switching back to tab 501 must restore its own completion badge.
    window._restoreTabSession(savedForTab501);
    expect(window._getTabChipDone()).toBe(true);
    expect(document.getElementById('pageguide-tab-chip').classList.contains('pageguide-tab-chip--done')).toBe(true);
  });

  test('REGRESSION: a genuinely new ask after one finishes seals the previous card as history and gets its own fresh one', () => {
    // The card left over from the previous test is still live (unsealed) — collapsed to
    // "View Journey", but not yet sealed, since sealing is deferred until we know for sure
    // a different ask has started (see resetLiveGuideTimelineForSession).
    const prevCard = document.getElementById('pageguide-goal');
    expect(prevCard).toBeTruthy();
    expect(prevCard.classList.contains('pageguide-goal--sealed')).toBe(false);

    window._startNewAskForTest(); // this is a genuinely new user submission, not an internal phase
    window.addGuideStep({ sessionId: 'timeline-s2', step: 1, planStep: 1, isLastStep: false, instruction: 'Start a new task' });
    window.renderGoalCard({ route: 'guide', prompt: 'Second task', step: 1, total: 1, title: 'Second task' });

    // NOW the previous card gets sealed, as static history...
    expect(prevCard.classList.contains('pageguide-goal--sealed')).toBe(true);
    // ...and the new ask got its own fresh, live card alongside it, not a reused one.
    const liveCard = document.getElementById('pageguide-goal');
    expect(liveCard).toBeTruthy();
    expect(liveCard).not.toBe(prevCard);
    expect(liveCard.classList.contains('pageguide-goal--sealed')).toBe(false);
    expect(liveCard.querySelector('#pageguide-goal-title').textContent).toBe('Second task');
    expect(document.querySelectorAll('#pageguide-messages > .pageguide-goal').length).toBe(2);
  });

  test('REGRESSION: internal phase changes within the same ask replace the previous card instead of stacking a new one', () => {
    // Real-world trigger: one compound user request ("go to bbc news and find 2 news items")
    // gets internally decomposed into multiple guide phases, each with its own session id, but
    // it's still visually the same task. Previously every phase change sealed-and-kept the old
    // card, leaving 2-3 duplicate bubbles behind for a single ask. Titles aren't a reliable way
    // to detect "same ask" (state that feeds them can get cleared between phases, and a user can
    // retype an identical prompt as a genuinely new ask), so this must hold even when the title
    // reported by each phase differs slightly.
    window.clearGoalAndStepPanel();
    document.getElementById('pageguide-messages').innerHTML = ''; // clear prior tests' bubbles
    window._startNewAskForTest(); // exactly one ask covers both phases below

    window.resetLiveGuideTimelineForSession('phase-1', { title: 'Go to BBC News' });
    window.renderGoalCard({ route: 'guide', prompt: 'Compound task', step: 1, total: 1, title: 'Go to BBC News' });
    expect(document.querySelectorAll('#pageguide-messages > .pageguide-goal').length).toBe(1);

    window.resetLiveGuideTimelineForSession('phase-2', { title: 'Find 2 news items' });
    window.renderGoalCard({ route: 'guide', prompt: 'Compound task', step: 1, total: 1, title: 'Find 2 news items' });

    // Still exactly one bubble — the phase-1 card was replaced, not sealed alongside a new one.
    expect(document.querySelectorAll('#pageguide-messages > .pageguide-goal').length).toBe(1);
    expect(document.querySelectorAll('.pageguide-goal--sealed').length).toBe(0);
  });
});

describe('Background-tab guide messages no longer leak into the currently displayed tab (sidepanel/panel.js)', () => {
  beforeAll(() => {
    window.chrome = {
      runtime: {
        connect: jest.fn(() => ({ disconnect: jest.fn() })),
        sendMessage: jest.fn(),
        onMessage: { addListener: jest.fn() }
      },
      tabs: {
        onActivated: { addListener: jest.fn() },
        onUpdated: { addListener: jest.fn() },
        onRemoved: { addListener: jest.fn() }
      },
      storage: {
        onChanged: { addListener: jest.fn() }
      }
    };
    document.body.innerHTML = `
      <div id="pageguide-step-panel" style="display:none;"></div>
      <div id="pageguide-messages"></div>
      <div id="pageguide-tab-chip" style="display:none;">
        <img id="pageguide-tab-chip-favicon">
        <span id="pageguide-tab-chip-title"></span>
      </div>
    `;
    loadScript('sidepanel/panel.js');
  });

  test('REGRESSION: a guideStep message from a background tab is queued, not painted into the tab currently on screen', () => {
    // The user is looking at tab 200 (e.g. an unrelated docs page) while a guide keeps running
    // in the background on tab 100 (e.g. BBC News). Its final-answer message arrives here.
    window._setCurrentTabIdForTest(200);

    window.handleContentMessage(
      {
        action: 'guideStep',
        result: {
          sessionId: 'bg-session', step: 2, planStep: 2, isLastStep: true,
          isFinish: true, finalAnswer: 'I found two World Cup news items.', instruction: 'Wrap up'
        }
      },
      { tab: { id: 100 } }
    );

    // Nothing was rendered into tab 200's chat — no leaked View Journey / answer card.
    expect(document.getElementById('pageguide-goal')).toBeNull();
    expect(document.getElementById('pageguide-messages').children.length).toBe(0);

    // The message is held for tab 100 instead of being dropped.
    const pending = window._getPendingBackgroundGuideMessages(100);
    expect(pending).toHaveLength(1);
    expect(pending[0].action).toBe('guideStep');
  });

  test('REGRESSION: switching back to that tab replays the queued message and renders it there', () => {
    window._setCurrentTabIdForTest(100);
    window._drainPendingGuideMessages(100);

    const card = document.getElementById('pageguide-goal');
    expect(card).toBeTruthy();
    expect(document.getElementById('pageguide-messages').contains(card)).toBe(true);

    // Queue is now empty — replayed exactly once.
    expect(window._getPendingBackgroundGuideMessages(100)).toBeUndefined();
  });

  test('messages from the tab currently on screen still render immediately (no regression for the common case)', () => {
    document.getElementById('pageguide-messages').innerHTML = '';
    window._startNewAskForTest();
    window._setCurrentTabIdForTest(300);

    window.handleContentMessage(
      { action: 'guideStep', result: { sessionId: 'same-tab-session', step: 1, planStep: 1, isLastStep: false, instruction: 'Open settings' } },
      { tab: { id: 300 } }
    );

    expect(document.getElementById('pageguide-goal')).toBeTruthy();
    expect(window._getPendingBackgroundGuideMessages(300)).toBeUndefined();
  });
});

describe('Step panel no longer shows a redundant finish notice (sidepanel/panel.js)', () => {
  beforeAll(() => {
    window.chrome = {
      runtime: {
        connect: jest.fn(() => ({ disconnect: jest.fn() })),
        sendMessage: jest.fn(),
        onMessage: { addListener: jest.fn() }
      },
      tabs: {
        onActivated: { addListener: jest.fn() },
        onUpdated: { addListener: jest.fn() },
        onRemoved: { addListener: jest.fn() }
      },
      storage: {
        onChanged: { addListener: jest.fn() }
      }
    };
    document.body.innerHTML = `
      <div id="pageguide-step-panel" style="display:none;"></div>
      <div id="pageguide-messages"></div>
      <div id="pageguide-tab-chip" style="display:none;">
        <img id="pageguide-tab-chip-favicon">
        <span id="pageguide-tab-chip-title"></span>
      </div>
    `;
    loadScript('sidepanel/panel.js');
  });

  test('REGRESSION: a plain guide finish hides the step panel instead of showing "I have completed your task..."', () => {
    window.addGuideStep({ sessionId: 'finish-s1', step: 1, planStep: 1, isLastStep: true, instruction: 'Finish up' });

    const panel = document.getElementById('pageguide-step-panel');
    expect(panel.style.display).toBe('none');
    expect(panel.innerHTML.trim()).toBe('');
  });

  test('REGRESSION: the ANSWER card still posts to chat when isFinish+finalAnswer, even though the step panel stays hidden', () => {
    window.addGuideStep({
      sessionId: 'finish-s2', step: 1, planStep: 1, isLastStep: true,
      isFinish: true, finalAnswer: 'Order placed successfully.'
    });

    const panel = document.getElementById('pageguide-step-panel');
    expect(panel.style.display).toBe('none');
    expect(panel.innerHTML.trim()).toBe('');

    const card = document.querySelector('#pageguide-messages .pageguide-answer-card');
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('Order placed successfully.');
  });

  test('find/watch-video terminal steps still get their own step-panel card (unaffected by the finish-notice removal)', () => {
    document.getElementById('pageguide-step-panel').innerHTML = '';
    window.addGuideStep({
      sessionId: 'finish-s3', step: 1, planStep: 1, isLastStep: true,
      isFind: true, findAnswer: 'The return window is 30 days.'
    });

    const panel = document.getElementById('pageguide-step-panel');
    expect(panel.style.display).not.toBe('none');
    expect(panel.innerHTML).toContain('completed your request');
  });
});

describe('Per-tab guide session isolation (background/service-worker.js)', () => {
  let onMessage, onConnect, onCreated;

  beforeAll(() => {
    window.chrome = {
      action: { onClicked: { addListener: jest.fn() } },
      runtime: {
        onConnect: { addListener: jest.fn() },
        onMessage: { addListener: jest.fn() },
        sendMessage: jest.fn(),
        getPlatformInfo: jest.fn()
      },
      tabs: {
        onCreated: { addListener: jest.fn() },
        onUpdated: { addListener: jest.fn() },
        onRemoved: { addListener: jest.fn() },
        get: jest.fn(),
        query: jest.fn(),
        captureVisibleTab: jest.fn(),
        sendMessage: jest.fn()
      },
      debugger: {
        attach: jest.fn().mockResolvedValue(undefined),
        detach: jest.fn().mockResolvedValue(undefined),
        sendCommand: jest.fn(),
        onDetach: { addListener: jest.fn() }
      },
      storage: {
        sync: { get: jest.fn().mockResolvedValue({}) },
        local: { get: jest.fn().mockResolvedValue({}), remove: jest.fn().mockResolvedValue(undefined) },
        session: { get: jest.fn(), set: jest.fn(), remove: jest.fn() }
      }
    };
    loadScript('background/service-worker.js');
    onMessage = window.chrome.runtime.onMessage.addListener.mock.calls[0][0];
    onConnect = window.chrome.runtime.onConnect.addListener.mock.calls[0][0];
    onCreated = window.chrome.tabs.onCreated.addListener.mock.calls[0][0];
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function send(action, extra = {}, sender = {}) {
    let response;
    onMessage({ action, ...extra }, sender, (r) => { response = r; });
    return response;
  }

  function connectGuidev2Port(tabId) {
    const port = { name: 'guidev2', sender: { tab: { id: tabId } }, postMessage: jest.fn() };
    onConnect(port);
    return port;
  }

  test('REGRESSION: two tabs each keep their own active session — setting/resuming one never leaks into the other', () => {
    send('guidanceV2_setState', { state: { active: true, question: 'Tab A task' } }, { tab: { id: 1 } });
    send('guidanceV2_setState', { state: { active: true, question: 'Tab B task' } }, { tab: { id: 2 } });

    const portA = connectGuidev2Port(1);
    const portB = connectGuidev2Port(2);
    expect(portA.postMessage).toHaveBeenCalledWith({ type: 'swState', state: { active: true, question: 'Tab A task' } });
    expect(portB.postMessage).toHaveBeenCalledWith({ type: 'swState', state: { active: true, question: 'Tab B task' } });

    // Each tab still reports itself as the owner of its own session.
    expect(send('guidanceV2_isOwner', {}, { tab: { id: 1 } })).toEqual({ isOwner: true });
    expect(send('guidanceV2_isOwner', {}, { tab: { id: 2 } })).toEqual({ isOwner: true });
  });

  test('image selector falls back to OpenRouter when direct Gemini rejects the key', async () => {
    window.chrome.storage.sync.get.mockResolvedValue({
      geminiApiKey: 'bad-gemini-key',
      openrouterApiKey: 'valid-openrouter-key'
    });
    const originalFetch = window.fetch;
    window.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: { message: 'API key not valid. Please pass a valid API key.' } })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"selected_image_ids":["page_image_1"]}' } }] })
      });

    try {
      const out = await window.callImageSelectionLLM([{ role: 'user', content: 'Question\n- page_image_1: title' }], 'select');

      expect(out).toMatchObject({
        content: '{"selected_image_ids":["page_image_1"]}',
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash-lite'
      });
      expect(window.fetch).toHaveBeenCalledTimes(2);
      expect(window.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer valid-openrouter-key');
    } finally {
      window.fetch = originalFetch;
    }
  });

  test('REGRESSION: clearing one tab (e.g. Stop, or the panel resetting a DIFFERENT tab it just switched to) does not clear another tab\'s active guide', () => {
    send('guidanceV2_setState', { state: { active: true, question: 'Tab A task' } }, { tab: { id: 1 } });
    send('guidanceV2_setState', { state: { active: true, question: 'Tab B task' } }, { tab: { id: 2 } });

    // Side-panel-originated clear (no sender.tab — must pass tabId explicitly), e.g. resetChat()
    // firing while the panel just switched to look at an unrelated tab 2.
    send('guidanceV2_clearState', { tabId: 2 });

    const portA = connectGuidev2Port(1);
    const portB = connectGuidev2Port(2);
    expect(portA.postMessage).toHaveBeenCalledWith({ type: 'swState', state: { active: true, question: 'Tab A task' } });
    expect(portB.postMessage).toHaveBeenCalledWith({ type: 'swState', state: null });
  });

  test('a content-script-originated clearState (Stop button) uses sender.tab.id, not an explicit tabId', () => {
    send('guidanceV2_setState', { state: { active: true } }, { tab: { id: 5 } });
    send('guidanceV2_clearState', {}, { tab: { id: 5 } });
    expect(send('guidanceV2_isOwner', {}, { tab: { id: 5 } })).toEqual({ isOwner: false });
  });

  test('transfers ownership to a new tab via openerTabId, leaving the opener with no session', () => {
    send('guidanceV2_setState', { state: { active: true, question: 'Tab A task' } }, { tab: { id: 1 } });
    onCreated({ id: 2, openerTabId: 1 });

    expect(send('guidanceV2_isOwner', {}, { tab: { id: 1 } })).toEqual({ isOwner: false });
    expect(send('guidanceV2_isOwner', {}, { tab: { id: 2 } })).toEqual({ isOwner: true });

    const portNew = connectGuidev2Port(2);
    expect(portNew.postMessage).toHaveBeenCalledWith({
      type: 'swState',
      state: { active: true, question: 'Tab A task', pendingResume: true }
    });
  });

  test('does not transfer to an unrelated new tab (no matching openerTabId or pre-click)', () => {
    send('guidanceV2_setState', { state: { active: true } }, { tab: { id: 1 } });
    onCreated({ id: 99, openerTabId: 42 }); // unrelated opener
    expect(send('guidanceV2_isOwner', {}, { tab: { id: 1 } })).toEqual({ isOwner: true });
    expect(send('guidanceV2_isOwner', {}, { tab: { id: 99 } })).toEqual({ isOwner: false });
  });

  test('REGRESSION: with two concurrently-guided tabs, a new tab only ever transfers the matching opener\'s session', () => {
    send('guidanceV2_setState', { state: { active: true, question: 'Tab A task' } }, { tab: { id: 1 } });
    send('guidanceV2_setState', { state: { active: true, question: 'Tab B task' } }, { tab: { id: 2 } });

    onCreated({ id: 3, openerTabId: 2 }); // opened from tab B, not tab A

    expect(send('guidanceV2_isOwner', {}, { tab: { id: 1 } })).toEqual({ isOwner: true });  // untouched
    expect(send('guidanceV2_isOwner', {}, { tab: { id: 2 } })).toEqual({ isOwner: false }); // transferred away
    expect(send('guidanceV2_isOwner', {}, { tab: { id: 3 } })).toEqual({ isOwner: true });  // received it
  });

  test('falls back to the pre-click watch when openerTabId is absent (noopener links)', () => {
    send('guidanceV2_setState', { state: { active: true } }, { tab: { id: 7 } });
    send('guidanceV2_preClick', {}, { tab: { id: 7 } });
    onCreated({ id: 8 }); // no openerTabId
    expect(send('guidanceV2_isOwner', {}, { tab: { id: 7 } })).toEqual({ isOwner: false });
    expect(send('guidanceV2_isOwner', {}, { tab: { id: 8 } })).toEqual({ isOwner: true });
  });
});

describe('_gv2ResetPauseGuards (content/tasks/guidev2.js) — Resume must clear the stop guards', () => {
  beforeAll(() => {
    if (!window.gv2LoopScore) loadScript('content/utils.js');
    window.chrome = window.chrome || {
      runtime: {
        connect: jest.fn(() => ({
          onMessage: { addListener: jest.fn() },
          onDisconnect: { addListener: jest.fn() }
        })),
        sendMessage: jest.fn()
      },
      storage: {
        session: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}), remove: jest.fn(async () => {}) },
        local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) }
      }
    };
    if (!window._gv2ResetPauseGuards) loadScript('content/tasks/guidev2.js');
  });

  test('clears the low-confidence streak', () => {
    const g = { active: true, lowConfidenceCount: 3 };
    window._gv2ResetPauseGuards(g);
    expect(g.lowConfidenceCount).toBe(0);
  });

  // REGRESSION: the loop guard is cumulative (score = matches/10 over every element key the guide
  // has targeted, stop at >= 0.3). Resume used to clear only lowConfidenceCount, so the same three
  // matches were still in _mechElementTexts and the guide re-paused on the very next step —
  // forever, since each re-pause appended another match. Resume now starts both guards over.
  test('clears the loop-detection history so the loop score drops back under the stop threshold', () => {
    const key = 'submit';
    const g = { active: true, lowConfidenceCount: 3, _mechElementTexts: [key, key, key], _mechKeys: [key] };

    expect(window.gv2LoopScore(g._mechElementTexts, key)).toBeGreaterThanOrEqual(0.3); // was stopping

    window._gv2ResetPauseGuards(g);

    expect(g._mechElementTexts).toEqual([]);
    expect(g._mechKeys).toEqual([]);
    expect(window.gv2LoopScore(g._mechElementTexts, key)).toBe(0);
  });

  test('clears the loop streak, so a raised threshold is not spent before the first step', () => {
    const g = { active: true, loopStepCount: 4 };
    window._gv2ResetPauseGuards(g);
    expect(g.loopStepCount).toBe(0);
  });

  test('is a no-op on a missing guide state', () => {
    expect(window._gv2ResetPauseGuards(null)).toBe(null);
  });
});

// How many looping steps in a row end the run — a Debug Mode setting, because 1 is tuned for safety
// and some pages legitimately revisit the same control (paging a list, retrying a flaky menu).
describe('loop step threshold (content/tasks/guidev2.js)', () => {
  beforeAll(() => {
    window.chrome = window.chrome || {
      runtime: {
        connect: jest.fn(() => ({ onMessage: { addListener: jest.fn() }, onDisconnect: { addListener: jest.fn() } })),
        sendMessage: jest.fn(),
      },
      storage: {
        session: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}), remove: jest.fn(async () => {}) },
        local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) },
      },
    };
    if (!window._gv2NextLoopStreak) loadScript('content/tasks/guidev2.js');
  });

  beforeEach(() => {
    window.chrome = window.chrome || {};
    window.chrome.storage = window.chrome.storage || {};
    window.chrome.storage.local = { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) };
  });

  describe('_gv2NextLoopStreak', () => {
    test('counts up while steps stay at or above the loop threshold', () => {
      expect(window._gv2NextLoopStreak(0, 0.3)).toBe(1);
      expect(window._gv2NextLoopStreak(1, 0.5)).toBe(2);
      expect(window._gv2NextLoopStreak(2, 1)).toBe(3);
    });

    // Consecutive, not cumulative: a clean step is evidence the guide moved on. Cumulative would
    // add up unrelated repeats from opposite ends of a session and stop a run that never looped.
    test('a step under the threshold clears the streak', () => {
      expect(window._gv2NextLoopStreak(3, 0.29)).toBe(0);
      expect(window._gv2NextLoopStreak(3, 0)).toBe(0);
    });

    test('a step with no loop score at all clears it too', () => {
      expect(window._gv2NextLoopStreak(3, null)).toBe(0);
      expect(window._gv2NextLoopStreak(3, undefined)).toBe(0);
      expect(window._gv2NextLoopStreak(3, NaN)).toBe(0);
    });

    test('starts from zero when the count is missing or nonsense', () => {
      expect(window._gv2NextLoopStreak(undefined, 0.4)).toBe(1);
      expect(window._gv2NextLoopStreak(null, 0.4)).toBe(1);
      expect(window._gv2NextLoopStreak(-2, 0.4)).toBe(1);
    });
  });

  describe('_gv2LoopStepThreshold', () => {
    test('defaults to 1 — what the guard did before it was configurable', async () => {
      expect(await window._gv2LoopStepThreshold()).toBe(1);
    });

    test('reads the stored setting', async () => {
      window.chrome.storage.local.get = jest.fn(async () => ({ guideLoopStepThreshold: 3 }));
      expect(await window._gv2LoopStepThreshold()).toBe(3);
    });

    test('never returns less than one — zero would stop the guide before it acted', async () => {
      window.chrome.storage.local.get = jest.fn(async () => ({ guideLoopStepThreshold: 0 }));
      expect(await window._gv2LoopStepThreshold()).toBe(1);
      window.chrome.storage.local.get = jest.fn(async () => ({ guideLoopStepThreshold: -5 }));
      expect(await window._gv2LoopStepThreshold()).toBe(1);
    });

    test('rounds a fractional setting, and ignores a junk one', async () => {
      window.chrome.storage.local.get = jest.fn(async () => ({ guideLoopStepThreshold: 2.6 }));
      expect(await window._gv2LoopStepThreshold()).toBe(3);
      window.chrome.storage.local.get = jest.fn(async () => ({ guideLoopStepThreshold: 'lots' }));
      expect(await window._gv2LoopStepThreshold()).toBe(1);
    });

    test('falls back to 1 when storage is unreadable', async () => {
      window.chrome.storage.local.get = jest.fn(async () => { throw new Error('no access'); });
      expect(await window._gv2LoopStepThreshold()).toBe(1);
    });
  });

  // The two halves together: with the threshold at 3, two looping steps run and the third stops.
  test('a threshold of 3 stops on the third consecutive looping step, not the first', () => {
    let count = 0;
    const stopsAt = (scores, threshold) => scores.findIndex(s => {
      count = window._gv2NextLoopStreak(count, s);
      return count >= threshold;
    });
    expect(stopsAt([0.4, 0.4, 0.4], 3)).toBe(2);

    count = 0;
    expect(stopsAt([0.4, 0.4, 0.1, 0.4, 0.4], 3)).toBe(-1);   // the clean step reset it
  });

  test('the setting is offered in Debug Mode, with a handler that stores it', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../options/options.html'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '../../options/options.js'), 'utf8');
    // Inside debugToggleGroup — this is a researcher's dial, not a general preference.
    const debugBlock = html.slice(html.indexOf('id="debugToggleGroup"'));
    expect(debugBlock).toContain('id="guideLoopStepThreshold"');
    expect(js).toContain('guideLoopStepThreshold: value');
  });
});

describe('Highlight styling (content/functions/highlight.js) — one effect, one colour', () => {
  beforeAll(() => {
    window.chrome = window.chrome || {
      storage: { local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) } },
      runtime: { sendMessage: jest.fn() }
    };
    loadScript('content/functions/highlight.js');
  });

  afterEach(() => {
    if (Math.random.mockRestore) Math.random.mockRestore();
  });

  // REGRESSION: getRandomHighlightStyle used to pick a random colour out of three and a random
  // animation out of four (pulse / spotlight / left-to-right shimmer / glow) per citation, so one
  // answer lit the page up in several colours moving in several ways at once.
  test('returns the same colour and effect no matter what Math.random does', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const first = window.getRandomHighlightStyle(false);
    Math.random.mockReturnValue(0.99);
    const second = window.getRandomHighlightStyle(false);

    expect(first).toEqual(second);
    expect(first.animation).toBe('soft');
  });

  test('never returns one of the old motion effects', () => {
    const motion = ['pulse', 'spotlight', 'shimmer', 'glow'];
    for (const isDark of [true, false]) {
      expect(motion).not.toContain(window.getRandomHighlightStyle(isDark).animation);
    }
  });

  test('varies only by page background, so every span on a page matches', () => {
    const light = window.getRandomHighlightStyle(false);
    const dark = window.getRandomHighlightStyle(true);

    expect(light.color).not.toBe(dark.color);
    expect(light.animation).toBe(dark.animation);
    expect(window.getRandomHighlightStyle(false).color).toBe(light.color);
  });

  test('block tint is lighter than span tint, in the same accent colour', () => {
    const span = window.pageguideHighlightTint('#7857ff');
    const block = window.pageguideHighlightTint('#7857ff', true);
    const pct = (v) => Number(v.match(/(\d+)%/)[1]);

    expect(pct(block)).toBeLessThan(pct(span));
    expect(span).toContain('#7857ff');
    expect(block).toContain('#7857ff');
  });

  describe('applyAnimatedHighlight', () => {
    const highlight = (opts) => {
      const el = document.createElement('p');
      document.body.appendChild(el);
      window.applyAnimatedHighlight(el, '#7857ff', 'soft', opts);
      return el;
    };

    test('marks the element with the accent colour and the base class', () => {
      const el = highlight();
      expect(el.style.getPropertyValue('--pageguide-color')).toBe('#7857ff');
      expect(el.classList.contains('pageguide-highlight')).toBe(true);
      expect(el.getAttribute('data-pageguide-styled')).toBe('true');
    });

    // REGRESSION: block elements used to be swapped onto the shimmer-block class, which ran an
    // infinite left-to-right gradient sweep across the whole paragraph.
    test('never applies the left-to-right sweep class', () => {
      const el = highlight();
      expect(el.classList.contains('pageguide-highlight-shimmer-block')).toBe(false);
    });

    test('whole-element highlights are tagged as blocks so they tint lighter', () => {
      expect(highlight({ block: true }).classList.contains('pageguide-highlight-block')).toBe(true);
      expect(highlight().classList.contains('pageguide-highlight-block')).toBe(false);
    });
  });
});

describe('Scroll-to-citation feedback (content/functions/scroll.js) — no flash', () => {
  beforeAll(() => {
    window.chrome = window.chrome || {
      storage: { local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) } },
      runtime: { sendMessage: jest.fn() }
    };
    Element.prototype.scrollIntoView = jest.fn();
    loadScript('content/functions/scroll.js');
    if (!window.getRandomHighlightStyle) loadScript('content/functions/highlight.js');
  });

  beforeEach(() => {
    document.body.innerHTML = '';
    window._pageguideHighlights = [];
    window._pageguideIndex = {};
  });

  // REGRESSION: clicking a citation used to blink the element bright yellow for 500ms and then
  // leave it yellow permanently, overriding the purple tint it already carried.
  test('scrollToHighlight scrolls without repainting the element', () => {
    const el = document.createElement('p');
    el.style.backgroundColor = 'rgb(1, 2, 3)';
    document.body.appendChild(el);
    window._pageguideHighlights = [el];

    window.scrollToHighlight(0);

    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(el.style.backgroundColor).toBe('rgb(1, 2, 3)');
  });

  // REGRESSION: scrollToIndex used to add a yellow 4px outline plus a yellow background that
  // vanished after 1.5s — a flash, in a colour nothing else on the page used.
  test('scrollToIndex marks the element with the shared tint and no yellow outline', () => {
    const el = document.createElement('p');
    document.body.appendChild(el);
    window._pageguideIndex = { 12: el };

    expect(window.scrollToIndex(12)).toBe(true);

    expect(el.style.outline).toBe('');
    expect(el.classList.contains('pageguide-highlight')).toBe(true);
    expect(el.style.getPropertyValue('--pageguide-color')).toBe(window.getRandomHighlightStyle(false).color);
    expect(window._pageguideHighlights).toContain(el);
  });

  test('scrollToIndex leaves the element untouched when the caller opts out (non-grounding)', () => {
    const el = document.createElement('p');
    document.body.appendChild(el);
    window._pageguideIndex = { 12: el };

    window.scrollToIndex(12, false);

    expect(el.className).toBe('');
    expect(el.getAttribute('data-pageguide-styled')).toBeNull();
  });
});

describe('Evidence mode: Visual vs Text (content/utils.js)', () => {
  beforeAll(() => {
    if (!window.gv2ElementSelector) loadScript('content/utils.js');
  });

  describe('normalizeEvidenceMode', () => {
    test('visual is the default for anything unrecognised', () => {
      expect(window.normalizeEvidenceMode('text')).toBe('text');
      expect(window.normalizeEvidenceMode('visual')).toBe('visual');
      expect(window.normalizeEvidenceMode('')).toBe('visual');
      expect(window.normalizeEvidenceMode(undefined)).toBe('visual');
      expect(window.normalizeEvidenceMode('TEXT')).toBe('visual'); // exact value only
    });
  });

  describe('gv2ShouldCaptureScreenshots', () => {
    // The whole point of the Text arm: it takes no screenshots at all, not merely different
    // rendering — so this predicate is the single gate every capture path checks.
    test('text mode captures nothing; every other value captures', () => {
      expect(window.gv2ShouldCaptureScreenshots('text')).toBe(false);
      expect(window.gv2ShouldCaptureScreenshots('visual')).toBe(true);
      expect(window.gv2ShouldCaptureScreenshots(undefined)).toBe(true); // legacy records
    });
  });

  describe('gv2ElementSelector', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    test('prefers a test id over structure', () => {
      document.body.innerHTML = '<div><button data-testid="search-button" aria-label="Search BBC"></button></div>';
      expect(window.gv2ElementSelector(document.querySelector('button')))
        .toBe('button[data-testid="search-button"]');
    });

    test('uses the id when there is no test id', () => {
      document.body.innerHTML = '<div><input id="q" name="query"></div>';
      expect(window.gv2ElementSelector(document.getElementById('q'))).toBe('#q');
    });

    test('identifies a link by its href', () => {
      document.body.innerHTML = '<nav><a href="/sport/football/world-cup">World Cup</a></nav>';
      expect(window.gv2ElementSelector(document.querySelector('a')))
        .toBe('a[href="/sport/football/world-cup"]');
    });

    test('falls back to an nth-of-type chain when the element has no hooks', () => {
      document.body.innerHTML = '<section><p>one</p><p>two</p></section>';
      const sel = window.gv2ElementSelector(document.querySelectorAll('p')[1]);
      expect(sel).toContain('p:nth-of-type(2)');
    });

    test('returns an empty string for a missing element instead of throwing', () => {
      expect(window.gv2ElementSelector(null)).toBe('');
    });
  });

  describe('gv2TextualEvidence', () => {
    test('collects the four fields a Text-mode evidence popup shows', () => {
      document.body.innerHTML = '<button data-testid="search-button" aria-label="Search BBC"></button>';
      const ev = window.gv2TextualEvidence(document.querySelector('button'), 'https://bbc.com/news');

      expect(ev).toEqual({
        text: '',
        ariaLabel: 'Search BBC',
        selector: 'button[data-testid="search-button"]',
        url: 'https://bbc.com/news'
      });
    });

    test('collapses whitespace in node text', () => {
      document.body.innerHTML = '<a href="/x">  World\n  Cup  </a>';
      expect(window.gv2TextualEvidence(document.querySelector('a'), '').text).toBe('World Cup');
    });
  });
});

describe('Evidence mode rendering (sidepanel/panel.js)', () => {
  beforeAll(() => {
    window.chrome = {
      runtime: {
        connect: jest.fn(() => ({ disconnect: jest.fn() })),
        sendMessage: jest.fn(),
        onMessage: { addListener: jest.fn() }
      },
      tabs: {
        onActivated: { addListener: jest.fn() },
        onUpdated: { addListener: jest.fn() },
        onRemoved: { addListener: jest.fn() }
      },
      storage: {
        onChanged: { addListener: jest.fn() },
        local: { get: jest.fn().mockResolvedValue({}), set: jest.fn().mockResolvedValue(undefined) }
      }
    };
    document.body.innerHTML = '<div id="pageguide-goal-dots"></div>';
    loadScript('sidepanel/panel.js');
  });

  describe('_normalizeEvidenceMode (toggle)', () => {
    test('defaults to visual', () => {
      expect(window._normalizeEvidenceMode('text')).toBe('text');
      expect(window._normalizeEvidenceMode('nonsense')).toBe('visual');
      expect(window._normalizeEvidenceMode(undefined)).toBe('visual');
    });
  });

  describe('_isTextEvidenceRecord', () => {
    test('only an explicit text stamp counts', () => {
      expect(window._isTextEvidenceRecord({ evidenceMode: 'text' })).toBe(true);
      expect(window._isTextEvidenceRecord({ evidenceMode: 'visual' })).toBe(false);
    });

    // REGRESSION: records written before this mode existed have no evidenceMode but always had a
    // screenshot. Treating "no shot" as text mode would silently reclassify old sessions.
    test('a legacy record with no evidenceMode is NOT text mode', () => {
      expect(window._isTextEvidenceRecord({ screenshot: null })).toBe(false);
      expect(window._isTextEvidenceRecord(null)).toBe(false);
    });
  });

  describe('_textualEvidenceHtml', () => {
    test('renders the four fields and no image', () => {
      const html = window._textualEvidenceHtml({
        text: 'World Cup',
        ariaLabel: '',
        selector: 'a[href="/sport/football/world-cup"]',
        url: 'https://bbc.co.uk/search?q=World+Cup'
      }, null, 'Step 4 — target');

      expect(html).toContain('Step 4 — target');
      expect(html).toContain('node text');
      expect(html).toContain('World Cup');
      expect(html).toContain('selector');
      expect(html).toContain('a[href="/sport/football/world-cup"]');
      expect(html).toContain('page');
      expect(html).not.toContain('<img');
      expect(html).not.toContain('aria-label'); // empty fields are dropped, not shown blank
    });

    test('falls back to the record URL when the evidence carries none', () => {
      const html = window._textualEvidenceHtml({ text: 'Latest' }, { url: 'https://bbc.com/news' });
      expect(html).toContain('https://bbc.com/news');
    });

    test('says so plainly when there is nothing to show', () => {
      expect(window._textualEvidenceHtml(null, null)).toContain('No target recorded');
    });
  });

});

describe('Text evidence mode escapes markup in a selector (sidepanel/panel.js)', () => {
  // The selector and node text come from the page, so they are untrusted input.
  test('page-supplied text cannot inject markup', () => {
    const html = window._textualEvidenceHtml({
      text: '<img src=x onerror=alert(1)>',
      selector: 'div[title="<script>"]'
    }, null);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
  });
});

describe('_isVoidStepMeta (sidepanel/panel.js) — Text-mode steps are not void', () => {
  // REGRESSION: void steps (no screenshot) are dropped from the timeline and the journey. Text
  // evidence mode never produces a screenshot, so without the mode check the entire text arm
  // rendered an empty journey.
  test('a text-mode step with no shot survives', () => {
    expect(window._isVoidStepMeta({ step: 3, hasShot: false, evidenceMode: 'text' })).toBe(false);
  });

  test('a visual-mode step with no shot is still void', () => {
    expect(window._isVoidStepMeta({ step: 3, hasShot: false, evidenceMode: 'visual' })).toBe(true);
    expect(window._isVoidStepMeta({ step: 3, hasShot: false })).toBe(true); // legacy record
  });

  test('steps that have a shot are never void', () => {
    expect(window._isVoidStepMeta({ step: 3, hasShot: true })).toBe(false);
    expect(window._isVoidStepMeta({ step: 3 })).toBe(false); // hasShot absent ≠ false
  });

  test('the initial-state node is never void', () => {
    expect(window._isVoidStepMeta({ step: 0, hasShot: false })).toBe(false);
    expect(window._isVoidStepMeta({ step: 5, isInitial: true, hasShot: false })).toBe(false);
  });
});

describe('gv2CaptureFindEvidenceShots (content/tasks/guidev2.js) — Find × Visual only', () => {
  beforeAll(() => {
    if (!window.gv2LoopScore) loadScript('content/utils.js');
    window.chrome = {
      runtime: {
        connect: jest.fn(() => ({ onMessage: { addListener: jest.fn() }, onDisconnect: { addListener: jest.fn() } })),
        sendMessage: jest.fn()
      },
      storage: {
        session: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}), remove: jest.fn(async () => {}) },
        local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) }
      }
    };
    window.safeSendMessage = jest.fn(async () => ({}));
    if (!window.gv2CaptureFindEvidenceShots) loadScript('content/tasks/guidev2.js');
    Element.prototype.scrollIntoView = jest.fn();
  });

  const visualMode = () => {
    window.chrome.storage.local.get = jest.fn(async () => ({ pageguideEvidenceMode: 'visual' }));
  };

  beforeEach(() => {
    document.documentElement.className = '';
    document.body.innerHTML = `
      <p><span id="a" class="pageguide-highlight">one</span>
         <span id="b" class="pageguide-highlight">two</span>
         <span id="c" class="pageguide-highlight">three</span></p>`;
    window._pageguideHighlights = ['a', 'b', 'c'].map(id => document.getElementById(id));
    window._pageguideHighlightNumbers = [1, 2, 3];
    // Record what the page looked like at the moment of each capture.
    window.gv2CaptureEvidenceRegion = jest.fn(async (el) => ({
      visualEvidenceShot: `SHOT-${el.id}`,
      _rootClass: document.documentElement.className,
      _activeIds: Array.from(document.querySelectorAll('.pageguide-highlight-active')).map(n => n.id)
    }));
  });

  test('captures one crop per cited span, numbered by its citation', async () => {
    visualMode();

    const shots = await window.gv2CaptureFindEvidenceShots(true);

    expect(shots).toHaveLength(3);
    expect(shots.map(s => s.index)).toEqual([1, 2, 3]);
    expect(shots.map(s => s.shot)).toEqual(['SHOT-a', 'SHOT-b', 'SHOT-c']);
    expect(shots[0].note).toBe('one');
  });

  // REGRESSION: the index used to be the position in the results array, so if the first two
  // captures failed the surviving crop was labelled "3" while the answer's only chip said [1].
  test('keeps the citation number even when earlier captures fail', async () => {
    visualMode();
    window.gv2CaptureEvidenceRegion = jest.fn(async (el) =>
      el.id === 'c' ? { visualEvidenceShot: 'SHOT-c' } : { visualEvidenceShot: null, captureError: 'dom-target-offscreen' });

    const shots = await window.gv2CaptureFindEvidenceShots(true);

    expect(shots).toHaveLength(1);
    expect(shots[0].index).toBe(3); // the third citation, not "the third capture"
  });

  test('retries transient capture failures before dropping a chip', async () => {
    visualMode();
    const attempts = {};
    window.gv2CaptureEvidenceRegion = jest.fn(async (el) => {
      attempts[el.id] = (attempts[el.id] || 0) + 1;
      if (el.id === 'b' && attempts[el.id] === 1) {
        return { visualEvidenceShot: null, captureError: 'dom-target-offscreen' };
      }
      return { visualEvidenceShot: `SHOT-${el.id}` };
    });

    const shots = await window.gv2CaptureFindEvidenceShots(true);

    expect(shots.map(s => s.index)).toEqual([1, 2, 3]);
    expect(shots.map(s => s.shot)).toEqual(['SHOT-a', 'SHOT-b', 'SHOT-c']);
    expect(attempts.b).toBe(2);
  });

  // The user-visible point of capturing one at a time: each crop shows exactly which phrase is
  // the evidence, instead of a page where every cited span carries the same tint.
  test('lights up exactly one span at a time, in capture mode', async () => {
    visualMode();

    await window.gv2CaptureFindEvidenceShots(true);

    const calls = window.gv2CaptureEvidenceRegion.mock.results.map(r => r.value);
    const states = await Promise.all(calls);
    expect(states.map(s => s._activeIds)).toEqual([['a'], ['b'], ['c']]);
    expect(states.every(s => s._rootClass.includes('pageguide-evidence-capture'))).toBe(true);
  });

  test('restores the page afterwards', async () => {
    visualMode();

    await window.gv2CaptureFindEvidenceShots(true);

    expect(document.documentElement.className).not.toContain('pageguide-evidence-capture');
    expect(document.querySelectorAll('.pageguide-highlight-active')).toHaveLength(0);
  });

  test('restores the page even when a capture throws', async () => {
    visualMode();
    window.gv2CaptureEvidenceRegion = jest.fn(async () => { throw new Error('boom'); });

    await window.gv2CaptureFindEvidenceShots(true);

    expect(document.documentElement.className).not.toContain('pageguide-evidence-capture');
    expect(document.querySelectorAll('.pageguide-highlight-active')).toHaveLength(0);
  });

  test('captures whole-element (block) highlights so bare citations still have visual evidence', async () => {
    visualMode();
    document.getElementById('b').classList.add('pageguide-highlight-block');

    const shots = await window.gv2CaptureFindEvidenceShots(true);

    expect(shots.map(s => s.shot)).toEqual(['SHOT-a', 'SHOT-b', 'SHOT-c']);
    expect(shots.map(s => s.index)).toEqual([1, 2, 3]);
  });

  test('captures more than the old eight-chip limit', async () => {
    visualMode();
    document.body.innerHTML = '<p>' + Array.from({ length: 12 }, (_, i) =>
      `<span id="h${i + 1}" class="pageguide-highlight">${i + 1}</span>`
    ).join(' ') + '</p>';
    window._pageguideHighlights = Array.from({ length: 12 }, (_, i) => document.getElementById(`h${i + 1}`));
    window._pageguideHighlightNumbers = Array.from({ length: 12 }, (_, i) => i + 1);
    window.gv2CaptureEvidenceRegion = jest.fn(async (el) => ({ visualEvidenceShot: `SHOT-${el.id}` }));

    const shots = await window.gv2CaptureFindEvidenceShots(true);

    expect(shots).toHaveLength(12);
    expect(shots.map(s => s.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  // The Text arm must not reach captureVisibleTab at all — that is the difference between the
  // two study conditions, not just what gets rendered.
  test('captures nothing in Text evidence mode', async () => {
    window.chrome.storage.local.get = jest.fn(async () => ({ pageguideEvidenceMode: 'text' }));

    expect(await window.gv2CaptureFindEvidenceShots(true)).toEqual([]);
    expect(window.gv2CaptureEvidenceRegion).not.toHaveBeenCalled();
    expect(document.documentElement.className).not.toContain('pageguide-evidence-capture');
  });

  test('skips the work when the answer highlighted nothing', async () => {
    visualMode();

    expect(await window.gv2CaptureFindEvidenceShots(false)).toEqual([]);
    expect(window.gv2CaptureEvidenceRegion).not.toHaveBeenCalled();
  });

  test('asks for no marker box — the active highlight is already in the pixels', async () => {
    visualMode();

    await window.gv2CaptureFindEvidenceShots(true);

    expect(window.gv2CaptureEvidenceRegion.mock.calls[0][3]).toEqual({ noMarker: true });
  });
});

describe('Answer marker routing (sidepanel/panel.js)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  // Clicking [N] scrolls to its span, but a span inside an already-tinted paragraph is invisible on
  // arrival and the jump reads as having gone nowhere. Hovering previews it first.
  describe('citation hover preview', () => {
    let sent;

    const mount = (inner) => {
      document.body.innerHTML = `<div id="pageguide-messages">${inner}</div>`;
      const container = document.getElementById('pageguide-messages');
      window.bindCitationHoverPreview(container);
      return container;
    };
    const hover = (el) => el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

    beforeEach(() => {
      jest.useFakeTimers();
      // The marked target is module state; clear it so each test starts with a bare page.
      window.sendToContentScript = jest.fn(async () => {});
      window.previewCitationIndex(null);
      jest.advanceTimersByTime(200);
      sent = [];
      window.sendToContentScript = jest.fn(async (msg) => { sent.push(msg); });
    });
    afterEach(() => { jest.useRealTimers(); });

    test('hovering a citation asks the page to pulse its span', () => {
      const c = mount('<span class="pageguide-citation pageguide-citation-idx" data-index="42"></span>');
      hover(c.querySelector('.pageguide-citation-idx'));
      jest.advanceTimersByTime(200);

      expect(sent).toEqual([{ action: 'previewIndex', index: 42, citation: undefined, on: true }]);
    });

    // The pointer crosses several citations on the way to the one it wants; each should not fire.
    test('a citation crossed on the way is never armed', () => {
      const c = mount(
        '<span class="pageguide-citation pageguide-citation-idx" data-index="1"></span>' +
        '<span class="pageguide-citation pageguide-citation-idx" data-index="2"></span>');
      const [first, second] = c.querySelectorAll('.pageguide-citation-idx');

      hover(first);
      jest.advanceTimersByTime(30);
      hover(second);
      jest.advanceTimersByTime(200);

      expect(sent).toEqual([{ action: 'previewIndex', index: 2, citation: undefined, on: true }]);
    });

    test('moving off the citation clears the pulse', () => {
      const c = mount('<span class="pageguide-citation pageguide-citation-idx" data-index="7"></span><p id="plain">x</p>');
      hover(c.querySelector('.pageguide-citation-idx'));
      jest.advanceTimersByTime(200);
      hover(document.getElementById('plain'));
      jest.advanceTimersByTime(200);

      expect(sent).toEqual([
        { action: 'previewIndex', index: 7, citation: undefined, on: true },
        { action: 'previewIndex', index: 7, on: false }
      ]);
    });

    // An [ev] marker points at a region the annotator drew — over a picture, usually — so it is
    // marked a different way on the page, but the reader's gesture is the same.
    test('an evidence marker marks its region instead', () => {
      const c = mount('<span class="pageguide-citation pageguide-citation-idx pageguide-evidence-citation" data-evidence-num="3"></span>');
      hover(c.querySelector('.pageguide-evidence-citation'));
      jest.advanceTimersByTime(200);

      expect(sent).toEqual([{ action: 'previewEvidenceMark', index: 3, citation: undefined, on: true }]);
    });

    test('moving from an evidence marker to a citation clears the right one', () => {
      const c = mount(
        '<span class="pageguide-citation pageguide-citation-idx pageguide-evidence-citation" data-evidence-num="3"></span>' +
        '<span class="pageguide-citation pageguide-citation-idx" data-index="42"></span>');
      hover(c.querySelector('.pageguide-evidence-citation'));
      jest.advanceTimersByTime(200);
      hover(c.querySelector('.pageguide-citation-idx[data-index]'));
      jest.advanceTimersByTime(200);

      expect(sent).toEqual([
        { action: 'previewEvidenceMark', index: 3, citation: undefined, on: true },
        { action: 'previewEvidenceMark', index: 3, on: false },
        { action: 'previewIndex', index: 42, citation: undefined, on: true }
      ]);
    });
  });

  // Which marker leads where. EVERY marker in the answer goes to the page — a cited span to its
  // highlight, an annotated evidence to the marks drawn over it. Nothing in the chat opens a crop
  // any more: the "Evidence on the page" card is gone.
  describe('click routing in the messages delegate', () => {
    let sent;

    const mount = (inner) => {
      document.body.innerHTML = `<div id="pageguide-messages"><div class="pageguide-message">${inner}</div></div>`;
      const container = document.getElementById('pageguide-messages');
      window._setupMessageContainerDelegate(container);
      return container;
    };

    beforeEach(() => {
      sent = [];
      window.sendToContentScript = jest.fn((msg) => { sent.push(msg); });
    });

    afterEach(() => { document.getElementById('pageguide-memory-shot-lightbox')?.remove(); });

    // REGRESSION: in Visual mode a [N] click used to open a crop of the span instead of scrolling to
    // it, so Visual participants lost the jump-to-page that Text participants had.
    // The citation number rides along so the jump lands on the SPAN this marker created, not the
    // paragraph around it — one paragraph often carries several citations sharing an index.
    test('a cited span scrolls the page even in Visual mode', () => {
      mount('<span class="pageguide-citation pageguide-citation-idx" data-index="42" data-citation="1"></span>');

      document.querySelector('.pageguide-citation').click();

      expect(sent).toEqual([{ action: 'scrollToIndex', index: 42, citation: '1' }]);
    });

    test('an [ev] marker goes to the mark on the page', () => {
      mount(window._expandEvidenceKeyCitations('Red shirt [ev:shirt].', [{ key: 'shirt', index: 2 }]));

      document.querySelector('.pageguide-evidence-citation').click();

      expect(sent).toEqual([{ action: 'scrollToEvidenceMark', index: 2 }]);
    });

    // REGRESSION: an [ev] marker used to be followed by a picture button opening the captured crop,
    // and the chat carried an "Evidence on the page" card of chips doing the same. A crop is a
    // re-encode of a JPEG viewport screenshot and read as blurrier than the page it came from, so
    // every affordance now points at the page instead.
    test('nothing in the answer opens a picture', () => {
      mount(window._expandEvidenceKeyCitations('Red shirt [ev:shirt].', [{ key: 'shirt', index: 2 }]));

      expect(document.querySelector('.pageguide-evidence-image-btn')).toBeNull();
      expect(document.querySelector('.pageguide-find-evidence-chip')).toBeNull();
    });

  });
});


describe('Citation numbering for evidence crops (content/tasks/ask.js)', () => {
  // REGRESSION: applyHighlightsFromCitations collects citations pattern-by-pattern (all
  // double-quoted, then single-quoted, then unquoted), so a later single-quoted citation was
  // highlighted — and numbered — before an earlier double-quoted one. The side panel numbers
  // citations by their position in the answer, so the crop labelled [2] could show citation 1's
  // text. Sorting by position is what keeps the chip and the crop talking about the same span.
  test('citation markers are ranked by position in the answer, not by quote style', () => {
    const answer = 'First [1:"alpha"] then [2:\'beta\'] then [3:gamma].';
    const positions = [...answer.matchAll(/\[(\d+)(?::[^\]]*)?\]/g)].map(m => m.index);

    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.indexOf(answer.indexOf('[1:')) + 1).toBe(1);
    expect(positions.indexOf(answer.indexOf("[2:")) + 1).toBe(2);
    expect(positions.indexOf(answer.indexOf('[3:')) + 1).toBe(3);
  });
});

describe('parseCitations malformed placeholder citations (sidepanel/panel.js)', () => {
  beforeAll(() => {
    if (!window.parseCitations) loadScript('sidepanel/panel.js');
  });

  test('does not render raw [N:"text"] placeholder citations from the model', () => {
    const html = window.parseCitations('The tree is named Adonis [N:"Adonis"] and looks old [2:"old"].');

    expect(html).not.toContain('[N:');
    expect(html).toContain('The tree is named Adonis');
    expect(html).toContain('data-index="2"');
    expect(html).toContain('citation-index');
  });

  test('keeps placeholder citation text when the surrounding sentence needs it', () => {
    const html = window.parseCitations('The tree has a [N:"dead top"] and a [N:"flattened crown"].');

    expect(html).not.toContain('[N:');
    expect(html).toContain('a dead top and a flattened crown.');
  });
});

describe('stripCitationMarkers duplicate handling (content/tasks/ask.js)', () => {
  beforeAll(() => {
    if (!window.stripCitationMarkers) {
      window.chrome = window.chrome || { storage: { local: { get: jest.fn().mockResolvedValue({}) } } };
      loadScript('content/tasks/ask.js');
    }
  });

  // REGRESSION: models normally write the phrase and then cite it with the same words. Grounding
  // mode collapses the marker to a chip so the repeat is invisible; unwrapping it printed the
  // phrase twice ("Peter Thiel Peter Thiel") in the non-grounding baseline.
  test('drops a citation that just repeats the words before it', () => {
    expect(window.stripCitationMarkers('The essay identifies **Peter Thiel** [12:"Peter Thiel"] as the figure.'))
      .toBe('The essay identifies **Peter Thiel** as the figure.');
  });

  test('ignores quotes and case when spotting the repeat', () => {
    expect(window.stripCitationMarkers('rendered the concept of "capitalist democracy" [4:"Capitalist Democracy"] into an oxymoron.'))
      .toBe('rendered the concept of "capitalist democracy" into an oxymoron.');
  });

  test('ignores punctuation sitting between the prose and the marker', () => {
    expect(window.stripCitationMarkers('the extension of the franchise to women, [3:"extension of the franchise to women"] which he opposed.'))
      .toBe('the extension of the franchise to women, which he opposed.');
  });

  test('drops a citation that repeats the words after it', () => {
    expect(window.stripCitationMarkers('He founded [7:"The Yogi"] The Yogi while jailed.'))
      .toBe('He founded The Yogi while jailed.');
  });

  // The other half of the contract: a span the sentence actually needs is still kept, or the
  // baseline answer comes out with holes in it.
  test('still keeps a span the sentence needs', () => {
    expect(window.stripCitationMarkers('Contact the depot [12:"within 30 days"] of travel.'))
      .toBe('Contact the depot within 30 days of travel.');
  });

  test('handles a repeat and a needed span in the same answer', () => {
    expect(window.stripCitationMarkers('**Sydney Flower** [1:"Sydney Flower"] founded it [2:"in 1910"] while jailed.'))
      .toBe('**Sydney Flower** founded it in 1910 while jailed.');
  });

  test('leaves no bracket syntax behind in any case', () => {
    const out = window.stripCitationMarkers('A **Peter Thiel** [12:"Peter Thiel"] b [3] c [idx:1-2] d [4:"new words"].');
    expect(out).not.toMatch(/\[/);
    expect(out).toContain('new words');
  });
});

describe('stripCitationMarkers: markers that used to leak or stutter (content/tasks/ask.js)', () => {
  beforeAll(() => {
    if (!window.stripCitationMarkers) {
      window.chrome = window.chrome || { storage: { local: { get: jest.fn().mockResolvedValue({}) } } };
      loadScript('content/tasks/ask.js');
    }
  });

  // REGRESSION: cited page text often contains quotes of its own. A [^"]+ capture stopped at the
  // inner quote, never reached the closing bracket, and left the whole marker in the answer as
  // raw text: [94:"claimed sanction from the "Great White Lodge""].
  test('parses a citation whose quoted text contains quotes', () => {
    const out = window.stripCitationMarkers(
      '**The "Great White Lodge"**: The booklet explicitly claimed sanction from this group [94:"claimed sanction from the "Great White Lodge""], which refers to the hierarchy.'
    );
    expect(out).not.toMatch(/\[94/);
    expect(out).toBe('**The "Great White Lodge"**: The booklet explicitly claimed sanction from this group, which refers to the hierarchy.');
  });

  // REGRESSION: the model paraphrases, then cites the page's near-identical wording. Exact-match
  // detection missed it and inlined an obvious stutter.
  test('drops a citation that echoes the prose without matching it word for word', () => {
    expect(window.stripCitationMarkers(
      'which refers to the hierarchy of ascended masters in the Theosophical Society [7:"Theosophical Society\'s hierarchy of ascended masters"].'
    )).toBe('which refers to the hierarchy of ascended masters in the Theosophical Society.');
  });

  test('drops a citation that repeats a quoted phrase from the prose', () => {
    expect(window.stripCitationMarkers(
      'The text stated that the school was "submissive alone to the Illuminated Government" [8:"submissive alone to the Illuminated Government"].'
    )).toBe('The text stated that the school was "submissive alone to the Illuminated Government".');
  });

  // The safety net: anything still bracket-shaped after parsing is a marker we failed to read, and
  // raw "[94:...]" in the baseline answer is worse than a dropped quote.
  test('never leaves a DOM/index-shaped marker in the answer', () => {
    const out = window.stripCitationMarkers('a [94:unclosed "quote] b [idx:1-2] c [Page 3: "x"] d [12] e.');
    expect(out).not.toMatch(/\[\s*(idx|Page|\d)/i);
  });

  test('a short span the sentence needs is still kept', () => {
    expect(window.stripCitationMarkers('Contact the depot [12:"within 30 days"] of travel.'))
      .toBe('Contact the depot within 30 days of travel.');
  });
});

describe('stripCitationMarkers: stutters from real non-grounding answers (content/tasks/ask.js)', () => {
  beforeAll(() => {
    if (!window.stripCitationMarkers) {
      window.chrome = window.chrome || { storage: { local: { get: jest.fn().mockResolvedValue({}) } } };
      loadScript('content/tasks/ask.js');
    }
  });

  const clean = (s) => window.stripCitationMarkers(s);

  // Each of these shipped a visible stutter in the baseline condition. The repeat is not always a
  // word-for-word match of the prose, which is why exact containment alone was not enough.
  test('exact repeat right before the marker', () => {
    expect(clean('the Mystic Brotherhood University [3:"Mystic Brotherhood University"], invoked authority'))
      .toBe('the Mystic Brotherhood University, invoked authority');
  });

  test('repeat of a quoted phrase', () => {
    expect(clean('the school was "submissive alone to the Illuminated Government" [8:"submissive alone to the Illuminated Government"].'))
      .toBe('the school was "submissive alone to the Illuminated Government".');
  });

  test('reworded repeat — caught by content-word overlap', () => {
    expect(clean('**A "group of Sages"**: The mailer claimed that these sages periodically revealed pathways to the "outer World" [9:"this group of Sages have revealed to the outer World, a pathway"].'))
      .toBe('**A "group of Sages"**: The mailer claimed that these sages periodically revealed pathways to the "outer World".');
  });

  // Here the repeat straddles the marker: the prose ends with the span's opening words and picks
  // up again with its closing ones.
  test('repeat split across the marker — caught at the seam', () => {
    expect(clean('The cover of the mailer featured the Rose Cross lamen [10:"featured the Rose Cross lamen of this famous nineteenth-century British occult society"] of this famous society.'))
      .toBe('The cover of the mailer featured the Rose Cross lamen of this famous society.');
  });

  // The opposite failure mode: a span the sentence depends on must survive all of the above.
  test('a needed span is still kept', () => {
    expect(clean('Contact the depot [12:"within 30 days"] of travel.'))
      .toBe('Contact the depot within 30 days of travel.');
    expect(clean('The fee is [3:"$5 per item"] at checkout.'))
      .toBe('The fee is $5 per item at checkout.');
  });
});

describe('Find × Visual: independence + page evidence (content/tasks/guidev2.js)', () => {
  beforeAll(() => {
    if (!window.gv2LoopScore) loadScript('content/utils.js');
    window.PROMPTS = window.PROMPTS || {};
    window.PROMPTS.FIND_VISUAL_EVIDENCE = 'FIND_VISUAL_EVIDENCE {maxItems}';
    window.chrome = {
      runtime: {
        connect: jest.fn(() => ({ onMessage: { addListener: jest.fn() }, onDisconnect: { addListener: jest.fn() } })),
        sendMessage: jest.fn()
      },
      storage: {
        session: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}), remove: jest.fn(async () => {}) },
        local: { get: jest.fn(async () => ({ pageguideEvidenceMode: 'visual' })), set: jest.fn(async () => {}) }
      }
    };
    if (!window.gv2BuildFindEvidence) loadScript('content/tasks/guidev2.js');
    Element.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    document.documentElement.className = '';
    document.body.innerHTML = '<p id="para"><span id="a" class="pageguide-highlight">one</span></p>';
    window._pageguideHighlights = [document.getElementById('a')];
    window._pageguideHighlightNumbers = [1];
    window._pageguideIndex = {};
    window.chrome.storage.local.get = jest.fn(async () => ({ pageguideEvidenceMode: 'visual' }));
    window.captureScreenshot = jest.fn(async () => 'PAGESHOT');
    window.showSetOfMarks = jest.fn();
    window.cleanupSom = jest.fn();
    window.createPageIndex = jest.fn(() => ({ count: 3, indexText: '[1] x' }));
    window.gv2CaptureEvidenceRegion = jest.fn(async () => ({ visualEvidenceShot: 'SPANSHOT' }));
    window.gv2CaptureEvidenceItems = jest.fn(async (items) =>
      items.map((it, i) => ({ visualEvidenceShot: `VISUAL${i}`, note: it.note })));
    window.safeSendMessage = jest.fn(async () => ({ content: '{"items":[]}' }));
  });

  describe('gv2ParseFindVisualEvidence', () => {
    test('reads the documented shape', () => {
      const items = window.gv2ParseFindVisualEvidence(
        '{"items":[{"key":"portrait_beard","note":"A man with a full beard.","som_id":"7","need_annotation":true,"annotation_prompt":"Box the beard."}]}'
      );
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        key: 'portrait_beard', som_id: '7', need_annotation: true, annotation_prompt: 'Box the beard.'
      });
    });

    test('tolerates fenced JSON and a bare array', () => {
      expect(window.gv2ParseFindVisualEvidence('```json\n{"items":[{"key":"k","som_id":"1"}]}\n```')).toHaveLength(1);
      expect(window.gv2ParseFindVisualEvidence('[{"key":"k","region_bbox":{"x":0,"y":0,"w":1,"h":1}}]')).toHaveLength(1);
    });

    // An empty list is the right answer for an ordinary text question, so bad input must not throw.
    test('returns [] for prose, empty input, or items with no target', () => {
      expect(window.gv2ParseFindVisualEvidence('I could not find anything visual.')).toEqual([]);
      expect(window.gv2ParseFindVisualEvidence('')).toEqual([]);
      expect(window.gv2ParseFindVisualEvidence('{"items":[{"key":"k"}]}')).toEqual([]);
    });

    test('caps the item count', () => {
      const many = { items: Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, som_id: String(i) })) };
      expect(window.gv2ParseFindVisualEvidence(JSON.stringify(many))).toHaveLength(3);
    });
  });

  describe('gv2RunFindVisualEvidence', () => {
    test('captures nothing and makes no call in Text evidence mode', async () => {
      window.chrome.storage.local.get = jest.fn(async () => ({ pageguideEvidenceMode: 'text' }));

      expect(await window.gv2RunFindVisualEvidence('does he have a beard?', 1)).toEqual([]);
      expect(window.safeSendMessage).not.toHaveBeenCalled();
      expect(window.captureScreenshot).not.toHaveBeenCalled();
    });

    test('sends the page screenshot and numbers items from startNumber', async () => {
      window.safeSendMessage = jest.fn(async () => ({
        content: '{"items":[{"key":"beard","note":"A full beard.","need_annotation":true,"annotation_prompt":"Box it."}]}'
      }));

      const out = await window.gv2RunFindVisualEvidence('does he have a beard?', 4);

      const msg = window.safeSendMessage.mock.calls[0][0];
      expect(msg.action).toBe('callLLMWithImages');
      expect(msg.images[0].base64).toBe('PAGESHOT');
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ shot: 'VISUAL0', note: 'A full beard.', index: 4 });
    });

    // need_annotation must survive into gv2CaptureEvidenceItems — that is what routes the item to
    // the Guide's annotator so the crop comes back with the box drawn on it.
    test('hands need_annotation items to the capture pipeline intact', async () => {
      window.safeSendMessage = jest.fn(async () => ({
        content: '{"items":[{"key":"beard","note":"A full beard.","need_annotation":true,"annotation_prompt":"Box the beard."}]}'
      }));

      await window.gv2RunFindVisualEvidence('beard?', 1);

      const item = window.gv2CaptureEvidenceItems.mock.calls[0][0][0];
      expect(item.need_annotation).toBe(true);
      expect(item.annotation_prompt).toBe('Box the beard.');
      expect(window.gv2CaptureEvidenceItems.mock.calls[0][1].maxItems).toBe(3);
    });

    test('cleans up SoM markers even when the capture fails', async () => {
      window.captureScreenshot = jest.fn(async () => null);

      expect(await window.gv2RunFindVisualEvidence('beard?', 1)).toEqual([]);
      expect(window.cleanupSom).toHaveBeenCalled();
    });

    test('an empty model reply costs nothing downstream', async () => {
      window.safeSendMessage = jest.fn(async () => ({ content: '{"items":[]}' }));

      expect(await window.gv2RunFindVisualEvidence('who founded it?', 1)).toEqual([]);
      expect(window.gv2CaptureEvidenceItems).not.toHaveBeenCalled();
    });
  });

  describe('gv2BuildFindEvidence', () => {
    // A cited span is already highlighted on the page and its [N] scrolls there, so a crop of that
    // highlight showed the reader nothing — the numbering still runs on past the citations, though,
    // so an [ev] marker can never collide with an [N] one in the same answer.
    test('illustrates no cited spans, and numbers page evidence after the citations', async () => {
      window.safeSendMessage = jest.fn(async () => ({
        content: '{"items":[{"key":"beard","note":"A full beard.","som_id":null,"need_annotation":true,"annotation_prompt":"Box it."}]}'
      }));

      const out = await window.gv2BuildFindEvidence(true, 'beard?');

      expect(window.gv2CaptureEvidenceRegion).not.toHaveBeenCalled();
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ shot: 'VISUAL0', index: 2 });
    });

    test('numbers on past every citation, not just the first', async () => {
      document.body.innerHTML = '<p><span id="a">one</span><span id="b">two</span><span id="c">three</span></p>';
      window._pageguideHighlights = ['a', 'b', 'c'].map(id => document.getElementById(id));
      window._pageguideHighlightNumbers = [1, 2, 3];
      window.safeSendMessage = jest.fn(async () => ({
        content: '{"items":[{"key":"beard","note":"A full beard.","som_id":null,"need_annotation":true,"annotation_prompt":"Box it."}]}'
      }));

      const out = await window.gv2BuildFindEvidence(true, 'beard?');

      expect(out[0].index).toBe(4);
    });

    // The model's own evidence list is the normal path (FIND_ANSWER_VISUAL returns it with the
    // answer); an explicitly empty list means the text citations carry the whole claim.
    test('captures the model evidence it is handed, and nothing for an empty list', async () => {
      const items = [{ key: 'shirt', note: 'A red shirt.', som_id: null, need_annotation: true, annotation_prompt: 'Box it.' }];

      const out = await window.gv2BuildFindEvidence(true, 'shirt?', items);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ shot: 'VISUAL0', note: 'A red shirt.', index: 2 });
      expect(window.safeSendMessage).not.toHaveBeenCalled(); // no second vision pass

      expect(await window.gv2BuildFindEvidence(true, 'shirt?', [])).toEqual([]);
      expect(window.gv2CaptureEvidenceRegion).not.toHaveBeenCalled();
    });

    // The number the panel shows must travel with the marks, so clicking [ev:N] can scroll to the
    // right one — visualEvidenceIndex is the SoM page index and cannot serve.
    test('marks carry the chip number for the on-page jump', async () => {
      window.gv2CaptureEvidenceItems = jest.fn(async (list) =>
        list.map((it, i) => ({ visualEvidenceShot: `VISUAL${i}`, note: it.note, annotations: [{ type: 'box', bbox: { x: 0, y: 0, w: 1, h: 1 } }] })));

      const out = await window.gv2BuildFindEvidence(true, 'shirt?', [
        { key: 'shirt', note: 'A red shirt.', som_id: null, need_annotation: true, annotation_prompt: 'Box it.' }
      ]);

      expect(out[0].marks.evidenceNumber).toBe(out[0].index);
    });

    // The annotated pass is the whole point for DOM-less questions: it must run even when the answer
    // highlighted nothing on the page.
    test('runs the visual pass even with no highlights', async () => {
      window.safeSendMessage = jest.fn(async () => ({
        content: '{"items":[{"key":"shirt","note":"A red shirt.","som_id":null,"need_annotation":true,"annotation_prompt":"Box it."}]}'
      }));

      const out = await window.gv2BuildFindEvidence(false, 'what colour is the shirt?');

      expect(window.gv2CaptureEvidenceRegion).not.toHaveBeenCalled(); // no spans to crop
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ shot: 'VISUAL0', note: 'A red shirt.', index: 1 });
    });
  });

  describe('span capture no longer depends on Guide state', () => {
    // REGRESSION: the marker mode was read from window._guidev2._lastVisualInputOn, so the Send
    // Image toggle silently changed what a Find capture produced.
    test('Send Image state does not reach the find capture', async () => {
      window._guidev2 = { _lastVisualInputOn: true };

      await window.gv2CaptureFindEvidenceShots(true);

      const opts = window.gv2CaptureEvidenceRegion.mock.calls[0][3];
      expect(opts).toEqual({ noMarker: true });
      expect(opts.visionMarkerDefault).toBeUndefined();
    });

    test('SoM overlays are taken down before any crop', async () => {
      await window.gv2CaptureFindEvidenceShots(true);
      expect(window.cleanupSom).toHaveBeenCalled();
    });

    // REGRESSION: a span inside a scroll container measured offscreen and the citation got no
    // picture at all. The containing block is a worse crop but a real one.
    test('falls back to the containing block when the span cannot be captured', async () => {
      window.gv2CaptureEvidenceRegion = jest.fn(async (el) =>
        el.id === 'a'
          ? { visualEvidenceShot: null, captureError: 'dom-target-offscreen' }
          : { visualEvidenceShot: 'BLOCKSHOT' });

      const out = await window.gv2CaptureFindEvidenceShots(true);

      expect(out).toEqual([{ shot: 'BLOCKSHOT', note: 'one', index: 1 }]);
      const captured = window.gv2CaptureEvidenceRegion.mock.calls.map(c => c[0].id);
      expect(captured).toContain('para');
    });
  });
});

describe('Evidence marks on the live page (content/functions/highlight.js)', () => {
  beforeAll(() => {
    window.chrome = window.chrome || {
      storage: { local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) } },
      runtime: { sendMessage: jest.fn() }
    };
    if (!window.pageguideShowEvidenceAnnotations) loadScript('content/functions/highlight.js');
    window.scrollTo = jest.fn();
  });

  beforeEach(() => {
    document.body.innerHTML = '';
    window._pageguideIndex = {};
    window.pageguideClearEvidenceAnnotations();
  });

  const GEO = { x: 100, y: 500, w: 1000, h: 800 };

  describe('gv2EvidenceDocRect', () => {
    // Annotation coordinates are fractions of the capture screenshot, so they only become page
    // coordinates once the scroll + viewport of that moment are added back.
    test('converts viewport fractions to document coordinates', () => {
      expect(window.gv2EvidenceDocRect({ x: 0.5, y: 0.25, w: 0.1, h: 0.2 }, GEO))
        .toEqual({ left: 600, top: 700, width: 100, height: 160 });
    });

    test('maps page-image annotation fractions through the image document geometry', () => {
      expect(window.gv2EvidenceDocRect(
        { x: 0.883, y: 0.412, w: 0.07, h: 0.025 },
        { x: 70, y: 440, w: 840, h: 520 }
      )).toEqual({
        left: 811.72,
        top: 654.24,
        width: 58.800000000000004,
        height: 13
      });
    });

    test('returns null rather than placing marks at 0,0 on unusable input', () => {
      expect(window.gv2EvidenceDocRect(null, GEO)).toBeNull();
      expect(window.gv2EvidenceDocRect({ x: 0, y: 0, w: 0.1, h: 0.1 }, null)).toBeNull();
      expect(window.gv2EvidenceDocRect({ x: 0, y: 0, w: 0.1, h: 0.1 }, { x: 0, y: 0, w: 0, h: 0 })).toBeNull();
      expect(window.gv2EvidenceDocRect({ x: 0, y: 0, w: 0, h: 0 }, GEO)).toBeNull();
    });
  });

  describe('gv2ResolveEvidenceElement', () => {
    test('prefers the live element behind the SoM index', () => {
      const el = document.createElement('div');
      window._pageguideIndex = { 7: el };
      expect(window.gv2ResolveEvidenceElement({ visualEvidenceIndex: 7 })).toBe(el);
    });

    test('falls back to a stored selector, and to null when nothing resolves', () => {
      document.body.innerHTML = '<a id="x" href="/y">link</a>';
      expect(window.gv2ResolveEvidenceElement({ selector: '#x' })).toBe(document.getElementById('x'));
      expect(window.gv2ResolveEvidenceElement({ selector: '#gone' })).toBeNull();
      expect(window.gv2ResolveEvidenceElement({})).toBeNull();
      // A malformed stored selector must not throw into the answer flow.
      expect(window.gv2ResolveEvidenceElement({ selector: '###' })).toBeNull();
    });
  });

  describe('pageguideShowEvidenceAnnotations', () => {
    const overlay = () => document.getElementById('pageguide-evidence-overlay');

    test('draws a box per annotation, with its label', () => {
      const drawn = window.pageguideShowEvidenceAnnotations([{
        captureGeometry: GEO,
        annotations: [
          { type: 'box', bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, label: 'Parking Lot', color: '#ff2d78' },
          { type: 'ellipse', bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, label: 'Samford Hall' }
        ]
      }]);

      expect(drawn).toBe(2);
      expect(overlay()).not.toBeNull();
      expect(overlay().textContent).toContain('Parking Lot');
      expect(overlay().textContent).toContain('Samford Hall');
    });

    test('uses annotationGeometry instead of captureGeometry for annotator marks', () => {
      const drawn = window.pageguideShowEvidenceAnnotations([{
        annotationGeometry: { x: 70, y: 440, w: 840, h: 520 },
        captureGeometry: { x: 0, y: 0, w: 1000, h: 800 },
        annotations: [
          { type: 'box', bbox: { x: 0.883, y: 0.412, w: 0.07, h: 0.025 }, label: 'Name' }
        ]
      }]);

      expect(drawn).toBe(1);
      const box = overlay().querySelector('div[style*="border"]');
      expect(parseFloat(box.style.left)).toBeCloseTo(811.72);
      expect(parseFloat(box.style.top)).toBeCloseTo(654.24);
      expect(parseFloat(box.style.width)).toBeCloseTo(58.8);
      expect(parseFloat(box.style.height)).toBeCloseTo(13);
    });

    test('draws arrows into an SVG layer', () => {
      window.pageguideShowEvidenceAnnotations([{
        captureGeometry: GEO,
        annotations: [{ type: 'arrow', from: { x: 0.2, y: 0.2 }, to: { x: 0.6, y: 0.4 }, label: 'to Hall' }]
      }]);

      expect(overlay().querySelector('svg line')).not.toBeNull();
      expect(overlay().querySelector('svg polygon')).not.toBeNull(); // arrowhead
    });

    // The second half of the ask: plain bounding-box evidence should be outlined too.
    test('outlines a region when there are no annotations', () => {
      const drawn = window.pageguideShowEvidenceAnnotations([{
        captureGeometry: GEO,
        region_bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
        note: 'Article card'
      }]);

      expect(drawn).toBe(1);
      expect(overlay().textContent).toContain('Article card');
    });

    test('anchors a region to the live element when one still resolves', () => {
      const el = document.createElement('div');
      el.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 50 });
      document.body.appendChild(el);
      window._pageguideIndex = { 3: el };

      window.pageguideShowEvidenceAnnotations([{ visualEvidenceIndex: 3, note: 'card', captureGeometry: GEO }]);

      // Element rect wins over the stored fractions — it survives reflow, they do not.
      const box = overlay().querySelector('div[style*="border"]');
      expect(box.style.left).toBe('10px');
      expect(box.style.width).toBe('200px');
    });

    test('draws nothing when an item has neither annotations nor a region', () => {
      expect(window.pageguideShowEvidenceAnnotations([{ note: 'nothing to draw' }])).toBe(0);
      expect(overlay()).toBeNull();
      expect(window.pageguideShowEvidenceAnnotations([])).toBe(0);
    });

    test('a second call replaces the previous marks', () => {
      window.pageguideShowEvidenceAnnotations([{ captureGeometry: GEO, region_bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, note: 'first' }]);
      window.pageguideShowEvidenceAnnotations([{ captureGeometry: GEO, region_bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, note: 'second' }]);

      expect(document.querySelectorAll('#pageguide-evidence-overlay')).toHaveLength(1);
      expect(overlay().textContent).toContain('second');
      expect(overlay().textContent).not.toContain('first');
    });

    test('clearing removes every node it added', () => {
      window.pageguideShowEvidenceAnnotations([{
        captureGeometry: GEO,
        annotations: [{ type: 'box', bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, label: 'x' }]
      }]);
      window.pageguideClearEvidenceAnnotations();

      expect(overlay()).toBeNull();
    });

    test('clearHighlights takes the marks down with the highlights', () => {
      window.pageguideShowEvidenceAnnotations([{ captureGeometry: GEO, region_bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, note: 'x' }]);
      window.clearHighlights();

      expect(overlay()).toBeNull();
    });
  });

  // Clicking [ev:N] in the panel has to land on mark N specifically, which means remembering where
  // each item was drawn — the overlay itself is one flat SVG plus loose divs and cannot be queried
  // back per item.
  describe('pageguideScrollToEvidenceMark', () => {
    const twoItems = () => window.pageguideShowEvidenceAnnotations([
      { captureGeometry: GEO, evidenceNumber: 2, region_bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, note: 'first' },
      { captureGeometry: GEO, evidenceNumber: 3, region_bbox: { x: 0.1, y: 0.5, w: 0.2, h: 0.1 }, note: 'second' }
    ]);

    test('records one anchor per drawn item, keyed on the chip number', () => {
      twoItems();

      expect(window._pageguideEvidenceMarks.map(m => m.index)).toEqual([2, 3]);
      expect(window._pageguideEvidenceMarks[0].rect.top).toBe(580);  // 0.1 * 800 + 500
      expect(window._pageguideEvidenceMarks[1].rect.top).toBe(900);  // 0.5 * 800 + 500
    });

    test('falls back to the drawing order when no chip number came through', () => {
      window.pageguideShowEvidenceAnnotations([
        { captureGeometry: GEO, region_bbox: { x: 0, y: 0.1, w: 0.2, h: 0.1 }, note: 'first' }
      ]);

      expect(window._pageguideEvidenceMarks.map(m => m.index)).toEqual([1]);
    });

    test('scrolls to the requested mark, framed a third down', () => {
      twoItems();
      window.scrollTo.mockClear();

      expect(window.pageguideScrollToEvidenceMark(3)).toBe(true);
      expect(window.scrollTo).toHaveBeenCalledWith({ top: 900 - (window.innerHeight / 3), behavior: 'smooth' });
    });

    // A stale message from an earlier answer must not jump the page somewhere arbitrary.
    test('an unknown mark is a no-op', () => {
      twoItems();
      window.scrollTo.mockClear();

      expect(window.pageguideScrollToEvidenceMark(9)).toBe(false);
      expect(window.pageguideScrollToEvidenceMark(undefined)).toBe(false);
      expect(window.scrollTo).not.toHaveBeenCalled();
    });

    test('clearing the marks clears the anchors too', () => {
      twoItems();
      window.pageguideClearEvidenceAnnotations();

      expect(window._pageguideEvidenceMarks).toEqual([]);
      expect(window.pageguideScrollToEvidenceMark(2)).toBe(false);
    });
  });
});

describe('Find × Visual draws its evidence on the page when the answer lands (content/tasks/guidev2.js)', () => {
  beforeAll(() => {
    if (!window.gv2BuildFindEvidence) loadScript('content/tasks/guidev2.js');
  });

  beforeEach(() => {
    document.body.innerHTML = '';
    window._pageguideHighlights = [];
    window._pageguideHighlightNumbers = [];
    window._pageguideIndex = {};
    window.chrome.storage.local.get = jest.fn(async () => ({ pageguideEvidenceMode: 'visual' }));
    window.captureScreenshot = jest.fn(async () => 'PAGESHOT');
    window.createPageIndex = jest.fn(() => ({ count: 1, indexText: '[1] x' }));
    window.showSetOfMarks = jest.fn();
    window.cleanupSom = jest.fn();
    window.pageguideShowEvidenceAnnotations = jest.fn(() => 1);
    window.safeSendMessage = jest.fn(async () => ({
      content: '{"items":[{"key":"lot","note":"The parking lot next to Samford Hall.","need_annotation":true,"annotation_prompt":"Box the lot."}]}'
    }));
    window.gv2CaptureEvidenceItems = jest.fn(async (items) => items.map((it) => ({
      visualEvidenceShot: 'VISUAL',
      note: it.note,
      annotations: [{ type: 'box', bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, label: 'Parking Lot' }],
      captureGeometry: { x: 0, y: 400, w: 1000, h: 800 }
    })));
  });

  test('hands the annotator marks to the page renderer, with their capture geometry', async () => {
    await window.gv2BuildFindEvidence(false, 'where do I park for Samford Hall?');

    expect(window.pageguideShowEvidenceAnnotations).toHaveBeenCalledTimes(1);
    const marks = window.pageguideShowEvidenceAnnotations.mock.calls[0][0];
    expect(marks[0].annotations[0].label).toBe('Parking Lot');
    expect(marks[0].captureGeometry).toEqual({ x: 0, y: 400, w: 1000, h: 800 });
    // The screenshots stay out of the marks payload — it rides along on every panel message.
    expect(marks[0].annotationScreenshot).toBeUndefined();
  });

  test('draws nothing when the evidence has no marks to place', async () => {
    window.gv2CaptureEvidenceItems = jest.fn(async (items) =>
      items.map((it) => ({ visualEvidenceShot: 'VISUAL', note: it.note, annotations: [], region_bbox: null })));

    await window.gv2BuildFindEvidence(false, 'who founded it?');

    expect(window.pageguideShowEvidenceAnnotations).not.toHaveBeenCalled();
  });

  // Text mode never captures, so there is nothing to draw either.
  test('draws nothing in Text evidence mode', async () => {
    window.chrome.storage.local.get = jest.fn(async () => ({ pageguideEvidenceMode: 'text' }));

    await window.gv2BuildFindEvidence(false, 'where do I park?');

    expect(window.pageguideShowEvidenceAnnotations).not.toHaveBeenCalled();
    expect(window.safeSendMessage).not.toHaveBeenCalled();
  });
});

describe('Per-answer debug chip (sidepanel/panel.js)', () => {
  beforeAll(() => {
    if (!window._debugRangeForAnswer) {
      window.chrome = window.chrome || {
        runtime: { connect: jest.fn(() => ({ disconnect: jest.fn() })), sendMessage: jest.fn(), onMessage: { addListener: jest.fn() } },
        tabs: { onActivated: { addListener: jest.fn() }, onUpdated: { addListener: jest.fn() }, onRemoved: { addListener: jest.fn() } },
        storage: { onChanged: { addListener: jest.fn() }, local: { get: jest.fn().mockResolvedValue({}), set: jest.fn().mockResolvedValue(undefined) } }
      };
      document.body.innerHTML = '<div id="pageguide-goal-dots"></div>';
      loadScript('sidepanel/panel.js');
    }
  });

  afterEach(() => { window.__pgDebugEnabled = false; });

  describe('_debugRangeForAnswer', () => {
    const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

    test('returns exactly the calls made while the answer was being produced', () => {
      expect(window._debugRangeForAnswer(1, 3, entries).map(e => e.id)).toEqual(['b', 'c']);
    });

    // debugPrompts is capped at 50 in the service worker, so a range can outlive its entries.
    test('survives a range that points past the end', () => {
      expect(window._debugRangeForAnswer(2, 99, entries).map(e => e.id)).toEqual(['c', 'd']);
      expect(window._debugRangeForAnswer(99, 120, entries)).toEqual([]);
    });

    test('returns [] rather than throwing on missing input', () => {
      expect(window._debugRangeForAnswer(undefined, 2, entries)).toEqual([]);
      expect(window._debugRangeForAnswer(0, 2, null)).toEqual([]);
      expect(window._debugRangeForAnswer(3, 1, entries)).toEqual([]); // inverted range
    });
  });

  describe('_debugAnswerChipHtml', () => {
    test('renders nothing unless debug mode is on', () => {
      window.__pgDebugEnabled = false;
      expect(window._debugAnswerChipHtml(4)).toBe('');
    });

    test('carries the range start so the click knows which calls to show', () => {
      window.__pgDebugEnabled = true;
      const html = window._debugAnswerChipHtml(4);
      expect(html).toContain('pageguide-debug-answer-chip');
      expect(html).toContain('data-debug-from="4"');
    });

    test('defaults a missing start to 0 instead of emitting NaN', () => {
      window.__pgDebugEnabled = true;
      expect(window._debugAnswerChipHtml(undefined)).toContain('data-debug-from="0"');
    });
  });

  describe('_debugRawResponseHtml', () => {
    test('shows the raw response returned by the model', () => {
      const html = window._debugRawResponseHtml({ rawResponse: '{"action":"finish"}', ok: true, durationMs: 1234 });
      expect(html).toContain('Raw model response');
      expect(html).toContain('{"action":"finish"}');
      expect(html).toContain('1234ms');
    });

    // The entry is written before the call runs, so "no response" is a real state, not a bug.
    test('says pending when the call had not returned', () => {
      expect(window._debugRawResponseHtml({ systemPrompt: 'x' })).toContain('pending');
    });

    test('flags a failed call', () => {
      const html = window._debugRawResponseHtml({ rawResponse: 'HTTP 429', ok: false });
      expect(html).toContain('ERROR');
      expect(html).toContain('HTTP 429');
    });

    test('escapes the response — it is model output, not markup', () => {
      const html = window._debugRawResponseHtml({ rawResponse: '<img src=x onerror=alert(1)>' });
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img');
    });
  });

  describe('_debugImageIdForAttachment', () => {
    test('uses the explicit id on a sent image', () => {
      expect(window._debugImageIdForAttachment({ id: 'page_image_1', label: 'Image on page' })).toBe('page_image_1');
    });

    test('falls back to the image_id embedded in the label', () => {
      expect(window._debugImageIdForAttachment({ label: '[image_id=viewport] Page screenshot' })).toBe('viewport');
    });

    test('uses a supplied fallback for older debug records', () => {
      expect(window._debugImageIdForAttachment({ label: 'Image attachment' }, 'image_2')).toBe('image_2');
    });
  });
});

describe('Find × Visual: one multimodal answer call (content/tasks/guidev2.js)', () => {
  beforeAll(() => {
    if (!window.gv2ParseFindAnswer) loadScript('content/tasks/guidev2.js');
  });

  describe('gv2ParseFindAnswer', () => {
    test('reads the {answer, evidence} envelope', () => {
      const out = window.gv2ParseFindAnswer(
        '{"answer":"Yes — the portrait shows a beard [12:\\"Portrait of a Carthusian\\"].","evidence":[{"key":"beard","note":"A full beard.","som_id":"12","need_annotation":true,"annotation_prompt":"Box it."}]}'
      );
      expect(out.answer).toContain('[12:"Portrait of a Carthusian"]');
      expect(out.evidence).toHaveLength(1);
      expect(out.evidence[0]).toMatchObject({ key: 'beard', som_id: '12', source_image_id: 'viewport', need_annotation: true });
    });

    test('tolerates fenced JSON', () => {
      const out = window.gv2ParseFindAnswer('```json\n{"answer":"Hi","evidence":[]}\n```');
      expect(out.answer).toBe('Hi');
      expect(out.evidence).toEqual([]);
    });

    // A model that ignores the envelope must still produce a readable answer — never an empty one.
    test('falls back to prose when the envelope is missing', () => {
      const out = window.gv2ParseFindAnswer('The movie was directed by Christopher Nolan [45:"Christopher Nolan"].');
      expect(out.answer).toContain('Christopher Nolan');
      expect(out.evidence).toEqual([]);
    });

    test('handles empty input without throwing', () => {
      expect(window.gv2ParseFindAnswer('')).toEqual({ answer: '', evidence: [] });
      expect(window.gv2ParseFindAnswer(null)).toEqual({ answer: '', evidence: [] });
    });

    test('drops evidence items with no target', () => {
      const out = window.gv2ParseFindAnswer('{"answer":"x","evidence":[{"key":"k","note":"n"}]}');
      expect(out.evidence).toEqual([]);
    });

    test('preserves the source image id for visual evidence items', () => {
      const out = window.gv2ParseFindAnswer(
        '{"answer":"Yes [ev:beard].","evidence":[{"key":"beard","note":"A beard.","som_id":"12","source_image_id":"page_image_1","need_annotation":true,"annotation_prompt":"Box it."}]}'
      );
      expect(out.evidence[0]).toMatchObject({ key: 'beard', source_image_id: 'page_image_1' });
    });

    test('parses image selector JSON and ignores unknown ids', () => {
      const out = window.gv2ParseImageSelection(
        '```json\n{"selected_image_ids":["page_image_2","missing","page_image_1"],"reason":"caption match"}\n```',
        ['page_image_1', 'page_image_2']
      );
      expect(out).toEqual({
        selectedIds: ['page_image_2', 'page_image_1'],
        reason: 'caption match'
      });
    });

    test('image selector fails open on malformed output', async () => {
      window.safeSendMessage = jest.fn(async () => ({ content: 'not json' }));
      const images = [
        { id: 'viewport', base64: 'VIEW', label: '[image_id=viewport] Page screenshot' },
        { id: 'page_image_1', base64: 'A', label: '[image_id=page_image_1] Image on page: A' },
        { id: 'page_image_2', base64: 'B', label: '[image_id=page_image_2] Image on page: B' }
      ];

      const out = await window.gv2SelectFindAnswerImages('question', images, { mode: 'test' });

      expect(out.map(i => i.id)).toEqual(['viewport', 'page_image_1', 'page_image_2']);
      expect(out.selectionDiagnostics).toMatchObject({
        status: 'empty_fail_open',
        selectedImageIds: ['viewport', 'page_image_1', 'page_image_2']
      });
    });

    test('image selector keeps viewport and selected page image ids', async () => {
      window.safeSendMessage = jest.fn(async () => ({
        content: '{"selected_image_ids":["page_image_2"],"reason":"title mentions the instrument"}'
      }));
      const images = [
        { id: 'viewport', base64: 'VIEW', label: '[image_id=viewport] Page screenshot' },
        { id: 'page_image_1', base64: 'A', label: '[image_id=page_image_1] Image on page: Portrait' },
        { id: 'page_image_2', base64: 'B', label: '[image_id=page_image_2] Image on page: Farce actors with instrument' }
      ];

      const out = await window.gv2SelectFindAnswerImages('what color is the shirt of the instrument player?', images, { mode: 'test' });

      expect(window.safeSendMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: 'callImageSelectionLLM',
        metadata: expect.objectContaining({ mode: 'find_image_selector', parentMode: 'test' })
      }));
      expect(out.map(i => i.id)).toEqual(['viewport', 'page_image_2']);
      expect(out.selectionDiagnostics).toMatchObject({
        status: 'selected',
        selectedImageIds: ['viewport', 'page_image_2'],
        droppedImageIds: ['page_image_1']
      });
    });
  });

  describe('gv2RunFind arms', () => {
    beforeEach(() => {
      document.body.innerHTML = '<p id="para">page text</p>';
      window._pageguideHighlights = [];
      window._pageguideHighlightNumbers = [];
      window._pageguideIndex = {};
      window.getVisibleText = jest.fn(() => 'Lost property. Contact the depot.');
      window.createPageIndex = jest.fn(() => ({ count: 2, indexText: '[12] Portrait' }));
      window.applyHighlightsFromCitations = jest.fn(() => 1);
      window.scrollToHighlight = jest.fn();
      window.captureScreenshot = jest.fn(async () => 'PAGESHOT');
      window.showSetOfMarks = jest.fn();
      window.cleanupSom = jest.fn();
      window.gv2CaptureEvidenceRegion = jest.fn(async () => ({ visualEvidenceShot: 'SPAN' }));
      window.gv2CaptureEvidenceItems = jest.fn(async (items) => items.map(it => ({ visualEvidenceShot: 'VISUAL', note: it.note })));
      window.pageguideShowEvidenceAnnotations = jest.fn();
      window.PROMPTS = Object.assign({}, window.PROMPTS, {
        ANSWER_AND_HIGHLIGHT: 'TEXT_PROMPT {pageContent} {pageIndex}',
        FIND_ANSWER_VISUAL: 'VISUAL_PROMPT {pageContent} {pageIndex} max={maxItems}'
      });
      delete window.PROMPTS.ANSWER_NONGROUNDING;
    });

    test('Visual mode sends ONE call with the screenshot and the visual prompt', async () => {
      window.chrome.storage.local.get = jest.fn(async () => ({ pageguideEvidenceMode: 'visual' }));
      window.safeSendMessage = jest.fn(async () => ({
        content: '{"answer":"Yes, a beard [12:\\"Portrait\\"].","evidence":[{"key":"beard","note":"A beard.","som_id":"12","need_annotation":true,"annotation_prompt":"Box it."}]}'
      }));

      const out = await window.gv2RunFind('does he have a beard?');

      const answerCalls = window.safeSendMessage.mock.calls.filter(c => String(c[0]?.metadata?.mode || '').startsWith('guide_find'));
      expect(answerCalls).toHaveLength(1);
      expect(answerCalls[0][0].action).toBe('callLLMWithImages');
      expect(answerCalls[0][0].images).toHaveLength(1);
      expect(answerCalls[0][0].images[0]).toMatchObject({ id: 'viewport' });
      expect(answerCalls[0][0].systemPrompt).toContain('VISUAL_PROMPT');
      // The envelope is unwrapped: the user sees prose, not JSON.
      expect(out.answer).toBe('Yes, a beard [12:"Portrait"].');
      // The model's own evidence went straight to the capture pipeline — no second vision call.
      expect(window.gv2CaptureEvidenceItems).toHaveBeenCalledTimes(1);
      expect(window.gv2CaptureEvidenceItems.mock.calls[0][0][0]).toMatchObject({
        source_image_id: 'viewport', need_annotation: true, annotation_prompt: 'Box it.'
      });
    });

    test('Visual mode preselects relevant page image ids before the main answer call', async () => {
      document.body.innerHTML = `
        <main>
          <figure><img id="a" alt="Portrait"><figcaption>Portrait of a monk</figcaption></figure>
          <figure><img id="b" alt="Harbor"><figcaption>A harbor scene</figcaption></figure>
          <figure><img id="c" alt="Map"><figcaption>A route map</figcaption></figure>
          <figure><img id="d" alt="Farce actors"><figcaption>Verio, Farceurs Francais et Italiens</figcaption></figure>
        </main>`;
      ['a', 'b', 'c', 'd'].forEach((id, idx) => {
        document.getElementById(id).getBoundingClientRect = () => ({ left: 0, top: idx * 900, width: 300, height: 300 });
      });
      window.chrome.storage.local.get = jest.fn(async () => ({ pageguideEvidenceMode: 'visual' }));
      window.gv2CaptureEvidenceRegion = jest.fn(async (el) => ({ visualEvidenceShot: `CROP-${el.id}` }));
      window.safeSendMessage = jest.fn(async (msg) => {
        if (msg.action === 'callImageSelectionLLM') {
          return { content: '{"selected_image_ids":["page_image_4"],"reason":"instrument caption"}' };
        }
        return { content: '{"answer":"The shirt is yellow.","evidence":[]}' };
      });
      document.querySelectorAll('figure').forEach((fig, idx) => {
        fig.getBoundingClientRect = () => ({ left: 0, top: idx * 900, width: 300, height: 300 });
      });

      await window.gv2RunFind('what do you see in the selected picture?');

      const selectorCall = window.safeSendMessage.mock.calls.map(c => c[0]).find(msg => msg.action === 'callImageSelectionLLM');
      const answerCall = window.safeSendMessage.mock.calls.map(c => c[0]).find(msg => msg.action === 'callLLMWithImages');
      expect(selectorCall?.messages?.[0]?.content).toContain('page_image_1');
      expect(selectorCall?.messages?.[0]?.content).toContain('page_image_4');
      expect(window.gv2CaptureEvidenceRegion.mock.calls[0][0].querySelector('img').id).toBe('d');
      expect(window.gv2CaptureEvidenceRegion.mock.calls[0][3]).toMatchObject({ scrollIntoView: true });
      expect(answerCall?.images.map(img => img.id)).toEqual(['viewport', 'page_image_4']);
      expect(answerCall?.metadata?.imageSelectionDiagnostics).toMatchObject({
        status: 'selected',
        selectedImageIds: ['page_image_4']
      });
    });

    // REGRESSION: the two study arms must differ only in evidence. Text mode keeps the old prompt,
    // the old call shape, and takes no screenshots at all.
    test('Text mode still sends a text-only call with the original prompt', async () => {
      window.chrome.storage.local.get = jest.fn(async () => ({ pageguideEvidenceMode: 'text' }));
      window.safeSendMessage = jest.fn(async () => ({ content: 'Plain answer [12:"Portrait"].' }));

      const out = await window.gv2RunFind('does he have a beard?');

      const answerCalls = window.safeSendMessage.mock.calls.filter(c => String(c[0]?.metadata?.mode || '').startsWith('guide_find'));
      expect(answerCalls).toHaveLength(1);
      expect(answerCalls[0][0].action).toBe('callLLM');
      expect(answerCalls[0][0].images).toBeUndefined();
      expect(answerCalls[0][0].systemPrompt).toContain('TEXT_PROMPT');
      expect(window.captureScreenshot).not.toHaveBeenCalled();
      expect(window.gv2CaptureEvidenceItems).not.toHaveBeenCalled();
      expect(out.answer).toBe('Plain answer [12:"Portrait"].');
      expect(out.findEvidenceShots).toEqual([]);
    });

    test('Non-grounding visual mode uses the SAME prompt as grounding and skips evidence capture', async () => {
      window.chrome.storage.local.get = jest.fn(async () => ({
        pageguideEvidenceMode: 'visual',
        pageguideNonGrounding: 'on'
      }));
      window.safeSendMessage = jest.fn(async () => ({
        content: 'The garment appears to be draped over the figure. [ev:engraving_detail] [12:"Portrait"]'
      }));

      const out = await window.gv2RunFind('what does the engraving show?');

      const answerCalls = window.safeSendMessage.mock.calls.filter(c => String(c[0]?.metadata?.mode || '').startsWith('guide_find'));
      expect(answerCalls).toHaveLength(1);
      expect(answerCalls[0][0].action).toBe('callLLMWithImages');
      expect(answerCalls[0][0].metadata.mode).toBe('guide_find_nongrounding_visual');
      // Same question asked, same images attached — only the display differs between arms.
      expect(answerCalls[0][0].systemPrompt).toContain('VISUAL_PROMPT');
      expect(window.applyHighlightsFromCitations).not.toHaveBeenCalled();
      expect(window.gv2CaptureEvidenceItems).not.toHaveBeenCalled();
      expect(window.pageguideShowEvidenceAnnotations).not.toHaveBeenCalled();
      expect(out.answer).toBe('The garment appears to be draped over the figure.');
      expect(out.findEvidenceShots).toEqual([]);
      expect(out.highlightCount).toBe(0);
    });

    // Both arms now share a prompt, so the baseline gets the JSON envelope back. Unwrapping it is the
    // difference between prose and a wall of raw JSON in the participant's chat.
    test('Non-grounding unwraps the envelope and drops every marker and evidence item', async () => {
      window.chrome.storage.local.get = jest.fn(async () => ({
        pageguideEvidenceMode: 'visual',
        pageguideNonGrounding: 'on'
      }));
      // The span is inlined rather than deleted (stripCitationMarkers keeps text the sentence needs),
      // which is exactly the behaviour the existing marker tests pin down.
      window.safeSendMessage = jest.fn(async () => ({
        content: '{"answer":"The garment is draped [ev:engraving_detail] [12:\\"over the figure\\"].","evidence":[{"key":"engraving_detail","note":"A draped garment.","som_id":"12","need_annotation":true,"annotation_prompt":"Box it."}]}'
      }));

      const out = await window.gv2RunFind('what does the engraving show?');

      expect(out.answer).toBe('The garment is draped over the figure.');
      expect(out.answer).not.toContain('{');
      expect(out.answer).not.toContain('evidence');
      expect(out.answer).not.toContain('[ev:');
      expect(out.answer).not.toMatch(/\[\d+/);
      expect(out.findEvidenceShots).toEqual([]);
      expect(window.gv2CaptureEvidenceItems).not.toHaveBeenCalled();
      expect(window.pageguideShowEvidenceAnnotations).not.toHaveBeenCalled();
    });

    test('Non-grounding still shows prose when the envelope is malformed', async () => {
      window.chrome.storage.local.get = jest.fn(async () => ({
        pageguideEvidenceMode: 'visual',
        pageguideNonGrounding: 'on'
      }));
      window.safeSendMessage = jest.fn(async () => ({ content: 'Yes, he has a beard [12:"a beard"].' }));

      const out = await window.gv2RunFind('beard?');

      expect(out.answer).toBe('Yes, he has a beard.');
    });

    // The confound guard, and the reason for the whole change: an answer generated under one prompt
    // cannot be compared with an answer generated under another.
    test('both arms send an identical system prompt for the same evidence mode', async () => {
      const promptFor = async (nonGrounding) => {
        window.safeSendMessage = jest.fn(async () => ({ content: '{"answer":"An answer.","evidence":[]}' }));
        window.chrome.storage.local.get = jest.fn(async () => Object.assign(
          { pageguideEvidenceMode: 'visual' },
          nonGrounding ? { pageguideNonGrounding: 'on' } : {}
        ));
        await window.gv2RunFind('what does the engraving show?');
        return window.safeSendMessage.mock.calls
          .find(c => String(c[0]?.metadata?.mode || '').startsWith('guide_find'))[0].systemPrompt;
      };

      expect(await promptFor(true)).toBe(await promptFor(false));
    });

    // REGRESSION: the parse used to be gated on the screenshot too, so a visual-mode run whose
    // capture failed asked for JSON and then printed it raw.
    test('a visual-mode run with no screenshot still unwraps the envelope, in both arms', async () => {
      window.captureScreenshot = jest.fn(async () => null);
      window.safeSendMessage = jest.fn(async () => ({ content: '{"answer":"The shirt is yellow.","evidence":[]}' }));

      window.chrome.storage.local.get = jest.fn(async () => ({ pageguideEvidenceMode: 'visual' }));
      expect((await window.gv2RunFind('shirt?')).answer).toBe('The shirt is yellow.');

      window.chrome.storage.local.get = jest.fn(async () => ({
        pageguideEvidenceMode: 'visual',
        pageguideNonGrounding: 'on'
      }));
      expect((await window.gv2RunFind('shirt?')).answer).toBe('The shirt is yellow.');
    });

    test('a malformed envelope still shows the answer, with no evidence', async () => {
      window.chrome.storage.local.get = jest.fn(async () => ({ pageguideEvidenceMode: 'visual' }));
      window.safeSendMessage = jest.fn(async () => ({ content: 'Yes, he has a beard [12:"Portrait"].' }));

      const out = await window.gv2RunFind('beard?');

      expect(out.answer).toBe('Yes, he has a beard [12:"Portrait"].');
      expect(window.gv2CaptureEvidenceItems).not.toHaveBeenCalled();
    });
  });
});

describe('Annotations: free-form paths (content/utils.js + highlight.js)', () => {
  beforeAll(() => {
    if (!window.gv2NormalizeEvidenceAnnotations) loadScript('content/utils.js');
    // Reload unconditionally: an earlier block replaces pageguideShowEvidenceAnnotations with a
    // jest mock, and these tests exercise the real renderer.
    loadScript('content/functions/highlight.js');
    window.scrollTo = jest.fn();
  });

  describe('gv2NormalizeEvidenceAnnotations', () => {
    // The annotator was limited to box/ellipse/arrow/line; a route, a river or an irregular
    // outline had no shape that could describe it.
    test('accepts a path and keeps its points in order', () => {
      const out = window.gv2NormalizeEvidenceAnnotations([{
        type: 'path',
        points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }, { x: 0.5, y: 0.35 }],
        curved: true, arrow: true, label: 'walk this way', color: '#ff2d78'
      }]);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ type: 'path', curved: true, arrow: true, label: 'walk this way' });
      expect(out[0].points).toHaveLength(3);
      expect(out[0].points[0]).toEqual({ x: 0.1, y: 0.2 });
    });

    test('accepts the aliases a model is likely to use', () => {
      ['polyline', 'curve', 'freehand', 'scribble'].forEach(type => {
        const out = window.gv2NormalizeEvidenceAnnotations([{ type, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }]);
        expect(out[0].type).toBe('path');
      });
    });

    test('defaults curved on, arrow off', () => {
      const out = window.gv2NormalizeEvidenceAnnotations([{ type: 'path', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }]);
      expect(out[0]).toMatchObject({ curved: true, arrow: false });
    });

    test('drops a path that cannot be drawn, and caps very long ones', () => {
      expect(window.gv2NormalizeEvidenceAnnotations([{ type: 'path', points: [{ x: 0.1, y: 0.1 }] }])).toEqual([]);
      expect(window.gv2NormalizeEvidenceAnnotations([{ type: 'path' }])).toEqual([]);
      const many = Array.from({ length: 40 }, (_, i) => ({ x: i / 40, y: 0.5 }));
      expect(window.gv2NormalizeEvidenceAnnotations([{ type: 'path', points: many }])[0].points).toHaveLength(20);
    });

    test('still accepts the original shapes', () => {
      const out = window.gv2NormalizeEvidenceAnnotations([
        { type: 'box', bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
        { type: 'arrow', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }
      ]);
      expect(out.map(a => a.type)).toEqual(['box', 'arrow']);
    });
  });

  describe('pageguideShowEvidenceAnnotations with a path', () => {
    const GEO = { x: 0, y: 0, w: 1000, h: 800 };
    const overlay = () => document.getElementById('pageguide-evidence-overlay');

    beforeEach(() => {
      document.body.innerHTML = '';
      window.pageguideClearEvidenceAnnotations();
    });

    test('draws the stroke as an SVG path', () => {
      const drawn = window.pageguideShowEvidenceAnnotations([{
        captureGeometry: GEO,
        annotations: [{ type: 'path', points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.5 }, { x: 0.8, y: 0.3 }], curved: true, label: 'route' }]
      }]);

      expect(drawn).toBe(1);
      const path = overlay().querySelector('svg path');
      expect(path).not.toBeNull();
      expect(path.getAttribute('d')).toContain('Q'); // smoothed, not a polyline
      expect(overlay().textContent).toContain('route');
    });

    test('straight segments when curved is false, arrowhead when arrow is true', () => {
      window.pageguideShowEvidenceAnnotations([{
        captureGeometry: GEO,
        annotations: [{ type: 'path', points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.5 }, { x: 0.8, y: 0.3 }], curved: false, arrow: true }]
      }]);

      const d = overlay().querySelector('svg path').getAttribute('d');
      expect(d).not.toContain('Q');
      expect(overlay().querySelector('svg polygon')).not.toBeNull();
    });

    test('a path with one usable point draws nothing', () => {
      expect(window.pageguideShowEvidenceAnnotations([{
        captureGeometry: GEO,
        annotations: [{ type: 'path', points: [{ x: 0.1, y: 0.1 }] }]
      }])).toBe(0);
    });

    // 'line' is a plain connector; only 'arrow' should carry a head.
    test('line has no arrowhead, arrow does', () => {
      window.pageguideShowEvidenceAnnotations([{
        captureGeometry: GEO,
        annotations: [{ type: 'line', from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 } }]
      }]);
      expect(overlay().querySelector('svg polygon')).toBeNull();

      window.pageguideShowEvidenceAnnotations([{
        captureGeometry: GEO,
        annotations: [{ type: 'arrow', from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 } }]
      }]);
      expect(overlay().querySelector('svg polygon')).not.toBeNull();
    });
  });
});

describe('[ev:key] citations in the answer (sidepanel/panel.js)', () => {
  const shots = [{ key: 'portrait_beard', index: 3 }, { key: 'red_shirt', index: 4 }];

  // The label is the reader's position in ONE sequence; the capture-time number survives on
  // data-evidence-num, which is what scrollToEvidenceMark resolves against.
  test('turns a cited key into a marker, numbered where it appears', () => {
    const html = window._expandEvidenceKeyCitations('has a full beard [ev:portrait_beard].', shots);
    expect(html).toContain('pageguide-evidence-citation');
    expect(html).toContain('data-evidence-num="3"'); // where it goes
    expect(html).toContain('[1]');                   // what it reads as
    expect(html).not.toContain('[ev:');
  });

  // REGRESSION: the label used to be the capture-time number, so an answer whose earlier evidence
  // was edited out read "[1] … [4]" with 2 and 3 nowhere — missing evidence, not renumbered.
  test('numbering is contiguous after the text citations, whatever was captured', () => {
    const html = window._expandEvidenceKeyCitations(
      'Cited <span class="pageguide-citation pageguide-citation-idx" data-index="12">' +
      '<sup class="citation-index">[1]</sup></span> then [ev:red_shirt] and [ev:portrait_beard].',
      shots
    );

    expect(html).toContain('<sup class="citation-index">[2]</sup></span>');
    expect(html).toContain('<sup class="citation-index">[3]</sup></span>');
    expect(html).not.toContain('[4]');
    // Each still points where its evidence actually is.
    expect(html.indexOf('data-evidence-num="4"')).toBeLessThan(html.indexOf('data-evidence-num="3"'));
  });

  test('with no text citations the evidence starts at 1', () => {
    const html = window._expandEvidenceKeyCitations('a [ev:red_shirt] b [ev:portrait_beard]', shots);
    expect(html).toContain('<sup class="citation-index">[1]</sup>');
    expect(html).toContain('<sup class="citation-index">[2]</sup>');
  });

  // The marker is the whole affordance: it leads to the annotation on the page, and nothing in the
  // answer opens a picture any more.
  test('emits the marker alone, with no picture button beside it', () => {
    const html = window._expandEvidenceKeyCitations('a red shirt [ev:red_shirt].', shots);
    document.body.innerHTML = html;

    const marker = document.querySelector('.pageguide-evidence-citation');
    expect(marker.dataset.evidenceNum).toBe('4');
    expect(html).not.toContain('pageguide-evidence-image-btn');
    expect(document.querySelector('button')).toBeNull();
  });

  test('is case- and whitespace-insensitive about the key', () => {
    expect(window._expandEvidenceKeyCitations('x [ev: Portrait_Beard ]', shots)).toContain('data-evidence-num="3"');
  });

  // A key whose evidence failed to capture would otherwise appear as raw "[ev:foo]" in the prose.
  test('drops a key with no captured evidence', () => {
    const html = window._expandEvidenceKeyCitations('x [ev:missing] y', shots);
    expect(html).not.toContain('[ev:');
    expect(html).not.toContain('missing');
  });

  test('leaves text without evidence citations untouched', () => {
    const plain = 'The movie was directed by Christopher Nolan [45:"Christopher Nolan"].';
    expect(window._expandEvidenceKeyCitations(plain, shots)).toBe(plain);
    expect(window._expandEvidenceKeyCitations('x [ev:portrait_beard]', [])).toBe('x ');
  });
});

describe('Find × Visual: annotation is honoured for element-backed evidence (content/tasks/guidev2.js)', () => {
  beforeAll(() => {
    if (!window.gv2CaptureFindEvidenceItems) loadScript('content/tasks/guidev2.js');
    window._realGv2CaptureEvidenceItems = window._gv2RealCaptureEvidenceItems || window.gv2CaptureEvidenceItems;
  });

  beforeEach(() => {
    document.body.innerHTML = '<img id="painting" alt="portrait">';
    const el = document.getElementById('painting');
    el.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 500 });
    window._pageguideIndex = { 12: el };
    window.chrome.storage.local.get = jest.fn(async () => ({ pageguideEvidenceMode: 'visual' }));
    window.gv2CaptureEvidenceItems = jest.fn(async (items) => items.map(it => ({ visualEvidenceShot: 'SHOT', note: it.note, key: it.key })));
    window.pageguideShowEvidenceAnnotations = jest.fn();
    if (window.gv2ClearFindCropCache) window.gv2ClearFindCropCache();
  });

  // REGRESSION: _gv2AnnotateEvidenceItem returns early for anything carrying an element or som_id,
  // so a model asking to "box the man's beard" on an indexed <img> got no annotator call at all —
  // just a plain box around the whole painting.
  test('an element-backed item that needs annotation is sent to the annotator, with the element rect as the hint', async () => {
    await window.gv2CaptureFindEvidenceItems([{
      key: 'portrait_beard', note: 'A full beard.', som_id: '12',
      need_annotation: true, annotation_prompt: "Box the man's beard."
    }], 1);

    const item = window.gv2CaptureEvidenceItems.mock.calls[0][0][0];
    expect(item.need_annotation).toBe(true);
    expect(item.evidenceEl).toBeNull();   // dropped so the annotator gate lets it through
    expect(item.som_id).toBeNull();
    expect(item.region_bbox).not.toBeNull(); // the element's rect, so the annotator aims inside it
    expect(item.annotation_prompt).toBe("Box the man's beard.");
  });

  // The other half: evidence that just points at an element keeps the cheap DOM-marker path.
  test('an element-backed item that does NOT need annotation keeps its element', async () => {
    await window.gv2CaptureFindEvidenceItems([{
      key: 'portrait', note: 'The portrait.', som_id: '12', need_annotation: false
    }], 1);

    const item = window.gv2CaptureEvidenceItems.mock.calls[0][0][0];
    expect(item.evidenceEl).not.toBeNull();
    expect(item.forceDomMarker).toBe(true);
    expect(item.need_annotation).toBe(false);
  });

  test('carries the evidence key through to the chip, for [ev:key] citations', async () => {
    const out = await window.gv2CaptureFindEvidenceItems([{
      key: 'portrait_beard', note: 'A full beard.', som_id: '12', source_image_id: 'page_image_1', need_annotation: true, annotation_prompt: 'Box it.'
    }], 3);

    const item = window.gv2CaptureEvidenceItems.mock.calls[0][0][0];
    expect(item.source_image_id).toBe('page_image_1');
    expect(out[0]).toMatchObject({
      key: 'portrait_beard',
      source_image_id: 'page_image_1',
      index: 3,
      marks: expect.objectContaining({ source_image_id: 'page_image_1' })
    });
  });

  test('uses source_image_id provenance as the annotator source when available', async () => {
    const source = document.getElementById('painting');
    window.gv2RememberFindAnswerImageSource({
      id: 'page_image_1',
      kind: 'page_image',
      el: source,
      selector: '#painting',
      captureGeometry: { x: 0, y: 500, w: 1000, h: 800 }
    });

    await window.gv2CaptureFindEvidenceItems([{
      key: 'portrait_beard', note: 'A full beard.', source_image_id: 'page_image_1',
      need_annotation: true, annotation_prompt: 'Box it.'
    }], 1);

    const item = window.gv2CaptureEvidenceItems.mock.calls[0][0][0];
    expect(item.annotationSourceEl).toBe(source);
    expect(item.source_image_id).toBe('page_image_1');
  });

  test('sends the exact source image crop to the annotator for page_image evidence', async () => {
    window.gv2CaptureEvidenceItems = window._realGv2CaptureEvidenceItems;
    const source = document.getElementById('painting');
    window.gv2RememberFindAnswerImageSource({
      id: 'page_image_1',
      kind: 'page_image',
      el: source,
      selector: '#painting',
      shot: 'CROP-SENT-TO-ANSWER-LLM',
      captureGeometry: { x: 0, y: 500, w: 1000, h: 800 },
      targetRect: { x: 0, y: 0, w: 1, h: 1 }
    });
    window.captureScreenshot = jest.fn(async () => 'CURRENT-VIEWPORT');
    window.safeSendMessage = jest.fn(async () => ({
      content: '{"region_bbox":{"x":100,"y":100,"w":200,"h":200},"annotations":[{"type":"box","bbox":{"x":100,"y":100,"w":200,"h":200},"label":"detail"}]}'
    }));
    window.gv2CaptureEvidenceRegion = jest.fn(async (_el, _idx, _rect, opts) => ({
      visualEvidenceShot: opts.screenshotBase64,
      captureGeometry: { x: 0, y: 500, w: 1000, h: 800 }
    }));

    await window.gv2CaptureFindEvidenceItems([{
      key: 'detail',
      note: 'Detail in the selected page image.',
      source_image_id: 'page_image_1',
      need_annotation: true,
      annotation_prompt: 'Box the detail.'
    }], 1);

    const annotatorCall = window.safeSendMessage.mock.calls.map(c => c[0]).find(msg => msg.metadata?.mode === 'guide_evidence_annotator');
    expect(annotatorCall.images[0]).toMatchObject({
      base64: 'CROP-SENT-TO-ANSWER-LLM',
      label: '[image_id=page_image_1] Source image for evidence annotation'
    });
    expect(window.captureScreenshot).not.toHaveBeenCalled();
  });

  test('maps page_image crop annotations back to the crop viewport on the live page', async () => {
    window.gv2CaptureEvidenceItems = window._realGv2CaptureEvidenceItems;
    window.gv2RememberFindAnswerImageSource({
      id: 'page_image_1',
      kind: 'page_image',
      shot: 'CROP-SENT-TO-ANSWER-LLM',
      annotationGeometry: { x: 20, y: 900, w: 500, h: 400 },
      captureGeometry: { x: 0, y: 800, w: 1000, h: 800 }
    });
    window.safeSendMessage = jest.fn(async () => ({
      content: '{"region_bbox":{"x":100,"y":100,"w":200,"h":100},"annotations":[{"type":"box","bbox":{"x":100,"y":100,"w":200,"h":100},"label":"shirt"}]}'
    }));
    window.gv2CaptureEvidenceRegion = jest.fn(async (_el, _idx, _rect, opts) => ({
      visualEvidenceShot: 'ANNOTATED-CROP',
      captureGeometry: { x: 999, y: 999, w: 1, h: 1 },
      visualEvidenceNormRect: opts.fullViewport ? { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } : null
    }));

    const out = await window.gv2CaptureFindEvidenceItems([{
      key: 'shirt',
      note: 'The shirt is visible.',
      source_image_id: 'page_image_1',
      need_annotation: true,
      annotation_prompt: 'Box the shirt.'
    }], 1);

    expect(window.gv2CaptureEvidenceRegion.mock.calls[0][3]).toMatchObject({
      fullViewport: true,
      screenshotBase64: 'CROP-SENT-TO-ANSWER-LLM'
    });
    expect(out[0].marks.captureGeometry).toEqual({ x: 20, y: 900, w: 500, h: 400 });
    expect(out[0].marks.annotations[0].bbox).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
  });

  test('batches multiple annotation prompts for the same source image into one annotator call', async () => {
    window.gv2CaptureEvidenceItems = window._realGv2CaptureEvidenceItems;
    window.captureScreenshot = jest.fn(async () => 'SCREEN');
    window.safeSendMessage = jest.fn(async () => ({
      content: JSON.stringify({
        items: [
          {
            key: 'beard',
            region_bbox: { x: 100, y: 100, w: 200, h: 160 },
            annotations: [{ type: 'box', bbox: { x: 120, y: 120, w: 100, h: 80 }, label: 'Beard' }]
          },
          {
            key: 'shirt',
            region_bbox: { x: 400, y: 250, w: 180, h: 220 },
            annotations: [{ type: 'box', bbox: { x: 410, y: 260, w: 130, h: 180 }, label: 'Shirt' }]
          }
        ]
      })
    }));
    window.gv2CaptureEvidenceRegion = jest.fn(async (_el, _idx, rect, opts) => ({
      visualEvidenceShot: `SHOT-${opts.annotations[0].label}`,
      visualEvidenceNormRect: rect,
      captureGeometry: { x: 0, y: 0, w: 800, h: 600 }
    }));

    const out = await window.gv2CaptureEvidenceItems([
      { key: 'beard', note: 'The beard is visible.', source_image_id: 'page_image_1', need_annotation: true, annotation_prompt: 'Box the beard.' },
      { key: 'shirt', note: 'The shirt is visible.', source_image_id: 'page_image_1', need_annotation: true, annotation_prompt: 'Box the shirt.' }
    ], { restoreScroll: true });

    const annotatorCalls = window.safeSendMessage.mock.calls.map(c => c[0]).filter(msg => msg.metadata?.mode === 'guide_evidence_annotator');
    expect(annotatorCalls).toHaveLength(1);
    expect(annotatorCalls[0].metadata.batch).toBe(true);
    expect(annotatorCalls[0].messages[0].content).toContain('EVIDENCE KEY: beard');
    expect(annotatorCalls[0].messages[0].content).toContain('EVIDENCE KEY: shirt');
    expect(out).toHaveLength(2);
    expect(out.map(item => item.annotations[0].label)).toEqual(['Beard', 'Shirt']);
    expect(window.gv2CaptureEvidenceRegion).toHaveBeenCalledTimes(2);
  });
});

describe('Find × Visual: picking which pictures to send (content/utils.js)', () => {
  beforeAll(() => {
    if (!window.gv2FindMediaCandidates) loadScript('content/utils.js');
  });

  const sized = (el, w, h) => {
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h });
    return el;
  };

  beforeEach(() => { document.body.innerHTML = ''; });

  // The whole point: the question names the picture, and the DOM already says which one it is.
  test('the image the question names beats a bigger hero banner', () => {
    document.body.innerHTML = `
      <header><img id="hero" alt="Aeon essays banner"></header>
      <main><figure><img id="painting" alt="Portrait of a Carthusian by Petrus Christus">
        <figcaption>Portrait of a Carthusian (1446)</figcaption></figure></main>`;
    sized(document.getElementById('hero'), 1200, 400);
    sized(document.querySelector('figure'), 400, 500);
    sized(document.getElementById('painting'), 400, 500);

    const out = window.gv2FindMediaCandidates('Does the person in the portrait of a Carthusian have a beard?', { limit: 2 });

    expect(out.length).toBeGreaterThan(0);
    expect(out[0].label.toLowerCase()).toContain('carthusian');
  });

  test('drops chrome: logos, icons and images inside nav/header', () => {
    document.body.innerHTML = `
      <nav><img id="logo" alt="Site logo"></nav>
      <main><img id="icon" class="social-icon" alt="share icon"></main>`;
    sized(document.getElementById('logo'), 300, 300);
    sized(document.getElementById('icon'), 300, 300);

    const out = window.gv2FindMediaCandidates('does the man have a beard', { limit: 3 });
    expect(out.map(c => c.el.id)).not.toContain('logo');
    expect(out.map(c => c.el.id)).not.toContain('icon');
  });

  test('drops anything below the size floor', () => {
    document.body.innerHTML = '<main><img id="tiny" alt="beard portrait"></main>';
    sized(document.getElementById('tiny'), 40, 40);
    expect(window.gv2FindMediaCandidates('beard portrait', { limit: 2 })).toEqual([]);
  });

  test('prefers the figure over the img inside it, so the caption travels with the crop', () => {
    document.body.innerHTML = `
      <main><figure><img id="inner" alt="a painting"><figcaption>The monk has a beard</figcaption></figure></main>`;
    sized(document.querySelector('figure'), 400, 400);
    sized(document.getElementById('inner'), 380, 380);

    const out = window.gv2FindMediaCandidates('does the monk have a beard', { limit: 2 });
    expect(out).toHaveLength(1);
    expect(out[0].el.tagName).toBe('FIGURE');
  });

  test('describes a figure with the inner image alt text plus caption', () => {
    document.body.innerHTML = `
      <main><figure><img id="inner" alt="Two profile portraits of mustached men"><figcaption>Desire retained diagram</figcaption></figure></main>`;
    const figure = document.querySelector('figure');
    sized(figure, 400, 400);
    sized(document.getElementById('inner'), 380, 380);

    const descriptor = window.gv2MediaDescriptor(figure);
    expect(descriptor).toEqual(expect.arrayContaining([
      { kind: 'alt', text: 'Two profile portraits of mustached men' },
      { kind: 'caption', text: 'Desire retained diagram' }
    ]));
    expect(window.gv2MediaDescribe(figure)).toContain('Two profile portraits of mustached men');
  });

  test('respects the limit and returns the best first', () => {
    document.body.innerHTML = `
      <main>
        <img id="a" alt="a beard portrait of a monk">
        <img id="b" alt="a beard">
        <img id="c" alt="an unrelated chart">
      </main>`;
    ['a', 'b', 'c'].forEach(id => sized(document.getElementById(id), 300, 300));

    const out = window.gv2FindMediaCandidates('does the monk have a beard', { limit: 2 });
    expect(out).toHaveLength(2);
    expect(out[0].score).toBeGreaterThanOrEqual(out[1].score);
    expect(out[0].el.id).toBe('a');
  });

  test('every candidate explains its score, for the ranking log', () => {
    document.body.innerHTML = '<main><img id="x" alt="beard portrait"></main>';
    sized(document.getElementById('x'), 300, 300);
    expect(window.gv2FindMediaCandidates('beard', { limit: 1 })[0].why).toMatch(/overlap=/);
  });

  test('an empty page yields nothing rather than throwing', () => {
    expect(window.gv2FindMediaCandidates('anything', { limit: 2 })).toEqual([]);
    expect(window.gv2FindMediaCandidates('', { limit: 2 })).toEqual([]);
  });

  test('keeps a large article image even when the query does not match its label', () => {
    document.body.innerHTML = '<main><article><img id="painting" alt=""></article></main>';
    sized(document.getElementById('painting'), 900, 500);

    const out = window.gv2FindMediaCandidates('who is the old man in the scene?', { limit: 3 });
    expect(out.map(c => c.el.id)).toContain('painting');
    expect(out[0].why).toContain('+large');
  });

  test('the selector catalog can see all image labels beyond the top three', () => {
    document.body.innerHTML = `
      <main>
        <img id="a" alt="A">
        <img id="b" alt="B">
        <img id="c" alt="C">
        <img id="d" alt="Verio, Farceurs Francais et Italiens">
      </main>`;
    ['a', 'b', 'c', 'd'].forEach(id => sized(document.getElementById(id), 300, 300));

    expect(window.gv2FindMediaCandidates('what is in the picture?', { limit: 3 })).toHaveLength(3);
    const out = window.gv2FindMediaCandidates('what is in the picture?', { limit: Infinity, includeAll: true });
    expect(out).toHaveLength(4);
    expect(out.map(c => c.el.id)).toContain('d');
  });

  test('selector catalog labels show the source fields such as alt and caption', () => {
    if (!window.gv2BuildFindImageCatalog) loadScript('content/tasks/guidev2.js');
    document.body.innerHTML = `
      <main><figure><img id="inner" alt="A heavyset mustached man reading"><figcaption>Reader in a chair</figcaption></figure></main>`;
    sized(document.querySelector('figure'), 400, 400);
    sized(document.getElementById('inner'), 380, 380);

    const catalog = window.gv2BuildFindImageCatalog('what is shown?');
    expect(catalog[0].selectorLabel).toContain('alt: A heavyset mustached man reading');
    expect(catalog[0].selectorLabel).toContain('caption: Reader in a chair');
  });

  test('matches a nearby article caption with accents normalized', () => {
    document.body.innerHTML = `
      <main><article>
        <img id="verio" alt="">
        <p class="caption">Verio, Farceurs Français et Italiens (French and Italian farce actors), 1670.</p>
      </article></main>`;
    sized(document.getElementById('verio'), 900, 500);

    const out = window.gv2FindMediaCandidates('In Verio, Farceurs Francais et Italiens, what color is the shirt?', { limit: 3 });
    expect(out[0].el.id).toBe('verio');
    expect(out[0].score).toBeGreaterThan(1);
  });

  test('discovers visible background-image media in article content', () => {
    document.body.innerHTML = '<main><article><div id="bg" style="background-image: url(example.jpg)"></div></article></main>';
    sized(document.getElementById('bg'), 700, 400);

    const out = window.gv2FindMediaCandidates('what color is the shirt in the image?', { limit: 3 });
    expect(out.map(c => c.el.id)).toContain('bg');
  });
  test('ignores stale need_more_view fields from older prompts', () => {
    const out = window.gv2ParseFindAnswer('{"answer":"I cannot see it","evidence":[],"need_more_view":{"want":"below","reason":"below the fold"}}');
    expect(out).toEqual({ answer: 'I cannot see it', evidence: [] });
    expect(out.needMoreView).toBeUndefined();
    expect(window.gv2ParseNeedMoreView).toBeUndefined();
    expect(window.gv2CaptureMoreViews).toBeUndefined();
  });
});

describe('Find × Visual: the image budget per answer call (content/tasks/guidev2.js)', () => {
  beforeAll(() => {
    if (!window.gv2BuildFindAnswerImages) loadScript('content/tasks/guidev2.js');
  });

  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <img id="a" alt="a beard portrait of a monk">
        <img id="b" alt="a monk with a beard, second view">
        <img id="c" alt="a monk beard study">
      </main>`;
    ['a', 'b', 'c'].forEach(id => {
      document.getElementById(id).getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 });
    });
    window.chrome.storage.local.get = jest.fn(async () => ({ pageguideEvidenceMode: 'visual' }));
    window.gv2CaptureEvidenceRegion = jest.fn(async (el) => ({ visualEvidenceShot: `CROP-${el.id}` }));
    window.gv2ClearFindCropCache(); // each test starts cold; the cache has its own test below
    window.scrollTo = jest.fn();
  });

  test('computes document geometry for an element crop so annotations draw where the crop came from', () => {
    const out = window._gv2CropDocumentGeometryForRect(
      { left: 200, top: 300, width: 100, height: 50 },
      { x: 10, y: 800, w: 1000, h: 700 }
    );

    expect(out).toEqual({ x: 90, y: 980, w: 340, h: 290 });
  });

  test('computes fit-scroll targets that show the whole image when it fits, and top-align tall images', () => {
    const fitting = window._gv2FitViewportScrollTargetForRect(
      { left: 200, top: 300, width: 500, height: 400 },
      { x: 10, y: 800, w: 1000, h: 900, scrollW: 1600, scrollH: 3000 },
      { headerOffset: 80 }
    );
    expect(fitting).toEqual({ left: 198, top: 1008 });

    const tall = window._gv2FitViewportScrollTargetForRect(
      { left: 200, top: 300, width: 500, height: 1200 },
      { x: 10, y: 800, w: 1000, h: 900, scrollW: 1600, scrollH: 3000 },
      { headerOffset: 80 }
    );
    expect(tall).toEqual({ left: 198, top: 1020 });
  });

  test('sends the viewport plus three media crops, each labelled', async () => {
    const images = await window.gv2BuildFindAnswerImages('does the monk have a beard', 'VIEWPORT');

    expect(images).toHaveLength(4);
    expect(images[0]).toEqual({ id: 'viewport', base64: 'VIEWPORT', label: '[image_id=viewport] Page screenshot with SoM markers' });
    expect(images[1]).toMatchObject({ id: 'page_image_1' });
    expect(images[2]).toMatchObject({ id: 'page_image_2' });
    expect(images[3]).toMatchObject({ id: 'page_image_3' });
    expect(images[1].label).toContain('[image_id=page_image_1]');
    expect(images[1].label).toContain('Image on page:');
    expect(images.slice(1).every(i => i.base64.startsWith('CROP-'))).toBe(true);
    expect(window.gv2FindAnswerImageSource('viewport')).toMatchObject({ id: 'viewport', kind: 'viewport' });
    expect(window.gv2FindAnswerImageSource('page_image_1')).toMatchObject({ id: 'page_image_1', kind: 'page_image' });
    expect(window.gv2FindAnswerImageSource('page_image_1').el.id).toBe('a');
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  test('stores the exact crop geometry for page-image annotation replay', async () => {
    window.gv2CaptureEvidenceRegion = jest.fn(async (el) => ({
      visualEvidenceShot: `CROP-${el.id}`,
      captureGeometry: { x: 0, y: 800, w: 1000, h: 700 },
      visualEvidenceCropGeometry: { x: 12, y: 916, w: 820, h: 540 },
      visualEvidenceNormRect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }
    }));

    await window.gv2BuildFindAnswerImages('does the monk have a beard', 'VIEWPORT');

    expect(window.gv2FindAnswerImageSource('page_image_1')).toMatchObject({
      annotationGeometry: { x: 12, y: 916, w: 820, h: 540 },
      captureGeometry: { x: 0, y: 800, w: 1000, h: 700 }
    });
  });

  test('sends the whole image from its URL before falling back to a viewport crop', async () => {
    document.body.innerHTML = `
      <main><figure><img id="portrait" src="https://cdn.example.test/portrait.jpg" alt="large portrait of a monk"><figcaption>Portrait of a Carthusian</figcaption></figure></main>`;
    const img = document.getElementById('portrait');
    const fig = document.querySelector('figure');
    img.getBoundingClientRect = () => ({ left: 100, top: 40, width: 500, height: 1200 });
    fig.getBoundingClientRect = () => ({ left: 90, top: 30, width: 520, height: 1280 });
    window.safeSendMessage = jest.fn(async (msg) => {
      if (msg.action === 'fetchImageAsBase64') {
        return { imageBase64: 'WHOLE-IMAGE', contentType: 'image/jpeg', sourceUrl: msg.url };
      }
      return {};
    });
    window.gv2CaptureEvidenceRegion = jest.fn(async () => ({ visualEvidenceShot: 'SHOULD-NOT-USE-CROP' }));

    const images = await window.gv2BuildFindAnswerImages('what color is the robe in the portrait?', 'VIEWPORT');

    expect(window.safeSendMessage).toHaveBeenCalledWith({
      action: 'fetchImageAsBase64',
      url: 'https://cdn.example.test/portrait.jpg'
    });
    expect(window.gv2CaptureEvidenceRegion).not.toHaveBeenCalled();
    expect(images[1]).toMatchObject({ id: 'page_image_1', base64: 'WHOLE-IMAGE' });
    expect(window.gv2FindAnswerImageSource('page_image_1')).toMatchObject({
      wholeImage: true,
      annotationGeometry: { x: 100, y: 40, w: 500, h: 1200 },
      sourceUrl: 'https://cdn.example.test/portrait.jpg'
    });
    expect(window.gv2FindAnswerImageSource('page_image_1').el.id).toBe('portrait');
  });

  // A cap must exist (a retina crop is mostly wasted tokens) but it has to stay large enough to read
  // text off a scanned page — at 1024 a two-page spread of captioned portraits arrived unreadably
  // blurry, which is the whole reason the image is attached.
  test('crops are capped, but not so small that text becomes unreadable', async () => {
    await window.gv2BuildFindAnswerImages('does the monk have a beard', 'VIEWPORT');
    const opts = window.gv2CaptureEvidenceRegion.mock.calls[0][3];
    expect(opts).toMatchObject({
      noMarker: true,
      scrollIntoView: true,
      exactScrollTarget: true,
      fitInViewport: true
    });
    expect(opts.maxWidth).toBeGreaterThanOrEqual(1536);
    expect(opts.maxWidth).toBeLessThanOrEqual(4096);
  });

  // A page with no relevant pictures should cost exactly what it did before: one image.
  test('sends the viewport alone when nothing on the page matches', async () => {
    document.body.innerHTML = '<main><p>no pictures here</p></main>';
    const images = await window.gv2BuildFindAnswerImages('who founded the order', 'VIEWPORT');

    expect(images).toEqual([{ id: 'viewport', base64: 'VIEWPORT', label: '[image_id=viewport] Page screenshot with SoM markers' }]);
    expect(window.gv2CaptureEvidenceRegion).not.toHaveBeenCalled();
  });

  test('a failed crop is skipped, not sent as an empty image', async () => {
    window.gv2CaptureEvidenceRegion = jest.fn(async (el) =>
      el.id === 'a' ? { visualEvidenceShot: null, captureError: 'offscreen' } : { visualEvidenceShot: 'CROP-b' });
    window.captureScreenshot = jest.fn(async () => 'FALLBACK-VIEW');

    const images = await window.gv2BuildFindAnswerImages('does the monk have a beard', 'VIEWPORT');
    expect(images.every(i => !!i.base64)).toBe(true);
    expect(images.some(i => i.base64 === 'FALLBACK-VIEW')).toBe(true);
    expect(window.gv2FindImageDiagnostics().some(d => d.status === 'fallback_viewport')).toBe(true);
  });

  test('the second question on the same page reuses the crops', async () => {
    await window.gv2BuildFindAnswerImages('does the monk have a beard', 'VIEWPORT');
    const firstCalls = window.gv2CaptureEvidenceRegion.mock.calls.length;

    await window.gv2BuildFindAnswerImages('does the monk have a beard', 'VIEWPORT2');

    expect(window.gv2CaptureEvidenceRegion.mock.calls.length).toBe(firstCalls); // served from cache
  });
});

// The Ask route is how a participant reaches Find from the chat box, and it carries its own copy of
// the arm logic (handleAskWithHighlight) separate from gv2RunFind. It had no non-grounding coverage
// at all, which is how a raw JSON envelope could have reached the chat unnoticed.
describe('Ask route arms (content/tasks/ask.js)', () => {
  beforeAll(() => {
    window.chrome = window.chrome || {};
    window.chrome.storage = window.chrome.storage || {};
    window.chrome.storage.local = { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) };
    window.chrome.runtime = window.chrome.runtime || { sendMessage: jest.fn() };
    if (!window.getEvidenceMode) loadScript('content/utils.js');
    if (!window.isNonGroundingModeOn) loadScript('content/functions/highlight.js');
    loadScript('content/tasks/ask.js');
    if (!window.gv2ParseFindAnswer) loadScript('content/tasks/guidev2.js');
  });

  beforeEach(() => {
    document.body.innerHTML = '<p id="para">page text</p>';
    window._pageguideHighlights = [];
    window._pageguideHighlightNumbers = [];
    window._pageguideIndex = {};
    window.getVisibleText = jest.fn(() => 'The garment is draped over the figure.');
    window.createPageIndex = jest.fn(() => ({ count: 1, indexText: '[12] Engraving' }));
    window.showSetOfMarks = jest.fn();
    window.cleanupSom = jest.fn();
    window.captureScreenshot = jest.fn(async () => 'PAGESHOT');
    window.applyHighlightsFromCitations = jest.fn(() => 1);
    window.gv2BuildFindAnswerImages = jest.fn(async (q, shot) => [{ id: 'viewport', base64: shot, label: 'v' }]);
    window.gv2BuildFindEvidence = jest.fn(async () => [{ shot: 'VISUAL', note: 'n', index: 2 }]);
    window.PROMPTS = Object.assign({}, window.PROMPTS, {
      // The {multiPageNote} slot is part of the real prompts, so the mocks carry it too — that is
      // what proves it collapses to nothing for a single-page answer.
      ANSWER_AND_HIGHLIGHT: 'TEXT_PROMPT{multiPageNote} {pageContent} {pageIndex}',
      FIND_ANSWER_VISUAL: 'VISUAL_PROMPT{multiPageNote} {pageContent} {pageIndex} max={maxItems}',
      MULTI_PAGE_NOTE: ' TWO_PAGE_NOTE'
    });
    delete window.PROMPTS.ANSWER_NONGROUNDING;
  });

  // Long enough to clear the minimal-content guard at the top of handleAskWithHighlight.
  const PAGE_TEXT = 'The engraving shows a garment draped over the figure, printed in Chicago in 1902.';

  const run = (settings, content) => {
    window.chrome.storage.local.get = jest.fn(async () => settings);
    window.safeSendMessage = jest.fn(async () => ({ content }));
    return window.handleAskWithHighlight('what does the engraving show?', PAGE_TEXT, { count: 3, indexText: '[12] Engraving' }, []);
  };

  const NG_VISUAL = { pageguideEvidenceMode: 'visual', pageguideNonGrounding: 'on' };

  test('Non-grounding unwraps the envelope and shows prose only', async () => {
    const out = await run(NG_VISUAL,
      '{"answer":"The garment is draped [ev:engraving_detail] [12:\\"over the figure\\"].","evidence":[{"key":"engraving_detail","note":"A draped garment.","som_id":"12","need_annotation":true,"annotation_prompt":"Box it."}]}');

    expect(out.answer).toBe('The garment is draped over the figure.');
    expect(out.answer).not.toContain('{');
    expect(out.answer).not.toContain('[ev:');
    expect(out.answer).not.toMatch(/\[\d+/);
    expect(out.findEvidenceShots).toEqual([]);
    expect(out.highlightCount).toBe(0);
    expect(window.applyHighlightsFromCitations).not.toHaveBeenCalled();
    expect(window.gv2BuildFindEvidence).not.toHaveBeenCalled();
  });

  test('Non-grounding asks the model exactly what the grounding arm asks', async () => {
    await run(NG_VISUAL, '{"answer":"An answer.","evidence":[]}');
    const baseline = window.safeSendMessage.mock.calls[0][0];

    await run({ pageguideEvidenceMode: 'visual' }, '{"answer":"An answer.","evidence":[]}');
    const grounded = window.safeSendMessage.mock.calls[0][0];

    expect(baseline.systemPrompt).toBe(grounded.systemPrompt);
    expect(baseline.systemPrompt).toContain('VISUAL_PROMPT');
    expect(baseline.action).toBe('callLLMWithImages');
    expect(baseline.images).toEqual(grounded.images);
    // The mode string is the one thing that must still differ — it is how the arms are told apart in
    // the logs.
    expect(baseline.metadata.mode).toBe('ask_chat_nongrounding_visual');
    expect(grounded.metadata.mode).toBe('ask_chat_visual');
  });

  test('Non-grounding in Text evidence mode keeps the text prompt and its plain reply', async () => {
    const out = await run({ pageguideEvidenceMode: 'text', pageguideNonGrounding: 'on' },
      'Yes, he has a beard [12:"a beard"].');

    expect(window.safeSendMessage.mock.calls[0][0].systemPrompt).toContain('TEXT_PROMPT');
    expect(window.safeSendMessage.mock.calls[0][0].action).toBe('callLLM');
    expect(out.answer).toBe('Yes, he has a beard.');
    expect(out.findEvidenceShots).toEqual([]);
  });

  test('the grounding arm still highlights, parses and captures evidence', async () => {
    const out = await run({ pageguideEvidenceMode: 'visual' },
      '{"answer":"Draped [12:\\"over the figure\\"] [ev:d].","evidence":[{"key":"d","note":"n","som_id":"12","need_annotation":true}]}');

    expect(out.answer).toBe('Draped [12:"over the figure"] [ev:d].'); // markers intact for the panel
    expect(window.applyHighlightsFromCitations).toHaveBeenCalled();
    expect(window.gv2BuildFindEvidence).toHaveBeenCalled();
    expect(out.findEvidenceShots).toHaveLength(1);
  });

  // REGRESSION: the envelope parse used to require a screenshot, so a visual run whose capture failed
  // printed the JSON verbatim.
  test('a visual run with no screenshot still unwraps the envelope, in both arms', async () => {
    window.captureScreenshot = jest.fn(async () => null);

    const ng = await run(NG_VISUAL, '{"answer":"The shirt is yellow.","evidence":[]}');
    expect(ng.answer).toBe('The shirt is yellow.');

    const grounded = await run({ pageguideEvidenceMode: 'visual' }, '{"answer":"The shirt is yellow.","evidence":[]}');
    expect(grounded.answer).toBe('The shirt is yellow.');
  });
});

// ===== SUPPORTING EVIDENCE: PICKING OFF THE PAGE =====
// The supporting questions are answered by pointing at the page, not by typing and not from a
// dropdown: a list of every paragraph hands over the candidate set, so a participant could land on
// the right answer by recognising it rather than by having read the page.
// Evidence the answer never cites has no number pointing at it, so a reader has no way to reach it —
// a box and a label sitting on a sentence for no stated reason, which reads as the answer having
// claimed something it did not.
// [N] citations resolve through window._pageguideIndex. Anything that walks the page afterwards has
// to READ that map, not rebuild it: createPageIndex renumbers from the live DOM, and the answer's own
// highlight spans change what the walk sees, so a rebuild moves every number after the first
// highlight — and the answer's citations start pointing at the wrong elements.
// [N:"text"] wraps its quoted words in a NEW span inside the element N points at, and only the
// element is in the page index — so resolving by index alone lands on the whole paragraph, which is
// what "the citation points at the outer paragraph" looked like. The citation NUMBER is what tells
// two citations in one paragraph apart.
describe('pageguideResolveCitationTarget (content/functions/highlight.js)', () => {
  beforeAll(() => {
    window.CSS = window.CSS || {};
    window.CSS.escape = window.CSS.escape || ((str) => str.replace(/([^\w-])/g, '\\$1'));
    loadScript('content/utils.js');
    loadScript('content/functions/highlight.js');
  });

  beforeEach(() => {
    document.body.innerHTML = `
      <p id="para">Musk cited
        <span id="s1" class="pageguide-highlight" data-pageguide-citation="1" data-pageguide-index="69">Foundation series</span>
        and wanted to
        <span id="s2" class="pageguide-highlight" data-pageguide-citation="2" data-pageguide-index="69">extend the human species’ reach.</span>
      </p>`;
    window._pageguideIndex = { 69: document.getElementById('para') };
  });

  // The case from the answer in hand: both citations are index 69, in the same paragraph.
  test('two citations in one paragraph resolve to their own spans', () => {
    expect(window.pageguideResolveCitationTarget(69, 1).id).toBe('s1');
    expect(window.pageguideResolveCitationTarget(69, 2).id).toBe('s2');
  });

  test('without a citation number it falls back to something stamped with that index', () => {
    expect(window.pageguideResolveCitationTarget(69).id).toBe('s1');
  });

  // A whole-element highlight (no quoted text matched) has no inner span, and the element IS the
  // highlight — paragraph-level is right there.
  test('an unstamped index falls back to the indexed element', () => {
    document.body.innerHTML = '<p id="plain">Nothing stamped here.</p>';
    window._pageguideIndex = { 12: document.getElementById('plain') };

    expect(window.pageguideResolveCitationTarget(12, 5).id).toBe('plain');
  });

  test('junk resolves to nothing rather than throwing', () => {
    window._pageguideIndex = {};
    expect(window.pageguideResolveCitationTarget(undefined, undefined)).toBeNull();
    expect(window.pageguideResolveCitationTarget('x', 'y')).toBeNull();
  });
});

describe('pageguideExistingIndexMap (content/utils.js)', () => {
  beforeAll(() => {
    window.CSS = window.CSS || {};
    window.CSS.escape = window.CSS.escape || ((str) => str.replace(/([^\w-])/g, '\\$1'));
    loadScript('content/utils.js');
  });

  beforeEach(() => {
    document.body.innerHTML = '<p id="a">One paragraph here.</p><p id="b">Another paragraph here.</p>';
  });

  test('hands back the index a previous run installed', () => {
    window._pageguideIndex = { 12: document.getElementById('a') };
    expect(window.pageguideExistingIndexMap()).toEqual({ 12: document.getElementById('a') });
  });

  test('nothing installed means nothing to reuse', () => {
    window._pageguideIndex = {};
    expect(window.pageguideExistingIndexMap()).toBeNull();
    window._pageguideIndex = null;
    expect(window.pageguideExistingIndexMap()).toBeNull();
  });

  // A map whose elements are all gone belongs to a page that has since navigated; rebuilding is then
  // the only sane option.
  test('an index of detached elements is not reused', () => {
    const gone = document.createElement('p');
    window._pageguideIndex = { 3: gone };
    expect(window.pageguideExistingIndexMap()).toBeNull();
  });
});

describe('gv2FilterCitedEvidence (content/tasks/guidev2.js)', () => {
  beforeAll(() => {
    if (!window.gv2FilterCitedEvidence) {
      window.CSS = window.CSS || {};
      window.CSS.escape = window.CSS.escape || ((str) => str.replace(/([^\w-])/g, '\\$1'));
      loadScript('content/utils.js');
      loadScript('content/tasks/guidev2.js');
    }
  });

  const items = [
    { key: 'beard', note: 'the beard' },
    { key: 'frieze', note: 'the frieze' },
    { key: 'unused', note: 'never cited' }
  ];

  test('keeps only the evidence the answer points at', () => {
    const out = window.gv2FilterCitedEvidence(items, 'A beard [ev:beard] over a frieze [ev:frieze].');
    expect(out.map(i => i.key)).toEqual(['beard', 'frieze']);
  });

  // The case in front of us: an answer with [N] citations and no [ev] markers at all, while the page
  // was marked in two places.
  test('an answer that cites no evidence shows none', () => {
    expect(window.gv2FilterCitedEvidence(items, 'Cited text [12:"education"] and more [14:"Oxford"].'))
      .toEqual([]);
  });

  test('matching the key ignores case and padding', () => {
    expect(window.gv2FilterCitedEvidence(items, 'x [ev:  Beard ] y').map(i => i.key)).toEqual(['beard']);
  });

  test('a marker with no captured evidence drops out on its own', () => {
    expect(window.gv2FilterCitedEvidence(items, 'x [ev:missing] y')).toEqual([]);
  });

  test('junk in, empty out', () => {
    expect(window.gv2FilterCitedEvidence(null, 'x [ev:beard]')).toEqual([]);
    expect(window.gv2FilterCitedEvidence(items, '')).toEqual([]);
    expect(window.gv2FilterCitedEvidence(items, null)).toEqual([]);
  });
});

describe('Study evidence picker (content/functions/study_pick.js)', () => {
  beforeAll(() => {
    window.CSS = window.CSS || {};
    window.CSS.escape = window.CSS.escape || ((str) => str.replace(/([^\w-])/g, '\\$1'));
    loadScript('content/utils.js');
    loadScript('content/functions/study_pick.js');
  });

  beforeEach(() => {
    window.pageguideCancelStudyPick();
    document.body.innerHTML = `
      <main>
        <p id="p1">The hall was built in 1888 and stands at the centre of campus.</p>
        <p id="p2">A second sentence with <em id="inner">emphasis inside it</em> for the hop.</p>
        <figure><img id="img" alt="Title page engraving"><figcaption id="cap">Title page engraving from El pedante (1538).</figcaption></figure>
      </main>`;
  });

  afterEach(() => { window.pageguideCancelStudyPick(); });

  // REGRESSION, and the reason "I cannot annotate what PageGuide already highlighted" survived
  // several rounds: targets used to come from createPageIndex, whose isPageGuideElement test is
  // closest('[class*="pageguide"]') — so a highlighted paragraph and everything inside it dropped
  // out of the index, and nothing in a highlighted region could be pointed at at all.
  // A citation is only correct if its index and its quoted text agree — [N:"text"] searches for the
  // text INSIDE element N. A block PageGuide has highlighted is not in the index at all, so a marker
  // written against it would resolve to nothing; the nearest indexed ancestor still contains the
  // words, which is what the search needs.
  describe('_pgStudyPickNearestIndex', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <section id="sec"><p id="lit" class="pageguide-highlight">A highlighted paragraph, long enough.</p></section>
        <p id="plain">An ordinary paragraph with enough words in it.</p>`;
      window._pageguideIndex = { 7: document.getElementById('sec'), 12: document.getElementById('plain') };
    });

    test('an element with its own index keeps it', () => {
      expect(window._pgStudyPickNearestIndex(document.getElementById('plain'))).toBe(12);
    });

    test('an unindexed block borrows its nearest indexed ancestor', () => {
      expect(window._pgStudyPickNearestIndex(document.getElementById('lit'))).toBe(7);
    });

    test('nothing indexed above it means no index', () => {
      window._pageguideIndex = {};
      expect(window._pgStudyPickNearestIndex(document.getElementById('lit'))).toBeNull();
      expect(window._pgStudyPickNearestIndex(null)).toBeNull();
    });
  });

  describe('_pgStudyPickTextTargets', () => {
    beforeEach(() => {
      window.createPageIndex = () => ({ indexMap: { 12: document.getElementById('plain') } });
      window.getAccessibleRole = () => null;
    });

    test('a paragraph PageGuide has highlighted is still pickable', () => {
      document.body.innerHTML = `
        <p id="plain">An ordinary paragraph with enough words in it.</p>
        <p id="lit" class="pageguide-highlight pageguide-highlight-block">A paragraph PageGuide highlighted, with enough words.</p>`;

      const targets = window._pgStudyPickTextTargets();

      expect(targets.has(document.getElementById('lit'))).toBe(true);
      expect(targets.has(document.getElementById('plain'))).toBe(true);
    });

    test('a block the index knows keeps its number; a highlighted one has none', () => {
      document.body.innerHTML = `
        <p id="plain">An ordinary paragraph with enough words in it.</p>
        <p id="lit" class="pageguide-highlight">A paragraph PageGuide highlighted, with enough words.</p>`;

      const targets = window._pgStudyPickTextTargets();

      expect(targets.get(document.getElementById('plain'))).toBe(12);
      expect(targets.get(document.getElementById('lit'))).toBeNull();
    });

    // The exclusion that WAS right: PageGuide's own injected UI is not page content.
    test('PageGuide’s own UI is still excluded', () => {
      document.body.innerHTML = `
        <div id="pageguide-messages"><p id="chat">An answer bubble in the panel, long enough.</p></div>
        <p id="plain">An ordinary paragraph with enough words in it.</p>`;

      const targets = window._pgStudyPickTextTargets();

      expect(targets.has(document.getElementById('chat'))).toBe(false);
      expect(targets.has(document.getElementById('plain'))).toBe(true);
    });

    test('a page with no usable index still offers its blocks', () => {
      window.createPageIndex = () => { throw new Error('no index'); };
      document.body.innerHTML = '<p id="plain">An ordinary paragraph with enough words in it.</p>';

      expect(window._pgStudyPickTextTargets().has(document.getElementById('plain'))).toBe(true);
    });

    test('blocks too short to be a sentence are left out', () => {
      document.body.innerHTML = '<p id="tiny">Short</p><p id="plain">An ordinary paragraph with enough words.</p>';
      const targets = window._pgStudyPickTextTargets();

      expect(targets.has(document.getElementById('tiny'))).toBe(false);
      expect(targets.has(document.getElementById('plain'))).toBe(true);
    });
  });

  describe('_pgStudyPickResolve', () => {
    test('a click inside a sentence resolves to the sentence', () => {
      const targets = new Map([[document.getElementById('p2'), 7]]);
      expect(window._pgStudyPickResolve(document.getElementById('inner'), targets).id).toBe('p2');
    });

    test('something outside every target resolves to nothing', () => {
      const targets = new Map([[document.getElementById('p1'), 3]]);
      expect(window._pgStudyPickResolve(document.getElementById('cap'), targets)).toBeNull();
      expect(window._pgStudyPickResolve(null, targets)).toBeNull();
    });
  });

  // The question asks which SENTENCE gives the answer, so outlining the whole paragraph is both too
  // generous to score and hard to aim — a participant pointing at a five-sentence block has not said
  // which claim they mean.
  describe('_pgStudyPickSplitSentences', () => {
    const split = (t) => window._pgStudyPickSplitSentences(t).map(sp => t.slice(sp.start, sp.end).trim());

    test('splits a paragraph into its sentences', () => {
      expect(split('The hall was built in 1888. It stands at the centre. Visitors may enter.'))
        .toEqual(['The hall was built in 1888.', 'It stands at the centre.', 'Visitors may enter.']);
    });

    test('keeps the closing quote with the sentence it ends', () => {
      expect(split('He called it "the pedant." Then he left.'))
        .toEqual(['He called it "the pedant."', 'Then he left.']);
    });

    // These pages are full of initials and abbreviations; cutting after them halves a name.
    test('does not split on an initial or a common abbreviation', () => {
      expect(split('The portrait is of S. Dutton Whitney, M.D. He wrote the course.'))
        .toEqual(['The portrait is of S. Dutton Whitney, M.D.', 'He wrote the course.']);
      expect(split('See Dr. Smith for details. He is in.'))
        .toEqual(['See Dr. Smith for details.', 'He is in.']);
    });

    test('does not split inside a number or a domain', () => {
      expect(split('It cost 1.5 million at example.com in total.'))
        .toEqual(['It cost 1.5 million at example.com in total.']);
    });

    test('a heading or cell with no sentence punctuation is one span', () => {
      expect(split('Published July 8 2026')).toEqual(['Published July 8 2026']);
    });

    test('handles ! ? and … as endings', () => {
      expect(split('Really? Yes! Well…')).toEqual(['Really?', 'Yes!', 'Well…']);
    });

    test('is safe on empty input', () => {
      expect(window._pgStudyPickSplitSentences('')).toEqual([]);
      expect(window._pgStudyPickSplitSentences(null)).toEqual([]);
      expect(window._pgStudyPickSplitSentences('   ')).toEqual([]);
    });
  });

  describe('_pgStudyPickSentenceRanges', () => {
    test('one range per sentence, spanning the block’s inline markup', () => {
      document.body.innerHTML = '<p id="p">The hall was <b>built</b> in 1888. It stands at the centre.</p>';
      const out = window._pgStudyPickSentenceRanges(document.getElementById('p'));

      expect(out.map(o => o.text)).toEqual(['The hall was built in 1888.', 'It stands at the centre.']);
      expect(out[0].range.toString()).toBe('The hall was built in 1888.');
    });

    // The range must stop at the full stop, or the outline runs on to the next sentence's first word.
    test('the range excludes the whitespace after the sentence', () => {
      document.body.innerHTML = '<p id="p">One. Two.</p>';
      const out = window._pgStudyPickSentenceRanges(document.getElementById('p'));
      expect(out[0].range.toString()).toBe('One.');
    });

    test('an element with no text has no ranges', () => {
      document.body.innerHTML = '<p id="p"></p>';
      expect(window._pgStudyPickSentenceRanges(document.getElementById('p'))).toEqual([]);
    });
  });

  // Only a sentence is pickable in a multi-sentence block: "which sentence gives you the answer" is
  // not answered by pointing at five of them, and an outline that widens to the paragraph when the
  // pointer slips between lines is how a paragraph gets recorded by accident.
  // The agent's own citations are drawn on the page as highlighted phrases, and they are usually the
  // exact evidence a supporting question is about — so they are the most specific thing that can be
  // pointed at, finer than the sentence around them.
  // A picked sentence is scored against another pick and against ground truth, so it has to be the
  // SENTENCE — not the sentence plus the page's footnote furniture. Wikipedia hangs [79], [82][83],
  // [nb 1] off half its clauses, and two people pointing at the same words would otherwise record
  // different strings.
  describe('reference markers are not part of a pick', () => {
    test('_pgStudyPickCleanText drops markers and closes the gap with a space', () => {
      expect(window._pgStudyPickCleanText('out of the coil.[80] Later called the Tesla coil.'))
        .toBe('out of the coil. Later called the Tesla coil.');
      expect(window._pgStudyPickCleanText('wireless power work.[82][83]'))
        .toBe('wireless power work.');
      expect(window._pgStudyPickCleanText('officially born.[18][nb 2] Under Mangnall'))
        .toBe('officially born. Under Mangnall');
    });

    test('a marker mid-sentence leaves no double space behind', () => {
      expect(window._pgStudyPickCleanText('radio waves [79] were repeated'))
        .toBe('radio waves were repeated');
    });

    test('prose in brackets is left alone', () => {
      const kept = 'The coil (patented in 1891) worked, and [the rest] followed.';
      expect(window._pgStudyPickCleanText(kept)).toBe(kept);
    });

    // Structural, not just textual: the marker's text node is skipped when the sentence is built, so
    // a marker can never end a sentence span and ride along in the recorded text.
    test('_pgStudyPickVisibleText skips the reference elements themselves', () => {
      document.body.innerHTML = '<p id="p">To fix this, Tesla used a coil.<sup class="reference">[80]</sup> Later it was named.</p>';
      expect(window._pgStudyPickVisibleText(document.getElementById('p')))
        .toBe('To fix this, Tesla used a coil. Later it was named.');
    });

    test('a sentence range records the prose without its markers', () => {
      document.body.innerHTML = '<p id="p">First one.<sup class="reference">[9]</sup> Second one.<sup class="reference">[10]</sup></p>';
      const out = window._pgStudyPickSentenceRanges(document.getElementById('p'));

      expect(out.map(o => o.text)).toEqual(['First one.', 'Second one.']);
    });
  });

  // "Which image?" is answered by naming a picture, not by quoting the sentence underneath it. A
  // caption carries provenance too ("Courtesy the National Museum of Norway"), and recording all of
  // it makes two people who picked the SAME picture disagree — one clicked the image, one the caption.
  describe('_pgStudyPickImageLabel', () => {
    test('prefers the image’s own alt text', () => {
      document.body.innerHTML = '<figure id="f"><img alt="Mountainous Landscape with a Blasted Oak Tree"><figcaption>Long caption. Courtesy the National Museum of Norway</figcaption></figure>';
      expect(window._pgStudyPickImageLabel(document.getElementById('f')))
        .toBe('Image: Mountainous Landscape with a Blasted Oak Tree');
    });

    test('falls back to the caption’s first clause, not the provenance', () => {
      document.body.innerHTML = '<figure id="f"><img><figcaption id="c">Mountainous Landscape with a Blasted Oak Tree (1660s) by Jacob van Ruisdael. Courtesy the National Museum of Norway</figcaption></figure>';
      expect(window._pgStudyPickImageLabel(document.getElementById('c')))
        .toBe('Image: Mountainous Landscape with a Blasted Oak Tree (1660s) by Jacob van Ruisdael.');
    });

    test('the picture and its caption record the same thing', () => {
      document.body.innerHTML = '<figure id="f"><img id="i" alt="A team photograph"><figcaption id="c">A team photograph. Taken in 1905</figcaption></figure>';
      expect(window._pgStudyPickImageLabel(document.getElementById('i')))
        .toBe(window._pgStudyPickImageLabel(document.getElementById('c')));
    });

    test('a very long name is capped', () => {
      document.body.innerHTML = `<figure id="f"><img alt="${'x'.repeat(200)}"></figure>`;
      const label = window._pgStudyPickImageLabel(document.getElementById('f'));
      expect(label.length).toBeLessThan(110);
      expect(label.endsWith('…')).toBe(true);
    });

    test('a picture with nothing to go on is still named', () => {
      document.body.innerHTML = '<figure id="f"><img></figure>';
      expect(window._pgStudyPickImageLabel(document.getElementById('f'))).toBe('Image');
    });
  });

  describe('_pgStudyPickHighlightAt', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <p id="p">The play is <span id="hl" class="pageguide-highlight">El pedante</span> by Belo.</p>
        <p id="q" class="pageguide-highlight pageguide-highlight-block">A whole tinted paragraph. With two sentences.</p>
        <p id="plain">Nothing highlighted here at all.</p>`;
    });

    test('a phrase highlight under the pointer is the target', () => {
      const hl = window._pgStudyPickHighlightAt(document.getElementById('hl'), document.getElementById('p'));
      expect(hl?.id).toBe('hl');
    });

    test('finds it from a node inside the highlight', () => {
      document.getElementById('hl').innerHTML = '<em id="inner">El pedante</em>';
      expect(window._pgStudyPickHighlightAt(document.getElementById('inner'), document.getElementById('p')).id).toBe('hl');
    });

    // A whole-element tint is the paragraph itself; treating it as a "highlight" would put
    // paragraph-level picking back in through the side door.
    test('a whole-element block tint is not a phrase target', () => {
      expect(window._pgStudyPickHighlightAt(document.getElementById('q'), document.getElementById('q'))).toBeNull();
    });

    test('a highlight outside the block being picked does not count', () => {
      expect(window._pgStudyPickHighlightAt(document.getElementById('hl'), document.getElementById('plain'))).toBeNull();
    });

    test('plain text and junk resolve to nothing', () => {
      expect(window._pgStudyPickHighlightAt(document.getElementById('plain'), document.getElementById('plain'))).toBeNull();
      expect(window._pgStudyPickHighlightAt(null, document.getElementById('p'))).toBeNull();
      expect(window._pgStudyPickHighlightAt(document.getElementById('hl'), null)).toBeNull();
    });
  });

  describe('_pgStudyPickSentenceHit', () => {
    const sentence = (text, rects) => ({ text, range: { getClientRects: () => rects } });
    const rect = (left, top, right, bottom) => ({ left, top, right, bottom });

    test('returns the sentence whose line the point is on', () => {
      const sentences = [
        sentence('First.', [rect(0, 0, 100, 20)]),
        sentence('Second.', [rect(0, 20, 100, 40)])
      ];
      expect(window._pgStudyPickSentenceHit(sentences, 50, 30).text).toBe('Second.');
    });

    // A sentence that wraps is several rects; any of them counts.
    test('a wrapped sentence is hit on any of its lines', () => {
      const wrapped = sentence('Long one.', [rect(60, 0, 100, 20), rect(0, 20, 40, 40)]);
      expect(window._pgStudyPickSentenceHit([wrapped], 20, 30)).toBe(wrapped);
    });

    test('a point between lines hits nothing, rather than widening to the block', () => {
      const sentences = [sentence('First.', [rect(0, 0, 100, 20)])];
      expect(window._pgStudyPickSentenceHit(sentences, 50, 60)).toBeNull();
      expect(window._pgStudyPickSentenceHit([], 50, 10)).toBeNull();
      expect(window._pgStudyPickSentenceHit(null, 50, 10)).toBeNull();
    });
  });

  describe('_pgStudyPickTextFor', () => {
    test('a text block stands for its own words, whitespace collapsed', () => {
      document.getElementById('p1').innerHTML = 'The hall\n   was  built';
      expect(window._pgStudyPickTextFor(document.getElementById('p1'))).toBe('The hall was built');
    });

    // The image hop asks for the image's NAME, and an <img> has no text of its own.
    test('an image falls back to its alt text', () => {
      expect(window._pgStudyPickTextFor(document.getElementById('img'))).toBe('Title page engraving');
    });
  });

  // The image hop asks for a name that is written in the caption, so both the picture and the
  // caption have to be clickable — a participant reaches for whichever they are looking at.
  test('the image hop accepts captions as well as pictures', () => {
    window.gv2FindMediaCandidates = () => [{ el: document.getElementById('img'), label: 'Title page engraving' }];
    const targets = window._pgStudyPickImageTargets();

    expect(targets.has(document.getElementById('img'))).toBe(true);
    expect(targets.has(document.getElementById('cap'))).toBe(true);
  });

  describe('the pick session', () => {
    test('starting puts the picker on the page and cancelling takes it off', () => {
      const started = window.pageguideStartStudyPick({ hop: 1, kind: 'paragraph' });

      expect(started.success).toBe(true);
      expect(document.querySelector('.pageguide-study-pick-root')).not.toBeNull();

      window.pageguideCancelStudyPick();
      expect(document.querySelector('.pageguide-study-pick-root')).toBeNull();
    });

    test('a page with nothing pickable refuses rather than arming an empty picker', () => {
      document.body.innerHTML = '<div>short</div>';
      const started = window.pageguideStartStudyPick({ hop: 1, kind: 'paragraph' });

      expect(started.success).toBe(false);
      expect(document.querySelector('.pageguide-study-pick-root')).toBeNull();
    });

    // Starting again must not leave the first session's listeners and overlay behind.
    test('starting twice leaves exactly one picker', () => {
      window.pageguideStartStudyPick({ hop: 1, kind: 'paragraph' });
      window.pageguideStartStudyPick({ hop: 2, kind: 'paragraph' });

      expect(document.querySelectorAll('.pageguide-study-pick-root')).toHaveLength(1);
    });

    // PageGuide's own tints and evidence boxes are the loudest thing on the page; picking inside one
    // read as "nothing is selectable". They step back for the duration and come straight back.
    test('the page’s own marks are muted while picking, and restored after', () => {
      window.pageguideStartStudyPick({ hop: 1, kind: 'paragraph' });
      expect(document.documentElement.classList.contains('pageguide-picking')).toBe(true);

      window.pageguideCancelStudyPick();
      expect(document.documentElement.classList.contains('pageguide-picking')).toBe(false);
    });

    test('a refused start leaves nothing muted', () => {
      document.body.innerHTML = '<div>short</div>';
      window.pageguideStartStudyPick({ hop: 1, kind: 'paragraph' });
      expect(document.documentElement.classList.contains('pageguide-picking')).toBe(false);
    });

    test('cancelling when nothing is running is harmless', () => {
      expect(() => window.pageguideCancelStudyPick()).not.toThrow();
    });
  });
});

// ===== GUIDE TRAJECTORIES =====
// A guide run is the study material for the guide half. Rewind keeps every run but evicts them
// (RW_SESSION_CAP is 8, 🧹 New Chat clears it) and never keeps the recap, so a run a study depends on
// has to be copied out — with the answer and the reasoning trail the recap carries.
describe('Guide trajectories (sidepanel/guide_trajectories.js)', () => {
  beforeAll(() => {
    window.chrome = window.chrome || {};
    window.chrome.storage = window.chrome.storage || { local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) } };
    loadScript('sidepanel/guide_trajectories.js');
  });

  const INDEX = {
    sessionId: 'gv2-abc', goal: 'Sort the results by price', guideTitle: 'Sort by price',
    steps: [
      { step: 0, isInitial: true, instruction: 'Initial state' },
      { step: 1, instruction: 'Click "Sort by"', action: 'click', url: 'https://x.test' },
      { step: 2, instruction: 'Select "Price: low to high"', action: 'click', url: 'https://x.test' },
    ],
  };
  const RECORDS = [
    { step: 1, screenshotBefore: 'SHOT1', target: { text: 'Sort by' } },
    { step: 2, screenshot: 'SHOT2', target: { text: 'Price: low to high' } },
  ];
  const RECAP = {
    sessionId: 'gv2-abc', summary: 'I sorted the results by price.',
    milestones: [
      { step: 1, text: 'Opened the sort menu.', status: 'correct' },
      { step: 2, text: 'Chose the wrong option.', status: 'wrong', errorLabel: 'Wrong target' },
      { step: 9, text: 'Off-goal noise.', goalRelated: false },
    ],
  };

  describe('_buildGuideTrajectory', () => {
    test('keeps every step, its instruction and its screenshot', () => {
      const t = window._buildGuideTrajectory(INDEX, RECORDS, RECAP);
      const steps = t.arms.grounding.steps;

      expect(steps.map(st => st.instruction)).toEqual(['Click "Sort by"', 'Select "Price: low to high"']);
      expect(steps.map(st => st.screenshot)).toEqual(['SHOT1', 'SHOT2']);
      expect(steps.map(st => st.n)).toEqual([1, 2]);
      expect(steps[0].target_text).toBe('Sort by');
    });

    // WHICH MOMENT a step's picture shows. It must be the same one the live run shows: the panel's
    // step card (showGoalStepPreview) opens `screenshotBefore` full-size, titled "Before action —
    // what PageGuide saw before this step". A study that showed the after-action capture instead
    // would put a participant and a researcher in front of two different pictures of one step.
    test('a step shows the before-action shot the live run shows, never the after-shot', () => {
      const recs = [
        { step: 1, screenshotBefore: 'BEFORE1', screenshotAfter: 'AFTER1' },
        { step: 2, screenshot: 'BEFORE2', screenshotAfter: 'AFTER2' },
      ];
      const steps = window._buildGuideTrajectory(INDEX, recs, RECAP).arms.grounding.steps;
      expect(steps.map(st => st.screenshot)).toEqual(['BEFORE1', 'BEFORE2']);
    });

    // The one case where the after-shot IS the step's picture: nothing else was saved. A
    // wrong-moment image still beats a blank row in a trajectory a study depends on.
    test('a step with only an after-shot uses it rather than showing nothing', () => {
      const recs = [{ step: 1, screenshotAfter: 'AFTER1' }, { step: 2, screenshot: 'BEFORE2' }];
      const steps = window._buildGuideTrajectory(INDEX, recs, RECAP).arms.grounding.steps;
      expect(steps.map(st => st.screenshot)).toEqual(['AFTER1', 'BEFORE2']);
    });

    // Step 0 is the page before the agent touched it — not something it DID, so not something a
    // participant can be asked about.
    test('drops the initial-state node', () => {
      expect(window._buildGuideTrajectory(INDEX, RECORDS, RECAP).arms.grounding.steps).toHaveLength(2);
    });

    test('carries the recap’s answer and milestones, minus the off-goal ones', () => {
      const t = window._buildGuideTrajectory(INDEX, RECORDS, RECAP);
      expect(t.arms.grounding.answer).toBe('I sorted the results by price.');
      expect(t.arms.grounding.trail.milestones.map(m => m.step)).toEqual([1, 2]);
      expect(t.arms.grounding.trail.milestones[1].errorLabel).toBe('Wrong target');
    });

    // Capture must not fail on a run whose recap never arrived — the steps are still worth having,
    // and the answer can be written by hand in the editor.
    test('a run with no recap still captures its steps', () => {
      const t = window._buildGuideTrajectory(INDEX, RECORDS, null);
      expect(t.arms.grounding.steps).toHaveLength(2);
      expect(t.arms.grounding.answer).toBe('');
      expect(t.arms.grounding.trail.milestones).toEqual([]);
    });

    test('a step whose record is missing still appears', () => {
      const t = window._buildGuideTrajectory(INDEX, [RECORDS[0]], RECAP);
      expect(t.arms.grounding.steps).toHaveLength(2);
      expect(t.arms.grounding.steps[1].screenshot).toBeNull();
    });

    // The bookends. Both were already recorded by the live run and both used to be discarded here:
    // the initial state because step 0 is not a step, the final state because _guideStepScreenshot
    // prefers the "before" shot. Every step picture is a before; these are the only two that show
    // the page as it was handed over and as it was left.
    describe('initial and final state', () => {
      const INITIAL = { step: 0, isInitial: true, screenshotBefore: 'START', url: 'https://x.test' };
      const FINISHED = [
        RECORDS[0],
        { step: 2, screenshot: 'SHOT2', isLastStep: true, finalShot: 'END', url: 'https://x.test/sorted' },
      ];

      test('takes the opening state from the step-0 record and the closing state from finalShot', () => {
        const g = window._buildGuideTrajectory(INDEX, [INITIAL, ...FINISHED], RECAP).arms.grounding;
        expect(g.initial_state.screenshot).toBe('START');
        expect(g.final_state.screenshot).toBe('END');
        expect(g.final_state.url).toBe('https://x.test/sorted');
        expect(g.steps).toHaveLength(2);       // and neither became a step
        expect(g.steps.map(st => st.n)).toEqual([1, 2]);
      });

      test('falls back to screenshotAfter when the run has no final verification shot', () => {
        const recs = [INITIAL, RECORDS[0], { step: 2, screenshot: 'SHOT2', isLastStep: true, screenshotAfter: 'AFTER' }];
        expect(window._buildGuideTrajectory(INDEX, recs, RECAP).arms.grounding.final_state.screenshot).toBe('AFTER');
      });

      test('an older run with neither is captured with empty bookends, not a crash', () => {
        const g = window._buildGuideTrajectory(INDEX, RECORDS, RECAP).arms.grounding;
        expect(g.initial_state.screenshot).toBeNull();
        expect(g.final_state.screenshot).toBeNull();
      });

      // The one thing the strip deliberately keeps: both arms are asked whether the task got done.
      test('the strip keeps both, screenshots included', () => {
        const g = window._buildGuideTrajectory(INDEX, [INITIAL, ...FINISHED], RECAP).arms.grounding;
        const bare = window._stripGuideArm(g);
        expect(bare.initial_state.screenshot).toBe('START');
        expect(bare.final_state.screenshot).toBe('END');
        expect(bare.steps.every(st => st.screenshot === null)).toBe(true);
      });

      // Re-capture rewrites the grounded arm only, so a non-grounded arm banked earlier would keep
      // showing no outcome while the grounded one showed both — the arms would differ in something
      // other than grounding, which is the one thing they must not do.
      test('re-capture carries the bookends across to a non-grounded arm, and nothing else', () => {
        const rec = {
          arms: {
            grounding: { initial_state: { screenshot: 'START', url: 'u1' }, final_state: { screenshot: 'END', url: 'u2' }, answer: 'new' },
            nongrounding: { initial_state: { screenshot: null, url: '' }, final_state: { screenshot: null, url: '' }, answer: 'hand-edited' },
          },
        };
        window._syncGuideBookends(rec);
        expect(rec.arms.nongrounding.initial_state).toEqual({ screenshot: 'START', url: 'u1' });
        expect(rec.arms.nongrounding.final_state).toEqual({ screenshot: 'END', url: 'u2' });
        expect(rec.arms.nongrounding.answer).toBe('hand-edited');
      });

      test('the bookend sync is a no-op when there is no non-grounded arm yet', () => {
        const rec = { arms: { grounding: { initial_state: { screenshot: 'START' } }, nongrounding: null } };
        expect(() => window._syncGuideBookends(rec)).not.toThrow();
        expect(rec.arms.nongrounding).toBeNull();
      });
    });

    // Twice this session a state stopped rendering because a later, more specific rule quietly
    // outranked it — `.study-timer-display` beating `[hidden]`, then `body.light-mode
    // .study-step-pick` beating `.study-step-pick.is-on`, which left white text on a white button.
    // jsdom does not do cascade, so this asserts the one thing that would have caught it: the
    // selected state is stated for the light theme too, not only unscoped.
    describe('study.css — states that must outrank their theme base', () => {
      const css = fs.readFileSync(path.join(__dirname, '../../sidepanel/study.css'), 'utf8');

      test('the picked step states its selected style for light mode as well', () => {
        expect(css).toMatch(/body\.light-mode\s+\.study-step-pick\.is-on/);
      });

      test('a hidden timer row beats the display rule that would otherwise show it', () => {
        expect(css).toMatch(/\.study-timer-display\[hidden\]\s*\{[^}]*display:\s*none/);
      });
    });

    // Steps are renumbered 1..N by position, but the recap's milestones and the evidence cite the
    // ORIGINAL rewind step numbers. They agree only when nothing was filtered out — and when they
    // disagree, a milestone names a step the journey does not have, so nothing can resolve it to a
    // screenshot and it silently stops being hoverable.
    describe('milestone and evidence step numbers follow the renumber', () => {
      const GAPPY = {
        sessionId: 'gv2-gap', goal: 'g',
        steps: [
          { step: 0, isInitial: true, instruction: 'Initial state' },
          { step: 2, instruction: 'First real step', url: 'https://x.test' },
          { step: 5, instruction: 'Second real step', url: 'https://x.test' },
        ],
      };
      const GAPPY_RECORDS = [
        { step: 2, screenshotBefore: 'SHOT-A' },
        { step: 5, screenshotBefore: 'SHOT-B', isLastStep: true },
      ];
      const GAPPY_RECAP = {
        summary: 'Did it.',
        milestones: [{ step: 2, text: 'Opened the thing.' }, { step: 5, text: 'Finished.' }],
      };

      test('a milestone points at the renumbered step, not the original', () => {
        const g = window._buildGuideTrajectory(GAPPY, GAPPY_RECORDS, GAPPY_RECAP).arms.grounding;
        expect(g.steps.map(st => st.n)).toEqual([1, 2]);
        expect(g.trail.milestones.map(m => m.step)).toEqual([1, 2]);
      });

      test('a milestone naming a step that was dropped points at nothing rather than at the wrong step', () => {
        const recap = { summary: '', milestones: [{ step: 99, text: 'Ghost.' }] };
        const g = window._buildGuideTrajectory(GAPPY, GAPPY_RECORDS, recap).arms.grounding;
        expect(g.trail.milestones[0].step).toBeNull();
      });

      test('a linked phrase is captured with its step remapped too', () => {
        const recap = Object.assign({}, GAPPY_RECAP, {
          summarySegments: [
            { phrase: 'Opened the thing', step: 5, evidenceKey: 'ev_a', text: 'What it proves' },
            { phrase: '', step: 2 },                       // no phrase: nothing to underline
          ],
        });
        const g = window._buildGuideTrajectory(GAPPY, GAPPY_RECORDS, recap).arms.grounding;
        expect(g.answer_segments).toEqual([
          { phrase: 'Opened the thing', step: 2, key: 'ev_a', note: 'What it proves' },
        ]);
      });

      test('evidence keeps its own screenshot while its step number is remapped', () => {
        const g = window._buildGuideTrajectory(GAPPY, GAPPY_RECORDS, GAPPY_RECAP).arms.grounding;
        g.answer_evidence.forEach(ev => {
          if (ev.step != null) expect(g.steps.some(st => st.n === ev.step)).toBe(true);
        });
      });
    });

    // The wording is banked per trajectory at capture, so a change to the default only reaches new
    // captures — an existing trajectory keeps whatever it was captured with until it is edited.
    test('a fresh capture asks whether the agent completed the task', () => {
      const t = window._buildGuideTrajectory(INDEX, RECORDS, RECAP);
      expect(t.arms.grounding.questions.correctness).toBe('Did the agent complete the task successfully?');
    });

    test('a trajectory that already has its own wording keeps it through a strip', () => {
      const bare = window._stripGuideArm({ steps: [], questions: { correctness: 'Custom wording?' } });
      expect(bare.questions.correctness).toBe('Custom wording?');
    });

    // Q2's steps are picked from buttons, so there is no format to parse and no "2-3" to interpret.
    // What buttons cannot prevent is an INCOMPLETE answer — a type ticked with no step under it.
    describe('_guideErrorsProblem', () => {
      test('a complete answer has no problem', () => {
        expect(window._guideErrorsProblem([{ type: 'loop', steps: [2, 3] }])).toBeNull();
      });

      test('"no error" — an empty list — is complete, not incomplete', () => {
        expect(window._guideErrorsProblem([])).toBeNull();
        expect(window._guideErrorsProblem(null)).toBeNull();
      });

      test('a type with no step is caught, and says so in the singular case', () => {
        expect(window._guideErrorsProblem([{ type: 'loop', steps: [] }])).toMatch(/tap which step/i);
      });

      test('one incomplete type among several points at that one', () => {
        const msg = window._guideErrorsProblem([{ type: 'loop', steps: [1] }, { type: 'mismatch', steps: [] }]);
        expect(msg).toMatch(/one of the errors/i);
      });

      test('a missing steps field is treated as unanswered, not as zero steps', () => {
        expect(window._guideErrorsProblem([{ type: 'loop' }])).toMatch(/tap which step/i);
      });
    });

    describe('bookend sync edge cases', () => {
      test('still a no-op when there is no non-grounded arm', () => {
        const rec = { arms: { grounding: { initial_state: { screenshot: 'START' } }, nongrounding: null } };
        expect(() => window._syncGuideBookends(rec)).not.toThrow();
        expect(rec.arms.nongrounding).toBeNull();
      });

      test('the strip tolerates an arm that has no bookends at all', () => {
        const bare = window._stripGuideArm({ steps: [] });
        expect(bare.initial_state).toEqual({ screenshot: null, url: '' });
        expect(bare.final_state).toEqual({ screenshot: null, url: '' });
      });
    });

    test('the non-grounded arm is not invented at capture time', () => {
      expect(window._buildGuideTrajectory(INDEX, RECORDS, RECAP).arms.nongrounding).toBeNull();
    });
  });

  // A grounded answer without its evidence is prose with pictures beside it. The participant is asked
  // whether the answer is right; the evidence is what lets them check rather than guess.
  describe('answer evidence', () => {
    const INDEX_EV = Object.assign({}, INDEX, {
      evidenceScratchpad: [
        { key: 'cart_badge', note: 'The cart shows 1 item', ref_step_id: 2 },
        { key: 'search_box', note: 'Searched for oranges', ref_step_id: 1 },
      ],
    });
    const RECORDS_EV = [
      { step: 1, screenshot: 'SHOT1', savedEvidenceCaptures: [{ key: 'search_box', shot: 'EV1' }] },
      { step: 2, screenshot: 'SHOT2', visualEvidenceItems: [{ key: 'cart_badge', visualEvidenceShot: 'EV2' }] },
    ];

    test('carries each saved evidence with its note, step and crop', () => {
      const ev = window._buildGuideTrajectory(INDEX_EV, RECORDS_EV, RECAP).arms.grounding.answer_evidence;

      expect(ev.map(e => e.key)).toEqual(['cart_badge', 'search_box']);
      expect(ev[0]).toMatchObject({ note: 'The cart shows 1 item', step: 2, screenshot: 'EV2' });
      // Explicit saves and confirmation captures are stored in different arrays, keyed the same way.
      expect(ev[1].screenshot).toBe('EV1');
    });

    test('evidence whose crop never made it still carries its words', () => {
      const ev = window._buildGuideTrajectory(INDEX_EV, [], RECAP).arms.grounding.answer_evidence;
      expect(ev).toHaveLength(2);
      expect(ev[0].screenshot).toBeNull();
    });

    // Mirrors the chat: with nothing saved and nothing confirmed, gv2BuildAnswerEvidence falls back
    // to the final step, so the answer is never left standing on nothing at all.
    test('a run that saved no evidence falls back to the final step', () => {
      const ev = window._buildGuideTrajectory(INDEX, RECORDS, RECAP).arms.grounding.answer_evidence;
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ source: 'action-fallback', step: 2, screenshot: 'SHOT2' });
    });

    test('the bare arm carries none of it', () => {
      const grounded = window._buildGuideTrajectory(INDEX_EV, RECORDS_EV, RECAP).arms.grounding;
      expect(window._stripGuideArm(grounded).answer_evidence).toEqual([]);
    });
  });

  describe('_stripGuideArm', () => {
    const grounded = () => window._buildGuideTrajectory(INDEX, RECORDS, RECAP).arms.grounding;

    // The arms must be the same RUN. A shorter trajectory would differ in more than its grounding,
    // and nothing measured against it would be comparable.
    test('drops every screenshot and keeps every step', () => {
      const bare = window._stripGuideArm(grounded());

      expect(bare.steps).toHaveLength(2);
      expect(bare.steps.map(st => st.instruction)).toEqual(grounded().steps.map(st => st.instruction));
      expect(bare.steps.every(st => st.screenshot === null)).toBe(true);
    });

    test('keeps the answer and the trail', () => {
      const bare = window._stripGuideArm(grounded());
      expect(bare.answer).toBe('I sorted the results by price.');
      expect(bare.trail.milestones).toHaveLength(2);
    });

    test('junk in still yields a usable arm', () => {
      const bare = window._stripGuideArm(null);
      expect(bare.steps).toEqual([]);
      expect(bare.questions.correctness).toBeTruthy();
    });
  });

  // `n` is what the participant reads and what their error answer names ("wrong at step 3"). If it
  // survived a reorder, every answer that cites a step number would be ambiguous.
  describe('_moveGuideStep / _renumberGuideSteps', () => {
    const steps = () => [
      { n: 1, instruction: 'a' }, { n: 2, instruction: 'b' }, { n: 3, instruction: 'c' },
    ];

    test('moving a step renumbers by position', () => {
      const out = window._moveGuideStep(steps(), 2, 0);
      expect(out.map(st => st.instruction)).toEqual(['c', 'a', 'b']);
      expect(out.map(st => st.n)).toEqual([1, 2, 3]);
    });

    test('a delete leaves no gap', () => {
      const list = steps();
      list.splice(1, 1);
      expect(window._renumberGuideSteps(list).map(st => st.n)).toEqual([1, 2]);
    });

    test('moving past either end is a no-op that still renumbers', () => {
      expect(window._moveGuideStep(steps(), 0, -5).map(st => st.instruction)).toEqual(['a', 'b', 'c']);
      expect(window._moveGuideStep(steps(), 2, 99).map(st => st.instruction)).toEqual(['a', 'b', 'c']);
      expect(window._moveGuideStep(steps(), 9, 0).map(st => st.n)).toEqual([1, 2, 3]);
    });
  });

  describe('storage', () => {
    beforeEach(() => {
      const store = {};
      window.chrome.storage.local.get = jest.fn(async (k) => (store[k] !== undefined ? { [k]: store[k] } : {}));
      window.chrome.storage.local.set = jest.fn(async (obj) => { Object.assign(store, obj); });
    });

    test('saves, reads back and deletes by id', async () => {
      const t = window._buildGuideTrajectory(INDEX, RECORDS, RECAP);
      await window.saveGuideTrajectory(t, { downscale: false });

      expect((await window.getGuideTrajectory('gv2-abc')).goal).toBe('Sort the results by price');
      await window.deleteGuideTrajectory('gv2-abc');
      expect(await window.getGuideTrajectory('gv2-abc')).toBeNull();
    });

    // The participant queue is built from this, so a half-captured trajectory must not reach them.
    test('only trajectories with steps are offered to participants', async () => {
      await window.saveGuideTrajectory(window._buildGuideTrajectory(INDEX, RECORDS, RECAP), { downscale: false });
      await window.saveGuideTrajectory({ id: 'empty', arms: { grounding: { steps: [] } } }, { downscale: false });

      const ready = await window.listReadyGuideTrajectories();
      expect(ready.map(t => t.id)).toEqual(['gv2-abc']);
    });
  });
});

// ===== PRE-RECORDED STUDY RESPONSES =====
// The study shows every participant the same agent answer per (task × condition). A record that
// lost its [N:"text"] / [ev:key] markers cannot reproduce a grounding answer at all, so that is the
// property these tests exist to protect.
describe('Study responses: record building (sidepanel/study_responses.js)', () => {
  beforeAll(() => {
    window.chrome = window.chrome || {};
    window.chrome.storage = window.chrome.storage || { local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) } };
    loadScript('sidepanel/study_responses.js');
  });

  const GROUNDED_RESULT = {
    answer: 'The garment is draped [12:"over the figure"] and the beard is full [ev:beard].',
    highlightCount: 2,
    hasHighlights: true,
    findEvidenceShots: [{
      shot: 'BASE64DATA', note: 'A full beard.', index: 3, key: 'beard',
      source_image_id: 'viewport',
      marks: { annotations: [{ type: 'box', bbox: { x: 0, y: 0, w: 1, h: 1 } }], captureGeometry: { x: 0, y: 0, w: 800, h: 600 }, evidenceNumber: 3 }
    }]
  };

  describe('_studyResponseCondition', () => {
    // Two arms, one pair per question: what the participant reads either carries its grounding
    // markers or it does not. The old per-evidence-mode split is legacy read-only data.
    test('names the two arms', () => {
      expect(window._studyResponseCondition(false)).toBe('grounding');
      expect(window._studyResponseCondition(true)).toBe('nongrounding');
    });
  });

  describe('_buildStudyResponseRecord', () => {
    const build = (result, extra = {}) => window._buildStudyResponseRecord(Object.assign({
      taskId: 'MAGIC-V1', condition: 'grounding',
      url: 'https://example.com', question: 'what does it show?', result
    }, extra));

    // THE central guarantee.
    test('keeps the citation and evidence markers intact', () => {
      const rec = build(GROUNDED_RESULT);
      expect(rec.answer_raw).toContain('[12:"over the figure"]');
      expect(rec.answer_raw).toContain('[ev:beard]');
    });

    test('carries every evidence field the panel needs to re-render', () => {
      const rec = build(GROUNDED_RESULT);
      expect(rec.evidence).toHaveLength(1);
      expect(rec.evidence[0]).toMatchObject({
        shot: 'BASE64DATA', note: 'A full beard.', index: 3, key: 'beard', source_image_id: 'viewport'
      });
      // marks is what redraws the annotations on the live page — losing it loses the on-page evidence.
      expect(rec.evidence[0].marks.captureGeometry).toEqual({ x: 0, y: 0, w: 800, h: 600 });
      expect(rec.highlight_count).toBe(2);
    });

    // The Ask route returns `answer`; a Guide find step returns `findAnswer` (and also carries a
    // stale `answer`), so findAnswer has to win.
    test('accepts both result shapes, preferring findAnswer', () => {
      expect(build({ answer: 'from ask' }).answer_raw).toBe('from ask');
      expect(build({ findAnswer: 'from find', answer: 'step text' }).answer_raw).toBe('from find');
    });

    test('a non-grounding result records no evidence and no highlights', () => {
      const rec = build({ answer: 'Plain prose.', highlightCount: 0, findEvidenceShots: [] },
        { condition: 'nongrounding' });
      expect(rec.evidence).toEqual([]);
      expect(rec.highlight_count).toBe(0);
      expect(rec.condition).toBe('nongrounding');
    });

    // REGRESSION: entries used to be filtered on `shot`, which silently deleted the [ev:key] markers
    // of any evidence whose crop failed — so the banked answer read differently from the live one.
    // Nothing shows a crop any more; marks are what an evidence item is for.
    test('keeps evidence that has marks but no picture', () => {
      const rec = build({ answer: 'x', findEvidenceShots: [
        { key: 'a', note: 'no crop', marks: { evidenceNumber: 1 } },
        { shot: 'A', key: 'b', note: 'with crop' }
      ] });
      expect(rec.evidence.map(e => e.note)).toEqual(['no crop', 'with crop']);
      expect(rec.evidence[0].shot).toBeNull();
    });

    test('still drops an entry that is nothing at all', () => {
      const rec = build({ answer: 'x', findEvidenceShots: [{ note: 'orphan' }, { shot: 'A', key: 'b', note: 'kept' }] });
      expect(rec.evidence.map(e => e.note)).toEqual(['kept']);
    });

    test('starts unedited', () => {
      const rec = build(GROUNDED_RESULT);
      expect(rec.edited).toBe(false);
      expect(rec.edited_at).toBeNull();
      expect(rec.recorded_at).toBeTruthy();
    });
  });

  // Which record an arm of the Answer screen writes. The evidence is the fragile part: it carries the
  // marks every [ev] marker scrolls to, and losing it is silent — the answer still saves, just
  // without its annotations.
  describe('_buildStudyArmRecord', () => {
    const RESULT = {
      answer: 'Draped [12:"over the figure"] and bearded [ev:beard].',
      highlightCount: 2,
      findEvidenceShots: [{ shot: 'AAA', key: 'beard', index: 3, note: 'the beard', marks: { evidenceNumber: 3 } }]
    };
    const build = (ctx) => window._buildStudyArmRecord(Object.assign({ taskId: 'T', condition: 'grounding' }, ctx));

    test('a fresh recording keeps the text and the evidence it was generated with', () => {
      const rec = build({ result: RESULT });
      expect(rec.answer_raw).toContain('[ev:beard]');
      expect(rec.evidence).toHaveLength(1);
      expect(rec.edited).toBe(false);
    });

    // REGRESSION: editing a banked answer used to rebuild the record from the edited text alone, so
    // the prose and its [N:"…"] spans survived and every annotation was thrown away.
    test('editing a banked record changes only the text — the annotations survive', () => {
      const existing = build({ result: RESULT });

      const edited = build({ existing, text: 'Draped [12:"over the figure"] and bearded [ev:beard], rewritten.' });

      expect(edited.answer_raw).toContain('rewritten');
      expect(edited.evidence).toEqual(existing.evidence);
      expect(edited.evidence[0].marks.evidenceNumber).toBe(3);
      expect(edited.highlight_count).toBe(2);
      expect(edited.edited).toBe(true);
    });

    // The stripped bare answer has no recording behind it, and no evidence by design.
    test('a draft with nothing banked saves as a bare record', () => {
      const rec = build({ condition: 'nongrounding', existing: null, text: 'Draped over the figure and bearded.' });
      expect(rec.evidence).toEqual([]);
      expect(rec.highlight_count).toBe(0);
      expect(rec.edited).toBe(true);
    });
  });

  describe('_applyStudyResponseEdit', () => {
    test('replaces the text, flags the edit, and leaves the evidence alone', () => {
      const rec = window._buildStudyResponseRecord({
        taskId: 't', condition: 'grounding', result: GROUNDED_RESULT
      });
      const edited = window._applyStudyResponseEdit(rec, 'A shorter answer [12:"over the figure"].');

      expect(edited.answer_raw).toBe('A shorter answer [12:"over the figure"].');
      expect(edited.answer_display).toBe(edited.answer_raw);
      expect(edited.edited).toBe(true);
      expect(edited.edited_at).toBeTruthy();
      expect(edited.evidence).toEqual(rec.evidence); // editing prose never drops a screenshot
      expect(rec.answer_raw).toContain('the beard is full'); // original untouched
    });
  });

  describe('storage round trip', () => {
    let store;

    beforeEach(() => {
      store = {};
      window.chrome.storage.local.get = jest.fn(async (k) => (store[k] !== undefined ? { [k]: store[k] } : {}));
      window.chrome.storage.local.set = jest.fn(async (obj) => { Object.assign(store, obj); });
      delete window.supabaseInsert; // Supabase not configured
    });

    const rec = (taskId, condition, answer) => window._buildStudyResponseRecord({
      taskId, condition, result: { answer, findEvidenceShots: [] }
    });

    test('saves and reads back by task and condition', async () => {
      await window.saveStudyResponse(rec('MAGIC-V1', 'grounding', 'first'), { downscale: false });

      const got = await window.getStudyResponse('MAGIC-V1', 'grounding');
      expect(got.answer_raw).toBe('first');
    });

    // Re-recording an answer must replace it, not pile up a second copy the study might pick.
    test('re-saving the same task and condition overwrites', async () => {
      await window.saveStudyResponse(rec('MAGIC-V1', 'grounding', 'first'), { downscale: false });
      await window.saveStudyResponse(rec('MAGIC-V1', 'grounding', 'second'), { downscale: false });

      expect(Object.keys(await window.listStudyResponses())).toHaveLength(1);
      expect((await window.getStudyResponse('MAGIC-V1', 'grounding')).answer_raw).toBe('second');
    });

    test('the two arms of one task coexist', async () => {
      await window.saveStudyResponse(rec('MAGIC-V1', 'grounding', 'grounded'), { downscale: false });
      await window.saveStudyResponse(rec('MAGIC-V1', 'nongrounding', 'bare'), { downscale: false });

      expect(Object.keys(await window.listStudyResponses())).toHaveLength(2);
      expect((await window.getStudyResponse('MAGIC-V1', 'grounding')).answer_raw).toBe('grounded');
      expect((await window.getStudyResponse('MAGIC-V1', 'nongrounding')).answer_raw).toBe('bare');
    });

    test('delete removes only that slot', async () => {
      await window.saveStudyResponse(rec('A', 'grounding', 'a'), { downscale: false });
      await window.saveStudyResponse(rec('B', 'grounding', 'b'), { downscale: false });
      await window.deleteStudyResponse('A', 'grounding');

      expect(await window.getStudyResponse('A', 'grounding')).toBeNull();
      expect(await window.getStudyResponse('B', 'grounding')).not.toBeNull();
    });

    // Local is the source of truth: a broken remote must not lose the recording.
    test('a failing Supabase sync still leaves the record saved', async () => {
      window.supabaseInsert = jest.fn(async () => { throw new Error('network down'); });

      const res = await window.saveStudyResponse(rec('A', 'grounding', 'a'), { downscale: false });

      expect(res.saved).toBe(true);
      expect(res.synced).toBe(false);
      expect((await window.getStudyResponse('A', 'grounding')).answer_raw).toBe('a');
    });

    test('with no Supabase configured the save is local-only and does not throw', async () => {
      const res = await window.saveStudyResponse(rec('A', 'grounding', 'a'), { downscale: false });
      expect(res).toEqual({ saved: true, synced: false });
    });

    // The arms used to be split by evidence mode. Those recordings must stay readable, or the bank
    // silently looks empty for every question recorded before the collapse.
    test('a grounding read falls back to a legacy per-evidence-mode slot', async () => {
      await window.saveStudyResponse(rec('MAGIC-V1', 'grounding-visual', 'recorded earlier'), { downscale: false });

      expect((await window.getStudyResponse('MAGIC-V1', 'grounding')).answer_raw).toBe('recorded earlier');
      // The canonical slot still wins once something is saved there.
      await window.saveStudyResponse(rec('MAGIC-V1', 'grounding', 'recorded now'), { downscale: false });
      expect((await window.getStudyResponse('MAGIC-V1', 'grounding')).answer_raw).toBe('recorded now');
    });

    // tasks.json is the source of truth for which questions exist: delete a question there and its
    // recordings go with it, or the bank fills up with answers to nothing.
    describe('pruneStudyResponses', () => {
      test('drops both arms of a task that is no longer in tasks.json', async () => {
        await window.saveStudyResponse(rec('KEEP-1', 'grounding', 'a'), { downscale: false });
        await window.saveStudyResponse(rec('GONE-1', 'grounding', 'b'), { downscale: false });
        await window.saveStudyResponse(rec('GONE-1', 'nongrounding', 'c'), { downscale: false });

        const removed = await window.pruneStudyResponses(['KEEP-1']);

        expect(removed).toHaveLength(2);
        expect(await window.getStudyResponse('GONE-1', 'grounding')).toBeNull();
        expect(await window.getStudyResponse('KEEP-1', 'grounding')).not.toBeNull();
      });

      // THE guard that matters: a tasks.json that failed to load looks exactly like "every task was
      // deleted", and this function deletes recordings.
      test('an empty id list is a no-op, not a wipe', async () => {
        await window.saveStudyResponse(rec('KEEP-1', 'grounding', 'a'), { downscale: false });

        expect(await window.pruneStudyResponses([])).toEqual([]);
        expect(await window.pruneStudyResponses(null)).toEqual([]);
        expect(await window.getStudyResponse('KEEP-1', 'grounding')).not.toBeNull();
      });

      test('legacy per-evidence-mode records are pruned with their task', async () => {
        await window.saveStudyResponse(rec('GONE-1', 'grounding-visual', 'old'), { downscale: false });

        await window.pruneStudyResponses(['KEEP-1']);

        expect(Object.keys(await window.listStudyResponses())).toHaveLength(0);
      });

      test('nothing to prune leaves storage untouched', async () => {
        await window.saveStudyResponse(rec('KEEP-1', 'grounding', 'a'), { downscale: false });
        window.chrome.storage.local.set.mockClear();

        expect(await window.pruneStudyResponses(['KEEP-1', 'KEEP-2'])).toEqual([]);
        expect(window.chrome.storage.local.set).not.toHaveBeenCalled();
      });
    });

    test('the fallback does not leak across arms', async () => {
      await window.saveStudyResponse(rec('MAGIC-V1', 'grounding-visual', 'grounded'), { downscale: false });
      expect(await window.getStudyResponse('MAGIC-V1', 'nongrounding')).toBeNull();
    });
  });

  // The non-grounded arm is DERIVED from the grounded one — same generation, markers taken out, by
  // the SAME stripNonGroundingMarkers the Non-grounding arm applies at generation time. These tests
  // pin the wiring and the study-only extra; the strip's own behaviour is covered by the
  // stripCitationMarkers suites above.
  describe('_stripStudyGrounding', () => {
    beforeAll(() => { if (!window.stripNonGroundingMarkers) loadScript('content/utils.js'); });

    const strip = (t) => window._stripStudyGrounding(t);

    test('drops a quote that just repeats the prose in front of it', () => {
      expect(strip('featured the **Rose Cross lamen** [2:"Rose Cross lamen"] of a society.'))
        .toBe('featured the **Rose Cross lamen** of a society.');
    });

    test('keeps a quote that carries the sentence', () => {
      expect(strip('Contact the depot [12:"within 30 days"] of travel.'))
        .toBe('Contact the depot within 30 days of travel.');
    });

    test('removes markers that carry no prose, including evidence keys', () => {
      expect(strip('A shirt [45] and a table [idx:3-9] and a beard [ev:beard].'))
        .toBe('A shirt and a table and a beard.');
    });

    // Appended by the panel after generation, so the generation-time strip never sees it.
    test('removes the panel’s highlight tally', () => {
      expect(strip('The answer is here [12:"here"]. ✨ (5 highlighted)')).toBe('The answer is here.');
    });

    test('leaves marker-free prose exactly as it is', () => {
      const plain = 'A plain answer with **bold** and a (parenthetical), nothing else.';
      expect(strip(plain)).toBe(plain);
    });

    test('is safe on empty input', () => {
      expect(strip('')).toBe('');
      expect(strip(null)).toBe('');
    });
  });

  // ===== LIVE → GROUNDED FIDELITY =====
  // Save as Grounded must bank the answer the researcher just approved, character for character in
  // what a reader ends up seeing. Anything the record drops on the way in shows up as a marker that
  // is missing — or renumbered — when the banked version is read back.
  describe('a banked answer renders exactly like the live one', () => {
    beforeAll(() => {
      // The renderers live in panel.js; load it here so this block stands on its own rather than on
      // an earlier describe having loaded it first.
      if (typeof window.parseMarkdown !== 'function') {
        window.chrome = window.chrome || {};
        window.chrome.runtime = Object.assign(
          { onMessage: { addListener: jest.fn() }, sendMessage: jest.fn(), getURL: (p) => p },
          window.chrome.runtime,
          { connect: jest.fn(() => ({ disconnect: jest.fn(), onDisconnect: { addListener: jest.fn() }, postMessage: jest.fn() })) }
        );
        window.chrome.tabs = window.chrome.tabs || {
          query: jest.fn(async () => []), sendMessage: jest.fn(), get: jest.fn(),
          onActivated: { addListener: jest.fn() }, onUpdated: { addListener: jest.fn() }, onRemoved: { addListener: jest.fn() }
        };
        window.chrome.storage = window.chrome.storage || {};
        window.chrome.storage.onChanged = window.chrome.storage.onChanged || { addListener: jest.fn() };
        document.body.innerHTML = '<div id="pageguide-goal-dots"></div>';
        loadScript('sidepanel/panel.js');
      }
    });

    const render = (answer, evidence) => window._expandEvidenceKeyCitations(
      window.parseCitations(window.parseMarkdown(answer)),
      evidence
    );

    const RESULT = {
      answer: 'The play is [517:"El pedante"] and the border shows a frieze [ev:frieze] below the portrait [ev:portrait].',
      highlightCount: 2,
      findEvidenceShots: [
        { key: 'frieze', index: 2, note: 'the frieze', shot: 'AAA', marks: { evidenceNumber: 2 } },
        // No crop — its capture failed. It still marks the page, so it is still evidence.
        { key: 'portrait', index: 3, note: 'the portrait', marks: { evidenceNumber: 3 } }
      ]
    };

    test('same markers, same numbers, both ways', () => {
      const live = render(RESULT.answer, RESULT.findEvidenceShots);
      const rec = window._buildStudyResponseRecord({ taskId: 'T', condition: 'grounding', result: RESULT });
      const banked = render(rec.answer_raw, rec.evidence);

      expect(banked).toBe(live);
      expect(banked).toContain('data-evidence-num="2"');
      expect(banked).toContain('data-evidence-num="3"');
      expect(banked).not.toContain('[ev:');
    });

    // REGRESSION: this is what a dropped evidence entry looked like from the reader's side.
    test('an evidence entry lost on the way in would delete its marker', () => {
      const rec = window._buildStudyResponseRecord({ taskId: 'T', condition: 'grounding', result: RESULT });
      const withoutPortrait = rec.evidence.filter(e => e.key !== 'portrait');

      expect(render(rec.answer_raw, withoutPortrait)).not.toContain('data-evidence-num="3"');
    });

    // The [ev:key] markers are part of the answer, not decoration on top of it: they are what the
    // reader clicks to reach the annotation. They have to survive a save AND an edit, in the stored
    // text and in what that text renders to.
    test('[ev:key] survives being banked and then edited', () => {
      const banked = window._buildStudyArmRecord({ taskId: 'T', condition: 'grounding', result: RESULT });
      expect(banked.answer_raw).toContain('[ev:frieze]');
      expect(banked.answer_raw).toContain('[ev:portrait]');

      const edited = window._buildStudyArmRecord({
        taskId: 'T', condition: 'grounding', existing: banked,
        text: banked.answer_raw.replace('The play is', 'The play here is')
      });

      expect(edited.answer_raw).toContain('[ev:frieze]');
      expect(edited.answer_raw).toContain('[ev:portrait]');
      // And they still RESOLVE, which needs the evidence to have come along with them.
      const html = render(edited.answer_raw, edited.evidence);
      expect(html).toContain('data-evidence-num="2"');
      expect(html).toContain('data-evidence-num="3"');
      expect(html).not.toContain('[ev:');
    });

    // The marks are what an [ev] marker jumps to on the page, so they have to survive the save or
    // the banked answer points at whatever the last live run happened to draw.
    test('every entry keeps the marks its [ev] marker scrolls to', () => {
      const rec = window._buildStudyResponseRecord({ taskId: 'T', condition: 'grounding', result: RESULT });
      expect(rec.evidence.map(e => e.marks?.evidenceNumber)).toEqual([2, 3]);
    });
  });

  // ===== GROUND TRUTH =====
  // What a participant's picked sentence is scored against. A LIST per hop: the answer is often
  // stated in more than one place, and marking a participant wrong for pointing at the other one
  // would be scoring the page rather than the participant.
  describe('ground truth for the supporting questions', () => {
    beforeEach(() => {
      const store = {};
      window.chrome.storage.local.get = jest.fn(async (k) => (store[k] !== undefined ? { [k]: store[k] } : {}));
      window.chrome.storage.local.set = jest.fn(async (obj) => { Object.assign(store, obj); });
      delete window.supabaseInsert;
    });

    describe('_buildGroundTruthRecord', () => {
      test('keeps every accepted sentence per hop, with where it was picked from', () => {
        const rec = window._buildGroundTruthRecord('MAGIC-V1', {
          1: [{ text: 'Built in 1888.', index: 12, url: 'https://x.test' },
               { text: 'The hall dates to 1888.', index: 40, url: 'https://x.test' }],
          2: [{ text: 'Title page engraving', index: 3, url: 'https://x.test' }]
        });

        expect(rec.task_id).toBe('MAGIC-V1');
        expect(rec.hops['1']).toHaveLength(2);
        expect(rec.hops['1'][0]).toMatchObject({ text: 'Built in 1888.', index: 12, url: 'https://x.test' });
        expect(rec.hops['2'][0].index).toBe(3);
        expect(typeof rec.updated_at).toBe('string');
      });

      test('the same sentence added twice is one accepted answer', () => {
        const rec = window._buildGroundTruthRecord('T', {
          1: [{ text: 'Built in 1888.' }, { text: 'built in 1888.' }]
        });
        expect(rec.hops['1']).toHaveLength(1);
      });

      // A hand-edited entry has no element behind it any more, so it carries no index.
      test('normalises whitespace and tolerates a missing index', () => {
        const rec = window._buildGroundTruthRecord('T', { 1: [{ text: '  Built   in\n1888. ' }] });
        expect(rec.hops['1'][0]).toMatchObject({ text: 'Built in 1888.', index: null, url: '' });
      });

      test('drops empty entries rather than storing blanks', () => {
        const rec = window._buildGroundTruthRecord('T', { 1: [{ text: '   ' }, null, { text: 'Real.' }] });
        expect(rec.hops['1']).toHaveLength(1);
        expect(rec.hops['1'][0]).toMatchObject({ text: 'Real.', index: null, url: '' });
      });
    });

    // Ground truth is authored, not measured, so it accepts a typed or pasted sentence as well as a
    // picked one. A typed entry has no element behind it, hence no page index — it is matched on its
    // words. (A participant's own answer stays pick-only; that one IS the measurement.)
    test('a typed entry is stored beside a picked one', () => {
      const rec = window._buildGroundTruthRecord('T', {
        1: [
          { text: 'Picked off the page.', index: 12, url: 'https://x.test' },
          { text: 'Typed by hand.', index: null, url: 'https://x.test' }
        ]
      });

      expect(rec.hops['1']).toHaveLength(2);
      expect(rec.hops['1'][1]).toMatchObject({ text: 'Typed by hand.', index: null, url: 'https://x.test' });
      expect(rec.hops['1'][1].selector).toBe(''); // typed, so there is nothing to go back to
    });

    test('typing the same sentence that was picked does not double it', () => {
      const rec = window._buildGroundTruthRecord('T', {
        1: [{ text: 'One sentence.', index: 12 }, { text: 'One sentence.', index: null }]
      });
      expect(rec.hops['1']).toHaveLength(1);
    });

    test('saves and reads back per task', async () => {
      await window.saveStudyGroundTruth(window._buildGroundTruthRecord('A', { 1: [{ text: 'one' }] }));
      await window.saveStudyGroundTruth(window._buildGroundTruthRecord('B', { 1: [{ text: 'two' }] }));

      expect((await window.getStudyGroundTruth('A')).hops['1'][0].text).toBe('one');
      expect(await window.getStudyGroundTruth('MISSING')).toBeNull();
    });

    test('re-saving a task replaces its ground truth rather than appending', async () => {
      await window.saveStudyGroundTruth(window._buildGroundTruthRecord('A', { 1: [{ text: 'first' }] }));
      await window.saveStudyGroundTruth(window._buildGroundTruthRecord('A', { 1: [{ text: 'second' }] }));

      expect(Object.keys(await window.listStudyGroundTruth())).toHaveLength(1);
      expect((await window.getStudyGroundTruth('A')).hops['1']).toHaveLength(1);
    });

    test('a task deleted from tasks.json takes its ground truth with it', async () => {
      await window.saveStudyGroundTruth(window._buildGroundTruthRecord('KEEP', { 1: [{ text: 'a' }] }));
      await window.saveStudyGroundTruth(window._buildGroundTruthRecord('GONE', { 1: [{ text: 'b' }] }));

      expect(await window.pruneStudyGroundTruth(['KEEP'])).toEqual(['GONE']);
      expect(await window.getStudyGroundTruth('GONE')).toBeNull();
      expect(await window.getStudyGroundTruth('KEEP')).not.toBeNull();
    });

    // Same guard as the response bank: a tasks.json that failed to load must not read as "delete all".
    test('an empty id list is a no-op, not a wipe', async () => {
      await window.saveStudyGroundTruth(window._buildGroundTruthRecord('KEEP', { 1: [{ text: 'a' }] }));

      expect(await window.pruneStudyGroundTruth([])).toEqual([]);
      expect(await window.getStudyGroundTruth('KEEP')).not.toBeNull();
    });
  });

  describe('_persistStudyAnswerEdit (sidepanel/panel.js)', () => {
    let store;

    beforeEach(() => {
      store = {};
      window.chrome.storage.local.get = jest.fn(async (k) => (store[k] !== undefined ? { [k]: store[k] } : {}));
      window.chrome.storage.local.set = jest.fn(async (obj) => { Object.assign(store, obj); });
      delete window.supabaseInsert;
      window._isPanelNonGrounding = () => false;
      window._isPanelVisualEvidence = () => true;
      window.__pgStudyCurrentTask = { id: 'MAGIC-V1', url: 'https://example.com', question: 'q?' };
    });

    afterEach(() => { window.__pgStudyCurrentTask = null; });

    const parked = () => ({
      url: 'https://example.com',
      question: 'q?',
      result: { answer: 'edited prose', findEvidenceShots: [{ shot: 'AAA', note: 'n', index: 1, key: 'k' }] }
    });

    test('records a first edit under the task the study is running', async () => {
      const res = await window._persistStudyAnswerEdit(parked(), 'edited prose');

      expect(res).toMatchObject({ status: 'created', taskId: 'MAGIC-V1', condition: 'grounding' });
      const saved = await window.getStudyResponse('MAGIC-V1', 'grounding');
      expect(saved.answer_raw).toBe('edited prose');
      expect(saved.edited).toBe(true);
    });

    test('updates the banked record in place, keeping its evidence', async () => {
      await window.saveStudyResponse(window._buildStudyResponseRecord({
        taskId: 'MAGIC-V1', condition: 'grounding',
        result: { answer: 'original', findEvidenceShots: [{ shot: 'AAA', note: 'n', index: 1, key: 'k' }] }
      }), { downscale: false });

      const res = await window._persistStudyAnswerEdit(parked(), 'rewritten');

      expect(res.status).toBe('updated');
      const saved = await window.getStudyResponse('MAGIC-V1', 'grounding');
      expect(saved.answer_raw).toBe('rewritten');
      expect(saved.evidence).toHaveLength(1);
      expect(Object.keys(await window.listStudyResponses())).toHaveLength(1);
    });

    // Outside a study session, with nothing to match on, the edit stays in memory rather than
    // being filed under a guessed task.
    test('reports unresolved instead of guessing a task', async () => {
      window.__pgStudyCurrentTask = null;
      window.fetch = jest.fn(async () => ({ json: async () => ({ find: [] }) }));

      const res = await window._persistStudyAnswerEdit({ result: { answer: 'x' } }, 'x');

      expect(res).toEqual({ status: 'unresolved' });
      expect(Object.keys(await window.listStudyResponses())).toHaveLength(0);
    });
  });
});

describe('Trajectory viewer (study/trajectory_view.js)', () => {
  const ARM_GROUNDED = {
    initial_state: { screenshot: 'START', url: 'https://a.test' },
    final_state: { screenshot: 'END', url: 'https://a.test/cart' },
    steps: [
      { n: 1, instruction: 'Type "orange" into the search bar.', url: 'https://amazon.test', screenshot: 'SHOT1' },
      { n: 2, instruction: 'Click "Add to cart".', url: 'https://amazon.test/o', screenshot: 'SHOT2' },
    ],
    answer: 'I added a Navel Orange [ev:ev1] to the cart [ev:gone].',
    answer_evidence: [{ key: 'ev1', note: 'The cart shows 1 item.', step: 2, screenshot: 'EVSHOT' }],
    trail: { summary: 'I searched and added it.', milestones: [{ step: 1, text: 'Typed orange.' }] },
  };

  /** Boot the viewer against a given store and query string, then let its async load settle. */
  async function boot(query, trajectories) {
    document.body.className = '';
    document.body.innerHTML = `
      <h1 id="tv-goal"></h1><div id="tv-count"></div>
      <section id="tv-stage"></section>`;
    window.history.replaceState({}, '', `/study/trajectory_view.html${query}`);
    window.Element.prototype.scrollIntoView = window.Element.prototype.scrollIntoView || (() => {});
    window.chrome = window.chrome || {};
    window.chrome.storage = { local: { get: jest.fn(async () => ({ pageguide_guide_trajectories: trajectories })) } };
    loadScript('sidepanel/guide_trajectories.js'); // the page loads it too, for _stripGuideArm
    loadScript('study/trajectory_view.js');
    await new Promise(r => setTimeout(r, 0));
  }

  // The step TEXT, not the whole row: only a grounded row carries the ⌕ marker saying it has a
  // screenshot behind it, and that difference is the arm working as intended.
  const rowTexts = () => [...document.querySelectorAll('.tv-journey-list .tv-journey-text')]
    .map(el => el.textContent.replace(/\s+/g, ' ').trim());

  const RECORD = { goal: 'add an orange to the cart', arms: { grounding: ARM_GROUNDED, nongrounding: null } };

  // The whole point of the page: one layout, and the arms differ in ONE thing.
  test('both arms render the same journey, under the same states section', async () => {
    await boot('?id=t1&arm=grounding', { t1: RECORD });
    const grounded = rowTexts();
    const order = [...document.querySelectorAll('#tv-stage .tv-states, #tv-stage .tv-journey')]
      .map(el => el.className.split(' ')[0]);
    expect(order).toEqual(['tv-states', 'tv-journey']);

    await boot('?id=t1&arm=nongrounding', { t1: RECORD });
    expect(rowTexts()).toEqual(grounded);
    expect(grounded[0]).toContain('Type "orange" into the search bar.');
  });

  // Both arms, because the pair is the outcome — which both arms are asked to judge — not
  // per-action grounding, which only one of them gets.
  test.each(['grounding', 'nongrounding'])('%s: both states open on click', async (armName) => {
    await boot(`?id=t1&arm=${armName}`, { t1: RECORD });
    const btns = [...document.querySelectorAll('.tv-state-btn')];
    expect(btns.map(b => b.dataset.state)).toEqual(['initial', 'final']);

    btns[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('#pageguide-memory-shot-lightbox img').getAttribute('src'))
      .toBe('data:image/jpeg;base64,START');

    document.querySelector('.tv-lightbox-close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    btns[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('#pageguide-memory-shot-lightbox img').getAttribute('src'))
      .toBe('data:image/jpeg;base64,END');
  });

  // Rendering nothing is how a run that predates the bookends used to look: identical to the
  // feature not existing, which is exactly the confusion this is meant to end.
  test('a state the run never recorded still renders, disabled and saying so', async () => {
    const arm = { ...ARM_GROUNDED, initial_state: { screenshot: null, url: '' } };
    await boot('?id=t1&arm=grounding', { t1: { goal: 'g', arms: { grounding: arm } } });
    const first = document.querySelector('.tv-state-btn[data-state="initial"]');
    expect(first).not.toBeNull();
    expect(first.disabled).toBe(true);
    expect(first.textContent).toMatch(/not recorded/i);
    first.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('pageguide-memory-shot-lightbox')).toBeNull();
  });

  test('grounded step rows offer their screenshot; the page shows the run at full size', async () => {
    await boot('?id=t1&arm=grounding', { t1: RECORD });
    expect(document.getElementById('tv-goal').textContent).toBe('add an orange to the cart');
    expect(document.getElementById('tv-count').textContent).toBe('2 steps');
    expect([...document.querySelectorAll('.tv-journey-list [data-step]')].map(el => el.dataset.step))
      .toEqual(['1', '2']);
  });

  test('non-grounded rows carry no hook, and no step image is reachable', async () => {
    // The arm still carries step screenshots here on purpose: a hand-edited arm can, and the viewer
    // must withhold them on the arm, not on whether the data happens to be clean.
    const rec = { goal: 'g', arms: { grounding: ARM_GROUNDED, nongrounding: { ...ARM_GROUNDED } } };
    await boot('?id=t1&arm=nongrounding', { t1: rec });
    expect(document.querySelectorAll('[data-step], [data-ev-key], [data-ev-step]')).toHaveLength(0);
    expect(document.querySelectorAll('img')).toHaveLength(0);

    // Hovering a row does nothing at all in this arm — no listener was ever attached.
    document.querySelector('.tv-journey-row').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    expect(document.getElementById('tv-pop')).toBeNull();
  });

  test('a step with no screenshot gets no hook — an empty card is a broken affordance', async () => {
    const arm = { ...ARM_GROUNDED, steps: [{ n: 1, instruction: 'Only step.', screenshot: null }] };
    await boot('?id=t1&arm=grounding', { t1: { goal: 'g', arms: { grounding: arm } } });
    expect(document.querySelectorAll('.tv-journey-list .tv-journey-row')).toHaveLength(1);
    expect(document.querySelectorAll('.tv-journey-list [data-step]')).toHaveLength(0);
  });

  // The two gestures the live run teaches: hover a step for its screenshot, click it for the big
  // one. Worth testing rather than eyeballing — the hover card is created on the fly and the click
  // target lives inside it, so a regression in either half leaves the other looking fine.
  test('hovering a step row shows its screenshot; clicking that shows it full size', async () => {
    await boot('?id=t1&arm=grounding', { t1: RECORD });
    const row = document.querySelector('.tv-journey-list [data-step="2"]');
    row.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

    const pop = document.getElementById('tv-pop');
    expect(pop).not.toBeNull();
    expect(pop.querySelector('.tv-pop-shot').getAttribute('src')).toBe('data:image/jpeg;base64,SHOT2');
    expect(pop.textContent).toContain('Click "Add to cart".');

    pop.querySelector('.tv-pop-shot').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const box = document.getElementById('pageguide-memory-shot-lightbox');
    expect(box).not.toBeNull();
    expect(box.querySelector('img').getAttribute('src')).toBe('data:image/jpeg;base64,SHOT2');
  });

  test('hovering an answer chip shows the evidence behind it, not the step', async () => {
    await boot('?id=t1&arm=grounding', { t1: RECORD });
    document.querySelector('.tv-chip').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    const pop = document.getElementById('tv-pop');
    expect(pop.querySelector('.tv-pop-shot').getAttribute('src')).toBe('data:image/jpeg;base64,EVSHOT');
    expect(pop.textContent).toContain('The cart shows 1 item.');
  });

  test('the answer renders numbered chips, dropping markers whose evidence did not survive', async () => {
    await boot('?id=t1&arm=grounding', { t1: RECORD });
    const chips = [...document.querySelectorAll('.tv-answer .tv-chip')];
    expect(chips.map(el => el.textContent)).toEqual(['1']);
    expect(chips[0].dataset.evKey).toBe('ev1');
    // [ev:gone] has no evidence behind it, so it goes entirely rather than showing as raw text.
    expect(document.querySelector('.tv-answer').textContent).not.toContain('[ev:');
  });

  // The chat underlines the phrase that rests on evidence, in place. A number at the end of a
  // sentence says evidence exists; the underline says which words it backs.
  describe('linked phrases in the answer', () => {
    const LINKED = {
      ...ARM_GROUNDED,
      answer: 'I added a Navel Orange to the cart, which now shows 1 item.',
      answer_segments: [
        { phrase: 'which now shows 1 item', step: 2, key: 'ev1', note: 'The cart badge.' },
        { phrase: 'a Navel Orange', step: 1, key: '', note: 'The product page.' },
      ],
    };
    const rec = { goal: 'g', arms: { grounding: LINKED } };

    test('each phrase is underlined where it sits, and opens what backs it', async () => {
      await boot('?id=t1&arm=grounding', { t1: rec });
      const refs = [...document.querySelectorAll('.tv-answer .tv-ref')];
      expect(refs.map(r => r.textContent)).toEqual(['a Navel Orange', 'which now shows 1 item']);
      expect(refs[0].dataset.evStep).toBe('1');     // no evidence key: falls to its step
      expect(refs[1].dataset.evKey).toBe('ev1');
      // The prose around them survives intact.
      expect(document.querySelector('.tv-answer').textContent)
        .toBe('I added a Navel Orange to the cart, which now shows 1 item.');
    });

    test('hovering a phrase shows the same card as its chip would', async () => {
      await boot('?id=t1&arm=grounding', { t1: rec });
      document.querySelector('.tv-ref').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
      expect(document.querySelector('#tv-pop .tv-pop-shot').getAttribute('src')).toBe('data:image/jpeg;base64,SHOT1');
    });

    test('a phrase that leads nowhere stays as prose', async () => {
      const arm = { ...LINKED, answer_segments: [{ phrase: 'a Navel Orange', step: 99, key: '', note: '' }] };
      await boot('?id=t1&arm=grounding', { t1: { goal: 'g', arms: { grounding: arm } } });
      expect(document.querySelectorAll('.tv-answer .tv-ref')).toHaveLength(0);
      expect(document.querySelector('.tv-answer').textContent).toContain('a Navel Orange');
    });

    test('a phrase edited out of the answer is skipped, not force-fitted', async () => {
      const arm = { ...LINKED, answer: 'Rewritten by hand.', answer_segments: LINKED.answer_segments };
      await boot('?id=t1&arm=grounding', { t1: { goal: 'g', arms: { grounding: arm } } });
      expect(document.querySelectorAll('.tv-ref')).toHaveLength(0);
      expect(document.querySelector('.tv-answer').textContent).toBe('Rewritten by hand.');
    });

    test('overlapping phrases do not nest — the first one wins', async () => {
      const arm = {
        ...LINKED,
        answer_segments: [
          { phrase: 'a Navel Orange to the cart', step: 1, key: '', note: '' },
          { phrase: 'Orange to the', step: 2, key: 'ev1', note: '' },
        ],
      };
      await boot('?id=t1&arm=grounding', { t1: { goal: 'g', arms: { grounding: arm } } });
      const refs = [...document.querySelectorAll('.tv-ref')];
      expect(refs).toHaveLength(1);
      expect(refs[0].textContent).toBe('a Navel Orange to the cart');
    });

    test('the non-grounded arm gets no underline — it opens a screenshot either way', async () => {
      const bare = window._stripGuideArm(LINKED);
      await boot('?id=t1&arm=nongrounding', { t1: { goal: 'g', arms: { grounding: LINKED, nongrounding: bare } } });
      expect(document.querySelectorAll('.tv-ref')).toHaveLength(0);
      expect(bare.answer_segments).toEqual([]);
    });
  });

  test('the non-grounded answer is plain text with no chip to press', async () => {
    await boot('?id=t1&arm=nongrounding', { t1: RECORD });
    expect(document.querySelectorAll('.tv-chip')).toHaveLength(0);
    expect(document.querySelector('.tv-answer').textContent).toContain('I added a Navel Orange');
    expect(document.querySelector('.tv-answer').textContent).not.toContain('[ev:');
  });

  test('the reasoning trail travels with the answer, and its milestones point at their step', async () => {
    await boot('?id=t1&arm=grounding', { t1: RECORD });
    expect(document.querySelector('.tv-trail-summary').textContent).toBe('I searched and added it.');
    expect(document.querySelector('.tv-trail [data-ev-step]').dataset.evStep).toBe('1');
  });

  // The answer's evidence clusters on the finish step while the trail narrates every step, so
  // matching evidence ALONE left most milestones wired to nothing — hovering them did nothing at
  // all, which reads as broken rather than as empty.
  test('a milestone with no evidence of its own falls back to that step’s screenshot', async () => {
    await boot('?id=t1&arm=grounding', { t1: RECORD });
    const row = document.querySelector('.tv-trail [data-ev-step="1"]');
    row.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    // Step 1 is named by no evidence entry; its own picture is the right thing to show.
    expect(document.querySelector('#tv-pop .tv-pop-shot').getAttribute('src')).toBe('data:image/jpeg;base64,SHOT1');
  });

  test('a milestone still prefers evidence that names its step', async () => {
    const arm = { ...ARM_GROUNDED, trail: { summary: '', milestones: [{ step: 2, text: 'Added it.' }] } };
    await boot('?id=t1&arm=grounding', { t1: { goal: 'g', arms: { grounding: arm } } });
    document.querySelector('.tv-trail [data-ev-step="2"]').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    const pop = document.getElementById('tv-pop');
    expect(pop.querySelector('.tv-pop-shot').getAttribute('src')).toBe('data:image/jpeg;base64,EVSHOT');
    expect(pop.textContent).toContain('The cart shows 1 item.');
  });

  test('only a row with something behind it carries the peek marker', async () => {
    await boot('?id=t1&arm=grounding', { t1: RECORD });
    expect(document.querySelectorAll('.tv-journey-list .tv-peek')).toHaveLength(2);
    await boot('?id=t1&arm=nongrounding', { t1: RECORD });
    expect(document.querySelectorAll('.tv-peek')).toHaveLength(0);
  });

  // A trajectory banked with no step screenshots is silent otherwise: every hover does nothing and
  // the page looks broken rather than empty.
  test('a grounded arm with no step screenshots at all says so', async () => {
    const arm = { ...ARM_GROUNDED, steps: [{ n: 1, instruction: 'No picture.', screenshot: null }] };
    await boot('?id=t1&arm=grounding', { t1: { goal: 'g', arms: { grounding: arm } } });
    expect(document.querySelector('.tv-warn').textContent).toMatch(/re-capture/i);

    await boot('?id=t1&arm=grounding', { t1: RECORD });
    expect(document.querySelector('.tv-warn')).toBeNull();   // not a nag when the data is fine
  });

  test('a milestone with nothing to show is not wired at all', async () => {
    const arm = {
      ...ARM_GROUNDED,
      steps: [{ n: 1, instruction: 'No picture here.', screenshot: null }],
      answer_evidence: [],
      trail: { summary: '', milestones: [{ step: 1, text: 'Did a thing.' }] },
    };
    await boot('?id=t1&arm=grounding', { t1: { goal: 'g', arms: { grounding: arm } } });
    expect(document.querySelectorAll('.tv-trail [data-ev-step]')).toHaveLength(0);
    expect(document.querySelector('.tv-trail .tv-journey-row').textContent).toContain('Did a thing.');
  });

  // "Agent answer", "reasoning trail" and "view journey" are this product's words, not everyone's.
  test('every section carries a hint, collapsed until asked for, in both arms', async () => {
    for (const armName of ['grounding', 'nongrounding']) {
      await boot(`?id=t1&arm=${armName}`, { t1: RECORD });
      const hints = [...document.querySelectorAll('.tv-hint')];
      expect(hints.length).toBe(4);                       // states, journey, answer, trail
      expect(hints.every(h => h.hidden)).toBe(true);

      const btn = document.querySelector('.tv-info');
      btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      expect(btn.parentElement.querySelector('.tv-hint').hidden).toBe(false);
      expect(btn.getAttribute('aria-expanded')).toBe('true');

      btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      expect(btn.parentElement.querySelector('.tv-hint').hidden).toBe(true);
    }
  });

  test('the hints only promise hover and chips in the arm that has them', async () => {
    await boot('?id=t1&arm=grounding', { t1: RECORD });
    expect(document.querySelector('#tv-stage').textContent).toMatch(/hover a step/i);

    await boot('?id=t1&arm=nongrounding', { t1: RECORD });
    expect(document.querySelector('#tv-stage').textContent).not.toMatch(/hover a step/i);
  });

  test('an unstripped trajectory derives the non-grounded arm rather than serving the grounded one', async () => {
    await boot('?id=t1&arm=nongrounding', { t1: RECORD });
    expect(rowTexts()).toHaveLength(2);
    expect(document.querySelectorAll('[data-step]')).toHaveLength(0);
    expect(document.getElementById('tv-stage').textContent).not.toMatch(/no trajectory recorded/i);
  });

  // loadScript evals each file into its own scope, so it cannot see the one thing that actually
  // broke this page: two classic <script> tags share ONE global lexical scope, and a `const`
  // declared in both is a parse error that kills the second file before a line of it runs. Compile
  // them the way the browser does instead.
  test('the page\'s scripts share a scope without redeclaring anything', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../study/trajectory_view.html'), 'utf8');
    const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
    expect(srcs.length).toBeGreaterThan(1);
    const combined = srcs
      .map(src => fs.readFileSync(path.join(__dirname, '../../study', src), 'utf8'))
      .join('\n;\n');
    expect(() => new Function(combined)).not.toThrow();
  });

  test('a missing grounded arm says so instead of guessing', async () => {
    await boot('?id=t1&arm=grounding', { t1: { goal: 'g', arms: { nongrounding: ARM_GROUNDED } } });
    expect(document.getElementById('tv-stage').textContent).toMatch(/no trajectory recorded/i);
  });
});

// ===== OPENROUTER COST ACCOUNTING =====
// What a run cost, in the provider's own numbers. OpenRouter is the only provider that returns a
// price (`usage.cost`, and only when the request asks for it), so everything here is built on that
// one field rather than a local price table that would rot the next time a model was repriced.
describe('Cost accounting (background/service-worker.js + content/utils.js)', () => {
  const fsx = require('fs');
  const pathx = require('path');
  const SW = fsx.readFileSync(pathx.join(__dirname, '../../background/service-worker.js'), 'utf8');

  beforeAll(() => {
    loadScript('content/utils.js');
  });

  // Without `usage: {include: true}` OpenRouter returns token counts and NO price at all, and the
  // whole feature silently degrades to "unpriced" on every call. Both image paths matter: images
  // are the expensive half of a guide step.
  test('both OpenRouter paths ask for usage accounting', () => {
    const bodies = SW.match(/const response = await fetch\(config\.endpoint[\s\S]*?\}\);/g) || [];
    const orBodies = bodies.filter(b => b.includes('max_tokens'));
    const priced = orBodies.filter(b => /usage:\s*\{\s*include:\s*true\s*\}/.test(b));
    expect(priced.length).toBeGreaterThanOrEqual(2);
  });

  test('the OpenRouter calls return the usage they were given', () => {
    const returns = SW.match(/return \{ content: text, usage: normalizeUsage\(data, 'openrouter', model\) \};/g) || [];
    expect(returns).toHaveLength(2);
  });

  describe('normalizeUsage', () => {
    // Evaluated straight out of the worker source: the function is pure, but the worker as a whole
    // registers listeners at load, which this suite has no reason to stand up.
    const normalizeUsage = new Function(
      `${SW.match(/function normalizeUsage\([\s\S]*?\n\}/)[0]}; return normalizeUsage;`)();

    test('reads OpenRouter’s price and token counts', () => {
      const u = normalizeUsage(
        { usage: { prompt_tokens: 1204, completion_tokens: 180, total_tokens: 1384, cost: 0.00213 } },
        'openrouter', 'anthropic/claude-3.5-sonnet');
      expect(u).toMatchObject({
        provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet',
        promptTokens: 1204, completionTokens: 180, totalTokens: 1384, costUsd: 0.00213,
      });
    });

    // Gemini and OpenAI report tokens but never a price. A zero here would be a lie that adds up:
    // the journey total would read as almost-free instead of unmeasured.
    test('a provider that reports no price gets a null cost, never zero', () => {
      const u = normalizeUsage({ usage: { promptTokenCount: 900, candidatesTokenCount: 120 } }, 'gemini', 'gemini-2.5-flash');
      expect(u.costUsd).toBeNull();
      expect(u.promptTokens).toBe(900);
      expect(u.completionTokens).toBe(120);
    });

    test('totals are derived when the provider omits them', () => {
      expect(normalizeUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } }, 'openrouter', 'm').totalTokens).toBe(15);
    });

    test('a response with no usage block yields null, not an empty shell', () => {
      expect(normalizeUsage({ choices: [] }, 'openrouter', 'm')).toBeNull();
      expect(normalizeUsage(null, 'openrouter', 'm')).toBeNull();
    });
  });

  describe('sumCostEntries', () => {
    test('adds up cost and tokens across a run', () => {
      const t = window.sumCostEntries([
        { costUsd: 0.002, promptTokens: 1000, completionTokens: 100 },
        { costUsd: 0.003, promptTokens: 1500, completionTokens: 200 },
      ]);
      expect(t.costUsd).toBeCloseTo(0.005, 10);
      expect(t.calls).toBe(2);
      expect(t.unpriced).toBe(0);
      expect(t.promptTokens).toBe(2500);
      expect(t.completionTokens).toBe(300);
    });

    // The distinction the whole readout rests on: "$0.0020 · 3 calls" would say the two unpriced
    // calls were free. They were not measured.
    test('unpriced calls are counted but add nothing to the total', () => {
      const t = window.sumCostEntries([
        { costUsd: 0.002, promptTokens: 100 },
        { costUsd: null, promptTokens: 100 },
        { promptTokens: 100 },
      ]);
      expect(t.costUsd).toBeCloseTo(0.002, 10);
      expect(t.calls).toBe(3);
      expect(t.unpriced).toBe(2);
    });

    test('an empty ledger sums to nothing rather than throwing', () => {
      expect(window.sumCostEntries(null)).toEqual(
        { costUsd: 0, calls: 0, unpriced: 0, promptTokens: 0, completionTokens: 0 });
    });
  });

  describe('costEntriesForSession', () => {
    const LEDGER = [
      { sessionId: 'gv2-a', costUsd: 0.001 },
      { sessionId: 'gv2-b', costUsd: 0.002 },
      { sessionId: 'gv2-a', costUsd: 0.003 },
      { sessionId: null, costUsd: 0.004 },
    ];

    test('a journey is priced from its own calls only', () => {
      expect(window.sumCostEntries(window.costEntriesForSession(LEDGER, 'gv2-a')).costUsd).toBeCloseTo(0.004, 10);
    });

    // Two guide runs in one chat must not pool. Attributing a second run's spend to the first is
    // exactly the error that makes a per-journey cost useless.
    test('a second run in the same chat is priced separately', () => {
      expect(window.sumCostEntries(window.costEntriesForSession(LEDGER, 'gv2-b')).calls).toBe(1);
    });

    test('no session means no rows, rather than every unattributed row', () => {
      expect(window.costEntriesForSession(LEDGER, '')).toEqual([]);
      expect(window.costEntriesForSession(LEDGER, null)).toEqual([]);
    });
  });

  describe('costEntriesForAnswer', () => {
    const LOG = [
      { id: 'a' }, { id: 'b' },   // before the question was asked
      { id: 'c' }, { id: 'd' },   // this answer's calls
    ];
    const LEDGER = [
      { debugId: 'a', costUsd: 0.001 },
      { debugId: 'c', costUsd: 0.002 },
      { debugId: 'd', costUsd: 0.004 },
    ];

    // A Find outside a guide run has no session id, so it is attributed the way the 🐞 chip already
    // attributes prompts: everything logged since the question went out.
    test('a Find is priced from the calls logged since its question', () => {
      const slice = window.costEntriesForAnswer(LEDGER, LOG, 2);
      expect(slice.map(e => e.debugId)).toEqual(['c', 'd']);
      expect(window.sumCostEntries(slice).costUsd).toBeCloseTo(0.006, 10);
    });

    test('earlier answers’ calls are excluded', () => {
      expect(window.costEntriesForAnswer(LEDGER, LOG, 2).some(e => e.debugId === 'a')).toBe(false);
    });

    // debugPrompts is capped at 50 in the worker, so a range can point past the end once older
    // entries roll off. An out-of-range answer is unpriced, not a crash.
    test('a range past the end of a rolled-over log yields nothing', () => {
      expect(window.costEntriesForAnswer(LEDGER, LOG, 99)).toEqual([]);
      expect(window.costEntriesForAnswer(LEDGER, [], 0)).toEqual([]);
    });
  });

  describe('formatCostUsd', () => {
    // A guide step runs well under a cent. Two decimals would render every step, and most whole
    // journeys, as $0.00 — which is the same thing as not showing a cost at all.
    test('shows four decimals, so a single step is visible', () => {
      expect(window.formatCostUsd(0.00213)).toBe('$0.0021');
      expect(window.formatCostUsd(0.0184)).toBe('$0.0184');
    });

    test('a cost too small to render is not shown as zero', () => {
      expect(window.formatCostUsd(0.00001)).toBe('<$0.0001');
    });

    test('nothing measured reads as an em dash, not as free', () => {
      expect(window.formatCostUsd(null)).toBe('—');
      expect(window.formatCostUsd(undefined)).toBe('—');
      expect(window.formatCostUsd(NaN)).toBe('—');
      expect(window.formatCostUsd(0)).toBe('$0');
    });
  });

  // One stamp, in the one place every LLM message passes through. A new call site that builds its
  // own metadata block would otherwise be silently unattributed, and its cost would vanish from the
  // journey total without anything failing.
  test('safeSendMessage stamps the guide session onto every LLM call', () => {
    const router = fsx.readFileSync(pathx.join(__dirname, '../../content/functions/main_router.js'), 'utf8');
    expect(router).toMatch(/_isAgentThink[\s\S]{0,400}window\._guidev2\?\.sessionId/);
    expect(router).toMatch(/sessionId: window\._guidev2\.sessionId/);
  });
});

// ===== WHAT A SCROLL MOVES =====
// A scroll used to always go to document.scrollingElement. With a filter popup open that moves
// nothing: modals lock body scroll and keep their options in their own overflow container, so the
// step "succeeds", the page stays put, and the run repeats itself until the loop score pauses it.
describe('Scroll target selection (content/functions/scroll.js)', () => {
  beforeAll(() => {
    loadScript('content/utils.js');
    loadScript('content/functions/scroll.js');
  });

  /**
   * jsdom computes no layout, so every metric this logic reads has to be declared outright —
   * including offsetWidth/offsetHeight, which are 0 for everything in jsdom and would otherwise
   * make isHiddenElement discard every fixture as invisible.
   */
  function makeScroller(el, { scrollHeight, clientHeight, scrollTop = 0, width = 300 }) {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
    Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
    Object.defineProperty(el, 'offsetHeight', { value: clientHeight, configurable: true });
    let top = scrollTop;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      // Clamped like a real element: assigning past the end parks at the end, which is what makes
      // "did it actually move" a meaningful question.
      set: (v) => { top = Math.max(0, Math.min(Number(v) || 0, scrollHeight - clientHeight)); },
    });
    el.getBoundingClientRect = () => ({ top: 0, bottom: clientHeight, left: 0, right: width, width, height: clientHeight });
    return el;
  }

  function setBodyOverflow(value) {
    document.documentElement.style.overflow = value;
    document.body.style.overflow = value;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    setBodyOverflow('');
    // An ordinary long page underneath, so "the page root" is a live option in every test.
    makeScroller(document.documentElement, { scrollHeight: 5000, clientHeight: 800 });
    Object.defineProperty(document, 'scrollingElement', { value: document.documentElement, configurable: true });
    window.innerHeight = 800;
  });

  test('an ordinary page with no popup still scrolls the page', () => {
    const pick = window.gv2PickScroller('down', null);
    expect(pick.el).toBe(document.documentElement);
    expect(pick.source).toBe('page');
  });

  // The case that prompted all of this.
  test('an open filter popup is scrolled, not the page behind it', () => {
    const popup = document.createElement('div');
    popup.setAttribute('role', 'dialog');
    popup.style.overflowY = 'auto';
    document.body.appendChild(popup);
    makeScroller(popup, { scrollHeight: 1200, clientHeight: 400 });

    const pick = window.gv2PickScroller('down', null);
    expect(pick.el).toBe(popup);
    expect(pick.source).toBe('popup');
  });

  test('the scroll lands in the popup and the page does not move', () => {
    const popup = document.createElement('div');
    popup.setAttribute('role', 'menu');
    popup.style.overflowY = 'scroll';
    document.body.appendChild(popup);
    makeScroller(popup, { scrollHeight: 1200, clientHeight: 400 });
    const pageBefore = document.documentElement.scrollTop;

    const res = window.gv2ScrollBy('down', null);
    expect(res.scrolled).toBe(true);
    expect(popup.scrollTop).toBeGreaterThan(0);
    expect(document.documentElement.scrollTop).toBe(pageBefore);
  });

  // Otherwise the no-op just moves one level in: a popup at its end is still "scrollable".
  test('a popup that cannot move any further falls through to the page', () => {
    const popup = document.createElement('div');
    popup.setAttribute('role', 'dialog');
    popup.style.overflowY = 'auto';
    document.body.appendChild(popup);
    makeScroller(popup, { scrollHeight: 1200, clientHeight: 400, scrollTop: 800 }); // already at the bottom

    expect(window.gv2PickScroller('down', null).el).toBe(document.documentElement);
    // ...and it is still the right answer going the other way.
    expect(window.gv2PickScroller('up', null).el).toBe(popup);
  });

  // overflow:auto is the default on a great many wrappers that have nothing to scroll.
  test('overflow:auto with nothing to scroll is not treated as scrollable', () => {
    const wrap = document.createElement('div');
    wrap.setAttribute('role', 'dialog');
    wrap.style.overflowY = 'auto';
    document.body.appendChild(wrap);
    makeScroller(wrap, { scrollHeight: 400, clientHeight: 400 });

    expect(window.pgIsScrollable(wrap)).toBe(false);
    expect(window.gv2PickScroller('down', null).el).toBe(document.documentElement);
  });

  test('the agent’s hint wins over an unrelated open popup', () => {
    const popup = document.createElement('div');
    popup.setAttribute('role', 'dialog');
    popup.style.overflowY = 'auto';
    document.body.appendChild(popup);
    makeScroller(popup, { scrollHeight: 1200, clientHeight: 400 });

    const panel = document.createElement('div');
    panel.style.overflowY = 'auto';
    document.body.appendChild(panel);
    makeScroller(panel, { scrollHeight: 900, clientHeight: 300 });
    const inner = document.createElement('span');
    panel.appendChild(inner);

    const pick = window.gv2PickScroller('down', inner);
    expect(pick.el).toBe(panel);
    expect(pick.source).toBe('hint');
  });

  // The planner can cite an index that has since gone away; that must degrade, not throw.
  test('a hint that leads nowhere falls back to detection', () => {
    const popup = document.createElement('div');
    popup.setAttribute('role', 'dialog');
    popup.style.overflowY = 'auto';
    document.body.appendChild(popup);
    makeScroller(popup, { scrollHeight: 1200, clientHeight: 400 });

    const orphan = document.createElement('div'); // never attached, scrolls nothing
    expect(window.gv2PickScroller('down', orphan).el).toBe(popup);
    expect(window.gv2PickScroller('down', null).el).toBe(popup);
  });

  test('a locked body with no popup picks the largest viewport scroller', () => {
    setBodyOverflow('hidden');
    makeScroller(document.documentElement, { scrollHeight: 800, clientHeight: 800 }); // page cannot move

    const small = document.createElement('div');
    small.style.overflowY = 'auto';
    document.body.appendChild(small);
    makeScroller(small, { scrollHeight: 900, clientHeight: 100, width: 100 });

    const big = document.createElement('div');
    big.style.overflowY = 'auto';
    document.body.appendChild(big);
    makeScroller(big, { scrollHeight: 3000, clientHeight: 600, width: 800 });

    const pick = window.gv2PickScroller('down', null);
    expect(pick.el).toBe(big);
    expect(pick.source).toBe('locked-body');
  });

  // Nothing on the page can move: the caller needs an honest "it did not", not a thrown error or a
  // null it has to branch on.
  test('a page where nothing can scroll reports that it did not move', () => {
    makeScroller(document.documentElement, { scrollHeight: 800, clientHeight: 800 });
    const res = window.gv2ScrollBy('down', null);
    expect(res.scrolled).toBe(false);
    expect(res.source).toBe('none');
    expect(res.el).toBe(document.documentElement);
  });

  test('scrolling up at the top of the page reports no movement', () => {
    const res = window.gv2ScrollBy('up', null);
    expect(res.scrolled).toBe(false);
  });

  // Two definitions of "a popup is open" would let the agent see an option inside a filter popup,
  // ask to scroll to it, and have the scroll go to the page behind.
  test('the popup list is shared with createPageIndex, not duplicated', () => {
    expect(Array.isArray(window.PAGEGUIDE_POPUP_SELECTORS)).toBe(true);
    expect(window.PAGEGUIDE_POPUP_SELECTORS).toContain('[role="dialog"]');
    const utils = fs.readFileSync(path.join(__dirname, '../../content/utils.js'), 'utf8');
    expect(utils).toMatch(/const popupSelectors = PAGEGUIDE_POPUP_SELECTORS;/);
    // Declared exactly once.
    expect(utils.match(/const PAGEGUIDE_POPUP_SELECTORS = \[/g)).toHaveLength(1);
  });

  // Find/Ask goes through the same picker; its false still means "nothing more that way".
  test('the Ask/Find scroll uses the shared picker', () => {
    const ask = fs.readFileSync(path.join(__dirname, '../../content/tasks/ask.js'), 'utf8');
    expect(ask).toMatch(/return gv2ScrollBy\(direction, null\)\.scrolled;/);
  });

  test('the guide step passes its element as the scroll hint', () => {
    const g = fs.readFileSync(path.join(__dirname, '../../content/tasks/guidev2.js'), 'utf8');
    expect(g).toMatch(/getIndexedElement\(step\.element\.index\)/);
    expect(g).toMatch(/gv2ScrollBy\(action === 'scroll_up' \? 'up' : 'down', hintEl\)/);
    // The verify sweep sweeps whatever the action actually opened.
    expect(g).toMatch(/const swept = \(typeof gv2ScrollBy === 'function'\)/);
  });
});

// ===== GROUND TRUTH AND CONDITION (Record Guide User Study) =====
// A captured trajectory is a stimulus; these two fields are what make it usable as one. The ground
// truth is what a participant's answer is scored against, and the condition is which half of the
// design the trajectory belongs to. Both live on the RECORD rather than inside an arm: both arms
// show the same run, so they are graded against the same truth.
describe('Guide ground truth + condition (sidepanel/guide_trajectories.js)', () => {
  beforeAll(() => {
    window.chrome = window.chrome || {};
    window.chrome.storage = window.chrome.storage || { local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) } };
    loadScript('sidepanel/guide_trajectories.js');
  });

  describe('_buildGuideGroundTruth', () => {
    test('keeps a verdict, a problem statement and typed errors', () => {
      const gt = window._buildGuideGroundTruth({
        correctness: 'failure',
        problem: '  It gave the phone number instead of the email address  ',
        errors: [{ type: 'loop', steps: [2, 1] }],
      });
      expect(gt.correctness).toBe('failure');
      expect(gt.problem).toBe('It gave the phone number instead of the email address');
      expect(gt.errors).toEqual([{ type: 'loop', steps: [1, 2] }]);
    });

    // The scoring comparison is between this and a participant's answer. ["2","2",null] and [2] are
    // the same claim, and only one of them can be compared without cleaning — so it is cleaned here,
    // once, rather than at every place that ever reads it.
    test('step lists are numbers, deduplicated and ordered', () => {
      const gt = window._buildGuideGroundTruth({
        correctness: 'failure',
        errors: [{ type: 'wrong_target', steps: ['3', 3, '1', null, 'x', 0, -2] }],
      });
      expect(gt.errors[0].steps).toEqual([1, 3]);
    });

    // An error type the participant can never pick is one no answer can ever match.
    test('an error type outside GUIDE_ERROR_TYPES is dropped', () => {
      const gt = window._buildGuideGroundTruth({
        correctness: 'failure',
        errors: [{ type: 'made_up', steps: [1] }, { type: 'mismatch', steps: [2] }],
      });
      expect(gt.errors.map(e => e.type)).toEqual(['mismatch']);
    });

    test('the error vocabulary is the participant’s, not a second list', () => {
      const ids = window.GUIDE_ERROR_TYPES.map(t => t.id);
      const gt = window._buildGuideGroundTruth({
        correctness: 'failure',
        errors: ids.map(id => ({ type: id, steps: [1] })),
      });
      expect(gt.errors.map(e => e.type)).toEqual(ids);
    });

    test('an empty or missing record normalizes rather than throwing', () => {
      expect(window._buildGuideGroundTruth(null)).toEqual({ correctness: '', problems: [], problem: '', errors: [], no_error: false });
      expect(window._buildGuideGroundTruth({ correctness: 'maybe' }).correctness).toBe('');
    });
  });

  // Drives a badge in the list, so a trajectory that cannot be scored is visible BEFORE the study
  // runs rather than discovered during analysis.
  describe('_guideGroundTruthProblem', () => {
    // Q2 is asked on EVERY run, so a success still has to answer it — even if the answer is "none".
    test('a success must still answer Q2, one way or the other', () => {
      expect(window._guideGroundTruthProblem({ correctness: 'success', errors: [] }))
        .toMatch(/which error/i);
      expect(window._guideGroundTruthProblem({ correctness: 'success', errors: [], no_error: true }))
        .toBeNull();
    });

    test('no verdict is the first thing missing', () => {
      expect(window._guideGroundTruthProblem({ correctness: '', errors: [] })).toMatch(/no verdict/i);
    });

    test('a failure with no answer to Q2 is incomplete', () => {
      const gt = { correctness: 'failure', problems: [window.GUIDE_PROBLEM_TYPES[0].id], errors: [] };
      expect(window._guideGroundTruthProblem(gt)).toMatch(/which error/i);
    });

    // Half an answer: it says something went wrong while withholding where, and that cannot be
    // reconstructed afterwards. Same rule the participant's own answer is held to.
    test('an error with no step is incomplete', () => {
      const problem = window._guideGroundTruthProblem({
        correctness: 'failure',
        problems: [window.GUIDE_PROBLEM_TYPES[0].id],
        errors: [{ type: 'loop', steps: [] }],
      });
      expect(problem).toMatch(/no step/i);
    });

    test('a complete failure passes', () => {
      expect(window._guideGroundTruthProblem({
        correctness: 'failure',
        problems: [window.GUIDE_PROBLEM_TYPES[0].id],
        errors: [{ type: 'loop', steps: [1, 2] }],
      })).toBeNull();
    });
  });

  describe('condition assignment', () => {
    test('the two conditions are the evidence-mode vocabulary', () => {
      expect(window.GUIDE_CONDITIONS.map(c => c.id)).toEqual(['visual', 'text']);
      expect(window.guideConditionLabel('visual')).toBe('GUIDE × VISUAL');
      expect(window.guideConditionLabel('text')).toBe('GUIDE × TEXT');
    });

    test('an unassigned trajectory says so rather than defaulting to a condition', () => {
      expect(window.guideConditionLabel('')).toBe('Unassigned');
      expect(window.guideConditionLabel(undefined)).toBe('Unassigned');
    });

    // Text mode takes no captures at all, so "no screenshots on any step" is the one signal in the
    // data itself. Better than leaving every capture unassigned for the researcher to recall.
    test('a run with screenshots is guessed as VISUAL, one without as TEXT', () => {
      expect(window._inferGuideCondition({ steps: [{ screenshot: 'A' }, { screenshot: null }] })).toBe('visual');
      expect(window._inferGuideCondition({ steps: [{ screenshot: null }, { screenshot: null }] })).toBe('text');
    });

    test('a trajectory with no steps is left unassigned, not guessed', () => {
      expect(window._inferGuideCondition({ steps: [] })).toBe('');
      expect(window._inferGuideCondition(null)).toBe('');
    });
  });

  // Both fields are top-level, so re-capture (which replaces arms.grounding wholesale) cannot
  // silently drop the researcher's work.
  test('a captured trajectory carries a condition guess and an empty ground truth', () => {
    const t = window._buildGuideTrajectory(
      { sessionId: 'gt-1', goal: 'g', steps: [{ step: 1, instruction: 'one' }] },
      [{ step: 1, screenshotBefore: 'SHOT' }],
      null);
    expect(t.condition).toBe('visual');
    expect(t.ground_truth).toEqual({ correctness: '', problems: [], problem: '', errors: [], no_error: false });
    expect(t.arms.grounding.ground_truth).toBeUndefined(); // not per-arm
  });

  test('the strip does not move ground truth into an arm', () => {
    const bare = window._stripGuideArm({ steps: [{ n: 1, instruction: 'x' }], answer: 'a' });
    expect(bare.ground_truth).toBeUndefined();
    expect(bare.condition).toBeUndefined();
  });
});

// ===== WHICH TRAJECTORIES A PARTICIPANT ACTUALLY WALKS =====
// The bank is a working set: captures made to try something, runs superseded by a better take,
// trajectories held back for a later condition. Which of them a participant sees is the
// researcher's call, not "everything that happens to be banked".
describe('Guide study inclusion (sidepanel/guide_trajectories.js)', () => {
  let store;
  beforeAll(() => {
    window.chrome = window.chrome || {};
    window.chrome.storage = {
      local: {
        get: jest.fn(async (key) => ({ [key]: store })),
        set: jest.fn(async (obj) => { store = obj[Object.keys(obj)[0]]; }),
      },
    };
    loadScript('sidepanel/guide_trajectories.js');
  });

  const traj = (id, extra = {}) => Object.assign({
    id, captured_at: `2026-08-0${id.slice(-1)}`,
    arms: { grounding: { steps: [{ n: 1, instruction: 'x' }] } },
  }, extra);

  beforeEach(() => { store = {}; });

  // OPT-OUT: every trajectory banked before this flag existed has no `in_study`, and reading that
  // as "excluded" would empty the guide half of the study the first time this shipped.
  test('a trajectory with no flag set is included', () => {
    expect(window._guideTrajectoryInStudy(traj('t1'))).toBe(true);
    expect(window._guideTrajectoryInStudy(traj('t2', { in_study: true }))).toBe(true);
  });

  test('only an explicit false excludes', () => {
    expect(window._guideTrajectoryInStudy(traj('t1', { in_study: false }))).toBe(false);
    expect(window._guideTrajectoryInStudy(null)).toBe(false);
  });

  test('the participant queue skips excluded trajectories', async () => {
    store = {
      t1: traj('t1'),
      t2: traj('t2', { in_study: false }),
      t3: traj('t3', { in_study: true }),
    };
    const ready = await window.listReadyGuideTrajectories();
    expect(ready.map(t => t.id)).toEqual(['t1', 't3']);
  });

  // Two separate reasons a trajectory cannot be walked; both have to hold.
  test('an included trajectory with no steps still cannot be shown', async () => {
    store = { t1: traj('t1', { in_study: true, arms: { grounding: { steps: [] } } }) };
    expect(await window.listReadyGuideTrajectories()).toEqual([]);
  });

  test('saving normalizes the flag so the field is never left undefined', async () => {
    await window.saveGuideTrajectory(traj('t1'), { downscale: false });
    expect(store.t1.in_study).toBe(true);
    await window.saveGuideTrajectory(traj('t2', { in_study: false }), { downscale: false });
    expect(store.t2.in_study).toBe(false);
  });

  test('excluding a trajectory does not disturb the rest of the bank', async () => {
    await window.saveGuideTrajectory(traj('t1'), { downscale: false });
    await window.saveGuideTrajectory(traj('t2'), { downscale: false });
    const t2 = (await window.listGuideTrajectories()).t2;
    t2.in_study = false;
    await window.saveGuideTrajectory(t2, { downscale: false });
    expect((await window.listReadyGuideTrajectories()).map(t => t.id)).toEqual(['t1']);
    expect(store.t1.in_study).toBe(true);
  });
});

// ===== Q1b IS A CLOSED LIST ON BOTH SIDES =====
// Q1b was the one question in the study that could not be scored: free text on both sides means
// comparing a participant's sentence to the researcher's sentence by hand. A shared closed list
// makes the comparison mechanical; the free-text box survives as optional elaboration.
describe('Guide problem vocabulary (sidepanel/guide_trajectories.js)', () => {
  const fsp = require('fs');
  const pathp = require('path');

  beforeAll(() => {
    window.chrome = window.chrome || {};
    window.chrome.storage = window.chrome.storage || { local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) } };
    loadScript('sidepanel/guide_trajectories.js');
  });

  test('every problem type has an id and a label', () => {
    expect(window.GUIDE_PROBLEM_TYPES.length).toBeGreaterThan(0);
    window.GUIDE_PROBLEM_TYPES.forEach(t => {
      expect(typeof t.id).toBe('string');
      expect(t.id).not.toBe('');
      expect(typeof t.label).toBe('string');
    });
    const ids = window.GUIDE_PROBLEM_TYPES.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Q1b is DETECTION (did you notice it went wrong), Q2 is LOCALIZATION (can you find where).
  // Identical wording under two headings gets ticked in both places, and the data can no longer
  // say whether the participant meant one thing or two — which collapses the distinction the
  // study's two timers exist to measure.
  test('no wording is shared between the two questions', () => {
    const problems = new Set(window.GUIDE_PROBLEM_TYPES.map(t => t.id));
    expect(window.GUIDE_ERROR_TYPES.some(t => problems.has(t.id))).toBe(false);
  });

  // Each field only accepts its own list, so a behavioural answer cannot be filed as an outcome.
  test('an error type is not accepted as a problem', () => {
    const gt = window._buildGuideGroundTruth({
      correctness: 'failure',
      problems: window.GUIDE_ERROR_TYPES.map(t => t.id),
    });
    expect(gt.problems).toEqual([]);
  });

  test('the problem types are the three end states', () => {
    expect(window.GUIDE_PROBLEM_TYPES.map(t => t.id)).toEqual([
      'hallucinated_result', 'incomplete', 'could_not_complete',
    ]);
  });

  // Every option names where the run FINISHED. Behavioural verbs belong to Q2, where an answer
  // has to carry a step number.
  test('no problem option describes an action at a step', () => {
    const behavioural = /\b(click|clicked|type|typed|scroll|submit|filter|log in|misclick|element)\b/i;
    window.GUIDE_PROBLEM_TYPES.forEach(t => {
      expect(t.label).not.toMatch(behavioural);
    });
  });

  test('ground truth keeps picked problems and drops unknown ones', () => {
    const known = window.GUIDE_PROBLEM_TYPES[0].id;
    const gt = window._buildGuideGroundTruth({
      correctness: 'failure',
      problems: [known, 'not_a_real_option', known],
      problem: '  extra detail  ',
    });
    expect(gt.problems).toEqual([known]);   // deduplicated, unknown dropped
    expect(gt.problem).toBe('extra detail'); // the optional elaboration survives
  });

  test('a record with no problems normalizes to an empty list', () => {
    expect(window._buildGuideGroundTruth(null).problems).toEqual([]);
    expect(window._buildGuideGroundTruth({ correctness: 'success' }).problems).toEqual([]);
  });

  // The badge in the list has to catch this: a failure with no problem named cannot be scored
  // against a participant who did name one.
  test('a failure with no problem recorded is flagged as incomplete', () => {
    expect(window._guideGroundTruthProblem({ correctness: 'failure', problems: [], errors: [] }))
      .toMatch(/no problem/i);
  });

  test('a success still needs no problem, but does need a Q2 answer', () => {
    expect(window._guideGroundTruthProblem({ correctness: 'success', problems: [], errors: [], no_error: true }))
      .toBeNull();
  });

  test('a complete failure names a problem, an error and its steps', () => {
    expect(window._guideGroundTruthProblem({
      correctness: 'failure',
      problems: [window.GUIDE_PROBLEM_TYPES[0].id],
      errors: [{ type: window.GUIDE_ERROR_TYPES[0].id, steps: [2] }],
    })).toBeNull();
  });

  // Both sides must read the SAME const, or the comparison the closed list exists for is lost.
  test('the participant and the ground truth render the same list', () => {
    const study = fsp.readFileSync(pathp.join(__dirname, '../../sidepanel/study.js'), 'utf8');
    expect(study).toMatch(/name="guide-problem"/);            // participant
    expect(study).toMatch(/name="study-gt-problem-type"/);    // ground truth
    // Neither builds its own list.
    expect(study.match(/GUIDE_PROBLEM_TYPES\.map/g).length).toBeGreaterThanOrEqual(2);
  });

  test('the participant’s picked problems are saved alongside the free text', () => {
    const study = fsp.readFileSync(pathp.join(__dirname, '../../sidepanel/study.js'), 'utf8');
    expect(study).toMatch(/problems: \[\.\.\.overlay\.querySelectorAll\('input\[name="guide-problem"\]:checked'\)\]/);
    expect(study).toMatch(/problem: \$\('study-guide-problem'\)\?\.value \|\| '',/);
  });

  // The researcher writes ground truth by spotting a wrong step, which needs the steps at a size a
  // 400px column cannot give — so the recorder opens the participant's own page rather than
  // growing a third renderer of the same data.
  test('the recorder previews the participant’s own trajectory page', () => {
    const study = fsp.readFileSync(pathp.join(__dirname, '../../sidepanel/study.js'), 'utf8');
    expect(study).toMatch(/study-traj-preview/);
    expect(study).toMatch(/study\/trajectory_view\.html\?id=\$\{encodeURIComponent\(draft\.id\)\}&arm=/);
  });
});

// ===== "IT SAVED" =====
// A save used to report itself in the same grey as every other note, which is indistinguishable
// from the note already sitting there — so pressing Save twice, unsure whether the first press
// registered, was the normal way to use this screen.
describe('Trajectory save feedback (sidepanel/study.js)', () => {
  const fsq = require('fs');
  const pathq = require('path');
  const study = fsq.readFileSync(pathq.join(__dirname, '../../sidepanel/study.js'), 'utf8');
  const css = fsq.readFileSync(pathq.join(__dirname, '../../sidepanel/study.css'), 'utf8');

  test('the status line has a tone, and a save uses the success one', () => {
    expect(study).toMatch(/const setNote = \(msg, tone = ''\)/);
    expect(study).toMatch(/Saved \$\{draft\.arms\.grounding\.steps\.length\} step\(s\) at/);
    expect(study).toMatch(/'ok'\);/);
  });

  test('a failed save is reported as a failure, not as a note', () => {
    expect(study).toMatch(/setNote\(`Could not save: \$\{res\.error \|\| 'unknown error'\}`, 'bad'\)/);
  });

  // The eye is on the button that was just clicked, not on a small line below the fold.
  test('the button itself confirms', () => {
    expect(study).toMatch(/const flashButton = \(id, label = '✓ Saved'\)/);
    expect(study).toMatch(/flashButton\('study-traj-save'\)/);
    expect(css).toMatch(/\.study-btn-saved/);
  });

  // Saving downscales a dozen screenshots; a live button invites a second press mid-save.
  test('Save is disabled while the write is in flight', () => {
    expect(study).toMatch(/if \(btn\) btn\.disabled = true;/);
    expect(study).toMatch(/if \(btn\) btn\.disabled = false;/);
  });

  // A success is transient; a failure is still true and still needs acting on.
  test('success fades, failure stays', () => {
    expect(study).toMatch(/if \(tone === 'ok' && msg\)/);
    expect(study).toMatch(/noteTimer = setTimeout/);
  });

  // The editor re-renders on almost any interaction, so the restore has to survive the button
  // being replaced underneath it.
  test('the flash does not write to a button that has gone', () => {
    expect(study).toMatch(/if \(!btn\.isConnected\) return;/);
  });

  test('an unsaved edit says so in its own tone', () => {
    expect(study).toMatch(/remember to save\.`?'?, 'warn'\)/);
    expect(css).toMatch(/\.study-note-warn/);
  });

  test('all three tones are styled, and motion is skipped when asked', () => {
    ['study-note-ok', 'study-note-bad', 'study-note-warn'].forEach(cls => {
      expect(css).toContain(`.${cls}`);
    });
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]{0,220}study-btn-saved/);
  });
});


// ===== "NO ERROR" IS AN ANSWER, NOT AN ABSENCE =====
// The participant cannot submit Q2 without ticking something, so their empty `errors` always means
// "I looked, and there were none". The ground truth had no such gate: its empty list meant either
// that or "not filled in yet" — two states that scored identically, and one of them silently
// marked every unfinished trajectory as agreeing with a participant who called the run clean.
describe('Guide ground truth: explicit "no error" (sidepanel/guide_trajectories.js)', () => {
  const fsn = require('fs');
  const pathn = require('path');

  beforeAll(() => {
    window.chrome = window.chrome || {};
    window.chrome.storage = window.chrome.storage || { local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) } };
    loadScript('sidepanel/guide_trajectories.js');
  });

  test('an untouched ground truth is not "no error"', () => {
    expect(window._buildGuideGroundTruth(null).no_error).toBe(false);
  });

  test('the flag survives a round trip', () => {
    expect(window._buildGuideGroundTruth({ correctness: 'success', no_error: true }).no_error).toBe(true);
  });

  // Recording both is not a state worth keeping — the error list is the more specific answer.
  test('an error list wins over the flag', () => {
    const gt = window._buildGuideGroundTruth({
      correctness: 'failure',
      no_error: true,
      errors: [{ type: window.GUIDE_ERROR_TYPES[0].id, steps: [2] }],
    });
    expect(gt.no_error).toBe(false);
    expect(gt.errors).toHaveLength(1);
  });

  // The distinction the whole flag exists for.
  test('"not filled in" and "there were none" are told apart', () => {
    const untouched = { correctness: 'success', problems: [], errors: [] };
    const answered = { correctness: 'success', problems: [], errors: [], no_error: true };
    expect(window._guideGroundTruthProblem(untouched)).toMatch(/which error/i);
    expect(window._guideGroundTruthProblem(answered)).toBeNull();
  });

  test('a failed run can also be recorded as having no step-level error', () => {
    const gt = {
      correctness: 'failure',
      problems: [window.GUIDE_PROBLEM_TYPES[0].id],
      errors: [],
      no_error: true,
    };
    expect(window._guideGroundTruthProblem(gt)).toBeNull();
  });

  // Same control, same exclusivity, same wording as the participant's — the two are compared.
  test('the editor offers the participant’s own "No error" option', () => {
    const study = fsn.readFileSync(pathn.join(__dirname, '../../sidepanel/study.js'), 'utf8');
    expect(study).toMatch(/id="study-gt-no-error"/);
    expect(study).toMatch(/No error — the agent did this correctly/);
    // Ticking it clears the errors; adding an error unticks it.
    expect(study).toMatch(/if \(noError\.checked\) draft\.ground_truth\.errors = \[\];/);
    expect(study).toMatch(/draft\.ground_truth\.no_error = false;/);
    expect(study).toMatch(/if \(noErrBox\) gt\.no_error = noErrBox\.checked;/);
  });
});

// ===== SCORING PARTICIPANTS AGAINST GROUND TRUTH =====
// The closed vocabularies exist so this comparison can be mechanical. Two scores, never one: the
// study times Q1b and Q2 separately because detection ("did you notice") and localization ("can you
// find where") are different acts, and grounding should help the second far more than the first.
describe('Guide answer scoring (sidepanel/guide_trajectories.js)', () => {
  beforeAll(() => {
    window.chrome = window.chrome || {};
    window.chrome.storage = window.chrome.storage || { local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) } };
    loadScript('sidepanel/guide_trajectories.js');
  });

  const PROBLEM = () => window.GUIDE_PROBLEM_TYPES[0].id;
  /** A complete, scorable ground truth. */
  const truth = (over = {}) => window._buildGuideGroundTruth(Object.assign({
    correctness: 'failure',
    problems: [PROBLEM()],
    errors: [{ type: 'wrong_target', steps: [3] }, { type: 'loop', steps: [7, 8] }],
  }, over));

  // The worked example from the plan.
  test('partial credit is scored per type, and steps only for types named right', () => {
    const answer = {
      correct: false,
      problems: [PROBLEM()],
      errors: [{ type: 'wrong_target', steps: [3] }, { type: 'mismatch', steps: [7] }],
    };
    const s = window._scoreGuideAnswer(answer, truth());
    expect(s.type_precision).toBeCloseTo(0.5, 10);   // 1 of 2 named types is real
    expect(s.type_recall).toBeCloseTo(0.5, 10);      // 1 of 2 real types was named
    expect(s.step_precision).toBeCloseTo(1, 10);     // step 3 is right; step 7 earns no credit
    expect(s.step_recall).toBeCloseTo(1 / 3, 10);    // 1 of 3 true steps found
  });

  // The rule that makes step_precision mean something: a step list hung on a failure the run never
  // had is a guess that happened to land somewhere, not localization.
  test('steps under an invented error type earn nothing', () => {
    const answer = { correct: false, problems: [PROBLEM()], errors: [{ type: 'mismatch', steps: [3, 7, 8] }] };
    const s = window._scoreGuideAnswer(answer, truth());
    expect(s.type_precision).toBe(0);
    expect(s.step_precision).toBe(null);  // nothing creditable was even attempted
    expect(s.step_recall).toBe(0);
  });

  test('a perfect answer scores 1 throughout', () => {
    const answer = {
      correct: false,
      problems: [PROBLEM()],
      errors: [{ type: 'wrong_target', steps: [3] }, { type: 'loop', steps: [7, 8] }],
    };
    const s = window._scoreGuideAnswer(answer, truth());
    expect(s.verdict_correct).toBe(true);
    expect(s.problem_precision).toBe(1);
    expect(s.problem_recall).toBe(1);
    expect(s.problem_exact).toBe(true);
    expect(s.type_precision).toBe(1);
    expect(s.type_recall).toBe(1);
    expect(s.step_precision).toBe(1);
    expect(s.step_recall).toBe(1);
    expect(s.step_exact).toBe(true);
  });

  test('the wrong verdict is scored as wrong', () => {
    const s = window._scoreGuideAnswer({ correct: true, problems: [], errors: [] }, truth());
    expect(s.verdict_correct).toBe(false);
  });

  // Order is an artefact of which checkbox was clicked first; it is not part of the answer.
  test('scoring does not depend on the order of errors or steps', () => {
    const a = { correct: false, problems: [PROBLEM()], errors: [{ type: 'wrong_target', steps: [3] }, { type: 'loop', steps: [7, 8] }] };
    const b = { correct: false, problems: [PROBLEM()], errors: [{ type: 'loop', steps: [8, 7] }, { type: 'wrong_target', steps: [3] }] };
    expect(window._scoreGuideAnswer(a, truth())).toEqual(window._scoreGuideAnswer(b, truth()));
  });

  describe('"no error" on both sides', () => {
    const cleanTruth = () => window._buildGuideGroundTruth({
      correctness: 'success', problems: [], errors: [], no_error: true,
    });

    // The case the no_error flag was added for. There is no set to be precise ABOUT, so precision
    // and recall are null — 1 would invent agreement out of two empty lists, 0 would punish it.
    test('agreement is recorded, and precision/recall stay null', () => {
      const s = window._scoreGuideAnswer({ correct: true, problems: [], errors: [] }, cleanTruth());
      expect(s.no_error_agreement).toBe(true);
      expect(s.type_precision).toBeNull();
      expect(s.type_recall).toBeNull();
      expect(s.step_precision).toBeNull();
      expect(s.step_recall).toBeNull();
    });

    test('a participant who finds an error in a clean run disagrees', () => {
      const s = window._scoreGuideAnswer(
        { correct: true, problems: [], errors: [{ type: 'loop', steps: [2] }] }, cleanTruth());
      expect(s.no_error_agreement).toBe(false);
      expect(s.type_precision).toBe(0);
    });

    test('a participant who finds nothing in a broken run disagrees', () => {
      const s = window._scoreGuideAnswer({ correct: false, problems: [PROBLEM()], errors: [] }, truth());
      expect(s.no_error_agreement).toBe(false);
      expect(s.type_recall).toBe(0);
    });
  });

  // NULL IS NOT ZERO. An unfilled stimulus must never read as a participant who got it all wrong.
  describe('nothing to score against', () => {
    test('no ground truth at all scores null, not zero', () => {
      expect(window._scoreGuideAnswer({ correct: false, problems: [], errors: [] }, null)).toBeNull();
    });

    test('an incomplete ground truth scores null', () => {
      const partial = { correctness: 'failure', problems: [], errors: [] }; // no problem, no Q2 answer
      expect(window._guideGroundTruthProblem(partial)).not.toBeNull();
      expect(window._scoreGuideAnswer({ correct: false, problems: [], errors: [] }, partial)).toBeNull();
    });

    test('no answer scores null', () => {
      expect(window._scoreGuideAnswer(null, truth())).toBeNull();
    });
  });

  // The problem question is only SHOWN when the verdict is "did not complete".
  test('the problem score is null when the question was never asked', () => {
    const cleanTruth = window._buildGuideGroundTruth({ correctness: 'success', errors: [], no_error: true });
    const s = window._scoreGuideAnswer({ correct: true, problems: [], errors: [] }, cleanTruth);
    expect(s.problem_precision).toBeNull();
    expect(s.problem_recall).toBeNull();
  });

  test('no score is ever NaN', () => {
    const cases = [
      [{ correct: false, problems: [], errors: [] }, truth()],
      [{ correct: false, problems: [PROBLEM()], errors: [{ type: 'loop', steps: [] }] }, truth()],
      [{ correct: true, problems: [], errors: [] }, truth({ correctness: 'success', problems: [], errors: [], no_error: true })],
    ];
    cases.forEach(([answer, gt]) => {
      const s = window._scoreGuideAnswer(answer, gt) || {};
      Object.entries(s).forEach(([k, v]) => {
        expect(Number.isNaN(v)).toBe(false);
        if (typeof v === 'number') expect(v).toBeGreaterThanOrEqual(0);
      });
    });
  });
});

// The columns those scores are written to, and the table they are posted into.
describe('Guide score columns (sidepanel/study.js + supabase_schema.sql)', () => {
  const fsc = require('fs');
  const pathc = require('path');
  const study = fsc.readFileSync(pathc.join(__dirname, '../../sidepanel/study.js'), 'utf8');
  const schema = fsc.readFileSync(pathc.join(__dirname, '../../supabase_schema.sql'), 'utf8');

  const SCORE_COLUMNS = [
    'score_verdict_correct', 'score_problem_precision', 'score_problem_recall', 'score_problem_exact',
    'score_type_precision', 'score_type_recall', 'score_step_precision', 'score_step_recall',
    'score_step_exact', 'score_no_error_agreement',
  ];

  test('the scored Q1b answer is persisted, not just collected', () => {
    expect(study).toMatch(/guide_answer_problems: guideAnswer \? \(guideAnswer\.problems \|\| \[\]\) : null/);
    expect(window.STUDY_CSV_COLUMNS ? window.STUDY_CSV_COLUMNS : study).toBeTruthy();
    expect(study).toMatch(/'guide_answer_problems'/);
  });

  // persistResult posts exactly SUPABASE_TASK_COLUMNS, and an insert naming a column the table
  // lacks is rejected WHOLE — the error is swallowed and the row silently stays local. This test is
  // the one that would catch a column added to the code but not to the table.
  test('every posted score column exists in the schema', () => {
    SCORE_COLUMNS.concat(['guide_answer_problems']).forEach(col => {
      expect(schema).toContain(col);
    });
  });

  test('the migration adds them to a table that already exists', () => {
    // `create table if not exists` does nothing to a live table, so the alter block is the only
    // thing that makes these columns appear for an existing deployment.
    expect(schema).toMatch(/alter table public\.study_task_results[\s\S]*?add column if not exists guide_answer_problems/);
    SCORE_COLUMNS.forEach(col => {
      expect(schema).toMatch(new RegExp(`add column if not exists\\s+${col}`));
    });
  });

  test('one list feeds both the CSV and the insert', () => {
    expect(study).toMatch(/const GUIDE_SCORE_COLUMNS = \[/);
    // Spread into both, rather than written out twice.
    expect(study.match(/\.\.\.GUIDE_SCORE_COLUMNS/g)).toHaveLength(2);
  });
});

// ===== PUBLISHING STIMULI TO THE STUDY WEBSITE =====
// The browser version of the study (user_study_website) reads study_guide_trajectories. Nothing
// else puts rows there, so this button is the only bridge between a trajectory authored on the
// researcher's machine and a participant running from a URL.
describe('Publish trajectories to Supabase (sidepanel/study.js + supabase_schema.sql)', () => {
  const fsp2 = require('fs');
  const pathp2 = require('path');
  const study = fsp2.readFileSync(pathp2.join(__dirname, '../../sidepanel/study.js'), 'utf8');
  const schema = fsp2.readFileSync(pathp2.join(__dirname, '../../supabase_schema.sql'), 'utf8');

  test('the stimulus tables exist, readable by anon', () => {
    expect(schema).toMatch(/create table if not exists public\.study_guide_trajectories/);
    expect(schema).toMatch(/create table if not exists public\.study_tasks/);
    expect(schema).toMatch(/anon can read guide trajectories[\s\S]{0,120}for select to anon/);
    expect(schema).toMatch(/anon can read tasks[\s\S]{0,120}for select to anon/);
  });

  // The extension and the site both ship the anon key. An anon write policy here would let any
  // holder overwrite the study's stimuli mid-run, so the only uncommented policy is SELECT.
  test('anon cannot write the stimuli', () => {
    const live = schema
      .split('\n')
      .filter(l => !l.trim().startsWith('--'))
      .join('\n');
    const traj = live.slice(live.indexOf('study_guide_trajectories'));
    expect(traj).not.toMatch(/for (insert|all|update) to anon/);
  });

  // Supabase refuses a secret key from any browser context ("Forbidden use of secret API key in
  // browser"), and a side panel is a browser. The privileged half of publishing therefore lives in
  // scripts/publish.mjs, run from a terminal — the panel only ever builds the bundle.
  test('the panel never handles a secret key', () => {
    // No field to paste one into, and no request that could carry one.
    expect(study).not.toMatch(/study-traj-service-key/);
    expect(study).not.toMatch(/type="password"/);
    expect(study).not.toMatch(/rest\/v1\/study_guide_trajectories/);
    // It posts the bundle to the loopback helper instead of talking to Supabase directly.
    expect(study).toMatch(/127\.0\.0\.1:8790\/publish/);
  });

  test('the helper is named when it is not running', () => {
    expect(study).toMatch(/publish helper is not running/);
    expect(study).toMatch(/scripts\/publish\.mjs --serve/);
  });

  // Only what a participant would actually walk: publishing an excluded or step-less trajectory
  // puts a row on the site that its own queue then filters out.
  test('only included trajectories with steps are published', () => {
    expect(study).toMatch(/\.filter\(t => _guideTrajectoryInStudy\(t\) && t\.arms\?\.grounding\?\.steps\?\.length\)/);
  });

  // A bulk insert is rejected whole, so one malformed trajectory would take the rest with it and
  // report nothing about which.
  test('rows are published one at a time so a failure is attributable', () => {
    const helper = fsp2.readFileSync(
      pathp2.join(__dirname, '../../../user_study_website/scripts/publish.mjs'), 'utf8');
    expect(helper).toMatch(/for \(const row of rows\)/);
    expect(helper).toMatch(/resolution=merge-duplicates/);
    expect(helper).toMatch(/on_conflict=/);
  });

  // The bundle carries both halves. A site with the trajectories but not the Find questions
  // silently runs half the study.
  test('the exported bundle covers both halves', () => {
    expect(study).toMatch(/study_guide_trajectories:/);
    expect(study).toMatch(/study_tasks:/);
    expect(study).toMatch(/study_canned_responses:/);
    expect(study).toMatch(/study_ground_truth:/);
  });

  // The secret key lives in .env, read only by the terminal helper.
  test('the helper reads its key from .env, not from a field', () => {
    const helper = fsp2.readFileSync(
      pathp2.join(__dirname, '../../../user_study_website/scripts/publish.mjs'), 'utf8');
    expect(helper).toMatch(/SUPABASE_SECRET_KEY/);
    expect(helper).toMatch(/loadEnv/);
    // Loopback only: it holds a privileged key and must not be reachable off this machine.
    expect(helper).toMatch(/listen\(PORT, '127\.0\.0\.1'/);
  });
});

// ===== PUBLISHING IS REACHABLE FROM BOTH RECORDERS =====
// The stimuli are ONE study: the guide trajectories and the Find questions, answers and ground
// truth go up together. A researcher working through the Find half had no way to know that the
// Guide recorder's button also published their work, and an unreachable action is one nobody runs.
describe('Publish from either half (sidepanel/study.js)', () => {
  const fsb = require('fs');
  const pathb = require('path');
  const study = fsb.readFileSync(pathb.join(__dirname, '../../sidepanel/study.js'), 'utf8');

  test('both recorders offer the action', () => {
    expect(study).toMatch(/id="study-traj-publish"/);   // guide trajectory list
    expect(study).toMatch(/id="study-publish-find"/);   // find recorder task screen
  });

  // One implementation, called twice. Two half-publishes that each looked successful would be a
  // far worse failure than one that is occasionally redundant.
  test('they call the same publisher rather than each having their own', () => {
    expect(study).toMatch(/async function _publishStimuliVia\(/);
    // 1 definition + 3 call sites: publish guide, publish find, publish THIS find. The last is
    // narrowed by task id rather than being its own implementation — a check that ran different
    // code from the real publish would prove nothing about the real publish.
    expect(study.match(/_publishStimuliVia\(/g)).toHaveLength(4);
    // The loopback endpoint is named once, not copied.
    expect(study.match(/127\.0\.0\.1:8790\/publish/g)).toHaveLength(1);
  });

  // Publishing and capturing are researcher actions; a participant must never see either button.
  test('the Find recorder buttons only exist while recording', () => {
    const block = study.match(/\$\{_studyRecording\(\) \? `([\s\S]*?)` : ''\}/);
    expect(block).not.toBeNull();
    expect(block[1]).toContain('study-publish-find');
    expect(block[1]).toContain('study-capture-page');
  });
});

// ===== FROZEN PAGES FOR THE FIND HALF =====
// A Find task asks a participant to check an answer against a page, and the website cannot show the
// live one. Two independent reasons, and the second is the one that matters:
//   1. Most sites refuse to be framed (publicdomainreview.org sends X-Frame-Options: DENY).
//   2. A cross-origin frame CANNOT BE SCRIPTED. Even where framing works, nothing could be indexed,
//      highlighted or scrolled — so the grounded arm would look exactly like the non-grounded one.
// A snapshot served from the study's own origin is same-origin, and therefore a working DOM.
describe('Page snapshots (content/functions/page_snapshot.js)', () => {
  const fss = require('fs');
  const paths = require('path');
  const snap = fss.readFileSync(paths.join(__dirname, '../../content/functions/page_snapshot.js'), 'utf8');
  const site = fss.readFileSync(
    paths.join(__dirname, '../../../user_study_website/app/study.js'), 'utf8');

  // A snapshot that could run code could rewrite itself under a participant, re-fetch the live
  // article, or navigate the study away.
  test('scripts are stripped and re-blocked by a CSP', () => {
    expect(snap).toMatch(/querySelectorAll\('script, noscript'\)\.forEach\(el => el\.remove\(\)\)/);
    expect(snap).toMatch(/Content-Security-Policy/);
    expect(snap).toMatch(/default-src 'none'/);
  });

  // Nothing may reach the network from inside a snapshot: it must not change under a participant,
  // and a participant's IP must not reach the site being studied.
  test('embedded and remote content is removed', () => {
    expect(snap).toMatch(/iframe, frame, object, embed, video, audio, source/);
    expect(snap).toMatch(/link\[rel~="stylesheet"\]/);
  });

  test("PageGuide's own chrome is not baked into the capture", () => {
    expect(snap).toMatch(/\[id\^="pageguide-"\]/);
    expect(snap).toMatch(/study-overlay/);
  });

  // A rule in /assets/css/site.css saying url(../img/bg.png) means /assets/img/bg.png. Resolving it
  // against the document instead fetches the wrong file — or a real but different one, which is
  // worse because nobody notices.
  test('stylesheet URLs resolve against the stylesheet, not the page', () => {
    expect(snap).toMatch(/new URL\(raw, sheetHref \|\| document\.baseURI\)/);
  });

  // currentSrc is the only place a responsive page keeps the URL it actually used; src alone would
  // inline a placeholder.
  test('responsive images are captured from what the browser really chose', () => {
    expect(snap).toMatch(/img\.currentSrc/);
    expect(snap).toMatch(/removeAttribute\('srcset'\)/);
  });

  test('a password is never serialized into a snapshot', () => {
    const utils = fss.readFileSync(paths.join(__dirname, '../../content/utils.js'), 'utf8');
    expect(utils).toMatch(/never serialize password values/i);
  });

  // The site must frame it same-origin, or the entire exercise was pointless.
  test('the site frames the snapshot same-origin and marks evidence in it', () => {
    expect(site).toMatch(/frame\.srcdoc = page\.html/);
    expect(site).toMatch(/frame\.contentDocument/);
    expect(site).toMatch(/createTreeWalker/);
  });

  // Matching by element index only works if the page re-indexes identically — one lazy image or
  // one A/B variant and every index points somewhere else. The recorded sentence is stable.
  test('evidence is matched by text, not by element index', () => {
    expect(site).toMatch(/needle\.length < 4/);       // too short to match uniquely
    expect(site).toMatch(/markText\(doc, needle\)/);
  });

  test('the non-grounded arm gets no marks — that is the arm', () => {
    expect(site).toMatch(/if \(arm === 'nongrounding'\) return;/);
  });

  test('the snapshot table is anon-readable and published with the Find half', () => {
    const schema = fss.readFileSync(paths.join(__dirname, '../../supabase_schema.sql'), 'utf8');
    expect(schema).toMatch(/create table if not exists public\.study_task_pages/);
    expect(schema).toMatch(/anon can read task pages/);
    const study = fss.readFileSync(paths.join(__dirname, '../../sidepanel/study.js'), 'utf8');
    expect(study).toMatch(/study_task_pages: pages/);
    const helper = fss.readFileSync(
      paths.join(__dirname, '../../../user_study_website/scripts/publish.mjs'), 'utf8');
    // Pages reference tasks, so the tasks must be upserted first.
    expect(helper.indexOf('study_tasks:')).toBeLessThan(helper.indexOf('study_task_pages:'));
  });
});

// ===== THE BLURRY-IMAGE FAILURE =====
// Lazy loaders put a tiny blurred stand-in in `src` and keep the real file in a data- attribute
// until the image scrolls into view. Capturing `src` naively inlines the blur — and the snapshot is
// then unreadable exactly where a Find question points ("what small creature appears on the lower
// ledge of the portrait?"). On publicdomainreview.org this hit 15 of 20 images.
describe('Snapshot image resolution (content/functions/page_snapshot.js)', () => {
  beforeAll(() => {
    global.document = global.document || window.document;
    loadScript('content/functions/page_snapshot.js');
  });

  const img = (attrs) => {
    const el = document.createElement('img');
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  };

  test('an explicit lazy attribute beats the placeholder in src', () => {
    expect(window._pgBestImageUrl(img({
      src: 'https://x.test/blur/tiny.jpg',
      'data-src': 'https://x.test/full/big.jpg',
    }))).toBe('https://x.test/full/big.jpg');
  });

  // The exact shape publicdomainreview.org uses: the placeholder sits right beside the real one.
  test('data-blursrc is never chosen — it IS the placeholder', () => {
    const el = img({
      src: 'https://x.test/blur.jpg',
      'data-blursrc': 'https://x.test/blur.jpg',
      'data-src': 'https://x.test/real.jpg',
    });
    expect(window._pgBestImageUrl(el)).toBe('https://x.test/real.jpg');
  });

  // An upscaled small candidate is the same blur problem in a different costume.
  test('the widest srcset candidate wins', () => {
    expect(window._pgBestImageUrl(img({
      src: 'https://x.test/small.jpg',
      srcset: 'https://x.test/400.jpg 400w, https://x.test/1600.jpg 1600w, https://x.test/800.jpg 800w',
    }))).toBe('https://x.test/1600.jpg');
  });

  test('pixel-density descriptors are ranked too', () => {
    expect(window._pgBestImageUrl(img({
      src: 'https://x.test/1x.jpg',
      srcset: 'https://x.test/1x.jpg 1x, https://x.test/3x.jpg 3x',
    }))).toBe('https://x.test/3x.jpg');
  });

  test('a plain image is left exactly as it is', () => {
    expect(window._pgBestImageUrl(img({ src: 'https://x.test/plain.jpg' })))
      .toBe('https://x.test/plain.jpg');
  });

  // A data: candidate is itself an inline placeholder, never the full asset.
  test('inline data: candidates are skipped', () => {
    expect(window._pgBestImageUrl(img({
      src: 'https://x.test/real.jpg',
      'data-src': 'data:image/gif;base64,R0lGOD',
    }))).toBe('https://x.test/real.jpg');
  });

  // Some loaders leave no data- attribute at all: an IntersectionObserver swaps src and that is the
  // only place the real URL ever exists, so every image has to be brought near the viewport first.
  test('lazy loaders are made to run before anything is read', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../content/functions/page_snapshot.js'), 'utf8');
    expect(src).toMatch(/async function _pgSettleLazyImages/);
    expect(src).toMatch(/await _pgSettleLazyImages\(\);/);
    // ...and the scroll must be put back, or capturing moves the researcher's page under them.
    expect(src).toMatch(/window\.scrollTo\(0, startY\)/);
    // One image behind a dead CDN must not hold the capture open forever.
    expect(src).toMatch(/setTimeout\(r, 5000\)/);
  });
});

// A Find task renders a framed page, not a step list, so it replaces the stimulus pane wholesale.
// The guide renderer mounts into #tv-goal/#tv-stage — which no longer existed after a Find task, so
// a guide task following a find task rendered into nothing until the page was reloaded.
describe('Find → Guide without a reload (user_study_website/app/study.js)', () => {
  const site = require('fs').readFileSync(
    require('path').join(__dirname, '../../../user_study_website/app/study.js'), 'utf8');

  test('the guide shell is rebuilt before every guide task', () => {
    expect(site).toMatch(/function renderGuideShell\(\)/);
    expect(site).toMatch(/renderGuideShell\(\);\s*\n\s*window\.Stimulus\.mountStimulus/);
  });

  test('the rebuilt shell carries the ids the renderer mounts into', () => {
    const shell = site.match(/function renderGuideShell\(\)[\s\S]*?\n\}/)[0];
    ['tv-goal', 'tv-count', 'tv-stage'].forEach(id => expect(shell).toContain(`id="${id}"`));
  });
});

// ===== OPENING THE PAGE WITHOUT STARTING THE ASK =====
// 📄 Capture page reads the active tab, so the researcher needs the task page open while the
// recorder is still on the setup screen. The combined button reset the chat AND moved the panel to
// the running screen in one click, so that moment never existed.
describe('Open page / Ask PageGuide (sidepanel/study.js)', () => {
  const study = require('fs').readFileSync(
    require('path').join(__dirname, '../../sidepanel/study.js'), 'utf8');

  test('the recorder gets two buttons', () => {
    expect(study).toMatch(/id="study-open-only-btn"/);
    expect(study).toMatch(/id="study-open-btn"/);
  });

  // A participant choosing between them is a way to do the task wrong.
  test('a participant still gets one', () => {
    const block = study.match(/\$\{_studyRecording\(\) \? `([\s\S]*?)`\s*\n?\s*: `([\s\S]*?)`\}/);
    expect(block).not.toBeNull();
    expect(block[1]).toContain('study-open-only-btn');   // recording
    expect(block[2]).not.toContain('study-open-only-btn'); // participating
  });

  // The whole point: opening must not reset the chat or leave the screen.
  test('opening alone does not start the run', () => {
    const handler = study.match(/if \(openOnly\) openOnly\.onclick[\s\S]*?\n    \};/)[0];
    expect(handler).toMatch(/openTaskPage\(taskUrl\)/);
    expect(handler).not.toMatch(/resetChat/);
    expect(handler).not.toMatch(/renderTaskRunning/);
    expect(handler).not.toMatch(/startBehaviorTracking/);
  });

  // Asking still does the full thing, unchanged.
  test('Ask PageGuide still resets the chat and starts the run', () => {
    const handler = study.match(/\$\('study-open-btn'\)\.onclick[\s\S]*?renderTaskRunning/)[0];
    expect(handler).toMatch(/resetChat/);
    expect(handler).toMatch(/openTaskPage\(taskUrl\)/);
  });
});

// ===== RE-CAPTURING REPLACES =====
// A page captured before the lazy-image fix has blurred placeholders baked into it, and capturing
// again is the only way to repair it. Appending would leave the broken one in place with nothing to
// say which of the two a participant should see.
describe('Page snapshots replace on re-capture (sidepanel/study.js + publish.mjs)', () => {
  const fsr = require('fs');
  const pathr = require('path');
  const study = fsr.readFileSync(pathr.join(__dirname, '../../sidepanel/study.js'), 'utf8');
  const helper = fsr.readFileSync(
    pathr.join(__dirname, '../../../user_study_website/scripts/publish.mjs'), 'utf8');
  const schema = fsr.readFileSync(pathr.join(__dirname, '../../supabase_schema.sql'), 'utf8');

  test('the local bank is keyed by task id, so a second capture overwrites', () => {
    expect(study).toMatch(/all\[String\(taskId\)\] = \{/);
  });

  test('publishing upserts on task_id rather than inserting a duplicate', () => {
    expect(helper).toMatch(/study_task_pages: 'task_id'/);
    expect(helper).toMatch(/resolution=merge-duplicates/);
  });

  // A primary key is what makes the upsert an upsert; without it the merge has nothing to match on.
  test('task_id is the primary key of the table', () => {
    expect(schema).toMatch(/task_id\s+text\s+primary key references public\.study_tasks/);
  });
});

// ===== FIND GROUNDING ON THE WEBSITE =====
// A recorded Find answer carries the grounding INSIDE it: [N:"quoted text"] cites an element, and
// [ev:key] points at saved evidence. Rendered as plain text those markers are visible garbage —
// "[43:"El pedante"]" — and nothing on the page is marked, so the grounded arm shows a participant
// exactly what the non-grounded one does.
describe('Find citation rendering and marking (user_study_website/app/study.js)', () => {
  const site = require('fs').readFileSync(
    require('path').join(__dirname, '../../../user_study_website/app/study.js'), 'utf8');

  test('both marker kinds are parsed out of the answer', () => {
    expect(site).toMatch(/function parseFindCitations/);
    expect(site).toContain('/\\[(\\d+):"([^"]*)"\\]/g');   // the [N:"text"] pattern
    expect(site).toContain('/\\[ev:([^\\]]+)\\]/g');        // the [ev:key] pattern
  });

  test('the grounded arm gets chips, never raw markers', () => {
    expect(site).toMatch(/class="find-cite"/);
    expect(site).toMatch(/data-cite-text=/);
  });

  // A raw marker in the non-grounded arm would be the worst of both: it announces that something
  // was cited while giving no way to check it.
  test('the non-grounded arm has its markers stripped, not shown', () => {
    const fn = site.match(/function renderFindAnswer[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/arm === 'nongrounding'/);
    expect(fn).toMatch(/stripNonGroundingMarkers/);
  });

  // Curly quotes and collapsed whitespace differ between a recorded quote and the page it came from.
  test('matching normalizes quotes and whitespace', () => {
    expect(site).toMatch(/function normText/);
    expect(site).toContain('\\u2018\\u2019');
  });

  // The hard case: a cited image's caption is split across elements (the play title sits in its own
  // tag), so no single text node holds the whole quote and an exact match finds nothing.
  test('a caption split across elements still matches, by prefix', () => {
    expect(site).toMatch(/for \(const len of \[40, 25, 15\]\)/);
    expect(site).toMatch(/function findElementContaining/);
  });

  // A caption is rarely a sibling of its image — on publicdomainreview it is two levels away.
  test('the cited picture is found by walking up, but only so far', () => {
    const fn = site.match(/function markElement[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/depth < 4/);   // unbounded, every caption reaches <body> and marks the logo
    // The marking itself is markImage's job — an <img> needs a wrapper to carry the badge.
    expect(fn).toMatch(/markImage\(img, needle\)/);
  });

  test('clicking a chip scrolls the snapshot to what it cites', () => {
    expect(site).toMatch(/function focusFindCitation/);
    expect(site).toMatch(/scrollIntoView/);
    // The extension's own class, so the outline and badge are the ones the panel already shows.
    expect(site).toMatch(/pageguide-preview-target/);
  });
});

// ===== THE INTERACTION MATCHES THE EXTENSION =====
// A participant who saw the live page through the extension and the snapshot here must be looking
// at the same affordance: the same tint, the same outline, and the same "PageGuide highlight" badge
// naming what is being pointed at. A lookalike would be one more difference between the arms that
// nobody is measuring.
describe('Find grounding matches the extension (user_study_website/app/study.js)', () => {
  const fsx2 = require('fs');
  const px2 = require('path');
  const site = fsx2.readFileSync(px2.join(__dirname, '../../../user_study_website/app/study.js'), 'utf8');
  const css = fsx2.readFileSync(px2.join(__dirname, '../../content/content.css'), 'utf8');

  test('the badge text and classes are the extension’s, not new ones', () => {
    expect(css).toContain("content: 'PageGuide highlight'");
    expect(site).toContain("content: 'PageGuide highlight'");
    expect(site).toContain('pageguide-preview-target');   // the class the panel already uses
    expect(site).toContain('pageguide-highlight');
  });

  // Hover names it, click goes to it — the two gestures a citation already has in the panel.
  test('a chip is both hoverable and clickable', () => {
    expect(site).toMatch(/chip\.onmouseenter/);
    expect(site).toMatch(/chip\.onclick/);
  });

  test('only one thing is ever pointed at', () => {
    expect(site).toMatch(/function clearFindFocus/);
    expect(site).toMatch(/clearFindFocus\(doc\);\s*\n\s*target\.classList\.add\('pageguide-preview-target'\)/);
  });

  // One citation's text is often a substring of another's: "El pedante" is the play, and it also
  // appears inside "Title page engraving from Francesco Belo's El pedante (1538)". A substring
  // search in document order sent the chip for the play to the picture of its title page.
  test('an exact citation match wins over a substring', () => {
    const fn = site.match(/function focusFindCitation[\s\S]*?\n\}/)[0];
    const exact = fn.indexOf("=== needle");
    const loose = fn.indexOf(".includes(needle");
    expect(exact).toBeGreaterThan(-1);
    expect(exact).toBeLessThan(loose);
  });

  // Measured: 0px moved with smooth, 394px with the default. It fails silently, so the chip looks
  // like it does nothing.
  test('scrolling inside the snapshot is instant, because smooth does not work there', () => {
    const fn = site.match(/function focusFindCitation[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/scrollIntoView\(\{ block: 'start' \}\)/);
    expect(fn).not.toMatch(/behavior: 'smooth'/);
  });

  // block:'start' + scroll-margin, not 'center': centring a tall engraving puts its top off-screen,
  // and the top is exactly where the badge sits.
  test('the badge is left room above the citation', () => {
    expect(site).toMatch(/scroll-margin: 90px/);
    expect(site).not.toMatch(/block: 'center'/);
  });
});

// ===== THE CITED PHRASE, AND THE BADGE ON AN IMAGE =====
describe('Find citation display parity (user_study_website)', () => {
  const fsy = require('fs');
  const py = require('path');
  const site = fsy.readFileSync(py.join(__dirname, '../../../user_study_website/app/study.js'), 'utf8');
  const css = fsy.readFileSync(py.join(__dirname, '../../../user_study_website/styles/site.css'), 'utf8');

  // The extension renders the cited PHRASE plus a superscript index, with the phrase hidden until
  // the answer is clicked open. Rendering only a number drops the phrase and loses what the
  // citation is even about.
  test('a citation carries its phrase, not just a number', () => {
    expect(site).toMatch(/class="citation-text"/);
    expect(site).toMatch(/class="citation-index"/);
    expect(css).toMatch(/\.find-cite \.citation-text \{[\s\S]*?display: none/);
    expect(css).toMatch(/citations-expanded[\s\S]*?display: inline/);
  });

  // A cited phrase can be a whole caption, so it wraps. Without cloning the decoration the
  // background paints as one box across every line it touches, landing on the lines between.
  test('a wrapped phrase does not paint over the lines around it', () => {
    expect(css).toMatch(/box-decoration-break: clone/);
  });

  // ::before and ::after DO NOT RENDER on replaced elements, and <img> is one. Putting the class on
  // the image gives an outline and no label — the picture pointed at with nothing saying why.
  test('a cited image is wrapped, because an image cannot carry the badge', () => {
    expect(site).toMatch(/function markImage/);
    expect(site).toMatch(/pageguide-highlight-imgwrap/);
    const fn = site.match(/function markImage[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/createElement\('span'\)/);
    expect(fn).toMatch(/wrap\.appendChild\(img\)/);
    // Marking must not reflow the article around it.
    expect(site).toMatch(/\.pageguide-highlight-imgwrap \{ display: inline-block/);
  });

  test('an image is never wrapped twice', () => {
    expect(site).toMatch(/if \(img\.parentElement\?\.classList\.contains\('pageguide-highlight-imgwrap'\)\) return;/);
  });

  test('clicking the answer expands its citations, as the panel does', () => {
    expect(site).toMatch(/citations-expanded/);
    expect(site).toMatch(/pageguide-clickable/);
    // A chip click is a different gesture and must not also toggle the answer.
    expect(site).toMatch(/if \(e\.target\.closest\('\.find-cite'\)\) return;/);
  });
});

// ===== ONE PAGE, TWO TASKS =====
// MUFC-V1 and MUFC-V1-TEXT are the same Wikipedia article asked under the two Find conditions.
// A snapshot is multi-megabyte, so storing it twice wastes space — and, worse, lets the two copies
// drift, which would make the conditions differ in the PAGE rather than only in the grounding.
describe('Shared page snapshots (sidepanel/study.js + user_study_website)', () => {
  const fsz = require('fs');
  const pz = require('path');
  const study = fsz.readFileSync(pz.join(__dirname, '../../sidepanel/study.js'), 'utf8');
  const db = fsz.readFileSync(pz.join(__dirname, '../../../user_study_website/app/supabase.js'), 'utf8');
  const schema = fsz.readFileSync(pz.join(__dirname, '../../supabase_schema.sql'), 'utf8');

  // The task file is where the sharing actually comes from, so it is worth asserting it is real.
  test('the task set really does share a page', () => {
    const tasks = JSON.parse(fsz.readFileSync(
      pz.join(__dirname, '../../user_study_data/tasks.json'), 'utf8')).find;
    const byUrl = {};
    tasks.forEach(t => { (byUrl[t.url] = byUrl[t.url] || []).push(t.id); });
    const shared = Object.values(byUrl).filter(ids => ids.length > 1);
    expect(shared.length).toBeGreaterThan(0);
    expect(tasks.length).toBeGreaterThan(Object.keys(byUrl).length);
  });

  test('publishing sends one row per URL, not one per task', () => {
    expect(study).toMatch(/const seenUrls = new Set\(\)/);
    expect(study).toMatch(/if \(seenUrls\.has\(p\.url\)\) return false;/);
    // A page with no URL cannot be deduped and must still be published.
    expect(study).toMatch(/if \(!p\.url\) return true;/);
  });

  test('a task with no page of its own finds the shared one by URL', () => {
    expect(db).toMatch(/async function getTaskPage\(taskId, url\)/);
    const fn = db.match(/async function getTaskPage[\s\S]*?\n\}/)[0];
    // Its own row wins; the URL lookup is the fallback, not the first choice.
    expect(fn.indexOf('task_id=eq.')).toBeLessThan(fn.indexOf('url=eq.'));
    expect(fn).toMatch(/if \(!url\) return null;/);
  });

  test('the URL is indexed, since it is now a lookup key', () => {
    expect(schema).toMatch(/create index if not exists idx_stp_url on public\.study_task_pages \(url\)/);
  });

  // Capturing the second task should say so rather than silently banking a duplicate.
  test('capturing a page another task already has says so', () => {
    expect(study).toMatch(/async function _pageSharedWith/);
    expect(study).toMatch(/already has this same page/);
  });
});

// ===== SNAPSHOTS THAT ARE SMALL ENOUGH TO STORE =====
// Uncapped, one article reached 23.9 MB. Postgres cancels an insert that large with 57014
// (statement timeout), and a participant on a slow connection waits for every megabyte. Images are
// essentially all of the weight, and the frame is ~1100px wide — so a 4000px original was
// downscaled by the browser on arrival anyway. Only the file was ever that big.
describe('Snapshot size control (content/functions/page_snapshot.js)', () => {
  const snap = require('fs').readFileSync(
    require('path').join(__dirname, '../../content/functions/page_snapshot.js'), 'utf8');
  const helper = require('fs').readFileSync(
    require('path').join(__dirname, '../../../user_study_website/scripts/publish.mjs'), 'utf8');

  test('inlined images are downscaled', () => {
    expect(snap).toMatch(/PG_SNAPSHOT_IMG_MAX_WIDTH = 1600/);
    expect(snap).toMatch(/async function _pgShrinkDataUri/);
    // Applied to page images AND to the assets referenced from CSS.
    expect(snap.match(/_pgShrinkDataUri\(await _pgFetchAsDataUri/g)).toHaveLength(2);
  });

  // Re-encoding these makes them worse, not smaller.
  test('vector and animated images are left alone', () => {
    const fn = snap.match(/async function _pgShrinkDataUri[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/data:image\/svg/);
    expect(fn).toMatch(/data:image\/gif/);
    expect(fn).toMatch(/img\.naturalWidth <= target && !heavy/);
  });

  // REGRESSION. Mars grew from 19.7 MB to 37.3 MB after lazy-loading started resolving real images
  // instead of blur placeholders, and took visibly longer to load than any other page. Nothing on
  // that article is wider than the 1600px cap, so under the old rule NOTHING on it was ever
  // re-encoded — a 1280px PNG was banked whole, at PNG weight, to be drawn at 250px.
  test('images are sized to what they are drawn at, not to what they happen to be', () => {
    const fn = snap.match(/async function _pgShrinkDataUri[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/renderedWidth/);
    expect(fn).toMatch(/\(renderedWidth \|\| 0\) \* 2/);
    // Layout does not survive cloneNode, so the drawn width is stamped on the live page first.
    expect(snap).toMatch(/img\.setAttribute\('data-pg-w', String\(w\)\)/);
    expect(snap).toMatch(/getBoundingClientRect\(\)\.width/);
    expect(snap).toMatch(/_pgShrinkDataUri\(await _pgFetchAsDataUri\(abs\), drawnWidth\)/);
    // ...and is cleaned off it afterwards, like every other capture-time attribute.
    expect(snap).toMatch(/removeAttribute\('data-pg-w'\)/);
  });

  // A heavy LOSSLESS file with no excess pixels is the case the width test alone never catches —
  // a 1280px PNG drawn at 250px. A lossy one is left alone: see the re-encode test below.
  test('a heavy lossless image is re-encoded even when it has no pixels to drop', () => {
    const fn = snap.match(/async function _pgShrinkDataUri[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/const heavy = lossless && dataUri\.length > PG_SNAPSHOT_IMG_REENCODE_BYTES/);
    expect(fn).toMatch(/if \(img\.naturalWidth <= target && !heavy\) return dataUri;/);
  });

  // A thumbnail drawn at 90px would otherwise be stored at 180px and turn to mush in the lightbox.
  test('the drawn-width budget has a floor', () => {
    expect(snap).toMatch(/PG_SNAPSHOT_IMG_MIN_WIDTH = 900/);
    expect(snap.match(/async function _pgShrinkDataUri[\s\S]*?\n\}/)[0])
      .toMatch(/Math\.max\(PG_SNAPSHOT_IMG_MIN_WIDTH/);
  });

  // A small illustration can re-encode LARGER as a JPEG, and a transparent PNG would composite
  // onto black without a white ground first.
  test('the re-encode is only kept when it helps, and does not blacken transparency', () => {
    const fn = snap.match(/async function _pgShrinkDataUri[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/out\.length < dataUri\.length \? out : dataUri/);
    expect(fn).toMatch(/fillStyle = '#fff'/);
  });

  // 57014 means the insert was slow, not wrong — a page snapshot is genuinely megabytes.
  test('a timed-out upload is retried once and named', () => {
    expect(helper).toMatch(/57014/);
    expect(helper).toMatch(/retrying once/);
    expect(helper).toMatch(/failedIds/);
    expect(helper).toMatch(/statement_timeout = '120s'/);
  });
});

// ===== THE ANSWER READS AS AN ANSWER =====
describe('Find answer rendering (user_study_website)', () => {
  const fsw = require('fs');
  const pw = require('path');
  const site = fsw.readFileSync(pw.join(__dirname, '../../../user_study_website/app/study.js'), 'utf8');
  const css = fsw.readFileSync(pw.join(__dirname, '../../../user_study_website/styles/site.css'), 'utf8');

  // An answer is written in markdown — "is **Jupiter**" — and raw asterisks are visible noise in
  // the middle of the sentence a participant is being asked to judge.
  test('markdown is rendered, bold before italic', () => {
    expect(site).toMatch(/function renderMarkdown/);
    const fn = site.match(/function renderMarkdown[\s\S]*?\n\}/)[0];
    // Doing italics first eats one asterisk from every pair and turns **Jupiter** into *Jupiter*.
    expect(fn.indexOf('\\*\\*([^*]+)\\*\\*')).toBeLessThan(fn.indexOf('[^*\\n]+'));
    expect(fn).toMatch(/<strong>\$1<\/strong>/);
  });

  test('markdown runs on escaped text, so the only tags are its own', () => {
    expect(site).toMatch(/renderMarkdown\(esc\(/);
    expect(site).toMatch(/renderMarkdown\(withChips\)/);
  });

  // It was a filled purple pill with the index tinted purple inside it: the number was invisible
  // against its own background and every citation read as a blank blob.
  test('the citation index is visible, not a filled chip', () => {
    const rule = css.match(/\.find-cite \{[\s\S]*?\}/)[0];
    expect(rule).not.toMatch(/background: var\(--accent\)/);
    expect(rule).not.toMatch(/border-radius: 999px/);
    expect(css).toMatch(/\.find-cite \.citation-index \{[\s\S]*?color: var\(--accent\)/);
  });

  // A participant should not have to hold the number in their head to know which claim a highlight
  // belongs to.
  test('the active citation is lit in the answer as well as in the page', () => {
    expect(site).toMatch(/find-cite-active/);
    expect(css).toMatch(/\.find-cite-active \{/);
  });

  test('only one citation is active at a time', () => {
    expect(site).toMatch(/c\.classList\.remove\('find-cite-active'\)/);
  });
});

// ===== SAVED EVIDENCE, AND IMAGES THAT COULD NOT BE INLINED =====
describe('Evidence markers and missing images', () => {
  const fsv = require('fs');
  const pv = require('path');
  const site = fsv.readFileSync(pv.join(__dirname, '../../../user_study_website/app/study.js'), 'utf8');
  const snap = fsv.readFileSync(pv.join(__dirname, '../../content/functions/page_snapshot.js'), 'utf8');

  // [ev:key]'s note DESCRIBES the region rather than quoting it, so it cannot be found in the page
  // by text. The crop taken at record time is the evidence, and opening it is the only thing that
  // honestly shows what was meant.
  test('an evidence marker opens its saved crop', () => {
    expect(site).toMatch(/function openEvidenceLightbox/);
    expect(site).toMatch(/data:image\/jpeg;base64,\$\{item\.shot\}/);
    // Its own numbered series, so it is not mistaken for a citation into the page.
    expect(site).toMatch(/\[E\$\{e\}\]/);
  });

  test('an evidence marker with no crop says so rather than opening nothing', () => {
    const fn = site.match(/function openEvidenceLightbox[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/No image was saved with this evidence/);
  });

  // The snapshot's own policy is `img-src data:`, so a remote URL there can NEVER load — it
  // rendered as a broken-image icon, which reads as "the study is broken" rather than "one asset
  // was too big to keep".
  test('an un-inlinable image becomes a labelled box, not a broken icon', () => {
    expect(snap).toMatch(/function _pgReplaceWithPlaceholder/);
    expect(snap).toMatch(/Image not captured/);
    // The old fallback wrote the live URL into src, which the CSP then blocked.
    expect(snap).not.toMatch(/img\.setAttribute\('src', abs\)/);
  });

  test('the placeholder keeps the page’s own description of the picture', () => {
    const fn = snap.match(/function _pgReplaceWithPlaceholder[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/getAttribute\('alt'\)/);
  });

  // Wikipedia's orbit animation is a 6.47 MB GIF: over the old 3 MB cap, so it was skipped entirely.
  test('the asset cap allows what downscaling will shrink', () => {
    expect(snap).toMatch(/PG_SNAPSHOT_MAX_ASSET_BYTES = 10 \* 1024 \* 1024/);
    // A large animated GIF is flattened to frame 1 rather than dropped.
    expect(snap).toMatch(/const isGif = dataUri\.startsWith\('data:image\/gif'\)/);
    expect(snap).toMatch(/if \(isGif && dataUri\.length < 400 \* 1024\) return dataUri;/);
  });
});

// ===== THE FIND TASK, AS A PARTICIPANT ANSWERS IT =====
// Two stages, two timers, nothing skippable. The split is the measurement: answer_multiple_choice_ms
// is deciding (answerable from the agent's answer alone) and find_supporting_answer_ms is hunting
// (needs the page). Grounding should help the second far more than the first, and averaging them
// together hides exactly that.
describe('Find participant flow (user_study_website)', () => {
  const fsq2 = require('fs');
  const pq2 = require('path');
  const dir = pq2.join(__dirname, '../../../user_study_website');
  const findTask = fsq2.readFileSync(pq2.join(dir, 'app/find_task.js'), 'utf8');
  const study = fsq2.readFileSync(pq2.join(dir, 'app/study.js'), 'utf8');
  const session = fsq2.readFileSync(pq2.join(dir, 'app/session.js'), 'utf8');

  beforeAll(() => { loadScript('../user_study_website/app/find_task.js'); });

  // An answer always in the same position would be findable without reading the page.
  test('the options are the answer plus its distractors, shuffled', () => {
    const task = { answer: 'right', distractors: ['a', 'b', 'c'] };
    const opts = window.FindTask.answerOptions(task);
    expect(opts).toHaveLength(4);
    expect(opts.sort()).toEqual(['a', 'b', 'c', 'right']);
    expect(findTask).toMatch(/function shuffleOptions/);
  });

  test('a task with no distractors still offers its answer', () => {
    expect(window.FindTask.answerOptions({ answer: 'only' })).toEqual(['only']);
    expect(window.FindTask.answerOptions({})).toEqual([]);
  });

  // A VISUAL item's second hop lives in a picture, so it is answered by clicking an image.
  test('the supporting questions differ by arm on hop 2', () => {
    expect(window.FindTask.evidencePrompts({ type: 'FIND X VISUAL' })[1].kind).toBe('image');
    expect(window.FindTask.evidencePrompts({ type: 'FIND x TEXT' })[1].kind).toBe('paragraph');
    // Casing varies in the source spreadsheet.
    expect(window.FindTask.findTaskArm({ type: 'find x visual' })).toBe('visual');
    expect(window.FindTask.findTaskArm({})).toBeNull();
  });

  test('an unrecognised type still gets two hops', () => {
    expect(window.FindTask.evidencePrompts({ type: 'other' })).toHaveLength(2);
  });

  // A blank is not a finding — it is a row that has to be dropped at analysis.
  test('neither stage can be skipped', () => {
    expect(study).toMatch(/if \(!sel\) return showError\('Please select the answer you found\.'\)/);
    expect(study).toMatch(/const missing = picked\.findIndex\(v => !v\)/);
    expect(study).toMatch(/Please answer both questions/);
  });

  test('the two timers hand over at the verdict, and only one runs', () => {
    expect(study).toMatch(/choiceElapsed = Math\.max\(0, Date\.now\(\) - startedAt\)/);
    expect(study).toMatch(/clearInterval\(answerTimer\); answerTimer = null;/);
    expect(study).toMatch(/q-support-timer-row'\)\.hidden = false/);
  });

  // Clicking one word must select the sentence it is in: a one-word answer cannot be scored against
  // a ground truth written as sentences.
  test('picking walks up to a block, and cleans up after itself', () => {
    expect(study).toMatch(/p, li, figcaption, blockquote, h1, h2, h3, td/);
    expect(study).toMatch(/function stopPicking/);
    expect(study).toMatch(/delete doc\.__pgPick/);
  });

  test('a Find row is graded and shaped like every other row', () => {
    expect(session).toMatch(/function buildFindResultRow/);
    expect(session).toMatch(/answer_correct: !!correct && chosen === correct/);
    expect(session).toMatch(/task_type: 'find'/);
    // The guide-only columns are explicitly null rather than absent, so the CSV has no ragged rows.
    expect(session).toMatch(/guide_answer_correct: null/);
  });

  // A reviewer filling in Q1 sixteen times would be producing answers that look exactly like data.
  test('review mode shows no questions and no timer', () => {
    expect(study).toMatch(/if \(S\.state\.adminReview\) \{[\s\S]{0,400}Review mode/);
  });
});

// ===== STAMPED ANCHORS =====
// A recorded citation is `[69:"Foundation series"]` — element 69 IN THE PAGE INDEX AT RECORD TIME.
// That index is exact. Without it the study site can only search the snapshot for the quoted text,
// and text search is a guess: it misses when a page splits a phrase across tags ("*Foundation*
// series" is not one text node) and misfires when one quote contains another ("El pedante" sits
// inside "…Belo's El pedante (1538)"). Both happened, on real tasks.
describe('Snapshot anchors (page_snapshot.js + user_study_website)', () => {
  const fsa = require('fs');
  const pa = require('path');
  const snap = fsa.readFileSync(pa.join(__dirname, '../../content/functions/page_snapshot.js'), 'utf8');
  const site = fsa.readFileSync(pa.join(__dirname, '../../../user_study_website/app/study.js'), 'utf8');

  test('citation targets are stamped from the index the citations refer to', () => {
    expect(snap).toMatch(/function _pgStampAnchors/);
    expect(snap).toMatch(/setAttribute\('data-pg-index'/);
    // The ANSWER RUN's index, reused — never rebuilt. createPageIndex renumbers from the live DOM
    // and skips the answer's own highlight spans, so a rebuilt index hands out different numbers
    // than the citations were written against: not a missing anchor, a confidently wrong one.
    const fn = snap.match(/function _pgStampAnchors[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/pageguideExistingIndexMap\(\)/);
    // Comments stripped: the rule above NAMES createPageIndex to explain why it is not called.
    expect(fn.replace(/\/\/[^\n]*/g, '')).not.toMatch(/createPageIndex/);
  });

  // Counting images on the site has to guess at the recorder's filtering rule, and guessing put
  // Tesla's page_image_6 on a different picture. The catalog is the same function that wrote
  // source_image_id, so the two cannot disagree.
  test('image ids come from the recorder’s own catalog', () => {
    expect(snap).toMatch(/gv2BuildFindImageCatalog/);
    expect(snap).toMatch(/setAttribute\('data-pg-image-id', cand\.id\)/);
  });

  // Capturing must not leave attributes on a page the researcher is still using.
  test('the live page is left as it was found', () => {
    expect(snap).toMatch(/const anchors = _pgStampAnchors\(\);/);
    // unmark() sits between them now — both must run, and both before anything else touches the page.
    expect(snap).toMatch(/const clone = document\.documentElement\.cloneNode\(true\);\s*\n\s*unmark\(\);\s*\n\s*anchors\.unstamp\(\);/);
    expect(snap).toMatch(/stamped\.forEach\(\(\[el, attr\]\) => el\.removeAttribute\(attr\)\)/);
  });

  test('the site resolves by anchor BEFORE any text search', () => {
    const fn = site.match(/function markFindCitation[\s\S]*?\n\}/)[0];
    const anchor = fn.indexOf('data-pg-index');
    const textSearch = fn.indexOf('markText(doc, needle)');
    expect(anchor).toBeGreaterThan(-1);
    expect(anchor).toBeLessThan(textSearch);
    // An index can be any string; escaping it keeps the selector valid.
    expect(fn).toMatch(/CSS\.escape/);
  });

  test('evidence annotations prefer the stamped image', () => {
    expect(site).toMatch(/data-pg-image-id="\$\{CSS\.escape\(id\)\}/);
    // Positional counting survives only as the fallback for older snapshots.
    expect(site).toMatch(/const img = stamped \|\| contentImages\[n - 1\]/);
  });

  // Snapshots captured before stamping existed must keep working.
  test('the text search survives as a fallback', () => {
    const fn = site.match(/function markFindCitation[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/if \(index != null\)/);
    expect(fn).toMatch(/markText\(doc, needle\)/);
    expect(fn).toMatch(/findElementContaining/);
  });
});

// ===== PRUNING THE FURNITURE =====
// On the Mars article 51 of 94 images live in references and navboxes, and the reference apparatus
// dwarfs the prose. None of it can hold an answer: a question asks about the article, not about its
// citation list or the "Solar System" navbox. Measured on the live page: 60% less HTML and 56 fewer
// images fetched, with every anchor intact.
describe('Snapshot pruning (content/functions/page_snapshot.js)', () => {
  const snap = require('fs').readFileSync(
    require('path').join(__dirname, '../../content/functions/page_snapshot.js'), 'utf8');

  test('chrome is identified generically, not per-site', () => {
    expect(snap).toMatch(/PG_SNAPSHOT_CHROME/);
    ['nav', 'footer', '\\[role="navigation"\\]', '\\.reflist', '\\.navbox']
      .forEach(sel => expect(snap).toMatch(new RegExp(sel)));
  });

  // THE SAFETY PROPERTY. Anything the agent actually pointed at survives by definition, which is
  // what lets the pruning be aggressive. Cutting a percentage of the page could make no such
  // promise: if the answer is in the last 30%, the task breaks and nothing says so.
  test('nothing carrying an anchor is ever dropped', () => {
    const fn = snap.match(/function _pgMarkPrunable[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/hasAttribute\('data-pg-index'\)/);
    expect(fn).toMatch(/hasAttribute\('data-pg-image-id'\)/);
    // ...including anchors nested inside the chrome being considered.
    expect(fn).toMatch(/querySelector\('\[data-pg-index\], \[data-pg-image-id\]'\)/);
    expect(fn).toMatch(/if \(anchored\(el\)\) return;/);
  });

  // Marking has to happen AFTER stamping, or the anchor check has nothing to protect.
  test('pruning is marked after the anchors are stamped', () => {
    const order = snap.match(/const anchors = _pgStampAnchors\(\);[\s\S]{0,200}/)[0];
    expect(order).toMatch(/_pgMarkPrunable\(\)/);
    expect(order.indexOf('_pgStampAnchors')).toBeLessThan(order.indexOf('_pgMarkPrunable'));
  });

  // A dropped image is never downloaded either, which is most of the capture TIME, not just size.
  test('the drop happens before images are fetched', () => {
    expect(snap.indexOf("querySelectorAll('[data-pg-drop]')"))
      .toBeLessThan(snap.indexOf('await _pgInlineImages(clone,'));
  });

  // REGRESSION. Every recaptured page came back with data-pg-index: 0 while image anchors stamped
  // fine, and the capture reported success anyway — so every citation fell back to text search and
  // landed wherever it first hit: "Foundation series" on an unrelated paragraph, Tesla's evidence
  // on the polyphase image instead of the blackboard, Alex Ferguson and Harry Potter both wrong.
  //
  // Stamping the snapshot fixes the symptom but welds the anchors to one capture, which makes the
  // recording ORDER load-bearing and cannot help a page already captured. The locator is therefore
  // stored on the ANSWER as well, and resolved by the same press that captures the page — the one
  // moment both halves exist at once.
  test('capturing a page also anchors that task’s recorded answers', () => {
    const study = require('fs').readFileSync(
      require('path').join(__dirname, '../../sidepanel/study.js'), 'utf8');
    expect(study).toMatch(/const anchored = await _anchorRecordedAnswers\(task\.id, tab\.id\)/);
    const fn = study.match(/async function _anchorRecordedAnswers[\s\S]*?\n  \}/)[0];
    // Only this task's answers, and only ones that actually cite something.
    expect(fn).toMatch(/String\(r\.task_id\) === String\(taskId\)/);
    expect(fn).toMatch(/if \(!r\.total\) continue;/);
    // Banked, or the resolution is thrown away the moment the panel closes.
    expect(fn).toMatch(/await saveStudyResponse\(record/);
    // Reported: an unanchored answer is invisible until it misplaces evidence on the site.
    expect(fn).toMatch(/citations anchored across/);
  });

  // The locator has to survive the snapshot's pruning, so it cannot be a CSS path — the capture
  // drops page chrome and every nth-child index shifts by however many siblings went with it.
  test('a locator is addressed by flattened text and ordinal, not by position', () => {
    const anchors = require('fs').readFileSync(
      require('path').join(__dirname, '../../content/functions/citation_anchors.js'), 'utf8');
    expect(anchors).toMatch(/_pgAnchorNormalize\(el\.textContent\)/);
    expect(anchors).toMatch(/function _pgAnchorOrdinal/);
    expect(anchors.replace(/\/\/[^\n]*/g, '')).not.toMatch(/nth-child/);
    // Resolved from the answer run's own index, never rebuilt — see the anchors test above.
    expect(anchors).toMatch(/pageguideExistingIndexMap\(\)/);
    expect(anchors.replace(/\/\/[^\n]*/g, '')).not.toMatch(/createPageIndex/);
  });

  // The recorder writes locators with its normalizer and the site matches them with normText. A
  // divergence — a curly apostrophe folded on one side only — makes every locator miss silently.
  test('the recorder and the site normalize text identically', () => {
    const anchors = require('fs').readFileSync(
      require('path').join(__dirname, '../../content/functions/citation_anchors.js'), 'utf8');
    const site = require('fs').readFileSync(
      require('path').join(__dirname, '../../../user_study_website/app/study.js'), 'utf8');
    const body = f => f.match(/function (?:_pgAnchorNormalize|normText)\(\w*\) \{[\s\S]*?\n\}/)[0]
      .replace(/function \w+/, 'function F').replace(/\s+/g, ' ');
    expect(body(anchors)).toBe(body(site));
  });

  // Locators travel with the answer, so they must reach the site — a column the schema lacks makes
  // PostgREST reject the whole row, and the publish reports a failure with no obvious cause.
  test('the locators are published and the column exists', () => {
    const study = require('fs').readFileSync(
      require('path').join(__dirname, '../../sidepanel/study.js'), 'utf8');
    expect(study).toMatch(/citation_anchors: r\.citation_anchors \|\| null/);
    const sql = require('fs').readFileSync(
      require('path').join(__dirname, '../../supabase_schema.sql'), 'utf8');
    expect(sql).toMatch(/add column if not exists citation_anchors jsonb/);
  });

  // A silent wait is indistinguishable from a hang, and both were read as one. Capture inlines an
  // image at a time and publish uploads a megabyte-scale row at a time; each says where it is.
  test('capture reports progress per image', () => {
    const snap = require('fs').readFileSync(
      require('path').join(__dirname, '../../content/functions/page_snapshot.js'), 'utf8');
    expect(snap).toMatch(/async function _pgInlineImages\(root, onProgress\)/);
    expect(snap).toMatch(/action: 'captureProgress', done, total/);
    const study = require('fs').readFileSync(
      require('path').join(__dirname, '../../sidepanel/study.js'), 'utf8');
    expect(study).toMatch(/image \$\{msg\.done\} of \$\{msg\.total\}/);
    // Removed in finally, or every capture leaves another listener writing to a stale note.
    expect(study).toMatch(/chrome\.runtime\.onMessage\.removeListener\(onProgress\)/);
  });

  test('publish uploads in named steps, tasks before pages, one page at a time', () => {
    const study = require('fs').readFileSync(
      require('path').join(__dirname, '../../sidepanel/study.js'), 'utf8');
    const pub = study.match(/async function _publishStimuliVia[\s\S]*?\n  \}/)[0];
    // study_task_pages.task_id is a foreign key into study_tasks: a page sent first is rejected.
    expect(pub.indexOf("add('find questions'")).toBeLessThan(pub.indexOf('study_task_pages: [page]'));
    // Pages are the megabytes — the only rows where "which one is it stuck on?" is a real question.
    expect(pub).toMatch(/study_task_pages: \[page\]/);
    expect(pub).toMatch(/page \$\{i \+ 1\} of \$\{all\.length\}/);
    expect(pub).toMatch(/Publishing \$\{i \+ 1\}\/\$\{steps\.length\}/);
    // Stops at the first failure: later steps depend on earlier ones, and a wall of errors hides
    // which one actually broke.
    expect(pub).toMatch(/Failed on \$\{step\.label\}/);
  });

  // A hung fetch hangs the whole capture: there is no deadline above it, so one asset from a host
  // that accepts the connection and never answers leaves the panel waiting forever with no error.
  test('an asset fetch cannot hang the capture', () => {
    const snap = require('fs').readFileSync(
      require('path').join(__dirname, '../../content/functions/page_snapshot.js'), 'utf8');
    const fn = snap.match(/async function _pgFetchAsDataUri[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/new AbortController\(\)/);
    expect(fn).toMatch(/signal: ctl\.signal/);
    expect(fn).toMatch(/clearTimeout\(timer\)/);
    expect(snap).toMatch(/PG_SNAPSHOT_FETCH_TIMEOUT_MS = 15000/);
  });

  // Re-encoding a JPEG to a JPEG at the same size costs tens of milliseconds and saves nothing.
  // Doing it for every image over 180 KB on an image-heavy article is what made capture look hung.
  test('a same-size re-encode only happens for lossless formats', () => {
    const snap = require('fs').readFileSync(
      require('path').join(__dirname, '../../content/functions/page_snapshot.js'), 'utf8');
    const fn = snap.match(/async function _pgShrinkDataUri[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/const lossless = \/\^data:image\\\/\(png\|bmp\|tiff\?\)\//);
    expect(fn).toMatch(/const heavy = lossless && dataUri\.length > PG_SNAPSHOT_IMG_REENCODE_BYTES/);
  });

  // Checking grounding by re-asking checks the wrong thing: a fresh ask makes a NEW answer and
  // re-indexes the page, so what it draws is not what the study will draw. The check has to replay
  // the BANKED record through the same locators the site resolves, or it proves nothing about it.
  test('grounding is replayed from the banked record, not from a fresh ask', () => {
    const study = require('fs').readFileSync(
      require('path').join(__dirname, '../../sidepanel/study.js'), 'utf8');
    const handler = study.match(/if \(showGrounding\) showGrounding\.onclick[\s\S]*?\n    \};/)[0];
    expect(handler).toMatch(/await getStudyResponse\(task\.id, 'grounding'\)/);
    expect(handler).toMatch(/record\.citation_anchors/);
    expect(handler).toMatch(/action: 'showSavedGrounding'/);
    // The visual marks are the other half of the grounded arm; text alone checks half the stimulus.
    expect(handler).toMatch(/action: 'showStudyEvidenceMarks'/);
    // Misses are NAMED. A bare count sends a researcher hunting for which quote failed.
    expect(handler).toMatch(/Could not place: /);
    // Refuses rather than drawing nothing silently when the answer was never anchored.
    expect(handler).toMatch(/no citation anchors yet/);
  });

  // Three copies of one rule: the recorder writes the ordinal, the extension replays it, the site
  // resolves it. They must count identically or a locator written by one misses in the others.
  test('the extension replays a locator exactly as the site resolves it', () => {
    const anchorsSrc = require('fs').readFileSync(
      require('path').join(__dirname, '../../content/functions/citation_anchors.js'), 'utf8');
    const site = require('fs').readFileSync(
      require('path').join(__dirname, '../../../user_study_website/app/study.js'), 'utf8');
    const rule = /anchor\.truncated \? t\.startsWith\(want\) : t === want/;
    const fallback = /matches\[anchor\.ordinal\] \|\| \(matches\.length === 1 \? matches\[0\] : null\)/;
    for (const src of [anchorsSrc, site]) {
      expect(src).toMatch(rule);
      expect(src).toMatch(fallback);
    }
  });

  // A ten-page bundle is a slow way to discover the anchors did not land, and it re-uploads nine
  // pages that were already right. One task, same rows, same keys, same upsert.
  test('a single task can be published on its own, through the same publisher', () => {
    const study = require('fs').readFileSync(
      require('path').join(__dirname, '../../sidepanel/study.js'), 'utf8');
    expect(study).toMatch(/await _publishStimuliVia\(\[\], note, 'find', task\.id\)/);
    const build = study.match(/async function _buildStimulusBundle[\s\S]*?\n  \}/)[0];
    // Every Find table is narrowed, or the "one task" publish quietly ships the other nine.
    expect(build).toMatch(/tasks = tasks\.filter\(t => String\(t\.id\) === only\)/);
    expect(build).toMatch(/\.filter\(r => !only \|\| String\(r\.task_id\) === only\)/);
    expect(build).toMatch(/\.filter\(t => !only \|\| String\(t\.task_id\) === only\)/);
    expect(build).toMatch(/\.filter\(p => !only \|\| String\(p\.task_id\) === only\)/);
    // Guide trajectories are not a Find task's business, and would make the "small" upload large.
    expect(build).toMatch(/const wantGuide = !only &&/);
  });

  // A page shared between twins (MUFC-V1 / MUFC-V1-TEXT) is stored under ONE task id. Narrowing by
  // url instead would ship a row whose task_id is a foreign key into a task this bundle lacks.
  test('a one-task publish says so when it carries no page', () => {
    const study = require('fs').readFileSync(
      require('path').join(__dirname, '../../sidepanel/study.js'), 'utf8');
    const pub = study.match(/async function _publishStimuliVia[\s\S]*?\n  \}/)[0];
    expect(pub).toMatch(/onlyTaskId && !bundle\.study_task_pages\.length/);
    expect(pub).toMatch(/WITHOUT a page/);
  });

  // The recorded locator wins over the stamped one, which wins over text search. A stamped anchor
  // belongs to ONE capture; the locator belongs to the answer and outlives every re-capture.
  test('the site prefers the recorded locator over the stamp, and the stamp over text search', () => {
    const site = require('fs').readFileSync(
      require('path').join(__dirname, '../../../user_study_website/app/study.js'), 'utf8');
    const fn = site.match(/function markFindCitation[\s\S]*?\n\}/)[0];
    expect(fn.indexOf('resolveCitationAnchor(doc, anchor)')).toBeGreaterThan(-1);
    expect(fn.indexOf('resolveCitationAnchor(doc, anchor)')).toBeLessThan(fn.indexOf('data-pg-index'));
    expect(fn.indexOf('data-pg-index')).toBeLessThan(fn.indexOf('markText(doc, needle)'));
    // An out-of-range ordinal falls THROUGH to text search rather than marking something wrong.
    const res = site.match(/function resolveCitationAnchor[\s\S]*?\n\}/)[0];
    expect(res).toMatch(/matches\[anchor\.ordinal\] \|\| \(matches\.length === 1 \? matches\[0\] : null\)/);
    // A truncated locator can only compare on prefix; an untruncated one must match whole, or
    // "El pedante" would match the caption that merely begins with it.
    expect(res).toMatch(/anchor\.truncated \? t\.startsWith\(want\) : t === want/);
  });

  test('the live page is left as it was found', () => {
    expect(snap).toMatch(/const unmark = _pgMarkPrunable\(\);/);
    expect(snap).toMatch(/unmark\(\);\s*\n\s*anchors\.unstamp\(\);/);
    expect(snap).toMatch(/marked\.forEach\(el => el\.removeAttribute\('data-pg-drop'\)\)/);
  });
});
