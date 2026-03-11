'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const dotenv = require('dotenv');
const { Client } = require('pg');

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEV_ENV_FILES = [
  path.join(REPO_ROOT, '.env.development'),
  path.join(REPO_ROOT, '.env.development.local'),
];
const SEEDED_DRIVER_PHONE = '9876500001';

function loadDevelopmentEnv() {
  const env = {};
  DEV_ENV_FILES.forEach((file, index) => {
    if (!fs.existsSync(file)) return;
    dotenv.config({
      path: file,
      processEnv: env,
      override: index === 0,
      quiet: true,
    });
  });
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && /^\$\{[A-Z0-9_]+\}$/.test(value.trim())) {
      delete env[key];
    }
  }
  return env;
}

const devEnv = loadDevelopmentEnv();
const ADMIN_TOKEN = devEnv.GOAPP_ADMIN_TOKEN || 'goapp-admin-secret';

function makeDbConfig(dbName) {
  return {
    host: devEnv.POSTGRES_HOST || 'localhost',
    port: Number(devEnv.POSTGRES_PORT || 5432),
    user: devEnv.POSTGRES_USER || 'goapp',
    password: devEnv.POSTGRES_PASSWORD || 'goapp',
    database: dbName,
  };
}

async function query(dbName, sql, params = []) {
  const client = new Client(makeDbConfig(dbName));
  await client.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

async function requestJson(baseUrl, targetPath, options = {}) {
  const response = await fetch(`${baseUrl}${targetPath}`, options);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

async function requestMultipartJson(baseUrl, targetPath, form, headers = {}) {
  const response = await fetch(`${baseUrl}${targetPath}`, {
    method: 'POST',
    headers,
    body: form,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

function hashOtp(otpCode, secret) {
  return crypto.createHmac('sha256', String(secret || ''))
    .update(String(otpCode))
    .digest('hex');
}

function ensureDevDriversSeeded() {
  const seeded = spawnSync(
    process.execPath,
    ['scripts/dev-seed-drivers.js'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'development' },
      encoding: 'utf8',
    }
  );

  assert.equal(
    seeded.status,
    0,
    `Development driver seed failed: ${String(seeded.stderr || seeded.stdout || '').trim()}`
  );
}

async function waitForCondition(fn, timeoutMs = 20000, intervalMs = 500) {
  const startedAt = Date.now();
  let lastValue = null;
  while ((Date.now() - startedAt) < timeoutMs) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await delay(intervalMs);
  }
  return lastValue;
}

async function loginWithPhone(baseUrl, phone, devicePrefix) {
  const countryCode = '+91';
  const requestOtp = await requestJson(baseUrl, '/api/v1/auth/request-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone,
      countryCode,
      channel: 'sms',
    }),
  });
  assert.equal(requestOtp.status, 200, JSON.stringify(requestOtp.body));
  const requestId = requestOtp.body?.data?.requestId;
  assert.ok(requestId);

  await query(
    'identity_db',
    `UPDATE otp_requests
     SET otp_code = $2
     WHERE id = $1`,
    [requestId, hashOtp('123456', devEnv.OTP_SECRET || 'test-otp-secret')],
  );

  const login = await requestJson(baseUrl, '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone,
      countryCode,
      otp: '123456',
      requestId,
      deviceId: `${devicePrefix}-${Date.now()}`,
      platform: 'android',
      fcmToken: `${devicePrefix}-token-${Date.now()}`,
    }),
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return {
    token: login.body?.data?.accessToken,
    userId: login.body?.data?.user?.id,
  };
}

