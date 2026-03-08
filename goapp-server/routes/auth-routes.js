// IP-based rate limit: max 10 OTP requests per IP per 10 minutes.
// Guards against distributing attacks across many phone numbers from one IP.
const IP_RATE_WINDOW_MS = 10 * 60 * 1000;
const IP_RATE_MAX = 10;
const ipRateMap = new Map();
const REFRESH_RATE_WINDOW_MS = 10 * 60 * 1000;
const REFRESH_RATE_MAX = 20;
const refreshRateMap = new Map();

function checkIpRateLimit(ip) {
  const key = ip || 'unknown';
  const now = Date.now();
  const record = ipRateMap.get(key);
  if (record && (now - record.windowStart) < IP_RATE_WINDOW_MS) {
    if (record.count >= IP_RATE_MAX) return false;
    record.count++;
  } else {
    ipRateMap.set(key, { count: 1, windowStart: now });
  }
  return true;
}

function checkRefreshRateLimit(ip) {
  const key = ip || 'unknown';
  const now = Date.now();
  const record = refreshRateMap.get(key);
  if (record && (now - record.windowStart) < REFRESH_RATE_WINDOW_MS) {
    if (record.count >= REFRESH_RATE_MAX) return false;
    record.count++;
  } else {
    refreshRateMap.set(key, { count: 1, windowStart: now });
  }
  return true;
}

const ALLOWED_CHANNELS = new Set(['sms', 'whatsapp', 'voice']);
const tokenService = require('../services/token-service');

