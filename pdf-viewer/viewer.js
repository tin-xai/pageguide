/**
 * PageGuide PDF Viewer
 * Full-screen PDF viewer that works with the sidepanel chat
 */

// State
const state = {
  pdfDoc: null,
  currentPage: 1,
  totalPages: 0,
  scale: 1.5,
  pdfText: [], // Array of {page, text, items} for each page
  highlights: [],
  pdfUrl: null,
  pdfName: 'Document'
};

// DOM Elements
const elements = {};

// Initialize
document.addEventListener('DOMContentLoaded', init);

function init() {
  // Cache DOM elements
  elements.uploadModal = document.getElementById('upload-modal');
  elements.mainViewer = document.getElementById('main-viewer');
  elements.fileInput = document.getElementById('file-input');
  elements.urlInput = document.getElementById('url-input');
  elements.loadUrlBtn = document.getElementById('load-url-btn');
  elements.fileUploadOption = document.getElementById('file-upload-option');
  elements.pdfContainer = document.getElementById('pdf-container');
  elements.pdfPages = document.getElementById('pdf-pages');
  elements.pdfLoading = document.getElementById('pdf-loading');
  elements.pdfTitle = document.getElementById('pdf-title');
  elements.pdfStatus = document.getElementById('pdf-status');
  elements.pageInfo = document.getElementById('page-info');
  elements.zoomLevel = document.getElementById('zoom-level');
  elements.backBtn = document.getElementById('back-btn');
  elements.openSidepanel = document.getElementById('open-sidepanel');
  
  // Set PDF.js worker
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
  }
  
  setupEventListeners();
  setupMessageListener();
  checkUrlParams();
}

function setupEventListeners() {
  // File upload
  elements.fileUploadOption.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', handleFileUpload);
  
  // Drag and drop
  elements.fileUploadOption.addEventListener('dragover', handleDragOver);
  elements.fileUploadOption.addEventListener('dragleave', handleDragLeave);
  elements.fileUploadOption.addEventListener('drop', handleDrop);
  
  // URL load
  elements.loadUrlBtn.addEventListener('click', handleUrlLoad);
  elements.urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleUrlLoad();
  });
  
  // Navigation
  elements.backBtn.addEventListener('click', showUploadModal);
  document.getElementById('prev-page').addEventListener('click', () => goToPage(state.currentPage - 1));
  document.getElementById('next-page').addEventListener('click', () => goToPage(state.currentPage + 1));
  
  // Zoom
  document.getElementById('zoom-in').addEventListener('click', () => setZoom(state.scale + 0.25));
  document.getElementById('zoom-out').addEventListener('click', () => setZoom(state.scale - 0.25));
  
  // Open sidepanel button
  elements.openSidepanel.addEventListener('click', openSidepanel);
  
  // Scroll tracking
  elements.pdfContainer.addEventListener('scroll', updateCurrentPage);
  
  // Click on PDF to clear highlights
  elements.pdfPages.addEventListener('click', (e) => {
    // Only clear if clicking on the PDF itself, not on controls
    if (state.highlights.length > 0) {
      clearHighlights();
    }
  });
}

// Listen for messages from sidepanel to navigate/highlight
function setupMessageListener() {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('📄 PDF Viewer received message:', request);
    
    if (request.action === 'navigateToPdfPage') {
      const { page, searchText } = request;
      goToPage(page);
      if (searchText) {
        setTimeout(() => highlightText(page, searchText), 300);
      }
      sendResponse({ success: true });
      return true;
    }
    
    if (request.action === 'highlightByIndex') {
      const { startIdx, endIdx } = request;
      highlightByRanges([{ start: startIdx, end: endIdx }]);
      sendResponse({ success: true });
      return true;
    }
    
    if (request.action === 'highlightByRanges') {
      const { ranges } = request;
      highlightByRanges(ranges);
      sendResponse({ success: true });
      return true;
    }
    
    if (request.action === 'getPdfContext') {
      // Return PDF text for sidepanel to use
      sendResponse({
        success: true,
        pdfName: state.pdfName,
        totalPages: state.totalPages,
        pdfText: state.pdfText
      });
      return true;
    }
    
    if (request.action === 'clearPdfHighlights') {
      clearHighlights();
      sendResponse({ success: true });
      return true;
    }
  });
}

