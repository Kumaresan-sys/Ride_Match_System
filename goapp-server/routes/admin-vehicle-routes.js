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

function registerAdminVehicleRoutes(router, ctx) {
  const { requireAdmin } = ctx;
  const pricingService = ctx.services.pricingService;

  function ensureAdmin(headers = {}) {
    const err = requireAdmin(headers);
    return err ? normalizeRouteError(err, 'ADMIN_AUTH_REQUIRED') : null;
  }

  // ── Public: active vehicle types for the app ──────────────────────────────
  router.register('GET', '/api/v1/vehicle-types', async () => {
    const vehicleTypes = await vehicleTypeService.listActive();
    return { data: { vehicleTypes } };
  });

  // ── Admin: list all (including inactive) ─────────────────────────────────
  router.register('GET', '/api/v1/admin/vehicle-types', async ({ headers }) => {
    const err = ensureAdmin(headers);
    if (err) return err;

    const vehicleTypes = await vehicleTypeService.listAll();
    return { data: { vehicleTypes } };
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
