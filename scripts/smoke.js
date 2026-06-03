'use strict';

/**
 * Smoke test for a running Qoder CN Proxy instance.
 *
 * Usage:
 *   node scripts/smoke-test.js          # quick check: /health + /v1/models
 *   node scripts/smoke-test.js --full   # also test chat and messages endpoints
 *
 * The --full flag requires a running proxy with a valid QODERCN_PERSONAL_ACCESS_TOKEN
 * and will make real model calls that consume time and quota.
 */

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const args = process.argv.slice(2);
const fullMode = args.includes('--full');

let passed = 0;
let failed = 0;
let skipped = 0;

async function request(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const contentType = res.headers.get('content-type') || '';
  let data;
  if (contentType.includes('json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, data };
}

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`  SKIP  ${name}`);
  console.log(`        ${reason}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testHealth() {
  const { status, data } = await request('GET', '/health');
  assert(status === 200, `Expected status 200, got ${status}`);
  assert(data.ok === true, 'Expected { ok: true }');
}

async function testModels() {
  const { status, data } = await request('GET', '/v1/models');
  assert(status === 200, `Expected status 200, got ${status}`);
  assert(data.object === 'list', `Expected object "list", got "${data.object}"`);
  assert(Array.isArray(data.data) && data.data.length > 0, 'Expected non-empty model list');

  const ids = data.data.map((m) => m.id);
  assert(ids.includes('qoder-cn'), 'Missing model "qoder-cn"');
  assert(ids.includes('qwen3.7-max'), 'Missing model "qwen3.7-max"');
  assert(ids.includes('deepseek-v4-flash'), 'Missing model "deepseek-v4-flash"');

  console.log(`        Models: ${ids.join(', ')}`);
}

async function testChatCompletions() {
  const { status, data } = await request('POST', '/v1/chat/completions', {
    model: 'qoder-cn',
    messages: [{ role: 'user', content: 'Reply with exactly: SMOKE_OK' }],
  });
  assert(status === 200, `Expected status 200, got ${status}`);
  assert(data.choices && data.choices.length > 0, 'Expected at least one choice');
  assert(typeof data.choices[0].message.content === 'string', 'Expected string content in choice');
  console.log(`        Response (${data.choices[0].message.content.length} chars)`);
}

async function testChatCompletionsStream() {
  const url = `${BASE_URL}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'qoder-cn',
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: SMOKE_OK' }],
    }),
  });
  assert(res.status === 200, `Expected status 200, got ${res.status}`);
  assert(
    (res.headers.get('content-type') || '').includes('text/event-stream'),
    'Expected SSE content-type'
  );
  const text = await res.text();
  assert(text.includes('data:'), 'Expected SSE data lines');
  assert(text.includes('[DONE]'), 'Expected SSE [DONE] marker');
  assert(text.includes('chat.completion.chunk'), 'Expected chat.completion.chunk objects');
}

async function testAnthropicMessages() {
  const { status, data } = await request('POST', '/v1/messages', {
    model: 'qoder-cn',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply with exactly: SMOKE_OK' }],
  });
  assert(status === 200, `Expected status 200, got ${status}`);
  assert(data.type === 'message', `Expected type "message", got "${data.type}"`);
  assert(Array.isArray(data.content) && data.content.length > 0, 'Expected non-empty content array');
  assert(typeof data.content[0].text === 'string', 'Expected text in first content block');
  console.log(`        Response (${data.content[0].text.length} chars)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nSmoke test: ${BASE_URL}`);
  console.log(`Mode: ${fullMode ? 'full (includes model calls)' : 'quick (endpoints only)'}\n`);

  try {
    await fetch(`${BASE_URL}/health`);
  } catch (error) {
    console.log(`  ERROR: Cannot connect to ${BASE_URL}`);
    console.log(`         ${error.cause ? error.cause.message : error.message}`);
    console.log(`         Is the proxy running? Start it with: npm start\n`);
    process.exit(1);
  }

  console.log('  Quick checks:');
  await check('GET /health', testHealth);
  await check('GET /v1/models', testModels);

  console.log();

  if (fullMode) {
    console.log('  Full checks (real model calls):');
    await check('POST /v1/chat/completions', testChatCompletions);
    await check('POST /v1/chat/completions (stream)', testChatCompletionsStream);
    await check('POST /v1/messages', testAnthropicMessages);
  } else {
    skip('POST /v1/chat/completions', 'use --full to test (requires a valid PAT and live model access)');
    skip('POST /v1/chat/completions (stream)', 'use --full to test');
    skip('POST /v1/messages', 'use --full to test');
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