function openSidepanel() {
  chrome.runtime.sendMessage({ action: 'openSidePanel' });
}

function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const url = params.get('url');
  if (url) {
    elements.urlInput.value = url;
    handleUrlLoad();
  }
}

// File handling
function handleFileUpload(e) {
  const file = e.target.files[0];
  if (file && file.type === 'application/pdf') {
    loadPdfFromFile(file);
  }
}

function handleDragOver(e) {
  e.preventDefault();
  elements.fileUploadOption.classList.add('dragging');
}

function handleDragLeave(e) {
  e.preventDefault();
  elements.fileUploadOption.classList.remove('dragging');
}

function handleDrop(e) {
  e.preventDefault();
  elements.fileUploadOption.classList.remove('dragging');
  
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') {
    loadPdfFromFile(file);
  }
}

function handleUrlLoad() {
  const url = elements.urlInput.value.trim();
  if (!url) return;
  
  // Transform URLs if needed
  let pdfUrl = url;
  
  // Handle arxiv URLs
  if (url.includes('arxiv.org/abs/')) {
    pdfUrl = url.replace('/abs/', '/pdf/') + '.pdf';
  }
  
  // Handle Google Drive URLs
  if (url.includes('drive.google.com')) {
    const match = url.match(/\/d\/([^/]+)/);
    if (match) {
      pdfUrl = `https://drive.google.com/uc?export=download&id=${match[1]}`;
    }
  }
  
  loadPdfFromUrl(pdfUrl);
}

// PDF Loading
async function loadPdfFromFile(file) {
  state.pdfName = file.name;
  const arrayBuffer = await file.arrayBuffer();
  await loadPdf(arrayBuffer);
}

