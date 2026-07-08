// PageGuide - LLM request builders
//
// Pure helpers (no chrome.* / network deps) for assembling provider requests so the
// system prompt is sent in a real `system` role, the user prompt is the `user` message,
// and any image stays appended last. Shared by every provider path in service-worker.js
// (loaded via importScripts) and unit-tested in e2e-tests/unit/logic.test.js.

/** The user prompt = the content of the last message (no folded-in instructions). */
function pgUserText(messages) {
  return (messages && messages.length > 0) ? messages[messages.length - 1].content : '';
}

/**
 * OpenAI-compatible chat messages: a `system` entry (when a system prompt is present)
 * followed by the `user` entry. `userContent` may be a plain string or an OpenAI content
 * array (e.g. [{type:'text'}, {type:'image_url'}]).
 */
function pgBuildOpenAIMessages(systemPrompt, userContent) {
  const out = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  out.push({ role: 'user', content: userContent });
  return out;
}

/** Gemini's native system field; undefined when there's no system prompt. */
function pgGeminiSystemInstruction(systemPrompt) {
  return systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined;
}

// Export for the jest (CommonJS) harness without breaking the service-worker global scope.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pgUserText, pgBuildOpenAIMessages, pgGeminiSystemInstruction };
}
