// PageGuide — portable citation anchors, resolved where the mapping is known.
// ==========================================================================
// WHAT THIS FIXES. A recorded citation is `[69:"Foundation series"]` — element 69 in the page index
// AT ANSWER TIME. The study site never has that index: it has a snapshot, so all it could do was
// search the snapshot for the quoted text. Text search is a guess, and it guessed wrong in two
// ways that both happened on real tasks:
//
//   • it MISSES when the page splits a phrase across tags — "<i>Foundation</i> series" is not one
//     text node, so the phrase exists on the page and matches nothing;
//   • it MISFIRES when one quote contains another — "El pedante" sits inside "…Belo's El pedante
//     (1538)", and the wrong one wins whenever it comes first.
//
// WHY IT IS DONE HERE AND NOW, rather than at capture time. The number 69 means something only
// while the index that issued it is still installed. It is built by the answer run, it is discarded
// on reload, and it CANNOT BE REBUILT: createPageIndex renumbers from the live DOM and skips the
// answer's own highlight spans (see pageguideExistingIndexMap in utils.js), so a rebuilt index
// hands out different numbers than the citations were written against. So the one moment the
// mapping is knowable is the moment the answer is banked — which is exactly when this runs.
//
// WHY NOT JUST STAMP THE SNAPSHOT. Stamping works, but it welds the anchors to one capture: it
// makes the recording order load-bearing (ask, then capture, same tab, no reload), and it cannot
// help a page that was already captured. A locator stored ON THE RESPONSE travels with the answer
// instead — it resolves against any snapshot of that page, including the ones already published,
// and re-capturing a page can never silently strip the anchors off an answer again.
//
// WHAT A LOCATOR IS. Deliberately not a CSS path: the snapshot drops page chrome (see
// _pgMarkPrunable), so any nth-child path computed on the live page is wrong in the snapshot by
// however many siblings were pruned. It is instead the element's own flattened text, which pruning
// cannot change and tag boundaries do not disturb:
//
//   { index, tag, text, ordinal, len }
//
// `text` is textContent — flattened, so "<i>Foundation</i> series" is simply "Foundation series"
// and the split that defeated text search is gone. `ordinal` disambiguates repeats by counting the
// same-tag elements with the same flattened text, so the inner "El pedante" and the outer one are
// two distinct addresses rather than one ambiguous string.

/** How much of an element's text to keep. Long enough to be unique, short enough to store. */
const PG_ANCHOR_TEXT_MAX = 400;

/**
 * Normalize text for comparison.
 *
 * MUST STAY BYTE-FOR-BYTE EQUIVALENT to `normText` in user_study_website/app/study.js. The recorder
 * writes locators with this and the site matches them with that, so any divergence — a curly
 * apostrophe folded on one side and not the other — makes a locator fail to resolve, which looks
 * exactly like no locator at all and falls back to the text search this exists to replace.
 */
