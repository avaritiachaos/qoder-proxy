const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { AppError } = require('./errors');
const { redactString } = require('./redact');
const { resolveModelRoute } = require('./models');
const { buildToolSystemPrompt, formatToolResultForPrompt } = require('./tool-parser');

const DEFAULT_TIMEOUT_MS = 300000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_INSTRUCTION =
  'Answer the attached OpenAI-compatible chat completion request. Return only the final assistant message content.';

function normalizeContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return part.text || part.content || '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}

function normalizeMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      // Format tool results with their call ID for context continuity
      const id = message.tool_call_id || 'unknown';
      const content = normalizeContent(message.content);
      return {
        role: 'tool',
        content: `<tool_result id="${id}">\n${content}\n</tool_result>`,
      };
    }
    if (message.role === 'assistant' && message.tool_calls) {
      // Format previous assistant tool_calls for context continuity
      const parts = [];
      if (message.content) {
        parts.push(normalizeContent(message.content));
      }
      for (const call of message.tool_calls) {
        const name = call.function?.name || call.name || 'unknown';
        const args = call.function?.arguments || JSON.stringify(call.arguments || {});
        parts.push(`[assistant called tool: ${name} with arguments: ${args}]`);
      }
      return { role: 'assistant', content: parts.join('\n') };
    }
    return {
      role: message.role,
      content: normalizeContent(message.content),
    };
  });
}

function buildPrompt(messages, tools) {
  const normalized = normalizeMessages(messages);
  const parts = [];

  const hasSystemPrompt = normalized.some((m) => m.role === 'system');
  const hasTools = tools && tools.length > 0;

  // Three paths to minimize prompt pollution:
  //
  // 1. Client provides its own system prompt (SillyTavern, 紫苑, etc.)
  //    → No injection at all. The client's instructions dominate.
  // 2. No system prompt, no tools (simple curl/OpenCode chat)
  //    → Minimal meta-instruction so the model knows what format to follow.
  // 3. Tools present (Agent mode: Claude Code, 紫苑 with tools)
  //    → Only format instructions, no role definitions.

  if (hasTools) {
    parts.push(buildToolSystemPrompt(tools));
  } else if (hasSystemPrompt) {
    // Client already told the model who to be — don't add anything.
    // The JSON conversation blob below is enough context.
  } else {
    // No system prompt, no tools — bare request. Add minimal guidance.
    parts.push('Answer the latest user message in the conversation context below.');
  }

  parts.push('');
  parts.push(JSON.stringify({ messages: normalized }, null, 2));
  return parts.join('\n');
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function parseMaybeJsonLines(text) {
  const trimmed = stripAnsi(text).trim();
  if (!trimmed) return [];

  try {
    return [JSON.parse(trimmed)];
  } catch (_) {
    const parsed = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate || (!candidate.startsWith('{') && !candidate.startsWith('['))) continue;
      try {
        parsed.push(JSON.parse(candidate));
      } catch (_) {
        // Ignore non-JSON status lines; unstructured-only output is rejected.
      }
    }
    return parsed;
  }
}

function textFromContentParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') return part.text || part.content || '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractText(record) {
  if (record == null) return '';
  if (typeof record === 'string') return record;
  if (Array.isArray(record)) {
    for (let i = record.length - 1; i >= 0; i -= 1) {
      const text = extractText(record[i]);
      if (text) return text;
    }
    return '';
  }
  if (typeof record !== 'object') return '';

  if (record.type === 'result' && typeof record.result === 'string') return record.result;
  if (typeof record.content === 'string') return record.content;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.result === 'string') return record.result;
  if (typeof record.response === 'string') return record.response;
  if (typeof record.output === 'string') return record.output;

  const message = record.message;
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') {
    const fromContent = textFromContentParts(message.content);
    if (fromContent) return fromContent;
    if (typeof message.text === 'string') return message.text;
  }

  return '';
}

