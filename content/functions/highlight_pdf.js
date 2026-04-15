// PageGuide - PDF Highlight Functions
// Handles PDF detection, text extraction, and highlighting on PDF.js viewers

/**
 * PDF Highlight Configuration (guard against double-loading)
 */
if (typeof PDF_CONFIG === 'undefined') {
  var PDF_CONFIG = {
    highlightColor: 'rgba(255, 235, 59, 0.4)',  // Yellow highlight
    highlightBorder: '2px solid #FFC107',
    animationDuration: 2000,  // ms for highlight pulse animation
    scrollPadding: 100  // px padding when scrolling to highlight
  };
}

// Note: PDF.js is loaded in the background service worker
// Text extraction is done via message passing to the service worker

/**
 * Show notification to user about PDF navigation
 * @param {number} pageNumber - Page number navigated to
 * @param {string} searchText - Text being searched
 */
function showPdfSearchNotification(pageNumber, searchText) {
  // Remove existing notification
  const existing = document.getElementById('pageguide-pdf-notification');
  if (existing) existing.remove();
  
  // Create notification element
  const notification = document.createElement('div');
  notification.id = 'pageguide-pdf-notification';
  notification.innerHTML = `
    <div style="display: flex; align-items: center; gap: 10px;">
      <span style="font-size: 24px;">📄</span>
      <div>
        <div style="font-weight: 600; margin-bottom: 4px;">Navigating to page ${pageNumber}</div>
        <div style="font-size: 12px; opacity: 0.9;">🔍 Searching & highlighting text...</div>
        <div style="font-size: 11px; opacity: 0.7; margin-top: 4px; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">"${searchText}..."</div>
      </div>
    </div>
  `;
  
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    color: white;
    padding: 16px 20px;
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 193, 7, 0.3);
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    max-width: 350px;
    animation: pageguide-slide-in 0.3s ease-out;
    border-left: 4px solid #FFC107;
  `;
  
  // Add animation keyframes
  if (!document.getElementById('pageguide-pdf-notification-styles')) {
    const style = document.createElement('style');
    style.id = 'pageguide-pdf-notification-styles';
    style.textContent = `
      @keyframes pageguide-slide-in {
        from {
          opacity: 0;
          transform: translateX(100px);
        }
        to {
          opacity: 1;
          transform: translateX(0);
        }
      }
      @keyframes pageguide-slide-out {
        from {
          opacity: 1;
          transform: translateX(0);
        }
        to {
          opacity: 0;
          transform: translateX(100px);
        }
      }
    `;
    document.head.appendChild(style);
  }
  
  document.body.appendChild(notification);
  
  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    notification.style.animation = 'pageguide-slide-out 0.3s ease-out forwards';
    setTimeout(() => notification.remove(), 300);
  }, 5000);
  
  // Click to dismiss
  notification.addEventListener('click', () => {
    notification.style.animation = 'pageguide-slide-out 0.3s ease-out forwards';
    setTimeout(() => notification.remove(), 300);
  });
}

/**
 * Detect if current page is a PDF viewer
 * Supports: PDF.js (Firefox, web viewers), Chrome native, embedded PDFs
 * @returns {{isPdf: boolean, viewerType: string|null, viewerElement: Element|null, hasTextLayer: boolean}}
 */
function detectPdfViewer() {
  const url = window.location.href;
  
  // Check for Chrome's native PDF viewer (embed element with PDF type)
  const chromeEmbed = document.querySelector('embed[type="application/pdf"]');
  if (chromeEmbed) {
    console.log('📄 Detected Chrome native PDF viewer');
    return {
      isPdf: true,
      viewerType: 'chrome-native',
      viewerElement: chromeEmbed,
      hasTextLayer: false  // Chrome native doesn't expose text layer
    };
  }
  
  // Check for PDF.js viewer (Firefox, web-based viewers)
  const pdfJsViewer = document.getElementById('viewer') || 
                      document.querySelector('.pdfViewer') ||
                      document.querySelector('[class*="pdf-viewer"]');
  
  if (pdfJsViewer) {
    const hasTextLayer = !!document.querySelector('.textLayer');
    return {
      isPdf: true,
      viewerType: 'pdfjs',
      viewerElement: pdfJsViewer,
      hasTextLayer: hasTextLayer
    };
  }
  
  // Check for embedded PDF (iframe or object)
  const embeddedPdf = document.querySelector('iframe[src*=".pdf"]') ||
                      document.querySelector('object[data*=".pdf"]') ||
                      document.querySelector('embed[src*=".pdf"]');
  
  if (embeddedPdf) {
    return {
      isPdf: true,
      viewerType: 'embedded',
      viewerElement: embeddedPdf,
      hasTextLayer: false
    };
  }
  
  // Check URL for PDF extension or content type
  if (url.toLowerCase().includes('.pdf') || 
      url.includes('pdf.') ||
      document.contentType === 'application/pdf') {
    // Check if there's an embed (Chrome loads PDFs this way)
    const anyEmbed = document.querySelector('embed');
    if (anyEmbed) {
      return {
        isPdf: true,
        viewerType: 'chrome-native',
        viewerElement: anyEmbed,
        hasTextLayer: false
      };
    }
    return {
      isPdf: true,
      viewerType: 'native',
      viewerElement: document.body,
      hasTextLayer: false
    };
  }
  
  // Check for Google Drive PDF viewer
  if (url.includes('drive.google.com') && url.includes('/view')) {
    const driveViewer = document.querySelector('.ndfHFb-c4YZDc-Wrber');
    if (driveViewer) {
      return {
        isPdf: true,
        viewerType: 'google-drive',
        viewerElement: driveViewer,
        hasTextLayer: false
      };
    }
  }
  
  // Check for arXiv HTML viewer (has /html/ in URL for HTML version)
  if (url.includes('arxiv.org') && !url.includes('/html/')) {
    // Could be PDF
    const anyEmbed = document.querySelector('embed');
    if (anyEmbed) {
      return {
        isPdf: true,
        viewerType: 'chrome-native',
        viewerElement: anyEmbed,
        hasTextLayer: false
      };
    }
  }
  
  return {
    isPdf: false,
    viewerType: null,
    viewerElement: null,
    hasTextLayer: false
  };
}

/**
 * Get PDF.js application instance if available
 * @returns {object|null} PDFViewerApplication or null
 */
function getPdfJsApp() {
  // Standard PDF.js viewer
  if (typeof PDFViewerApplication !== 'undefined') {
    return PDFViewerApplication;
  }
  
  // Try to access through window
  if (window.PDFViewerApplication) {
    return window.PDFViewerApplication;
  }
  
  // Try to find through frames (for embedded viewers)
  try {
    const frames = document.querySelectorAll('iframe');
    for (const frame of frames) {
      if (frame.contentWindow?.PDFViewerApplication) {
        return frame.contentWindow.PDFViewerApplication;
      }
    }
  } catch (e) {
    // Cross-origin iframe
  }
  
  return null;
}

/**
 * Get current PDF page number from PDF.js viewer or Chrome native viewer
 * @returns {number} Current page number (1-indexed)
 */
function getCurrentPdfPage() {
  const pdfApp = getPdfJsApp();
  if (pdfApp?.page) {
    return pdfApp.page;
  }
  
  // Check for Chrome native PDF viewer page indicator
  // Chrome shows "1 / 15" format in a toolbar input
  const chromePageInput = document.querySelector('input[type="text"][aria-label*="Page"]') ||
                          document.querySelector('input#page-selector') ||
                          document.querySelector('cr-input');
  
  if (chromePageInput?.value) {
    const match = chromePageInput.value.match(/(\d+)/);
    if (match) return parseInt(match[1], 10);
  }
  
  // Fallback: look for page indicator in DOM
  const pageInput = document.getElementById('pageNumber') ||
                    document.querySelector('input[title*="Page"]') ||
                    document.querySelector('[class*="pageNumber"]');
  
  if (pageInput?.value) {
    return parseInt(pageInput.value, 10) || 1;
  }
  
  // Try to find page text like "1 / 15"
  const pageText = document.body.innerText?.match(/(\d+)\s*\/\s*\d+/);
  if (pageText) {
    return parseInt(pageText[1], 10) || 1;
  }
  
  return 1;
}

/**
 * Get total number of pages in PDF
 * @returns {number} Total page count
 */
function getTotalPdfPages() {
  const pdfApp = getPdfJsApp();
  if (pdfApp?.pagesCount) {
    return pdfApp.pagesCount;
  }
  
  // Check for Chrome native PDF viewer - look for "X / Y" format
  const pageText = document.body.innerText?.match(/\d+\s*\/\s*(\d+)/);
  if (pageText) {
    return parseInt(pageText[1], 10) || 1;
  }
  
  // Fallback: look for page count in DOM
  const pageCount = document.getElementById('numPages') ||
                    document.querySelector('[class*="numPages"]');
  
  if (pageCount?.textContent) {
    const match = pageCount.textContent.match(/(\d+)/);
    if (match) return parseInt(match[1], 10);
  }
  
  // Count page elements
  const pages = document.querySelectorAll('.page, [data-page-number]');
  if (pages.length > 0) return pages.length;
  
  return 1;
}

/**
 * Navigate to a specific page in PDF viewer and optionally copy text for search
 * Supports PDF.js and Chrome's native PDF viewer
 * @param {number} pageNumber - Page to navigate to (1-indexed)
 * @param {string} searchText - Optional text to copy to clipboard for Ctrl+F search
 * @returns {Promise<boolean>} Success
 */
async function navigateToPdfPage(pageNumber, searchText = null) {
  console.log('📄 Navigating to PDF page:', pageNumber, 'searchText:', searchText);
  
  const pdfInfo = detectPdfViewer();
  
  // If we have search text, copy it to clipboard for easy Ctrl+F
  if (searchText && searchText.length > 0) {
    try {
      // Get first ~50 chars for search (easier to find)
      const searchSnippet = searchText.slice(0, 50).trim();
      await navigator.clipboard.writeText(searchSnippet);
      console.log('📄 Copied to clipboard for search:', searchSnippet);
      
      // Show notification to user
      showPdfSearchNotification(pageNumber, searchSnippet);
    } catch (e) {
      console.warn('📄 Could not copy to clipboard:', e);
    }
  }
  
  // Chrome's native PDF viewer - use URL hash navigation with search
  if (pdfInfo.viewerType === 'chrome-native') {
    const baseUrl = window.location.href.split('#')[0];
    
    // Build URL with page and optional search parameter
    // Chrome PDF viewer supports: #page=N&search=text
    let targetUrl;
    if (searchText && searchText.length > 0) {
      // Use first few words for search (more reliable matching)
      const searchQuery = searchText.split(' ').slice(0, 6).join(' ');
      const encodedSearch = encodeURIComponent(searchQuery);
      targetUrl = `${baseUrl}#page=${pageNumber}&search=${encodedSearch}`;
      console.log('📄 Chrome PDF: navigating with search:', searchQuery);
    } else {
      targetUrl = `${baseUrl}#page=${pageNumber}`;
    }
    
    console.log('📄 Chrome PDF: navigating to', targetUrl);
    
    // Use chrome.tabs.update via background (most reliable)
    try {
      chrome.runtime.sendMessage({ 
        action: 'navigateTab', 
        url: targetUrl 
      });
      console.log('📄 Chrome PDF: requested navigation via background');
    } catch (e) {
      console.warn('📄 Background navigation failed:', e);
      // Fallback to direct navigation
      window.location.href = targetUrl;
    }
    
    return true;
  }
  
  // PDF.js viewer
  const pdfApp = getPdfJsApp();
  if (pdfApp?.page !== undefined) {
    pdfApp.page = pageNumber;
    // Wait for page to render
    await new Promise(r => setTimeout(r, 500));
    console.log('📄 PDF.js: navigated to page', pageNumber);
    return true;
  }
  
  // Fallback: try page input (some viewers have this)
  const pageInput = document.getElementById('pageNumber') ||
                    document.querySelector('input[title*="Page"]');
  
  if (pageInput) {
    pageInput.value = pageNumber;
    pageInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    console.log('📄 Input fallback: navigated to page', pageNumber);
    return true;
  }
  
  // Fallback: scroll to page element (for web-based PDF viewers)
  const pageElement = document.querySelector(`[data-page-number="${pageNumber}"]`) ||
                      document.querySelectorAll('.page')[pageNumber - 1];
  
  if (pageElement) {
    pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    await new Promise(r => setTimeout(r, 500));
    console.log('📄 Scroll fallback: scrolled to page element', pageNumber);
    return true;
  }
  
  // Last resort: try URL hash for any PDF
  try {
    const url = new URL(window.location.href);
    url.hash = `page=${pageNumber}`;
    window.location.href = url.toString();
    console.log('📄 URL hash fallback: navigated to page', pageNumber);
    return true;
  } catch (e) {
    console.warn('📄 Failed to navigate to page:', e);
  }
  
  return false;
}

