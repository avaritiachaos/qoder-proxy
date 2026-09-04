const test = require('node:test');
const assert = require('node:assert/strict');
const qoderCli = require('../clean/qodercn-cli');
const { createApp } = require('../clean/app');

const TOOL_CALL_OUTPUT =
  '```json\n{"tool_calls": [{"name": "read_file", "arguments": {"path": "/tmp/test.txt"}}]}\n```';

const OPENAI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
];

const ANTHROPIC_TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file',
    input_schema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('streaming with tools streams text live and appends delta.tool_calls', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  const originalStream = qoderCli.runQoderCnCliStream;
  let bufferedCalled = false;
  let streamCalled = false;
  qoderCli.runQoderCnCli = async () => {
    bufferedCalled = true;
    return TOOL_CALL_OUTPUT;
  };
  // Emulate the incremental deltas the CLI streamer delivers after snapshot
  // conversion: prose first, then the tool-call JSON growing in pieces.
  qoderCli.runQoderCnCliStream = async ({ onDelta }) => {
    streamCalled = true;
    onDelta('Let me read that file.');
    onDelta('\n```json\n{"tool_calls": [{"name": "read_file"');
    onDelta(', "arguments": {"path": "/tmp/test.txt"}}]}\n```');
    return 'Let me read that file.\n```json\n{"tool_calls": [{"name": "read_file", "arguments": {"path": "/tmp/test.txt"}}]}\n```';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'read the file' }],
        tools: OPENAI_TOOLS,
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /"tool_calls"/);
    assert.match(text, /"name":"read_file"/);
    assert.match(text, /"finish_reason":"tool_calls"/);
    assert.match(text, /data: \[DONE\]/);
    // Tool-declared streaming now uses the true streaming path.
    assert.equal(streamCalled, true);
    assert.equal(bufferedCalled, false);
    const chunks = text
      .split('\n')
      .map((line) => line.replace(/^data: /, '').trim())
      .filter((line) => line && line !== '[DONE]')
      .map((line) => JSON.parse(line));
    // The prose prefix streams live…
    const firstContent = chunks.find((chunk) => chunk.choices?.[0]?.delta?.content);
    assert.equal(firstContent.choices[0].delta.content, 'Let me read that file.');
    // …and the tool-call JSON never leaks into content deltas: the gate
    // withholds it, and only the prefix (incl. trailing newline) is flushed.
    const streamedText = chunks
      .filter((chunk) => chunk.choices?.[0]?.delta?.content)
      .map((chunk) => chunk.choices[0].delta.content)
      .join('');
    assert.equal(streamedText, 'Let me read that file.\n');
    const toolCallChunk = chunks.find((chunk) => chunk.choices?.[0]?.delta?.tool_calls);
    assert.ok(toolCallChunk);
    const call = toolCallChunk.choices[0].delta.tool_calls[0];
    assert.equal(call.index, 0);
    assert.equal(call.type, 'function');
    assert.ok(call.id.startsWith('call_'));
    assert.deepEqual(JSON.parse(call.function.arguments), { path: '/tmp/test.txt' });
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    qoderCli.runQoderCnCliStream = originalStream;
    server.close();
  }
});

test('streaming with tools falls back to streamed text when model replies without tool calls', async () => {
  const originalStream = qoderCli.runQoderCnCliStream;
  qoderCli.runQoderCnCliStream = async ({ onDelta }) => {
    onDelta('Just a ');
    onDelta('normal answer.');
    return 'Just a normal answer.';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
        tools: OPENAI_TOOLS,
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    // Both halves stream as separate live deltas.
    assert.match(text, /"content":"Just a "/);
    assert.match(text, /"content":"normal answer\."/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    qoderCli.runQoderCnCliStream = originalStream;
    server.close();
  }
});

test('streaming a bare tool-call reply emits no text content, only tool_calls', async () => {
  const originalStream = qoderCli.runQoderCnCliStream;
  qoderCli.runQoderCnCliStream = async ({ onDelta }) => {
    // The model jumps straight into the tool block — nothing may stream
    // until the stream completes and the block parses as tool calls.
    onDelta('```json\n{"tool_calls"');
    onDelta(': [{"name": "read_file", "arguments": {}}]}\n```');
    return TOOL_CALL_OUTPUT.replace('"path": "/tmp/test.txt"', '');
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'read the file' }],
        tools: OPENAI_TOOLS,
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const chunks = text
      .split('\n')
      .map((line) => line.replace(/^data: /, '').trim())
      .filter((line) => line && line !== '[DONE]')
      .map((line) => JSON.parse(line));
    // No content delta at all — the gate held back the entire JSON payload.
    assert.equal(chunks.some((chunk) => chunk.choices?.[0]?.delta?.content), false);
    assert.match(text, /"tool_calls"/);
    assert.match(text, /"finish_reason":"tool_calls"/);
  } finally {
    qoderCli.runQoderCnCliStream = originalStream;
    server.close();
  }
});

test('tool calls are returned to the client without server-side execution by default', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  let cliCalls = 0;
  qoderCli.runQoderCnCli = async () => {
    cliCalls += 1;
    return TOOL_CALL_OUTPUT;
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'read the file' }],
        tools: OPENAI_TOOLS,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    // Exactly one CLI roundtrip: the proxy must not execute tools itself
    // and loop — the client owns tool execution.
    assert.equal(cliCalls, 1);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('OpenAI streaming failure emits an SSE error event instead of a silent empty stream', async () => {
  const originalStream = qoderCli.runQoderCnCliStream;
  qoderCli.runQoderCnCliStream = async () => {
    const error = new Error('qoderclicn failed. boom');
    error.code = 'upstream_error';
    error.status = 502;
    throw error;
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"error"/);
    assert.match(text, /upstream_error/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    qoderCli.runQoderCnCliStream = originalStream;
    server.close();
  }
});

