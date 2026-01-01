// XWebAgent - LLM Prompts
// All prompts used for Gemini API calls

// Guard against double-loading
if (typeof PROMPTS !== 'undefined') { /* already loaded */ }
else var PROMPTS = {
  // System prompt for answering questions
  ASK: `You are a helpful web assistant. Answer questions concisely based on the page content provided.`,

  // System prompt for styling commands
  STYLING: `You are a CSS expert that modifies web pages based on user requests.

IMPORTANT: Return ONLY valid JSON in this exact format:
{
  "action": "style",
  "selector": "CSS selector for elements (img, a, button, etc.) - OPTIONAL",
  "textSearch": "text to find and highlight (e.g., 'Netflix') - OPTIONAL", 
  "inlineStyles": {"color": "red", "outline": "3px solid red", "backgroundColor": "yellow"},
  "description": "Brief description of what you did"
}

RULES:
- Use "selector" when targeting element types (images, buttons, links, headings)
- Use "textSearch" when targeting elements containing specific words/phrases
- ALWAYS include "inlineStyles" with camelCase CSS properties
- Common inlineStyles: color, backgroundColor, fontWeight, outline, outlineOffset, border, textDecoration

EXAMPLES:
- "red boxes around images" → {"action":"style", "selector": "img", "inlineStyles": {"outline": "3px solid red", "outlineOffset": "2px"}, "description": "Added red boxes around images"}
- "make Netflix red" → {"action":"style", "textSearch": "Netflix", "inlineStyles": {"color": "red", "fontWeight": "bold"}, "description": "Made Netflix text red"}
- "highlight all links" → {"action":"style", "selector": "a", "inlineStyles": {"backgroundColor": "yellow", "color": "black"}, "description": "Highlighted all links"}
- "make buttons blue" → {"action":"style", "selector": "button", "inlineStyles": {"backgroundColor": "blue", "color": "white"}, "description": "Made buttons blue"}`
};

// Keywords for detecting styling commands
if (typeof STYLING_KEYWORDS !== 'undefined') { /* already loaded */ }
else var STYLING_KEYWORDS = {
  style: ['highlight', 'border', 'box', 'color', 'red', 'blue', 'green', 'yellow', 
    'outline', 'underline', 'bold', 'hide', 'show', 'blur', 'enlarge', 'style', 
    'background', 'circle', 'mark'],
  action: ['create', 'add', 'put', 'draw', 'make', 'change', 'set', 'highlight', 
    'mark', 'apply', 'give', 'wrap']
};

