'use strict';

const { createIdentityModule } = require('./identity');
const { createDriversModule } = require('./drivers');
const { createRidesModule } = require('./rides');
const { createPaymentsModule } = require('./payments');
const { createAnalyticsModule } = require('./analytics');

function bootstrapModules() {
  const modules = [
    createIdentityModule(),
    createDriversModule(),
    createRidesModule(),
    createPaymentsModule(),
    createAnalyticsModule(),
  ];

  return {
    modules,
    byName: Object.fromEntries(modules.map(m => [m.name, m])),
  };
}

module.exports = {
  bootstrapModules,
};
