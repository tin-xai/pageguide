<p align="center">
  <img src="icons/icon128.png" width="128" height="128" alt="XWebAgent Icon" />
</p>
<h1 align="center">XWebAgent — AI Web Assistant for Chrome & Edge</h1>
<p align="center">A Chrome extension that makes browsing <b>Safe</b> 🛡️, <b>Smart</b> 🧠, and <b>Efficient</b> 🚀</p>

<div align="center">

| 🔍 Find | 🎯 Guide | 🛡️ Hide | 💬 Answer | 🖼️ Image | 📄 PDF |
|-|-|-|-|-|-|
| Highlight content on page | Step-by-step interactive guidance | Hide ads & distractions | General knowledge Q&A | Visual search via image upload | Ask questions about PDFs |

<br/>

<img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/chrome/chrome_48x48.png" width="20" alt="Chrome"> Chrome &nbsp;&nbsp; <img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/edge/edge_48x48.png" width="20" alt="Edge"> Edge

</div>

---

## Features

### 💬 Ask & Find on Page
Type any question and the agent finds the answer on the current page, automatically highlighting the relevant section(s). Supports:
- Text-based citation highlighting with `[N]` index references
- Vision-based scrolling navigation (up to 5 scroll steps) when visual context is needed
- Auto-expansion of "See more" / "Show more" on X (Twitter) and LinkedIn

### 🎯 Step-by-Step Interactive Guide
Ask "how to" questions and get live, step-by-step guidance overlaid on the page:
- Highlights the exact element to interact with at each step
- Supports **click**, **type** (auto-fills text fields), and **navigate** actions
- Persists guidance state across page navigations and new tabs
- Handles SPA frameworks (React, Vue, Angular) via proper event dispatching
- Automatically resumes on new pages opened during guided flows
- Looks up pre-verified site-specific tutorials when available

### 🛡️ Hide / Protection
Detect and remove unwanted content from any page:
- LLM identifies ads, banners, popups, sidebars, and distracting elements
- User confirmation dialog with per-item checkboxes and "Jump to" preview
- **Auto-hide on scroll**: continues hiding matching content as you scroll down
- Visual badges (🛡️ 1, 🛡️ 2…) mark items before removal

### 💡 General Knowledge Answer
Toggle **Page: Off** to query the AI's knowledge base independent of the current page. Answers can include Chrome Text Fragment links (`#:~:text=...`) for auto-highlighting referenced sources.

### 🖼️ Image Search
Upload or paste (Ctrl/Cmd+V) an image to visually search the current page:
- Compares uploaded image against viewport screenshots as the agent scrolls
- Highlights matching on-page content and returns bounding boxes for matched regions
- Supports up to 8 scroll steps

### 📄 PDF Q&A
Ask questions about PDFs directly in the browser:
- Auto-detected when viewing any PDF
- Extracts text with bounding box coordinates for precise highlighting
- Optional local Python backend (`localhost:8000`) for advanced processing
- Built-in standalone PDF viewer (accessible via 📄 button)

---

## Installation

### Developer Mode (for testing)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `XWebAgent-Extension` folder
5. The extension icon will appear in your toolbar

---

## Configuration

1. Click the extension icon to open the side panel
2. Click the **⚙️ Settings** (gear icon) at the bottom
3. Choose your LLM provider and enter your API key:

| Provider | Recommended Model |
|----------|-------------------|
| **Gemini** (default) | Gemini 2.5 Flash |
| **OpenRouter** | Claude Sonnet 4.6 / Gemini 2.5 Flash |
| **OpenAI** | GPT-5.2 |

4. Click **Test & Save Connection** to validate your key
5. Optionally configure:
   - **Vision (Screenshot)** — enable/disable visual analysis (default: on)
   - **Show Element Indices (SoM)** — display numbered badges on page elements (default: off)

---

## Usage

### Quick Reference

| What you want | What to type |
|---------------|--------------|
| Find info on page | `What is the return policy?` |
| Step-by-step task | `How do I change my password?` |
| Hide distractions | `Hide all ads and sidebars` |
| General knowledge | *(toggle Page: Off)* `What is the capital of France?` |
| Search by image | *(upload image via 📎)* `Find this product on the page` |
| Ask about a PDF | *(open PDF)* `Summarize section 3` |

### Chat Panel Controls

