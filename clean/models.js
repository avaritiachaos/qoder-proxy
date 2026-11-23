// Static fallback model registry aligned with `qodercli --list-models` (qodercli 1.1.41).
// At runtime, the proxy can dynamically discover live models from `<cli> --list-models`
// so newly launched or custom models work without manual updates.
const MODELS = [
  { id: 'qoder-cn', name: 'Qoder CN Auto', cliModel: 'auto', reasoning: true },
  { id: 'auto', name: 'Auto', cliModel: 'auto', reasoning: true },
  { id: 'ultimate', name: 'Ultimate', cliModel: 'Ultimate', reasoning: true },
  { id: 'performance', name: 'Performance', cliModel: 'Performance', reasoning: true },
  { id: 'efficient', name: 'Efficient', cliModel: 'Efficient', reasoning: true },
  { id: 'lite', name: 'Lite', cliModel: 'Lite', reasoning: true },
  { id: 'cantus', name: 'Cantus', cliModel: 'Cantus', reasoning: true },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', cliModel: 'Qwen3.8-Max', reasoning: true },
  { id: 'qwen3.8-max-effort-low', name: 'Qwen3.8-Max low', cliModel: 'Qwen3.8-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.8-max-effort-medium', name: 'Qwen3.8-Max medium', cliModel: 'Qwen3.8-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.8-max-effort-high', name: 'Qwen3.8-Max high', cliModel: 'Qwen3.8-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.8-max-effort-max', name: 'Qwen3.8-Max max', cliModel: 'Qwen3.8-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', cliModel: 'Qwen3.8-Flash', reasoning: true },
  { id: 'qwen3.7-max', name: 'Qwen3.7-Max', cliModel: 'Qwen3.7-Max', reasoning: true },
  { id: 'qwen3.7-max-effort-low', name: 'Qwen3.7-Max low', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.7-max-effort-medium', name: 'Qwen3.7-Max medium', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.7-max-effort-high', name: 'Qwen3.7-Max high', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.7-max-effort-max', name: 'Qwen3.7-Max max', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', cliModel: 'Qwen3.7-Plus', reasoning: true },
  { id: 'kimi-k3', name: 'Kimi-K3', cliModel: 'Kimi-K3', reasoning: true },
  { id: 'kimi-k2.7-code', name: 'Kimi-K2.7-Code', cliModel: 'Kimi-K2.7-Code', reasoning: true },
  { id: 'glm-5.3', name: 'GLM-5.3', cliModel: 'GLM-5.3', reasoning: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', cliModel: 'GLM-5.3-Flash', reasoning: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', cliModel: 'DeepSeek-V4-Pro', reasoning: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', cliModel: 'DeepSeek-V4-Flash', reasoning: true },
  { id: 'minimax-m3', name: 'MiniMax-M3', cliModel: 'MiniMax-M3', reasoning: true },
];

const DEFAULT_MODEL_ID = 'qoder-cn';
const EFFORT_SUFFIX_RE = /^(.*)-effort-(low|medium|high|xhigh|max)$/;

let dynamicModels = null;

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function normalizeModelId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

/**
 * Parse stdout from `qoderclicn --list-models` / `qodercli --list-models`.
 *
 * Format emitted by Qoder CLI:
 *   MODEL
 *   Auto
 *   Qwen4-Max
 *   My Custom Model (provider/model-id)
 */
function parseCliModelList(stdout) {
  const lines = stripAnsi(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = [];
  const seenIds = new Set();

  for (const line of lines) {
    if (/^MODEL(?:\s+.*)?$/i.test(line)) continue;
    if (/^[-─=]+$/.test(line)) continue;
    if (/^(?:Warning:|Failed |Error:|Assertion failed:|Not logged in)/i.test(line)) continue;

    let name = line;
    let cliModel = line;

    const parenMatch = line.match(/^(.+?)\s+\(([^()]+)\)$/);
    if (parenMatch) {
      const displayName = parenMatch[1].trim();
      const rawKey = parenMatch[2].trim();
      name = displayName;
      // CLI truncates keys > 40 chars with a trailing ellipsis; use the raw key
      // when intact (needed for custom modelIDs) and fall back to displayName otherwise.
      cliModel = rawKey && !rawKey.endsWith('…') && !rawKey.endsWith('...') ? rawKey : displayName;
    }

    const id = normalizeModelId(cliModel);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);

    parsed.push({
      id,
      name,
      cliModel,
      reasoning: true,
    });
  }

  return parsed;
}

function setDynamicModels(models) {
  if (!Array.isArray(models) || models.length === 0) {
    dynamicModels = null;
    return;
  }
  dynamicModels = models.map((model) => ({
    id: model.id,
    name: model.name || model.cliModel || model.id,
    cliModel: model.cliModel || model.name || model.id,
    reasoning: model.reasoning !== false,
    ...(model.effortAlias ? { effortAlias: true } : {}),
  }));
}

function clearDynamicModels() {
  dynamicModels = null;
}

function getActiveModels() {
  if (!dynamicModels || dynamicModels.length === 0) {
    return MODELS;
  }

  const active = [];
  const seenIds = new Set();

  // Always preserve the default proxy alias (`qoder-cn` -> `auto`).
  const defaultEntry = MODELS.find((m) => m.id === DEFAULT_MODEL_ID);
  if (defaultEntry) {
    active.push(defaultEntry);
    seenIds.add(defaultEntry.id);
  }

  for (const model of dynamicModels) {
    if (!model?.id || seenIds.has(model.id)) continue;
    active.push(model);
    seenIds.add(model.id);

    // Keep any static effort aliases whose base model is present in the live catalog.
    for (const alias of MODELS) {
      if (!alias.effortAlias || seenIds.has(alias.id)) continue;
      const match = alias.id.match(EFFORT_SUFFIX_RE);
      if (match && match[1] === model.id) {
        active.push(alias);
        seenIds.add(alias.id);
      }
    }
  }

  return active;
}

function findModelInList(list, modelId) {
  if (!Array.isArray(list) || !modelId) return undefined;
  const exact = list.find((model) => model.id === modelId);
  if (exact) return exact;

  const lower = String(modelId).trim().toLowerCase();
  if (!lower) return undefined;
  return list.find(
    (model) =>
      model.id.toLowerCase() === lower ||
      String(model.cliModel || '').toLowerCase() === lower
  );
}

function getModel(modelId) {
  if (!modelId) return undefined;
  if (dynamicModels) {
    const found = findModelInList(dynamicModels, modelId);
    if (found) return found;
  }
  return findModelInList(MODELS, modelId);
}

function resolveCliModel(modelId) {
  if (process.env.QODERCN_MODEL) return process.env.QODERCN_MODEL;
  const model = getModel(modelId);
  if (model) return model.cliModel;
  // Fallback to auto for unknown models (e.g. claude-haiku, gpt-4, etc.)
  return 'auto';
}

function resolveModelRoute(modelId) {
  const match = modelId ? String(modelId).match(EFFORT_SUFFIX_RE) : null;
  const baseModelId = match ? match[1] : modelId;
  return {
    baseModelId,
    cliModel: resolveCliModel(baseModelId),
    reasoningEffort: match?.[2],
  };
}

module.exports = {
  DEFAULT_MODEL_ID,
  MODELS,
  clearDynamicModels,
  getActiveModels,
  getModel,
  parseCliModelList,
  resolveCliModel,
  resolveModelRoute,
  setDynamicModels,
};
