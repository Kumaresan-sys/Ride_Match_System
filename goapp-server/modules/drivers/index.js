'use strict';

const locationService = require('../../services/location-service');
const driverWalletService = require('../../services/driver-wallet-service');

function createDriversModule() {
  return {
    name: 'drivers',
    services: {
      locationService,
      driverWalletService,
    },
  };
}

module.exports = {
  createDriversModule,
};
