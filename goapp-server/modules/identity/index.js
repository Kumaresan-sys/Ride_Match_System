'use strict';

const identityService = require('../../services/identity-service');
const profileService = require('../../services/profile-service');

function createIdentityModule() {
  return {
    name: 'identity',
    services: {
      identityService,
      profileService,
    },
  };
}

module.exports = {
  createIdentityModule,
};