/**
 * Get the scale factor of the PDF viewer
 * @returns {number} Scale factor (1.0 = 100%)
 */
function getPdfScale() {
  const pdfApp = getPdfJsApp();
  if (pdfApp?.pdfViewer?.currentScale) {
    return pdfApp.pdfViewer.currentScale;
  }
  
  // Fallback: try to read from scale selector
  const scaleSelect = document.getElementById('scaleSelect') ||
                      document.querySelector('[id*="zoom"]');
  
  if (scaleSelect?.value) {
    const val = parseFloat(scaleSelect.value);
    if (!isNaN(val)) return val;
  }
  
  return 1.0;
}

/**
 * Create highlight overlay on PDF page
 * @param {number} pageNumber - Page number (1-indexed)
 * @param {object} bbox - Bounding box {x0, y0, x1, y1} in PDF coordinates
 * @param {string} text - Text being highlighted
 * @returns {Element|null} The highlight element or null
 */
function createPdfHighlight(pageNumber, bbox, text) {
  // Find the page container
  const pageElement = document.querySelector(`[data-page-number="${pageNumber}"]`) ||
                      document.querySelectorAll('.page')[pageNumber - 1];
  
  if (!pageElement) {
    console.warn('📄 Could not find page element for page', pageNumber);
    return null;
  }
  
  // Get page dimensions and scale
  const scale = getPdfScale();
  const pageRect = pageElement.getBoundingClientRect();
  
  // Convert PDF coordinates to screen coordinates
  // PDF coordinates: origin at bottom-left, y increases upward
  // Screen coordinates: origin at top-left, y increases downward
  const { x0, y0, x1, y1, pageWidth, pageHeight } = bbox;
  
  // Calculate scaled positions
  const scaleX = pageRect.width / (pageWidth || 612);  // Default PDF width
  const scaleY = pageRect.height / (pageHeight || 792); // Default PDF height
  
  const left = x0 * scaleX;
  const width = (x1 - x0) * scaleX;
  // PDF y coordinates are from bottom, so we need to flip
  const top = pageRect.height - (y1 * scaleY);
  const height = (y1 - y0) * scaleY;
  
  // Create highlight element
  const highlight = document.createElement('div');
  highlight.className = 'pageguide-pdf-highlight';
  highlight.setAttribute('data-pageguide-styled', 'true');
  highlight.setAttribute('data-pdf-page', pageNumber);
  highlight.setAttribute('data-pdf-text', text);
  
  highlight.style.cssText = `
    position: absolute;
    left: ${left}px;
    top: ${top}px;
    width: ${width}px;
    height: ${height}px;
    background-color: ${PDF_CONFIG.highlightColor};
    border: ${PDF_CONFIG.highlightBorder};
    border-radius: 2px;
    pointer-events: none;
    z-index: 10;
    animation: pageguide-pdf-pulse 1.5s ease-in-out 3;
  `;
  
  // Ensure page container has relative positioning
  const pageStyle = window.getComputedStyle(pageElement);
  if (pageStyle.position === 'static') {
    pageElement.style.position = 'relative';
  }
  
  pageElement.appendChild(highlight);
  
  // Store reference for cleanup
  window._pageguidePdfHighlights = window._pageguidePdfHighlights || [];
  window._pageguidePdfHighlights.push(highlight);
  
  console.log('📄 Created PDF highlight on page', pageNumber, 'at', bbox);
  
  return highlight;
}

