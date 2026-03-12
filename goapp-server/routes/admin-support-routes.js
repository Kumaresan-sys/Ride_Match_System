'use strict';

const { parseQueryNumber, validateSchema, validationError } = require('./validation');
const { buildErrorFromResult } = require('./response');

function registerAdminSupportRoutes(router, ctx) {
  const { requireAdmin, services } = ctx;
  const { ticketService, rideSessionService } = services;

  function ensureAdmin(headers) {
    return requireAdmin(headers || {});
  }

  router.register('GET', '/api/v1/admin/tickets', async ({ params, headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 200, fallback: 50 });
    if (!limitParsed.ok) return validationError(limitParsed.error);
    return {
      data: await ticketService.adminListTickets({
        status: params.get('status') || null,
        category: params.get('category') || null,
        priority: params.get('priority') || null,
        agentId: params.get('agentId') || null,
        limit: limitParsed.value,
      }),
    };
  });

  router.register('GET', '/api/v1/admin/tickets/:ticketId', async ({ pathParams, headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    const result = await ticketService.getTicket(pathParams.ticketId, 'admin', { isAdmin: true });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 404,
        defaultCode: 'SUPPORT_TICKET_NOT_FOUND',
        defaultMessage: 'Support ticket not found.',
      });
    }
    return { data: result };
  });

  router.register('GET', '/api/v1/admin/tickets/:ticketId/messages', async ({ pathParams, params, headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 100, fallback: 20 });
    if (!limitParsed.ok) return validationError(limitParsed.error);
    const result = await ticketService.listMessages(pathParams.ticketId, 'admin', {
      isAdmin: true,
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

  router.register('POST', '/api/v1/admin/tickets/:ticketId/messages', async ({ pathParams, body, headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    const parsed = validateSchema(body, [
      { key: 'content', type: 'string', required: true, minLength: 1, maxLength: 5000 },
      { key: 'visibility', type: 'string', required: false, enum: ['public', 'internal'] },
    ]);
    if (!parsed.ok) return validationError(parsed.error);
    const result = await ticketService.addMessage(pathParams.ticketId, {
      actorId: 'admin',
      content: parsed.data.content,
      isAdmin: true,
      visibility: parsed.data.visibility || 'public',
      requestUserReply: body?.requestUserReply === true,
      requestId: headers?.['x-request-id'] || null,
      idempotencyKey: String(headers?.['idempotency-key'] || headers?.['x-idempotency-key'] || '').trim() || null,
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

  router.register('PUT', '/api/v1/admin/tickets/:ticketId/status', async ({ pathParams, body, headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    const result = await ticketService.adminUpdateStatus(pathParams.ticketId, {
      status: body?.status,
      resolution: body?.resolution || null,
      reason: body?.reason || null,
      actorId: 'admin',
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'SUPPORT_STATUS_UPDATE_FAILED',
        defaultMessage: 'Unable to update support ticket status.',
      });
    }
    return { data: result };
  });

  router.register('PUT', '/api/v1/admin/tickets/:ticketId/assign', async ({ pathParams, body, headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    const result = await ticketService.adminAssignTicket(pathParams.ticketId, {
      agentId: body?.agentId || null,
      actorId: 'admin',
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'SUPPORT_ASSIGN_FAILED',
        defaultMessage: 'Unable to update support ticket assignment.',
      });
    }
    return { data: result };
  });

  router.register('GET', '/api/v1/admin/tickets/stats', async ({ headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    return { data: await ticketService.getStats() };
  });

  router.register('GET', '/api/v1/admin/support/past-ride-issues', async ({ headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    return { data: await ticketService.listPastRideIssueCatalog({ activeOnly: false }) };
  });

  router.register('POST', '/api/v1/admin/support/past-ride-issues/groups', async ({ body, headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    const parsed = validateSchema(body, [
      { key: 'title', type: 'string', required: true, minLength: 2, maxLength: 200 },
      { key: 'description', type: 'string', required: false, maxLength: 2000 },
      { key: 'backendCategory', type: 'string', required: true, maxLength: 64 },
      { key: 'sortOrder', type: 'number', required: false, min: 0, max: 100000 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);
    const result = await ticketService.adminCreatePastRideIssueGroup({
      ...parsed.data,
      showDriverDetails: body?.showDriverDetails === true,
      isActive: body?.isActive !== false,
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'SUPPORT_TRIP_ISSUE_GROUP_CREATE_FAILED',
        defaultMessage: 'Unable to create past ride issue group.',
      });
    }
    return { status: 201, data: result };
  });

  router.register('PUT', '/api/v1/admin/support/past-ride-issues/groups/:groupId', async ({ pathParams, body, headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    const parsed = validateSchema(body, [
      { key: 'title', type: 'string', required: false, minLength: 2, maxLength: 200 },
      { key: 'description', type: 'string', required: false, maxLength: 2000 },
      { key: 'backendCategory', type: 'string', required: false, maxLength: 64 },
      { key: 'sortOrder', type: 'number', required: false, min: 0, max: 100000 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);
    const result = await ticketService.adminUpdatePastRideIssueGroup(pathParams.groupId, {
      ...parsed.data,
      ...(Object.prototype.hasOwnProperty.call(body || {}, 'showDriverDetails')
        ? { showDriverDetails: body.showDriverDetails === true }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body || {}, 'isActive')
        ? { isActive: body.isActive === true }
        : {}),
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'SUPPORT_TRIP_ISSUE_GROUP_UPDATE_FAILED',
        defaultMessage: 'Unable to update past ride issue group.',
      });
    }
    return { data: result };
  });

  router.register('DELETE', '/api/v1/admin/support/past-ride-issues/groups/:groupId', async ({ pathParams, headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    const result = await ticketService.adminDeletePastRideIssueGroup(pathParams.groupId);
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'SUPPORT_TRIP_ISSUE_GROUP_DELETE_FAILED',
        defaultMessage: 'Unable to delete past ride issue group.',
      });
    }
    return { data: result };
  });

  router.register('POST', '/api/v1/admin/support/past-ride-issues/groups/:groupId/sub-issues', async ({ pathParams, body, headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    const parsed = validateSchema(body, [
      { key: 'title', type: 'string', required: true, minLength: 2, maxLength: 240 },
      { key: 'description', type: 'string', required: false, maxLength: 2000 },
      { key: 'sortOrder', type: 'number', required: false, min: 0, max: 100000 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);
    const result = await ticketService.adminCreatePastRideSubIssue(pathParams.groupId, {
      ...parsed.data,
      isActive: body?.isActive !== false,
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'SUPPORT_TRIP_SUB_ISSUE_CREATE_FAILED',
        defaultMessage: 'Unable to create past ride sub-issue.',
      });
    }
    return { status: 201, data: result };
  });

  router.register('PUT', '/api/v1/admin/support/past-ride-issues/sub-issues/:subIssueId', async ({ pathParams, body, headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    const parsed = validateSchema(body, [
      { key: 'groupId', type: 'string', required: false, maxLength: 64 },
      { key: 'title', type: 'string', required: false, minLength: 2, maxLength: 240 },
      { key: 'description', type: 'string', required: false, maxLength: 2000 },
      { key: 'sortOrder', type: 'number', required: false, min: 0, max: 100000 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);
    const result = await ticketService.adminUpdatePastRideSubIssue(pathParams.subIssueId, {
      ...parsed.data,
      ...(Object.prototype.hasOwnProperty.call(body || {}, 'isActive')
        ? { isActive: body.isActive === true }
        : {}),
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'SUPPORT_TRIP_SUB_ISSUE_UPDATE_FAILED',
        defaultMessage: 'Unable to update past ride sub-issue.',
      });
    }
    return { data: result };
  });

  router.register('DELETE', '/api/v1/admin/support/past-ride-issues/sub-issues/:subIssueId', async ({ pathParams, headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    const result = await ticketService.adminDeletePastRideSubIssue(pathParams.subIssueId);
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'SUPPORT_TRIP_SUB_ISSUE_DELETE_FAILED',
        defaultMessage: 'Unable to delete past ride sub-issue.',
      });
    }
    return { data: result };
  });

  router.register('GET', '/api/v1/admin/tickets/agents', async ({ headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    return { data: await ticketService.adminListAgents() };
  });

  router.register('POST', '/api/v1/admin/tickets/agents', async ({ body, headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    const parsed = validateSchema(body, [
      { key: 'userId', type: 'string', required: true, minLength: 8, maxLength: 64 },
      { key: 'displayName', type: 'string', required: true, minLength: 2, maxLength: 200 },
      { key: 'email', type: 'string', required: false, maxLength: 200 },
      { key: 'role', type: 'string', required: false, enum: ['support_agent', 'supervisor', 'admin'] },
    ]);
    if (!parsed.ok) return validationError(parsed.error);
    const result = await ticketService.adminAddAgent(parsed.data);
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'SUPPORT_AGENT_CREATE_FAILED',
        defaultMessage: 'Unable to create support agent.',
      });
    }
    return { status: 201, data: result };
  });

  router.register('GET', '/api/v1/admin/recovery-logs', async ({ params, headers }) => {
    const admin = ensureAdmin(headers);
    if (admin) return admin;
    const type = params.get('type') || null;
    const riderId = params.get('riderId') || null;
    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 500, fallback: 50 });
    if (!limitParsed.ok) return validationError(limitParsed.error);
    return { data: { logs: await rideSessionService.getRecoveryLogs({ type, riderId, limit: limitParsed.value }) } };
  });
}

module.exports = registerAdminSupportRoutes;
