// GoApp Identity Service
// OTP-only auth flow.
//
// DB_BACKEND=mock  → all state in in-memory Maps (zero setup)
// DB_BACKEND=pg    → all state persisted to PostgreSQL via pg-identity-repository

'use strict';

const crypto = require('crypto');
const config = require('../config');
const { logger, eventBus } = require('../utils/logger');

const USE_PG = config.db.backend === 'pg';
const pgRepo = USE_PG ? require('../repositories/pg/pg-identity-repository') : null;

// OTP rate limit constants (used in both modes)
const OTP_RATE_WINDOW_MS = 10 * 60 * 1000;
const OTP_RATE_MAX       = 5;

// HMAC secret for OTP hashing. Must be non-empty in production.
const OTP_SECRET = config.otp?.secret || '';

class IdentityService {
  constructor() {
    // ── In-memory stores (mock mode only) ──
    this.usersByPhone    = new Map();
    this.usersById       = new Map();
    this.otpByRequestId  = new Map();
    this.otpIndexByPhone = new Map();
    this.sessions        = new Map();
    this.otpRateByPhone  = new Map();
    this.seedMeta        = null;
  }

  // ─── Seed (mock mode only) ────────────────────────────────────────────────

  seedUsers(users = []) {
    if (USE_PG) {
      logger.warn('IDENTITY', 'seedUsers() is a no-op in pg mode — users are created via OTP verify');
      return { seededAt: Date.now(), count: 0 };
    }

    this.usersByPhone.clear();
    this.usersById.clear();

    for (const user of users) {
      const phone = this._normalizePhone(user.phoneNumber);
      const row = {
        userId:        user.userId,
        phoneNumber:   phone,
        name:          user.name,
        userType:      user.userType || 'rider',
        phoneVerified: Boolean(user.phoneVerified),
        status:        user.status || 'active',
        createdAt:     user.createdAt || Date.now(),
      };
      this.usersByPhone.set(phone, row);
      this.usersById.set(row.userId, row);
    }

    this.seedMeta = { seededAt: Date.now(), count: this.usersById.size };
    return this.seedMeta;
  }

  // ─── Request OTP ──────────────────────────────────────────────────────────

