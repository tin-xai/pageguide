// PageGuide User Study V2 — publishing a Find item into the four-variant schema
// =============================================================================
// V1 asked a participant to judge ONE authored answer per question, and the answer was always the
// correct one; only its grounding varied. V2 counterbalances on two axes at once —
//
//                   grounded                    non-grounded
//   correct         correct_grounding           correct_nongrounding
//   incorrect       incorrect_grounding         incorrect_nongrounding
//
// — and deals one of the four cells per participant from their assignment slot. All four therefore
// have to exist on the item BEFORE anyone starts, which is what this file writes.
//
// WHY THIS WRITES TO SUPABASE DIRECTLY, unlike the V1 export beside it.
//
// study.js explains at length (see "EXPORTING STIMULI FOR THE STUDY WEBSITE") that it cannot
// upload V1 stimuli: anon has no write policy on the V1 stimulus tables, writing needs the
// secret key, and Supabase refuses a secret key from any browser context —
//
//     401 "Forbidden use of secret API key in browser"
//
// — so V1 writes a JSON bundle and a terminal script uploads it. V2 removes that constraint at the
// schema level. `save_pageguide_find_v2_claim` is SECURITY DEFINER, `grant execute … to anon`, and
// gated on an admin password checked inside the function (supabase_schema_v2.sql). The privilege
// lives in the function, not in the key, so the anon key plus a password the researcher types is
// enough. No secret key enters this process, and there is no loopback helper to run.
//
// The password is held in a module-local variable for the life of the panel and is never written
// to chrome.storage — the schema's own note says it should live in one browser tab and die with it.
//
// TWO HALVES, split so the mapping can be tested without a network:
//   buildFindV2Claim   — pure. Local banks in, the RPC's `p_claim` payload out.
//   publishFindV2Claim — the fetch.

