// PageGuide - Ask Functionality
// Single prompt approach: Answer with inline citations
// Supports vision-based answering for visual questions

// Configuration (guard against double-loading)
if (typeof VISION_CONFIG === 'undefined') {
  var VISION_CONFIG = {
    maxScrollSteps: 5,        // Maximum number of scroll steps
    scrollDelayMs: 500,       // Delay between scrolls for rendering
    viewportOverlap: 0.2      // 20% overlap between screenshots
  };
}

/**
 * Route query to determine if vision (screenshots) is needed
 * @param {string} query - User's question
 * @returns {Promise<{needsVision: boolean, confidence: number, reason: string}>}
 */
async function routeVisionQuery(query) {
  console.log('👁️ Checking if vision is needed for:', query);
  
  try {
    // Use fast router LLM (Gemini 2.5 Flash) for quick vision classification
    const response = await safeSendMessage({
      action: 'callRouterLLM',
      systemPrompt: PROMPTS.VISION_ROUTER,
      messages: [{
        role: 'user',
        content: `Query: "${query}"\n\nClassify this query and return JSON only.`
      }]
    });
    
    if (response?.error) {
      console.warn('👁️ Vision router error, defaulting to text-only:', response.error);
      return { needsVision: false, confidence: 0.5, reason: 'Router error, using text-only' };
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
      console.log('👁️ Vision router decision:', result);
      
      return {
        needsVision: result.needsVision === true,
        confidence: result.confidence || 0.5,
        reason: result.reason || ''
      };
    }
    
    return { needsVision: false, confidence: 0.5, reason: 'No response from router' };
    
  } catch (e) {
    console.error('👁️ Vision router parse error:', e);
    return { needsVision: false, confidence: 0.5, reason: 'Parse error, using text-only' };
  }
}

// Note: captureScreenshot() is defined in capture_screenshot.js

/**
 * Get current scroll position as a descriptive string
 */
function getScrollPosition() {
  const scrollY = window.scrollY;
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  
  if (maxScroll <= 0) return 'single page (no scroll needed)';
  
  const percent = Math.round((scrollY / maxScroll) * 100);
  
  if (percent <= 5) return 'top of page';
  if (percent >= 95) return 'bottom of page';
  return `${percent}% down the page`;
}

/**
 * Scroll the page in a direction
 * @param {string} direction - 'up' or 'down'
 * @returns {boolean} Whether scroll was possible
 */
function scrollPage(direction) {
  const viewportHeight = window.innerHeight;
  const scrollAmount = viewportHeight * 0.8; // 80% of viewport
  const maxScroll = document.documentElement.scrollHeight - viewportHeight;
  
  if (direction === 'down') {
    if (window.scrollY >= maxScroll) return false;
    window.scrollTo({ 
      top: Math.min(window.scrollY + scrollAmount, maxScroll), 
      behavior: 'smooth' 
    });
    return true;
  } else if (direction === 'up') {
    if (window.scrollY <= 0) return false;
    window.scrollTo({ 
      top: Math.max(window.scrollY - scrollAmount, 0), 
      behavior: 'smooth' 
    });
    return true;
  }
  return false;
}

/**
 * Parse vision agent response
 */
function parseVisionResponse(content) {
  try {
    let jsonStr = content.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');
    
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) jsonStr = match[0];
    
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('👁️ Failed to parse vision response:', e);
    return null;
  }
}

/**
 * Handle question using vision with navigation loop
 * Agent takes screenshot, decides if it can answer or needs to scroll
 * @param {string} query - User's question
 * @returns {Promise<object>} Result with answer
 */
