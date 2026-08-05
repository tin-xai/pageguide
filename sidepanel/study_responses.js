// PageGuide User Study — pre-recorded agent responses
// ====================================================
// Participants must read the SAME agent answer, not a fresh one: the grounding arm needs identical
// text citations and visual evidence for everyone, and the non-grounding arm needs a matched bare
// version of that same answer rather than an independently generated one. So the researcher records
// each answer once (Save), curates it (Edit), and the study replays it later.
//
// This module is the authoring/storage half. Playback is not built yet.
//
// THE AUTHORING PIPELINE, driven from the study's Answer screen (sidepanel/study.js):
//   run the task grounded → Save as Grounded → _stripStudyGrounding → edit the bare draft →
//   Save as Non-grounded. Two records per question, derived from ONE generation, which is the whole
//   point: the arms have to differ in grounding, not in what the agent happened to say that run.
//
// WHAT A RECORD MUST KEEP, and why:
//   answer_raw  — the answer with its markers INTACT: [N:"text"] for what the agent read, [ev:key]
//                 for what it saw. parseCitations and _expandEvidenceKeyCitations build the clickable
//                 links out of exactly these; strip them and the grounding is gone. This is why the
//                 existing chat-history feature (saveCurrentChat) is not a model to copy — its own
//                 comment says it stores "Only ... text messages — no HTML or highlights".
//   evidence    — findEvidenceShots verbatim, including `key` (binds [ev:key] to a card) and `marks`
//                 (the geometry pageguideShowEvidenceAnnotations needs to redraw on the live page).
//
// TWO THINGS PLAYBACK WILL HIT, recorded here while they are fresh:
//   1. [N] numbers are NOT durable. getIndexedElement (content/utils.js) is a bare
//      window._pageguideIndex[idx] lookup with no text fallback, and that index is rebuilt from the
//      DOM every run. The quoted text inside each marker is the durable anchor —
//      gv2FindElementByText / gv2PickTargetIndex (content/tasks/guidev2.js) are the existing
//      "trust the index only if the text agrees" resolvers to reuse.
//   2. Annotated marks do NOT survive reflow. When an evidence item has annotations,
//      pageguideShowEvidenceAnnotations places them purely from marks.captureGeometry plus
//      normalised coordinates; gv2ResolveEvidenceElement is consulted only on the no-annotation
//      branch, and marks carries no selector. Replaying at a different window width will drift.

const PAGEGUIDE_STUDY_RESPONSES_KEY = 'pageguide_study_responses';

/** Evidence crops wider than this are downscaled before saving — see _downscaleStudyShot. */
const STUDY_RESPONSE_SHOT_MAX_WIDTH = 1024;

/**
 * Recordings made before the arms were collapsed to two. The Visual/Text evidence split used to get
 * its own slot, but with the crops no longer shown anywhere in the chat the two produce the same
 * reading experience, so 'grounding' is one arm and these are read-only fallbacks.
 */
const STUDY_GROUNDED_LEGACY_KEYS = ['grounding-visual', 'grounding-text'];

/**
 * The condition a record belongs to. Two arms, one per question: what the participant reads either
 * carries its grounding markers or it does not.
 *
 * @param {boolean} nonGrounding - _isPanelNonGrounding()
 * @returns {'nongrounding'|'grounding'}
 */
function _studyResponseCondition(nonGrounding) {
  return nonGrounding ? 'nongrounding' : 'grounding';
}

/**
 * Strip a grounded answer down to the bare version the non-grounding arm reads.
 *
 * The strip itself is `stripNonGroundingMarkers` (content/utils.js) — the SAME function the
 * Non-grounding arm applies to a generated answer. Reusing it is the point: a recorded bare answer
 * has to read exactly like a generated one, or the two arms differ in more than their grounding.
 * All this adds is the panel's display suffix, which is appended after generation and so is never
 * covered by the generation-time strip.
 *
 * The Answer screen offers an Edit step straight after, which is the safety net for the odd case
 * the duplicate-detection heuristic reads the wrong way.
 *
 * @param {string} answerRaw - the grounded answer with its markers intact
 * @returns {string}
 */
