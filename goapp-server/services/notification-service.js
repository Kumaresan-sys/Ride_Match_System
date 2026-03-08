// GoApp Notification Service — Firebase FCM
//
// Sends push notifications to riders and drivers at every ride lifecycle event.
// Requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY env vars.
// If not configured, notifications are silently skipped (service degrades gracefully).

const config = require('../config');
const db = require('./db');
const { logger } = require('../utils/logger');
const USE_PG = config.db.backend === 'pg';
const ALLOWED_PLATFORMS = new Set(['ios', 'android', 'web']);

const TOKEN_CACHE_TTL_MS = 30_000; // re-fetch from DB at most every 30 s per user

class NotificationService {
  constructor() {
    // `${userId}:${token}` -> { userId, token, platform, updatedAt }
    this.deviceTokens = new Map();
    // userId -> timestamp of last DB fetch
    this._cacheTimestamps = new Map();
    this.initialized = false;
    this.admin = null;
    this._init();
  }

  // ─── Initialise Firebase Admin SDK ───────────────────────────────────────
  _init() {
    const { projectId, privateKey, clientEmail } = config.firebase;

    try {
      this.admin = require('firebase-admin');
    } catch {
      logger.warn('FCM', 'firebase-admin package not installed — push notifications disabled.');
      return;
    }

    if (!projectId || !privateKey || !clientEmail) {
      logger.warn('FCM', 'Firebase not configured — push notifications disabled.');
      logger.warn('FCM', 'Set FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL in .env');
      return;
    }

    try {
      this.admin.initializeApp({
        credential: this.admin.credential.cert({
          projectId,
          privateKey: privateKey.replace(/\\n/g, '\n'), // handle escaped newlines in env
          clientEmail,
        }),
      });
      this.initialized = true;
      logger.success('FCM', `Firebase FCM initialised (project: ${projectId})`);
    } catch (err) {
      logger.error('FCM', `Firebase init failed: ${err.message}`);
    }
  }

  // ─── Device Token Registry ────────────────────────────────────────────────
  async registerToken(userId, token, platform = 'unknown', deviceRecordId = null) {
    if (!token) return { success: false, error: 'token is required' };
    const normalizedPlatform = ALLOWED_PLATFORMS.has(platform) ? platform : 'web';

    if (USE_PG) {
      await db.query(
        `INSERT INTO push_tokens (user_id, device_id, platform, token, is_active, updated_at)
         VALUES ($1, $2, $3, $4, true, NOW())
         ON CONFLICT (token)
         DO UPDATE SET user_id = EXCLUDED.user_id,
                       device_id = EXCLUDED.device_id,
                       platform = EXCLUDED.platform,
                       is_active = true,
                       updated_at = NOW()`,
        [userId, deviceRecordId, normalizedPlatform, token]
      );
    }

    this.deviceTokens.set(`${userId}:${token}`, {
      userId,
      token,
      platform: normalizedPlatform,
      updatedAt: Date.now(),
    });
    // Invalidate TTL so next send re-reads the full device list from DB
    this._cacheTimestamps.delete(userId);
    logger.info('FCM', `Registered token for user ${userId} (${normalizedPlatform})`);
    return { success: true, userId, platform: normalizedPlatform };
  }

