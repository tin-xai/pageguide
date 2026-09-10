// PageGuide annotator site — the wiring.
// ======================================
// State, transport and rendering. The arithmetic lives in annotate_logic.js.
//
// TRANSPORT. Two routes, chosen once at load:
//   Supabase — when supabase_config.js is filled in. Trajectories are read straight off the table
//              (anon select), annotations go through save_pageguide_annotation.
//   Local    — otherwise. Trajectories come from a JSON file exported by the extension, and
//              annotations stay in localStorage until downloaded from the Agreement tab.
// Both routes keep a local copy of every annotation, so a network failure never loses a grade.

(function () {
  'use strict';

  const L = window.AnnotateLogic;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const LS_ANNOTATOR = 'pageguide_annot_annotator';
  const LS_RESULTS = 'pageguide_annot_results';      // { "<trajectory_id>|<annotator>": annotation }
  const LS_TRAJECTORIES = 'pageguide_annot_trajectories_cache';

  const cfg = {
    url: typeof SUPABASE_ANNOT_URL !== 'undefined' ? SUPABASE_ANNOT_URL : '',
    key: typeof SUPABASE_ANNOT_ANON_KEY !== 'undefined' ? SUPABASE_ANNOT_ANON_KEY : '',
  };
  const remote = !!(cfg.url && cfg.key && !cfg.url.includes('YOUR_') && !cfg.key.includes('YOUR_'));
  const headers = () => ({ apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' });

  const s = {
    trajectories: [],   // [{id, title, goal, url, step_count, trajectory, arms, agent_answer, ...}]
    results: [],        // every annotation row we know about
    current: null,      // the trajectory being graded
    draft: null,        // the annotation being built
    startedAt: 0,
  };

  // ── storage ────────────────────────────────────────────────────────────────
  const lsGet = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch (e) { return fallback; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
  const annotator = () => ($('an-annotator').value || '').trim();

  function localResults() { return Object.values(lsGet(LS_RESULTS, {})); }
  function rememberLocal(ann) {
    const all = lsGet(LS_RESULTS, {});
    all[`${ann.trajectory_id}|${ann.annotator_id}`] = ann;
    lsSet(LS_RESULTS, all);
  }

  // ── transport ──────────────────────────────────────────────────────────────
  async function loadTrajectories() {
    if (remote) {
      const select = 'id,source_task_id,title,url,task_style,goal,step_count,agent_answer,claims_completion,task_index,updated_at';
      const res = await fetch(`${cfg.url}/rest/v1/pageguide_annotation_trajectories?select=${select}&in_annotation=eq.true&order=task_index.asc`, { headers: headers() });
      if (!res.ok) throw new Error(`Could not read trajectories (${res.status})`);
      s.trajectories = await res.json();
    } else {
      s.trajectories = lsGet(LS_TRAJECTORIES, []);
      // Local mode: a bundle dropped beside the site is picked up without the file dialog.
      if (!s.trajectories.length) {
        try {
          const res = await fetch('annotation_trajectories.json', { cache: 'no-store' });
          if (res.ok) importBundle(await res.json(), { cache: false });
        } catch (e) { /* none there; the Load button still works */ }
      }
    }
  }

  /** The steps/screenshots are large, so they are fetched only when a trajectory opens. */
  async function loadTrajectoryBody(t) {
    if (t.trajectory) return t;
    if (!remote) return t;
    const res = await fetch(`${cfg.url}/rest/v1/pageguide_annotation_trajectories?select=trajectory,arms&id=eq.${encodeURIComponent(t.id)}`, { headers: headers() });
    if (!res.ok) throw new Error(`Could not read trajectory ${t.id} (${res.status})`);
    const [row] = await res.json();
    Object.assign(t, row || {});
    return t;
  }

  async function loadResults() {
    let rows = localResults();
    if (remote) {
      const res = await fetch(`${cfg.url}/rest/v1/pageguide_annotation_results?select=trajectory_id,annotator_id,step_labels,answer_correct,answer_problems,answer_note,duration_ms,updated_at`, { headers: headers() });
      if (res.ok) {
        const server = await res.json();
        // Server wins for the same (trajectory, annotator); local fills in anything unsent.
        const seen = new Set(server.map(r => `${r.trajectory_id}|${r.annotator_id}`));
        rows = server.concat(rows.filter(r => !seen.has(`${r.trajectory_id}|${r.annotator_id}`)));
      }
    }
    s.results = rows;
  }

  async function saveAnnotation(ann) {
    rememberLocal(ann);
    if (!remote) return { ok: true, where: 'this browser' };
    const res = await fetch(`${cfg.url}/rest/v1/rpc/save_pageguide_annotation`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ p_annotation: ann }),
    });
    if (!res.ok) {
      let msg = await res.text();
      try { msg = JSON.parse(msg).message || msg; } catch (e) { /* raw */ }
      return { ok: false, error: msg };
    }
    return { ok: true, where: 'Supabase' };
  }

  function importBundle(json, { cache = true } = {}) {
    const list = Array.isArray(json?.trajectories) ? json.trajectories : (Array.isArray(json) ? json : []);
    const byId = new Map(s.trajectories.map(t => [t.id, t]));
    list.forEach(t => {
      if (!t?.id) return;
      byId.set(t.id, Object.assign({}, t, { step_count: (t.trajectory || []).length }));
    });
    s.trajectories = [...byId.values()].sort((a, b) => (a.task_index || 0) - (b.task_index || 0));
    // Screenshots make the cache large; keep it anyway so a reload does not lose the file, and
    // fall back silently when the quota says no.
    if (cache) lsSet(LS_TRAJECTORIES, s.trajectories);
  }

  /**
   * A usable <img> src. The extension banks screenshots as data URLs, but the V2 study rows store
   * bare base64 (JPEG mostly, PNG sometimes), so the prefix is put back from the first bytes.
   */
  function imageSrc(raw) {
    const v = String(raw || '');
    if (!v || /^(data:|https?:|blob:)/i.test(v)) return v;
    const mime = v.startsWith('iVBOR') ? 'image/png' : (v.startsWith('R0lGOD') ? 'image/gif' : (v.startsWith('UklGR') ? 'image/webp' : 'image/jpeg'));
    return `data:${mime};base64,${v}`;
  }

  // ── views ──────────────────────────────────────────────────────────────────
  function showTab(name) {
    ['queue', 'task', 'agreement'].forEach(v => { $(`an-${v}`).hidden = v !== name; });
    document.querySelectorAll('.an-tab').forEach(b => b.classList.toggle('an-tab-on', b.dataset.tab === name));
    if (name === 'queue') renderQueue();
    if (name === 'agreement') renderAgreement();
  }

  function myResult(tid) {
    const who = annotator();
    return s.results.find(r => r.trajectory_id === tid && r.annotator_id === who) || null;
  }

  function renderQueue() {
    const list = $('an-queue-list');
    if (!s.trajectories.length) {
      list.innerHTML = `<div class="an-empty">${remote
        ? 'No trajectories published yet. In the extension: run a guide task, press 📝 on its journey card, then ⋯ → Record Annotation Trajectories → Publish.'
        : 'No trajectories loaded. Export them from the extension (⋯ → Record Annotation Trajectories → Export JSON) and load the file above.'}</div>`;
      return;
    }
    const done = s.trajectories.filter(t => myResult(t.id)).length;
    list.innerHTML = `<div class="an-count">${done} / ${s.trajectories.length} done${annotator() ? ` as <strong>${esc(annotator())}</strong>` : ''}</div>`
      + s.trajectories.map((t, i) => {
        const r = myResult(t.id);
        const raters = L.listAnnotators(s.results.filter(x => x.trajectory_id === t.id));
        return `
        <button class="an-row${r ? ' an-row-done' : ''}" data-open="${esc(t.id)}">
          <span class="an-row-n">${i + 1}</span>
          <span class="an-row-main">
            <span class="an-row-title">${esc(t.title || t.goal || t.id)}</span>
            <span class="an-row-meta">${t.step_count || 0} steps · ${esc(t.url || '')}${raters.length ? ` · graded by ${esc(raters.join(', '))}` : ''}</span>
          </span>
          <span class="an-row-state">${r ? '✓ done' : 'open'}</span>
        </button>`;
      }).join('');
    list.querySelectorAll('[data-open]').forEach(b => { b.onclick = () => openTask(b.dataset.open); });
  }

  async function openTask(id) {
    if (!annotator()) { $('an-annotator').focus(); alertNote('Enter your annotator ID first.'); return; }
    const t = s.trajectories.find(x => x.id === id);
    if (!t) return;
    $('an-stage').innerHTML = '<div class="an-empty">Loading the steps…</div>';
    showTab('task');
    try { await loadTrajectoryBody(t); } catch (e) { $('an-stage').innerHTML = `<div class="an-empty">${esc(e.message)}</div>`; return; }
    s.current = t;
    const existing = myResult(id);
    s.draft = existing ? L.normalizeAnnotation(existing) : L.normalizeAnnotation({
      trajectory_id: id, annotator_id: annotator(),
      step_labels: (t.trajectory || []).map(st => ({ step: st.n, correct: null })),
    });
    s.draft.annotator_id = annotator();
    s.startedAt = Date.now();
    renderTask();
  }

  function alertNote(msg) { const n = $('an-note'); if (n) n.textContent = msg; }

  function renderTask() {
    const t = s.current;
    const steps = t.trajectory || [];
    const grounded = t.arms?.grounding || {};
    $('an-goal').textContent = t.goal || t.title || t.id;
    $('an-task-meta').textContent = `${steps.length} steps · ${t.url || ''}`;

    const shot = (src, alt) => src ? `<img class="an-shot" src="${esc(imageSrc(src))}" alt="${esc(alt)}" data-zoom>` : '<div class="an-noshot">no screenshot</div>';
    const labelFor = (n) => s.draft.step_labels.find(l => l.step === n) || (s.draft.step_labels.push({ step: n, correct: null, error_type: '', note: '' }), s.draft.step_labels[s.draft.step_labels.length - 1]);

    $('an-stage').innerHTML = `
      ${grounded.initial_state?.screenshot ? `<div class="an-bookend"><div class="an-kicker">Before the agent started</div>${shot(grounded.initial_state.screenshot, 'initial state')}</div>` : ''}
      ${steps.map(st => {
        const l = labelFor(st.n);
        return `
        <div class="an-step" data-step="${st.n}">
          <div class="an-step-head">
            <span class="an-step-n">Step ${st.n}</span>
            <span class="an-step-action">${esc(st.action || '')}</span>
            ${st.url ? `<a class="an-step-url" href="${esc(st.url)}" target="_blank" rel="noopener">${esc(st.url.replace(/^https?:\/\//, '').slice(0, 60))}</a>` : ''}
          </div>
          <div class="an-step-instruction">${esc(st.instruction || '')}${st.target_text ? ` <span class="an-target">→ “${esc(st.target_text)}”</span>` : ''}</div>
          ${shot(st.screenshot, `step ${st.n}`)}
          <div class="an-grade">
            <span class="an-grade-q">Did this step serve the goal?</span>
            <label class="an-pill${l.correct === true ? ' an-pill-on-good' : ''}"><input type="radio" name="step-${st.n}" value="1" ${l.correct === true ? 'checked' : ''}>✓ Correct</label>
            <label class="an-pill${l.correct === false ? ' an-pill-on-bad' : ''}"><input type="radio" name="step-${st.n}" value="0" ${l.correct === false ? 'checked' : ''}>✗ Incorrect</label>
            <select class="an-err" data-err="${st.n}" ${l.correct === false ? '' : 'hidden'}>
              <option value="">— error type —</option>
              ${L.ANNOT_ERROR_TYPES.map(e => `<option value="${e.id}" ${l.error_type === e.id ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}
            </select>
            <input class="an-step-note" data-note="${st.n}" placeholder="note (optional)" value="${esc(l.note || '')}">
          </div>
        </div>`;
      }).join('')}
      <div class="an-answer">
        <div class="an-kicker">Final state</div>
        ${grounded.final_state?.screenshot ? shot(grounded.final_state.screenshot, 'final state') : ''}
        <div class="an-kicker">Agent's answer</div>
        <div class="an-answer-text">${esc(t.agent_answer || grounded.answer || '(no answer recorded)')}</div>
        <div class="an-grade">
          <span class="an-grade-q">Is the final answer correct — did the agent complete the task?</span>
          <label class="an-pill${s.draft.answer_correct === true ? ' an-pill-on-good' : ''}"><input type="radio" name="answer" value="1" ${s.draft.answer_correct === true ? 'checked' : ''}>✓ Correct</label>
          <label class="an-pill${s.draft.answer_correct === false ? ' an-pill-on-bad' : ''}"><input type="radio" name="answer" value="0" ${s.draft.answer_correct === false ? 'checked' : ''}>✗ Incorrect</label>
        </div>
        <div class="an-problems" id="an-problems" ${s.draft.answer_correct === false ? '' : 'hidden'}>
          <div class="an-grade-q">What is the problem with it?</div>
          ${L.ANNOT_PROBLEM_TYPES.map(p => `<label class="an-check"><input type="checkbox" data-problem="${p.id}" ${s.draft.answer_problems.includes(p.id) ? 'checked' : ''}> ${esc(p.label)}</label>`).join('')}
        </div>
        <textarea class="an-answer-note" id="an-answer-note" placeholder="note on the answer (optional)">${esc(s.draft.answer_note || '')}</textarea>
      </div>`;

    // wiring
    $('an-stage').querySelectorAll('input[type=radio][name^=step-]').forEach(r => {
      r.onchange = () => {
        const n = Number(r.name.slice(5));
        const l = labelFor(n);
        l.correct = r.value === '1';
        if (l.correct) l.error_type = '';
        const sel = $('an-stage').querySelector(`[data-err="${n}"]`);
        if (sel) sel.hidden = l.correct;
        r.closest('.an-grade').querySelectorAll('.an-pill').forEach(p => p.classList.remove('an-pill-on-good', 'an-pill-on-bad'));
        r.parentElement.classList.add(l.correct ? 'an-pill-on-good' : 'an-pill-on-bad');
        renderProgress();
      };
    });
    $('an-stage').querySelectorAll('[data-err]').forEach(sel => { sel.onchange = () => { labelFor(Number(sel.dataset.err)).error_type = sel.value; }; });
    $('an-stage').querySelectorAll('[data-note]').forEach(inp => { inp.oninput = () => { labelFor(Number(inp.dataset.note)).note = inp.value; }; });
    $('an-stage').querySelectorAll('input[name=answer]').forEach(r => {
      r.onchange = () => {
        s.draft.answer_correct = r.value === '1';
        $('an-problems').hidden = s.draft.answer_correct;
        r.closest('.an-grade').querySelectorAll('.an-pill').forEach(p => p.classList.remove('an-pill-on-good', 'an-pill-on-bad'));
        r.parentElement.classList.add(s.draft.answer_correct ? 'an-pill-on-good' : 'an-pill-on-bad');
        renderProgress();
      };
    });
    $('an-stage').querySelectorAll('[data-problem]').forEach(cb => {
      cb.onchange = () => {
        const set = new Set(s.draft.answer_problems);
        cb.checked ? set.add(cb.dataset.problem) : set.delete(cb.dataset.problem);
        s.draft.answer_problems = [...set];
        renderProgress();
      };
    });
    $('an-answer-note').oninput = (e) => { s.draft.answer_note = e.target.value; };
    $('an-stage').querySelectorAll('[data-zoom]').forEach(img => { img.onclick = () => { $('an-lightbox-img').src = img.src; $('an-lightbox').hidden = false; }; });
    renderProgress();
  }

  function renderProgress() {
    const n = (s.current?.trajectory || []).length;
    const graded = s.draft.step_labels.filter(l => l.correct !== null && l.step <= n).length;
    const bad = s.draft.step_labels.filter(l => l.correct === false).length;
    $('an-progress').innerHTML = `<div class="an-progress-bar"><span style="width:${n ? Math.round(100 * graded / n) : 0}%"></span></div>
      <div class="an-progress-text">${graded} / ${n} steps graded · ${bad} marked incorrect · answer: ${s.draft.answer_correct === null ? '—' : (s.draft.answer_correct ? 'correct' : 'incorrect')}</div>`;
    const problem = L.annotationProblem(s.draft, n);
    alertNote(problem || 'Ready to submit.');
    $('an-submit').disabled = !!problem;
  }

  async function submit() {
    const n = (s.current?.trajectory || []).length;
    s.draft.annotator_id = annotator();
    s.draft.duration_ms = (s.draft.duration_ms || 0) + (Date.now() - s.startedAt);
    const ann = L.normalizeAnnotation(s.draft);
    if (L.annotationProblem(ann, n)) { renderProgress(); return; }
    $('an-submit').disabled = true;
    alertNote('Saving…');
    const res = await saveAnnotation(ann);
    if (!res.ok) { alertNote(`Saved in this browser, but Supabase refused: ${res.error}`); $('an-submit').disabled = false; return; }
    await loadResults();
    showTab('queue');
  }

  function renderAgreement() {
    const raters = L.listAnnotators(s.results);
    const fill = (sel, keep) => {
      sel.innerHTML = raters.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
      if (raters.includes(keep)) sel.value = keep;
    };
    const a = $('an-rater-a'), b = $('an-rater-b');
    fill(a, a.value || raters[0]); fill(b, b.value || raters[1] || raters[0]);
    if (raters.length < 2) {
      $('an-overall').innerHTML = `<div class="an-empty">Agreement needs two annotators; ${raters.length} so far${raters.length ? ` (${esc(raters.join(', '))})` : ''}.</div>`;
      $('an-agree-table').innerHTML = '';
      return;
    }
    const rep = L.agreementReport(s.trajectories, s.results, a.value, b.value);
    const pct = (v) => v == null ? '—' : `${Math.round(v * 100)}%`;
    const k = (v) => v == null ? '—' : v.toFixed(2);
    const o = rep.overall;
    $('an-overall').innerHTML = `
      <div class="an-stat"><div class="an-stat-n">${o.trajectories_both}</div><div class="an-stat-l">trajectories graded by both</div></div>
      <div class="an-stat"><div class="an-stat-n">${pct(o.step_agreement)}</div><div class="an-stat-l">step-level agreement (${o.steps_compared} steps)</div></div>
      <div class="an-stat"><div class="an-stat-n">${k(o.step_kappa)}</div><div class="an-stat-l">step-level Cohen's κ</div></div>
      <div class="an-stat"><div class="an-stat-n">${pct(o.error_type_agreement)}</div><div class="an-stat-l">error-type agreement (both said incorrect)</div></div>
      <div class="an-stat"><div class="an-stat-n">${pct(o.answer_agreement)}</div><div class="an-stat-l">answer-level agreement (${o.answers_compared})</div></div>
      <div class="an-stat"><div class="an-stat-n">${k(o.answer_kappa)}</div><div class="an-stat-l">answer-level Cohen's κ</div></div>`;
    const yn = (v) => v == null ? '—' : (v ? '✓' : '✗');
    $('an-agree-table').innerHTML = `
      <thead><tr><th>#</th><th>Trajectory</th><th>Steps compared</th><th>Step agreement</th><th>κ</th><th>Disagree at</th><th>Error-type agr.</th><th>Answer A</th><th>Answer B</th><th>Agree</th></tr></thead>
      <tbody>${rep.perTrajectory.map((r, i) => `
        <tr class="${!r.has_a || !r.has_b ? 'an-tr-missing' : (r.answer_agree === false || r.disagreeing_steps.length ? 'an-tr-diff' : '')}">
          <td>${i + 1}</td><td>${esc(r.title)}<div class="an-row-meta">${r.has_a ? '' : 'A missing '}${r.has_b ? '' : 'B missing'}</div></td>
          <td>${r.steps_compared} / ${r.step_count}</td><td>${pct(r.step_agreement)}</td><td>${k(r.step_kappa)}</td>
          <td>${r.disagreeing_steps.join(', ') || '—'}</td><td>${pct(r.error_type_agreement)}</td>
          <td>${yn(r.answer_a)}</td><td>${yn(r.answer_b)}</td><td>${yn(r.answer_agree)}</td>
        </tr>`).join('')}</tbody>`;
    $('an-csv').onclick = () => download('annotation_agreement.csv', L.agreementCsv(rep), 'text/csv');
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── boot ───────────────────────────────────────────────────────────────────
  async function boot() {
    $('an-source').textContent = remote ? '● Supabase' : '○ local only';
    $('an-annotator').value = lsGet(LS_ANNOTATOR, '') || '';
    $('an-annotator').oninput = () => { lsSet(LS_ANNOTATOR, annotator()); renderQueue(); };
    document.querySelectorAll('.an-tab').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
    $('an-back').onclick = () => showTab('queue');
    $('an-submit').onclick = submit;
    $('an-refresh').onclick = async () => { await loadTrajectories(); await loadResults(); renderAgreement(); };
    $('an-download-local').onclick = () => download('annotations_local.json', JSON.stringify(localResults(), null, 2), 'application/json');
    $('an-rater-a').onchange = renderAgreement;
    $('an-rater-b').onchange = renderAgreement;
    $('an-lightbox').onclick = () => { $('an-lightbox').hidden = true; };
    $('an-file').onchange = async (e) => {
      for (const f of e.target.files) {
        try { importBundle(JSON.parse(await f.text())); } catch (err) { alert(`Could not read ${f.name}: ${err.message}`); }
      }
      renderQueue();
    };
    try { await loadTrajectories(); await loadResults(); } catch (e) { $('an-queue-list').innerHTML = `<div class="an-empty">${esc(e.message)}</div>`; return; }
    renderQueue();
  }
  boot();
})();
