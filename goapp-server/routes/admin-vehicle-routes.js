'use strict';
// Admin CRUD for vehicle service types + pricing
// Public:  GET  /api/v1/vehicle-types           — app fetches available types
// Admin:   GET  /api/v1/admin/vehicle-types      — all types including inactive
//          POST /api/v1/admin/vehicle-types       — create new type
//          PUT  /api/v1/admin/vehicle-types/:id   — update type / pricing
//          DELETE /api/v1/admin/vehicle-types/:id — deactivate (soft delete)

const { validateSchema, validationError } = require('./validation');
const { badRequest, notFoundError, normalizeRouteError } = require('./response');
const vehicleTypeService = require('../services/vehicle-type-service');
const zoneVehicleTypeAvailabilityService = require('../services/zone-vehicle-type-availability-service');
const zoneVehicleTypePricingService = require('../services/zone-vehicle-type-pricing-service');
const zoneRestrictionsService = require('../services/zone-restrictions-service');

function registerAdminVehicleRoutes(router, ctx) {
  const { requireAdmin } = ctx;
  const pricingService = ctx.services.pricingService;

  function ensureAdmin(headers = {}) {
    const err = requireAdmin(headers);
    return err ? normalizeRouteError(err, 'ADMIN_AUTH_REQUIRED') : null;
  }

  // ── Public: active vehicle types for the app ──────────────────────────────
  router.register('GET', '/api/v1/vehicle-types', async ({ params }) => {
    const pickupLat = Number.parseFloat(params?.get('pickupLat') || '');
    const pickupLng = Number.parseFloat(params?.get('pickupLng') || '');
    let vehicleTypes = await vehicleTypeService.listActive();
    if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
      vehicleTypes = await zoneVehicleTypeAvailabilityService.filterVehicleTypesForLocation(vehicleTypes, {
        pickupLat,
        pickupLng,
        role: 'rider',
      });
      vehicleTypes = await zoneVehicleTypePricingService.applyZonePricingForLocation(vehicleTypes, {
        pickupLat,
        pickupLng,
        role: 'rider',
      });
    }
    return { data: { vehicleTypes } };
  });

  // ── Admin: list all (including inactive) ─────────────────────────────────
  router.register('GET', '/api/v1/admin/vehicle-types', async ({ headers }) => {
    const err = ensureAdmin(headers);
    if (err) return err;

    const vehicleTypes = await vehicleTypeService.listAll();
    return { data: { vehicleTypes } };
  });

  router.register('GET', '/api/v1/admin/zones/:zoneId/vehicle-types', async ({ headers, pathParams }) => {
    const err = ensureAdmin(headers);
    if (err) return err;

    const zoneId = pathParams?.zoneId;
    if (!zoneId) return badRequest('Missing zoneId', 'VALIDATION_ERROR');

    const zones = await zoneRestrictionsService.list();
    const zone = zones.find((item) => String(item.id) === String(zoneId));
    if (!zone) return notFoundError('Zone not found', 'ZONE_NOT_FOUND');

    const vehicleTypes = await vehicleTypeService.listAll();
    const availability = await zoneVehicleTypeAvailabilityService.listZoneAvailability(zoneId, vehicleTypes);
    const merged = await zoneVehicleTypePricingService.listZonePricing(zoneId, availability);
    return { data: { zone, vehicleTypes: merged } };
  });

  // ── Admin: create ─────────────────────────────────────────────────────────
  router.register('POST', '/api/v1/admin/vehicle-types', async ({ headers, body }) => {
    const err = ensureAdmin(headers);
    if (err) return err;

    const parsed = validateSchema(body, [
      { key: 'name',          type: 'string',  required: true,  minLength: 1, maxLength: 50 },
      { key: 'displayName',   type: 'string',  required: true,  minLength: 1, maxLength: 100 },
      { key: 'category',      type: 'string',  required: true,
        enum: ['economy', 'comfort', 'premium', 'xl', 'auto', 'bike', 'ev'] },
      { key: 'baseFare',      type: 'number',  required: true,  min: 0 },
      { key: 'perKmRate',     type: 'number',  required: true,  min: 0 },
      { key: 'perMinRate',    type: 'number',  required: true,  min: 0 },
      { key: 'minFare',       type: 'number',  required: true,  min: 0 },
      { key: 'commissionPct', type: 'number',  required: false, min: 0, max: 1 },
      { key: 'maxPassengers', type: 'number',  required: true,  min: 1 },
      { key: 'sortOrder',     type: 'number',  required: false },
      { key: 'iconUrl',       type: 'string',  required: false },
      { key: 'description',   type: 'string',  required: false },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    const vehicleType = await vehicleTypeService.create(parsed.data);
    return { status: 201, data: { vehicleType } };
  });

  // ── Admin: update ─────────────────────────────────────────────────────────
  router.register('PUT', '/api/v1/admin/vehicle-types/:id', async ({ headers, body, pathParams }) => {
    const err = ensureAdmin(headers);
    if (err) return err;

    const id = pathParams?.id;
    if (!id) return badRequest('Missing id', 'VALIDATION_ERROR');

    const parsed = validateSchema(body, [
      { key: 'displayName',   type: 'string',  required: false, minLength: 1, maxLength: 100 },
      { key: 'category',      type: 'string',  required: false,
        enum: ['economy', 'comfort', 'premium', 'xl', 'auto', 'bike', 'ev'] },
      { key: 'baseFare',      type: 'number',  required: false, min: 0 },
      { key: 'perKmRate',     type: 'number',  required: false, min: 0 },
      { key: 'perMinRate',    type: 'number',  required: false, min: 0 },
      { key: 'minFare',       type: 'number',  required: false, min: 0 },
      { key: 'commissionPct', type: 'number',  required: false, min: 0, max: 1 },
      { key: 'maxPassengers', type: 'number',  required: false, min: 1 },
      { key: 'sortOrder',     type: 'number',  required: false },
      { key: 'iconUrl',       type: 'string',  required: false },
      { key: 'description',   type: 'string',  required: false },
      { key: 'isActive',      type: 'boolean', required: false },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    const result = await vehicleTypeService.update(id, parsed.data);
    if (result && result.reason === 'NO_FIELDS') {
      return badRequest('No fields to update', 'NO_FIELDS');
    }
    if (!result) return notFoundError('Vehicle type not found', 'VEHICLE_TYPE_NOT_FOUND');
    return { data: { vehicleType: result } };
  });

  // ── Admin: deactivate (soft delete) ──────────────────────────────────────
  router.register('DELETE', '/api/v1/admin/vehicle-types/:id', async ({ headers, pathParams }) => {
    const err = ensureAdmin(headers);
    if (err) return err;

    const id = pathParams?.id;
    if (!id) return badRequest('Missing id', 'VALIDATION_ERROR');

    const result = await vehicleTypeService.deactivate(id);
    if (!result) return notFoundError('Vehicle type not found', 'VEHICLE_TYPE_NOT_FOUND');
    return { data: { message: `Vehicle type '${result.name}' deactivated` } };
  });

  router.register('PUT', '/api/v1/admin/zones/:zoneId/vehicle-types/:vehicleTypeId', async ({ headers, pathParams, body }) => {
    const err = ensureAdmin(headers);
    if (err) return err;

    const zoneId = pathParams?.zoneId;
    const vehicleTypeId = pathParams?.vehicleTypeId;
    if (!zoneId || !vehicleTypeId) return badRequest('Missing zoneId or vehicleTypeId', 'VALIDATION_ERROR');

    const parsed = validateSchema(body, [
      { key: 'isEnabled', type: 'boolean', required: true },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    const zones = await zoneRestrictionsService.list();
    const zone = zones.find((item) => String(item.id) === String(zoneId));
    if (!zone) return notFoundError('Zone not found', 'ZONE_NOT_FOUND');

    const vehicleType = await vehicleTypeService.getById(vehicleTypeId);
    if (!vehicleType) {
      return notFoundError('Vehicle type not found', 'VEHICLE_TYPE_NOT_FOUND');
    }

    const updatedBy = headers['x-admin-id'] || headers['x-admin-email'] || 'admin';
    const availability = await zoneVehicleTypeAvailabilityService.setZoneAvailability({
      zoneId,
      vehicleType,
      isEnabled: parsed.data.isEnabled,
      updatedBy: String(updatedBy),
    });
    return { data: { availability } };
  });

  router.register('POST', '/api/v1/admin/zones/:zoneId/vehicle-types/bulk', async ({ headers, pathParams, body }) => {
    const err = ensureAdmin(headers);
    if (err) return err;

    const zoneId = pathParams?.zoneId;
    if (!zoneId) return badRequest('Missing zoneId', 'VALIDATION_ERROR');
    const availability = Array.isArray(body?.availability) ? body.availability : null;
    if (!availability || availability.length === 0) {
      return badRequest('availability array is required', 'VALIDATION_ERROR');
    }

    const zones = await zoneRestrictionsService.list();
    const zone = zones.find((item) => String(item.id) === String(zoneId));
    if (!zone) return notFoundError('Zone not found', 'ZONE_NOT_FOUND');

    const vehicleTypes = await vehicleTypeService.listAll();
    const vehicleTypeById = new Map(vehicleTypes.map((item) => [String(item.id), item]));
    const entries = [];
    for (const row of availability) {
      const vehicleTypeId = String(row?.vehicleTypeId || '').trim();
      if (!vehicleTypeId || typeof row?.isEnabled !== 'boolean') {
        return badRequest('Each availability item requires vehicleTypeId and isEnabled', 'VALIDATION_ERROR');
      }
      const vehicleType = vehicleTypeById.get(vehicleTypeId);
      if (!vehicleType) {
        return notFoundError(`Vehicle type not found: ${vehicleTypeId}`, 'VEHICLE_TYPE_NOT_FOUND');
      }
      entries.push({
        ...vehicleType,
        isEnabled: row.isEnabled,
      });
    }

    const updatedBy = headers['x-admin-id'] || headers['x-admin-email'] || 'admin';
    const updates = await zoneVehicleTypeAvailabilityService.bulkSetZoneAvailability({
      zoneId,
      vehicleTypes: entries,
      updatedBy: String(updatedBy),
    });
    return { data: { updates } };
  });

  router.register('PUT', '/api/v1/admin/zones/:zoneId/vehicle-types/:vehicleTypeId/pricing', async ({ headers, pathParams, body }) => {
    const err = ensureAdmin(headers);
    if (err) return err;

    const zoneId = pathParams?.zoneId;
    const vehicleTypeId = pathParams?.vehicleTypeId;
    if (!zoneId || !vehicleTypeId) return badRequest('Missing zoneId or vehicleTypeId', 'VALIDATION_ERROR');

    const parsed = validateSchema(body, [
      { key: 'baseFare', type: 'number', required: true, min: 0 },
      { key: 'perKmRate', type: 'number', required: true, min: 0 },
      { key: 'perMinRate', type: 'number', required: true, min: 0 },
      { key: 'minFare', type: 'number', required: true, min: 0 },
      { key: 'commissionPct', type: 'number', required: false, min: 0, max: 1 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    const zones = await zoneRestrictionsService.list();
    const zone = zones.find((item) => String(item.id) === String(zoneId));
    if (!zone) return notFoundError('Zone not found', 'ZONE_NOT_FOUND');

    const vehicleType = await vehicleTypeService.getById(vehicleTypeId);
    if (!vehicleType) {
      return notFoundError('Vehicle type not found', 'VEHICLE_TYPE_NOT_FOUND');
    }

    const updatedBy = headers['x-admin-id'] || headers['x-admin-email'] || 'admin';
    const pricing = await zoneVehicleTypePricingService.setZonePricing({
      zoneId,
      vehicleType,
      pricing: parsed.data,
      updatedBy: String(updatedBy),
    });
    return { data: { pricing } };
  });

  router.register('POST', '/api/v1/admin/zones/:zoneId/vehicle-types/pricing/bulk', async ({ headers, pathParams, body }) => {
    const err = ensureAdmin(headers);
    if (err) return err;

    const zoneId = pathParams?.zoneId;
    if (!zoneId) return badRequest('Missing zoneId', 'VALIDATION_ERROR');

    const pricingEntries = Array.isArray(body?.pricing) ? body.pricing : null;
    if (!pricingEntries || pricingEntries.length === 0) {
      return badRequest('pricing array is required', 'VALIDATION_ERROR');
    }

    const zones = await zoneRestrictionsService.list();
    const zone = zones.find((item) => String(item.id) === String(zoneId));
    if (!zone) return notFoundError('Zone not found', 'ZONE_NOT_FOUND');

    const vehicleTypes = await vehicleTypeService.listAll();
    const vehicleTypeById = new Map(vehicleTypes.map((item) => [String(item.id), item]));
    const entries = [];
    for (const row of pricingEntries) {
      const vehicleTypeId = String(row?.vehicleTypeId || '').trim();
      if (!vehicleTypeId) {
        return badRequest('Each pricing item requires vehicleTypeId', 'VALIDATION_ERROR');
      }
      const vehicleType = vehicleTypeById.get(vehicleTypeId);
      if (!vehicleType) {
        return notFoundError(`Vehicle type not found: ${vehicleTypeId}`, 'VEHICLE_TYPE_NOT_FOUND');
      }
      const parsed = validateSchema(row, [
        { key: 'baseFare', type: 'number', required: true, min: 0 },
        { key: 'perKmRate', type: 'number', required: true, min: 0 },
        { key: 'perMinRate', type: 'number', required: true, min: 0 },
        { key: 'minFare', type: 'number', required: true, min: 0 },
        { key: 'commissionPct', type: 'number', required: false, min: 0, max: 1 },
      ]);
      if (!parsed.ok) return validationError(parsed.error);
      entries.push({
        vehicleType,
        pricing: parsed.data,
      });
    }

    const updatedBy = headers['x-admin-id'] || headers['x-admin-email'] || 'admin';
    const updates = await zoneVehicleTypePricingService.bulkSetZonePricing({
      zoneId,
      entries,
      updatedBy: String(updatedBy),
    });
    return { data: { updates } };
  });

  router.register('DELETE', '/api/v1/admin/zones/:zoneId/vehicle-types/:vehicleTypeId/pricing', async ({ headers, pathParams }) => {
    const err = ensureAdmin(headers);
    if (err) return err;

    const zoneId = pathParams?.zoneId;
    const vehicleTypeId = pathParams?.vehicleTypeId;
    if (!zoneId || !vehicleTypeId) return badRequest('Missing zoneId or vehicleTypeId', 'VALIDATION_ERROR');

    const zones = await zoneRestrictionsService.list();
    const zone = zones.find((item) => String(item.id) === String(zoneId));
    if (!zone) return notFoundError('Zone not found', 'ZONE_NOT_FOUND');

    const vehicleType = await vehicleTypeService.getById(vehicleTypeId);
    if (!vehicleType) {
      return notFoundError('Vehicle type not found', 'VEHICLE_TYPE_NOT_FOUND');
    }

    const removed = await zoneVehicleTypePricingService.clearZonePricing(zoneId, vehicleTypeId);
    if (!removed) return notFoundError('Zone vehicle pricing override not found', 'ZONE_VEHICLE_PRICING_NOT_FOUND');
    return { data: { removed: true } };
  });

  // ── Admin: pricing tax config ─────────────────────────────────────────────
  router.register('GET', '/api/v1/admin/pricing/tax', async ({ headers }) => {
    const err = ensureAdmin(headers);
    if (err) return err;
    const taxConfig = await pricingService.getTaxConfig();
    return { data: { taxConfig } };
  });

  router.register('PUT', '/api/v1/admin/pricing/tax', async ({ headers, body }) => {
    const err = ensureAdmin(headers);
    if (err) return err;

    const parsed = validateSchema(body, [
      { key: 'gstPct', type: 'number', required: false, min: 0, max: 100 },
      { key: 'platformCommissionPct', type: 'number', required: false, min: 0, max: 1 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);
    if (parsed.data.gstPct === undefined && parsed.data.platformCommissionPct === undefined) {
      return badRequest('At least one of gstPct or platformCommissionPct is required', 'NO_FIELDS');
    }

    const updatedBy = headers['x-admin-id'] || headers['x-admin-email'] || 'admin';
    const taxConfig = await pricingService.setTaxConfig(
      {
        gstPct: parsed.data.gstPct,
        platformCommissionPct: parsed.data.platformCommissionPct,
      },
      String(updatedBy)
    );
    return { data: { taxConfig } };
  });
}

module.exports = registerAdminVehicleRoutes;
