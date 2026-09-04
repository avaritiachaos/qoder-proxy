const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MODEL_ID,
  MODELS,
  getModel,
  resolveModelRoute,
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
