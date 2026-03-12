'use strict';

const repo = require('../repositories/pg/pg-zone-vehicle-type-availability-repository');
const zoneRestrictionsService = require('./zone-restrictions-service');

class ZoneVehicleTypeAvailabilityService {
  async listZoneAvailability(zoneId, vehicleTypes = []) {
    const rows = await repo.listByZone(zoneId);
    const rowByVehicleTypeId = new Map(rows.map((row) => [String(row.vehicleTypeId), row]));
    const hasZoneRows = rows.length > 0;

    return vehicleTypes.map((vehicleType) => {
      const zoneRule = rowByVehicleTypeId.get(String(vehicleType.id)) || null;
      return {
        ...vehicleType,
        zoneId,
        zoneRuleId: zoneRule?.id || null,
        zoneEnabled: zoneRule?.isEnabled ?? null,
        effectiveAvailability: Boolean(vehicleType.isActive) && (hasZoneRows ? zoneRule?.isEnabled === true : true),
      };
    });
  }

  async setZoneAvailability({ zoneId, vehicleType, isEnabled, updatedBy = null }) {
    return repo.upsert({
      zoneId,
      vehicleTypeId: vehicleType.id,
      vehicleTypeName: vehicleType.name,
      isEnabled,
      updatedBy,
    });
  }

  async bulkSetZoneAvailability({ zoneId, vehicleTypes = [], updatedBy = null }) {
    const results = [];
    for (const vehicleType of vehicleTypes) {
      results.push(await this.setZoneAvailability({
        zoneId,
        vehicleType,
        isEnabled: vehicleType.isEnabled,
        updatedBy,
      }));
    }
    return results;
  }

  async filterVehicleTypesForLocation(vehicleTypes = [], { pickupLat, pickupLng, role = 'rider' } = {}) {
    if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
      return vehicleTypes;
    }

    const matchedZones = await zoneRestrictionsService.getMatchingZones(pickupLat, pickupLng, role);
    if (!matchedZones.length) {
      return vehicleTypes;
    }

    const zoneIds = matchedZones.map((zone) => zone.id);
    const availabilityRows = await repo.listForZones(zoneIds);
    if (!availabilityRows.length) {
      return vehicleTypes;
    }

    const stateByVehicleTypeName = new Map();
    for (const row of availabilityRows) {
      const key = String(row.vehicleTypeName || '').trim().toLowerCase();
      if (!key) continue;
      const previous = stateByVehicleTypeName.get(key) || { hasEnabled: false, hasDisabled: false };
      if (row.isEnabled) {
        previous.hasEnabled = true;
      } else {
        previous.hasDisabled = true;
      }
      stateByVehicleTypeName.set(key, previous);
    }

    return vehicleTypes.filter((vehicleType) => {
      const key = String(vehicleType.name || '').trim().toLowerCase();
      const state = stateByVehicleTypeName.get(key);
      if (!state) return false;
      if (state.hasDisabled) return false;
      return state.hasEnabled;
    });
  }
}

module.exports = new ZoneVehicleTypeAvailabilityService();