/**
 * Add CSS animation for PDF highlights
 */
function injectPdfHighlightStyles() {
  if (document.getElementById('pageguide-pdf-styles')) return;
  
  const style = document.createElement('style');
  style.id = 'pageguide-pdf-styles';
  style.textContent = `
    @keyframes pageguide-pdf-pulse {
      0%, 100% {
        background-color: rgba(255, 235, 59, 0.4);
        box-shadow: 0 0 0 0 rgba(255, 193, 7, 0.4);
      }
      50% {
        background-color: rgba(255, 235, 59, 0.7);
        box-shadow: 0 0 10px 5px rgba(255, 193, 7, 0.3);
      }
    }
    
    .pageguide-pdf-highlight {
      transition: opacity 0.3s ease;
    }
    
    .pageguide-pdf-highlight:hover {
      opacity: 0.8;
    }
    
    .pageguide-pdf-highlight-tooltip {
      position: absolute;
      background: #333;
      color: white;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
      max-width: 300px;
      z-index: 1000;
      pointer-events: none;
      white-space: pre-wrap;
    }
  `;
  
  document.head.appendChild(style);
}

/**
 * Clear all PDF highlights
 */
function clearPdfHighlights() {
  const highlights = window._pageguidePdfHighlights || [];
  
  highlights.forEach(el => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });
  
  window._pageguidePdfHighlights = [];
  
  // Also remove any orphaned highlights
  document.querySelectorAll('.pageguide-pdf-highlight').forEach(el => {
    el.parentNode?.removeChild(el);
  });
  
  console.log('📄 Cleared all PDF highlights');
}

