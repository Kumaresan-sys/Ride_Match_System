// PostgreSQL-backed Identity Repository
// Tables: users, user_profiles, user_roles, user_status_history, user_security_logs,
//         user_devices, user_sessions, user_login_history, user_preferences,
//         refresh_token_security, otp_requests, otp_attempts, otp_rate_limits, push_tokens,
//         riders, rider_profiles, rider_loyalty_points
// Used by identity-service.js when DB_BACKEND=pg

'use strict';

const domainDb = require('../../infra/db/domain-db');
const { logger } = require('../../utils/logger');

const OTP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

class PgIdentityRepository {
  constructor() {
    this._riderColumnCache = new Map();
    this._logoutLookupFailureMetrics = {
      'rides:active_ride': 0,
      'payments:pending_wallet_payment': 0,
    };
  }

  async _ensureRiderArtifacts(client, userId) {
    const { rows } = await client.query(
      `INSERT INTO riders (user_id)
       VALUES ($1)
       ON CONFLICT (user_id)
       DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING id`,
      [userId]
    );
    const riderId = rows[0]?.id || null;
    if (!riderId) return null;

    await client.query(
      `INSERT INTO rider_profiles (rider_id) VALUES ($1)
       ON CONFLICT DO NOTHING`,
      [riderId]
    );
    await client.query(
      `INSERT INTO rider_loyalty_points (rider_id) VALUES ($1)
       ON CONFLICT DO NOTHING`,
      [riderId]
    );
    return riderId;
  }

  _trackLogoutLookupFailure({ domain, lookup, userId, error }) {
    const key = `${domain}:${lookup}`;
    const current = Number(this._logoutLookupFailureMetrics[key] || 0);
    const next = current + 1;
    this._logoutLookupFailureMetrics[key] = next;
    const safeError = String(error?.message || error || 'unknown')
      .replace(/\s+/g, ' ')
      .slice(0, 180);
    logger.warn(
      'IDENTITY',
      `metric=identity.logout.cross_domain_lookup_failed count=${next} domain=${domain} lookup=${lookup} userId=${userId} err="${safeError}"`
    );
  }

  // ─── OTP Rate Limiting ────────────────────────────────────────────────────

  async getRateLimit(phone) {
    const { rows } = await domainDb.query('identity', 
      `SELECT request_count, is_blocked, blocked_until
       FROM otp_rate_limits
       WHERE phone_number = $1
         AND window_start > NOW() - INTERVAL '10 minutes'
       ORDER BY window_start DESC LIMIT 1`,
      [phone]
    );
    return rows[0] || null;
  }

  async incrementRateLimit(phone) {
    const windowStart = new Date(
      Math.floor(Date.now() / OTP_WINDOW_MS) * OTP_WINDOW_MS
    );
    const { rows } = await domainDb.query('identity', 
      `INSERT INTO otp_rate_limits (phone_number, window_start, request_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (phone_number, window_start)
       DO UPDATE SET request_count = otp_rate_limits.request_count + 1
       RETURNING request_count, is_blocked, blocked_until`,
      [phone, windowStart]
    );
    return rows[0];
  }

  // ─── OTP Requests ─────────────────────────────────────────────────────────

  async expirePendingOtpsByPhone(phoneNumber) {
    await domainDb.query('identity', 
      `UPDATE otp_requests
       SET status = 'expired'
       WHERE phone_number = $1
         AND status = 'pending'`,
      [phoneNumber]
    );
  }

