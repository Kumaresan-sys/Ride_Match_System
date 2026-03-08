const test = require('node:test');
const assert = require('node:assert/strict');

const { startAPIServer, bootstrapTestData } = require('../server');
const identityService = require('../services/identity-service');
const matchingEngine = require('../services/matching-engine');
const locationService = require('../services/location-service');
const driverWalletService = require('../services/driver-wallet-service');
const redis = require('../services/redis-mock');

const PORT = 3110;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server;

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function createSessionToken(phoneNumber) {
  const requestRes = await api('/api/v1/auth/otp/request', {
    method: 'POST',
    body: { phoneNumber, otpType: 'login' },
  });

  const pending = identityService.otpByRequestId.get(requestRes.json.requestId);
  const verifyRes = await api('/api/v1/auth/otp/verify', {
    method: 'POST',
    body: {
      phoneNumber,
      requestId: requestRes.json.requestId,
      otpCode: pending?.otpCode,
    },
  });
  return { requestRes, verifyRes };
}

test.before(async () => {
  bootstrapTestData();
  matchingEngine.registerDriver({
    driverId: 'DRV-CONTRACT-1',
    name: 'Contract Driver',
    status: 'online',
    vehicleType: 'sedan',
    vehicleNumber: 'KA01TEST',
    acceptanceRate: 0.95,
    completionRate: 0.98,
    rating: 4.9,
    lastTripEndTime: Date.now() - 60 * 60 * 1000,
  });
  locationService.updateLocation('DRV-CONTRACT-1', {
    lat: 12.9716,
    lng: 77.5946,
    speed: 10,
    heading: 90,
  });
  driverWalletService.rechargeWallet('DRV-CONTRACT-1', 500, 'contract_test');
  server = startAPIServer(PORT);
  await new Promise(resolve => setTimeout(resolve, 100));
});

test.after(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
  redis.stop();
});

test('contract: OTP request -> verify issues session token', async () => {
  const phoneNumber = '+919111111111';
  const { requestRes, verifyRes } = await createSessionToken(phoneNumber);
  assert.equal(requestRes.status, 200);
  assert.equal(requestRes.json.success, true);
  assert.ok(requestRes.json.requestId);
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.json.success, true);
  assert.ok(verifyRes.json.sessionToken);
});

test('contract: rider auth API shape request-otp -> login', async () => {
  const phone = '9876543210';
  const countryCode = '+91';
  const requestRes = await api('/api/v1/auth/request-otp', {
    method: 'POST',
    body: { phone, countryCode, channel: 'sms' },
  });
  assert.equal(requestRes.status, 200);
  assert.equal(requestRes.json.success, true);
  assert.ok(requestRes.json.data?.requestId);
  assert.equal(typeof requestRes.json.data?.expiresInSec, 'number');

  const combinedPhone = `${countryCode}${phone}`;
  const pending = identityService.otpByRequestId.get(requestRes.json.data.requestId);
  const otp = pending?.otpCode;
  assert.ok(otp);

  const loginRes = await api('/api/v1/auth/login', {
    method: 'POST',
    body: {
      phone,
      countryCode,
      otp,
      deviceId: 'android-2f3a9c',
      platform: 'android',
      fcmToken: 'fcm_token_optional',
    },
  });

  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.json.success, true);
  assert.equal(loginRes.json.message, 'Login successful');
  assert.ok(loginRes.json.data?.accessToken);
  assert.ok(loginRes.json.data?.refreshToken);
  assert.equal(loginRes.json.data?.user?.phone, combinedPhone.replace(/^\+/, ''));
});

test('contract: refresh token rotates tokens without forcing OTP login again', async () => {
  const phone = '9000000001';
  const countryCode = '+91';
  const requestRes = await api('/api/v1/auth/request-otp', {
    method: 'POST',
    body: { phone, countryCode, channel: 'sms' },
  });
  const requestId = requestRes.json.data?.requestId;
  const pending = identityService.otpByRequestId.get(requestId);
  const otp = pending?.otpCode;

  const loginRes = await api('/api/v1/auth/login', {
    method: 'POST',
    body: {
      phone,
      countryCode,
      otp,
      deviceId: 'android-refresh-1',
      platform: 'android',
      fcmToken: 'fcm_refresh_token',
    },
  });

  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.json.data?.accessToken);
  assert.ok(loginRes.json.data?.refreshToken);

  const refreshRes = await api('/api/v1/auth/refresh-token', {
    method: 'POST',
    body: {
      refreshToken: loginRes.json.data.refreshToken,
      deviceId: 'android-refresh-1',
      platform: 'android',
    },
  });

  assert.equal(refreshRes.status, 200);
  assert.ok(refreshRes.json.data?.accessToken);
  assert.ok(refreshRes.json.data?.refreshToken);
  assert.notEqual(
    refreshRes.json.data.accessToken,
    loginRes.json.data.accessToken,
  );
  assert.notEqual(
    refreshRes.json.data.refreshToken,
    loginRes.json.data.refreshToken,
  );
});

