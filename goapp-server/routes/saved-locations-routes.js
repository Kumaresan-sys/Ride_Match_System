'use strict';

const { validateSchema, validationError } = require('./validation');
const { buildError, getAuthenticatedSession } = require('./response');

/**
 * Saved Locations routes — matches the Flutter ApiEndpoints constants exactly:
 *   GET    /api/v1/saved-locations          → savedLocationsList
 *   POST   /api/v1/saved-locations/add      → savedLocationsAdd
 *   DELETE /api/v1/saved-locations/delete   → savedLocationsDelete
 *   PUT    /api/v1/saved-locations/update   → savedLocationsUpdate
 *
 * All routes require a valid Bearer JWT (via requireAuth).
 * rider_id is resolved server-side — never accepted from the client.
 */
function registerSavedLocationsRoutes(router, ctx) {
  const { requireAuth } = ctx;

  // Lazy-require follows the same pattern as profile-routes.js / safety-routes.js
  const savedLocationsService =
    ctx.services?.savedLocationsService ||
    require('../services/saved-locations-service');

  // ── Shared error handler ────────────────────────────────────────────────
  function handleServiceError(err) {
    switch (err.code) {
      case 'RIDER_NOT_FOUND':
        return buildError(422, err.message, err.code);
      case 'LOCATIONS_LIMIT':
        return buildError(422, err.message, err.code);
      case 'LABEL_DUPLICATE':
        return buildError(409, err.message, err.code);
      case 'NOT_FOUND':
        return buildError(404, err.message, err.code);
      case 'NO_FIELDS':
        return buildError(400, err.message, err.code);
      default:
        throw err; // Unhandled — bubble to the global error handler in server.js
    }
  }

  // ── GET /api/v1/saved-locations ──────────────────────────────────────────
  router.register('GET', '/api/v1/saved-locations', async ({ headers }) => {
    const authResult = await getAuthenticatedSession(requireAuth, headers);
    if (authResult.error) return authResult.error;

    const { userId } = authResult.session;

    try {
      const locations = await savedLocationsService.list(userId);
      return { status: 200, data: { success: true, locations } };
    } catch (err) {
      return handleServiceError(err);
    }
  });

  // ── POST /api/v1/saved-locations/add ─────────────────────────────────────
  router.register('POST', '/api/v1/saved-locations/add', async ({ body, headers }) => {
    const authResult = await getAuthenticatedSession(requireAuth, headers);
    if (authResult.error) return authResult.error;

    const { userId } = authResult.session;

    const parsed = validateSchema(body, [
      { key: 'label',    type: 'string', required: true,  minLength: 1, maxLength: 50 },
      { key: 'address',  type: 'string', required: true,  minLength: 1, maxLength: 500 },
      { key: 'lat',      type: 'number', required: true,  min: -90,   max: 90 },
      { key: 'lng',      type: 'number', required: true,  min: -180,  max: 180 },
      { key: 'icon_key', type: 'string', required: false, maxLength: 30 },
      { key: 'place_id', type: 'string', required: false, maxLength: 200 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    const { label, address, lat, lng, icon_key, place_id } = parsed.data;

    try {
      const location = await savedLocationsService.add(userId, {
        label,
        address,
        lat,
        lng,
        placeId:  place_id  || null,
        iconKey:  icon_key  || 'bookmark',
      });
      return { status: 201, data: { success: true, location } };
    } catch (err) {
      return handleServiceError(err);
    }
  });

  // ── POST /api/v1/saved-locations/use ─────────────────────────────────────
  // Called when a saved location chip is tapped. Atomically increments
  // usage_count and sets last_used_at = NOW() so the home screen chip order
  // reflects the most regularly used locations.
  router.register('POST', '/api/v1/saved-locations/use', async ({ body, headers }) => {
    const authResult = await getAuthenticatedSession(requireAuth, headers);
    if (authResult.error) return authResult.error;

    const { userId } = authResult.session;

    const id = String(body?.id || '').trim();
    if (!id) return validationError('id is required');

    try {
      const location = await savedLocationsService.incrementUsage(id, userId);
      return { status: 200, data: { success: true, location } };
    } catch (err) {
      return handleServiceError(err);
    }
  });

  // ── DELETE /api/v1/saved-locations/delete ────────────────────────────────
  // id is sent in the request body (consistent with the safety contacts pattern)
  router.register('DELETE', '/api/v1/saved-locations/delete', async ({ body, headers }) => {
    const authResult = await getAuthenticatedSession(requireAuth, headers);
    if (authResult.error) return authResult.error;

    const { userId } = authResult.session;

    const id = String(body?.id || '').trim();
    if (!id) return validationError('id is required');

    try {
      await savedLocationsService.remove(id, userId);
      return { status: 200, data: { success: true } };
    } catch (err) {
      return handleServiceError(err);
    }
  });

  // ── PUT /api/v1/saved-locations/update ───────────────────────────────────
  router.register('PUT', '/api/v1/saved-locations/update', async ({ body, headers }) => {
    const authResult = await getAuthenticatedSession(requireAuth, headers);
    if (authResult.error) return authResult.error;

    const { userId } = authResult.session;

    const id = String(body?.id || '').trim();
    if (!id) return validationError('id is required');

    const parsed = validateSchema(body, [
      { key: 'label',    type: 'string', required: false, minLength: 1, maxLength: 50 },
      { key: 'address',  type: 'string', required: false, minLength: 1, maxLength: 500 },
      { key: 'lat',      type: 'number', required: false, min: -90,   max: 90 },
      { key: 'lng',      type: 'number', required: false, min: -180,  max: 180 },
      { key: 'icon_key', type: 'string', required: false, maxLength: 30 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    if (Object.keys(parsed.data).length === 0) {
      return validationError('No updatable fields provided');
    }

    const { label, address, lat, lng, icon_key } = parsed.data;
    const updates = {};
    if (label    !== undefined) updates.label   = label;
    if (address  !== undefined) updates.address = address;
    if (lat      !== undefined) updates.lat     = lat;
    if (lng      !== undefined) updates.lng     = lng;
    if (icon_key !== undefined) updates.iconKey = icon_key;

    try {
      const location = await savedLocationsService.update(id, userId, updates);
      return { status: 200, data: { success: true, location } };
    } catch (err) {
      return handleServiceError(err);
    }
  });
}

module.exports = registerSavedLocationsRoutes;
