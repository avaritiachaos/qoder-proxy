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

/**
 * Resolve the CLI backend configuration.
 *
 * Supports two backends:
 *   - "cn"     → qoderclicn  (Qoder CN, auth in .qoderworkcn)
 *   - "global" → qodercli    (Qoder international, auth in .qoder)
 *
 * The backend is selected via CLI_BACKEND env var (default: "cn").
 * Individual fields can be overridden with CLI_COMMAND and CLI_TOKEN.
 */
function getCliBackend() {
  const backend = (process.env.CLI_BACKEND || 'cn').toLowerCase();

  if (backend === 'global') {
    return {
      name: 'global',
      command: process.env.CLI_COMMAND || 'qodercli',
      bundlePackage: '@qoder-ai/qodercli',
      bundlePath: path.join('bundle', 'qodercli.js'),
      homeDir: path.join(process.env.USERPROFILE || process.env.HOME || '~', '.qoder'),
      tokenEnvVar: 'QODER_PAT',
    };
  }

  // Default: cn
  return {
    name: 'cn',
    command: process.env.CLI_COMMAND || 'qoderclicn',
    bundlePackage: '@qodercn-ai/qoderclicn',
    bundlePath: path.join('bundle', 'qoderclicn.js'),
    homeDir: path.join(process.env.USERPROFILE || process.env.HOME || '~', '.qoderworkcn'),
    tokenEnvVar: 'QODERCN_PERSONAL_ACCESS_TOKEN',
  };
}

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
  // 1. Client provides its own system prompt
  //    → No injection at all. The client's instructions dominate.
  // 2. No system prompt, no tools
  //    → Minimal meta-instruction so the model knows what format to follow.
  // 3. Tools present
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

function buildChildEnv(rootDir, token, backend) {
  ensureRuntimeHome(rootDir);
  const cfg = backend || getCliBackend();
  // Don't override HOME/USERPROFILE — let the CLI find its auth config
  // in the real home directory (same as running the CLI directly).
  const env = { ...process.env };
  // Set the backend-specific token env var
  env[cfg.tokenEnvVar] = token;
  return env;
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

function buildSpawnCommand(command, args, backend) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const cfg = backend || getCliBackend();
    const bundle = path.join(
      path.dirname(command),
      'node_modules',
      cfg.bundlePackage,
      cfg.bundlePath
    );
    if (fs.existsSync(bundle)) {
      return {
        command: process.execPath,
        args: [bundle, ...args],
      };
    }
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command, ...args],
    };
  }
  return { command, args };
}

function hasPathSeparator(command) {
  return /[\\/]/.test(command);
}

function pathEnv(env = process.env) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path');
  return key ? env[key] || '' : '';
}

function executableExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

function resolveCliCommand(command, env = process.env) {
  if (process.platform !== 'win32' || hasPathSeparator(command)) return command;

  const commandExt = path.extname(command);
  const defaultExts = ['.cmd', '.exe', '.bat', '.com'];
  const envExts = (env.PATHEXT || '')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const candidateExts = commandExt
    ? ['']
    : [...defaultExts, ...envExts.filter((ext) => !defaultExts.includes(ext))];

  for (const dir of pathEnv(env).split(';').filter(Boolean)) {
    for (const ext of candidateExts) {
      const candidate = path.join(dir, command + ext);
      if (executableExists(candidate)) return candidate;
    }
  }

  return command;
}

/**
 * Windows command line has a ~32,767 character limit (CreateProcessW).
 * When --append-system-prompt is too long, prepend it to the attachment
 * file and remove it from CLI args to avoid spawn ENAMETOOLONG.
 */