function _pgAnchorNormalize(v) {
  return String(v == null ? '' : v)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The comparable text of one element: flattened, collapsed, capped. */
function _pgAnchorTextOf(el) {
  const ownText = _pgAnchorNormalize(el.textContent);
  return (ownText || _pgAnchorSemanticTextOf(el)).slice(0, PG_ANCHOR_TEXT_MAX);
}

function _pgAnchorSemanticTextOf(el) {
  if (!el || el.nodeType !== 1) return '';
  const bits = [_pgAnchorNormalize(el.textContent)];
  const attrs = ['aria-label', 'title', 'alt'];
  const addAttrs = (node) => attrs.forEach((name) => {
    const value = node.getAttribute?.(name);
    if (value) bits.push(_pgAnchorNormalize(value));
  });
  addAttrs(el);
  el.querySelectorAll?.('[aria-label], [title], [alt]').forEach(addAttrs);
  return _pgAnchorNormalize(bits.filter(Boolean).join(' '));
}

function _pgAnchorEvidenceElement(el, quote) {
  if (!el || el.nodeType !== 1) return el;
  if (_pgAnchorNormalize(el.textContent)) return el;
  let cur = el.parentElement;
  let best = el;
  while (cur && cur !== document.body) {
    if (!_pgAnchorHolds(cur, quote)) break;
    const text = _pgAnchorNormalize(cur.textContent);
    if (text && text.length <= 600) {
      best = cur;
      if (/^(TD|TH|LI|P|FIGCAPTION|FIGURE|TR)$/.test(cur.tagName)) return cur;
    }
    cur = cur.parentElement;
  }
  return best;
}

/**
 * Which occurrence of (tag, text) this element is, counting in document order.
 *
 * The site counts the same way over the snapshot. Both walk the whole document rather than a
 * subtree, so pruning shifts nothing: a dropped nav is not a <p> with this text, and anything that
 * IS one is kept — _pgMarkPrunable refuses to drop an element that holds an anchor.
 */
function _pgAnchorOrdinal(el, tag, text) {
  let n = 0;
  const all = document.getElementsByTagName(tag);
  for (let i = 0; i < all.length; i++) {
    if (all[i] === el) return n;
    if (_pgAnchorTextOf(all[i]) === text) n++;
  }
  return n;
}

/**
 * Does this element actually contain the quoted text?
 *
 * Compared on a PREFIX for long quotes. A citation's quote is the model's rendering of what it
 * read, and it can end in an ellipsis or clip a trailing clause, so demanding the whole string
 * rejects perfectly good matches. 40 characters is long enough that a false agreement is not a
 * realistic worry.
 */
function _pgAnchorHolds(el, quote) {
  const q = _pgAnchorNormalize(quote);
  if (!q) return true;                       // nothing to disprove
  const hay = _pgAnchorSemanticTextOf(el).toLowerCase();
  const needle = q.toLowerCase();
  return hay.includes(needle.length > 40 ? needle.slice(0, 40) : needle);
}

/**
 * The smallest element that carries this quote, or null.
 *
 * The fallback for when the index and the quote disagree. SMALLEST because the <body> contains
 * every quote on the page: the useful answer is the paragraph, not the document. Elements whose
 * text is wildly longer than the quote are refused for the same reason a bounded search is used on
 * the site — "somewhere in this section" looks like a confident answer and is not one.
 */
function _pgFindByQuote(quote) {
  const q = _pgAnchorNormalize(quote);
  if (q.length < 4) return null;             // too short to identify anything on its own
  const probe = (q.length > 40 ? q.slice(0, 40) : q).toLowerCase();
  const matches = [];
  const all = document.body ? document.body.getElementsByTagName('*') : [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (typeof isPageGuideElement === 'function' && isPageGuideElement(el)) continue;
    const t = _pgAnchorSemanticTextOf(el);
    const lower = t.toLowerCase();
    if (!lower.includes(probe)) continue;
    const exact = lower === probe;
    if (!exact && t.length > Math.max(600, q.length * 8)) continue;
    matches.push({ el, len: t.length, exact });
  }
  matches.sort((a, b) => Number(b.exact) - Number(a.exact) || a.len - b.len);
  const short = q.length < 8;
  if (short) {
    const exact = matches.filter(m => m.exact);
    if (exact.length === 1) return exact[0].el;
    if (exact.length > 1) return null;
  }
  const best = matches[0];
  // Refuse a container many times the quote's own size — see above.
  return best ? best.el : null;
}

/**
 * Resolve the citations in an answer to portable locators, using the live index.
 *
 * @param {string} answer  the answer text, with its `[N:"…"]` markers intact
 * @returns {{anchors: object[], resolved: number, total: number, hasIndex: boolean}}
 */
function pgResolveCitationAnchors(answer) {
  const map = (typeof pageguideExistingIndexMap === 'function') ? pageguideExistingIndexMap() : null;
  const cites = _pgAnswerCitations(answer);

  const anchors = [];
  for (const cite of cites) {
    // THE QUOTE IS THE PROOF, not the number.
    //
    // `[70:"Book covers: Isaac Asimov's…"]` means element 70 IN THE RUN THAT WROTE IT. Every ask
    // renumbers the page (createPageIndex walks the live DOM), so element 70 of a LATER ask is
    // some other element — and re-deriving through it produces an anchor that resolves cleanly and
    // points at the wrong paragraph. That is exactly what happened: SVSF-V1's [70] landed on "The
    // novels are genuinely extraordinary…", which does not contain its own quote anywhere.
    //
    // The quote does not renumber. So the index is treated as a HINT that must agree with the
    // quote, and the quote is what decides.
    let el = map ? map[String(cite.index)] : null;
    if (el && el.nodeType === 1 && document.contains(el) && !_pgAnchorHolds(el, cite.text)) el = null;
    // The index disagreed, or there was none. Find the element that actually carries the quote.
    if (!el) el = _pgFindByQuote(cite.text);
    // Unresolvable is recorded as such rather than skipped: the site then knows to fall back to
    // text search for THIS citation, instead of assuming an absent locator means an absent citation.
    if (!el || el.nodeType !== 1 || !document.contains(el)) continue;
    el = _pgAnchorEvidenceElement(el, cite.text);
    const tag = el.tagName;
    const text = _pgAnchorTextOf(el);
    if (!text) continue;
    anchors.push({
      index: cite.index,
      quote: cite.text,
      tag,
      text,
      ordinal: _pgAnchorOrdinal(el, tag, text),
      // Whether `text` is the whole element or was cut. A truncated locator still matches on
      // prefix, and the site needs to know which comparison it is allowed to make.
      truncated: (_pgAnchorNormalize(el.textContent) || _pgAnchorSemanticTextOf(el)).length > PG_ANCHOR_TEXT_MAX,
    });
  }

  return {
    anchors,
    resolved: anchors.length,
    total: cites.length,
    // False means the answer run's index is gone — reloaded, or banked from a parked result on a
    // page that has since navigated. The caller says so rather than banking silent text-search bait.
    hasIndex: !!map,
  };
}

function _pgCitationKey(index, quote) {
  return `${Number(index)}:${String(quote || '')}`;
}

function _pgAnswerCitations(answer) {
  const seen = new Set();
  const cites = [];
  String(answer || '').replace(/\[(\d+):"([^"]*)"\]/g, (m, index, text) => {
    const key = _pgCitationKey(index, text);
    if (!seen.has(key)) { seen.add(key); cites.push({ index: Number(index), text, key }); }
    return m;
  });
  return cites;
}

