// XWebAgent - API Router (Main Entry Point)
// Routes queries to appropriate handlers: ask, guide, hide
/**
 * Safe wrapper for chrome.runtime.sendMessage
 * Handles common Chrome extension messaging errors gracefully
 * Includes timeout to prevent hanging on SPAs (X, ChatGPT, Claude, etc.)
 */
async function safeSendMessage(message, timeoutMs = 60000) {
  try {
    // Create a timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), timeoutMs);
    });
    
    // Race between the actual message and timeout
    const response = await Promise.race([
      chrome.runtime.sendMessage(message),
      timeoutPromise
    ]);
    
    return response;
  } catch (e) {
    const errorMsg = e.message || '';
    
    // Handle common Chrome extension errors
    if (errorMsg.includes('Extension context invalidated')) {
      return { error: '🔄 Extension was updated. Please refresh the page (F5).' };
    }
    if (errorMsg.includes('message channel closed') || 
        errorMsg.includes('Receiving end does not exist')) {
      return { error: '🔄 Connection lost. Please refresh the page (F5).' };
    }
    if (errorMsg.includes('timeout')) {
      return { error: '⏱️ Request timed out. Please try again.' };
    }
    
    // Return error instead of throwing to prevent unhandled rejections
    console.error('🤖 safeSendMessage error:', e);
    return { error: `Error: ${errorMsg || 'Unknown error'}` };
  }
}

/**
 * Route query using LLM-based coordinator
 * @param {string} query - User's query
 * @returns {Promise<{handler: string, confidence: number, reason: string}>}
 */
async function routeQuery(query) {
  console.log('🎯 Routing query:', query);
  
  try {
    // Use fast router LLM (Gemini 2.5 Flash) for quick classification
    const response = await safeSendMessage({
      action: 'callRouterLLM',
      systemPrompt: PROMPTS.ROUTER,
      messages: [{
        role: 'user',
        content: `Query: "${query}"\n\nClassify this query and return JSON only.`
      }]
    });
    
    if (response?.error) {
      console.warn('🎯 Router error, falling back to ask:', response.error);
      return { handler: 'ask', confidence: 0.5, reason: 'Router error, using default' };
    }
    
    if (response?.content) {
      // Parse JSON response
      let jsonStr = response.content.trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '');
      
      const match = jsonStr.match(/\{[\s\S]*\}/);
      if (match) jsonStr = match[0];
      
      const result = JSON.parse(jsonStr);
      console.log('🎯 Router decision:', result);
      
      return {
        handler: result.handler || 'ask',
        confidence: result.confidence || 0.5,
        reason: result.reason || ''
      };
    }
    
    return { handler: 'ask', confidence: 0.5, reason: 'No response from router' };
    
  } catch (e) {
    console.error('🎯 Router parse error:', e);
    return { handler: 'ask', confidence: 0.5, reason: 'Parse error, using default' };
  }
}

/**
 * Pure function: returns true if the query is a search/discovery intent
 * (e.g. "find me X", "search for X") where the user wants to navigate or
 * search to reach content, NOT locate something already on the current page.
 * Used as a heuristic safety override when the planner picks "find" incorrectly.
 * Exported for unit testing.
 * @param {string} query
 * @returns {boolean}
 */
function _isSearchIntentQuery(query) {
  if (!query) return false;
  // Matches: "find me X", "search for X", "look for X", "get me X",
  //          "show me a/an X", "go to X and find/search Y"
  return /\bfind me\b|\bsearch for\b|\blook for\b|\bget me\b|\bshow me an?\b|\bgo to .{1,40} and (find|search|look)\b/i.test(query);
}

/**
 * Pure function: returns true if the query clearly wants to hide/suppress
 * content on the current page using protection.js (ads, banners, sidebars, etc.).
 * Only matches UNAMBIGUOUS hide-DOM phrases — "remove/disable/turn off" are
 * intentionally excluded because they can refer to account actions or settings
 * (e.g. "remove my account" → guide, "disable notifications in settings" → guide).
 * Exported for unit testing.
 * @param {string} query
 * @returns {boolean}
 */
function _isHideIntentQuery(query) {
  if (!query) return false;
  // Matches: "hide X", "block X", "get rid of X", "suppress X",
  //          "make X go away/disappear", "no more X"
  return /\bhide\b|\bblock\b|\bget rid of\b|\bsuppress\b|\bmake .{1,30} (go away|disappear)\b|\bno more\b/i.test(query);
}

/**
 * Build a string summarising shared tab contexts for inclusion in the planner's pageHint.
 * Pure function — exported for unit testing.
 * @param {Array<{url: string, title: string, text: string}>} contexts
 * @returns {string}
 */
function _buildSharedTabsHint(contexts) {
  if (!contexts || contexts.length === 0) return '';
  return '\n\nShared tabs:\n' + contexts.map((t, i) =>
    `[Tab ${i + 1}] URL: ${t.url}\nTitle: ${t.title}\nSnippet: ${(t.text || '').slice(0, 200)}`
  ).join('\n\n');
}

/**
 * Smart handler that routes queries using the agentic planner + executor.
 * This is the main entry point for all user queries.
 * @param {string} query - User's query
 * @param {Array} history - Conversation history
 * @param {boolean} hasImage - Whether current message has an image attached
 * @param {boolean} hasImageInHistory - Whether any previous message had an image
 * @param {Array} sharedTabsContext - Page contexts from tabs the user chose to share
 */
