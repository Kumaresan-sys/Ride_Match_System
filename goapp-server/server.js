#!/usr/bin/env node

// MUST be the first require() — loads .env.<NODE_ENV> before any module reads process.env
require('./config/env-loader');

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
const coinsService = require('./services/coins-service');
const driverWalletService = require('./services/driver-wallet-service');
const feedbackService = require('./services/feedback-service');
const perfMonitor = require('./services/perf-monitor');
const demandAggregationService = require('./services/demand-aggregation-service');
const demandLogService = require('./services/demand-log-service');
const incentiveService = require('./services/incentive-service');
const ticketService = require('./services/ticket-service');
const rideSessionService = require('./services/ride-session-service');
const sosService = require('./services/sos-service');
const smsService = require('./services/sms-service');
const redis = require('./services/redis-client');
const razorpayService = require('./services/razorpay-service');
const zoneService = require('./services/zone-service');
const notificationService = require('./services/notification-service');
const WebSocketServer = require('./websocket/ws-gateway');
const { haversine, bearing } = require('./utils/formulas');
const googleMapsService = require('./services/google-maps-service');
const db = require('./services/db');
const profileService = require('./services/profile-service');
const safetyService = require('./services/safety-service');
const zoneCatalogService = require('./services/zone-catalog-service');
const zoneMappingService = require('./services/zone-mapping-service');
const zoneMetricsService = require('./services/zone-metrics-service');
const { applySecurityHeaders, parseJsonBody, readRawBody } = require('./middleware/http-middleware');
const { parseMultipart } = require('./middleware/multipart-parser');
const DocumentStorageService = require('./services/document-storage-service');
const DriverDocumentService = require('./services/driver-document-service');
const buildRouteDispatcher = require('./routes');
const validateConfig = require('./config/validate-config');
const { bootstrapArchitecture } = require('./infra/bootstrap');
const { bootstrapModules } = require('./modules');
const MatchingWorker = require('./workers/matching-worker');
const NotificationWorker = require('./workers/notification-worker');
const OutboxRelayWorker = require('./workers/outbox-relay-worker');
const DomainProjectionWorker = require('./workers/domain-projection-worker');
const {
  ServiceIdentityRepository,
  ServiceRideRepository,
  ServiceMatchingStateRepository,
  ServiceWalletRepository,
} = require('./repositories/adapters/service-repositories');
const tokenService = require('./services/token-service');

// Max request body size: 256 KB (prevents memory exhaustion)
const MAX_BODY_BYTES = 256 * 1024;
// Max upload size for driver document files: 10 MB
const MAX_FILE_UPLOAD_BYTES = config.storage.maxFileSizeBytes || (10 * 1024 * 1024);

// Instantiate document storage once at module load
const documentStorageService = new DocumentStorageService(config);
const driverDocumentService = new DriverDocumentService(documentStorageService);
const authRuntimeStats = {
  legacyTokenAccepted: 0,
  metrics: {
    'auth.legacy_token.accepted': 0,
  },
};

