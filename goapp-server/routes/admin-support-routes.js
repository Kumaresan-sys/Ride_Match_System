'use strict';

const { parseQueryNumber, validationError } = require('./validation');

function registerAdminSupportRoutes(router, ctx) {
  const { requireAdmin, services } = ctx;
  const { ticketService, rideSessionService } = services;

  router.register('GET', '/api/v1/admin/tickets', async ({ params, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const status = params.get('status') || null;
    const category = params.get('category') || null;
    const priority = params.get('priority') || null;
    const agentId = params.get('agentId') || null;
    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 500, fallback: 50 });
    if (!limitParsed.ok) return validationError(limitParsed.error);
    return { data: { tickets: ticketService.listTickets({ status, category, priority, agentId, limit: limitParsed.value }) } };
  });

  router.register('PUT', '/api/v1/admin/tickets/:ticketId/status', async ({ pathParams, body, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const result = ticketService.updateStatus(pathParams.ticketId, body || {});
    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('PUT', '/api/v1/admin/tickets/:ticketId/assign', async ({ pathParams, body, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const result = ticketService.assignAgent(pathParams.ticketId, body?.agentId);
    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('GET', '/api/v1/admin/tickets/stats', async ({ headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    return { data: ticketService.getStats() };
  });

  router.register('GET', '/api/v1/admin/tickets/agents', async ({ headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    return { data: { agents: ticketService.listAgents() } };
  });

  router.register('POST', '/api/v1/admin/tickets/agents', async ({ body, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const result = ticketService.addAgent(body || {});
    return { status: result.success ? 201 : 400, data: result };
  });

  router.register('GET', '/api/v1/admin/recovery-logs', async ({ params, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const type = params.get('type') || null;
    const riderId = params.get('riderId') || null;
    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 500, fallback: 50 });
    if (!limitParsed.ok) return validationError(limitParsed.error);
    return { data: { logs: await rideSessionService.getRecoveryLogs({ type, riderId, limit: limitParsed.value }) } };
  });
}

module.exports = registerAdminSupportRoutes;
