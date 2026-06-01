const crypto = require('crypto');

/**
 * Build a system prompt that injects tool definitions into the CLI prompt.
 *
 * IMPORTANT: This prompt must ONLY provide format instructions — no role
 * definitions or personality statements. Adding "你是一个..." would cause
 * personality pollution for character-based agents like 紫苑 (CodeShion).
 *
 * The prompt tells the model what tools are available and what output format
 * to use if it decides to call one. It explicitly allows normal text replies
 * when no tool is needed, so the model's existing persona is preserved.
 */
function buildToolSystemPrompt(tools) {
  if (!tools || tools.length === 0) return '';

  const toolDescriptions = tools.map((tool) => {
    const func = tool.function || tool;
    const name = func.name || tool.name;
    const desc = func.description || tool.description || '';
    const params = func.parameters || func.input_schema || {};
    return {
      name,
      description: desc,
      parameters: params,
    };
  });

  return [
    '[Tool Protocol] 以下工具可供调用：',
    '',
    JSON.stringify(toolDescriptions, null, 2),
    '',
    '如需调用工具，请仅输出以下格式的 JSON 代码块：',
    '```json',
    '{"tool_calls": [{"name": "工具名称", "arguments": {参数对象}}]}',
    '```',
    '',
    '如不需要调用工具，直接以正常文本回复，不要输出任何 JSON 代码块。',
    '不要在同一个回复中既输出普通文本又输出工具调用 JSON。',
  ].join('\n');
}

/**
 * Extract a balanced JSON object containing "tool_calls" from text.
 *
 * Uses brace-counting to find the outermost `{...}` that is properly
 * balanced and contains the key "tool_calls". This is more robust than
 * a regex approach because nested JSON objects contain inner braces
 * that a lazy regex would incorrectly close on.
 */
function extractBalancedJsonWithToolCalls(text) {
  // Find the first { that could start a JSON object with tool_calls
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;

    // Count braces to find the matching closing brace
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let end = start;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (depth !== 0) continue; // unbalanced braces, skip

    const candidate = text.slice(start, end + 1);

    // Quick check: does this candidate contain "tool_calls"?
    if (!candidate.includes('"tool_calls"')) continue;

    // Try to parse
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && 'tool_calls' in parsed) {
        return {
          json: candidate,
          prefixText: text.slice(0, start).trim(),
        };
      }
    } catch (_) {
      // Not valid JSON, continue searching
    }
  }

  return null;
}

/**
 * Parse CLI output to detect tool calls.
 *
 * Returns:
 *   { type: 'text', content: <original text> }  — when no valid tool_calls found
 *   { type: 'tool_calls', toolCalls: <array>, prefixText: <text before JSON> }  — when valid tool_calls found
 *
 * The parser is robust: it handles markdown ```json blocks, trailing whitespace,
 * and malformed JSON with a fallback to plain text.
 */
