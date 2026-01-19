// XWebAgent - PDF Ask Functionality
// Handles questions about PDF documents with backend-powered text extraction and bbox highlighting

// Configuration for PDF backend
const PDF_ASK_CONFIG = {
  backendUrl: 'http://localhost:8000',  // Backend server URL (configurable)
  maxPagesToScan: 10,  // Maximum pages to send to backend
  timeoutMs: 30000,    // Timeout for backend requests
  maxRetries: 2        // Number of retries on failure
};

/**
 * Check if PDF Ask is available (backend running, PDF detected)
 * @returns {Promise<{available: boolean, reason: string}>}
 */
async function checkPdfAskAvailability() {
  // Check if we're viewing a PDF
  const pdfInfo = detectPdfViewer();
  if (!pdfInfo.isPdf) {
    return { 
      available: false, 
      reason: 'Not viewing a PDF document' 
    };
  }
  
  // Check if backend is reachable
  try {
    const response = await fetch(`${PDF_ASK_CONFIG.backendUrl}/health`, {
      method: 'GET',
      timeout: 5000
    });
    
    if (!response.ok) {
      return { 
        available: false, 
        reason: 'PDF backend server not available' 
      };
    }
    
    return { 
      available: true, 
      reason: `PDF detected (${pdfInfo.viewerType}), backend ready` 
    };
    
  } catch (e) {
    // Backend not running - that's OK, we can use text layer fallback
    console.log('📄 PDF backend not available, will use text layer fallback');
    return { 
      available: true,  // Still available with fallback
      reason: `PDF detected (${pdfInfo.viewerType}), using text layer extraction`,
      fallbackMode: true
    };
  }
}

/**
 * Send PDF to backend for text extraction and question answering
 * @param {string} pdfUrl - URL of the PDF
 * @param {string} question - User's question
 * @returns {Promise<{answer: string, citations: Array}>}
 */
async function askPdfBackend(pdfUrl, question) {
  try {
    const response = await fetch(`${PDF_ASK_CONFIG.backendUrl}/ask-pdf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        pdf_url: pdfUrl,
        question: question,
        max_pages: PDF_ASK_CONFIG.maxPagesToScan
      }),
      timeout: PDF_ASK_CONFIG.timeoutMs
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Backend error: ${error}`);
    }
    
    const result = await response.json();
    return result;
    
  } catch (e) {
    console.error('📄 Backend request failed:', e);
    throw e;
  }
}

/**
 * Find bbox coordinates for a quote on a specific page
 * Uses backend pdfplumber for accurate coordinates
 * @param {string} pdfUrl - URL of the PDF
 * @param {number} pageNumber - Page number (1-indexed)
 * @param {string} quote - Exact quote to find
 * @returns {Promise<{bbox: object, found: boolean}>}
 */
async function findQuoteBbox(pdfUrl, pageNumber, quote) {
  try {
    const response = await fetch(`${PDF_ASK_CONFIG.backendUrl}/find-text-bbox`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        pdf_url: pdfUrl,
        page_number: pageNumber,
        search_text: quote
      }),
      timeout: PDF_ASK_CONFIG.timeoutMs
    });
    
    if (!response.ok) {
      console.warn('📄 Could not find bbox for quote:', quote);
      return { found: false, bbox: null };
    }
    
    const result = await response.json();
    return {
      found: result.found,
      bbox: result.bbox  // {x0, y0, x1, y1, pageWidth, pageHeight}
    };
    
  } catch (e) {
    console.error('📄 Find bbox failed:', e);
    return { found: false, bbox: null };
  }
}

/**
 * Parse answer with PDF citations
 * Format: "Answer text [Page N: 'exact quote']"
 * @param {string} answer - Answer with citations
 * @returns {{cleanAnswer: string, citations: Array<{page: number, quote: string}>}}
 */
function parsePdfCitations(answer) {
  const citations = [];
  
  // Match [Page N: "quote"] or [Page N: 'quote'] or [Page N: quote]
  const citationPattern = /\[Page\s*(\d+):\s*["']?([^"'\]]+)["']?\]/gi;
  
  let match;
  while ((match = citationPattern.exec(answer)) !== null) {
    citations.push({
      page: parseInt(match[1], 10),
      quote: match[2].trim()
    });
  }
  
  // Clean answer (keep citations for display but could remove them)
  const cleanAnswer = answer;
  
  return { cleanAnswer, citations };
}

