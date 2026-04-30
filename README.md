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

## 🎬 Demo

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

<p align="center">
  <img src="assets/find.gif" alt="Find demo" width="80%">
</p>

<p align="center">
  <em>Ask a question — PageGuide highlights the exact answer on the page.</em>
</p>

---

<a id="demo-guide"></a>

### 🎯 Guide

<p align="center">
  <img src="assets/guide.gif" alt="Guide demo" width="80%">
</p>

<p align="center"><em>Ask "how to" — PageGuide walks you through each step interactively, highlighting the exact element at every stage.</em></p>

---

<a id="demo-hide"></a>

### 🛡️ Hide

<p align="center">
  <img src="assets/hide.gif" alt="Hide demo" width="80%">
</p>

<p align="center"><em>Tell PageGuide what to remove — ads, banners, sidebars — and they disappear instantly.</em></p>

---

<a id="demo-image"></a>

### 🖼️ Image Asking

<p align="center">
  <img src="assets/vision_asking.gif" alt="Image demo" width="80%">
</p>

<p align="center"><em>Upload or paste an image — PageGuide visually searches the page and finds a match.</em></p>

---

<a id="demo-pdf"></a>

### 📄 PDF Asking

<p align="center">
<img src="assets/pdf_asking.gif" alt="PDF demo" width="80%">
</p>

<p align="center"><em>Open any PDF and ask questions — PageGuide reads the document and cites the exact passage.</em></p>

---

## ✨ Core Features

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

## 🛠️ Manual Installation

### Developer Mode (for testing)

1. **Download**

- Download the latest zip file from the official Github release.

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
