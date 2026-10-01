// PageGuide — LLM-as-a-judge for Model Comparison
// ===============================================
// Scores one model-performance run against the annotation run of the same task (the ground truth,
// as the annotators graded it). Pure: the prompt, the parser and the arithmetic live here so
// e2e-tests/unit/logic.test.js can pin them; study.js does the fetching and the rendering.
//
// THE PROMPT IS HERE — buildJudgeSystemPrompt / buildJudgeUserPrompt below. Edit it here and bump
// JUDGE_PROMPT_VERSION so old judgments (which record the version) can be told from new ones.
//
// METRICS, per (ground truth, run) pair:
//   answer_correct — does the run's final answer state the same result as the ground-truth answer?
//   evidence precision / recall / F1 — the judge pairs evidence items by the FACT they show, not by
//     key name: recall = ground-truth items the run also evidenced / all ground-truth items;
//     precision = run items that match a ground-truth item / all run items.
// The ground truth's evidence is the baseline's items the annotators marked correct & relevant
// (majority of the annotators who graded it); with no grades yet, every baseline item counts.
//
// The judge reads text only — answers plus each evidence item's key and note (what the agent said
// the crop shows). It does not see the crops. That is deliberate for now: it keeps the judge cheap
// and the same for every model, and the annotators have already looked at the pictures.

const JUDGE_PROMPT_VERSION = 'judge-v1';

/** Judge models offered in the Model Comparison screen. provider matches the Options page. */
const JUDGE_MODELS = [
  { provider: 'openrouter', model: 'google/gemini-3.1-pro-preview' },   // default
  { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' },
  { provider: 'openrouter', model: 'anthropic/claude-opus-4.5' },
  { provider: 'openrouter', model: 'openai/gpt-5.2' },
  { provider: 'openrouter', model: 'openai/gpt-4o-2024-11-20' },
  { provider: 'openrouter', model: 'google/gemini-2.5-flash' },
  { provider: 'gemini', model: 'gemini-2.5-flash' },
  // A second opinion straight from OpenAI (needs the OpenAI key from Options, or the field in the
  // Model Comparison judge bar). gpt-4o is the cheap, capable default there.
  { provider: 'openai', model: 'gpt-4o' },
  { provider: 'openai', model: 'gpt-4o-mini' },
];

/** Judgments are kept per judge: "<baseline id>|<run id>|<judge model>". */
function judgmentKey(baselineId, runId, judgeModel) {
  return `${baselineId}|${runId}|${judgeModel}`;
}

/**
 * Re-key a stored judgments map so every entry is per judge. Early builds stored one judgment per
 * pair ("<baseline>|<run>"), overwriting when the judge changed; those move under the judge model
 * they record. Pure; returns a new map.
 */
function migrateJudgments(stored) {
  const out = {};
  Object.entries(stored && typeof stored === 'object' ? stored : {}).forEach(([k, j]) => {
    if (!j || typeof j !== 'object') return;
    const parts = String(k).split('|');
    const key = parts.length >= 3 ? k : judgmentKey(j.baseline_id || parts[0], j.run_id || parts[1], j.judge_model || 'unknown');
    out[key] = j;
  });
  return out;
}

/**
 * How two judges agree on the same pairs: answer verdict agreement and mean |ΔF1|. Pairs are
 * matched by baseline + run. Pure.
 */
function judgeAgreement(judgmentsA, judgmentsB) {
  const byPair = (list) => new Map((Array.isArray(list) ? list : []).filter(Boolean).map(j => [`${j.baseline_id}|${j.run_id}`, j]));
  const a = byPair(judgmentsA), b = byPair(judgmentsB);
  const shared = [...a.keys()].filter(k => b.has(k));
  const answered = shared.filter(k => a.get(k).answer_correct !== null && b.get(k).answer_correct !== null && a.get(k).answer_correct !== undefined && b.get(k).answer_correct !== undefined);
  const agree = answered.filter(k => a.get(k).answer_correct === b.get(k).answer_correct).length;
  const dF1 = shared.length ? shared.reduce((acc, k) => acc + Math.abs((Number(a.get(k).f1) || 0) - (Number(b.get(k).f1) || 0)), 0) / shared.length : null;
  return { pairs: shared.length, answer_compared: answered.length, answer_agree: agree,
    answer_agreement: answered.length ? agree / answered.length : null, mean_abs_f1_diff: dF1,
    disagreeing_pairs: answered.filter(k => a.get(k).answer_correct !== b.get(k).answer_correct) };
}

/** How many judge calls run at once for "Judge all" / "Re-judge all". */
const JUDGE_CONCURRENCY = 4;

/**
 * Run `worker` over `items` with at most `limit` in flight. Pure scheduling; each item's failure is
 * reported through `onDone(item, error)` and never stops the rest. Results come back in input order.
 */
async function runWithConcurrency(items, limit, worker, onDone) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let next = 0;
  const lane = async () => {
    while (next < list.length) {
      const i = next++;
      try { results[i] = { ok: true, value: await worker(list[i], i) }; }
      catch (e) { results[i] = { ok: false, error: e }; }
      if (onDone) { try { onDone(list[i], results[i]); } catch (e) { /* a progress callback must not stop the run */ } }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit || 1, list.length || 1)) }, lane));
  return results;
}

