const { validateSchema } = require('./validation');
const {
  badRequest,
  forbiddenError,
  notFoundError,
  conflictError,
  internalError,
  getAuthenticatedSession,
} = require('./response');

function registerCancelRideRoutes(router, ctx) {
  const { services, repositories } = ctx;
  const requireAuth = ctx.requireAuth;

  async function authenticate(headers) {
    return getAuthenticatedSession(requireAuth, headers);
  }

  function canAccessRide(sessionUserId, ride) {
    if (!ride) return false;
    return String(ride.riderId || '') === String(sessionUserId || '') ||
      String(ride.driverId || '') === String(sessionUserId || '');
  }

  function normalizeActor(raw) {
    const actor = String(raw || 'rider').trim().toLowerCase();
    return ['rider', 'driver', 'system'].includes(actor) ? actor : 'rider';
  }

  router.register('GET', '/api/v1/cancel-ride/reasons', async ({ headers, params }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    try {
      const actorType = normalizeActor(params?.get('actor'));
      const reasons = await services.rideCancellationReasonService.listReasons({
        actorType,
        userSelectableOnly: true,
      });

      return {
        data: {
          success: true,
          message: 'Cancellation reasons loaded successfully.',
          data: {
            reasons: reasons.map((reason) => ({
              id: reason.code,
              title: reason.title,
              description: reason.description || '',
              requiresNote: Boolean(reason.requiresNote),
            })),
          },
        },
      };
    } catch (err) {
      return internalError('Unable to load cancellation reasons.', 'CANCEL_REASONS_FETCH_FAILED');
    }
  });

  router.register('POST', '/api/v1/cancel-ride/submit', async ({ headers, body }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    try {
      const parsed = validateSchema(body, [
        { key: 'rideSessionId', type: 'string', required: true, minLength: 1 },
        { key: 'reasonId', type: 'string', required: true, minLength: 1, maxLength: 64 },
        { key: 'note', type: 'string', required: false, maxLength: 500 },
        { key: 'cancelledBy', type: 'string', required: false, minLength: 1, maxLength: 20 },
        { key: 'userId', type: 'string', required: false, minLength: 1 },
      ]);
      if (!parsed.ok) {
        return badRequest(parsed.error, 'INVALID_CANCEL_REQUEST');
      }

      const rideId = parsed.data.rideSessionId;
      const actorType = normalizeActor(parsed.data.cancelledBy || 'rider');
      const requestedUserId = parsed.data.userId || auth.session.userId;
      if (requestedUserId !== auth.session.userId) {
        return forbiddenError(
          'Forbidden: userId must match authenticated user.',
          'FORBIDDEN_USER_MISMATCH',
        );
      }

      const ride = await repositories.ride.getRide(rideId);
      if (!ride) {
        return notFoundError('Ride not found', 'RIDE_NOT_FOUND');
      }
      if (!canAccessRide(auth.session.userId, ride)) {
        return forbiddenError('Forbidden: cannot cancel this ride.', 'FORBIDDEN_RIDE_ACCESS');
      }

      try {
        await services.rideCancellationReasonService.resolveReason({
          actorType,
          reasonCode: parsed.data.reasonId,
          note: parsed.data.note || null,
          fallbackCode: actorType === 'rider' ? 'CHANGE_OF_PLANS' : 'DRIVER_OTHER',
        });
      } catch (err) {
        return badRequest(err.message, 'INVALID_CANCELLATION_REASON');
      }

      let result;
      try {
        result = await repositories.ride.cancelRide(
          rideId,
          actorType,
          auth.session.userId,
          {
            reasonCode: parsed.data.reasonId,
            reasonText: parsed.data.note || null,
          }
        );
      } catch (err) {
        if (String(err?.message || '').includes('cancellation reason')) {
          return badRequest(err.message, 'INVALID_CANCELLATION_REASON');
        }
        throw err;
      }

      if (!result?.success) {
        const message = result?.reason || 'Unable to cancel ride.';
        const errorCode = String(message).toLowerCase().includes('not found')
          ? 'RIDE_NOT_FOUND'
          : 'CANCEL_RIDE_FAILED';
        return errorCode === 'RIDE_NOT_FOUND'
          ? notFoundError(message, errorCode)
          : conflictError(message, errorCode);
      }

      return {
        data: {
          success: true,
          message: 'Ride cancelled successfully.',
          data: {
            request_id: `cancel_${Date.now()}`,
            ride_session_id: rideId,
            reason_id: parsed.data.reasonId,
            message: 'Ride cancelled successfully.',
            cancelled_at: new Date().toISOString(),
          },
        },
      };
    } catch (err) {
      return internalError('Unable to cancel ride right now.', 'CANCEL_RIDE_FAILED');
    }
  });
}

module.exports = registerCancelRideRoutes;
