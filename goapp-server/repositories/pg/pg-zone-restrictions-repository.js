'use strict';

const domainDb          = require('../../infra/db/domain-db');
const { haversine } = require('../../utils/formulas');

/**
 * PostgreSQL repository for admin-managed zone restrictions.
 *
 * Zones are circular (lat/lng centre + radius_km) so no PostGIS is needed.
 * Distance checks use the haversine formula already used by zone-service.js.
 *
 * Security: all mutations are keyed by id; no user-supplied rider_id involved.
 * Admin-only mutations are enforced at the route layer (X-Admin-Token).
 */
class PgZoneRestrictionsRepository {
  _normalizeGeoField(value) {
    if (value == null) return null;
    const normalized = String(value).trim().toUpperCase();
    return normalized || null;
  }

  _normalizeGeoInput({ country, state, pincode } = {}) {
    return {
      country: this._normalizeGeoField(country),
      state: this._normalizeGeoField(state),
      pincode: this._normalizeGeoField(pincode),
    };
  }

  _matchesGeoFilter(zone, location = {}) {
    const normalized = this._normalizeGeoInput(location);
    if (zone.country && zone.country !== normalized.country) return false;
    if (zone.state && zone.state !== normalized.state) return false;
    if (zone.pincode && zone.pincode !== normalized.pincode) return false;
    return true;
  }

  // ── Private: map DB row → API shape ──────────────────────────────────────
  _mapRow(row) {
    return {
      id:                 row.id,
      name:               row.name,
      lat:                parseFloat(row.lat),
      lng:                parseFloat(row.lng),
      radiusKm:           parseFloat(row.radius_km),
      appliesTo:          row.applies_to,
      isAllowed:          row.is_allowed,          // true = whitelist, false = blacklist
      country:            row.country ? String(row.country).toUpperCase() : null,
      state:              row.state ? String(row.state).toUpperCase() : null,
      pincode:            row.pincode ? String(row.pincode).toUpperCase() : null,
      isEnabled:          row.is_enabled,
      restrictionMessage: row.restriction_message,
      createdBy:          row.created_by || null,
      createdAt:          row.created_at,
      updatedAt:          row.updated_at,
    };
  }

  // ── list ──────────────────────────────────────────────────────────────────
  async list() {
    const { rows } = await domainDb.query('rides', 
      `SELECT id, name, lat, lng, radius_km, applies_to, is_allowed, is_enabled,
              country, state, pincode, restriction_message, created_by, created_at, updated_at
       FROM zone_restrictions
       ORDER BY created_at DESC`,
    );
    return rows.map((r) => this._mapRow(r));
  }

  // ── listEnabled ───────────────────────────────────────────────────────────
  async listEnabled(role) {
    const { rows } = await domainDb.query('rides', 
      `SELECT id, name, lat, lng, radius_km, applies_to, is_allowed, is_enabled,
              country, state, pincode, restriction_message
       FROM zone_restrictions
       WHERE is_enabled = true
         AND (applies_to = $1 OR applies_to = 'both')`,
      [role],
    );
    return rows.map((r) => this._mapRow(r));
  }

  async findMatchingZones(lat, lng, role = 'rider', location = {}) {
    const zones = await this.listEnabled(role);
    const normalizedLocation = this._normalizeGeoInput(location);
    return zones.filter(
      (zone) =>
        haversine(lat, lng, zone.lat, zone.lng) <= zone.radiusKm &&
        this._matchesGeoFilter(zone, normalizedLocation),
    );
  }

  // ── create ────────────────────────────────────────────────────────────────
  async create({ name, lat, lng, radiusKm, appliesTo = 'both', isAllowed = false, country, state, pincode, restrictionMessage, createdBy }) {
    const geo = this._normalizeGeoInput({ country, state, pincode });
    const { rows } = await domainDb.query('rides', 
      `INSERT INTO zone_restrictions
         (name, lat, lng, radius_km, applies_to, is_allowed, country, state, pincode, restriction_message, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, name, lat, lng, radius_km, applies_to, is_allowed, is_enabled,
                 country, state, pincode, restriction_message, created_by, created_at, updated_at`,
      [
        name,
        lat,
        lng,
        radiusKm,
        appliesTo,
        isAllowed,
        geo.country,
        geo.state,
        geo.pincode,
        restrictionMessage || 'Service is not available in this area.',
        createdBy || null,
      ],
    );
    return this._mapRow(rows[0]);
  }

