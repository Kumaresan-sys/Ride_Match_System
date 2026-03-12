'use strict';

const db = require('./db');
const pricingService = require('./pricing-service');

class VehicleTypeService {
  async listActive() {
    const { rows } = await db.query(
      `SELECT id, name, display_name, category, base_fare, per_km_rate, per_min_rate,
              min_fare, commission_pct, max_passengers, sort_order, icon_url, description
       FROM vehicle_types
       WHERE is_active = true
       ORDER BY sort_order ASC`
    );
    return rows.map(this._formatType);
  }

  async listAll() {
    const { rows } = await db.query(
      `SELECT id, name, display_name, category, base_fare, per_km_rate, per_min_rate,
              min_fare, commission_pct, max_passengers, sort_order, icon_url, description,
              is_active, created_at, updated_at
       FROM vehicle_types
       ORDER BY sort_order ASC`
    );
    return rows.map(this._formatType);
  }

  async getById(id) {
    const { rows } = await db.query(
      `SELECT id, name, display_name, category, base_fare, per_km_rate, per_min_rate,
              min_fare, commission_pct, max_passengers, sort_order, icon_url, description,
              is_active, created_at, updated_at
         FROM vehicle_types
        WHERE id = $1
        LIMIT 1`,
      [id],
    );
    return rows[0] ? this._formatType(rows[0]) : null;
  }

  async create(payload) {
    const { rows } = await db.query(
      `INSERT INTO vehicle_types
         (name, display_name, category, base_fare, per_km_rate, per_min_rate,
          min_fare, commission_pct, max_passengers, sort_order, icon_url, description, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
       RETURNING *`,
      [
        payload.name.toLowerCase(),
        payload.displayName,
        payload.category,
        payload.baseFare,
        payload.perKmRate,
        payload.perMinRate,
        payload.minFare,
        payload.commissionPct ?? 0.20,
        payload.maxPassengers,
        payload.sortOrder ?? 0,
        payload.iconUrl ?? null,
        payload.description ?? null,
      ]
    );
    pricingService.invalidateCache();
    return this._formatType(rows[0]);
  }

  async update(id, data) {
    const setClauses = [];
    const values = [];
    let idx = 1;
    const fieldMap = {
      displayName: 'display_name',
      category: 'category',
      baseFare: 'base_fare',
      perKmRate: 'per_km_rate',
      perMinRate: 'per_min_rate',
      minFare: 'min_fare',
      commissionPct: 'commission_pct',
      maxPassengers: 'max_passengers',
      sortOrder: 'sort_order',
      iconUrl: 'icon_url',
      description: 'description',
      isActive: 'is_active',
    };

    for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        setClauses.push(`${dbCol} = $${idx++}`);
        values.push(data[jsKey]);
      }
    }
    if (setClauses.length === 0) return { reason: 'NO_FIELDS' };

    values.push(id);
    const { rows } = await db.query(
      `UPDATE vehicle_types SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (rows.length === 0) return null;
    pricingService.invalidateCache();
    return this._formatType(rows[0]);
  }

  async deactivate(id) {
    const { rows } = await db.query(
      `UPDATE vehicle_types SET is_active = false WHERE id = $1 RETURNING id, name`,
      [id]
    );
    if (rows.length === 0) return null;
    pricingService.invalidateCache();
    return rows[0];
  }

  _formatType(row) {
    return {
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      category: row.category,
      baseFare: parseFloat(row.base_fare),
      perKmRate: parseFloat(row.per_km_rate),
      perMinRate: parseFloat(row.per_min_rate),
      minFare: parseFloat(row.min_fare),
      commissionPct: parseFloat(row.commission_pct),
      maxPassengers: row.max_passengers,
      sortOrder: row.sort_order,
      iconUrl: row.icon_url,
      description: row.description,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = new VehicleTypeService();
