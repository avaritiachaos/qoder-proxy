const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  buildCliArgs,
  buildPrompt,
  buildSpawnCommand,
  createPromptAttachment,
  extractAssistantContent,
  extractStreamDelta,
  fixLongAppendSystemPrompt,
  resolveCliCommand,
} = require('../clean/qodercn-cli');
const { resolveModelRoute } = require('../clean/models');

test('prompt preserves multi-turn messages', () => {
  const prompt = buildPrompt([
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
  ]);

  assert.match(prompt, /Be terse/);
  assert.match(prompt, /first/);
  assert.match(prompt, /second/);
  assert.match(prompt, /third/);
});

test('extracts final assistant content from JSON output', () => {
  const output = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'draft' }] } }),
    JSON.stringify({ type: 'result', result: 'OK' }),
  ].join('\n');

  assert.equal(extractAssistantContent(output), 'OK');
});

test('rejects unstructured text output', () => {
  assert.throws(() => extractAssistantContent('Thinking...\nOK'), /structured JSON/);
});

test('builds qoderclicn print-mode args without unsupported flags', () => {
  const args = buildCliArgs({ prompt: 'hello', model: 'auto' });

  assert.deepEqual(args.slice(0, 5), ['--print', '--output-format', 'json', '--model', 'auto']);
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), 'hello');
  assert.equal(args.includes('--max-turns=1'), false);
  assert.equal(args.includes('--tools'), false);
});

test('builds qoderclicn reasoning effort args when requested', () => {
  const args = buildCliArgs({ prompt: 'hello', model: 'Qwen3.7-Max', reasoningEffort: 'high' });

  assert.equal(args.includes('--reasoning-effort'), true);
  assert.equal(args[args.indexOf('--reasoning-effort') + 1], 'high');
  assert.equal(args.at(-1), 'hello');
});

test('resolves effort model aliases to base qoderclicn model and effort', () => {
  assert.deepEqual(resolveModelRoute('qwen3.7-max-effort-high'), {
    baseModelId: 'qwen3.7-max',
    cliModel: 'Qwen3.7-Max',
    reasoningEffort: 'high',
  });
});

test('builds qoderclicn context and output token args when requested', () => {
  const args = buildCliArgs({
    prompt: 'hello',
    model: 'Qwen3.7-Max',
    contextWindow: 200000,
    maxOutputTokens: 4096,
  });

  assert.equal(args[args.indexOf('--context-window') + 1], '200000');
  assert.equal(args[args.indexOf('--max-output-tokens') + 1], '4096');
});

test('builds qoderclicn attachment args without putting long prompt on command line', () => {
  const longPrompt = 'x'.repeat(100000);
  const args = buildCliArgs({
    prompt: longPrompt,
    model: 'Qwen3.7-Max',
    attachmentPath: '/tmp/prompt.txt',
  });

  assert.equal(args.includes('--attachment'), true);
  assert.equal(args[args.indexOf('--attachment') + 1], '/tmp/prompt.txt');
  assert.equal(args.includes(longPrompt), false);
  assert.match(args.at(-1), /attached OpenAI-compatible/);
});