test('ride chat persists rider-driver messages, attachments, receipts, and admin audit views', { timeout: 120000 }, async (t) => {
  const baseUrl = process.env.GOAPP_DEV_BASE_URL || 'http://127.0.0.1:3000';
  let healthBody = null;
  try {
    const healthResponse = await fetch(`${baseUrl}/api/v1/health`);
    if (!healthResponse.ok) {
      t.skip(`Development API is not healthy at ${baseUrl}.`);
      return;
    }
    const healthText = await healthResponse.text();
    healthBody = healthText ? JSON.parse(healthText) : null;
  } catch (err) {
    if (/connect EPERM|Local TCP access blocked|operation not permitted|ECONNREFUSED|fetch failed/i.test(String(err?.message || ''))) {
      t.skip(`Development API is not reachable at ${baseUrl}.`);
      return;
    }
    throw err;
  }

  const uptimeSec = Number(healthBody?.data?.uptime || 0);
  if (Number.isFinite(uptimeSec) && uptimeSec < 35) {
    await delay(Math.ceil(35 - uptimeSec) * 1000);
  }
  ensureDevDriversSeeded();

  const riderPhone = `9${String(Date.now()).slice(-9)}`;
  const riderLogin = await loginWithPhone(baseUrl, riderPhone, 'ride-chat-rider');
  assert.ok(riderLogin.token);
  assert.ok(riderLogin.userId);

  const profileCreate = await requestJson(baseUrl, '/api/v1/profile/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${riderLogin.token}`,
    },
    body: JSON.stringify({
      name: 'Ride Chat Rider',
      gender: 'Male',
      date_of_birth: '10 March 1994',
      email: `ride-chat-${Date.now()}@goapp.local`,
      emergency_contact: '9876543210',
    }),
  });
  assert.equal(profileCreate.status, 200, JSON.stringify(profileCreate.body));

  const rideRequest = await requestJson(baseUrl, '/api/v1/rides/request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${riderLogin.token}`,
      'Idempotency-Key': `ride-chat-${Date.now()}`,
    },
    body: JSON.stringify({
      pickupLat: 13.0833913,
      pickupLng: 80.1499398,
      destLat: 13.080874,
      destLng: 80.164234,
      pickupAddress: 'Gpvalencia, Mel Ayanambakkam, Chennai',
      destAddress: '103 HIG Mogappair West, Chennai',
      rideType: 'bike',
    }),
  });
  assert.equal(rideRequest.status, 200, JSON.stringify(rideRequest.body));
  const rideNumber = rideRequest.body?.rideId;
  assert.ok(rideNumber);

  const matchedRide = await waitForCondition(async () => {
    const rows = await query(
      'rides_db',
      `SELECT ride_number,
              status,
              driver_id::text AS driver_id
       FROM rides
       WHERE ride_number = $1`,
      [rideNumber],
    );
    const ride = rows[0] || null;
    if (!ride) return null;
    if (!['driver_assigned', 'driver_arriving'].includes(String(ride.status))) return null;
    return ride;
  }, 20000, 500);
  assert.ok(matchedRide, 'ride did not reach matched status');

  const chatSnapshot = await waitForCondition(async () => {
    const response = await requestJson(baseUrl, `/api/v1/rides/${rideNumber}/chat`, {
      headers: { Authorization: `Bearer ${riderLogin.token}` },
    });
    if (response.status !== 200) {
      return null;
    }
    const chat = response.body?.data?.chat;
    return chat?.conversationId ? response : null;
  }, 20000, 500);
  assert.ok(chatSnapshot, 'ride chat did not open after driver assignment');

  const chat = chatSnapshot.body.data.chat;
  const conversationId = chat.conversationId;
  assert.ok(conversationId);
  assert.equal(chat.canSend, true);
  assert.ok(chat.driver.avatarUrl);
  assert.equal(chat.driver.completedRides, 155);
  assert.equal(chat.driver.name, 'Arun Bike');

  const riderText = await requestJson(baseUrl, `/api/v1/rides/${rideNumber}/chat/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${riderLogin.token}`,
    },
    body: JSON.stringify({
      text: 'Please come to gate 2',
      clientMessageId: `ride-chat-msg-${Date.now()}`,
    }),
  });
  assert.equal(riderText.status, 201, JSON.stringify(riderText.body));
  const riderMessage = riderText.body?.data?.message;
  assert.ok(riderMessage?.id);
  assert.equal(riderMessage.textContent, 'Please come to gate 2');

  const driverLogin = await loginWithPhone(baseUrl, SEEDED_DRIVER_PHONE, 'ride-chat-driver');
  assert.ok(driverLogin.token);

  const driverRead = await requestJson(baseUrl, `/api/v1/rides/${rideNumber}/chat/read`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${driverLogin.token}`,
    },
    body: JSON.stringify({
      upToMessageId: riderMessage.id,
    }),
  });
  assert.equal(driverRead.status, 200, JSON.stringify(driverRead.body));

  const driverReply = await requestJson(baseUrl, `/api/v1/rides/${rideNumber}/chat/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${driverLogin.token}`,
    },
    body: JSON.stringify({
      text: 'Reached near the pickup',
      clientMessageId: `ride-chat-driver-msg-${Date.now()}`,
    }),
  });
  assert.equal(driverReply.status, 201, JSON.stringify(driverReply.body));
  const driverMessage = driverReply.body?.data?.message;
  assert.ok(driverMessage?.id);

  const riderRead = await requestJson(baseUrl, `/api/v1/rides/${rideNumber}/chat/read`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${riderLogin.token}`,
    },
    body: JSON.stringify({
      upToMessageId: driverMessage.id,
    }),
  });
  assert.equal(riderRead.status, 200, JSON.stringify(riderRead.body));

  const form = new FormData();
  form.set('text', 'Sharing a photo of the pickup');
  form.set('attachmentType', 'image');
  form.append(
    'attachment',
    new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }),
    'pickup.png',
  );
  const riderAttachment = await requestMultipartJson(
    baseUrl,
    `/api/v1/rides/${rideNumber}/chat/messages`,
    form,
    { Authorization: `Bearer ${riderLogin.token}` },
  );
  assert.equal(riderAttachment.status, 201, JSON.stringify(riderAttachment.body));
  const attachmentMessage = riderAttachment.body?.data?.message;
  assert.ok(attachmentMessage?.attachments?.length, 'attachment message should include stored attachment metadata');
  const attachmentId = attachmentMessage.attachments[0].id;

  const attachmentResponse = await fetch(
    `${baseUrl}/api/v1/rides/${rideNumber}/chat/attachments/${attachmentId}`,
    {
      headers: { Authorization: `Bearer ${riderLogin.token}` },
    },
  );
  assert.equal(attachmentResponse.status, 200);
  assert.equal(attachmentResponse.headers.get('content-type'), 'image/png');
  const attachmentBytes = Buffer.from(await attachmentResponse.arrayBuffer());
  assert.ok(attachmentBytes.length > 0);

  const conversationRow = await query(
    'rides_db',
    `SELECT id, status, message_count, last_message_at
     FROM ride_chat_conversations
     WHERE id = $1`,
    [conversationId],
  );
  assert.equal(conversationRow.length, 1);
  assert.equal(conversationRow[0].status, 'active');
  assert.ok(Number(conversationRow[0].message_count) >= 3);
  assert.ok(conversationRow[0].last_message_at);

  const dbMessages = await query(
    'rides_db',
    `SELECT id, sender_role, message_type, text_content, client_message_id
     FROM ride_chat_messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [conversationId],
  );
  assert.ok(dbMessages.length >= 3);
  assert.ok(dbMessages.some((row) => row.text_content === 'Please come to gate 2'));
  assert.ok(dbMessages.some((row) => row.text_content === 'Reached near the pickup'));

  const dbAttachments = await query(
    'rides_db',
    `SELECT attachment_type, mime_type, original_filename, storage_backend, storage_key
     FROM ride_chat_attachments
     WHERE conversation_id = $1`,
    [conversationId],
  );
  assert.equal(dbAttachments.length, 1);
  assert.equal(dbAttachments[0].attachment_type, 'image');
  assert.equal(dbAttachments[0].mime_type, 'image/png');
  assert.equal(dbAttachments[0].storage_backend, 'local');
  assert.match(String(dbAttachments[0].storage_key || ''), /image\/.+\.png$/);

  const dbReceipts = await query(
    'rides_db',
    `SELECT recipient_user_id::text AS recipient_user_id, delivery_status, read_at
     FROM ride_chat_message_receipts
     WHERE message_id IN ($1::uuid, $2::uuid)
     ORDER BY recipient_user_id ASC`,
    [riderMessage.id, driverMessage.id],
  );
  assert.equal(dbReceipts.length, 2);
  assert.ok(dbReceipts.every((row) => row.delivery_status === 'read'));
  assert.ok(dbReceipts.every((row) => row.read_at));

  const dbEvents = await query(
    'rides_db',
    `SELECT event_type
     FROM ride_chat_events
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [conversationId],
  );
  const eventTypes = dbEvents.map((row) => row.event_type);
  assert.ok(eventTypes.includes('conversation_opened'));
  assert.ok(eventTypes.includes('message_created'));
  assert.ok(eventTypes.includes('attachment_saved'));
  assert.ok(eventTypes.includes('read'));

  const adminList = await requestJson(baseUrl, `/api/v1/admin/ride-chats?rideId=${encodeURIComponent(rideNumber)}`, {
    headers: { 'x-admin-token': ADMIN_TOKEN },
  });
  assert.equal(adminList.status, 200, JSON.stringify(adminList.body));
  const listedConversation = (adminList.body?.data?.conversations || [])[0];
  assert.equal(listedConversation?.id, conversationId);

  const adminConversation = await requestJson(baseUrl, `/api/v1/admin/ride-chats/${conversationId}`, {
    headers: { 'x-admin-token': ADMIN_TOKEN },
  });
  assert.equal(adminConversation.status, 200, JSON.stringify(adminConversation.body));
  assert.equal(adminConversation.body?.data?.chat?.conversationId, conversationId);
  assert.equal(adminConversation.body?.data?.chat?.driver?.name, 'Arun Bike');

  const adminMessages = await requestJson(baseUrl, `/api/v1/admin/ride-chats/${conversationId}/messages`, {
    headers: { 'x-admin-token': ADMIN_TOKEN },
  });
  assert.equal(adminMessages.status, 200, JSON.stringify(adminMessages.body));
  const adminTexts = (adminMessages.body?.data?.messages || []).map((entry) => entry.textContent);
  assert.ok(adminTexts.includes('Please come to gate 2'));
  assert.ok(adminTexts.includes('Reached near the pickup'));

  const adminEvents = await requestJson(baseUrl, `/api/v1/admin/ride-chats/${conversationId}/events`, {
    headers: { 'x-admin-token': ADMIN_TOKEN },
  });
  assert.equal(adminEvents.status, 200, JSON.stringify(adminEvents.body));
  const adminEventTypes = (adminEvents.body?.data?.events || []).map((entry) => entry.eventType);
  assert.ok(adminEventTypes.includes('conversation_opened'));
  assert.ok(adminEventTypes.includes('message_created'));
  assert.ok(adminEventTypes.includes('attachment_saved'));
});
