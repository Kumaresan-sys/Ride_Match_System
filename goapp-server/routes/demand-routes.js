'use strict';

const { parseQueryNumber, validationError } = require('./validation');

function registerDemandRoutes(router, ctx) {
  const { requireAdmin, services } = ctx;
  const { demandLogService, demandAggregationService } = services;

  router.register('GET', '/api/v1/demand/heatmap', async () => {
    const areas = demandLogService.getDemandMap();
    const hotAreas = areas.filter(a => a.demandLevel === 'HIGH' || a.demandLevel === 'SURGE');
    return {
      data: {
        snapshot: new Date().toISOString(),
        totalAreas: areas.length,
        hotAreas: hotAreas.length,
        areas,
      },
    };
  });

  router.register('GET', '/api/v1/demand/areas/hot', async ({ params }) => {
    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 50, fallback: 10 });
    if (!limitParsed.ok) return validationError(limitParsed.error);
    return { data: { hotAreas: demandLogService.getHotAreas(limitParsed.value) } };
  });

  router.register('GET', '/api/v1/demand/timeline', async ({ params }) => {
    const hoursParsed = parseQueryNumber(params, 'hours', { min: 1, max: 72, fallback: 6 });
    if (!hoursParsed.ok) return validationError(hoursParsed.error);
    return { data: demandLogService.getTimeline(hoursParsed.value) };
  });

  router.register('GET', '/api/v1/demand/stats', async () => {
    const stats = demandLogService.getStats();
    const current = demandLogService.getCurrentBucket();
    const hot = demandLogService.getHotAreas(5);
    return {
      data: {
        ...stats,
        currentBucket: current,
        topHotAreas: hot,
        poolStats: demandAggregationService.getStats(),
      },
    };
  });

  router.register('GET', '/api/v1/admin/demand/logs', async ({ params, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const type = params.get('type') || null;
    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 500, fallback: 100 });
    if (!limitParsed.ok) return validationError(limitParsed.error);
    const since = params.get('since') || null;
    const poolId = params.get('poolId') || null;
    const areaKey = params.get('areaKey') || null;
    const logs = demandLogService.getScenarioLogs({ type, limit: limitParsed.value, since, poolId, areaKey });
    return { data: { count: logs.length, logs } };
  });

  router.register('GET', '/api/v1/admin/demand/logs/summary', async ({ headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    return { data: demandLogService.getLogSummary() };
  });

  router.register('GET', '/api/v1/admin/demand/areas', async ({ headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    return { data: { areas: demandLogService.getDemandMap() } };
  });

  router.register('GET', '/api/v1/admin/demand/peak-hours', async ({ params, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 100, fallback: 20 });
    if (!limitParsed.ok) return validationError(limitParsed.error);
    return { data: { peakHours: demandLogService.getPeakHours(limitParsed.value) } };
  });

  router.register('GET', '/api/v1/admin/demand/no-match-analysis', async ({ headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    return { data: demandLogService.getNoMatchAnalysis() };
  });

  router.register('POST', '/api/v1/admin/demand/snapshot', async ({ headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    demandLogService._takeDemandSnapshot();
    return { data: { success: true, message: 'Demand snapshot taken.', stats: demandLogService.getStats() } };
  });

  router.register('GET', '/api/v1/admin/demand/timeline', async ({ params, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const hoursParsed = parseQueryNumber(params, 'hours', { min: 1, max: 168, fallback: 24 });
    if (!hoursParsed.ok) return validationError(hoursParsed.error);
    return { data: demandLogService.getTimeline(hoursParsed.value) };
  });

  router.register('GET', '/api/v1/admin/demand/daily-summary', async ({ headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    return { data: demandLogService.getDailySummary() };
  });
}

module.exports = registerDemandRoutes;
