# 🍊 PageGuide: Browser Extension to Assist Users in Navigating a Webpage and Locating Information

<p align="center">
  by <a href="#">Tin Nguyen</a><sup>*†1</sup>, <a href="#">Thang T. Truong</a><sup>*1</sup>, <a href="#">Runtao Zhou</a><sup>*2</sup>, <a href="#">Trung Bui</a>, <a href="#">Chirag Agarwal</a><sup>2</sup>, <a href="#">Anh Totti Nguyen</a><sup>1</sup>
</p>

<p align="center">
  <sup>*</sup>Equal contribution &nbsp;&nbsp; <sup>†</sup>Project lead<br>
  <sup>1</sup>Auburn University &nbsp;&nbsp; <sup>2</sup>University of Virginia
</p>

<p align="center">
  <a href="https://pageguide.github.io/"><img alt="Project Page" src="https://img.shields.io/badge/Project_Page-pageguide.github.io-4285F4?style=flat-square&logoColor=white"></a>
  &nbsp;
  <a href="https://arxiv.org/abs/2604.23772"><img alt="arXiv" src="https://img.shields.io/badge/arXiv-2604.23772-B31B1B?style=flat-square"></a>
  &nbsp;
  <a href="https://huggingface.co/papers/2604.23772"><img alt="Hugging Face" src="https://img.shields.io/badge/%F0%9F%A4%97%20Hugging_Face-Paper-FFD21E?style=flat-square"></a>
  &nbsp;
  <img alt="License" src="https://img.shields.io/badge/Code_License-MIT-4CAF50?style=flat-square">
</p>

---

<div align="center">

<br/>

Support <img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/chrome/chrome_48x48.png" width="20" alt="Chrome"> Chrome &nbsp;&nbsp; <img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/edge/edge_48x48.png" width="20" alt="Edge"> Edge

</div>

---

## ✨ Features

<p align="center">
  <a href="#feat-find"><kbd>🔍 Find</kbd></a> &nbsp;
  <a href="#feat-guide"><kbd>🎯 Guide</kbd></a> &nbsp;
  <a href="#feat-hide"><kbd>🛡️ Hide</kbd></a> &nbsp;
  <a href="#feat-answer"><kbd>💬 Answer</kbd></a> &nbsp;
  <a href="#feat-image"><kbd>🖼️ Image</kbd></a> &nbsp;
  <a href="#feat-pdf"><kbd>📄 PDF</kbd></a>
</p>

<br/>

<a id="feat-find"></a>

### 🔍 Find — Highlight the answer on the page

Have a question about something buried on a long page? PageGuide reads the page and highlights the exact text that answers your question — no manual scrolling needed.

**How to use:**
1. Open any webpage and click the PageGuide icon in your toolbar to open the side panel.
2. Make sure the **Page** toggle is **On** (the default).
3. Type your question in plain English, e.g. _"What is the return policy?"_ or _"Where is the contact email?"_
4. PageGuide highlights the relevant section on the page and shows you the answer in the panel.

<p align="center">
  <img src="assets/find.gif" alt="Find demo" width="80%">
</p>

---

<a id="feat-guide"></a>

### 🎯 Guide — Walk through any task step by step

Not sure how to complete a task on an unfamiliar site? PageGuide overlays live instructions directly on the page, highlighting the exact button or field to interact with at each step.

**How to use:**
1. Navigate to the site where you want to complete a task.
2. Open PageGuide from the toolbar.
3. Ask a "how to" question, e.g. _"How do I change my password?"_ or _"How do I export this spreadsheet as a PDF?"_
4. PageGuide displays step-by-step instructions on the page. Each step highlights the exact element — click it, or let PageGuide auto-fill text fields and navigate for you.
5. Confirm each step at your own pace; PageGuide waits for you and resumes on the next page if navigation is needed.

<p align="center">
  <img src="assets/guide.gif" alt="Guide demo" width="80%">
</p>

---

<a id="feat-hide"></a>

### 🛡️ Hide — Remove distracting content instantly

Cluttered with ads, cookie banners, or sidebars? Describe what you want gone and PageGuide removes it without refreshing the page.

**How to use:**
1. Open any webpage with unwanted content.
2. Open PageGuide from the toolbar.
3. Type what you want to remove, e.g. _"Hide all ads and the sidebar"_ or _"Remove the cookie banner."_
4. PageGuide detects the matching elements and makes them disappear instantly.

<p align="center">
  <img src="assets/hide.gif" alt="Hide demo" width="80%">
</p>

---

<a id="feat-answer"></a>

