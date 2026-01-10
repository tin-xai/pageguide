// XWebAgent - API Router (Main Entry Point)
// Routes queries to appropriate handlers: ask, guide, protection
// 
// Dependencies (loaded before this file):
// - api-core.js: Core utilities (safeSendMessage, scrollViewport, etc.)
// - api-highlight.js: Highlight functions (clearHighlights, applyIndexedHighlight, etc.)
// - api-ask.js: Ask functionality (handleAsk, processLLMResponseWithScroll, etc.)
// - api-guide.js: Guidance functionality (handleStepByStepGuide, etc.)

/**
 * Route query using LLM-based coordinator
 * @param {string} query - User's query
 * @returns {Promise<{handler: string, confidence: number, reason: string}>}
 */
async function routeQuery(query) {
  console.log('🎯 Routing query:', query);
  
  try {
    const response = await safeSendMessage({
      action: 'callLLM',
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
 */
async function handleSmartQuery(query, history = []) {
  // Route the query using LLM
  const route = await routeQuery(query);
  console.log('🎯 Routed to:', route.handler, `(${Math.round(route.confidence * 100)}% confident - ${route.reason})`);
  
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
