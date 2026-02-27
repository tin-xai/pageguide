// XWebAgent - Answer Tool (General Knowledge)
// Answers questions from LLM's general knowledge without injecting page content

/**
 * Answer a question purely from general knowledge — no page scraping, no highlights.
 * Used when the planner determines the query is unrelated to the current page.
 * @param {string} query - User's question
 * @param {Array} history - Conversation history [{role, content}]
 */
async function handleAnswer(query, history = []) {
  console.log('💡 handleAnswer:', query);

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: query }
  ];

  const response = await safeSendMessage({
    action: 'callLLM',
    systemPrompt: PROMPTS.GENERAL_ANSWER,
    messages
  });

  if (response?.error) {
    return { success: false, error: response.error };
  }

  return {
    success: true,
    answer: response.content || '',
    highlightCount: 0,
    hasHighlights: false,
    routedTo: 'answer',
    isGeneralKnowledge: true
  };
}

console.log('💡 answer.js loaded');
