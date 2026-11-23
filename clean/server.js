require('dotenv').config();
const { createApp } = require('./app');
const { log } = require('./logger');
const { isProxyAuthEnabled } = require('./auth');
const { getCliBackend } = require('./qodercn-cli');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const dynamicModelsEnabled = !/^(0|false|no)$/i.test((process.env.DYNAMIC_MODELS || '').trim());

const app = createApp({ enableDynamicModels: dynamicModelsEnabled });

app.listen(PORT, HOST, () => {
  const backend = getCliBackend();
  log(`Qoder Proxy listening on http://${HOST}:${PORT}`);
  log('CLI backend', {
    name: backend.name,
    command: backend.command,
    home: backend.homeDir,
    token_configured: Boolean(process.env[backend.tokenEnvVar] || process.env.QODERCN_PERSONAL_ACCESS_TOKEN),
    dynamic_models: dynamicModelsEnabled ? 'enabled' : 'disabled',
  });
  log('security', {
    proxy_api_key: isProxyAuthEnabled() ? 'enabled' : 'not set',
    cross_origin: 'loopback origins only',
    server_tool_execution: /^(1|true|yes)$/i.test(process.env.SERVER_TOOL_EXECUTION || '')
      ? 'ENABLED'
      : 'off',
  });
  if (!isProxyAuthEnabled()) {
    log(
      'note: PROXY_API_KEY is not set, so any process on this machine can use the proxy. ' +
        'Set it in .env to require a key.'
    );
  }
  if (dynamicModelsEnabled) {
    // Non-blocking startup warm-up of live CLI models via `<cli> --list-models`.
    app.refreshDynamicModels().catch(() => {});
  }
});