test('creates prompt attachment under project runtime directory', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-prompt-'));
  try {
    const filePath = createPromptAttachment(temp, 'hello');
    assert.equal(filePath.startsWith(path.join(temp, '.runtime', 'prompts')), true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'hello');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('wraps Windows cmd shims for spawning', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const spec = buildSpawnCommand('C:\\bin\\qoderclicn.cmd', ['--version']);
    assert.match(spec.command, /cmd\.exe$/i);
    assert.deepEqual(spec.args.slice(0, 4), ['/d', '/s', '/c', 'C:\\bin\\qoderclicn.cmd']);
    assert.equal(spec.args.at(-1), '--version');
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('uses qoderclicn JS bundle directly when npm cmd shim is available', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-spawn-'));
  const shim = path.join(temp, 'qoderclicn.cmd');
  const bundle = path.join(
    temp,
    'node_modules',
    '@qodercn-ai',
    'qoderclicn',
    'bundle',
    'qoderclicn.js'
  );
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(shim, '@echo off\n');
  fs.writeFileSync(bundle, 'console.log("ok")\n');

  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const spec = buildSpawnCommand(shim, ['--print', 'hello']);
    assert.equal(spec.command, process.execPath);
    assert.equal(spec.args[0], bundle);
    assert.equal(spec.args.at(-1), 'hello');
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('resolves bare qoderclicn command to Windows npm cmd shim on PATH', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-path-'));
  const shim = path.join(temp, 'qoderclicn.cmd');
  fs.writeFileSync(shim, '@echo off\n');

  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const command = resolveCliCommand('qoderclicn', { PATH: temp, PATHEXT: '.EXE;.BAT;.CMD' });
    assert.equal(command, shim);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('resolveCliCommand keeps explicit CLI paths unchanged', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    assert.equal(resolveCliCommand('C:\\bin\\qoderclicn.cmd', { PATH: '' }), 'C:\\bin\\qoderclicn.cmd');
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('builds stream-json output format when stream is requested', () => {
  const args = buildCliArgs({ prompt: 'hello', model: 'auto', stream: true });
  assert.deepEqual(args.slice(0, 5), ['--print', '--output-format', 'stream-json', '--model', 'auto']);
});

test('defaults to non-streaming json format when stream is not set', () => {
  const args = buildCliArgs({ prompt: 'hello', model: 'auto' });
  assert.deepEqual(args.slice(0, 5), ['--print', '--output-format', 'json', '--model', 'auto']);
});

test('extractStreamDelta extracts text from assistant message with content array', () => {
  const record = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Hello world' }] },
  };
  assert.equal(extractStreamDelta(record), 'Hello world');
});

test('extractStreamDelta extracts text from assistant message with delta field', () => {
  const record = { type: 'assistant', delta: 'partial text' };
  assert.equal(extractStreamDelta(record), 'partial text');
});

test('extractStreamDelta extracts text from assistant message with text field', () => {
  const record = { type: 'assistant', text: 'some text' };
  assert.equal(extractStreamDelta(record), 'some text');
});

test('extractStreamDelta returns null for non-assistant types', () => {
  assert.equal(extractStreamDelta({ type: 'system' }), null);
  assert.equal(extractStreamDelta({ type: 'result', result: 'done' }), null);
  assert.equal(extractStreamDelta({ type: 'user', content: 'hi' }), null);
});

test('extractStreamDelta returns null for tool_use content blocks', () => {
  const record = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
  };
  assert.equal(extractStreamDelta(record), null);
});

test('extractStreamDelta returns null for null or non-object input', () => {
  assert.equal(extractStreamDelta(null), null);
  assert.equal(extractStreamDelta(undefined), null);
  assert.equal(extractStreamDelta('string'), null);
});

test('extractStreamDelta joins multiple text blocks', () => {
  const record = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'first ' },
        { type: 'tool_use', name: 'X', input: {} },
        { type: 'text', text: 'second' },
      ],
    },
  };
  assert.equal(extractStreamDelta(record), 'first second');
});

test('fixLongAppendSystemPrompt returns original args on non-Windows', () => {
  const args = ['--print', '--append-system-prompt', 'sys', '--model', 'auto'];
  const result = fixLongAppendSystemPrompt(args, '/tmp/prompt.txt', 'qoderclicn');
  assert.deepEqual(result, args);
});

test('fixLongAppendSystemPrompt moves long system prompt into attachment on Windows', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-fix-'));
    const attachmentPath = path.join(tempDir, 'prompt.txt');
    fs.writeFileSync(attachmentPath, 'original content', 'utf8');

    const longSystemPrompt = 'x'.repeat(40000);
    const args = ['--print', '--append-system-prompt', longSystemPrompt, '--model', 'auto'];
    const result = fixLongAppendSystemPrompt(args, attachmentPath, 'qoderclicn');

    // --append-system-prompt should be removed from args
    assert.equal(result.includes('--append-system-prompt'), false);
    assert.equal(result.includes(longSystemPrompt), false);

    // system prompt should be prepended to attachment
    const newContent = fs.readFileSync(attachmentPath, 'utf8');
    assert.equal(newContent.startsWith(longSystemPrompt + '\n\noriginal content'), true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('fixLongAppendSystemPrompt keeps args when command line is short', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-short-'));
    const attachmentPath = path.join(tempDir, 'prompt.txt');
    fs.writeFileSync(attachmentPath, 'original content', 'utf8');

    const shortSystemPrompt = 'be helpful';
    const args = ['--print', '--append-system-prompt', shortSystemPrompt, '--model', 'auto'];
    const result = fixLongAppendSystemPrompt(args, attachmentPath, 'qoderclicn');

    // args should remain unchanged because total length is below threshold
    assert.deepEqual(result, args);

    // attachment should remain unchanged
    const content = fs.readFileSync(attachmentPath, 'utf8');
    assert.equal(content, 'original content');

    fs.rmSync(tempDir, { recursive: true, force: true });
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});
