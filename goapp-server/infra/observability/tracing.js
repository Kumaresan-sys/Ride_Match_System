'use strict';

const crypto = require('crypto');

function id(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function startTrace(name, seed = {}) {
  return {
    traceId: seed.traceId || id(16),
    spanId: id(8),
    name,
    startedAt: Date.now(),
    attrs: { ...(seed.attrs || {}) },
  };
}

function childSpan(trace, name, attrs = {}) {
  return {
    traceId: trace.traceId,
    spanId: id(8),
    parentSpanId: trace.spanId,
    name,
    startedAt: Date.now(),
    attrs,
  };
}

function finish(span) {
  return {
    ...span,
    durationMs: Date.now() - span.startedAt,
    endedAt: Date.now(),
  };
}

module.exports = {
  startTrace,
  childSpan,
  finish,
};
