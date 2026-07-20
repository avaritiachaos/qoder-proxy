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

test('streaming with tools returns delta.tool_calls instead of raw JSON text', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  const originalStream = qoderCli.runQoderCnCliStream;
  let streamCalled = false;
  qoderCli.runQoderCnCli = async () => TOOL_CALL_OUTPUT;
  qoderCli.runQoderCnCliStream = async () => {
    streamCalled = true;
    return '';
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
    // The raw passthrough streamer must not be used when tools are declared
    assert.equal(streamCalled, false);
    // Arguments must be a JSON string per OpenAI spec
    const toolCallChunk = text
      .split('\n')
      .map((line) => line.replace(/^data: /, '').trim())
      .filter((line) => line && line !== '[DONE]')
      .map((line) => JSON.parse(line))
      .find((chunk) => chunk.choices?.[0]?.delta?.tool_calls);
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
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async () => 'Just a normal answer.';
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
    assert.match(text, /"content":"Just a normal answer\."/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
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

test('anthropic streaming with tools returns tool_use blocks with input_json_delta', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  const originalStream = qoderCli.runQoderCnCliStream;
  let streamCalled = false;
  qoderCli.runQoderCnCli = async () => TOOL_CALL_OUTPUT;
  qoderCli.runQoderCnCliStream = async () => {
    streamCalled = true;
    return '';
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
    assert.match(text, /"type":"tool_use"/);
    assert.match(text, /"name":"read_file"/);
    assert.match(text, /"type":"input_json_delta"/);
    assert.match(text, /"stop_reason":"tool_use"/);
    assert.match(text, /event: message_stop/);
    assert.equal(streamCalled, false);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
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
