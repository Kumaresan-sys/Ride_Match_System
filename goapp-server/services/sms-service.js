// GoApp SMS Service
// Third-party SMS OTP delivery via Twilio (primary) or MSG91 (fallback).
// Configure via environment variables. Falls back to console log in dev.

const { logger } = require('../utils/logger');

// ─── Provider: Twilio ─────────────────────────────────────────────────────
async function sendViaTwilio(to, message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !from) {
    throw new Error('Twilio credentials not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER)');
  }

  // Twilio REST API — no SDK dependency required
  const body = new URLSearchParams({ To: to, From: from, Body: message }).toString();
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
    },
    body,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Twilio error ${response.status}: ${err.message || response.statusText}`);
  }

  const data = await response.json();
  return { provider: 'twilio', sid: data.sid, status: data.status };
}

// ─── Provider: MSG91 ──────────────────────────────────────────────────────
async function sendViaMSG91(to, otp, templateId) {
  const authKey    = process.env.MSG91_AUTH_KEY;
  const senderId   = process.env.MSG91_SENDER_ID  || 'GOAPP';
  const tmplId     = templateId || process.env.MSG91_TEMPLATE_ID;

  if (!authKey) {
    throw new Error('MSG91 credentials not configured (MSG91_AUTH_KEY)');
  }

  const payload = {
    template_id: tmplId,
    mobile:      to.replace(/^\+/, ''),   // MSG91 expects number without +
    authkey:     authKey,
    otp,
  };

  const response = await fetch('https://control.msg91.com/api/v5/otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/JSON', authkey: authKey },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`MSG91 error ${response.status}: ${err.message || response.statusText}`);
  }

  const data = await response.json();
  return { provider: 'msg91', requestId: data.request_id, type: data.type };
}

// ─── Provider: 2Factor ────────────────────────────────────────────────────
async function sendVia2Factor(to, otp) {
  const apiKey = process.env.TWOFACTOR_API_KEY;
  if (!apiKey) {
    throw new Error('2Factor credentials not configured (TWOFACTOR_API_KEY)');
  }

  const phone = to.replace(/^\+91/, '');  // 2Factor expects 10-digit Indian number
  const url = `https://2factor.in/API/V1/${apiKey}/SMS/${phone}/${otp}/OTP1`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.Status !== 'Success') {
    throw new Error(`2Factor error: ${data.Details}`);
  }
  return { provider: '2factor', sessionId: data.Details };
}

// ─── SmsService ───────────────────────────────────────────────────────────
class SmsService {
  constructor() {
    this.provider = process.env.SMS_PROVIDER || 'console'; // twilio | msg91 | 2factor | console
    this.logs = [];  // Dev-mode delivery log
  }

  /**
   * Send OTP to phone number.
   * Returns a promise with provider result or dev-mode log entry.
   */
  async sendOtp(phoneNumber, otpCode, requestId) {
    const message = `Your GoApp OTP is ${otpCode}. Valid for 2 minutes. Do not share. Ref: ${requestId}`;

    try {
      let result;

      switch (this.provider) {
        case 'twilio':
          result = await sendViaTwilio(phoneNumber, message);
          break;

        case 'msg91':
          result = await sendViaMSG91(phoneNumber, otpCode);
          break;

        case '2factor':
          result = await sendVia2Factor(phoneNumber, otpCode);
          break;

        default:
          // Development / testing: log to console, do NOT expose in API responses
          logger.info('SMS-DEV', `[OTP] ${phoneNumber} → ${otpCode} (requestId: ${requestId})`);
          result = { provider: 'console', delivered: true };
      }

      this.logs.push({
        phoneNumber,
        requestId,
        provider: result.provider,
        sentAt: new Date().toISOString(),
        status: 'sent',
      });

      logger.info('SMS', `OTP delivered via ${result.provider} to ${phoneNumber}`);
      return result;

    } catch (err) {
      logger.error('SMS', `Failed to deliver OTP to ${phoneNumber}: ${err.message}`);
      this.logs.push({
        phoneNumber,
        requestId,
        provider: this.provider,
        sentAt: new Date().toISOString(),
        status: 'failed',
        error: err.message,
      });
      throw err;
    }
  }

  getStats() {
    const total = this.logs.length;
    const sent   = this.logs.filter(l => l.status === 'sent').length;
    const failed = this.logs.filter(l => l.status === 'failed').length;
    return { provider: this.provider, total, sent, failed };
  }
}

module.exports = new SmsService();