test('contract: refresh token is rejected from a different device', async () => {
  const phone = '9000000002';
  const countryCode = '+91';
  const requestRes = await api('/api/v1/auth/request-otp', {
    method: 'POST',
    body: { phone, countryCode, channel: 'sms' },
  });
  const requestId = requestRes.json.data?.requestId;
  const pending = identityService.otpByRequestId.get(requestId);
  const otp = pending?.otpCode;

  const loginRes = await api('/api/v1/auth/login', {
    method: 'POST',
    body: {
      phone,
      countryCode,
      otp,
      deviceId: 'android-bound-1',
      platform: 'android',
      fcmToken: 'fcm_bound_token',
    },
  });

  const refreshRes = await api('/api/v1/auth/refresh-token', {
    method: 'POST',
    body: {
      refreshToken: loginRes.json.data.refreshToken,
      deviceId: 'android-other-device',
      platform: 'android',
    },
  });

  assert.equal(refreshRes.status, 401);
  assert.equal(refreshRes.json.success, false);
  assert.equal(refreshRes.json.errorCode, 'INVALID_REFRESH_TOKEN');
});

test('contract: repeated suspicious refresh attempts revoke the refresh session', async () => {
  const phone = '9000000003';
  const countryCode = '+91';
  const requestRes = await api('/api/v1/auth/request-otp', {
    method: 'POST',
    body: { phone, countryCode, channel: 'sms' },
  });
  const requestId = requestRes.json.data?.requestId;
  const pending = identityService.otpByRequestId.get(requestId);
  const otp = pending?.otpCode;

  const loginRes = await api('/api/v1/auth/login', {
    method: 'POST',
    body: {
      phone,
      countryCode,
      otp,
      deviceId: 'android-bound-3',
      platform: 'android',
      fcmToken: 'fcm_bound_token_3',
    },
  });

  for (let i = 0; i < 2; i++) {
    const suspiciousRes = await api('/api/v1/auth/refresh-token', {
      method: 'POST',
      body: {
        refreshToken: loginRes.json.data.refreshToken,
        deviceId: 'android-attacker-device',
        platform: 'android',
      },
    });
    assert.equal(suspiciousRes.status, 401);
    assert.equal(suspiciousRes.json.errorCode, 'INVALID_REFRESH_TOKEN');
  }

  const revokedRes = await api('/api/v1/auth/refresh-token', {
    method: 'POST',
    body: {
      refreshToken: loginRes.json.data.refreshToken,
      deviceId: 'android-attacker-device',
      platform: 'android',
    },
  });
  assert.equal(revokedRes.status, 401);
  assert.equal(revokedRes.json.errorCode, 'REFRESH_TOKEN_REVOKED');

  const legitimateRes = await api('/api/v1/auth/refresh-token', {
    method: 'POST',
    body: {
      refreshToken: loginRes.json.data.refreshToken,
      deviceId: 'android-bound-3',
      platform: 'android',
    },
  });
  assert.equal(legitimateRes.status, 401);
  assert.equal(legitimateRes.json.errorCode, 'INVALID_REFRESH_TOKEN');
});

test('contract: ride request -> matched/driver arriving', async () => {
  const { verifyRes } = await createSessionToken('+919222222222');
  const sessionToken = verifyRes.json.sessionToken;
  const riderUserId = verifyRes.json.user.userId;
  const oldRandom = Math.random;
  Math.random = () => 0.9;

  try {
    const rideRes = await api('/api/v1/rides/request', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
      body: {
        riderId: riderUserId,
        pickupLat: 12.9716,
        pickupLng: 77.5946,
        destLat: 12.9352,
        destLng: 77.6245,
        rideType: 'sedan',
      },
    });

    assert.equal(rideRes.status, 200);
    assert.ok(rideRes.json.rideId);
    assert.equal(rideRes.json.status, 'DRIVER_ARRIVING');
    assert.ok(rideRes.json.driver?.driverId);
  } finally {
    Math.random = oldRandom;
  }
});

test('contract: cancel ride + wallet refund endpoint', async () => {
  const { verifyRes } = await createSessionToken('+919333333333');
  const sessionToken = verifyRes.json.sessionToken;
  const riderUserId = verifyRes.json.user.userId;
  matchingEngine.updateDriverStatus('DRV-CONTRACT-1', 'online');
  const oldRandom = Math.random;
  Math.random = () => 0.9;

  const createRes = await api('/api/v1/rides/request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}` },
    body: {
      riderId: riderUserId,
      pickupLat: 12.9716,
      pickupLng: 77.5946,
      destLat: 12.9616,
      destLng: 77.6046,
      rideType: 'sedan',
    },
  });
  Math.random = oldRandom;

  assert.equal(createRes.status, 200);
  const { rideId } = createRes.json;
  assert.ok(rideId);

  const cancelRes = await api(`/api/v1/rides/${rideId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}` },
    body: { cancelledBy: 'rider', userId: riderUserId },
  });

  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.json.success, true);

  const refundRes = await api(`/api/v1/wallet/${riderUserId}/refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}` },
    body: { amount: 25, rideId, reason: 'contract_test' },
  });

  assert.equal(refundRes.status, 200);
  assert.equal(refundRes.json.success, true);
});