| Button | Action |
|--------|--------|
| 🌐 Page: On/Off | Toggle whether page content is used as context |
| 📎 | Upload files (md, txt, csv, image etc) or paste an image for visual search |
| 📄 | Open the built-in PDF viewer |
| 🕐 | View and reload saved chat history |
| 💾 | Save current conversation |
| ✏️ | Start a new chat session |
| 🌙/☀️ | Toggle dark/light theme |
| ⚙️ | Open settings |
| 🧹 | Clear the chat |

### Tips
- **Cross-site guidance**: start a guide on one site and it will follow you to another (e.g. "go to Amazon and buy X")
- Use **Shift+Enter** for multi-line messages; **Enter** to send

---

## Development

### Repo Layout
```
XWebAgent-Extension/
├── content/
│   ├── agent/          # planner.js, executor.js (multi-step agentic loop)
│   ├── tasks/          # ask.js, guidev2.js, protection.js, answer.js, image_ask.js, ask_pdf.js
│   ├── content.js      # message dispatcher
│   ├── functions/      # main_router.js, utils.js, highlight.js, scroll.js, …
│   └── prompts.js      # all LLM system prompts
├── background/
│   └── service-worker.js  # LLM API proxy, guidance state, screenshot capture
├── sidepanel/
│   ├── panel.html / panel.js   # chat UI
│   └── settings.html           # provider & model settings
├── options/            # options page
├── pdf-viewer/         # built-in PDF viewer
├── e2e-tests/          # unit + Playwright tests
└── manifest.json
```

### Running Tests

```bash
# Install test dependencies
npm run e2e:install

# Validate manifest
npm run e2e:manifest

# Run unit tests (Jest)
npm run e2e:unit

# Run Playwright e2e tests
npm run e2e:e2e

# Run all checks (CI equivalent)
npm run ci
```

### Contributing
- Run `npm run ci` before submitting a PR — all checks must pass
- Any logic change must include or update unit tests in `./e2e-tests/unit/`
- Bug fixes must include a regression test
- Keep PRs small and focused; do not refactor unrelated files
- Never push directly to `master` — use a branch + PR

---

## Permissions

| Permission | Why |
|------------|-----|
| `activeTab` | Read and interact with the current page |
| `storage` | Save API keys and settings |
| `scripting` | Inject content scripts |
| `tabs` | Transfer guidance state across tabs |
| `sidePanel` | Display the chat panel |
| `offscreen` | Run PDF.js in an offscreen document |
| `<all_urls>` | Work on any website |

---

## Privacy Policy

**Last updated: March 2026**

### What data does XWebAgent access?

To answer your questions, the extension may read:
- The **visible text content** of the current page
- **Screenshots** of the current viewport (when Vision mode is enabled)
- The **text of uploaded files** (PDF, images, CSV, TXT, MD) that you explicitly attach
- Your **chat messages and questions** as you type them

### What data is stored?

| Data | Where | How long |
|------|-------|----------|
| API keys | Chrome local storage (on your device only) | Until you remove them in Settings |
| Settings & preferences | Chrome local storage (on your device only) | Until you uninstall |
| Chat history | Browser session memory (per tab) | Until the tab is closed or you clear it |
| Saved conversations | Chrome local storage (on your device only) | Until you delete them |

**No data is stored on any XWebAgent server.** There are no XWebAgent servers.

### What data is transmitted — and where?

Your questions and page content are sent **directly from your browser** to the LLM provider you configure in Settings:

| Provider | Privacy policy |
|----------|---------------|
| Google Gemini | [ai.google.dev/terms](https://ai.google.dev/terms) |
| OpenRouter | [openrouter.ai/privacy](https://openrouter.ai/privacy) |
| OpenAI | [openai.com/policies/privacy-policy](https://openai.com/policies/privacy-policy) |

XWebAgent acts as a **local proxy only** — it formats your request and forwards it to your chosen provider. It never sees, logs, or stores the response on your behalf.

If you use the optional local Python backend for PDF processing, data is sent to `localhost:8000` only — it never leaves your machine.

### What data is NOT collected

- We do **not** collect any analytics, telemetry, or usage statistics
- We do **not** transmit your browsing history
- We do **not** read page content in the background — content is only read when you send a message
- We do **not** share any data with third parties beyond your chosen LLM provider
- API keys are **never** transmitted to anyone other than the provider they belong to

### User controls

- **Clear chat**: use the 🧹 button in the panel at any time
- **Remove API key**: open ⚙️ Settings, clear the key field, and save
- **Disable Vision**: turn off screenshot capture in ⚙️ Settings → Vision (Screenshot)
- **Uninstall**: removing the extension from Chrome immediately deletes all locally stored data
