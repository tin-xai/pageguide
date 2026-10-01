// PageGuide - Screenshot Capture
// Captures viewport screenshots for vision analysis

/**
 * Capture screenshot of current viewport
 * @returns {Promise<string|null>} Base64 image data or null
 */
async function captureScreenshot() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`📸 Capturing screenshot (attempt ${attempt})...`);
      const response = await safeSendMessage({ action: 'captureScreenshot' });
      
      if (response && !response.error && response.imageBase64) {
        console.log(`📸 Screenshot captured successfully on attempt ${attempt}`);
        return response.imageBase64;
      }
      
      console.warn(`📸 Screenshot failed on attempt ${attempt}:`, response?.error || 'No image data');
    } catch (e) {
      console.warn(`📸 Screenshot error on attempt ${attempt}:`, e);
    }
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  return null;
}

console.log('📸 capture_screenshot.js loaded');