  async requestOtp({ phoneNumber, otpType = 'login', channel = 'sms' }) {
    const phone = this._normalizePhone(phoneNumber);
    if (!phone || phone.replace(/\D/g, '').length < 7) {
      return { success: false, error: 'valid phoneNumber required' };
    }

    const now = Date.now();

    // ── Rate Limiting ──
    if (USE_PG) {
      const rateRecord = await pgRepo.getRateLimit(phone);
      if (rateRecord && rateRecord.request_count >= OTP_RATE_MAX) {
        logger.warn('IDENTITY', `OTP rate limit hit (pg) for ${this._maskPhone(phone)}`);
        return { success: false, error: 'Too many OTP requests. Try again later.', retryAfterSec: 60 };
      }
      // ── Reuse active OTP if within resend cooldown (PG) ──
      // Check cooldown BEFORE incrementing rate limit so cooldown hits
      // don't burn rate limit slots.
      const cooldownOtp = await pgRepo.getActiveOtpByPhone(phone);
      if (cooldownOtp && cooldownOtp.expiresAt > now && cooldownOtp.resendAt > now) {
        return {
          success: true,
          requestId: cooldownOtp.id,
          expiresAt: cooldownOtp.expiresAt,
          resendAfterSec: Math.ceil((cooldownOtp.resendAt - now) / 1000),
        };
      }
      await pgRepo.incrementRateLimit(phone);
    } else {
      const rateRecord = this.otpRateByPhone.get(phone);
      if (rateRecord && (now - rateRecord.windowStart) < OTP_RATE_WINDOW_MS) {
        if (rateRecord.count >= OTP_RATE_MAX) {
          const retryAfterSec = Math.ceil((rateRecord.windowStart + OTP_RATE_WINDOW_MS - now) / 1000);
          logger.warn('IDENTITY', `OTP rate limit hit for ${this._maskPhone(phone)}`);
          return { success: false, error: 'Too many OTP requests. Try again later.', retryAfterSec };
        }
        rateRecord.count++;
      } else {
        this.otpRateByPhone.set(phone, { count: 1, windowStart: now });
      }

      // ── Reuse active OTP if within resend cooldown (mock) ──
      const existingId = this.otpIndexByPhone.get(phone);
      if (existingId) {
        const existing = this.otpByRequestId.get(existingId);
        if (existing && existing.status === 'pending' && existing.expiresAt > now && existing.resendAt > now) {
          return {
            success: true,
            requestId: existing.requestId,
            expiresAt: existing.expiresAt,
            resendAfterSec: Math.ceil((existing.resendAt - now) / 1000),
          };
        }
      }
    }

    // ── Invalidate all previous pending OTPs for this phone ──
    if (USE_PG) {
      await pgRepo.expirePendingOtpsByPhone(phone);
    } else {
      const oldId = this.otpIndexByPhone.get(phone);
      if (oldId) {
        const old = this.otpByRequestId.get(oldId);
        if (old && old.status === 'pending') {
          old.status = 'expired';
        }
      }
    }

    // ── Generate new OTP ──
    const otpCode   = this._generateOtp();           // plaintext — sent via SMS
    const otpHash   = this._hashOtp(otpCode);        // stored in DB/memory
    const requestId = USE_PG
      ? crypto.randomUUID()
      : `OTP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const expiresAt = now + 120_000;
    const resendAt  = now +  30_000;

    if (USE_PG) {
      await pgRepo.createOtpRequest({ requestId, phoneNumber: phone, otpCode: otpHash, otpType, channel, expiresAt });
    } else {
      const request = {
        requestId, phoneNumber: phone, otpCode: otpHash, otpType, channel,
        status: 'pending', attempts: 0, maxAttempts: 3,
        createdAt: now, resendAt, expiresAt, verifiedAt: null,
      };
      this.otpByRequestId.set(requestId, request);
      this.otpIndexByPhone.set(phone, requestId);
    }

    eventBus.publish('otp_requested', { phoneNumber: phone, requestId, otpType, channel });
    logger.info('IDENTITY', `OTP generated for ${this._maskPhone(phone)} (${requestId})`);

    // Deliver plaintext OTP via SMS (never the hash)
    try {
      const smsService = require('./sms-service');
      Promise.resolve(smsService.sendOtp(phone, otpCode, requestId))
        .catch(err => logger.warn('IDENTITY', `SMS delivery failed: ${err.message}`));
    } catch (e) {
      logger.warn('IDENTITY', `SMS delivery skipped: ${e.message}`);
    }

    return { success: true, requestId, expiresAt };
  }

  // ─── Verify OTP ───────────────────────────────────────────────────────────

  async verifyOtp({
    phoneNumber,
    requestId,
    otpCode,
    deviceId = null,
    platform = null,
    fcmToken = null,
    deviceModel = null,
    osVersion = null,
    appVersion = null,
    ipAddress = null,
    userAgent = null,
  }) {
    const phone = this._normalizePhone(phoneNumber);
    const now   = Date.now();
    let effectiveRequestId = requestId;

    if (!effectiveRequestId) {
      if (USE_PG) {
        const active = await pgRepo.getActiveOtpByPhone(phone);
        effectiveRequestId = active?.id;
      } else {
        effectiveRequestId = this.otpIndexByPhone.get(phone);
      }
    }

    if (USE_PG) {
      const request = await pgRepo.getOtpRequest(effectiveRequestId);
      if (!request || request.phone_number !== phone) {
        return { success: false, error: 'invalid request' };
      }
      if (request.status !== 'pending') {
        return { success: false, error: `otp status is ${request.status}` };
      }
      if (now > request.expiresAt) {
        await pgRepo.recordOtpAttempt(effectiveRequestId, 'expired', {
          enteredCode: String(otpCode || ''),
          isCorrect: false,
          ipAddress,
        });
        return { success: false, error: 'otp expired' };
      }
      // Compare against stored hash, not plaintext
      if (request.otp_code !== this._hashOtp(String(otpCode || ''))) {
        const newStatus = (request.attempts + 1) >= request.max_attempts ? 'failed' : null;
        const updated   = await pgRepo.recordOtpAttempt(effectiveRequestId, newStatus, {
          enteredCode: String(otpCode || ''),
          isCorrect: false,
          ipAddress,
        });
        return { success: false, error: 'invalid otp', attempts: updated.attempts };
      }

      // Correct OTP — commit user/device/session/login/token writes atomically
      const existing = await pgRepo.getUserByPhone(phone);
      const userId   = existing ? existing.id : crypto.randomUUID();
      const isNewUser = !existing;
      const sessionToken    = crypto.randomUUID();
      const sessionExpiresAt = now + 24 * 3600 * 1000;
      const { user, deviceRecord } = await pgRepo.completeSuccessfulOtpLogin({
        requestId: effectiveRequestId,
        userId,
        phoneNumber: phone,
        userType: 'rider',
        deviceId,
        platform,
        fcmToken,
        deviceModel,
        osVersion,
        appVersion,
        ipAddress,
        sessionToken,
        sessionExpiresAt,
        enteredCode: String(otpCode || ''),
      });
      this.sessions.set(sessionToken, {
        sessionToken,
        userId: user.id,
        phoneNumber: phone,
        createdAt: now,
        expiresAt: sessionExpiresAt,
        deviceId: deviceRecord?.id || null,
      });

      eventBus.publish('otp_verified', { requestId: effectiveRequestId, userId: user.id, phoneNumber: phone });

      return {
        success: true,
        isNewUser,
        user: {
          userId:        user.id,
          phoneNumber:   user.phone_number,
          userType:      user.user_type,
          phoneVerified: user.phone_verified,
          status:        user.status,
          createdAt:     user.createdAt,
        },
        sessionToken,
        deviceRecordId: deviceRecord?.id || null,
      };
    }

    // ── Mock mode ──
    const request = this.otpByRequestId.get(effectiveRequestId);
    if (!request || request.phoneNumber !== phone) {
      return { success: false, error: 'invalid request' };
    }
    if (request.status !== 'pending') {
      return { success: false, error: `otp status is ${request.status}` };
    }
    if (now > request.expiresAt) {
      request.status = 'expired';
      return { success: false, error: 'otp expired' };
    }

    request.attempts++;
    // Compare against stored hash, not plaintext
    if (request.otpCode !== this._hashOtp(String(otpCode || ''))) {
      if (request.attempts >= request.maxAttempts) request.status = 'failed';
      return { success: false, error: 'invalid otp', attempts: request.attempts };
    }

    request.status     = 'verified';
    request.verifiedAt = now;

    const existingUser = this.usersByPhone.get(phone);
    const isNewUser = !existingUser;
    let user = existingUser;
    if (!user) {
      user = {
        userId:        `USR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        phoneNumber:   phone,
        name:          `User-${this.usersById.size + 1}`,
        userType:      'rider',
        phoneVerified: true,
        status:        'active',
        createdAt:     now,
      };
      this.usersByPhone.set(phone, user);
      this.usersById.set(user.userId, user);
    } else {
      user.phoneVerified = true;
    }

    const sessionToken = crypto.randomUUID();
    this.sessions.set(sessionToken, {
      sessionToken,
      userId:      user.userId,
      phoneNumber: phone,
      createdAt:   now,
      expiresAt:   now + 24 * 3600 * 1000,
    });

    eventBus.publish('otp_verified', { requestId: effectiveRequestId, userId: user.userId, phoneNumber: phone });
    return { success: true, isNewUser, user, sessionToken };
  }

  // ─── Validate Session ─────────────────────────────────────────────────────

  async validateSession(sessionToken) {
    if (!sessionToken) return null;
    if (USE_PG) {
      const pgSession = await pgRepo.getSession(sessionToken);
      if (!pgSession) return null;
      const session = {
        sessionToken: pgSession.session_token,
        userId: pgSession.user_id,
        createdAt: pgSession.createdAt,
        expiresAt: pgSession.expiresAt,
      };
      this.sessions.set(sessionToken, session);
      return session;
    }

    const session = this.sessions.get(sessionToken);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionToken);
      return null;
    }
    return session;
  }

  // ─── Read Methods ─────────────────────────────────────────────────────────

  async getUsers(limit = 100) {
    if (USE_PG) return pgRepo.getUsers(limit);
    return [...this.usersById.values()].slice(0, limit);
  }

  async getStats() {
    if (USE_PG) return pgRepo.getStats();

    const otpRows = [...this.otpByRequestId.values()];
    return {
      users:    this.usersById.size,
      sessions: this.sessions.size,
      otp: {
        total:    otpRows.length,
        pending:  otpRows.filter(r => r.status === 'pending').length,
        verified: otpRows.filter(r => r.status === 'verified').length,
        failed:   otpRows.filter(r => r.status === 'failed').length,
        expired:  otpRows.filter(r => r.status === 'expired').length,
      },
      seedMeta: this.seedMeta,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  _normalizePhone(phoneNumber) {
    if (!phoneNumber) return '';
    return String(phoneNumber).replace(/[^\d+]/g, '');
  }

  _generateOtp() {
    return String(crypto.randomInt(100000, 999999));
  }

  // HMAC-SHA256 hash of the OTP code using the server secret.
  // Stored in DB instead of plaintext so a DB dump doesn't expose live codes.
  _hashOtp(otpCode) {
    if (!OTP_SECRET) {
      // No secret configured — fall back to plaintext (dev only; validateConfig warns).
      return String(otpCode);
    }
    return crypto.createHmac('sha256', OTP_SECRET).update(String(otpCode)).digest('hex');
  }

  // Mask phone for logs: +91987***89
  _maskPhone(phone) {
    if (!phone || phone.length < 6) return '***';
    return phone.slice(0, 4) + '***' + phone.slice(-2);
  }
}

module.exports = new IdentityService();
