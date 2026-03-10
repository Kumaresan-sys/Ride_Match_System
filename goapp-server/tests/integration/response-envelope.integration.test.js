'use strict';

require('../../config/env-loader');

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

process.env.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'test_webhook_secret';

const { startAPIServer } = require('../../server');

let server;
let baseUrl;

async function startTestServer(runtime = {}) {
  const httpServer = startAPIServer(0, runtime);
  await once(httpServer, 'listening');
  const address = httpServer.address();
  return {
    server: httpServer,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function stopTestServer(httpServer) {
  if (!httpServer) return;
  await new Promise((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
}

async function requestJson(targetPath, options = {}) {
  const response = await fetch(`${baseUrl}${targetPath}`, options);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

function assertErrorEnvelope(payload, { message, errorCode, extra = {} }) {
  assert.equal(payload.success, false);
  assert.equal(payload.message, message);
  assert.equal(payload.errorCode, errorCode);
  assert.ok(typeof payload.requestId === 'string' && payload.requestId.length > 0);
  for (const [key, value] of Object.entries(extra)) {
    assert.deepEqual(payload[key], value);
  }
}

test.before(async () => {
  const started = await startTestServer();
  server = started.server;
  baseUrl = started.baseUrl;
});

test.after(async () => {
  await stopTestServer(server);
});

test('route files do not reintroduce legacy raw error payloads', () => {
  const routesDir = path.resolve(__dirname, '../../routes');
  const files = fs.readdirSync(routesDir)
    .filter((name) => name.endsWith('.js'))
    .filter((name) => name !== 'simple-router.js');

  const legacyPattern = /data:\s*\{\s*error:|success:\s*false,\s*error:|return\s+\{\s*error:\s*auth\.error\s*\}|return\s+\{\s*error:\s*\{/m;

  for (const file of files) {
    const content = fs.readFileSync(path.join(routesDir, file), 'utf8');
    assert.equal(
      legacyPattern.test(content),
      false,
      `Legacy raw error payload detected in routes/${file}`,
    );
  }
});

test('unknown route returns standardized error envelope', async () => {
  const response = await requestJson('/api/v1/does-not-exist');
  assert.equal(response.status, 404);
  assertErrorEnvelope(response.body, {
    message: 'Not found',
    errorCode: 'NOT_FOUND',
    extra: {
      path: '/api/v1/does-not-exist',
      method: 'GET',
    },
  });
});

test('authenticated route without bearer token returns standardized auth envelope', async () => {
  const response = await requestJson('/api/v1/saved-locations');
  assert.equal(response.status, 401);
  assertErrorEnvelope(response.body, {
    message: 'Authentication required. Provide Authorization: Bearer <token> header.',
    errorCode: 'AUTH_REQUIRED',
  });
});

test('route validation failure returns standardized error envelope', async () => {
  const response = await requestJson('/api/v1/formulas/haversine?lat1=a&lng1=1&lat2=2&lng2=3');
  assert.equal(response.status, 400);
  assertErrorEnvelope(response.body, {
    message: 'lat1, lng1, lat2, lng2 required',
    errorCode: 'VALIDATION_ERROR',
  });
});

test('invalid JSON body returns standardized error envelope', async () => {
  const response = await requestJson('/api/v1/tickets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: '{',
  });
  assert.equal(response.status, 400);
  assertErrorEnvelope(response.body, {
    message: 'Invalid JSON body',
    errorCode: 'INVALID_JSON',
  });
});

test('webhook invalid signature returns standardized error envelope', async () => {
  const response = await requestJson('/api/v1/payments/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': 'bad-signature',
    },
    body: '{}',
  });
  assert.equal(response.status, 400);
  assertErrorEnvelope(response.body, {
    message: 'Invalid webhook signature',
    errorCode: 'INVALID_WEBHOOK_SIGNATURE',
  });
});

test('webhook invalid JSON after signature verification returns standardized error envelope', async () => {
  const rawBody = '{';
  const signature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const response = await requestJson('/api/v1/payments/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': signature,
    },
    body: rawBody,
  });
  assert.equal(response.status, 400);
  assertErrorEnvelope(response.body, {
    message: 'Invalid JSON',
    errorCode: 'INVALID_JSON',
  });
});

test('global request error path returns standardized error envelope', async (t) => {
  const started = await startTestServer({
    dispatchRoute: async () => {
      const err = new Error('Simulated handler failure');
      err.statusCode = 503;
      err.code = 'SIMULATED_ROUTE_FAILURE';
      throw err;
    },
  });
  t.after(async () => {
    await stopTestServer(started.server);
  });

  const response = await fetch(`${started.baseUrl}/api/v1/test-error`);
  const payload = await response.json();

  assert.equal(response.status, 503);
  assertErrorEnvelope(payload, {
    message: 'Simulated handler failure',
    errorCode: 'SIMULATED_ROUTE_FAILURE',
  });
});
