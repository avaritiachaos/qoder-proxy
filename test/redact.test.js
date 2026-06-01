const test = require('node:test');
const assert = require('node:assert/strict');
const { redact, redactString } = require('../clean/redact');

test('redacts bearer tokens and sensitive keys', () => {
  assert.equal(redactString('Authorization: Bearer abc.def'), 'Authorization: Bearer [REDACTED]');
  assert.deepEqual(redact({ token: 'secret', nested: { cookie: 'a=b', ok: 'yes' } }), {
    token: '[REDACTED]',
    nested: { cookie: '[REDACTED]', ok: 'yes' },
  });
});
