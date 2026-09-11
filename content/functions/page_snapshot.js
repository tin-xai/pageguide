// PageGuide — self-contained page snapshots.
// =========================================
// Freeze the page a Find task is about, so the study website can show it.
//
// WHY A SNAPSHOT AND NOT THE LIVE PAGE. The website cannot put the real page in front of a
// participant, for two independent reasons:
//
//   1. Most sites refuse to be framed (publicdomainreview.org sends X-Frame-Options: DENY).
//   2. Worse, a cross-origin frame CANNOT BE SCRIPTED. Even where framing is allowed, the site
//      could not index the page, apply highlights or scroll to a citation — so the grounded arm
//      would look exactly like the non-grounded one and the study would measure nothing.
//
// A snapshot served from the study's own origin is same-origin, and therefore scriptable. That is
// the whole point: it is not a screenshot, it is a working DOM.
//
// FULLY SELF-CONTAINED, deliberately. Stylesheets, images and fonts are inlined as data: URIs and
// scripts are stripped, so the snapshot never touches the network when it is rendered. Three things
// follow, all of them wanted:
//   • it cannot change under a participant — an article edited mid-study would otherwise silently
//     invalidate every answer recorded before the edit;
//   • it cannot phone home from inside the study, so a participant's IP never reaches the site
//     being studied;
//   • it still works when the original is offline, paywalled or gone.
//
// The cost is size: an inlined article runs 2-20 MB. That is why the site fetches one page at a
// time and never the whole set.

/**
 * How large an asset may be before it is fetched at all.
 *
 * Raised from 3 MB once images started being downscaled: what is fetched is no longer what is
 * stored, so a 6 MB original that becomes 200 KB is worth fetching. Wikipedia's orbit animation is
 * a 6.47 MB GIF, and under the old cap it was skipped — which, with the snapshot's own
 * `img-src data:` policy, rendered as a broken image icon in the middle of the article.
 */
const PG_SNAPSHOT_MAX_ASSET_BYTES = 10 * 1024 * 1024;

/** How long one asset may take before it is given up on. See _pgFetchAsDataUri. */
const PG_SNAPSHOT_FETCH_TIMEOUT_MS = 15000;

/** Give up on the whole capture past this, rather than build something nothing can store. */
const PG_SNAPSHOT_MAX_TOTAL_BYTES = 40 * 1024 * 1024;

/**
 * Fetch one asset and return it as a data: URI, or null to leave the original URL alone.
 *
 * Null is a normal outcome, not a failure to report: CORS refuses plenty of fonts and images, and
 * a snapshot missing one background texture is worth far more than no snapshot at all. The page's
 * TEXT is what citations point at, and that never depends on an asset.
 */
async function _pgFetchAsDataUri(url) {
  try {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return null;
    // TIMED OUT, because a hung request hangs the whole capture. There is no overall deadline above
    // this — the capture awaits each image in turn — so one asset served by a host that accepts the
    // connection and then never answers leaves the panel on "inlining styles and images…" forever,
    // with no error and nothing to retry. A missing image is a normal, recoverable outcome; a
    // capture that never returns is not.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PG_SNAPSHOT_FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > PG_SNAPSHOT_MAX_ASSET_BYTES) return null;
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    return null;
  }
}

/**
 * The widest an inlined image is kept, and the quality it is re-encoded at.
 *
 * Images are essentially all of a snapshot's weight: uncapped, this bank reached 24 MB for one
 * article. That is slow to upload (Postgres cancels the insert with statement timeout 57014), slow
 * for a participant to load, and pointless — the frame is ~1100px wide, so a 4000px original is
 * downscaled by the browser anyway and only the file was ever that big.
 *
 * 1600px keeps it sharp on a retina display at that width, which matters here: a Find question can
 * turn on a detail inside an engraving.
 */
const PG_SNAPSHOT_IMG_MAX_WIDTH = 1600;
const PG_SNAPSHOT_IMG_QUALITY = 0.82;