async function loadPdfFromUrl(url) {
  showViewer();
  showLoading(true);
  
  try {
    // Extract filename from URL
    const urlParts = url.split('/');
    state.pdfName = urlParts[urlParts.length - 1].split('?')[0] || 'Document';
    state.pdfUrl = url;
    
    // Fetch PDF
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch PDF: ${response.status}`);
    
    const arrayBuffer = await response.arrayBuffer();
    await loadPdf(arrayBuffer);
  } catch (error) {
    console.error('Failed to load PDF from URL:', error);
    alert('Failed to load PDF. Please check the URL and try again.');
    showUploadModal();
  }
}

async function loadPdf(data) {
  showViewer();
  showLoading(true);
  
  try {
    // Load PDF document
    const loadingTask = pdfjsLib.getDocument({ data });
    state.pdfDoc = await loadingTask.promise;
    state.totalPages = state.pdfDoc.numPages;
    state.currentPage = 1;
    
    elements.pdfTitle.textContent = state.pdfName;
    updatePageInfo();
    
    // Extract text from all pages
    await extractAllText();
    
    // Render all pages
    await renderAllPages();
    
    showLoading(false);
    
    // Update status
    const totalChars = state.pdfText.reduce((sum, p) => sum + p.text.length, 0);
    elements.pdfStatus.textContent = `✓ ${state.totalPages} pages • ${Math.round(totalChars/1000)}k chars`;
    
    // Store PDF context for sidepanel access
    storePdfContext();
    
    console.log('📄 PDF loaded:', state.pdfName, state.totalPages, 'pages');
    
  } catch (error) {
    console.error('Failed to load PDF:', error);
    alert('Failed to load PDF. The file may be corrupted or password-protected.');
    showUploadModal();
  }
}

// Store PDF context in session storage for sidepanel
async function storePdfContext() {
  try {
    // Limit text per page to avoid quota issues (session storage has ~10MB limit)
    const maxCharsPerPage = 8000;
    const trimmedPdfText = state.pdfText.map(p => ({
      page: p.page,
      text: p.text.slice(0, maxCharsPerPage),
      indexedText: p.indexedText?.slice(0, maxCharsPerPage * 2) // Indexed text is larger
      // items stored locally in state.pdfText for highlighting
    }));
    
    const dataToStore = {
      pdfViewerActive: true,
      pdfName: state.pdfName,
      pdfTotalPages: state.totalPages,
      pdfText: trimmedPdfText
    };
    
    console.log('📄 Storing PDF context:', state.pdfName, trimmedPdfText.length, 'pages');
    
    await chrome.storage.session.set(dataToStore);
    
    // Verify it was stored
    const stored = await chrome.storage.session.get(['pdfText']);
    console.log('📄 PDF context stored successfully:', stored.pdfText?.length, 'pages');
  } catch (e) {
    console.error('Failed to store PDF context:', e);
    // Try with even smaller data
    try {
      const minimalText = state.pdfText.map(p => ({
        page: p.page,
        text: p.text.slice(0, 2000)
      }));
      await chrome.storage.session.set({
        pdfViewerActive: true,
        pdfName: state.pdfName,
        pdfTotalPages: state.totalPages,
        pdfText: minimalText
      });
      console.log('📄 PDF context stored (minimal mode)');
    } catch (e2) {
      console.error('Failed to store even minimal PDF context:', e2);
    }
  }
}

async function clearPdfContext() {
  try {
    await chrome.storage.session.remove(['pdfViewerActive', 'pdfName', 'pdfTotalPages', 'pdfText']);
  } catch (e) {
    console.warn('Failed to clear PDF context:', e);
  }
}

async function extractAllText() {
  state.pdfText = [];
  let globalIndex = 0; // Global index across all pages
  
  for (let i = 1; i <= state.totalPages; i++) {
    const page = await state.pdfDoc.getPage(i);
    const textContent = await page.getTextContent();
    
    const items = textContent.items.map(item => {
      globalIndex++;
      return {
        index: globalIndex, // Unique index for this text item
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height,
        transform: item.transform
      };
    });
    
    // Create indexed text format: "[1]Hello [2]World [3]92"
    const indexedText = items
      .filter(item => item.text.trim().length > 0)
      .map(item => `[${item.index}]${item.text}`)
      .join(' ');
    
    const text = items.map(item => item.text).join(' ');
    
    state.pdfText.push({
      page: i,
      text: text,
      indexedText: indexedText, // Text with indices for LLM
      items: items
    });
  }
  
  console.log('📄 Extracted', globalIndex, 'indexed text items from', state.totalPages, 'pages');
}

async function renderAllPages() {
  elements.pdfPages.innerHTML = '';
  state.highlights = []; // DOM was cleared; drop stale references

  for (let i = 1; i <= state.totalPages; i++) {
    await renderPage(i);
  }
}

async function renderPage(pageNum) {
  try {
    const page = await state.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: state.scale });
    
    // Create page wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrapper';
    wrapper.dataset.pageNumber = pageNum;
    wrapper.style.width = `${viewport.width}px`;
    wrapper.style.height = `${viewport.height}px`;
    
    // Add page number label
    const pageLabel = document.createElement('div');
    pageLabel.className = 'page-number-label';
    pageLabel.textContent = `Page ${pageNum}`;
    wrapper.appendChild(pageLabel);
    
    // Create canvas
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    // Render PDF page
    await page.render({
      canvasContext: context,
      viewport: viewport
    }).promise;
    
    wrapper.appendChild(canvas);
    
    console.log(`📄 Rendered page ${pageNum}/${state.totalPages}`);
    
    // Create text layer for selection
    const textLayer = document.createElement('div');
    textLayer.className = 'text-layer';
    
    const textContent = await page.getTextContent();
    
    textContent.items.forEach(item => {
      const span = document.createElement('span');
      span.textContent = item.str;
      
      // Position the text span
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);
      
      span.style.left = `${tx[4]}px`;
      span.style.top = `${tx[5] - fontSize}px`;
      span.style.fontSize = `${fontSize}px`;
      span.style.fontFamily = item.fontName || 'sans-serif';
      
      // Store original position data
      span.dataset.x = item.transform[4];
      span.dataset.y = item.transform[5];
      span.dataset.text = item.str;
      
      textLayer.appendChild(span);
    });
    
    wrapper.appendChild(textLayer);
    elements.pdfPages.appendChild(wrapper);
  } catch (error) {
    console.error(`Failed to render page ${pageNum}:`, error);
  }
}

// Navigation
function goToPage(pageNum) {
  if (pageNum < 1 || pageNum > state.totalPages) return;
  
  state.currentPage = pageNum;
  updatePageInfo();
  
  const pageElement = elements.pdfPages.querySelector(`[data-page-number="${pageNum}"]`);
  if (pageElement) {
    pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function updateCurrentPage() {
  const pages = elements.pdfPages.querySelectorAll('.pdf-page-wrapper');
  const containerRect = elements.pdfContainer.getBoundingClientRect();
  
  for (const page of pages) {
    const pageRect = page.getBoundingClientRect();
    if (pageRect.top <= containerRect.top + containerRect.height / 2 &&
        pageRect.bottom >= containerRect.top) {
      state.currentPage = parseInt(page.dataset.pageNumber);
      updatePageInfo();
      break;
    }
  }
}

function updatePageInfo() {
  elements.pageInfo.textContent = `${state.currentPage} / ${state.totalPages}`;
}

// Zoom
async function setZoom(newScale) {
  if (newScale < 0.5 || newScale > 3) return;

  const savedPage = state.currentPage;
  state.scale = newScale;
  elements.zoomLevel.textContent = `${Math.round(newScale * 100)}%`;

  // Re-render all pages (also clears state.highlights)
  await renderAllPages();

  // Restore scroll to the page that was visible before zoom
  const pageEl = elements.pdfPages.querySelector(`[data-page-number="${savedPage}"]`);
  if (pageEl) {
    pageEl.scrollIntoView({ behavior: 'instant', block: 'start' });
  }
}

// Normalize text for matching (collapse whitespace, remove special chars)
function normalizeForMatch(text) {
  return text
    .toLowerCase()
    .replace(/[\n\r\t]+/g, ' ')  // Newlines/tabs to space
    .replace(/\s+/g, ' ')         // Collapse whitespace
    .replace(/[^\w\s]/g, '')      // Remove punctuation
    .trim();
}

// Highlighting - uses PDF text item coordinates for precise bounding boxes
async function highlightText(pageNum, searchText) {
  console.log('📍 Highlighting on page', pageNum, ':', searchText);
  
  // Clear existing highlights
  clearHighlights();
  
  const pageWrapper = elements.pdfPages.querySelector(`[data-page-number="${pageNum}"]`);
  if (!pageWrapper) {
    console.warn('Page wrapper not found for page', pageNum);
    return;
  }
  
  // Get page data with text items (has coordinates)
  const pageData = state.pdfText.find(p => p.page === pageNum);
  if (!pageData || !pageData.items) {
    console.warn('No text items for page', pageNum);
    pageWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  
  // Get canvas height for Y-axis flip (PDF origin is bottom-left)
  const canvas = pageWrapper.querySelector('canvas');
  const canvasHeight = canvas ? canvas.height : 800;
  
  // Build concatenated text from items with position mapping
  let fullText = '';
  const itemPositions = []; // {item, start, end}
  
  for (const item of pageData.items) {
    itemPositions.push({
      item: item,
      start: fullText.length,
      end: fullText.length + item.text.length
    });
    fullText += item.text + ' ';
  }
  
  // Normalize both texts for matching
  const fullTextNorm = normalizeForMatch(fullText);
  const searchNorm = normalizeForMatch(searchText);
  
  console.log('📍 Search:', searchNorm.slice(0, 50) + '...');
  
  // Find match in normalized text
  let matchStart = fullTextNorm.indexOf(searchNorm);
  let searchLen = searchNorm.length;
  
  // Try progressively shorter prefixes
  const prefixLengths = [80, 50, 30, 20, 12];
  for (const prefixLen of prefixLengths) {
    if (matchStart !== -1) break;
    if (searchNorm.length >= prefixLen) {
      const prefix = searchNorm.slice(0, prefixLen);
      matchStart = fullTextNorm.indexOf(prefix);
      if (matchStart !== -1) {
        searchLen = prefix.length;
        console.log('📍 Matched with prefix length:', prefixLen);
      }
    }
  }
  
  let matchingItems = [];
  
  if (matchStart !== -1) {
    const matchEnd = matchStart + searchLen;
    
    // Map normalized position back to original items
    // We need to track normalized positions for each item
    let normPos = 0;
    for (const pos of itemPositions) {
      const itemNorm = normalizeForMatch(pos.item.text);
      const itemNormEnd = normPos + itemNorm.length;
      
      // Check if this item overlaps with the match range
      if (itemNormEnd > matchStart && normPos < matchEnd) {
        matchingItems.push(pos.item);
      }
      
      normPos = itemNormEnd + 1; // +1 for space
    }
    
    console.log('📍 Found', matchingItems.length, 'matching items');
  } else {
    console.warn('📍 No substring match, trying keywords');
    
    // Fallback: find items with unique long words
    const words = searchNorm.split(/\s+/).filter(w => w.length > 6);
    const uniqueWords = [...new Set(words)].slice(0, 3);
    
    for (const item of pageData.items) {
      const itemNorm = normalizeForMatch(item.text);
      if (uniqueWords.some(word => itemNorm.includes(word))) {
        matchingItems.push(item);
      }
    }
  }
  
  // Create highlights using viewport-transformed coordinates
  if (matchingItems.length > 0) {
    // Get the PDF page to access viewport transform
    const page = await state.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: state.scale });
    
    // Calculate bounding boxes for all items
    const boxes = matchingItems.map(item => {
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);
      
      const x = tx[4];
      const y = tx[5] - fontSize;
      const width = item.width ? item.width * state.scale : item.text.length * fontSize * 0.6;
      const height = fontSize * 1.2;
      
      return { x, y, width: Math.max(width, 15), height };
    });
    
    // Sort by y position (line), then x position
    boxes.sort((a, b) => {
      const yDiff = a.y - b.y;
      if (Math.abs(yDiff) > 5) return yDiff; // Different lines
      return a.x - b.x; // Same line, sort by x
    });
    
    // Merge consecutive boxes on the same line
    const mergedBoxes = [];
    for (const box of boxes) {
      const lastBox = mergedBoxes[mergedBoxes.length - 1];
      
      // Check if can merge: same line (similar y) and adjacent (close x)
      if (lastBox && 
          Math.abs(box.y - lastBox.y) < 5 && 
          box.x <= lastBox.x + lastBox.width + 10) {
        // Merge: extend the last box
        const newRight = Math.max(lastBox.x + lastBox.width, box.x + box.width);
        lastBox.width = newRight - lastBox.x;
        lastBox.height = Math.max(lastBox.height, box.height);
      } else {
        // New box
        mergedBoxes.push({ ...box });
      }
    }
    
    // Create highlight elements for merged boxes
    for (const box of mergedBoxes) {
      const highlight = document.createElement('div');
      highlight.className = 'pdf-highlight';
      highlight.style.left = `${box.x - 2}px`;
      highlight.style.top = `${box.y - 2}px`;
      highlight.style.width = `${box.width + 4}px`;
      highlight.style.height = `${box.height + 4}px`;
      
      pageWrapper.appendChild(highlight);
      state.highlights.push(highlight);
    }
    
    // Scroll to first highlight
    if (state.highlights.length > 0) {
      state.highlights[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    
    console.log('📍 Created', state.highlights.length, 'merged highlights');
  } else {
    // No matches - just scroll to page
    pageWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    console.warn('📍 No matching items found');
  }
}

// Highlight by multiple index ranges - precise and fast!
async function highlightByRanges(ranges) {
  console.log('📍 Highlighting ranges:', ranges);
  
  clearHighlights();
  
  // Find all items matching any of the ranges
  const matchingItems = [];
  let targetPage = null;
  
  for (const pageData of state.pdfText) {
    for (const item of pageData.items) {
      // Check if item index falls within any range
      for (const range of ranges) {
        if (item.index >= range.start && item.index <= range.end) {
          matchingItems.push({ ...item, page: pageData.page });
          if (!targetPage) targetPage = pageData.page;
          break; // Don't add same item twice
        }
      }
    }
  }
  
  if (matchingItems.length === 0) {
    console.warn('📍 No items found for ranges:', ranges);
    return;
  }
  
  console.log('📍 Found', matchingItems.length, 'items across ranges, first page:', targetPage);
  
  // Navigate to the first page with matches
  goToPage(targetPage);
  
  // Group items by page
  const itemsByPage = {};
  for (const item of matchingItems) {
    if (!itemsByPage[item.page]) itemsByPage[item.page] = [];
    itemsByPage[item.page].push(item);
  }
  
  // Create highlights for each page
  for (const [pageNum, items] of Object.entries(itemsByPage)) {
    const pageWrapper = elements.pdfPages.querySelector(`[data-page-number="${pageNum}"]`);
    if (!pageWrapper) continue;
    
    // Get viewport for coordinate transform
    const page = await state.pdfDoc.getPage(parseInt(pageNum));
    const viewport = page.getViewport({ scale: state.scale });
    
    // Calculate bounding boxes for all items
    const boxes = items.map(item => {
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);
      
      const x = tx[4];
      const y = tx[5] - fontSize;
      const width = item.width ? item.width * state.scale : item.text.length * fontSize * 0.6;
      const height = fontSize * 1.2;
      
      return { x, y, width: Math.max(width, 15), height, index: item.index };
    });
    
    // Sort by y position (line), then x position
    boxes.sort((a, b) => {
      const yDiff = a.y - b.y;
      if (Math.abs(yDiff) > 5) return yDiff; // Different lines
      return a.x - b.x; // Same line, sort by x
    });
    
    // Merge consecutive boxes on the same line
    const mergedBoxes = [];
    for (const box of boxes) {
      const lastBox = mergedBoxes[mergedBoxes.length - 1];
      
      // Check if can merge: same line (similar y) and adjacent (close x)
      if (lastBox && 
          Math.abs(box.y - lastBox.y) < 5 && 
          box.x <= lastBox.x + lastBox.width + 10) {
        // Merge: extend the last box
        const newRight = Math.max(lastBox.x + lastBox.width, box.x + box.width);
        lastBox.width = newRight - lastBox.x;
        lastBox.height = Math.max(lastBox.height, box.height);
      } else {
        // New box
        mergedBoxes.push({ ...box });
      }
    }
    
    // Create highlight elements for merged boxes
    for (const box of mergedBoxes) {
      const highlight = document.createElement('div');
      highlight.className = 'pdf-highlight';
      highlight.style.left = `${box.x - 2}px`;
      highlight.style.top = `${box.y - 2}px`;
      highlight.style.width = `${box.width + 4}px`;
      highlight.style.height = `${box.height + 4}px`;
      
      pageWrapper.appendChild(highlight);
      state.highlights.push(highlight);
    }
  }
  
  // Scroll to first highlight
  if (state.highlights.length > 0) {
    state.highlights[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  
  console.log('📍 Created', state.highlights.length, 'highlights across', Object.keys(itemsByPage).length, 'pages');
}

function clearHighlights() {
  for (const highlight of state.highlights) {
    highlight.remove();
  }
  state.highlights = [];
}

// UI Helpers
function showViewer() {
  elements.uploadModal.classList.remove('active');
  elements.mainViewer.classList.remove('hidden');
}

function showUploadModal() {
  elements.uploadModal.classList.add('active');
  elements.mainViewer.classList.add('hidden');
  
  // Reset state
  state.pdfDoc = null;
  state.pdfText = [];
  state.highlights = [];
  elements.pdfPages.innerHTML = '';
  elements.pdfStatus.textContent = '';
  
  clearPdfContext();
}

function showLoading(show) {
  if (show) {
    elements.pdfLoading.style.display = 'flex';
    elements.pdfPages.style.display = 'none';
  } else {
    elements.pdfLoading.style.display = 'none';
    elements.pdfPages.style.display = 'flex';
  }
}
