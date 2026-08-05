// PageGuide Content Script - Main Entry Point
// Initializes the extension and handles message routing

// Prevent double-loading
if (!window._pageguideLoaded) {
  window._pageguideLoaded = true;
  console.log('🤖 PageGuide loaded');

  // ===== Message Handler =====
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleMessage(request)
      .then(sendResponse)
      .catch(err => {
        console.error('🤖 Message handler error:', err);
        sendResponse({ success: false, error: err.message || 'Unknown error' });
      });
    return true;
  });
}

async function handleMessage(request) {
  switch (request.action) {
    // Freeze this page for the study website. Runs here, in the page, because that is the only
    // place the rendered DOM and its stylesheets exist — see content/functions/page_snapshot.js
    // for why a snapshot is needed at all rather than the live URL.
    case 'capturePageSnapshot':
      if (typeof pgCapturePageSnapshot !== 'function') {
        return { error: 'page_snapshot.js is not loaded — reload the page and try again' };
      }
      return await pgCapturePageSnapshot();

    case 'handleQuery':
      if (typeof handleSmartQuery === 'function') {
        return await handleSmartQuery(
          request.query,
          request.history || [],
          request.hasImage || false,
          request.hasImageInHistory || false,
          request.forcedRoute || null,
          request.cleanQuery || null
        );
      }
      return { success: false, error: 'Query handler not loaded' };
    
    case 'reset':
      if (typeof resetCustomStyles === 'function') resetCustomStyles();
      if (typeof clearMarkings === 'function') clearMarkings();
      if (typeof clearHighlights === 'function') clearHighlights();
      if (typeof clearPdfHighlights === 'function') clearPdfHighlights();
      // Reset guidev2 state
      if (typeof gv2StopGuide === 'function') gv2StopGuide();
      else if (window._guidev2) window._guidev2.active = false;
      // Clear rewind capture records (🧹 Clear / New Chat ends the session)
      if (typeof rewindClear === 'function') { try { rewindClear(); } catch (e) {} }
      // Stop auto-hide session
      if (typeof stopAutoHide === 'function') stopAutoHide();
      // Clear uploaded image
      if (typeof clearUploadedImage === 'function') clearUploadedImage();
      return { success: true };
    
    case 'scrollToHighlight': {
      // The scroll-to flash is itself a form of on-page highlighting — skip it in Non-grounding
      // baseline mode, same as the highlighting that would normally have put something in
      // window._pageguideHighlights in the first place.
      const nonGrounding = typeof isNonGroundingModeOn === 'function' && await isNonGroundingModeOn();
      if (typeof scrollToHighlight === 'function') scrollToHighlight(0, !nonGrounding);
      return { success: true };
    }

    case 'scrollToIndex': {
      const nonGrounding = typeof isNonGroundingModeOn === 'function' && await isNonGroundingModeOn();
      if (typeof scrollToIndex === 'function') {
        const scrolled = scrollToIndex(request.index, !nonGrounding, request.citation);
        return { success: scrolled };
      }
      return { success: false, error: 'Scroll function not loaded' };
    }

    // Hovering a citation in the side panel: pulse the span it points at, so the reader can see
    // where the click will take them — necessary when the paragraph around it is already tinted.
    case 'previewIndex': {
      if (typeof pageguidePreviewIndex !== 'function') return { success: false };
      const nonGrounding = typeof isNonGroundingModeOn === 'function' && await isNonGroundingModeOn();
      // No on-page grounding in the baseline arm, and that includes this.
      if (nonGrounding) return { success: true, found: false };
      return { success: true, found: pageguidePreviewIndex(request.index, request.on !== false, request.citation) };
    }

    // Hovering an [ev] marker: mark the evidence region the same way, so a number that points at a
    // picture is as answerable-at-a-glance as one that points at a sentence.
    case 'previewEvidenceMark': {
      if (typeof pageguidePreviewEvidenceMark !== 'function') return { success: false };
      const nonGrounding = typeof isNonGroundingModeOn === 'function' && await isNonGroundingModeOn();
      if (nonGrounding) return { success: true, found: false };
      return { success: true, found: pageguidePreviewEvidenceMark(request.index, request.on !== false) };
    }

    // Clicking [ev:N] in the side panel: scroll to the annotated evidence drawn on this page.
    case 'scrollToEvidenceMark': {
      if (typeof pageguideScrollToEvidenceMark !== 'function') {
        return { success: false, error: 'Evidence marks not loaded' };
      }
      return { success: pageguideScrollToEvidenceMark(request.index) };
    }

    case 'getStudyParagraphOptions':
      return getStudyParagraphOptions();

    // Supporting evidence is answered by pointing: the participant turns on Annotate in the panel,
    // hovers this page, and clicks the sentence (or image) they mean. The choice comes back as its
    // own runtime message when they confirm — see study_pick.js.
    case 'startStudyPick':
      if (typeof pageguideStartStudyPick !== 'function') {
        return { success: false, error: 'Study picker not loaded' };
      }
      return pageguideStartStudyPick({ hop: request.hop, kind: request.kind, channel: request.channel });

    case 'cancelStudyPick':
      if (typeof pageguideCancelStudyPick !== 'function') return { success: true };
      return pageguideCancelStudyPick();

    // Take me back to what I picked: scroll to the element a recorded answer came from and mark it
    // with the page's own "PageGuide highlight" badge. Resolved by selector rather than by index,
    // because an image — or a block PageGuide had already highlighted — carries no index.
    case 'markPickedTarget': {
      if (typeof pageguidePreviewIndex === 'function' && request.on === false) {
        pageguidePreviewIndex(null, false);
        return { success: true };
      }
      // One selector, or the whole set at once — the ground-truth panel marks every accepted answer
      // together so they can be read against each other rather than one at a time.
      const selectors = Array.isArray(request.selectors)
        ? request.selectors
        : [String(request.selector || '')];
      const found = [];
      selectors.filter(Boolean).forEach(sel => {
        try {
          const node = document.querySelector(sel);
          if (node) found.push(node);
        } catch (e) { /* a selector the page no longer matches */ }
      });
      document.querySelectorAll('.pageguide-preview-target')
        .forEach(node => node.classList.remove('pageguide-preview-target'));
      if (!found.length) return { success: true, found: false, count: 0 };
      found.forEach(node => node.classList.add('pageguide-preview-target'));
      const el = found[0];
      // 'ifNeeded' is what hovering asks for: bring it into view when it is not, and never yank a
      // page that is already showing the thing the pointer is asking about.
      const scroll = request.scroll || 'always';
      let needed = true;
      if (scroll === 'ifNeeded') {
        try {
          const r = el.getBoundingClientRect();
          const h = window.innerHeight || document.documentElement.clientHeight;
          needed = r.bottom < 40 || r.top > h - 40;
        } catch (e) { needed = true; }
      }
      if (scroll !== 'never' && needed) {
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* best-effort */ }
      }
      return { success: true, found: true, count: found.length, scrolled: scroll !== 'never' && needed };
    }

    // Show or hide the answer's citation highlights, without touching them.
    //
    // NOT re-applied from the answer text: [N] numbers are resolved through window._pageguideIndex,
    // which is rebuilt from the DOM on every run — and inserting the highlight spans themselves
    // changes what that walk indexes (isPageGuideElement skips them), so the same N addresses a
    // different element afterwards. Re-applying put the highlights in the wrong places. The spans
    // are still in the page from the run that drew them; the arms differ in whether they are SHOWN.
    case 'setAnswerHighlightsVisible': {
      document.documentElement.classList.toggle('pageguide-highlights-off', request.visible === false);
      return { success: true };
    }

    // Redraw the on-page evidence marks for a specific answer.
    //
    // The marks are otherwise drawn once, by whichever run captured them (gv2BuildFindEvidence), so
    // the page always showed the LATEST run's evidence. That is wrong the moment the study's Answer
    // screen shows a different answer than the last one generated — a banked Grounded record, or an
    // earlier answer of two — because its [ev] markers would then jump to another run's marks.
    // Every record carries its own marks for exactly this; an empty list clears them, which is what
    // the non-grounded arm needs.
    case 'showStudyEvidenceMarks': {
      if (typeof pageguideShowEvidenceAnnotations !== 'function') {
        return { success: false, error: 'Evidence marks not loaded' };
      }
      const marks = Array.isArray(request.marks) ? request.marks : [];
      if (!marks.length) {
        if (typeof pageguideClearEvidenceAnnotations === 'function') pageguideClearEvidenceAnnotations();
        return { success: true, drawn: 0 };
      }
      return { success: true, drawn: pageguideShowEvidenceAnnotations(marks) };
    }

    // The FIND × VISUAL arm's second supporting question asks which IMAGE carries the answer, so the
    // participant needs a list of the page's pictures rather than its paragraphs.
    case 'getStudyImageOptions':
      return getStudyImageOptions();
    
    case 'navigateToPdfPage':
      if (typeof navigateToPdfPage === 'function') {
        const navigated = await navigateToPdfPage(request.page, request.searchText);
        return { success: navigated };
      }
      return { success: false, error: 'PDF navigation not available' };
    
    case 'stopGuide':
      if (typeof gv2StopGuide === 'function') gv2StopGuide();
      else if (window._guidev2) window._guidev2.active = false;
      return { success: true };

    case 'stopGuideWithRecap':
      if (typeof gv2StopGuideWithRecap === 'function') {
        return await gv2StopGuideWithRecap();
      }
      if (typeof gv2StopGuide === 'function') gv2StopGuide();
      else if (window._guidev2) window._guidev2.active = false;
      return { success: true, stopped: true, recap: null };

    case 'pauseGuide':
      if (typeof gv2PauseGuide === 'function') {
        return await gv2PauseGuide(request.reason);
      }
      return { success: false, error: 'Guide not active' };

    case 'resumeGuide':
      if (typeof gv2ResumeGuide === 'function') {
        return await gv2ResumeGuide();
      }
      return { success: false, error: 'Guide not active' };

    case 'retryGuideStep':
      if (typeof gv2RetryGuideStep === 'function') {
        return await gv2RetryGuideStep();
      }
      return { success: false, error: 'Guide not active' };

    case 'nextGuideStep':
      if (typeof gv2NextStep === 'function') {
        return await gv2NextStep({ source: request.source || 'message' });
      }
      return { success: false, error: 'Guide not active' };

    case 'gv2SteerNow':
      // Same-page restore: fork + re-run on the live DOM without reloading
      // (reloading a heavy SPA like Google Slides loses state and can prompt "leave site?").
      console.log('🤖 gv2SteerNow received', request.payload);
      if (typeof gv2SteerNow === 'function' && request.payload) {
        return await gv2SteerNow(request.payload); // progress also streams via messages
      }
      return { success: false, error: 'Steer not available' };

    case 'manualRestoreHere':
      if (typeof gv2ManualRestoreHere === 'function') {
        return await gv2ManualRestoreHere();
      }
      return { success: false, error: 'Restore review not available' };

    case 'confirmSteerRestore':
      // User confirmed (in the side panel) that the restored state looks right — let the
      // agent continue from the branch step with the new instruction.
      if (typeof gv2ConfirmSteerRestore === 'function') {
        gv2ConfirmSteerRestore(request.reason, request.mode, request.isFixed); // fire-and-forget; progress streams via messages
        return { success: true };
      }
      return { success: false, error: 'Steer restore not available' };

    case 'retrySteerRestore':
      // User asked to re-apply the saved restore once (deterministic re-run).
      if (typeof gv2RetrySteerRestore === 'function') {
        gv2RetrySteerRestore(); // fire-and-forget; progress streams via messages
        return { success: true };
      }
      return { success: false, error: 'Steer restore not available' };

    case 'fixSteerRestore':
      // User reported the restore is wrong and described what's off — let the agent work on it.
      if (typeof gv2FixSteerRestore === 'function') {
        gv2FixSteerRestore(request.note); // fire-and-forget; progress streams via messages
        return { success: true };
      }
      return { success: false, error: 'Steer restore not available' };

    case 'compareSteerRestoreState':
      // Explicit user-triggered screenshot comparison. This is intentionally not run
      // automatically during steer restore or retry.
      if (typeof gv2CompareSteerRestoreState === 'function') {
        return await gv2CompareSteerRestoreState();
      }
      return { success: false, error: 'Steer restore comparison not available' };

    case 'setUploadedImage':
      if (typeof setUploadedImage === 'function') {
        setUploadedImage(request.imageBase64);
        return { success: true };
      }
      return { success: false, error: 'Image upload not available' };
    
    case 'clearUploadedImage':
      if (typeof clearUploadedImage === 'function') {
        clearUploadedImage();
        return { success: true };
      }
      return { success: true }; // Silently succeed even if function not loaded

    case 'setUploadedFile':
      if (typeof setUploadedFile === 'function') {
        setUploadedFile(request.fileText, request.fileName);
        return { success: true };
      }
      return { success: false, error: 'File upload not available' };

    case 'clearUploadedFile':
      if (typeof clearUploadedFileAttachment === 'function') {
        clearUploadedFileAttachment();
        return { success: true };
      }
      return { success: true }; // Silently succeed even if function not loaded

    // "Is anyone there?" — the panel asks before deciding a page needs the bundle reinjected.
    // Any answer proves this script is alive; only a rejection means it is not.
    case 'pageguidePing':
      return { success: true, alive: true };

    default:
      return { error: 'Unknown action' };
  }
}

