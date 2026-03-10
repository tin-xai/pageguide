// Study behavior tracker
// Counts scroll gestures, Ctrl/Cmd-F presses, and drag-text selections.
// Batches events and sends them to the background SW, which aggregates
// across page navigations so data is not lost when the user navigates.
(function () {
  'use strict';

  let active = false;
  let scrollTimer = null;
  const batch = { scroll: 0, ctrlF: 0, textSelect: 0, click: 0, mouseMove: 0 };

  function flush() {
    if (!active) return;
    if (batch.scroll === 0 && batch.ctrlF === 0 && batch.textSelect === 0 && batch.click === 0 && batch.mouseMove === 0) return;
    chrome.runtime.sendMessage({
      action: 'studyTracker_batch',
      scroll: batch.scroll,
      ctrlF: batch.ctrlF,
      textSelect: batch.textSelect,
      click: batch.click,
      mouseMove: batch.mouseMove,
    }).catch(() => {});
    batch.scroll = 0;
    batch.ctrlF = 0;
    batch.textSelect = 0;
    batch.click = 0;
    batch.mouseMove = 0;
  }

  // Flush every 2 s and on page unload (best-effort)
  setInterval(flush, 2000);
  window.addEventListener('beforeunload', flush);

  // Scroll: debounce 300 ms so one continuous gesture = 1 count
  window.addEventListener('scroll', () => {
    if (!active) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { batch.scroll++; }, 300);
  }, { passive: true, capture: true });

  // Ctrl/Cmd+F
  window.addEventListener('keydown', (e) => {
    if (!active) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      batch.ctrlF++;
    }
  }, { capture: true });

  // Drag-to-select: mouseup with >2-char selection
  window.addEventListener('mouseup', () => {
    if (!active) return;
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 2) {
      batch.textSelect++;
    }
  }, { capture: true });

  // Mouse clicks
  window.addEventListener('mousedown', () => {
    if (!active) return;
    batch.click++;
  }, { capture: true });

  // Mouse movement distance (throttled to every 50 ms)
  let lastMoveX = null, lastMoveY = null, moveThrottle = null;
  window.addEventListener('mousemove', (e) => {
    if (!active) return;
    if (moveThrottle) return;
    moveThrottle = setTimeout(() => { moveThrottle = null; }, 50);
    if (lastMoveX !== null) {
      const dx = e.clientX - lastMoveX;
      const dy = e.clientY - lastMoveY;
      batch.mouseMove += Math.round(Math.sqrt(dx * dx + dy * dy));
    }
    lastMoveX = e.clientX;
    lastMoveY = e.clientY;
  }, { passive: true, capture: true });

  // Messages from the sidepanel
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'studyTracker_start') {
      active = true;
      sendResponse({ ok: true });
    } else if (msg.action === 'studyTracker_stop') {
      flush(); // push remaining counts before stopping
      active = false;
      sendResponse({ ok: true });
    }
  });
})();