async function handleAskWithVision(query) {
  console.log('👁️ Using vision navigation mode for:', query);
  
  const maxSteps = VISION_CONFIG.maxScrollSteps;
  const previousActions = [];
  let step = 1;
  let lastAnswer = null;
  
  // Create page index (will be refreshed after scrolls)
  let pageIndex = createPageIndex(500);
  console.log('👁️ Initial page index count:', pageIndex.count);
  
  // Handle minimal content pages (like empty SPAs)
  const hasMinimalContent = pageIndex.count < 5;
  if (hasMinimalContent) {
    console.log('👁️ Minimal page content detected, relying more on visual analysis');
  }
  
  // Show Set of Marks if enabled
  await showSomIfEnabled(pageIndex);
  
  while (step <= maxSteps) {
    console.log(`👁️ Vision step ${step}/${maxSteps}`);
    
    // Wait for any scroll animation to complete
    await new Promise(r => setTimeout(r, VISION_CONFIG.scrollDelayMs));
    
    // Refresh page index after scroll (elements may have changed)
    if (step > 1) {
      pageIndex = createPageIndex(500);
      await showSomIfEnabled(pageIndex);
    }
    
    // Capture screenshot at current position
    const screenshot = await captureScreenshot();
    if (!screenshot) {
      cleanupSom();
      return { 
        success: false, 
        error: 'Could not capture screenshot',
        useVision: true,
        visionSteps: step
      };
    }
    
    // Build the navigation prompt
    // If page has minimal content, tell the agent to rely on visual analysis
    const pageIndexContent = pageIndex.count > 0 
      ? pageIndex.indexText 
      : '(No indexable elements found - rely on visual analysis of the screenshot)';
    
    const prompt = PROMPTS.VISION_NAVIGATE
      .replace('{step}', step.toString())
      .replace('{maxSteps}', maxSteps.toString())
      .replace('{previousActions}', previousActions.length > 0 ? previousActions.join(' → ') : 'none')
      .replace('{scrollPosition}', getScrollPosition())
      .replace('{pageIndex}', pageIndexContent)
      .replace('{question}', query);
    
    // Send to LLM
    const response = await safeSendMessage({
      action: 'callLLM',
      systemPrompt: '',
      messages: [{ role: 'user', content: prompt }],
      imageBase64: screenshot,
      metadata: {
        mode: 'ask_step',
        step: step,
        url: window.location.href
      }
    });
    
    if (response?.error) {
      cleanupSom();
      return { 
        success: false, 
        error: response.error,
        useVision: true,
        visionSteps: step
      };
    }
    
    // Parse the response
    const parsed = parseVisionResponse(response?.content || '');
    
    if (!parsed) {
      // If parsing failed, try to use raw response as answer
      cleanupSom();
      return {
        success: true,
        answer: response?.content || 'Could not parse response',
        useVision: true,
        visionSteps: step,
        highlightCount: 0,
        hasHighlights: false
      };
    }
    
    console.log('👁️ Vision agent response:', parsed);
    
    // Track action
    previousActions.push(`Step ${step}: ${parsed.action} (${parsed.reason})`);
    
    // If agent can answer, we're done!
    if (parsed.canAnswer && parsed.answer) {
      console.log('👁️ Found answer at step', step);
      lastAnswer = parsed.answer;

      // Apply highlights from citations — skipped entirely in Non-grounding baseline mode,
      // which also strips the citation markers themselves so no clickable chips appear in the
      // chat (parseCitations in the side panel would otherwise still turn them into chips even
      // with no on-page highlight applied).
      const nonGrounding = typeof isNonGroundingModeOn === 'function' && await isNonGroundingModeOn();
      const highlightCount = nonGrounding ? 0 : applyHighlightsFromCitations(parsed.answer);
      const answerOut = nonGrounding && typeof stripCitationMarkers === 'function'
        ? stripCitationMarkers(parsed.answer)
        : parsed.answer;
      cleanupSom();

      // Visual evidence mode only: a crop per cited span (empty array in Text mode).
      const findEvidenceShots = typeof gv2CaptureFindEvidenceShots === 'function'
        ? await gv2CaptureFindEvidenceShots(highlightCount > 0)
        : [];

      return {
        success: true,
        answer: answerOut,
        useVision: true,
        visionSteps: step,
        visionActions: previousActions,
        highlightCount: highlightCount,
        hasHighlights: highlightCount > 0,
        findEvidenceShots
      };
    }
    
    // Handle navigation actions
    if (parsed.action === 'scroll_down') {
      const scrolled = scrollPage('down');
      if (!scrolled) {
        console.log('👁️ Cannot scroll down further');
        previousActions.push('(hit bottom)');
      }
    } else if (parsed.action === 'scroll_up') {
      const scrolled = scrollPage('up');
      if (!scrolled) {
        console.log('👁️ Cannot scroll up further');
        previousActions.push('(hit top)');
      }
    } else if (parsed.action === 'not_found') {
      // Agent determined content doesn't exist
      console.log('👁️ Agent determined: not found');
      cleanupSom();
      
      return {
        success: true,
        answer: parsed.answer || "I couldn't find what you're looking for on this page.",
        useVision: true,
        visionSteps: step,
        visionActions: previousActions,
        highlightCount: 0,
        hasHighlights: false
      };
    }
    
    step++;
  }
  
  // Max steps reached
  console.log('👁️ Max steps reached');
  cleanupSom();
  
  return {
    success: true,
    answer: lastAnswer || "I've searched the visible page but couldn't find a definitive answer. Try scrolling to a different section and asking again.",
    useVision: true,
    visionSteps: step - 1,
    visionActions: previousActions,
    highlightCount: 0,
    hasHighlights: false
  };
}

