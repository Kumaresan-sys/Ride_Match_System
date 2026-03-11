const crypto = require('crypto');
const config = require('../config');
const { haversine } = require('../utils/formulas');
const { validateSchema, validationError } = require('./validation');
const {
  badRequest,
  forbiddenError,
  notFoundError,
  conflictError,
  rateLimitError,
  buildErrorFromResult,
  getAuthenticatedSession,
} = require('./response');
const RedisStateStore = require('../infra/redis/state-store');
const redis = require('../services/redis-client');

const RIDE_RATE_WINDOW_SEC = 60;
const RIDE_RATE_MAX = 20;

function registerRideRoutes(router, ctx) {
  const { services, repositories } = ctx;
  const requireAuth = ctx.requireAuth;
  const requireAdmin = ctx.requireAdmin;
  const stateStore = new RedisStateStore(redis);

  async function authenticate(headers) {
    return getAuthenticatedSession(requireAuth, headers);
  }

  function canAccessRide(sessionUserId, ride) {
    if (!ride) return false;
    return String(ride.riderId || '') === String(sessionUserId || '') ||
      String(ride.driverId || '') === String(sessionUserId || '');
  }

  function isAdmin(headers = {}) {
    if (!headers['x-admin-token']) return false;
    return !requireAdmin(headers);
  }

  async function checkRideRateLimit(key) {
    const k = key || 'unknown';
    const count = await stateStore.incrementRateLimit('ride_request', k, RIDE_RATE_WINDOW_SEC);
    return count <= RIDE_RATE_MAX;
  }

  function toIso(value) {
    if (value == null) return null;
    if (typeof value === 'string') {
      const numeric = Number(value);
      if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
        const parsedNumeric = new Date(numeric);
        return Number.isNaN(parsedNumeric.getTime()) ? null : parsedNumeric.toISOString();
      }
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    if (typeof value === 'number') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    return null;
  }

  function toNumber(value, fallback = null) {
    if (value == null) return fallback;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  }

  function roundMoney(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.round(numeric * 100) / 100;
  }

  function normalizeStatus(raw) {
    const key = String(raw || '').trim();
    if (!key) return 'UNKNOWN';
    if (key === key.toUpperCase()) return key;
    const upper = key.toUpperCase();
    switch (upper) {
      case 'REQUESTED':
        return 'REQUESTED';
      case 'SEARCHING':
        return 'MATCHING';
      case 'DRIVER_ASSIGNED':
        return 'ACCEPTED';
      case 'DRIVER_ARRIVING':
        return 'DRIVER_ARRIVING';
      case 'DRIVER_ARRIVED':
        return 'DRIVER_ARRIVED';
      case 'RIDE_STARTED':
      case 'IN_PROGRESS':
        return 'TRIP_STARTED';
      case 'COMPLETED':
        return 'TRIP_COMPLETED';
      case 'CANCELLED':
        return 'CANCELLED';
      case 'NO_DRIVERS':
        return 'NO_DRIVERS';
      default:
        return upper;
    }
  }

  function deriveCancelledBy(status, ride) {
    if (status === 'CANCELLED_BY_RIDER') return 'rider';
    if (status === 'CANCELLED_BY_DRIVER') return 'driver';
    if (status === 'NO_DRIVERS') return 'system';
    if (status === 'CANCELLED') {
      const by = String(ride?.cancelledBy || '').toLowerCase();
      if (by === 'rider' || by === 'driver' || by === 'system') return by;
      return 'system';
    }
    return null;
  }

  function deriveCancellationReason(status, ride) {
    const explicit = String(
      ride?.cancellationReasonText ||
      ride?.reasonText ||
      ''
    ).trim();
    if (explicit) return explicit;

    if (status === 'NO_DRIVERS') {
      const zone = String(
        ride?.pickupZoneName ||
        ride?.pickupZoneCode ||
        ride?.pickupZoneId ||
        ''
      ).trim();
      return zone
        ? `No drivers found in pickup zone ${zone}.`
        : 'No drivers found in your pickup zone.';
    }

    const cancelledBy = deriveCancelledBy(status, ride);
    if (cancelledBy === 'rider') return 'Ride cancelled by rider.';
    if (cancelledBy === 'driver') return 'Ride cancelled by driver.';
    if (cancelledBy === 'system') return 'Ride cancelled by system.';
    return null;
  }

  function deriveRequestedServiceType(ride) {
    const candidates = [
      ride?.requestedServiceType,
      ride?.serviceType,
      ride?.matchResult?.vehicleType,
      ride?.rideType,
    ];
    for (const candidate of candidates) {
      const value = String(candidate || '').trim();
      if (!value) continue;
      if (['on_demand', 'scheduled', 'shared', 'rental', 'intercity'].includes(value.toLowerCase())) {
        continue;
      }
      return value;
    }
    return null;
  }

  function deriveDistanceKm(ride) {
    const direct =
      toNumber(ride?.distanceKm, null) ??
      (toNumber(ride?.actualDistanceM, null) != null
        ? toNumber(ride?.actualDistanceM, 0) / 1000
        : null) ??
      (toNumber(ride?.estimatedDistanceM, null) != null
        ? toNumber(ride?.estimatedDistanceM, 0) / 1000
        : null) ??
      (toNumber(ride?.requestedEstimatedDistanceM, null) != null
        ? toNumber(ride?.requestedEstimatedDistanceM, 0) / 1000
        : null);
    if (direct != null) return Math.round(direct * 10) / 10;

    const pickupLat = toNumber(ride?.pickupLat, null);
    const pickupLng = toNumber(ride?.pickupLng, null);
    const destLat = toNumber(ride?.destLat, null);
    const destLng = toNumber(ride?.destLng, null);
    if ([pickupLat, pickupLng, destLat, destLng].every((value) => Number.isFinite(value))) {
      const approx = haversine(pickupLat, pickupLng, destLat, destLng) * 1.25;
      return Math.round(approx * 10) / 10;
    }
    return 0;
  }

  function deriveDurationMin(ride, distanceKm) {
    const direct =
      toNumber(ride?.durationMin, null) ??
      (toNumber(ride?.actualDurationS, null) != null
        ? Math.round(toNumber(ride?.actualDurationS, 0) / 60)
        : null) ??
      (toNumber(ride?.estimatedDurationS, null) != null
        ? Math.round(toNumber(ride?.estimatedDurationS, 0) / 60)
        : null) ??
      (toNumber(ride?.requestedEstimatedDurationS, null) != null
        ? Math.round(toNumber(ride?.requestedEstimatedDurationS, 0) / 60)
        : null);
    if (direct != null) return direct;

    const avgSpeedKmh = Number(config?.scoring?.avgCitySpeedKmh) || 22;
    if (distanceKm > 0 && avgSpeedKmh > 0) {
      return Math.max(1, Math.round((distanceKm / avgSpeedKmh) * 60));
    }
    return 0;
  }

  async function normalizeRideForClient(ride, paymentInfoByRide = null) {
    if (!ride || typeof ride !== 'object') return null;

    const status = normalizeStatus(ride.status);
    const liveDriver = ride.driver && typeof ride.driver === 'object'
      ? ride.driver
      : null;
    const matchResult = ride.matchResult && typeof ride.matchResult === 'object'
      ? ride.matchResult
      : null;
    const isCancelled =
      status === 'CANCELLED' ||
      status === 'CANCELLED_BY_RIDER' ||
      status === 'CANCELLED_BY_DRIVER' ||
      status === 'NO_DRIVERS';
    const cancellationFee = toNumber(ride.cancellationFee, null);
    const fareEstimateFinal =
      (ride.fareEstimate && typeof ride.fareEstimate === 'object')
        ? toNumber(ride.fareEstimate.finalFare, null)
        : null;
    let originalFare =
      toNumber(ride.estimatedFare, null) != null
        ? toNumber(ride.estimatedFare, null)
        : (typeof fareEstimateFinal === 'number' ? fareEstimateFinal : null);
    const finalFareRaw =
      toNumber(ride.finalFare, null) != null
        ? toNumber(ride.finalFare, null)
        : (ride.finalFare && typeof ride.finalFare === 'object' && toNumber(ride.finalFare.finalFare, null) != null
          ? toNumber(ride.finalFare.finalFare, null)
          : null);
    let finalFare = typeof finalFareRaw === 'number' ? finalFareRaw : (typeof originalFare === 'number' ? originalFare : 0);
    const fareObj = ride.finalFare && typeof ride.finalFare === 'object' ? ride.finalFare : null;
    const fareBreakdown = fareObj && typeof fareObj.breakdown === 'object' ? fareObj.breakdown : null;
    const requestedBreakdown = {
      baseFare: toNumber(ride.requestedBaseFare, null),
      distanceCharge: toNumber(ride.requestedDistanceCharge, null),
      timeCharge: toNumber(ride.requestedTimeCharge, null),
      subtotal: toNumber(ride.requestedSubtotal, null),
      serviceCost: toNumber(ride.requestedServiceCost, null),
      gstPct: toNumber(ride.requestedGstPct, null),
      gstAmount: toNumber(ride.requestedGstAmount, null),
      commissionPct: toNumber(ride.requestedCommissionPct, null),
      surgeMultiplier: toNumber(ride.requestedSurgeMultiplier, null),
      platformCommission: toNumber(ride.requestedPlatformCommission, null),
    };
    const gstPctFromRide =
      toNumber(fareObj?.gstPct, null) ??
      toNumber(fareBreakdown?.gstPct, null) ??
      requestedBreakdown.gstPct;
    const serviceCostFromRide =
      toNumber(fareObj?.serviceCost, null) ??
      toNumber(fareBreakdown?.serviceCost, null) ??
      requestedBreakdown.serviceCost;
    const gstAmountFromRide =
      toNumber(fareObj?.gstAmount, null) ??
      toNumber(fareBreakdown?.gstAmount, null) ??
      toNumber(ride.taxes, null) ??
      requestedBreakdown.gstAmount;

    let gstPct = gstPctFromRide;
    if (gstPct == null && services?.pricingService?.getTaxConfig) {
      try {
        const taxCfg = await services.pricingService.getTaxConfig();
        gstPct = toNumber(taxCfg?.gstPct, null);
      } catch (_) {
        gstPct = null;
      }
    }
    if (gstPct == null) gstPct = 5;

    let serviceCost = serviceCostFromRide != null
      ? serviceCostFromRide
      : Math.round((finalFare / (1 + (gstPct / 100))) * 100) / 100;
    let gstAmount = gstAmountFromRide != null
      ? gstAmountFromRide
      : Math.round((finalFare - serviceCost) * 100) / 100;
    const serviceType = deriveRequestedServiceType(ride);
    const distanceKm = deriveDistanceKm(ride);
    const durationMin = deriveDurationMin(ride, distanceKm);
    let estimatedBreakdown = null;
    if (services?.pricingService?.calculateFare && serviceType) {
      try {
        estimatedBreakdown = await services.pricingService.calculateFare(
          serviceType,
          distanceKm,
          durationMin,
          toNumber(ride.surgeMultiplier, 1) ?? 1
        );
      } catch (_) {
        estimatedBreakdown = null;
      }
    }
    if (originalFare == null) {
      originalFare = toNumber(estimatedBreakdown?.finalFare, null);
    }
    const hasCapturedCharge = Boolean(
      ride.paymentMethod ||
      ride.paymentTransactionId ||
      finalFareRaw != null ||
      (cancellationFee != null && cancellationFee > 0)
    );
    const breakdownFare =
      isCancelled && !hasCapturedCharge && originalFare != null
        ? originalFare
        : finalFare;

    if (serviceCostFromRide == null && breakdownFare > 0) {
      serviceCost = Math.round((breakdownFare / (1 + (gstPct / 100))) * 100) / 100;
    }
    if (gstAmountFromRide == null && breakdownFare > 0) {
      gstAmount = Math.round((breakdownFare - serviceCost) * 100) / 100;
    }

    if (isCancelled && !hasCapturedCharge) {
      finalFare = cancellationFee != null && cancellationFee > 0 ? cancellationFee : 0;
    }

    const commissionPct =
      toNumber(fareObj?.commissionPct, null) ??
      toNumber(fareBreakdown?.commissionPct, null) ??
      requestedBreakdown.commissionPct ??
      toNumber(estimatedBreakdown?.commissionPct, null);
    const platformFeeBase =
      isCancelled && !hasCapturedCharge && originalFare != null
        ? originalFare
        : (typeof finalFareRaw === 'number' ? finalFareRaw : originalFare);
    const platformFee =
      toNumber(ride.platformFee, null) ??
      toNumber(fareObj?.platformCommission, null) ??
      toNumber(fareBreakdown?.platformCommission, null) ??
      requestedBreakdown.platformCommission ??
      (commissionPct != null && platformFeeBase != null
        ? Math.round(platformFeeBase * commissionPct * 100) / 100
        : null) ??
      toNumber(estimatedBreakdown?.platformCommission, null);
    const baseFare =
      toNumber(ride.baseFare, null) ??
      toNumber(fareBreakdown?.baseFare, null) ??
      requestedBreakdown.baseFare ??
      toNumber(estimatedBreakdown?.breakdown?.baseFare, null);
    const distanceCharge =
      toNumber(ride.distanceFare, null) ??
      toNumber(fareBreakdown?.distanceCharge, null) ??
      requestedBreakdown.distanceCharge ??
      toNumber(estimatedBreakdown?.breakdown?.distanceCharge, null);
    const timeCharge =
      toNumber(ride.timeFare, null) ??
      toNumber(fareBreakdown?.timeCharge, null) ??
      requestedBreakdown.timeCharge ??
      toNumber(estimatedBreakdown?.breakdown?.timeCharge, null);
    const subtotal =
      toNumber(ride.subtotal, null) ??
      toNumber(fareBreakdown?.subtotal, null) ??
      requestedBreakdown.subtotal ??
      toNumber(estimatedBreakdown?.breakdown?.subtotal, null) ??
      serviceCost;
    const rawSubtotal =
      baseFare != null || distanceCharge != null || timeCharge != null
        ? roundMoney((baseFare || 0) + (distanceCharge || 0) + (timeCharge || 0))
        : null;
    const minimumFareAdjustment =
      rawSubtotal != null && subtotal != null && subtotal > rawSubtotal
        ? roundMoney(subtotal - rawSubtotal)
        : null;
    const displayedFinalFare =
      typeof finalFareRaw === 'number'
        ? finalFareRaw
        : (isCancelled && !hasCapturedCharge ? originalFare : finalFare);

    const startedAt = toIso(ride.startedAt);
    const endedAt = toIso(
      ride.endedAt ||
      ride.completedAt ||
      ride.cancelledAt ||
      ride.cancellationRecordedAt
    );
    const cancelledBy = deriveCancelledBy(status, ride);
    const cancellationReasonText = deriveCancellationReason(status, ride);
    const driverId = ride.driverId ? String(ride.driverId) : null;
    const driverName = String(
      ride.driverName ||
      liveDriver?.name ||
      matchResult?.driverName ||
      ''
    ).trim() || null;
    const driverPhone = String(
      ride.driverPhone ||
      liveDriver?.phone ||
      liveDriver?.phoneNumber ||
      matchResult?.driverPhone ||
      ''
    ).trim() || null;
    const driverVehicleNumber = String(
      ride.driverVehicleNumber ||
      liveDriver?.vehicleNumber ||
      matchResult?.vehicleNumber ||
      ''
    ).trim() || null;
    const driverVehicleType = String(
      ride.driverVehicleType ||
      liveDriver?.vehicleType ||
      matchResult?.vehicleType ||
      serviceType ||
      ride.rideType ||
      ''
    ).trim() || null;
    const driverRating =
      toNumber(ride.driverRating, null) ??
      toNumber(liveDriver?.rating, null) ??
      toNumber(matchResult?.driverRating, null);
    const driverAvatarUrl = String(
      ride.driverAvatarUrl ||
      liveDriver?.avatarUrl ||
      matchResult?.avatarUrl ||
      ''
    ).trim() || null;
    const driverCompletedRides =
      toNumber(ride.driverCompletedRides, null) ??
      toNumber(liveDriver?.completedRides, null) ??
      toNumber(matchResult?.completedRides, null);
    const rideOtp = String(ride.otp || '').trim() || null;
    const driverLat =
      toNumber(ride.driverLat, null) ??
      toNumber(liveDriver?.lat, null) ??
      toNumber(matchResult?.driverLat, null);
    const driverLng =
      toNumber(ride.driverLng, null) ??
      toNumber(liveDriver?.lng, null) ??
      toNumber(matchResult?.driverLng, null);
    const liveEtaMin =
      toNumber(ride.etaMin, null) ??
      toNumber(liveDriver?.etaMin, null) ??
      toNumber(matchResult?.etaMin, null);
    const normalizedMatchResult = matchResult
      ? {
        ...matchResult,
        driverName: driverName || matchResult.driverName || null,
        driverPhone: driverPhone || matchResult.driverPhone || null,
        vehicleType: driverVehicleType || matchResult.vehicleType || null,
        vehicleNumber: driverVehicleNumber || matchResult.vehicleNumber || null,
        driverRating: driverRating ?? null,
        avatarUrl: driverAvatarUrl || matchResult.avatarUrl || null,
        driverLat: driverLat ?? matchResult.driverLat ?? null,
        driverLng: driverLng ?? matchResult.driverLng ?? null,
        etaMin: liveEtaMin ?? matchResult.etaMin ?? null,
        completedRides:
          driverCompletedRides != null
            ? Math.round(driverCompletedRides)
            : (matchResult.completedRides ?? null),
      }
      : null;

    const normalized = {
      rideId: String(ride.rideId || ride.id || ''),
      status,
      cancelledBy,
      cancellationReasonCode:
        ride.cancellationReasonCode ||
        (status === 'NO_DRIVERS' ? 'NO_DRIVERS_IN_ZONE' : null),
      cancellationReasonText,
      cancellationFee,
      riderId: ride.riderId ? String(ride.riderId) : null,
      driverId,
      driverName,
      driverPhone,
      driverAvatarUrl,
      driverCompletedRides:
        driverCompletedRides != null ? Math.round(driverCompletedRides) : null,
      pickupAddress: ride.pickupAddress || ride.requestedPickupAddress || null,
      destAddress: ride.destAddress || ride.dropoffAddress || ride.requestedDestAddress || null,
      pickupZoneCode: ride.pickupZoneCode || null,
      pickupZoneName: ride.pickupZoneName || null,
      pickupZoneCity: ride.pickupZoneCity || null,
      dropZoneCode: ride.dropZoneCode || null,
      dropZoneName: ride.dropZoneName || null,
      dropZoneCity: ride.dropZoneCity || null,
      pickupLat: toNumber(ride.pickupLat, null),
      pickupLng: toNumber(ride.pickupLng, null),
      destLat: toNumber(ride.destLat, null),
      destLng: toNumber(ride.destLng, null),
      pickupZoneId: ride.pickupZoneId ? String(ride.pickupZoneId) : null,
      dropZoneId: ride.dropZoneId ? String(ride.dropZoneId) : null,
      rideMode: ride.rideType || null,
      rideType: serviceType || ride.rideType || null,
      serviceType,
      distanceKm,
      durationMin,
      driverLat,
      driverLng,
      etaMin: liveEtaMin,
      createdAt: toIso(ride.createdAt),
      acceptedAt: toIso(ride.acceptedAt),
      arrivedAt: toIso(ride.arrivedAt),
      otp: rideOtp,
      startedAt,
      endedAt,
      finalFare,
      displayedFinalFare,
      originalFare,
      baseFare,
      distanceCharge,
      timeCharge,
      rawSubtotal,
      minimumFareAdjustment,
      serviceCost,
      platformFee,
      bookingFee: toNumber(ride.bookingFee, null),
      gstAmount,
      gstPct,
      discountAmount: toNumber(ride.discountAmount, null),
      coinsUsed: toNumber(ride.coinsUsed, null) != null ? Math.round(toNumber(ride.coinsUsed, 0)) : null,
      coinsDiscountAmount: toNumber(ride.coinsDiscountAmount, null),
      paymentMethod: ride.paymentMethod || null,
      paymentTransactionId: ride.paymentTransactionId || null,
      matchResult: normalizedMatchResult,
      driver: driverId
        ? {
          driverId,
          name: driverName,
          phone: driverPhone,
          phoneNumber: driverPhone,
          vehicleType: driverVehicleType,
          vehicleNumber: driverVehicleNumber,
          rating: driverRating,
          avatarUrl: driverAvatarUrl,
          completedRides:
            driverCompletedRides != null ? Math.round(driverCompletedRides) : null,
          etaMin: liveEtaMin,
          lat: driverLat,
          lng: driverLng,
          otp: rideOtp,
        }
        : null,
    };

    if (!isCancelled &&
        (!normalized.paymentTransactionId || !normalized.paymentMethod) &&
        normalized.rideId &&
        normalized.riderId &&
        typeof repositories.wallet.getRidePaymentInfo === 'function') {
      try {
        const paymentInfo = paymentInfoByRide instanceof Map
          ? paymentInfoByRide.get(normalized.rideId)
          : await repositories.wallet.getRidePaymentInfo(
            normalized.riderId,
            normalized.rideId
          );
        if (paymentInfo) {
          if (!normalized.paymentTransactionId && paymentInfo.paymentTransactionId) {
            normalized.paymentTransactionId = paymentInfo.paymentTransactionId;
          }
          if (!normalized.paymentMethod && paymentInfo.paymentMethod) {
            normalized.paymentMethod = paymentInfo.paymentMethod;
          }
        }
      } catch (_) {
        // Best-effort enrichment; avoid failing core ride response path.
      }
    }

    if (isCancelled && !hasCapturedCharge) {
      normalized.paymentMethod = null;
      normalized.paymentTransactionId = null;
      normalized.discountAmount = null;
      normalized.coinsUsed = null;
      normalized.coinsDiscountAmount = null;
    }

    return normalized;
  }

  router.register('POST', '/api/v1/rides/request', async ({ body, headers, ip }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;
    const authenticatedRiderId = String(auth.session.userId || '').trim();
    if (!authenticatedRiderId) {
      return forbiddenError('Authenticated rider context is missing.', 'AUTH_REQUIRED');
    }
    if (!await checkRideRateLimit(`${ip || 'unknown'}:${auth.session.userId}`)) {
      return rateLimitError(
        'Rate limit exceeded for ride requests. Try again shortly.',
        'RIDE_REQUEST_RATE_LIMITED',
      );
    }

    const parsed = validateSchema(body, [
      { key: 'riderId', type: 'string', required: false },
      { key: 'pickupLat', type: 'number', required: true, min: -90, max: 90 },
      { key: 'pickupLng', type: 'number', required: true, min: -180, max: 180 },
      { key: 'destLat', type: 'number', required: true, min: -90, max: 90 },
      { key: 'destLng', type: 'number', required: true, min: -180, max: 180 },
      { key: 'pickupAddress', type: 'string', required: false, maxLength: 512 },
      { key: 'destAddress', type: 'string', required: false, maxLength: 512 },
      { key: 'dropAddress', type: 'string', required: false, maxLength: 512 },
      { key: 'rideType', type: 'string', required: false },
      { key: 'requestedServiceType', type: 'string', required: false },
      { key: 'idempotencyKey', type: 'string', required: false, minLength: 8, maxLength: 128 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    const requestedRideType = String(parsed.data.rideType || '').trim().toLowerCase();
    const requestedServiceType = String(parsed.data.requestedServiceType || '').trim().toLowerCase();
    const effectiveRideType = requestedServiceType || requestedRideType || 'sedan';

    // Validate rideType against active vehicle types from DB
    if (effectiveRideType) {
      const validTypes = await services.pricingService.getVehicleTypes();
      const validNames = validTypes.map(t => t.name);
      if (!validNames.includes(effectiveRideType)) {
        return badRequest(
          `Invalid rideType '${effectiveRideType}'. Valid types: ${validNames.join(', ')}`,
          'INVALID_RIDE_TYPE',
        );
      }
    }

    if (parsed.data.riderId && parsed.data.riderId !== authenticatedRiderId) {
      return forbiddenError('Forbidden: riderId must match authenticated user.', 'FORBIDDEN_RIDER_MISMATCH');
    }

    const pickupLat = parsed.data.pickupLat;
    const pickupLng = parsed.data.pickupLng;

    if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
      // In-memory zone check (open-area validation)
      const zoneCheck = services.zoneService.checkPickup(pickupLat, pickupLng);
      if (!zoneCheck.allowed) {
        return forbiddenError(zoneCheck.message, zoneCheck.reason || 'PICKUP_NOT_ALLOWED', {
          reason: zoneCheck.reason,
        });
      }

      // DB-backed zone restriction check (persisted admin-managed restrictions)
      const zoneRestrictionsService =
        require('../services/zone-restrictions-service');
      const restrictionCheck = await zoneRestrictionsService.checkRestricted(pickupLat, pickupLng, 'rider');
      if (restrictionCheck.restricted) {
        return {
          ...forbiddenError(restrictionCheck.message, 'ZONE_RESTRICTED', {
            reason: 'ZONE_RESTRICTED',
            zoneName: restrictionCheck.zoneName,
          }),
        };
      }
    }

    let coinRedemptionPreview = null;
    if (authenticatedRiderId && services?.coinsService) {
      const estimates = await services.pricingService.getEstimates(
        pickupLat,
        pickupLng,
        parsed.data.destLat,
        parsed.data.destLng
      );
      const estimatedFare = estimates.estimates[effectiveRideType]?.finalFare;
      if (estimatedFare != null) {
        coinRedemptionPreview = await services.coinsService.toRideCoinsQuote(
          authenticatedRiderId,
          Number(estimatedFare),
          { rideType: effectiveRideType }
        );
      }
    }

    if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
      services.demandLogService.recordDemand(pickupLat, pickupLng, 'ride_requested');
      services.demandLogService.recordTimeslot('ride_requested');
    }

    const idempotencyHeader = String(
      headers?.['idempotency-key'] || headers?.['x-idempotency-key'] || ''
    ).trim() || null;

    const result = await repositories.ride.createRide({
      ...body,
      ...parsed.data,
      riderId: authenticatedRiderId,
      destAddress: parsed.data.destAddress || parsed.data.dropAddress || null,
      rideType: effectiveRideType,
      requestedServiceType: requestedServiceType || null,
      rideId: crypto.randomUUID(),
      rideNumber: `RD${Date.now().toString(36).toUpperCase()}`,
      idempotencyKey: parsed.data.idempotencyKey || idempotencyHeader || crypto.randomUUID(),
    });

    if (coinRedemptionPreview) {
      result.coins = coinRedemptionPreview;
      result.coinRedemptionPreview = coinRedemptionPreview;
    }
    return { data: result };
  });

  router.register('GET', '/api/v1/rides', async ({ headers, params }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    const limitRaw = Number.parseInt(params?.get('limit') || '50', 10);
    const limit = Math.min(Math.max(limitRaw, 1), 200);
    const cursor = params?.get('cursor') || null;
    const page = await repositories.ride.getRidesPage({ limit, cursor });
    const rides = page?.rides || [];
    const paymentInfoByRide = new Map();
    if (rides.length > 0 && typeof repositories.wallet.getRidePaymentInfoBatch === 'function') {
      const rideIdsByRider = new Map();
      for (const ride of rides) {
        const rideId = String(ride?.rideId || '');
        const riderId = String(ride?.riderId || '');
        if (!rideId || !riderId) continue;
        const current = rideIdsByRider.get(riderId) || [];
        current.push(rideId);
        rideIdsByRider.set(riderId, current);
      }

      await Promise.all(Array.from(rideIdsByRider.entries()).map(async ([riderId, rideIds]) => {
        const batch = await repositories.wallet.getRidePaymentInfoBatch(riderId, rideIds).catch(() => ({}));
        Object.entries(batch || {}).forEach(([rideId, info]) => {
          paymentInfoByRide.set(String(rideId), info);
        });
      }));
    }

    const normalized = (await Promise.all(rides.map((ride) => normalizeRideForClient(ride, paymentInfoByRide))))
      .filter(Boolean);
    if (isAdmin(headers || {})) return { data: { rides: normalized, nextCursor: page?.nextCursor || null } };

    const ownRides = normalized.filter(ride => canAccessRide(auth.session.userId, ride));
    return { data: { rides: ownRides, nextCursor: page?.nextCursor || null } };
  });

  router.register('GET', '/api/v1/rides/:rideId', async ({ pathParams, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    const ride = await repositories.ride.getRide(pathParams.rideId);
    const normalized = await normalizeRideForClient(ride);
    if (normalized && !canAccessRide(auth.session.userId, normalized)) {
      return forbiddenError('Forbidden: cannot access this ride.', 'FORBIDDEN_RIDE_ACCESS');
    }
    if (!normalized) {
      return notFoundError('Ride not found', 'RIDE_NOT_FOUND');
    }
    return { data: normalized };
  });

  router.register('POST', '/api/v1/rides/:rideId/cancel', async ({ pathParams, body, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;
    if (!body.userId) return badRequest('userId is required', 'VALIDATION_ERROR');
    if (body.userId !== auth.session.userId) {
      return forbiddenError('Forbidden: userId must match authenticated user.', 'FORBIDDEN_USER_MISMATCH');
    }
    const ride = await repositories.ride.getRide(pathParams.rideId);
    if (ride && !canAccessRide(auth.session.userId, ride)) {
      return forbiddenError('Forbidden: cannot cancel this ride.', 'FORBIDDEN_RIDE_ACCESS');
    }

    let result;
    try {
      result = await repositories.ride.cancelRide(
        pathParams.rideId,
        body.cancelledBy,
        body.userId,
        {
          reasonCode: body.reasonCode || null,
          reasonText: body.reasonText || body.reason || null,
        }
      );
    } catch (err) {
      if (String(err?.message || '').includes('cancellation reason')) {
        return badRequest(err.message, 'INVALID_CANCELLATION_REASON');
      }
      throw err;
    }
    if (!result?.success) {
      if (String(result?.reason || '').toLowerCase().includes('not found')) {
        return notFoundError(result.reason, 'RIDE_NOT_FOUND');
      }
      return buildErrorFromResult(result, {
        status: 409,
        defaultCode: 'CANCEL_RIDE_FAILED',
        defaultMessage: 'Unable to cancel ride.',
      });
    }
    return { data: result };
  });

  // Driver-side accept endpoint.
  router.register('POST', '/api/v1/rides/:rideId/accept', async ({ pathParams, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    const result = await services.matchingEngine.acceptOffer(pathParams.rideId, auth.session.userId);
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 409,
        defaultCode: 'RIDE_ACCEPT_FAILED',
        defaultMessage: 'Unable to accept ride offer.',
      });
    }
    return { data: result };
  });

  router.register('POST', '/api/v2/rides/:rideId/offers/:offerId/accept', async ({ pathParams, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    const result = await services.matchingEngine.acceptOffer(
      pathParams.rideId,
      auth.session.userId,
      pathParams.offerId
    );
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 409,
        defaultCode: 'RIDE_ACCEPT_FAILED',
        defaultMessage: 'Unable to accept ride offer.',
      });
    }
    return { data: result };
  });

  router.register('POST', '/api/v1/rides/:rideId/arrived', async ({ pathParams, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;
    const ride = await repositories.ride.getRide(pathParams.rideId);
    if (!ride || ride.driverId !== auth.session.userId) {
      return forbiddenError('Forbidden: only assigned driver can update arrival.', 'FORBIDDEN_DRIVER_ACTION');
    }

    const updated = await services.rideService.driverArrived(pathParams.rideId);
    if (!updated) return conflictError('Invalid state', 'INVALID_RIDE_STATE');
    return { data: { status: updated.status, rideId: pathParams.rideId } };
  });

  router.register('POST', '/api/v1/rides/:rideId/start', async ({ pathParams, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;
    const ride = await repositories.ride.getRide(pathParams.rideId);
    if (!ride || ride.driverId !== auth.session.userId) {
      return forbiddenError('Forbidden: only assigned driver can start trip.', 'FORBIDDEN_DRIVER_ACTION');
    }

    const updated = await services.rideService.startTrip(pathParams.rideId);
    if (!updated) return conflictError('Invalid state', 'INVALID_RIDE_STATE');
    return { data: { status: updated.status, rideId: pathParams.rideId } };
  });

  router.register('POST', '/api/v1/rides/:rideId/complete', async ({ pathParams, body, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;
    const existingRide = await repositories.ride.getRide(pathParams.rideId);
    if (!existingRide || existingRide.driverId !== auth.session.userId) {
      return forbiddenError('Forbidden: only assigned driver can complete trip.', 'FORBIDDEN_DRIVER_ACTION');
    }

    const rideId = pathParams.rideId;
    const result = await repositories.ride.completeTrip(rideId, body.distanceKm, body.durationMin);
    if (!result) return conflictError('Invalid state', 'INVALID_RIDE_STATE');

    const ride = await repositories.ride.getRide(rideId);
    if (ride && ride.riderId && services?.coinsService) {
      const fareInr = Number(result.fare?.finalFare || 0);
      if (fareInr > 0) {
        const preview = await services.coinsService.previewRideDiscount(ride.riderId, {
          fareInr,
          rideId,
          rideType: ride.rideType || null,
          requestedCoins: body?.coinsToUse,
        });
        if (preview.appliedCoins > 0) {
          const redemption = await repositories.wallet.redeemCoins(
            ride.riderId,
            fareInr,
            preview.appliedCoins
          );
          if (redemption.success) {
            result.fare.finalFareAfterCoins = redemption.finalFare;
            result.fare.coinDiscount = redemption.discountInr;
            result.coinRedemption = redemption;
            result.coins = preview;
          }
        } else {
          result.coins = preview;
        }
      }
    }

    if (ride && ride.riderId) {
      const earnFare = result.fare?.finalFare;
      const earnResult = await services.walletService.earnCoins(ride.riderId, earnFare, rideId);
      if (earnResult) result.coinsEarned = earnResult.coins;
    }

    return { data: result };
  });
}

module.exports = registerRideRoutes;
