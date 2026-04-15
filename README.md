<p align="center">
  <img src="icons/icon128.png" width="52" height="52" alt="PageGuide Icon" style="vertical-align:middle; margin-right:12px;" />
  <span style="font-size:2.2em; font-weight:300; letter-spacing:-0.5px; vertical-align:middle;">PageGuide</span>
</p>
<p align="center"><i>AI Web Assistant for Chrome & Edge</i></p>
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
Type any question and the agent finds the answer on the current page, automatically highlighting the relevant section(s).

### 🎯 Step-by-Step Interactive Guide
Ask "how to" questions and get live, step-by-step guidance overlaid on the page:
- Highlights the exact element to interact with at each step
- Supports **click**, **type** (auto-fills text fields), and **navigate** actions

### 🛡️ Hide / Protection
Detect and remove unwanted content from any page.

### 💡 General Knowledge Answer
Toggle **Page: Off** to query the AI's knowledge base independent of the current page.

### 🖼️ Image Search
Upload or paste (Ctrl/Cmd+V) an image to visually search the current page.

### 📄 PDF Q&A
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

| What you want | What to type |
|---------------|--------------|
| Find info on page | `What is the return policy?` |
| Step-by-step task | `How do I change my password?` |
| Hide distractions | `Hide all ads and sidebars` |
| General knowledge | *(toggle Page: Off)* `What is the capital of France?` |
| Search by image | *(upload image via 📎)* `Find this product on the page` |
| Ask about a PDF | *(open PDF)* `Summarize section 3` |

---

## Contributing

Contributions are welcome! To get started:

1. Fork the repository and create a feature branch (`git checkout -b feat/your-feature`)
2. Make your changes — keep PRs small and focused on a single concern
3. Ensure all tests pass: `npm run ci`
4. Submit a pull request with a clear description of what and why

Please follow the rules in [CLAUDE.md](CLAUDE.md) and open an issue first for larger changes so we can align on the approach.

---

## Acknowledgements

PageGuide is built on top of some great open-source tools and APIs:

- [Playwright](https://playwright.dev/) — end-to-end testing
- [Chrome Extensions API (Manifest V3)](https://developer.chrome.com/docs/extensions/mv3/) — extension platform
- LLM providers: [Google Gemini](https://ai.google.dev/), [OpenAI](https://openai.com/), [OpenRouter](https://openrouter.ai/)

---

## ⭐ Star this repo if you find PageGuide helpful!

If PageGuide saves you time or makes your browsing better, consider giving it a star — it helps others discover the project.