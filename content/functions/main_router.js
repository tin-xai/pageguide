// XWebAgent - API Router (Main Entry Point)
// Routes queries to appropriate handlers: ask, guide, protection
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
 * Smart handler that routes queries using LLM coordinator
 * This is the main entry point for all user queries
 * @param {string} query - User's query
 * @param {Array} history - Conversation history
 * @param {boolean} hasImage - Whether current message has an image attached
 * @param {boolean} hasImageInHistory - Whether any previous message had an image
 */
async function handleSmartQuery(query, history = [], hasImage = false, hasImageInHistory = false) {
  // Expand truncated posts ("See more", "Show more", etc.) before indexing
  if (typeof expandTruncatedContent === 'function') {
    await expandTruncatedContent();
  }

  // Check if image is available (current or in history)
  const imageAvailable = hasImage || hasImageInHistory || !!getUploadedImage?.();
  console.log('🎯 Image available:', imageAvailable, '(current:', hasImage, ', history:', hasImageInHistory, ')');
  
  // If current message has an image attached, directly route to image_ask
  // (don't ask the LLM router since it can't see the image)
  if (hasImage && typeof handleImageAsk === 'function') {
    console.log('🎯 Current message has image, routing directly to image_ask');
    const result = await handleImageAsk(query);
    if (result) {
      result.routedTo = 'image_ask';
      result.routeConfidence = 1.0;
      result.routeReason = 'Image attached to current message';
      return result;
    }
    // Fall through if image_ask fails
  }
  
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
  
  // Route the query using LLM
  const route = await routeQuery(query);
  console.log('🎯 Routed to:', route.handler, `(${Math.round(route.confidence * 100)}% confident - ${route.reason})`);
  
  // If router says image_ask but no image available, fall back to ask
  if (route.handler === 'image_ask' && !imageAvailable) {
    console.log('🎯 Router suggested image_ask but no image available, falling back to ask');
    route.handler = 'ask';
    route.reason = 'No image available, using ask instead';
  }
  
  let result;
  
  switch (route.handler) {
    case 'protection':
      if (typeof handleProtectionQuery === 'function') {
        result = await handleProtectionQuery(query);
        if (result) break;
      }
      // Fall through to ask if protection handler not available
      result = await handleAsk(query, history);
      break;
    
    case 'guide':
      result = await handleStepByStepGuide(query);
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
