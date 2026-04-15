// PageGuide Offscreen Document - PDF Text Extraction
// This runs in a document context where PDF.js can work properly

console.log('📄 Offscreen document loaded');

// Configure PDF.js worker
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
  console.log('📄 PDF.js configured in offscreen document');
}

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extractPdfTextOffscreen') {
    extractPdfText(request.pdfUrl, request.maxPages || 15)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;  // Keep channel open for async response
  }
});

/**
 * Extract text from PDF using PDF.js
 * @param {string} pdfUrl - URL of the PDF
 * @param {number} maxPages - Maximum pages to extract
 */
async function extractPdfText(pdfUrl, maxPages) {
  console.log('📄 Extracting PDF text from:', pdfUrl);
  
  if (typeof pdfjsLib === 'undefined') {
    return { error: 'PDF.js library not loaded' };
  }
  
  try {
    // Fetch PDF
    const response = await fetch(pdfUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch PDF: ${response.status}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    console.log('📄 PDF fetched, size:', arrayBuffer.byteLength);
    
    // Load PDF document
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    
    console.log('📄 PDF loaded, pages:', pdf.numPages);
    
    const pageTexts = [];
    const pagesToExtract = Math.min(pdf.numPages, maxPages);
    
    // Extract text from each page
    for (let pageNum = 1; pageNum <= pagesToExtract; pageNum++) {
      try {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        
        // Combine text items
        const pageText = textContent.items
          .map(item => item.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        
        if (pageText) {
          pageTexts.push({
            page: pageNum,
            text: pageText
          });
        }
      } catch (pageError) {
        console.warn(`📄 Error extracting page ${pageNum}:`, pageError);
      }
    }
    
    // Combine all pages with page markers
    const fullText = pageTexts
      .map(p => `[Page ${p.page}]\n${p.text}`)
      .join('\n\n');
    
    console.log('📄 Extracted text length:', fullText.length, 'from', pageTexts.length, 'pages');
    
    return {
      text: fullText,
      pageTexts: pageTexts,
      totalPages: pdf.numPages,
      extractedPages: pageTexts.length
    };
    
  } catch (e) {
    console.error('📄 PDF extraction error:', e);
    return { error: `Failed to extract PDF: ${e.message}` };
  }
}

console.log('📄 Offscreen PDF parser ready');