async function handleSmartQuery(query, history = [], hasImage = false, hasImageInHistory = false, sharedTabsContext = []) {
  const imageAvailable = hasImage || hasImageInHistory || !!getUploadedImage?.();
  console.log('🤖 Agent: image available:', imageAvailable, '(current:', hasImage, ', history:', hasImageInHistory, ')');

  // Image bypass: current message has image → go directly to image_ask (skip planner)
  if (hasImage && typeof handleImageAsk === 'function') {
    console.log('🤖 Agent: current message has image, routing directly to image_ask');
    const result = await handleImageAsk(query);
    if (result) {
      result.routedTo = 'image_ask';
      result.routeConfidence = 1.0;
      result.routeReason = 'Image attached to current message';
      result.planSummary = 'Searching for your image on the page';
      result.planSteps = [{ tool: 'image_ask', reason: 'Image attached', ...result }];
      return result;
    }
    // Fall through if image_ask fails
  }

  // PDF bypass: PDF pages skip the planner (always pdf_ask)
  if (typeof isPdfPage === 'function' && isPdfPage()) {
    console.log('🤖 Agent: PDF page detected, routing directly to pdf_ask');
    if (typeof handlePdfAsk === 'function') {
      const result = await handlePdfAsk(query);
      if (result) {
        result.routedTo = 'pdf_ask';
        result.routeConfidence = 1.0;
        result.routeReason = 'PDF page detected';
        result.planSummary = 'Searching the PDF document';
        result.planSteps = [{ tool: 'pdf_ask', reason: 'PDF page', ...result }];
        return result;
      }
    }
    // Fall through if PDF handler returns null
  }

  // Build site context for the planner: URL + title + short page snippet.
  // URL and title are cheap and critical for intent disambiguation
  // (e.g. "find me black shoes size 6.5" means guide on amazon.com, find on a product page).
  let pageHint = '';
  try {
    const url = window.location.href || '';
    const title = document.title || '';
    const snippet = typeof getVisibleText === 'function'
      ? (getVisibleText(300) || '').slice(0, 300)
      : '';
    pageHint = `URL: ${url}\nTitle: ${title}\nPage snippet: ${snippet}`;
    pageHint += _buildSharedTabsHint(sharedTabsContext);
  } catch (e) { /* ignore */ }
  // Hint the planner that an image is available in history
  if (imageAvailable && !hasImage) {
    pageHint = `[User has an uploaded image in conversation]\n${pageHint}`;
  }

  // Plan the query
  const plan = await planQuery(query, pageHint);

  // Heuristic override 1: "hide X" / "remove X" / "block X" always means hide.
  // The planner can misroute these to guide or find; this override enforces the correct tool.
  if (plan.steps.length === 1 && plan.steps[0].tool !== 'hide' &&
      _isHideIntentQuery(query)) {
    console.log('🤖 Agent: heuristic override →hide for hide-intent query:', query);
    plan.steps[0].tool = 'hide';
    plan.steps[0].args = { filter: query };
    plan.steps[0].reason = 'Heuristic: hide/remove/block phrase overridden to hide';
  }

  // Heuristic override 2: "find me X" / "search for X" almost always means guide.
  // The planner can get confused when the page snippet shows product/content text,
  // causing it to assume the item is already on the page. This override corrects that.
  // Note: skip this override if override 1 already set tool to hide.
  if (plan.steps.length === 1 && plan.steps[0].tool === 'find' &&
      _isSearchIntentQuery(query)) {
    console.log('🤖 Agent: heuristic override find→guide for search-intent query:', query);
    plan.steps[0].tool = 'guide';
    plan.steps[0].args = { task: query };
    plan.steps[0].reason = 'Heuristic: search-intent phrase ("find me / search for / look for") overridden to guide';
  }

  // If planner chose image_ask but no image is available, override to find
  for (const step of plan.steps) {
    if (step.tool === 'image_ask' && !imageAvailable) {
      console.log('🤖 Agent: planner chose image_ask but no image available, switching to find');
      step.tool = 'find';
      step.reason = 'No image available, using find instead';
    }
  }

  // Expand "See more" / "Show more" ONLY for plans that include find or pdf_ask steps.
  // Skipped for guide/hide/answer/image_ask to avoid mutating the page unexpectedly.
  const shouldExpand = plan.steps.some(s => s.tool === 'find' || s.tool === 'pdf_ask');
  if (shouldExpand && typeof expandTruncatedContent === 'function') {
    await expandTruncatedContent();
  }

  // Execute the plan
  const result = await runAgentPlan(plan, query, history, hasImage, hasImageInHistory);

  // Ensure routedTo is set for the debug panel (backward compat)
  if (result && !result.routedTo) {
    result.routedTo = plan.steps.length > 1 ? 'agent' : (plan.steps[0]?.tool || 'find');
    result.routeConfidence = result.routeConfidence || 1.0;
    result.routeReason = result.routeReason || plan.planSummary || '';
  }

  return result;
}

// Export pure functions for unit testing (no-op in browser, consumed by Jest via window.eval)
if (typeof module !== 'undefined') {
  module.exports = { _buildSharedTabsHint };
}

console.log('🚀 api.js (router) loaded');