function _stripStudyGrounding(answerRaw) {
  const text = String(answerRaw == null ? '' : answerRaw);
  const bare = typeof stripNonGroundingMarkers === 'function' ? stripNonGroundingMarkers(text) : text;
  return String(bare == null ? '' : bare)
    .replace(/✨\s*\(\d+\s+highlighted\)/gi, '') // panel display suffix; there are no highlights here
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Storage key for one (task, condition) slot. Re-saving overwrites rather than appending. */
function _studyResponseKey(taskId, condition) {
  return `${String(taskId || '').trim()}::${String(condition || '').trim()}`;
}

/**
 * Build the durable record from a live answer result. Pure — this is where the "never lose the
 * markers" rule is enforced, so it is the thing worth testing.
 *
 * Accepts both result shapes: the Ask route returns `answer`, a Guide find step returns `findAnswer`.
 *
 * @param {{taskId: string, condition: string, url?: string, question?: string, result: object}} ctx
 * @returns {object} the record
 */
function _buildStudyResponseRecord(ctx) {
  const { taskId, condition, url, question, result } = ctx || {};
  const r = result || {};
  // findAnswer first: a Guide find step carries BOTH, and findAnswer is the one with the markers.
  const answer = typeof r.findAnswer === 'string' && r.findAnswer ? r.findAnswer : (r.answer || '');
  // Kept on `key` or `marks`, NOT on `shot`. A crop is no longer shown anywhere — every marker in an
  // answer points at the live page — so an item with marks but no picture is still a working piece
  // of evidence. Filtering those out silently deleted their [ev:key] markers from the replayed
  // answer, so the banked version read differently from the one the researcher approved.
  const evidence = (Array.isArray(r.findEvidenceShots) ? r.findEvidenceShots : [])
    .filter(item => item && (item.key || item.marks || item.shot))
    .map(item => ({
      shot: item.shot || null,
      note: item.note || '',
      index: item.index,
      key: item.key || null,
      source_image_id: item.source_image_id || 'viewport',
      marks: item.marks || null
    }));

  return {
    task_id: String(taskId || ''),
    condition: String(condition || ''),
    url: url || '',
    question: question || '',
    answer_raw: answer,
    answer_display: answer,
    evidence,
    // Where each [N:"…"] citation actually points, resolved on the live page while the index that
    // issued N was still installed. Filled by _attachCitationAnchors; null when it could not run.
    // See content/functions/citation_anchors.js for why this is the only moment it is knowable.
    citation_anchors: Array.isArray(ctx?.citationAnchors) ? ctx.citationAnchors : null,
    highlight_count: Number(r.highlightCount) || 0,
    edited: false,
    recorded_at: new Date().toISOString(),
    edited_at: null
  };
}

/**
 * The record to write for one arm of the Answer screen. Pure — it is the decision that matters, and
 * getting it wrong is silent: the answer still saves, just without its evidence.
 *
 *   fresh recording  → build from the live result: text AND the evidence it was generated with.
 *   editing a record → change ONLY the text. The evidence carries the `marks` that every [ev]
 *                      marker in the answer scrolls to, so rebuilding from the edited text alone
 *                      deletes the annotations and leaves just the [N:"…"] spans behind.
 *   a bare draft     → no recording behind it (the stripped non-grounded answer), so no evidence.
 *
 * @param {{taskId: string, condition: string, url?: string, question?: string,
 *          existing?: object|null, result?: object|null, text?: string}} ctx
 * @returns {object} the record to save
 */
function _buildStudyArmRecord(ctx) {
  const { taskId, condition, url, question, existing, result, text } = ctx || {};
  if (result) {
    return _buildStudyResponseRecord({ taskId, condition, url, question, result });
  }
  if (existing) {
    return _applyStudyResponseEdit(existing, text);
  }
  return _applyStudyResponseEdit(
    _buildStudyResponseRecord({
      taskId, condition, url, question,
      result: { answer: text, findEvidenceShots: [], highlightCount: 0 }
    }),
    text
  );
}

/**
 * Ask the page where this answer's citations point, and hang the result on the record.
 *
 * Runs against the tab the answer was produced on, because the numbers in `[N:"…"]` are only
 * meaningful while that run's page index is installed — a reload discards it and it cannot be
 * rebuilt (see content/functions/citation_anchors.js).
 *
 * Failure is soft and REPORTED, never thrown: a page that has since navigated, or an answer banked
 * from a parked result, simply has no anchors, and the site falls back to text search for those
 * citations. What must not happen is banking silently and finding out at analysis.
 *
 * @returns {Promise<{ok: boolean, resolved: number, total: number, reason: string|null}>}
 */
async function _attachCitationAnchors(record, tabId) {
  const answer = record?.answer_raw || record?.answer_display || '';
  if (!/\[\d+:"/.test(answer)) return { ok: true, resolved: 0, total: 0, reason: null };
  try {
    const id = tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (!id) return { ok: false, resolved: 0, total: 0, reason: 'no active tab' };
    const res = await chrome.tabs.sendMessage(id, { action: 'resolveCitationAnchors', answer });
    if (!res || res.error) {
      return { ok: false, resolved: 0, total: 0, reason: res?.error || 'the page did not respond' };
    }
    record.citation_anchors = res.anchors || [];
    return {
      ok: res.hasIndex && res.resolved > 0,
      resolved: res.resolved,
      total: res.total,
      reason: res.hasIndex ? null : 'the answer run\'s page index is gone (was the page reloaded?)',
    };
  } catch (e) {
    return { ok: false, resolved: 0, total: 0, reason: e?.message || String(e) };
  }
}

/**
 * Apply an edited answer to a record. Pure. Only the text changes — evidence is left exactly as
 * captured, since editing prose must never silently drop a screenshot.
 */
function _applyStudyResponseEdit(record, newAnswer) {
  return Object.assign({}, record, {
    answer_raw: String(newAnswer == null ? '' : newAnswer),
    answer_display: String(newAnswer == null ? '' : newAnswer),
    edited: true,
    edited_at: new Date().toISOString()
  });
}

/**
 * Shrink one base64 JPEG to at most `maxWidth` across. Evidence crops are captured at device-pixel
 * ratio and never downscaled by the capture path, so a retina full-viewport item can be ~1 MB —
 * enough that a bank of them is awkward to put in a database row. Returns the input unchanged on any
 * failure: a slightly large record beats a lost one.
 */
function _downscaleStudyShot(base64, maxWidth = STUDY_RESPONSE_SHOT_MAX_WIDTH) {
  return new Promise((resolve) => {
    if (!base64) { resolve(base64); return; }
    // Time-box the decode: an Image that neither loads nor errors would otherwise hang the save,
    // and the whole point of this helper is that it never costs us the record.
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(base64), 2000);
    try {
      const img = new Image();
      img.onload = () => {
        try {
          if (!img.naturalWidth || img.naturalWidth <= maxWidth) { finish(base64); return; }
          const scale = maxWidth / img.naturalWidth;
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL('image/jpeg', 0.86).replace(/^data:image\/\w+;base64,/, ''));
        } catch (e) { finish(base64); }
      };
      img.onerror = () => finish(base64);
      img.src = `data:image/jpeg;base64,${base64}`;
    } catch (e) {
      finish(base64);
    }
  });
}

/** Downscale every crop in a record, in place on a copy. */
async function _downscaleStudyResponseEvidence(record) {
  const evidence = Array.isArray(record?.evidence) ? record.evidence : [];
  if (!evidence.length) return record;
  const shrunk = [];
  for (const item of evidence) {
    shrunk.push(Object.assign({}, item, { shot: await _downscaleStudyShot(item.shot) }));
  }
  return Object.assign({}, record, { evidence: shrunk });
}

// ===== STORAGE =====
// chrome.storage.local is the source of truth. manifest.json grants unlimitedStorage, so the base64
// evidence is fine here even before downscaling.

async function listStudyResponses() {
  try {
    const data = await chrome.storage.local.get(PAGEGUIDE_STUDY_RESPONSES_KEY);
    const all = data[PAGEGUIDE_STUDY_RESPONSES_KEY];
    return (all && typeof all === 'object') ? all : {};
  } catch (e) {
    console.warn('[StudyResponses] read failed:', e);
    return {};
  }
}

/**
 * The record for one (task, condition), or null. A 'grounding' read falls back to the pre-collapse
 * per-evidence-mode slots, so recordings made before the arms were merged stay visible.
 */
async function getStudyResponse(taskId, condition) {
  const all = await listStudyResponses();
  const hit = all[_studyResponseKey(taskId, condition)];
  if (hit) return hit;
  if (condition === 'grounding') {
    for (const legacy of STUDY_GROUNDED_LEGACY_KEYS) {
      const old = all[_studyResponseKey(taskId, legacy)];
      if (old) return old;
    }
  }
  return null;
}

/**
 * Save a record locally, then mirror it to Supabase when configured. Local write is what counts;
 * a remote failure warns and returns, exactly like the study's own persistResult.
 *
 * @returns {Promise<{saved: boolean, synced: boolean, error?: string}>}
 */
async function saveStudyResponse(record, { downscale = true } = {}) {
  const toStore = downscale ? await _downscaleStudyResponseEvidence(record) : record;
  try {
    const all = await listStudyResponses();
    all[_studyResponseKey(toStore.task_id, toStore.condition)] = toStore;
    await chrome.storage.local.set({ [PAGEGUIDE_STUDY_RESPONSES_KEY]: all });
  } catch (e) {
    console.error('[StudyResponses] local save failed:', e);
    return { saved: false, synced: false, error: e?.message || 'local save failed' };
  }
  const synced = await syncStudyResponse(toStore);
  return { saved: true, synced };
}

/**
 * Drop every record whose task no longer exists in tasks.json. A question removed from the task
 * file is a question that will never be asked again, and leaving its recordings behind means the
 * bank slowly fills with answers to nothing — which shows up later as a task count that does not
 * match the number of banked pairs.
 *
 * Guarded on a NON-EMPTY id list on purpose: this deletes recordings, and a tasks.json that failed
 * to load, or loaded as `{}`, would otherwise look exactly like "every task was deleted" and wipe
 * the whole bank.
 *
 * @param {Array<string>} validTaskIds - every task id currently in tasks.json
 * @returns {Promise<Array<string>>} the storage keys removed
 */
async function pruneStudyResponses(validTaskIds) {
  const keep = new Set((Array.isArray(validTaskIds) ? validTaskIds : [])
    .map(id => String(id || '').trim())
    .filter(Boolean));
  if (!keep.size) return [];
  try {
    const all = await listStudyResponses();
    const orphaned = Object.keys(all).filter(key => !keep.has(String(all[key]?.task_id || key.split('::')[0]).trim()));
    if (!orphaned.length) return [];
    orphaned.forEach(key => { delete all[key]; });
    await chrome.storage.local.set({ [PAGEGUIDE_STUDY_RESPONSES_KEY]: all });
    console.log(`[StudyResponses] pruned ${orphaned.length} record(s) for deleted tasks:`, orphaned);
    return orphaned;
  } catch (e) {
    console.warn('[StudyResponses] prune failed:', e);
    return [];
  }
}

async function deleteStudyResponse(taskId, condition) {
  try {
    const all = await listStudyResponses();
    delete all[_studyResponseKey(taskId, condition)];
    await chrome.storage.local.set({ [PAGEGUIDE_STUDY_RESPONSES_KEY]: all });
    return true;
  } catch (e) {
    console.warn('[StudyResponses] delete failed:', e);
    return false;
  }
}

/**
 * Mirror one record to Supabase. Reuses study.js's supabaseInsert (exposed on window) rather than
 * standing up a second client — it already handles the anon key and the return=representation →
 * return=minimal retry when RLS blocks the RETURNING clause.
 *
 * Never throws: the local copy is the source of truth.
 */
async function syncStudyResponse(record) {
  if (typeof window.supabaseInsert !== 'function') return false;
  try {
    const row = await window.supabaseInsert('study_canned_responses', {
      task_id: record.task_id,
      condition: record.condition,
      url: record.url,
      question: record.question,
      answer_raw: record.answer_raw,
      answer_display: record.answer_display,
      evidence: record.evidence,
      highlight_count: record.highlight_count,
      edited: !!record.edited
    });
    // supabaseInsert returns null both when Supabase is unconfigured and when the row was created
    // without a readable RETURNING, so this is "we tried and nothing threw", not "confirmed stored".
    return row !== undefined;
  } catch (e) {
    console.warn('[StudyResponses] Supabase sync failed (saved locally):', e);
    return false;
  }
}

// ===== EDITING =====

/**
 * Edit a block of answer text in a dialog, resolving to the new text or null if it was dismissed.
 *
 * Generic on purpose: the Answer screen edits three different things through it (the live answer,
 * a banked record, an unsaved bare draft) and the caller decides what to do with the result. Reuses
 * the #pageguide-memory-shot-lightbox shell and the .pageguide-study-edit-* classes the panel's own
 * edit dialog already styles.
 *
 * @param {string} text
 * @param {{title?: string, hint?: string}} [options]
 * @returns {Promise<string|null>}
 */
function openStudyAnswerEditor(text, options = {}) {
  const esc = typeof escapeHtml === 'function' ? escapeHtml : (v => String(v == null ? '' : v));
  return new Promise((resolve) => {
    if (typeof closeMemoryShotLightbox === 'function') closeMemoryShotLightbox();
    const overlay = document.createElement('div');
    overlay.id = 'pageguide-memory-shot-lightbox';
    overlay.className = 'pageguide-memory-shot-lightbox';
    overlay.innerHTML = `
      <div class="pageguide-memory-shot-dialog pageguide-recap-detail" role="dialog" aria-modal="true" aria-label="Edit answer">
        <div class="pageguide-memory-shot-head">
          <span>${esc(options.title || 'Edit the answer')}</span>
          <button type="button" class="pageguide-memory-shot-close" aria-label="Close">×</button>
        </div>
        <div class="pageguide-recap-detail-body pageguide-study-save-body">
          <textarea class="pageguide-study-edit-text" rows="14">${esc(String(text == null ? '' : text))}</textarea>
          ${options.hint ? `<div class="pageguide-study-save-hint">${options.hint}</div>` : ''}
          <div class="pageguide-study-save-actions">
            <button type="button" class="pageguide-study-edit-apply">Apply</button>
          </div>
        </div>
      </div>`;

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('.pageguide-memory-shot-close')) close(null);
    });
    overlay.querySelector('.pageguide-study-edit-apply')?.addEventListener('click', () => {
      close(overlay.querySelector('.pageguide-study-edit-text')?.value ?? '');
    });
    document.body.appendChild(overlay);
    overlay.querySelector('.pageguide-study-edit-text')?.focus();
  });
}