/**
 * Highlight multiple bboxes on PDF pages
 * @param {Array<{page: number, bbox: object, text: string}>} highlights - Array of highlight specs
 * @returns {number} Number of highlights created
 */
async function applyPdfHighlights(highlights) {
  // Inject styles first
  injectPdfHighlightStyles();
  
  // Clear existing highlights
  clearPdfHighlights();
  
  if (!highlights || highlights.length === 0) {
    console.log('📄 No PDF highlights to apply');
    return 0;
  }
  
  let count = 0;
  const sortedHighlights = [...highlights].sort((a, b) => a.page - b.page);
  
  // Navigate to first highlight page
  const firstPage = sortedHighlights[0].page;
  await navigateToPdfPage(firstPage);
  
  // Wait for page render
  await new Promise(r => setTimeout(r, 300));
  
  // Apply all highlights
  for (const hl of sortedHighlights) {
    const element = createPdfHighlight(hl.page, hl.bbox, hl.text);
    if (element) {
      count++;
    }
  }
  
  // Scroll first highlight into view
  const firstHighlight = window._pageguidePdfHighlights?.[0];
  if (firstHighlight) {
    firstHighlight.scrollIntoView({ 
      behavior: 'smooth', 
      block: 'center' 
    });
  }
  
  console.log('📄 Applied', count, 'PDF highlights');
  return count;
}

