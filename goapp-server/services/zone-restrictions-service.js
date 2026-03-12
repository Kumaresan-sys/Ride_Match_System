'use strict';

const repo = require('../repositories/pg/pg-zone-restrictions-repository');
const googleMapsService = require('./google-maps-service');
const { logger } = require('../utils/logger');

/**
 * Service for admin-managed, DB-backed zone restrictions.
 *
 * Unlike the in-memory zone-service.js (which loses state on restart), this
 * service persists zones in PostgreSQL and survives server restarts.
 *
 * Thin wrapper — business logic lives in the repository's haversine check.
 */
class ZoneRestrictionsService {
  constructor() {
    this.metrics = {
      geoResolveFailed: 0,
      blockedByGeoFilter: 0,
    };
  }

  _normalizeGeo(value) {
    if (value == null) return null;
    const normalized = String(value).trim().toUpperCase();
    return normalized || null;
  }

  async _resolveLocationComponents(lat, lng) {
    const result = await googleMapsService.reverseGeocode(lat, lng);
    if (!result || result.error) {
      this.metrics.geoResolveFailed += 1;
      logger.warn(
        'ZONE_RESTRICTIONS',
        `metric=zone_restriction.geo_resolve_failed count=${this.metrics.geoResolveFailed} lat=${lat} lng=${lng} err="${result?.error || 'unknown'}"`,
      );
      return null;
    }
    const location = {
      country: this._normalizeGeo(result.country),
      state: this._normalizeGeo(result.state),
      pincode: this._normalizeGeo(result.pincode),
    };
    logger.info(
      'ZONE_RESTRICTIONS',
      `Geo components resolved lat=${lat} lng=${lng} country=${location.country || 'n/a'} state=${location.state || 'n/a'} pincode=${location.pincode || 'n/a'}`,
    );
    return location;
  }

  // ── Admin operations ──────────────────────────────────────────────────────

  async list() {
    return repo.list();
  }

  async create({ name, lat, lng, radiusKm, appliesTo, isAllowed, country, state, pincode, restrictionMessage, createdBy }) {
    return repo.create({ name, lat, lng, radiusKm, appliesTo, isAllowed, country, state, pincode, restrictionMessage, createdBy });
  }

  async update(id, updates) {
    return repo.update(id, updates); // throws NOT_FOUND if id unknown
  }

  async setEnabled(id, enabled) {
    return repo.setEnabled(id, enabled); // throws NOT_FOUND if id unknown
  }

  async remove(id) {
    return repo.remove(id); // throws NOT_FOUND if id unknown
  }

  // ── Runtime check ─────────────────────────────────────────────────────────
  // Called by ride-routes.js before accepting a ride request, and by the
  // public /zones/check endpoint used by the Flutter app before booking.
  //
  // role = 'rider' | 'driver'
  // Returns:
  //   { restricted: false }
  //   { restricted: true, message: string, zoneName: string }
  async checkRestricted(lat, lng, role = 'rider') {
    const location = await this._resolveLocationComponents(lat, lng);
    if (!location) {
      // Fail-open when geocode is unavailable (availability first)
      return { restricted: false, location: null, geocodeUnavailable: true };
    }

    const result = await repo.checkCoordinate(lat, lng, role, location);
    if (result.restricted && result.geoFilterApplied) {
      this.metrics.blockedByGeoFilter += 1;
      logger.warn(
        'ZONE_RESTRICTIONS',
        `metric=zone_restriction.blocked_by_geo_filter count=${this.metrics.blockedByGeoFilter} role=${role} zoneId=${result.zoneId || 'n/a'} country=${location.country || 'n/a'} state=${location.state || 'n/a'} pincode=${location.pincode || 'n/a'}`,
      );
    }
    return result;
  }

  async getMatchingZones(lat, lng, role = 'rider') {
    const location = await this._resolveLocationComponents(lat, lng);
    if (!location) {
      return [];
    }
    return repo.findMatchingZones(lat, lng, role, location);
  }
}

module.exports = new ZoneRestrictionsService();
