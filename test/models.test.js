const test = require('node:test');
const assert = require('node:assert/strict');
const qoderCli = require('../clean/qodercn-cli');
const { createApp } = require('../clean/app');
const {
  DEFAULT_MODEL_ID,
  MODELS,
  clearDynamicModels,
  getActiveModels,
  getModel,
  parseCliModelList,
  resolveModelRoute,
  setDynamicModels,
} = require('../clean/models');

test('all models have required fields: id, name, cliModel, reasoning', () => {
  for (const model of MODELS) {
    assert.equal(typeof model.id, 'string', `model missing id`);
    assert.equal(typeof model.name, 'string', `model ${model.id} missing name`);
    assert.equal(typeof model.cliModel, 'string', `model ${model.id} missing cliModel`);
    assert.equal(model.reasoning, true, `model ${model.id} missing reasoning: true`);
  }
});

test('effort alias models have effortAlias: true', () => {
  const effortIds = [
    'qwen3.8-max-effort-low',
    'qwen3.8-max-effort-medium',
    'qwen3.8-max-effort-high',
    'qwen3.8-max-effort-max',
    'qwen3.7-max-effort-low',
    'qwen3.7-max-effort-medium',
    'qwen3.7-max-effort-high',
    'qwen3.7-max-effort-max',
  ];
  for (const id of effortIds) {
    const model = MODELS.find((m) => m.id === id);
    assert.ok(model, `effort model ${id} should exist`);
    assert.equal(model.effortAlias, true, `model ${id} should have effortAlias: true`);
  }
});

test('non-effort models do not have effortAlias', () => {
  const nonEffort = MODELS.filter((m) => !m.id.includes('-effort-'));
  assert.ok(nonEffort.length > 0, 'should have non-effort models');
  for (const model of nonEffort) {
    assert.equal(model.effortAlias, undefined, `model ${model.id} should not have effortAlias`);
  }
});

test('resolveModelRoute parses effort suffixes correctly', () => {
  const low = resolveModelRoute('qwen3.7-max-effort-low');
  assert.equal(low.baseModelId, 'qwen3.7-max');
  assert.equal(low.reasoningEffort, 'low');

  const high = resolveModelRoute('qwen3.7-max-effort-high');
  assert.equal(high.baseModelId, 'qwen3.7-max');
  assert.equal(high.reasoningEffort, 'high');

  const max = resolveModelRoute('deepseek-v4-pro-effort-max');
  assert.equal(max.baseModelId, 'deepseek-v4-pro');
  assert.equal(max.reasoningEffort, 'max');

  const none = resolveModelRoute('qwen3.7-max');
  assert.equal(none.baseModelId, 'qwen3.7-max');
  assert.equal(none.reasoningEffort, undefined);
});

test('getModel returns correct model for known ID', () => {
  const model = getModel('qoder-cn');
  assert.ok(model);
  assert.equal(model.id, 'qoder-cn');
  assert.equal(model.name, 'Qoder CN Auto');
  assert.equal(model.cliModel, 'auto');
  assert.equal(model.reasoning, true);

  const flash = getModel('deepseek-v4-flash');
  assert.ok(flash);
  assert.equal(flash.id, 'deepseek-v4-flash');
  assert.equal(flash.cliModel, 'DeepSeek-V4-Flash');
});

test('current Qoder CLI models resolve to their CLI model names', () => {
  const expected = {
    ultimate: 'Ultimate',
    performance: 'Performance',
    efficient: 'Efficient',
    lite: 'Lite',
    cantus: 'Cantus',
    'qwen3.8-max': 'Qwen3.8-Max',
    'qwen3.8-flash': 'Qwen3.8-Flash',
    'qwen3.7-max': 'Qwen3.7-Max',
    'qwen3.7-plus': 'Qwen3.7-Plus',
    'kimi-k3': 'Kimi-K3',
    'kimi-k2.7-code': 'Kimi-K2.7-Code',
    'glm-5.3': 'GLM-5.3',
    'glm-5.3-flash': 'GLM-5.3-Flash',
    'deepseek-v4-pro': 'DeepSeek-V4-Pro',
    'deepseek-v4-flash': 'DeepSeek-V4-Flash',
    'minimax-m3': 'MiniMax-M3',
  };
  for (const [id, cliModel] of Object.entries(expected)) {
    const route = resolveModelRoute(id);
    assert.equal(route.baseModelId, id);
    assert.equal(route.cliModel, cliModel, `model ${id} should resolve to ${cliModel}`);
  }
});

test('removed model IDs fall back to auto', () => {
  for (const id of ['qwen3.8-max-preview', 'qwen3.6-flash', 'glm-5.2', 'minimax-m2.7']) {
    assert.equal(getModel(id), undefined, `removed model ${id} should not be registered`);
    assert.equal(resolveModelRoute(id).cliModel, 'auto', `removed model ${id} should fall back to auto`);
  }
});

test('getModel returns undefined for unknown ID', () => {
  assert.equal(getModel('nonexistent-model'), undefined);
  assert.equal(getModel(''), undefined);
  assert.equal(getModel(undefined), undefined);
});

test('DEFAULT_MODEL_ID is qoder-cn', () => {
  assert.equal(DEFAULT_MODEL_ID, 'qoder-cn');
});

