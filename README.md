# XWebAgent Chrome Extension
A Chrome extension that makes browsing **Safe**, **Fun**, and **Efficient**.

## Features

### 🔍 Read - Find Information
- Ask questions about any page
- Extract specific information

### ✨ Write - Enhance Pages
- Highlight links

### 🎯 Guide - Step-by-Step Help
- Get guided through complex tasks
- Visual highlighting of next steps
- Form filling assistance

### 🛡️ Guardian - Stay Safe
- Phishing detection on login pages
- Explicit content blocking (for U18)
- Large purchase warnings
- Suspicious domain alerts

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
Type a question in the popup to find information on the current page.

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