function _pgAnchorKey(anchor) {
  return _pgCitationKey(anchor?.index, anchor?.quote);
}

function _pgMergeCitationAnchors(answer, freshAnchors, storedAnchors) {
  const cites = _pgAnswerCitations(answer);
  if (!cites.length) return [];
  const fresh = _pgAnchorQueues(freshAnchors);
  const stored = _pgAnchorQueues(storedAnchors);
  const merged = [];
  for (const cite of cites) {
    const nextFresh = fresh.get(cite.key);
    const nextStored = stored.get(cite.key);
    const anchor = nextFresh?.length ? nextFresh.shift() : (nextStored?.length ? nextStored.shift() : null);
    if (anchor) merged.push(anchor);
  }
  return merged;
}

function _pgAnchorQueues(anchors) {
  const out = new Map();
  (Array.isArray(anchors) ? anchors : []).forEach((anchor) => {
    const key = _pgAnchorKey(anchor);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(anchor);
  });
  return out;
}

/**
 * Find the element a stored locator names, on the page as it stands now.
 *
 * The mirror of _pgAnchorOrdinal, and of resolveCitationAnchor in the study site — all three count
 * the same way or a locator written by one fails to resolve in the others. Kept here rather than
 * imported because the site cannot import from an extension, so the rule is written twice and
 * asserted equal by test rather than shared.
 */
function pgFindByCitationAnchor(anchor) {
  const want = String(anchor?.text || '');
  if (!want || !anchor.tag) return null;
  const all = document.getElementsByTagName(anchor.tag);
  const matches = [];
  for (let i = 0; i < all.length; i++) {
    const t = _pgAnchorTextOf(all[i]);
    if (anchor.truncated ? t.startsWith(want) : t === want) matches.push(all[i]);
  }
  if (!matches.length) return null;
  const el = matches[anchor.ordinal] || (matches.length === 1 ? matches[0] : null);
  return el ? _pgAnchorEvidenceElement(el, anchor?.quote || '') : null;
}

/**
 * Re-draw a banked answer's grounding on the live page.
 *
 * WHY THIS IS NOT "just run the ask again". Re-asking produces a NEW answer — possibly a different
 * one — and re-indexes the page, so what it shows is not what the study will show. The point here
 * is to look at the highlights a participant will actually get, which are the ones belonging to the
 * banked record, resolved through the locators saved with it.
 *
 * That also makes this a check on the locators themselves: if the highlight lands in the wrong
 * place here, on the real page, it will land in the wrong place on the site — the same locators
 * resolve both. A researcher can see the fault before publishing rather than after.
 *
 * RESOLVES ITS OWN LOCATORS when the record has none. Requiring them first made this button useless
 * exactly when it was most wanted — an answer banked before anchoring existed has no locators, and
 * the only way to get them was to capture the page, so the check could not be run before the thing
 * it was meant to check. If the answer run's index is still installed, the locators are derived here
 * and handed back so the caller can bank them; pressing this then anchors an answer without a
 * capture at all.
 *
 * @param {object[]} anchors - citation_anchors from the banked response, possibly empty
 * @param {string} answer - the raw answer, used to derive locators when there are none
 * @returns {{shown: number, missed: number, misses: object[], anchors: object[], derived: boolean}}
 */
