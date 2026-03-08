'use strict';

const safetyRepo = require('../repositories/pg/pg-safety-repository');

function registerSafetyRoutes(router, ctx) {
  const { requireAuth } = ctx;

  // ── GET /api/v1/safety/contacts ──────────────────────────────────────────
  router.register('GET', '/api/v1/safety/contacts', async ({ headers }) => {
    const authResult = await requireAuth(headers);
    if (authResult.error) return authResult.error;

    const { userId } = authResult.session;
    const contacts = await safetyRepo.getContacts(userId);
    return { status: 200, data: { success: true, contacts } };
  });

  // ── POST /api/v1/safety/contacts/add ────────────────────────────────────
  router.register('POST', '/api/v1/safety/contacts/add', async ({ body, headers }) => {
    const authResult = await requireAuth(headers);
    if (authResult.error) return authResult.error;

    const { userId } = authResult.session;
    const name        = String(body?.name        || '').trim();
    const phoneNumber = String(body?.phone_number || '').trim();

    if (!name || !phoneNumber) {
      return { status: 400, data: { success: false, message: 'name and phone_number are required' } };
    }

    try {
      const contact = await safetyRepo.addContact(userId, { name, phoneNumber });
      const contacts = await safetyRepo.getContacts(userId);
      return { status: 200, data: { success: true, contact, contacts } };
    } catch (err) {
      if (err.code === 'CONTACTS_LIMIT') {
        return { status: 422, data: { success: false, message: err.message } };
      }
      throw err;
    }
  });

  // ── DELETE /api/v1/safety/contacts/delete ────────────────────────────────
  router.register('DELETE', '/api/v1/safety/contacts/delete', async ({ body, headers }) => {
    const authResult = await requireAuth(headers);
    if (authResult.error) return authResult.error;

    const { userId } = authResult.session;
    const contactId = String(body?.id || '').trim();

    if (!contactId) {
      return { status: 400, data: { success: false, message: 'id is required' } };
    }

    try {
      await safetyRepo.deleteContact(userId, contactId);
      const contacts = await safetyRepo.getContacts(userId);
      return { status: 200, data: { success: true, contacts } };
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return { status: 404, data: { success: false, message: err.message } };
      }
      throw err;
    }
  });

  // ── PUT /api/v1/safety/contacts/update ───────────────────────────────────
  router.register('PUT', '/api/v1/safety/contacts/update', async ({ body, headers }) => {
    const authResult = await requireAuth(headers);
    if (authResult.error) return authResult.error;

    const { userId } = authResult.session;
    const contactId   = String(body?.id           || '').trim();
    const name        = String(body?.name         || '').trim();
    const phoneNumber = String(body?.phone_number || '').trim();

    if (!contactId || !name || !phoneNumber) {
      return { status: 400, data: { success: false, message: 'id, name, and phone_number are required' } };
    }

    try {
      await safetyRepo.updateContact(userId, contactId, { name, phoneNumber });
      const contacts = await safetyRepo.getContacts(userId);
      return { status: 200, data: { success: true, contacts } };
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return { status: 404, data: { success: false, message: err.message } };
      }
      throw err;
    }
  });

  // ── PUT /api/v1/safety/contacts/primary ──────────────────────────────────
  router.register('PUT', '/api/v1/safety/contacts/primary', async ({ body, headers }) => {
    const authResult = await requireAuth(headers);
    if (authResult.error) return authResult.error;

    const { userId } = authResult.session;
    const contactId = String(body?.id || '').trim();

    if (!contactId) {
      return { status: 400, data: { success: false, message: 'id is required' } };
    }

    try {
      await safetyRepo.makePrimary(userId, contactId);
      const contacts = await safetyRepo.getContacts(userId);
      return { status: 200, data: { success: true, contacts } };
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return { status: 404, data: { success: false, message: err.message } };
      }
      throw err;
    }
  });

  // ── GET /api/v1/safety/preferences ──────────────────────────────────────
  router.register('GET', '/api/v1/safety/preferences', async ({ headers }) => {
    const authResult = await requireAuth(headers);
    if (authResult.error) return authResult.error;

    const { userId } = authResult.session;
    const prefs = await safetyRepo.getPreferences(userId);
    return { status: 200, data: { success: true, ...prefs } };
  });

  // ── PUT /api/v1/safety/preferences ──────────────────────────────────────
  router.register('PUT', '/api/v1/safety/preferences', async ({ body, headers }) => {
    const authResult = await requireAuth(headers);
    if (authResult.error) return authResult.error;

    const { userId } = authResult.session;
    const autoShare    = body?.autoShare    != null ? Boolean(body.autoShare)    : null;
    const shareAtNight = body?.shareAtNight != null ? Boolean(body.shareAtNight) : null;

    if (autoShare === null && shareAtNight === null) {
      return { status: 400, data: { success: false, message: 'Nothing to update' } };
    }

    // Merge with existing prefs so caller can send partial updates
    const current = await safetyRepo.getPreferences(userId);
    const prefs = await safetyRepo.updatePreferences(userId, {
      autoShare:    autoShare    ?? current.autoShare,
      shareAtNight: shareAtNight ?? current.shareAtNight,
    });
    return { status: 200, data: { success: true, ...prefs } };
  });
}

module.exports = registerSafetyRoutes;
