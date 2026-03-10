// GoApp Feedback Routes
// Mutual post-trip ratings: rider → driver and driver → rider

const {
  badRequest,
  forbiddenError,
  notFoundError,
  buildErrorFromResult,
  getAuthenticatedSession,
} = require('./response');

function registerFeedbackRoutes(router, ctx) {
  const { services, repositories, requireAuth, requireAdmin } = ctx;
  const feedbackService = services.feedbackService;

  async function authenticate(headers = {}) {
    return getAuthenticatedSession(requireAuth, headers);
  }

  function isAdmin(headers = {}) {
    if (!headers['x-admin-token']) return false;
    return !requireAdmin(headers);
  }

  // ─── Rider rates Driver ───
  router.register('POST', '/api/v1/rides/:rideId/feedback/rider', async ({ pathParams, body, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    const { rideId } = pathParams;
    const { raterId, rating, comment } = body;

    if (rating === undefined || rating === null) return badRequest('rating is required', 'VALIDATION_ERROR');
    if (raterId && raterId !== auth.session.userId) {
      return forbiddenError('Forbidden: raterId must match authenticated user.', 'FORBIDDEN_RATER_MISMATCH');
    }

    const result = feedbackService.submitRiderFeedback(rideId, auth.session.userId, rating, comment || '');
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'FEEDBACK_SUBMIT_FAILED',
        defaultMessage: 'Unable to submit rider feedback.',
      });
    }
    return { data: result };
  });

  // ─── Driver rates Rider ───
  router.register('POST', '/api/v1/rides/:rideId/feedback/driver', async ({ pathParams, body, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    const { rideId } = pathParams;
    const { raterId, rating, comment } = body;

    if (rating === undefined || rating === null) return badRequest('rating is required', 'VALIDATION_ERROR');
    if (raterId && raterId !== auth.session.userId) {
      return forbiddenError('Forbidden: raterId must match authenticated user.', 'FORBIDDEN_RATER_MISMATCH');
    }

    const result = feedbackService.submitDriverFeedback(rideId, auth.session.userId, rating, comment || '');
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'FEEDBACK_SUBMIT_FAILED',
        defaultMessage: 'Unable to submit driver feedback.',
      });
    }
    return { data: result };
  });

  // ─── Get feedback for a specific ride ───
  router.register('GET', '/api/v1/rides/:rideId/feedback', async ({ pathParams, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    const ride = await repositories.ride.getRide(pathParams.rideId);
    if (!ride) return notFoundError('Ride not found', 'RIDE_NOT_FOUND');
    if (!isAdmin(headers) && ride.riderId !== auth.session.userId && ride.driverId !== auth.session.userId) {
      return forbiddenError('Forbidden: cannot access this ride feedback.', 'FORBIDDEN_RIDE_ACCESS');
    }

    const result = feedbackService.getFeedbackForRide(pathParams.rideId);
    return { data: result };
  });

  // ─── Get all feedback received by a driver ───
  router.register('GET', '/api/v1/drivers/:driverId/feedback', async ({ pathParams, params, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    if (!isAdmin(headers) && auth.session.userId !== pathParams.driverId) {
      return forbiddenError('Forbidden: cannot access another driver feedback.', 'FORBIDDEN_DRIVER_FEEDBACK_ACCESS');
    }

    const limit = parseInt(params.get('limit') || '50', 10);
    const result = feedbackService.getDriverFeedbacks(pathParams.driverId, limit);
    return { data: result };
  });

  // ─── Get all feedback received by a rider ───
  router.register('GET', '/api/v1/riders/:riderId/feedback', async ({ pathParams, params, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    if (!isAdmin(headers) && auth.session.userId !== pathParams.riderId) {
      return forbiddenError('Forbidden: cannot access another rider feedback.', 'FORBIDDEN_RIDER_FEEDBACK_ACCESS');
    }

    const limit = parseInt(params.get('limit') || '50', 10);
    const result = feedbackService.getRiderFeedbacks(pathParams.riderId, limit);
    return { data: result };
  });
}

module.exports = registerFeedbackRoutes;
