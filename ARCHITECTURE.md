# XWebAgent Extension - Architecture

## Overview

XWebAgent is a Chrome extension that provides an AI-powered web assistant. Users can ask questions about page content, get step-by-step guidance, and detect unsafe content.

## Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER INTERACTION                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SIDE PANEL (sidepanel/)                              │
│  panel.html → panel.js                                                       │
│  - Chat UI                                                                   │
│  - User input                                                                │
│  - Message display                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                          chrome.tabs.sendMessage()
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CONTENT SCRIPTS (content/)                             │
│                                                                              │
│  ┌─────────────┐                                                             │
│  │ content.js  │ ← Entry point, message router                               │
│  └──────┬──────┘                                                             │
│         │                                                                    │
│         ▼                                                                    │
│  ┌─────────────┐     ┌──────────────┐     ┌────────────────┐                │
│  │   api.js    │────▶│  prompts.js  │     │  protection.js │                │
│  │             │     │  (LLM prompts)│     │  (Safety scan) │                │
│  │ - routeQuery│     └──────────────┘     └────────────────┘                │
│  │ - handleAsk │                                                             │
│  │ - handleGuide                                                             │
│  └──────┬──────┘                                                             │
│         │                                                                    │
│         ▼                                                                    │
│  ┌─────────────┐     ┌──────────────┐                                       │
│  │  utils.js   │     │  actions.js  │                                       │
│  │ - DOM utils │     │ - expandContent                                       │
│  │ - Highlights│     └──────────────┘                                       │
│  │ - Page index│                                                             │
│  └─────────────┘                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                          chrome.runtime.sendMessage()
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    BACKGROUND SERVICE WORKER (background/)                   │
│  service-worker.js                                                           │
│  - LLM API calls (Gemini, OpenRouter, OpenAI)                               │
│  - Screenshot capture                                                        │
│  - Side panel management                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Query Flow

```
User types query
       │
       ▼
┌──────────────┐
│  panel.js    │  sendMessage()
└──────┬───────┘
       │ chrome.tabs.sendMessage({action: 'handleQuery', query})
       ▼
┌──────────────┐
│  content.js  │  handleMessage() → switch(action)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   api.js     │  handleSmartQuery(query, history)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  routeQuery  │  LLM classifies: ask | guide | protection
└──────┬───────┘
       │
       ├─── "ask" ──────▶ handleAsk() → Answer + highlights
       │
       ├─── "guide" ────▶ handleStepByStepGuide() → Step-by-step tutorial
       │
       └─── "protection" ▶ handleProtectionQuery() → Scan & blur unsafe content
```

## File Descriptions

### `/manifest.json`
Chrome extension manifest (v3). Defines permissions, content scripts, side panel, and service worker.

---

### `/background/service-worker.js`
**Purpose:** Background service worker that handles all external API calls.

**Key Functions:**
- `callLLM(options)` - Unified LLM API caller (Gemini, OpenRouter, OpenAI)
- `captureScreenshot()` - Captures current tab screenshot
- Opens side panel on extension icon click

**Why separate?** Content scripts can't make cross-origin API calls due to CORS. The service worker acts as a proxy.

---

### `/sidepanel/panel.html` + `/sidepanel/panel.js`
**Purpose:** Chat interface UI that users interact with.

**Key Functions:**
- `sendMessage()` - Sends user query to content script
- `addMessage()` - Displays messages in chat
- `addGuideStep()` - Shows step-by-step guidance UI
- `handleQuickAction()` - Handles "Clear All" button

**Communication:** Uses `chrome.tabs.sendMessage()` to talk to content scripts.

---

### `/content/content.js`
**Purpose:** Entry point for content scripts. Routes incoming messages.

**Key Functions:**
- `handleMessage(request)` - Switch statement routing to appropriate handlers

**Actions handled:**
- `handleQuery` → `handleSmartQuery()`
- `reset` → Clear highlights, styles, markings
- `scrollToHighlight` → Scroll to highlighted element
- `continueGuidance` → Next step in guide mode

---

### `/content/api.js`
**Purpose:** Core logic - query routing, LLM communication, response processing.

