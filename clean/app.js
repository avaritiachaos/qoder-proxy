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
  writeAnthropicSse,
} = require('./anthropic');
const {
  parseToolCallOutput,
  generateCallId,
  normalizeOpenAiTools,
  normalizeAnthropicTools,
  formatToolResultForPrompt,
} = require('./tool-parser');
const path = require('path');
const { trackRequest, getUsage, resetUsage, saveUsage, extractTextFromMessages } = require('./usage');
const { executeToolCall } = require('./tools-executor');

const MODEL_ID = DEFAULT_MODEL_ID;

function validateChatRequest(body) {
  if (!body || typeof body !== 'object') {
    throw new AppError(400, 'invalid_request', 'Request body must be a JSON object.');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new AppError(400, 'invalid_messages', 'messages must be a non-empty array.');
  }
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') {
      throw new AppError(400, 'invalid_messages', 'Each message must be an object.');
    }
    // Allow system, user, assistant, and tool roles for multi-turn tool use
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) {
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

function createChatCompletion({ model, content, parsedOutput }) {
  // If the CLI output was parsed as tool calls, return OpenAI tool_calls format
  if (parsedOutput && parsedOutput.type === 'tool_calls') {
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
            content: parsedOutput.prefixText || null,
            tool_calls: parsedOutput.toolCalls.map((call) => ({
              id: generateCallId('call_'),
              type: 'function',
              function: {
                name: call.name,
                // OpenAI spec: arguments is a JSON string, not a parsed object
                arguments: JSON.stringify(call.arguments),
              },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  // Regular text response
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
    const backend = qoderCli.getCliBackend();
    res.json({
      ok: true,
      name: 'qoder-proxy',
      mode: 'clean',
      cli_backend: backend.name,
      cli_command: backend.command,
      cli_home: backend.homeDir,
    });
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
        capabilities: {
          reasoning: model.reasoning || false,
        },
        ...(model.effortAlias ? { effort_alias: true } : {}),
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
      const tools = Array.isArray(req.body.tools) ? req.body.tools : null;
      const normalizedTools = tools ? normalizeOpenAiTools(tools) : null;
      log('chat request accepted', {
        model,
        message_count: req.body.messages.length,
        stream: Boolean(req.body.stream),
        tool_count: normalizedTools ? normalizedTools.length : 0,
        reasoning_effort: requestOptions.reasoningEffort,
      });

      // True streaming: stream-json mode, real-time SSE forwarding
      if (req.body.stream) {
        const id = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        // Send role chunk first
        writeSse(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });

        try {
          await qoderCli.runQoderCnCliStream({
            messages: req.body.messages,
            model,
            tools: normalizedTools,
            reasoningEffort: requestOptions.reasoningEffort,
            contextWindow: requestOptions.contextWindow,
            maxOutputTokens: requestOptions.maxOutputTokens,
            signal: controller.signal,
            onDelta: (delta) => {
              writeSse(res, {
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
              });
            },
          });
        } catch (streamError) {
          // If headers are already sent, we can only log and end the stream
          if (!res.writableEnded) {
            try { res.end(); } catch (_) { /* ignore */ }
          }
          log('chat stream failed', {
            code: streamError.code || 'internal_error',
            status: streamError.status || 500,
            duration_ms: Date.now() - started,
            message: streamError.message,
          });
          return;
        }

        writeSse(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        res.write('data: [DONE]\n\n');
        res.end();
        log('chat stream completed', { duration_ms: Date.now() - started });
        trackRequest({
          model,
          inputText: extractTextFromMessages(req.body.messages),
          outputText: '',
          isError: false,
        });
        return;
      }

      // Non-streaming path (or tool calls with stream=true → downgraded)
      // Build working messages for potential tool-call loops
      let workingMessages = [...req.body.messages];
      let finalContent = '';
      let finalParsedOutput = null;
      let toolCallDepth = 0;
      const MAX_TOOL_CALL_DEPTH = 10;

      while (toolCallDepth < MAX_TOOL_CALL_DEPTH) {
        const content = await qoderCli.runQoderCnCli({
          messages: workingMessages,
          model,
          tools: normalizedTools,
          reasoningEffort: requestOptions.reasoningEffort,
          contextWindow: requestOptions.contextWindow,
          maxOutputTokens: requestOptions.maxOutputTokens,
          signal: controller.signal,
        });

        finalContent = content;

        // Parse the output for tool calls if tools were provided
        let parsedOutput = null;
        if (normalizedTools) {
          parsedOutput = parseToolCallOutput(content);
          if (parsedOutput && parsedOutput.type === 'tool_calls') {
            log('chat tool calls detected', {
              tool_count: parsedOutput.toolCalls.length,
              tools: parsedOutput.toolCalls.map((t) => t.name),
            });
          } else {
            log('chat no tool calls detected', { response_type: parsedOutput?.type || 'text' });
          }
        }

        finalParsedOutput = parsedOutput;

        // If no tool calls, we're done
        if (!parsedOutput || parsedOutput.type !== 'tool_calls') {
          break;
        }

        // Execute tool calls and build tool result messages
        const toolResults = [];
        const assistantToolCalls = [];

        for (const toolCall of parsedOutput.toolCalls) {
          const callId = generateCallId('call_');
          assistantToolCalls.push({
            id: callId,
            type: 'function',
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments || {}),
            },
          });

          log('executing tool', { name: toolCall.name, arguments: toolCall.arguments });
          const result = await executeToolCall(toolCall);
          log('tool result', { name: toolCall.name, result });

          toolResults.push({
            role: 'tool',
            tool_call_id: callId,
            content: JSON.stringify(result),
          });
        }

        // Add assistant message with tool_calls
        workingMessages.push({
          role: 'assistant',
          content: parsedOutput.prefixText || null,
          tool_calls: assistantToolCalls,
        });

        // Add tool result messages
        workingMessages.push(...toolResults);

        toolCallDepth++;
      }

      if (toolCallDepth >= MAX_TOOL_CALL_DEPTH) {
        log('warning: max tool call depth reached', { depth: MAX_TOOL_CALL_DEPTH });
      }

      if (req.body.stream) {
        // Tool calls are not streamed — downgrade to non-streaming response
        if (finalParsedOutput && finalParsedOutput.type === 'tool_calls') {
          res.json(createChatCompletion({ model, content: finalContent, parsedOutput: finalParsedOutput }));
        } else {
          writeChatCompletionStream(res, { model, content: finalContent });
        }
      } else {
        res.json(createChatCompletion({ model, content: finalContent, parsedOutput: finalParsedOutput }));
      }
      log('chat request completed', { duration_ms: Date.now() - started, tool_call_depth: toolCallDepth });
      trackRequest({
        model,
        inputText: extractTextFromMessages(req.body.messages),
        outputText: finalContent || '',
        isError: false,
      });
    } catch (error) {
      log('chat request failed', {
        code: error.code || 'internal_error',
        status: error.status || 500,
        duration_ms: Date.now() - started,
        message: error.message,
      });
      trackRequest({
        model: req.body?.model || MODEL_ID,
        inputText: extractTextFromMessages(req.body?.messages),
        outputText: '',
        isError: true,
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
      const { messages, tools } = anthropicToOpenAiMessages(req.body);
      log('anthropic message request accepted', {
        model,
        message_count: req.body.messages.length,
        stream: Boolean(req.body.stream),
        tool_count: Array.isArray(req.body.tools) ? req.body.tools.length : 0,
        reasoning_effort: requestOptions.reasoningEffort,
      });

      // True streaming: stream-json mode, real-time SSE forwarding
      if (req.body.stream) {
        const msgId = `msg_${Date.now()}`;

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        writeAnthropicSse(res, 'message_start', {
          type: 'message_start',
          message: {
            id: msgId,
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

        try {
          await qoderCli.runQoderCnCliStream({
            messages,
            model,
            tools,
            reasoningEffort: requestOptions.reasoningEffort,
            contextWindow: requestOptions.contextWindow,
            maxOutputTokens: requestOptions.maxOutputTokens || req.body.max_tokens,
            signal: controller.signal,
            onDelta: (delta) => {
              writeAnthropicSse(res, 'content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: delta },
              });
            },
          });
        } catch (streamError) {
          if (!res.writableEnded) {
            try { res.end(); } catch (_) { /* ignore */ }
          }
          log('anthropic stream failed', {
            code: streamError.code || 'internal_error',
            status: streamError.status || 500,
            duration_ms: Date.now() - started,
            message: streamError.message,
          });
          return;
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
        log('anthropic stream completed', { duration_ms: Date.now() - started });
        trackRequest({
          model,
          inputText: extractTextFromMessages(req.body.messages),
          outputText: '',
          isError: false,
        });
        return;
      }

      // Non-streaming path (or tool calls with stream=true → downgraded)
      // Build working messages for potential tool-call loops
      let workingMessagesAnthropic = [...messages];
      let anthropicContent = '';
      let anthropicParsedOutput = null;
      let anthropicToolDepth = 0;
      const MAX_ANTHROPIC_TOOL_DEPTH = 10;

      while (anthropicToolDepth < MAX_ANTHROPIC_TOOL_DEPTH) {
        const content = await qoderCli.runQoderCnCli({
          messages: workingMessagesAnthropic,
          model,
          tools,
          reasoningEffort: requestOptions.reasoningEffort,
          contextWindow: requestOptions.contextWindow,
          maxOutputTokens: requestOptions.maxOutputTokens || req.body.max_tokens,
          signal: controller.signal,
        });

        anthropicContent = content;

        // Parse the output for tool calls if tools were provided
        let parsedOutput = null;
        if (tools) {
          parsedOutput = parseToolCallOutput(content);
          if (parsedOutput && parsedOutput.type === 'tool_calls') {
            log('anthropic tool calls detected', {
              tool_count: parsedOutput.toolCalls.length,
              tools: parsedOutput.toolCalls.map((t) => t.name),
            });
          } else {
            log('anthropic no tool calls detected', { response_type: parsedOutput?.type || 'text' });
          }
        }

        anthropicParsedOutput = parsedOutput;

        // If no tool calls, we're done
        if (!parsedOutput || parsedOutput.type !== 'tool_calls') {
          break;
        }

        // Execute tool calls and build tool result messages
        const toolResults = [];
        const assistantToolCalls = [];

        for (const toolCall of parsedOutput.toolCalls) {
          const callId = generateCallId('call_');
          assistantToolCalls.push({
            id: callId,
            type: 'function',
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments || {}),
            },
          });

          log('executing anthropic tool', { name: toolCall.name, arguments: toolCall.arguments });
          const result = await executeToolCall(toolCall);
          log('anthropic tool result', { name: toolCall.name, result });

          toolResults.push({
            role: 'tool',
            tool_call_id: callId,
            content: JSON.stringify(result),
          });
        }

        // Add assistant message with tool_calls
        workingMessagesAnthropic.push({
          role: 'assistant',
          content: parsedOutput.prefixText || null,
          tool_calls: assistantToolCalls,
        });

        // Add tool result messages
        workingMessagesAnthropic.push(...toolResults);

        anthropicToolDepth++;
      }

      if (anthropicToolDepth >= MAX_ANTHROPIC_TOOL_DEPTH) {
        log('warning: max anthropic tool call depth reached', { depth: MAX_ANTHROPIC_TOOL_DEPTH });
      }

      if (req.body.stream) {
        // Tool calls are not streamed — downgrade to non-streaming response
        if (anthropicParsedOutput && anthropicParsedOutput.type === 'tool_calls') {
          res.json(createAnthropicMessage({ model, content: anthropicContent, parsedOutput: anthropicParsedOutput }));
        } else {
          writeAnthropicMessageStream(res, { model, content: anthropicContent });
        }
      } else {
        res.json(createAnthropicMessage({ model, content: anthropicContent, parsedOutput: anthropicParsedOutput }));
      }
      log('anthropic message request completed', { duration_ms: Date.now() - started, tool_call_depth: anthropicToolDepth });
      trackRequest({
        model,
        inputText: extractTextFromMessages(req.body.messages),
        outputText: anthropicContent || '',
        isError: false,
      });
    } catch (error) {
      log('anthropic message request failed', {
        code: error.code || 'internal_error',
        status: error.status || 500,
        duration_ms: Date.now() - started,
        message: error.message,
      });
      trackRequest({
        model: req.body?.model || MODEL_ID,
        inputText: extractTextFromMessages(req.body?.messages),
        outputText: '',
        isError: true,
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

  // --- Usage / Credits API ---
  app.get('/usage/local', (_req, res) => {
    res.json(getUsage());
  });

  app.post('/usage/reset-local', (_req, res) => {
    resetUsage();
    res.json({ ok: true });
  });

  // --- Static Web Console at /ui ---
  const publicDir = path.join(__dirname, '..', 'public');

  // Redirect /ui → /ui/ so relative asset paths resolve correctly in the browser
  app.use('/ui', (req, res, next) => {
    if (req.originalUrl === '/ui' || req.originalUrl === '/ui?') {
      return res.redirect(301, '/ui/');
    }
    next();
  });

  // Serve /ui/ → index.html, and static assets under /ui/*
  app.get('/ui/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use('/ui', express.static(publicDir));

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
