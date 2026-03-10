'use strict';

const { validateSchema, validationError } = require('./validation');
const {
  badRequest,
  notFoundError,
  normalizeRouteError,
  getAuthenticatedSession,
} = require('./response');

/**
 * Zone Restriction routes.
 *
 * Admin CRUD (X-Admin-Token required):
 *   GET    /api/v1/admin/zone-restrictions
 *   POST   /api/v1/admin/zone-restrictions
 *   PUT    /api/v1/admin/zone-restrictions/:id
 *   PUT    /api/v1/admin/zone-restrictions/:id/enable
 *   PUT    /api/v1/admin/zone-restrictions/:id/disable
 *   DELETE /api/v1/admin/zone-restrictions/:id
 *
 * Public (Bearer JWT required) — used by Flutter before booking:
 *   POST   /api/v1/zones/check
 */
function registerZoneRestrictionRoutes(router, ctx) {
  const { requireAuth, requireAdmin } = ctx;

  const zoneRestrictionsService =
    ctx.services?.zoneRestrictionsService ||
    require('../services/zone-restrictions-service');

  // ── Shared error handler ──────────────────────────────────────────────────
  function handleError(err) {
    if (err.code === 'NOT_FOUND') {
      return notFoundError(err.message, err.code);
    }
    if (err.code === 'NO_FIELDS') {
      return badRequest(err.message, err.code);
    }
    throw err;
  }

  // ── GET /api/v1/admin/zone-restrictions ───────────────────────────────────
  router.register('GET', '/api/v1/admin/zone-restrictions', async ({ headers }) => {
    const adminErr = requireAdmin(headers);
    if (adminErr) return normalizeRouteError(adminErr, 'ADMIN_AUTH_REQUIRED');

    const zones = await zoneRestrictionsService.list();
    return {
      status: 200,
      data: {
        success: true,
        zones,
        stats: {
          total:   zones.length,
          enabled: zones.filter((z) => z.isEnabled).length,
          disabled: zones.filter((z) => !z.isEnabled).length,
        },
      },
    };
  });

  // ── POST /api/v1/admin/zone-restrictions ──────────────────────────────────
  router.register('POST', '/api/v1/admin/zone-restrictions', async ({ body, headers }) => {
    const adminErr = requireAdmin(headers);
    if (adminErr) return normalizeRouteError(adminErr, 'ADMIN_AUTH_REQUIRED');

    const parsed = validateSchema(body, [
      { key: 'name',               type: 'string', required: true,  minLength: 1, maxLength: 200 },
      { key: 'lat',                type: 'number', required: true,  min: -90,    max: 90 },
      { key: 'lng',                type: 'number', required: true,  min: -180,   max: 180 },
      { key: 'radiusKm',           type: 'number', required: true,  min: 0.01,   max: 500 },
      { key: 'isAllowed',          type: 'boolean', required: false },
      { key: 'country',            type: 'string',  required: false, maxLength: 80 },
      { key: 'state',              type: 'string',  required: false, maxLength: 120 },
      { key: 'pincode',            type: 'string',  required: false, maxLength: 20 },
      { key: 'restrictionMessage', type: 'string',  required: false, maxLength: 300 },
      { key: 'createdBy',          type: 'string',  required: false, maxLength: 100 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    try {
      const zone = await zoneRestrictionsService.create({
        name:               parsed.data.name,
        lat:                parsed.data.lat,
        lng:                parsed.data.lng,
        radiusKm:           parsed.data.radiusKm,
        appliesTo:          'both',
        isAllowed:          parsed.data.isAllowed ?? false,
        country:            parsed.data.country,
        state:              parsed.data.state,
        pincode:            parsed.data.pincode,
        restrictionMessage: parsed.data.restrictionMessage,
        createdBy:          parsed.data.createdBy || null,
      });
      return { status: 201, data: { success: true, zone } };
    } catch (err) {
      return handleError(err);
    }
  });

  // ── PUT /api/v1/admin/zone-restrictions/:id ───────────────────────────────
  router.register('PUT', '/api/v1/admin/zone-restrictions/:id', async ({ pathParams, body, headers }) => {
    const adminErr = requireAdmin(headers);
    if (adminErr) return normalizeRouteError(adminErr, 'ADMIN_AUTH_REQUIRED');

    const parsed = validateSchema(body, [
      { key: 'name',               type: 'string', required: false, minLength: 1, maxLength: 200 },
      { key: 'lat',                type: 'number', required: false, min: -90,    max: 90 },
      { key: 'lng',                type: 'number', required: false, min: -180,   max: 180 },
      { key: 'radiusKm',           type: 'number', required: false, min: 0.01,   max: 500 },
      { key: 'isAllowed',          type: 'boolean', required: false },
      { key: 'country',            type: 'string',  required: false, maxLength: 80 },
      { key: 'state',              type: 'string',  required: false, maxLength: 120 },
      { key: 'pincode',            type: 'string',  required: false, maxLength: 20 },
      { key: 'restrictionMessage', type: 'string',  required: false, maxLength: 300 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    if (Object.keys(parsed.data).length === 0) {
      return validationError('No updatable fields provided');
    }

    try {
      const updates = { ...parsed.data };
      if (Object.prototype.hasOwnProperty.call(updates, 'appliesTo')) {
        updates.appliesTo = 'both';
      }
      const zone = await zoneRestrictionsService.update(pathParams.id, updates);
      return { status: 200, data: { success: true, zone } };
    } catch (err) {
      return handleError(err);
    }
  });

  // ── PUT /api/v1/admin/zone-restrictions/:id/enable ────────────────────────
  router.register('PUT', '/api/v1/admin/zone-restrictions/:id/enable', async ({ pathParams, headers }) => {
    const adminErr = requireAdmin(headers);
    if (adminErr) return normalizeRouteError(adminErr, 'ADMIN_AUTH_REQUIRED');

    try {
      const zone = await zoneRestrictionsService.setEnabled(pathParams.id, true);
      return { status: 200, data: { success: true, zone } };
    } catch (err) {
      return handleError(err);
    }
  });

  // ── PUT /api/v1/admin/zone-restrictions/:id/disable ───────────────────────
  router.register('PUT', '/api/v1/admin/zone-restrictions/:id/disable', async ({ pathParams, headers }) => {
    const adminErr = requireAdmin(headers);
    if (adminErr) return normalizeRouteError(adminErr, 'ADMIN_AUTH_REQUIRED');

    try {
      const zone = await zoneRestrictionsService.setEnabled(pathParams.id, false);
      return { status: 200, data: { success: true, zone } };
    } catch (err) {
      return handleError(err);
    }
  });

  // ── DELETE /api/v1/admin/zone-restrictions/:id ────────────────────────────
  router.register('DELETE', '/api/v1/admin/zone-restrictions/:id', async ({ pathParams, headers }) => {
    const adminErr = requireAdmin(headers);
    if (adminErr) return normalizeRouteError(adminErr, 'ADMIN_AUTH_REQUIRED');

    try {
      await zoneRestrictionsService.remove(pathParams.id);
      return { status: 200, data: { success: true } };
    } catch (err) {
      return handleError(err);
    }
  });

  // ── POST /api/v1/zones/check ──────────────────────────────────────────────
  // Public endpoint — Flutter calls this before showing "Book Now".
  // Returns immediately; does NOT block booking if the request itself fails.
  router.register('POST', '/api/v1/zones/check', async ({ body, headers }) => {
    const authResult = await getAuthenticatedSession(requireAuth, headers);
    if (authResult.error) return authResult.error;

    const parsed = validateSchema(body, [
      { key: 'lat',  type: 'number', required: true,  min: -90,  max: 90 },
      { key: 'lng',  type: 'number', required: true,  min: -180, max: 180 },
      { key: 'role', type: 'string', required: false, enum: ['rider', 'driver'] },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    const role   = parsed.data.role || 'rider';
    const result = await zoneRestrictionsService.checkRestricted(parsed.data.lat, parsed.data.lng, role);

    return { status: 200, data: result };
  });
}

module.exports = registerZoneRestrictionRoutes;