/**
 * Resolve one capture's image budget. Pure.
 *
 * The defaults above are right for nearly every page, so they stay the defaults. But a page can be
 * heavy enough that the finished row cannot be WRITTEN: Postgres cancels the insert with statement
 * timeout 57014, which is what two of the ten Find items did (a Public Domain Review essay of
 * scanned engravings, and an Aeon essay of large photography — every other page went up at 3–5 MB).
 *
 * Lowering the constants globally is the wrong trade. A Find question can turn on a detail inside
 * an engraving, so the eight pages that publish fine should keep every pixel they have; only the
 * one page that will not fit should give any up. Hence a per-capture override rather than a new
 * default.
 *
 * @param {{imgMaxWidth?: number, imgQuality?: number}} [options]
 * @returns {{imgMaxWidth: number, imgQuality: number}}
 */
function _pgCaptureLimits(options) {
  const width = Number(options?.imgMaxWidth);
  const quality = Number(options?.imgQuality);
  return {
    // Never below the min width an image is stored at, or the floor in _pgShrinkDataUri would
    // silently win and the setting would do nothing; never above the default, which is the cap.
    imgMaxWidth: Number.isFinite(width) && width > 0
      ? Math.min(PG_SNAPSHOT_IMG_MAX_WIDTH, Math.max(PG_SNAPSHOT_IMG_MIN_WIDTH, Math.round(width)))
      : PG_SNAPSHOT_IMG_MAX_WIDTH,
    // 0.3 is where JPEG artefacts start eating the fine detail these questions are asked about.
    imgQuality: Number.isFinite(quality) && quality > 0
      ? Math.min(PG_SNAPSHOT_IMG_QUALITY, Math.max(0.3, quality))
      : PG_SNAPSHOT_IMG_QUALITY,
  };
}

/**
 * The narrowest an image is ever stored at, whatever it is drawn at.
 *
 * A thumbnail drawn at 90px would otherwise be banked at 180px and turn to mush the moment a
 * participant opens it in the evidence lightbox — where the whole point is to look at it closely.
 */
const PG_SNAPSHOT_IMG_MIN_WIDTH = 900;

/** Past this, an image is re-encoded even when it has no excess pixels — see _pgShrinkDataUri. */
const PG_SNAPSHOT_IMG_REENCODE_BYTES = 180 * 1024;

/**
 * Re-encode a data: URI down to PG_SNAPSHOT_IMG_MAX_WIDTH, or return it unchanged.
 *
 * Unchanged is the right answer more often than it looks: an image already narrower than the cap
 * gains nothing from a re-encode and would only lose quality, and SVG has no pixels to resample —
 * re-encoding one to JPEG would rasterize a diagram that was crisp at any size.
 */