/**
 * Main handler for user questions
 * Routes between text-only and vision-based approaches
 * @param {string} query - User's question
 * @param {Array} history - Conversation history (unused for now)
 */
async function handleAsk(query, history = []) {
  console.log('🤖 handleAsk:', query);
  
  // First, check if vision is needed
  const visionRoute = await routeVisionQuery(query);
  console.log('👁️ Vision decision:', visionRoute.needsVision ? 'YES' : 'NO', 
              `(${Math.round(visionRoute.confidence * 100)}% - ${visionRoute.reason})`);
  
  // If vision is needed, use screenshot-based approach
  if (visionRoute.needsVision) {
    const result = await handleAskWithVision(query);
    result.visionDecision = visionRoute;
    return result;
  }
  
  // Otherwise, use text-based approach
  // Get page content and index (limit to prevent performance issues on large pages)
  const pageContent = getVisibleText(50000); 
  const pageIndex = createPageIndex(5000);    
  
  console.log('🤖 Page content length:', pageContent.length);
  console.log('🤖 Page index count:', pageIndex.count);
  
  // Show Set of Marks if enabled in settings
  await showSomIfEnabled(pageIndex);
  
  let result;
  
  // Try with highlighting first
  try {
    result = await handleAskWithHighlight(query, pageContent, pageIndex, history);
    if (result.success && result.answer) {
      // Hide SoM when task completes successfully
      cleanupSom();
      result.visionDecision = visionRoute;
      return result;
    }
  } catch (error) {
    console.log('🤖 Error:', error);
  }
  
  // Clean up SoM on failure
  cleanupSom();
  
  result = result || { success: false, error: 'Failed to process query' };
  result.visionDecision = visionRoute;
  return result;
}

/**
 * Ask with highlighting (main approach)
 * @param {string} query - User's question
 * @param {string} pageContent - Page text content
 * @param {Object} pageIndex - Page element index
 * @param {Array} history - Conversation history [{role, content}]
 */
