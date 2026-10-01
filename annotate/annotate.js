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
  const SS_ADMIN = 'pageguide_annot_admin_password';   // sessionStorage: gone when the tab closes

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
    editing: null,      // id of the trajectory whose edit form is open in the queue
    tasks: [],          // annotate/tasks.json — the named tasks a run can belong to
  };
  const taskName = (id) => (s.tasks.find(t => t.id === id) || {}).name || '';
  const taskStatus = (id) => (s.tasks.find(t => t.id === id) || {}).status || '';
  /** tasks.json verdict for the run's task: kept from the study (answer was correct) or a fresh re-run. */
  const statusBadge = (t) => {
    const st = taskStatus(t.source_task_id);
    if (st === 'correct') return '<span class="an-status an-status-kept" title="The study answer was correct; this run was seeded from the study">✓ kept from study</span>';
    if (st === 'rerun') return '<span class="an-status an-status-rerun" title="The study answer was wrong; this is a fresh re-run">↻ re-run</span>';
    return '';
  };
  /** The one-click Shown/Hidden toggle (researcher only); wireVisButtons saves it straight away. */
  const visButton = (t) => `<button class="an-btn an-btn-vis${t.in_annotation === false ? '' : ' an-btn-vis-on'}" data-vis="${esc(t.id)}"
      title="${t.in_annotation === false ? 'Hidden from annotators — click to show it in their queue' : 'In the annotators\' queue — click to hide it'}">${t.in_annotation === false ? '○ Hidden · Show' : '● Shown · Hide'}</button>`;
  function wireVisButtons(root, rerender) {
    root.querySelectorAll('[data-vis]').forEach(b => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const t = s.trajectories.find(x => x.id === b.dataset.vis);
        if (!t) return;
        b.disabled = true; b.textContent = 'Saving…';
        try { await saveTrajectoryPatch(t, { in_annotation: t.in_annotation === false }); }
        catch (err) { alert(`Not saved: ${err.message}`); }
        rerender();
      };
    });
  }
  const when = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };

  // ── storage ────────────────────────────────────────────────────────────────
  const lsGet = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch (e) { return fallback; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
  // Two annotators, A and B, picked with the segmented control in the header. The choice is
  // remembered per browser; the queue's progress and the ✓ done marks are for whoever is selected.
  const ANNOTATORS = ['A', 'B'];
  let _annotator = '';
  const annotator = () => _annotator;
  function setAnnotator(who, { save = true } = {}) {
    _annotator = ANNOTATORS.includes(who) ? who : '';
    if (save) lsSet(LS_ANNOTATOR, _annotator);
    document.querySelectorAll('[data-annotator]').forEach(b => {
      const on = b.dataset.annotator === _annotator;
      b.classList.toggle('an-seg-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  // ── researcher mode ────────────────────────────────────────────────────────
  // The V2 admin password unlocks the researcher's view of the same page: every published run
  // (hidden ones included) and an ✎ Edit on each. Kept in sessionStorage only. In local mode there
  // is nothing to authenticate against, so researcher mode is simply on.
  const adminPassword = () => { try { return sessionStorage.getItem(SS_ADMIN) || ''; } catch (e) { return ''; } };
  const researcher = () => !remote || !!adminPassword();
  async function rpc(name, body) {
    const res = await fetch(`${cfg.url}/rest/v1/rpc/${name}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    if (!res.ok) {
      let msg = await res.text();
      try { msg = JSON.parse(msg).message || msg; } catch (e) { /* raw */ }
      throw new Error(msg);
    }
    return res.json();
  }
  async function unlockResearcher() {
    if (!remote) return true;
    const pw = window.prompt('V2 admin password (the one Publish → Supabase asks for):', '');
    if (!pw) return false;
    try { await rpc('list_pageguide_annotation_trajectories_admin', { p_password: pw }); }
    catch (e) { window.alert(`Not unlocked: ${e.message}`); return false; }
    try { sessionStorage.setItem(SS_ADMIN, pw); } catch (e) { /* fine, this tab only */ }
    return true;
  }
  function lockResearcher() { try { sessionStorage.removeItem(SS_ADMIN); } catch (e) { /* */ } }
  /** Header: 🔑 Researcher unlocks; once unlocked the ✎ Edit tab appears and the button locks. */
  function renderResearcherButton() {
    const b = $('an-researcher');
    if (b) {
      b.hidden = !remote;
      b.textContent = adminPassword() ? '🔓 Researcher · lock' : '🔑 Researcher';
      b.title = adminPassword() ? 'Forget the admin password and hide the Edit tab' : 'Enter the admin password to unlock the Edit tab';
    }
    const tab = $('an-tab-edit');
    if (tab) tab.hidden = !researcher();
  }

  function localResults() { return Object.values(lsGet(LS_RESULTS, {})); }
  function rememberLocal(ann) {
    const all = lsGet(LS_RESULTS, {});
    all[`${ann.trajectory_id}|${ann.annotator_id}`] = ann;
    lsSet(LS_RESULTS, all);
  }

  // ── transport ──────────────────────────────────────────────────────────────
  async function loadTrajectories() {
    if (remote) {
      if (adminPassword()) {
        // Researcher: every row, hidden ones included (see supabase_migration_annotation_edit.sql).
        try { s.trajectories = await rpc('list_pageguide_annotation_trajectories_admin', { p_password: adminPassword() }); return; }
        catch (e) { console.warn('[annotate] admin list failed, falling back to the live queue:', e.message); lockResearcher(); renderResearcherButton(); }
      }
      const select = 'id,source_task_id,title,url,task_style,goal,step_count,agent_answer,claims_completion,in_annotation,task_index,created_at,updated_at';
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
    let row = null;
    if (t.in_annotation === false && adminPassword()) {
      // Hidden from anon by RLS; the researcher reads it through the password-gated RPC.
      [row] = await rpc('get_pageguide_annotation_trajectory_admin', { p_password: adminPassword(), p_id: t.id });
    } else {
      const res = await fetch(`${cfg.url}/rest/v1/pageguide_annotation_trajectories?select=trajectory,arms&id=eq.${encodeURIComponent(t.id)}`, { headers: headers() });
      if (!res.ok) throw new Error(`Could not read trajectory ${t.id} (${res.status})`);
      [row] = await res.json();
    }
    if (!row) throw new Error(`Trajectory ${t.id} is not readable${t.in_annotation === false ? ' (hidden — unlock Researcher to open it)' : ''}`);
    Object.assign(t, row);
    return t;
  }

  async function loadResults() {
    let rows = localResults();
    if (remote) {
      const res = await fetch(`${cfg.url}/rest/v1/pageguide_annotation_results?select=trajectory_id,annotator_id,step_labels,evidence_labels,evidence_count,answer_correct,answer_problems,answer_note,duration_ms,updated_at`, { headers: headers() });
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

  /**
   * Persist a researcher's edit. Supabase: the update RPC (then the local copy is patched the same
   * way so the list is right without a refetch). Local: the cached bundle is patched, and the
   * cache rewritten so a reload keeps it.
   */
  async function saveTrajectoryPatch(t, patch) {
    if (!Object.keys(patch).length) return { ok: true, where: 'nothing changed' };
    if (remote) {
      await rpc('update_pageguide_annotation_trajectory', { p_password: adminPassword(), p_id: t.id, p_patch: patch });
    }
    const next = L.applyTrajectoryPatch(t, patch);
    s.trajectories = s.trajectories.map(x => x.id === t.id ? next : x);
    if (s.current?.id === t.id) s.current = next;
    if (!remote) lsSet(LS_TRAJECTORIES, s.trajectories);
    return { ok: true, where: remote ? 'Supabase' : 'this browser' };
  }

  /**
   * Publish an exported bundle from the Edit tab — the same RPC the extension's Publish uses
   * (save_pageguide_annotation_trajectory), so a run captured on one machine, or one whose task
   * tag had to be fixed in the file, can go up without going back through the extension.
   * Upsert by id: re-publishing a run updates its row in place.
   */
  async function publishBundle(json) {
    const list = Array.isArray(json?.trajectories) ? json.trajectories : (Array.isArray(json) ? json : []);
    const rows = [];
    for (const t of list) {
      if (!t?.id) continue;
      if (!remote) { importBundle({ trajectories: [t] }); rows.push({ id: t.id, ok: true, where: 'this browser' }); continue; }
      try {
        await rpc('save_pageguide_annotation_trajectory', { p_password: adminPassword(), p_task: t });
        rows.push({ id: t.id, ok: true, where: 'Supabase' });
      } catch (e) { rows.push({ id: t.id, ok: false, error: e.message }); }
    }
    return rows;
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
    ['queue', 'task', 'agreement', 'rerun', 'edit'].forEach(v => { $(`an-${v}`).hidden = v !== name; });
    document.querySelectorAll('.an-tab').forEach(b => b.classList.toggle('an-tab-on', b.dataset.tab === name));
    if (name === 'queue') renderQueue();
    if (name === 'agreement') renderAgreement();
    if (name === 'rerun') renderRerun();
    if (name === 'edit') renderEdit();
  }

  /** The Edit tab: unlock once (Supabase), then every run with its edit form. */
  async function renderEdit() {
    const list = $('an-edit-list');
    if (!researcher()) { showTab('queue'); return; }
    if (!s.trajectories.length) { list.innerHTML = '<div class="an-empty">No trajectories published yet.</div>'; return; }
    const hidden = s.trajectories.filter(t => t.in_annotation === false).length;
    list.innerHTML = `<div class="an-count">${s.trajectories.length} runs${hidden ? ` · ${hidden} hidden from annotators` : ''}</div>`
      + s.trajectories.map((t, i) => `
        <div class="an-row-wrap an-edit-wrap">
          <div class="an-row an-row-static${t.in_annotation === false ? ' an-row-hidden' : ''}">
            <span class="an-row-n">${i + 1}</span>
            <span class="an-row-main">
              <span class="an-row-title">${taskName(t.source_task_id) ? `<span class="an-task-name">${esc(taskName(t.source_task_id))}</span> ` : '<span class="an-task-name an-task-none">no task name</span> '}${esc(t.title || t.goal || t.id)}${t.in_annotation === false ? ' <span class="an-tag">hidden</span>' : ''}</span>
              <span class="an-row-meta">${statusBadge(t)}${t.step_count || 0} steps · published ${esc(when(t.created_at) || '—')}${t.updated_at && t.updated_at !== t.created_at ? ` · edited ${esc(when(t.updated_at))}` : ''} · id ${esc(t.id)}</span>
            </span>
            ${visButton(t)}
            <button class="an-btn an-btn-quiet" data-open="${esc(t.id)}" title="Open in the grading view">view →</button>
          </div>
          ${editForm(t)}
        </div>`).join('');
    list.querySelectorAll('[data-open]').forEach(b => { b.onclick = () => openTask(b.dataset.open); });
    wireVisButtons(list, renderEdit);
    wireEditForm(list, renderEdit);
  }

  async function loadTasks() {
    try { s.tasks = (await fetch('tasks.json', { cache: 'no-store' }).then(r => r.json())).guide || []; }
    catch (e) { s.tasks = []; }
    return s.tasks;
  }

  /** The 12 tasks with their verdict (annotate/tasks.json), split into rerun vs. kept. */
  async function renderRerun() {
    const list = $('an-rerun-list');
    const tasks = await loadTasks();
    if (!tasks.length) { list.innerHTML = '<div class="an-empty">Could not load tasks.json</div>'; return; }
    const rerun = tasks.filter(t => t.status === 'rerun');
    const kept = tasks.filter(t => t.status !== 'rerun');
    const row = (t, i, cls, state) => `
      <div class="an-row ${cls}">
        <span class="an-row-n">${tasks.indexOf(t) + 1}</span>
        <span class="an-row-main">
          <span class="an-row-title">${esc(t.name)}</span>
          <span class="an-row-meta" style="white-space:normal">${esc(t.task)}</span>
          <span class="an-row-meta">Start at <a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.url)}</a>${t.rerun_reason ? ` · was: ${esc(t.rerun_reason)}` : ''}</span>
        </span>
        <span class="an-row-state">${state}</span>
      </div>`;
    list.innerHTML = `<div class="an-count"><strong>${rerun.length}</strong> to re-run · ${kept.length} kept</div>`
      + rerun.map((t, i) => row(t, i, 'an-row-rerun', '↻ rerun')).join('')
      + (kept.length ? `<div class="an-count" style="margin-top:14px">Kept (answer correct)</div>` + kept.map((t, i) => row(t, i, 'an-row-done', '✓ correct')).join('') : '');
  }

  function myResult(tid) {
    const who = annotator();
    return s.results.find(r => r.trajectory_id === tid && r.annotator_id === who) || null;
  }
  /** Done = the evidence has been graded in full (steps and answer no longer count). */
  function myDone(tid) { const r = myResult(tid); return !!r && L.annotationComplete(r); }

  function renderQueue() {
    const list = $('an-queue-list');
    if (!s.trajectories.length) {
      list.innerHTML = `<div class="an-empty">${remote
        ? 'No trajectories published yet. In the extension: run a guide task, press 📝 on its journey card, then ⋯ → Record Annotation Trajectories → Publish.'
        : 'No trajectories loaded. Export them from the extension (⋯ → Record Annotation Trajectories → Export JSON) and load the file above.'}</div>`;
      return;
    }
    // Annotators see exactly what is "Shown" in the Edit tab; the researcher also sees hidden rows, dimmed.
    const canEdit = researcher();
    const rows = canEdit ? s.trajectories : s.trajectories.filter(t => t.in_annotation !== false);
    const done = rows.filter(t => myDone(t.id)).length;
    const hidden = s.trajectories.filter(t => t.in_annotation === false).length;
    if (!rows.length) { list.innerHTML = '<div class="an-empty">Nothing is shown to annotators yet — use the Edit tab to show a run.</div>'; return; }
    list.innerHTML = `<div class="an-count">${annotator()
        ? `<strong>Annotator ${esc(annotator())}</strong>: ${done} / ${rows.length} done`
        : `Choose Annotator A or B above to start grading · ${rows.length} trajectories`}${canEdit && hidden ? ` · ${hidden} hidden from annotators` : ''}</div>`
      + rows.map((t, i) => {
        const r = myResult(t.id);
        const done = myDone(t.id);
        const raters = L.listAnnotators(s.results.filter(x => x.trajectory_id === t.id).filter(L.annotationComplete));
        const off = t.in_annotation === false;
        return `
        <div class="an-row-wrap">
        <div class="an-row${done ? ' an-row-done' : ''}${off ? ' an-row-hidden' : ''}" data-open="${esc(t.id)}" role="button" tabindex="0">
          <span class="an-row-n">${i + 1}</span>
          <span class="an-row-main">
            <span class="an-row-title">${taskName(t.source_task_id) ? `<span class="an-task-name">${esc(taskName(t.source_task_id))}</span> ` : ''}${esc(t.title || t.goal || t.id)}${off ? ' <span class="an-tag">hidden</span>' : ''}</span>
            <span class="an-row-meta">${statusBadge(t)}${t.step_count || 0} steps · ${esc(t.url || '')} · published ${esc(when(t.created_at) || '—')}${raters.length ? ` · graded by ${esc(raters.join(', '))}` : ''}</span>
            <span class="an-row-meta an-row-answer" title="${esc(t.agent_answer || '')}">answer: ${esc(t.agent_answer || '(none recorded)')}</span>
          </span>
          <span class="an-row-state"><span>${done ? '✓ done' : (r ? 'in progress' : 'open')}</span><span class="an-row-time" title="published">${esc(when(t.created_at) || '')}</span></span>
          ${canEdit ? `${visButton(t)}<button class="an-btn an-btn-edit" data-edit="${esc(t.id)}" title="Edit title, task, agent answer, visibility">✎ Edit</button>` : ''}
        </div>
        ${canEdit && s.editing === t.id ? editForm(t) : ''}
        </div>`;
      }).join('');
    list.querySelectorAll('[data-open]').forEach(b => {
      b.onclick = () => openTask(b.dataset.open);
      b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTask(b.dataset.open); } };
    });
    list.querySelectorAll('[data-edit]').forEach(b => {
      b.onclick = (e) => { e.stopPropagation(); s.editing = s.editing === b.dataset.edit ? null : b.dataset.edit; renderQueue(); };
    });
    wireVisButtons(list, renderQueue);
    wireEditForm(list);
  }

  /** The researcher's inline edit form for one run: title, task, agent answer, visibility. */
  function editForm(t) {
    const answer = t.agent_answer || t.arms?.grounding?.answer || '';
    return `
      <form class="an-edit" data-edit-form="${esc(t.id)}">
        <label>Task name <select name="source_task_id">
          <option value="">— none —</option>
          ${s.tasks.map(k => `<option value="${esc(k.id)}" ${k.id === t.source_task_id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}
          ${t.source_task_id && !s.tasks.some(k => k.id === t.source_task_id) ? `<option value="${esc(t.source_task_id)}" selected>${esc(t.source_task_id)} (not in tasks.json)</option>` : ''}
        </select></label>
        <label>Title <input name="title" value="${esc(t.title || '')}" placeholder="shown in the queue"></label>
        <label>Task (goal) <textarea name="goal" rows="2">${esc(t.goal || '')}</textarea></label>
        <label>Agent's answer <textarea name="agent_answer" rows="5" placeholder="what the agent answered — this is what annotators grade">${esc(answer)}</textarea></label>
        <label class="an-edit-check"><input type="checkbox" name="in_annotation" ${t.in_annotation !== false ? 'checked' : ''}> Visible to annotators</label>
        <div class="an-edit-actions">
          <span class="an-edit-note" data-edit-note></span>
          <button type="button" class="an-btn an-btn-quiet" data-edit-cancel>Cancel</button>
          <button type="submit" class="an-btn an-btn-save">Save</button>
        </div>
      </form>`;
  }

  function wireEditForm(root, rerender = renderQueue) {
    root.querySelectorAll('[data-edit-form]').forEach(form => {
      const t = s.trajectories.find(x => x.id === form.dataset.editForm);
      const note = form.querySelector('[data-edit-note]');
      form.querySelector('[data-edit-cancel]').onclick = () => { s.editing = null; rerender(); };
      form.onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const patch = L.trajectoryPatchDiff(t, {
          source_task_id: fd.get('source_task_id'), title: fd.get('title'), goal: fd.get('goal'), agent_answer: fd.get('agent_answer'),
          in_annotation: form.elements.in_annotation.checked,
        });
        if (!Object.keys(patch).length) { note.textContent = 'Nothing changed.'; return; }
        form.querySelector('[type=submit]').disabled = true;
        note.textContent = 'Saving…';
        try {
          const res = await saveTrajectoryPatch(t, patch);
          s.editing = null;
          rerender();
          const n = root.querySelector('.an-count');
          if (n) n.insertAdjacentHTML('beforeend', ` · <span class="an-saved">saved ${esc(t.title || t.id).slice(0, 40)} to ${esc(res.where)}</span>`);
        } catch (err) {
          note.textContent = `Not saved: ${err.message}`;
          form.querySelector('[type=submit]').disabled = false;
        }
      };
    });
  }

  async function openTask(id) {
    if (!annotator()) { $('an-annotator-seg').classList.add('an-seg-nudge'); setTimeout(() => $('an-annotator-seg').classList.remove('an-seg-nudge'), 900); return; }
    const t = s.trajectories.find(x => x.id === id);
    if (!t) return;
    $('an-stage').innerHTML = '<div class="an-empty">Loading the steps…</div>';
    showTab('task');
    try { await loadTrajectoryBody(t); } catch (e) { $('an-stage').innerHTML = `<div class="an-empty">${esc(e.message)}</div>`; return; }
    s.current = t;
    const existing = myResult(id);
    s.draft = existing ? L.normalizeAnnotation(existing) : L.normalizeAnnotation({
      trajectory_id: id, annotator_id: annotator(),
      step_labels: L.defaultStepLabels(t.trajectory),
    });
    s.draft.annotator_id = annotator();
    // Evidence labels: one per item the page will show (saved crops + markers without a crop),
    // keeping any verdicts already saved for the same keys.
    const evKeys = L.defaultEvidenceLabels(evidenceFor(t));
    const had = new Map(s.draft.evidence_labels.map(l => [l.key, l]));
    s.draft.evidence_labels = evKeys.map(l => had.get(l.key) || l);
    s.draft.evidence_count = evKeys.length;
    s.startedAt = Date.now();
    renderTask();
  }

  /** The answer with each [ev:key] rendered as a chip that jumps to its crop (or a plain tag if none). */
  function answerHtml(text, evidence) {
    const have = new Set((evidence || []).map(e => e.key));
    return L.splitAnswerMarkers(text).map(seg => seg.ev == null
      ? esc(seg.text)
      : (have.has(seg.ev)
        ? `<a class="an-ev-chip" href="#an-ev-${esc(seg.ev)}" data-ev="${esc(seg.ev)}" title="Show evidence ${esc(seg.ev)}">ev:${esc(seg.raw || seg.ev)}</a>`
        : `<span class="an-ev-chip an-ev-chip-missing" title="No crop saved for this marker">ev:${esc(seg.raw || seg.ev)}</span>`)).join('');
  }

  /**
   * Everything the annotator grades for a run: the crops the agent saved with its answer, plus a
   * fallback card for each [ev:…] marker cited without a crop (older captures dropped cited SoM
   * indices when named evidence existed) — the final page is what such an index points at.
   */
  function evidenceFor(t) {
    const grounded = t.arms?.grounding || {};
    const steps = t.trajectory || [];
    const saved = L.answerEvidence(t.arms);
    const finalShot = grounded.final_state?.screenshot || steps[steps.length - 1]?.screenshot || null;
    const have = new Set(saved.map(e => e.key));
    const fallback = L.splitAnswerMarkers(t.agent_answer || grounded.answer || '')
      .filter(seg => { if (seg.ev == null || have.has(seg.ev)) return false; have.add(seg.ev); return true; })
      .map(seg => ({ key: seg.ev, note: /^\d+$/.test(seg.ev)
          ? `No crop was saved for this marker — it is element ${seg.ev} on the final page, shown here.`
          : `No crop was saved for “${seg.raw || seg.ev}” — the final page is shown instead; judge it from there.`,
        screenshot: finalShot, step: null, source: 'final page', cited: true, fallback: true }));
    return saved.concat(fallback);
  }

  function alertNote(msg) { const n = $('an-note'); if (n) n.textContent = msg; }

  function renderTask() {
    const t = s.current;
    const steps = t.trajectory || [];
    const grounded = t.arms?.grounding || {};
    const evidence = evidenceFor(t);
    const savedEvidence = evidence.filter(e => !e.fallback);
    const fallbackEvidence = evidence.filter(e => e.fallback);
    $('an-goal').textContent = t.goal || t.title || t.id;
    $('an-task-meta').textContent = `${steps.length} steps · ${t.url || ''}${t.in_annotation === false ? ' · hidden from annotators' : ''}`;
    const editBtn = $('an-task-edit');
    if (editBtn) {
      editBtn.onclick = () => { showTab('edit'); document.querySelector(`[data-edit-form="${CSS.escape(t.id)}"]`)?.scrollIntoView({ block: 'center' }); };
      editBtn.hidden = false;
    }

    const shot = (src, alt) => src ? `<img class="an-shot" src="${esc(imageSrc(src))}" alt="${esc(alt)}" data-zoom>` : '<div class="an-noshot">no screenshot</div>';
    const evLabel = (k) => s.draft.evidence_labels.find(l => l.key === k) || (s.draft.evidence_labels.push({ key: k, correct: null, problem: '', note: '' }), s.draft.evidence_labels[s.draft.evidence_labels.length - 1]);
    const labelFor = (n) => s.draft.step_labels.find(l => l.step === n) || (s.draft.step_labels.push({ step: n, correct: true, error_type: '', note: '' }), s.draft.step_labels[s.draft.step_labels.length - 1]);

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
            <span class="an-grade-q">Did this step serve the goal? <span class="an-grade-hint">(optional — correct by default; mark ✗ if not)</span></span>
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
        <div class="an-answer-text">${answerHtml(t.agent_answer || grounded.answer || '(no answer recorded)', evidence)}</div>
        ${evidence.length ? `
        <div class="an-kicker an-ev-head">Grade the evidence <span class="an-grade-hint">(${savedEvidence.length} crop${savedEvidence.length === 1 ? '' : 's'}${fallbackEvidence.length ? ` + ${fallbackEvidence.length} without a crop` : ''} — for each: is it correct and relevant to the task? click a picture to enlarge)</span></div>
        <div class="an-evidence">
          ${evidence.map(e => {
            const l = evLabel(e.key);
            return `
          <figure class="an-ev${e.fallback ? ' an-ev-fallback' : ''}${l.correct === true ? ' an-ev-good' : (l.correct === false ? ' an-ev-bad' : '')}" id="an-ev-${esc(e.key)}">
            ${e.screenshot ? `<img class="an-ev-img" src="${esc(imageSrc(e.screenshot))}" alt="evidence ${esc(e.key)}" data-zoom>` : '<div class="an-noshot">no crop saved</div>'}
            <figcaption><span class="an-ev-key">ev:${esc(e.key)}</span>${e.step ? ` <span class="an-ev-step">step ${e.step}</span>` : ''}${e.source ? ` <span class="an-ev-step">${esc(e.source)}</span>` : ''}${e.fallback ? ' <span class="an-tag">no crop</span>' : ''}${e.note ? `<div>${esc(e.note)}</div>` : ''}</figcaption>
            <div class="an-ev-grade">
              <label class="an-pill${l.correct === true ? ' an-pill-on-good' : ''}"><input type="radio" name="ev-${esc(e.key)}" value="1" ${l.correct === true ? 'checked' : ''}>✓ Correct &amp; relevant</label>
              <label class="an-pill${l.correct === false ? ' an-pill-on-bad' : ''}"><input type="radio" name="ev-${esc(e.key)}" value="0" ${l.correct === false ? 'checked' : ''}>✗ Not</label>
              <select class="an-err" data-ev-problem="${esc(e.key)}" ${l.correct === false ? '' : 'hidden'}>
                <option value="">— what is wrong with it? —</option>
                ${L.ANNOT_EVIDENCE_PROBLEMS.map(pr => `<option value="${pr.id}" ${l.problem === pr.id ? 'selected' : ''}>${esc(pr.label)}</option>`).join('')}
              </select>
              <input class="an-step-note" data-ev-note="${esc(e.key)}" placeholder="note (optional)" value="${esc(l.note || '')}">
            </div>
          </figure>`; }).join('')}
        </div>` : '<div class="an-empty">This run has no evidence to grade — Submit records that.</div>'}
        <div class="an-grade">
          <span class="an-grade-q">Is the final answer correct — did the agent complete the task? <span class="an-grade-hint">(optional)</span></span>
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
    $('an-stage').querySelectorAll('input[type=radio][name^=ev-]').forEach(r => {
      r.onchange = () => {
        const key = r.name.slice(3);
        const l = evLabel(key);
        l.correct = r.value === '1';
        if (l.correct) l.problem = '';
        const sel = $('an-stage').querySelector(`[data-ev-problem="${CSS.escape(key)}"]`);
        if (sel) { sel.hidden = l.correct; if (l.correct) sel.value = ''; }
        const fig = r.closest('.an-ev');
        fig.classList.toggle('an-ev-good', l.correct); fig.classList.toggle('an-ev-bad', !l.correct);
        fig.querySelectorAll('.an-pill').forEach(p => p.classList.remove('an-pill-on-good', 'an-pill-on-bad'));
        r.parentElement.classList.add(l.correct ? 'an-pill-on-good' : 'an-pill-on-bad');
        renderProgress();
      };
    });
    $('an-stage').querySelectorAll('[data-ev-problem]').forEach(sel => { sel.onchange = () => { evLabel(sel.dataset.evProblem).problem = sel.value; renderProgress(); }; });
    $('an-stage').querySelectorAll('[data-ev-note]').forEach(inp => { inp.oninput = () => { evLabel(inp.dataset.evNote).note = inp.value; }; });
    $('an-stage').querySelectorAll('[data-zoom]').forEach(img => { img.onclick = () => { $('an-lightbox-img').src = img.src; $('an-lightbox').hidden = false; }; });
    $('an-stage').querySelectorAll('[data-ev]').forEach(a => {
      a.onclick = (e) => {
        e.preventDefault();
        const fig = document.getElementById(`an-ev-${a.dataset.ev}`);
        if (!fig) return;
        fig.scrollIntoView({ block: 'center', behavior: 'smooth' });
        fig.classList.add('an-ev-flash'); setTimeout(() => fig.classList.remove('an-ev-flash'), 1200);
      };
    });
    renderProgress();
  }

  function renderProgress() {
    const n = (s.current?.trajectory || []).length;
    const keys = evidenceFor(s.current).map(e => e.key);
    const evGraded = s.draft.evidence_labels.filter(l => keys.includes(l.key) && l.correct !== null).length;
    const evBad = s.draft.evidence_labels.filter(l => keys.includes(l.key) && l.correct === false).length;
    const bad = s.draft.step_labels.filter(l => l.correct === false).length;
    $('an-progress').innerHTML = `<div class="an-progress-bar"><span style="width:${keys.length ? Math.round(100 * evGraded / keys.length) : 100}%"></span></div>
      <div class="an-progress-text"><strong>${evGraded} / ${keys.length} evidence graded</strong> · ${evBad} marked not correct/relevant</div>
      <div class="an-progress-text an-progress-minor">optional: ${bad} of ${n} steps marked incorrect · answer: ${s.draft.answer_correct === null ? '—' : (s.draft.answer_correct ? 'correct' : 'incorrect')}</div>`;
    const problem = L.annotationProblem(s.draft, n, keys);
    alertNote(problem || 'Ready to submit.');
    $('an-submit').disabled = !!problem;
    const ev = $('an-stage').querySelector('.an-ev-head');
    if (ev) ev.classList.toggle('an-ev-head-todo', !!problem);
  }

  async function submit() {
    const n = (s.current?.trajectory || []).length;
    s.draft.annotator_id = annotator();
    s.draft.duration_ms = (s.draft.duration_ms || 0) + (Date.now() - s.startedAt);
    s.draft.evidence_count = evidenceFor(s.current).length;
    const ann = L.normalizeAnnotation(s.draft);
    if (L.annotationProblem(ann, n, evidenceFor(s.current).map(e => e.key))) { renderProgress(); return; }
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
      <div class="an-stat"><div class="an-stat-n">${o.trajectories_complete_both}</div><div class="an-stat-l">trajectories with evidence fully graded by both</div></div>
      <div class="an-stat"><div class="an-stat-n">${pct(o.evidence_agreement)}</div><div class="an-stat-l">evidence agreement (${o.evidence_compared} items)</div></div>
      <div class="an-stat"><div class="an-stat-n">${k(o.evidence_kappa)}</div><div class="an-stat-l">evidence Cohen's κ</div></div>
      <div class="an-stat"><div class="an-stat-n">${pct(o.evidence_problem_agreement)}</div><div class="an-stat-l">problem-type agreement (both said not correct)</div></div>`;
    const done = (v) => v ? '✓' : '·';
    $('an-agree-table').innerHTML = `
      <thead><tr><th>#</th><th>Trajectory</th><th>A done</th><th>B done</th><th>Evidence compared</th><th>Agreement</th><th>κ</th><th>Disagree on</th><th>Problem-type agr.</th></tr></thead>
      <tbody>${rep.perTrajectory.map((r, i) => `
        <tr class="${!r.complete_a || !r.complete_b ? 'an-tr-missing' : (r.disagreeing_evidence.length ? 'an-tr-diff' : '')}">
          <td>${i + 1}</td><td>${esc(r.title)}</td>
          <td>${done(r.complete_a)}</td><td>${done(r.complete_b)}</td>
          <td>${r.evidence_compared}</td><td>${pct(r.evidence_agreement)}</td><td>${k(r.evidence_kappa)}</td>
          <td>${r.disagreeing_evidence.map(x => `ev:${esc(x)}`).join(', ') || '—'}</td><td>${pct(r.evidence_problem_agreement)}</td>
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
    setAnnotator(lsGet(LS_ANNOTATOR, ''), { save: false });
    document.querySelectorAll('[data-annotator]').forEach(b => { b.onclick = () => { setAnnotator(b.dataset.annotator); renderQueue(); }; });
    document.querySelectorAll('.an-tab').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
    $('an-back').onclick = () => showTab('queue');
    renderResearcherButton();
    $('an-edit-refresh').onclick = async () => { try { await loadTrajectories(); await loadResults(); } catch (e) { alert(e.message); } renderEdit(); };
    $('an-edit-publish').onchange = async (e) => {
      const note = $('an-edit-publish-note');
      const all = [];
      for (const f of e.target.files) {
        note.textContent = `Publishing ${f.name}…`;
        try { all.push(...await publishBundle(JSON.parse(await f.text()))); }
        catch (err) { all.push({ id: f.name, ok: false, error: err.message }); }
      }
      e.target.value = '';
      const ok = all.filter(r => r.ok), bad = all.filter(r => !r.ok);
      note.textContent = `${ok.length} published${bad.length ? `, ${bad.length} failed: ${bad.map(r => `${r.id} — ${r.error}`).join('; ')}` : ''}`;
      note.className = `an-edit-publish-note ${bad.length ? 'an-bad' : 'an-saved'}`;
      try { await loadTrajectories(); await loadResults(); } catch (err) { /* list stays as it was */ }
      renderEdit();
    };
    $('an-researcher').onclick = async () => {
      if (adminPassword()) {
        lockResearcher(); renderResearcherButton();
        try { await loadTrajectories(); await loadResults(); } catch (e) { /* queue falls back to live rows */ }
        showTab('queue');
        return;
      }
      if (!(await unlockResearcher())) return;
      renderResearcherButton();
      try { await loadTrajectories(); await loadResults(); } catch (e) { alert(e.message); }
      showTab('edit');
    };
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
    await loadTasks();
    try { await loadTrajectories(); await loadResults(); } catch (e) { $('an-queue-list').innerHTML = `<div class="an-empty">${esc(e.message)}</div>`; return; }
    renderQueue();
  }
  boot();
})();
