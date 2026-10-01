// PageGuide study — the trajectory viewer.
// =======================================
// The left half of a guide study task: what the agent did, at a size where it can be checked.
//
// This page MIRRORS THE LIVE RUN rather than inventing a way to look at a trajectory. A live user
// sees a "View Journey" card — a vertical list of steps, hover a row for that step's screenshot,
// click the screenshot for a full-size one (renderGoalTimeline / showGoalStepPreview /
// openMemoryShotLightbox, sidepanel/panel.js) — followed by the agent's answer and its reasoning
// trail. A participant judging that run should be looking at the same thing, or the study measures
// how well people read a study interface.
//
// ONE LAYOUT, TWO ARMS. The arms differ in exactly one way: a grounded step row will show you its
// screenshot, a non-grounded one is text and nothing else. That is the same rule the live panel
// already applies in _buildGoalTimelineRow, which skips the hover/click wiring under
// _isPanelNonGrounding(). Everything else — the order, the wording, the bookends, the answer, the
// trail — is identical, because anything else that differs is a second variable nobody is measuring.
//
// Reads the banked trajectory (chrome.storage.local, pageguide_guide_trajectories) rather than the
// rewind store: what a participant sees has to be what the researcher authored, edits and uploaded
// screenshots included, not whatever the live run happens to still hold.

// Read off window rather than re-declared: guide_trajectories.js is loaded on this page too, and two
// classic scripts share one global lexical scope — a second `const` of the same name is a parse
// error that kills this whole file silently.
const TRAJECTORY_STORE_KEY = window.PAGEGUIDE_GUIDE_TRAJECTORIES_KEY || 'pageguide_guide_trajectories';

const els = {
  goal: document.getElementById('tv-goal'),
  count: document.getElementById('tv-count'),
  stage: document.getElementById('tv-stage'),
};

let arm = null;

// Gated on the arm, not on whether the data happens to carry a screenshot. _stripGuideArm nulls
// them, but an arm can also be hand-edited in the recorder, and one uploaded image would undo the
// condition for that participant without anyone noticing.
//
// The two STATE shots are the exception and are shown in both arms — see _stripGuideArm. The arms
// differ in whether each ACTION can be checked, not in whether the outcome is known.
let showShots = true;

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function load() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id') || '';
  const armName = params.get('arm') === 'nongrounding' ? 'nongrounding' : 'grounding';
  showShots = armName !== 'nongrounding';
  if (!showShots) document.body.classList.add('tv-nogrounding');

  let record = null;
  try {
    const data = await chrome.storage.local.get(TRAJECTORY_STORE_KEY);
    record = (data[TRAJECTORY_STORE_KEY] || {})[id] || null;
  } catch (e) {
    record = null;
  }
  if (!record) {
    els.goal.textContent = 'This task could not be loaded.';
    return;
  }

  // No cross-arm fallback. Showing the grounded trajectory to a non-grounded participant because
  // their arm was never recorded does not degrade gracefully — it hands them the exact thing the
  // arm exists to withhold, and nothing downstream would ever say so.
  //
  // Deriving it is a different matter: _stripGuideArm is the definition of the non-grounded arm,
  // not a substitute for it, so an unstripped trajectory shows text rather than an apology.
  arm = record.arms?.[armName] || null;
  if (!arm && armName === 'nongrounding' && record.arms?.grounding && typeof window._stripGuideArm === 'function') {
    arm = window._stripGuideArm(record.arms.grounding);
  }
  els.goal.textContent = record.goal || record.title || '';
  if (!arm) {
    els.stage.innerHTML = '<div class="tv-empty">This task has no trajectory recorded for this condition.</div>';
    return;
  }

  const n = (arm.steps || []).length;
  els.count.textContent = `${n} step${n === 1 ? '' : 's'}`;
  render();
  bindHints();
  bindStates();
  bindPreviews();
}

