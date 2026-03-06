// GoApp SOS Service
// Handles emergency SOS alerts from riders/drivers during a trip.
// Logs incidents, notifies emergency contacts, and triggers admin alerts.
//
// SQL Table schema is in enterprise-setup/node-setup.js

const crypto = require('crypto');
const { logger, eventBus } = require('../utils/logger');

// SOS status machine
const SOS_STATUS = {
  TRIGGERED:   'TRIGGERED',    // Initial alert sent
  ACKNOWLEDGED:'ACKNOWLEDGED', // Support agent acknowledged
  DISPATCHED:  'DISPATCHED',   // Emergency responder dispatched
  RESOLVED:    'RESOLVED',     // Incident resolved
  FALSE_ALARM: 'FALSE_ALARM',  // User confirmed false alarm
};

// SOS trigger types
const SOS_TYPES = {
  PANIC:        'PANIC',          // Panic button press
  ACCIDENT:     'ACCIDENT',       // Vehicle accident detected
  ROUTE_DEVIATE:'ROUTE_DEVIATE',  // Driver deviated from route
  SHARE_TRIP:   'SHARE_TRIP',     // User shared trip (info only)
};

class SosService {
  constructor() {
    // sosId -> sos record
    this.sosLogs = new Map();
    // userId -> active sosId (only one active SOS per user)
    this.activeByUser = new Map();
  }

  // ─── Trigger SOS ──────────────────────────────────────────────────────────
  triggerSos({ userId, userType, rideId, lat, lng, sosType = SOS_TYPES.PANIC, message }) {
    if (!userId) return { success: false, error: 'userId required' };
    if (!Number.isFinite(parseFloat(lat)) || !Number.isFinite(parseFloat(lng))) {
      return { success: false, error: 'valid lat/lng required' };
    }

    // Prevent duplicate active SOS
    const existingId = this.activeByUser.get(userId);
    if (existingId) {
      const existing = this.sosLogs.get(existingId);
      if (existing && existing.status === SOS_STATUS.TRIGGERED) {
        return {
          success: true,
          duplicate: true,
          sosId: existing.sosId,
          message: 'SOS already active',
          status: existing.status,
        };
      }
    }

    if (!Object.values(SOS_TYPES).includes(sosType)) {
      sosType = SOS_TYPES.PANIC;
    }

    const sosId = `SOS-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const now = Date.now();

    const sosRecord = {
      sosId,
      userId,
      userType: userType || 'rider',
      rideId: rideId || null,
      sosType,
      status: SOS_STATUS.TRIGGERED,
      triggeredAt: now,
      location: {
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        capturedAt: now,
      },
      message: message || null,
      statusHistory: [{ status: SOS_STATUS.TRIGGERED, at: now, by: 'user' }],
      acknowledgedAt: null,
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null,
    };

    this.sosLogs.set(sosId, sosRecord);
    this.activeByUser.set(userId, sosId);

    eventBus.publish('sos_triggered', {
      sosId, userId, userType, rideId, sosType,
      lat: sosRecord.location.lat,
      lng: sosRecord.location.lng,
    });

    logger.error('SOS', `🚨 SOS TRIGGERED: ${sosId} | User: ${userId} | Type: ${sosType} | Ride: ${rideId || 'N/A'}`);

    return {
      success: true,
      sosId,
      status: SOS_STATUS.TRIGGERED,
      message: 'SOS alert sent. Help is on the way.',
      triggeredAt: new Date(now).toISOString(),
    };
  }

  // ─── Update SOS Status (admin/support) ────────────────────────────────────
  updateStatus(sosId, { status, resolvedBy, resolutionNote }) {
    const sos = this.sosLogs.get(sosId);
    if (!sos) return { success: false, error: 'SOS not found' };

    if (!Object.values(SOS_STATUS).includes(status)) {
      return { success: false, error: `Invalid status. Valid: ${Object.values(SOS_STATUS).join(', ')}` };
    }

    const now = Date.now();
    sos.status = status;
    sos.statusHistory.push({ status, at: now, by: resolvedBy || 'admin' });

    if (status === SOS_STATUS.ACKNOWLEDGED) {
      sos.acknowledgedAt = now;
    }
    if (status === SOS_STATUS.RESOLVED || status === SOS_STATUS.FALSE_ALARM) {
      sos.resolvedAt = now;
      sos.resolvedBy = resolvedBy || 'admin';
      sos.resolutionNote = resolutionNote || null;
      // Clear active SOS for user
      this.activeByUser.delete(sos.userId);
    }

    eventBus.publish('sos_status_updated', { sosId, status, userId: sos.userId });
    logger.info('SOS', `SOS ${sosId} status updated to ${status} by ${resolvedBy || 'admin'}`);

    return { success: true, sosId, status, updatedAt: new Date(now).toISOString() };
  }

  // ─── Update live location during SOS ─────────────────────────────────────
  updateLocation(sosId, { lat, lng }) {
    const sos = this.sosLogs.get(sosId);
    if (!sos) return { success: false, error: 'SOS not found' };
    if (!Number.isFinite(parseFloat(lat)) || !Number.isFinite(parseFloat(lng))) {
      return { success: false, error: 'valid lat/lng required' };
    }

    sos.location = { lat: parseFloat(lat), lng: parseFloat(lng), capturedAt: Date.now() };
    return { success: true, sosId, location: sos.location };
  }

  getSos(sosId) {
    return this.sosLogs.get(sosId) || null;
  }

  getActiveSos(userId) {
    const sosId = this.activeByUser.get(userId);
    return sosId ? this.sosLogs.get(sosId) : null;
  }

  getAllSos({ status, limit = 50 } = {}) {
    let logs = [...this.sosLogs.values()];
    if (status) logs = logs.filter(s => s.status === status);
    return logs.sort((a, b) => b.triggeredAt - a.triggeredAt).slice(0, limit);
  }

  getStats() {
    const logs = [...this.sosLogs.values()];
    const byStatus = {};
    const byType   = {};
    logs.forEach(s => {
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
      byType[s.sosType]  = (byType[s.sosType]  || 0) + 1;
    });
    return { total: logs.length, active: this.activeByUser.size, byStatus, byType, types: SOS_TYPES, statuses: SOS_STATUS };
  }
}

module.exports = new SosService();
module.exports.SOS_STATUS = SOS_STATUS;
module.exports.SOS_TYPES  = SOS_TYPES;
