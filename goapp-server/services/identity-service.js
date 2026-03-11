// GoApp Identity Service
// OTP-only auth flow — all state persisted to PostgreSQL via pg-identity-repository.

'use strict';

const crypto = require('crypto');
const config = require('../config');
const { logger, eventBus } = require('../utils/logger');

const pgRepo = require('../repositories/pg/pg-identity-repository');
const domainProjectionService = require('./domain-projection-service');

// OTP rate limit constants
const OTP_RATE_MAX           = 5;
const SUSPICIOUS_REFRESH_MAX = 3;

// HMAC secret for OTP hashing. Must be non-empty in production.
const OTP_SECRET = config.otp?.secret || '';
const ACCESS_TOKEN_TTL_MS  = config.security.sessionTtlMs;
const REFRESH_TOKEN_TTL_MS = config.security.refreshTokenTtlMs;
const TOKEN_HASH_SECRET    = config.security.tokenHashSecret || OTP_SECRET;

class IdentityService {
  constructor() {
    // In-memory session cache (not a mock — used for sub-millisecond token lookups
    // between DB validates). The authoritative store is PostgreSQL.
    this.sessions        = new Map();
    this.refreshSessions = new Map();
  }

  // ─── Seed (pg mode — no-op, users are created via OTP verify) ───────────

  seedUsers() {
    logger.warn('IDENTITY', 'seedUsers() is a no-op — users are created via OTP verify');
    return { seededAt: Date.now(), count: 0 };
  }

  // ─── Request OTP ──────────────────────────────────────────────────────────

  async requestOtp({ phoneNumber, otpType = 'login', channel = 'sms' }) {
    const phone = this._normalizePhone(phoneNumber);
    if (!phone || phone.replace(/\D/g, '').length < 7) {
      return { success: false, error: 'valid phoneNumber required' };
    }

    const now = Date.now();

    // ── Rate Limiting ──
    const rateRecord = await pgRepo.getRateLimit(phone);
    if (rateRecord && rateRecord.request_count >= OTP_RATE_MAX) {
      logger.warn('IDENTITY', `OTP rate limit hit (pg) for ${this._maskPhone(phone)}`);
      return { success: false, error: 'Too many OTP requests. Try again later.', retryAfterSec: 60 };
    }

    // ── Reuse active OTP if within resend cooldown ──
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

    // ── Invalidate all previous pending OTPs for this phone ──
    await pgRepo.expirePendingOtpsByPhone(phone);

    // ── Generate new OTP ──
    const otpCode   = this._generateOtp();    // plaintext — sent via SMS
    const otpHash   = this._hashOtp(otpCode); // stored in DB
    const requestId = crypto.randomUUID();
    const expiresAt = now + 120_000;

    await pgRepo.createOtpRequest({ requestId, phoneNumber: phone, otpCode: otpHash, otpType, channel, expiresAt });

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
      const active = await pgRepo.getActiveOtpByPhone(phone);
      effectiveRequestId = active?.id;
    }

    const request = await pgRepo.getOtpRequest(effectiveRequestId);
    if (!request || request.phone_number !== phone) {
      return { success: false, error: 'invalid request' };
    }
    if (request.status !== 'pending') {
      return { success: false, error: `otp status is ${request.status}` };
    }
    if (now > request.expiresAt) {
      await pgRepo.recordOtpAttempt(effectiveRequestId, 'expired', {
        isCorrect: false,
        ipAddress,
      });
      return { success: false, error: 'otp expired' };
    }
    // Compare against stored hash, not plaintext
    if (request.otp_code !== this._hashOtp(String(otpCode || ''))) {
      const newStatus = (request.attempts + 1) >= request.max_attempts ? 'failed' : null;
      const updated   = await pgRepo.recordOtpAttempt(effectiveRequestId, newStatus, {
        isCorrect: false,
        ipAddress,
      });
      return { success: false, error: 'invalid otp', attempts: updated.attempts };
    }

