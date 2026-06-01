require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { anthropicError, openAiError, AppError } = require('./errors');
const { log } = require('./logger');
const qoderCli = require('./qodercn-cli');
const { DEFAULT_MODEL_ID, MODELS } = require('./models');
const {
  anthropicToOpenAiMessages,
  createAnthropicMessage,
  estimateAnthropicInputTokens,
  validateAnthropicMessagesRequest,
  writeAnthropicMessageStream,
} = require('./anthropic');

const MODEL_ID = DEFAULT_MODEL_ID;

function hasToolCalls(messages) {
  return messages.some(
    (message) => message.role === 'tool' || message.tool_calls || message.function_call
  );
}

function validateChatRequest(body) {
  if (!body || typeof body !== 'object') {
    throw new AppError(400, 'invalid_request', 'Request body must be a JSON object.');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new AppError(400, 'invalid_messages', 'messages must be a non-empty array.');
  }
  if (hasToolCalls(body.messages)) {
    throw new AppError(400, 'tool_calls_not_supported', 'Tool calls are not supported yet.');
  }
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') {
      throw new AppError(400, 'invalid_messages', 'Each message must be an object.');
    }
    if (!['system', 'user', 'assistant'].includes(message.role)) {
      throw new AppError(400, 'unsupported_role', `Unsupported message role: ${message.role}`);
    }
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function extractProviderOption(body, key) {
  return firstDefined(
    body.providerOptions?.['qoder-cn-local']?.[key],
    body.providerOptions?.qoder?.[key],
    body.providerOptions?.openai?.[key],
    body.provider_options?.['qoder-cn-local']?.[key],
    body.provider_options?.qoder?.[key],
    body.provider_options?.openai?.[key],
    body.options?.[key],
    body.modelOptions?.[key],
    body.model_options?.[key]
  );
}

function extractRequestOptions(body) {
  return {
    reasoningEffort: firstDefined(
      body.reasoningEffort,
      body.reasoning_effort,
      body.reasoning?.effort,
      body.reasoning?.reasoningEffort,
      body.reasoning?.reasoning_effort,
      extractProviderOption(body, 'reasoningEffort'),
      extractProviderOption(body, 'reasoning_effort')
    ),
    contextWindow: firstDefined(
      body.contextWindow,
      body.context_window,
      extractProviderOption(body, 'contextWindow'),
      extractProviderOption(body, 'context_window')
    ),
    maxOutputTokens: firstDefined(
      body.maxOutputTokens,
      body.max_output_tokens,
      body.max_tokens,
      extractProviderOption(body, 'maxOutputTokens'),
      extractProviderOption(body, 'max_output_tokens'),
      extractProviderOption(body, 'max_tokens')
    ),
  };
}

function createChatCompletion({ model, content }) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeChatCompletionStream(res, { model, content }) {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  writeSse(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant' },
        finish_reason: null,
      },
    ],
  });

  if (content) {
    writeSse(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: null,
        },
      ],
    });
  }

  writeSse(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop',
      },
    ],
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/', (_req, res) => {
    res.json({ ok: true, name: 'qoder-cn-proxy', mode: 'clean' });
  });

  app.get('/v1/models', (_req, res) => {
    res.json({
      object: 'list',
      data: MODELS.map((model) => ({
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: 'qodercn',
        name: model.name,
      })),
    });
  });

  app.post('/v1/chat/completions', async (req, res) => {
    const started = Date.now();
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());

    try {
      validateChatRequest(req.body);
      const model = req.body.model || MODEL_ID;
      const requestOptions = extractRequestOptions(req.body);
      log('chat request accepted', {
        model,
        message_count: req.body.messages.length,
        stream: Boolean(req.body.stream),
        reasoning_effort: requestOptions.reasoningEffort,
      });

      const content = await qoderCli.runQoderCnCli({
        messages: req.body.messages,
        model,
        reasoningEffort: requestOptions.reasoningEffort,
        contextWindow: requestOptions.contextWindow,
        maxOutputTokens: requestOptions.maxOutputTokens,
        signal: controller.signal,
      });

      if (req.body.stream) {
        writeChatCompletionStream(res, { model, content });
      } else {
        res.json(createChatCompletion({ model, content }));
      }
      log('chat request completed', { duration_ms: Date.now() - started });
    } catch (error) {
      log('chat request failed', {
        code: error.code || 'internal_error',
        status: error.status || 500,
        duration_ms: Date.now() - started,
        message: error.message,
      });
      if (!res.headersSent && !res.writableEnded) openAiError(res, error);
    }
  });

  app.post('/v1/messages', async (req, res) => {
    const started = Date.now();
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());

    try {
      validateAnthropicMessagesRequest(req.body);
      const model = req.body.model || MODEL_ID;
      const requestOptions = extractRequestOptions(req.body);
      const messages = anthropicToOpenAiMessages(req.body);
      log('anthropic message request accepted', {
        model,
        message_count: req.body.messages.length,
        stream: Boolean(req.body.stream),
        tool_count: Array.isArray(req.body.tools) ? req.body.tools.length : 0,
        reasoning_effort: requestOptions.reasoningEffort,
      });

      const content = await qoderCli.runQoderCnCli({
        messages,
        model,
        reasoningEffort: requestOptions.reasoningEffort,
        contextWindow: requestOptions.contextWindow,
        maxOutputTokens: requestOptions.maxOutputTokens || req.body.max_tokens,
        signal: controller.signal,
      });

      if (req.body.stream) {
        writeAnthropicMessageStream(res, { model, content });
      } else {
        res.json(createAnthropicMessage({ model, content }));
      }
      log('anthropic message request completed', { duration_ms: Date.now() - started });
    } catch (error) {
      log('anthropic message request failed', {
        code: error.code || 'internal_error',
        status: error.status || 500,
        duration_ms: Date.now() - started,
        message: error.message,
      });
      if (!res.headersSent && !res.writableEnded) anthropicError(res, error);
    }
  });

  app.post('/v1/messages/count_tokens', (req, res) => {
    try {
      res.json({ input_tokens: estimateAnthropicInputTokens(req.body) });
    } catch (error) {
      anthropicError(res, error);
    }
  });

  app.use((_req, res) => {
    openAiError(res, new AppError(404, 'not_found', 'Route not found.'));
  });

  app.use((error, _req, res, _next) => {
    openAiError(res, error);
  });

  return app;
}

module.exports = {
  MODEL_ID,
  createApp,
  createChatCompletion,
  extractRequestOptions,
  writeChatCompletionStream,
  validateChatRequest,
};
