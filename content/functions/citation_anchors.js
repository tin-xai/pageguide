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
  return _pgAnchorNormalize(el.textContent).slice(0, PG_ANCHOR_TEXT_MAX);
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
 * Resolve the citations in an answer to portable locators, using the live index.
 *
 * @param {string} answer  the answer text, with its `[N:"…"]` markers intact
 * @returns {{anchors: object[], resolved: number, total: number, hasIndex: boolean}}
 */
function pgResolveCitationAnchors(answer) {
  const map = (typeof pageguideExistingIndexMap === 'function') ? pageguideExistingIndexMap() : null;
  const seen = new Set();
  const cites = [];
  String(answer || '').replace(/\[(\d+):"([^"]*)"\]/g, (m, index, text) => {
    const key = `${index}:${text}`;
    if (!seen.has(key)) { seen.add(key); cites.push({ index: Number(index), text }); }
    return m;
  });

  const anchors = [];
  for (const cite of cites) {
    const el = map ? map[String(cite.index)] : null;
    // Unresolvable is recorded as such rather than skipped: the site then knows to fall back to
    // text search for THIS citation, instead of assuming an absent locator means an absent citation.
    if (!el || el.nodeType !== 1 || !document.contains(el)) continue;
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
      truncated: _pgAnchorNormalize(el.textContent).length > PG_ANCHOR_TEXT_MAX,
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
    const t = _pgAnchorNormalize(all[i].textContent);
    if (anchor.truncated ? t.startsWith(want) : t === want) matches.push(all[i]);
  }
  if (!matches.length) return null;
  return matches[anchor.ordinal] || (matches.length === 1 ? matches[0] : null);
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
 * @param {object[]} anchors - citation_anchors from the banked response
 * @returns {{shown: number, missed: number, misses: object[]}}
 */
function pgShowSavedGrounding(anchors) {
  if (typeof clearHighlights === 'function') clearHighlights();
  const list = Array.isArray(anchors) ? anchors : [];
  let shown = 0;
  const misses = [];
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
  return { shown, missed: misses.length, misses };
}

if (typeof window !== 'undefined') {
  window.pgResolveCitationAnchors = pgResolveCitationAnchors;
  window.pgFindByCitationAnchor = pgFindByCitationAnchor;
  window.pgShowSavedGrounding = pgShowSavedGrounding;
  window._pgAnchorNormalize = _pgAnchorNormalize;
  window._pgAnchorTextOf = _pgAnchorTextOf;
  window._pgAnchorOrdinal = _pgAnchorOrdinal;
  window.PG_ANCHOR_TEXT_MAX = PG_ANCHOR_TEXT_MAX;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pgResolveCitationAnchors, _pgAnchorNormalize, _pgAnchorTextOf, _pgAnchorOrdinal };
}
