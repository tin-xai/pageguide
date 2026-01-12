// XWebAgent - Screenshot Capture
// Captures viewport screenshots for vision analysis

/**
 * Capture screenshot of current viewport
 * @returns {Promise<string|null>} Base64 image data or null
 */
async function captureScreenshot() {
  try {
    console.log('📸 Capturing screenshot...');
    const response = await safeSendMessage({ action: 'captureScreenshot' });
    
    if (response?.error) {
      console.warn('📸 Screenshot failed:', response.error);
      return null;
    }
    
    if (response?.imageBase64) {
      console.log('📸 Screenshot captured successfully');
      return response.imageBase64;
    }
    
    return null;
  } catch (e) {
    console.warn('📸 Screenshot error:', e);
    return null;
  }
}

console.log('📸 capture_screenshot.js loaded');