/** The ⓘ toggles. Bound in both arms — knowing what a section is called is not grounding. */
function bindHints() {
  els.stage.addEventListener('click', (e) => {
    const btn = e.target.closest('.tv-info');
    if (!btn) return;
    const hint = btn.parentElement.querySelector('.tv-hint');
    if (!hint) return;
    hint.hidden = !hint.hidden;
    btn.setAttribute('aria-expanded', hint.hidden ? 'false' : 'true');
    btn.classList.toggle('is-open', !hint.hidden);
  });
}

/**
 * Click a state to see it. Bound in BOTH arms — unlike the step previews.
 *
 * The arms differ in whether each ACTION can be checked against the page it was taken on. The
 * before/after pair is the outcome, which both arms are asked to judge; withholding it from one of
 * them would make the condition about who was told whether the task succeeded.
 */
function bindStates() {
  els.stage.addEventListener('click', (e) => {
    const btn = e.target.closest('.tv-state-btn');
    if (!btn) return;
    const state = btn.dataset.state === 'initial' ? arm.initial_state : arm.final_state;
    if (!state?.screenshot) return;
    openLightbox({
      shot: state.screenshot,
      title: btn.dataset.state === 'initial' ? 'Before the agent started' : 'After the agent finished',
      note: state.url || '',
    });
  });
}

/**
 * The two page states, as one section above the journey. Shown in both arms.
 *
 * Their own section rather than two pictures bracketing the steps: they are not steps and they are
 * not evidence, they are the pair a participant compares to answer "did this actually get done?".
 * Side by side and openable in either order, that comparison is one click each; spread top and
 * bottom of a long page, it is a scroll and a memory test.
 *
 * A state with no screenshot still renders, disabled and saying so. Rendering nothing is how this
 * looked for a run that predated the bookends — indistinguishable from the feature not existing.
 */
function statesSection() {
  const cell = (state, kicker, caption, key) => {
    const has = !!state?.screenshot;
    return `
      <button type="button" class="tv-state-btn${has ? '' : ' is-empty'}" data-state="${key}"${has ? '' : ' disabled'}>
        <span class="tv-state-kicker">${esc(kicker)}</span>
        <span class="tv-state-cap">${esc(caption)}</span>
        <span class="tv-state-hint">${has ? 'Click to view' : 'Not recorded for this run'}</span>
      </button>`;
  };
  return `
    ${sectionTitle('The page before and after', 'The page as it was before the agent started, and as it was left once it stopped. Comparing the two is the quickest way to see whether the task actually got done.')}
    <div class="tv-states">
      ${cell(arm.initial_state, 'Before', 'The page before the agent started', 'initial')}
      ${cell(arm.final_state, 'After', 'The page once the agent finished', 'final')}
    </div>`;
}

/**
 * Text with each [ev:key] marker turned into a numbered chip. Used for the answer AND the trail's
 * summary, since either can cite evidence and a raw "[ev:54]" in prose is worse than no marker.
 *
 * Ported from _studyGuideAnswerHtml (sidepanel/study.js), where it used to run in the panel. The
 * chips are what tie a claim to the thing backing it — "added a Navel Orange to the cart [1]" — and
 * they carry the same hover/click gestures as everything else on this page.
 */
function chipify(html) {
  const byKey = new Map();
  (arm.answer_evidence || []).forEach(ev => {
    if (ev?.key) byKey.set(String(ev.key).trim().toLowerCase(), ev);
  });
  let shown = 0;
  return String(html || '').replace(/\[ev:\s*([^\]]+)\]/gi, (match, rawKey) => {
    const hit = byKey.get(String(rawKey).trim().toLowerCase());
    // A marker whose evidence did not survive is dropped rather than shown as raw text.
    if (!hit) return '';
    shown++;
    return `<button type="button" class="tv-chip" data-ev-key="${esc(hit.key)}" title="See what this rests on">${shown}</button>`;
  });
}