function extractAssistantContent(stdout) {
  const records = parseMaybeJsonLines(stdout);
  if (!records.length) {
    throw new AppError(
      502,
      'invalid_upstream_output',
      'Qoder CN CLI did not return structured JSON output.'
    );
  }

  for (let i = records.length - 1; i >= 0; i -= 1) {
    const text = extractText(records[i]).trim();
    if (text) return text;
  }

  throw new AppError(502, 'empty_upstream_output', 'Qoder CN CLI returned no assistant content.');
}

function ensureRuntimeHome(rootDir) {
  const runtimeHome = path.join(rootDir, '.runtime', 'qodercn-home');
  fs.mkdirSync(path.join(runtimeHome, 'AppData', 'Roaming'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'AppData', 'Local'), { recursive: true });
  return runtimeHome;
}

function buildChildEnv(rootDir, token) {
  const runtimeHome = ensureRuntimeHome(rootDir);
  return {
    ...process.env,
    QODERCN_PERSONAL_ACCESS_TOKEN: token,
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
    APPDATA: path.join(runtimeHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(runtimeHome, 'AppData', 'Local'),
  };
}

function appendChunk(chunks, chunk, currentBytes) {
  const nextBytes = currentBytes + chunk.length;
  if (nextBytes > MAX_OUTPUT_BYTES) {
    throw new AppError(502, 'upstream_output_too_large', 'Qoder CN CLI output exceeded the limit.');
  }
  chunks.push(chunk);
  return nextBytes;
}

function buildCliArgs({
  prompt,
  model,
  reasoningEffort,
  contextWindow,
  maxOutputTokens,
  attachmentPath,
  appendSystemPrompt,
  stream,
}) {
  const args = [
    '--print',
    '--output-format',
    stream ? 'stream-json' : 'json',
    '--model',
    model,
  ];

  if (attachmentPath) {
    args.push('--attachment', attachmentPath);
  }

  if (appendSystemPrompt) {
    args.push('--append-system-prompt', appendSystemPrompt);
  }

  if (reasoningEffort) {
    args.push('--reasoning-effort', reasoningEffort);
  }

  if (contextWindow) {
    args.push('--context-window', String(contextWindow));
  }

  if (maxOutputTokens) {
    args.push('--max-output-tokens', String(maxOutputTokens));
  }

  args.push('--', attachmentPath ? ATTACHMENT_INSTRUCTION : prompt);
  return args;
}

function buildSpawnCommand(command, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const qodercnBundle = path.join(
      path.dirname(command),
      'node_modules',
      '@qodercn-ai',
      'qoderclicn',
      'bundle',
      'qoderclicn.js'
    );
    if (fs.existsSync(qodercnBundle)) {
      return {
        command: process.execPath,
        args: [qodercnBundle, ...args],
      };
    }
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command, ...args],
    };
  }
  return { command, args };
}

