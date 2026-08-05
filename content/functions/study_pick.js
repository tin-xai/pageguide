// PageGuide User Study — pick a sentence off the page
// ===================================================
// The supporting-evidence questions ask which sentence (or which image) carries the answer. Typing
// it out is slow and unreliable to score; a dropdown of every paragraph on the page is worse, since
// it hands the participant the candidate set and lets them recognise the answer instead of finding
// it. So the answer is given by pointing at it: the participant turns on Annotate, hovers the page,
// and clicks the one thing they mean.
//
// One selection at a time, confirmed with Done — a click alone would be too easy to fire by
// accident on a page the participant is also reading and scrolling.
//
// Eligibility deliberately mirrors getStudyParagraphOptions / getStudyImageOptions (content.js):
// what can be pointed at has to be the same set the response is scored against, and the index this
// returns comes from the same createPageIndex numbering the citations use.

// Bumped whenever the picking BEHAVIOUR changes. A content script keeps running across an extension
// reload, so a tab opened before the change silently keeps the old behaviour — which reads as "the
// fix did not work" rather than "this tab is stale". The panel compares this against its own
// constant and says to reload the page.
const PG_STUDY_PICK_VERSION = 9;

const PG_STUDY_PICK_MIN_TEXT = 8;
const PG_STUDY_PICK_MAX_TEXT = 1800;

// Live pick session, or null. Only ever one — a second start replaces the first.
let _pgStudyPick = null;

const PG_STUDY_PICK_TEXT_ROLES = new Set(['paragraph', 'article', 'heading', 'listitem', 'row', 'cell', 'gridcell']);
const PG_STUDY_PICK_TEXT_TAGS = ['p', 'li', 'blockquote', 'td', 'th', 'dd', 'dt', 'figcaption'];

/**
 * PageGuide's OWN injected UI — the panel's overlays, the evidence layer, this picker. Not the same
 * thing as page content PageGuide has drawn on, which is exactly what a pick is usually about.
 */
function _pgStudyPickIsOwnUi(el) {
  return !!el?.closest?.('[id^="pageguide"], .pageguide-study-pick-root, .pageguide-message');
}

/**
 * The text-bearing blocks a 'paragraph' hop may point at, as [element, index] pairs.
 *
 * NOT taken from createPageIndex alone, which is where this went wrong for a long time: that index
 * skips anything isPageGuideElement matches, and that test is `closest('[class*="pageguide"]')` — so
 * the moment PageGuide highlights a paragraph, the paragraph AND everything inside it drop out of
 * the index. Right for keeping PageGuide's own UI out of an agent's element list; fatally wrong
 * here, because "annotate the sentence PageGuide highlighted" is the common case, and the answer was
 * that nothing in a highlighted region could be pointed at at all.
 *
 * So eligibility is decided against the DOM, and the page index is consulted only to attach the
 * number a block already has — which a highlighted block will not, hence `null`. The sentence text
 * is what scores; the index is a convenience for scrollToIndex.
 */
function _pgStudyPickTextTargets() {
  const out = new Map();
  const indexByEl = new Map();
  try {
    // The index the ANSWER cites through, not a fresh one. Rebuilding renumbers the page out from
    // under the citations already on screen (pageguideExistingIndexMap), and a pick happens while
    // those citations are still clickable.
    const existing = typeof pageguideExistingIndexMap === 'function' ? pageguideExistingIndexMap() : null;
    const indexMap = existing
      || (typeof createPageIndex === 'function' ? createPageIndex(5000, false).indexMap : null)
      || {};
    Object.entries(indexMap).forEach(([rawIndex, el]) => {
      const n = parseInt(rawIndex, 10);
      if (el && Number.isFinite(n)) indexByEl.set(el, n);
    });
  } catch (e) { /* an unusable index still leaves every block pickable */ }

  const eligible = (el) => {
    if (!el || _pgStudyPickIsOwnUi(el)) return false;
    const role = typeof getAccessibleRole === 'function' ? getAccessibleRole(el) : null;
    if (!PG_STUDY_PICK_TEXT_ROLES.has(role) && !PG_STUDY_PICK_TEXT_TAGS.includes((el.tagName || '').toLowerCase())) return false;
    const text = _pgStudyPickVisibleText(el);
    return text.length >= PG_STUDY_PICK_MIN_TEXT && text.length <= PG_STUDY_PICK_MAX_TEXT;
  };

  document.querySelectorAll(PG_STUDY_PICK_TEXT_TAGS.join(',')).forEach(el => {
    if (eligible(el)) out.set(el, indexByEl.has(el) ? indexByEl.get(el) : null);
  });
  // Then the role-bearing blocks that are not one of those tags — a div with role="paragraph".
  indexByEl.forEach((n, el) => {
    if (!out.has(el) && eligible(el)) out.set(el, n);
  });
  return out;
}