async function handleAskWithHighlight(query, pageContent, pageIndex, history = []) {
  // Check if we have enough content to work with
  if (pageContent.length < 50 && pageIndex.count < 3) {
    console.log('🤖 Very minimal page content detected');
    return {
      success: true,
      answer: "This page appears to have minimal readable content. It might be a Single Page Application (SPA) that loads content dynamically, or the main content hasn't loaded yet. Try waiting a moment and asking again, or scroll to load more content.",
      highlightCount: 0,
      hasHighlights: false,
      minimalContent: true
    };
  }
  
  // Build system prompt with page content (fresh context each time)
  const systemPrompt = PROMPTS.ANSWER_AND_HIGHLIGHT
    .replace('{pageContent}', pageContent || '(No text content found)')
    .replace('{pageIndex}', pageIndex.indexText || '(No elements indexed)');
  
  // Build messages with history (history contains only Q&A, not page context)
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: query }
  ];
  
  console.log('🤖 Chat history length:', history.length);
  
  // LLM call with history
  const response = await safeSendMessage({
    action: 'callLLM',
    systemPrompt: systemPrompt,
    messages: messages,
    metadata: {
      mode: 'ask_chat',
      url: window.location.href
    }
  });
  
  if (response?.error) {
    return { success: false, error: response.error, answer: "Could not answer the question with highlighting" };
  }
  
  const answer = response?.content?.trim();
  if (!answer) {
    return { success: false, error: 'No answer from AI', answer: "Could not answer the question with highlighting" };
  }
  
  console.log('🤖 Answer with citations:', answer);

  // Extract citations and apply highlights — skipped entirely in Non-grounding baseline mode,
  // which also strips the citation markers themselves so no clickable chips appear in the chat
  // (parseCitations in the side panel would otherwise still turn them into chips even with no
  // on-page highlight applied).
  const nonGrounding = typeof isNonGroundingModeOn === 'function' && await isNonGroundingModeOn();
  const highlightCount = nonGrounding ? 0 : applyHighlightsFromCitations(answer);
  const answerOut = nonGrounding && typeof stripCitationMarkers === 'function'
    ? stripCitationMarkers(answer)
    : answer;

  // Visual evidence mode: crop each cited span into the answer. Returns [] in Text mode, where the
  // citation chips linking to the page are the whole story. Same helper the Guide find path uses.
  const findEvidenceShots = typeof gv2CaptureFindEvidenceShots === 'function'
    ? await gv2CaptureFindEvidenceShots(highlightCount > 0)
    : [];

  return {
    success: true,
    answer: answerOut,
    highlightCount: highlightCount,
    hasHighlights: highlightCount > 0,
    findEvidenceShots
  };
}

/**
 * Extract [N:"text"] citations from answer and apply highlights
 * @param {string} answer - Answer text with [N:"text"] citations
 * @returns {number} Number of elements highlighted
 */
