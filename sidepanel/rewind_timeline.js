// PageGuide - Rewind Timeline + Inspector (Slice 1, side panel)
//
// Renders a vertical dot timeline of the steps the agent performed and an in-panel
// inspector (screenshot / read-only DOM snapshot + reasoning). Lightweight step meta
// arrives live via `guideStepRecord` messages; the heavy record (screenshot + DOM
// snapshot) is loaded lazily from the rewind store (chrome.storage.local) on demand.
//
// Kept self-contained so panel.js only needs: RewindTimeline.addStep(meta) / .clear().

(function (global) {
  const TIMELINE_ID = 'pageguide-rewind-timeline';
  const INSPECTOR_ID = 'pageguide-rewind-inspector';
  let _injectedCss = false;
  let _sessionId = null;

  function _injectCss() {
    if (_injectedCss) return;
    _injectedCss = true;
    const style = document.createElement('style');
    style.textContent = `
#${TIMELINE_ID}{margin:12px 0 4px;padding:0 0 4px;border-top:0}
#${TIMELINE_ID} .rw-hdr{font:760 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#555d72;margin:0 0 10px;display:flex;align-items:center;gap:6px}
#${TIMELINE_ID} .rw-hdr::after{content:"";height:1px;flex:1;background:#eef0f6}
#${TIMELINE_ID} .rw-plan{display:none!important}
#${TIMELINE_ID} .rw-plan-hdr{font:600 10px/1.4 sans-serif;text-transform:uppercase;letter-spacing:.04em;opacity:.6;margin-bottom:5px}
#${TIMELINE_ID} .rw-plan-item{display:flex;align-items:flex-start;gap:7px;font:400 12px/1.4 -apple-system,sans-serif;padding:2px 0;opacity:.7}
#${TIMELINE_ID} .rw-plan-item .rw-pi-mark{flex-shrink:0;width:15px;text-align:center}
#${TIMELINE_ID} .rw-plan-item.done{opacity:.55}
#${TIMELINE_ID} .rw-plan-item.current{opacity:1;font-weight:600;color:#7c5cff}
#${TIMELINE_ID} .rw-track{position:relative;padding-left:20px}
#${TIMELINE_ID} .rw-track::before{content:"";position:absolute;left:6px;top:9px;bottom:13px;width:2px;background:#d7dbe7}
#${TIMELINE_ID} .rw-step{position:relative;display:flex;align-items:center;gap:10px;min-height:38px;padding:8px 10px;margin:2px 0;border-radius:9px;cursor:pointer;transition:background .15s,border-color .15s;color:#60687c}
#${TIMELINE_ID} .rw-step:hover{background:#f6f4ff}
#${TIMELINE_ID} .rw-step.current{background:#f7f5ff;border:1px solid #d7cffd;color:#7857ff;box-shadow:0 8px 24px rgba(120,87,255,.08)}
#${TIMELINE_ID} .rw-dot{position:absolute;left:-19px;top:50%;width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid #b8bdca;box-sizing:border-box;transform:translateY(-50%)}
#${TIMELINE_ID} .rw-step.done .rw-dot{width:12px;height:12px;background:#22c55e;border-color:#22c55e}
#${TIMELINE_ID} .rw-step.done .rw-dot::after{content:"✓";position:absolute;inset:0;color:#fff;font:800 8px/11px sans-serif;text-align:center}
#${TIMELINE_ID} .rw-step.current .rw-dot{width:16px;height:16px;background:#fff;border:4px solid #7857ff;box-shadow:0 0 0 4px rgba(120,87,255,.16)}
#${TIMELINE_ID} .rw-step.current .rw-instr{color:#7857ff;font-weight:760}
#${TIMELINE_ID} .rw-step.rw-review .rw-dot{background:#ff526a;border-color:#ff526a}
#${TIMELINE_ID} .rw-step.rw-verify-failed .rw-dot{background:#ff6b35;border-color:#ff6b35}
#${TIMELINE_ID} .rw-step.rw-verify-blocked .rw-dot{background:#ffa502;border-color:#ffa502}
#${TIMELINE_ID} .rw-body{flex:1;min-width:0}
#${TIMELINE_ID} .rw-instr{font:680 12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${TIMELINE_ID} .rw-right{flex-shrink:0;display:flex;align-items:center;gap:8px;margin-left:8px}
#${TIMELINE_ID} .rw-when{font:700 11px/1.3 -apple-system,sans-serif;color:#9aa1b2;white-space:nowrap}
#${TIMELINE_ID} .rw-step.current .rw-when{color:#7857ff;font-weight:760}
#${TIMELINE_ID} .rw-right::after{content:"⌄";color:#a5abba;font-size:13px}
#${TIMELINE_ID} .rw-step.current .rw-right::after{content:"⌃";color:#7857ff}
#${TIMELINE_ID} .rw-thumb{display:none!important}
#${TIMELINE_ID} .rw-flag{display:inline-block;font:700 9px/1 sans-serif;color:#ff4757;background:rgba(255,71,87,.14);border:1px solid rgba(255,71,87,.35);padding:2px 6px;border-radius:99px;margin-top:2px}
#${TIMELINE_ID} .rw-step.rw-verify-failed .rw-instr::after{content:" ⚠";color:#ff6b35}
#${TIMELINE_ID} .rw-step.rw-verify-blocked .rw-instr::after{content:" ⛔";color:#ffa502}

.rw-hovercard{position:fixed;z-index:2147483646;width:230px;background:var(--pg-bg,#1e1e28);color:var(--pg-text,#eee);border:1px solid var(--pg-border,rgba(255,255,255,.15));border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.4);padding:8px;font:400 11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none}
.rw-hovercard img{width:100%;border-radius:6px;display:block;margin-bottom:6px;background:#0003}
.rw-hovercard .rw-hc-instr{font-weight:600;margin-bottom:3px}
.rw-hovercard .rw-hc-meta{opacity:.65;font-size:10px}

#${INSPECTOR_ID}{position:fixed;inset:0;z-index:2147483647;background:var(--pg-bg,#1e1e28);color:var(--pg-text,#eee);display:flex;flex-direction:column}
#${INSPECTOR_ID} .rw-ins-hdr{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--pg-border,rgba(255,255,255,.12))}
#${INSPECTOR_ID} .rw-ins-title{font:600 13px/1.3 -apple-system,sans-serif;flex:1}
#${INSPECTOR_ID} .rw-ins-btn{background:var(--pg-hover,rgba(128,128,128,.18));border:none;color:inherit;border-radius:6px;padding:6px 10px;font:600 12px/1 sans-serif;cursor:pointer}
#${INSPECTOR_ID} .rw-ins-btn.active{background:#7c5cff;color:#fff}
#${INSPECTOR_ID} .rw-ins-body{flex:1;overflow:auto;padding:12px}
#${INSPECTOR_ID} .rw-why{font:400 12px/1.5 -apple-system,sans-serif;background:var(--pg-hover,rgba(128,128,128,.1));border-radius:8px;padding:10px;margin-bottom:10px}
#${INSPECTOR_ID} .rw-tabs{display:flex;gap:6px;margin-bottom:10px}
#${INSPECTOR_ID} .rw-view img{width:100%;max-width:100%;border-radius:8px;border:1px solid var(--pg-border,rgba(255,255,255,.12))}
#${INSPECTOR_ID} .rw-snap-wrap{position:relative}
#${INSPECTOR_ID} .rw-snap-banner{position:absolute;top:8px;left:8px;background:rgba(20,20,30,.85);color:#ffd166;font:600 11px/1 sans-serif;padding:5px 9px;border-radius:99px;z-index:2}
#${INSPECTOR_ID} iframe{width:100%;height:60vh;border:1px solid var(--pg-border,rgba(255,255,255,.12));border-radius:8px;background:#fff}
#${INSPECTOR_ID} .rw-steer{background:var(--pg-hover,rgba(128,128,128,.1));border:1px solid var(--pg-border,rgba(255,255,255,.12));border-radius:8px;padding:10px;margin-bottom:10px}
#${INSPECTOR_ID} .rw-steer-hdr{font:700 12px/1.3 -apple-system,sans-serif;margin-bottom:7px;color:#7c5cff}
#${INSPECTOR_ID} .rw-steer-input{width:100%;box-sizing:border-box;resize:vertical;background:var(--pg-bg,#15151f);color:inherit;border:1px solid var(--pg-border,rgba(255,255,255,.18));border-radius:7px;padding:8px;font:400 12px/1.4 -apple-system,sans-serif}
#${INSPECTOR_ID} .rw-steer-note{font:400 10px/1.4 sans-serif;opacity:.6;margin:6px 0 8px}
#${INSPECTOR_ID} .rw-steer-actions{display:flex;justify-content:flex-end;gap:8px}
#${INSPECTOR_ID} .rw-steer-go{background:#7c5cff;color:#fff}
#${INSPECTOR_ID} .rw-steer-go[disabled]{opacity:.5;cursor:default}
#${INSPECTOR_ID} details{margin-top:10px;font:400 11px/1.5 monospace}
#${INSPECTOR_ID} pre{white-space:pre-wrap;word-break:break-word;background:#0004;padding:8px;border-radius:6px;overflow:auto;max-height:240px}`;
    document.head.appendChild(style);
  }

  function _ensureContainer() {
    _injectCss();
    let el = document.getElementById(TIMELINE_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TIMELINE_ID;
      el.style.display = 'none';
      el.innerHTML = `<div class="rw-hdr">Journey</div><div class="rw-plan" style="display:none"></div><div class="rw-track"></div>`;
      // Mount at the top of the scroll area so the Journey sits above chat bubbles.
      const messages = document.getElementById('pageguide-messages');
      if (messages) messages.insertBefore(el, messages.firstChild);
      else document.body.appendChild(el);
    }
    return el;
  }

  function _fmtDuration(ms) {
    if (!ms && ms !== 0) return '';
    return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
  }
  function _fmtCost(cost) {
    if (!cost || cost.usd == null) return '';
    return '$' + Number(cost.usd).toFixed(4);
  }
  function _recordShot(rec) {
    if (typeof global.rewindResolveScreenshot === 'function') return global.rewindResolveScreenshot(rec);
    return rec ? (rec.screenshotBefore || rec.screenshot || rec.screenshotAfter || null) : null;
  }
  function _removeTimelineStep(meta) {
    if (!meta) return;
    const container = document.getElementById(TIMELINE_ID);
    const row = container?.querySelector(`[data-step="${meta.step}"]`);
    if (row) row.remove();
    try {
      if (typeof global.removeGuideStepRecord === 'function') {
        global.removeGuideStepRecord(meta.sessionId || _sessionId, meta.step);
      }
    } catch (e) {}
  }
  async function _getVerifiedRecord(meta, attempts = 3) {
    if (!meta || typeof rewindGetRecord !== 'function') return null;
    for (let i = 0; i < attempts; i++) {
      let rec = null;
      try { rec = await rewindGetRecord(meta.sessionId, meta.step); } catch (e) {}
      if (rec && _recordShot(rec)) return rec;
      if (rec && (rec.isInitial || Number(rec.step) === 0) && rec.domSnapshot) return rec;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 350));
    }
    return null;
  }
  function _clearPanelLoading() {
    try {
      if (typeof global.hideTyping === 'function') global.hideTyping();
      else document.querySelector('.pageguide-typing')?.remove();
    } catch (e) {}
  }
  function _branchSessionId(parentSessionId, redoStep) {
    return String(parentSessionId) + '--branch-' + String(redoStep) + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }

  // ---- hover preview (lazy-loads the full record for the thumbnail) ----
  let _hoverCard = null;
  async function _showHover(meta, anchorEl) {
    _hideHover();
    let rec = await _getVerifiedRecord(meta, 1);
    if (!rec && !(meta.isInitial || Number(meta.step) === 0)) {
      _removeTimelineStep(meta);
      return;
    }
    const card = document.createElement('div');
    card.className = 'rw-hovercard';
    const shot = _recordShot(rec);
    const img = shot ? `<img src="data:image/jpeg;base64,${shot}" alt="">` : '';
    const bits = [];
    if (meta.confidence != null && meta.confidence < 0.5) bits.push('Review suggested');
    if (meta.durationMs != null) bits.push(_fmtDuration(meta.durationMs));
    const cost = _fmtCost(meta.cost); if (cost) bits.push(cost);
    card.innerHTML = `${img}<div class="rw-hc-instr">Step ${meta.step}</div><div>${_escape(meta.instruction || '')}</div><div class="rw-hc-meta">${bits.join(' · ')}</div>`;
    document.body.appendChild(card);
    const r = anchorEl.getBoundingClientRect();
    const top = Math.max(8, Math.min(r.top, window.innerHeight - card.offsetHeight - 8));
    card.style.top = top + 'px';
    card.style.left = Math.max(8, r.left - card.offsetWidth - 10) + 'px';
    _hoverCard = card;
  }
  function _hideHover() { if (_hoverCard) { _hoverCard.remove(); _hoverCard = null; } }

  document.addEventListener('mousemove', (e) => {
    if (!_hoverCard) return;
    if (!e.target.closest || !e.target.closest(`#${TIMELINE_ID} .rw-step`)) _hideHover();
  }, true);
  document.addEventListener('scroll', _hideHover, true);
  document.addEventListener('click', (e) => {
    if (!_hoverCard) return;
    if (!e.target.closest || !e.target.closest(`#${TIMELINE_ID} .rw-step`)) _hideHover();
  }, true);

  function _escape(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---- in-panel inspector ----
  function _openFullPageInspector(meta) {
    if (!meta) return;
    const url = chrome.runtime.getURL(`rewind/inspector.html?session=${encodeURIComponent(meta.sessionId || _sessionId || '')}&step=${encodeURIComponent(meta.step)}`);
    try { chrome.tabs.create({ url }); } catch (err) { window.open(url, '_blank'); }
  }

  async function _openInspector(meta) {
    _injectCss(); // ensure inspector styles exist even when the live timeline never mounted
    _hideHover();
    let rec = await _getVerifiedRecord(meta, 1);
    if (!rec && !(meta.isInitial || Number(meta.step) === 0)) {
      _removeTimelineStep(meta);
      return;
    }
    if (!rec) rec = meta; // fall back to lightweight meta

    const wrap = document.createElement('div');
    wrap.id = INSPECTOR_ID;
    let badgesHtml = '';
    if (rec.confidence != null) {
      const isHigh = rec.confidence >= 0.7;
      badgesHtml += `<span class="rw-ins-badge ${isHigh ? 'conf-high' : 'conf-med'}">● Confidence: ${Math.round(rec.confidence * 100)}%</span>`;
    }
    if (rec.verification?.status) {
      const v = rec.verification.status;
      const cls = v === 'success' ? 'verify-ok' : (v === 'failed' ? 'verify-failed' : 'verify-blocked');
      const label = v === 'success' ? 'Verified' : (v === 'failed' ? 'Failed' : 'Blocked');
      badgesHtml += `<span class="rw-ins-badge ${cls}">● ${label}</span>`;
    }

    const durationText = rec.durationMs != null ? 'Duration: ' + _fmtDuration(rec.durationMs) : '';
    const costText = _fmtCost(rec.cost) ? 'Cost: ' + _fmtCost(rec.cost) : '';
    const extraMeta = [durationText, costText].filter(Boolean).join('  ·  ');

    const shot = _recordShot(rec);
    const hasShot = !!shot;
    const hasSnap = !!rec.domSnapshot;

    wrap.innerHTML = `
      <div class="rw-ins-hdr">
        <button class="rw-ins-btn" data-rw="back">← Back</button>
        <span class="rw-ins-title">Step ${_escape(rec.step)}</span>
        <button class="rw-ins-btn" data-rw="steer" title="Branch off from this step with a new instruction">⤳ Steer from here</button>
        <button class="rw-ins-btn" data-rw="fullpage" title="Open in a new tab">Open detailed view ↗</button>
      </div>
      <div class="rw-ins-body">
        <div class="rw-why">
          <div><strong>What:</strong> ${_escape(rec.instruction)}</div>
          ${rec.target?.text ? `<div><strong>Element:</strong> ${_escape(rec.target.text)}</div>` : ''}
          ${rec.nextStepHint ? `<div><strong>Next:</strong> ${_escape(rec.nextStepHint)}</div>` : ''}
          <div style="margin-top:8px; display:flex; align-items:center; flex-wrap:wrap; gap:6px;">
            ${badgesHtml}
            ${extraMeta ? `<span style="opacity:.6; font-size:11px; margin-left:4px;">${_escape(extraMeta)}</span>` : ''}
          </div>
        </div>
        <div class="rw-steer" style="display:none">
          <div class="rw-steer-hdr">⤳ Steer from step ${_escape(rec.step)}</div>
          <textarea class="rw-steer-input" rows="3" placeholder="What should the agent do differently from here?"></textarea>
          <div class="rw-steer-note">This re-runs from this step on a fresh load and discards the steps after it.</div>
          <div class="rw-steer-actions">
            <button class="rw-ins-btn" data-rw="steer-cancel">Cancel</button>
            <button class="rw-ins-btn rw-steer-go" data-rw="steer-run">Run</button>
          </div>
        </div>
        <div class="rw-tabs">
          <button class="rw-ins-btn ${hasShot ? 'active' : ''}" data-rw="tab" data-view="shot" ${hasShot ? '' : 'disabled'}>📷 Screenshot</button>
          <button class="rw-ins-btn ${!hasShot && hasSnap ? 'active' : ''}" data-rw="tab" data-view="snap" ${hasSnap ? '' : 'disabled'}>🧩 Page snapshot</button>
        </div>
        <div class="rw-view"></div>
        ${rec.rawLlmJson ? `<details><summary>Raw agent response</summary><pre>${_escape(rec.rawLlmJson)}</pre></details>` : ''}
      </div>`;
    document.body.appendChild(wrap);

    const view = wrap.querySelector('.rw-view');
    function renderView(which) {
      if (which === 'snap' && hasSnap) {
        view.innerHTML = `<div class="rw-snap-wrap"><div class="rw-snap-banner">🔒 Read-only snapshot</div><iframe sandbox></iframe></div>`;
        const iframe = view.querySelector('iframe');
        iframe.srcdoc = rec.domSnapshot;
      } else if (hasShot) {
        view.innerHTML = `<img src="data:image/jpeg;base64,${shot}" alt="Step ${_escape(rec.step)} screenshot">`;
      } else {
        view.innerHTML = `<div style="opacity:.6">No capture available for this step.</div>`;
      }
    }
    renderView(hasShot ? 'shot' : 'snap');

    const steerBox = wrap.querySelector('.rw-steer');
    wrap.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-rw]');
      if (!btn) return;
      const kind = btn.getAttribute('data-rw');
      if (kind === 'back') { wrap.remove(); }
      else if (kind === 'fullpage') {
        _openFullPageInspector({ sessionId: rec.sessionId || meta.sessionId, step: rec.step });
      } else if (kind === 'tab') {
        wrap.querySelectorAll('[data-rw="tab"]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderView(btn.getAttribute('data-view'));
      } else if (kind === 'steer') {
        if (steerBox) {
          const showing = steerBox.style.display !== 'none';
          steerBox.style.display = showing ? 'none' : '';
          if (!showing) { const ta = steerBox.querySelector('.rw-steer-input'); if (ta) ta.focus(); }
        }
      } else if (kind === 'steer-cancel') {
        if (steerBox) steerBox.style.display = 'none';
      } else if (kind === 'steer-run') {
        await _runSteer(wrap, rec, meta, btn);
      }
    });
  }

  // Rewind to BEFORE the clicked step and redo it: restore the page to the state before step N's
  // action (== the state after step N-1) and re-run from step N with the new instruction. This is
  // implemented as "branch after step N-1": step N-1's record holds that before-N state (its
  // post-action url + restore). For step 1, the anchor is the Initial-state node (step 0). Shared
  // by the in-panel inspector and the goal-dot preview card. Returns true on success.
  async function steerFromStep(meta, newGoal) {
    newGoal = (newGoal || '').trim();
    if (!meta || !newGoal) return false;
    const sessionId = meta.sessionId || _sessionId;
    const redoStep = Number(meta.step);
    if (!sessionId || !Number.isFinite(redoStep)) return false;
    const anchorStep = redoStep - 1; // branch after this step (its after-state == before redoStep)

    // Land on the ANCHOR's page (the state before the step we're redoing).
    let landingUrl = null;
    try {
      if (typeof rewindGetRecord === 'function') {
        const anchorRec = await rewindGetRecord(sessionId, anchorStep); // anchorStep may be 0 (initial node)
        if (anchorRec && anchorRec.url) landingUrl = anchorRec.url;
      }
    } catch (e) {}
    if (!landingUrl) landingUrl = meta.url || null; // fallback to the clicked step's url
    if (!landingUrl) {
      try { chrome.runtime.sendMessage({ action: 'addMessage', content: '⚠ Cannot rewind this step — missing its page URL.', type: 'error' }); } catch (e) {}
      return false;
    }

    const branchSessionId = _branchSessionId(sessionId, redoStep);
    const branchLabel = 'View journey before Step ' + redoStep;
    const branchTitle = 'Before Step ' + redoStep;
    const payload = {
      sessionId: branchSessionId,
      parentSessionId: sessionId,
      fromStep: anchorStep,
      redoStep,
      newGoal,
      url: landingUrl,
      branchLabel,
      createdAt: Date.now()
    };
    try {
      // Branch forward: copy the prefix into a new session. The original journey stays intact.
      if (typeof rewindCreateBranchSession === 'function') {
        await rewindCreateBranchSession(sessionId, branchSessionId, anchorStep, {
          redoStep,
          branchLabel,
          branchStatus: 'pending_restore',
          goal: branchTitle
        });
      }
      // Stash the handoff too — it's the fallback path if we have to reload (different page).
      if (typeof rewindSetSteerPending === 'function') await rewindSetSteerPending(payload);
      try {
        chrome.runtime.sendMessage({
          action: 'addMessage',
          content: `↩ Rewinding to before step ${redoStep} and redoing it — applying: “${newGoal}”`,
          type: 'info'
        });
      } catch (e) {}
      const applied = await _rwApplySteer(payload);
      if (!applied) {
        _clearPanelLoading();
        try {
          chrome.runtime.sendMessage({
            action: 'addMessage',
            content: '⚠ Could not rewind this step. Try opening the page again, then run the steer from there.',
            type: 'error'
          });
        } catch (e) {}
        return false;
      }
      try {
        if (typeof global.registerBranchJourney === 'function') {
          await global.registerBranchJourney(branchSessionId, branchLabel);
        } else if (typeof global.addJourneyRecallMessage === 'function') {
          global.addJourneyRecallMessage(branchSessionId, branchTitle, branchLabel);
        }
        if (typeof global.showStoredJourney === 'function') await global.showStoredJourney(branchSessionId);
        if (typeof global.showBranchTree === 'function') {
          global.showBranchTree();
        }
      } catch (e) {}
      return true;
    } catch (err) {
      console.warn('[rewind] steer failed:', err);
      return false;
    }
  }

  // Remove Journey-timeline rows after `step` (keeps the live timeline in sync on rebranch).
  function dropStepsAfter(step) {
    const n = Number(step);
    const container = document.getElementById(TIMELINE_ID);
    if (!container || !Number.isFinite(n)) return;
    container.querySelectorAll('.rw-step').forEach(r => {
      const k = parseInt(r.getAttribute('data-step'), 10);
      if (Number.isFinite(k) && k > n) r.remove();
    });
  }

  // Apply a steer to the working tab. If it's already on the branch URL, fork IN PLACE on the
  // live page (no reload — vital for SPAs like Google Slides that lose state / prompt on
  // reload). Different page → navigate there; the content script picks up the stashed handoff
  // on load. Falls back to the SW navigateTab handler if direct tab access fails.
  function _rwStripHash(u) { try { const x = new URL(u); return x.origin + x.pathname + x.search; } catch (e) { return u; } }
  async function _rwApplySteer(payload) {
    const url = payload.url;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (tab && tab.id != null) {
        const samePage = !!tab.url && _rwStripHash(tab.url) === _rwStripHash(url);
        if (samePage) {
          // No reload: tell the content script to re-run on the current live DOM.
          console.log('[rewind] steer: in-place re-run on working tab', tab.id);
          try {
            const res = await chrome.tabs.sendMessage(tab.id, { action: 'gv2SteerNow', payload });
            if (!res || res.success === false) return false;
            return true;
          }
          catch (e) { console.warn('[rewind] in-place steer message failed, reloading instead:', e); await chrome.tabs.reload(tab.id); return true; }
        }
        console.log('[rewind] steer: navigating working tab', tab.id, '→', url);
        await chrome.tabs.update(tab.id, { url });
        return true;
      }
    } catch (e) { console.warn('[rewind] steer apply failed, falling back to SW:', e); }
    try { chrome.runtime.sendMessage({ action: 'navigateTab', url }); return true; } catch (e) {}
    return false;
  }

  async function _runSteer(wrap, rec, meta, runBtn) {
    const ta = wrap.querySelector('.rw-steer-input');
    const newGoal = ta ? ta.value.trim() : '';
    if (!newGoal) { if (ta) ta.focus(); return; }
    if (runBtn) runBtn.disabled = true;
    const ok = await steerFromStep({ sessionId: rec.sessionId || meta.sessionId, step: rec.step, url: rec.url || meta.url }, newGoal);
    if (ok) wrap.remove();
    else {
      _clearPanelLoading();
      if (runBtn) runBtn.disabled = false;
    }
  }

  // ---- plan strip ----
  let _plan = [];
  let _planProgress = 0; // highest plan step reached

  function _renderPlan() {
    const container = _ensureContainer();
    const strip = container.querySelector('.rw-plan');
    if (!_plan.length) { strip.style.display = 'none'; return; }
    container.style.display = '';
    strip.style.display = '';
    strip.innerHTML = '<div class="rw-plan-hdr">Plan</div>' + _plan.map(p => {
      const done = p.n < _planProgress;
      const current = p.n === _planProgress;
      const mark = done ? '✓' : (current ? '▸' : '○');
      const cls = done ? 'done' : (current ? 'current' : '');
      return `<div class="rw-plan-item ${cls}"><span class="rw-pi-mark">${mark}</span><span>${_escape(p.goal)}</span></div>`;
    }).join('');
  }

  function setPlan(plan) {
    _plan = Array.isArray(plan) ? plan : [];
    _planProgress = _plan.length ? 1 : 0;
    _renderPlan();
  }

  // ---- public API ----
  function addStep(meta) {
    if (!meta) return;
    _sessionId = meta.sessionId;
    const container = _ensureContainer();
    container.style.display = '';

    // Advance plan progress from the step's reported planStep.
    if (meta.planStep && meta.planStep > _planProgress) { _planProgress = meta.planStep; _renderPlan(); }
    const track = container.querySelector('.rw-track');

    // Low confidence → flag the step for review (the numeric score is NOT shown).
    const lowConf = (meta.confidence != null && meta.confidence < 0.5);
    let row = track.querySelector(`[data-step="${meta.step}"]`);
    const created = !row;
    if (!row) {
      row = document.createElement('div');
      row.className = 'rw-step';
      row.setAttribute('data-step', meta.step);
    }
    row.classList.toggle('rw-review', lowConf);

    const when = _fmtDuration(meta.durationMs);
    row.innerHTML = `
      <span class="rw-dot"></span>
      <span class="rw-body">
        <span class="rw-instr">${_escape(meta.instruction || ('Step ' + meta.step))}</span>
        ${lowConf ? '<span class="rw-flag">⚑ Review</span>' : ''}
      </span>
      <span class="rw-right">
        <span class="rw-when"></span>
        <img class="rw-thumb" alt="" style="display:none">
      </span>`;

    if (created) track.appendChild(row);

    // State: this step is "current" (Now) unless it is the final step; demote earlier
    // steps to "done". markVerify may later override the dot color.
    const isLast = !!meta.isLastStep;
    track.querySelectorAll('.rw-step').forEach(r => {
      const n = parseInt(r.getAttribute('data-step'), 10);
      if (n < meta.step) { r.classList.add('done'); r.classList.remove('current'); }
    });
    row.classList.toggle('current', !isLast);
    row.classList.toggle('done', isLast);
    row.querySelector('.rw-when').textContent = isLast ? '' : (row.classList.contains('current') ? 'Now' : when);
    // Done rows show their duration instead of "Now".
    track.querySelectorAll('.rw-step.done').forEach(r => {
      const w = r.querySelector('.rw-when');
      if (w && (!w.textContent || w.textContent === 'Now')) {
        const d = r.getAttribute('data-duration');
        if (d) w.textContent = _fmtDuration(parseInt(d, 10));
      }
    });
    if (meta.durationMs != null) row.setAttribute('data-duration', meta.durationMs);

    // Lazy-load the snapshot thumbnail from the store (kept out of the message payload).
    if (typeof rewindGetRecord === 'function') {
      _getVerifiedRecord(meta).then(rec => {
        const shot = _recordShot(rec);
        if (shot) {
          const img = row.querySelector('.rw-thumb');
          if (img) { img.src = 'data:image/jpeg;base64,' + shot; img.style.display = ''; }
        } else if (!(meta.isInitial || Number(meta.step) === 0)) {
          _removeTimelineStep(meta);
        }
      }).catch(() => {});
    }

    row.onclick = () => { _hideHover(); _openInspector(meta); };
    row.onmouseenter = () => _showHover(meta, row);
    row.onmouseleave = _hideHover;
  }

  // Mark a step's dot with its verification verdict (Slice 3).
  function markVerify(step, status, reason) {
    const container = document.getElementById(TIMELINE_ID);
    if (!container) return;
    const row = container.querySelector(`[data-step="${step}"]`);
    if (!row) return;
    row.classList.remove('rw-verify-failed', 'rw-verify-blocked', 'rw-verify-ok');
    if (status === 'failed') row.classList.add('rw-verify-failed');
    else if (status === 'blocked') row.classList.add('rw-verify-blocked');
    else if (status === 'success') row.classList.add('rw-verify-ok');
    if (reason) row.title = 'Verification: ' + status + ' — ' + reason;
  }

  function clear() {
    _hideHover();
    _plan = [];
    _planProgress = 0;
    const el = document.getElementById(TIMELINE_ID);
    if (el) {
      el.querySelector('.rw-track').innerHTML = '';
      const strip = el.querySelector('.rw-plan');
      if (strip) { strip.innerHTML = ''; strip.style.display = 'none'; }
      el.style.display = 'none';
    }
    const ins = document.getElementById(INSPECTOR_ID);
    if (ins) ins.remove();
    _sessionId = null;
  }

  global.RewindTimeline = { addStep, clear, setPlan, markVerify, openStep: _openInspector, openFullPageStep: _openFullPageInspector, steerFromStep, dropStepsAfter };
})(typeof window !== 'undefined' ? window : globalThis);