### 💬 Answer — Ask general knowledge questions

Need a quick fact that has nothing to do with the current page? Switch PageGuide into general-knowledge mode and ask anything.

**How to use:**
1. Open PageGuide from the toolbar.
2. Toggle **Page** to **Off** in the side panel (this tells PageGuide to ignore the current page).
3. Type any question, e.g. _"What is the capital of France?"_ or _"Explain what a p-value means."_
4. PageGuide answers from its AI knowledge base directly in the panel.

---

<a id="feat-image"></a>

### 🖼️ Image Asking — Search the page with a picture

Have a screenshot or product image and want to find the matching item on the current page? Upload it and ask.

**How to use:**
1. Navigate to the page you want to search visually.
2. Open PageGuide from the toolbar.
3. Click the **📎** attachment icon in the chat bar, or paste an image directly with **Ctrl/Cmd+V**.
4. Type your question alongside the image, e.g. _"Find this product on the page"_ or _"Where is this button?"_
5. PageGuide compares your image against the page and highlights the matching element.

<p align="center">
  <img src="assets/vision_asking.gif" alt="Image demo" width="80%">
</p>

---

<a id="feat-pdf"></a>

### 📄 PDF Asking — Ask questions about any PDF

Reading a long PDF in the browser? Ask questions and PageGuide finds the relevant passage without you having to read the whole document.

**How to use:**
1. Open a PDF in your browser (e.g. navigate to any `.pdf` URL or open a local PDF file in Chrome).
2. Open PageGuide from the toolbar — it detects the PDF automatically.
3. Ask a question about the document, e.g. _"What is the main finding?"_ or _"Summarize section 3."_
4. PageGuide reads the document and highlights the cited passage directly in the PDF viewer.

<p align="center">
  <img src="assets/pdf_asking.gif" alt="PDF demo" width="80%">
</p>

---

## 🛠️ Manual Installation

### Developer Mode (for testing)

1. **Download**

