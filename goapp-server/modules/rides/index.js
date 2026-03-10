'use strict';

const rideService = require('../../services/ride-service');
const matchingEngine = require('../../services/matching-engine');

function createRidesModule() {
  return {
    name: 'rides',
    services: {
      rideService,
      matchingEngine,
    },
  };
}

module.exports = {
  createRidesModule,
};