/**
 * Extract text from PDF via background service worker and answer question
 * This works with ANY PDF viewer including Chrome's native viewer
 * @param {string} question - User's question
 * @returns {Promise<object>} Result with answer
 */
async function handlePdfAskFallback(question) {
  console.log('📄 Using background service worker for PDF text extraction');
  
  // Get PDF URL
  const pdfUrl = getPdfUrl();
  if (!pdfUrl) {
    return {
      success: false,
      error: 'Could not determine PDF URL',
      isPdf: true
    };
  }
  
  console.log('📄 PDF URL:', pdfUrl);
  
  // Extract text via background service worker (has PDF.js loaded)
  const extraction = await safeSendMessage({
    action: 'extractPdfText',
    pdfUrl: pdfUrl,
    maxPages: 15
  });
  
  if (extraction?.error) {
    return {
      success: false,
      error: extraction.error,
      isPdf: true
    };
  }
  
  if (!extraction?.text || extraction.text.length < 50) {
    return {
      success: false,
      error: 'Could not extract text from PDF. The PDF might be image-based (scanned document).',
      isPdf: true
    };
  }
  
  console.log('📄 Successfully extracted', extraction.text.length, 'chars from', extraction.extractedPages, 'pages');
  
  // Use LLM to answer question based on extracted text
  const prompt = `You are a helpful assistant answering questions about a PDF document.

PDF CONTENT (${extraction.totalPages} pages):
${extraction.text.slice(0, 50000)}

QUESTION: ${question}

INSTRUCTIONS:
1. Answer the question based on the PDF content
2. Use [Page N: "exact quote"] format to cite specific passages
3. Include the page number and the exact text you're referencing
4. If the answer spans multiple pages, cite each relevant page

EXAMPLE:
Question: "What is the main topic?"
Answer: The document discusses machine learning algorithms [Page 1: "Introduction to Machine Learning"] with a focus on neural networks [Page 3: "Deep Learning Architectures"].

Now answer the question with citations:`;

  const response = await safeSendMessage({
    action: 'callLLM',
    systemPrompt: '',
    messages: [{ role: 'user', content: prompt }]
  });
  
  if (response?.error) {
    return { 
      success: false, 
      error: response.error,
      isPdf: true
    };
  }
  
  const answer = response?.content?.trim();
  if (!answer) {
    return { 
      success: false, 
      error: 'No answer from AI',
      isPdf: true
    };
  }
  
  // Parse citations
  const { cleanAnswer, citations } = parsePdfCitations(answer);
  
  return {
    success: true,
    answer: cleanAnswer,
    isPdf: true,
    highlightCount: 0,
    hasHighlights: false,
    totalPages: extraction.totalPages,
    extractedPages: extraction.extractedPages,
    pdfJsMode: true
  };
}

/**
 * Apply highlights using text search (fallback when backend unavailable)
 * @param {Array<{page: number, quote: string}>} citations - Citations to highlight
 * @returns {number} Number of highlights applied
 */