test('resolveModelRoute supports xhigh reasoning effort suffix', () => {
  const xhigh = resolveModelRoute('qwen3.8-max-effort-xhigh');
  assert.equal(xhigh.baseModelId, 'qwen3.8-max');
  assert.equal(xhigh.cliModel, 'Qwen3.8-Max');
  assert.equal(xhigh.reasoningEffort, 'xhigh');
});

test('parseCliModelList parses standard, aliased, custom, and noisy CLI output', () => {
  const stdout = [
    '\u001b[1mMODEL\u001b[0m',
    'Auto',
    'Qwen4-Max',
    'Qwen3.8-Flash',
    'Qwen3.8-Flash', // duplicate ignored
    'My Custom Model (openai/gpt-5-mini)',
    'Very Long Custom (provider/this-key-was-truncated-by-cli-output…)',
    'Warning: something noisy',
    'Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)',
  ].join('\r\n');

  const parsed = parseCliModelList(stdout);
  assert.deepEqual(parsed, [
    { id: 'auto', name: 'Auto', cliModel: 'Auto', reasoning: true },
    { id: 'qwen4-max', name: 'Qwen4-Max', cliModel: 'Qwen4-Max', reasoning: true },
    { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', cliModel: 'Qwen3.8-Flash', reasoning: true },
    { id: 'openai/gpt-5-mini', name: 'My Custom Model', cliModel: 'openai/gpt-5-mini', reasoning: true },
    { id: 'very-long-custom', name: 'Very Long Custom', cliModel: 'Very Long Custom', reasoning: true },
  ]);
});

test('dynamic models override active list, preserve qoder-cn default, and support effort routing', () => {
  try {
    setDynamicModels([
      { id: 'qwen4-max', name: 'Qwen4-Max', cliModel: 'Qwen4-Max', reasoning: true },
      { id: 'qwen3.8-max', name: 'Qwen3.8-Max', cliModel: 'Qwen3.8-Max', reasoning: true },
      { id: 'minimax-m3.1-flash', name: 'MiniMax-M3.1-Flash', cliModel: 'MiniMax-M3.1-Flash', reasoning: true },
    ]);

    const active = getActiveModels();
    const ids = active.map((m) => m.id);
    assert.equal(ids[0], 'qoder-cn');
    assert.equal(ids.includes('qwen4-max'), true);
    assert.equal(ids.includes('minimax-m3.1-flash'), true);
    // Static effort aliases for a discovered base model are preserved; retired ones are omitted.
    assert.equal(ids.includes('qwen3.8-max-effort-high'), true);
    assert.equal(ids.includes('lite'), false);

    // Both lowercase ID and exact CLI display casing resolve cleanly.
    assert.equal(resolveModelRoute('qwen4-max').cliModel, 'Qwen4-Max');
    assert.equal(resolveModelRoute('Qwen4-Max').cliModel, 'Qwen4-Max');
    assert.deepEqual(resolveModelRoute('qwen4-max-effort-xhigh'), {
      baseModelId: 'qwen4-max',
      cliModel: 'Qwen4-Max',
      reasoningEffort: 'xhigh',
    });
  } finally {
    clearDynamicModels();
  }
});

test('GET /v1/models dynamically discovers, caches, refreshes, and falls back gracefully', async () => {
  const originalList = qoderCli.listCliModels;
  let calls = 0;
  let currentList = [
    { id: 'qwen4-max', name: 'Qwen4-Max', cliModel: 'Qwen4-Max', reasoning: true },
    { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', cliModel: 'Qwen3.8-Flash', reasoning: true },
  ];
  qoderCli.listCliModels = async () => {
    calls += 1;
    return currentList;
  };

  const app = createApp({ enableDynamicModels: true, dynamicModelsTtlMs: 60000 });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // First call triggers discovery.
    const res1 = await fetch(`${baseUrl}/v1/models`);
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(calls, 1);
    assert.deepEqual(
      body1.data.map((m) => m.id),
      ['qoder-cn', 'qwen4-max', 'qwen3.8-flash']
    );

    // Second call within TTL uses cache.
    const res2 = await fetch(`${baseUrl}/v1/models`);
    assert.equal(res2.status, 200);
    assert.equal(calls, 1);

    // Explicit ?refresh=1 forces re-discovery.
    currentList = [
      { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', cliModel: 'Kimi-K3.1-Pro', reasoning: true },
    ];
    const res3 = await fetch(`${baseUrl}/v1/models?refresh=1`);
    assert.equal(res3.status, 200);
    const body3 = await res3.json();
    assert.equal(calls, 2);
    assert.deepEqual(
      body3.data.map((m) => m.id),
      ['qoder-cn', 'kimi-k3.1-pro']
    );
  } finally {
    qoderCli.listCliModels = originalList;
    clearDynamicModels();
    server.close();
  }
});

test('GET /v1/models falls back to static list when CLI model discovery fails', async () => {
  const originalList = qoderCli.listCliModels;
  qoderCli.listCliModels = async () => {
    throw new Error('Not logged in');
  };

  const app = createApp({ enableDynamicModels: true });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${baseUrl}/v1/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, MODELS.length);
    assert.equal(body.data[0].id, 'qoder-cn');
  } finally {
    qoderCli.listCliModels = originalList;
    clearDynamicModels();
    server.close();
  }
});