function registerAuthRoutes(router, ctx) {
  const { repositories, requireAuth } = ctx;
  const notificationService = ctx.services?.notificationService;
  const OTP_EXPIRES_IN_SEC = 120;

  function normalizePhonePayload(body = {}) {
    const phone = String(body.phone || body.phoneNumber || '').trim();
    const countryCode = String(body.countryCode || '').trim();
    if (!phone) return '';
    if (phone.startsWith('+')) return phone;
    return `${countryCode}${phone}` || phone;
  }

  function mapOtpErrorCode(error = '') {
    const e = String(error).toLowerCase();
    if (e.includes('too many')) return 'OTP_RATE_LIMITED';
    if (e.includes('otp expired')) return 'OTP_EXPIRED';
    if (e.includes('invalid otp') || e.includes('invalid request')) return 'INVALID_OTP';
    return 'AUTH_ERROR';
  }

  function mapOtpErrorMessage(error = '') {
    const e = String(error).toLowerCase();
    if (e.includes('otp expired')) return 'OTP has expired. Please request a new one.';
    if (e.includes('invalid otp')) return 'Invalid OTP. Please check and try again.';
    if (e.includes('invalid request')) return 'Invalid OTP request. Please request a new OTP.';
    return 'Authentication failed. Please try again.';
  }

  function mapUserPayload(user = {}, phone = '') {
    return {
      id: user.userId || user.id || '',
      name: user.name || '',
      phone: (phone || user.phoneNumber || '').replace(/^\+/, ''),
      email: user.email || '',
    };
  }

  async function sendLoginWelcomeNotification({
    userId,
    isNewUser,
    profileComplete,
    profileName,
  }) {
    if (!notificationService || !userId) return;

    if (isNewUser || !profileComplete) {
      await notificationService.send(userId, {
        title: 'Welcome to GoApp',
        body: 'Complete your profile setup to get started.',
        data: {
          type: 'WELCOME_NEW_USER',
          route: 'profile_setup',
          userStatus: 'new',
          channelId: 'goapp_auth',
        },
      });
      return;
    }

    const displayName = profileName || 'there';
    await notificationService.send(userId, {
      title: 'Welcome back to GoApp',
      body: `Welcome back, ${displayName}.`,
      data: {
        type: 'WELCOME_BACK_USER',
        route: 'home',
        userStatus: 'existing',
        name: displayName,
        channelId: 'goapp_auth',
      },
    });
  }

  const requestOtpHandler = async ({ body, ip }) => {
    if (!checkIpRateLimit(ip)) {
      return {
        status: 429,
        data: { success: false, message: 'Too many requests from this IP', errorCode: 'IP_RATE_LIMITED' },
      };
    }

    const phoneNumber = normalizePhonePayload(body);
    const channel = ALLOWED_CHANNELS.has(body?.channel) ? body.channel : 'sms';
    const result = await repositories.identity.requestOtp({
      phoneNumber,
      channel,
      otpType: 'login',
    });

    if (!result.success) {
      const code = mapOtpErrorCode(result.error);
      return {
        status: code === 'OTP_RATE_LIMITED' ? 429 : 400,
        data: {
          success: false,
          message: result.error || 'Failed to send OTP',
          errorCode: code,
        },
      };
    }

    return {
      status: 200,
      data: {
        success: true,
        message: 'OTP sent successfully',
        data: {
          requestId: result.requestId,
          expiresInSec: OTP_EXPIRES_IN_SEC,
          resendAfterSec: result.resendAfterSec || 30,
        },
      },
    };
  };

  const loginHandler = async ({ body, headers, ip }) => {
    const phoneNumber = normalizePhonePayload(body);
    const result = await repositories.identity.verifyOtp({
      phoneNumber,
      requestId: body?.requestId,
      otpCode: body?.otp,
      deviceId: body?.deviceId,
      platform: body?.platform,
      fcmToken: body?.fcmToken,
      deviceModel: body?.deviceModel || null,
      osVersion: body?.osVersion || null,
      appVersion: body?.appVersion || null,
      ipAddress: ip || null,
      userAgent: headers?.['user-agent'] || null,
    });

    if (!result.success) {
      return {
        status: 401,
        data: {
          success: false,
          message: mapOtpErrorMessage(result.error),
          errorCode: mapOtpErrorCode(result.error),
        },
      };
    }

    const userId = result.user.userId || result.user.id;
    const profileComplete = await repositories.identity.isProfileComplete(userId);
    const profile = await repositories.identity.getUserProfile(userId).catch(() => null);
    const profileName = profile?.name || result.user.name || '';

    await sendLoginWelcomeNotification({
      userId,
      isNewUser: result.isNewUser || false,
      profileComplete,
      profileName,
    }).catch(() => {});

    return {
      status: 200,
      data: {
        success: true,
        message: 'Login successful',
        data: {
          accessToken: tokenService.signAccessToken({
            sessionToken: result.sessionToken,
            userId,
            expiresInSec: result.expiresInSec || 1800,
          }),
          legacySessionToken: result.sessionToken,
          refreshToken: result.refreshToken || '',
          expiresInSec: result.expiresInSec || null,
          isNewUser: result.isNewUser || false,
          profileComplete,
          user: mapUserPayload(
            { ...result.user, name: profileName },
            phoneNumber,
          ),
        },
      },
    };
  };

  const refreshTokenHandler = async ({ body, headers, ip }) => {
    if (!checkRefreshRateLimit(ip)) {
      return {
        status: 429,
        data: {
          success: false,
          message: 'Too many refresh attempts from this IP. Please login again shortly.',
          errorCode: 'REFRESH_RATE_LIMITED',
        },
      };
    }

    const refreshToken =
      String(body?.refreshToken || headers?.['x-refresh-token'] || '').trim();
    const result = await repositories.identity.refreshSession({
      refreshToken,
      deviceId: body?.deviceId || null,
      platform: body?.platform || null,
      ipAddress: headers?.['x-forwarded-for']?.split(',')[0]?.trim() || ip || null,
      userAgent: headers?.['user-agent'] || null,
    });

    if (!result.success) {
      const error = String(result.error || '').toLowerCase();
      return {
        status: error.includes('too many') ? 429 : 401,
        data: {
          success: false,
          message: error.includes('suspicious')
            ? 'Refresh token was revoked after repeated suspicious attempts. Please login again.'
            : 'Refresh token is invalid, expired, or rejected for this device. Please login again.',
          errorCode: error.includes('suspicious')
            ? 'REFRESH_TOKEN_REVOKED'
            : 'INVALID_REFRESH_TOKEN',
        },
      };
    }

    const refreshedSession = typeof repositories.identity.validateSession === 'function'
      ? await repositories.identity.validateSession(result.sessionToken)
      : null;
    const accessToken = refreshedSession?.userId
      ? tokenService.signAccessToken({
        sessionToken: result.sessionToken,
        userId: refreshedSession.userId,
        expiresInSec: result.expiresInSec || 1800,
      })
      : result.sessionToken;

    return {
      status: 200,
      data: {
        success: true,
        message: 'Token refreshed successfully',
        data: {
          accessToken,
          legacySessionToken: result.sessionToken,
          refreshToken: result.refreshToken,
          expiresInSec: result.expiresInSec,
        },
      },
    };
  };

  const logoutHandler = async ({ body, headers, ip }) => {
    const auth = requireAuth ? await requireAuth(headers || {}) : null;
    const refreshToken =
      String(body?.refreshToken || headers?.['x-refresh-token'] || '').trim();

    if (auth?.error && !refreshToken) {
      return auth.error;
    }

    const userAgent = String(headers?.['user-agent'] || '').slice(0, 512);

    const result = await repositories.identity.revokeSession({
      sessionToken: auth?.session?.sessionToken || null,
      refreshToken: refreshToken || null,
      ipAddress:    ip   || null,
      userAgent:    userAgent || null,
      logoutType:   'voluntary',
    });

    if (!result.success) {
      return {
        status: 400,
        data: {
          success: false,
          message: 'Unable to logout session.',
          errorCode: 'LOGOUT_FAILED',
        },
      };
    }

    return {
      status: 200,
      data: {
        success: true,
        message: 'Logout successful',
      },
    };
  };

  const resendOtpHandler = async ({ body, ip }) => {
    if (!checkIpRateLimit(ip)) {
      return {
        status: 429,
        data: { success: false, message: 'Too many requests from this IP', errorCode: 'IP_RATE_LIMITED' },
      };
    }

    const phoneNumber = normalizePhonePayload(body);
    const result = await repositories.identity.requestOtp({
      phoneNumber,
      channel: 'sms',
      otpType: 'login',
    });

    if (!result.success) {
      const code = mapOtpErrorCode(result.error);
      return {
        status: code === 'OTP_RATE_LIMITED' ? 429 : 400,
        data: {
          success: false,
          message: result.error || 'Failed to resend OTP',
          errorCode: code,
        },
      };
    }

    if (result.resendAfterSec && result.resendAfterSec > 0) {
      return {
        status: 400,
        data: {
          success: false,
          message: 'Resend not allowed yet',
          errorCode: 'RESEND_COOLDOWN_ACTIVE',
          data: { retryAfterSec: result.resendAfterSec },
        },
      };
    }

    return {
      status: 200,
      data: {
        success: true,
        message: 'OTP resent successfully',
        data: {
          requestId: result.requestId,
          expiresInSec: OTP_EXPIRES_IN_SEC,
          resendAfterSec: 30,
        },
      },
    };
  };

  const legacyOtpRequestHandler = async ({ body }) => {
    const phoneNumber = normalizePhonePayload(body);
    const channel = ALLOWED_CHANNELS.has(body?.channel) ? body.channel : 'sms';
    const result = await repositories.identity.requestOtp({
      phoneNumber,
      channel,
      otpType: body?.otpType || 'login',
    });
    return { status: result.success ? 200 : 400, data: result };
  };

  const legacyOtpVerifyHandler = async ({ body, headers, ip }) => {
    const phoneNumber = normalizePhonePayload(body);
    const result = await repositories.identity.verifyOtp({
      phoneNumber,
      requestId: body?.requestId,
      otpCode: body?.otpCode || body?.otp,
      deviceId: body?.deviceId,
      platform: body?.platform,
      fcmToken: body?.fcmToken,
      deviceModel: body?.deviceModel || null,
      osVersion: body?.osVersion || null,
      appVersion: body?.appVersion || null,
      ipAddress: ip || null,
      userAgent: headers?.['user-agent'] || null,
    });
    return { status: result.success ? 200 : 400, data: result };
  };

  router.register('POST', '/api/v1/auth/request-otp', requestOtpHandler);
  router.register('POST', '/api/v1/auth/otp/request', legacyOtpRequestHandler);
  router.register('POST', '/api/v1/auth/otp/verify', legacyOtpVerifyHandler);
  router.register('POST', '/api/v1/auth/login', loginHandler);
  router.register('POST', '/api/v1/auth/refresh-token', refreshTokenHandler);
  router.register('POST', '/api/v1/auth/logout', logoutHandler);
  router.register('POST', '/api/v1/auth/resend-otp', resendOtpHandler);

  router.register('POST', '/auth/request-otp', requestOtpHandler);
  router.register('POST', '/auth/login', loginHandler);
  router.register('POST', '/auth/refresh-token', refreshTokenHandler);
  router.register('POST', '/auth/logout', logoutHandler);
  router.register('POST', '/auth/resend-otp', resendOtpHandler);
}

module.exports = registerAuthRoutes;