function getStudyParagraphOptions() {
  if (typeof createPageIndex !== 'function') {
    return { success: false, error: 'Page index function not loaded', options: [] };
  }

  const textRoles = new Set([
    'paragraph', 'article', 'heading', 'listitem', 'row', 'cell', 'gridcell',
  ]);
  const textTags = new Set(['P', 'LI', 'BLOCKQUOTE', 'TD', 'TH', 'DD', 'DT', 'FIGCAPTION']);
  const options = [];
  const seenText = new Set();

  // Reuse the index the answer's citations resolve through. Rebuilding it here renumbers the page
  // out from under them — see pageguideExistingIndexMap.
  const existing = typeof pageguideExistingIndexMap === 'function' ? pageguideExistingIndexMap() : null;
  const indexMap = existing || createPageIndex(5000, false).indexMap || {};
  Object.entries(indexMap).some(([rawIndex, el]) => {
    if (!el || !el.textContent) return false;
    const role = typeof getAccessibleRole === 'function' ? getAccessibleRole(el) : null;
    const tagName = el.tagName || '';
    if (!textRoles.has(role) && !textTags.has(tagName)) return false;

    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (text.length < 8 || text.length > 1800) return false;
    const dedupeKey = text.toLowerCase();
    if (seenText.has(dedupeKey)) return false;
    seenText.add(dedupeKey);

    const index = parseInt(rawIndex, 10);
    if (!Number.isFinite(index)) return false;
    const shortText = text.length > 180 ? `${text.slice(0, 180)}...` : text;
    options.push({
      index,
      role: role || tagName.toLowerCase() || 'text',
      label: `[${index}] ${shortText}`,
      text,
      url: window.location.href,
    });
    return options.length >= 250;
  });

  return {
    success: true,
    url: window.location.href,
    options,
  };
}

