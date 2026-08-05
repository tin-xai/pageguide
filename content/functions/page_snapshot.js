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
    const res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
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
 * Re-encode a data: URI down to PG_SNAPSHOT_IMG_MAX_WIDTH, or return it unchanged.
 *
 * Unchanged is the right answer more often than it looks: an image already narrower than the cap
 * gains nothing from a re-encode and would only lose quality, and SVG has no pixels to resample —
 * re-encoding one to JPEG would rasterize a diagram that was crisp at any size.
 */
async function _pgShrinkDataUri(dataUri) {
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
    if (!img.naturalWidth || img.naturalWidth <= PG_SNAPSHOT_IMG_MAX_WIDTH) return dataUri;

    const scale = PG_SNAPSHOT_IMG_MAX_WIDTH / img.naturalWidth;
    const canvas = document.createElement('canvas');
    canvas.width = PG_SNAPSHOT_IMG_MAX_WIDTH;
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    // A JPEG has no alpha, so a transparent PNG would composite onto black without this.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL('image/jpeg', PG_SNAPSHOT_IMG_QUALITY);
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
async function _pgInlineCssUrls(cssText, sheetHref) {
  const seen = new Map();
  const urls = [...String(cssText).matchAll(/url\((['"]?)([^'")]+)\1\)/g)]
    .map(m => m[2].trim())
    .filter(u => u && !u.startsWith('data:'));

  for (const raw of [...new Set(urls)]) {
    if (seen.has(raw)) continue;
    let abs;
    try { abs = new URL(raw, sheetHref || document.baseURI).href; } catch (e) { continue; }
    seen.set(raw, await _pgShrinkDataUri(await _pgFetchAsDataUri(abs)));
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
async function _pgCollectCss() {
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
    if (text) parts.push(await _pgInlineCssUrls(text, sheet.href || document.baseURI));
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

/** Inline every <img>, including the srcset/lazy-loading variants that carry the real URL. */
async function _pgInlineImages(root) {
  const imgs = Array.from(root.querySelectorAll('img'));
  for (const img of imgs) {
    const abs = _pgAbsolute(_pgBestImageUrl(img));
    // srcset would otherwise override the data: URI we just set, and re-fetch from the network.
    img.removeAttribute('srcset');
    img.removeAttribute('loading');
    if (!abs) continue;
    const dataUri = await _pgShrinkDataUri(await _pgFetchAsDataUri(abs));
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
async function _pgInlineInlineStyles(root) {
  const els = Array.from(root.querySelectorAll('[style*="url("]'));
  for (const el of els) {
    const before = el.getAttribute('style') || '';
    el.setAttribute('style', await _pgInlineCssUrls(before, document.baseURI));
  }
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

  // Citation targets: window._pageguideIndex is the very index [N:"…"] refers to.
  const index = (typeof window !== 'undefined' && window._pageguideIndex) || {};
  Object.keys(index).forEach(key => {
    const el = index[key];
    if (!el || el.nodeType !== 1 || !el.isConnected) return;
    el.setAttribute('data-pg-index', String(key));
    stamped.push([el, 'data-pg-index']);
  });

  // Image ids, from the recorder's own catalog so the numbering matches source_image_id exactly.
  try {
    if (typeof gv2BuildFindImageCatalog === 'function') {
      gv2BuildFindImageCatalog('').forEach(cand => {
        const el = cand?.el;
        if (!el || el.nodeType !== 1 || !el.isConnected) return;
        el.setAttribute('data-pg-image-id', cand.id);
        stamped.push([el, 'data-pg-image-id']);
      });
    }
  } catch (e) { /* best-effort: the text fallback still works */ }

  return () => stamped.forEach(([el, attr]) => el.removeAttribute(attr));
}

/**
 * Capture the current page as one self-contained HTML string.
 *
 * @returns {Promise<{html: string, bytes: number, url: string, title: string, truncated: boolean}>}
 */
async function pgCapturePageSnapshot() {
  // Let the lazy loaders finish FIRST. Capturing before they have run inlines the blurred
  // placeholders, and the snapshot is then unreadable exactly where the question points.
  await _pgSettleLazyImages();

  // Record what the browser actually resolved for each image BEFORE cloning: currentSrc does not
  // survive a clone, and it is the only place a responsive page keeps the URL it really used.
  const live = Array.from(document.querySelectorAll('img'));
  live.forEach(img => { if (img.currentSrc) img.setAttribute('data-pg-current', img.currentSrc); });

  const css = await _pgCollectCss();

  // Stamped BEFORE the clone so the attributes are copied into it, and removed immediately after so
  // the researcher's live page is left as it was found.
  const unstamp = _pgStampAnchors();
  const clone = document.documentElement.cloneNode(true);
  unstamp();
  live.forEach(img => img.removeAttribute('data-pg-current'));

  // Scripts go, all of them. A snapshot that could run code could rewrite itself under a
  // participant, re-fetch the live article, or navigate the study away.
  clone.querySelectorAll('script, noscript').forEach(el => el.remove());
  // PageGuide's own chrome must not be baked in.
  clone.querySelectorAll('[id^="pageguide-"], [class*="pageguide-"], #study-overlay, #study-mini-bar')
    .forEach(el => el.remove());
  // Existing stylesheet links are replaced by the collected CSS below.
  clone.querySelectorAll('link[rel~="stylesheet"], link[rel="preload"][as="style"]').forEach(el => el.remove());
  // Nothing may reach the network from inside the snapshot.
  clone.querySelectorAll('iframe, frame, object, embed, video, audio, source').forEach(el => el.remove());

  await _pgInlineImages(clone);
  await _pgInlineInlineStyles(clone);

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
  };
}

if (typeof window !== 'undefined') {
  window.pgCapturePageSnapshot = pgCapturePageSnapshot;
  window._pgInlineCssUrls = _pgInlineCssUrls;
  window._pgBestImageUrl = _pgBestImageUrl;
  window._pgShrinkDataUri = _pgShrinkDataUri;
  window._pgStampAnchors = _pgStampAnchors;
  window.PG_SNAPSHOT_IMG_MAX_WIDTH = PG_SNAPSHOT_IMG_MAX_WIDTH;
  window._pgAbsolute = _pgAbsolute;
  window.PG_SNAPSHOT_MAX_TOTAL_BYTES = PG_SNAPSHOT_MAX_TOTAL_BYTES;
}

console.log('📄 page_snapshot.js loaded');