async function applyTextBasedPdfHighlights(citations) {
  // Inject styles
  injectPdfHighlightStyles();
  clearPdfHighlights();
  
  let count = 0;
  
  for (const citation of citations) {
    // Navigate to page
    await navigateToPdfPage(citation.page);
    await new Promise(r => setTimeout(r, 300));
    
    // Find text in text layer
    const pageEl = document.querySelector(`[data-page-number="${citation.page}"]`) ||
                   document.querySelectorAll('.page')[citation.page - 1];
    
    if (!pageEl) continue;
    
    const textLayer = pageEl.querySelector('.textLayer');
    if (!textLayer) continue;
    
    // Search for quote in spans
    const spans = textLayer.querySelectorAll('span');
    const quoteLower = citation.quote.toLowerCase();
    
    for (const span of spans) {
      const spanText = span.textContent?.toLowerCase() || '';
      
      if (spanText.includes(quoteLower) || quoteLower.includes(spanText)) {
        // Get span position
        const rect = span.getBoundingClientRect();
        const pageRect = pageEl.getBoundingClientRect();
        
        // Create highlight at span position
        const highlight = document.createElement('div');
        highlight.className = 'xwebagent-pdf-highlight';
        highlight.setAttribute('data-xwebagent-styled', 'true');
        highlight.setAttribute('data-pdf-page', citation.page);
        highlight.setAttribute('data-pdf-text', citation.quote);
        
        highlight.style.cssText = `
          position: absolute;
          left: ${rect.left - pageRect.left}px;
          top: ${rect.top - pageRect.top}px;
          width: ${rect.width}px;
          height: ${rect.height}px;
          background-color: rgba(255, 235, 59, 0.4);
          border: 2px solid #FFC107;
          border-radius: 2px;
          pointer-events: none;
          z-index: 10;
          animation: xwebagent-pdf-pulse 1.5s ease-in-out 3;
        `;
        
        pageEl.style.position = 'relative';
        pageEl.appendChild(highlight);
        
        window._xwebagentPdfHighlights = window._xwebagentPdfHighlights || [];
        window._xwebagentPdfHighlights.push(highlight);
        count++;
        break;  // One highlight per citation
      }
    }
  }
  
  // Scroll to first highlight
  const firstHighlight = window._xwebagentPdfHighlights?.[0];
  if (firstHighlight) {
    firstHighlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  
  return count;
}

/**
 * Main handler for PDF questions
 * Flow:
 * 1. Detect PDF and get URL
 * 2. Send to backend (or use fallback)
 * 3. Get answer with citations
 * 4. Find bbox for each citation
 * 5. Apply highlights
 * @param {string} query - User's question about the PDF
 * @returns {Promise<object>} Result with answer and highlights
 */
async function handlePdfAsk(query) {
  console.log('📄 handlePdfAsk:', query);
  
  // Detect PDF
  const pdfInfo = detectPdfViewer();
  if (!pdfInfo.isPdf) {
    console.log('📄 Not a PDF page, falling back to regular ask');
    return null;  // Return null to signal fallback to regular handler
  }
  
  console.log('📄 PDF detected:', pdfInfo.viewerType);
  
  // Get PDF URL
  const pdfUrl = getPdfUrl();
  console.log('📄 PDF URL:', pdfUrl);
  
  // Check backend availability
  const availability = await checkPdfAskAvailability();
  
  if (availability.fallbackMode) {
    // Use text layer fallback
    return await handlePdfAskFallback(query);
  }
  
  // Try backend approach
  try {
    // Send to backend
    console.log('📄 Sending to backend...');
    const backendResult = await askPdfBackend(pdfUrl, query);
    
    if (!backendResult.answer) {
      return {
        success: false,
        error: 'No answer from backend',
        isPdf: true
      };
    }
    
    console.log('📄 Backend response:', backendResult);
    
    // Parse citations
    const { cleanAnswer, citations } = parsePdfCitations(backendResult.answer);
    
    // Get bboxes for each citation
    const highlightSpecs = [];
    
    for (const citation of citations) {
      const bboxResult = await findQuoteBbox(pdfUrl, citation.page, citation.quote);
      
      if (bboxResult.found && bboxResult.bbox) {
        highlightSpecs.push({
          page: citation.page,
          bbox: bboxResult.bbox,
          text: citation.quote
        });
      }
    }
    
    // Apply highlights
    let highlightCount = 0;
    if (highlightSpecs.length > 0) {
      highlightCount = await applyPdfHighlights(highlightSpecs);
    } else if (citations.length > 0) {
      // Fallback to text-based highlighting if bbox search failed
      highlightCount = await applyTextBasedPdfHighlights(citations);
    }
    
    return {
      success: true,
      answer: cleanAnswer,
      isPdf: true,
      highlightCount: highlightCount,
      hasHighlights: highlightCount > 0,
      citations: citations.length,
      pdfUrl: pdfUrl
    };
    
  } catch (e) {
    console.error('📄 Backend failed, using fallback:', e);
    // Fallback to text layer approach
    return await handlePdfAskFallback(query);
  }
}

/**
 * Check if current page is a PDF (quick check for router)
 * @returns {boolean}
 */
function isPdfPage() {
  return detectPdfViewer().isPdf;
}

console.log('📄 ask_pdf.js loaded');
