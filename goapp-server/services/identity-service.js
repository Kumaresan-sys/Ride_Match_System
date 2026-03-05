// GoApp Identity Service (Mock)
// OTP-only auth flow with in-memory test data for future DB migration.

const crypto = require('crypto');
const { logger, eventBus } = require('../utils/logger');

class IdentityService {
  constructor() {
    this.usersByPhone = new Map();
    this.usersById = new Map();
    this.otpByRequestId = new Map();
    this.otpIndexByPhone = new Map();
    this.sessions = new Map();
    this.seedMeta = null;
  }

  seedUsers(users = []) {
    this.usersByPhone.clear();
    this.usersById.clear();

    for (const user of users) {
      const normalizedPhone = this._normalizePhone(user.phoneNumber);
      const row = {
        userId: user.userId,
        phoneNumber: normalizedPhone,
        name: user.name,
        userType: user.userType || 'rider',
        phoneVerified: Boolean(user.phoneVerified),
        status: user.status || 'active',
        createdAt: user.createdAt || Date.now(),
      };
      this.usersByPhone.set(normalizedPhone, row);
      this.usersById.set(row.userId, row);
    }

    this.seedMeta = {
      seededAt: Date.now(),
      count: this.usersById.size,
    };

    return this.seedMeta;
  }

  requestOtp({ phoneNumber, otpType = 'login', channel = 'sms' }) {
    const normalizedPhone = this._normalizePhone(phoneNumber);
    if (!normalizedPhone) {
      return { success: false, error: 'valid phoneNumber required' };
    }

    const existingRequestId = this.otpIndexByPhone.get(normalizedPhone);
    if (existingRequestId) {
      const existing = this.otpByRequestId.get(existingRequestId);
      if (existing && existing.status === 'pending' && existing.expiresAt > Date.now()) {
        return {
          success: true,
          requestId: existing.requestId,
          expiresAt: existing.expiresAt,
          resendAfterSec: Math.ceil((existing.resendAt - Date.now()) / 1000),
          otpCode: existing.otpCode,
        };
      }
    }

    const otpCode = this._generateOtp();
    const now = Date.now();
    const request = {
      requestId: `OTP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      phoneNumber: normalizedPhone,
      otpCode,
      otpType,
      channel,
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      createdAt: now,
      resendAt: now + 30 * 1000,
      expiresAt: now + 120 * 1000,
      verifiedAt: null,
    };

    this.otpByRequestId.set(request.requestId, request);
    this.otpIndexByPhone.set(normalizedPhone, request.requestId);

    eventBus.publish('otp_requested', {
      phoneNumber: normalizedPhone,
      requestId: request.requestId,
      otpType,
      channel,
    });

    logger.info('IDENTITY', `OTP generated for ${normalizedPhone} (${request.requestId})`);

    return {
      success: true,
      requestId: request.requestId,
      expiresAt: request.expiresAt,
      otpCode,
    };
  }

  verifyOtp({ phoneNumber, requestId, otpCode }) {
    const normalizedPhone = this._normalizePhone(phoneNumber);
    const request = this.otpByRequestId.get(requestId);

    if (!request || request.phoneNumber !== normalizedPhone) {
      return { success: false, error: 'invalid request' };
    }

    if (request.status !== 'pending') {
      return { success: false, error: `otp status is ${request.status}` };
    }

    if (Date.now() > request.expiresAt) {
      request.status = 'expired';
      return { success: false, error: 'otp expired' };
    }

    request.attempts += 1;

    if (request.otpCode !== String(otpCode || '')) {
      if (request.attempts >= request.maxAttempts) request.status = 'failed';
      return { success: false, error: 'invalid otp', attempts: request.attempts };
    }

    request.status = 'verified';
    request.verifiedAt = Date.now();

    let user = this.usersByPhone.get(normalizedPhone);
    if (!user) {
      user = {
        userId: `USR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        phoneNumber: normalizedPhone,
        name: `User-${this.usersById.size + 1}`,
        userType: 'rider',
        phoneVerified: true,
        status: 'active',
        createdAt: Date.now(),
      };
      this.usersByPhone.set(normalizedPhone, user);
      this.usersById.set(user.userId, user);
    } else {
      user.phoneVerified = true;
    }

    const sessionToken = crypto.randomUUID();
    this.sessions.set(sessionToken, {
      sessionToken,
      userId: user.userId,
      phoneNumber: normalizedPhone,
      createdAt: Date.now(),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000),
    });

    eventBus.publish('otp_verified', {
      requestId,
      userId: user.userId,
      phoneNumber: normalizedPhone,
    });

    return {
      success: true,
      user,
      sessionToken,
    };
  }

  getUsers(limit = 100) {
    return [...this.usersById.values()].slice(0, limit);
  }

  getStats() {
    const otpRows = [...this.otpByRequestId.values()];
    return {
      users: this.usersById.size,
      sessions: this.sessions.size,
      otp: {
        total: otpRows.length,
        pending: otpRows.filter(r => r.status === 'pending').length,
        verified: otpRows.filter(r => r.status === 'verified').length,
        failed: otpRows.filter(r => r.status === 'failed').length,
        expired: otpRows.filter(r => r.status === 'expired').length,
      },
      seedMeta: this.seedMeta,
    };
  }

  _normalizePhone(phoneNumber) {
    if (!phoneNumber) return '';
    return String(phoneNumber).replace(/[^\d+]/g, '');
  }

  _generateOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }
}

module.exports = new IdentityService();
