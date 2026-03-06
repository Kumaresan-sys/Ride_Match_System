#!/usr/bin/env node

const http = require('http');
const crypto = require('crypto');
const config = require('./config');
const enterpriseConfig = require('./config/enterprise-architecture');
const { logger, eventBus } = require('./utils/logger');

// Services
const locationService = require('./services/location-service');
const matchingEngine = require('./services/matching-engine');
const pricingService = require('./services/pricing-service');
const rideService = require('./services/ride-service');
const identityService = require('./services/identity-service');
const walletService = require('./services/wallet-service');
const driverWalletService = require('./services/driver-wallet-service');
const demandAggregationService = require('./services/demand-aggregation-service');
const demandLogService = require('./services/demand-log-service');
const incentiveService = require('./services/incentive-service');
const ticketService = require('./services/ticket-service');
const rideSessionService = require('./services/ride-session-service');
const sosService = require('./services/sos-service');
const smsService = require('./services/sms-service');
const redis = require('./services/redis-mock');
const mockDb = require('./services/mock-db');
const zoneService = require('./services/zone-service');
const notificationService = require('./services/notification-service');
const WebSocketServer = require('./websocket/ws-gateway');
const { haversine, bearing } = require('./utils/formulas');

// Max request body size: 256 KB (prevents memory exhaustion)
const MAX_BODY_BYTES = 256 * 1024;

// Test Data
const { generateIdentityUsers } = require('./data/test-data');

// ─── Admin auth helper ────────────────────────────────────────────────────
function requireAdmin(headers) {
  const token = headers['x-admin-token'];
  if (!token || token !== config.admin.token) {
    return { status: 401, data: { error: 'Admin authentication required. Provide X-Admin-Token header.' } };
  }
  return null;
}

// ─── Session auth helper ──────────────────────────────────────────────────
// Returns session object or an error response to return immediately
function requireAuth(headers) {
  const authHeader = headers['authorization'] || '';
  const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : headers['x-session-token'];
  if (!sessionToken) {
    return { error: { status: 401, data: { error: 'Authentication required. Provide Authorization: Bearer <token> header.' } } };
  }
  const session = identityService.validateSession(sessionToken);
  if (!session) {
    return { error: { status: 401, data: { error: 'Invalid or expired session token.' } } };
  }
  return { session };
}

function startAPIServer(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method;
    const headers = req.headers;

    const allowedOrigin = process.env.CORS_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Token, X-Admin-Token');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/json');

    if (method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      let body = '';
      if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
        body = await new Promise((resolve, reject) => {
          let data = '';
          let size = 0;
          req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              req.destroy();
              reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
              return;
            }
            data += chunk;
          });
          req.on('end', () => resolve(data));
          req.on('error', reject);
        });
      }

      let json;
      try {
        json = body ? JSON.parse(body) : {};
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
      const response = await handleRoute(method, path, json, url.searchParams, headers);
      res.writeHead(response.status || 200);
      res.end(JSON.stringify(response.data, null, 2));
    } catch (err) {
      const status = err.statusCode || 500;
      res.writeHead(status);
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.keepAliveTimeout = enterpriseConfig.performance.httpKeepAliveMs;
  server.requestTimeout = enterpriseConfig.performance.requestTimeoutMs;

  server.listen(port, () => {
    logger.success('API', `REST API running on http://localhost:${port}`);
    logger.info('API', 'Endpoints:');
    console.log('  GET  /api/v1/health');
    console.log('  GET  /api/v1/microservices');
    console.log('  GET  /api/v1/aws/readiness');
    console.log('  GET  /api/v1/users?limit=20');
    console.log('  POST /api/v1/auth/otp/request');
    console.log('  POST /api/v1/auth/otp/verify');
    console.log('  GET  /api/v1/auth/stats');
    console.log('  GET  /api/v1/drivers');
    console.log('  GET  /api/v1/drivers/nearby?lat=X&lng=Y&radius=Z');
    console.log('  PUT  /api/v1/drivers/:id/location');
    console.log('  POST /api/v1/rides/request');
    console.log('  POST /api/v1/rides/:id/cancel');
    console.log('  POST /api/v1/rides/:id/arrived');
    console.log('  POST /api/v1/rides/:id/start');
    console.log('  POST /api/v1/rides/:id/complete');
    console.log('  GET  /api/v1/rides');
    console.log('  GET  /api/v1/rides/:id');
    console.log('  POST /api/v1/fare/estimate');
    console.log('  GET  /api/v1/surge/zones');
    console.log('  POST /api/v1/surge/update');
    console.log('  GET  /api/v1/events');
    console.log('  GET  /api/v1/stats');
    console.log('  GET  /api/v1/formulas/haversine?lat1=X&lng1=Y&lat2=X&lng2=Y');
    console.log('  GET  /api/v1/formulas/bearing?lat1=X&lng1=Y&lat2=X&lng2=Y');
    console.log('  POST /api/v1/users/:id/device-token');
    console.log('  DELETE /api/v1/users/:id/device-token');
    console.log('  --- Rider Wallet (Coins + Cash) ---');
    console.log('  GET  /api/v1/wallet/:userId/balance');
    console.log('  GET  /api/v1/wallet/:userId/transactions');
    console.log('  POST /api/v1/wallet/:userId/topup           { amount, method, referenceId? }');
    console.log('  POST /api/v1/wallet/:userId/pay             { fareInr, rideId }');
    console.log('  POST /api/v1/wallet/:userId/refund          { amount, rideId, reason? }');
    console.log('  POST /api/v1/wallet/:userId/redeem          { fareInr, coinsToUse? }');
    console.log('  --- Driver Wallet (min ₹300 gate) ---');
    console.log('  GET  /api/v1/driver-wallet/:driverId/balance');
    console.log('  GET  /api/v1/driver-wallet/:driverId/transactions');
    console.log('  GET  /api/v1/driver-wallet/:driverId/eligibility');
    console.log('  POST /api/v1/driver-wallet/:driverId/recharge  { amount, method }');
    console.log('  --- Pool / Demand Aggregation ---');
    console.log('  POST /api/v1/pool/match                     { riderId, pickupLat, pickupLng, destLat, destLng, fareInr }');
    console.log('  POST /api/v1/pool                           { riderId, pickupLat, pickupLng, destLat, destLng, fareInr }');
    console.log('  GET  /api/v1/pool/:poolId');
    console.log('  POST /api/v1/pool/:poolId/join              { riderId, pickupLat, pickupLng }');
    console.log('  POST /api/v1/pool/:poolId/leave             { riderId }');
    console.log('  GET  /api/v1/riders/:riderId/pools');
    console.log('  --- Demand Analytics (Heatmap + Timeline + Logs) ---');
    console.log('  GET  /api/v1/demand/heatmap                 Current area demand map (HOT zones)');
    console.log('  GET  /api/v1/demand/areas/hot?limit=10      Top N high-demand areas right now');
    console.log('  GET  /api/v1/demand/timeline?hours=6        15-min bucket demand for last N hours');
    console.log('  GET  /api/v1/demand/stats                   Real-time supply vs demand summary');
    console.log('  --- Driver Incentives ---');
    console.log('  GET  /api/v1/incentives?activeOnly=true');
    console.log('  GET  /api/v1/incentives/:taskId');
    console.log('  POST /api/v1/incentives/:taskId/enrol       { driverId }');
    console.log('  POST /api/v1/incentives/:taskId/claim       { driverId }');
    console.log('  GET  /api/v1/incentives/:taskId/leaderboard');
    console.log('  GET  /api/v1/drivers/:driverId/incentives');
    console.log('  --- Chat Ticket System ---');
    console.log('  POST /api/v1/tickets                        { userId, userType, subject, message, category?, rideId?, priority? }');
    console.log('  GET  /api/v1/tickets/:ticketId');
    console.log('  POST /api/v1/tickets/:ticketId/messages     { senderId, senderRole, content }');
    console.log('  PUT  /api/v1/tickets/:ticketId/read         { readBy }');
    console.log('  GET  /api/v1/users/:userId/tickets');
    console.log('  --- Ride Session Recovery (App Kill Resume) ---');
    console.log('  GET  /api/v1/riders/:riderId/active-ride    Check if rider has an in-progress ride');
    console.log('  POST /api/v1/riders/:riderId/restore        Full ride + driver snapshot for app recovery');
    console.log('  POST /api/v1/riders/:riderId/heartbeat      { rideId? } Keepalive ping every 30s');
    console.log('  --- SOS / Safety ---');
    console.log('  POST /api/v1/sos                            { userId, userType, rideId?, lat, lng, sosType? }');
    console.log('  GET  /api/v1/sos/:sosId');
    console.log('  POST /api/v1/sos/:sosId/location            { lat, lng }');
    console.log('  GET  /api/v1/users/:userId/sos/active');
    console.log('  --- Admin (requires X-Admin-Token header) ---');
    console.log('  GET    /api/v1/admin/zones');
    console.log('  POST   /api/v1/admin/zones');
    console.log('  PUT    /api/v1/admin/zones/:id/enable');
    console.log('  PUT    /api/v1/admin/zones/:id/disable');
    console.log('  DELETE /api/v1/admin/zones/:id');
    console.log('  GET    /api/v1/admin/notifications/stats');
    console.log('  GET    /api/v1/admin/sos');
    console.log('  PUT    /api/v1/admin/sos/:sosId/status      { status, resolvedBy?, resolutionNote? }');
    console.log('  GET    /api/v1/admin/sos/stats');
    console.log('  POST   /api/v1/admin/wallet/:userId/adjust          { coins, reason }');
    console.log('  POST   /api/v1/admin/wallet/:userId/adjust-cash     { amount, reason }');
    console.log('  GET    /api/v1/admin/wallet/stats');
    console.log('  POST   /api/v1/admin/driver-wallet/:driverId/adjust { amount, reason }');
    console.log('  GET    /api/v1/admin/driver-wallet/stats');
    console.log('  GET    /api/v1/admin/demand/logs?type=no_match_found&limit=100');
    console.log('  GET    /api/v1/admin/demand/logs/summary    Count by scenario type');
    console.log('  GET    /api/v1/admin/demand/areas           All areas with full metrics');
    console.log('  GET    /api/v1/admin/demand/peak-hours      Time slots sorted by demand');
    console.log('  GET    /api/v1/admin/demand/no-match-analysis  Why pool matches fail + recommendations');
    console.log('  GET    /api/v1/admin/demand/timeline?hours=24');
    console.log('  POST   /api/v1/admin/demand/snapshot        Trigger manual area snapshot');
    console.log('  GET    /api/v1/admin/pool?status=OPEN');
    console.log('  POST   /api/v1/admin/pool/:poolId/dispatch          { driverId }');
    console.log('  PUT    /api/v1/admin/pool/:poolId/status            { status }');
    console.log('  GET    /api/v1/admin/pool/stats');
    console.log('  POST   /api/v1/admin/incentives                     { title, type, targetValue, rewardAmount, startDate, endDate }');
    console.log('  GET    /api/v1/admin/incentives');
    console.log('  PUT    /api/v1/admin/incentives/:taskId             { status, rewardAmount, ... }');
    console.log('  DELETE /api/v1/admin/incentives/:taskId');
    console.log('  GET    /api/v1/admin/incentives/stats');
    console.log('  GET    /api/v1/admin/incentives/:taskId/leaderboard');
    console.log('  GET    /api/v1/admin/tickets?status=OPEN');
    console.log('  PUT    /api/v1/admin/tickets/:ticketId/status       { status, resolution? }');
    console.log('  PUT    /api/v1/admin/tickets/:ticketId/assign       { agentId }');
    console.log('  GET    /api/v1/admin/tickets/stats');
    console.log('  GET    /api/v1/admin/tickets/agents');
    console.log('  POST   /api/v1/admin/tickets/agents                 { agentId, name, email }');
    console.log('  GET    /api/v1/admin/sms/stats');
    console.log('');
  });

  return server;
}