// ─── Coordinate validator ─────────────────────────────────────────────────
function validCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// ─── Safe integer param with clamp ───────────────────────────────────────
function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// ─── Safe float param with clamp ─────────────────────────────────────────
function clampFloat(value, min, max, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// ─── Admin auth helper ────────────────────────────────────────────────────
function requireAdmin(headers) {
  const token = headers['x-admin-token'];
  const expected = config.admin.token;
  // Deny immediately if the server has no admin token configured — prevents
  // empty-string timingSafeEqual bypass where both buffers have length 0.
  if (!expected) {
    return { status: 401, data: { error: 'Admin access is not configured on this server.' } };
  }
  let valid = false;
  if (token) {
    try {
      const a = Buffer.from(token);
      const b = Buffer.from(expected);
      valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (_) { valid = false; }
  }
  if (!valid) {
    return { status: 401, data: { error: 'Admin authentication required. Provide X-Admin-Token header.' } };
  }
  return null;
}

// ─── Session auth helper ──────────────────────────────────────────────────
// Returns { session } on success, or { error: { status, data } } to return immediately.
// All callers: if (auth.error) return auth.error;
async function requireAuth(headers) {
  const authHeader = headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const legacySessionToken = headers['x-session-token'];
  const rawToken = bearerToken || legacySessionToken;
  if (!rawToken) {
    return { error: { status: 401, data: { error: 'Authentication required. Provide Authorization: Bearer <token> header.' } } };
  }

  let sessionToken = rawToken;
  const jwtPayload = tokenService.verifyAccessToken(rawToken);
  const usingLegacyToken = !bearerToken && Boolean(legacySessionToken);
  const disableDate = Date.parse(config.security.legacyAuth.disableDate);
  if (usingLegacyToken && Number.isFinite(disableDate) && Date.now() >= disableDate) {
    return {
      error: {
        status: 401,
        data: {
          error: 'Legacy session token is no longer accepted. Use Authorization: Bearer <JWT>.',
          code: 'LEGACY_TOKEN_DISABLED',
        },
      },
    };
  }

  if (usingLegacyToken) {
    authRuntimeStats.legacyTokenAccepted += 1;
    authRuntimeStats.metrics['auth.legacy_token.accepted'] += 1;
    logger.warn(
      'AUTH',
      `metric=auth.legacy_token.accepted count=${authRuntimeStats.metrics['auth.legacy_token.accepted']} ua="${String(headers['user-agent'] || 'unknown').slice(0, 120)}"`
    );
  }

  if (jwtPayload?.sessionToken) {
    sessionToken = jwtPayload.sessionToken;
  }

  const session = await identityService.validateSession(sessionToken);
  if (!session) {
    return { error: { status: 401, data: { error: 'Invalid or expired session token.' } } };
  }
  if (jwtPayload?.userId && String(jwtPayload.userId) !== String(session.userId)) {
    return { error: { status: 401, data: { error: 'Invalid authentication token subject.' } } };
  }
  return { session };
}

function startAPIServer(port, runtime = {}) {
  const repositories = {
    identity: new ServiceIdentityRepository(identityService),
    ride: new ServiceRideRepository(rideService),
    matchingState: new ServiceMatchingStateRepository(matchingEngine),
    wallet: new ServiceWalletRepository(walletService),
  };
  const modules = runtime.modules || bootstrapModules();

  const dispatchRoute = buildRouteDispatcher({
    enterpriseConfig,
    repositories,
    eventBus,
    authRuntimeStats,
    // Auth helpers exposed to route modules so they don't need to import server.js
    requireAuth,
    requireAdmin,
    services: {
      redis,
      locationService,
      pricingService,
      rideService,
      identityService,
      zoneService,
      demandLogService,
      walletService,
      coinsService,
      driverWalletService,
      feedbackService,
      ticketService,
      rideSessionService,
      sosService,
      matchingEngine,
      perfMonitor,
      razorpayService,
      driverDocumentService,
      notificationService,
      profileService,
      safetyService,
      zoneCatalogService,
      zoneMappingService,
      zoneMetricsService,
      googleMapsService,
      smsService,
      infra: runtime.infra || null,
      modules,
    },
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method;
    const headers = req.headers;
    const requestId = String(headers['x-request-id'] || crypto.randomUUID());
    // Prefer X-Forwarded-For (set by load balancers/proxies); fall back to socket address.
    const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress
      || '';

    res.setHeader('X-Request-Id', requestId);
    const hasLegacyToken = !String(headers['authorization'] || '').startsWith('Bearer ')
      && Boolean(headers['x-session-token']);
    if (hasLegacyToken) {
      res.setHeader('X-Auth-Deprecation', 'legacy-token');
    }
    applySecurityHeaders(req, res);

    const writeJson = (status, data) => {
      let payload = data;
      if (payload && typeof payload === 'object' && !Buffer.isBuffer(payload) && !Array.isArray(payload)) {
        if (payload.requestId == null) {
          payload = { ...payload, requestId };
        }
      }
      res.writeHead(status);
      const indent = process.env.NODE_ENV === 'production' ? 0 : 2;
      res.end(JSON.stringify(payload, null, indent));
    };

    if (method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // ── Razorpay webhook — must read raw body BEFORE JSON.parse ──────────────
    if (path === '/api/v1/payments/webhook' && method === 'POST') {
      const doneWebhook = perfMonitor.startRequest();
      try {
        const rawBody  = await readRawBody(req, MAX_BODY_BYTES);
        const sig      = headers['x-razorpay-signature'] || '';
        const isValid  = razorpayService.verifyWebhookSignature(rawBody, sig);

        if (!isValid) {
          logger.warn('RAZORPAY', `Webhook received with invalid signature — rejected (requestId=${requestId})`);
          writeJson(400, { error: 'Invalid webhook signature', requestId });
          doneWebhook();
          return;
        }

        let event;
        try { event = JSON.parse(rawBody.toString('utf8')); }
        catch (_) { writeJson(400, { error: 'Invalid JSON', requestId }); doneWebhook(); return; }

        // ── Webhook event processing ─────────────────────────────────────────
        const eventName  = event.event || '';
        const payment    = event.payload?.payment?.entity;
        const orderId    = payment?.order_id;
        const webhookEventId = event?.payload?.payment?.entity?.id || event?.id || `${eventName}:${orderId || 'na'}`;

        const idempotency = await redis.checkIdempotency(`payment_webhook:${webhookEventId}`);
        if (idempotency.isDuplicate) {
          writeJson(200, { received: true, duplicate: true, event: eventName, requestId });
          doneWebhook();
          return;
        }

        logger.info('RAZORPAY', `Webhook received: ${eventName} | order: ${orderId || 'n/a'}`);

        if ((eventName === 'payment.captured' || eventName === 'payment.authorized') && orderId) {
          const order = razorpayService.getOrder(orderId);
          if (order && order.status !== 'paid') {
            // Credit the appropriate wallet
            if (order.userType === 'rider') {
              walletService.topupWallet(order.userId, order.amountInr, 'razorpay_webhook', payment.id);
              logger.success('RAZORPAY', `Webhook: credited ₹${order.amountInr} to rider ${order.userId}`);
            } else if (order.userType === 'driver') {
              driverWalletService.rechargeWallet(order.userId, order.amountInr, 'razorpay_webhook', payment.id);
              logger.success('RAZORPAY', `Webhook: credited ₹${order.amountInr} to driver ${order.userId}`);
            }
          }
        }

        await redis.setIdempotency(`payment_webhook:${webhookEventId}`, { event: eventName, orderId }, 24 * 3600);

        writeJson(200, { received: true, event: eventName, requestId });
        doneWebhook();
      } catch (err) {
        doneWebhook();
        logger.error('API', `Webhook error (requestId=${requestId}): ${err.message}`);
        writeJson(500, { error: err.message, requestId });
      }
      return;
    }

    const doneRequest = perfMonitor.startRequest();
    try {
      let body, files = null;
      const contentType = headers['content-type'] || '';
      if (contentType.startsWith('multipart/form-data')) {
        const parsed = await parseMultipart(req, MAX_FILE_UPLOAD_BYTES);
        body = parsed.fields;
        files = parsed.files;
      } else {
        body = await parseJsonBody(req, MAX_BODY_BYTES);
      }

      const response = await dispatchRoute(method, path, body, url.searchParams, headers, files, clientIp);
      if (path.startsWith('/api/v1/admin/')) {
        logger.info('AUDIT', `Admin API access ${method} ${path} status=${response.status || 200} requestId=${requestId} ip=${clientIp}`);
      }

      // Binary file response (e.g. driver document file download)
      if (response.raw) {
        const disposition = `inline; filename="${response.filename || 'document'}"`;
        res.writeHead(200, {
          'Content-Type': response.contentType || 'application/octet-stream',
          'Content-Disposition': disposition,
          'Content-Length': response.buffer.length,
        });
        res.end(response.buffer);
        doneRequest();
        return;
      }

      writeJson(response.status || 200, response.data);
      doneRequest();
    } catch (err) {
      doneRequest();
      if (err instanceof SyntaxError) {
        writeJson(400, { error: 'Invalid JSON body', requestId });
        return;
      }
      const status = err.statusCode || 500;
      logger.error('API', `Unhandled request error (requestId=${requestId}, path=${path}, method=${method}): ${err.message}`);
      writeJson(status, { error: err.message, requestId });
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
    console.log('  --- Google Maps (requires GOOGLE_MAPS_API_KEY) ---');
    console.log('  GET  /api/v1/maps/autocomplete?input=TEXT&lat=X&lng=Y&sessionToken=T');
    console.log('  GET  /api/v1/maps/place?placeId=ID&sessionToken=T');
    console.log('  GET  /api/v1/maps/reverse-geocode?lat=X&lng=Y');
    console.log('  GET  /api/v1/maps/status');
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
    console.log('  GET    /api/v1/admin/demand/daily-summary   Today\'s aggregated demand summary');
    console.log('  GET    /api/v1/admin/recovery-logs?type=restore&riderId=xxx&limit=50');
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
    console.log('  --- Razorpay Payments ---');
    console.log('  POST /api/v1/payments/rider/create-order  { userId, amountInr }');
    console.log('  POST /api/v1/payments/rider/verify        { razorpayOrderId, razorpayPaymentId, razorpaySignature }');
    console.log('  POST /api/v1/payments/driver/create-order { driverId, amountInr }');
    console.log('  POST /api/v1/payments/driver/verify       { razorpayOrderId, razorpayPaymentId, razorpaySignature }');
    console.log('  GET  /api/v1/payments/orders/:orderId');
    console.log('  POST /api/v1/payments/webhook             (Razorpay webhook — X-Razorpay-Signature header)');
    console.log('  GET  /api/v1/admin/payments/stats');
    console.log('');
  });

  return server;
}

async function assertPgSchemaReady() {
  if (config.db.backend !== 'pg') return;

  const requiredTables = [
    'users',
    'otp_requests',
    'user_sessions',
    'drivers',
    'riders',
    'rides',
    'driver_locations',
    'driver_wallets',
    'rider_wallets',
  ];

  const { rows } = await db.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [requiredTables]
  );

  const present = new Set(rows.map(r => r.table_name));
  const missing = requiredTables.filter(t => !present.has(t));
  if (missing.length > 0) {
    throw new Error(
      `Database schema is incomplete. Missing tables: ${missing.join(', ')}. ` +
      'Run enterprise-setup/sql/run-migrations.sh (or apply sql/001..029) against POSTGRES_DB before starting.'
    );
  }
}

async function main() {
  const strictConfig = process.env.CONFIG_STRICT === 'true' || process.env.NODE_ENV !== 'development';
  const configCheck = validateConfig({ strict: strictConfig });
  configCheck.warnings.forEach(msg => logger.warn('CONFIG', msg));
  if (!configCheck.ok) {
    throw new Error(`Config validation failed: ${configCheck.errors.join(' | ')}`);
  }

  await assertPgSchemaReady();

  const args = process.argv.slice(2);
  const apiOnly = args.includes('--api-only');

  console.clear();
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║   GoApp Ride Matching Platform v2.2                 ║');
  console.log('  ║   Microservice-ready + AWS-aware + Real Flow        ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');

  const runtimeIsTest = (process.env.NODE_ENV || 'development') === 'test';
  if (!runtimeIsTest && config.db.backend !== 'pg') {
    throw new Error(`DB_BACKEND must be 'pg' for runtime flow (got '${config.db.backend}').`);
  }
  if (!runtimeIsTest && config.redis.backend !== 'real') {
    throw new Error(`REDIS_BACKEND must be 'real' for runtime flow (got '${config.redis.backend}').`);
  }

  const infrastructure = await bootstrapArchitecture({ eventBus });
  const modules = bootstrapModules();

  logger.info('BOOT', `Architecture flags => MATCHING_V2=${String(config.architecture.featureFlags.matchingV2)} REDIS_STATE_V2=${String(config.architecture.featureFlags.redisStateV2)} KAFKA_OUTBOX=${String(config.architecture.featureFlags.kafkaOutbox)} KAFKA_OUTBOX_RELAY_WORKER=${String(config.architecture.featureFlags.kafkaOutboxRelayWorker)} KAFKA_DOMAIN_PROJECTION_WORKER=${String(config.architecture.featureFlags.kafkaDomainProjectionWorker)}`);
  logger.info('BOOT', `Domain modules loaded: ${modules.modules.map(m => m.name).join(', ')}`);

  if (config.architecture.featureFlags.kafkaMatchingWorker) {
    const matchingWorker = new MatchingWorker({ rideService, matchingEngine });
    matchingWorker.start().catch((err) => logger.error('BOOT', `matching worker start failed: ${err.message}`));
  } else {
    logger.info('BOOT', 'Kafka matching worker disabled (KAFKA_MATCHING_WORKER=false).');
  }

  if (config.architecture.featureFlags.kafkaOutboxRelayWorker) {
    const outboxRelayWorker = new OutboxRelayWorker();
    outboxRelayWorker.start().catch((err) => logger.error('BOOT', `outbox relay worker start failed: ${err.message}`));
  } else {
    logger.info('BOOT', 'Outbox relay worker disabled (KAFKA_OUTBOX_RELAY_WORKER=false).');
  }

  if (config.architecture.featureFlags.kafkaDomainProjectionWorker) {
    const domainProjectionWorker = new DomainProjectionWorker();
    domainProjectionWorker.start().catch((err) => logger.error('BOOT', `domain projection worker start failed: ${err.message}`));
  } else {
    logger.info('BOOT', 'Domain projection worker disabled (KAFKA_DOMAIN_PROJECTION_WORKER=false).');
  }

  if (config.architecture.featureFlags.kafkaNotificationWorker) {
    const worker = new NotificationWorker({ notificationService });
    worker.start().catch((err) => logger.error('BOOT', `notification worker start failed: ${err.message}`));
  }

  const apiServer = startAPIServer(config.server.port, { infra: infrastructure, modules });

  const wsServer = new WebSocketServer({
    authTimeoutMs: config.security.wsAuthTimeoutMs,
    authenticateToken: async (token) => {
      const payload = tokenService.verifyAccessToken(token);
      if (!payload?.sessionToken) return null;
      const session = await identityService.validateSession(payload.sessionToken);
      if (!session) return null;
      if (String(session.userId) !== String(payload.userId)) return null;
      return { userId: session.userId, sessionToken: session.sessionToken };
    },
    canAccessRide: (userId, rideId) => {
      const ride = rideService.getRide(rideId);
      if (!ride) return false;
      return String(ride.riderId) === String(userId) || String(ride.driverId) === String(userId);
    },
  });
  wsServer.start(config.server.wsPort);
  if (wsServer.server && typeof wsServer.server.on === 'function') {
    wsServer.server.on('error', (err) => logger.error('WS', `WebSocket server error: ${err.message}`));
  }
  wsServer.onLocationUpdate = (driverId, data) => {
    locationService.updateLocation(driverId, data);
  };
  if (!apiOnly) {
    logger.info('BOOT', 'API and WebSocket started in real-flow mode.');
  }

  console.log('\n  Servers are running. Press Ctrl+C to stop.\n');
  console.log('  curl http://localhost:3000/api/v1/health');
  console.log('  curl http://localhost:3000/api/v1/microservices');
  console.log("  curl -X POST http://localhost:3000/api/v1/auth/otp/request -H 'Content-Type: application/json' -d '{\"phoneNumber\":\"+919876543210\",\"otpType\":\"login\"}'");
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    try { demandLogService.stop(); } catch (_) {}
    process.exit(1);
  });
}

module.exports = {
  startAPIServer,
  main,
};
