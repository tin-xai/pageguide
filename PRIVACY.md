# Privacy Policy for PageGuide

**Effective Date:** May 18, 2026

This Privacy Policy describes how PageGuide ("we", "our", or "the extension") handles your data. We are committed to protecting your privacy and being fully transparent about what happens to your information.

### 1. Data We Do Not Collect
We **do not** collect, transmit, or store any of your personal data on our own servers. We do not have access to your browsing history, the websites you visit, or the questions you ask the AI. 

### 2. Data Handled by the Extension
To function properly as an AI Web Assistant, the extension processes the following data locally on your device and transmits it directly to the third-party AI provider of your choice:

* **Authentication Information (API Keys):** You must provide your own API key (from Google Gemini, OpenAI, or OpenRouter). This key is stored locally in your browser's secure sync storage (`chrome.storage.sync`) and is never sent to us.
* **Website Content:** When you ask a question about a page, use the "Hide" feature, or upload a PDF, the extension extracts the relevant text or captures a screenshot of the visible area. 
* **User Activity:** When using the "Guide" feature, the extension temporarily monitors your clicks to advance the step-by-step tutorial.

### 3. Third-Party Services
The data mentioned above (Website Content, User Activity, and your API Key) is sent **directly from your browser** to the LLM provider you have selected in the settings (Google Gemini, OpenAI, or OpenRouter). 

Because you are using your own API keys, your data is governed by the privacy policies of those respective services:
* [Google Privacy Policy](https://policies.google.com/privacy)
* [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy)
* [OpenRouter Privacy Policy](https://openrouter.ai/privacy)

### 4. Data Storage
All your settings, preferences, and API keys are stored locally on your device using Chrome's built-in storage APIs. You can clear this data at any time by uninstalling the extension or clearing the extension's data in your browser settings.

### 5. Changes to This Policy
We may update this Privacy Policy from time to time to reflect changes to our extension or for other operational, legal, or regulatory reasons. 

### 6. Contact Us
If you have any questions or concerns about this Privacy Policy or our data practices, please open an issue on our [GitHub repository](https://github.com/tin-xai/pageguide).
