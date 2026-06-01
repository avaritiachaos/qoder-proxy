class AppError extends Error {
  constructor(status, code, message, type = 'server_error') {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

function openAiError(res, error) {
  const status = error.status || 500;
  const code = error.code || 'internal_error';
  const type = error.type || (status >= 500 ? 'server_error' : 'invalid_request_error');
  const message = error.publicMessage || error.message || 'Internal server error';

  return res.status(status).json({
    error: {
      message,
      type,
      code,
    },
  });
}

function anthropicError(res, error) {
  const status = error.status || 500;
  const type = error.type || (status >= 500 ? 'api_error' : 'invalid_request_error');
  const message = error.publicMessage || error.message || 'Internal server error';

  return res.status(status).json({
    type: 'error',
    error: {
      type,
      message,
    },
  });
}

module.exports = {
  AppError,
  anthropicError,
  openAiError,
};
