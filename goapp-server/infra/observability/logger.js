'use strict';

const crypto = require('crypto');

function timestamp() {
  return new Date().toISOString();
}

function safeStringify(data) {
  try {
    return JSON.stringify(data);
  } catch (_) {
    return JSON.stringify({ error: 'serialization_failed' });
  }
}

function write(level, message, fields = {}) {
  const entry = {
    ts: timestamp(),
    level,
    message,
    ...fields,
  };
  process.stdout.write(`${safeStringify(entry)}\n`);
}

function child(baseFields = {}) {
  return {
    info: (message, fields = {}) => write('info', message, { ...baseFields, ...fields }),
    warn: (message, fields = {}) => write('warn', message, { ...baseFields, ...fields }),
    error: (message, fields = {}) => write('error', message, { ...baseFields, ...fields }),
    debug: (message, fields = {}) => write('debug', message, { ...baseFields, ...fields }),
  };
}

function requestContext(headers = {}, ids = {}) {
  return {
    requestId: ids.requestId || headers['x-request-id'] || crypto.randomUUID(),
    userId: ids.userId || null,
    driverId: ids.driverId || null,
    rideId: ids.rideId || null,
    eventId: ids.eventId || null,
  };
}

module.exports = {
  info: (message, fields = {}) => write('info', message, fields),
  warn: (message, fields = {}) => write('warn', message, fields),
  error: (message, fields = {}) => write('error', message, fields),
  debug: (message, fields = {}) => write('debug', message, fields),
  child,
  requestContext,
};
