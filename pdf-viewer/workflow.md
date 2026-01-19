# PDF Reader Workflow

## Overview

The XWebAgent PDF Reader allows users to upload PDFs, ask questions about them using AI, and get answers with clickable citations that highlight the exact text in the document.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        PDF Viewer Tab                           │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    viewer.html                           │   │
│  │  ┌─────────────┐  ┌────────────────────────────────┐   │   │
│  │  │ Upload Modal │  │     PDF Display (PDF.js)       │   │   │
│  │  │  - File      │  │  - Canvas rendering            │   │   │
│  │  │  - URL       │  │  - Text layer (invisible)      │   │   │
│  │  └─────────────┘  │  - Highlight overlays           │   │   │
│  │                    └────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              │ chrome.storage.session            │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              PDF Context (stored)                        │   │
│  │  - pdfName, pdfTotalPages                               │   │
│  │  - pdfText: [{page, text}, ...]                         │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ chrome.runtime.sendMessage
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Background Service Worker                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  - callLLM: Sends to Gemini/OpenRouter/OpenAI           │   │
│  │  - openSidePanel: Opens sidepanel on PDF viewer tab     │   │
│  │  - navigateTab: Tab navigation helper                   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Side Panel (Chat UI)                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  panel.html / panel.js                                   │   │
│  │  - Detects if on PDF viewer tab                         │   │
│  │  - Reads PDF context from storage                       │   │
│  │  - Sends question + PDF text to LLM                     │   │
│  │  - Parses citations [Page N: "quote"]                   │   │
│  │  - Click citation → navigate + highlight                │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## User Flow

### Step 1: Open PDF Reader

```
User clicks "📄 PDF Reader" button in sidepanel
         │
         ▼
chrome.tabs.create({ url: 'pdf-viewer/viewer.html' })
         │
         ▼
Upload modal appears with options:
  - Upload file from computer
  - Paste URL (arxiv, Google Drive, etc.)
```

### Step 2: Load PDF

```
User uploads file OR pastes URL
         │
         ▼
┌─────────────────────────────────────┐
│         loadPdf(data)               │
│  1. pdfjsLib.getDocument({ data })  │
│  2. Get total pages                 │
│  3. extractAllText() ────────────┐  │
│  4. renderAllPages()             │  │
│  5. storePdfContext() ◄──────────┘  │
└─────────────────────────────────────┘
         │
         ▼
PDF displayed with:
  - Page number labels
  - Zoom controls
  - Navigation controls
  - "Ask Questions" button
```

### Step 3: Extract Text

```
extractAllText()
         │
         ▼
For each page (1 to totalPages):
  ┌────────────────────────────────────┐
  │  page.getTextContent()             │
  │         │                          │
  │         ▼                          │
  │  items = [{                        │
  │    text: "word",                   │
  │    x, y: coordinates,              │
  │    width, height,                  │
  │    transform: [...]                │
  │  }, ...]                           │
  │         │                          │
  │         ▼                          │
  │  state.pdfText.push({              │
  │    page: pageNum,                  │
  │    text: concatenated text,        │
  │    items: position data            │
  │  })                                │
  └────────────────────────────────────┘
```

### Step 4: Store Context for Sidepanel

```
storePdfContext()
         │
         ▼
chrome.storage.session.set({
  pdfViewerActive: true,
  pdfName: "document.pdf",
  pdfTotalPages: 15,
  pdfText: [
    { page: 1, text: "..." },
    { page: 2, text: "..." },
    ...
  ]
})
```

### Step 5: User Asks Question

```
User clicks "💬 Ask Questions" → Opens sidepanel
         │
         ▼
User types: "What is the main contribution?"
         │
         ▼
sendMessage() in panel.js
         │
         ▼
┌─────────────────────────────────────────┐
│  Check if on PDF viewer tab:            │
│  currentTab.url.includes('pdf-viewer')  │
│         │                               │
│         ▼ YES                           │
│  Read PDF context from storage          │
│         │                               │
│         ▼                               │
│  handlePdfQuestion(query, pdfContext)   │
└─────────────────────────────────────────┘
```

### Step 6: LLM Request

```
handlePdfQuestion(query, pdfContext)
         │
         ▼
Build system prompt:
┌─────────────────────────────────────────────────┐
│  "You are a helpful assistant that answers      │
│   questions about PDF documents.                │
│   When answering, ALWAYS cite specific          │
│   passages using: [Page N: "exact quote"]       │
│                                                 │
│   PDF Content:                                  │
│   [Page 1]                                      │
│   First page text...                            │
│   [Page 2]                                      │
│   Second page text...                           │
│   ..."                                          │
└─────────────────────────────────────────────────┘
         │
         ▼
chrome.runtime.sendMessage({
  action: 'callLLM',
  messages: [{ role: 'user', content: query }],
  systemPrompt: systemPrompt
})
         │
         ▼
Background service worker → LLM API
         │
         ▼
Response: "The main contribution is... 
           [Page 1: "We propose a novel method..."]"
```

### Step 7: Parse & Display Response

```
LLM Response received
         │
         ▼
parseCitations(response)
         │
         ▼
Regex: /\[Page\s*(\d+):\s*["']([^"']+)["']\]/gi
         │
         ▼
Creates clickable citation spans:
<span class="xwebagent-pdf-citation" 
      data-page="1" 
      data-text="We propose a novel method...">
  📄 We propose a novel method...
</span>
```