  async removeToken(userId) {
    if (USE_PG) {
      await db.query(
        `UPDATE push_tokens
         SET is_active = false, updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );
    }

    for (const key of [...this.deviceTokens.keys()]) {
      if (key.startsWith(`${userId}:`)) {
        this.deviceTokens.delete(key);
      }
    }
    this._cacheTimestamps.delete(userId);
  }

  // ─── Core send ────────────────────────────────────────────────────────────
  async send(userId, { title, body, data = {}, channelId = 'goapp_rides' }) {
    if (!this.initialized) {
      logger.info('FCM', `[SKIP — not initialised] ${userId}: "${title}"`);
      return { sent: false, reason: 'not_initialized' };
    }

    const devices = await this._getDevicesForUser(userId);
    if (devices.length === 0) {
      logger.info('FCM', `[SKIP — no token] ${userId}: "${title}"`);
      return { sent: false, reason: 'no_token' };
    }

    const stringData = this._stringifyData(data);

    const results = await Promise.all(
      devices.map(async (device) => {
        try {
          const resolvedChannelId = data.channelId || channelId;
          const messageId = await this.admin.messaging().send({
            token: device.token,
            notification: { title, body },
            data: stringData,
            android: {
              priority: 'high',
              notification: { sound: 'default', channelId: resolvedChannelId },
            },
            apns: {
              payload: { aps: { sound: 'default', badge: 1 } },
            },
          });
          logger.info('FCM', `✓ Sent to ${userId} (${device.platform}): "${title}" [${messageId}]`);
          return messageId;
        } catch (err) {
          await this._handleSendError(userId, device.token, err);
          return null;
        }
      })
    );

    const messageIds = results.filter(Boolean);
    return messageIds.length > 0
      ? { sent: true, messageIds, delivered: messageIds.length }
      : { sent: false, reason: 'all_tokens_failed' };
  }

  // ─── Ride lifecycle notifications ─────────────────────────────────────────

  /** Ride requested — let rider know matching has started */
  async notifyRideRequested(riderId, rideId) {
    await this.send(riderId, {
      title: 'Finding your driver…',
      body: 'We are searching for the best driver near you.',
      data: { type: 'RIDE_REQUESTED', rideId },
    });
  }

  /** Driver matched — notify both rider and driver */
  async notifyRideMatched(riderId, driverId, { rideId, driverName, vehicleType, vehicleNumber, etaMin, score }) {
    await Promise.all([
      this.send(riderId, {
        title: 'Driver Found!',
        body: `${driverName} (${vehicleType} · ${vehicleNumber}) is on the way. ETA: ${etaMin} min`,
        data: { type: 'RIDE_MATCHED', rideId, driverId, etaMin },
      }),
      this.send(driverId, {
        title: 'New Ride Assigned',
        body: 'You have a new ride. Navigate to the pickup point.',
        data: { type: 'RIDE_ASSIGNED', rideId, riderId, score },
      }),
    ]);
  }

  /** Driver arrived at pickup */
  async notifyDriverArrived(riderId, driverName, rideId) {
    await this.send(riderId, {
      title: 'Driver Arrived!',
      body: `${driverName} is waiting at your pickup location.`,
      data: { type: 'DRIVER_ARRIVED', rideId },
    });
  }

  /** Trip started */
  async notifyTripStarted(riderId, rideId) {
    await this.send(riderId, {
      title: 'Trip Started',
      body: 'Your trip has begun. Have a safe journey!',
      data: { type: 'TRIP_STARTED', rideId },
    });
    // Also send a silent/data-only push so the app can recover if killed during the trip
    this.sendSilent(riderId, { type: 'TRIP_STARTED', rideId, silent: 'true' })
      .catch((err) => logger.error('FCM', `Silent TRIP_STARTED failed for ${riderId}: ${err.message}`));
  }

  /** Trip completed — notify both rider and driver */
  async notifyTripCompleted(riderId, driverId, { rideId, finalFare, driverEarnings }) {
    await Promise.all([
      this.send(riderId, {
        title: 'You have arrived!',
        body: `Trip completed. Total fare: ₹${finalFare}. Thank you for riding with GoApp!`,
        data: { type: 'TRIP_COMPLETED', rideId, finalFare },
      }),
      this.send(driverId, {
        title: 'Trip Completed',
        body: `Great job! You earned ₹${driverEarnings} for this trip.`,
        data: { type: 'TRIP_COMPLETED', rideId, driverEarnings },
      }),
    ]);
  }

  /** Rider cancelled — notify driver */
  async notifyCancelledByRider(driverId, rideId, cancelFee) {
    await this.send(driverId, {
      title: 'Ride Cancelled',
      body: cancelFee > 0
        ? `The rider cancelled. A cancellation fee of ₹${cancelFee} has been applied.`
        : 'The rider has cancelled this ride.',
      data: { type: 'CANCELLED_BY_RIDER', rideId, cancelFee: cancelFee || 0 },
    });
  }

  /** Driver cancelled — notify rider that we are finding a new driver */
  async notifyCancelledByDriver(riderId, rideId) {
    await this.send(riderId, {
      title: 'Driver Cancelled',
      body: 'Your driver has cancelled. We are finding you a new driver right away!',
      data: { type: 'CANCELLED_BY_DRIVER', rideId },
    });
  }

  /** Re-matching found a new driver after driver cancellation */
  async notifyRematchSuccess(riderId, driverId, { rideId, driverName, vehicleType, vehicleNumber, etaMin }) {
    await Promise.all([
      this.send(riderId, {
        title: 'New Driver Found!',
        body: `${driverName} (${vehicleType} · ${vehicleNumber}) is on the way. ETA: ${etaMin} min`,
        data: { type: 'REMATCH_SUCCESS', rideId, driverId, etaMin },
      }),
      this.send(driverId, {
        title: 'New Ride Assigned',
        body: 'You have a new ride. Navigate to the pickup point.',
        data: { type: 'RIDE_ASSIGNED', rideId, riderId },
      }),
    ]);
  }

  /** No drivers available */
  async notifyNoDrivers(riderId, rideId) {
    await this.send(riderId, {
      title: 'No Drivers Available',
      body: 'Sorry, no drivers are available near you right now. Please try again in a moment.',
      data: { type: 'NO_DRIVERS', rideId },
    });
  }

  /** Admin disabled zone — notify rider if they are in a blocked zone */
  async notifyZoneDisabled(riderId, zoneName) {
    await this.send(riderId, {
      title: 'Service Unavailable',
      body: `GoApp service has been temporarily suspended in ${zoneName}. We apologise for the inconvenience.`,
      data: { type: 'ZONE_DISABLED', zoneName },
    });
  }

  // ─── Stats ────────────────────────────────────────────────────────────────
  // ─── Silent / Data-only push (no banner shown to user) ────────────────────
  // Used for background app wakeup: iOS content-available, Android data-only.
  // The app wakes silently, reads the data payload, and calls /restore.
  async sendSilent(userId, data = {}) {
    if (!this.initialized) {
      logger.info('FCM', `[SKIP — not initialised] silent push to ${userId}`);
      return { sent: false, reason: 'not_initialized' };
    }

    const devices = await this._getDevicesForUser(userId);
    if (devices.length === 0) {
      logger.info('FCM', `[SKIP — no token] silent push to ${userId}`);
      return { sent: false, reason: 'no_token' };
    }

    const stringData = this._stringifyData(data);

    const results = await Promise.all(
      devices.map(async (device) => {
        try {
          const messageId = await this.admin.messaging().send({
            token: device.token,
            data: stringData,
            android: { priority: 'high' },
            apns: {
              headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
              payload: { aps: { 'content-available': 1 } },
            },
          });
          logger.info('FCM', `✓ Silent push to ${userId} (${device.platform}) [${messageId}]`);
          return messageId;
        } catch (err) {
          await this._handleSendError(userId, device.token, err);
          return null;
        }
      })
    );

    const messageIds = results.filter(Boolean);
    return messageIds.length > 0
      ? { sent: true, messageIds, delivered: messageIds.length }
      : { sent: false, reason: 'all_tokens_failed' };
  }

  getStats() {
    return {
      initialized: this.initialized,
      registeredTokens: this.deviceTokens.size,
      storage: USE_PG ? 'pg+memory-cache' : 'memory',
      tokens: [...this.deviceTokens.values()].map((d) => ({
        userId: d.userId, platform: d.platform,
        updatedAt: new Date(d.updatedAt).toISOString(),
      })),
    };
  }

  async _getDevicesForUser(userId) {
    if (USE_PG) {
      const lastFetch = this._cacheTimestamps.get(userId) || 0;
      const cacheStale = (Date.now() - lastFetch) > TOKEN_CACHE_TTL_MS;

      if (cacheStale) {
        // Refresh from DB and populate the in-memory cache
        const { rows } = await db.query(
          `SELECT token, platform
           FROM push_tokens
           WHERE user_id = $1
             AND is_active = true
           ORDER BY updated_at DESC`,
          [userId]
        );

        // Clear stale entries for this user before repopulating
        for (const key of this.deviceTokens.keys()) {
          if (key.startsWith(`${userId}:`)) this.deviceTokens.delete(key);
        }
        rows.forEach((row) => {
          this.deviceTokens.set(`${userId}:${row.token}`, {
            userId,
            token: row.token,
            platform: row.platform,
            updatedAt: Date.now(),
          });
        });
        this._cacheTimestamps.set(userId, Date.now());
      }
    }

    // Serve from in-memory cache (for both PG and non-PG backends)
    return [...this.deviceTokens.values()].filter((d) => d.userId === userId);
  }

  _stringifyData(data = {}) {
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    );
  }

  async _handleSendError(userId, token, err) {
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      logger.warn('FCM', `Removed stale token for ${userId}`);
      await this._deactivateToken(token);
      return;
    }

    logger.error('FCM', `Failed to send to ${userId}: ${err.message}`);
  }

  async _deactivateToken(token) {
    if (USE_PG) {
      await db.query(
        `UPDATE push_tokens
         SET is_active = false, updated_at = NOW()
         WHERE token = $1`,
        [token]
      );
    }

    for (const [key, value] of this.deviceTokens.entries()) {
      if (value.token === token) {
        this.deviceTokens.delete(key);
      }
    }
  }
}

module.exports = new NotificationService();
