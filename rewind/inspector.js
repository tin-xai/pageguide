// PageGuide - Full-page Step Inspector (Slice 1)
// Reads ?session=<id>&step=<n>, loads the record from the rewind store, and renders
// the static DOM snapshot (read-only, sandboxed), screenshot, reasoning, and raw JSON.

(function () {
  const params = new URLSearchParams(location.search);
  let sessionId = params.get('session');
  let step = parseInt(params.get('step'), 10);

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

  async function populateStepSelect() {
    let index = null;
    // Prefer the session from the URL (?session=); fall back to the current session.
    try { index = await rewindGetIndex(sessionId || undefined); } catch (e) {}
    const sel = $('step-select');
    sel.innerHTML = '';
    const steps = (index && index.steps) ? index.steps : [];
    if (index && !sessionId) sessionId = index.sessionId;
    steps.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.step;
      opt.textContent = 'Step ' + s.step;
      if (s.step === step) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = () => { step = parseInt(sel.value, 10); render(); };
  }

  async function render() {
    let rec = null;
    try { rec = await rewindGetRecord(sessionId, step); } catch (e) {}

    if (!rec) {
      $('empty').style.display = '';
      $('content').style.display = 'none';
      return;
    }
    $('empty').style.display = 'none';
    $('content').style.display = '';
    $('title').textContent = 'Step ' + rec.step + ' — Inspector';

    const metaBits = [];
    if (rec.confidence != null) metaBits.push('Confidence: ' + Math.round(rec.confidence * 100) + '%');
    if (rec.durationMs != null) metaBits.push('Duration: ' + fmtDuration(rec.durationMs));
    const cost = fmtCost(rec.cost); if (cost) metaBits.push('Cost: ' + cost);
    if (rec.verification && rec.verification.status) metaBits.push('Verify: ' + rec.verification.status);
    if (rec.url) metaBits.push(rec.url);

    $('why').innerHTML = `
      <div><strong>What:</strong> ${esc(rec.instruction)}</div>
      ${rec.target && rec.target.text ? `<div><strong>Element:</strong> ${esc(rec.target.text)}</div>` : ''}
      ${rec.nextStepHint ? `<div><strong>Next:</strong> ${esc(rec.nextStepHint)}</div>` : ''}
      ${metaBits.length ? `<div class="meta">${esc(metaBits.join('   ·   '))}</div>` : ''}`;

    const hasShot = !!rec.screenshot;
    const hasSnap = !!rec.domSnapshot;
    const tabShot = $('tab-shot'), tabSnap = $('tab-snap'), view = $('view');
    tabShot.disabled = !hasShot;
    tabSnap.disabled = !hasSnap;

    function show(which) {
      tabShot.classList.toggle('active', which === 'shot');
      tabSnap.classList.toggle('active', which === 'snap');
      if (which === 'snap' && hasSnap) {
        view.innerHTML = `<div class="snap-wrap"><div class="snap-banner">🔒 Read-only snapshot — not a live page</div><iframe sandbox></iframe></div>`;
        view.querySelector('iframe').srcdoc = rec.domSnapshot;
      } else if (hasShot) {
        view.innerHTML = `<img src="data:image/jpeg;base64,${rec.screenshot}" alt="Step ${esc(rec.step)} screenshot">`;
      } else if (hasSnap) {
        show('snap'); return;
      } else {
        view.innerHTML = `<div class="empty">No capture available.</div>`;
      }
    }
    tabShot.onclick = () => !tabShot.disabled && show('shot');
    tabSnap.onclick = () => !tabSnap.disabled && show('snap');
    show(hasShot ? 'shot' : 'snap');

    if (rec.rawLlmJson) {
      $('raw-wrap').style.display = '';
      $('raw').textContent = rec.rawLlmJson;
    } else {
      $('raw-wrap').style.display = 'none';
    }
  }

  (async function init() {
    await populateStepSelect();
    if (!Number.isFinite(step)) {
      const sel = $('step-select');
      if (sel.options.length) step = parseInt(sel.options[0].value, 10);
    }
    await render();
  })();
})();