**Key Functions:**
| Function | Description |
|----------|-------------|
| `routeQuery(query)` | LLM-powered router classifies query intent |
| `handleSmartQuery(query, history)` | Main entry - routes to appropriate handler |
| `handleAsk(query, history)` | Answers questions, highlights relevant elements |
| `handleStepByStepGuide(query, step, previousSteps)` | Multi-step interactive tutorials |
| `continueGuidance()` | Continues to next step in guide mode |
| `processLLMResponseWithScroll(result)` | Applies highlights, handles scroll/expand |
| `callLLM(options)` | Wrapper for service worker LLM calls |
| `callLLMWithScreenshot(options)` | LLM call with page screenshot |

---

### `/content/prompts.js`
**Purpose:** All LLM system prompts in one place.

**Prompts:**
| Prompt | Used For |
|--------|----------|
| `PROMPTS.ROUTER` | Classifies query → ask/guide/protection |
| `PROMPTS.ASK` | Answering questions about page content |
| `PROMPTS.STEP_BY_STEP_GUIDE` | Step-by-step guidance generation |
| `PROMPTS.PROTECTION` | Detecting unsafe/unwanted content |

---

### `/content/utils.js`
**Purpose:** DOM utilities, page analysis, highlighting.

**Key Functions:**
| Function | Description |
|----------|-------------|
| `getRandomHighlightStyle(isDark)` | Random color + animation for highlights |
| `createPageIndex()` | Builds index of interactive elements |
| `getVisibleText()` | Extracts page text via accessibility tree |
| `getPageBackground()` | Detects if page is dark/light |
| `applyIndexedHighlight(index, text, style)` | Highlights element by index |
| `applyElementHighlight(selector, style)` | Highlights by CSS selector |
| `clearHighlights()` | Removes all highlights |
| `scrollToHighlight(index)` | Scrolls to highlighted element |

---

### `/content/protection.js`
**Purpose:** Detects and blurs unsafe/unwanted content (dark patterns, sensitive content).

**Key Functions:**
| Function | Description |
|----------|-------------|
| `handleProtectionQuery(query)` | Scans page for specified content type |
| `applyProtectionMarkings(elements)` | Blurs detected elements |
| `clearMarkings()` | Removes blur effects |

---

### `/content/actions.js`
**Purpose:** Web interaction actions (currently minimal after cleanup).

**Key Functions:**
| Function | Description |
|----------|-------------|
| `actionExpandContent(maxClicks)` | Clicks "Load more" buttons to expand content |
| `sleep(ms)` | Utility delay function |
| `highlightElement(element)` | Visual feedback during actions |

---

### `/content/content.css`
**Purpose:** Styles for highlights, animations, and UI elements.

**Includes:**
- Highlight animations (pulse, spotlight, shimmer, bounce, glow, underline)
- Protection blur styles
- Guide step indicators

---

### `/options/options.html` + `/options/options.js`
**Purpose:** Extension settings page for API keys and preferences.

---

### `/config.js`
**Purpose:** API keys configuration (gitignored).

```javascript
const CONFIG_KEYS = {
  GEMINI_KEY: 'your-api-key',
  OPENROUTER_KEY: 'your-api-key',
  OPENAI_KEY: 'your-api-key'
};
```

---

## Highlight System

Highlights are applied with random fun styles:

```javascript
// Colors auto-contrast with page background
const darkPageColors = ['#00ff88', '#ff6b6b', '#ffd93d', '#6bcfff', '#ff85c0', '#a29bfe'];
const lightPageColors = ['#ff4757', '#2ed573', '#1e90ff', '#9b59b6', '#e84393', '#00b894'];

// Animations
const animations = ['pulse', 'spotlight', 'shimmer', 'bounce', 'glow', 'underline'];
```

The `getRandomHighlightStyle()` function picks random combinations for visual variety.

---

## Message Flow Summary

| From | To | Method | Purpose |
|------|----|--------|---------|
| Panel → Content | `chrome.tabs.sendMessage()` | Send user queries |
| Content → Panel | `sendResponse()` | Return results |
| Content → Background | `chrome.runtime.sendMessage()` | LLM API calls |
| Background → Content | `sendResponse()` | API responses |

---

## Three Query Handlers

1. **Ask** (`handleAsk`) - Answers questions about visible content with highlights
2. **Guide** (`handleStepByStepGuide`) - Interactive step-by-step tutorials
3. **Protection** (`handleProtectionQuery`) - Scans and blurs unsafe content
