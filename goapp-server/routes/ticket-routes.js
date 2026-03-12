'use strict';

const { validateSchema, validationError, parseQueryNumber } = require('./validation');
const {
  buildErrorFromResult,
  getAuthenticatedSession,
} = require('./response');

function parseJsonObject(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function registerTicketRoutes(router, ctx) {
  const { requireAuth, services } = ctx;
  const ticketService = services.ticketService;

  router.register('GET', '/api/v1/support/sections', async () => ({
    data: ticketService.getSupportSections(),
  }));

  router.register('GET', '/api/v1/support/past-ride-issues', async () => {
    const result = await ticketService.listPastRideIssueCatalog({ activeOnly: true });
    return { data: result };
  });

  router.register('POST', '/api/v1/tickets', async ({ body, headers, files, ip }) => {
    const auth = await getAuthenticatedSession(requireAuth, headers);
    if (auth.error) return auth.error;

    const parsed = validateSchema(body, [
      { key: 'category', type: 'string', required: true, maxLength: 64 },
      { key: 'subject', type: 'string', required: true, minLength: 3, maxLength: 300 },
      { key: 'message', type: 'string', required: true, minLength: 2, maxLength: 5000 },
      { key: 'rideId', type: 'string', required: false, maxLength: 255 },
      { key: 'priority', type: 'string', required: false, enum: ['low', 'normal', 'high', 'urgent'] },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    const result = await ticketService.createTicket({
      userId: auth.session.userId,
      userType: 'rider',
      category: parsed.data.category,
      subject: parsed.data.subject,
      message: parsed.data.message,
      rideId: parsed.data.rideId || null,
      priority: parsed.data.priority || 'normal',
      metadata: parseJsonObject(body?.metadata),
      files: Array.isArray(files)
          ? files.filter((file) => ['attachment', 'attachments', 'file'].includes(file.fieldName))
          : [],
      idempotencyKey: String(headers?.['idempotency-key'] || headers?.['x-idempotency-key'] || '').trim() || null,
      requestId: headers?.['x-request-id'] || null,
      ip,
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'SUPPORT_TICKET_CREATE_FAILED',
        defaultMessage: 'Unable to create support ticket.',
      });
    }
    return { status: 201, data: result };
  });

  router.register('GET', '/api/v1/tickets', async ({ params, headers }) => {
    const auth = await getAuthenticatedSession(requireAuth, headers);
    if (auth.error) return auth.error;

    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 100, fallback: 20 });
    if (!limitParsed.ok) return validationError(limitParsed.error);

    const result = await ticketService.listUserTickets(auth.session.userId, {
      status: params.get('status') || null,
      search: params.get('search') || null,
      limit: limitParsed.value,
      cursor: params.get('cursor') || null,
    });
    return { data: result };
  });

  router.register('GET', '/api/v1/tickets/:ticketId', async ({ pathParams, headers }) => {
    const auth = await getAuthenticatedSession(requireAuth, headers);
    if (auth.error) return auth.error;

    const result = await ticketService.getTicket(pathParams.ticketId, auth.session.userId);
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 404,
        defaultCode: 'SUPPORT_TICKET_NOT_FOUND',
        defaultMessage: 'Support ticket not found.',
      });
    }
    return { data: result };
  });

  router.register('GET', '/api/v1/tickets/:ticketId/messages', async ({ pathParams, params, headers }) => {
    const auth = await getAuthenticatedSession(requireAuth, headers);
    if (auth.error) return auth.error;

    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 100, fallback: 20 });
    if (!limitParsed.ok) return validationError(limitParsed.error);

    const result = await ticketService.listMessages(pathParams.ticketId, auth.session.userId, {
      limit: limitParsed.value,
      cursor: params.get('cursor') || null,
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 404,
        defaultCode: 'SUPPORT_MESSAGES_FETCH_FAILED',
        defaultMessage: 'Unable to load support ticket messages.',
      });
    }
    return { data: result };
  });

  router.register('POST', '/api/v1/tickets/:ticketId/messages', async ({ pathParams, body, headers }) => {
    const auth = await getAuthenticatedSession(requireAuth, headers);
    if (auth.error) return auth.error;

    const parsed = validateSchema(body, [
      { key: 'content', type: 'string', required: true, minLength: 1, maxLength: 5000 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    const result = await ticketService.addMessage(pathParams.ticketId, {
      actorId: auth.session.userId,
      content: parsed.data.content,
      idempotencyKey: String(headers?.['idempotency-key'] || headers?.['x-idempotency-key'] || '').trim() || null,
      requestId: headers?.['x-request-id'] || null,
      isAdmin: false,
      visibility: 'public',
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'SUPPORT_MESSAGE_ADD_FAILED',
        defaultMessage: 'Unable to add support ticket message.',
      });
    }
    return { status: 201, data: result };
  });

  router.register('PUT', '/api/v1/tickets/:ticketId/read', async ({ pathParams, body, headers }) => {
    const auth = await getAuthenticatedSession(requireAuth, headers);
    if (auth.error) return auth.error;

    const result = await ticketService.markRead(pathParams.ticketId, auth.session.userId, {
      upToMessageId: body?.upToMessageId || body?.lastReadMessageId || null,
      isAdmin: false,
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'SUPPORT_READ_FAILED',
        defaultMessage: 'Unable to update support ticket read state.',
      });
    }
    return { data: result };
  });

  router.register('GET', '/api/v1/tickets/:ticketId/attachments/:attachmentId', async ({ pathParams, headers }) => {
    const auth = await getAuthenticatedSession(requireAuth, headers);
    if (auth.error) return auth.error;

    const result = await ticketService.getAttachmentFile(
      pathParams.ticketId,
      pathParams.attachmentId,
      auth.session.userId,
      { isAdmin: false },
    );
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 404,
        defaultCode: 'SUPPORT_ATTACHMENT_NOT_FOUND',
        defaultMessage: 'Support attachment not found.',
      });
    }
    return {
      raw: true,
      contentType: result.contentType,
      filename: result.filename,
      buffer: result.buffer,
    };
  });

  router.register('GET', '/api/v1/users/:userId/tickets', async ({ pathParams, params, headers }) => {
    const auth = await getAuthenticatedSession(requireAuth, headers);
    if (auth.error) return auth.error;
    if (String(auth.session.userId) !== String(pathParams.userId)) {
      return buildErrorFromResult(
        { code: 'SUPPORT_TICKET_FORBIDDEN', error: 'Forbidden support ticket access.' },
        { status: 403, defaultCode: 'SUPPORT_TICKET_FORBIDDEN' },
      );
    }
    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 100, fallback: 20 });
    if (!limitParsed.ok) return validationError(limitParsed.error);
    const result = await ticketService.listUserTickets(auth.session.userId, {
      status: params.get('status') || null,
      search: params.get('search') || null,
      limit: limitParsed.value,
      cursor: params.get('cursor') || null,
    });
    return { data: result };
  });
}

module.exports = registerTicketRoutes;
