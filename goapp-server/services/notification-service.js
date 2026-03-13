// GoApp Notification Service — Firebase FCM
//
// Sends push notifications to riders and drivers at every ride lifecycle event.
// Device tokens are persisted in PostgreSQL (push_tokens table) and cached
// in-memory for TOKEN_CACHE_TTL_MS to reduce DB reads.
//
// Requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY env vars.
// If not configured, notifications are silently skipped (service degrades gracefully).

const config = require('../config');
const db = require('./db');
const notificationCenterService = require('./notification-center-service');
const { logger } = require('../utils/logger');
const ALLOWED_PLATFORMS = new Set(['ios', 'android', 'web']);
const CATEGORY_VALUES = new Set(['ride', 'payment', 'promo', 'system', 'security', 'other']);
const APP_DEEP_LINK_SCHEME = process.env.APP_DEEP_LINK_SCHEME || 'goapp://';
const UUID_V4_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  _normalizeUserId(userId) {
    return String(userId || '').trim();
  }

  _isUuid(userId) {
    return UUID_V4_LIKE_RE.test(this._normalizeUserId(userId));
  }

  async registerToken(userId, token, platform = 'unknown', deviceRecordId = null) {
    if (!token) return { success: false, error: 'token is required' };
    const normalizedUserId = this._normalizeUserId(userId);
    if (!this._isUuid(normalizedUserId)) {
      logger.warn('FCM', `Rejected token registration for invalid userId "${normalizedUserId}"`);
      return { success: false, error: 'userId must be a valid UUID' };
    }
    const normalizedPlatform = ALLOWED_PLATFORMS.has(platform) ? platform : 'web';

    const updateRes = await db.query(
      `UPDATE push_tokens
       SET user_id = $1,
           device_id = $2,
           platform = $3,
           is_active = true,
           updated_at = NOW()
       WHERE token = $4`,
      [normalizedUserId, deviceRecordId, normalizedPlatform, token]
    );
    if (!updateRes.rowCount) {
      await db.query(
        `INSERT INTO push_tokens (user_id, device_id, platform, token, is_active, updated_at)
         SELECT $1, $2, $3, $4, true, NOW()
         WHERE NOT EXISTS (SELECT 1 FROM push_tokens WHERE token = $4)`,
        [normalizedUserId, deviceRecordId, normalizedPlatform, token]
      );
    }

    this.deviceTokens.set(`${normalizedUserId}:${token}`, {
      userId: normalizedUserId,
      token,
      platform: normalizedPlatform,
      updatedAt: Date.now(),
    });
    // Invalidate TTL so next send re-reads the full device list from DB
    this._cacheTimestamps.delete(normalizedUserId);
    logger.info('FCM', `Registered token for user ${normalizedUserId} (${normalizedPlatform})`);
    return { success: true, userId: normalizedUserId, platform: normalizedPlatform };
  }

  async removeToken(userId) {
    const normalizedUserId = this._normalizeUserId(userId);
    if (!this._isUuid(normalizedUserId)) {
      logger.warn('FCM', `Skipping token removal for invalid userId "${normalizedUserId}"`);
      return;
    }
    await db.query(
      `UPDATE push_tokens
       SET is_active = false, updated_at = NOW()
       WHERE user_id = $1`,
      [normalizedUserId]
    );

    for (const key of [...this.deviceTokens.keys()]) {
      if (key.startsWith(`${normalizedUserId}:`)) {
        this.deviceTokens.delete(key);
      }
    }
    this._cacheTimestamps.delete(normalizedUserId);
  }

  async _createNotificationRecord(userId, {
    title,
    body,
    data = {},
  } = {}) {
    try {
      const referenceType = String(
        data.referenceType ||
        (String(data.type || '').trim() ? String(data.type || '').trim().toLowerCase() : '') ||
        'push'
      ).slice(0, 30);
      const referenceIdRaw =
        data.referenceId ||
        data.trackingId ||
        data.rideId ||
        data.ticketId ||
        null;
      const referenceId = referenceIdRaw == null ? null : String(referenceIdRaw);
      const category = this._inferCategory(data);
      const deepLink = this._normalizeDeepLinkForStorage(data.deepLink);
      const navPayload = this._buildNavPayload(data);
      const { rows } = await db.query(
        `INSERT INTO notifications (
           user_id,
           channel,
           title,
           body,
           data_payload,
           priority,
           status,
           reference_type,
           reference_id,
           event_type,
           category,
           deep_link,
           nav_payload,
           source_service,
           updated_at
         ) VALUES ($1, 'push', $2, $3, $4::jsonb, 'normal', 'unread', $5, $6, $7, $8, $9, $10::jsonb, $11, NOW())
         RETURNING id::text AS "notificationId"`,
        [
          userId,
          title || null,
          body || '',
          JSON.stringify(data || {}),
          referenceType || null,
          referenceId,
          String(data.eventType || data.type || '').trim() || null,
          category,
          deepLink,
          JSON.stringify(navPayload || {}),
          'notification-service',
        ],
      );
      const notificationId = rows[0]?.notificationId || null;
      if (notificationId) {
        await this._appendNotificationLog(notificationId, 'queued', {
          payload: data || {},
        });
        await notificationCenterService.appendEvent(notificationId, userId, 'created', {
          sourceService: 'notification-service',
          referenceType,
          referenceId,
          eventType: data.eventType || data.type || null,
          deepLink,
        });
      }
      return notificationId;
    } catch (err) {
      logger.warn('FCM', `Failed to persist notification row for ${userId}: ${err.message}`);
      return null;
    }
  }

  async _appendNotificationLog(notificationId, event, {
    providerResponse = null,
    errorMessage = null,
    payload = null,
  } = {}) {
    if (!notificationId) return;
    try {
      await db.query(
        `INSERT INTO notification_logs (
           notification_id,
           event,
           provider_response,
           error_message
         ) VALUES ($1, $2, $3::jsonb, $4)`,
        [
          notificationId,
          String(event || 'unknown').slice(0, 30),
          JSON.stringify(providerResponse || payload || {}),
          errorMessage,
        ],
      );
    } catch (err) {
      logger.warn('FCM', `Failed to persist notification log ${notificationId}: ${err.message}`);
    }
  }

  async _updateNotificationStatus(notificationId, status, userId, {
    providerResponse = null,
    errorMessage = null,
  } = {}) {
    if (!notificationId) return;
    try {
      if (status === 'sent') {
        await db.query(
          `UPDATE notifications
           SET delivered_at = COALESCE(delivered_at, NOW()),
               updated_at = NOW()
           WHERE id = $1`,
          [notificationId],
        );
        if (userId) {
          await notificationCenterService.appendEvent(notificationId, userId, 'delivered', {
            provider: 'fcm',
          });
        }
      } else if (status === 'failed') {
        await db.query(
          `UPDATE notifications
           SET updated_at = NOW()
           WHERE id = $1`,
          [notificationId],
        );
      }
      await this._appendNotificationLog(notificationId, status, {
        providerResponse,
        errorMessage,
      });
    } catch (err) {
      logger.warn('FCM', `Failed to update notification ${notificationId}: ${err.message}`);
    }
  }

  async _recordDeliveryAttempt(notificationId, {
    deviceId = null,
    tokenId = null,
    providerMessageId = null,
    status = 'sent',
    errorCode = null,
    errorMessage = null,
  } = {}) {
    try {
      if (!notificationId) return;
      const { rows } = await db.query(
        `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no
         FROM notification_delivery_attempts
         WHERE notification_id = $1`,
        [notificationId]
      );
      const attemptNo = rows[0]?.attempt_no || 1;
      await db.query(
        `INSERT INTO notification_delivery_attempts (
           notification_id,
           device_id,
           token_id,
           attempt_no,
           provider,
           provider_message_id,
           status,
           error_code,
           error_message
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          notificationId,
          deviceId,
          tokenId,
          attemptNo,
          'fcm',
          providerMessageId,
          status,
          errorCode,
          errorMessage,
        ],
      );
    } catch (err) {
      logger.warn('FCM', `Failed to persist delivery attempt ${notificationId}: ${err.message}`);
    }
  }

  // ─── Core send ────────────────────────────────────────────────────────────
  async send(userId, { title, body, data = {}, channelId = 'goapp_rides' }) {
    const normalizedUserId = this._normalizeUserId(userId);
    if (!this._isUuid(normalizedUserId)) {
      logger.warn('FCM', `[SKIP — invalid userId] ${normalizedUserId}: "${title}"`);
      return { sent: false, reason: 'invalid_user_id' };
    }

    const notificationId = await this._createNotificationRecord(normalizedUserId, {
      title,
      body,
      data,
    });

    if (!this.initialized) {
      logger.info('FCM', `[SKIP — not initialised] ${normalizedUserId}: "${title}"`);
      await this._recordDeliveryAttempt(notificationId, {
        status: 'failed',
        errorMessage: 'push provider not initialized',
        errorCode: 'not_initialized',
      });
      await this._updateNotificationStatus(notificationId, 'failed', normalizedUserId, {
        errorMessage: 'push provider not initialized',
      });
      return { sent: false, reason: 'not_initialized' };
    }

    const devices = await this._getDevicesForUser(normalizedUserId);
    if (devices.length === 0) {
      logger.info('FCM', `[SKIP — no token] ${normalizedUserId}: "${title}"`);
      await this._recordDeliveryAttempt(notificationId, {
        status: 'failed',
        errorMessage: 'no active push tokens',
        errorCode: 'no_token',
      });
      await this._updateNotificationStatus(notificationId, 'failed', normalizedUserId, {
        errorMessage: 'no active push tokens',
      });
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
          await this._recordDeliveryAttempt(notificationId, {
            deviceId: device.deviceId,
            tokenId: device.token,
            providerMessageId: messageId,
            status: 'sent',
          });
          logger.info('FCM', `✓ Sent to ${normalizedUserId} (${device.platform}): "${title}" [${messageId}]`);
          return messageId;
        } catch (err) {
          await this._recordDeliveryAttempt(notificationId, {
            deviceId: device.deviceId,
            tokenId: device.token,
            status: 'failed',
            errorMessage: err?.message,
            errorCode: err?.code,
          });
          await this._handleSendError(normalizedUserId, device.token, err);
          return null;
        }
      })
    );

    const messageIds = results.filter(Boolean);
    if (messageIds.length > 0) {
      await this._updateNotificationStatus(notificationId, 'sent', normalizedUserId, {
        providerResponse: {
          messageIds,
          delivered: messageIds.length,
          attempted: devices.length,
        },
      });
      return { sent: true, messageIds, delivered: messageIds.length, notificationId };
    }

    await this._updateNotificationStatus(notificationId, 'failed', normalizedUserId, {
      errorMessage: 'all push token deliveries failed',
    });
    return { sent: false, reason: 'all_tokens_failed', notificationId };
  }

  // ─── Ride lifecycle notifications ─────────────────────────────────────────

  /** Ride requested — let rider know matching has started */
  async notifyRideRequested(riderId, rideId) {
    await this.send(riderId, {
      title: 'Finding your driver…',
      body: 'We are searching for the best driver near you.',
      data: this._withNavigationData(
        { type: 'RIDE_REQUESTED', rideId, screen: 'ride_tracking' },
        { route: 'home', deepLink: this._buildDeepLink(`/ride/${rideId}`) }
      ),
    });
  }

  /** Driver offer broadcast — notify driver to accept an offer within TTL */
  async notifyDriverRideOffer(driverId, { offerId, rideId, stage, etaMin, score, ttlSec }) {
    await this.send(driverId, {
      title: 'New Ride Offer',
      body: `Tap to accept. Offer expires in ${Math.max(1, Number(ttlSec || 7))}s.`,
      data: this._withNavigationData(
        {
          type: 'RIDE_OFFER',
          offerId,
          rideId,
          stage,
          etaMin,
          score,
          ttlSec: Math.max(1, Number(ttlSec || 7)),
          screen: 'driver_ride_offer',
        },
        { route: 'home', deepLink: this._buildDeepLink(`/driver/offers/${rideId}`) }
      ),
    });
  }

  /** Driver matched — notify both rider and driver */
  async notifyRideMatched(riderId, driverId, { rideId, driverName, vehicleType, vehicleNumber, etaMin, score }) {
    await Promise.all([
      this.send(riderId, {
        title: 'Driver Found!',
        body: `${driverName} (${vehicleType} · ${vehicleNumber}) is on the way. ETA: ${etaMin} min`,
        data: this._withNavigationData(
          { type: 'RIDE_MATCHED', rideId, driverId, etaMin, screen: 'ride_tracking' },
          { route: 'home', deepLink: this._buildDeepLink(`/ride/${rideId}`) }
        ),
      }),
      this.send(driverId, {
        title: 'New Ride Assigned',
        body: 'You have a new ride. Navigate to the pickup point.',
        data: this._withNavigationData(
          { type: 'RIDE_ASSIGNED', rideId, riderId, score, screen: 'driver_ride' },
          { route: 'home', deepLink: this._buildDeepLink(`/driver/ride/${rideId}`) }
        ),
      }),
    ]);
  }

  /** Driver arrived at pickup */
  async notifyDriverArrived(riderId, driverName, rideId) {
    await this.send(riderId, {
      title: 'Driver Arrived!',
      body: `${driverName} is waiting at your pickup location.`,
      data: this._withNavigationData(
        { type: 'DRIVER_ARRIVED', rideId, screen: 'ride_tracking' },
        { route: 'home', deepLink: this._buildDeepLink(`/ride/${rideId}`) }
      ),
    });
  }

  async notifyRideChatMessage(recipientUserId, { rideId, conversationId, senderRole, senderName, preview }) {
    const title = senderRole === 'driver' ? `${senderName || 'Driver'} sent a message` : 'Rider sent a message';
    const body = String(preview || 'Open chat to reply.').slice(0, 140);
    await this.send(recipientUserId, {
      title,
      body,
      data: this._withNavigationData(
        {
          type: 'RIDE_CHAT_MESSAGE',
          rideId,
          conversationId,
          senderRole,
          screen: 'ride_chat',
        },
        { route: 'home', deepLink: this._buildDeepLink(`/ride/${rideId}/chat`) }
      ),
    });
  }

  /** Trip started */
  async notifyTripStarted(riderId, rideId) {
    await this.send(riderId, {
      title: 'Trip Started',
      body: 'Your trip has begun. Have a safe journey!',
      data: this._withNavigationData(
        { type: 'TRIP_STARTED', rideId, screen: 'ride_tracking' },
        { route: 'home', deepLink: this._buildDeepLink(`/ride/${rideId}`) }
      ),
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
        data: this._withNavigationData(
          { type: 'TRIP_COMPLETED', rideId, finalFare, screen: 'trip_details' },
          { route: 'home', deepLink: this._buildDeepLink(`/trip/${rideId}`) }
        ),
      }),
      this.send(driverId, {
        title: 'Trip Completed',
        body: `Great job! You earned ₹${driverEarnings} for this trip.`,
        data: this._withNavigationData(
          { type: 'TRIP_COMPLETED', rideId, driverEarnings, screen: 'driver_wallet' },
          { route: 'home', deepLink: this._buildDeepLink(`/driver/wallet`) }
        ),
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
      data: this._withNavigationData(
        { type: 'CANCELLED_BY_RIDER', rideId, cancelFee: cancelFee || 0, screen: 'driver_home' },
        { route: 'home', deepLink: this._buildDeepLink(`/driver/home`) }
      ),
    });
  }

  /** Driver cancelled — notify rider that we are finding a new driver */
  async notifyCancelledByDriver(riderId, rideId) {
    await this.send(riderId, {
      title: 'Driver Cancelled',
      body: 'Your driver has cancelled. We are finding you a new driver right away!',
      data: this._withNavigationData(
        { type: 'CANCELLED_BY_DRIVER', rideId, screen: 'ride_tracking' },
        { route: 'home', deepLink: this._buildDeepLink(`/ride/${rideId}`) }
      ),
    });
  }

  /** Re-matching found a new driver after driver cancellation */
  async notifyRematchSuccess(riderId, driverId, { rideId, driverName, vehicleType, vehicleNumber, etaMin }) {
    await Promise.all([
      this.send(riderId, {
        title: 'New Driver Found!',
        body: `${driverName} (${vehicleType} · ${vehicleNumber}) is on the way. ETA: ${etaMin} min`,
        data: this._withNavigationData(
          { type: 'REMATCH_SUCCESS', rideId, driverId, etaMin, screen: 'ride_tracking' },
          { route: 'home', deepLink: this._buildDeepLink(`/ride/${rideId}`) }
        ),
      }),
      this.send(driverId, {
        title: 'New Ride Assigned',
        body: 'You have a new ride. Navigate to the pickup point.',
        data: this._withNavigationData(
          { type: 'RIDE_ASSIGNED', rideId, riderId, screen: 'driver_ride' },
          { route: 'home', deepLink: this._buildDeepLink(`/driver/ride/${rideId}`) }
        ),
      }),
    ]);
  }

  /** No drivers available */
  async notifyNoDrivers(riderId, rideId) {
    await this.send(riderId, {
      title: 'No Drivers Available',
      body: 'Sorry, no drivers are available near you right now. Please try again in a moment.',
      data: this._withNavigationData(
        { type: 'NO_DRIVERS', rideId, screen: 'ride_request' },
        { route: 'home', deepLink: this._buildDeepLink('/home') }
      ),
    });
  }

  /** Admin disabled zone — notify rider if they are in a blocked zone */
  async notifyZoneDisabled(riderId, zoneName) {
    await this.send(riderId, {
      title: 'Service Unavailable',
      body: `GoApp service has been temporarily suspended in ${zoneName}. We apologise for the inconvenience.`,
      data: this._withNavigationData(
        { type: 'ZONE_DISABLED', zoneName, screen: 'home' },
        { route: 'home', deepLink: this._buildDeepLink('/home') }
      ),
    });
  }

  async notifyWalletTopup(userId, { amount, method, txId }) {
    await this.send(userId, {
      title: 'Wallet Top-up Successful',
      body: `₹${amount} added via ${String(method || 'wallet').toUpperCase()}.`,
      channelId: 'goapp_wallet',
      data: this._withNavigationData(
        { type: 'WALLET_TOPUP', amount, method, txId, screen: 'wallet' },
        { route: 'home', deepLink: this._buildDeepLink('/wallet') }
      ),
    });
  }

  async notifyWalletPayment(userId, { rideId, fareInr, txId }) {
    await this.send(userId, {
      title: 'Ride Payment Successful',
      body: `₹${fareInr} paid${rideId ? ` for ride ${rideId}` : ''}.`,
      channelId: 'goapp_wallet',
      data: this._withNavigationData(
        { type: 'WALLET_PAYMENT', rideId, amount: fareInr, txId, screen: 'trip_details' },
        { route: 'home', deepLink: this._buildDeepLink(rideId ? `/trip/${rideId}` : '/wallet') }
      ),
    });
  }

  async notifyWalletRefund(userId, { rideId, amount, reason, txId }) {
    await this.send(userId, {
      title: 'Refund Processed',
      body: `₹${amount} refunded${rideId ? ` for ride ${rideId}` : ''}.`,
      channelId: 'goapp_wallet',
      data: this._withNavigationData(
        { type: 'WALLET_REFUND', rideId, amount, reason, txId, screen: 'wallet' },
        { route: 'home', deepLink: this._buildDeepLink('/wallet') }
      ),
    });
  }

  async notifyReferralApplied(userId, { referralCode, rewardCoins }) {
    return this.send(userId, {
      title: 'Referral Code Accepted',
      body: `Referral code ${referralCode} has been linked. Your referrer will earn ${rewardCoins} coins after your first ride.`,
      channelId: 'goapp_rewards',
      data: this._withNavigationData(
        {
          type: 'REFERRAL_APPLIED',
          referenceType: 'referral',
          referralCode,
          rewardCoins,
          screen: 'refer_earn',
        },
        { route: 'home', deepLink: this._buildDeepLink('/profile') },
      ),
    });
  }

  async notifyReferralRewardIssued(userId, { rewardCoins, rideId, trackingId, refereeName }) {
    return this.send(userId, {
      title: 'Referral Reward Credited',
      body: `${refereeName || 'Your friend'} completed the first ride. ${rewardCoins} coins have been added to your wallet.`,
      channelId: 'goapp_rewards',
      data: this._withNavigationData(
        {
          type: 'REFERRAL_REWARD_ISSUED',
          referenceType: 'referral',
          referenceId: trackingId,
          trackingId,
          rideId,
          rewardCoins,
          screen: 'refer_earn',
        },
        { route: 'home', deepLink: this._buildDeepLink('/wallet') },
      ),
    });
  }

  async notifyTicketCreated(userId, { ticketId, ticketCode = null, category, priority }) {
    const reference = ticketCode || ticketId;
    await this.send(userId, {
      title: 'Support Ticket Created',
      body: `Ticket ${reference} has been created (${category}, ${priority}).`,
      channelId: 'goapp_support',
      data: this._withNavigationData(
        { type: 'TICKET_CREATED', ticketId, ticketCode: reference, category, priority, screen: 'support_ticket' },
        { route: 'home', deepLink: this._buildDeepLink(`/support/tickets/${ticketId}`) }
      ),
    });
  }

  async notifyTicketUpdated(userId, { ticketId, ticketCode = null, status }) {
    const reference = ticketCode || ticketId;
    await this.send(userId, {
      title: 'Ticket Updated',
      body: `Ticket ${reference} is now ${status}.`,
      channelId: 'goapp_support',
      data: this._withNavigationData(
        { type: 'TICKET_UPDATED', ticketId, ticketCode: reference, status, screen: 'support_ticket' },
        { route: 'home', deepLink: this._buildDeepLink(`/support/tickets/${ticketId}`) }
      ),
    });
  }

  async notifyTicketMessage(userId, { ticketId, ticketCode = null, senderRole }) {
    const reference = ticketCode || ticketId;
    await this.send(userId, {
      title: 'New Support Message',
      body: `New ${senderRole} message in ticket ${reference}.`,
      channelId: 'goapp_support',
      data: this._withNavigationData(
        { type: 'TICKET_MESSAGE', ticketId, ticketCode: reference, senderRole, screen: 'support_ticket' },
        { route: 'home', deepLink: this._buildDeepLink(`/support/tickets/${ticketId}`) }
      ),
    });
  }

  async notifySosTriggered(userId, { sosId, rideId, sosType }) {
    await this.send(userId, {
      title: 'SOS Alert Triggered',
      body: `Emergency alert (${sosType}) has been recorded.`,
      channelId: 'goapp_safety',
      data: this._withNavigationData(
        { type: 'SOS_TRIGGERED', sosId, rideId, sosType, screen: 'safety_sos' },
        { route: 'home', deepLink: this._buildDeepLink(`/safety/sos/${sosId}`) }
      ),
    });
  }

  async notifySosStatusUpdated(userId, { sosId, status }) {
    await this.send(userId, {
      title: 'SOS Status Updated',
      body: `SOS ${sosId} is now ${status}.`,
      channelId: 'goapp_safety',
      data: this._withNavigationData(
        { type: 'SOS_STATUS_UPDATED', sosId, status, screen: 'safety_sos' },
        { route: 'home', deepLink: this._buildDeepLink(`/safety/sos/${sosId}`) }
      ),
    });
  }

  // ─── Silent / Data-only push (no banner shown to user) ────────────────────
  async sendSilent(userId, data = {}) {
    const normalizedUserId = this._normalizeUserId(userId);
    if (!this._isUuid(normalizedUserId)) {
      logger.warn('FCM', `[SKIP — invalid userId] silent push to ${normalizedUserId}`);
      return { sent: false, reason: 'invalid_user_id' };
    }

    if (!this.initialized) {
      logger.info('FCM', `[SKIP — not initialised] silent push to ${normalizedUserId}`);
      return { sent: false, reason: 'not_initialized' };
    }

    const devices = await this._getDevicesForUser(normalizedUserId);
    if (devices.length === 0) {
      logger.info('FCM', `[SKIP — no token] silent push to ${normalizedUserId}`);
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
          logger.info('FCM', `✓ Silent push to ${normalizedUserId} (${device.platform}) [${messageId}]`);
          return messageId;
        } catch (err) {
          await this._handleSendError(normalizedUserId, device.token, err);
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
      storage: 'pg+memory-cache',
      tokens: [...this.deviceTokens.values()].map((d) => ({
        userId: d.userId, platform: d.platform,
        updatedAt: new Date(d.updatedAt).toISOString(),
      })),
    };
  }

  async _getDevicesForUser(userId) {
    const normalizedUserId = this._normalizeUserId(userId);
    if (!this._isUuid(normalizedUserId)) {
      logger.warn('FCM', `Skipping token lookup for invalid userId "${normalizedUserId}"`);
      return [];
    }

    const lastFetch = this._cacheTimestamps.get(normalizedUserId) || 0;
    const cacheStale = (Date.now() - lastFetch) > TOKEN_CACHE_TTL_MS;

    if (cacheStale) {
      // Refresh from DB and populate the in-memory cache
      const { rows } = await db.query(
        `SELECT token, platform, device_id
         FROM push_tokens
         WHERE user_id = $1
           AND is_active = true
         ORDER BY updated_at DESC`,
        [normalizedUserId]
      );

      // Clear stale entries for this user before repopulating
      for (const key of this.deviceTokens.keys()) {
        if (key.startsWith(`${normalizedUserId}:`)) this.deviceTokens.delete(key);
      }
      rows.forEach((row) => {
        this.deviceTokens.set(`${normalizedUserId}:${row.token}`, {
          userId: normalizedUserId,
          token: row.token,
          platform: row.platform,
          deviceId: row.device_id,
          updatedAt: Date.now(),
        });
      });
      this._cacheTimestamps.set(normalizedUserId, Date.now());
    }

    // Serve from in-memory cache
    return [...this.deviceTokens.values()].filter((d) => d.userId === normalizedUserId);
  }

  _stringifyData(data = {}) {
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    );
  }

  _buildDeepLink(path, query = {}) {
    const rawScheme = String(APP_DEEP_LINK_SCHEME || 'goapp://').trim();
    const schemePrefix = rawScheme.endsWith('://')
      ? rawScheme
      : `${rawScheme.replace(/\/+$/, '')}://`;
    const normalizedPath = String(path || '/').startsWith('/') ? path : `/${path}`;
    const pathWithoutLeadingSlash = normalizedPath.replace(/^\/+/, '');
    const queryEntries = Object.entries(query).filter(([, value]) => value != null && value !== '');
    const base = `${schemePrefix}${pathWithoutLeadingSlash}`;
    if (queryEntries.length === 0) {
      return base;
    }
    const qs = queryEntries
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&');
    return `${base}?${qs}`;
  }

  _normalizeDeepLinkForStorage(deepLink) {
    if (!deepLink) return null;
    const normalized = String(deepLink).trim();
    if (!normalized) return null;
    if (normalized === 'wallet_activity_detail') return normalized;
    if (normalized.includes('://')) {
      const afterScheme = normalized.split('://').slice(1).join('://');
      if (!afterScheme) return null;
      if (afterScheme === 'wallet_activity_detail') return afterScheme;
      const trimmed = afterScheme.replace(/^\/+/, '');
      return trimmed ? `/${trimmed}` : null;
    }
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  }

  _inferCategory(data = {}) {
    const category = String(data.category || '').trim().toLowerCase();
    if (CATEGORY_VALUES.has(category)) return category;
    const type = String(data.type || '').toUpperCase();
    if (type.includes('PAYMENT') || type.includes('WALLET')) return 'payment';
    if (type.includes('PROMO') || type.includes('OFFER')) return 'promo';
    if (type.includes('SECURITY')) return 'security';
    if (type.includes('RIDE') || type.includes('TRIP')) return 'ride';
    return 'system';
  }

  _buildNavPayload(data = {}) {
    if (data.navPayload && typeof data.navPayload === 'object') {
      return data.navPayload;
    }
    const payload = {};
    if (data.rideId) payload.rideId = String(data.rideId);
    if (data.ticketId) payload.ticketId = String(data.ticketId);
    if (data.paymentId) payload.paymentId = String(data.paymentId);
    if (data.orderId) payload.orderId = String(data.orderId);
    if (data.paymentStatus || data.status) payload.status = String(data.paymentStatus || data.status);
    if (data.paymentMethod || data.method) payload.method = String(data.paymentMethod || data.method);
    const amountCandidate = data.amount ?? data.paymentAmount ?? data.fare;
    if (amountCandidate != null && !Number.isNaN(Number(amountCandidate))) {
      payload.amount = Number(amountCandidate);
    }
    if (data.campaignId) payload.campaignId = String(data.campaignId);
    if (data.action) payload.action = String(data.action);
    return Object.keys(payload).length > 0 ? payload : null;
  }

  _withNavigationData(data = {}, { route = 'home', deepLink = null } = {}) {
    return {
      ...data,
      route,
      deepLink: deepLink || data.deepLink || '',
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    };
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
    await db.query(
      `UPDATE push_tokens
       SET is_active = false, updated_at = NOW()
       WHERE token = $1`,
      [token]
    );

    for (const [key, value] of this.deviceTokens.entries()) {
      if (value.token === token) {
        this.deviceTokens.delete(key);
      }
    }
  }
}

module.exports = new NotificationService();