function fixLongAppendSystemPrompt(args, attachmentPath, command) {
  if (process.platform !== 'win32' || !attachmentPath) return args;

  const idx = args.indexOf('--append-system-prompt');
  if (idx === -1) return args;

  const systemPrompt = args[idx + 1];
  if (!systemPrompt) return args;

  // Rough estimate: include command name and a safety margin
  const totalLength = (command?.length || 10) + args.reduce((acc, s) => acc + s.length + 1, 0);
  if (totalLength < 30000) return args;

  try {
    const original = fs.readFileSync(attachmentPath, 'utf8');
    fs.writeFileSync(attachmentPath, systemPrompt + '\n\n' + original, 'utf8');
  } catch (e) {
    // If we can't modify the file, keep original args and hope for the best
    return args;
  }

  const newArgs = [...args];
  newArgs.splice(idx, 2);
  return newArgs;
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
  const backend = getCliBackend();
  const token = process.env[backend.tokenEnvVar];
  if (!token) {
    throw new AppError(
      401,
      'cli_token_missing',
      `${backend.tokenEnvVar} is not configured. Set it in .env or run \`${backend.command} login\` first.`,
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

  const command = resolveCliCommand(process.env.CLI_COMMAND || process.env.QODERCN_CLI_PATH || backend.command);
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
  const spawnSpec = buildSpawnCommand(command, args, backend);
  const finalArgs = fixLongAppendSystemPrompt(spawnSpec.args, attachmentPath, spawnSpec.command);

  return new Promise((resolve, reject) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;

    const child = spawn(spawnSpec.command, finalArgs, {
      cwd: rootDir,
      env: buildChildEnv(rootDir, token, backend),
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
      const code = error.code === 'ENOENT' ? 'cli_not_found' : 'cli_error';
      const message =
        error.code === 'ENOENT'
          ? `${backend.command} is not installed or not on PATH.`
          : `Failed to start ${backend.command}.`;
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
        finish(reject, new AppError(504, 'upstream_timeout', `${backend.command} request timed out.`));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const detail = redactString(stderr).trim();
        const suffix = detail ? ` ${detail.slice(0, 240)}` : '';
        finish(reject, new AppError(502, 'upstream_error', `${backend.command} failed.${suffix}`));
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
  const backend = getCliBackend();
  const token = process.env[backend.tokenEnvVar];
  if (!token) {
    throw new AppError(
      401,
      'cli_token_missing',
      `${backend.tokenEnvVar} is not configured. Set it in .env or run \`${backend.command} login\` first.`,
      'authentication_error'
    );
  }

  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');
  const appendSystemPrompt = systemMessages
    .map((m) => normalizeContent(m.content))
    .filter(Boolean)
    .join('\n\n');

  const command = resolveCliCommand(process.env.CLI_COMMAND || process.env.QODERCN_CLI_PATH || backend.command);
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
  const spawnSpec = buildSpawnCommand(command, args, backend);
  const finalArgs = fixLongAppendSystemPrompt(spawnSpec.args, attachmentPath, spawnSpec.command);

  return new Promise((resolve, reject) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;
    let lineBuffer = '';
    const fullTextParts = [];

    const child = spawn(spawnSpec.command, finalArgs, {
      cwd: rootDir,
      env: buildChildEnv(rootDir, token, backend),
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
      const code = error.code === 'ENOENT' ? 'cli_not_found' : 'cli_error';
      const message =
        error.code === 'ENOENT'
          ? `${backend.command} is not installed or not on PATH.`
          : `Failed to start ${backend.command}.`;
      finish(reject, new AppError(502, code, message));
    });

    child.stdout.on('data', (chunk) => {
      try {
        const nextBytes = stdoutBytes + chunk.length;
        if (nextBytes > MAX_OUTPUT_BYTES) {
          throw new AppError(502, 'upstream_output_too_large', `${backend.command} output exceeded the limit.`);
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
        finish(reject, new AppError(504, 'upstream_timeout', `${backend.command} request timed out.`));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const detail = redactString(stderr).trim();
        const suffix = detail ? ` ${detail.slice(0, 240)}` : '';
        finish(reject, new AppError(502, 'upstream_error', `${backend.command} failed.${suffix}`));
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
  fixLongAppendSystemPrompt,
  getCliBackend,
  normalizeMessages,
  resolveCliCommand,
  runQoderCnCli,
  runQoderCnCliStream,
};
