// GoApp Zone Service
// Admin-managed circular service zones.  A ride request is accepted only if
// the pickup point falls inside at least one *enabled* zone.

const crypto = require('crypto');
const { haversine } = require('../utils/formulas');
const { logger } = require('../utils/logger');

class ZoneService {
  constructor() {
    // zoneId -> zone object
    this.zones = new Map();
  }

  // ─── Admin: create a new service zone ───────────────────────────────────
  createZone({ name, lat, lng, radiusKm }) {
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radiusKm) || radiusKm <= 0) {
      return { success: false, error: 'name, lat, lng and radiusKm (> 0) are required' };
    }

    const zoneId = `ZONE-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const zone = {
      zoneId,
      name,
      lat,
      lng,
      radiusKm,
      enabled: true,
      createdAt: Date.now(),
    };

    this.zones.set(zoneId, zone);
    logger.success('ZONE', `Created zone "${name}" (${zoneId}) | centre (${lat}, ${lng}) | radius ${radiusKm} km`);
    return { success: true, zone };
  }

  // ─── Admin: toggle a zone on or off ────────────────────────────────────
  setZoneEnabled(zoneId, enabled) {
    const zone = this.zones.get(zoneId);
    if (!zone) return { success: false, error: `Zone ${zoneId} not found` };

    zone.enabled = enabled;
    logger.info('ZONE', `Zone "${zone.name}" (${zoneId}) ${enabled ? 'ENABLED' : 'DISABLED'}`);
    return { success: true, zone };
  }

  // ─── Admin: delete a zone ───────────────────────────────────────────────
  deleteZone(zoneId) {
    const zone = this.zones.get(zoneId);
    if (!zone) return { success: false, error: `Zone ${zoneId} not found` };

    this.zones.delete(zoneId);
    logger.warn('ZONE', `Deleted zone "${zone.name}" (${zoneId})`);
    return { success: true };
  }

  // ─── Admin: list all zones ──────────────────────────────────────────────
  listZones() {
    return [...this.zones.values()];
  }

  // ─── Runtime: check whether a pickup point is in an enabled zone ────────
  // Returns { allowed: true, zone } | { allowed: false, reason }
  checkPickup(lat, lng) {
    const enabledZones = [...this.zones.values()].filter(z => z.enabled);

    // If no zones are defined at all, the service is open everywhere
    if (this.zones.size === 0) {
      return { allowed: true, reason: 'no_zones_configured' };
    }

    // If zones exist but none are enabled, service is suspended
    if (enabledZones.length === 0) {
      return { allowed: false, reason: 'SERVICE_SUSPENDED', message: 'GoApp is currently unavailable in your area.' };
    }

    for (const zone of enabledZones) {
      const distKm = haversine(lat, lng, zone.lat, zone.lng);
      if (distKm <= zone.radiusKm) {
        return { allowed: true, zone };
      }
    }

    return {
      allowed: false,
      reason: 'OUTSIDE_SERVICE_AREA',
      message: 'GoApp is not available at your pickup location yet.',
    };
  }

  getStats() {
    const all = [...this.zones.values()];
    return {
      total: all.length,
      enabled: all.filter(z => z.enabled).length,
      disabled: all.filter(z => !z.enabled).length,
    };
  }
}

module.exports = new ZoneService();
