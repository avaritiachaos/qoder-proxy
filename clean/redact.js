const SENSITIVE_KEY_RE = /authorization|cookie|token|access_token|qodercn_personal_access_token/i;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const AUTH_HEADER_RE = /\bAuthorization\s*:\s*(?!Bearer\b)[^"',\s}]+/gi;
const ASSIGNMENT_RE =
  /\b(cookie|token|access_token|QODERCN_PERSONAL_ACCESS_TOKEN)\s*[:=]\s*["']?[^"',\s}]+/gi;

function redactString(value) {
  return String(value)
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(AUTH_HEADER_RE, 'Authorization: [REDACTED]')
    .replace(ASSIGNMENT_RE, (match, key) => `${key}=[REDACTED]`);
}

function redact(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : redact(item, seen);
  }
  return out;
}

module.exports = {
  redact,
  redactString,
};
