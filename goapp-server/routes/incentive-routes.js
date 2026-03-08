'use strict';

const { parseQueryNumber, parsePathParams, validationError, forbiddenError } = require('./validation');

function registerIncentiveRoutes(router, ctx) {
  const { requireAuth, requireAdmin, services } = ctx;
  const { incentiveService, driverWalletService, walletService } = services;

  router.register('GET', '/api/v1/incentives', async ({ params }) => {
    const activeOnly = params.get('activeOnly') === 'true';
    const type = params.get('type') || null;
    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 200, fallback: 50 });
    if (!limitParsed.ok) return validationError(limitParsed.error);
    return { data: { tasks: incentiveService.listTasks({ activeOnly, type, limit: limitParsed.value }) } };
  });

  router.register('GET', '/api/v1/incentives/:taskId', async ({ pathParams }) => {
    const pathValidation = parsePathParams(pathParams, [{ key: 'taskId', type: 'string', required: true, minLength: 2 }]);
    if (!pathValidation.ok) return validationError(pathValidation.error);
    const task = incentiveService.getTask(pathValidation.data.taskId);
    return { data: task || { error: 'Task not found', code: 'NOT_FOUND' } };
  });

  router.register('POST', '/api/v1/incentives/:taskId/enrol', async ({ pathParams, body, headers }) => {
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;
    const driverId = String(body?.driverId || '').trim();
    if (!driverId) return validationError('driverId required');
    if (driverId !== auth.session.userId) {
      return forbiddenError('Forbidden: driverId must match authenticated user.');
    }
    const pathValidation = parsePathParams(pathParams, [{ key: 'taskId', type: 'string', required: true, minLength: 2 }]);
    if (!pathValidation.ok) return validationError(pathValidation.error);
    const result = incentiveService.enrolDriver(driverId, pathValidation.data.taskId);
    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('POST', '/api/v1/incentives/:taskId/claim', async ({ pathParams, body, headers }) => {
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;
    const driverId = String(body?.driverId || '').trim();
    if (!driverId) return validationError('driverId required');
    if (driverId !== auth.session.userId) {
      return forbiddenError('Forbidden: driverId must match authenticated user.');
    }
    const pathValidation = parsePathParams(pathParams, [{ key: 'taskId', type: 'string', required: true, minLength: 2 }]);
    if (!pathValidation.ok) return validationError(pathValidation.error);

    const result = incentiveService.claimReward(driverId, pathValidation.data.taskId);
    if (!result.success) return { status: 400, data: result };

    let walletResult = null;
    if (result.rewardType === 'cash' && result.rewardAmount > 0) {
      walletResult = driverWalletService.creditIncentive(driverId, result.rewardAmount, pathValidation.data.taskId, result.task.title);
    } else if (result.rewardType === 'coins' && result.rewardCoins > 0) {
      walletResult = walletService.adjustCoins(driverId, result.rewardCoins, `Incentive: ${result.task.title}`);
    }

    return { data: { ...result, walletCredit: walletResult } };
  });

  router.register('GET', '/api/v1/drivers/:driverId/incentives', async ({ pathParams, headers }) => {
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;
    if (pathParams.driverId !== auth.session.userId) {
      return forbiddenError('Forbidden: driverId must match authenticated user.');
    }
    return { data: { progress: incentiveService.getDriverProgress(pathParams.driverId) } };
  });

  router.register('GET', '/api/v1/incentives/:taskId/leaderboard', async ({ pathParams, params }) => {
    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 100, fallback: 20 });
    if (!limitParsed.ok) return validationError(limitParsed.error);
    return { data: { leaderboard: incentiveService.getTaskLeaderboard(pathParams.taskId, limitParsed.value) } };
  });

  router.register('POST', '/api/v1/admin/incentives', async ({ body, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const result = incentiveService.createTask({ ...body, createdBy: 'admin' });
    return { status: result.success ? 201 : 400, data: result };
  });

  router.register('GET', '/api/v1/admin/incentives', async ({ params, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 500, fallback: 50 });
    if (!limitParsed.ok) return validationError(limitParsed.error);
    return { data: { tasks: incentiveService.listTasks({ limit: limitParsed.value }) } };
  });

  router.register('PUT', '/api/v1/admin/incentives/:taskId', async ({ pathParams, body, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const result = incentiveService.updateTask(pathParams.taskId, body || {});
    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('DELETE', '/api/v1/admin/incentives/:taskId', async ({ pathParams, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const result = incentiveService.deleteTask(pathParams.taskId);
    return { status: result.success ? 200 : 404, data: result };
  });

  router.register('GET', '/api/v1/admin/incentives/stats', async ({ headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    return { data: incentiveService.getStats() };
  });

  router.register('GET', '/api/v1/admin/incentives/:taskId/leaderboard', async ({ pathParams, params, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 500, fallback: 20 });
    if (!limitParsed.ok) return validationError(limitParsed.error);
    return { data: { leaderboard: incentiveService.getTaskLeaderboard(pathParams.taskId, limitParsed.value) } };
  });
}

module.exports = registerIncentiveRoutes;
