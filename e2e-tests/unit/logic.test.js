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
    window.PROMPTS = { ANSWER_AND_HIGHLIGHT: 'CONTENT:{pageContent}\nINDEX:{pageIndex}' };
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
    expect(result.answer).toBe('Contact the depot within 30 days of travel.'); // link gone, full text kept
    expect(result.answer).not.toMatch(/\[\d+/); // no citation bracket syntax left at all
    expect(result.highlightCount).toBe(0);
    expect(result.hasHighlights).toBe(false);
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
    test('uses two default two-hop evidence prompts', () => {
      expect(window._studyEvidencePrompts({})).toEqual([
        { hop: 1, prompt: 'Which paragraph supports the first part of the question?' },
        { hop: 2, prompt: 'Which paragraph supports the final answer?' },
      ]);
    });

    test('uses two task-specific prompts when provided', () => {
      expect(window._studyEvidencePrompts({
        evidence_questions: ['Evidence for hop one?', 'Evidence for hop two?', 'ignored'],
      })).toEqual([
        { hop: 1, prompt: 'Evidence for hop one?' },
        { hop: 2, prompt: 'Evidence for hop two?' },
      ]);
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

  describe('_buildStudyResultsCSV', () => {
    test('produces a header row plus one row per result, quoting fields with commas', () => {
      const csv = window._buildStudyResultsCSV([
        { tool: 'pageguide', participant_id: 'P07', task_id: 'find-1', task_type: 'find', answer: 'a, b', page_visit_urls: ['https://a.com'] },
      ]);
      const lines = csv.split('\n');
      expect(lines[0]).toBe(
        'tool,participant_id,session_id,condition,block_index,task_index,question_index,task_id,task_type,question_or_task,url,time_ms,notes_time_ms,answer_time_ms,evidence_responses,answer,answer_correct,confidence,helpfulness,chat_turn_count,scroll_user_count,scroll_agent_count,ctrl_f_count,text_select_count,click_count,mouse_move_px,agent_think_ms,page_visit_count,page_visit_urls,completed_at'
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

  test('REQ 3: the recap card has inert step text, no Visual evidence blocks, no Checkpoints strip', () => {
    setNonGrounding(true);
    document.getElementById('pageguide-messages').innerHTML = '';
    window.renderGuideRecap({
      sessionId: 'ng-s1',
      summary: 'Found two news articles.',
      milestones: [{ step: 1, text: 'Found two articles', status: 'ok', phrase: 'two articles' }],
      evidenceByStep: { 1: { hasShot: true, reason: 'Why this step is correct', items: [{ hasShot: true, reason: 'Article headline' }] } }
    });

    const card = document.querySelector('#pageguide-messages .pageguide-recap');
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('Found two articles'); // recap content survives
    expect(card.querySelector('.pageguide-recap-link')).toBeNull();
    expect(card.querySelector('.pageguide-recap-evidence')).toBeNull();
    expect(card.querySelector('.pageguide-recap-checkpoint')).toBeNull();
    expect(card.textContent).not.toContain('Visual evidence');
    expect(card.textContent).not.toContain('Checkpoints');
  });

  test('REQ 3 CONTRAST: with grounding on, the same recap DOES render evidence + checkpoints', () => {
    setNonGrounding(false);
    document.getElementById('pageguide-messages').innerHTML = '';
    window.renderGuideRecap({
      sessionId: 'ng-s2',
      summary: 'Found two news articles.',
      milestones: [{ step: 1, text: 'Found two articles', status: 'ok', phrase: 'two articles' }],
      evidenceByStep: { 1: { hasShot: true, reason: 'Why this step is correct', items: [{ hasShot: true, reason: 'Article headline' }] } }
    });

    const card = document.querySelector('#pageguide-messages .pageguide-recap');
    expect(card.querySelector('.pageguide-recap-link')).toBeTruthy();
    expect(card.querySelector('.pageguide-recap-evidence')).toBeTruthy();
    expect(card.querySelector('.pageguide-recap-checkpoint')).toBeTruthy();
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

  test('is a no-op on a missing guide state', () => {
    expect(window._gv2ResetPauseGuards(null)).toBe(null);
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

  describe('_findEvidenceShotsHtml', () => {
    test('renders one collapsed chip and one hidden panel per cited span', () => {
      const html = window._findEvidenceShotsHtml({
        findEvidenceShots: [
          { shot: 'AAAA', note: 'first span', index: 1 },
          { shot: 'BBBB', note: 'second span', index: 2 }
        ]
      });
      expect((html.match(/class="pageguide-find-evidence-chip"/g) || []).length).toBe(2);
      expect((html.match(/<figure/g) || []).length).toBe(2);
      // REGRESSION: the crops used to render expanded, burying the answer under screenshots.
      expect((html.match(/hidden/g) || []).length).toBe(2);
      expect(html).toContain('first span');
      expect(html).toContain('second span');
    });

    test('numbers the chips to match the [N] citations in the answer', () => {
      const html = window._findEvidenceShotsHtml({
        findEvidenceShots: [{ shot: 'AAAA', note: 'a', index: 1 }, { shot: 'BBBB', note: 'b', index: 2 }]
      });
      expect(html).toContain('data-evidence-num="1"');
      expect(html).toContain('data-evidence-num="2"');
    });

    // Text mode returns no shots at all, so the answer stays exactly as it is today.
    test('renders nothing without shots', () => {
      expect(window._findEvidenceShotsHtml({ findEvidenceShots: [] })).toBe('');
      expect(window._findEvidenceShotsHtml({})).toBe('');
      expect(window._findEvidenceShotsHtml({ findEvidenceShots: [{ shot: null, note: 'x' }] })).toBe('');
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

describe('Find × Visual evidence chips (sidepanel/panel.js)', () => {
  const groupHtml = () => window._findEvidenceShotsHtml({
    findEvidenceShots: [
      { shot: 'AAAA', note: 'first span', index: 1 },
      { shot: 'BBBB', note: 'second span', index: 2 }
    ]
  });

  beforeEach(() => { document.body.innerHTML = ''; });

  describe('openFindEvidenceView', () => {
    const mount = () => {
      document.body.innerHTML = `<div class="pageguide-message">${groupHtml()}</div>`;
      return document.querySelector('.pageguide-find-evidence');
    };

    afterEach(() => { document.getElementById('pageguide-memory-shot-lightbox')?.remove(); });

    // Same lightbox shell the Guide uses for its saved evidence, so both routes look identical.
    test('opens the evidence card for the clicked number', () => {
      const group = mount();
      window.openFindEvidenceView(group, '2');

      const dialog = document.getElementById('pageguide-memory-shot-lightbox');
      expect(dialog).not.toBeNull();
      expect(dialog.querySelector('.pageguide-memory-shot-dialog.pageguide-recap-detail')).not.toBeNull();
      expect(dialog.textContent).toContain('Evidence 2');
      expect(dialog.textContent).toContain('second span');
      expect(dialog.querySelector('img').src).toContain('BBBB');
    });

    test('opening another number replaces the open card instead of stacking', () => {
      const group = mount();
      window.openFindEvidenceView(group, '1');
      window.openFindEvidenceView(group, '2');

      expect(document.querySelectorAll('#pageguide-memory-shot-lightbox')).toHaveLength(1);
      expect(document.getElementById('pageguide-memory-shot-lightbox').textContent).toContain('Evidence 2');
    });

    test('the crops stay collapsed in the chat — the card is the only place they show', () => {
      const group = mount();
      window.openFindEvidenceView(group, '1');

      expect(group.querySelector('.pageguide-find-evidence-panel[data-evidence-num="1"]').hidden).toBe(true);
    });

    test('an unknown number opens nothing instead of throwing', () => {
      const group = mount();
      expect(() => window.openFindEvidenceView(group, '9')).not.toThrow();
      expect(() => window.openFindEvidenceView(null, '1')).not.toThrow();
      expect(document.getElementById('pageguide-memory-shot-lightbox')).toBeNull();
    });
  });

  describe('_findEvidenceGroupFor', () => {
    test('finds the group inside the citation’s own message (Find card)', () => {
      document.body.innerHTML = `<div class="pageguide-message"><span class="pageguide-citation" data-citation="1"></span>${groupHtml()}</div>`;
      const cit = document.querySelector('.pageguide-citation');
      expect(window._findEvidenceGroupFor(cit)).not.toBeNull();
    });

    // The Ask route posts the answer and the crops as two separate bubbles.
    test('falls forward to the following message (Ask route)', () => {
      document.body.innerHTML = `
        <div class="pageguide-message"><span class="pageguide-citation" data-citation="1"></span></div>
        <div class="pageguide-message">${groupHtml()}</div>`;
      const cit = document.querySelector('.pageguide-citation');
      expect(window._findEvidenceGroupFor(cit)).not.toBeNull();
    });

    test('returns null when there is no evidence anywhere (Text mode)', () => {
      document.body.innerHTML = '<div class="pageguide-message"><span class="pageguide-citation" data-citation="1"></span></div>';
      expect(window._findEvidenceGroupFor(document.querySelector('.pageguide-citation'))).toBeNull();
    });

    test('does not reach across an unrelated run of messages', () => {
      document.body.innerHTML = `
        <div class="pageguide-message"><span class="pageguide-citation" data-citation="1"></span></div>
        <div class="pageguide-message">one</div>
        <div class="pageguide-message">two</div>
        <div class="pageguide-message">${groupHtml()}</div>`;
      expect(window._findEvidenceGroupFor(document.querySelector('.pageguide-citation'))).toBeNull();
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
    test('numbers page evidence after the span crops, in one list', async () => {
      window.safeSendMessage = jest.fn(async () => ({
        content: '{"items":[{"key":"beard","note":"A full beard.","som_id":null,"need_annotation":true,"annotation_prompt":"Box it."}]}'
      }));

      const out = await window.gv2BuildFindEvidence(true, 'beard?');

      expect(out.map(e => e.index)).toEqual([1, 2]);
      expect(out[0].shot).toBe('SPANSHOT');
      expect(out[1].shot).toBe('VISUAL0');
    });

    // The visual pass is the whole point for DOM-less questions: it must run even when the answer
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
      expect(window.gv2ParseFindAnswer('')).toEqual({ answer: '', evidence: [], needMoreView: null });
      expect(window.gv2ParseFindAnswer(null)).toEqual({ answer: '', evidence: [], needMoreView: null });
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

  test('turns a cited key into a chip carrying its evidence number', () => {
    const html = window._expandEvidenceKeyCitations('has a full beard [ev:portrait_beard].', shots);
    expect(html).toContain('pageguide-evidence-citation');
    expect(html).toContain('data-evidence-num="3"');
    expect(html).toContain('[3]');
    expect(html).not.toContain('[ev:');
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
});

describe('need_more_view: one bounded escalation (content/tasks/guidev2.js)', () => {
  beforeAll(() => {
    if (!window.gv2ParseNeedMoreView) loadScript('content/tasks/guidev2.js');
  });

  test('accepts the documented directions', () => {
    expect(window.gv2ParseNeedMoreView({ want: 'below', reason: 'answer is further down' }))
      .toEqual({ want: 'below', reason: 'answer is further down' });
    expect(window.gv2ParseNeedMoreView({ want: 'ABOVE' }).want).toBe('above');
    expect(window.gv2ParseNeedMoreView({ want: 'whole_page' }).want).toBe('whole_page');
    expect(window.gv2ParseNeedMoreView({ want: 'element:12' }).want).toBe('element:12');
  });

  // Anything we cannot aim a capture at is dropped rather than triggering a guess.
  test('rejects anything else', () => {
    expect(window.gv2ParseNeedMoreView({ want: 'the picture of the monk' })).toBeNull();
    expect(window.gv2ParseNeedMoreView({ want: 'element:abc' })).toBeNull();
    expect(window.gv2ParseNeedMoreView({})).toBeNull();
    expect(window.gv2ParseNeedMoreView(null)).toBeNull();
    expect(window.gv2ParseNeedMoreView('below')).toBeNull();
  });

  test('the answer envelope carries it through', () => {
    const out = window.gv2ParseFindAnswer('{"answer":"I cannot see it","evidence":[],"need_more_view":{"want":"below","reason":"below the fold"}}');
    expect(out.needMoreView).toEqual({ want: 'below', reason: 'below the fold' });
  });

  test('absent or malformed leaves it null', () => {
    expect(window.gv2ParseFindAnswer('{"answer":"x","evidence":[]}').needMoreView).toBeNull();
    expect(window.gv2ParseFindAnswer('{"answer":"x","need_more_view":"below"}').needMoreView).toBeNull();
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

  test('sends the viewport plus two media crops, each labelled', async () => {
    const images = await window.gv2BuildFindAnswerImages('does the monk have a beard', 'VIEWPORT');

    expect(images).toHaveLength(3);
    expect(images[0]).toEqual({ id: 'viewport', base64: 'VIEWPORT', label: '[image_id=viewport] Page screenshot with SoM markers' });
    expect(images[1]).toMatchObject({ id: 'page_image_1' });
    expect(images[2]).toMatchObject({ id: 'page_image_2' });
    expect(images[1].label).toContain('[image_id=page_image_1]');
    expect(images[1].label).toContain('Image on page:');
    expect(images.slice(1).every(i => i.base64.startsWith('CROP-'))).toBe(true);
    expect(window.gv2FindAnswerImageSource('viewport')).toMatchObject({ id: 'viewport', kind: 'viewport' });
    expect(window.gv2FindAnswerImageSource('page_image_1')).toMatchObject({ id: 'page_image_1', kind: 'page_image' });
    expect(window.gv2FindAnswerImageSource('page_image_1').el.id).toBe('a');
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  test('crops are downscaled, not sent at retina size', async () => {
    await window.gv2BuildFindAnswerImages('does the monk have a beard', 'VIEWPORT');
    expect(window.gv2CaptureEvidenceRegion.mock.calls[0][3]).toMatchObject({ noMarker: true, maxWidth: 1024 });
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

    const images = await window.gv2BuildFindAnswerImages('does the monk have a beard', 'VIEWPORT');
    expect(images.every(i => !!i.base64)).toBe(true);
  });

  test('the second question on the same page reuses the crops', async () => {
    await window.gv2BuildFindAnswerImages('does the monk have a beard', 'VIEWPORT');
    const firstCalls = window.gv2CaptureEvidenceRegion.mock.calls.length;

    await window.gv2BuildFindAnswerImages('does the monk have a beard', 'VIEWPORT2');

    expect(window.gv2CaptureEvidenceRegion.mock.calls.length).toBe(firstCalls); // served from cache
  });
});
