'use strict';

const { buildError } = require('./response');

function registerPublicShareRoutes(router, ctx) {
  const tripShareService = ctx.services?.tripShareService || require('../services/trip-share-service');
  const rideService = ctx.services?.rideService || require('../services/ride-service');

  router.register('GET', '/api/v1/public/ride-share/:token', async ({ pathParams }) => {
    const result = await tripShareService.getPublicShareSnapshot(pathParams.token, {
      rideService,
      markViewed: true,
    });
    if (!result?.success) {
      return buildError(
        result?.status || 404,
        result?.message || 'Tracking link not found.',
        result?.errorCode || 'TRACKING_SHARE_NOT_FOUND',
      );
    }
    const { success: _ignored, ...snapshot } = result;
    return { status: 200, data: { success: true, data: snapshot } };
  });

  router.register('GET', '/ride-share/:token', async ({ pathParams }) => {
    return {
      status: 200,
      html: tripShareService.renderPublicSharePage(pathParams.token),
    };
  });
}

module.exports = registerPublicShareRoutes;
