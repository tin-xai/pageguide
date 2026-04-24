<h1 align="center"> &nbsp;🍊 PageGuide</h1>
<p align="center">Web Extension that makes browsing <b>Safe</b> 🛡️, <b>Smart</b> 🧠, and <b>Efficient</b> 🚀</p>

<div align="center">

| 🔍 Find                   | 🎯 Guide                          | 🛡️ Hide                 | 💬 Answer             | 🖼️ Image Asking                | 📄 PDF Asking            |
| ------------------------- | --------------------------------- | ----------------------- | --------------------- | ------------------------------ | ------------------------ |
| Highlight content on page | Step-by-step interactive guidance | Hide ads & distractions | General knowledge Q&A | Visual search via image upload | Ask questions about PDFs |

<br/>

Support <img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/chrome/chrome_48x48.png" width="20" alt="Chrome"> Chrome &nbsp;&nbsp; <img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/edge/edge_48x48.png" width="20" alt="Edge"> Edge

</div>

---

## Demo

<p align="center">
  <a href="#demo-find"><kbd>🔍 Find</kbd></a> &nbsp;
  <a href="#demo-guide"><kbd>🎯 Guide</kbd></a> &nbsp;
  <a href="#demo-hide"><kbd>🛡️ Hide</kbd></a> &nbsp;
  <a href="#demo-answer"><kbd>💬 Answer</kbd></a> &nbsp;
  <a href="#demo-image"><kbd>🖼️ Image</kbd></a> &nbsp;
  <a href="#demo-pdf"><kbd>📄 PDF</kbd></a>
</p>

<br/>

<a id="demo-find"></a>

### 🔍 Find

<img src="videos/find.gif" alt="Find demo" width="50%">

<p><em>Ask a question — PageGuide highlights the exact answer on the page.</em></p>

---

<a id="demo-guide"></a>

### 🎯 Guide

<img src="videos/guide.gif" alt="Guide demo" width="50%">

<p><em>Ask "how to" — PageGuide walks you through each step interactively, highlighting the exact element at every stage.</em></p>

---

<a id="demo-hide"></a>

### 🛡️ Hide

<img src="videos/hide.gif" alt="Hide demo" width="50%">

<p><em>Tell PageGuide what to remove — ads, banners, sidebars — and they disappear instantly.</em></p>

---

<a id="demo-image"></a>

### 🖼️ Image Asking

<img src="videos/vision_asking.gif" alt="Image demo" width="50%">

<p><em>Upload or paste an image — PageGuide visually searches the page and finds a match.</em></p>

---

<a id="demo-pdf"></a>

### 📄 PDF Asking

<img src="videos/pdf_asking.gif" alt="PDF demo" width="50%">

<p><em>Open any PDF and ask questions — PageGuide reads the document and cites the exact passage.</em></p>

---

## Core Features

### 💬 Ask & Find on Page

Type any question and the agent finds the answer on the current page, automatically highlighting the relevant section(s).

### 🎯 Step-by-Step Interactive Guide

Ask "how to" questions and get live, step-by-step guidance overlaid on the page:

- Highlights the exact element to interact with at each step
- Supports **click**, **type** (auto-fills text fields), and **navigate** actions

### 🛡️ Hide / Protection

Detect and remove unwanted content from any page.

### 💡 General Knowledge Answer

Toggle **Page: Off** to query the AI's knowledge base independent of the current page.

### 🖼️ Image Asking

Upload or paste (Ctrl/Cmd+V) an image to visually search the current page.

### 📄 PDF Asking

Ask questions about PDFs directly in the browser.

---

## Installation

### Developer Mode (for testing)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `PageGuide-Extension` folder
5. The extension icon will appear in your toolbar

---

### Browser Support

Officially Supported:

- Chrome - Full support with all features
- Edge - Full support with all features

Not Supported:

- Firefox, Safari.

---

## Configuration

1. Click the extension icon to open the side panel
2. Click the **⚙️ Settings** (gear icon) at the bottom
3. Choose your LLM provider and enter your API key (support Gemini, OpenRouter, and OpenAI providers)
4. Click **Test & Save Connection** to validate your key
5. Optionally configure:
   - **Vision (Screenshot)** — enable/disable visual analysis (default: on)
   - **Show Element Indices (SoM)** — display numbered badges on page elements (default: off)

---

## Use case

### Quick Reference

| What you want     | What to type                                            |
| ----------------- | ------------------------------------------------------- |
| Find info on page | `What is the return policy?`                            |
| Step-by-step task | `How do I change my password?`                          |
| Hide distractions | `Hide all ads and sidebars`                             |
| General knowledge | _(toggle Page: Off)_ `What is the capital of France?`   |
| Search by image   | _(upload image via 📎)_ `Find this product on the page` |
| Ask about a PDF   | _(open PDF)_ `Summarize section 3`                      |

---

## Contributing

Contributions are welcome! To get started:

1. Fork the repository and create a feature branch (`git checkout -b feat/your-feature`)
2. Make your changes — keep PRs small and focused on a single concern
3. Ensure all tests pass: `npm run ci`
4. Submit a pull request with a clear description of what and why

Please follow the rules in [CLAUDE.md](CLAUDE.md) and open an issue first for larger changes so we can align on the approach.

### End-to-End Tests

We use Playwright to run end-to-end tests. The e2e tests verify that the extension loads correctly, its UI pages render and respond to basic user actions,
content scripts behave on real-like pages, and common edge cases don’t crash the app.

To run the tests:

```bash
npm run ci
```

---

## Acknowledgements

PageGuide is built on top of some great open-source tools and APIs:

- [Playwright](https://playwright.dev/) — end-to-end testing
- [Chrome Extensions API (Manifest V3)](https://developer.chrome.com/docs/extensions/mv3/) — extension platform
- LLM providers: [Google Gemini](https://ai.google.dev/), [OpenAI](https://openai.com/), [OpenRouter](https://openrouter.ai/)

---

## ⭐ Star this repo if you find PageGuide helpful!

If PageGuide saves you time or makes your browsing better, consider giving it a star — it helps others discover the project.
