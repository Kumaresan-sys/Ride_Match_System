// GoApp Notification Service — Firebase FCM
//
// Sends push notifications to riders and drivers at every ride lifecycle event.
// Requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY env vars.
// If not configured, notifications are silently skipped (service degrades gracefully).

const admin = require('firebase-admin');
const config = require('../config');
const { logger } = require('../utils/logger');

class NotificationService {
  constructor() {
    // userId -> { token, platform, updatedAt }
    this.deviceTokens = new Map();
    this.initialized = false;
    this._init();
  }

  // ─── Initialise Firebase Admin SDK ───────────────────────────────────────
  _init() {
    const { projectId, privateKey, clientEmail } = config.firebase;

    if (!projectId || !privateKey || !clientEmail) {
      logger.warn('FCM', 'Firebase not configured — push notifications disabled.');
      logger.warn('FCM', 'Set FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL in .env');
      return;
    }

    try {
      admin.initializeApp({
        credential: admin.credential.cert({
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
  registerToken(userId, token, platform = 'unknown') {
    if (!token) return { success: false, error: 'token is required' };
    this.deviceTokens.set(userId, { token, platform, updatedAt: Date.now() });
    logger.info('FCM', `Registered token for user ${userId} (${platform})`);
    return { success: true, userId, platform };
  }

  removeToken(userId) {
    this.deviceTokens.delete(userId);
  }

  // ─── Core send ────────────────────────────────────────────────────────────
  async send(userId, { title, body, data = {} }) {
    if (!this.initialized) {
      logger.info('FCM', `[SKIP — not initialised] ${userId}: "${title}"`);
      return { sent: false, reason: 'not_initialized' };
    }

    const device = this.deviceTokens.get(userId);
    if (!device) {
      logger.info('FCM', `[SKIP — no token] ${userId}: "${title}"`);
      return { sent: false, reason: 'no_token' };
    }

    // FCM requires all data values to be strings
    const stringData = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    );

    const message = {
      token: device.token,
      notification: { title, body },
      data: stringData,
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'goapp_rides' },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
      },
    };

    try {
      const messageId = await admin.messaging().send(message);
      logger.info('FCM', `✓ Sent to ${userId} (${device.platform}): "${title}" [${messageId}]`);
      return { sent: true, messageId };
    } catch (err) {
      // Stale / unregistered token — clean up automatically
      if (
        err.code === 'messaging/registration-token-not-registered' ||
        err.code === 'messaging/invalid-registration-token'
      ) {
        logger.warn('FCM', `Removed stale token for ${userId}`);
        this.removeToken(userId);
      } else {
        logger.error('FCM', `Failed to send to ${userId}: ${err.message}`);
      }
      return { sent: false, reason: err.message };
    }
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
  getStats() {
    return {
      initialized: this.initialized,
      registeredTokens: this.deviceTokens.size,
      tokens: [...this.deviceTokens.entries()].map(([userId, d]) => ({
        userId, platform: d.platform,
        updatedAt: new Date(d.updatedAt).toISOString(),
      })),
    };
  }
}

module.exports = new NotificationService();