function parseToolCallOutput(text) {
  if (!text || typeof text !== 'string') {
    return { type: 'text', content: text || '' };
  }

  // Try to find a ```json ... ``` block
  const jsonBlockRe = /```json\s*\n([\s\S]*?)\n```/;
  const blockMatch = text.match(jsonBlockRe);

  let jsonString = null;
  let prefixText = '';

  if (blockMatch) {
    jsonString = blockMatch[1].trim();
    prefixText = text.slice(0, blockMatch.index).trim();
  } else {
    // Fallback: extract the outermost balanced JSON object containing "tool_calls"
    // This handles cases where the model forgets the markdown fences.
    // We cannot use a simple regex because lazy quantifiers will close on the
    // first inner brace instead of the matching outer brace.
    const extracted = extractBalancedJsonWithToolCalls(text);
    if (extracted) {
      jsonString = extracted.json;
      prefixText = extracted.prefixText;
    }
  }

  if (!jsonString) {
    return { type: 'text', content: text };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (_) {
    // JSON parse failed — try to fix common issues
    // Sometimes the model outputs extra text inside the JSON block
    const firstBrace = jsonString.indexOf('{');
    const lastBrace = jsonString.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        parsed = JSON.parse(jsonString.slice(firstBrace, lastBrace + 1));
      } catch (_) {
        // Still can't parse — fallback to text
        return { type: 'text', content: text };
      }
    } else {
      return { type: 'text', content: text };
    }
  }

  // Validate the parsed structure
  if (!parsed || !Array.isArray(parsed.tool_calls)) {
    return { type: 'text', content: text };
  }

  // Validate each tool call has required fields
  const validCalls = parsed.tool_calls.filter((call) => {
    if (!call || typeof call !== 'object') return false;
    if (!call.name || typeof call.name !== 'string') return false;
    // arguments must be an object (or absent, which defaults to {})
    if (call.arguments !== undefined && typeof call.arguments !== 'object') return false;
    return true;
  });

  if (validCalls.length === 0) {
    return { type: 'text', content: text };
  }

  // Normalize arguments: ensure each call has an arguments object
  const toolCalls = validCalls.map((call) => ({
    name: call.name,
    arguments: call.arguments || {},
  }));

  return { type: 'tool_calls', toolCalls, prefixText };
}

/**
 * Generate a call ID with the appropriate prefix.
 *
 * OpenAI uses "call_" prefix, Anthropic uses "toolu_" prefix.
 * The ID body is 24 hex characters (12 bytes of randomness).
 */
function generateCallId(prefix = 'call_') {
  const id = crypto.randomBytes(12).toString('hex');
  return `${prefix}${id}`;
}

/**
 * Format tool results for inclusion in the CLI prompt.
 *
 * This handles both OpenAI format (role: 'tool' messages) and
 * Anthropic format (tool_result content blocks).
 *
 * OpenAI tool result messages:
 *   { role: 'tool', tool_call_id: 'call_xxx', content: 'result text' }
 *
 * Anthropic tool_result blocks:
 *   { type: 'tool_result', tool_use_id: 'toolu_xxx', content: '...' }
 *
 * Returns a formatted text block that clearly identifies each result
 * by its tool call/use ID so the model can understand what result
 * corresponds to which tool invocation.
 */
function formatToolResultForPrompt(toolResults) {
  if (!toolResults || toolResults.length === 0) return '';

  return toolResults
    .map((result) => {
      const id = result.tool_call_id || result.tool_use_id || 'unknown';
      const content = typeof result.content === 'string'
        ? result.content
        : Array.isArray(result.content)
          ? result.content
              .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object') return part.text || part.content || '';
                return '';
              })
              .filter(Boolean)
              .join('\n')
          : String(result.content || '');
      return `<tool_result id="${id}">\n${content}\n</tool_result>`;
    })
    .join('\n\n');
}

/**
 * Convert OpenAI tool definitions to a normalized format.
 *
 * OpenAI tools: [{ type: 'function', function: { name, description, parameters } }]
 * Returns: [{ name, description, parameters }]
 */
function normalizeOpenAiTools(tools) {
  if (!tools || !Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    name: tool.function?.name || tool.name,
    description: tool.function?.description || tool.description || '',
    parameters: tool.function?.parameters || tool.parameters || {},
  }));
}

/**
 * Convert Anthropic tool definitions to a normalized format.
 *
 * Anthropic tools: [{ name, description, input_schema }]
 * Note: Anthropic uses `input_schema` where OpenAI uses `parameters`.
 * Returns: [{ name, description, parameters }]
 */
function normalizeAnthropicTools(tools) {
  if (!tools || !Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    parameters: tool.input_schema || tool.parameters || {},
  }));
}

module.exports = {
  buildToolSystemPrompt,
  formatToolResultForPrompt,
  generateCallId,
  normalizeAnthropicTools,
  normalizeOpenAiTools,
  parseToolCallOutput,
};