/**
 * What an 'image' hop may point at: the page's pictures AND their captions, because the question
 * asks for the image's NAME — which is written in the caption, so that is what a participant
 * reaches for. Clicking either records the same words.
 */
function _pgStudyPickImageTargets() {
  const out = new Map();
  if (typeof gv2FindMediaCandidates === 'function') {
    try {
      gv2FindMediaCandidates('', { includeAll: true, limit: Infinity }).forEach((cand, i) => {
        const label = String(cand?.label || '').replace(/\s+/g, ' ').trim();
        if (cand?.el && label) out.set(cand.el, i + 1);
      });
    } catch (e) { /* fall through to captions only */ }
  }
  document.querySelectorAll('figcaption').forEach(el => {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length >= PG_STUDY_PICK_MIN_TEXT) out.set(el, null);
  });
  return out;
}

// ===== REFERENCE MARKERS =====
// A picked sentence is compared against what a participant picked and against the ground truth, so
// it has to be the SENTENCE — not the sentence plus the page's footnote furniture. Wikipedia in
// particular hangs [79], [82][83], [nb 1] off the end of half its clauses, and two people pointing
// at the same words would otherwise record different strings depending on where the markers fell.

/** Whether a text node lives inside a footnote/reference marker rather than in the prose. */
function _pgStudyPickIsRefNode(node) {
  const el = node?.parentElement;
  return !!el?.closest?.('sup.reference, .reference, .mw-ref, .mw-cite-backlink, .noprint, sup[id^="cite_ref"]');
}

/**
 * Tidy a picked string: drop any reference marker the DOM filter did not catch, and close the gap it
 * leaves. Replaced with a SPACE rather than nothing — "the coil.[80] Later" has to come out as
 * "the coil. Later", not "the coil.Later".
 */
function _pgStudyPickCleanText(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\[\s*(?:\d+|nb\s*\d+|[a-z]|citation needed|clarification needed)\s*\]/gi, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The prose inside an element, with reference markers left out. */
function _pgStudyPickVisibleText(el) {
  if (!el) return '';
  if (typeof document === 'undefined' || typeof document.createTreeWalker !== 'function') {
    return _pgStudyPickCleanText(el.textContent || '');
  }
  let out = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!_pgStudyPickIsRefNode(n)) out += n.nodeValue || '';
  }
  return _pgStudyPickCleanText(out);
}

/**
 * What an image pick is recorded as: `Image: <short name>`.
 *
 * A caption is a sentence about a picture — "Mountainous Landscape with a Blasted Oak Tree (1660s)
 * by Jacob van Ruisdael. Courtesy the National Museum of Norway" — and recording all of it as the
 * answer to "which image?" makes two people who picked the SAME picture disagree, because one
 * clicked the picture and one clicked the caption. So an image pick is named, not quoted: the alt
 * text if the page provides one, else the caption's first clause, capped.
 */
function _pgStudyPickImageLabel(el) {
  const img = (el?.tagName === 'IMG') ? el
    : (el?.querySelector?.('img') || el?.closest?.('figure')?.querySelector?.('img') || null);
  const alt = _pgStudyPickCleanText(
    img?.getAttribute?.('alt') || img?.getAttribute?.('aria-label') || img?.getAttribute?.('title') || ''
  );
  const caption = alt || _pgStudyPickVisibleText(el);
  if (!caption) return 'Image';
  // The first clause is the name; what follows is provenance ("Courtesy the National Museum…").
  const firstClause = caption.split(/(?<=[.!?])\s|\s[—–]\s/)[0] || caption;
  const short = firstClause.length > 90 ? `${firstClause.slice(0, 90).trim()}…` : firstClause.trim();
  return `Image: ${short}`;
}

