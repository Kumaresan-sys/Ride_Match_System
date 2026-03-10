'use strict';

const zoneMetricsService = require('../../services/zone-metrics-service');
const demandLogService = require('../../services/demand-log-service');

function createAnalyticsModule() {
  return {
    name: 'analytics',
    services: {
      zoneMetricsService,
      demandLogService,
    },
  };
}

module.exports = {
  createAnalyticsModule,
};
