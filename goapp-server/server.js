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
    console.log('  --- Wallet / Coins ---');
    console.log('  GET  /api/v1/wallet/:userId/balance');
    console.log('  GET  /api/v1/wallet/:userId/transactions');
    console.log('  POST /api/v1/wallet/:userId/redeem          { fareInr, coinsToUse? }');
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
    console.log('  POST   /api/v1/admin/wallet/:userId/adjust  { coins, reason }');
    console.log('  GET    /api/v1/admin/wallet/stats');
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
