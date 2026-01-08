<p align="center">
  <img src="icons/icon128.png" width="128" height="128" alt="XWebAgent Icon" />
</p>
<h1 align="center">XWebAgent Extension – A Chrome extension that makes browsing 
<b>Safe</b> 🛡️, <b>Fun</b> 😄, and <b>Efficient</b> 🚀</h1>


## TODO 🎯

### A. Most important core features

1. [x] Highlight/localize information (given any general question format e.g. What? where? How?..)
2. [x] Guide users step by step through some task (e.g. add some item to cart, or change my password, add a new payment card, etc...)
3. [ ] Hide/filter what (posts, articles, emails, etc...) users don't want to see (e.g. ads or political posts or 18+ or whatever the request)
4. [ ] Figure out whether the AI extension right now can "see" images on an HTML page. Test sending a screenshot of the page to LLMs to see if it fix the issues with interpreting images or icons.

### B. Visual aids

1. [x] Let LLMs decide on the highlighting colors by itself (because this should depend on the webpage and the element being highlighted)
2. [x] Explore other ways to highlight/localize information e.g. CSS5 can do a lot of animation. This makes it easier to see the highlighted content.

### C. Infrastructure

1. [ ] Figure out how to auto update Chrome extension upon git push or pull requests, so we don't have to upload everytime. ➡️ _ANH_ working on this.

### D. Automated testing

_After we are done with creating experimental features (go crazy to see how far we can go; what all kinds of useful features we can implement), THEN, we should set up proper tests for serious development of this open-source project (so that the community can contribute). See ideas [here](https://chatgpt.com/share/695f226e-7ca0-8007-a234-1ec09ea912fd)_

1. [ ] Set up End-to-End feature tests (using Playwright)

### E. Adding History to the Chatbot
1. [ ] The entire chat history should be sent to Gemini. Then, users can click on Clear to clear the entire chat history and start again fresh with a new question.

## General Features (future)
<div align="center">

| 🔍 Read | ✨ Write | 🎯 Guide | 🛡️ Guardian |Support|
|-|-|-|-|-|
|Extract information| Highlight links | Guided tasks <br> Visual cues | Phishing <br> U18 blocking <br> Domains |<img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/edge/edge_48x48.png" width="18" alt="Edge"> <br><img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/chrome/chrome_48x48.png" width="18" alt="Chrome"> |

</div>

## Examples
Example Site: https://en.wikipedia.org/wiki/Stranger_Things

Prompt: Highlight the title
<p align="center">
  <img src="examples/example.png" alt="XWebAgent Icon" />
</p>
Result: The title "Stranger Things" are highlighted in Yellow.

## Installation

### Developer Mode (for testing)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `XWebAgent-Extension` folder
5. The extension icon should appear in your toolbar

## Configuration
Create config.js that store the API keys:
```
// DO NOT COMMIT THIS FILE
const CONFIG_KEYS = {
  GEMINI_KEY: "......",
};

```
OR,

1. Click the extension icon
2. Click **Settings** (gear icon at bottom)
3. Enter your API key (now only support Gemini)

## Usage

### Ask Anything
Type a question in the chat box to find information on the current page.

## Project Structure

```
XWebAgent-Extension/
├── manifest.json           # Extension configuration
├── config.js
├── content/
│   ├── prompts.js         # LLM system prompts & keywords
│   └── utils.css          # Page analysis helpers
│   └── styling.css        # CSS injection & element styling
│   └── api.css            # Gemini API communication
│   └── chat.css           # Chat panel UI & user interaction
│   └── content.css        # Entry point & message handler
├── background/
│   └── service-worker.js  # Background tasks & API calls
├── options/
│   ├── options.html       # Settings page
│   └── options.js         # Settings logic
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```


## New features in V2
1. The LLM reads (almost) everything on the website.

2. Scroll to the highlighted location.
