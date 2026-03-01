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
|----------|-----------|-------------------|
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
