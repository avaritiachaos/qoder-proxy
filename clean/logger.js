const { redact } = require('./redact');

function log(message, data) {
  const timestamp = new Date().toISOString();
  if (data === undefined) {
    console.log(`[${timestamp}] ${message}`);
    return;
  }
  console.log(`[${timestamp}] ${message}`, redact(data));
}

module.exports = {
  log,
};
