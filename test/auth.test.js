const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const qoderCli = require('../clean/qodercn-cli');
const { createApp } = require('../clean/app');
const { isAllowedHost, isAllowedOrigin } = require('../clean/auth');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, port });
    });
  });
}

/** Raw request, for headers fetch() refuses to send (Host). */
function rawRequest(port, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, method: 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Run a test body with specific env vars set, restoring them afterwards. */
async function withEnv(vars, body) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CHAT_BODY = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });

// ─── Origin / Host predicates ────────────────────────────────────────────────

test('origin predicate allows native clients and loopback pages only', () => {
  // No Origin header: curl, OpenCode, Trae, editor plugins.
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(''), true);

  assert.equal(isAllowedOrigin('http://127.0.0.1:3000'), true);
  assert.equal(isAllowedOrigin('http://localhost:3000'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:5173'), true);
  assert.equal(isAllowedOrigin('http://127.9.9.9:3000'), true);
  assert.equal(isAllowedOrigin('http://[::1]:3000'), true);

  assert.equal(isAllowedOrigin('https://evil.example'), false);
  assert.equal(isAllowedOrigin('http://evil.example'), false);
  // A hostname merely containing a loopback name must not pass.
  assert.equal(isAllowedOrigin('http://localhost.evil.example'), false);
  assert.equal(isAllowedOrigin('http://127.0.0.1.evil.example'), false);
  // Sandboxed iframes and file:// pages send "null".
  assert.equal(isAllowedOrigin('null'), false);
  assert.equal(isAllowedOrigin('not a url'), false);
});

test('ALLOWED_ORIGINS opts in extra origins without loosening the default', async () => {
  await withEnv({ ALLOWED_ORIGINS: 'https://studio.example, http://localhost:5173/' }, () => {
    assert.equal(isAllowedOrigin('https://studio.example'), true);
    // Trailing slashes and case must not decide the outcome.
    assert.equal(isAllowedOrigin('https://Studio.Example/'), true);
    assert.equal(isAllowedOrigin('http://localhost:5173'), true);
    assert.equal(isAllowedOrigin('https://other.example'), false);
  });
});

test('host predicate blocks DNS rebinding but tolerates a missing Host', () => {
  assert.equal(isAllowedHost('127.0.0.1:3000'), true);
  assert.equal(isAllowedHost('localhost:3000'), true);
  assert.equal(isAllowedHost('[::1]:3000'), true);
  assert.equal(isAllowedHost(undefined), true);

  // A page whose domain resolves to 127.0.0.1 still names itself in Host.
  assert.equal(isAllowedHost('rebind.evil.example:3000'), false);
  assert.equal(isAllowedHost('192.168.1.20:3000'), false);
});

test('ALLOWED_HOSTS opts in a deliberate front-end hostname', async () => {
  await withEnv({ ALLOWED_HOSTS: 'proxy.internal' }, () => {
    assert.equal(isAllowedHost('proxy.internal'), true);
    assert.equal(isAllowedHost('proxy.internal:8080'), true);
    assert.equal(isAllowedHost('other.internal:8080'), false);
  });
});

// ─── End-to-end request handling ─────────────────────────────────────────────

test('a third-party web page cannot reach the chat endpoint', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  let cliCalled = false;
  qoderCli.runQoderCnCli = async () => {
    cliCalled = true;
    return 'should never run';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: CHAT_BODY,
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error.code, 'origin_not_allowed');
    // The important part: the quota was never spent.
    assert.equal(cliCalled, false);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('a rejected origin does not get CORS approval on preflight either', async () => {
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  } finally {
    server.close();
  }
});

test('the local web console is still allowed through as a same-origin caller', async () => {
  const { server, baseUrl, port } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      `http://127.0.0.1:${port}`
    );
  } finally {
    server.close();
  }
});

test('a rebinding Host header is refused', async () => {
  const { server, port } = await listen(createApp());
  try {
    // Host is a forbidden header for fetch(), which silently derives it from
    // the URL — so this has to go out over a raw request to be a real test of
    // a domain that resolved to 127.0.0.1 while naming itself in Host.
    const rebound = await rawRequest(port, '/v1/models', { host: 'rebind.evil.example' });
    assert.equal(rebound.status, 403);
    assert.equal(JSON.parse(rebound.body).error.code, 'host_not_allowed');

    const loopback = await rawRequest(port, '/v1/models', { host: `127.0.0.1:${port}` });
    assert.equal(loopback.status, 200);
  } finally {
    server.close();
  }
});

test('PROXY_API_KEY is actually enforced once set', async () => {
  await withEnv({ PROXY_API_KEY: 'sekret-key' }, async () => {
    const { server, baseUrl } = await listen(createApp());
    try {
      const missing = await fetch(`${baseUrl}/v1/models`);
      assert.equal(missing.status, 401);
      assert.equal((await missing.json()).error.code, 'invalid_api_key');

      const wrong = await fetch(`${baseUrl}/v1/models`, {
        headers: { authorization: 'Bearer nope' },
      });
      assert.equal(wrong.status, 401);

      const bearer = await fetch(`${baseUrl}/v1/models`, {
        headers: { authorization: 'Bearer sekret-key' },
      });
      assert.equal(bearer.status, 200);

      // Anthropic clients send the key as x-api-key instead.
      const apiKeyHeader = await fetch(`${baseUrl}/v1/models`, {
        headers: { 'x-api-key': 'sekret-key' },
      });
      assert.equal(apiKeyHeader.status, 200);
    } finally {
      server.close();
    }
  });
});

test('PROXY_API_KEY also guards the usage endpoints', async () => {
  await withEnv({ PROXY_API_KEY: 'sekret-key' }, async () => {
    const { server, baseUrl } = await listen(createApp());
    try {
      assert.equal((await fetch(`${baseUrl}/usage/local`)).status, 401);
      const reset = await fetch(`${baseUrl}/usage/reset-local`, { method: 'POST' });
      assert.equal(reset.status, 401);

      const allowed = await fetch(`${baseUrl}/usage/local`, {
        headers: { authorization: 'Bearer sekret-key' },
      });
      assert.equal(allowed.status, 200);
    } finally {
      server.close();
    }
  });
});

test('key errors on /v1/messages keep the Anthropic error shape', async () => {
  await withEnv({ PROXY_API_KEY: 'sekret-key' }, async () => {
    const { server, baseUrl } = await listen(createApp());
    try {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(response.status, 401);
      const body = await response.json();
      assert.equal(body.type, 'error');
      assert.equal(body.error.type, 'authentication_error');
    } finally {
      server.close();
    }
  });
});

test('/health stays open for liveness checks and leaks nothing', async () => {
  await withEnv({ PROXY_API_KEY: 'sekret-key' }, async () => {
    const { server, baseUrl } = await listen(createApp());
    try {
      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });
    } finally {
      server.close();
    }
  });
});

test('the root route no longer exposes local filesystem paths', async () => {
  const { server, baseUrl } = await listen(createApp());
  try {
    const body = await (await fetch(`${baseUrl}/`)).json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.cli_backend, 'string');
    // cli_home embedded the OS username; cli_command could hold a full path.
    assert.equal('cli_home' in body, false);
    assert.equal('cli_command' in body, false);
  } finally {
    server.close();
  }
});
