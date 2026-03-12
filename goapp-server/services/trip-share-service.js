'use strict';

const crypto = require('crypto');
const config = require('../config');
const safetyRepo = require('../repositories/pg/pg-safety-repository');
const pgRideRepo = require('../repositories/pg/pg-ride-repository');
const locationRepo = require('../repositories/pg/pg-location-repository');
const domainDb = require('../infra/db/domain-db');
const whatsappService = require('./whatsapp-service');
const { logger } = require('../utils/logger');

const TERMINAL_STATUSES = new Set(['TRIP_COMPLETED', 'CANCELLED_BY_RIDER', 'CANCELLED_BY_DRIVER', 'NO_DRIVERS']);

class TripShareService {
  async shouldAutoShareRide({ riderId, startedAt }) {
    if (!riderId) {
      return { shouldShare: false, reason: 'MISSING_RIDER_ID' };
    }

    const prefs = await safetyRepo.getPreferences(riderId).catch(() => ({
      autoShare: false,
      shareAtNight: false,
    }));

    if (prefs.autoShare) {
      return { shouldShare: true, reason: 'AUTO_SHARE_ENABLED', preferences: prefs };
    }

    if (prefs.shareAtNight && this._isNightTime(startedAt || Date.now())) {
      return { shouldShare: true, reason: 'NIGHT_SHARE_WINDOW', preferences: prefs };
    }

    return { shouldShare: false, reason: 'PREFERENCE_DISABLED', preferences: prefs };
  }

  async handleRideStarted({ rideId, riderId = null } = {}) {
    const ride = await pgRideRepo.getRide(rideId).catch(() => null);
    if (!ride?.rideId) {
      return { shared: false, reason: 'RIDE_NOT_FOUND' };
    }

    if (!ride.otpVerifiedAt) {
      await pgRideRepo.insertRideEvent(rideId, 'ride_trip_share_skipped', {
        reason: 'OTP_NOT_VERIFIED',
      });
      return { shared: false, reason: 'OTP_NOT_VERIFIED' };
    }

    const decision = await this.shouldAutoShareRide({
      riderId: riderId || ride.riderId,
      startedAt: ride.startedAt || Date.now(),
    });
    if (!decision.shouldShare) {
      await pgRideRepo.insertRideEvent(rideId, 'ride_trip_share_skipped', {
        reason: decision.reason,
        autoShare: Boolean(decision.preferences?.autoShare),
        shareAtNight: Boolean(decision.preferences?.shareAtNight),
      });
      return { shared: false, reason: decision.reason };
    }

    const primaryContact = await safetyRepo.getPrimaryContact(ride.riderId);
    if (!primaryContact?.id || !primaryContact?.number) {
      await pgRideRepo.insertRideEvent(rideId, 'ride_trip_share_skipped', {
        reason: 'PRIMARY_CONTACT_NOT_FOUND',
      });
      return { shared: false, reason: 'PRIMARY_CONTACT_NOT_FOUND' };
    }

    const expiresAt = new Date(Date.now() + (config.tripSharing?.shareTtlHours || 12) * 3600 * 1000);
    const trackingShare = await this._createOrRefreshTrackingShare({
      rideDbId: ride.dbRideId,
      riderId: ride.riderId,
      contactId: primaryContact.id,
      expiresAt,
    });

    const publicTrackingUrl = this._buildPublicTrackingUrl(trackingShare.token);
    const payload = this.buildTrackingSharePayload({
      ride,
      contact: primaryContact,
      publicTrackingUrl,
    });

    const dispatch = await safetyRepo.recordTrustedContactShare({
      rideDbId: ride.dbRideId,
      userId: ride.riderId,
      contactId: primaryContact.id,
      shareType: 'auto',
      shareUrl: publicTrackingUrl,
      expiresAt,
      trackingShareId: trackingShare.id,
    });

    await pgRideRepo.insertRideEvent(rideId, 'ride_trip_share_created', {
      trackingShareId: trackingShare.id,
      shareId: dispatch?.id || null,
      contactId: primaryContact.id,
      expiresAt: expiresAt.toISOString(),
      publicTrackingUrl,
    });

    const delivery = await whatsappService.sendTripShare({
      toPhone: primaryContact.number,
      messageText: payload.messageText,
    });

    await this._recordDelivery({
      trackingShare,
      ride,
      dispatchId: dispatch?.id || null,
      delivery,
    });

    if (delivery.success) {
      await pgRideRepo.insertRideEvent(rideId, 'ride_trip_share_sent', {
        trackingShareId: trackingShare.id,
        shareId: dispatch?.id || null,
        provider: delivery.provider,
        providerMessageId: delivery.providerMessageId || null,
      });
      logger.info('TRIP_SHARE', `Trip share delivered for ${ride.rideId}`, {
        rideId: ride.rideId,
        contactId: primaryContact.id,
        provider: delivery.provider,
      });
      return {
        shared: true,
        trackingShareId: trackingShare.id,
        shareId: dispatch?.id || null,
        provider: delivery.provider,
      };
    }

    await pgRideRepo.insertRideEvent(rideId, 'ride_trip_share_delivery_failed', {
      trackingShareId: trackingShare.id,
      shareId: dispatch?.id || null,
      provider: delivery.provider,
      errorCode: delivery.errorCode || null,
      errorMessage: delivery.errorMessage || null,
    });
    logger.warn('TRIP_SHARE', `Trip share delivery failed for ${ride.rideId}: ${delivery.errorMessage || delivery.errorCode || 'unknown error'}`);
    return {
      shared: false,
      trackingShareId: trackingShare.id,
      shareId: dispatch?.id || null,
      reason: delivery.errorCode || 'DELIVERY_FAILED',
    };
  }