- Download the latest zip file from the official Github release (`master` branch: https://github.com/tin-xai/pageguide).

2. **Install**

- Open Chrome and go to `chrome://extensions/`
- Enable **Developer mode** (toggle in top right)
- Click **Load unpacked**
- Select the `pageguide` folder from the downloaded and unpacked zip file
- Pin the extension icon to your toolbar
- Use the extension by clicking the icon in the toolbar

3. **Upgrading**

- Download the latest zip file from the official Github release.
- Unzip and replace the existing `pageguide` folder.
- Reload the extension in `chrome://extensions/` by clicking the reload button on the extension card.

---

## 🌐 Browser Support

- Chrome <img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/chrome/chrome_48x48.png" width="20" alt="Chrome"> - Full support with all features
- Edge <img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/edge/edge_48x48.png" width="20" alt="Edge"> - Full support with all features

Not Supported:

- Firefox, Safari.

---

## ⚙️ Configuration

1. Click the extension icon to open the side panel
2. Click the **⚙️ Settings** (gear icon) at the top right corner of the side panel
3. Choose your LLM provider and enter your API key (support Gemini, OpenRouter, and OpenAI providers)
4. Click **Test & Save Connection** to validate your key
5. Optionally configure:
   - **Vision (Screenshot)** — enable/disable visual analysis (default: on)
   - **Show Element Indices (SoM)** — display numbered badges on page elements (default: off)

---

## 💡 Use Case

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

## 📊 Research & Dataset

PageGuide was evaluated in a controlled within-subjects user study. All data and task stimuli are publicly available on HuggingFace.

### User Study

| Property | Value |
|---|---|
| Design | Counterbalanced within-subjects |
| Participants | ~47 |
| Conditions | `extension` (PageGuide active) vs. `control` (no extension) |
| Task types | `find` · `guide` · `hide` |
| Metrics | Completion time, answer correctness, 7-point Likert survey |

Each participant completed all three task types in both conditions. Condition order was counterbalanced to control for learning effects.

**Results summary**

| Task | n | Control (s) | Extension (s) | Δ (s) | p (Wilcoxon) |
|---|---|---|---|---|---|
| find  | 86 | 81.1 | 70.8 | −10.3 | 0.094 |
| guide | 85 | 76.2 | 109.3 | +33.1 | < 0.001 ✱ |
| hide  | 82 | 80.3 | 45.2  | −35.1 | < 0.001 ✱ |

✱ Statistically significant at α = 0.05.

**Post-study survey (7-point Likert, n ≈ 47)**

| Task | Difficulty without PageGuide | Ease with PageGuide | Accuracy with PageGuide |
|---|---|---|---|
| Find  | 4.4 / 7 | 5.7 / 7 | 6.0 / 7 |
| Guide | 4.8 / 7 | 5.6 / 7 | 5.5 / 7 |
| Hide  | 5.5 / 7 | 5.9 / 7 | — |

### Datasets

---

**`pageguide_userstudy`**
- **Purpose:** Raw interaction logs from the user study — completion times, chat transcripts, correctness labels, paired statistical results, and post-study survey responses.
- **Used in:** Section 5 (User Study / Evaluation)
- **Download:** [🤗 ttn0011/pageguide_userstudy](https://huggingface.co/datasets/ttn0011/pageguide_userstudy)

```python
from datasets import load_dataset
tasks  = load_dataset("ttn0011/pageguide_userstudy", data_files="tasks.csv", split="train").to_pandas()
paired = load_dataset("ttn0011/pageguide_userstudy", data_files="paired_times.csv", split="train").to_pandas()
```

---

**`pageguide_find_data`**
- **Purpose:** Task stimuli for the **Find** condition — 10 real webpages (NASA, Wikipedia, Cleveland Clinic, WWF, Britannica, JMLR) each annotated with up to 2 factual questions, ground-truth answers, and supporting evidence spans.
- **Used in:** Section 5.1 (Find Task Setup)
- **Download:** [🤗 ttn0011/pageguide_find_data](https://huggingface.co/datasets/ttn0011/pageguide_find_data)

```python
find_tasks = load_dataset("ttn0011/pageguide_find_data", split="train").to_pandas()
```

---

**`pageguide_guide_data`**
- **Purpose:** Task stimuli for the **Guide** condition — 7 procedural tasks across 6 platforms (Google Sheets, Google Docs, Google Slides, Coda, TradingView, Scratch), labelled Easy or Medium difficulty.
- **Used in:** Section 5.2 (Guide Task Setup)
- **Download:** [🤗 ttn0011/pageguide_guide_data](https://huggingface.co/datasets/ttn0011/pageguide_guide_data)

```python
guide_tasks = load_dataset("ttn0011/pageguide_guide_data", split="train").to_pandas()
```

---

**`pageguide_hide_data`**
- **Purpose:** Task stimuli for the **Hide** condition — 37 annotated webpage snapshots (Amazon, Netflix, TechCrunch, Allrecipes, Spotify, Yelp, and more) with `(user_goal, hide_query, difficulty, hidden_elements)` annotations and ground-truth CSS selectors. HTML snapshots available on [Google Drive](https://drive.google.com/drive/folders/1tid8Hec_WIGGWdpZUVkE47qFH5flBC2z?usp=sharing).
- **Used in:** Section 5.3 (Hide Task Setup)
- **Download:** [🤗 ttn0011/pageguide_hide_data](https://huggingface.co/datasets/ttn0011/pageguide_hide_data)

```python
hide_tasks = load_dataset("ttn0011/pageguide_hide_data", split="train").to_pandas()
```

---

## 🤝 Contributing

Contributions are welcome! To get started:

1. Fork the repository and create a feature branch (`git checkout -b feat/your-feature`)
2. Make your changes — keep PRs small and focused on a single concern
3. Ensure all tests pass: `npm run ci`
4. Submit a pull request with a clear description of what and why

Please follow the rules in [CLAUDE.md](CLAUDE.md) and open an issue first for larger changes so we can align on the approach.

### 🧪 End-to-End Tests

We use Playwright to run end-to-end (E2E) tests, integrated with automated continuous integration (CI) via GitHub Actions. The CI pipeline runs whenever a commit is pushed to the `main` branch or a pull request targeting `main` is opened or updated, invoking `npm run ci` to execute the full test suite.
The E2E tests verify that the extension loads correctly, its UI pages render and respond to user actions, content scripts behave on real-world pages, and common edge cases do not cause failures.

To run the tests locally, use the following command:

```bash
npm run ci
```

---

## 🙏 Acknowledgements

PageGuide is built on top of some great open-source tools and APIs:

- [Playwright](https://playwright.dev/) — end-to-end testing
- [Chrome Extensions API (Manifest V3)](https://developer.chrome.com/docs/extensions/mv3/) — extension platform
- LLM providers: [Google Gemini](https://ai.google.dev/), [OpenAI](https://openai.com/), [OpenRouter](https://openrouter.ai/)

---

## ⭐ Star this repo if you find PageGuide helpful!

If PageGuide saves you time or makes your browsing better, consider giving it a star — it helps others discover the project.
