const { createApp } = require('./app');
const { log } = require('./logger');
const { getCliBackend } = require('./qodercn-cli');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);

const app = createApp();

app.listen(PORT, HOST, () => {
  const backend = getCliBackend();
  log(`Qoder CN clean proxy listening on http://${HOST}:${PORT}`);
  log('CLI backend', {
    name: backend.name,
    command: backend.command,
    home: backend.homeDir,
    token_configured: Boolean(process.env[backend.tokenEnvVar] || process.env.QODERCN_PERSONAL_ACCESS_TOKEN),
  });
});