function applyHighlightsFromCitations(answer) {
  // Clear previous highlights
  clearHighlights();
  window._pageguideHighlights = [];
  
  // Normalize curly/smart quotes to straight quotes
  const normalizedAnswer = answer
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'");
  
  // Find all citation patterns:
  // [N:"text"] or [N:'text'] - with quotes (text may contain apostrophes/quotes)
  // [N:text] - without quotes
  // [N] - simple index only
  // Use separate patterns for double-quoted, single-quoted, and unquoted
  const doubleQuotedPattern = /\[(\d+):\s*"([^"]+)"\]/g;  // [N:"text"]
  const singleQuotedPattern = /\[(\d+):\s*'([^']+)'\]/g;  // [N:'text']
  const unquotedPattern = /\[(\d+):\s*([^\]"']+)\]/g;     // [N:text]
  const citationSimplePattern = /\[(\d+)\](?!:)/g;        // [N]
  
  // Collect all matches from normalized answer
  const matchesWithText = [
    ...normalizedAnswer.matchAll(doubleQuotedPattern),
    ...normalizedAnswer.matchAll(singleQuotedPattern),
    ...normalizedAnswer.matchAll(unquotedPattern)
  ];
  const matchesSimple = [...normalizedAnswer.matchAll(citationSimplePattern)];
  
  if (matchesWithText.length === 0 && matchesSimple.length === 0) {
    console.log('🤖 No citations found in answer');
    return 0;
  }
  
  console.log('🤖 Found', matchesWithText.length, 'citations with text,', matchesSimple.length, 'simple citations');
  console.log('🤖 Available indices in _pageguideIndex:', Object.keys(window._pageguideIndex || {}).length);
  
  // Citation ordinals, so a highlighted span knows which [N] chip in the answer it belongs to.
  // The side panel numbers citations by their position in the answer text (parseCitations), while
  // this function processes them grouped by quote style — without this map the crop labelled "3"
  // could belong to the first citation in the sentence.
  const markerPositions = [...normalizedAnswer.matchAll(/\[(\d+)(?::[^\]]*)?\]/g)]
    .map(m => m.index)
    .sort((a, b) => a - b);
  const citationNumberAt = (pos) => {
    const rank = markerPositions.indexOf(pos);
    return rank >= 0 ? rank + 1 : null;
  };
  // Parallel to window._pageguideHighlights: the citation number each highlighted element serves.
  window._pageguideHighlightNumbers = [];
  const tagHighlightsSince = (startLen, citationNumber) => {
    for (let i = startLen; i < window._pageguideHighlights.length; i++) {
      window._pageguideHighlightNumbers[i] = citationNumber;
    }
  };

  const pageBg = getPageBackground();
  // highlightedElements tracks WHOLE-element highlights (simple citations / Strategy-3
  // fallbacks). Used to prevent simple citations from re-highlighting an element whose
  // parent is already lit up. NOT used to block multiple text highlights on the same
  // element (e.g. two different phrases inside the same social-media paragraph).
  const highlightedElements = new Set();
  const seenIndices = new Set();
  // For text citations we dedup by "index:text" pair so the SAME element can carry
  // multiple distinct highlighted substrings (e.g. "16,180 tokens" AND "3,150 tokens"
  // both inside the same indexed paragraph div).
  const seenIndexTextPairs = new Set();
  const failedIndices = [];
  let count = 0;

  // Process citations with text first (higher priority), in the order they appear in the answer —
  // the three quote-style patterns above are collected pattern-by-pattern, which would otherwise
  // highlight (and number) a later single-quoted citation before an earlier double-quoted one.
  matchesWithText.sort((a, b) => a.index - b.index);

  for (const match of matchesWithText) {
    const index = parseInt(match[1], 10);
    const textToHighlight = match[2];

    // Deduplicate by index+text pair — same index with different text is ALLOWED
    const pairKey = `${index}:${textToHighlight.toLowerCase().trim()}`;
    if (seenIndexTextPairs.has(pairKey)) continue;
    seenIndexTextPairs.add(pairKey);
    seenIndices.add(index); // keep tracking index so simple [N] citations are deduped

    let element = getIndexedElement(index);

    if (!element) {
      console.log('🤖 Index', index, 'not found and text search failed');
      failedIndices.push(index);
      continue;
    }

    console.log('🤖 Found element for [' + index + ':"' + textToHighlight + '"]:', element.tagName, element.textContent?.slice(0, 30));

    // For text citations: only skip if a PARENT element is already whole-highlighted.
    // Siblings or children being highlighted is fine — we want every cited phrase lit up.
    let parentAlreadyHighlighted = false;
    let parent = element.parentElement;
    while (parent) {
      if (highlightedElements.has(parent)) { parentAlreadyHighlighted = true; break; }
      parent = parent.parentElement;
    }
    if (parentAlreadyHighlighted) {
      console.log('🤖 Skipping', index, '- parent element already highlighted');
      continue;
    }

    // Apply highlight with specific text
    const style = getRandomHighlightStyle(pageBg.isDark);
    const beforeLen = window._pageguideHighlights.length;
    const highlighted = applyIndexedHighlight(index, textToHighlight, style);
    tagHighlightsSince(beforeLen, citationNumberAt(match.index));

    if (highlighted > 0) {
      // Do NOT add element to highlightedElements here — other phrases inside the
      // same element must still be highlightable in subsequent loop iterations.
      count += highlighted;
      console.log('🤖 Highlighted [' + index + ':"' + textToHighlight + '"] ✓');
    }
  }
  
  // Process simple citations (fallback, highlights entire element)
  for (const match of matchesSimple) {
    const index = parseInt(match[1], 10);

    // Skip duplicate indices
    if (seenIndices.has(index)) continue;
    seenIndices.add(index);

    // Skip bare [N] citations that look like Wikipedia-style footnotes.
    // Wikipedia footnotes appear as "text[1]" (no space before the bracket).
    // Valid extension citations should have a space: "text [45]".
    const matchPos = match.index;
    if (matchPos > 0 && normalizedAnswer[matchPos - 1] !== ' ' && normalizedAnswer[matchPos - 1] !== '\n') {
      console.log('🤖 Skipping likely webpage footnote [' + index + '] - no space before bracket');
      continue;
    }
    
    const element = getIndexedElement(index);
    if (!element) {
      console.log('🤖 Index', index, 'not found in _pageguideIndex');
      failedIndices.push(index);
      continue;
    }
    
    console.log('🤖 Found element for [' + index + ']:', element.tagName, element.textContent?.slice(0, 30));
    
    // Skip if already highlighted or parent/child is highlighted
    if (isAlreadyHighlighted(element, highlightedElements)) {
      console.log('🤖 Skipping', index, '- overlapping element');
      continue;
    }
    
    // Apply highlight to entire element (no specific text). Tagged as a block highlight: it can be
    // a whole paragraph or card, which is why evidence capture skips these — a crop of one is a
    // wall of tint that shows nothing.
    const style = getRandomHighlightStyle(pageBg.isDark);
    applyAnimatedHighlight(element, style.color, style.animation, { block: true });

    // Force inline styles as backup (in case CSS classes don't work)
    element.style.backgroundColor = typeof pageguideHighlightTint === 'function'
      ? pageguideHighlightTint(style.color, true)
      : `${style.color}22`;

    window._pageguideHighlightNumbers[window._pageguideHighlights.length] = citationNumberAt(match.index);
    window._pageguideHighlights.push(element);
    highlightedElements.add(element);
    count++;
    
    console.log('🤖 Highlighted [' + index + '] ✓');
  }
  
  if (failedIndices.length > 0) {
    console.warn('🤖 Failed to highlight indices:', failedIndices);
  }
  
  // Scroll to first highlight
  if (window._pageguideHighlights.length > 0) {
    window._pageguideHighlights[0].scrollIntoView({ 
      behavior: 'smooth', 
      block: 'center' 
    });
  }
  
  return count;
}

