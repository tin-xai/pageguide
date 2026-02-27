// XWebAgent - Agentic Planner
// Converts a user query into an ordered plan of tool calls

/**
 * Pure function: parses the LLM's plan JSON response.
 * Exported for unit testing.
 * @param {string} content - Raw LLM response text
 * @param {string} fallbackQuery - Original query used when parsing fails
 * @returns {{ steps: Array, planSummary: string }}
 */
function parsePlanResponse(content, fallbackQuery) {
  const VALID_TOOLS = ['find', 'guide', 'hide', 'answer', 'image_ask', 'pdf_ask'];

  try {
    let jsonStr = content.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');

    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) jsonStr = match[0];

    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      throw new Error('Missing or empty steps array');
    }

    const steps = parsed.steps
      .filter(s => s && VALID_TOOLS.includes(s.tool))
      .map(s => ({
        tool: s.tool,
        args: s.args && typeof s.args === 'object' ? s.args : {},
        reason: typeof s.reason === 'string' ? s.reason : ''
      }));

    if (steps.length === 0) throw new Error('No valid tool steps after filtering');

    return {
      steps,
      planSummary: typeof parsed.planSummary === 'string' ? parsed.planSummary : ''
    };
  } catch (e) {
    console.warn('🧠 Plan parse error, using fallback:', e.message);
    return {
      steps: [{ tool: 'find', args: { question: fallbackQuery }, reason: 'parse error fallback' }],
      planSummary: ''
    };
  }
}

/**
 * Call the planner LLM to produce a multi-step plan for the user's query.
 * @param {string} query - User's query
 * @param {string} [pageHint] - First ~500 chars of visible page text (cheap context for planner)
 * @returns {Promise<{ steps: Array, planSummary: string }>}
 */
async function planQuery(query, pageHint = '') {
  console.log('🧠 Planning query:', query);

  try {
    const userContent = pageHint
      ? `Query: "${query}"\n\nSite context:\n${pageHint}`
      : `Query: "${query}"`;

    const response = await safeSendMessage({
      action: 'callRouterLLM',
      systemPrompt: PROMPTS.PLANNER,
      messages: [{ role: 'user', content: userContent }]
    });

    if (response?.error) {
      console.warn('🧠 Planner LLM error, using fallback:', response.error);
      return {
        steps: [{ tool: 'find', args: { question: query }, reason: 'LLM error fallback' }],
        planSummary: ''
      };
    }

    if (response?.content) {
      const plan = parsePlanResponse(response.content, query);
      console.log('🧠 Plan:', plan.steps.map(s => s.tool).join(' → '));
      return plan;
    }

    return {
      steps: [{ tool: 'find', args: { question: query }, reason: 'no LLM response fallback' }],
      planSummary: ''
    };
  } catch (e) {
    console.error('🧠 Planner exception:', e);
    return {
      steps: [{ tool: 'find', args: { question: query }, reason: 'exception fallback' }],
      planSummary: ''
    };
  }
}

console.log('🧠 planner.js loaded');
