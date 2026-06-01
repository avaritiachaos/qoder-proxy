const { AppError } = require('./errors');
const { generateCallId, normalizeAnthropicTools, buildToolSystemPrompt } = require('./tool-parser');

function normalizeAnthropicText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return part.text || '';
      if (part.type === 'tool_result') {
        const toolText = normalizeAnthropicText(part.content);
        return toolText ? `<tool_result id="${part.tool_use_id || ''}">\n${toolText}\n</tool_result>` : '';
      }
      if (part.type === 'tool_use') {
        return `<tool_use name="${part.name || ''}" id="${part.id || ''}">\n${JSON.stringify(part.input || {})}\n</tool_use>`;
      }
      if (part.type === 'image') {
        const mediaType = part.source?.media_type || 'unknown';
        return `[image: ${mediaType}]`;
      }
      if (part.type === 'thinking') {
        return part.thinking ? `[thinking]\n${part.thinking}` : '';
      }
      if (part.type === 'document') {
        const label = part.name || part.source?.media_type || 'file';
        return `[document: ${label}]`;
      }
      if (part.type) {
        return `[unsupported content: ${part.type}]`;
      }
      if (part.text) return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeSystem(system) {
  if (system == null) return '';
  return normalizeAnthropicText(system);
}

function validateAnthropicMessagesRequest(body) {
  if (!body || typeof body !== 'object') {
    throw new AppError(400, 'invalid_request', 'Request body must be a JSON object.');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new AppError(400, 'invalid_request', 'messages must be a non-empty array.');
  }
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') {
      throw new AppError(400, 'invalid_request', 'Each message must be an object.');
    }
    if (!['user', 'assistant', 'system'].includes(message.role)) {
      throw new AppError(400, 'invalid_request', `Unsupported message role: ${message.role}`);
    }
  }
}

function anthropicToOpenAiMessages(body) {
  const messages = [];
  const system = normalizeSystem(body.system);
  if (system) messages.push({ role: 'system', content: system });

  // Convert Anthropic tools to normalized format and inject as system prompt
  let tools = null;
  if (Array.isArray(body.tools) && body.tools.length) {
    tools = normalizeAnthropicTools(body.tools);
    const toolPrompt = buildToolSystemPrompt(tools);
    if (toolPrompt) {
      messages.push({ role: 'system', content: toolPrompt });
    }
  }

  for (const message of body.messages) {
    messages.push({
      role: message.role,
      content: normalizeAnthropicText(message.content),
    });
  }

  return { messages, tools };
}

function createAnthropicMessage({ model, content, parsedOutput }) {
  // If the CLI output was parsed as tool calls, return Anthropic tool_use format
  if (parsedOutput && parsedOutput.type === 'tool_calls') {
    const contentBlocks = [];

    // Add prefix text if the model also output explanatory text
    if (parsedOutput.prefixText) {
      contentBlocks.push({ type: 'text', text: parsedOutput.prefixText });
    }

    // Add tool_use blocks
    for (const call of parsedOutput.toolCalls) {
      contentBlocks.push({
        type: 'tool_use',
        id: generateCallId('toolu_'),
        name: call.name,
        // Anthropic spec: input is a parsed object, not a JSON string
        input: call.arguments,
      });
    }

    return {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: contentBlocks,
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    };
  }

  // Regular text response
  return {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: content }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}

function writeAnthropicSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeAnthropicMessageStream(res, { model, content }) {
  const id = `msg_${Date.now()}`;
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  writeAnthropicSse(res, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  writeAnthropicSse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  if (content) {
    writeAnthropicSse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: content },
    });
  }
  writeAnthropicSse(res, 'content_block_stop', {
    type: 'content_block_stop',
    index: 0,
  });
  writeAnthropicSse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  writeAnthropicSse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function estimateAnthropicInputTokens(body) {
  const text = [
    normalizeSystem(body?.system),
    ...(Array.isArray(body?.messages)
      ? body.messages.map((message) => normalizeAnthropicText(message.content))
      : []),
  ].join('\n');
  return Math.max(1, Math.ceil(text.length / 4));
}

module.exports = {
  anthropicToOpenAiMessages,
  createAnthropicMessage,
  estimateAnthropicInputTokens,
  normalizeAnthropicText,
  validateAnthropicMessagesRequest,
  writeAnthropicMessageStream,
  writeAnthropicSse,
};
