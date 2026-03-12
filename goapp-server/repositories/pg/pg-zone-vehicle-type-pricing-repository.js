'use strict';

const domainDb = require('../../infra/db/domain-db');

class PgZoneVehicleTypePricingRepository {
  _mapRow(row) {
    return {
      id: row.id,
      zoneId: row.zone_id,
      vehicleTypeId: row.vehicle_type_id,
      vehicleTypeName: row.vehicle_type_name,
      baseFare: Number.parseFloat(row.base_fare),
      perKmRate: Number.parseFloat(row.per_km_rate),
      perMinRate: Number.parseFloat(row.per_min_rate),
      minFare: Number.parseFloat(row.min_fare),
      commissionPct: row.commission_pct != null ? Number.parseFloat(row.commission_pct) : null,
      updatedBy: row.updated_by || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    };
  }

  async listByZone(zoneId) {
    const { rows } = await domainDb.query(
      'rides',
      `SELECT id, zone_id, vehicle_type_id, vehicle_type_name, base_fare, per_km_rate,
              per_min_rate, min_fare, commission_pct, updated_by, created_at, updated_at
         FROM zone_vehicle_type_pricing
        WHERE zone_id = $1
        ORDER BY vehicle_type_name ASC`,
      [zoneId],
    );
    return rows.map((row) => this._mapRow(row));
  }

  async upsert({
    zoneId,
    vehicleTypeId,
    vehicleTypeName,
    baseFare,
    perKmRate,
    perMinRate,
    minFare,
    commissionPct = null,
    updatedBy = null,
  }) {
    const { rows } = await domainDb.query(
      'rides',
      `INSERT INTO zone_vehicle_type_pricing
         (zone_id, vehicle_type_id, vehicle_type_name, base_fare, per_km_rate, per_min_rate, min_fare, commission_pct, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (zone_id, vehicle_type_id)
       DO UPDATE SET
         vehicle_type_name = EXCLUDED.vehicle_type_name,
         base_fare = EXCLUDED.base_fare,
         per_km_rate = EXCLUDED.per_km_rate,
         per_min_rate = EXCLUDED.per_min_rate,
         min_fare = EXCLUDED.min_fare,
         commission_pct = EXCLUDED.commission_pct,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING id, zone_id, vehicle_type_id, vehicle_type_name, base_fare, per_km_rate,
                 per_min_rate, min_fare, commission_pct, updated_by, created_at, updated_at`,
      [
        zoneId,
        vehicleTypeId,
        String(vehicleTypeName).toLowerCase(),
        baseFare,
        perKmRate,
        perMinRate,
        minFare,
        commissionPct,
        updatedBy,
      ],
    );
    return this._mapRow(rows[0]);
  }

  async remove(zoneId, vehicleTypeId) {
    const { rowCount } = await domainDb.query(
      'rides',
      `DELETE FROM zone_vehicle_type_pricing
        WHERE zone_id = $1
          AND vehicle_type_id = $2`,
      [zoneId, vehicleTypeId],
    );
    return rowCount > 0;
  }
}

module.exports = new PgZoneVehicleTypePricingRepository();