function buildJudgeSystemPrompt() {
  return `You are a strict grader comparing two runs of a web agent on the same task.

You are given:
- TASK: what the agent was asked to do.
- GROUND TRUTH: the reference run. Its final answer is correct, and its evidence items were checked by human annotators as correct and relevant.
- CANDIDATE: another model's run of the same task — its final answer and its evidence items.

An evidence item is a fact the agent captured from the page (key + note describing what the capture shows).

Judge two things.

1. ANSWER: Is the CANDIDATE's final answer correct, taking GROUND TRUTH as the reference? Correct means it states the same result(s) — same items, numbers, times, names — allowing different wording or order. Extra correct detail is fine. A missing required part, a different value, or a claim the ground truth contradicts makes it incorrect.

2. EVIDENCE MATCHING: Pair evidence items by the FACT they show, never by key name.
   - For each GROUND TRUTH item, name the one CANDIDATE item that shows the same fact (or null).
   - For each CANDIDATE item, name the one GROUND TRUTH item it corresponds to (or null). A candidate item that shows something true but not in the ground truth is unmatched (null).
   Be consistent: if gt "a" matches candidate "x", then candidate "x" matches gt "a".

Return ONLY this JSON, no prose:
{
  "answer_correct": true | false,
  "answer_reason": "one sentence",
  "gt_matches": [ { "key": "<ground truth key>", "candidate_key": "<candidate key or null>" } ],
  "candidate_matches": [ { "key": "<candidate key>", "gt_key": "<ground truth key or null>" } ]
}`;
}

/**
 * @param {object} input
 * @param {string} input.task
 * @param {{answer:string, evidence:Array<{key:string, note?:string}>}} input.groundTruth
 * @param {{answer:string, evidence:Array<{key:string, note?:string}>}} input.candidate
 * @param {string} [input.candidateModel]
 */
function buildJudgeUserPrompt(input) {
  const o = input || {};
  const list = (items) => {
    const arr = Array.isArray(items) ? items : [];
    return arr.length ? arr.map(e => `- ${e.key}: ${String(e.note || '').replace(/\s+/g, ' ').trim() || '(no note)'}`).join('\n') : '- (none)';
  };
  return `TASK:
${String(o.task || '').trim()}

GROUND TRUTH answer:
${String(o.groundTruth?.answer || '').trim() || '(none)'}

GROUND TRUTH evidence:
${list(o.groundTruth?.evidence)}

CANDIDATE${o.candidateModel ? ` (${o.candidateModel})` : ''} answer:
${String(o.candidate?.answer || '').trim() || '(none)'}

CANDIDATE evidence:
${list(o.candidate?.evidence)}

Return the JSON.`;
}