/**
 * Get visible text from PDF page (for sending to backend)
 * Uses text layer from PDF.js if available
 * @param {number} pageNumber - Page number (1-indexed), or null for all visible pages
 * @returns {string} Extracted text
 */
function getPdfPageText(pageNumber = null) {
  let textLayers;
  
  if (pageNumber) {
    const pageEl = document.querySelector(`[data-page-number="${pageNumber}"]`) ||
                   document.querySelectorAll('.page')[pageNumber - 1];
    textLayers = pageEl ? [pageEl.querySelector('.textLayer')] : [];
  } else {
    textLayers = document.querySelectorAll('.textLayer');
  }
  
  const texts = [];
  
  textLayers.forEach((layer, idx) => {
    if (!layer) return;
    
    const pageNum = pageNumber || idx + 1;
    const spans = layer.querySelectorAll('span');
    const pageText = Array.from(spans)
      .map(span => span.textContent)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    if (pageText) {
      texts.push(`[Page ${pageNum}]\n${pageText}`);
    }
  });
  
  return texts.join('\n\n');
}

/**
 * Get PDF URL for backend processing
 * @returns {string|null} PDF URL or null
 */
function getPdfUrl() {
  // Check URL directly
  const url = window.location.href;
  
  if (url.toLowerCase().includes('.pdf')) {
    return url;
  }
  
  // Check for PDF.js loaded URL
  const pdfApp = getPdfJsApp();
  if (pdfApp?.url) {
    return pdfApp.url;
  }
  
  // Check for embedded PDF
  const embeddedPdf = document.querySelector('iframe[src*=".pdf"]') ||
                      document.querySelector('object[data*=".pdf"]') ||
                      document.querySelector('embed[src*=".pdf"]');
  
  if (embeddedPdf) {
    return embeddedPdf.src || embeddedPdf.getAttribute('data');
  }
  
  // Check Open button or download link for PDF URL
  const pdfLink = document.querySelector('a[href*=".pdf"]');
  if (pdfLink?.href) {
    return pdfLink.href;
  }
  
  return url; // Return current URL as fallback
}

console.log('📄 highlight_pdf.js loaded');