/**
 * The page's images, for the FIND × VISUAL arm's "which image?" supporting question.
 *
 * Reuses gv2FindMediaCandidates — the same ranked catalog the Find answer already uses to decide
 * which pictures to send the model — with includeAll so nothing relevant is filtered out by a
 * question-relevance score the participant is not being asked about.
 */
function getStudyImageOptions() {
  if (typeof gv2FindMediaCandidates !== 'function') {
    return { success: false, error: 'Media catalog not loaded', options: [] };
  }
  try {
    const seen = new Set();
    const options = [];
    gv2FindMediaCandidates('', { includeAll: true, limit: Infinity }).forEach((cand, i) => {
      const label = String(cand?.label || '').replace(/\s+/g, ' ').trim();
      if (!label) return;
      const key = label.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      options.push({
        index: i + 1,
        role: 'image',
        label,
        text: label,
        selector: typeof gv2ElementSelector === 'function' ? gv2ElementSelector(cand.el) : '',
        url: window.location.href,
      });
    });
    return { success: true, url: window.location.href, options: options.slice(0, 100) };
  } catch (e) {
    return { success: false, error: e?.message || 'image scan failed', options: [] };
  }
}

// When Chrome restores this page from bfcache, clean up any stale guide state
// (the guide has already moved to the new page; this page is just returning from bfcache)
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    if (typeof gv2StopGuide === 'function') gv2StopGuide();
    else if (window._guidev2) window._guidev2.active = false;
  }
});

// Track selection changes to send context to sidepanel
let selectionTimeout = null;
document.addEventListener('selectionchange', () => {
  // Clear any pending timeout
  if (selectionTimeout) {
    clearTimeout(selectionTimeout);
  }
  
  // Debounce to avoid spamming messages while user is dragging
  selectionTimeout = setTimeout(() => {
    const selection = window.getSelection();
    // Only send if we're not inside an input/textarea to avoid interfering with normal typing
    const activeEl = document.activeElement;
    const isInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);
    
    if (!isInput) {
      const selectedText = selection.toString().trim();
      try {
        chrome.runtime.sendMessage({ 
          action: 'selectedText', 
          text: selectedText 
        });
      } catch (err) {
        // Extension context might be invalidated, ignore
      }
    }
  }, 300); // 300ms debounce
});
