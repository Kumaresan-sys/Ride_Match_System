'use strict';

function isFiniteNumber(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n);
}

function toNumber(value) {
  return typeof value === 'number' ? value : parseFloat(value);
}

function validateSchema(input, schema) {
  const out = {};
  for (const rule of schema) {
    const value = input?.[rule.key];

    if (value === undefined || value === null || value === '') {
      if (rule.required) {
        return { ok: false, error: `${rule.key} is required` };
      }
      continue;
    }

    if (rule.type === 'string') {
      const str = String(value).trim();
      if (rule.minLength && str.length < rule.minLength) {
        return { ok: false, error: `${rule.key} must be at least ${rule.minLength} chars` };
      }
      if (rule.maxLength && str.length > rule.maxLength) {
        return { ok: false, error: `${rule.key} must be at most ${rule.maxLength} chars` };
      }
      if (rule.pattern && !rule.pattern.test(str)) {
        return { ok: false, error: `${rule.key} is invalid` };
      }
      if (rule.enum && !rule.enum.includes(str)) {
        return { ok: false, error: `${rule.key} must be one of: ${rule.enum.join(', ')}` };
      }
      out[rule.key] = str;
      continue;
    }

    if (rule.type === 'number') {
      if (!isFiniteNumber(value)) {
        return { ok: false, error: `${rule.key} must be a valid number` };
      }
      const num = toNumber(value);
      if (rule.min != null && num < rule.min) {
        return { ok: false, error: `${rule.key} must be >= ${rule.min}` };
      }
      if (rule.max != null && num > rule.max) {
        return { ok: false, error: `${rule.key} must be <= ${rule.max}` };
      }
      out[rule.key] = num;
      continue;
    }

    if (rule.type === 'boolean') {
      out[rule.key] = Boolean(value);
      continue;
    }
  }

  return { ok: true, data: out };
}

function validationError(message) {
  return { status: 400, data: { error: message, code: 'VALIDATION_ERROR' } };
}

function forbiddenError(message = 'Forbidden') {
  return { status: 403, data: { error: message, code: 'FORBIDDEN' } };
}

function parseQueryNumber(params, key, { min = null, max = null, fallback = null } = {}) {
  const raw = params.get(key);
  if (raw == null || raw === '') return { ok: true, value: fallback };
  const parsed = validateSchema({ [key]: raw }, [{ key, type: 'number', required: true, min, max }]);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, value: parsed.data[key] };
}

function parsePathParams(pathParams, schema) {
  return validateSchema(pathParams, schema);
}

module.exports = {
  validateSchema,
  validationError,
  forbiddenError,
  parseQueryNumber,
  parsePathParams,
};
