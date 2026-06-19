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
  let debugEnabled = false;
  let chartVisibleVersions = { full: true, reduced: true, noloop: true };

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

  // Show how confidence is composed: the three LLM signals grounded (G), loop (L), progress (P),
  // and BOTH formula versions side by side (full = G·loop·progress, no-progress = G·loop) so they
  // can be compared. Both are recomputed from the stored signals via the shared pure helper.
  function confidenceBreakdown(rec) {
    const fmt = (v) => Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '—';
    const pct = (c) => (c != null) ? Math.round(c * 100) + '%' : '—';
    if (rec.grounded == null && rec.loop == null && rec.progress == null) return '';
    const parts = [
      `<span class="pill">G: ${fmt(rec.grounded)}</span>`,
      `<span class="pill">L: ${fmt(rec.loop)}</span>`,
      `<span class="pill">P: ${fmt(rec.progress)}</span>`
    ];
    if (typeof gv2ComputeConfidence === 'function') {
      const signals = { grounded: rec.grounded, loop: rec.loop, progress: rec.progress };
      const cFull = gv2ComputeConfidence(signals, 'full').confidence;
      const cReduced = gv2ComputeConfidence(signals, 'reduced').confidence;
      const cNoLoop = gv2ComputeConfidence(signals, 'noloop').confidence;
      const active = rec.confidenceFormula || 'full';
      parts.push(`<span class="pill ${active === 'full' ? 'ok' : ''}">Full: ${pct(cFull)}</span>`);
      parts.push(`<span class="pill ${active === 'reduced' ? 'ok' : ''}">No-progress: ${pct(cReduced)}</span>`);
      parts.push(`<span class="pill ${active === 'noloop' ? 'ok' : ''}">No-loop: ${pct(cNoLoop)}</span>`);
    }
    return parts.join('');
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

    const breakdownHtml = debugEnabled ? confidenceBreakdown(rec) : '';
    // Debug developer tools, inside the task panel: download every step's data, and a collapsible
    // chart comparing all three confidence formulas across the whole session.
    const devToolsHtml = debugEnabled ? `
        <div class="meta" style="margin-top:10px;">
          <button class="tab" id="dev-download-btn" style="min-width:auto;">⬇ Download all step data</button>
        </div>
        <details id="dev-chart-wrap" style="margin-top:10px;">
          <summary>📈 Confidence chart — Full vs No-progress vs No-loop (all steps)</summary>
          <div style="margin:8px 0;"><button class="tab" id="dev-chart-btn" style="min-width:auto;">Refresh chart</button></div>
          <div id="dev-chart-filters" class="meta"></div>
          <div id="dev-chart"></div>
        </details>` : '';

    $('why').innerHTML = `
      <div class="current-task">
        <div class="task-head">
          <span class="step-badge">${esc(stepName(rec))}</span>
          <h2 class="task-title">${esc(title)}</h2>
        </div>
        <div class="task-grid">
          <div class="task-row"><span class="task-key">Target</span><span class="task-value">${esc(rec.instruction || 'Initial state')}</span></div>
          ${targetText ? `<div class="task-row"><span class="task-key">Element</span><span class="task-value">${esc(targetText)}</span></div>` : ''}
          ${rec.action ? `<div class="task-row"><span class="task-key">Action</span><span class="task-value">${esc(rec.action)}${rec.typeText ? ' = "' + esc(rec.typeText) + '"' : ''}</span></div>` : ''}
          ${url ? `<div class="task-row"><span class="task-key">Link</span><span class="task-value">${url}</span></div>` : ''}
        </div>
        ${meta ? `<div class="meta">${meta}</div>` : ''}
        ${breakdownHtml ? `<div class="meta">${breakdownHtml}</div>` : ''}
        ${devToolsHtml}
      </div>`;

    // Wire the debug tools (re-created on every render, so attach listeners each time).
    if (debugEnabled) {
      const dl = $('dev-download-btn');
      if (dl) dl.addEventListener('click', downloadAllStepData);
      const chartBox = $('dev-chart');
      const chartBtn = $('dev-chart-btn');
      renderChartFilters();
      if (chartBtn) chartBtn.addEventListener('click', async () => {
        if (!window.confirm('Refresh the confidence chart from the latest saved step data?')) return;
        await populateStepSelect();
        renderConfChartInto(chartBox);
      });
      const chartWrap = $('dev-chart-wrap');
      if (chartWrap) chartWrap.addEventListener('toggle', () => { if (chartWrap.open) renderConfChartInto(chartBox); }, { once: true });
    }
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
    if (rec.systemPrompt) {
      $('prompt-system-wrap').style.display = '';
      $('prompt-system').textContent = rec.systemPrompt;
    } else {
      $('prompt-system-wrap').style.display = 'none';
    }

    if (rec.userPrompt) {
      $('prompt-user-wrap').style.display = '';
      $('prompt-user').textContent = rec.userPrompt;
    } else {
      $('prompt-user-wrap').style.display = 'none';
    }

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

  // Confidence line colors, shared by the chart + legends.
  const CONF_COLORS = { full: '#7857ff', reduced: '#ff8a3d', noloop: '#1bbf9c' };
  const CONF_LABELS = {
    full: 'Full (G·loop·progress)',
    reduced: 'No-progress (G·loop)',
    noloop: 'No-loop (G·progress)'
  };

  function normalizeChartVisible(next, changedKey) {
    const clean = {
      full: next?.full !== false,
      reduced: next?.reduced !== false,
      noloop: next?.noloop !== false
    };
    if (!clean.full && !clean.reduced && !clean.noloop) clean[changedKey || 'full'] = true;
    return clean;
  }

  function renderChartFilters() {
    const wrap = $('dev-chart-filters');
    if (!wrap) return;
    chartVisibleVersions = normalizeChartVisible(chartVisibleVersions);
    wrap.innerHTML = Object.keys(CONF_LABELS).map(key => `
      <button type="button" class="tab chart-version-filter${chartVisibleVersions[key] ? ' active' : ''}" data-chart-version="${key}" aria-pressed="${chartVisibleVersions[key] ? 'true' : 'false'}" style="min-width:auto;margin-right:6px;">
        <span style="display:inline-block;width:12px;height:3px;border-radius:2px;background:${CONF_COLORS[key]}"></span> ${esc(CONF_LABELS[key])}
      </button>`).join('');
    wrap.querySelectorAll('[data-chart-version]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-chart-version');
        chartVisibleVersions = normalizeChartVisible({ ...chartVisibleVersions, [key]: !chartVisibleVersions[key] }, key);
        renderChartFilters();
        renderConfChartInto($('dev-chart'));
      });
    });
  }

  // Build an SVG triple-line chart from per-step {step, full, reduced, noloop} confidence rows.
  function buildConfChartSvg(data, visible = chartVisibleVersions) {
    visible = normalizeChartVisible(visible);
    const keys = Object.keys(CONF_LABELS).filter(k => visible[k]);
    const W = 600, H = 220, padL = 38, padR = 16, padT = 18, padB = 30;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const n = data.length;
    const xAt = (i) => n <= 1 ? padL + innerW / 2 : padL + (i / (n - 1)) * innerW;
    const yAt = (v) => padT + (1 - Math.max(0, Math.min(1, v))) * innerH;
    const line = (key) => {
      const pts = data.map((d, i) => d[key] == null ? null : `${xAt(i).toFixed(1)},${yAt(d[key]).toFixed(1)}`).filter(Boolean);
      return pts.length ? `<polyline data-version="${key}" points="${pts.join(' ')}" fill="none" stroke="${CONF_COLORS[key]}" stroke-width="2.2"/>` : '';
    };
    const dots = (key) => data.map((d, i) => d[key] == null ? '' : `<circle data-version="${key}" cx="${xAt(i).toFixed(1)}" cy="${yAt(d[key]).toFixed(1)}" r="3" fill="${CONF_COLORS[key]}"/>`).join('');
    const grid = [0, 0.25, 0.5, 0.75, 1].map(v => {
      const y = yAt(v).toFixed(1);
      return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(128,128,128,.22)" stroke-width="1"/>`
        + `<text x="${padL - 6}" y="${(yAt(v) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="currentColor" opacity=".55">${Math.round(v * 100)}</text>`;
    }).join('');
    const xlabels = data.map((d, i) => `<text x="${xAt(i).toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="10" fill="currentColor" opacity=".55">${esc(String(d.step))}</text>`).join('');
    const legendItem = (key) => `<span class="pill" style="color:${CONF_COLORS[key]}"><b style="display:inline-block;width:12px;height:3px;border-radius:2px;background:${CONF_COLORS[key]}"></b> ${CONF_LABELS[key]}</span>`;
    return `
      <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Confidence comparison chart">
        ${grid}
        ${keys.map(line).join('')}
        ${keys.map(dots).join('')}
        ${xlabels}
        <text x="${padL}" y="12" font-size="10" fill="currentColor" opacity=".55">confidence %  ·  x = step</text>
      </svg>
      <div class="meta" style="margin-top:8px;">
        ${keys.map(legendItem).join('')}
      </div>`;
  }

  // Build [{step, full, reduced, noloop}] rows from the session's in-memory step index. All three
  // formula versions are recomputed from each step's stored signals (grounded/loop/progress).
  function _confChartRows() {
    if (typeof gv2ComputeConfidence !== 'function') return [];
    return (Array.isArray(indexSteps) ? indexSteps : [])
      .slice().sort((a, b) => Number(a.step) - Number(b.step))
      .map(m => {
        if (m.grounded == null && m.loop == null && m.progress == null) return null;
        const signals = { grounded: m.grounded, loop: m.loop, progress: m.progress };
        const full = gv2ComputeConfidence(signals, 'full').confidence;
        const reduced = gv2ComputeConfidence(signals, 'reduced').confidence;
        const noloop = gv2ComputeConfidence(signals, 'noloop').confidence;
        return (full != null || reduced != null || noloop != null) ? { step: m.step, full, reduced, noloop } : null;
      })
      .filter(Boolean);
  }

  // Render the double-line chart into the given container element.
  function renderConfChartInto(box) {
    if (!box) return;
    const data = _confChartRows();
    if (!data.length) {
      box.innerHTML = '<div class="empty" style="padding:20px">No steps with confidence signals yet. Run a guide (after reloading the extension) so steps capture grounded/loop/progress.</div>';
      return;
    }
    box.innerHTML = buildConfChartSvg(data);
  }

  // Developer export: download every step's data (agent response, prompts, confidence + both
  // formula versions, link, target, timing) plus the comparison chart SVG, as one JSON file.
  async function downloadAllStepData() {
    const rows = [];
    for (const m of (Array.isArray(indexSteps) ? indexSteps : [])) {
      let rec = null;
      try { rec = await rewindGetRecord(sessionId, m.step); } catch (e) {}
      rec = rec || m;
      let confidenceFull = null, confidenceNoProgress = null, confidenceNoLoop = null;
      if (typeof gv2ComputeConfidence === 'function' && (rec.grounded != null || rec.loop != null || rec.progress != null)) {
        const signals = { grounded: rec.grounded, loop: rec.loop, progress: rec.progress };
        confidenceFull = gv2ComputeConfidence(signals, 'full').confidence;
        confidenceNoProgress = gv2ComputeConfidence(signals, 'reduced').confidence;
        confidenceNoLoop = gv2ComputeConfidence(signals, 'noloop').confidence;
      }
      rows.push({
        step: rec.step, planStep: rec.planStep ?? null, title: rec.title || '',
        instruction: rec.instruction || '', link: rec.url || '', action: rec.action || null,
        target: rec.target || null,
        confidence: rec.confidence ?? null, grounded: rec.grounded ?? null, loop: rec.loop ?? null, progress: rec.progress ?? null,
        confidenceFormula: rec.confidenceFormula || null, confidenceFull, confidenceNoProgress, confidenceNoLoop,
        agentResponse: rec.rawLlmJson || '', systemPrompt: rec.systemPrompt || '', userPrompt: rec.userPrompt || '',
        durationMs: rec.durationMs ?? null, timestamp: rec.timestamp ?? null
      });
    }
    const chartRows = rows.filter(r => r.confidenceFull != null)
      .map(r => ({ step: r.step, full: r.confidenceFull, reduced: r.confidenceNoProgress, noloop: r.confidenceNoLoop }));
    const payload = {
      sessionId: sessionId || null,
      generatedAt: new Date().toISOString(),
      confidenceWeights: {
        lambdaL: (typeof GV2_LAMBDA_L === 'number') ? GV2_LAMBDA_L : 0.8,
        lambdaP: (typeof GV2_LAMBDA_P === 'number') ? GV2_LAMBDA_P : 0.3
      },
      steps: rows,
      chartSvg: chartRows.length ? buildConfChartSvg(chartRows) : ''
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pageguide-steps-${sessionId || 'session'}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (e) {} }, 1000);
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
    try {
      const s = await chrome.storage.sync.get('debugEnabled');
      debugEnabled = s.debugEnabled === true;
    } catch (e) {}
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