    // Correct OTP — commit user/device/session/login/token writes atomically
    const existing = await pgRepo.getUserByPhone(phone);
    const userId   = existing ? existing.id : crypto.randomUUID();
    const isNewUser = !existing;
    const sessionToken       = crypto.randomUUID();
    const refreshToken       = this._generateToken();
    const refreshTokenHash   = this._hashToken(refreshToken);
    const sessionExpiresAt   = now + ACCESS_TOKEN_TTL_MS;
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
      userAgent,
      sessionToken,
      refreshTokenHash,
      sessionExpiresAt,
    });

    try {
      const syncResult = await domainProjectionService.syncRiderByUserId(user.id);
      if (!syncResult?.synced) {
        logger.warn(
          'IDENTITY',
          `Rider projection sync incomplete after login for user ${user.id}: ${syncResult?.reason || 'unknown'}`,
        );
      }
    } catch (err) {
      logger.warn('IDENTITY', `Rider projection sync failed after login for user ${user.id}: ${err.message}`);
    }

    this._storeSession({
      sessionToken,
      refreshToken,
      userId: user.id,
      phoneNumber: phone,
      createdAt: now,
      expiresAt: sessionExpiresAt,
      refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
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
      refreshToken,
      expiresInSec: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      deviceRecordId: deviceRecord?.id || null,
    };
  }

  // ─── Validate Session ─────────────────────────────────────────────────────

  async validateSession(sessionToken) {
    if (!sessionToken) return null;
    const pgSession = await pgRepo.getSession(sessionToken);
    if (!pgSession) return null;
    const session = {
      id: pgSession.id,
      sessionToken: pgSession.session_token,
      refreshToken: null,
      deviceId: pgSession.device_id || null,
      userId: pgSession.user_id,
      createdAt: pgSession.createdAt,
      expiresAt: pgSession.expiresAt,
      refreshExpiresAt: pgSession.createdAt + REFRESH_TOKEN_TTL_MS,
    };
    this._storeSession(session);
    return session;
  }

  async refreshSession({ refreshToken, deviceId = null, platform = null, ipAddress = null, userAgent = null }) {
    if (!refreshToken) {
      return { success: false, error: 'refresh token required' };
    }

    const currentSession = await pgRepo.getSessionByRefreshToken(
      this._hashToken(refreshToken),
      REFRESH_TOKEN_TTL_MS
    );
    if (!currentSession) {
      return { success: false, error: 'invalid refresh token' };
    }

    const hasBoundDevice  = Boolean(currentSession.deviceIdentifier);
    const hasProvidedDevice = Boolean(deviceId);
    const deviceMismatch  =
      hasBoundDevice && hasProvidedDevice && currentSession.deviceIdentifier !== deviceId;
    const platformMismatch =
      Boolean(currentSession.deviceType) &&
      Boolean(platform) &&
      currentSession.deviceType !== platform;
    const ipChanged =
      Boolean(currentSession.ipAddress) &&
      Boolean(ipAddress) &&
      currentSession.ipAddress !== ipAddress;
    const userAgentChanged =
      Boolean(currentSession.userAgent) &&
      Boolean(userAgent) &&
      currentSession.userAgent !== userAgent;

    if (deviceMismatch || platformMismatch) {
      const revoked = await this._recordSuspiciousRefreshAttempt({
        refreshTokenHash: this._hashToken(refreshToken),
        currentSession,
        ipAddress,
        deviceId,
        platform,
        reason: deviceMismatch ? 'device_mismatch' : 'platform_mismatch',
      });
      await pgRepo.logSecurityEvent({
        userId: currentSession.user_id,
        eventType: 'refresh_token_rejected',
        eventDetail: {
          reason: deviceMismatch ? 'device_mismatch' : 'platform_mismatch',
          expectedDeviceId: currentSession.deviceIdentifier || null,
          providedDeviceId: deviceId || null,
          expectedPlatform: currentSession.deviceType || null,
          providedPlatform: platform || null,
          suspiciousAttempts: revoked.attempts,
          sessionRevoked: revoked.revoked,
        },
        ipAddress,
        deviceRecordId: currentSession.device_id || null,
        riskLevel: 'high',
      });
      return {
        success: false,
        error: revoked.revoked
          ? 'refresh token revoked due to suspicious activity'
          : 'refresh token rejected for this device',
      };
    }

    if (ipChanged || userAgentChanged) {
      await pgRepo.logSecurityEvent({
        userId: currentSession.user_id,
        eventType: 'refresh_token_suspicious',
        eventDetail: {
          ipChanged,
          userAgentChanged,
          previousIpAddress: currentSession.ipAddress || null,
          nextIpAddress: ipAddress || null,
          previousUserAgent: currentSession.userAgent || null,
          nextUserAgent: userAgent || null,
        },
        ipAddress,
        deviceRecordId: currentSession.device_id || null,
        riskLevel: 'medium',
      });
    }

    const nextSessionToken     = crypto.randomUUID();
    const nextRefreshToken     = this._generateToken();
    const nextRefreshTokenHash = this._hashToken(nextRefreshToken);
    const rotatedSession = await pgRepo.rotateSessionTokens({
      currentRefreshTokenHash: this._hashToken(refreshToken),
      nextSessionToken,
      nextRefreshTokenHash,
      accessExpiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
      ipAddress,
      userAgent,
    });
    if (!rotatedSession) {
      return { success: false, error: 'invalid refresh token' };
    }

    await pgRepo.clearSuspiciousRefreshAttempts(this._hashToken(refreshToken));
    await pgRepo.clearSuspiciousRefreshAttempts(nextRefreshTokenHash);
    this._deleteSession(this.refreshSessions.get(refreshToken) || currentSession);
    const session = {
      id: rotatedSession.id,
      sessionToken: rotatedSession.session_token,
      refreshToken: nextRefreshToken,
      deviceId: rotatedSession.device_id || null,
      userId: rotatedSession.user_id,
      createdAt: rotatedSession.createdAt,
      expiresAt: rotatedSession.expiresAt,
      refreshExpiresAt: rotatedSession.createdAt + REFRESH_TOKEN_TTL_MS,
    };
    this._storeSession(session);
    return {
      success: true,
      sessionToken: session.sessionToken,
      refreshToken: session.refreshToken,
      expiresInSec: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    };
  }

  async revokeSession({
    sessionToken  = null,
    refreshToken  = null,
    ipAddress     = null,
    userAgent     = null,
    logoutType    = 'voluntary',
  } = {}) {
    if (sessionToken) {
      const revoked = await pgRepo.revokeSession(sessionToken);
      this._deleteSession(this.sessions.get(sessionToken));
      if (revoked?.user_id) {
        pgRepo.recordLogout({
          userId:           revoked.user_id,
          sessionId:        revoked.id,
          sessionStartedAt: revoked.created_at,
          deviceId:         revoked.device_id,
          ipAddress,
          userAgent,
          logoutType,
        }).catch(() => {});  // fire-and-forget — never block the response
      }
      return { success: true };
    }
    if (refreshToken) {
      const revoked = await pgRepo.revokeSessionByRefreshToken(this._hashToken(refreshToken));
      this._deleteSession(this.refreshSessions.get(refreshToken));
      if (revoked?.user_id) {
        pgRepo.recordLogout({
          userId:           revoked.user_id,
          sessionId:        revoked.id,
          sessionStartedAt: revoked.created_at,
          deviceId:         revoked.device_id,
          ipAddress,
          userAgent,
          logoutType: 'token_revoked',
        }).catch(() => {});
      }
      return { success: true };
    }
    return { success: false, error: 'session token or refresh token required' };
  }

  // ─── Read Methods ─────────────────────────────────────────────────────────

  async getUsers(limit = 100) {
    return pgRepo.getUsers(limit);
  }

  async getStats() {
    return pgRepo.getStats();
  }

  async isProfileComplete(userId) {
    if (!userId) return false;
    return pgRepo.isProfileComplete(userId);
  }

  async getUserProfile(userId) {
    if (!userId) return null;
    return pgRepo.getUserProfile(userId);
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  _normalizePhone(phoneNumber) {
    if (!phoneNumber) return '';
    return String(phoneNumber).replace(/[^\d+]/g, '');
  }

  _generateOtp() {
    return String(crypto.randomInt(100000, 999999));
  }

  _generateToken() {
    return crypto.randomBytes(48).toString('base64url');
  }

  _storeSession(session) {
    this.sessions.set(session.sessionToken, session);
    if (session.refreshToken) {
      this.refreshSessions.set(session.refreshToken, session);
    }
  }

  _deleteSession(session) {
    if (!session) return;
    if (session.sessionToken) {
      this.sessions.delete(session.sessionToken);
    }
    if (session.refreshToken) {
      this.refreshSessions.delete(session.refreshToken);
    }
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

  _hashToken(token) {
    if (!TOKEN_HASH_SECRET) {
      return String(token || '');
    }
    return crypto
      .createHmac('sha256', TOKEN_HASH_SECRET)
      .update(String(token || ''))
      .digest('hex');
  }

  async _recordSuspiciousRefreshAttempt({
    refreshTokenHash,
    currentSession,
    ipAddress,
    deviceId,
    platform,
    reason,
  }) {
    const result = await pgRepo.recordSuspiciousRefreshAttempt({
      refreshTokenHash,
      userId: currentSession.user_id,
      deviceRecordId: currentSession.device_id || null,
      reason,
      maxAttempts: SUSPICIOUS_REFRESH_MAX,
    });
    if (result.revoked) {
      await pgRepo.revokeSessionByRefreshToken(refreshTokenHash);
      this._deleteSession(currentSession);
      await pgRepo.logSecurityEvent({
        userId: currentSession.user_id,
        eventType: 'refresh_token_revoked',
        eventDetail: {
          reason,
          suspiciousAttempts: result.attempts,
          providedDeviceId: deviceId || null,
          providedPlatform: platform || null,
        },
        ipAddress,
        deviceRecordId: currentSession.device_id || null,
        riskLevel: 'high',
      });
    }
    return result;
  }

  // Mask phone for logs: +91987***89
  _maskPhone(phone) {
    if (!phone || phone.length < 6) return '***';
    return phone.slice(0, 4) + '***' + phone.slice(-2);
  }
}

module.exports = new IdentityService();
