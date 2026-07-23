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
        session: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}), remove: jest.fn(async () => {}) }
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
    window.PROMPTS = { ANSWER_AND_HIGHLIGHT: 'CONTENT:{pageContent}\nINDEX:{pageIndex}' };
    // guidev2.js calls gv2ParseFindResponse/gv2StepHasTarget, which utils.js defines — the
    // same order manifest.json loads them in. Load it here so this block stands alone.
    loadScript('content/utils.js');
    loadScript('content/tasks/guidev2.js');
  });

  beforeEach(() => {
    jest.clearAllMocks();
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

    const call = window.safeSendMessage.mock.calls.find(c => c[0]?.metadata?.mode === 'guide_find');
    expect(call).toBeTruthy();
    expect(call[0].messages[0].content).toBe('what to do when I have lost items');
    expect(call[0].systemPrompt).toContain('Lost property. Contact the depot');
  });

  test('falls back to the user goal when the model omits findQuery', async () => {
    await window.gv2ProcessResponse(findStep({ findQuery: null }));

    const call = window.safeSendMessage.mock.calls.find(c => c[0]?.metadata?.mode === 'guide_find');
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
        getPlatformInfo: jest.fn()
      },
      tabs: {
        onCreated: { addListener: jest.fn() },
        get: jest.fn(),
        query: jest.fn(),
        captureVisibleTab: jest.fn(),
        sendMessage: jest.fn()
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

  test('REGRESSION: refuses to capture a tab that has lost focus instead of silently grabbing whatever tab is now visible', async () => {
    // chrome.tabs.captureVisibleTab only ever captures the currently-active tab of a window —
    // it can't target tabId directly. If tabId is no longer that window's active tab (the user
    // switched away), capturing would silently return a screenshot of the WRONG tab.
    window.chrome.tabs.get.mockResolvedValue({ id: 7, windowId: 1, active: false });
    const result = await window._doCaptureScreenshot(7, 1);
    expect(result.error).toMatch(/not active/i);
    expect(window.chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  test('captures normally when the target tab is still the active/visible tab', async () => {
    window.chrome.tabs.get.mockResolvedValue({ id: 7, windowId: 1, active: true });
    window.chrome.tabs.captureVisibleTab.mockResolvedValue('data:image/jpeg;base64,AAAA');
    const result = await window._doCaptureScreenshot(7, 1);
    expect(result.success).toBe(true);
    expect(result.imageBase64).toBe('AAAA');
    expect(window.chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(1, { format: 'jpeg', quality: 80 });
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
    'renderGuideFinalAnswer, and renderGuideRecap all reach chatMessages, not just addMessage()', async () => {
    // Before this fix, these five render functions built their own DOM bubble directly and never
    // touched chatMessages, so saveCurrentChat() silently dropped every Guide/Find/Visual-Highlight/
    // Watch-Video answer — only the user's own question (added via addMessage) got saved.
    addMessage('What is the return policy?', 'user');
    window.renderFindAnswer({ findAnswer: 'Returns are accepted within 30 days.' });
    window.renderVisualHighlightAnswer({ visualHighlightImage: 'AAAA', visualHighlightCaption: 'The banner shows free shipping.' });
    window.renderWatchVideoAnswer({ watchVideoAnswer: 'The video explains setup in the first 2 minutes.' });
    await window.renderGuideFinalAnswer({ finalAnswer: 'Task completed: order was placed.' });
    await window.renderGuideRecap({ summary: 'Guide finished after 5 steps.', milestones: [] });
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
      <div id="pageguide-goal" style="display:none;">
        <div class="pageguide-goal-title-row"><div id="pageguide-goal-title"></div></div>
        <div id="pageguide-goal-timeline"></div>
        <div id="pageguide-plan-list" style="display:none;"></div>
        <div id="pageguide-conf-chart" style="display:none;"></div>
      </div>
      <div id="pageguide-step-panel" style="display:none;"></div>
      <div id="pageguide-messages"></div>
      <div id="pageguide-tab-chip" style="display:none;">
        <img id="pageguide-tab-chip-favicon">
        <span id="pageguide-tab-chip-title"></span>
      </div>
    `;
    loadScript('sidepanel/panel.js');
  });

  test('renders one timeline row per step and keeps the list expanded while the guide is working', () => {
    window.addGuideStep({ sessionId: 'timeline-s1', step: 1, planStep: 1, isLastStep: false, instruction: 'Open settings' });
    window.renderGoalCard({ route: 'guide', prompt: 'Test task', step: 1, total: 2, title: 'Test task' });

    const rows = document.querySelectorAll('#pageguide-goal-timeline .pageguide-goal-row');
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.pageguide-goal-row-dot').classList.contains('current')).toBe(true);

    const details = document.querySelector('#pageguide-goal-timeline details');
    expect(details.open).toBe(true);
  });

  test('REGRESSION: auto-collapses the timeline and marks the tab chip done once the guide finishes', () => {
    window.addGuideStep({ sessionId: 'timeline-s1', step: 2, planStep: 2, isLastStep: true, instruction: 'Save changes' });
    window.renderGoalCard({ route: 'guide', step: 2, total: 2 });

    const details = document.querySelector('#pageguide-goal-timeline details');
    expect(details.open).toBe(false);
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
        get: jest.fn(),
        query: jest.fn(),
        captureVisibleTab: jest.fn(),
        sendMessage: jest.fn()
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