/** Fold a fragment to comparable text: no markdown emphasis, no quotes, no case, single spaces. */
function _citationCompareText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[*_`"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Content words of a fragment: punctuation dropped, so "world," and "world" are the same word. */
function _citationTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(t => t.length > 2);
}

/**
 * Does the prose around the marker already say what the cited span says? Exact containment is not
 * enough — models paraphrase and then cite the page's near-identical wording, which inlines as an
 * obvious stutter. Two signals catch the real cases:
 *
 *   seam  — the prose right before the marker ends with the span's opening words, or the prose
 *           right after starts with its closing words:
 *           "…featured the Rose Cross lamen [10:"featured the Rose Cross lamen of this famous …"]
 *            of this famous society."
 *   ratio — most of the span's content words are already in the surrounding sentence:
 *           "…in the Theosophical Society [7:"Theosophical Society's hierarchy of ascended …"]"
 *
 * Spans under three content words are judged by exact containment only: a two-word overlap says
 * nothing, and dropping "within 30 days" would put a hole back in the sentence.
 *
 * @param {string} before - normalized prose preceding the marker
 * @param {string} after - normalized prose following the marker
 * @param {string} span - normalized cited text
 * @returns {boolean}
 */
function _citationEchoesProse(before, after, span) {
  const spanTokens = _citationTokens(span);
  if (!spanTokens.length) return true;
  const beforeStr = _citationTokens(before).join(' ');
  const afterStr = _citationTokens(after).join(' ');
  const spanStr = spanTokens.join(' ');

  if (beforeStr.endsWith(spanStr) || afterStr.startsWith(spanStr)) return true;
  if (spanTokens.length < 3) return false;

  // Try progressively shorter openings/closings (down to 3 words): the prose repeats "featured
  // the rose cross lamen" — five words — so a fixed-length probe misses it.
  for (let k = Math.min(8, spanTokens.length); k >= 3; k--) {
    if (beforeStr.endsWith(spanTokens.slice(0, k).join(' '))) return true;
    if (afterStr.startsWith(spanTokens.slice(-k).join(' '))) return true;
  }

  // Substring rather than exact token match, so "pathways" counts as "pathway".
  const windowStr = `${beforeStr} ${afterStr}`;
  const hits = spanTokens.filter(t => windowStr.includes(t)).length;
  return hits / spanTokens.length >= 0.7;
}

/**
 * Strip citation markers from an answer, keeping the model's prose intact and complete. Used by
 * Non-grounding baseline mode (isNonGroundingModeOn) so the displayed answer has no clickable
 * citation chips at all — not just no on-page highlight — since parseCitations() in the side panel
 * would otherwise turn any leftover marker into a clickable span regardless of whether
 * applyHighlightsFromCitations() ever ran on the page.
 *
 * A cited span plays one of two roles, and they need opposite treatment:
 *
 *   1. It repeats prose that is already there — `**Peter Thiel** [12:"Peter Thiel"] wrote…`.
 *      Grounding mode collapses the marker to a chip so the repeat is invisible; inlining it
 *      printed the phrase twice ("Peter Thiel Peter Thiel"). The marker is dropped.
 *   2. It carries words the sentence needs — `Contact the depot [12:"within 30 days"] of travel.`
 *      Deleting it left a gap ("Contact the depot of travel."). The span is kept.
 *
 * So each marker is compared against the prose right before and after it: a duplicate is removed,
 * anything else is unwrapped in place. Markers with no text of their own ([N], [N, M], [idx:1-2])
 * are always removed — there is nothing to keep.
 *
 * @param {string} answer - Answer text with citation markers
 * @returns {string} The same text, marker-free, with no gaps and no repeats
 */
function stripCitationMarkers(answer) {
  if (!answer) return answer;
  // Curly quotes must be folded to straight ones with explicit escapes — a literal ["”] in the
  // source is just a straight quote twice and never matched the smart quotes models emit.
  const normalized = String(answer)
    .replace(/[“”„‟"]/g, '"')
    .replace(/[‘’‚‛']/g, "'");

  // One pass over every marker shape, so each match can see the text around it. The index part
  // allows comma-separated lists ([517, 519:"text"]) the same way parseCitations does. The quoted
  // alternatives take everything up to the LAST quote before the closing bracket, because cited
  // page text frequently contains quotes of its own:
  //   [94:"claimed sanction from the "Great White Lodge""]
  // A [^"]+ capture stops at the inner quote, fails to reach the bracket, and leaves the whole
  // marker sitting in the answer as raw text.
  const MARKER = /\[(?:Page\s*)?[\d,\s]+:\s*(?:"([^\]]*)"|'([^\]]*)'|([^\]"']+))\s*\]|\[idx:[^\]]+\]|\[[\d,\s]+\](?!:)/gi;

  return normalized
    .replace(MARKER, (match, dq, sq, uq, offset, whole) => {
      const span = dq || sq || uq;
      if (!span) return ''; // [N] / [N, M] / [idx:1-2] — no text of its own
      const spanCmp = _citationCompareText(span);
      if (!spanCmp) return '';

      // Look at the sentence on both sides of the marker. The windows are generous because the
      // repeat is often split across the marker (prose ends with the span's opening words, then
      // continues with its closing ones).
      const beforeRaw = whole.slice(Math.max(0, offset - spanCmp.length - 120), offset);
      const afterRaw = whole.slice(offset + match.length, offset + match.length + spanCmp.length + 120);
      if (_citationEchoesProse(beforeRaw, afterRaw, spanCmp)) return '';

      return span;
    })
    // Safety net: anything still bracket-shaped is a marker whose form we failed to parse, and a
    // raw "[94:...]" in the baseline answer is worse than a dropped quote — the prose around it
    // already carries the claim. Nothing DOM- or index-shaped reaches the user.
    .replace(/\[\s*(?:idx\s*:|Page\s*\d|\d)[^\][]*\]/gi, '')
    .replace(/\s+([.,;:!?])/g, '$1')  // drop stray space a removed marker left before punctuation
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
if (typeof window !== 'undefined') window.stripCitationMarkers = stripCitationMarkers;

console.log('💬 ask.js loaded');
