const MODELS = [
  { id: 'qoder-cn', name: 'Qoder CN Auto', cliModel: 'auto', reasoning: true },
  { id: 'auto', name: 'Auto', cliModel: 'auto', reasoning: true },
  { id: 'qwen3.7-max', name: 'Qwen3.7-Max', cliModel: 'Qwen3.7-Max', reasoning: true },
  { id: 'qwen3.7-max-effort-low', name: 'Qwen3.7-Max low', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.7-max-effort-medium', name: 'Qwen3.7-Max medium', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.7-max-effort-high', name: 'Qwen3.7-Max high', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.7-max-effort-max', name: 'Qwen3.7-Max max', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'glm-5.1', name: 'GLM-5.1', cliModel: 'GLM-5.1', reasoning: true },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', cliModel: 'Kimi-K2.6', reasoning: true },
  { id: 'qwen3.6-plus', name: 'Qwen3.6-Plus', cliModel: 'Qwen3.6-Plus', reasoning: true },
  { id: 'qwen3.6-flash', name: 'Qwen3.6-Flash', cliModel: 'Qwen3.6-Flash', reasoning: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', cliModel: 'DeepSeek-V4-Pro', reasoning: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', cliModel: 'DeepSeek-V4-Flash', reasoning: true },
];

const DEFAULT_MODEL_ID = 'qoder-cn';
const EFFORT_SUFFIX_RE = /^(.*)-effort-(low|medium|high|max)$/;

function getModel(modelId) {
  return MODELS.find((model) => model.id === modelId);
}

function resolveCliModel(modelId) {
  if (process.env.QODERCN_MODEL) return process.env.QODERCN_MODEL;
  return getModel(modelId)?.cliModel || modelId || 'auto';
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
  getModel,
  resolveCliModel,
  resolveModelRoute,
};
