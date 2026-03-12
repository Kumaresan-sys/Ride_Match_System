'use strict';

const https = require('https');
const querystring = require('querystring');
const config = require('../config');
const { logger } = require('../utils/logger');

class WhatsAppService {
  _normalizeRecipient(phoneNumber) {
    const raw = String(phoneNumber || '').trim();
    if (!raw) return '';
    if (raw.startsWith('whatsapp:')) return raw;
    if (raw.startsWith('+')) return `whatsapp:${raw}`;

    const digits = raw.replace(/\D+/g, '');
    if (digits.length === 10) return `whatsapp:+91${digits}`;
    return digits ? `whatsapp:+${digits}` : '';
  }

  async sendTripShare({ toPhone, messageText, mediaUrl = null }) {
    const provider = String(config.whatsapp?.provider || 'console').trim().toLowerCase();
    const recipient = this._normalizeRecipient(toPhone);

    if (!recipient) {
      return {
        success: false,
        provider,
        errorCode: 'INVALID_PHONE',
        errorMessage: 'Emergency contact phone number is invalid.',
      };
    }

    if (!config.whatsapp?.enabled) {
      logger.info('WHATSAPP', `Sharing disabled. Skipping outbound message to ${recipient}`);
      return {
        success: false,
        provider,
        skipped: true,
        errorCode: 'WHATSAPP_DISABLED',
        errorMessage: 'WhatsApp delivery is disabled.',
      };
    }

    if (provider === 'console') {
      logger.info('WHATSAPP-DEV', `Trip share → ${recipient}\n${messageText}`);
      return {
        success: true,
        provider: 'console',
        providerMessageId: `console-${Date.now()}`,
        response: { to: recipient, mediaUrl },
      };
    }

    if (provider !== 'twilio') {
      return {
        success: false,
        provider,
        errorCode: 'UNSUPPORTED_WHATSAPP_PROVIDER',
        errorMessage: `Unsupported WhatsApp provider: ${provider}`,
      };
    }

    return this._sendViaTwilio(recipient, messageText, mediaUrl);
  }

  _sendViaTwilio(recipient, messageText, mediaUrl = null) {
    const accountSid = String(config.whatsapp?.twilio?.accountSid || '').trim();
    const authToken = String(config.whatsapp?.twilio?.authToken || '').trim();
    const from = String(config.whatsapp?.from || '').trim();

    if (!accountSid || !authToken || !from) {
      return Promise.resolve({
        success: false,
        provider: 'twilio',
        errorCode: 'WHATSAPP_NOT_CONFIGURED',
        errorMessage: 'Twilio WhatsApp credentials are missing.',
      });
    }

    const formBody = {
      From: from.startsWith('whatsapp:') ? from : `whatsapp:${from}`,
      To: recipient,
      Body: String(messageText || '').slice(0, 3900),
    };
    if (mediaUrl) formBody.MediaUrl = mediaUrl;

    const payload = querystring.stringify(formBody);
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = raw; }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({
              success: true,
              provider: 'twilio',
              providerMessageId: parsed?.sid || null,
              response: parsed,
            });
            return;
          }

          resolve({
            success: false,
            provider: 'twilio',
            errorCode: 'WHATSAPP_SEND_FAILED',
            errorMessage: parsed?.message || `Twilio responded with status ${res.statusCode}`,
            response: parsed,
          });
        });
      });

      req.on('error', (err) => {
        resolve({
          success: false,
          provider: 'twilio',
          errorCode: 'WHATSAPP_NETWORK_ERROR',
          errorMessage: err.message,
        });
      });

      req.write(payload);
      req.end();
    });
  }
}

module.exports = new WhatsAppService();
