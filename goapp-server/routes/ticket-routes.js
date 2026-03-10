'use strict';

const { requireOwnedResource } = require('../middleware/authz-middleware');
const { validateSchema, validationError } = require('./validation');
const {
  forbiddenError,
  notFoundError,
  buildErrorFromResult,
  normalizeRouteError,
  getAuthenticatedSession,
} = require('./response');

function registerTicketRoutes(router, ctx) {
  const { requireAuth, requireAdmin, services } = ctx;
  const ticketService = services.ticketService;

  router.register('POST', '/api/v1/tickets', async ({ body, headers }) => {
    const auth = await getAuthenticatedSession(requireAuth, headers);
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
    if (!parsed.ok) return validationError(parsed.error);

    if (parsed.data.userId !== auth.session.userId) {
      return forbiddenError('Forbidden: userId must match authenticated user.', 'FORBIDDEN_USER_MISMATCH');
    }

    const result = ticketService.createTicket(parsed.data);
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 400,
        defaultCode: 'TICKET_CREATE_FAILED',
        defaultMessage: 'Unable to create ticket.',
      });
    }
    return { status: 201, data: result };
  });

  router.register('GET', '/api/v1/tickets/:ticketId', async ({ pathParams, headers }) => {
    const auth = await getAuthenticatedSession(requireAuth, headers);
    if (auth.error) return auth.error;

    const ticket = ticketService.getTicket(pathParams.ticketId);
    if (!ticket) return notFoundError('Ticket not found', 'TICKET_NOT_FOUND');

    const owner = await requireOwnedResource({
      headers,
      resourceUserId: ticket.userId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot access another user ticket.',
    });
    if (owner.error) return normalizeRouteError(owner.error);

    return { data: ticket };
  });

  router.register('POST', '/api/v1/tickets/:ticketId/messages', async ({ pathParams, body, headers }) => {
    const auth = await getAuthenticatedSession(requireAuth, headers);
    if (auth.error) return auth.error;

    const ticket = ticketService.getTicket(pathParams.ticketId);
    if (!ticket) return notFoundError('Ticket not found', 'TICKET_NOT_FOUND');

    const owner = await requireOwnedResource({
      headers,
      resourceUserId: ticket.userId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot update another user ticket.',
    });
    if (owner.error) return normalizeRouteError(owner.error);

    const parsed = validateSchema(body, [
      { key: 'senderId', type: 'string', required: true },
      { key: 'senderRole', type: 'string', required: false, enum: ['user', 'agent', 'system'] },
      { key: 'senderType', type: 'string', required: false, enum: ['rider', 'driver', 'agent', 'system'] },
      { key: 'content', type: 'string', required: true, minLength: 1, maxLength: 5000 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    const isAdmin = headers?.['x-admin-token'] && !requireAdmin(headers);
    if (!isAdmin && parsed.data.senderId !== auth.session.userId) {
      return forbiddenError('Forbidden: senderId must match authenticated user.', 'FORBIDDEN_SENDER_MISMATCH');
    }

    const result = ticketService.addMessage(pathParams.ticketId, {
      senderId: parsed.data.senderId,
      senderRole: isAdmin ? (parsed.data.senderRole || 'agent') : 'user',
      senderType: parsed.data.senderType || (isAdmin ? 'agent' : ticket.userType),
      content: parsed.data.content,
      attachments: Array.isArray(body?.attachments) ? body.attachments : [],
    });

    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 400,
        defaultCode: 'TICKET_MESSAGE_ADD_FAILED',
        defaultMessage: 'Unable to add ticket message.',
      });
    }
    return { status: 200, data: result };
  });

  router.register('PUT', '/api/v1/tickets/:ticketId/read', async ({ pathParams, body, headers }) => {
    const auth = await getAuthenticatedSession(requireAuth, headers);
    if (auth.error) return auth.error;

    const ticket = ticketService.getTicket(pathParams.ticketId);
    if (!ticket) return notFoundError('Ticket not found', 'TICKET_NOT_FOUND');

    const owner = await requireOwnedResource({
      headers,
      resourceUserId: ticket.userId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot access another user ticket.',
    });
    if (owner.error) return normalizeRouteError(owner.error);

    const readBy = String(body?.readBy || '').trim() || auth.session.userId;
    const result = ticketService.markMessagesRead(pathParams.ticketId, readBy);
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 404,
        defaultCode: 'TICKET_NOT_FOUND',
        defaultMessage: 'Ticket not found.',
      });
    }
    return { status: 200, data: result };
  });

  router.register('GET', '/api/v1/users/:userId/tickets', async ({ pathParams, params, headers }) => {
    const owner = await requireOwnedResource({
      headers,
      resourceUserId: pathParams.userId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot access another user ticket list.',
    });
    if (owner.error) return normalizeRouteError(owner.error);

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