  // ── update ────────────────────────────────────────────────────────────────
  async update(id, { name, lat, lng, radiusKm, appliesTo, isAllowed, country, state, pincode, restrictionMessage }) {
    const sets   = [];
    const params = [];
    let   n      = 1;

    if (name               !== undefined) { sets.push(`name = $${n++}`);                params.push(name); }
    if (lat                !== undefined) { sets.push(`lat = $${n++}`);                 params.push(lat); }
    if (lng                !== undefined) { sets.push(`lng = $${n++}`);                 params.push(lng); }
    if (radiusKm           !== undefined) { sets.push(`radius_km = $${n++}`);           params.push(radiusKm); }
    if (appliesTo          !== undefined) { sets.push(`applies_to = $${n++}`);          params.push(appliesTo); }
    if (isAllowed          !== undefined) { sets.push(`is_allowed = $${n++}`);          params.push(Boolean(isAllowed)); }
    if (country            !== undefined) { sets.push(`country = $${n++}`);             params.push(this._normalizeGeoField(country)); }
    if (state              !== undefined) { sets.push(`state = $${n++}`);               params.push(this._normalizeGeoField(state)); }
    if (pincode            !== undefined) { sets.push(`pincode = $${n++}`);             params.push(this._normalizeGeoField(pincode)); }
    if (restrictionMessage !== undefined) { sets.push(`restriction_message = $${n++}`); params.push(restrictionMessage); }

    if (sets.length === 0) {
      const err = new Error('No updatable fields provided.');
      err.code = 'NO_FIELDS';
      throw err;
    }

    sets.push(`updated_at = NOW()`);
    params.push(id);

    const { rows } = await domainDb.query('rides', 
      `UPDATE zone_restrictions SET ${sets.join(', ')}
       WHERE id = $${n}
       RETURNING id, name, lat, lng, radius_km, applies_to, is_allowed, is_enabled,
                 country, state, pincode, restriction_message, created_by, created_at, updated_at`,
      params,
    );

    if (!rows.length) {
      const err = new Error('Zone restriction not found.');
      err.code = 'NOT_FOUND';
      throw err;
    }
    return this._mapRow(rows[0]);
  }

  // ── setEnabled ────────────────────────────────────────────────────────────
  async setEnabled(id, enabled) {
    const { rows } = await domainDb.query('rides', 
      `UPDATE zone_restrictions
       SET is_enabled = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, lat, lng, radius_km, applies_to, is_allowed, is_enabled,
                 restriction_message, created_by, created_at, updated_at`,
      [id, enabled],
    );
    if (!rows.length) {
      const err = new Error('Zone restriction not found.');
      err.code = 'NOT_FOUND';
      throw err;
    }
    return this._mapRow(rows[0]);
  }

  // ── remove ────────────────────────────────────────────────────────────────
  async remove(id) {
    const { rowCount } = await domainDb.query('rides', 
      `DELETE FROM zone_restrictions WHERE id = $1`,
      [id],
    );
    if (rowCount === 0) {
      const err = new Error('Zone restriction not found.');
      err.code = 'NOT_FOUND';
      throw err;
    }
  }

  // ── checkCoordinate ───────────────────────────────────────────────────────
  // Two-pass check:
  //   Pass 1 — blacklist (is_allowed=false): block if inside any active restricted zone.
  //   Pass 2 — whitelist (is_allowed=true):  if any exist, pickup must be inside at least one.
  async checkCoordinate(lat, lng, role = 'rider', location = {}) {
    const zones = await this.listEnabled(role);
    const normalizedLocation = this._normalizeGeoInput(location);

    const blacklist = zones.filter((z) => !z.isAllowed);
    const whitelist = zones.filter((z) => z.isAllowed);

    // Pass 1 — blacklist check
    for (const zone of blacklist) {
      if (
        haversine(lat, lng, zone.lat, zone.lng) <= zone.radiusKm &&
        this._matchesGeoFilter(zone, normalizedLocation)
      ) {
        return {
          restricted: true,
          message: zone.restrictionMessage,
          zoneName: zone.name,
          zoneId: zone.id,
          geoFilterApplied: Boolean(zone.country || zone.state || zone.pincode),
          location: normalizedLocation,
        };
      }
    }

    // Pass 2 — whitelist check (only when allowed zones are configured)
    if (whitelist.length > 0) {
      const insideAllowed = whitelist.some(
        (z) =>
          haversine(lat, lng, z.lat, z.lng) <= z.radiusKm &&
          this._matchesGeoFilter(z, normalizedLocation),
      );
      if (!insideAllowed) {
        return {
          restricted: true,
          message:    'Service is not available in your area yet.',
          zoneName:   null,
          zoneId:     null,
          geoFilterApplied: whitelist.some((z) => Boolean(z.country || z.state || z.pincode)),
          location:   normalizedLocation,
        };
      }
    }

    return { restricted: false, location: normalizedLocation, geoFilterApplied: false };
  }
}

module.exports = new PgZoneRestrictionsRepository();
