const config = require('./index');

function validateConfig({ strict = false } = {}) {
  const errors = [];
  const warnings = [];
  const nodeEnv = process.env.NODE_ENV || 'development';

  if (!process.env.GOAPP_ADMIN_TOKEN || config.admin.token === 'goapp-admin-secret') {
    const msg = 'GOAPP_ADMIN_TOKEN is using default value.';
    if (strict || nodeEnv === 'production') errors.push(msg); else warnings.push(msg);
  }

  if ((nodeEnv === 'production' || strict) && (process.env.CORS_ORIGIN || '*') === '*') {
    errors.push('CORS_ORIGIN must be explicitly set in strict/production mode.');
  }

  if ((nodeEnv === 'production' || strict) && config.sms.provider !== 'console') {
    if (config.sms.provider === 'twilio') {
      if (!config.sms.twilio.accountSid || !config.sms.twilio.authToken || !config.sms.twilio.fromNumber) {
        errors.push('Twilio SMS provider selected but credentials are incomplete.');
      }
    }
  }

  // ─── Database validation ────────────────────────────────────────────────────
  const needsRealServices = nodeEnv === 'test' || nodeEnv === 'production';

  if (needsRealServices && config.db.backend !== 'pg') {
    errors.push(`DB_BACKEND must be 'pg' in ${nodeEnv} environment (got '${config.db.backend}').`);
  }

  if (config.db.backend === 'pg') {
    if (!config.db.password) errors.push('POSTGRES_PASSWORD is required when DB_BACKEND=pg.');
    if (!config.db.database) errors.push('POSTGRES_DB is required when DB_BACKEND=pg.');
    if (config.db.pool.max < config.db.pool.min) {
      errors.push(`POSTGRES_POOL_MAX (${config.db.pool.max}) must be >= POSTGRES_POOL_MIN (${config.db.pool.min}).`);
    }
    if (nodeEnv === 'production' && !config.db.ssl) {
      warnings.push('POSTGRES_SSL is not enabled in production. Consider enabling SSL for RDS connections.');
    }
  }

  // ─── Redis validation ───────────────────────────────────────────────────────

  if (needsRealServices && config.redis.backend !== 'real') {
    errors.push(`REDIS_BACKEND must be 'real' in ${nodeEnv} environment (got '${config.redis.backend}').`);
  }

  if (config.redis.backend === 'real' && !config.redis.host) {
    errors.push('REDIS_HOST is required when REDIS_BACKEND=real.');
  }

  return { ok: errors.length === 0, errors, warnings, profile: nodeEnv };
}

module.exports = validateConfig;