async function _pgShrinkDataUri(dataUri, renderedWidth = 0, limits = null) {
  if (!dataUri || !dataUri.startsWith('data:image/')) return dataUri;
  if (dataUri.startsWith('data:image/svg')) return dataUri;
  // An ANIMATED GIF is flattened to its first frame when it is large. The animation is lost, which
  // is a real cost — but a 6 MB orbit animation is most of a snapshot's budget, and a still frame
  // of it answers "what does this diagram show?" while a dropped image answers nothing.
  const isGif = dataUri.startsWith('data:image/gif');
  if (isGif && dataUri.length < 400 * 1024) return dataUri;   // small enough to keep moving
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = dataUri;
      setTimeout(() => reject(new Error('decode timeout')), 8000);
    });
    if (!img.naturalWidth) return dataUri;

    // How many pixels this image is worth KEEPING, rather than how many it happens to have.
    //
    // A Wikipedia article is mostly thumbnails drawn at ~250px inside a ~1100px frame. Sizing every
    // one of them to the 1600px cap stores ~40× the pixels that are ever shown, and the old rule
    // did worse than that: an image already under 1600px was returned UNTOUCHED, so a 1280px PNG
    // was banked at full PNG weight. That is why Mars came to 37 MB after lazy-loading started
    // resolving real images instead of blur placeholders — nothing on that page was wide enough to
    // trip the cap, so nothing on it was ever re-encoded.
    //
    // 2× the drawn width is the retina budget: sharp on any display at the size it is actually
    // shown, and a fraction of the bytes. The floor keeps an image usable if it is later opened
    // full-size in the evidence lightbox; the cap is unchanged, so a wide hero image is still
    // capped rather than doubled.
    const { imgMaxWidth, imgQuality } = limits || _pgCaptureLimits(null);
    const target = Math.min(
      imgMaxWidth,
      Math.max(PG_SNAPSHOT_IMG_MIN_WIDTH, (renderedWidth || 0) * 2) || imgMaxWidth,
      img.naturalWidth,
    );
    // Re-encode when there are pixels to drop, or when the file is heavy AND re-encoding it could
    // plausibly help.
    //
    // "Could plausibly help" is doing real work here. Decode + draw + toDataURL costs tens of
    // milliseconds on a large image, and an article can hold fifty — the first version of this rule
    // re-encoded every image over 180 KB regardless of format, which on an image-heavy page meant
    // re-encoding a JPEG to a JPEG at the same size dozens of times over, to save nothing. The
    // capture appeared to hang. Only LOSSLESS formats are worth a same-size re-encode; anything
    // already lossy is left alone unless it has pixels to lose.
    const lossless = /^data:image\/(png|bmp|tiff?)/.test(dataUri);
    const heavy = lossless && dataUri.length > PG_SNAPSHOT_IMG_REENCODE_BYTES;
    if (img.naturalWidth <= target && !heavy) return dataUri;

    const scale = target / img.naturalWidth;
    const canvas = document.createElement('canvas');
    canvas.width = target;
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    // A JPEG has no alpha, so a transparent PNG would composite onto black without this.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL('image/jpeg', imgQuality);
    // Only take it if it actually helped: a small illustration can re-encode LARGER as a JPEG.
    return out.length < dataUri.length ? out : dataUri;
  } catch (e) {
    return dataUri;
  }
}

/** Absolute URL against the document, or '' when it cannot be resolved. */
function _pgAbsolute(url) {
  try { return new URL(url, document.baseURI).href; } catch (e) { return ''; }
}

/**
 * Replace every url(...) inside a stylesheet with an inlined copy.
 *
 * Rewritten against the STYLESHEET's own URL, not the document's: a rule in
 * /assets/css/site.css saying url(../img/bg.png) means /assets/img/bg.png, and resolving it
 * against the page instead would quietly fetch the wrong thing — or, worse, a real but different
 * image, which nobody would notice.
 */
