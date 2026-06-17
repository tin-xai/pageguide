// PageGuide - Full-page Step Inspector
// Reads ?session=<id>&step=<n>, then renders a slider-driven inspection view with
// before-action screenshot, read-only page snapshot, after-action screenshot, and raw memory.

(function () {
  const params = new URLSearchParams(location.search);
  let sessionId = params.get('session');
  let step = parseInt(params.get('step'), 10);
  let indexSteps = [];
  let currentRecord = null;
  let currentView = null;

  const $ = id => document.getElementById(id);

  try {
    const savedTheme = localStorage.getItem('pageguide-theme');
    if (savedTheme === 'light') document.body.classList.add('light-mode');
    else if (savedTheme === 'dark') document.body.classList.add('dark-mode');
  } catch (e) {}

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function fmtDuration(ms) {
    if (ms == null) return '';
    return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
  }

  function fmtCost(cost) {
    if (!cost || cost.usd == null) return '';
    return '$' + Number(cost.usd).toFixed(4);
  }

  function stepName(s) {
    return (s && (s.isInitial || Number(s.step) === 0)) ? 'Initial state' : 'Step ' + (s ? s.step : step);
  }

  function currentStepIndex() {
    const idx = indexSteps.findIndex(s => Number(s.step) === Number(step));
    return idx >= 0 ? idx : 0;
  }

  async function populateStepSelect() {
    let index = null;
    try {
      index = await rewindGetIndex(sessionId || undefined);
      if (index?.sessionId && typeof rewindVerifyScreenshots === 'function') {
        index = await rewindVerifyScreenshots(index.sessionId);
      }
    } catch (e) {}
    const sel = $('step-select');
    sel.innerHTML = '';
    indexSteps = (index && Array.isArray(index.steps)) ? index.steps.slice().sort((a, b) => Number(a.step) - Number(b.step)) : [];
    if (index && !sessionId) sessionId = index.sessionId;
    if (!indexSteps.length && Number.isFinite(step)) indexSteps = [{ sessionId, step }];
    if (indexSteps.length && !indexSteps.some(s => Number(s.step) === Number(step))) {
      step = Number(indexSteps[0].step);
    }

    indexSteps.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.step;
      opt.textContent = stepName(s);
      if (Number(s.step) === Number(step)) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = () => setStep(parseInt(sel.value, 10));
    renderTimeline();
  }

  function renderTimeline() {
    const wrap = $('timeline');
    const track = $('timeline-track');
    if (!wrap || !track) return;

    if (!indexSteps.length) {
      wrap.style.display = 'none';
      return;
    }

    const idx = currentStepIndex();
    wrap.style.display = '';

    track.innerHTML = indexSteps.map((s, i) => {
      const conf = typeof s.confidence === 'number' ? s.confidence : null;
      const verifyFailed = s.verification && s.verification.status && s.verification.status !== 'success';
      const review = verifyFailed || (conf != null && conf < 0.7);
      const cls = ['step-chip'];
      if (i < idx) cls.push('done');
      if (review) cls.push('review');
      if (i === idx) cls.push('current');
      const meta = [];
      if (s.durationMs != null) meta.push(fmtDuration(s.durationMs));
      if (review) meta.push('Review');
      return `<button type="button" class="${cls.join(' ')}" data-step="${esc(s.step)}" title="${esc(stepName(s) + (s.instruction ? ' — ' + s.instruction : ''))}" aria-current="${i === idx ? 'step' : 'false'}">
        <span class="step-dot" aria-hidden="true"></span>
        <span>
          <span class="step-chip-title">${esc((s.isInitial || Number(s.step) === 0) ? 'Init' : 'Step ' + s.step)}</span>
          <span class="step-chip-text">${esc(s.instruction || stepName(s))}</span>
          ${meta.length ? `<span class="step-chip-meta">${esc(meta.join(' · '))}</span>` : ''}
        </span>
      </button>`;
    }).join('');
    track.querySelectorAll('[data-step]').forEach(btn => {
      btn.addEventListener('click', () => setStep(Number(btn.getAttribute('data-step'))));
    });
    const current = track.querySelector('.step-chip.current');
    if (current && typeof current.scrollIntoView === 'function') {
      try { current.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {}
    }
  }

  async function setStep(nextStep) {
    if (!Number.isFinite(nextStep)) return;
    step = nextStep;
    const sel = $('step-select');
    if (sel) sel.value = String(step);
    currentView = null;
    await render();
  }

  function confidencePill(confidence) {
    if (confidence == null || !Number.isFinite(Number(confidence))) return '';
    const val = Math.max(0, Math.min(1, Number(confidence)));
    const review = val < 0.7;
    return `<span class="pill ${review ? 'review' : 'ok'}">${review ? 'Needs review' : 'Confident'} · ${Math.round(val * 100)}%</span>`;
  }

  function verificationPill(verification) {
    if (!verification || !verification.status) return '';
    const ok = verification.status === 'success';
    return `<span class="pill ${ok ? 'ok' : 'review'}">Verify: ${esc(verification.status)}</span>`;
  }

  function renderTaskPanel(rec) {
    const cost = fmtCost(rec.cost);
    const meta = [
      confidencePill(rec.confidence),
      rec.durationMs != null ? `<span class="pill">Duration: ${esc(fmtDuration(rec.durationMs))}</span>` : '',
      cost ? `<span class="pill">Cost: ${esc(cost)}</span>` : '',
      verificationPill(rec.verification)
    ].filter(Boolean).join('');
    const url = rec.url
      ? `<a href="${esc(rec.url)}" target="_blank" rel="noreferrer">${esc(rec.url)}</a>`
      : '';
    const targetText = rec.target && rec.target.text ? rec.target.text : '';
    const title = rec.isInitial || Number(rec.step) === 0 ? 'Initial page state' : (rec.instruction || 'Captured step');

    $('why').innerHTML = `
      <div class="current-task">
        <div class="task-head">
          <span class="step-badge">${esc(stepName(rec))}</span>
          <h2 class="task-title">${esc(title)}</h2>
        </div>
        <div class="task-grid">
          <div class="task-row"><span class="task-key">Target</span><span class="task-value">${esc(rec.instruction || 'Initial state')}</span></div>
          ${targetText ? `<div class="task-row"><span class="task-key">Element</span><span class="task-value">${esc(targetText)}</span></div>` : ''}
          ${rec.nextStepHint ? `<div class="task-row"><span class="task-key">Next</span><span class="task-value">${esc(rec.nextStepHint)}</span></div>` : ''}
          ${rec.action ? `<div class="task-row"><span class="task-key">Action</span><span class="task-value">${esc(rec.action)}${rec.typeText ? ' = "' + esc(rec.typeText) + '"' : ''}</span></div>` : ''}
          ${url ? `<div class="task-row"><span class="task-key">Link</span><span class="task-value">${url}</span></div>` : ''}
        </div>
        ${meta ? `<div class="meta">${meta}</div>` : ''}
      </div>`;
  }

  function renderMemoryPanel(rec) {
    const mem = $('memory');
    if (!mem) return;
    const bits = [];

    if (rec.title || rec.risk || rec.restore) {
      const stateBits = [];
      if (rec.title) stateBits.push(`<div class="memory-item"><b>Page title</b>${esc(rec.title)}</div>`);
      if (rec.risk) stateBits.push(`<div class="memory-item"><b>Risk</b>${esc(rec.risk)}</div>`);
      if (rec.restore) {
        const r = rec.restore;
        const ls = r.localStorage ? Object.keys(r.localStorage).length : 0;
        const ss = r.sessionStorage ? Object.keys(r.sessionStorage).length : 0;
        const fm = Array.isArray(r.forms) ? r.forms.length : 0;
        const scroll = r.scroll ? ((r.scroll.x | 0) + ',' + (r.scroll.y | 0)) : 'none';
        stateBits.push(`<div class="memory-item"><b>Captured state</b>${ls} localStorage · ${ss} sessionStorage · ${fm} field(s) · scroll ${esc(scroll)}</div>`);
      }
      if (stateBits.length) bits.push(`<div class="memory-grid">${stateBits.join('')}</div>`);
    }

    if (Array.isArray(rec.restoreLog) && rec.restoreLog.length) {
      const fmt = (typeof gv2FriendlyRestoreAction === 'function') ? gv2FriendlyRestoreAction : ((typeof gv2DescribeRestoreAction === 'function') ? gv2DescribeRestoreAction : (e) => (e && e.kind) || '');
      const tech = (typeof gv2RestoreTechnicalDetail === 'function') ? gv2RestoreTechnicalDetail : ((typeof gv2DescribeRestoreAction === 'function') ? gv2DescribeRestoreAction : (e) => (e && e.kind) || '');
      const when = rec.restoredAt ? ' · ' + new Date(rec.restoredAt).toLocaleString() : '';
      const items = rec.restoreLog.map(e => `<li>${esc(fmt(e))}</li>`).join('');
      const techItems = rec.restoreLog.map(e => `<li>${esc(tech(e))}</li>`).join('');
      bits.push(`<details open><summary>Restore log${esc(when)}</summary><ul class="restore-list">${items}</ul>
        <details><summary>Technical details</summary><ul class="restore-list">${techItems}</ul></details></details>`);
    }

    if (rec.regionShot || rec.regionDom) {
      const region = [];
      if (rec.regionShot) {
        region.push(`<div class="memory-item"><b>Target region</b><img src="data:image/jpeg;base64,${rec.regionShot}" alt="target region" style="width:100%;border-radius:8px;border:1px solid var(--pg-border);display:block"></div>`);
      }
      if (rec.regionDom) {
        region.push(`<details class="memory-item"><summary>Region DOM snapshot</summary><iframe class="rw-region-dom" sandbox style="height:40vh;margin-top:8px"></iframe></details>`);
      }
      bits.push(`<div class="memory-grid">${region.join('')}</div>`);
    }

    if (!bits.length) {
      mem.style.display = 'none';
      mem.innerHTML = '';
      return;
    }
    mem.innerHTML = bits.join('');
    mem.style.display = '';
    if (rec.regionDom) {
      const frame = mem.querySelector('.rw-region-dom');
      if (frame) frame.srcdoc = rec.regionDom;
    }
  }

  function viewAvailability(rec) {
    const resolved = (typeof rewindResolveScreenshot === 'function')
      ? rewindResolveScreenshot(rec)
      : (rec.screenshotBefore || rec.screenshot || rec.screenshotAfter || null);
    return {
      beforeShot: rec.screenshotBefore || rec.screenshot || resolved || null,
      beforeSnap: rec.domSnapshot || null,
      afterShot: rec.screenshotAfter || null
    };
  }

  function defaultView(rec) {
    const a = viewAvailability(rec);
    if (a.beforeShot) return 'before';
    if (a.afterShot) return 'after';
    if (a.beforeSnap) return 'snap';
    return 'before';
  }

  function showView(which) {
    if (!currentRecord) return;
    const a = viewAvailability(currentRecord);
    const available = {
      before: !!a.beforeShot,
      snap: !!a.beforeSnap,
      after: !!a.afterShot
    };
    if (!available[which]) which = defaultView(currentRecord);
    currentView = which;

    const tabs = {
      before: $('tab-before'),
      snap: $('tab-snap'),
      after: $('tab-after')
    };
    Object.keys(tabs).forEach(k => {
      if (!tabs[k]) return;
      tabs[k].disabled = !available[k];
      tabs[k].classList.toggle('active', which === k && available[k]);
      tabs[k].onclick = () => !tabs[k].disabled && showView(k);
    });

    const view = $('view');
    if (which === 'snap' && a.beforeSnap) {
      view.innerHTML = `<div class="snap-wrap"><div class="snap-banner">Read-only page snapshot — before action</div><iframe sandbox></iframe></div>`;
      view.querySelector('iframe').srcdoc = a.beforeSnap;
    } else if (which === 'after' && a.afterShot) {
      view.innerHTML = `<img src="data:image/jpeg;base64,${a.afterShot}" alt="${esc(stepName(currentRecord))} after action">`;
    } else if (a.beforeShot) {
      view.innerHTML = `<img src="data:image/jpeg;base64,${a.beforeShot}" alt="${esc(stepName(currentRecord))} before action">`;
    } else {
      view.innerHTML = `<div class="empty">No ${esc(which)} capture available for this step.</div>`;
    }
  }

  function renderRawAndRecord(rec) {
    if (rec.rawLlmJson) {
      $('raw-wrap').style.display = '';
      $('raw').textContent = rec.rawLlmJson;
    } else {
      $('raw-wrap').style.display = 'none';
    }

    const recordWrap = $('record-wrap'), recordPre = $('record');
    if (!recordWrap || !recordPre) return;
    try {
      const copy = Object.assign({}, rec);
      for (const k of ['screenshot', 'screenshotBefore', 'screenshotAfter', 'regionShot']) {
        if (copy[k]) copy[k] = '[base64 ' + copy[k].length + ' chars]';
      }
      for (const k of ['domSnapshot', 'domSnapshotAfter', 'regionDom']) {
        if (copy[k]) copy[k] = '[html ' + copy[k].length + ' chars]';
      }
      recordPre.textContent = JSON.stringify(copy, null, 2);
      recordWrap.style.display = '';
    } catch (e) {
      recordWrap.style.display = 'none';
    }
  }

  async function render() {
    let rec = null;
    try { rec = await rewindGetRecord(sessionId, step); } catch (e) {}
    currentRecord = rec;

    if (!rec) {
      $('empty').style.display = '';
      $('content').style.display = 'none';
      renderTimeline();
      return;
    }

    $('empty').style.display = 'none';
    $('content').style.display = '';
    $('title').textContent = stepName(rec) + ' — Inspector';

    renderTimeline();
    renderTaskPanel(rec);
    renderMemoryPanel(rec);
    showView(currentView || defaultView(rec));
    renderRawAndRecord(rec);
  }

  (async function init() {
    await populateStepSelect();
    if (!Number.isFinite(step)) {
      const first = indexSteps[0];
      if (first) step = Number(first.step);
    }
    const sel = $('step-select');
    if (sel && Number.isFinite(step)) sel.value = String(step);
    await render();
  })();
})();