### Step 8: Click Citation → Navigate & Highlight

```
User clicks citation
         │
         ▼
┌─────────────────────────────────────────────┐
│  Get page number and quote text             │
│  pageNum = citation.dataset.page            │
│  searchText = citation.dataset.text         │
│         │                                   │
│         ▼                                   │
│  Find PDF viewer tab                        │
│  chrome.tabs.query({})                      │
│         │                                   │
│         ▼                                   │
│  Send message to PDF viewer:                │
│  chrome.tabs.sendMessage(pdfViewerTab.id, { │
│    action: 'navigateToPdfPage',             │
│    page: pageNum,                           │
│    searchText: searchText                   │
│  })                                         │
│         │                                   │
│         ▼                                   │
│  Focus PDF viewer tab                       │
└─────────────────────────────────────────────┘
```

### Step 9: Highlight Text in PDF

```
PDF Viewer receives navigateToPdfPage message
         │
         ▼
goToPage(pageNum)
  - Scroll page into view
         │
         ▼
highlightText(pageNum, searchText)
         │
         ▼
┌─────────────────────────────────────────────────┐
│  1. Get text layer spans                        │
│  2. Concatenate all span text                   │
│  3. Track span positions: [{span, start, end}]  │
│         │                                       │
│         ▼                                       │
│  4. Find exact quote in concatenated text       │
│     matchStart = fullText.indexOf(searchText)   │
│         │                                       │
│         ▼                                       │
│  5. Find spans overlapping match position       │
│     for each span:                              │
│       if (span.end > matchStart &&              │
│           span.start < matchEnd)                │
│         → Add to matchingSpans                  │
│         │                                       │
│         ▼                                       │
│  6. Create highlight overlays                   │
│     - Group consecutive spans into regions      │
│     - Create yellow highlight divs              │
│     - Position using getBoundingClientRect()    │
│         │                                       │
│         ▼                                       │
│  7. Scroll first match into view                │
└─────────────────────────────────────────────────┘
```

---

## File Structure

```
pdf-viewer/
├── viewer.html      # Main HTML with upload modal & PDF container
├── viewer.css       # Styles for viewer, highlights, controls
├── viewer.js        # PDF loading, rendering, highlighting logic
└── workflow.md      # This documentation

sidepanel/
├── panel.html       # Chat UI structure
├── panel.js         # Chat logic, PDF detection, citation handling
└── panel.css        # Chat styling

background/
└── service-worker.js  # LLM calls, message routing

lib/
├── pdf.min.js       # PDF.js library
└── pdf.worker.min.js # PDF.js web worker
```

---

## Key Functions

### viewer.js

| Function | Purpose |
|----------|---------|
| `loadPdf(data)` | Load PDF from ArrayBuffer |
| `extractAllText()` | Extract text from all pages |
| `renderAllPages()` | Render PDF pages to canvas |
| `renderPage(pageNum)` | Render single page with text layer |
| `storePdfContext()` | Save PDF text to session storage |
| `highlightText(pageNum, searchText)` | Create highlight overlays |
| `goToPage(pageNum)` | Navigate to specific page |

### panel.js

| Function | Purpose |
|----------|---------|
| `sendMessage()` | Handle user query |
| `handlePdfQuestion(query, ctx)` | Call LLM with PDF context |
| `parseCitations(text)` | Convert `[Page N: "..."]` to clickable spans |
| `addMessage(content, type)` | Add message to chat UI |

---

## Citation Format

The LLM is instructed to use this format:

```
[Page N: "exact quote from the document"]
```

Examples:
- `[Page 1: "We propose a novel attention mechanism"]`
- `[Page 5: "Results show 15% improvement over baseline"]`

---

## Highlighting Algorithm

```
Input: searchText = "We propose a novel attention mechanism"
       pageNum = 1

1. Get all spans from text layer
   spans = [<span>We</span>, <span>propose</span>, ...]

2. Concatenate span texts
   fullText = "We propose a novel attention mechanism that..."
   positions = [{span: span0, start: 0, end: 2}, 
                {span: span1, start: 3, end: 10}, ...]

3. Find exact match
   matchStart = fullText.indexOf("We propose a novel attention mechanism")
   matchStart = 0
   matchEnd = 38

4. Find overlapping spans
   spans where: span.end > 0 AND span.start < 38
   → spans 0, 1, 2, 3, 4, 5

5. Get bounding rectangles
   For each span: getBoundingClientRect()

6. Group into regions (by line)
   Region 1: spans on same line → merge bounds

7. Create highlight divs
   <div class="pdf-highlight" style="left:X; top:Y; width:W; height:H">

8. Scroll into view
   firstSpan.scrollIntoView({ behavior: 'smooth', block: 'center' })
```

---

## Error Handling

| Scenario | Handling |
|----------|----------|
| PDF load fails | Show alert, return to upload modal |
| Storage quota exceeded | Trim text to 5000 chars/page |
| Exact match not found | Try first 50 chars, then 30 chars |
| No matches at all | Fallback to keyword search (words > 6 chars) |
| PDF viewer tab not found | Send to content script instead |

---

## Browser APIs Used

- `chrome.storage.session` - Store PDF context
- `chrome.tabs.query` - Find PDF viewer tab
- `chrome.tabs.sendMessage` - Send navigation messages
- `chrome.runtime.sendMessage` - LLM calls
- `chrome.sidePanel.open` - Open sidepanel
- `pdfjsLib` - PDF parsing and rendering
