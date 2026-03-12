'use strict';

const { haversine } = require('../utils/formulas');
const repo = require('../repositories/pg/pg-zone-vehicle-type-pricing-repository');
const zoneRestrictionsService = require('./zone-restrictions-service');

class ZoneVehicleTypePricingService {
  _pickBestZone(zones = [], pickupLat, pickupLng) {
    if (!Array.isArray(zones) || zones.length === 0) return null;
    return [...zones].sort((a, b) => {
      const radiusDiff = Number(a.radiusKm || 0) - Number(b.radiusKm || 0);
      if (radiusDiff !== 0) return radiusDiff;
      const distA = haversine(pickupLat, pickupLng, Number(a.lat), Number(a.lng));
      const distB = haversine(pickupLat, pickupLng, Number(b.lat), Number(b.lng));
      return distA - distB;
    })[0];
  }

  async resolveBestZoneForLocation(pickupLat, pickupLng, role = 'rider') {
    if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
      return null;
    }
    const zones = await zoneRestrictionsService.getMatchingZones(pickupLat, pickupLng, role);
    return this._pickBestZone(zones, pickupLat, pickupLng);
  }

  async listZonePricing(zoneId, vehicleTypes = []) {
    const rows = await repo.listByZone(zoneId);
    const pricingByVehicleTypeId = new Map(rows.map((row) => [String(row.vehicleTypeId), row]));

    return vehicleTypes.map((vehicleType) => {
      const zonePricing = pricingByVehicleTypeId.get(String(vehicleType.id)) || null;
      return {
        ...vehicleType,
        zoneId,
        zonePricingId: zonePricing?.id || null,
        zonePricing,
        effectivePricing: zonePricing
          ? {
              baseFare: zonePricing.baseFare,
              perKmRate: zonePricing.perKmRate,
              perMinRate: zonePricing.perMinRate,
              minFare: zonePricing.minFare,
              commissionPct: zonePricing.commissionPct ?? vehicleType.commissionPct,
            }
          : {
              baseFare: vehicleType.baseFare,
              perKmRate: vehicleType.perKmRate,
              perMinRate: vehicleType.perMinRate,
              minFare: vehicleType.minFare,
              commissionPct: vehicleType.commissionPct,
            },
      };
    });
  }

  async applyZonePricingForLocation(vehicleTypes = [], { pickupLat, pickupLng, role = 'rider' } = {}) {
    const zone = await this.resolveBestZoneForLocation(pickupLat, pickupLng, role);
    if (!zone) return vehicleTypes;

    const rows = await repo.listByZone(zone.id);
    if (!rows.length) return vehicleTypes;

    const pricingByName = new Map(rows.map((row) => [String(row.vehicleTypeName).toLowerCase(), row]));
    return vehicleTypes.map((vehicleType) => {
      const override = pricingByName.get(String(vehicleType.name || '').toLowerCase());
      if (!override) return vehicleType;
      return {
        ...vehicleType,
        zoneId: zone.id,
        zonePricingId: override.id,
        baseFare: override.baseFare,
        perKmRate: override.perKmRate,
        perMinRate: override.perMinRate,
        minFare: override.minFare,
        commissionPct: override.commissionPct ?? vehicleType.commissionPct,
      };
    });
  }

  async setZonePricing({ zoneId, vehicleType, pricing, updatedBy = null }) {
    return repo.upsert({
      zoneId,
      vehicleTypeId: vehicleType.id,
      vehicleTypeName: vehicleType.name,
      baseFare: pricing.baseFare,
      perKmRate: pricing.perKmRate,
      perMinRate: pricing.perMinRate,
      minFare: pricing.minFare,
      commissionPct: pricing.commissionPct ?? null,
      updatedBy,
    });
  }

  async bulkSetZonePricing({ zoneId, entries = [], updatedBy = null }) {
    const results = [];
    for (const entry of entries) {
      results.push(await this.setZonePricing({
        zoneId,
        vehicleType: entry.vehicleType,
        pricing: entry.pricing,
        updatedBy,
      }));
    }
    return results;
  }

  async clearZonePricing(zoneId, vehicleTypeId) {
    return repo.remove(zoneId, vehicleTypeId);
  }
}

module.exports = new ZoneVehicleTypePricingService();
