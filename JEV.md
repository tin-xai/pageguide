# Jev (TypeSafe System One) integration — branch `jev-integration`

Context notes from the session that built this branch (2026-09-21), so the next session can pick up
without re-deriving it.

## What Jev is

- TypeSafe's "System One" decision model. Text-only (no images), ~100–300 ms, calibrated probabilities.
- One HTTP call: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`,
  body `{ state, model: "jev-latest", questions }`.
- Three question types: `choice` (pick one option from a `criteria` map, ≤255 options), `score`
  (ordered levels), `noul` (probability that a yes/no is yes). Each `choice` answer returns
  `{choice, confidence, probabilities}`. `confidence` is the spread of `probabilities`, not the top
  probability.
- Ask several questions per request; they run in parallel and barely add latency.
- Docs index: https://docs.typesafe.ai/llms.txt · JS SDK: `@typesafe-ai/sdk` (not used; plain fetch).
- Reference use in browser agents: https://github.com/browser-use/jev-ultrafast (Python) — per step,
  one Jev call picks the operation and the target element; a small LLM only writes typed text.

## Why it fits PageGuide

Jev cannot replace the Guide planner (it never writes instructions and cannot see screenshots). It
fits the *narrow decisions* around it, where a generative LLM was overkill:

| Layer | Decision | Before | Now |
|---|---|---|---|
| Router | which handler (guide/hide/image_ask/pdf_ask/ask) | LLM + JSON parse | Jev Choice, LLM fallback |
| Intelligence | which tutorial matches the query | LLM + JSON parse | Jev Choice + `none`, LLM fallback |
| Intelligence | which element a step means (when index/text fail) | step had no target | Jev Choice over page index (opt-in) |

Every Jev path falls back to the existing LLM path on: no key, toggle off, HTTP/network error,
`none`, or low confidence. Jev can only make things faster; it must never be why a feature breaks.

## Code map

- `background/service-worker.js` — `JEV` config, `readJevSettings()`, `callJev(state, questions)`,
  message actions `callJev` and `getJevSettings` (the latter never returns the key, only `hasKey`).
- `content/prompts.js` — `PROMPTS.JEV_ROUTER_CRITERIA` (keep in sync with `PROMPTS.ROUTER`).
- `content/functions/main_router.js` — `routeQueryWithJev()`, `getJevSettings()` (5 s cache),
  `JEV_ROUTER_MIN_CONFIDENCE = 0.4`; `routeQuery(query, ctx)` now takes `{hasImage, isPdf}`;
  results carry `router: 'jev' | 'llm'`.
- `content/tasks/guidev2.js` — `_gv2JevPickTutorial()` (called first by `_gv2LlmPickTutorial`),
  `gv2JevGroundElement(step)` + `_gv2JevGroundCandidates()`, `g._lastIndexText` stash in
  `gv2GenerateNextStep`, fallback hook in `gv2ProcessResponse` where `idxToUse`/`resolvedEl` resolve.
- `options/options.html|js` — "⚡ Jev (TypeSafe)" section: `typesafeApiKey`, `jevModel`,
  `jevRouterEnabled` (default on), `jevGroundingEnabled` (default off), `testJev()`.
- `e2e-tests/jev_router_eval.mjs` — offline router eval on 23 labelled queries.
  (`scripts/` is gitignored, which is why it lives in `e2e-tests/`.)

## Settings keys (chrome.storage.sync)

`typesafeApiKey`, `jevModel`, `jevRouterEnabled`, `jevGroundingEnabled`.
Optional build-time default: `CONFIG_KEYS.TYPESAFE_KEY`.

## Not yet verified — do this first

No TypeSafe key was available in the session, so nothing has hit the live API. Only `node --check`
and manifest validation ran.

1. `TYPESAFE_API_KEY=... node e2e-tests/jev_router_eval.mjs` — check accuracy and the
   `defer→LLM` column; tune `JEV_ROUTER_MIN_CONFIDENCE` from it.
2. Load the extension, Settings → Jev → paste key → "Test & Save Jev".
3. Run a few queries; console shows `⚡ Jev routed to: …` or `🎯 Jev not confident enough`.
4. Turn on grounding and run a Guide task on a page where the planner's index goes stale;
   look for `⚡ Jev grounded … → [idx]`.

## Ideas not built

- Jev `noul` for `VISION_ROUTER` ("does this question need a screenshot?").
- Jev `score` for low-confidence action gating in Guide (`_gv2LowConfidenceActionThreshold`).
- Fan-out: ask router + "needs vision" + "is destructive" in one call.
- Cost ledger entry for Jev calls (`usage.input_tokens`/`output_tokens` are returned; $42 / 1B input tokens).
