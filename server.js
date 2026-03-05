#!/usr/bin/env node

// ═══════════════════════════════════════════════════════════════
//  GoApp Ride Matching Platform - Complete Node.js System
//  Version 2.0 | Production Architecture Simulation
// ═══════════════════════════════════════════════════════════════
//
//  This system demonstrates:
//  ├── REST API (http://localhost:3000)
//  ├── WebSocket Server (ws://localhost:3001)
//  ├── Redis GEO (in-memory mock)
//  ├── Kafka Event Bus (in-memory mock)
//  └── Full ride lifecycle simulation
//
//  Usage:
//    node server.js              → Run simulation + start servers
//    node server.js --sim-only   → Run simulation only (no servers)
//    node server.js --api-only   → Start API servers only
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const crypto = require('crypto');
const config = require('./config');
const { logger, eventBus } = require('./utils/logger');

// Services
const locationService = require('./services/location-service');
const matchingEngine = require('./services/matching-engine');
const pricingService = require('./services/pricing-service');
const rideService = require('./services/ride-service');
const redis = require('./services/redis-mock');
const WebSocketServer = require('./websocket/ws-gateway');
const { haversine, bearing, calculateCompositeScore, detectSpoofing } = require('./utils/formulas');

// Test Data
const { generateDrivers, generateRiders, generateRideScenarios, chennaiLocations } = require('./data/test-data');

// ─── REST API Server ───
function startAPIServer(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    try {
      let body = '';
      if (method === 'POST' || method === 'PUT') {
        body = await new Promise((resolve) => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => resolve(data));
        });
      }

      const json = body ? JSON.parse(body) : {};
      const response = await handleRoute(method, path, json, url.searchParams);
      res.writeHead(response.status || 200);
      res.end(JSON.stringify(response.data, null, 2));

    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, () => {
    logger.success('API', `REST API running on http://localhost:${port}`);
    logger.info('API', 'Endpoints:');
    console.log('  GET  /api/v1/health');
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
    console.log('');
  });

  return server;
}

// ─── Route Handler ───
async function handleRoute(method, path, body, params) {
  // Health
  if (path === '/api/v1/health') {
    return { data: {
      status: 'ok', service: 'GoApp Ride Matching Platform', version: '2.0',
      uptime: process.uptime(),
      redis: redis.getStats(),
      location: locationService.getStats(),
      pricing: pricingService.getStats(),
      rides: rideService.getStats(),
    }};
  }

  // ─── Drivers ───
  if (path === '/api/v1/drivers' && method === 'GET') {
    return { data: { drivers: locationService.getAllTracked() } };
  }

  if (path === '/api/v1/drivers/nearby' && method === 'GET') {
    const lat = parseFloat(params.get('lat'));
    const lng = parseFloat(params.get('lng'));
    const radius = parseFloat(params.get('radius') || '5');
    if (!lat || !lng) return { status: 400, data: { error: 'lat and lng required' } };
    const nearby = locationService.findNearby(lat, lng, radius, 20);
    return { data: { count: nearby.length, drivers: nearby } };
  }

  if (path.match(/^\/api\/v1\/drivers\/(.+)\/location$/) && method === 'PUT') {
    const driverId = path.split('/')[4];
    const result = locationService.updateLocation(driverId, body);
    return { data: result };
  }

  // ─── Rides ───
  if (path === '/api/v1/rides/request' && method === 'POST') {
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

  // ─── Fare ───
  if (path === '/api/v1/fare/estimate' && method === 'POST') {
    const estimates = pricingService.getEstimates(body.pickupLat, body.pickupLng, body.destLat, body.destLng);
    return { data: estimates };
  }

  // ─── Surge ───
  if (path === '/api/v1/surge/zones' && method === 'GET') {
    return { data: { zones: pricingService.getSurgeZones() } };
  }

  if (path === '/api/v1/surge/update' && method === 'POST') {
    const result = pricingService.updateSurge(body.zoneId, body.demand, body.supply);
    return { data: result };
  }

  // ─── Events ───
  if (path === '/api/v1/events' && method === 'GET') {
    const count = parseInt(params.get('count') || '20');
    return { data: { events: eventBus.getRecentEvents(count) } };
  }

  // ─── Stats ───
  if (path === '/api/v1/stats' && method === 'GET') {
    return { data: {
      redis: redis.getStats(),
      location: locationService.getStats(),
      pricing: pricingService.getStats(),
      rides: rideService.getStats(),
      events: { total: eventBus.events.length },
    }};
  }

  // ─── Formula Endpoints ───
  if (path === '/api/v1/formulas/haversine' && method === 'GET') {
    const lat1 = parseFloat(params.get('lat1'));
    const lng1 = parseFloat(params.get('lng1'));
    const lat2 = parseFloat(params.get('lat2'));
    const lng2 = parseFloat(params.get('lng2'));
    if (!lat1 || !lng1 || !lat2 || !lng2) return { status: 400, data: { error: 'lat1, lng1, lat2, lng2 required' } };
    const dist = haversine(lat1, lng1, lat2, lng2);
    const bear = bearing(lat1, lng1, lat2, lng2);
    return { data: {
      from: { lat: lat1, lng: lng1 }, to: { lat: lat2, lng: lng2 },
      distanceKm: Math.round(dist * 100) / 100,
      bearingDeg: Math.round(bear * 10) / 10,
      etaMin: Math.round((dist * 1.3 / config.scoring.avgCitySpeedKmh) * 60 * 10) / 10,
    }};
  }

  // 404
  return { status: 404, data: { error: 'Not found', path, method } };
}

// ═══════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════
async function main() {
  const args = process.argv.slice(2);
  const simOnly = args.includes('--sim-only');
  const apiOnly = args.includes('--api-only');

  console.clear();
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║   GoApp Ride Matching Platform v2.0                 ║');
  console.log('  ║   Complete Node.js System Simulation                ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');

  if (!simOnly) {
    // Setup test data for API mode
    const drivers = generateDrivers(20);
    drivers.forEach(d => {
      matchingEngine.registerDriver(d);
      locationService.updateLocation(d.driverId, {
        lat: d.lat, lng: d.lng, speed: d.speed, heading: d.heading,
      });
    });

    // Start REST API
    startAPIServer(config.server.port);

    // Start WebSocket
    const wsServer = new WebSocketServer();
    wsServer.start(config.server.wsPort);

    // Wire WebSocket location updates to location service
    wsServer.onLocationUpdate = (driverId, data) => {
      locationService.updateLocation(driverId, data);
    };
  }

  if (!apiOnly) {
    // Run simulation
    const Simulator = require('./simulation/simulator');
    const sim = new Simulator();
    await sim.run();
  }

  if (!simOnly) {
    console.log('\n  Servers are running. Press Ctrl+C to stop.\n');
    console.log('  Try these API calls:');
    console.log('  curl http://localhost:3000/api/v1/health');
    console.log('  curl http://localhost:3000/api/v1/drivers/nearby?lat=13.0418\\&lng=80.2341\\&radius=5');
    console.log('  curl http://localhost:3000/api/v1/stats');
    console.log('  curl http://localhost:3000/api/v1/formulas/haversine?lat1=13.0827\\&lng1=80.2707\\&lat2=13.0418\\&lng2=80.2341');
    console.log('  curl -X POST http://localhost:3000/api/v1/rides/request -H "Content-Type: application/json" -d \'{"riderId":"RDR-001","pickupLat":13.0418,"pickupLng":80.2341,"destLat":13.0827,"destLng":80.2707,"rideType":"sedan"}\'');
    console.log('');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
