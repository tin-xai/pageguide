// PageGuide - API Router (Main Entry Point)
// Routes queries to appropriate handlers: ask, guide, hide
/**
 * Safe wrapper for chrome.runtime.sendMessage
 * Handles common Chrome extension messaging errors gracefully
 * Includes timeout to prevent hanging on SPAs (X, ChatGPT, Claude, etc.)
 */
async function safeSendMessage(message, timeoutMs = 60000) {
  // Time agent "thinking" turns for the user study: the wall-clock of each planning LLM call.
  // Emitted to the study tracker (ignored there unless a study task is running). Router/embedding
  // calls are excluded so this reflects the guide agent's step reasoning.
  const _isAgentThink = message && (message.action === 'callLLM' || message.action === 'callLLMWithImages');
  const _thinkStart = _isAgentThink ? Date.now() : 0;

  // Stamp the guide session onto every LLM call, in ONE place. It is what ties a call's cost to the
  // journey that spent it (appendCostEntry, background/service-worker.js). Doing it here rather
  // than at the ~20 call sites that build a `metadata` block is not just less code — it is the only
  // version that stays true, since a new call site would otherwise be silently unattributed and its
  // cost would quietly vanish from the journey's total. A Find outside a guide run has no session;
  // those are attributed by debug-log position instead.
  if (_isAgentThink && typeof window !== 'undefined' && window._guidev2?.sessionId) {
    message = Object.assign({}, message, {
      metadata: Object.assign({ sessionId: window._guidev2.sessionId }, message.metadata || {})
    });
  }

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

    if (_isAgentThink) {
      try { chrome.runtime.sendMessage({ action: 'studyTracker_agentThink', durationMs: Date.now() - _thinkStart }); } catch (e2) {}
    }
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
 * Smart handler that routes queries using LLM coordinator
 * This is the main entry point for all user queries
 * @param {string} query - User's query
 * @param {Array} history - Conversation history
 * @param {boolean} hasImage - Whether current message has an image attached
 * @param {boolean} hasImageInHistory - Whether any previous message had an image
 * @param {string} forcedRoute - Whether a specific route is requested by user ('ask'|'hide'|'guide')
 * @param {string} cleanQuery - Query with any slash command stripped
 */
async function handleSmartQuery(query, history = [], hasImage = false, hasImageInHistory = false, forcedRoute = null, cleanQuery = null) {
  // expandTruncatedContent is called AFTER routing (below), only for non-guide modes.
  // Calling it before routing would auto-click "See more" / "More" buttons on
  // social sites (X, LinkedIn) before guidance even starts, mutating the page
  // and confusing the step generator.

  // Check if image is available (current or in history)
  const imageAvailable = hasImage || hasImageInHistory || !!getUploadedImage?.();
  console.log('🎯 Image available:', imageAvailable, '(current:', hasImage, ', history:', hasImageInHistory, ')');
  
  // Force route override from slash command if set
  let route = null;
  if (forcedRoute && ['ask', 'guide', 'hide'].includes(forcedRoute)) {
    route = {
      handler: forcedRoute,
      confidence: 1.0,
      reason: `User forced route via /${forcedRoute} command`
    };
    console.log(`🎯 Override routing to: ${route.handler} due to forced command`);
  } else {
    // Check if we're on a PDF page first (bypass router for PDF pages)
    if (typeof isPdfPage === 'function' && isPdfPage()) {
      console.log('🎯 PDF page detected, routing to pdf_ask');
      if (typeof handlePdfAsk === 'function') {
        const result = await handlePdfAsk(query);
        if (result) {
          result.routedTo = 'pdf_ask';
          result.routeConfidence = 1.0;
          result.routeReason = 'PDF page detected';
          return result;
        }
      }
      // Fall through to regular ask if pdf handler returns null
    }

    // Route the query using the LLM router. We ask the router even when an image
    // is attached — it decides guide vs. image_ask vs. ask from the query's intent.
    route = await routeQuery(query);
    console.log('🎯 LLM Routed to:', route.handler, `(${Math.round(route.confidence * 100)}% confident - ${route.reason})`);

    // An attached image defaults to image_ask (find-this-on-the-page) UNLESS the
    // router chose an action route (guide/hide) that should consume the image
    // itself. This is what lets Guide/Auto mode actually "see" an uploaded image
    // instead of the image always hijacking the request into a find-on-page scroll.
    if (hasImage && route.handler !== 'guide' && route.handler !== 'hide'
        && typeof handleImageAsk === 'function') {
      console.log('🎯 Image attached with non-guide route → image_ask');
      const result = await handleImageAsk(query);
      if (result) {
        result.routedTo = 'image_ask';
        result.routeConfidence = 1.0;
        result.routeReason = 'Image attached (non-guide route)';
        return result;
      }
      // Fall through if image_ask fails
    }
  }


  // If router says image_ask but no image available, fall back to ask
  if (route.handler === 'image_ask' && !imageAvailable) {
    console.log('🎯 Router suggested image_ask but no image available, falling back to ask');
    route.handler = 'ask';
    route.reason = 'No image available, using ask instead';
  }
  
  let result;

  // Expand "See more" / "Show more" ONLY for ask and pdf_ask.
  // All other modes (guide, protection, image_ask) skip this because auto-clicking
  // mutates the page unexpectedly:
  //   • guide     — mutates the page before guidance starts, confusing the step generator
  //   • hide      — user wants to hide existing elements, not trigger more content
  //   • image_ask — expanding text doesn't help find images
  const _shouldExpand = route.handler === 'ask' || route.handler === 'pdf_ask';
  if (_shouldExpand && typeof expandTruncatedContent === 'function') {
    await expandTruncatedContent();
  }

  switch (route.handler) {
    case 'hide':
      if (typeof handleProtectionQuery === 'function') {
        result = await handleProtectionQuery(query);
        if (result) break;
      }
      // Fall through to ask if hide handler not available
      result = await handleAsk(query, history);
      break;

    case 'guide':
      // Use the clean query (file kept out) when provided — the guide ingests any
      // attached file/image once instead of re-embedding it in every step.
      result = await handleStepByStepGuide(cleanQuery || query);
      break;
    
    case 'image_ask':
      if (typeof handleImageAsk === 'function') {
        result = await handleImageAsk(query);
        if (result) break;
      }
      // Fall through to ask if image_ask handler not available or no image uploaded
      console.log('🎯 Falling back to ask (no image or handler unavailable)');
      result = await handleAsk(query, history);
      break;
    
    case 'pdf_ask':
      if (typeof handlePdfAsk === 'function') {
        result = await handlePdfAsk(query);
        if (result) break;
      }
      // Fall through to ask if pdf_ask handler returns null
      console.log('🎯 Falling back to ask (PDF handler unavailable or not a PDF)');
      result = await handleAsk(query, history);
      break;
    
    case 'ask':
    default:
      result = await handleAsk(query, history);
      break;
  }
  
  // Add routing info to result
  if (result) {
    result.routedTo = route.handler;
    result.routeConfidence = route.confidence;
    result.routeReason = route.reason;
  }
  
  return result;
}

console.log('🚀 api.js (router) loaded');