  async createOtpRequest({ requestId, phoneNumber, otpCode, otpType, channel, expiresAt }) {
    await domainDb.query('identity', 
      `INSERT INTO otp_requests
         (id, phone_number, otp_code, otp_type, channel, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
      [requestId, phoneNumber, otpCode, otpType, channel, new Date(expiresAt)]
    );
  }

  async getOtpRequest(requestId) {
    const { rows } = await domainDb.query('identity', 
      `SELECT id, phone_number, otp_code, otp_type, status,
              attempts, max_attempts,
              EXTRACT(EPOCH FROM expires_at) * 1000 AS "expiresAt",
              EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
       FROM otp_requests WHERE id = $1`,
      [requestId]
    );
    return rows[0] || null;
  }

  async getActiveOtpByPhone(phone) {
    const { rows } = await domainDb.query('identity', 
      `SELECT id, phone_number, otp_code, otp_type, status,
              attempts, max_attempts,
              EXTRACT(EPOCH FROM expires_at) * 1000  AS "expiresAt",
              EXTRACT(EPOCH FROM (created_at + INTERVAL '30 seconds')) * 1000 AS "resendAt"
       FROM otp_requests
       WHERE phone_number = $1
         AND status = 'pending'
         AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    return rows[0] || null;
  }

  // Atomically increment attempts and optionally set a new status.
  // Also writes a row to otp_attempts for per-attempt audit trail.
  async recordOtpAttempt(requestId, newStatus, { isCorrect = false, ipAddress = null } = {}) {
    const client = await domainDb.getClient('identity');
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `UPDATE otp_requests
         SET attempts = attempts + 1,
             status   = COALESCE($2, status),
             verified_at = CASE WHEN $2 = 'verified' THEN NOW() ELSE verified_at END
         WHERE id = $1
         RETURNING attempts, status`,
        [requestId, newStatus || null]
      );

      // Record the individual attempt in otp_attempts for audit
      await client.query(
        `INSERT INTO otp_attempts (otp_request_id, entered_code, is_correct, ip_address)
         VALUES ($1, $2, $3, $4)`,
        [requestId, '***', isCorrect, ipAddress || null]
      );

      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── User Profiles ────────────────────────────────────────────────────────

  async upsertUserProfile({ userId, name, gender, dateOfBirth, emergencyContact }) {
    await domainDb.query('identity', 
      `INSERT INTO user_profiles (user_id, display_name, gender, date_of_birth, emergency_contact)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
         SET display_name       = EXCLUDED.display_name,
             gender             = EXCLUDED.gender,
             date_of_birth      = EXCLUDED.date_of_birth,
             emergency_contact  = EXCLUDED.emergency_contact,
             updated_at         = NOW()`,
      [userId, name, gender, dateOfBirth || null, emergencyContact || null]
    );
  }

  async getUserProfile(userId) {
    const { rows } = await domainDb.query('identity', 
      `SELECT up.display_name AS name,
              up.gender,
              TO_CHAR(up.date_of_birth, 'DD FMMonth YYYY') AS date_of_birth,
              up.emergency_contact,
              EXTRACT(EPOCH FROM u.created_at) * 1000 AS "createdAt"
       FROM user_profiles up
       JOIN users u ON u.id = up.user_id
       WHERE up.user_id = $1`,
      [userId]
    );
    return rows[0] || null;
  }

  async updateUserEmail(userId, email) {
    await domainDb.query('identity', 
      `UPDATE users SET email = $2, updated_at = NOW() WHERE id = $1`,
      [userId, email]
    );
  }

  async upsertUserProfileWithEmail({ userId, name, gender, dateOfBirth, emergencyContact, email }) {
    const client = await domainDb.getClient('identity');
    let riderId = null;
    let committed = false;
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO user_profiles (user_id, display_name, gender, date_of_birth, emergency_contact)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE
           SET display_name       = EXCLUDED.display_name,
               gender             = EXCLUDED.gender,
               date_of_birth      = EXCLUDED.date_of_birth,
               emergency_contact  = EXCLUDED.emergency_contact,
               updated_at         = NOW()`,
        [userId, name, gender, dateOfBirth || null, emergencyContact || null]
      );

      if (email) {
        try {
          await client.query(
            `UPDATE users SET email = $2, updated_at = NOW() WHERE id = $1`,
            [userId, email]
          );
        } catch (err) {
          if (err.code === '23505') {
            const dupErr = new Error('This email address is already in use by another account.');
            dupErr.code = 'EMAIL_DUPLICATE';
            throw dupErr;
          }
          throw err;
        }
      }

      riderId = await this._ensureRiderArtifacts(client, userId);

      await client.query('COMMIT');
      committed = true;

      if (riderId) {
        await domainDb.withTransaction('payments', async (paymentsClient) => {
          await paymentsClient.query(
            `INSERT INTO wallets (user_id, balance, promo_balance, currency, status)
             VALUES ($1, 0, 0, 'INR', 'active')
             ON CONFLICT (user_id) DO NOTHING`,
            [userId]
          );
          await paymentsClient.query(
            `INSERT INTO coin_wallets (user_id, balance, lifetime_earned, lifetime_redeemed)
             VALUES ($1, 0, 0, 0)
             ON CONFLICT (user_id) DO NOTHING`,
            [userId]
          );
          await paymentsClient.query(
            `INSERT INTO rider_wallets (rider_id, cash_balance, coin_balance)
             VALUES ($1, 0.00, 0)
             ON CONFLICT (rider_id) DO NOTHING`,
            [riderId]
          );
        });
      }
    } catch (err) {
      if (!committed) {
        await client.query('ROLLBACK');
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async updateProfileFields({ userId, name, email }) {
    const client = await domainDb.getClient('identity');
    try {
      await client.query('BEGIN');

      if (name !== null) {
        await client.query(
          `UPDATE user_profiles SET display_name = $2, updated_at = NOW() WHERE user_id = $1`,
          [userId, name]
        );
      }

      if (email !== null) {
        try {
          await client.query(
            `UPDATE users SET email = $2, updated_at = NOW() WHERE id = $1`,
            [userId, email]
          );
        } catch (err) {
          if (err.code === '23505') {
            const dupErr = new Error('This email address is already in use by another account.');
            dupErr.code = 'EMAIL_DUPLICATE';
            throw dupErr;
          }
          throw err;
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async isProfileComplete(userId) {
    const { rows } = await domainDb.query('identity', 
      `SELECT 1 FROM user_profiles
       WHERE user_id = $1
         AND display_name IS NOT NULL AND display_name <> ''
         AND gender       IS NOT NULL AND gender       <> ''`,
      [userId]
    );
    return rows.length > 0;
  }

  // ─── Users ────────────────────────────────────────────────────────────────

  // Upserts the user row and also ensures a riders record exists (for rider type)
  async upsertUser({ userId, phoneNumber, userType }) {
    const client = await domainDb.getClient('identity');
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `INSERT INTO users (id, phone_number, user_type, phone_verified, status)
         VALUES ($1, $2, $3, true, 'active')
         ON CONFLICT (phone_number)
         DO UPDATE SET phone_verified = true, updated_at = NOW()
         RETURNING id, phone_number, email, user_type, status, phone_verified,
                   (xmax = 0) AS is_new,
                   EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"`,
        [userId, phoneNumber, userType]
      );
      const user = rows[0];
      const isNew = user.is_new;

      if (isNew) {
        // Assign default role
        await client.query(
          `INSERT INTO user_roles (user_id, role) VALUES ($1, $2)
           ON CONFLICT (user_id, role) DO NOTHING`,
          [user.id, userType]
        );

        // Record initial status transition: pending → active
        await client.query(
          `INSERT INTO user_status_history (user_id, old_status, new_status, reason)
           VALUES ($1, 'pending', 'active', 'OTP signup')`,
          [user.id]
        );
      }

      // Ensure a riders row (+ profile + loyalty) exists so wallet/ride FKs resolve
      if (user.user_type === 'rider') {
        await this._ensureRiderArtifacts(client, user.id);
      }

      await client.query('COMMIT');
      return user;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async completeSuccessfulOtpLogin({
    requestId,
    userId,
    phoneNumber,
    userType,
    deviceId,
    platform,
    fcmToken,
    deviceModel = null,
    osVersion = null,
    appVersion = null,
    ipAddress,
    userAgent = null,
    sessionToken,
    refreshTokenHash,
    sessionExpiresAt,
  }) {
    const client = await domainDb.getClient('identity');
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE otp_requests
         SET attempts = attempts + 1,
             status = 'verified',
             verified_at = NOW()
         WHERE id = $1`,
        [requestId]
      );

      // Audit: record the successful attempt in otp_attempts
      await client.query(
        `INSERT INTO otp_attempts (otp_request_id, entered_code, is_correct, ip_address)
         VALUES ($1, $2, true, $3)`,
        [requestId, '***', ipAddress || null]
      );

      const { rows: userRows } = await client.query(
        `INSERT INTO users (id, phone_number, user_type, phone_verified, status)
         VALUES ($1, $2, $3, true, 'active')
         ON CONFLICT (phone_number)
         DO UPDATE SET phone_verified = true, updated_at = NOW()
         RETURNING id, phone_number, email, user_type, status, phone_verified,
                   (xmax = 0) AS is_new,
                   EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"`,
        [userId, phoneNumber, userType]
      );
      const user = userRows[0];
      const isNew = user.is_new;

      if (isNew) {
        // Assign default role for new users
        await client.query(
          `INSERT INTO user_roles (user_id, role) VALUES ($1, $2)
           ON CONFLICT (user_id, role) DO NOTHING`,
          [user.id, userType]
        );

        // Record initial status transition: pending → active
        await client.query(
          `INSERT INTO user_status_history (user_id, old_status, new_status, reason)
           VALUES ($1, 'pending', 'active', 'OTP signup')`,
          [user.id]
        );
      }

      // Log security event for every login
      await client.query(
        `INSERT INTO user_security_logs (user_id, event_type, event_detail, ip_address, risk_level)
         VALUES ($1, 'otp_login', $2, $3, 'low')`,
        [
          user.id,
          JSON.stringify({ isNewUser: isNew, userType }),
          ipAddress || null,
        ]
      );

      if (user.user_type === 'rider') {
        await this._ensureRiderArtifacts(client, user.id);
      }

      let deviceRecord = null;
      if (deviceId) {
        const normalizedPlatform = ['ios', 'android', 'web'].includes(platform)
          ? platform
          : 'web';
        const { rows: existingRows } = await client.query(
          `SELECT id
           FROM user_devices
           WHERE user_id = $1
             AND device_id = $2
           LIMIT 1`,
          [user.id, deviceId]
        );

        if (existingRows[0]?.id) {
          const { rows } = await client.query(
            `UPDATE user_devices
             SET device_type = $2,
                 fcm_token = COALESCE($3, fcm_token),
                 device_model = COALESCE($4, device_model),
                 os_version = COALESCE($5, os_version),
                 app_version = COALESCE($6, app_version),
                 is_active = true,
                 last_active_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1
             RETURNING id, user_id, device_id, device_type, fcm_token,
                       device_model, os_version, app_version, is_active,
                       EXTRACT(EPOCH FROM updated_at) * 1000 AS "updatedAt"`,
            [existingRows[0].id, normalizedPlatform, fcmToken || null, deviceModel, osVersion, appVersion]
          );
          deviceRecord = rows[0] || null;
        } else {
          const { rows } = await client.query(
            `INSERT INTO user_devices (
               user_id, device_id, device_type, fcm_token,
               device_model, os_version, app_version, is_active, last_active_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW())
             RETURNING id, user_id, device_id, device_type, fcm_token,
                       device_model, os_version, app_version, is_active,
                       EXTRACT(EPOCH FROM updated_at) * 1000 AS "updatedAt"`,
            [user.id, deviceId, normalizedPlatform, fcmToken || null, deviceModel, osVersion, appVersion]
          );
          deviceRecord = rows[0] || null;
        }

        if (fcmToken) {
          const updateRes = await client.query(
            `UPDATE push_tokens
             SET user_id = $1,
                 device_id = $2,
                 platform = $3,
                 is_active = true,
                 updated_at = NOW()
             WHERE token = $4`,
            [user.id, deviceRecord?.id || null, normalizedPlatform, fcmToken]
          );
          if (updateRes.rowCount === 0) {
            await client.query(
              `INSERT INTO push_tokens (user_id, device_id, platform, token, is_active, updated_at)
               SELECT $1, $2, $3, $4, true, NOW()
               WHERE NOT EXISTS (SELECT 1 FROM push_tokens WHERE token = $4)`,
              [user.id, deviceRecord?.id || null, normalizedPlatform, fcmToken]
            );
          }
        }
      }

      await client.query(
        `INSERT INTO user_sessions (
           user_id, device_id, session_token, refresh_token,
           ip_address, user_agent, is_active, expires_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, true, $7)
         ON CONFLICT (session_token) DO NOTHING`,
        [
          user.id,
          deviceRecord?.id || null,
          sessionToken,
          refreshTokenHash,
          ipAddress || null,
          userAgent || null,
          new Date(sessionExpiresAt),
        ]
      );

      await client.query(
        `INSERT INTO user_login_history (
           user_id, login_method, ip_address, device_id, status, created_at
         )
         VALUES ($1, 'otp', $2, $3, 'success', NOW())`,
        [user.id, ipAddress || null, deviceRecord?.id || null]
      );

      await client.query('COMMIT');
      return { user, deviceRecord };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getUserByPhone(phone) {
    const { rows } = await domainDb.query('identity', 
      `SELECT id, phone_number, email, user_type, status, phone_verified,
              EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
       FROM users WHERE phone_number = $1 AND deleted_at IS NULL`,
      [phone]
    );
    return rows[0] || null;
  }

  async getUserById(userId) {
    const { rows } = await domainDb.query('identity', 
      `SELECT id, phone_number, email, user_type, status, phone_verified,
              EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    return rows[0] || null;
  }

  async getUsers(limit = 100) {
    const { rows } = await domainDb.query('identity', 
      `SELECT id, phone_number, email, user_type, status, phone_verified,
              EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
       FROM users WHERE deleted_at IS NULL
       ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows;
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────

  async createSession({
    sessionToken,
    refreshTokenHash = null,
    userId,
    expiresAt,
    deviceRecordId = null,
    ipAddress = null,
    userAgent = null,
  }) {
    await domainDb.query('identity', 
      `INSERT INTO user_sessions (
         user_id, device_id, session_token, refresh_token,
         ip_address, user_agent, is_active, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, true, $7)
       ON CONFLICT (session_token) DO NOTHING`,
      [
        userId,
        deviceRecordId,
        sessionToken,
        refreshTokenHash,
        ipAddress,
        userAgent,
        new Date(expiresAt),
      ]
    );
  }

  async upsertUserDevice({ userId, deviceId, platform, fcmToken }) {
    if (!userId || !deviceId) return null;

    const normalizedPlatform = ['ios', 'android', 'web'].includes(platform)
      ? platform
      : 'web';

    const { rows: existingRows } = await domainDb.query('identity', 
      `SELECT id
       FROM user_devices
       WHERE user_id = $1
         AND device_id = $2
       LIMIT 1`,
      [userId, deviceId]
    );

    if (existingRows[0]?.id) {
      const { rows } = await domainDb.query('identity', 
        `UPDATE user_devices
         SET device_type = $2,
             fcm_token = COALESCE($3, fcm_token),
             is_active = true,
             last_active_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, user_id, device_id, device_type, fcm_token, is_active,
                   EXTRACT(EPOCH FROM updated_at) * 1000 AS "updatedAt"`,
        [existingRows[0].id, normalizedPlatform, fcmToken || null]
      );
      return rows[0] || null;
    }

    const { rows } = await domainDb.query('identity', 
      `INSERT INTO user_devices (
         user_id, device_id, device_type, fcm_token, is_active, last_active_at
       )
       VALUES ($1, $2, $3, $4, true, NOW())
       RETURNING id, user_id, device_id, device_type, fcm_token, is_active,
                 EXTRACT(EPOCH FROM updated_at) * 1000 AS "updatedAt"`,
      [userId, deviceId, normalizedPlatform, fcmToken || null]
    );
    return rows[0] || null;
  }

  async recordLoginHistory({
    userId,
    deviceRecordId = null,
    ipAddress = null,
    status = 'success',
    loginMethod = 'otp',
  }) {
    await domainDb.query('identity', 
      `INSERT INTO user_login_history (
         user_id, login_method, ip_address, device_id, status, created_at
       )
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [userId, loginMethod, ipAddress, deviceRecordId, status]
    );
  }

  async getSession(sessionToken) {
    const { rows } = await domainDb.query('identity', 
      `SELECT us.id, us.session_token, us.refresh_token, us.device_id, us.user_id,
              ud.device_id AS "deviceIdentifier",
              ud.device_type AS "deviceType",
              us.ip_address AS "ipAddress",
              us.user_agent AS "userAgent",
              EXTRACT(EPOCH FROM us.expires_at) * 1000 AS "expiresAt",
              EXTRACT(EPOCH FROM us.created_at) * 1000 AS "createdAt"
       FROM user_sessions us
       LEFT JOIN user_devices ud ON ud.id = us.device_id
       WHERE us.session_token = $1
         AND us.is_active = true
         AND us.expires_at > NOW()`,
      [sessionToken]
    );
    return rows[0] || null;
  }

  async getSessionByRefreshToken(refreshTokenHash, refreshTokenTtlMs) {
    const { rows } = await domainDb.query('identity', 
      `SELECT us.id, us.session_token, us.refresh_token, us.device_id, us.user_id,
              ud.device_id AS "deviceIdentifier",
              ud.device_type AS "deviceType",
              us.ip_address AS "ipAddress",
              us.user_agent AS "userAgent",
              EXTRACT(EPOCH FROM us.expires_at) * 1000 AS "expiresAt",
              EXTRACT(EPOCH FROM us.created_at) * 1000 AS "createdAt"
       FROM user_sessions us
       LEFT JOIN user_devices ud ON ud.id = us.device_id
       WHERE us.refresh_token = $1
         AND us.is_active = true
         AND us.created_at > NOW() - ($2 * INTERVAL '1 millisecond')
       LIMIT 1`,
      [refreshTokenHash, refreshTokenTtlMs]
    );
    return rows[0] || null;
  }

  async rotateSessionTokens({
    currentRefreshTokenHash,
    nextSessionToken,
    nextRefreshTokenHash,
    accessExpiresAt,
    ipAddress = null,
    userAgent = null,
  }) {
    const { rows } = await domainDb.query('identity', 
      `UPDATE user_sessions
       SET session_token = $2,
           refresh_token = $3,
           expires_at = $4,
           ip_address = COALESCE($5, ip_address),
           user_agent = COALESCE($6, user_agent),
           created_at = NOW(),
           revoked_at = NULL,
           is_active = true
       WHERE refresh_token = $1
         AND is_active = true
       RETURNING id, session_token, refresh_token, device_id, user_id,
                 EXTRACT(EPOCH FROM expires_at) * 1000 AS "expiresAt",
                 EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"`,
      [
        currentRefreshTokenHash,
        nextSessionToken,
        nextRefreshTokenHash,
        new Date(accessExpiresAt),
        ipAddress,
        userAgent,
      ]
    );
    return rows[0] || null;
  }

  async revokeSession(sessionToken) {
    const { rows } = await domainDb.query('identity', 
      `UPDATE user_sessions
       SET is_active = false, revoked_at = NOW()
       WHERE session_token = $1
       RETURNING id, user_id, device_id, created_at`,
      [sessionToken]
    );
    return rows[0] || null;   // { id, user_id, device_id, created_at }
  }

  async revokeSessionByRefreshToken(refreshTokenHash) {
    const { rows } = await domainDb.query('identity', 
      `UPDATE user_sessions
       SET is_active = false, revoked_at = NOW()
       WHERE refresh_token = $1
       RETURNING id, user_id, device_id, created_at`,
      [refreshTokenHash]
    );
    return rows[0] || null;
  }

  /**
   * Writes one row to user_logout_logs.
   * Checks for active rides / pending payments to record in the audit row.
   */
  async recordLogout({
    userId,
    sessionId      = null,
    sessionStartedAt = null,
    ipAddress      = null,
    userAgent      = null,
    deviceId       = null,
    logoutType     = 'voluntary',
  }) {
    if (!userId) return;

    // Duration in seconds
    const durationSec = sessionStartedAt
      ? Math.round((Date.now() - new Date(sessionStartedAt).getTime()) / 1000)
      : null;

    // Check for active ride
    let rideRows = [];
    try {
      const { rows } = await domainDb.query('rides', 
        `SELECT id FROM rides
         WHERE rider_id = $1
           AND status IN ('requested','accepted','in_progress','driver_assigned')
         LIMIT 1`,
        [userId]
      );
      rideRows = rows;
    } catch (err) {
      this._trackLogoutLookupFailure({
        domain: 'rides',
        lookup: 'active_ride',
        userId,
        error: err,
      });
      rideRows = [];
    }

    // Check for pending wallet payment (hold transactions indicate an in-progress ride payment)
    let payRows = [];
    try {
      const { rows } = await domainDb.query('payments', 
        `SELECT wt.id FROM wallet_transactions wt
         JOIN wallets w ON w.id = wt.wallet_id
         WHERE w.user_id = $1 AND wt.transaction_type = 'hold'
         LIMIT 1`,
        [userId]
      );
      payRows = rows;
    } catch (err) {
      this._trackLogoutLookupFailure({
        domain: 'payments',
        lookup: 'pending_wallet_payment',
        userId,
        error: err,
      });
      payRows = [];
    }

    await domainDb.query('identity', 
      `INSERT INTO user_logout_logs
         (user_id, session_id, logout_type, ip_address, user_agent,
          device_id, session_started_at, session_duration_sec,
          had_active_ride, had_pending_payment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        userId,
        sessionId,
        logoutType,
        ipAddress,
        userAgent,
        deviceId,
        sessionStartedAt,
        durationSec,
        rideRows.length > 0,
        payRows.length > 0,
      ]
    );

    // Also write to user_security_logs for unified security audit trail
    await domainDb.query('identity', 
      `INSERT INTO user_security_logs
         (user_id, event_type, event_detail, ip_address, device_id, risk_level)
       VALUES ($1, 'logout', $2, $3, $4, 'low')`,
      [
        userId,
        JSON.stringify({
          logout_type:          logoutType,
          session_duration_sec: durationSec,
          had_active_ride:      rideRows.length > 0,
          had_pending_payment:  payRows.length > 0,
        }),
        ipAddress,
        deviceId,
      ]
    );
  }

  async recordSuspiciousRefreshAttempt({
    refreshTokenHash,
    userId,
    deviceRecordId = null,
    reason = null,
    maxAttempts = 3,
  }) {
    const { rows } = await domainDb.query('identity', 
      `INSERT INTO refresh_token_security (
         refresh_token_hash, user_id, device_id, suspicious_attempt_count,
         first_suspicious_at, last_suspicious_at, last_reason, revoked_at
       )
       VALUES ($1, $2, $3, 1, NOW(), NOW(), $4, NULL)
       ON CONFLICT (refresh_token_hash)
       DO UPDATE SET
         suspicious_attempt_count = refresh_token_security.suspicious_attempt_count + 1,
         last_suspicious_at = NOW(),
         last_reason = EXCLUDED.last_reason
       RETURNING suspicious_attempt_count AS attempts,
                 revoked_at IS NOT NULL AS revoked`,
      [refreshTokenHash, userId, deviceRecordId, reason]
    );

    const attempts = rows[0]?.attempts || 1;
    const alreadyRevoked = Boolean(rows[0]?.revoked);
    const shouldRevoke = alreadyRevoked || attempts >= maxAttempts;

    if (shouldRevoke && !alreadyRevoked) {
      await domainDb.query('identity', 
        `UPDATE refresh_token_security
         SET revoked_at = NOW()
         WHERE refresh_token_hash = $1`,
        [refreshTokenHash]
      );
    }

    return { attempts, revoked: shouldRevoke };
  }

  async clearSuspiciousRefreshAttempts(refreshTokenHash) {
    await domainDb.query('identity', 
      `DELETE FROM refresh_token_security
       WHERE refresh_token_hash = $1`,
      [refreshTokenHash]
    );
  }

  async logSecurityEvent({
    userId,
    eventType,
    eventDetail = {},
    ipAddress = null,
    deviceRecordId = null,
    riskLevel = 'medium',
  }) {
    await domainDb.query('identity', 
      `INSERT INTO user_security_logs (user_id, event_type, event_detail, ip_address, device_id, risk_level)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        eventType,
        JSON.stringify(eventDetail || {}),
        ipAddress,
        deviceRecordId,
        riskLevel,
      ]
    );
  }

  // ─── Roles ────────────────────────────────────────────────────────────────

  async getUserRoles(userId) {
    const { rows } = await domainDb.query('identity', 
      `SELECT role, granted_at, expires_at
       FROM user_roles
       WHERE user_id = $1
         AND is_active = true
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY granted_at`,
      [userId]
    );
    return rows;
  }

  // ─── Preferences ──────────────────────────────────────────────────────────

  async getUserPreferences(userId) {
    const { rows } = await domainDb.query('identity', 
      `SELECT preference_key AS key, preference_value AS value
       FROM user_preferences
       WHERE user_id = $1
       ORDER BY preference_key`,
      [userId]
    );
    // Return as a flat object: { key: value, ... }
    return rows.reduce((acc, r) => {
      acc[r.key] = r.value;
      return acc;
    }, {});
  }

  async setUserPreference(userId, key, value) {
    await domainDb.query('identity', 
      `INSERT INTO user_preferences (user_id, preference_key, preference_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, preference_key)
       DO UPDATE SET preference_value = EXCLUDED.preference_value,
                     updated_at = NOW()`,
      [userId, key, JSON.stringify(value)]
    );
  }

  // ─── Welcome Bonus ────────────────────────────────────────────────────────

  async awardWelcomeBonus(userId) {
    const hasWelcomeBonusClaimed = await this._hasRiderColumn('welcome_bonus_claimed');
    // Fast path: already claimed
    const riderSelectSql = hasWelcomeBonusClaimed
      ? `SELECT id, welcome_bonus_claimed FROM riders WHERE user_id = $1 LIMIT 1`
      : `SELECT id, false AS welcome_bonus_claimed FROM riders WHERE user_id = $1 LIMIT 1`;
    const { rows: riderRows } = await domainDb.query('identity', riderSelectSql, [userId]);
    if (!riderRows[0] || Boolean(riderRows[0].welcome_bonus_claimed)) {
      return { coinsAwarded: 0, alreadyClaimed: true };
    }

    const riderId = riderRows[0].id;
    const BONUS = 100;
    const client = await domainDb.getClient('payments');
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO coin_wallets (user_id, balance, lifetime_earned, lifetime_redeemed)
         VALUES ($1, 0, 0, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );

      // Lock the wallet row (wallet guaranteed to exist from upsertUserProfileWithEmail)
      const { rows: walletRows } = await client.query(
        `SELECT id, balance FROM coin_wallets WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      const wallet = walletRows[0];
      const balanceBefore = wallet.balance;
      const balanceAfter  = balanceBefore + BONUS;

      // Record transaction — idempotency_key prevents any duplicate
      const creditTx = await client.query(
        `INSERT INTO coin_transactions
           (wallet_id, user_id, transaction_type, coins, balance_before, balance_after,
            reference_type, description, idempotency_key)
         VALUES ($1, $2, 'credit', $3, $4, $5, 'signup', 'Welcome signup bonus', $6)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [wallet.id, userId, BONUS, balanceBefore, balanceAfter, `welcome_bonus:${userId}`]
      );

      // Idempotency guard: if already awarded previously, do not mutate wallet again.
      if (creditTx.rowCount === 0) {
        await client.query('COMMIT');
        return { coinsAwarded: 0, alreadyClaimed: true };
      }

      // Update wallet balance
      await client.query(
        `UPDATE coin_wallets
         SET balance = $2, lifetime_earned = lifetime_earned + $3, updated_at = NOW()
         WHERE id = $1`,
        [wallet.id, balanceAfter, BONUS]
      );

      await client.query('COMMIT');

      // Mark bonus claimed on rider in identity_db after the wallet transaction commits.
      if (hasWelcomeBonusClaimed) {
        await domainDb.query(
          'identity',
          `UPDATE riders SET welcome_bonus_claimed = true WHERE id = $1`,
          [riderId],
          { role: 'writer', strongRead: true }
        ).catch(() => {});
      }

      return { coinsAwarded: BONUS, alreadyClaimed: false };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── Referral Code ────────────────────────────────────────────────────────

  async generateOrGetReferralCode(userId) {
    const hasRiderReferralCode = await this._hasRiderColumn('referral_code');
    // Return existing code if already created
    const { rows: riderRows } = await domainDb.query('identity', 
      `SELECT ${hasRiderReferralCode ? 'r.referral_code' : 'NULL::text AS referral_code'}, up.display_name
       FROM riders r
       LEFT JOIN user_profiles up ON up.user_id = r.user_id
       WHERE r.user_id = $1 LIMIT 1`,
      [userId]
    );
    if (!riderRows[0]) return { code: null };
    if (riderRows[0].referral_code) return { code: riderRows[0].referral_code };

    // Build base from display name: first 4 alpha chars uppercased
    const name = (riderRows[0].display_name || 'USER').replace(/[^a-zA-Z]/g, '');
    const prefix = name.substring(0, 4).toUpperCase().padEnd(4, 'X');

    // Get active referral program
    const { rows: progRows } = await domainDb.query('identity', 
      `SELECT id FROM referral_programs WHERE is_active = true ORDER BY created_at DESC LIMIT 1`
    );
    const programId = progRows[0]?.id || null;

    // Try up to 5 unique codes
    for (let attempt = 0; attempt < 5; attempt++) {
      const suffix = String(Math.floor(1000 + Math.random() * 9000));
      const code = `${prefix}${suffix}`;
      try {
        const client = await domainDb.getClient('identity');
        try {
          await client.query('BEGIN');
          if (programId) {
            await client.query(
              `INSERT INTO referral_codes (user_id, program_id, code)
               VALUES ($1, $2, $3)
               ON CONFLICT (code) DO NOTHING`,
              [userId, programId, code]
            );
          }
          if (hasRiderReferralCode) {
            await client.query(
              `UPDATE riders SET referral_code = $2 WHERE user_id = $1`,
              [userId, code]
            );
          }
          await client.query('COMMIT');
          return { code };
        } catch (err) {
          await client.query('ROLLBACK');
          if (err.constraint === 'referral_codes_code_key' || err.code === '23505') continue;
          throw err;
        } finally {
          client.release();
        }
      } catch (innerErr) {
        if (attempt === 4) throw innerErr;
      }
    }
    return { code: null };
  }

  async _hasRiderColumn(columnName) {
    if (this._riderColumnCache.has(columnName)) {
      return this._riderColumnCache.get(columnName);
    }
    const { rows } = await domainDb.query('identity', 
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'riders'
           AND column_name = $1
       ) AS "exists"`,
      [columnName]
    );
    const exists = Boolean(rows[0]?.exists);
    this._riderColumnCache.set(columnName, exists);
    return exists;
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  async getStats() {
    const [{ rows: u }, { rows: s }, { rows: o }] = await Promise.all([
      domainDb.query('identity', `SELECT COUNT(*)::int AS cnt FROM users WHERE deleted_at IS NULL`),
      domainDb.query('identity', `SELECT COUNT(*)::int AS cnt FROM user_sessions WHERE is_active = true AND expires_at > NOW()`),
      domainDb.query('identity', 
        `SELECT status, COUNT(*)::int AS cnt
         FROM otp_requests
         WHERE created_at > NOW() - INTERVAL '24 hours'
         GROUP BY status`
      ),
    ]);
    const oByStatus = {};
    for (const row of o) oByStatus[row.status] = row.cnt;
    return {
      users:    u[0].cnt,
      sessions: s[0].cnt,
      otp: {
        pending:  oByStatus.pending  || 0,
        verified: oByStatus.verified || 0,
        failed:   oByStatus.failed   || 0,
        expired:  oByStatus.expired  || 0,
        total:    Object.values(oByStatus).reduce((a, b) => a + b, 0),
      },
    };
  }
}

module.exports = new PgIdentityRepository();
