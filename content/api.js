// XWebAgent - API Functions
// Handles communication with Gemini LLM

/**
 * Safe wrapper for chrome.runtime.sendMessage
 * Handles "Extension context invalidated" error gracefully
 */
async function safeSendMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (e) {
    if (e.message?.includes('Extension context invalidated')) {
      return { error: '🔄 Extension was updated. Please refresh the page (F5).' };
    }
    throw e;
  }
}

/**
 * Handle user questions about the page
 */
async function handleAsk(query) {
  console.log('🤖 Processing:', query);
  
  // Check if this is a styling command
  if (detectStylingCommand(query)) {
    return await handleStylingCommand(query);
  }
  
  const pageTitle = document.title;
  const pageUrl = window.location.href;
  const pageText = document.body.innerText.slice(0, 5000);
  const pageHTML = getSimplifiedHTML(10000);
  
  try {
    const response = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: PROMPTS.ASK,
      messages: [{
        role: 'user',
        content: `Page: ${pageTitle} (${pageUrl})

=== PAGE CONTENT ===
${pageHTML}

=== TEXT ===
${pageText}

=== QUESTION ===
${query}`
      }]
    });
    
    if (response?.content) {
      return { success: true, answer: response.content };
    } else if (response?.error) {
      return { success: false, error: response.error };
    }
  } catch (e) {
    console.error('API error:', e);
    return { success: false, error: e.message };
  }
  
  return { success: false, error: 'No response' };
}

/**
 * Handle styling/CSS modification commands
 */
async function handleStylingCommand(query) {
  console.log('🤖 Styling command:', query);
  
  const pageHTML = getSimplifiedHTML(15000);
  const pageStructure = getPageStructure();
  
  try {
    const response = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: PROMPTS.STYLING,
      messages: [{
        role: 'user',
        content: `=== HTML STRUCTURE ===
${pageHTML}

=== ELEMENTS ===
${pageStructure}

=== USER REQUEST ===
${query}

Return JSON only.`
      }]
    });
    
    if (response?.content) {
      try {
        // Parse JSON from response
        let jsonStr = response.content.trim()
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/\s*```$/i, '');
        
        const match = jsonStr.match(/\{[\s\S]*\}/);
        if (match) jsonStr = match[0];
        
        const styling = JSON.parse(jsonStr);
        const count = applyStyling(styling);
        
        return { 
          success: true, 
          description: styling.description || `Styled ${count} elements` 
        };
      } catch (e) {
        console.error('Parse error:', e);
        return { success: false, error: 'Could not parse AI response' };
      }
    }
    
    return { success: false, error: response?.error || 'No response from AI' };
  } catch (e) {
    console.error('Styling error:', e);
    return { success: false, error: e.message };
  }
}

