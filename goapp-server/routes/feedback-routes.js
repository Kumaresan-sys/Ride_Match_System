// GoApp Feedback Routes
// Mutual post-trip ratings: rider → driver and driver → rider

function registerFeedbackRoutes(router, ctx) {
  const { services } = ctx;
  const feedbackService = services.feedbackService;

  // ─── Rider rates Driver ───
  router.register('POST', '/api/v1/rides/:rideId/feedback/rider', async ({ pathParams, body }) => {
    const { rideId } = pathParams;
    const { raterId, rating, comment } = body;

    if (!raterId) return { status: 400, data: { error: 'raterId is required' } };
    if (rating === undefined || rating === null) return { status: 400, data: { error: 'rating is required' } };

    const result = feedbackService.submitRiderFeedback(rideId, raterId, rating, comment || '');
    if (!result.success) return { status: result.status || 400, data: { error: result.error } };
    return { data: result };
  });

  // ─── Driver rates Rider ───
  router.register('POST', '/api/v1/rides/:rideId/feedback/driver', async ({ pathParams, body }) => {
    const { rideId } = pathParams;
    const { raterId, rating, comment } = body;

    if (!raterId) return { status: 400, data: { error: 'raterId is required' } };
    if (rating === undefined || rating === null) return { status: 400, data: { error: 'rating is required' } };

    const result = feedbackService.submitDriverFeedback(rideId, raterId, rating, comment || '');
    if (!result.success) return { status: result.status || 400, data: { error: result.error } };
    return { data: result };
  });

  // ─── Get feedback for a specific ride ───
  router.register('GET', '/api/v1/rides/:rideId/feedback', async ({ pathParams }) => {
    const result = feedbackService.getFeedbackForRide(pathParams.rideId);
    return { data: result };
  });

  // ─── Get all feedback received by a driver ───
  router.register('GET', '/api/v1/drivers/:driverId/feedback', async ({ pathParams, params }) => {
    const limit = params && params.limit ? parseInt(params.limit, 10) : 50;
    const result = feedbackService.getDriverFeedbacks(pathParams.driverId, limit);
    return { data: result };
  });

  // ─── Get all feedback received by a rider ───
  router.register('GET', '/api/v1/riders/:riderId/feedback', async ({ pathParams, params }) => {
    const limit = params && params.limit ? parseInt(params.limit, 10) : 50;
    const result = feedbackService.getRiderFeedbacks(pathParams.riderId, limit);
    return { data: result };
  });
}

module.exports = registerFeedbackRoutes;
