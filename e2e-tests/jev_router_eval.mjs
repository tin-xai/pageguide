#!/usr/bin/env node
// Evaluate Jev (TypeSafe System One) as PageGuide's query router, outside the extension.
//
//   TYPESAFE_API_KEY=... node e2e-tests/jev_router_eval.mjs
//
// Sends every labelled query below as one Choice question using the SAME criteria the extension
// uses (PROMPTS.JEV_ROUTER_CRITERIA from content/prompts.js) and reports accuracy, confidence and
// latency. The labelled set is the ROUTER prompt's own examples plus a few harder paraphrases.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) { console.error('Set TYPESAFE_API_KEY'); process.exit(1); }
const model = process.env.JEV_MODEL || 'jev-latest';
const MIN_CONF = 0.4; // JEV_ROUTER_MIN_CONFIDENCE in content/functions/main_router.js

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'content/prompts.js'), 'utf8') + '\nthis.PROMPTS = PROMPTS;', ctx);
const criteria = ctx.PROMPTS.JEV_ROUTER_CRITERIA;

const CASES = [
  ['How do I report this video?', 'guide'],
  ['Where can I change my password?', 'guide'],
  ['help me delete my account', 'guide'],
  ['how do I export this spreadsheet as a PDF?', 'guide'],
  ['walk me through turning on two-factor auth', 'guide'],
  ['Hide the ads on this page', 'hide'],
  ['remove the cookie banner', 'hide'],
  ['get rid of the recommended videos', 'hide'],
  ['I don\'t want to see comments', 'hide'],
  ['Find this product on the page', 'image_ask'],
  ['Where can I buy the item in my image?', 'image_ask'],
  ['Do they sell this?', 'image_ask'],
  ['is my upload anywhere on this page?', 'image_ask'],
  ['What does this PDF say about machine learning?', 'pdf_ask'],
  ['Summarize this document', 'pdf_ask'],
  ["What's on page 5?", 'pdf_ask'],
  ['find where the paper mentions the methodology', 'pdf_ask'],
  ['What is the price of this product?', 'ask'],
  ['Show me where the settings are', 'ask'],
  ['Summarize this page', 'ask'],
  ['What is the capital of France?', 'ask'],
  ['where is the login button?', 'ask'],
  ['what is the return policy?', 'ask'],
];

async function route(query) {
  const t0 = performance.now();
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: { user_query: query, has_uploaded_image: false, is_pdf_page: false },
      model,
      questions: { handler: { type: 'choice', instructions: 'Which handler should process this user query? Pick by what the user wants done, not by keywords.', criteria } }
    })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { ...data.answers.handler, ms: Math.round(performance.now() - t0), usage: data.usage, model: data.model };
}

let correct = 0, deferred = 0, totalMs = 0, tokens = 0;
const rows = [];
for (const [q, expected] of CASES) {
  const a = await route(q);
  const ok = a.choice === expected;
  const defer = a.confidence < MIN_CONF;
  if (ok) correct++;
  if (defer) deferred++;
  totalMs += a.ms; tokens += (a.usage?.input_tokens || 0) + (a.usage?.output_tokens || 0);
  rows.push({ query: q, expected, got: a.choice, conf: a.confidence.toFixed(2), ms: a.ms, note: defer ? 'defer→LLM' : (ok ? '' : 'WRONG') });
}
console.table(rows);
console.log(`model: ${rows.length ? (await route(CASES[0][0])).model : model}`);
console.log(`accuracy: ${correct}/${CASES.length}  deferred (<${MIN_CONF} conf): ${deferred}  mean latency: ${Math.round(totalMs / CASES.length)}ms  tokens: ${tokens}`);
