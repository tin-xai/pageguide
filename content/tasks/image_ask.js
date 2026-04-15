// PageGuide - Image Ask Functionality
// Allows users to upload an image and ask questions about finding similar content on the page
// Uses vision-based scrolling to find and highlight matching elements

// Configuration for image ask (guard against double-loading)
if (typeof IMAGE_ASK_CONFIG === 'undefined') {
  var IMAGE_ASK_CONFIG = {
    maxScrollSteps: 8,          // Maximum scroll steps to find matching content
    scrollDelayMs: 600,         // Delay between scrolls for rendering
    viewportOverlap: 0.2        // 20% overlap between screenshots
  };
}

// Store the uploaded image globally
window._pageguideUploadedImage = null;

/**
 * Set the uploaded image (called from panel)
 * @param {string} imageBase64 - Base64 encoded image data
 */
function setUploadedImage(imageBase64) {
  window._pageguideUploadedImage = imageBase64;
  console.log('🖼️ Image uploaded and stored');
}

/**
 * Clear the uploaded image
 */
function clearUploadedImage() {
  window._pageguideUploadedImage = null;
  console.log('🖼️ Uploaded image cleared');
}

/**
 * Get the uploaded image
 * @returns {string|null} Base64 image data or null
 */
function getUploadedImage() {
  return window._pageguideUploadedImage;
}

/**
 * Parse image ask response
 */
function parseImageAskResponse(content) {
  try {
    let jsonStr = content.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');
    
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) jsonStr = match[0];
    
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('🖼️ Failed to parse image ask response:', e);
    return null;
  }
}

/**
 * Main handler for image-based questions
 * Uses the uploaded image + current page screenshot to find matching content
 * @param {string} query - User's question about the uploaded image
 * @returns {Promise<object>} Result with answer and highlights
 */
async function handleImageAsk(query) {
  console.log('🖼️ handleImageAsk:', query);
  
  const uploadedImage = getUploadedImage();
  
  if (!uploadedImage) {
    return {
      success: false,
      error: 'No image uploaded. Please upload an image first using the 📷 button.',
      isImageAsk: true
    };
  }
  
  console.log('🖼️ Using uploaded image for comparison, scrolling to find matches...');
  
  const maxSteps = IMAGE_ASK_CONFIG.maxScrollSteps;
  const previousActions = [];
  let step = 1;
  let lastAnswer = null;
  
  // Create page index
  let pageIndex = createPageIndex(5000);
  console.log('🖼️ Initial page index count:', pageIndex.count);
  
  // Show Set of Marks if enabled
  await showSomIfEnabled(pageIndex);
  
  while (step <= maxSteps) {
    console.log(`🖼️ Image search step ${step}/${maxSteps}`);
    
    // Wait for any scroll animation
    await new Promise(r => setTimeout(r, IMAGE_ASK_CONFIG.scrollDelayMs));
    
    // Refresh page index after scroll
    if (step > 1) {
      pageIndex = createPageIndex(5000);
      await showSomIfEnabled(pageIndex);
    }
    
    // Capture current viewport screenshot
    const viewportScreenshot = await captureScreenshot();
    if (!viewportScreenshot) {
      cleanupSom();
      return {
        success: false,
        error: 'Could not capture page screenshot',
        isImageAsk: true,
        imageAskSteps: step
      };
    }
    
    // Build page index content
    const pageIndexContent = pageIndex.count > 0 
      ? pageIndex.indexText 
      : '(No indexable elements found - rely on visual analysis)';
    
    // Build the prompt for image comparison
    const prompt = PROMPTS.IMAGE_ASK_NAVIGATE
      .replace('{step}', step.toString())
      .replace('{maxSteps}', maxSteps.toString())
      .replace('{previousActions}', previousActions.length > 0 ? previousActions.join(' → ') : 'none')
      .replace('{scrollPosition}', getScrollPosition())
      .replace('{pageIndex}', pageIndexContent)
      .replace('{question}', query);
    
    // Send to LLM with both images (uploaded + viewport)
    const response = await safeSendMessage({
      action: 'callLLMWithImages',
      systemPrompt: '',
      messages: [{ role: 'user', content: prompt }],
      images: [
        { base64: uploadedImage, label: 'User uploaded image (what to find)' },
        { base64: viewportScreenshot, label: 'Current page viewport (where to search)' }
      ]
    });
    
    if (response?.error) {
      cleanupSom();
      return {
        success: false,
        error: response.error,
        isImageAsk: true,
        imageAskSteps: step
      };
    }
    
    // Parse response
    const parsed = parseImageAskResponse(response?.content || '');
    
    if (!parsed) {
      // Try using raw response
      cleanupSom();
      return {
        success: true,
        answer: response?.content || 'Could not parse response',
        isImageAsk: true,
        imageAskSteps: step,
        highlightCount: 0,
        hasHighlights: false
      };
    }
    
    console.log('🖼️ Image ask agent response:', parsed);
    
    // Track action
    previousActions.push(`Step ${step}: ${parsed.action} (${parsed.reason})`);
    
    // If agent found a match
    if (parsed.found && parsed.answer) {
      console.log('🖼️ Found matching content at step', step);
      lastAnswer = parsed.answer;

      // Apply highlights from citations
      const highlightCount = applyHighlightsFromCitations(parsed.answer);
      cleanupSom();

      return {
        success: true,
        answer: parsed.answer,
        isImageAsk: true,
        imageAskSteps: step,
        imageAskActions: previousActions,
        highlightCount: highlightCount,
        hasHighlights: highlightCount > 0,
        imageRegions: Array.isArray(parsed.imageRegions) ? parsed.imageRegions : []
      };
    }
    
    // Handle navigation actions
    if (parsed.action === 'scroll_down') {
      const scrolled = scrollPage('down');
      if (!scrolled) {
        console.log('🖼️ Cannot scroll down further');
        previousActions.push('(hit bottom)');
      }
    } else if (parsed.action === 'scroll_up') {
      const scrolled = scrollPage('up');
      if (!scrolled) {
        console.log('🖼️ Cannot scroll up further');
        previousActions.push('(hit top)');
      }
    } else if (parsed.action === 'not_found') {
      // Agent determined content doesn't exist
      console.log('🖼️ Agent determined: not found on this page');
      cleanupSom();
      
      return {
        success: true,
        answer: parsed.answer || "I couldn't find content matching your uploaded image on this page.",
        isImageAsk: true,
        imageAskSteps: step,
        imageAskActions: previousActions,
        highlightCount: 0,
        hasHighlights: false
      };
    }
    
    step++;
  }
  
  // Max steps reached
  console.log('🖼️ Max steps reached without finding match');
  cleanupSom();
  
  return {
    success: true,
    answer: lastAnswer || "I've searched the visible page but couldn't find content matching your uploaded image. Try scrolling to a different section or uploading a different image.",
    isImageAsk: true,
    imageAskSteps: step - 1,
    imageAskActions: previousActions,
    highlightCount: 0,
    hasHighlights: false
  };
}

console.log('🖼️ image_ask.js loaded');
