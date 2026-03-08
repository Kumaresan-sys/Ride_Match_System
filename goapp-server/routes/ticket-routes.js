'use strict';

const { requireOwnedResource } = require('../middleware/authz-middleware');
const { validateSchema } = require('./validation');

function registerTicketRoutes(router, ctx) {
  const { requireAuth, requireAdmin, services } = ctx;
  const ticketService = services.ticketService;

  router.register('POST', '/api/v1/tickets', async ({ body, headers }) => {
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;

    const parsed = validateSchema(body, [
      { key: 'userId', type: 'string', required: true },
      { key: 'userType', type: 'string', required: true, enum: ['rider', 'driver'] },
      { key: 'subject', type: 'string', required: true, minLength: 3, maxLength: 200 },
      { key: 'message', type: 'string', required: true, minLength: 2, maxLength: 5000 },
      { key: 'category', type: 'string', required: false },
      { key: 'rideId', type: 'string', required: false },
      { key: 'priority', type: 'string', required: false, enum: ['low', 'normal', 'high', 'urgent'] },
    ]);
    if (!parsed.ok) return { status: 400, data: { error: parsed.error } };

    if (parsed.data.userId !== auth.session.userId) {
      return { status: 403, data: { error: 'Forbidden: userId must match authenticated user.' } };
    }

    const result = ticketService.createTicket(parsed.data);
    return { status: result.success ? 201 : 400, data: result };
  });

  router.register('GET', '/api/v1/tickets/:ticketId', async ({ pathParams, headers }) => {
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;

    const ticket = ticketService.getTicket(pathParams.ticketId);
    if (!ticket) return { status: 404, data: { error: 'Ticket not found' } };

    const owner = await requireOwnedResource({
      headers,
      resourceUserId: ticket.userId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot access another user ticket.',
    });
    if (owner.error) return owner.error;

    return { data: ticket };
  });

  router.register('POST', '/api/v1/tickets/:ticketId/messages', async ({ pathParams, body, headers }) => {
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;

    const ticket = ticketService.getTicket(pathParams.ticketId);
    if (!ticket) return { status: 404, data: { error: 'Ticket not found' } };

    const owner = await requireOwnedResource({
      headers,
      resourceUserId: ticket.userId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot update another user ticket.',
    });
    if (owner.error) return owner.error;

    const parsed = validateSchema(body, [
      { key: 'senderId', type: 'string', required: true },
      { key: 'senderRole', type: 'string', required: false, enum: ['user', 'agent', 'system'] },
      { key: 'senderType', type: 'string', required: false, enum: ['rider', 'driver', 'agent', 'system'] },
      { key: 'content', type: 'string', required: true, minLength: 1, maxLength: 5000 },
    ]);
    if (!parsed.ok) return { status: 400, data: { error: parsed.error } };

    const isAdmin = headers?.['x-admin-token'] && !requireAdmin(headers);
    if (!isAdmin && parsed.data.senderId !== auth.session.userId) {
      return { status: 403, data: { error: 'Forbidden: senderId must match authenticated user.' } };
    }

    const result = ticketService.addMessage(pathParams.ticketId, {
      senderId: parsed.data.senderId,
      senderRole: isAdmin ? (parsed.data.senderRole || 'agent') : 'user',
      senderType: parsed.data.senderType || (isAdmin ? 'agent' : ticket.userType),
      content: parsed.data.content,
      attachments: Array.isArray(body?.attachments) ? body.attachments : [],
    });

    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('PUT', '/api/v1/tickets/:ticketId/read', async ({ pathParams, body, headers }) => {
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;

    const ticket = ticketService.getTicket(pathParams.ticketId);
    if (!ticket) return { status: 404, data: { error: 'Ticket not found' } };

    const owner = await requireOwnedResource({
      headers,
      resourceUserId: ticket.userId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot access another user ticket.',
    });
    if (owner.error) return owner.error;

    const readBy = String(body?.readBy || '').trim() || auth.session.userId;
    const result = ticketService.markMessagesRead(pathParams.ticketId, readBy);
    return { status: result.success ? 200 : 404, data: result };
  });

  router.register('GET', '/api/v1/users/:userId/tickets', async ({ pathParams, params, headers }) => {
    const owner = await requireOwnedResource({
      headers,
      resourceUserId: pathParams.userId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot access another user ticket list.',
    });
    if (owner.error) return owner.error;

    const limit = Number.parseInt(params.get('limit') || '20', 10);
    const status = params.get('status') || null;
    return {
      data: {
        tickets: ticketService.getUserTickets(pathParams.userId, {
          limit: Math.min(Math.max(limit, 1), 100),
          status,
        }),
      },
    };
  });
}

module.exports = registerTicketRoutes;
