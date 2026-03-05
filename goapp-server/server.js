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
const redis = require('./services/redis-mock');
const mockDb = require('./services/mock-db');
const zoneService = require('./services/zone-service');
const WebSocketServer = require('./websocket/ws-gateway');
const { haversine, bearing } = require('./utils/formulas');

// Test Data
const { generateIdentityUsers } = require('./data/test-data');

// ─── Admin auth helper ────────────────────────────────────────────────────
function requireAdmin(headers) {
  const token = headers['x-admin-token'];
  if (!token || token !== config.admin.token) {
    return { status: 401, data: { error: 'Admin authentication required. Provide X-Admin-Token header.' } };
  }
  return null; // no error
}

function startAPIServer(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method;
    const headers = req.headers;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      let body = '';
      if (method === 'POST' || method === 'PUT') {
        body = await new Promise((resolve) => {
          let data = '';
          req.on('data', chunk => { data += chunk; });
          req.on('end', () => resolve(data));
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
      res.writeHead(500);
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
    console.log('  --- Admin (requires X-Admin-Token header) ---');
    console.log('  GET    /api/v1/admin/zones');
    console.log('  POST   /api/v1/admin/zones');
    console.log('  PUT    /api/v1/admin/zones/:id/enable');
    console.log('  PUT    /api/v1/admin/zones/:id/disable');
    console.log('  DELETE /api/v1/admin/zones/:id');
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
        version: '2.1',
        uptime: process.uptime(),
        runtime: enterpriseConfig.runtime,
        redis: redis.getStats(),
        identity: identityService.getStats(),
        location: locationService.getStats(),
        pricing: pricingService.getStats(),
        rides: rideService.getStats(),
        mockDb: mockDb.getStats(),
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

    const result = await rideService.createRide({
      ...body,
      idempotencyKey: body.idempotencyKey || crypto.randomUUID(),
    });
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
    return { data: result || { error: 'Invalid state' } };
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
