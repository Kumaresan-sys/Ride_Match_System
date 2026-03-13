'use strict';

const { validate } = require('./validation');

function registerNotificationRoutes(router, ctx) {
  const { requireAuth } = ctx;
  const notificationCenterService =
    ctx.services?.notificationCenterService ||
    require('../services/notification-center-service');

  router.register('GET', '/api/v1/notifications', async ({ headers, query }) => {
    const auth = await requireAuth(headers);
    if (auth.error) return auth.error;
    const limit = Math.min(Math.max(Number(query?.limit) || 20, 1), 100);
    const cursor = query?.cursor ? String(query.cursor) : null;
    const result = await notificationCenterService.listNotifications(auth.session.userId, {
      cursor,
      limit,
    });
    return {
      data: {
        items: result.items,
        next_cursor: result.nextCursor,
        unread_count: result.unreadCount,
      },
    };
  });

  router.register('GET', '/api/v1/notifications/unread-count', async ({ headers }) => {
    const auth = await requireAuth(headers);
    if (auth.error) return auth.error;
    const count = await notificationCenterService.unreadCount(auth.session.userId);
    return { data: { unread_count: count } };
  });

  router.register('POST', '/api/v1/notifications', async ({ headers, body }) => {
    const auth = await requireAuth(headers);
    if (auth.error) return auth.error;
    const schema = {
      title: 'string',
      message: 'string',
      category: 'string',
      deep_link: 'string?',
      nav_payload: 'object?',
      source_service: 'string?',
      reference_type: 'string?',
      reference_id: 'string?',
      event_type: 'string?',
      expires_at: 'string?',
    };
    const validation = validate(body, schema);
    if (!validation.valid) {
      return { status: 400, data: { message: validation.message } };
    }
    const id = await notificationCenterService.createNotification(auth.session.userId, body || {});
    if (!id) {
      return { status: 400, data: { message: 'Invalid notification payload' } };
    }
    return { data: { id } };
  });

  router.register('PATCH', '/api/v1/notifications/:id/read', async ({ headers, pathParams }) => {
    const auth = await requireAuth(headers);
    if (auth.error) return auth.error;
    const updated = await notificationCenterService.markRead(auth.session.userId, pathParams.id);
    if (!updated) {
      return { status: 404, data: { message: 'Not found' } };
    }
    const result = await notificationCenterService.listNotifications(auth.session.userId, { limit: 20 });
    return {
      data: {
        items: result.items,
        next_cursor: result.nextCursor,
        unread_count: result.unreadCount,
        changed_ids: [updated],
      },
    };
  });

  router.register('PATCH', '/api/v1/notifications/read', async ({ headers }) => {
    const auth = await requireAuth(headers);
    if (auth.error) return auth.error;
    const changed = await notificationCenterService.markAllRead(auth.session.userId);
    const result = await notificationCenterService.listNotifications(auth.session.userId, { limit: 20 });
    return {
      data: {
        items: result.items,
        next_cursor: result.nextCursor,
        unread_count: result.unreadCount,
        changed_ids: changed,
      },
    };
  });

  router.register('DELETE', '/api/v1/notifications/:id', async ({ headers, pathParams }) => {
    const auth = await requireAuth(headers);
    if (auth.error) return auth.error;
    const deleted = await notificationCenterService.softDelete(auth.session.userId, pathParams.id);
    if (!deleted) {
      return { status: 404, data: { message: 'Not found' } };
    }
    const result = await notificationCenterService.listNotifications(auth.session.userId, { limit: 20 });
    return {
      data: {
        items: result.items,
        next_cursor: result.nextCursor,
        unread_count: result.unreadCount,
        changed_ids: [deleted],
      },
    };
  });
}

module.exports = registerNotificationRoutes;
