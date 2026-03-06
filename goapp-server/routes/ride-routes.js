const crypto = require('crypto');

function registerRideRoutes(router, ctx) {
  const { services, repositories } = ctx;

  router.register('POST', '/api/v1/rides/request', async ({ body }) => {
    const pickupLat = parseFloat(body.pickupLat);
    const pickupLng = parseFloat(body.pickupLng);

    if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
      const zoneCheck = services.zoneService.checkPickup(pickupLat, pickupLng);
      if (!zoneCheck.allowed) {
        return { status: 403, data: { error: zoneCheck.message, reason: zoneCheck.reason } };
      }
    }

    let coinRedemptionPreview = null;
    if (body.useCoins && body.riderId) {
      const estimates = await services.pricingService.getEstimates(
        pickupLat,
        pickupLng,
        parseFloat(body.destLat),
        parseFloat(body.destLng)
      );
      const rideType = body.rideType || 'sedan';
      const estimatedFare = estimates.estimates[rideType]?.finalFare;
      if (estimatedFare) {
        const balance = repositories.wallet.getBalance(body.riderId);
        coinRedemptionPreview = {
          coinsAvailable: balance.coinBalance,
          maxDiscountInr: Math.round(Math.min(balance.coinBalance, Math.floor(estimatedFare * 0.20 / 0.10)) * 0.10 * 100) / 100,
        };
      }
    }

    if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
      services.demandLogService.recordDemand(pickupLat, pickupLng, 'ride_requested');
      services.demandLogService.recordTimeslot('ride_requested');
    }

    const result = await repositories.ride.createRide({
      ...body,
      idempotencyKey: body.idempotencyKey || crypto.randomUUID(),
    });

    if (coinRedemptionPreview) result.coinRedemptionPreview = coinRedemptionPreview;
    return { data: result };
  });

  router.register('GET', '/api/v1/rides', async () => ({ data: { rides: repositories.ride.getAllRides() } }));

  router.register('GET', '/api/v1/rides/:rideId', async ({ pathParams }) => {
    const ride = repositories.ride.getRide(pathParams.rideId);
    return { data: ride || { error: 'Ride not found' } };
  });

  router.register('POST', '/api/v1/rides/:rideId/cancel', async ({ pathParams, body }) => {
    const result = repositories.ride.cancelRide(pathParams.rideId, body.cancelledBy, body.userId);
    return { data: result };
  });

  router.register('POST', '/api/v1/rides/:rideId/arrived', async ({ pathParams }) => {
    const ride = services.rideService.driverArrived(pathParams.rideId);
    return { data: ride ? { status: ride.status, rideId: pathParams.rideId } : { error: 'Invalid state' } };
  });

  router.register('POST', '/api/v1/rides/:rideId/start', async ({ pathParams }) => {
    const ride = services.rideService.startTrip(pathParams.rideId);
    return { data: ride ? { status: ride.status, rideId: pathParams.rideId } : { error: 'Invalid state' } };
  });

  router.register('POST', '/api/v1/rides/:rideId/complete', async ({ pathParams, body }) => {
    const rideId = pathParams.rideId;
    const result = repositories.ride.completeTrip(rideId, body.distanceKm, body.durationMin);
    if (!result) return { data: { error: 'Invalid state' } };

    const ride = repositories.ride.getRide(rideId);
    if (ride && body.useCoins && ride.riderId) {
      const fareInr = result.fare?.finalFare;
      if (fareInr) {
        const redemption = repositories.wallet.redeemCoins(ride.riderId, fareInr, body.coinsToUse);
        if (redemption.success) {
          result.fare.finalFareAfterCoins = redemption.finalFare;
          result.fare.coinDiscount = redemption.discountInr;
          result.coinRedemption = redemption;
        }
      }
    }

    if (ride && ride.riderId) {
      const earnFare = result.fare?.finalFare;
      const earnResult = services.walletService.earnCoins(ride.riderId, earnFare, rideId);
      if (earnResult) result.coinsEarned = earnResult.coins;
    }

    return { data: result };
  });
}

module.exports = registerRideRoutes;