/** The words a picked element stands for: a caption/paragraph's text, an image's own label. */
function _pgStudyPickTextFor(el) {
  const text = _pgStudyPickVisibleText(el);
  if (text) return text;
  const alt = el?.getAttribute?.('alt') || el?.getAttribute?.('aria-label') || el?.getAttribute?.('title') || '';
  return _pgStudyPickCleanText(alt);
}

/** The index of the nearest ancestor that has one, or null. */
function _pgStudyPickNearestIndex(el) {
  const map = typeof pageguideExistingIndexMap === 'function' ? pageguideExistingIndexMap() : null;
  if (!map) return null;
  const byEl = new Map();
  Object.entries(map).forEach(([raw, node]) => {
    const n = parseInt(raw, 10);
    if (node && Number.isFinite(n) && !byEl.has(node)) byEl.set(node, n);
  });
  for (let node = el; node; node = node.parentElement) {
    if (byEl.has(node)) return byEl.get(node);
  }
  return null;
}

/** The nearest pickable ancestor of `node`, or null. */
function _pgStudyPickResolve(node, targets) {
  let el = node;
  for (let hops = 0; el && hops < 12; el = el.parentElement, hops++) {
    if (targets.has(el)) return el;
  }
  return null;
}

// ===== SENTENCE GRANULARITY =====
// The question is "which SENTENCE gives you the answer", so highlighting the whole paragraph is both
// too generous to score and hard to aim: a participant pointing at a five-sentence block has not
// said which claim they mean. So a block is split into sentences and the one under the pointer is
// what gets outlined and recorded.

/**
 * Split a block's text into sentence spans, as {start, end} offsets into that same string. Pure, so
 * the splitting can be tested without layout.
 *
 * Splits after . ! ? … and their trailing quotes/brackets, but NOT after a common abbreviation or an
 * initial ("Dr. Smith", "S. Dutton Whitney"), which would otherwise cut a name in half — these pages
 * are full of them. A block with no sentence punctuation at all is one span, which is right for a
 * heading or a table cell.
 *
 * @param {string} text
 * @returns {Array<{start: number, end: number}>}
 */
function _pgStudyPickSplitSentences(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return [];
  const ABBREV = /(?:^|\s)(?:[A-Z]|Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|e\.g|i\.e|No|Fig|Vol|pp|ca|approx)\.$/;
  const spans = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (!/[.!?…]/.test(s[i])) continue;
    let j = i + 1;
    while (j < s.length && /["'”’)\]]/.test(s[j])) j++;   // take closing quotes/brackets with it
    if (j < s.length && !/\s/.test(s[j])) continue;        // mid-token dot: 1.5, example.com
    if (ABBREV.test(s.slice(start, j))) continue;          // "Dr." / "S." — not a sentence end
    while (j < s.length && /\s/.test(s[j])) j++;           // trailing space belongs to the gap
    if (s.slice(start, j).trim()) spans.push({ start, end: j });
    start = j;
    i = j - 1;
  }
  if (s.slice(start).trim()) spans.push({ start, end: s.length });
  return spans;
}

/**
 * DOM Ranges for each sentence in `el`, so a sentence can be measured and outlined even though it is
 * not an element. Walks the text nodes once, builds the same string _pgStudyPickSplitSentences sees,
 * and maps each span's offsets back to (node, offset) pairs.
 *
 * @returns {Array<{range: Range, text: string}>}
 */
function _pgStudyPickSentenceRanges(el) {
  if (!el || typeof document.createRange !== 'function') return [];
  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const value = n.nodeValue || '';
    // Reference markers are skipped here rather than scrubbed afterwards: leaving them in would let
    // "[80]" end a sentence span, and the recorded text would carry it.
    if (!value || _pgStudyPickIsRefNode(n)) continue;
    nodes.push({ node: n, start: text.length, end: text.length + value.length });
    text += value;
  }
  if (!nodes.length) return [];

  const locate = (offset) => {
    const hit = nodes.find(n => offset >= n.start && offset <= n.end) || nodes[nodes.length - 1];
    return { node: hit.node, offset: Math.max(0, Math.min(offset - hit.start, hit.end - hit.start)) };
  };

  return _pgStudyPickSplitSentences(text).map(span => {
    // Trim the trailing whitespace out of the range, so the outline stops at the full stop rather
    // than running on to the next sentence's first word.
    let end = span.end;
    while (end > span.start && /\s/.test(text[end - 1])) end--;
    const from = locate(span.start);
    const to = locate(end);
    const range = document.createRange();
    try {
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
    } catch (e) {
      return null;
    }
    return { range, text: _pgStudyPickCleanText(text.slice(span.start, end)) };
  }).filter(item => item && item.text);
}

