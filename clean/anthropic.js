const { AppError } = require('./errors');

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
        return toolText ? `[tool_result ${part.tool_use_id || ''}]\n${toolText}` : '';
      }
      if (part.type === 'tool_use') {
        return `[tool_use ${part.name || ''}]\n${JSON.stringify(part.input || {})}`;
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
    if (!['user', 'assistant'].includes(message.role)) {
      throw new AppError(400, 'invalid_request', `Unsupported message role: ${message.role}`);
    }
  }
}

function anthropicToOpenAiMessages(body) {
  const messages = [];
  const system = normalizeSystem(body.system);
  if (system) messages.push({ role: 'system', content: system });

  if (Array.isArray(body.tools) && body.tools.length) {
    messages.push({
      role: 'system',
      content: [
        'The client supplied Anthropic tools, but this proxy currently supports text-only responses.',
        'Do not emit tool_use blocks. Explain limitations or answer directly in text.',
      ].join(' '),
    });
  }

  for (const message of body.messages) {
    messages.push({
      role: message.role,
      content: normalizeAnthropicText(message.content),
    });
  }

  return messages;
}

function createAnthropicMessage({ model, content }) {
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
};