function pgShowSavedGrounding(anchors, answer) {
  if (typeof clearHighlights === 'function') clearHighlights();

  // THE LIVE INDEX WINS PER CITATION WHENEVER IT CAN, and stored locators fill the gaps.
  //
  // Deriving only when the record had none left no way to REPAIR a bad set. Anchors resolved
  // against the wrong tab are still anchors: the record has them, so nothing re-derived, and every
  // republish sent the same wrong ones back up. Clearing the database did not help either, because
  // the bad copy lived in chrome.storage.local and was simply uploaded again.
  //
  // Re-deriving costs nothing and is authoritative for the citations it resolves. But a PARTIAL
  // derive must not throw away saved locators for the rest — that is exactly how a two-citation
  // answer could bank and show only one highlight.
  let list = Array.isArray(anchors) ? anchors : [];
  let derived = false;
  if (answer) {
    const res = pgResolveCitationAnchors(answer);
    const merged = _pgMergeCitationAnchors(answer, res.anchors, anchors);
    if (res.anchors.length || merged.length !== list.length) {
      list = merged;
      derived = !!res.anchors.length;
    }
  }
  let shown = 0;
  const misses = [];
  const missing = _pgMissingCitations(answer, list);
  missing.forEach(cite => misses.push({ index: cite.index, quote: cite.text }));
  for (const anchor of list) {
    const el = pgFindByCitationAnchor(anchor);
    if (!el) { misses.push({ index: anchor?.index, quote: anchor?.quote || '' }); continue; }
    // The page's own highlight treatment, not one invented here: the researcher is checking what a
    // participant sees, so a second visual language would be checking the wrong thing.
    const quote = String(anchor.quote || '').trim();
    const n = (quote && typeof highlightTextInElement === 'function')
      ? highlightTextInElement(el, quote, '#ffd93d', 'soft')
      : 0;
    if (!n && typeof applyAnimatedHighlight === 'function') {
      applyAnimatedHighlight(el, '#ffd93d', 'soft', { block: true });
      if (Array.isArray(window._pageguideHighlights)) window._pageguideHighlights.push(el);
    }
    shown++;
  }
  // Scrolled to the first hit, because a highlight below the fold reads as no highlight at all.
  const first = list.length ? pgFindByCitationAnchor(list[0]) : null;
  if (first) { try { first.scrollIntoView({ block: 'center' }); } catch (e) { } }
  // The locators go back with the result so a caller that derived them can bank them rather than
  // deriving them again on a page whose index may be gone by then.
  return { shown, missed: misses.length, misses, anchors: list, derived };
}

function _pgMissingCitations(answer, anchors) {
  const anchored = new Set((Array.isArray(anchors) ? anchors : []).map(_pgAnchorKey));
  return _pgAnswerCitations(answer).filter(cite => !anchored.has(cite.key));
}

function pgScrollToCitationAnchor(anchor) {
  const el = pgFindByCitationAnchor(anchor);
  if (!el) return { success: false, error: 'anchor not found' };
  try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {
    try { el.scrollIntoView({ block: 'center' }); } catch (ignored) {}
  }
  const quote = String(anchor?.quote || '').trim();
  const n = (quote && typeof highlightTextInElement === 'function')
    ? highlightTextInElement(el, quote, '#ffd93d', 'soft')
    : 0;
  if (!n && typeof applyAnimatedHighlight === 'function') {
    applyAnimatedHighlight(el, '#ffd93d', 'soft', { block: true });
    if (Array.isArray(window._pageguideHighlights)) window._pageguideHighlights.push(el);
  }
  return { success: true };
}

if (typeof window !== 'undefined') {
  window.pgResolveCitationAnchors = pgResolveCitationAnchors;
  window.pgFindByCitationAnchor = pgFindByCitationAnchor;
  window.pgScrollToCitationAnchor = pgScrollToCitationAnchor;
  window._pgMergeCitationAnchors = _pgMergeCitationAnchors;
  window._pgAnchorHolds = _pgAnchorHolds;
  window._pgFindByQuote = _pgFindByQuote;
  window.pgShowSavedGrounding = pgShowSavedGrounding;
  window._pgAnchorNormalize = _pgAnchorNormalize;
  window._pgAnchorTextOf = _pgAnchorTextOf;
  window._pgAnchorOrdinal = _pgAnchorOrdinal;
  window.PG_ANCHOR_TEXT_MAX = PG_ANCHOR_TEXT_MAX;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pgResolveCitationAnchors, _pgAnchorNormalize, _pgAnchorTextOf, _pgAnchorOrdinal,
    _pgAnchorHolds, _pgFindByQuote,
  };
}
