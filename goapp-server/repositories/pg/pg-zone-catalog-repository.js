'use strict';

const domainDb = require('../../infra/db/domain-db');

class PgZoneCatalogRepository {
  _normalize(value) {
    if (value == null) return null;
    const v = String(value).trim();
    return v || null;
  }

  _mapRow(row) {
    return {
      id: row.id,
      zoneCode: row.zone_code,
      zoneName: row.zone_name,
      city: row.city,
      state: row.state,
      country: row.country,
      pincode: row.pincode || null,
      centerLat: Number(row.center_lat),
      centerLng: Number(row.center_lng),
      radiusKm: Number(row.radius_km),
      zoneLevel: row.zone_level,
      isActive: Boolean(row.is_active),
      sourceName: row.source_name || null,
      sourceUrl: row.source_url || null,
      sourceRef: row.source_ref || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async list({ city, state, country, zoneLevel, activeOnly = false } = {}) {
    const where = [];
    const args = [];

    if (activeOnly) {
      where.push('is_active = true');
    }
    if (city) {
      args.push(this._normalize(city));
      where.push(`city = $${args.length}`);
    }
    if (state) {
      args.push(this._normalize(state));
      where.push(`state = $${args.length}`);
    }
    if (country) {
      args.push(this._normalize(country));
      where.push(`country = $${args.length}`);
    }
    if (zoneLevel) {
      args.push(this._normalize(zoneLevel));
      where.push(`zone_level = $${args.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await domainDb.query('rides', 
      `SELECT id, zone_code, zone_name, city, state, country, pincode,
              center_lat, center_lng, radius_km, zone_level, is_active,
              source_name, source_url, source_ref, created_at, updated_at
       FROM zone_catalog
       ${whereSql}
       ORDER BY zone_name ASC`,
      args,
    );
    return rows.map((row) => this._mapRow(row));
  }

  async resolveByPoint({ lat, lng, city = 'Chennai', state = 'Tamil Nadu', country = 'IN' }) {
    const { rows } = await domainDb.query('rides', 
      `SELECT id, zone_code, zone_name, city, state, country, pincode,
              center_lat, center_lng, radius_km, zone_level, is_active,
              source_name, source_url, source_ref, created_at, updated_at,
              (
                6371.0 * acos(
                  LEAST(
                    1.0,
                    GREATEST(
                      -1.0,
                      cos(radians($1)) * cos(radians(center_lat)) *
                      cos(radians(center_lng) - radians($2)) +
                      sin(radians($1)) * sin(radians(center_lat))
                    )
                  )
                )
              ) AS distance_km
       FROM zone_catalog
       WHERE is_active = true
         AND city = $3
         AND state = $4
         AND country = $5
       ORDER BY distance_km ASC, radius_km ASC, zone_code ASC
       LIMIT 1`,
      [lat, lng, city, state, country],
    );
    if (!rows.length) return null;
    const row = rows[0];
    const distanceKm = Number(row.distance_km);
    if (!Number.isFinite(distanceKm) || distanceKm > Number(row.radius_km)) {
      return null;
    }
    return { ...this._mapRow(row), distanceKm };
  }
}

module.exports = new PgZoneCatalogRepository();
