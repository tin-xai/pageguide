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

// ===== Attachment ingestion (shared by guide/auto mode) =====
// A guide session "ingests" any attached image/file ONCE at start into a compact
// text context (cheap to carry on every step) plus, for images, the raw base64
// which is attached to the model only on the first step.

// Text files at or below this size go to the agent verbatim; larger ones are summarized.
if (typeof ATTACHMENT_RAW_CHAR_LIMIT === 'undefined') {
  var ATTACHMENT_RAW_CHAR_LIMIT = 6000;
}

// Store for an attached text file (image lives in window._pageguideUploadedImage).
window._pageguideFileAttachment = window._pageguideFileAttachment || { fileText: null, fileName: null };

/** Store an attached text file (called from the panel via content.js). */
function setUploadedFile(fileText, fileName) {
  window._pageguideFileAttachment = {
    fileText: fileText || null,
    fileName: fileName || null
  };
  console.log('📎 File stored for attachment ingestion:', fileName);
}

/** Clear the attached text file. */
function clearUploadedFileAttachment() {
  window._pageguideFileAttachment = { fileText: null, fileName: null };
}

/** Get the attached text file record. */
function getUploadedFileAttachment() {
  return window._pageguideFileAttachment || { fileText: null, fileName: null };
}

/**
 * Whether an attached text file is large enough to warrant a one-shot summary
 * instead of being embedded verbatim. Pure — unit-tested.
 * @param {number} len - character length of the file text
 */
function attachmentNeedsSummary(len) {
  return typeof len === 'number' && len > ATTACHMENT_RAW_CHAR_LIMIT;
}

/**
 * Build the compact text block injected into the guide plan + each step's USER GOAL.
 * Pure — unit-tested. Returns '' when nothing is attached.
 * @param {object} opts
 * @param {string} [opts.imageDescription] - LLM description of an attached image
 * @param {string} [opts.fileName]
 * @param {string} [opts.fileText]    - raw text (small files)
 * @param {string} [opts.fileSummary] - summary text (large files)
 */
function buildAttachmentContext({ imageDescription, fileName, fileText, fileSummary } = {}) {
  const parts = [];
  if (imageDescription && imageDescription.trim()) {
    parts.push(`Attached image (described): ${imageDescription.trim()}`);
  }
  if (fileSummary && fileSummary.trim()) {
    parts.push(`Attached file "${fileName || 'file'}" (summary): ${fileSummary.trim()}`);
  } else if (fileText && fileText.trim()) {
    parts.push(`Attached file "${fileName || 'file'}":\n${fileText.trim()}`);
  }
  return parts.join('\n\n');
}

/**
 * One-shot attachment ingestion for a guide session. Produces g.attachmentContext
 * (compact text carried on every step) and g.attachmentImage (raw base64 attached
 * only on the first step). Called ONCE at guide start; safe to call with nothing attached.
 */
async function gv2IngestAttachment(g) {
  if (!g) return;
  g.attachmentContext = '';
  g.attachmentImage = null;

  const image = (typeof getUploadedImage === 'function') ? getUploadedImage() : null;
  const fileStore = getUploadedFileAttachment();
  const fileText = fileStore?.fileText || null;
  const fileName = fileStore?.fileName || null;

  if (!image && !fileText) return; // nothing attached — no work, no cost

  let imageDescription = '';
  let fileSummary = '';
  let rawFileText = null;

  // Image → concise vision description (one call). Keep the raw base64 for step 1.
  if (image) {
    g.attachmentImage = image;
    try {
      const resp = await safeSendMessage({
        action: 'callLLMWithImages',
        systemPrompt: '',
        messages: [{ role: 'user', content: 'Describe this user-attached image in 2-4 sentences for a browser assistant that will use it to complete a task. Note key objects, any visible text/labels, brand or product, and distinctive colors. Do not add commentary or preamble.' }],
        images: [{ base64: image, label: 'User-attached image' }],
        metadata: { mode: 'attachment_ingest_image', url: window.location.href }
      });
      if (resp && !resp.error && resp.content) imageDescription = String(resp.content).trim();
    } catch (e) {
      console.warn('[guidev2] image attachment ingest failed:', e);
    }
  }

  // File → raw (small) or one-shot summary (large).
  if (fileText) {
    if (attachmentNeedsSummary(fileText.length)) {
      try {
        const clipped = fileText.slice(0, 40000);
        const resp = await safeSendMessage({
          action: 'callLLM',
          systemPrompt: '',
          messages: [{ role: 'user', content: `Summarize the following attached file for a browser assistant that will use it to complete the user's task. Preserve any facts, values, names, IDs, and instructions that could matter; be concise (under 400 words).\n\n[File: ${fileName || 'file'}]\n---\n${clipped}\n---` }],
          metadata: { mode: 'attachment_ingest_file', url: window.location.href }
        });
        if (resp && !resp.error && resp.content) fileSummary = String(resp.content).trim();
      } catch (e) {
        console.warn('[guidev2] file attachment ingest failed:', e);
      }
      // If summarization failed, fall back to a truncated raw copy so context isn't lost.
      if (!fileSummary) rawFileText = fileText.slice(0, ATTACHMENT_RAW_CHAR_LIMIT) + '\n… [truncated]';
    } else {
      rawFileText = fileText;
    }
  }

  g.attachmentContext = buildAttachmentContext({
    imageDescription,
    fileName,
    fileText: rawFileText,
    fileSummary
  });
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
      ],
      metadata: {
        mode: 'image_ask_step',
        step: step,
        url: window.location.href
      }
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
