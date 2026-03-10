'use strict';

const domainDb = require('../../infra/db/domain-db');

/**
 * PostgreSQL repository for rider saved locations.
 *
 * Security guarantees:
 * - rider_id is NEVER accepted from the caller; it is always resolved from
 *   the authenticated session's userId via the riders table.
 * - All queries are fully parameterised — no string interpolation of user data.
 * - Mutations use WHERE id=$1 AND rider_id=$2 so a valid ID belonging to a
 *   different rider returns NOT_FOUND (not 403), preventing oracle attacks.
 */
class PgSavedLocationsRepository {
  // ── Private: resolve users.id → riders.id ───────────────────────────────
  async _resolveRiderId(userId) {
    const { rows } = await domainDb.query('identity', 
      `SELECT id FROM riders WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    if (!rows.length) {
      const err = new Error('Rider profile not found. Complete onboarding first.');
      err.code = 'RIDER_NOT_FOUND';
      throw err;
    }
    return rows[0].id;
  }

  // ── Private: map DB row → wire JSON shape ────────────────────────────────
  // Keys must exactly match what SavedLocationModel.fromJson() reads in Flutter:
  //   id, label, address, lat, lng, icon_key, usage_count, last_used_at
  _mapRow(row) {
    return {
      id:           row.id,
      label:        row.label,
      address:      row.address,
      lat:          parseFloat(row.latitude),
      lng:          parseFloat(row.longitude),
      icon_key:     row.icon || 'bookmark',
      usage_count:  row.usage_count != null ? Number(row.usage_count) : 0,
      last_used_at: row.last_used_at ? row.last_used_at.toISOString() : null,
    };
  }

  // ── listByRider ──────────────────────────────────────────────────────────
  async listByRider(userId) {
    const riderId = await this._resolveRiderId(userId);
    const { rows } = await domainDb.query('identity', 
      `SELECT id, label, address, latitude, longitude, icon,
              usage_count, last_used_at
       FROM rider_saved_places
       WHERE rider_id = $1
       ORDER BY usage_count DESC, last_used_at DESC NULLS LAST`,
      [riderId],
    );
    return rows.map((r) => this._mapRow(r));
  }

  // ── create ───────────────────────────────────────────────────────────────
  // Returns the newly created row so the client gets the server-assigned UUID.
  // The existing schema has a `name` column (VARCHAR 200) alongside `address`;
  // we mirror address into name so NOT NULL constraints are satisfied.
  async create({ userId, label, address, lat, lng, placeId, iconKey }) {
    const riderId = await this._resolveRiderId(userId);
    const { rows } = await domainDb.query('identity', 
      `INSERT INTO rider_saved_places
         (rider_id, label, name, address, latitude, longitude, place_id, icon)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, label, address, latitude, longitude, icon,
                 usage_count, last_used_at`,
      [
        riderId,
        label,
        address,           // name mirrors address (internal column only)
        address,
        lat,
        lng,
        placeId || null,
        iconKey || 'bookmark',
      ],
    );
    return this._mapRow(rows[0]);
  }

  // ── update ────────────────────────────────────────────────────────────────
  // Builds a dynamic SET clause from only the provided fields.
  async update(id, userId, { label, address, lat, lng, iconKey }) {
    const riderId = await this._resolveRiderId(userId);

    const sets   = [];
    const params = [];
    let   n      = 1;

    if (label   !== undefined) { sets.push(`label = $${n++}`);     params.push(label); }
    if (address !== undefined) {
      sets.push(`address = $${n++}`); params.push(address);
      sets.push(`name = $${n++}`);    params.push(address); // keep name in sync
    }
    if (lat     !== undefined) { sets.push(`latitude = $${n++}`);  params.push(lat); }
    if (lng     !== undefined) { sets.push(`longitude = $${n++}`); params.push(lng); }
    if (iconKey !== undefined) { sets.push(`icon = $${n++}`);      params.push(iconKey); }

    if (sets.length === 0) {
      const err = new Error('No updatable fields provided.');
      err.code = 'NO_FIELDS';
      throw err;
    }

    sets.push(`updated_at = NOW()`);
    params.push(id, riderId);

    const { rows } = await domainDb.query('identity', 
      `UPDATE rider_saved_places
       SET ${sets.join(', ')}
       WHERE id = $${n} AND rider_id = $${n + 1}
       RETURNING id, label, address, latitude, longitude, icon,
                 usage_count, last_used_at`,
      params,
    );

    if (!rows.length) {
      const err = new Error('Saved location not found.');
      err.code = 'NOT_FOUND';
      throw err;
    }
    return this._mapRow(rows[0]);
  }

  // ── remove ────────────────────────────────────────────────────────────────
  async remove(id, userId) {
    const riderId = await this._resolveRiderId(userId);
    const { rowCount } = await domainDb.query('identity', 
      `DELETE FROM rider_saved_places WHERE id = $1 AND rider_id = $2`,
      [id, riderId],
    );
    if (rowCount === 0) {
      const err = new Error('Saved location not found.');
      err.code = 'NOT_FOUND';
      throw err;
    }
  }

  // ── incrementUsage ────────────────────────────────────────────────────────
  // Called when a rider selects a saved location to start a ride.
  // Exposed through the service for future ride-request integration.
  async incrementUsage(id, userId) {
    const riderId = await this._resolveRiderId(userId);
    const { rows } = await domainDb.query('identity', 
      `UPDATE rider_saved_places
       SET usage_count  = usage_count + 1,
           last_used_at = NOW(),
           updated_at   = NOW()
       WHERE id = $1 AND rider_id = $2
       RETURNING id, label, address, latitude, longitude, icon,
                 usage_count, last_used_at`,
      [id, riderId],
    );
    if (!rows.length) {
      const err = new Error('Saved location not found.');
      err.code = 'NOT_FOUND';
      throw err;
    }
    return this._mapRow(rows[0]);
  }

  // ── getById ───────────────────────────────────────────────────────────────
  async getById(id, userId) {
    const riderId = await this._resolveRiderId(userId);
    const { rows } = await domainDb.query('identity', 
      `SELECT id, label, address, latitude, longitude, icon,
              usage_count, last_used_at
       FROM rider_saved_places
       WHERE id = $1 AND rider_id = $2`,
      [id, riderId],
    );
    return rows.length ? this._mapRow(rows[0]) : null;
  }
}

module.exports = new PgSavedLocationsRepository();