/**
 * Underline the phrases that rest on something, in place.
 *
 * A port of _answerLinkedSummaryHtml (sidepanel/panel.js): each segment names a phrase copied
 * verbatim out of the text, so it is located by substring and wrapped where it sits. The underline
 * is the part a trailing number cannot do — it says WHICH WORDS the evidence backs, so a claim and
 * its proof stay attached instead of being a sentence and a footnote.
 *
 * Overlapping segments are dropped rather than nested: two underlines fighting over the same words
 * would break the text into pieces that read as neither phrase.
 */
function linkPhrases(text) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  const ranges = [];
  (arm.answer_segments || []).forEach(seg => {
    const phrase = String(seg?.phrase || '').trim();
    if (!phrase) return;
    const start = lower.indexOf(phrase.toLowerCase());
    if (start < 0) return;                       // the answer was edited out from under the segment
    const end = start + phrase.length;
    if (ranges.some(r => start < r.end && end > r.start)) return;
    if (!segmentHasTarget(seg)) return;          // nothing to open: leave it as prose
    ranges.push({ start, end, seg });
  });
  if (!ranges.length) return esc(raw);

  ranges.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  ranges.forEach(({ start, end, seg }) => {
    out += esc(raw.slice(cursor, start));
    const attr = seg.key
      ? ` data-ev-key="${esc(seg.key)}"`
      : ` data-ev-step="${esc(String(seg.step))}"`;
    out += `<span class="tv-ref"${attr} title="${esc(seg.note || 'See what this rests on')}">${esc(raw.slice(start, end))}</span>`;
    cursor = end;
  });
  return out + esc(raw.slice(cursor));
}

/** Whether a segment leads anywhere — evidence by key, or a step with a picture. */
function segmentHasTarget(seg) {
  if (seg?.key) {
    return (arm.answer_evidence || []).some(ev =>
      String(ev.key || '').trim().toLowerCase() === String(seg.key).trim().toLowerCase() && ev.screenshot);
  }
  return milestoneHasShot(seg?.step);
}

/** Both passes over one piece of prose: underline the linked phrases, then number the markers. */
function richText(text) {
  if (!showShots) return esc(text || '');
  return chipify(linkPhrases(text));
}

/**
 * A section heading with a hint folded away behind an ⓘ.
 *
 * Collapsed by default and on every render: "agent answer", "reasoning trail" and "view journey" are
 * this product's words, not everyone's, and a participant who has never seen PageGuide is guessing
 * at the difference between the answer and the trail. Spelling it out inline would put three
 * paragraphs of instruction above the material they were brought here to read, so the explanation
 * waits until it is asked for.
 */
function sectionTitle(text, hint) {
  return `
    <div class="tv-section-title">
      <span>${esc(text)}</span>
      <button type="button" class="tv-info" data-hint aria-expanded="false" aria-label="What is this?">i</button>
      <div class="tv-hint" hidden>${esc(hint)}</div>
    </div>`;
}