/**
 * The PageGuide highlight under `node`, if it sits inside the block being picked.
 *
 * The agent's own citations are drawn on the page as `span.pageguide-highlight`, and they are
 * frequently the exact phrase a supporting question is about — "which evidence answers this" is
 * often answered by the words the agent already underlined. Without this the smallest thing that
 * could be pointed at was the whole sentence around them.
 *
 * `.pageguide-highlight-block` is deliberately excluded: that class marks a whole ELEMENT tint (a
 * highlighted paragraph), which is already pickable as itself and would otherwise re-introduce
 * paragraph-level picking through the back door.
 */
function _pgStudyPickHighlightAt(node, blockEl) {
  const hl = node?.closest?.('.pageguide-highlight:not(.pageguide-highlight-block)');
  if (!hl || !blockEl || !blockEl.contains(hl)) return null;
  return _pgStudyPickTextFor(hl) ? hl : null;
}

/** Which of `sentences` covers the viewport point, or null when the point is between lines. */
function _pgStudyPickSentenceHit(sentences, x, y) {
  for (const item of sentences || []) {
    const rects = Array.from(item.range.getClientRects());
    if (rects.some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return item;
  }
  return null;
}

/**
 * Every rect a hover target covers, in document coordinates. Ranges and inline elements both wrap
 * across lines, so getClientRects (plural) is what draws an outline that follows the text rather
 * than a single box swallowing the lines around it.
 */
function _pgStudyPickRects(target) {
  const source = target?.range || target?.node || target?.el || null;
  const rects = source
    ? (typeof source.getClientRects === 'function' && source.getClientRects().length
        ? Array.from(source.getClientRects())
        : [source.getBoundingClientRect()])
    : [];
  return rects
    .filter(r => r.width > 0 && r.height > 0)
    .map(r => ({
      top: r.top + window.scrollY,
      left: r.left + window.scrollX,
      width: r.width,
      height: r.height,
      bottom: r.bottom + window.scrollY
    }));
}

/** Redraw the outline: one box per rect, since a wrapped sentence spans several lines. */
function _pgStudyPickDrawBoxes(layer, target, chosen) {
  const rects = _pgStudyPickRects(target);
  layer.innerHTML = rects.map(r =>
    `<div class="pageguide-study-pick-box${chosen ? ' is-chosen' : ''}" style="top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px;"></div>`
  ).join('');
  return rects;
}

function _pgStudyPickPositionBar(bar, rects) {
  const last = rects[rects.length - 1];
  if (!last) return;
  bar.style.top = `${last.bottom + 8}px`;
  bar.style.left = `${Math.max(8, last.left)}px`;
}

/**
 * Enter pick mode. Resolves nothing — the choice comes back to the side panel as a runtime message
 * ('studyPickResult'), since the participant may take as long as they like and a held-open
 * sendMessage channel would not survive that.
 *
 * @param {{hop: number, kind: 'paragraph'|'image', channel?: string}} options - `channel` is echoed
 *   back untouched, so the participant's evidence fields and the researcher's ground-truth panel can
 *   both listen without reading each other's picks.
 */
function pageguideStartStudyPick(options = {}) {
  pageguideCancelStudyPick();
  const kind = options.kind === 'image' ? 'image' : 'paragraph';
  const hop = Number(options.hop) || 1;
  const channel = String(options.channel || 'evidence');
  const targets = kind === 'image' ? _pgStudyPickImageTargets() : _pgStudyPickTextTargets();
  if (!targets.size) return { success: false, version: PG_STUDY_PICK_VERSION, error: 'Nothing on this page can be picked' };

  // Mute PageGuide's own marks for the duration. They are the loudest thing on the page — a tinted
  // paragraph, a pink evidence box — and the pick outline has to compete with them for the reader's
  // eye, which is why picking inside an already-highlighted region read as "nothing is selectable".
  // The page returns to normal the moment the pick ends.
  document.documentElement.classList.add('pageguide-picking');

  const root = document.createElement('div');
  root.className = 'pageguide-study-pick-root';
  root.innerHTML = `
    <div class="pageguide-study-pick-layer"></div>
    <div class="pageguide-study-pick-hint">Hover the page, then click the ${kind === 'image' ? 'image or caption' : 'sentence — or a highlighted phrase'} you mean · Esc to cancel</div>
    <div class="pageguide-study-pick-bar" hidden>
      <span class="pageguide-study-pick-text"></span>
      <button type="button" class="pageguide-study-pick-done">✓ Done</button>
      <button type="button" class="pageguide-study-pick-again">↺ Pick again</button>
    </div>`;
  document.documentElement.appendChild(root);

  const layer = root.querySelector('.pageguide-study-pick-layer');
  const bar = root.querySelector('.pageguide-study-pick-bar');
  const barText = root.querySelector('.pageguide-study-pick-text');
  const hint = root.querySelector('.pageguide-study-pick-hint');

  const state = { root, layer, bar, hovered: null, chosen: null, kind, hop, channel, targets };
  _pgStudyPick = state;

  /**
   * What is under the pointer: the sentence if the block has more than one, else the block itself.
   * An image target is always whole — there are no sentences inside a picture.
   */
  const targetAt = (x, y) => {
    const el = _pgStudyPickResolve(document.elementFromPoint(x, y), targets);
    if (!el) return null;
    // A picture has no sentences inside it, so an image target is always whole.
    if (kind === 'image') return { el, range: null, text: _pgStudyPickImageLabel(el) };

    // The agent's own highlighted phrase, when the pointer is on one: the most specific thing the
    // page offers, and usually the exact evidence the question is about.
    const highlight = _pgStudyPickHighlightAt(document.elementFromPoint(x, y), el);
    if (highlight) return { el, node: highlight, range: null, text: _pgStudyPickTextFor(highlight) };

    const sentences = _pgStudyPickSentenceRanges(el);
    // A block that IS one sentence — a heading, a caption, a one-line cell — is picked whole,
    // because that whole is the sentence.
    if (sentences.length <= 1) {
      return { el, range: sentences[0]?.range || null, text: sentences[0]?.text || _pgStudyPickTextFor(el) };
    }
    // Otherwise only a sentence can be picked. There is deliberately NO fall back to the block:
    // "which sentence gives you the answer" is not answered by pointing at five of them, and an
    // outline that silently widens to the paragraph when the pointer slips between lines is exactly
    // how a paragraph gets recorded by accident.
    const hit = _pgStudyPickSentenceHit(sentences, x, y);
    return hit ? { el, range: hit.range, text: hit.text } : null;
  };

  const onMove = (e) => {
    if (state.chosen) return;
    const target = targetAt(e.clientX, e.clientY);
    state.hovered = target;
    if (!target) { layer.innerHTML = ''; return; }
    _pgStudyPickDrawBoxes(layer, target, false);
  };

  const choose = (target) => {
    state.chosen = target;
    const rects = _pgStudyPickDrawBoxes(layer, target, true);
    barText.textContent = target.text.length > 120 ? `${target.text.slice(0, 120)}…` : target.text;
    bar.hidden = false;
    hint.hidden = true;
    _pgStudyPickPositionBar(bar, rects);
  };

  const onClick = (e) => {
    if (e.target.closest('.pageguide-study-pick-root')) return; // our own controls
    const target = targetAt(e.clientX, e.clientY) || state.hovered;
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    choose(target);
  };

  const onKey = (e) => { if (e.key === 'Escape') pageguideCancelStudyPick(); };

  const onScroll = () => {
    const target = state.chosen || state.hovered;
    if (!target) return;
    const rects = _pgStudyPickDrawBoxes(layer, target, !!state.chosen);
    if (!bar.hidden) _pgStudyPickPositionBar(bar, rects);
  };

  root.querySelector('.pageguide-study-pick-again').addEventListener('click', (e) => {
    e.stopPropagation();
    state.chosen = null;
    layer.innerHTML = '';
    bar.hidden = true;
    hint.hidden = false;
  });

  root.querySelector('.pageguide-study-pick-done').addEventListener('click', (e) => {
    e.stopPropagation();
    const target = state.chosen;
    if (!target) return;
    const payload = {
      action: 'studyPickResult',
      hop: state.hop,
      channel: state.channel,
      kind: state.kind,
      text: target.text,
      // The index is the BLOCK's, even for a sentence inside it: it is what scrollToIndex resolves
      // against, and the sentence text is the finer-grained half of the answer.
      //
      // Falls back to the nearest indexed ANCESTOR when the block itself has no number — which is
      // routine on a page PageGuide has already highlighted, since a highlighted element drops out
      // of the index. A citation written against an unindexed block would resolve to nothing, and
      // the quoted text is searched inside whatever the index points at, so an ancestor works.
      index: targets.get(target.el) ?? _pgStudyPickNearestIndex(target.el),
      // A selector too, because an index is not always there — an image, or a block PageGuide has
      // highlighted — and the panel offers "take me back to what I picked".
      selector: typeof gv2ElementSelector === 'function' ? gv2ElementSelector(target.el) : '',
      url: window.location.href
    };
    pageguideCancelStudyPick();
    try { chrome.runtime.sendMessage(payload); } catch (err) { /* panel closed */ }
  });

  state.listeners = [
    ['mousemove', onMove, true],
    ['click', onClick, true],
    ['keydown', onKey, true],
    ['scroll', onScroll, true],
  ];
  state.listeners.forEach(([type, fn, capture]) => document.addEventListener(type, fn, capture));
  window.addEventListener('resize', onScroll, true);
  state.onResize = onScroll;

  return { success: true, version: PG_STUDY_PICK_VERSION, count: targets.size };
}

function pageguideCancelStudyPick() {
  document.documentElement.classList.remove('pageguide-picking');
  const state = _pgStudyPick;
  if (!state) return { success: true };
  (state.listeners || []).forEach(([type, fn, capture]) => document.removeEventListener(type, fn, capture));
  if (state.onResize) window.removeEventListener('resize', state.onResize, true);
  state.root?.remove();
  _pgStudyPick = null;
  return { success: true };
}

if (typeof window !== 'undefined') {
  window.pageguideStartStudyPick = pageguideStartStudyPick;
  window.pageguideCancelStudyPick = pageguideCancelStudyPick;
  window._pgStudyPickResolve = _pgStudyPickResolve;
  window._pgStudyPickSplitSentences = _pgStudyPickSplitSentences;
  window._pgStudyPickSentenceRanges = _pgStudyPickSentenceRanges;
  window._pgStudyPickSentenceHit = _pgStudyPickSentenceHit;
  window._pgStudyPickHighlightAt = _pgStudyPickHighlightAt;
  window._pgStudyPickCleanText = _pgStudyPickCleanText;
  window._pgStudyPickImageLabel = _pgStudyPickImageLabel;
  window._pgStudyPickNearestIndex = _pgStudyPickNearestIndex;
  window._pgStudyPickVisibleText = _pgStudyPickVisibleText;
  window._pgStudyPickTextFor = _pgStudyPickTextFor;
  window._pgStudyPickImageTargets = _pgStudyPickImageTargets;
  window._pgStudyPickTextTargets = _pgStudyPickTextTargets;
}

console.log('🖍️ study_pick.js loaded');