async function _pgInlineCssUrls(cssText, sheetHref, limits = null) {
  const seen = new Map();
  const urls = [...String(cssText).matchAll(/url\((['"]?)([^'")]+)\1\)/g)]
    .map(m => m[2].trim())
    .filter(u => u && !u.startsWith('data:'));

  for (const raw of [...new Set(urls)]) {
    if (seen.has(raw)) continue;
    let abs;
    try { abs = new URL(raw, sheetHref || document.baseURI).href; } catch (e) { continue; }
    seen.set(raw, await _pgShrinkDataUri(await _pgFetchAsDataUri(abs), 0, limits));
  }

  let out = String(cssText);
  seen.forEach((dataUri, raw) => {
    if (!dataUri) return;
    out = out.split(`url(${raw})`).join(`url(${dataUri})`)
      .split(`url('${raw}')`).join(`url('${dataUri}')`)
      .split(`url("${raw}")`).join(`url("${dataUri}")`);
  });
  return out;
}

/**
 * Every stylesheet the page is using, as one block of CSS with its assets inlined.
 *
 * Read from document.styleSheets rather than by re-fetching the <link> hrefs, because that is the
 * CSS the page is ACTUALLY rendering with — media queries already resolved, and same-origin sheets
 * readable directly. Cross-origin sheets throw on .cssRules (that is the whole point of the
 * restriction), so those are re-fetched by URL as a fallback.
 */
async function _pgCollectCss(limits = null) {
  const parts = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let text = '';
    try {
      text = Array.from(sheet.cssRules).map(r => r.cssText).join('\n');
    } catch (e) {
      // Cross-origin: unreadable through the CSSOM, but usually fetchable as a plain file.
      if (sheet.href) {
        try {
          const res = await fetch(sheet.href, { credentials: 'omit' });
          if (res.ok) text = await res.text();
        } catch (e2) { /* leave it out; layout degrades, text survives */ }
      }
    }
    if (text) parts.push(await _pgInlineCssUrls(text, sheet.href || document.baseURI, limits));
  }
  return parts.join('\n');
}

/**
 * The best URL for an image — the FULL one, not the placeholder.
 *
 * Lazy loaders put a tiny blurred stand-in in `src` and keep the real file in a data- attribute
 * until the image scrolls into view. Capturing `src` naively therefore inlines the blur, and the
 * snapshot looks like a badly compressed photograph — which is exactly what a participant would
 * then be asked to read a detail out of.
 *
 * `data-blursrc` is named and excluded rather than skipped by luck: it is the placeholder, and on
 * this loader it sits right beside the attribute we do want.
 *
 * Order: an explicit lazy attribute → the largest srcset candidate → what the browser actually
 * resolved → the raw src.
 */
function _pgBestImageUrl(img) {
  const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-hi-res-src', 'data-full-src'];
  for (const attr of LAZY_ATTRS) {
    const v = img.getAttribute(attr);
    if (v && !v.startsWith('data:')) return v;
  }

  // srcset: take the widest candidate, since the snapshot may be viewed at any width and an
  // upscaled small one is the blur problem in a different costume.
  const srcset = img.getAttribute('data-srcset') || img.getAttribute('srcset') || '';
  if (srcset) {
    const best = srcset.split(',')
      .map(part => {
        const bits = part.trim().split(/\s+/);
        const descriptor = bits[1] || '';
        const weight = descriptor.endsWith('w') ? parseFloat(descriptor)
          : descriptor.endsWith('x') ? parseFloat(descriptor) * 1000
          : 0;
        return { url: bits[0], weight };
      })
      .filter(c => c.url && !c.url.startsWith('data:'))
      .sort((a, b) => b.weight - a.weight)[0];
    if (best) return best.url;
  }

  const current = img.getAttribute('data-pg-current') || '';
  if (current && !current.startsWith('data:')) return current;
  return img.getAttribute('src') || '';
}

/**
 * Make the lazy loaders do their work before anything is read.
 *
 * Some loaders leave no data- attribute at all: an IntersectionObserver swaps `src` when the image
 * nears the viewport and that is the only place the real URL ever exists. The only way to get it is
 * to put every image near the viewport, so this scrolls the length of the page and waits for the
 * images to settle before returning to where the reader was.
 */
async function _pgSettleLazyImages() {
  const startY = window.scrollY;
  const step = Math.max(400, Math.round(window.innerHeight * 0.9));
  for (let y = 0; y < document.body.scrollHeight; y += step) {
    window.scrollTo(0, y);
    await new Promise(r => setTimeout(r, 120));
  }
  window.scrollTo(0, startY);

  // Then wait for what that started, with a ceiling: one image behind a dead CDN must not hold the
  // capture open forever.
  const pending = Array.from(document.images).filter(img => !img.complete);
  await Promise.race([
    Promise.all(pending.map(img => new Promise(res => {
      img.addEventListener('load', res, { once: true });
      img.addEventListener('error', res, { once: true });
    }))),
    new Promise(r => setTimeout(r, 5000)),
  ]);
  await new Promise(r => setTimeout(r, 200));
}

/**
 * Inline every <img>, including the srcset/lazy-loading variants that carry the real URL.
 *
 * Reports progress as it goes. Inlining is where all the time goes — one fetch and often one
 * re-encode per image — and a silent wait of a minute is indistinguishable from a hang, which is
 * exactly how it was read. `onProgress` lets the panel say "image 14 of 61" instead.
 */
async function _pgInlineImages(root, onProgress, limits = null) {
  const imgs = Array.from(root.querySelectorAll('img'));
  let done = 0;
  for (const img of imgs) {
    if (onProgress) { try { onProgress(done, imgs.length); } catch (e) { } }
    done++;
    const abs = _pgAbsolute(_pgBestImageUrl(img));
    // srcset would otherwise override the data: URI we just set, and re-fetch from the network.
    img.removeAttribute('srcset');
    img.removeAttribute('loading');
    if (!abs) continue;
    const drawnWidth = Number(img.getAttribute('data-pg-w')) || 0;
    img.removeAttribute('data-pg-w');
    const dataUri = await _pgShrinkDataUri(await _pgFetchAsDataUri(abs), drawnWidth, limits);
    if (dataUri) img.setAttribute('src', dataUri);
    // NO URL FALLBACK. The snapshot's own CSP is `img-src data:`, so a remote URL here could never
    // load — it rendered as a broken-image icon, which is worse than either alternative: it looks
    // like the study is broken rather than like one asset was too big to keep. A placeholder says
    // what was there, in the alt text the page already wrote.
    else _pgReplaceWithPlaceholder(img);
  }
}

/**
 * Swap an un-inlinable image for a labelled box.
 *
 * Keeps the alt text, because that is the page's own description of what the picture showed, and a
 * participant who cannot see it should at least know what it was rather than staring at a broken
 * icon and wondering whether the study failed.
 */
function _pgReplaceWithPlaceholder(img) {
  const box = img.ownerDocument.createElement('div');
  const alt = (img.getAttribute('alt') || '').trim();
  box.setAttribute('data-pg-missing', '1');
  box.setAttribute('style',
    'display:inline-block;min-width:180px;padding:14px 16px;border:1px dashed #b9b9c6;'
    + 'border-radius:8px;background:#f6f6fa;color:#6b6b78;'
    + "font:500 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center");
  box.textContent = alt
    ? `🖼 Image not captured — ${alt}`
    : '🖼 Image not captured (too large to store)';
  img.replaceWith(box);
}

/** Inline CSS background images declared inline on elements. */
async function _pgInlineInlineStyles(root, limits = null) {
  const els = Array.from(root.querySelectorAll('[style*="url("]'));
  for (const el of els) {
    const before = el.getAttribute('style') || '';
    el.setAttribute('style', await _pgInlineCssUrls(before, document.baseURI, limits));
  }
}

/**
 * The furniture a Find task can never be about.
 *
 * On a Wikipedia article this is most of the page: the Mars article carries 94 images, of which 51
 * live in references and navboxes, and the reference apparatus dwarfs the prose. None of it can
 * hold an answer — a question asks about the article, not about its citation list or the "Solar
 * System" navbox at the bottom.
 *
 * Kept deliberately generic (roles and common class names) rather than tuned to one site, and
 * nothing here is removed on faith: _pgMarkPrunable refuses to drop anything carrying an anchor.
 */
const PG_SNAPSHOT_CHROME = [
  'nav', 'footer', '[role="navigation"]', '[role="contentinfo"]', '[role="banner"]',
  '.navbox', '.reflist', '.references', '.mw-references-wrap', '.catlinks',
  '.sistersitebox', '.metadata', '.mw-footer', '.vector-toc', '.mw-portlet',
  '.mw-editsection', '.noprint', '[aria-hidden="true"]',
].join(',');

/**
 * Mark what can be dropped, on the LIVE page, where the layout is known.
 *
 * Two rules, and the second is what makes the first safe:
 *   • it is chrome, or an image too small to be evidence;
 *   • AND it carries no anchor, and contains none.
 *
 * The anchors are the recorded citations and evidence targets. Anything the agent actually pointed
 * at survives by definition, however deep in the furniture it sits — so pruning can be aggressive
 * without ever removing the thing a participant is being asked to check. Pruning by a percentage
 * of the page could not make that promise: if the answer is in the last 30%, the task breaks and
 * nothing says so.
 *
 * Runs before the images are fetched, so a dropped image is never downloaded either — which is most
 * of the capture time, not just most of the size.
 */
function _pgMarkPrunable() {
  const marked = [];
  const anchored = (el) =>
    el.hasAttribute('data-pg-index') || el.hasAttribute('data-pg-image-id')
    || !!el.querySelector('[data-pg-index], [data-pg-image-id]');

  let chrome = [];
  try { chrome = Array.from(document.querySelectorAll(PG_SNAPSHOT_CHROME)); } catch (e) { chrome = []; }
  chrome.forEach(el => {
    if (anchored(el)) return;
    el.setAttribute('data-pg-drop', '1');
    marked.push(el);
  });

  // Icons, spacers and tracking pixels: too small to be the subject of a question, and there are
  // usually dozens.
  Array.from(document.querySelectorAll('img')).forEach(img => {
    if (anchored(img) || img.hasAttribute('data-pg-drop')) return;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w < 100 || h < 100) { img.setAttribute('data-pg-drop', '1'); marked.push(img); }
  });

  return () => marked.forEach(el => el.removeAttribute('data-pg-drop'));
}

/**
 * Stamp the recorder's own anchors onto the live DOM, and hand back a function to remove them.
 *
 * WHY THIS EXISTS. A recorded citation is `[69:"Foundation series"]` — element 69 IN THE PAGE INDEX
 * AT RECORD TIME. That index is exact. Without it the study site can only search the snapshot for
 * the quoted text, and text search is a guess: it misses when the page splits a phrase across tags
 * ("*Foundation* series" is not one text node), and it misfires when one quote contains another
 * ("El pedante" is inside "…Belo's El pedante (1538)"). Both happened.
 *
 * Stamping resolves it at the only moment the mapping is known. `data-pg-index` is the citation
 * target; `data-pg-image-id` is the image an evidence annotation was drawn on, numbered by
 * gv2BuildFindImageCatalog's rule rather than by anything this file invents.
 *
 * The live page is cleaned up afterwards: capturing must not leave attributes behind on a page the
 * researcher is still using.
 */
function _pgStampAnchors() {
  const stamped = [];
  let indexCount = 0;
  let imageCount = 0;

  // Citation targets: the index [N:"…"] refers to is the one the ANSWER RUN installed, and only
  // that one. It is NOT rebuilt here, ever. createPageIndex renumbers from the live DOM and skips
  // the answer's own highlight spans (see pageguideExistingIndexMap in utils.js), so a rebuild
  // hands out different numbers than the citations were written against — stamping those would not
  // be a missing anchor, it would be a CONFIDENTLY WRONG one, and the site trusts anchors over text.
  // An empty map is therefore the correct outcome when no Find has been run on this page; the
  // caller reports it so the researcher can run one and capture again.
  const index = (typeof window !== 'undefined' && typeof pageguideExistingIndexMap === 'function'
    ? pageguideExistingIndexMap() : null) || {};
  Object.keys(index).forEach(key => {
    const el = index[key];
    if (!el || el.nodeType !== 1 || !el.isConnected) return;
    el.setAttribute('data-pg-index', String(key));
    stamped.push([el, 'data-pg-index']);
    indexCount++;
  });

  // Image ids, from the recorder's own catalog so the numbering matches source_image_id exactly.
  try {
    if (typeof gv2BuildFindImageCatalog === 'function') {
      gv2BuildFindImageCatalog('').forEach(cand => {
        const el = cand?.el;
        if (!el || el.nodeType !== 1 || !el.isConnected) return;
        el.setAttribute('data-pg-image-id', cand.id);
        stamped.push([el, 'data-pg-image-id']);
        imageCount++;
      });
    }
  } catch (e) { /* best-effort: the text fallback still works */ }

  return {
    indexCount,
    imageCount,
    unstamp: () => stamped.forEach(([el, attr]) => el.removeAttribute(attr)),
  };
}

/**
 * Capture the current page as one self-contained HTML string.
 *
 * @param {{imgMaxWidth?: number, imgQuality?: number}} [options] - shrink THIS capture's images
 *   harder than the defaults, for a page too heavy to be written inside the database's statement
 *   timeout. See _pgCaptureLimits.
 * @returns {Promise<{html: string, bytes: number, url: string, title: string, truncated: boolean,
 *   limits: {imgMaxWidth: number, imgQuality: number}}>}
 */
async function pgCapturePageSnapshot(options = null) {
  const limits = _pgCaptureLimits(options);
  // Let the lazy loaders finish FIRST. Capturing before they have run inlines the blurred
  // placeholders, and the snapshot is then unreadable exactly where the question points.
  await _pgSettleLazyImages();

  // Record what the browser actually resolved for each image BEFORE cloning: currentSrc does not
  // survive a clone, and it is the only place a responsive page keeps the URL it really used.
  const live = Array.from(document.querySelectorAll('img'));
  live.forEach(img => {
    if (img.currentSrc) img.setAttribute('data-pg-current', img.currentSrc);
    // How wide the image is actually DRAWN. Layout does not survive a clone, and it is the only
    // honest budget for how many pixels the snapshot needs to keep — see _pgShrinkDataUri.
    const w = Math.round(img.getBoundingClientRect().width || img.clientWidth || 0);
    if (w > 0) img.setAttribute('data-pg-w', String(w));
  });

  const css = await _pgCollectCss(limits);

  // Stamped BEFORE the clone so the attributes are copied into it, and removed immediately after so
  // the researcher's live page is left as it was found.
  const anchors = _pgStampAnchors();
  const unmark = _pgMarkPrunable();     // after stamping: the anchors are what make pruning safe
  const clone = document.documentElement.cloneNode(true);
  unmark();
  anchors.unstamp();
  live.forEach(img => { img.removeAttribute('data-pg-current'); img.removeAttribute('data-pg-w'); });

  // Scripts go, all of them. A snapshot that could run code could rewrite itself under a
  // participant, re-fetch the live article, or navigate the study away.
  clone.querySelectorAll('script, noscript').forEach(el => el.remove());
  // PageGuide's own chrome must not be baked in — but ONLY the chrome.
  //
  // THE BUG THIS REPLACES. The rule was `[class*="pageguide-"]` → remove, which does not
  // distinguish an element PageGuide INJECTED from a page element PageGuide DECORATED. A highlight
  // puts `pageguide-highlight` on the page's own <p> (applyAnimatedHighlight), so capturing a page
  // with an answer showing DELETED every cited paragraph — precisely the elements the citations
  // point at, and only those. SVSF-V1's snapshot lost "Musk has spoken of how science fiction
  // shaped his ambitions…" and kept the rest of the article, so nothing looked wrong until a
  // citation was followed and landed nowhere.
  //
  // So: injected UI is removed, decoration is stripped, and the page's own content survives both.
  const PG_INJECTED = [
    '[id^="pageguide-"]', '#study-overlay', '#study-mini-bar',
    '.pageguide-som-box', '.pageguide-som-mark', '.pageguide-som-container',
    '.pageguide-evidence-marker', '.pageguide-evidence-overlay',
    '.pageguide-preview-box', '.pageguide-custom-style',
  ].join(',');
  clone.querySelectorAll(PG_INJECTED).forEach(el => el.remove());

  // Inline highlight spans wrap the page's OWN words (highlightTextInElement), so they are unwrapped
  // rather than removed: deleting them would delete the cited sentence out of the paragraph.
  clone.querySelectorAll('span.pageguide-highlight').forEach(span => {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  });
  // Whole-element highlights are just classes on page elements. Drop the classes, keep the elements.
  clone.querySelectorAll('[class*="pageguide-"]').forEach(el => {
    // Snapshotted first: removing from a live DOMTokenList while iterating it skips entries.
    Array.from(el.classList)
      .filter(c => c.startsWith('pageguide-'))
      .forEach(c => el.classList.remove(c));
    if (!el.getAttribute('class')) el.removeAttribute('class');
  });
  // The furniture, dropped before any image is fetched — see _pgMarkPrunable.
  clone.querySelectorAll('[data-pg-drop]').forEach(el => el.remove());
  // Existing stylesheet links are replaced by the collected CSS below.
  clone.querySelectorAll('link[rel~="stylesheet"], link[rel="preload"][as="style"]').forEach(el => el.remove());
  // Nothing may reach the network from inside the snapshot.
  clone.querySelectorAll('iframe, frame, object, embed, video, audio, source').forEach(el => el.remove());

  // Progress goes to the panel as a fire-and-forget message: the panel is awaiting this call's
  // reply, so it cannot be told anything through the return value until the work is already done.
  await _pgInlineImages(clone, (done, total) => {
    try {
      chrome.runtime.sendMessage({ action: 'captureProgress', done, total });
    } catch (e) { /* no receiver is fine — the capture is not for the panel's benefit */ }
  }, limits);
  await _pgInlineInlineStyles(clone, limits);

  const head = clone.querySelector('head') || clone.insertBefore(document.createElement('head'), clone.firstChild);

  // A restrictive CSP inside the snapshot itself: belt and braces over stripping scripts by hand.
  // If any executable content survives the strip, this stops it running; if any URL survives the
  // inlining, this stops it being fetched. The one exception is data:, which is the whole snapshot.
  const csp = document.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content',
    "default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:");
  head.insertBefore(csp, head.firstChild);

  const style = document.createElement('style');
  style.textContent = css;
  head.appendChild(style);

  const html = `<!doctype html>\n${clone.outerHTML}`;
  const bytes = new Blob([html]).size;
  return {
    html: bytes > PG_SNAPSHOT_MAX_TOTAL_BYTES ? '' : html,
    bytes,
    url: location.href,
    title: document.title || '',
    truncated: bytes > PG_SNAPSHOT_MAX_TOTAL_BYTES,
    // Reported, not just counted. A capture with no citation anchors succeeds in every visible way
    // and then puts every citation on whatever text search happens to hit first — which is what
    // "the evidence is on the wrong paragraph" was, on every page at once. The caller says so.
    anchors: { index: anchors.indexCount, image: anchors.imageCount },
    // Reported back so the panel can say what a re-capture actually used, rather than what was asked
    // for — the request is clamped (see _pgCaptureLimits).
    limits,
  };
}

if (typeof window !== 'undefined') {
  window.pgCapturePageSnapshot = pgCapturePageSnapshot;
  window._pgCaptureLimits = _pgCaptureLimits;
  window._pgInlineCssUrls = _pgInlineCssUrls;
  window._pgBestImageUrl = _pgBestImageUrl;
  window._pgShrinkDataUri = _pgShrinkDataUri;
  window._pgStampAnchors = _pgStampAnchors;
  window._pgMarkPrunable = _pgMarkPrunable;
  window.PG_SNAPSHOT_CHROME = PG_SNAPSHOT_CHROME;
  window.PG_SNAPSHOT_IMG_MAX_WIDTH = PG_SNAPSHOT_IMG_MAX_WIDTH;
  window._pgAbsolute = _pgAbsolute;
  window.PG_SNAPSHOT_MAX_TOTAL_BYTES = PG_SNAPSHOT_MAX_TOTAL_BYTES;
}

console.log('📄 page_snapshot.js loaded');
