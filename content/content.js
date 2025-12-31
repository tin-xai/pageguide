// XWebAgent Content Script - Main Entry Point
// Initializes the extension and handles message routing

console.log('🤖 XWebAgent loaded');

// ===== Message Handler =====
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request).then(sendResponse);
  return true; // Keep channel open for async
});

async function handleMessage(request) {
  switch (request.action) {
    case 'toggleChatPanel':
      if (!document.getElementById('xwebagent-chat-panel')) {
        createChatPanel();
      }
      toggleChatPanel();
      return { success: true, isOpen: chatPanelOpen };
    
    default:
      return { error: 'Unknown action' };
  }
}

// ===== Initialize =====
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createChatPanel);
} else {
  createChatPanel();
}