  async finalizeRideShares({ rideId, finalStatus } = {}) {
    if (!rideId || !TERMINAL_STATUSES.has(String(finalStatus || '').toUpperCase())) {
      return { updated: 0 };
    }
    const result = await domainDb.query(
      'rides',
      `WITH resolved AS (
         SELECT id
         FROM rides
         WHERE id::text = $1 OR ride_number = $1
         LIMIT 1
       )
       UPDATE ride_tracking_shares rts
       SET status = CASE
             WHEN $2 = 'TRIP_COMPLETED' THEN 'completed'
             ELSE 'revoked'
           END,
           revoked_at = CASE
             WHEN $2 = 'TRIP_COMPLETED' THEN revoked_at
             ELSE NOW()
           END
       FROM resolved
       WHERE rts.ride_id = resolved.id
         AND rts.status = 'active'
       RETURNING rts.id::text AS id`,
      [rideId, String(finalStatus || '').toUpperCase()]
    );
    if (result.rows.length) {
      await pgRideRepo.insertRideEvent(rideId, 'ride_trip_share_expired', {
        finalStatus,
        affectedShares: result.rows.length,
      });
    }
    return { updated: result.rows.length };
  }

  async getPublicShareSnapshot(token, { rideService, markViewed = true } = {}) {
    const trackingShare = await this._getTrackingShareByToken(token);
    if (!trackingShare) {
      return { success: false, status: 404, errorCode: 'TRACKING_SHARE_NOT_FOUND', message: 'Tracking link not found.' };
    }

    if (trackingShare.status !== 'active' || (trackingShare.expiresAt && new Date(trackingShare.expiresAt).getTime() < Date.now())) {
      return { success: false, status: 410, errorCode: 'TRACKING_SHARE_EXPIRED', message: 'Tracking link has expired.' };
    }

    const ride = rideService?.getRideAsync
      ? await rideService.getRideAsync(trackingShare.rideNumber).catch(() => null)
      : await pgRideRepo.getRide(trackingShare.rideNumber).catch(() => null);

    if (!ride?.rideId) {
      return { success: false, status: 404, errorCode: 'RIDE_NOT_FOUND', message: 'Ride not found.' };
    }

    const latestLocation = await locationRepo.getLatestRideLiveLocation(trackingShare.rideDbId).catch(() => null);
    const driverLat = ride.driverLat ?? latestLocation?.lat ?? null;
    const driverLng = ride.driverLng ?? latestLocation?.lng ?? null;
    const etaMin = ride.etaMin ?? latestLocation?.etaMin ?? null;
    const distanceKmRemaining =
      ride.distanceKmRemaining ??
      (typeof latestLocation?.distanceRemainingM === 'number'
        ? Number((latestLocation.distanceRemainingM / 1000).toFixed(2))
        : null);

    if (markViewed && !trackingShare.lastViewedAt) {
      await this._markTrackingShareViewed(trackingShare);
      await pgRideRepo.insertRideEvent(ride.rideId, 'ride_trip_share_viewed', {
        trackingShareId: trackingShare.id,
        contactId: trackingShare.contactId,
      }).catch(() => {});
    }

    const pickupCoords = {
      lat: this._toNumber(ride.pickupLat),
      lng: this._toNumber(ride.pickupLng),
    };
    const dropCoords = {
      lat: this._toNumber(ride.destLat),
      lng: this._toNumber(ride.destLng),
    };
    const currentCoords = {
      lat: this._toNumber(driverLat),
      lng: this._toNumber(driverLng),
    };

    return {
      success: true,
      rideId: ride.rideId,
      status: ride.status,
      driver: ride.driverId ? {
        name: this._firstName(ride.driverName),
        vehicleType: ride.driverVehicleType || ride.matchResult?.vehicleType || null,
        vehicleNumber: ride.driverVehicleNumber || ride.matchResult?.vehicleNumber || null,
      } : null,
      pickup: {
        address: ride.pickupAddress || null,
        ...pickupCoords,
      },
      drop: {
        address: ride.destAddress || null,
        ...dropCoords,
      },
      live: {
        lat: currentCoords.lat,
        lng: currentCoords.lng,
        etaMin: this._toNumber(etaMin),
        distanceKmRemaining,
      },
      googleMapsCurrentUrl: this._mapsUrl(currentCoords.lat, currentCoords.lng),
      googleMapsPickupUrl: this._mapsUrl(pickupCoords.lat, pickupCoords.lng),
      googleMapsDropUrl: this._mapsUrl(dropCoords.lat, dropCoords.lng),
      publicTrackingUrl: this._buildPublicTrackingUrl(trackingShare.token),
      pollIntervalSec: config.tripSharing?.pollIntervalSec || 5,
      expiresAt: trackingShare.expiresAt ? new Date(trackingShare.expiresAt).toISOString() : null,
    };
  }