async function handleRoute(method, path, body, params, headers = {}) {
  if (path === '/api/v1/health') {
    return {
      data: {
        status: 'ok',
        service: 'GoApp Ride Matching Platform',
        version: '2.2',
        uptime: process.uptime(),
        runtime: enterpriseConfig.runtime,
        redis: redis.getStats(),
        identity: identityService.getStats(),
        location: locationService.getStats(),
        pricing: pricingService.getStats(),
        rides: rideService.getStats(),
        mockDb: mockDb.getStats(),
        notifications: notificationService.getStats(),
        wallet: walletService.getStats(),
        driverWallet: driverWalletService.getStats(),
        demandAggregation: demandAggregationService.getStats(),
        demandLog: demandLogService.getStats(),
        incentives: incentiveService.getStats(),
        tickets: ticketService.getStats(),
        rideSession: rideSessionService.getStats(),
        sos: sosService.getStats(),
        sms: smsService.getStats(),
      },
    };
  }

  if (path === '/api/v1/microservices' && method === 'GET') {
    return { data: enterpriseConfig.microservices };
  }

  if (path === '/api/v1/aws/readiness' && method === 'GET') {
    return {
      data: {
        runtime: enterpriseConfig.runtime,
        aws: enterpriseConfig.aws,
        checks: {
          canRunWithoutDatabase: true,
          eventBusBuffered: true,
          inMemoryTestDataSeeded: Boolean(mockDb.getStats().seedMeta),
        },
      },
    };
  }

  if (path === '/api/v1/users' && method === 'GET') {
    const limit = Number(params.get('limit') || 20);
    return { data: { users: identityService.getUsers(limit) } };
  }

  if (path === '/api/v1/auth/stats' && method === 'GET') {
    return { data: identityService.getStats() };
  }

  if (path === '/api/v1/auth/otp/request' && method === 'POST') {
    const result = identityService.requestOtp(body);
    return { status: result.success ? 200 : 400, data: result };
  }

  if (path === '/api/v1/auth/otp/verify' && method === 'POST') {
    const result = identityService.verifyOtp(body);
    return { status: result.success ? 200 : 400, data: result };
  }

  if (path === '/api/v1/drivers' && method === 'GET') {
    return { data: { drivers: locationService.getAllTracked() } };
  }

  if (path === '/api/v1/drivers/nearby' && method === 'GET') {
    const lat = parseFloat(params.get('lat'));
    const lng = parseFloat(params.get('lng'));
    const radius = parseFloat(params.get('radius') || '5');

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { status: 400, data: { error: 'lat and lng required' } };
    }

    const nearby = locationService.findNearby(lat, lng, radius, 20);
    return { data: { count: nearby.length, drivers: nearby } };
  }

  if (path.match(/^\/api\/v1\/drivers\/(.+)\/location$/) && method === 'PUT') {
    const driverId = path.split('/')[4];
    const result = locationService.updateLocation(driverId, body);
    return { data: result };
  }

  if (path === '/api/v1/rides/request' && method === 'POST') {
    const pickupLat = parseFloat(body.pickupLat);
    const pickupLng = parseFloat(body.pickupLng);

    if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
      const zoneCheck = zoneService.checkPickup(pickupLat, pickupLng);
      if (!zoneCheck.allowed) {
        return { status: 403, data: { error: zoneCheck.message, reason: zoneCheck.reason } };
      }
    }

    // Optional: preview coin redemption discount before creating ride
    let coinRedemptionPreview = null;
    if (body.useCoins && body.riderId) {
      const estimates = pricingService.getEstimates(pickupLat, pickupLng, parseFloat(body.destLat), parseFloat(body.destLng));
      const rideType = body.rideType || 'sedan';
      const estimatedFare = estimates.estimates[rideType]?.finalFare;
      if (estimatedFare) {
        const balance = walletService.getBalance(body.riderId);
        coinRedemptionPreview = {
          coinsAvailable: balance.balance,
          maxDiscountInr: Math.round(Math.min(balance.balance, Math.floor(estimatedFare * 0.20 / 0.10)) * 0.10 * 100) / 100,
        };
      }
    }

    // Record raw demand for area heatmap + time-series
    if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
      demandLogService.recordDemand(pickupLat, pickupLng, 'ride_requested');
      demandLogService.recordTimeslot('ride_requested');
      demandLogService.logScenario('ride_requested', {
        riderId:    body.riderId,
        pickupLat,
        pickupLng,
        destLat:    parseFloat(body.destLat),
        destLng:    parseFloat(body.destLng),
        rideType:   body.rideType || 'sedan',
        useCoins:   !!body.useCoins,
        usedPool:   !!body.poolId,
        outcome:    'requested',
      });
    }

    const result = await rideService.createRide({
      ...body,
      idempotencyKey: body.idempotencyKey || crypto.randomUUID(),
    });

    if (coinRedemptionPreview) result.coinRedemptionPreview = coinRedemptionPreview;
    return { data: result };
  }

  if (path === '/api/v1/rides' && method === 'GET') {
    return { data: { rides: rideService.getAllRides() } };
  }

  if (path.match(/^\/api\/v1\/rides\/(.+)\/cancel$/) && method === 'POST') {
    const rideId = path.split('/')[4];
    const result = rideService.cancelRide(rideId, body.cancelledBy, body.userId);
    return { data: result };
  }

  if (path.match(/^\/api\/v1\/rides\/(.+)\/arrived$/) && method === 'POST') {
    const rideId = path.split('/')[4];
    const ride = rideService.driverArrived(rideId);
    return { data: ride ? { status: ride.status, rideId } : { error: 'Invalid state' } };
  }

  if (path.match(/^\/api\/v1\/rides\/(.+)\/start$/) && method === 'POST') {
    const rideId = path.split('/')[4];
    const ride = rideService.startTrip(rideId);
    return { data: ride ? { status: ride.status, rideId } : { error: 'Invalid state' } };
  }

  if (path.match(/^\/api\/v1\/rides\/(.+)\/complete$/) && method === 'POST') {
    const rideId = path.split('/')[4];
    const result = rideService.completeTrip(rideId, body.distanceKm, body.durationMin);
    if (!result) return { data: { error: 'Invalid state' } };

    // Optional coin redemption (deduct coins from rider's balance for discount)
    let coinRedemption = null;
    const ride = rideService.getRide(rideId);
    if (ride && body.useCoins && ride.riderId) {
      const fareInr = result.fare?.finalFare;
      if (fareInr) {
        const redemption = walletService.redeemCoins(ride.riderId, fareInr, body.coinsToUse);
        if (redemption.success) {
          result.fare.finalFareAfterCoins = redemption.finalFare;
          result.fare.coinDiscount = redemption.discountInr;
          coinRedemption = redemption;
        }
      }
    }

    // Earn coins for this ride (always — on the original fare)
    if (ride && ride.riderId) {
      const earnFare = result.fare?.finalFare;
      const earnResult = walletService.earnCoins(ride.riderId, earnFare, rideId);
      if (earnResult) result.coinsEarned = earnResult.coins;
    }

    // Release demand from area (ride fulfilled)
    if (ride) {
      const pLat = ride.pickupLat || body.pickupLat;
      const pLng = ride.pickupLng || body.pickupLng;
      if (pLat && pLng) {
        demandLogService.releaseRequest(pLat, pLng);
        demandLogService.recordTimeslot('ride_completed');
        demandLogService.logScenario('ride_completed', {
          rideId,
          riderId:     ride.riderId,
          driverId:    ride.driverId,
          fareInr:     result.fare?.finalFare,
          distanceKm:  body.distanceKm,
          durationMin: body.durationMin,
          pickupLat:   pLat,
          pickupLng:   pLng,
          outcome:     'completed',
        });
      }
    }

    // Update driver incentive progress on ride completion
    if (ride && ride.driverId) {
      const fareInr = result.fare?.finalFare || 0;
      const now = new Date();
      const hour = now.getHours();
      const isPeakHour = (hour >= 7 && hour <= 10) || (hour >= 17 && hour <= 21);
      const incentiveUpdates = incentiveService.onRideCompleted(ride.driverId, { fareInr, isPeakHour });
      if (incentiveUpdates.length > 0) result.incentiveProgress = incentiveUpdates;
    }

    if (coinRedemption) result.coinRedemption = coinRedemption;
    return { data: result };
  }

  if (path.match(/^\/api\/v1\/rides\/(.+)$/) && method === 'GET') {
    const rideId = path.split('/')[4];
    const ride = rideService.getRide(rideId);
    return { data: ride || { error: 'Ride not found' } };
  }

  if (path === '/api/v1/fare/estimate' && method === 'POST') {
    const estimates = pricingService.getEstimates(body.pickupLat, body.pickupLng, body.destLat, body.destLng);
    return { data: estimates };
  }

  if (path === '/api/v1/surge/zones' && method === 'GET') {
    return { data: { zones: pricingService.getSurgeZones() } };
  }

  if (path === '/api/v1/surge/update' && method === 'POST') {
    const result = pricingService.updateSurge(body.zoneId, body.demand, body.supply);
    return { data: result };
  }

  if (path === '/api/v1/events' && method === 'GET') {
    const count = parseInt(params.get('count') || '20', 10);
    return { data: { events: eventBus.getRecentEvents(count) } };
  }

  if (path === '/api/v1/stats' && method === 'GET') {
    return {
      data: {
        redis: redis.getStats(),
        identity: identityService.getStats(),
        location: locationService.getStats(),
        pricing: pricingService.getStats(),
        rides: rideService.getStats(),
        events: { total: eventBus.events.length },
      },
    };
  }

  if (path === '/api/v1/formulas/haversine' && method === 'GET') {
    const lat1 = parseFloat(params.get('lat1'));
    const lng1 = parseFloat(params.get('lng1'));
    const lat2 = parseFloat(params.get('lat2'));
    const lng2 = parseFloat(params.get('lng2'));

    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) {
      return { status: 400, data: { error: 'lat1, lng1, lat2, lng2 required' } };
    }

    const dist = haversine(lat1, lng1, lat2, lng2);
    const bear = bearing(lat1, lng1, lat2, lng2);
    return {
      data: {
        from: { lat: lat1, lng: lng1 },
        to: { lat: lat2, lng: lng2 },
        distanceKm: Math.round(dist * 100) / 100,
        bearingDeg: Math.round(bear * 10) / 10,
        etaMin: Math.round((dist * 1.3 / config.scoring.avgCitySpeedKmh) * 60 * 10) / 10,
      },
    };
  }

  if (path === '/api/v1/formulas/bearing' && method === 'GET') {
    const lat1 = parseFloat(params.get('lat1'));
    const lng1 = parseFloat(params.get('lng1'));
    const lat2 = parseFloat(params.get('lat2'));
    const lng2 = parseFloat(params.get('lng2'));

    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) {
      return { status: 400, data: { error: 'lat1, lng1, lat2, lng2 required' } };
    }

    return { data: { bearingDeg: Math.round(bearing(lat1, lng1, lat2, lng2) * 10) / 10 } };
  }

  // ═══════════════════════════════════════════
  // DEVICE TOKEN — FCM registration
  // ═══════════════════════════════════════════

  // POST /api/v1/users/:id/device-token  { token, platform }
  const tokenRegMatch = path.match(/^\/api\/v1\/users\/(.+)\/device-token$/);
  if (tokenRegMatch && method === 'POST') {
    const userId = tokenRegMatch[1];
    const result = notificationService.registerToken(userId, body.token, body.platform);
    return { status: result.success ? 200 : 400, data: result };
  }

  // DELETE /api/v1/users/:id/device-token
  const tokenDelMatch = path.match(/^\/api\/v1\/users\/(.+)\/device-token$/);
  if (tokenDelMatch && method === 'DELETE') {
    notificationService.removeToken(tokenDelMatch[1]);
    return { data: { success: true } };
  }

  // ═══════════════════════════════════════════
  // ADMIN: Service Zone Management
  // All routes require X-Admin-Token header
  // ═══════════════════════════════════════════

  if (path.startsWith('/api/v1/admin/zones')) {
    const authErr = requireAdmin(headers);
    if (authErr) return authErr;

    // GET /api/v1/admin/zones — list all zones
    if (path === '/api/v1/admin/zones' && method === 'GET') {
      const zones = zoneService.listZones();
      return { data: { zones, stats: zoneService.getStats() } };
    }

    // POST /api/v1/admin/zones — create a zone
    if (path === '/api/v1/admin/zones' && method === 'POST') {
      const result = zoneService.createZone({
        name: body.name,
        lat: parseFloat(body.lat),
        lng: parseFloat(body.lng),
        radiusKm: parseFloat(body.radiusKm),
      });
      return { status: result.success ? 201 : 400, data: result };
    }

    // PUT /api/v1/admin/zones/:id/enable — enable a zone
    const enableMatch = path.match(/^\/api\/v1\/admin\/zones\/(.+)\/enable$/);
    if (enableMatch && method === 'PUT') {
      const result = zoneService.setZoneEnabled(enableMatch[1], true);
      return { status: result.success ? 200 : 404, data: result };
    }

    // PUT /api/v1/admin/zones/:id/disable — disable a zone
    const disableMatch = path.match(/^\/api\/v1\/admin\/zones\/(.+)\/disable$/);
    if (disableMatch && method === 'PUT') {
      const result = zoneService.setZoneEnabled(disableMatch[1], false);
      return { status: result.success ? 200 : 404, data: result };
    }

    // DELETE /api/v1/admin/zones/:id — delete a zone
    const deleteMatch = path.match(/^\/api\/v1\/admin\/zones\/(.+)$/);
    if (deleteMatch && method === 'DELETE') {
      const result = zoneService.deleteZone(deleteMatch[1]);
      return { status: result.success ? 200 : 404, data: result };
    }

    // GET /api/v1/admin/notifications/stats — FCM token registry
    if (path === '/api/v1/admin/notifications/stats' && method === 'GET') {
      return { data: notificationService.getStats() };
    }
  }

  // ═══════════════════════════════════════════
  // WALLET / COINS
  // ═══════════════════════════════════════════

  // GET /api/v1/wallet/:userId — get coin balance
  const walletBalanceMatch = path.match(/^\/api\/v1\/wallet\/(.+)\/balance$/);
  if (walletBalanceMatch && method === 'GET') {
    const userId = walletBalanceMatch[1];
    return { data: walletService.getBalance(userId) };
  }

  // GET /api/v1/wallet/:userId/transactions — transaction history
  const walletTxnMatch = path.match(/^\/api\/v1\/wallet\/(.+)\/transactions$/);
  if (walletTxnMatch && method === 'GET') {
    const userId = walletTxnMatch[1];
    const limit = parseInt(params.get('limit') || '20', 10);
    return { data: walletService.getTransactions(userId, Math.min(limit, 100)) };
  }

  // POST /api/v1/wallet/:userId/redeem — redeem coins for discount
  const walletRedeemMatch = path.match(/^\/api\/v1\/wallet\/(.+)\/redeem$/);
  if (walletRedeemMatch && method === 'POST') {
    const userId = walletRedeemMatch[1];
    const { fareInr, coinsToUse } = body;
    if (!fareInr || fareInr <= 0) return { status: 400, data: { error: 'fareInr required' } };
    const result = walletService.redeemCoins(userId, fareInr, coinsToUse);
    return { status: result.success ? 200 : 400, data: result };
  }

  // POST /api/v1/admin/wallet/:userId/adjust — admin coin adjustment
  if (path.match(/^\/api\/v1\/admin\/wallet\/(.+)\/adjust$/) && method === 'POST') {
    const authErr = requireAdmin(headers);
    if (authErr) return authErr;
    const userId = path.split('/')[5];
    const { coins, reason } = body;
    if (typeof coins !== 'number') return { status: 400, data: { error: 'coins (number) required' } };
    return { data: walletService.adjustCoins(userId, coins, reason || 'admin adjustment') };
  }

  // GET /api/v1/admin/wallet/stats
  if (path === '/api/v1/admin/wallet/stats' && method === 'GET') {
    const authErr = requireAdmin(headers);
    if (authErr) return authErr;
    return { data: walletService.getStats() };
  }

  // ═══════════════════════════════════════════
  // SOS / SAFETY
  // ═══════════════════════════════════════════

  // POST /api/v1/sos — trigger SOS
  if (path === '/api/v1/sos' && method === 'POST') {
    const result = sosService.triggerSos(body);
    return { status: result.success ? 200 : 400, data: result };
  }

  // GET /api/v1/sos/:sosId — get SOS details
  const sosGetMatch = path.match(/^\/api\/v1\/sos\/([^/]+)$/);
  if (sosGetMatch && method === 'GET') {
    const sos = sosService.getSos(sosGetMatch[1]);
    return { data: sos || { error: 'SOS not found' } };
  }

  // POST /api/v1/sos/:sosId/location — update live location during SOS
  const sosLocationMatch = path.match(/^\/api\/v1\/sos\/(.+)\/location$/);
  if (sosLocationMatch && method === 'POST') {
    const result = sosService.updateLocation(sosLocationMatch[1], body);
    return { status: result.success ? 200 : 400, data: result };
  }

  // GET /api/v1/users/:userId/sos/active — get active SOS for a user
  const userActiveSosMatch = path.match(/^\/api\/v1\/users\/(.+)\/sos\/active$/);
  if (userActiveSosMatch && method === 'GET') {
    const sos = sosService.getActiveSos(userActiveSosMatch[1]);
    return { data: sos || { active: false } };
  }

  // Admin SOS routes
  if (path.startsWith('/api/v1/admin/sos')) {
    const authErr = requireAdmin(headers);
    if (authErr) return authErr;

    // GET /api/v1/admin/sos — list all SOS logs
    if (path === '/api/v1/admin/sos' && method === 'GET') {
      const status = params.get('status') || undefined;
      const limit = parseInt(params.get('limit') || '50', 10);
      return { data: { sosList: sosService.getAllSos({ status, limit: Math.min(limit, 200) }) } };
    }

    // PUT /api/v1/admin/sos/:sosId/status — update SOS status
    const sosStatusMatch = path.match(/^\/api\/v1\/admin\/sos\/(.+)\/status$/);
    if (sosStatusMatch && method === 'PUT') {
      const result = sosService.updateStatus(sosStatusMatch[1], body);
      return { status: result.success ? 200 : 400, data: result };
    }

    // GET /api/v1/admin/sos/stats
    if (path === '/api/v1/admin/sos/stats' && method === 'GET') {
      return { data: sosService.getStats() };
    }
  }

  // ═══════════════════════════════════════════
  // SMS SERVICE STATS (Admin)
  // ═══════════════════════════════════════════
  if (path === '/api/v1/admin/sms/stats' && method === 'GET') {
    const authErr = requireAdmin(headers);
    if (authErr) return authErr;
    return { data: smsService.getStats() };
  }

  // ═══════════════════════════════════════════
  // RIDER WALLET — Cash topup + Pay with wallet
  // ═══════════════════════════════════════════

  // POST /api/v1/wallet/:userId/topup  { amount, method, referenceId? }
  const walletTopupMatch = path.match(/^\/api\/v1\/wallet\/(.+)\/topup$/);
  if (walletTopupMatch && method === 'POST') {
    const userId = walletTopupMatch[1];
    const { amount, method: payMethod = 'upi', referenceId } = body;
    if (!amount || amount <= 0) return { status: 400, data: { error: 'amount required and must be > 0' } };
    const result = walletService.topupWallet(userId, parseFloat(amount), payMethod, referenceId);
    return { status: result.success ? 200 : 400, data: result };
  }

  // POST /api/v1/wallet/:userId/pay  { fareInr, rideId }
  const walletPayMatch = path.match(/^\/api\/v1\/wallet\/(.+)\/pay$/);
  if (walletPayMatch && method === 'POST') {
    const userId = walletPayMatch[1];
    const { fareInr, rideId } = body;
    if (!fareInr || fareInr <= 0) return { status: 400, data: { error: 'fareInr required' } };
    const result = walletService.payWithWallet(userId, parseFloat(fareInr), rideId);
    return { status: result.success ? 200 : 400, data: result };
  }

  // POST /api/v1/wallet/:userId/refund  { amount, rideId, reason? }
  const walletRefundMatch = path.match(/^\/api\/v1\/wallet\/(.+)\/refund$/);
  if (walletRefundMatch && method === 'POST') {
    const userId = walletRefundMatch[1];
    const { amount, rideId, reason } = body;
    if (!amount || amount <= 0) return { status: 400, data: { error: 'amount required' } };
    const result = walletService.refundToWallet(userId, parseFloat(amount), rideId, reason);
    return { status: result.success ? 200 : 400, data: result };
  }

  // POST /api/v1/admin/wallet/:userId/adjust-cash  { amount, reason }
  if (path.match(/^\/api\/v1\/admin\/wallet\/(.+)\/adjust-cash$/) && method === 'POST') {
    const authErr = requireAdmin(headers);
    if (authErr) return authErr;
    const userId = path.split('/')[5];
    const { amount, reason } = body;
    if (typeof amount !== 'number') return { status: 400, data: { error: 'amount (number) required' } };
    return { data: walletService.adjustCash(userId, amount, reason || 'admin adjustment') };
  }

  // ═══════════════════════════════════════════
  // DRIVER WALLET — Balance gate ≥ ₹300
  // ═══════════════════════════════════════════

  // GET /api/v1/driver-wallet/:driverId/balance
  const drvWalletBalMatch = path.match(/^\/api\/v1\/driver-wallet\/(.+)\/balance$/);
  if (drvWalletBalMatch && method === 'GET') {
    return { data: driverWalletService.getBalance(drvWalletBalMatch[1]) };
  }

  // GET /api/v1/driver-wallet/:driverId/transactions?limit=20
  const drvWalletTxnMatch = path.match(/^\/api\/v1\/driver-wallet\/(.+)\/transactions$/);
  if (drvWalletTxnMatch && method === 'GET') {
    const limit = parseInt(params.get('limit') || '20', 10);
    return { data: driverWalletService.getTransactions(drvWalletTxnMatch[1], Math.min(limit, 100)) };
  }

  // POST /api/v1/driver-wallet/:driverId/recharge  { amount, method, referenceId? }
  const drvRechargeMatch = path.match(/^\/api\/v1\/driver-wallet\/(.+)\/recharge$/);
  if (drvRechargeMatch && method === 'POST') {
    const driverId = drvRechargeMatch[1];
    const { amount, method: payMethod = 'upi', referenceId } = body;
    if (!amount || amount <= 0) return { status: 400, data: { error: 'amount required and must be > 0' } };
    const result = driverWalletService.rechargeWallet(driverId, parseFloat(amount), payMethod, referenceId);
    return { status: result.success ? 200 : 400, data: result };
  }

  // GET /api/v1/driver-wallet/:driverId/eligibility — can driver receive rides?
  const drvEligibleMatch = path.match(/^\/api\/v1\/driver-wallet\/(.+)\/eligibility$/);
  if (drvEligibleMatch && method === 'GET') {
    return { data: driverWalletService.canReceiveRide(drvEligibleMatch[1]) };
  }

  // POST /api/v1/admin/driver-wallet/:driverId/adjust  { amount, reason }
  if (path.match(/^\/api\/v1\/admin\/driver-wallet\/(.+)\/adjust$/) && method === 'POST') {
    const authErr = requireAdmin(headers);
    if (authErr) return authErr;
    const driverId = path.split('/')[5];
    const { amount, reason } = body;
    if (typeof amount !== 'number') return { status: 400, data: { error: 'amount (number) required' } };
    return { data: driverWalletService.adminAdjust(driverId, amount, reason || 'admin adjustment') };
  }

  // GET /api/v1/admin/driver-wallet/stats
  if (path === '/api/v1/admin/driver-wallet/stats' && method === 'GET') {
    const authErr = requireAdmin(headers);
    if (authErr) return authErr;
    return { data: driverWalletService.getStats() };
  }

  // ═══════════════════════════════════════════
  // DEMAND AGGREGATION — Pool Rides
  // ═══════════════════════════════════════════

  // POST /api/v1/pool/match  { riderId, pickupLat, pickupLng, destLat, destLng, fareInr, rideType? }
  if (path === '/api/v1/pool/match' && method === 'POST') {
    const { riderId, pickupLat, pickupLng, destLat, destLng, fareInr, rideType } = body;
    if (!riderId || !pickupLat || !pickupLng || !destLat || !destLng || !fareInr) {
      return { status: 400, data: { error: 'riderId, pickupLat, pickupLng, destLat, destLng, fareInr required' } };
    }
    const result = demandAggregationService.smartMatch({
      riderId,
      pickupLat: parseFloat(pickupLat),
      pickupLng: parseFloat(pickupLng),
      destLat: parseFloat(destLat),
      destLng: parseFloat(destLng),
      fareInr: parseFloat(fareInr),
      rideType,
    });
    return { data: result };
  }

  // POST /api/v1/pool  { riderId, pickupLat, pickupLng, destLat, destLng, fareInr, rideType? }
  if (path === '/api/v1/pool' && method === 'POST') {
    const result = demandAggregationService.createPool(body);
    return { status: result.success ? 201 : 400, data: result };
  }

  // GET /api/v1/pool/:poolId
  const poolGetMatch = path.match(/^\/api\/v1\/pool\/([^/]+)$/);
  if (poolGetMatch && method === 'GET') {
    const pool = demandAggregationService.getPool(poolGetMatch[1]);
    return { data: pool || { error: 'Pool not found' } };
  }

  // POST /api/v1/pool/:poolId/join  { riderId, pickupLat, pickupLng }
  const poolJoinMatch = path.match(/^\/api\/v1\/pool\/(.+)\/join$/);
  if (poolJoinMatch && method === 'POST') {
    const result = demandAggregationService.joinPool(poolJoinMatch[1], body);
    return { status: result.success ? 200 : 400, data: result };
  }

  // POST /api/v1/pool/:poolId/leave  { riderId }
  const poolLeaveMatch = path.match(/^\/api\/v1\/pool\/(.+)\/leave$/);
  if (poolLeaveMatch && method === 'POST') {
    const result = demandAggregationService.leavePool(poolLeaveMatch[1], body.riderId);
    return { status: result.success ? 200 : 400, data: result };
  }

  // GET /api/v1/riders/:riderId/pools
  const riderPoolsMatch = path.match(/^\/api\/v1\/riders\/(.+)\/pools$/);
  if (riderPoolsMatch && method === 'GET') {
    return { data: { pools: demandAggregationService.getRiderPools(riderPoolsMatch[1]) } };
  }

  // Admin pool routes
  if (path.startsWith('/api/v1/admin/pool')) {
    const authErr = requireAdmin(headers);
    if (authErr) return authErr;

    // GET /api/v1/admin/pool?status=OPEN&limit=50
    if (path === '/api/v1/admin/pool' && method === 'GET') {
      const status = params.get('status') || undefined;
      const limit = parseInt(params.get('limit') || '50', 10);
      return { data: { pools: demandAggregationService.listPools({ status, limit: Math.min(limit, 200) }) } };
    }

    // POST /api/v1/admin/pool/:poolId/dispatch  { driverId, rideId? }
    const poolDispatchMatch = path.match(/^\/api\/v1\/admin\/pool\/(.+)\/dispatch$/);
    if (poolDispatchMatch && method === 'POST') {
      const result = demandAggregationService.dispatchDriver(poolDispatchMatch[1], body.driverId, body.rideId);
      return { status: result.success ? 200 : 400, data: result };
    }

    // PUT /api/v1/admin/pool/:poolId/status  { status }
    const poolStatusMatch = path.match(/^\/api\/v1\/admin\/pool\/(.+)\/status$/);
    if (poolStatusMatch && method === 'PUT') {
      const result = demandAggregationService.updateStatus(poolStatusMatch[1], body.status);
      return { status: result.success ? 200 : 400, data: result };
    }

    // GET /api/v1/admin/pool/stats
    if (path === '/api/v1/admin/pool/stats' && method === 'GET') {
      return { data: demandAggregationService.getStats() };
    }
  }

  // ═══════════════════════════════════════════
  // DRIVER INCENTIVES — Tasks & Progress
  // ═══════════════════════════════════════════

  // GET /api/v1/incentives?activeOnly=true&type=trip_count
  if (path === '/api/v1/incentives' && method === 'GET') {
    const activeOnly = params.get('activeOnly') === 'true';
    const type = params.get('type') || null;
    const limit = parseInt(params.get('limit') || '50', 10);
    return { data: { tasks: incentiveService.listTasks({ activeOnly, type, limit: Math.min(limit, 200) }) } };
  }

  // GET /api/v1/incentives/:taskId
  const incentiveGetMatch = path.match(/^\/api\/v1\/incentives\/([^/]+)$/);
  if (incentiveGetMatch && method === 'GET') {
    const task = incentiveService.getTask(incentiveGetMatch[1]);
    return { data: task || { error: 'Task not found' } };
  }

  // POST /api/v1/incentives/:taskId/enrol  { driverId }
  const incentiveEnrolMatch = path.match(/^\/api\/v1\/incentives\/(.+)\/enrol$/);
  if (incentiveEnrolMatch && method === 'POST') {
    const result = incentiveService.enrolDriver(body.driverId, incentiveEnrolMatch[1]);
    return { status: result.success ? 200 : 400, data: result };
  }

  // POST /api/v1/incentives/:taskId/claim  { driverId }
  const incentiveClaimMatch = path.match(/^\/api\/v1\/incentives\/(.+)\/claim$/);
  if (incentiveClaimMatch && method === 'POST') {
    const { driverId } = body;
    if (!driverId) return { status: 400, data: { error: 'driverId required' } };
    const result = incentiveService.claimReward(driverId, incentiveClaimMatch[1]);
    if (!result.success) return { status: 400, data: result };

    // Credit reward to driver wallet
    let walletResult = null;
    if (result.rewardType === 'cash' && result.rewardAmount > 0) {
      walletResult = driverWalletService.creditIncentive(driverId, result.rewardAmount, incentiveClaimMatch[1], result.task.title);
    } else if (result.rewardType === 'coins' && result.rewardCoins > 0) {
      walletResult = walletService.adjustCoins(driverId, result.rewardCoins, `Incentive: ${result.task.title}`);
    }

    return { data: { ...result, walletCredit: walletResult } };
  }

  // GET /api/v1/drivers/:driverId/incentives — driver's progress on enrolled tasks
  const driverIncentivesMatch = path.match(/^\/api\/v1\/drivers\/(.+)\/incentives$/);
  if (driverIncentivesMatch && method === 'GET') {
    return { data: { progress: incentiveService.getDriverProgress(driverIncentivesMatch[1]) } };
  }

  // GET /api/v1/incentives/:taskId/leaderboard?limit=20
  const incentiveLeaderboardMatch = path.match(/^\/api\/v1\/incentives\/(.+)\/leaderboard$/);
  if (incentiveLeaderboardMatch && method === 'GET') {
    const limit = parseInt(params.get('limit') || '20', 10);
    return { data: { leaderboard: incentiveService.getTaskLeaderboard(incentiveLeaderboardMatch[1], Math.min(limit, 100)) } };
  }

  // Admin incentive routes
  if (path.startsWith('/api/v1/admin/incentives')) {
    const authErr = requireAdmin(headers);
    if (authErr) return authErr;

    // POST /api/v1/admin/incentives  — create task
    if (path === '/api/v1/admin/incentives' && method === 'POST') {
      const result = incentiveService.createTask({ ...body, createdBy: 'admin' });
      return { status: result.success ? 201 : 400, data: result };
    }

    // GET /api/v1/admin/incentives  — list all tasks
    if (path === '/api/v1/admin/incentives' && method === 'GET') {
      const limit = parseInt(params.get('limit') || '50', 10);
      return { data: { tasks: incentiveService.listTasks({ limit: Math.min(limit, 500) }) } };
    }

    // PUT /api/v1/admin/incentives/:taskId  — update task
    const adminIncentiveUpdateMatch = path.match(/^\/api\/v1\/admin\/incentives\/([^/]+)$/);
    if (adminIncentiveUpdateMatch && method === 'PUT') {
      const result = incentiveService.updateTask(adminIncentiveUpdateMatch[1], body);
      return { status: result.success ? 200 : 400, data: result };
    }

    // DELETE /api/v1/admin/incentives/:taskId
    const adminIncentiveDeleteMatch = path.match(/^\/api\/v1\/admin\/incentives\/([^/]+)$/);
    if (adminIncentiveDeleteMatch && method === 'DELETE') {
      const result = incentiveService.deleteTask(adminIncentiveDeleteMatch[1]);
      return { status: result.success ? 200 : 404, data: result };
    }

    // GET /api/v1/admin/incentives/stats
    if (path === '/api/v1/admin/incentives/stats' && method === 'GET') {
      return { data: incentiveService.getStats() };
    }

    // GET /api/v1/admin/incentives/:taskId/leaderboard
    const adminLeaderboardMatch = path.match(/^\/api\/v1\/admin\/incentives\/(.+)\/leaderboard$/);
    if (adminLeaderboardMatch && method === 'GET') {
      const limit = parseInt(params.get('limit') || '20', 10);
      return { data: { leaderboard: incentiveService.getTaskLeaderboard(adminLeaderboardMatch[1], Math.min(limit, 500)) } };
    }
  }

  // ═══════════════════════════════════════════
  // CHAT TICKET SYSTEM — Support
  // ═══════════════════════════════════════════

  // POST /api/v1/tickets  { userId, userType, subject, message, category?, rideId?, priority? }
  if (path === '/api/v1/tickets' && method === 'POST') {
    const result = ticketService.createTicket(body);
    return { status: result.success ? 201 : 400, data: result };
  }

  // GET /api/v1/tickets/:ticketId
  const ticketGetMatch = path.match(/^\/api\/v1\/tickets\/([^/]+)$/);
  if (ticketGetMatch && method === 'GET') {
    const ticket = ticketService.getTicket(ticketGetMatch[1]);
    return { data: ticket || { error: 'Ticket not found' } };
  }

  // POST /api/v1/tickets/:ticketId/messages  { senderId, senderRole, content, attachments? }
  const ticketMsgMatch = path.match(/^\/api\/v1\/tickets\/(.+)\/messages$/);
  if (ticketMsgMatch && method === 'POST') {
    const result = ticketService.addMessage(ticketMsgMatch[1], body);
    return { status: result.success ? 200 : 400, data: result };
  }

  // PUT /api/v1/tickets/:ticketId/read  { readBy }
  const ticketReadMatch = path.match(/^\/api\/v1\/tickets\/(.+)\/read$/);
  if (ticketReadMatch && method === 'PUT') {
    const result = ticketService.markMessagesRead(ticketReadMatch[1], body.readBy);
    return { status: result.success ? 200 : 404, data: result };
  }

  // GET /api/v1/users/:userId/tickets?limit=20&status=OPEN
  const userTicketsMatch = path.match(/^\/api\/v1\/users\/(.+)\/tickets$/);
  if (userTicketsMatch && method === 'GET') {
    const limit = parseInt(params.get('limit') || '20', 10);
    const status = params.get('status') || null;
    return { data: { tickets: ticketService.getUserTickets(userTicketsMatch[1], { limit: Math.min(limit, 100), status }) } };
  }

  // ═══════════════════════════════════════════
  // DEMAND ANALYTICS — Heatmap, Timeline, Logs
  // ═══════════════════════════════════════════

  // GET /api/v1/demand/heatmap — current area demand map
  if (path === '/api/v1/demand/heatmap' && method === 'GET') {
    const areas    = demandLogService.getDemandMap();
    const hotAreas = areas.filter(a => a.demandLevel === 'HIGH' || a.demandLevel === 'SURGE');
    return {
      data: {
        snapshot:   new Date().toISOString(),
        totalAreas: areas.length,
        hotAreas:   hotAreas.length,
        areas,
      },
    };
  }

  // GET /api/v1/demand/areas/hot?limit=10 — top high-demand areas
  if (path === '/api/v1/demand/areas/hot' && method === 'GET') {
    const limit = parseInt(params.get('limit') || '10', 10);
    return { data: { hotAreas: demandLogService.getHotAreas(Math.min(limit, 50)) } };
  }

  // GET /api/v1/demand/timeline?hours=6 — demand by 15-min bucket
  if (path === '/api/v1/demand/timeline' && method === 'GET') {
    const hours = parseFloat(params.get('hours') || '6');
    return { data: demandLogService.getTimeline(Math.min(hours, 72)) };
  }

  // GET /api/v1/demand/stats — real-time demand summary
  if (path === '/api/v1/demand/stats' && method === 'GET') {
    const stats   = demandLogService.getStats();
    const current = demandLogService.getCurrentBucket();
    const hot     = demandLogService.getHotAreas(5);
    return {
      data: {
        ...stats,
        currentBucket: current,
        topHotAreas:   hot,
        poolStats:     demandAggregationService.getStats(),
      },
    };
  }

  // Admin demand routes
  if (path.startsWith('/api/v1/admin/demand')) {
    const authErr = requireAdmin(headers);
    if (authErr) return authErr;

    // GET /api/v1/admin/demand/logs?type=no_match_found&limit=100&since=ISO&poolId=...&areaKey=...
    if (path === '/api/v1/admin/demand/logs' && method === 'GET') {
      const type    = params.get('type')    || null;
      const limit   = parseInt(params.get('limit') || '100', 10);
      const since   = params.get('since')   || null;
      const poolId  = params.get('poolId')  || null;
      const areaKey = params.get('areaKey') || null;
      const logs    = demandLogService.getScenarioLogs({ type, limit: Math.min(limit, 500), since, poolId, areaKey });
      return { data: { count: logs.length, logs } };
    }

    // GET /api/v1/admin/demand/logs/summary — count by scenario type
    if (path === '/api/v1/admin/demand/logs/summary' && method === 'GET') {
      return { data: demandLogService.getLogSummary() };
    }

    // GET /api/v1/admin/demand/areas — all areas with full metrics
    if (path === '/api/v1/admin/demand/areas' && method === 'GET') {
      return { data: { areas: demandLogService.getDemandMap() } };
    }

    // GET /api/v1/admin/demand/peak-hours?limit=20 — time buckets sorted by demand
    if (path === '/api/v1/admin/demand/peak-hours' && method === 'GET') {
      const limit = parseInt(params.get('limit') || '20', 10);
      return { data: { peakHours: demandLogService.getPeakHours(Math.min(limit, 100)) } };
    }

    // GET /api/v1/admin/demand/no-match-analysis — why matches fail
    if (path === '/api/v1/admin/demand/no-match-analysis' && method === 'GET') {
      return { data: demandLogService.getNoMatchAnalysis() };
    }

    // POST /api/v1/admin/demand/snapshot — trigger manual snapshot
    if (path === '/api/v1/admin/demand/snapshot' && method === 'POST') {
      demandLogService._takeDemandSnapshot();
      return { data: { success: true, message: 'Demand snapshot taken.', stats: demandLogService.getStats() } };
    }

    // GET /api/v1/admin/demand/timeline?hours=24
    if (path === '/api/v1/admin/demand/timeline' && method === 'GET') {
      const hours = parseFloat(params.get('hours') || '24');
      return { data: demandLogService.getTimeline(Math.min(hours, 168)) }; // max 7 days
    }
  }

  // Admin ticket routes
  if (path.startsWith('/api/v1/admin/tickets')) {
    const authErr = requireAdmin(headers);
    if (authErr) return authErr;

    // GET /api/v1/admin/tickets?status=OPEN&category=payment_issue&priority=urgent
    if (path === '/api/v1/admin/tickets' && method === 'GET') {
      const status   = params.get('status')   || null;
      const category = params.get('category') || null;
      const priority = params.get('priority') || null;
      const agentId  = params.get('agentId')  || null;
      const limit    = parseInt(params.get('limit') || '50', 10);
      return { data: { tickets: ticketService.listTickets({ status, category, priority, agentId, limit: Math.min(limit, 500) }) } };
    }

    // PUT /api/v1/admin/tickets/:ticketId/status  { status, resolvedBy?, resolution?, agentId? }
    const ticketStatusMatch = path.match(/^\/api\/v1\/admin\/tickets\/(.+)\/status$/);
    if (ticketStatusMatch && method === 'PUT') {
      const result = ticketService.updateStatus(ticketStatusMatch[1], body);
      return { status: result.success ? 200 : 400, data: result };
    }

    // PUT /api/v1/admin/tickets/:ticketId/assign  { agentId }
    const ticketAssignMatch = path.match(/^\/api\/v1\/admin\/tickets\/(.+)\/assign$/);
    if (ticketAssignMatch && method === 'PUT') {
      const result = ticketService.assignAgent(ticketAssignMatch[1], body.agentId);
      return { status: result.success ? 200 : 400, data: result };
    }

    // GET /api/v1/admin/tickets/stats
    if (path === '/api/v1/admin/tickets/stats' && method === 'GET') {
      return { data: ticketService.getStats() };
    }

    // GET /api/v1/admin/tickets/agents
    if (path === '/api/v1/admin/tickets/agents' && method === 'GET') {
      return { data: { agents: ticketService.listAgents() } };
    }

    // POST /api/v1/admin/tickets/agents  { agentId, name, email }
    if (path === '/api/v1/admin/tickets/agents' && method === 'POST') {
      const result = ticketService.addAgent(body);
      return { status: result.success ? 201 : 400, data: result };
    }
  }

  // ═══════════════════════════════════════════
  // RIDE SESSION RECOVERY (app kill recovery)
  // ═══════════════════════════════════════════

  // GET /api/v1/riders/:riderId/active-ride  — lightweight check on app open
  const activeRideMatch = path.match(/^\/api\/v1\/riders\/(.+)\/active-ride$/);
  if (activeRideMatch && method === 'GET') {
    const riderId = activeRideMatch[1];
    const ride = rideService.getActiveRide(riderId);
    if (!ride) {
      return { data: { hasActiveRide: false } };
    }
    rideSessionService._logRecovery({ type: 'active_check', riderId, rideId: ride.rideId, rideStatus: ride.status });
    return {
      data: {
        hasActiveRide: true,
        rideId: ride.rideId,
        status: ride.status,
        wsChannel: `ride:${ride.rideId}`,
      },
    };
  }

  // POST /api/v1/riders/:riderId/restore  — full recovery payload (requires auth)
  const restoreMatch = path.match(/^\/api\/v1\/riders\/(.+)\/restore$/);
  if (restoreMatch && method === 'POST') {
    const authResult = requireAuth(headers);
    if (authResult.error) return authResult.error;
    const riderId = restoreMatch[1];
    const result = rideSessionService.restoreSession(riderId, {
      rideService,
      locationService,
      matchingEngine,
    });
    if (!result.hasActiveRide) {
      return { data: { hasActiveRide: false } };
    }
    return { data: result };
  }

  // POST /api/v1/riders/:riderId/heartbeat  — keepalive ping every 30s
  const heartbeatMatch = path.match(/^\/api\/v1\/riders\/(.+)\/heartbeat$/);
  if (heartbeatMatch && method === 'POST') {
    const riderId = heartbeatMatch[1];
    const rideId = body.rideId || null;
    const result = rideSessionService.heartbeat(riderId, rideId);
    return { data: result };
  }

  return { status: 404, data: { error: 'Not found', path, method } };
}

