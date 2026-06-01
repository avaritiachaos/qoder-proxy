const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { AppError } = require('./errors');
const { redactString } = require('./redact');
const { resolveModelRoute } = require('./models');

const DEFAULT_TIMEOUT_MS = 120000;
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
  return messages.map((message) => ({
    role: message.role,
    content: normalizeContent(message.content),
  }));
}

function buildPrompt(messages) {
  const normalized = normalizeMessages(messages);
  return [
    'You are serving an OpenAI-compatible chat completion request.',
    'Use the full conversation JSON as context and answer the latest user request.',
    'Return only the assistant message content. Do not include thinking traces, status logs, tool reports, or project summaries.',
    '',
    JSON.stringify({ messages: normalized }, null, 2),
  ].join('\n');
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
}) {
  const args = [
    '--print',
    '--output-format',
    'json',
    '--model',
    model,
  ];

  if (attachmentPath) {
    args.push('--attachment', attachmentPath);
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

  const command = process.env.QODERCN_CLI_PATH || 'qoderclicn';
  const modelRoute = resolveModelRoute(model);
  const cliModel = modelRoute.cliModel;
  const prompt = buildPrompt(messages);
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

module.exports = {
  ATTACHMENT_INSTRUCTION,
  buildCliArgs,
  buildPrompt,
  buildSpawnCommand,
  createPromptAttachment,
  extractAssistantContent,
  normalizeMessages,
  runQoderCnCli,
};