function render() {
  const steps = arm.steps || [];
  const milestones = (arm.trail?.milestones || []);

  els.stage.innerHTML = `
    <div class="tv-col">
      ${statesSection()}

      ${sectionTitle('View Journey', showShots
        ? 'Every action the agent took, in the order it took them. Hover a step to see the page it was looking at when it acted; click for a full-size view.'
        : 'Every action the agent took, in the order it took them.')}

      <details class="tv-journey" open>
        <summary class="tv-journey-summary">The steps</summary>
        <div class="tv-journey-list">
          ${steps.map(step => {
            const live = showShots && !!step.screenshot;
            return `
            <div class="tv-journey-row${live ? ' is-shot' : ''}"${live ? ` data-step="${esc(String(step.n))}"` : ''}>
              <span class="tv-dot"></span>
              <span class="tv-journey-text"><b>${esc(String(step.n))}</b> ${esc(step.instruction || '')}</span>
              ${live ? '<span class="tv-peek" aria-hidden="true">⌕</span>' : ''}
            </div>`;
          }).join('')}
          ${showShots && steps.length && !steps.some(st => st.screenshot) ? `
            <p class="tv-warn">No step screenshots were saved with this trajectory, so there is nothing to preview. Re-capture it from the run to add them.</p>` : ''}
        </div>
      </details>

      ${sectionTitle('Agent answer', showShots
        ? 'What the agent reported back when it finished — the claim you are being asked to judge. A numbered chip marks a claim the agent backed with something it saw; hover it to see what.'
        : 'What the agent reported back when it finished — the claim you are being asked to judge.')}
      <div class="tv-answer">${richText(arm.answer)}</div>

      ${(arm.trail?.summary || milestones.length) ? `
        ${sectionTitle('Reasoning trail', 'The agent\'s own account of what it did and why, written after the run. It describes the same steps as the journey above, in the agent\'s words rather than as actions.')}
        <div class="tv-trail">
          ${arm.trail?.summary ? `<p class="tv-trail-summary">${richText(arm.trail.summary)}</p>` : ''}
          ${milestones.map(m => {
            const live = showShots && milestoneHasShot(m.step);
            return `
            <div class="tv-journey-row${live ? ' is-shot' : ''}"${live ? ` data-ev-step="${esc(String(m.step))}"` : ''}>
              <span class="tv-dot"></span>
              <span class="tv-journey-text"><b>${esc(String(m.step ?? ''))}</b> ${esc(m.text || '')}</span>
              ${live ? '<span class="tv-peek" aria-hidden="true">⌕</span>' : ''}
            </div>`;
          }).join('')}
        </div>` : ''}
    </div>`;
}

/** The step that a number refers to, if the trajectory has it. */
function stepAt(n) {
  return (arm.steps || []).find(st => Number(st.n) === Number(n)) || null;
}

/**
 * What a hovered row, chip or milestone should show.
 *
 * A milestone resolves to its step's own picture when no saved evidence names that step — which is
 * the normal case, since the answer's evidence clusters on the finish step while the trail narrates
 * every step. Matching evidence only was why hovering "Clicked the globe icon" showed nothing at
 * all: a wired row that silently does nothing reads as broken, not as empty.
 */
function previewFor(el) {
  if (el.dataset.step != null) {
    const step = stepAt(el.dataset.step);
    if (!step?.screenshot) return null;
    return { shot: step.screenshot, title: `Step ${step.n}`, note: step.instruction || '', url: step.url || '' };
  }

  const items = arm.answer_evidence || [];
  if (el.dataset.evKey != null) {
    const hit = items.find(ev => String(ev.key || '').trim().toLowerCase() === String(el.dataset.evKey).trim().toLowerCase());
    if (!hit?.screenshot) return null;
    return { shot: hit.screenshot, title: hit.step != null ? `Step ${hit.step}` : 'Evidence', note: hit.note || hit.key || '', url: '' };
  }

  const n = el.dataset.evStep;
  const evidence = items.find(ev => Number(ev.step) === Number(n) && ev.screenshot);
  if (evidence) {
    return { shot: evidence.screenshot, title: `Step ${n}`, note: evidence.note || evidence.key || '', url: '' };
  }
  const step = stepAt(n);
  if (!step?.screenshot) return null;
  return { shot: step.screenshot, title: `Step ${step.n}`, note: step.instruction || '', url: step.url || '' };
}

/** Whether a milestone has anything to show — evidence naming its step, or the step's own picture. */
function milestoneHasShot(step) {
  if (step == null) return false;
  const named = (arm.answer_evidence || []).some(ev => Number(ev.step) === Number(step) && ev.screenshot);
  return named || !!stepAt(step)?.screenshot;
}

