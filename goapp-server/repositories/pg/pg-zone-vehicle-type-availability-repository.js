'use strict';

const domainDb = require('../../infra/db/domain-db');

class PgZoneVehicleTypeAvailabilityRepository {
  _mapRow(row) {
    return {
      id: row.id,
      zoneId: row.zone_id,
      vehicleTypeId: row.vehicle_type_id,
      vehicleTypeName: row.vehicle_type_name,
      isEnabled: row.is_enabled,
      updatedBy: row.updated_by || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    };
  }

  async listByZone(zoneId) {
    const { rows } = await domainDb.query(
      'rides',
      `SELECT id, zone_id, vehicle_type_id, vehicle_type_name, is_enabled, updated_by, created_at, updated_at
         FROM zone_vehicle_type_availability
        WHERE zone_id = $1
        ORDER BY updated_at DESC, vehicle_type_name ASC`,
      [zoneId],
    );
    return rows.map((row) => this._mapRow(row));
  }

  async listForZones(zoneIds = []) {
    if (!Array.isArray(zoneIds) || zoneIds.length === 0) return [];
    const normalized = zoneIds.map((value) => String(value)).filter(Boolean);
    if (normalized.length === 0) return [];
    const { rows } = await domainDb.query(
      'rides',
      `SELECT id, zone_id, vehicle_type_id, vehicle_type_name, is_enabled, updated_by, created_at, updated_at
         FROM zone_vehicle_type_availability
        WHERE zone_id = ANY($1::uuid[])`,
      [normalized],
    );
    return rows.map((row) => this._mapRow(row));
  }

  async upsert({ zoneId, vehicleTypeId, vehicleTypeName, isEnabled, updatedBy = null }) {
    const { rows } = await domainDb.query(
      'rides',
      `INSERT INTO zone_vehicle_type_availability
         (zone_id, vehicle_type_id, vehicle_type_name, is_enabled, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (zone_id, vehicle_type_id)
       DO UPDATE SET
         vehicle_type_name = EXCLUDED.vehicle_type_name,
         is_enabled = EXCLUDED.is_enabled,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING id, zone_id, vehicle_type_id, vehicle_type_name, is_enabled, updated_by, created_at, updated_at`,
      [zoneId, vehicleTypeId, String(vehicleTypeName).toLowerCase(), Boolean(isEnabled), updatedBy],
    );
    return this._mapRow(rows[0]);
  }
}

module.exports = new PgZoneVehicleTypeAvailabilityRepository();