// ===== PREVIEW =====

/**
 * Show one recorded response read-only, so the researcher can check what was banked for a task
 * before a participant runs it. Reached from the study's task setup screen.
 *
 * Deliberately inert: the answer is rendered through the same parseMarkdown → parseCitations →
 * _expandEvidenceKeyCitations chain the chat uses, so the markers look exactly as they will on the
 * day, but nothing is bound to them — there is no live page behind this dialog to scroll. The
 * evidence crops are shown inline instead, since that is the part worth eyeballing.
 *
 * Reuses the #pageguide-memory-shot-lightbox shell every other panel dialog uses.
 */
function openStudyResponsePreview(record, label) {
  if (!record) return;
  const esc = typeof escapeHtml === 'function' ? escapeHtml : (v => String(v == null ? '' : v));
  const answer = record.answer_display || record.answer_raw || '';
  let body = esc(answer);
  try {
    if (typeof parseMarkdown === 'function' && typeof parseCitations === 'function') {
      body = parseCitations(parseMarkdown(answer));
      if (typeof _expandEvidenceKeyCitations === 'function') {
        body = _expandEvidenceKeyCitations(body, Array.isArray(record.evidence) ? record.evidence : []);
      }
    }
  } catch (e) {
    body = esc(answer);
  }
  const shots = (Array.isArray(record.evidence) ? record.evidence : []).filter(item => item && item.shot);
  const figures = shots.map((item) => {
    const caption = item.note || `Evidence ${item.index}`;
    return `<figure class="pageguide-study-preview-figure">
      <img src="data:image/jpeg;base64,${item.shot}" alt="${esc(caption)}">
      <figcaption>${esc(String(item.index ?? ''))} · ${esc(caption)}</figcaption>
    </figure>`;
  }).join('');

  if (typeof closeMemoryShotLightbox === 'function') closeMemoryShotLightbox();
  const overlay = document.createElement('div');
  overlay.id = 'pageguide-memory-shot-lightbox';
  overlay.className = 'pageguide-memory-shot-lightbox';
  overlay.innerHTML = `
    <div class="pageguide-memory-shot-dialog pageguide-recap-detail" role="dialog" aria-modal="true" aria-label="Saved study response">
      <div class="pageguide-memory-shot-head">
        <span>${esc(label || record.condition)} · ${esc(record.task_id)}</span>
        <button type="button" class="pageguide-memory-shot-close" aria-label="Close">×</button>
      </div>
      <div class="pageguide-recap-detail-body pageguide-study-preview-body">
        <div class="pageguide-study-preview-meta">
          ${esc(record.condition)} · ${shots.length} evidence image${shots.length === 1 ? '' : 's'}
          · ${Number(record.highlight_count) || 0} highlight(s)${record.edited ? ' · edited' : ''}
        </div>
        <div class="pageguide-study-preview-answer">${body}</div>
        ${figures}
      </div>
    </div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.pageguide-memory-shot-close')) {
      if (typeof closeMemoryShotLightbox === 'function') closeMemoryShotLightbox();
      else overlay.remove();
    }
  });
  document.body.appendChild(overlay);
}

// ===== GROUND TRUTH FOR THE SUPPORTING QUESTIONS =====
// What a participant's picked sentence is scored against, authored the same way they answer: by
// pointing at the page.
//
// A LIST per hop, not a single sentence, on purpose. The answer to a supporting question is often
// stated in more than one place — a caption and the paragraph beside it, a claim and its restatement
// — and marking a participant wrong for pointing at the other one would be scoring the page rather
// than the participant. Anything in the list counts.

const PAGEGUIDE_STUDY_GROUND_TRUTH_KEY = 'pageguide_study_ground_truth';

/** One accepted sentence: what was picked, and where on the page it was picked from. */
function _buildGroundTruthEntry(picked) {
  const text = String(picked?.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // "No index" has to stay null. Number(null) is 0 — a perfectly finite, perfectly wrong page index
  // — so a typed or hand-edited entry would be filed as pointing at element 0.
  const raw = picked?.index;
  const index = (raw === null || raw === undefined || raw === '') ? null : Number(raw);
  return {
    text,
    index: Number.isFinite(index) ? index : null,
    url: picked?.url || '',
    // Kept so the panel can take the researcher back to what was picked. Not part of the match —
    // a selector is a position on one rendering of the page, the words are the answer.
    selector: picked?.selector || ''
  };
}

/**
 * Build the record for one task. Pure. Entries are deduplicated on their text, since the same
 * sentence picked twice is one accepted answer, not two.
 *
 * @param {string} taskId
 * @param {object} hops - {1: [entry|picked], 2: [...]}
 * @returns {{task_id: string, hops: object, updated_at: string}}
 */
function _buildGroundTruthRecord(taskId, hops) {
  const out = {};
  Object.keys(hops || {}).forEach(hop => {
    const seen = new Set();
    out[String(hop)] = (Array.isArray(hops[hop]) ? hops[hop] : [])
      .map(_buildGroundTruthEntry)
      .filter(entry => {
        if (!entry) return false;
        const key = entry.text.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  });
  return { task_id: String(taskId || ''), hops: out, updated_at: new Date().toISOString() };
}

async function listStudyGroundTruth() {
  try {
    const data = await chrome.storage.local.get(PAGEGUIDE_STUDY_GROUND_TRUTH_KEY);
    const all = data[PAGEGUIDE_STUDY_GROUND_TRUTH_KEY];
    return (all && typeof all === 'object') ? all : {};
  } catch (e) {
    console.warn('[StudyGroundTruth] read failed:', e);
    return {};
  }
}

async function getStudyGroundTruth(taskId) {
  const all = await listStudyGroundTruth();
  return all[String(taskId || '').trim()] || null;
}

/** Save one task's ground truth locally, then mirror it to Supabase. Local is the source of truth. */
async function saveStudyGroundTruth(record) {
  try {
    const all = await listStudyGroundTruth();
    all[String(record?.task_id || '').trim()] = record;
    await chrome.storage.local.set({ [PAGEGUIDE_STUDY_GROUND_TRUTH_KEY]: all });
  } catch (e) {
    console.error('[StudyGroundTruth] local save failed:', e);
    return { saved: false, synced: false, error: e?.message || 'local save failed' };
  }
  let synced = false;
  if (typeof window.supabaseInsert === 'function') {
    try {
      const row = await window.supabaseInsert('study_ground_truth', {
        task_id: record.task_id,
        hops: record.hops
      });
      synced = row !== undefined;
    } catch (e) {
      console.warn('[StudyGroundTruth] Supabase sync failed (saved locally):', e);
    }
  }
  return { saved: true, synced };
}

/** Same orphan rule as the response bank: a task deleted from tasks.json takes its ground truth. */
async function pruneStudyGroundTruth(validTaskIds) {
  const keep = new Set((Array.isArray(validTaskIds) ? validTaskIds : [])
    .map(id => String(id || '').trim())
    .filter(Boolean));
  if (!keep.size) return [];
  try {
    const all = await listStudyGroundTruth();
    const orphaned = Object.keys(all).filter(taskId => !keep.has(taskId));
    if (!orphaned.length) return [];
    orphaned.forEach(taskId => { delete all[taskId]; });
    await chrome.storage.local.set({ [PAGEGUIDE_STUDY_GROUND_TRUTH_KEY]: all });
    console.log(`[StudyGroundTruth] pruned ${orphaned.length} record(s) for deleted tasks:`, orphaned);
    return orphaned;
  } catch (e) {
    console.warn('[StudyGroundTruth] prune failed:', e);
    return [];
  }
}

/** Download the whole bank as JSON, so it can be committed beside user_study_data/tasks.json. */
async function exportStudyResponses() {
  const all = await listStudyResponses();
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `study_responses_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return Object.keys(all).length;
}

