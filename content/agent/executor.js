// XWebAgent - Agentic Executor
// Runs an ordered plan of tool calls, accumulates results and evidence

/**
 * Map from planner tool names to routedTo values used by the panel debug display.
 * Keeps backward compatibility with existing emoji map in panel.js.
 */
const _TOOL_TO_ROUTED = {
  find: 'ask',
  guide: 'guide',
  hide: 'protection',
  answer: 'answer',
  image_ask: 'image_ask',
  pdf_ask: 'pdf_ask'
};

/**
 * Pure function: merge step results into a single AgentResult.
 * Exported for unit testing.
 * @param {Array} steps - Collected step results [{tool, answer, highlightCount, ...}]
 * @param {string} planSummary
 * @returns {object} AgentResult
 */
function buildAgentResult(steps, planSummary) {
  if (!steps || steps.length === 0) {
    return { success: false, error: 'No steps executed', planSummary: planSummary || '' };
  }

  const totalHighlights = steps.reduce((sum, s) => sum + (s.highlightCount || 0), 0);
  const firstStep = steps[0];

  if (steps.length === 1) {
    // Single-step: passthrough with plan metadata appended (fully backward-compatible)
    return {
      ...firstStep,
      planSummary: planSummary || '',
      planSteps: steps
    };
  }

  // Multi-step: combined result
  // Combine answers for conversation history (each step separated by newline)
  const combinedAnswer = steps
    .filter(s => s.answer)
    .map(s => s.answer)
    .join('\n\n');

  return {
    success: true,
    isMultiTool: true,
    steps,
    planSummary: planSummary || '',
    // First answer kept for conversation history push in panel.js
    answer: firstStep.answer || combinedAnswer,
    highlightCount: totalHighlights,
    hasHighlights: totalHighlights > 0,
    routedTo: 'agent',
    routeConfidence: 1.0,
    routeReason: planSummary || ''
  };
}

/**
 * Execute an agent plan sequentially.
 * Calls the existing task functions; they handle their own highlighting.
 * @param {object} plan - { steps, planSummary } from planQuery()
 * @param {string} query - Original user query (fallback for step args)
 * @param {Array} history - Conversation history
 * @param {boolean} hasImage
 * @param {boolean} hasImageInHistory
 * @returns {Promise<object>} AgentResult
 */
async function runAgentPlan(plan, query, history, hasImage, hasImageInHistory) {
  const stepResults = [];

  for (const step of plan.steps) {
    const args = step.args || {};
    let result = null;

    console.log(`🤖 Executing step [${step.tool}]:`, args);

    try {
      switch (step.tool) {
        case 'find':
          if (typeof handleAsk === 'function') {
            result = await handleAsk(args.question || query, history);
          }
          break;

        case 'guide':
          if (typeof handleStepByStepGuide === 'function') {
            result = await handleStepByStepGuide(args.task || query);
          }
          break;

        case 'hide':
          if (typeof handleProtectionQuery === 'function') {
            result = await handleProtectionQuery(args.filter || query);
          } else {
            result = await handleAsk(args.filter || query, history);
          }
          break;

        case 'answer':
          if (typeof handleAnswer === 'function') {
            result = await handleAnswer(args.question || query, history);
          }
          break;

        case 'image_ask':
          if (typeof handleImageAsk === 'function') {
            result = await handleImageAsk(args.question || query);
          } else {
            result = await handleAsk(args.question || query, history);
          }
          break;

        case 'pdf_ask':
          if (typeof handlePdfAsk === 'function') {
            result = await handlePdfAsk(args.question || query);
          } else {
            result = await handleAsk(args.question || query, history);
          }
          break;

        default:
          console.warn('🤖 Unknown tool, falling back to find:', step.tool);
          result = await handleAsk(query, history);
      }
    } catch (e) {
      console.error('🤖 Step execution error:', step.tool, e);
      result = { success: false, error: e.message || 'Step failed', tool: step.tool };
    }

    if (result) {
      stepResults.push({
        tool: step.tool,
        reason: step.reason || '',
        routedTo: _TOOL_TO_ROUTED[step.tool] || step.tool,
        ...result
      });
    }

    // Guide manages its own multi-turn flow; stop the plan here so it can take over.
    // The guide will resume via the existing nextGuideStep / cross-page mechanism.
    if (result?.isGuide && !result?.isLastStep) {
      break;
    }
  }

  return buildAgentResult(stepResults, plan.planSummary);
}

console.log('🤖 executor.js loaded');