(function () {
  'use strict';

  /** Where the V2 project lives. Separate from V1's, so V1 keeps collecting untouched. */
  function _v2Configured() {
    return typeof SUPABASE_V2_URL !== 'undefined'
      && !!SUPABASE_V2_URL
      && !SUPABASE_V2_URL.includes('YOUR_V2_PROJECT')
      && typeof SUPABASE_V2_ANON_KEY !== 'undefined'
      && !!SUPABASE_V2_ANON_KEY
      && !SUPABASE_V2_ANON_KEY.includes('YOUR_V2_PROJECT');
  }

  function _v2Headers() {
    return {
      'apikey': SUPABASE_V2_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_V2_ANON_KEY}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * The admin password for this panel session. Deliberately a plain variable: it must not survive
   * the tab, must not sync, and must not be recoverable from disk afterwards.
   */
  let _adminPassword = null;

  /**
   * One cell of `answer_variants`, in the shape pageguide_v2_normalize_variants rebuilds anyway.
   *
   * `answer_text` comes from answer_raw and NOT from answer_display, because raw is the copy that
   * still carries the [N:"…"] and [ev:key] markers — the site rebuilds every clickable citation out
   * of exactly those, so a display copy would publish a grounded answer with its grounding gone.
   */
  function _variantPayload(record) {
    const text = record?.answer_raw || record?.answer_display || '';
    return {
      answer_text: String(text || '').trim(),
      citation_anchors: Array.isArray(record?.citation_anchors) ? record.citation_anchors : [],
      evidence: Array.isArray(record?.evidence) ? record.evidence : []
    };
  }

  /**
   * find_visual vs find_text, from tasks.json's `type`.
   *
   * Case-insensitive on purpose: the bank is inconsistent — five items say "FIND X VISUAL" and five
   * say "FIND x TEXT" — and a case-sensitive test would have quietly filed every visual task as
   * text, which changes what the participant is asked to point at.
   */
  function _taskStyleOf(task) {
    return /visual/i.test(String(task?.type || '')) ? 'find_visual' : 'find_text';
  }

  /**
   * The `p_claim` payload for one Find item. Pure — every input is passed in.
   *
   * @param {{task: object, taskIndex?: number, records?: object,
   *          groundTruth?: object|null, page?: object|null}} ctx
   *   task       - the tasks.json entry
   *   records    - { [variant]: bankedRecord|null } for the four cells
   *   groundTruth- the study_ground_truth record ({ hops })
   *   page       - the captured page snapshot ({ html, title, url })
   * @returns {object} the payload, plus a non-wire `_missing` list explaining any refusal
   */
  function buildFindV2Claim(ctx) {
    const { task, taskIndex, records, groundTruth, page } = ctx || {};
    const t = task || {};
    const banked = records || {};

    const variants = {};
    const missing = [];
    for (const variant of STUDY_V2_VARIANTS) {
      variants[variant] = _variantPayload(banked[variant]);
      if (!variants[variant].answer_text) missing.push(variant);
    }

    const question = String(t.question || '').trim();
    const url = String(t.url || '').trim();
    const pageHtml = page?.html || '';
    if (!question) missing.push('question');
    if (!url) missing.push('url');
    if (!pageHtml) missing.push('page snapshot');

    // 'balanced' walks all four cells. Pinning is for an item where one side genuinely cannot be
    // written — not for one that merely has not been written yet, which is what `missing` reports.
    // Only the two correct cells authored is the common half-done state, and pinning it lets the
    // item go live for the correctness axis it does have rather than blocking the whole queue.
    const correctAuthored = !!(variants.correct_grounding.answer_text
      && variants.correct_nongrounding.answer_text);
    const incorrectAuthored = !!(variants.incorrect_grounding.answer_text
      && variants.incorrect_nongrounding.answer_text);
    let correctnessMode = 'balanced';
    if (correctAuthored && !incorrectAuthored) correctnessMode = 'always_correct';
    else if (incorrectAuthored && !correctAuthored) correctnessMode = 'always_incorrect';

    // Mirrors the RPC's own gate (supabase_schema_v2.sql) so a refusal is explained here, in the
    // panel, with the cells named — rather than arriving as a raw Postgres exception.
    const inStudy = !missing.length;

    return {
      id: String(t.id || ''),
      source_task_id: String(t.id || ''),
      title: t.title || '',
      url,
      task_style: _taskStyleOf(t),
      question,
      answer_variants: variants,
      correctness_mode: correctnessMode,
      // The supporting passage or image, shared by all four answers: where the evidence IS does not
      // change with which answer was shown, so the evidence question scores the same in every cell.
      evidence_ground_truth: (groundTruth && typeof groundTruth.hops === 'object' && groundTruth.hops)
        ? groundTruth.hops
        : {},
      page_title: page?.title || t.title || '',
      page_html: pageHtml,
      in_study: inStudy,
      task_index: Number.isFinite(Number(taskIndex)) ? Number(taskIndex) : 0,
      _missing: missing
    };
  }

  /**
   * Gather one task's four cells, its ground truth and its page, and build the payload.
   *
   * The page is looked up by task first and by URL second: two tasks can be the same article
   * (MUFC-V1 and MUFC-V1-TEXT are), and only one of them carries the capture.
   */
  async function collectFindV2Claim(task, taskIndex) {
    const records = {};
    for (const variant of STUDY_V2_VARIANTS) {
      records[variant] = await getStudyResponse(task.id, variant);
    }
    const groundTruth = await getStudyGroundTruth(task.id);

    const pages = typeof listStudyPages === 'function' ? await listStudyPages() : {};
    const rows = Object.values(pages).filter(p => p && p.html);
    const page = rows.find(p => String(p.task_id) === String(task.id))
      || rows.find(p => p.url && task.url && _sameStudyPage(p.url, task.url))
      || null;

    return buildFindV2Claim({ task, taskIndex, records, groundTruth, page });
  }

  /**
   * Check a password against the V2 project. Cheap, and worth doing before a multi-megabyte upload:
   * `save_pageguide_find_v2_claim` raises on a bad password only after the page HTML is on the wire.
   */
  async function checkV2AdminPassword(password) {
    const res = await fetch(`${SUPABASE_V2_URL}/rest/v1/rpc/pageguide_find_v2_admin_check`, {
      method: 'POST',
      headers: _v2Headers(),
      body: JSON.stringify({ p_password: password })
    });
    if (!res.ok) throw new Error(`admin check failed (${res.status})`);
    return (await res.json()) === true;
  }

  /**
   * Ask for the password once per panel session, verify it, and remember it in memory.
   * Returns null if the researcher cancelled or got it wrong.
   */
  async function ensureV2AdminPassword() {
    if (_adminPassword) return _adminPassword;
    const typed = window.prompt('V2 admin password (set with set_pageguide_find_v2_admin_password):');
    if (!typed) return null;
    if (!(await checkV2AdminPassword(typed))) return null;
    _adminPassword = typed;
    return _adminPassword;
  }

  /** Forget the password — for the researcher stepping away from a shared machine. */
  function clearV2AdminPassword() {
    _adminPassword = null;
  }

  /**
   * Upsert one claim. `_missing` is stripped: it is the panel's explanation of what is not
   * authored yet, not a column, and the RPC would ignore it anyway.
   */
  async function publishFindV2Claim(payload, password) {
    const { _missing, ...claim } = payload || {};
    const res = await fetch(`${SUPABASE_V2_URL}/rest/v1/rpc/save_pageguide_find_v2_claim`, {
      method: 'POST',
      headers: _v2Headers(),
      body: JSON.stringify({ p_password: password, p_claim: claim })
    });
    const body = await res.text();
    if (!res.ok) {
      let message = body;
      try { message = JSON.parse(body).message || body; } catch (e) { /* keep the raw body */ }
      throw new Error(message);
    }
    return body.replace(/^"|"$/g, '');
  }

  /**
   * Publish every Find task, or one of them.
   *
   * Items with unauthored cells are published anyway, as `in_study: false`. That is deliberate: a
   * half-authored item on the site as a draft is visible and fixable, whereas one held back locally
   * looks exactly like one that was never written. The report says which cells are missing.
   *
   * @param {Array<object>} tasks - tasks.json's `find` array
   * @param {string|null} [onlyTaskId]
   * @returns {Promise<{ok: boolean, error?: string, rows: Array<object>}>}
   */
  async function publishFindV2(tasks, onlyTaskId = null) {
    if (!_v2Configured()) {
      return { ok: false, error: 'V2 Supabase is not configured — set SUPABASE_V2_URL and '
        + 'SUPABASE_V2_ANON_KEY in sidepanel/supabase_config.js.', rows: [] };
    }
    const password = await ensureV2AdminPassword();
    if (!password) return { ok: false, error: 'Wrong or no admin password.', rows: [] };

    const wanted = (tasks || []).filter(t => t && t.id && (!onlyTaskId || String(t.id) === String(onlyTaskId)));
    const rows = [];
    for (let i = 0; i < wanted.length; i++) {
      const task = wanted[i];
      // Position in the FULL list, not in the filtered one: task_index orders the participant's
      // queue, so publishing one task must not renumber it to 0.
      const index = (tasks || []).findIndex(t => t && String(t.id) === String(task.id));
      try {
        const payload = await collectFindV2Claim(task, index < 0 ? i : index);
        await publishFindV2Claim(payload, password);
        rows.push({
          id: task.id,
          ok: true,
          in_study: payload.in_study,
          missing: payload._missing,
          bytes: (payload.page_html || '').length
        });
      } catch (e) {
        rows.push({ id: task.id, ok: false, missing: [], error: e?.message || String(e) });
      }
    }
    return { ok: true, rows };
  }

  // ── Running a participant against V2 ────────────────────────────────────────
  //
  // These need no admin password: claiming a slot and writing a verdict are things a participant
  // does, and the schema grants both to anon (execute on claim_pageguide_find_v2_session, insert on
  // pageguide_find_v2_results). Only authoring is password-gated.

  /**
   * Take the next assignment slot and open a session for it.
   *
   * The slot is the counterbalancing counter, and taking it has to be ATOMIC — the RPC does the
   * increment and the insert under one row lock, so two participants starting at the same moment
   * cannot be handed the same slot and therefore the same group and the same cells. Doing it in the
   * browser with a read-then-write would lose that.
   *
   * @returns {Promise<{sessionId: number, slot: number, conditionOrder: string}|null>} null when
   *   the V2 project is not configured or the call failed; the caller falls back to a local slot.
   */
  async function claimFindV2Session(participantId) {
    if (!_v2Configured()) return null;
    try {
      const res = await fetch(`${SUPABASE_V2_URL}/rest/v1/rpc/claim_pageguide_find_v2_session`, {
        method: 'POST',
        headers: _v2Headers(),
        body: JSON.stringify({ p_participant_id: String(participantId || 'anon') })
      });
      if (!res.ok) throw new Error(`claim failed (${res.status})`);
      const rows = await res.json();
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row) return null;
      return {
        sessionId: row.session_id,
        slot: Number(row.assignment_slot),
        conditionOrder: row.condition_order || ''
      };
    } catch (e) {
      console.warn('[StudyV2] could not claim a session slot:', e);
      return null;
    }
  }

  /**
   * Write one Yes/No verdict.
   *
   * `result_key` is the idempotency handle: the schema makes it unique and grants anon UPDATE for
   * exactly this reason, so a retry after a dropped connection lands on the same row instead of
   * double-counting the participant. Hence `on_conflict` + `Prefer: resolution=merge-duplicates`
   * rather than a plain insert.
   *
   * Never throws. The row is already in chrome.storage.local and in the CSV before this runs; a
   * participant must not be stopped mid-study by a network failure.
   */
  async function submitFindV2Result(row) {
    if (!_v2Configured()) return false;
    try {
      const res = await fetch(
        `${SUPABASE_V2_URL}/rest/v1/pageguide_find_v2_results?on_conflict=result_key`, {
          method: 'POST',
          headers: Object.assign(_v2Headers(), {
            'Prefer': 'resolution=merge-duplicates,return=minimal'
          }),
          body: JSON.stringify(row)
        });
      if (!res.ok) {
        console.warn('[StudyV2] verdict insert failed:', res.status, await res.text());
        return false;
      }
      return true;
    } catch (e) {
      console.warn('[StudyV2] verdict insert failed (saved locally):', e);
      return false;
    }
  }

  /** One readable line per task. Pure, so the report can be tested. */
  function describeFindV2Publish(rows) {
    return (rows || []).map(r => {
      if (!r.ok) return `✗ ${r.id} — ${r.error}`;
      if (r.in_study) return `✓ ${r.id} — live (${Math.round((r.bytes || 0) / 1024)} KB page)`;
      return `◦ ${r.id} — saved as draft, not live yet (missing: ${(r.missing || []).join(', ')})`;
    }).join('\n');
  }

  if (typeof window !== 'undefined') {
    window._v2Configured = _v2Configured;
    // guide_v2_publish.js writes the other half of the same project through the same key.
    window._v2Headers = _v2Headers;
    window._taskStyleOf = _taskStyleOf;
    window.buildFindV2Claim = buildFindV2Claim;
    window.collectFindV2Claim = collectFindV2Claim;
    window.checkV2AdminPassword = checkV2AdminPassword;
    window.ensureV2AdminPassword = ensureV2AdminPassword;
    window.clearV2AdminPassword = clearV2AdminPassword;
    window.publishFindV2Claim = publishFindV2Claim;
    window.publishFindV2 = publishFindV2;
    window.claimFindV2Session = claimFindV2Session;
    window.submitFindV2Result = submitFindV2Result;
    window.describeFindV2Publish = describeFindV2Publish;
  }
})();
