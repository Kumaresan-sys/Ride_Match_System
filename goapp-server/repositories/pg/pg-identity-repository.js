// PostgreSQL-backed Identity Repository
// Tables: users, user_profiles, user_roles, user_status_history, user_security_logs,
//         user_devices, user_sessions, user_login_history, user_preferences,
//         otp_requests, otp_attempts, otp_rate_limits, push_tokens,
//         riders, rider_profiles, rider_loyalty_points
// Used by identity-service.js when DB_BACKEND=pg

'use strict';

const db = require('../../services/db');

const OTP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

class PgIdentityRepository {
  // ─── OTP Rate Limiting ────────────────────────────────────────────────────

  async getRateLimit(phone) {
    const { rows } = await db.query(
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
    const { rows } = await db.query(
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
    await db.query(
      `UPDATE otp_requests
       SET status = 'expired'
       WHERE phone_number = $1
         AND status = 'pending'`,
      [phoneNumber]
    );
  }

  async createOtpRequest({ requestId, phoneNumber, otpCode, otpType, channel, expiresAt }) {
    await db.query(
      `INSERT INTO otp_requests
         (id, phone_number, otp_code, otp_type, channel, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
      [requestId, phoneNumber, otpCode, otpType, channel, new Date(expiresAt)]
    );
  }

  async getOtpRequest(requestId) {
    const { rows } = await db.query(
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
    const { rows } = await db.query(
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
  async recordOtpAttempt(requestId, newStatus, { enteredCode = null, isCorrect = false, ipAddress = null } = {}) {
    const client = await db.getClient();
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
        [requestId, enteredCode || '***', isCorrect, ipAddress || null]
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
    await db.query(
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
    const { rows } = await db.query(
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
    await db.query(
      `UPDATE users SET email = $2, updated_at = NOW() WHERE id = $1`,
      [userId, email]
    );
  }

  async upsertUserProfileWithEmail({ userId, name, gender, dateOfBirth, emergencyContact, email }) {
    const client = await db.getClient();
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

      // Ensure GoCoins wallet exists with balance = 0 (reward points — not real money)
      await client.query(
        `INSERT INTO coin_wallets (user_id, balance, lifetime_earned)
         VALUES ($1, 0, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );

      // Ensure real cash wallet exists with cash_balance = 0 (recharge + ride payments)
      await client.query(
        `INSERT INTO rider_wallets (rider_id, cash_balance, coin_balance)
         SELECT id, 0.00, 0 FROM riders WHERE user_id = $1
         ON CONFLICT (rider_id) DO NOTHING`,
        [userId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async updateProfileFields({ userId, name, email }) {
    const client = await db.getClient();
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
    const { rows } = await db.query(
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
    const client = await db.getClient();
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
        const { rows: riderRows } = await client.query(
          `INSERT INTO riders (user_id) VALUES ($1)
           ON CONFLICT (user_id) DO NOTHING
           RETURNING id`,
          [user.id]
        );
        if (riderRows[0]?.id) {
          await client.query(
            `INSERT INTO rider_profiles (rider_id) VALUES ($1)
             ON CONFLICT DO NOTHING`,
            [riderRows[0].id]
          );
          await client.query(
            `INSERT INTO rider_loyalty_points (rider_id) VALUES ($1)
             ON CONFLICT DO NOTHING`,
            [riderRows[0].id]
          );
        }
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
    sessionToken,
    sessionExpiresAt,
    enteredCode = null,
  }) {
    const client = await db.getClient();
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
        [requestId, enteredCode || '***', ipAddress || null]
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
        const { rows: riderRows } = await client.query(
          `INSERT INTO riders (user_id) VALUES ($1)
           ON CONFLICT (user_id) DO NOTHING
           RETURNING id`,
          [user.id]
        );
        if (riderRows[0]?.id) {
          await client.query(
            `INSERT INTO rider_profiles (rider_id) VALUES ($1)
             ON CONFLICT DO NOTHING`,
            [riderRows[0].id]
          );
          await client.query(
            `INSERT INTO rider_loyalty_points (rider_id) VALUES ($1)
             ON CONFLICT DO NOTHING`,
            [riderRows[0].id]
          );
        }
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
          await client.query(
            `INSERT INTO push_tokens (user_id, device_id, platform, token, is_active, updated_at)
             VALUES ($1, $2, $3, $4, true, NOW())
             ON CONFLICT (token)
             DO UPDATE SET user_id = EXCLUDED.user_id,
                           device_id = EXCLUDED.device_id,
                           platform = EXCLUDED.platform,
                           is_active = true,
                           updated_at = NOW()`,
            [user.id, deviceRecord?.id || null, normalizedPlatform, fcmToken]
          );
        }
      }

      await client.query(
        `INSERT INTO user_sessions (user_id, device_id, session_token, is_active, expires_at)
         VALUES ($1, $2, $3, true, $4)
         ON CONFLICT (session_token) DO NOTHING`,
        [user.id, deviceRecord?.id || null, sessionToken, new Date(sessionExpiresAt)]
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
    const { rows } = await db.query(
      `SELECT id, phone_number, email, user_type, status, phone_verified,
              EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
       FROM users WHERE phone_number = $1 AND deleted_at IS NULL`,
      [phone]
    );
    return rows[0] || null;
  }

  async getUserById(userId) {
    const { rows } = await db.query(
      `SELECT id, phone_number, email, user_type, status, phone_verified,
              EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    return rows[0] || null;
  }

  async getUsers(limit = 100) {
    const { rows } = await db.query(
      `SELECT id, phone_number, email, user_type, status, phone_verified,
              EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
       FROM users WHERE deleted_at IS NULL
       ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows;
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────

  async createSession({ sessionToken, userId, expiresAt, deviceRecordId = null }) {
    await db.query(
      `INSERT INTO user_sessions (user_id, device_id, session_token, is_active, expires_at)
       VALUES ($1, $2, $3, true, $4)
       ON CONFLICT (session_token) DO NOTHING`,
      [userId, deviceRecordId, sessionToken, new Date(expiresAt)]
    );
  }

  async upsertUserDevice({ userId, deviceId, platform, fcmToken }) {
    if (!userId || !deviceId) return null;

    const normalizedPlatform = ['ios', 'android', 'web'].includes(platform)
      ? platform
      : 'web';

    const { rows: existingRows } = await db.query(
      `SELECT id
       FROM user_devices
       WHERE user_id = $1
         AND device_id = $2
       LIMIT 1`,
      [userId, deviceId]
    );

    if (existingRows[0]?.id) {
      const { rows } = await db.query(
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

    const { rows } = await db.query(
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
    await db.query(
      `INSERT INTO user_login_history (
         user_id, login_method, ip_address, device_id, status, created_at
       )
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [userId, loginMethod, ipAddress, deviceRecordId, status]
    );
  }

  async getSession(sessionToken) {
    const { rows } = await db.query(
      `SELECT session_token, user_id,
              EXTRACT(EPOCH FROM expires_at) * 1000 AS "expiresAt",
              EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
       FROM user_sessions
       WHERE session_token = $1
         AND is_active = true
         AND expires_at > NOW()`,
      [sessionToken]
    );
    return rows[0] || null;
  }

  async revokeSession(sessionToken) {
    await db.query(
      `UPDATE user_sessions
       SET is_active = false, revoked_at = NOW()
       WHERE session_token = $1`,
      [sessionToken]
    );
  }

  // ─── Roles ────────────────────────────────────────────────────────────────

  async getUserRoles(userId) {
    const { rows } = await db.query(
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
    const { rows } = await db.query(
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
    await db.query(
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
    // Fast path: already claimed
    const { rows: riderRows } = await db.query(
      `SELECT id, welcome_bonus_claimed FROM riders WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    if (!riderRows[0] || riderRows[0].welcome_bonus_claimed) {
      return { coinsAwarded: 0, alreadyClaimed: true };
    }

    const riderId = riderRows[0].id;
    const BONUS = 100;
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Lock the wallet row (wallet guaranteed to exist from upsertUserProfileWithEmail)
      const { rows: walletRows } = await client.query(
        `SELECT id, balance FROM coin_wallets WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      const wallet = walletRows[0];
      const balanceBefore = wallet.balance;
      const balanceAfter  = balanceBefore + BONUS;

      // Record transaction — idempotency_key prevents any duplicate
      await client.query(
        `INSERT INTO coin_transactions
           (wallet_id, user_id, transaction_type, coins, balance_before, balance_after,
            reference_type, description, idempotency_key)
         VALUES ($1, $2, 'credit', $3, $4, $5, 'signup', 'Welcome signup bonus', $6)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [wallet.id, userId, BONUS, balanceBefore, balanceAfter, `welcome_bonus:${userId}`]
      );

      // Update wallet balance
      await client.query(
        `UPDATE coin_wallets
         SET balance = $2, lifetime_earned = lifetime_earned + $3, updated_at = NOW()
         WHERE id = $1`,
        [wallet.id, balanceAfter, BONUS]
      );

      // Mark bonus claimed on rider
      await client.query(
        `UPDATE riders SET welcome_bonus_claimed = true WHERE id = $1`,
        [riderId]
      );

      await client.query('COMMIT');
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
    // Return existing code if already created
    const { rows: riderRows } = await db.query(
      `SELECT r.referral_code, up.display_name
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
    const { rows: progRows } = await db.query(
      `SELECT id FROM referral_programs WHERE is_active = true ORDER BY created_at DESC LIMIT 1`
    );
    const programId = progRows[0]?.id || null;

    // Try up to 5 unique codes
    for (let attempt = 0; attempt < 5; attempt++) {
      const suffix = String(Math.floor(1000 + Math.random() * 9000));
      const code = `${prefix}${suffix}`;
      try {
        const client = await db.getClient();
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
          await client.query(
            `UPDATE riders SET referral_code = $2 WHERE user_id = $1`,
            [userId, code]
          );
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

  // ─── Stats ────────────────────────────────────────────────────────────────

  async getStats() {
    const [{ rows: u }, { rows: s }, { rows: o }] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS cnt FROM users WHERE deleted_at IS NULL`),
      db.query(`SELECT COUNT(*)::int AS cnt FROM user_sessions WHERE is_active = true AND expires_at > NOW()`),
      db.query(
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