/** The judge's JSON, tolerant of fences and prose around it. null when there is no object. */
function parseJudgeResponse(text) {
  const str = String(text == null ? '' : text).trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  const m = str.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch (e) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const key = (v) => (v == null ? null : String(v).trim() || null);
  return {
    answer_correct: obj.answer_correct === true ? true : (obj.answer_correct === false ? false : null),
    answer_reason: String(obj.answer_reason || '').trim(),
    gt_matches: (Array.isArray(obj.gt_matches) ? obj.gt_matches : []).map(x => ({ key: key(x?.key), candidate_key: key(x?.candidate_key) })).filter(x => x.key),
    candidate_matches: (Array.isArray(obj.candidate_matches) ? obj.candidate_matches : []).map(x => ({ key: key(x?.key), gt_key: key(x?.gt_key) })).filter(x => x.key),
  };
}

/**
 * Precision / recall / F1 from the judge's pairing, computed against the REAL key lists (the judge
 * may invent or drop keys; only keys we actually showed it count). A ground-truth item is recalled
 * if either side of the pairing names it; a candidate item is precise if either side names it.
 */
function scoreJudgment(parsed, gtKeys, candidateKeys) {
  const gt = new Set((gtKeys || []).map(String));
  const cand = new Set((candidateKeys || []).map(String));
  const p = parsed || { gt_matches: [], candidate_matches: [] };
  const recalledGt = new Set();
  const preciseCand = new Set();
  (p.gt_matches || []).forEach(m => { if (gt.has(m.key) && m.candidate_key && cand.has(m.candidate_key)) { recalledGt.add(m.key); preciseCand.add(m.candidate_key); } });
  (p.candidate_matches || []).forEach(m => { if (cand.has(m.key) && m.gt_key && gt.has(m.gt_key)) { preciseCand.add(m.key); recalledGt.add(m.gt_key); } });
  const tp = recalledGt.size;                 // ground-truth facts the candidate evidenced
  const fn = gt.size - tp;
  const fp = cand.size - preciseCand.size;   // candidate items that match nothing
  const precision = cand.size ? preciseCand.size / cand.size : (gt.size ? 0 : 1);
  const recall = gt.size ? tp / gt.size : 1;
  const f1 = (precision + recall) ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, gt_count: gt.size, candidate_count: cand.size, precision, recall, f1,
    answer_correct: p.answer_correct === true ? true : (p.answer_correct === false ? false : null),
    unmatched_gt: [...gt].filter(k => !recalledGt.has(k)), unmatched_candidate: [...cand].filter(k => !preciseCand.has(k)) };
}

/**
 * The ground-truth evidence: baseline items the reference annotator marked correct. `verdicts` is
 * [{key, correct, annotator}] across annotators; with `annotator` given (default 'A') only that
 * annotator's verdicts count, falling back to the majority of everyone when that annotator has not
 * graded the run. Items nobody graded stay in when NO item was graded (no grades yet → everything
 * counts), and drop out once grading exists.
 */
function groundTruthEvidence(items, verdicts, annotator = 'A') {
  const list = (Array.isArray(items) ? items : []).filter(e => e && e.key);
  const all = (Array.isArray(verdicts) ? verdicts : []).filter(v => v && v.key && typeof v.correct === 'boolean');
  const mine = annotator ? all.filter(v => String(v.annotator || '') === String(annotator)) : [];
  const used = mine.length ? mine : all;
  const votes = new Map();
  used.forEach(v => {
    const t = votes.get(String(v.key)) || { yes: 0, no: 0 };
    v.correct ? t.yes++ : t.no++;
    votes.set(String(v.key), t);
  });
  if (!votes.size) return list;
  return list.filter(e => { const t = votes.get(String(e.key)); return t ? t.yes >= t.no : false; });
}

/**
 * PAGE LEVEL. A page is origin + path (query, hash and trailing slash dropped: Booking and Amazon
 * carry session junk in the query, and two crops from one results page are one page). Pure.
 */
function normalizePageUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch (e) { return raw.split('#')[0].split('?')[0].replace(/\/+$/, ''); }
}

/** Distinct pages a set of evidence items came from (items carry `url`). */
function evidencePages(items) {
  return [...new Set((Array.isArray(items) ? items : []).map(e => normalizePageUrl(e?.url)).filter(Boolean))];
}

