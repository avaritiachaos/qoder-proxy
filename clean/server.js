const { createApp } = require('./app');
const { log } = require('./logger');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);

const app = createApp();

app.listen(PORT, HOST, () => {
  log(`Qoder CN clean proxy listening on http://${HOST}:${PORT}`);
  log('Qoder CN auth source', {
    token_configured: Boolean(process.env.QODERCN_PERSONAL_ACCESS_TOKEN),
  });
});