function createPromptAttachment(rootDir, prompt) {
  const promptDir = path.join(rootDir, '.runtime', 'prompts');
  fs.mkdirSync(promptDir, { recursive: true });
  const filePath = path.join(
    promptDir,
    `prompt-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  );
  fs.writeFileSync(filePath, prompt, 'utf8');
  return filePath;
}

function runQoderCnCli({
  messages,
  model,
  tools,
  reasoningEffort,
  contextWindow,
  maxOutputTokens,
  signal,
  rootDir = process.cwd(),
}) {
  const token = process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
  if (!token) {
    throw new AppError(
      401,
      'qodercn_token_missing',
      'QODERCN_PERSONAL_ACCESS_TOKEN is not configured.',
      'authentication_error'
    );
  }

  // Extract system messages for --append-system-prompt
  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');
  const appendSystemPrompt = systemMessages
    .map((m) => normalizeContent(m.content))
    .filter(Boolean)
    .join('\n\n');

  const command = process.env.QODERCN_CLI_PATH || 'qoderclicn';
  const modelRoute = resolveModelRoute(model);
  const cliModel = modelRoute.cliModel;
  // Build prompt with non-system messages only (system prompt goes via CLI flag)
  const prompt = buildPrompt(nonSystemMessages, tools);
  const timeoutMs = Number(process.env.QODERCN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const effort = reasoningEffort || modelRoute.reasoningEffort || process.env.QODERCN_REASONING_EFFORT;
  const windowSize = contextWindow || process.env.QODERCN_CONTEXT_WINDOW;
  const outputTokens = maxOutputTokens || process.env.QODERCN_MAX_OUTPUT_TOKENS;
  const attachmentPath = createPromptAttachment(rootDir, prompt);
  const args = buildCliArgs({
    prompt,
    model: cliModel,
    reasoningEffort: effort,
    contextWindow: windowSize,
    maxOutputTokens: outputTokens,
    attachmentPath,
    appendSystemPrompt: appendSystemPrompt || undefined,
  });
  const spawnSpec = buildSpawnCommand(command, args);

  return new Promise((resolve, reject) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;

    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: rootDir,
      env: buildChildEnv(rootDir, token),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fs.rmSync(attachmentPath, { force: true });
      fn(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const onAbort = () => {
      child.kill();
      finish(
        reject,
        new AppError(499, 'request_cancelled', 'Request was cancelled by the client.')
      );
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.on('error', (error) => {
      const code = error.code === 'ENOENT' ? 'qodercn_cli_not_found' : 'qodercn_cli_error';
      const message =
        error.code === 'ENOENT'
          ? 'qoderclicn is not installed or not on PATH.'
          : 'Failed to start Qoder CN CLI.';
      finish(reject, new AppError(502, code, message));
    });

    child.stdout.on('data', (chunk) => {
      try {
        stdoutBytes = appendChunk(stdoutChunks, chunk, stdoutBytes);
      } catch (error) {
        child.kill();
        finish(reject, error);
      }
    });

    child.stderr.on('data', (chunk) => {
      try {
        stderrBytes = appendChunk(stderrChunks, chunk, stderrBytes);
      } catch (error) {
        child.kill();
        finish(reject, error);
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      if (timedOut) {
        finish(reject, new AppError(504, 'upstream_timeout', 'Qoder CN CLI request timed out.'));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const detail = redactString(stderr).trim();
        const suffix = detail ? ` ${detail.slice(0, 240)}` : '';
        finish(reject, new AppError(502, 'upstream_error', `Qoder CN CLI failed.${suffix}`));
        return;
      }

      try {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        finish(resolve, extractAssistantContent(stdout));
      } catch (error) {
        finish(reject, error);
      }
    });
  });
}

/**
 * Extract a text delta from a single stream-json line.
 *
 * The CLI's `--output-format stream-json` emits one JSON object per line with
 * various `type` values.  Only `assistant`-type messages carry incremental
 * text that should be forwarded to the client.
 *
 * Returns a non-empty string when text is available, or `null` to skip.
 */
function extractStreamDelta(record) {
  if (!record || typeof record !== 'object') return null;

  if (record.type === 'assistant') {
    if (record.message && Array.isArray(record.message.content)) {
      const texts = record.message.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text);
      if (texts.length) return texts.join('');
    }
    if (typeof record.delta === 'string') return record.delta;
    if (typeof record.text === 'string') return record.text;
  }

  return null;
}

function runQoderCnCliStream({
  messages,
  model,
  tools,
  reasoningEffort,
  contextWindow,
  maxOutputTokens,
  signal,
  rootDir = process.cwd(),
  onDelta,
}) {
  const token = process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
  if (!token) {
    throw new AppError(
      401,
      'qodercn_token_missing',
      'QODERCN_PERSONAL_ACCESS_TOKEN is not configured.',
      'authentication_error'
    );
  }

  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');
  const appendSystemPrompt = systemMessages
    .map((m) => normalizeContent(m.content))
    .filter(Boolean)
    .join('\n\n');

  const command = process.env.QODERCN_CLI_PATH || 'qoderclicn';
  const modelRoute = resolveModelRoute(model);
  const cliModel = modelRoute.cliModel;
  const prompt = buildPrompt(nonSystemMessages, tools);
  const timeoutMs = Number(process.env.QODERCN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const effort = reasoningEffort || modelRoute.reasoningEffort || process.env.QODERCN_REASONING_EFFORT;
  const windowSize = contextWindow || process.env.QODERCN_CONTEXT_WINDOW;
  const outputTokens = maxOutputTokens || process.env.QODERCN_MAX_OUTPUT_TOKENS;
  const attachmentPath = createPromptAttachment(rootDir, prompt);
  const args = buildCliArgs({
    prompt,
    model: cliModel,
    reasoningEffort: effort,
    contextWindow: windowSize,
    maxOutputTokens: outputTokens,
    attachmentPath,
    appendSystemPrompt: appendSystemPrompt || undefined,
    stream: true,
  });
  const spawnSpec = buildSpawnCommand(command, args);

  return new Promise((resolve, reject) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;
    let lineBuffer = '';
    const fullTextParts = [];

    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: rootDir,
      env: buildChildEnv(rootDir, token),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fs.rmSync(attachmentPath, { force: true });
      fn(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const onAbort = () => {
      child.kill();
      finish(
        reject,
        new AppError(499, 'request_cancelled', 'Request was cancelled by the client.')
      );
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.on('error', (error) => {
      const code = error.code === 'ENOENT' ? 'qodercn_cli_not_found' : 'qodercn_cli_error';
      const message =
        error.code === 'ENOENT'
          ? 'qoderclicn is not installed or not on PATH.'
          : 'Failed to start Qoder CN CLI.';
      finish(reject, new AppError(502, code, message));
    });

    child.stdout.on('data', (chunk) => {
      try {
        const nextBytes = stdoutBytes + chunk.length;
        if (nextBytes > MAX_OUTPUT_BYTES) {
          throw new AppError(502, 'upstream_output_too_large', 'Qoder CN CLI output exceeded the limit.');
        }
        stdoutBytes = nextBytes;
      } catch (error) {
        child.kill();
        finish(reject, error);
        return;
      }

      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const record = JSON.parse(trimmed);
          const delta = extractStreamDelta(record);
          if (delta) {
            fullTextParts.push(delta);
            onDelta(delta);
          }
        } catch (_) {
          // Non-JSON line — skip silently (status messages, ANSI, etc.)
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      try {
        stderrBytes = appendChunk(stderrChunks, chunk, stderrBytes);
      } catch (error) {
        child.kill();
        finish(reject, error);
      }
    });

    child.on('close', (code) => {
      // Flush remaining buffer
      if (lineBuffer.trim()) {
        try {
          const record = JSON.parse(lineBuffer.trim());
          const delta = extractStreamDelta(record);
          if (delta) {
            fullTextParts.push(delta);
            onDelta(delta);
          }
        } catch (_) {
          // Ignore
        }
      }

      if (settled) return;
      if (timedOut) {
        finish(reject, new AppError(504, 'upstream_timeout', 'Qoder CN CLI request timed out.'));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const detail = redactString(stderr).trim();
        const suffix = detail ? ` ${detail.slice(0, 240)}` : '';
        finish(reject, new AppError(502, 'upstream_error', `Qoder CN CLI failed.${suffix}`));
        return;
      }

      finish(resolve, fullTextParts.join(''));
    });
  });
}

module.exports = {
  ATTACHMENT_INSTRUCTION,
  buildCliArgs,
  buildPrompt,
  buildSpawnCommand,
  createPromptAttachment,
  extractAssistantContent,
  extractStreamDelta,
  normalizeMessages,
  runQoderCnCli,
  runQoderCnCliStream,
};