/**
 * Page-level precision / recall / F1: the set of pages the candidate's evidence came from against
 * the set the ground truth's came from. Deterministic — no judge involved.
 */
function pageLevelScore(gtItems, candItems) {
  const gt = new Set(evidencePages(gtItems));
  const cand = new Set(evidencePages(candItems));
  const tp = [...cand].filter(p => gt.has(p)).length;
  const precision = cand.size ? tp / cand.size : (gt.size ? 0 : 1);
  const recall = gt.size ? tp / gt.size : 1;
  const f1 = (precision + recall) ? (2 * precision * recall) / (precision + recall) : 0;
  return { page_tp: tp, page_fp: cand.size - tp, page_fn: gt.size - tp, gt_pages: [...gt], candidate_pages: [...cand],
    page_precision: precision, page_recall: recall, page_f1: f1 };
}

/** Accuracy and mean / micro P-R-F1 over a set of scored judgments. */
function aggregateJudgments(scores) {
  const list = (Array.isArray(scores) ? scores : []).filter(Boolean);
  const judged = list.filter(s => s.answer_correct !== null && s.answer_correct !== undefined);
  const mean = (f) => list.length ? list.reduce((a, s) => a + (Number(s[f]) || 0), 0) / list.length : null;
  const tp = list.reduce((a, s) => a + (s.tp || 0), 0), fp = list.reduce((a, s) => a + (s.fp || 0), 0), fn = list.reduce((a, s) => a + (s.fn || 0), 0);
  const mp = (tp + fp) ? tp / (tp + fp) : null, mr = (tp + fn) ? tp / (tp + fn) : null;
  const paged = list.filter(s => s.page_precision != null);
  const pmean = (f) => paged.length ? paged.reduce((a, s) => a + (Number(s[f]) || 0), 0) / paged.length : null;
  return {
    page_runs: paged.length,
    mean_page_precision: pmean('page_precision'), mean_page_recall: pmean('page_recall'), mean_page_f1: pmean('page_f1'),
    runs: list.length,
    answer_correct: judged.filter(s => s.answer_correct === true).length,
    answer_judged: judged.length,
    answer_accuracy: judged.length ? judged.filter(s => s.answer_correct === true).length / judged.length : null,
    mean_precision: mean('precision'), mean_recall: mean('recall'), mean_f1: mean('f1'),
    micro_precision: mp, micro_recall: mr,
    micro_f1: (mp != null && mr != null && (mp + mr)) ? (2 * mp * mr) / (mp + mr) : null,
  };
}

if (typeof window !== 'undefined') {
  window.JUDGE_PROMPT_VERSION = JUDGE_PROMPT_VERSION;
  window.JUDGE_MODELS = JUDGE_MODELS;
  window.JUDGE_CONCURRENCY = JUDGE_CONCURRENCY;
  window.judgmentKey = judgmentKey;
  window.migrateJudgments = migrateJudgments;
  window.judgeAgreement = judgeAgreement;
  window.runWithConcurrency = runWithConcurrency;
  window.buildJudgeSystemPrompt = buildJudgeSystemPrompt;
  window.buildJudgeUserPrompt = buildJudgeUserPrompt;
  window.parseJudgeResponse = parseJudgeResponse;
  window.scoreJudgment = scoreJudgment;
  window.groundTruthEvidence = groundTruthEvidence;
  window.aggregateJudgments = aggregateJudgments;
  window.normalizePageUrl = normalizePageUrl;
  window.evidencePages = evidencePages;
  window.pageLevelScore = pageLevelScore;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { JUDGE_PROMPT_VERSION, JUDGE_MODELS, JUDGE_CONCURRENCY, runWithConcurrency, judgmentKey, migrateJudgments, judgeAgreement, buildJudgeSystemPrompt, buildJudgeUserPrompt, parseJudgeResponse, scoreJudgment, groundTruthEvidence, aggregateJudgments, normalizePageUrl, evidencePages, pageLevelScore };
}