/**
 * Hover for the screenshot, click it for the big one — the live run's two gestures.
 *
 * The hide is DELAYED and cancellable, exactly as _scheduleGoalPreviewHide does in the panel. The
 * click target lives inside the card, so a card that closed the moment the pointer left the row
 * would make the second gesture unreachable: you would watch the thing you were trying to click
 * disappear as you moved towards it.
 */
function bindPreviews() {
  if (!showShots) return;   // no card, no lightbox, nothing to click: that is the arm.
  let hideTimer = null;
  const cancelHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
  const hideNow = () => { cancelHide(); document.getElementById('tv-pop')?.remove(); };
  const scheduleHide = () => { cancelHide(); hideTimer = setTimeout(hideNow, 220); };

  els.stage.addEventListener('mouseover', (e) => {
    const anchor = e.target.closest('[data-step], [data-ev-key], [data-ev-step]');
    if (!anchor) { if (!e.target.closest('#tv-pop')) scheduleHide(); return; }
    cancelHide();
    if (document.getElementById('tv-pop')?.dataset.for === anchorKey(anchor)) return;
    const item = previewFor(anchor);
    if (!item) return;
    hideNow();

    const pop = document.createElement('div');
    pop.id = 'tv-pop';
    pop.className = 'tv-pop';
    pop.dataset.for = anchorKey(anchor);
    pop.innerHTML = `
      <img class="tv-pop-shot" src="data:image/jpeg;base64,${item.shot}" alt="${esc(item.title)}" title="Click for a bigger view">
      <div class="tv-pop-title">${esc(item.title)}</div>
      <div class="tv-pop-note">${esc(item.note)}</div>
      ${item.url ? `<div class="tv-step-url">${esc(item.url)}</div>` : ''}`;
    pop.addEventListener('mouseenter', cancelHide);
    pop.addEventListener('mouseleave', scheduleHide);
    pop.addEventListener('click', (ev) => {
      if (ev.target.closest('.tv-pop-shot')) openLightbox(item);
    });

    document.body.appendChild(pop);
    position(pop, anchor);
  });

  els.stage.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-step], [data-ev-key], [data-ev-step]')) scheduleHide();
  });

  // Clicking the row itself opens the big view too — the card is a preview, not a toll gate.
  els.stage.addEventListener('click', (e) => {
    const anchor = e.target.closest('[data-step], [data-ev-key], [data-ev-step]');
    if (!anchor) return;
    const item = previewFor(anchor);
    if (item) { hideNow(); openLightbox(item); }
  });
}

function anchorKey(el) {
  return el.dataset.step != null ? `s${el.dataset.step}`
    : el.dataset.evKey != null ? `k${el.dataset.evKey}` : `e${el.dataset.evStep}`;
}

/** Sit under the row, clamped to the viewport — the card is taller than most rows have room for. */
function position(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const box = pop.getBoundingClientRect();
  const top = (r.bottom + box.height + 12 > window.innerHeight && r.top - box.height - 8 > 0)
    ? r.top - box.height - 8
    : r.bottom + 8;
  pop.style.top = `${Math.max(8, top)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - box.width - 8))}px`;
}

/** The full-size view. Same id and close behaviour as the panel's lightbox. */
function openLightbox(item) {
  document.getElementById('pageguide-memory-shot-lightbox')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'pageguide-memory-shot-lightbox';
  overlay.className = 'tv-lightbox';
  overlay.innerHTML = `
    <div class="tv-lightbox-dialog" role="dialog" aria-modal="true" aria-label="${esc(item.title)}">
      <div class="tv-lightbox-head">
        <span>${esc(item.title)}</span>
        <button type="button" class="tv-lightbox-close" aria-label="Close">×</button>
      </div>
      <img src="data:image/jpeg;base64,${item.shot}" alt="${esc(item.title)}">
      ${item.note ? `<div class="tv-lightbox-note">${esc(item.note)}</div>` : ''}
    </div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.tv-lightbox-close')) overlay.remove();
  });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
  });
  document.body.appendChild(overlay);
}

load();
