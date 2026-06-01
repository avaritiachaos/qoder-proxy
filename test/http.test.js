const test = require('node:test');
const assert = require('node:assert/strict');
const qoderCli = require('../clean/qodercn-cli');
const { createApp, extractRequestOptions } = require('../clean/app');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('health and models endpoints are OpenAI-compatible enough for discovery', async () => {
  const { server, baseUrl } = await listen(createApp());
  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const models = await fetch(`${baseUrl}/v1/models`);
    assert.equal(models.status, 200);
    const body = await models.json();
    assert.equal(body.object, 'list');
    assert.equal(body.data[0].id, 'qoder-cn');
    assert.equal(body.data.some((model) => model.id === 'qwen3.7-max'), true);
    assert.equal(body.data.some((model) => model.id === 'deepseek-v4-flash'), true);
  } finally {
    server.close();
  }
});

test('streaming returns OpenAI-compatible SSE chunks', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async () => 'OK';
  const { server, baseUrl } = await listen(createApp());
  try {
    const streaming = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(streaming.status, 200);
    assert.match(streaming.headers.get('content-type'), /text\/event-stream/);
    const text = await streaming.text();
    assert.match(text, /"object":"chat\.completion\.chunk"/);
    assert.match(text, /"content":"OK"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('tool calls are rejected with JSON errors', async () => {
  const { server, baseUrl } = await listen(createApp());
  try {
    const toolCall = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'x' }] }],
      }),
    });
    assert.equal(toolCall.status, 400);
    assert.equal((await toolCall.json()).error.code, 'tool_calls_not_supported');
  } finally {
    server.close();
  }
});

test('extracts OpenCode and OpenAI-compatible model options', () => {
  assert.deepEqual(
    extractRequestOptions({
      reasoningEffort: 'high',
      contextWindow: 200000,
      maxOutputTokens: 4096,
    }),
    {
      reasoningEffort: 'high',
      contextWindow: 200000,
      maxOutputTokens: 4096,
    }
  );

  assert.deepEqual(
    extractRequestOptions({
      reasoning_effort: 'low',
      context_window: 64000,
      max_tokens: 1024,
    }),
    {
      reasoningEffort: 'low',
      contextWindow: 64000,
      maxOutputTokens: 1024,
    }
  );

  assert.equal(
    extractRequestOptions({
      providerOptions: {
        'qoder-cn-local': {
          reasoningEffort: 'max',
        },
      },
    }).reasoningEffort,
    'max'
  );
});
