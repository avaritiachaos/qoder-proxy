'use strict';

const crypto = require('crypto');
const { AppError, anthropicError, openAiError } = require('./errors');

// The proxy binds to 127.0.0.1, but that alone does not make it private:
//
//   * Any web page the user visits can POST to http://127.0.0.1:3000 from the
//     browser. Loopback binding does not stop that — only an Origin check does.
//   * A DNS-rebinding domain can resolve to 127.0.0.1 and reach the same
//     socket, carrying its own name in the Host header.
//
// Native API clients (curl, OpenCode, Trae, Cline, editor plugins) send no
// Origin header at all, so requiring a loopback Origin costs them nothing while
// closing both holes.

const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1', '[::1]']);

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOrigin(value) {
  return String(value || '').trim().toLowerCase().replace(/\/+$/, '');
}

/** Extract the hostname from a Host header value ("host", "host:port", "[::1]:port"). */
function hostnameOf(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(0, end + 1);
  }
  return value.split(':')[0];
}

function isLoopbackHostname(hostname) {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  // 127.0.0.0/8 is entirely loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Guard against DNS rebinding: a request that arrives on the loopback socket
 * but names some other host was sent by a page that resolved that name to
 * 127.0.0.1. ALLOWED_HOSTS is the explicit opt-out for anyone who deliberately
 * fronts the proxy with a different hostname.
 */
function isAllowedHost(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  // HTTP/1.0 clients may omit Host. Browsers never do, so this is not an
  // attack vector — accept it rather than breaking simple scripts.
  if (!value) return true;

  const allowed = splitList(process.env.ALLOWED_HOSTS).map((host) => host.toLowerCase());
  if (allowed.includes(value)) return true;

  const hostname = hostnameOf(value);
  if (allowed.includes(hostname)) return true;

  return isLoopbackHostname(hostname);
}

/**
 * Only same-machine browser origins may talk to the proxy. Anything else is a
 * third-party page spending the user's Qoder quota, so it is refused outright
 * rather than merely having its CORS headers withheld.
 */
function isAllowedOrigin(originHeader) {
  const origin = String(originHeader || '').trim();
  if (!origin) return true; // Not a browser — native API client.
  // "null" is what a sandboxed iframe or a file:// page sends.
  if (origin.toLowerCase() === 'null') return false;

  const allowed = splitList(process.env.ALLOWED_ORIGINS).map(normalizeOrigin);
  if (allowed.includes(normalizeOrigin(origin))) return true;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isLoopbackHostname(parsed.hostname.toLowerCase());
}

function isProxyAuthEnabled() {
  return Boolean((process.env.PROXY_API_KEY || '').trim());
}

function timingSafeEquals(presented, expected) {
  // Hash first so the comparison operates on equal-length buffers without
  // leaking the expected key's length.
  const left = crypto.createHash('sha256').update(String(presented), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

function extractPresentedKey(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  return '';
}

/**
 * Anthropic clients expect Anthropic-shaped errors; everyone else gets OpenAI's.
 *
 * Uses originalUrl rather than req.path: these guards are mounted with
 * app.use('/v1', …), and Express strips the mount prefix from req.path, so
 * req.path would read "/messages" here.
 */
function respondWithError(req, res, error) {
  const url = String(req.originalUrl || req.url || '').split('?')[0];
  if (url.startsWith('/v1/messages')) {
    return anthropicError(res, error);
  }
  return openAiError(res, error);
}

function localOnlyGuard(req, res, next) {
  if (!isAllowedHost(req.headers.host)) {
    return respondWithError(
      req,
      res,
      new AppError(
        403,
        'host_not_allowed',
        'Rejected: unexpected Host header. This proxy serves loopback hosts only. ' +
          'Set ALLOWED_HOSTS if you deliberately front it with another hostname.',
        'invalid_request_error'
      )
    );
  }

  if (!isAllowedOrigin(req.headers.origin)) {
    return respondWithError(
      req,
      res,
      new AppError(
        403,
        'origin_not_allowed',
        'Rejected: cross-origin browser requests are not allowed, because any web page ' +
          'you visit could otherwise spend your Qoder quota. Set ALLOWED_ORIGINS if a ' +
          'local web app legitimately needs access.',
        'invalid_request_error'
      )
    );
  }

  return next();
}

function apiKeyGuard(req, res, next) {
  const expected = (process.env.PROXY_API_KEY || '').trim();
  if (!expected) return next(); // Opt-in; unset means no key required.

  const presented = extractPresentedKey(req);
  if (!presented || !timingSafeEquals(presented, expected)) {
    return respondWithError(
      req,
      res,
      new AppError(
        401,
        'invalid_api_key',
        'Invalid or missing API key. Send PROXY_API_KEY as "Authorization: Bearer <key>" ' +
          'or "x-api-key: <key>".',
        'authentication_error'
      )
    );
  }

  return next();
}

module.exports = {
  apiKeyGuard,
  isAllowedHost,
  isAllowedOrigin,
  isProxyAuthEnabled,
  localOnlyGuard,
};
