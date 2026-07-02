# Calling embeddings reliably during eval + live runs — hard-won notes

_Not committed. Working notes from debugging "Embedding request returned no response
(service worker unavailable) … grounding_similarity_unavailable:no_response"._

## TL;DR
- **Do NOT route embeddings through the MV3 service worker during an active guide.** During a
  running guide the SW does **not** reliably receive `chrome.runtime.sendMessage({action:'callEmbed'})`
  — the message never reaches the SW handler at all (proven with a durable SW-side trace:
  `embedTrace = 0` while the same run happily processed `callLLMWithImages`). A dedicated
  `chrome.runtime.connect` port did **not** help either — the port `postMessage` also never
  reached the SW.
- **Fetch embeddings directly from the content script.** The content script is alive and
  running the guide; it can `fetch()` the embeddings endpoint itself. With `host_permissions:
  ["<all_urls>"]` that fetch is exempt from the page's CSP, so it works across sites. This is
  the only transport that was reliable every step. (Fallback to the SW `sendMessage` + the
  Python backfill for safety, but the direct fetch is what actually works live.)

## The symptom
`content/tasks/guidev2.js` computes `element_step_similarity = cosine(instruction, elementText)`
before applying each action. The embed request kept resolving `undefined`, which the code maps
to `reason:'no_response'` → `grounding_similarity_unavailable`. The grounding warning could
therefore never fire, and every step's live grounding score was null.

## What was NOT the cause (each cost real time to rule out)
1. **The model id.** `openai/text-embedding-ada-002` *is* served by OpenRouter (curl → HTTP 200
   with vectors), even though it's absent from the public "embedding models" page. Don't trust
   the docs page; test the actual endpoint with the actual key.
2. **A cold/idle service worker.** Playwright's CDP connection keeps the MV3 SW alive, so idle
   eviction doesn't happen under the eval harness. A 35 s idle test still returned embeddings.
3. **Concurrency of embed calls among themselves.** Serializing + memoizing the embeds (one in
   flight at a time, cache by text) made a 12-way concurrent burst succeed in isolation — but
   did **not** fix the live guide. Worth keeping for efficiency, not a fix on its own.
4. **A stale/duplicated SW file or a second `onMessage` listener.** Verified single handler,
   single definition, manifest points at the real file, no build step.

## The actual cause
During a live guide the content script fires a lot of SW traffic in a tight window
(`captureScreenshot` with image data, `callLLMWithImages` with large base64, `guideStepRecord`,
`guidanceV2_setState`, typing toggles). In that environment the SW **receives `callLLM*` but
not `callEmbed`** — the embed messages are dropped before reaching any SW `onMessage` /
port `onMessage` handler. `callLLM` works because the whole guide loop is built around it and
its timing; the embed is the odd one out. I could reproduce it deterministically but never fully
explained the asymmetry at the Chrome level — which is exactly why the pragmatic fix is to stop
depending on the SW for this at all.

## The reliable recipe
1. **Primary: direct content-script fetch.** Read `provider` + key from `chrome.storage.sync`,
   `fetch(endpoint, { model, input })`, parse `data[].embedding`. Return `{embeddings}` /
   `{error}`, and return `undefined` on a thrown fetch so callers can fall back. See
   `_gv2DirectEmbed` in `content/tasks/guidev2.js`.
2. **Serialize + memoize.** One request in flight at a time (a `Promise` chain) and a
   `Map<text, vector>` cache — embeddings are a pure function of the text, and the same
   instruction is embedded ~3×/step (element-step sim, goal relevance, mechanical confidence).
3. **Keep short timeouts on any SW fallback.** A 20 s port/sendMessage timeout will *stall the
   whole guide* (the embed is awaited before the action), blowing the idle timeout and
   producing "NO STEPS RECORDED". Use ~6 s and few attempts. This bit me: adding a slow port
   transport turned a 3-step run into a 0-step run.
4. **Backfill is the safety net, not the mechanism.** `eval_tool/step_confidence.py:
   backfill_element_step_similarity` recomputes `element_step_similarity` offline (sequential,
   reliable) for any step the live path missed. Great for the *scored* metric; it can't drive a
   *live* in-step warning, so it isn't a substitute for a working live embed.

## How to debug this class of problem fast
- **Get SW-side ground truth.** Page console + `sendMessage` return value tell you the content
  side only. Write a durable trace from inside the SW to a `chrome.storage.local` key the
  runner does **not** clear (NOT `debugPrompts` — the runner wipes that on task start and the
  guide wipes it on `clearState`). Read it from an extension page while the context is still
  open. This is what finally proved the message never arrives.
- **Reproduce in isolation first, then in the real runner.** An isolated harness that loads the
  extension and calls the embed directly (extension page + content script, warm + idle +
  concurrent + while-an-LLM-is-in-flight) will *pass* — which is itself the clue that the real
  guide's message flood is the differentiator. Then drive one real task through
  `PlaywrightGuideRunner` to reproduce faithfully.
- **Watch for `asyncio.gather(..., return_exceptions=True)`** (runner `run()`): it swallows
  worker exceptions, so a broken run looks like "did nothing / exit 0". Call `_run_in_browser`
  (or the task path) directly when diagnosing so errors surface.
- **`chrome.runtime.sendMessage` resolving `undefined`** (not rejecting) means *no listener
  kept the channel open / responded* — i.e. delivery/listener problem, not a thrown error.
  Rejections (`Extension context invalidated`, `message channel closed`) are a different class
  and surface as `{error}` via `safeSendMessage`.

## Eval-specific gotchas
- Runner loads the extension fresh from `REPO_ROOT` via `--load-extension`, so source edits
  apply automatically; no reload needed. (Manual Chrome testing DOES need a `chrome://extensions`
  reload after SW changes.)
- Default eval mode is **headful** (`PAGEGUIDE_EVAL_HEADLESS=1` to opt into headless). MV3
  extensions are flaky in headless; prefer headful for repro.
- Content-script fetch reliability depends on `host_permissions` covering the embed host.
  `<all_urls>` is present, which is why the direct fetch bypasses page CSP. If that's ever
  narrowed, add `https://openrouter.ai/*` + `https://api.openai.com/*` explicitly.