  renderPublicSharePage(token) {
    const apiPath = `/api/v1/public/ride-share/${encodeURIComponent(token)}`;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GoApp Trip Tracking</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f7fb;color:#14171a;margin:0;padding:24px}
    .card{max-width:760px;margin:0 auto;background:#fff;border-radius:20px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,.08)}
    h1{margin:0 0 8px;font-size:28px}
    .muted{color:#5b6573}
    .pill{display:inline-block;padding:8px 14px;border-radius:999px;background:#e8f5ee;color:#128c4d;font-weight:700;margin:12px 0}
    .section{margin-top:20px}
    .label{font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em}
    .value{font-size:16px;font-weight:600;margin-top:4px}
    .grid{display:grid;grid-template-columns:1fr;gap:16px}
    a{color:#0b74ff;text-decoration:none}
    @media(min-width:720px){.grid{grid-template-columns:1fr 1fr}}
  </style>
</head>
<body>
  <div class="card">
    <h1>GoApp Trip Tracking</h1>
    <div class="muted">Live trip status shared by your trusted contact.</div>
    <div id="status" class="pill">Loading...</div>
    <div class="grid">
      <div class="section">
        <div class="label">Driver</div>
        <div id="driver" class="value">Loading...</div>
      </div>
      <div class="section">
        <div class="label">Live Location</div>
        <div id="live" class="value">Loading...</div>
      </div>
      <div class="section">
        <div class="label">Pickup</div>
        <div id="pickup" class="value">Loading...</div>
        <div><a id="pickupLink" href="#" target="_blank" rel="noreferrer">Open pickup in Google Maps</a></div>
      </div>
      <div class="section">
        <div class="label">Drop</div>
        <div id="drop" class="value">Loading...</div>
        <div><a id="dropLink" href="#" target="_blank" rel="noreferrer">Open drop in Google Maps</a></div>
      </div>
      <div class="section">
        <div class="label">Current Position</div>
        <div><a id="currentLink" href="#" target="_blank" rel="noreferrer">Open live position in Google Maps</a></div>
      </div>
    </div>
  </div>
  <script>
    async function loadSnapshot() {
      const response = await fetch('${apiPath}', { credentials: 'omit' });
      const payload = await response.json();
      const snapshot = payload && payload.data ? payload.data : payload;
      if (!response.ok || payload.success === false) {
        document.getElementById('status').textContent = payload.message || 'Tracking unavailable';
        document.getElementById('driver').textContent = '-';
        return { terminal: true };
      }

      document.getElementById('status').textContent = snapshot.status || 'ACTIVE';
      document.getElementById('driver').textContent =
        snapshot.driver ? [snapshot.driver.name, snapshot.driver.vehicleType, snapshot.driver.vehicleNumber].filter(Boolean).join(' · ') : 'Driver details unavailable';
      document.getElementById('live').textContent =
        snapshot.live && snapshot.live.lat != null && snapshot.live.lng != null
          ? snapshot.live.lat + ', ' + snapshot.live.lng + (snapshot.live.etaMin != null ? ' · ETA ' + snapshot.live.etaMin + ' min' : '')
          : 'Waiting for live GPS update';
      document.getElementById('pickup').textContent = snapshot.pickup?.address || '-';
      document.getElementById('drop').textContent = snapshot.drop?.address || '-';
      document.getElementById('pickupLink').href = snapshot.googleMapsPickupUrl || '#';
      document.getElementById('dropLink').href = snapshot.googleMapsDropUrl || '#';
      document.getElementById('currentLink').href = snapshot.googleMapsCurrentUrl || '#';

      return { terminal: ['TRIP_COMPLETED', 'CANCELLED_BY_RIDER', 'CANCELLED_BY_DRIVER', 'NO_DRIVERS'].includes(String(snapshot.status || '').toUpperCase()) };
    }

    (async () => {
      const first = await loadSnapshot();
      if (first.terminal) return;
      const timer = setInterval(async () => {
        const snapshot = await loadSnapshot();
        if (snapshot.terminal) {
          clearInterval(timer);
        }
      }, ${(config.tripSharing?.pollIntervalSec || 5) * 1000});
    })().catch((err) => {
      document.getElementById('status').textContent = err.message || 'Tracking unavailable';
    });
  </script>
</body>
</html>`;
  }

  buildTrackingSharePayload({ ride, contact, publicTrackingUrl }) {
    const pickupUrl = this._mapsUrl(ride.pickupLat, ride.pickupLng);
    const dropUrl = this._mapsUrl(ride.destLat, ride.destLng);
    const liveUrl = publicTrackingUrl;
    const driverName = this._firstName(ride.driverName) || 'Your driver';
    const vehicleLine = [ride.driverVehicleType, ride.driverVehicleNumber].filter(Boolean).join(' · ');
    const riderName = 'GoApp rider';

    const messageText = [
      `Trip started for ${riderName}.`,
      `Ride: ${ride.rideId}`,
      `Driver: ${driverName}${vehicleLine ? ` (${vehicleLine})` : ''}`,
      `Pickup: ${ride.pickupAddress || 'Not available'}`,
      pickupUrl ? `Pickup map: ${pickupUrl}` : null,
      `Drop: ${ride.destAddress || 'Not available'}`,
      dropUrl ? `Drop map: ${dropUrl}` : null,
      `Live tracking: ${liveUrl}`,
    ].filter(Boolean).join('\n');

    return {
      contactId: contact?.id || null,
      publicTrackingUrl,
      pickupUrl,
      dropUrl,
      messageText,
    };
  }

  async _createOrRefreshTrackingShare({ rideDbId, riderId, contactId, expiresAt }) {
    const { rows: existingRows } = await domainDb.query(
      'rides',
      `SELECT id::text AS id,
              token,
              status,
              expires_at AS "expiresAt"
       FROM ride_tracking_shares
       WHERE ride_id = $1
         AND contact_id = $2
         AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
      [rideDbId, contactId]
    );

    if (existingRows[0] && (!existingRows[0].expiresAt || new Date(existingRows[0].expiresAt).getTime() > Date.now())) {
      await domainDb.query(
        'rides',
        `UPDATE ride_tracking_shares
         SET expires_at = $2
         WHERE id = $1`,
        [existingRows[0].id, expiresAt]
      );
      return {
        ...existingRows[0],
        rideDbId,
        contactId,
      };
    }

    const token = crypto.randomBytes(24).toString('hex');
    const { rows } = await domainDb.query(
      'rides',
      `INSERT INTO ride_tracking_shares (
         ride_id,
         rider_user_id,
         contact_id,
         token,
         status,
         expires_at
       )
       VALUES ($1, $2, $3, $4, 'active', $5)
       RETURNING id::text AS id, token, status, expires_at AS "expiresAt"`,
      [rideDbId, riderId, contactId, token, expiresAt]
    );
    return {
      ...rows[0],
      rideDbId,
      contactId,
    };
  }

  async _getTrackingShareByToken(token) {
    const { rows } = await domainDb.query(
      'rides',
      `SELECT rts.id::text AS id,
              rts.ride_id AS "rideDbId",
              rts.rider_user_id::text AS "riderId",
              rts.contact_id::text AS "contactId",
              rts.token,
              rts.status,
              rts.expires_at AS "expiresAt",
              rts.last_viewed_at AS "lastViewedAt",
              r.ride_number AS "rideNumber"
       FROM ride_tracking_shares rts
       JOIN rides r ON r.id = rts.ride_id
       WHERE rts.token = $1
       LIMIT 1`,
      [String(token || '').trim()]
    );
    return rows[0] || null;
  }

  async _markTrackingShareViewed(trackingShare) {
    await domainDb.query(
      'rides',
      `UPDATE ride_tracking_shares
       SET last_viewed_at = COALESCE(last_viewed_at, NOW())
       WHERE id = $1`,
      [trackingShare.id]
    );
    await safetyRepo.markTrustedContactShareViewedByTrackingShareId(trackingShare.id).catch(() => {});
    await domainDb.query(
      'rides',
      `INSERT INTO trip_share_delivery_logs (
         tracking_share_id,
         ride_id,
         channel,
         provider_name,
         delivery_status,
         provider_response
       )
       VALUES ($1, $2, 'whatsapp', NULL, 'viewed', $3::jsonb)`,
      [trackingShare.id, trackingShare.rideDbId, JSON.stringify({ source: 'public_page' })]
    ).catch(() => {});
  }

  async _recordDelivery({ trackingShare, ride, dispatchId, delivery }) {
    await domainDb.query(
      'rides',
      `INSERT INTO trip_share_delivery_logs (
         tracking_share_id,
         ride_id,
         channel,
         provider_name,
         delivery_status,
         provider_message_id,
         failure_reason,
         provider_response
       )
       VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6, $7::jsonb)`,
      [
        trackingShare.id,
        ride.dbRideId,
        delivery.provider || null,
        delivery.success ? 'sent' : 'failed',
        delivery.providerMessageId || null,
        delivery.success ? null : (delivery.errorMessage || delivery.errorCode || 'Unknown delivery failure'),
        JSON.stringify(delivery.response || {}),
      ]
    ).catch(() => {});

    if (delivery.success) {
      await safetyRepo.markTrustedContactShareDelivered(dispatchId, {
        providerName: delivery.provider || null,
        providerMessageId: delivery.providerMessageId || null,
      }).catch(() => {});
      return;
    }

    await safetyRepo.markTrustedContactShareFailed(dispatchId, {
      providerName: delivery.provider || null,
      failureReason: delivery.errorMessage || delivery.errorCode || 'Unknown delivery failure',
    }).catch(() => {});
  }

  _isNightTime(dateInput) {
    const date = new Date(dateInput || Date.now());
    const hour = Number(new Intl.DateTimeFormat('en-GB', {
      timeZone: config.tripSharing?.timezone || 'Asia/Kolkata',
      hour: '2-digit',
      hour12: false,
    }).format(date));
    const start = Number(config.tripSharing?.nightWindowStartHour || 22);
    const end = Number(config.tripSharing?.nightWindowEndHour || 6);
    return hour >= start || hour < end;
  }

  _mapsUrl(lat, lng) {
    const safeLat = this._toNumber(lat);
    const safeLng = this._toNumber(lng);
    if (safeLat == null || safeLng == null) return null;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${safeLat},${safeLng}`)}`;
  }

  _buildPublicTrackingUrl(token) {
    return `${String(config.whatsapp?.publicBaseUrl || '').replace(/\/+$/, '')}/ride-share/${encodeURIComponent(token)}`;
  }

  _toNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  _firstName(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    return normalized.split(/\s+/)[0];
  }
}

module.exports = new TripShareService();