if (typeof window !== 'undefined') {
  window.PAGEGUIDE_STUDY_RESPONSES_KEY = PAGEGUIDE_STUDY_RESPONSES_KEY;
  window._studyResponseCondition = _studyResponseCondition;
  window._studyResponseKey = _studyResponseKey;
  window._stripStudyGrounding = _stripStudyGrounding;
  window.openStudyAnswerEditor = openStudyAnswerEditor;
  window._buildStudyResponseRecord = _buildStudyResponseRecord;
  window._buildStudyArmRecord = _buildStudyArmRecord;
  window._applyStudyResponseEdit = _applyStudyResponseEdit;
  window._attachCitationAnchors = _attachCitationAnchors;
  window.listStudyResponses = listStudyResponses;
  window.getStudyResponse = getStudyResponse;
  window.saveStudyResponse = saveStudyResponse;
  window.deleteStudyResponse = deleteStudyResponse;
  window.pruneStudyResponses = pruneStudyResponses;
  window.PAGEGUIDE_STUDY_GROUND_TRUTH_KEY = PAGEGUIDE_STUDY_GROUND_TRUTH_KEY;
  window._buildGroundTruthRecord = _buildGroundTruthRecord;
  window.listStudyGroundTruth = listStudyGroundTruth;
  window.getStudyGroundTruth = getStudyGroundTruth;
  window.saveStudyGroundTruth = saveStudyGroundTruth;
  window.pruneStudyGroundTruth = pruneStudyGroundTruth;
  window.syncStudyResponse = syncStudyResponse;
  window.openStudyResponsePreview = openStudyResponsePreview;
  window.exportStudyResponses = exportStudyResponses;
}
