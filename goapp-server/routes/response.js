'use strict';

function buildError(status, message, errorCode, extra = {}) {
  return {
    status,
    data: {
      success: false,
      message,
      ...(errorCode ? { errorCode } : {}),
      ...extra,
    },
  };
}

function badRequest(message, errorCode = 'BAD_REQUEST', extra = {}) {
  return buildError(400, message, errorCode, extra);
}

function unauthorizedError(message = 'Authentication failed.', errorCode = 'AUTH_REQUIRED', extra = {}) {
  return buildError(401, message, errorCode, extra);
}

function forbiddenError(message = 'Forbidden', errorCode = 'FORBIDDEN', extra = {}) {
  return buildError(403, message, errorCode, extra);
}

function notFoundError(message = 'Not found', errorCode = 'NOT_FOUND', extra = {}) {
  return buildError(404, message, errorCode, extra);
}

function conflictError(message = 'Request conflict', errorCode = 'CONFLICT', extra = {}) {
  return buildError(409, message, errorCode, extra);
}

function rateLimitError(message = 'Too many requests', errorCode = 'RATE_LIMITED', extra = {}) {
  return buildError(429, message, errorCode, extra);
}

function internalError(message = 'Internal server error', errorCode = 'INTERNAL_ERROR', extra = {}) {
  return buildError(500, message, errorCode, extra);
}

function normalizeAuthError(authError) {
  const status = Number(authError?.status || 401);
  const payload = authError?.data || {};
  const message = payload.message || payload.error || 'Authentication failed.';
  const errorCode = payload.errorCode
    || payload.code
    || (status === 401 ? 'AUTH_REQUIRED' : 'AUTH_ERROR');
  return buildError(status, message, errorCode);
}

function normalizeRouteError(routeError, fallbackCode = null) {
  const status = Number(routeError?.status || 500);
  const payload = routeError?.data || {};
  const message = payload.message || payload.error || 'Request failed.';
  const errorCode = payload.errorCode
    || payload.code
    || fallbackCode
    || (status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'FORBIDDEN' : 'REQUEST_FAILED');

  const extra = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'message' || key === 'error' || key === 'errorCode' || key === 'code' || key === 'success') {
      continue;
    }
    extra[key] = value;
  }

  return buildError(status, message, errorCode, extra);
}

async function getAuthenticatedSession(requireAuth, headers = {}) {
  const auth = await requireAuth(headers || {});
  if (auth.error) return { error: normalizeAuthError(auth.error) };
  return { session: auth.session };
}

function buildErrorFromResult(
  result,
  {
    status = 400,
    defaultCode = 'REQUEST_FAILED',
    defaultMessage = 'Request failed',
    expose = [],
    extra = {},
  } = {},
) {
  const message = result?.message || result?.error || result?.reason || defaultMessage;
  const errorCode = result?.errorCode || result?.code || defaultCode;
  const exposed = {};
  for (const key of expose) {
    if (result?.[key] !== undefined) exposed[key] = result[key];
  }
  return buildError(status, message, errorCode, { ...exposed, ...extra });
}

module.exports = {
  buildError,
  buildErrorFromResult,
  badRequest,
  unauthorizedError,
  forbiddenError,
  notFoundError,
  conflictError,
  rateLimitError,
  internalError,
  normalizeAuthError,
  normalizeRouteError,
  getAuthenticatedSession,
};