test('anthropic streaming with tools streams text live and appends tool_use blocks', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  const originalStream = qoderCli.runQoderCnCliStream;
  let bufferedCalled = false;
  let streamCalled = false;
  qoderCli.runQoderCnCli = async () => {
    bufferedCalled = true;
    return TOOL_CALL_OUTPUT;
  };
  qoderCli.runQoderCnCliStream = async ({ onDelta }) => {
    streamCalled = true;
    onDelta('Reading the file now.');
    onDelta('\n```json\n{"tool_calls": [{"name": "read_file", "arguments": {"path": "/tmp/test.txt"}}]}\n```');
    return 'Reading the file now.\n```json\n{"tool_calls": [{"name": "read_file", "arguments": {"path": "/tmp/test.txt"}}]}\n```';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true,
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'read the file' }],
        tools: ANTHROPIC_TOOLS,
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const text = await response.text();
    // The prose prefix streams as a live text_delta…
    assert.match(text, /event: content_block_delta\ndata: \{"type":"content_block_delta","index":0,"delta":\{"type":"text_delta","text":"Reading the file now\."\}/);
    // …then the tool_use block is appended with streamed input JSON.
    assert.match(text, /"type":"tool_use"/);
    assert.match(text, /"name":"read_file"/);
    assert.match(text, /"type":"input_json_delta"/);
    assert.match(text, /"stop_reason":"tool_use"/);
    assert.match(text, /event: message_stop/);
    assert.equal(streamCalled, true);
    assert.equal(bufferedCalled, false);
    // The tool-call JSON must never appear inside a text_delta.
    const textDeltas = [...text.matchAll(/"type":"text_delta","text":"([^"]*)"/g)].map((m) => m[1]);
    assert.equal(textDeltas.some((delta) => delta.includes('tool_calls')), false);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    qoderCli.runQoderCnCliStream = originalStream;
    server.close();
  }
});

test('anthropic streaming a bare tool-call reply opens no text block', async () => {
  const originalStream = qoderCli.runQoderCnCliStream;
  qoderCli.runQoderCnCliStream = async ({ onDelta }) => {
    onDelta('```json\n{"tool_calls"');
    onDelta(': [{"name": "read_file", "arguments": {"path": "/tmp/test.txt"}}]}\n```');
    return TOOL_CALL_OUTPUT;
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true,
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'read the file' }],
        tools: ANTHROPIC_TOOLS,
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    // The first content block is the tool_use block at index 0 — no empty
    // text block precedes it.
    assert.match(text, /"type":"content_block_start","index":0,"content_block":\{"type":"tool_use"/);
    assert.equal(text.includes('"type":"text_delta"'), false);
    assert.match(text, /"stop_reason":"tool_use"/);
  } finally {
    qoderCli.runQoderCnCliStream = originalStream;
    server.close();
  }
});

test('anthropic streaming failure emits an SSE error event', async () => {
  const originalStream = qoderCli.runQoderCnCliStream;
  qoderCli.runQoderCnCliStream = async () => {
    const error = new Error('qoderclicn failed. boom');
    error.code = 'upstream_error';
    error.status = 502;
    throw error;
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true,
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: error/);
    assert.match(text, /"type":"api_error"/);
  } finally {
    qoderCli.runQoderCnCliStream = originalStream;
    server.close();
  }
});

test('developer role is accepted and routed as a system message', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  let captured = null;
  qoderCli.runQoderCnCli = async (options) => {
    captured = options;
    return 'ok';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'developer', content: 'Always answer in French.' },
          { role: 'user', content: 'hi' },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.ok(captured);
    assert.equal(captured.messages.some((m) => m.role === 'developer'), true);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('fixLongAppendSystemPrompt uses the tighter cmd.exe limit', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  if (process.platform !== 'win32') {
    return; // Windows-only behavior
  }

  const attachment = path.join(os.tmpdir(), `qoder-proxy-test-${Date.now()}.txt`);
  fs.writeFileSync(attachment, 'original prompt', 'utf8');
  try {
    // ~10k chars: below the CreateProcess threshold (30000) but far above
    // the cmd.exe single-line limit (8191).
    const longPrompt = 'x'.repeat(10000);
    const args = ['/d', '/s', '/c', 'qoderclicn.cmd', '--append-system-prompt', longPrompt, '--', 'go'];

    const viaCmd = qoderCli.fixLongAppendSystemPrompt([...args], attachment, 'C:\\Windows\\system32\\cmd.exe');
    assert.equal(viaCmd.includes('--append-system-prompt'), false);
    assert.match(fs.readFileSync(attachment, 'utf8'), /^x{10000}\n\noriginal prompt$/);

    // A direct executable spawn keeps the flag at this size.
    fs.writeFileSync(attachment, 'original prompt', 'utf8');
    const viaExe = qoderCli.fixLongAppendSystemPrompt([...args], attachment, 'node.exe');
    assert.equal(viaExe.includes('--append-system-prompt'), true);
  } finally {
    fs.rmSync(attachment, { force: true });
  }
});
