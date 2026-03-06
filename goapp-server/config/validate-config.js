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

  return { ok: errors.length === 0, errors, warnings, profile: nodeEnv };
}

module.exports = validateConfig;
