const test = require('node:test');
const assert = require('node:assert/strict');
const qoderCli = require('../clean/qodercn-cli');
const { createApp } = require('../clean/app');
const { resetUsage, getUsage } = require('../clean/usage');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('GET /usage/local returns expected shape', async () => {
  resetUsage();
  const { server, baseUrl } = await listen(createApp());
  try {
    const res = await fetch(`${baseUrl}/usage/local`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, 'local-estimate');
    assert.equal(typeof body.startedAt, 'string');
    assert.equal(typeof body.totalRequests, 'number');
    assert.equal(typeof body.requestsToday, 'number');
    assert.equal(typeof body.requestsByModel, 'object');
    assert.equal(typeof body.errorCount, 'number');
    assert.equal(typeof body.estimatedInputTokens, 'number');
    assert.equal(typeof body.estimatedOutputTokens, 'number');
    assert.equal(typeof body.estimatedTotalTokens, 'number');
    assert.equal(body.officialQuota.supported, false);
    assert.equal(typeof body.officialQuota.message, 'string');
  } finally {
    server.close();
  }
});

test('POST /usage/reset-local resets all stats', async () => {
  const { server, baseUrl } = await listen(createApp());
  try {
    const res = await fetch(`${baseUrl}/usage/reset-local`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });

    // Verify stats are reset
    const usage = await (await fetch(`${baseUrl}/usage/local`)).json();
    assert.equal(usage.totalRequests, 0);
    assert.equal(usage.requestsToday, 0);
    assert.equal(usage.errorCount, 0);
    assert.equal(usage.estimatedInputTokens, 0);
    assert.equal(usage.estimatedOutputTokens, 0);
    assert.equal(usage.estimatedTotalTokens, 0);
  } finally {
    server.close();
  }
});

test('Chat request increments usage counters', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async () => 'Hello!';
  resetUsage();

  const { server, baseUrl } = await listen(createApp());
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.7-max',
        messages: [{ role: 'user', content: 'Hi there' }],
      }),
    });
    assert.equal(res.status, 200);

    const usage = await (await fetch(`${baseUrl}/usage/local`)).json();
    assert.equal(usage.totalRequests, 1);
    assert.equal(usage.requestsToday, 1);
    assert.equal(usage.requestsByModel['qwen3.7-max'], 1);
    assert.ok(usage.estimatedInputTokens > 0, 'Should have estimated input tokens');
    assert.ok(usage.estimatedOutputTokens > 0, 'Should have estimated output tokens');
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('Failed chat request increments error count', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async () => { throw new Error('CLI failed'); };
  resetUsage();

  const { server, baseUrl } = await listen(createApp());
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.7-max',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });
    assert.equal(res.status, 500);

    const usage = await (await fetch(`${baseUrl}/usage/local`)).json();
    assert.equal(usage.totalRequests, 1);
    assert.equal(usage.errorCount, 1);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('Anthropic messages endpoint increments usage counters', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async () => 'OK';
  resetUsage();

  const { server, baseUrl } = await listen(createApp());
  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.7-max',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    assert.equal(res.status, 200);

    const usage = await (await fetch(`${baseUrl}/usage/local`)).json();
    assert.equal(usage.totalRequests, 1);
    assert.equal(usage.requestsByModel['qwen3.7-max'], 1);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('Static UI is served at /ui/', async () => {
  const { server, baseUrl } = await listen(createApp());
  try {
    const res = await fetch(`${baseUrl}/ui/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Qoder Proxy/);
    assert.match(html, /<title>/);
  } finally {
    server.close();
  }
});

test('/ui serves the web console', async () => {
  const { server, baseUrl } = await listen(createApp());
  try {
    const res = await fetch(`${baseUrl}/ui`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Qoder Proxy/);
  } finally {
    server.close();
  }
});

test('UI CSS and JS files are served', async () => {
  const { server, baseUrl } = await listen(createApp());
  try {
    const css = await fetch(`${baseUrl}/ui/style.css`);
    assert.equal(css.status, 200);
    const cssText = await css.text();
    assert.match(cssText, /tab-content/);

    const js = await fetch(`${baseUrl}/ui/app.js`);
    assert.equal(js.status, 200);
    const jsText = await js.text();
    assert.match(jsText, /switchTab/);
  } finally {
    server.close();
  }
});

test('Existing endpoints still work after adding usage routes', async () => {
  const { server, baseUrl } = await listen(createApp());
  try {
    // Health
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    // Models
    const models = await fetch(`${baseUrl}/v1/models`);
    assert.equal(models.status, 200);
    const body = await models.json();
    assert.equal(body.object, 'list');
    assert.ok(body.data.length > 0);
  } finally {
    server.close();
  }
});