function bootstrapTestData() {
  const seedResult = mockDb.seed({
    driverCount: enterpriseConfig.performance.bootstrapBatchSize,
    riderCount: 200,
  });

  for (const driver of seedResult.drivers) {
    matchingEngine.registerDriver(driver);
    locationService.updateLocation(driver.driverId, {
      lat: driver.lat,
      lng: driver.lng,
      speed: driver.speed,
      heading: driver.heading,
    });
  }

  const identityUsers = generateIdentityUsers(300);
  identityService.seedUsers(identityUsers);

  logger.success('BOOTSTRAP', 'Seeded test datasets (no real DB dependency).', {
    drivers: seedResult.driverCount,
    riders: seedResult.riderCount,
    identityUsers: identityUsers.length,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const simOnly = args.includes('--sim-only');
  const apiOnly = args.includes('--api-only');

  console.clear();
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║   GoApp Ride Matching Platform v2.1                 ║');
  console.log('  ║   Microservice-ready + AWS-aware + Mock Data        ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');

  bootstrapTestData();

  if (!simOnly) {
    startAPIServer(config.server.port);

    const wsServer = new WebSocketServer();
    wsServer.start(config.server.wsPort);
    wsServer.onLocationUpdate = (driverId, data) => {
      locationService.updateLocation(driverId, data);
    };
  }

  if (!apiOnly) {
    const Simulator = require('./simulation/simulator');
    const sim = new Simulator();
    await sim.run();
  }

  if (!simOnly) {
    console.log('\n  Servers are running. Press Ctrl+C to stop.\n');
    console.log('  curl http://localhost:3000/api/v1/health');
    console.log('  curl http://localhost:3000/api/v1/microservices');
    console.log("  curl -X POST http://localhost:3000/api/v1/auth/otp/request -H 'Content-Type: application/json' -d '{\"phoneNumber\":\"+919876543210\",\"otpType\":\"login\"}'");
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
