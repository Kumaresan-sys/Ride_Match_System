'use strict';

const db = require('./db');
const kafka = require('./kafka-client');
const { logger } = require('../utils/logger');

const ALLOWED_DEEP_LINKS = new Set([
  '/home',
  '/wallet',
  '/support',
  '/sos',
  '/ride',
  '/trip',
  '/support/tickets',
  'wallet_activity_detail',
]);

const CATEGORY_VALUES = new Set([
  'ride',
  'payment',
  'promo',
  'system',
  'security',
  'other',
]);

function normalizeDeepLink(raw) {
  if (raw == null) return '';
  const normalized = String(raw).trim();
  if (normalized === '') return '';
  if (normalized === 'wallet_activity_detail') return normalized;

  if (normalized.includes('://')) {
    const afterScheme = normalized.split('://').slice(1).join('://');
    if (!afterScheme) return '';
    if (afterScheme === 'wallet_activity_detail') return afterScheme;
    const trimmed = afterScheme.replace(/^\/+/, '');
    return trimmed ? `/${trimmed}` : '';
  }

  if (normalized.startsWith('/')) return normalized;
  return `/${normalized}`;
}

function allowDeepLink(path) {
  if (!path) return true;
  const normalized = normalizeDeepLink(path);
  if (normalized === '') return true;
  if (normalized === 'wallet_activity_detail') return true;
  const prefix = normalized.split('/').slice(0, 2).join('/') || normalized;
  return ALLOWED_DEEP_LINKS.has(prefix) ||
    normalized.startsWith('/ride/') ||
    normalized.startsWith('/trip/') ||
    normalized.startsWith('/support/tickets/');
}

function resolveNavSchema(category, deepLink) {
  const normalized = normalizeDeepLink(deepLink);
  if (normalized.startsWith('/ride/')) return 'ride';
  if (normalized.startsWith('/trip/')) return 'trip';
  if (normalized.startsWith('/support/tickets/')) return 'support';
  if (normalized === 'wallet_activity_detail') return 'payment';
  if (category === 'payment') return 'payment';
  if (category === 'promo') return 'promo';
  if (category === 'ride') return 'ride';
  return null;
}

function parseNavPayload(payload) {
  if (payload == null) return null;
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch (_) {
      return null;
    }
  }
  if (typeof payload === 'object') return payload;
  return null;
}

function validateNavPayload(schema, payload) {
  if (!schema) return { ok: true };
  if (payload == null || typeof payload !== 'object') {
    return { ok: false, error: 'nav_payload must be an object' };
  }

  const ensureString = (value) => typeof value === 'string' && value.trim() !== '';

  switch (schema) {
    case 'ride':
      if (!ensureString(payload.rideId)) {
        return { ok: false, error: 'nav_payload.rideId is required' };
      }
      return { ok: true };
    case 'trip':
      if (!ensureString(payload.rideId)) {
        return { ok: false, error: 'nav_payload.rideId is required' };
      }
      return { ok: true };
    case 'support':
      if (!ensureString(payload.ticketId)) {
        return { ok: false, error: 'nav_payload.ticketId is required' };
      }
      return { ok: true };
    case 'payment':
      if (!ensureString(payload.paymentId)) {
        return { ok: false, error: 'nav_payload.paymentId is required' };
      }
      if (!ensureString(payload.status)) {
        return { ok: false, error: 'nav_payload.status is required' };
      }
      if (!ensureString(payload.method)) {
        return { ok: false, error: 'nav_payload.method is required' };
      }
      if (payload.amount == null || Number.isNaN(Number(payload.amount))) {
        return { ok: false, error: 'nav_payload.amount is required' };
      }
      return { ok: true };
    case 'promo':
      if (!ensureString(payload.campaignId)) {
        return { ok: false, error: 'nav_payload.campaignId is required' };
      }
      return { ok: true };
    default:
      return { ok: true };
  }
}

function buildCursor(createdAt, id) {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64');
}

function parseCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const [ts, id] = decoded.split('|');
    return { createdAt: new Date(ts), id };
  } catch (_) {
    return null;
  }
}

function mapNotificationRow(row) {
  if (!row) return row;
  return {
    ...row,
    message: row.body,
  };
}

async function listNotifications(userId, { cursor, limit = 20 } = {}) {
  const parsed = parseCursor(cursor);
  const params = [userId];
  let whereCursor = '';
  if (parsed) {
    params.push(parsed.createdAt);
    params.push(parsed.id);
    whereCursor =
      ` AND (created_at, id) < ($2, $3)`;
  }
  params.push(limit);
  const { rows } = await db.query(
    `
    SELECT *
    FROM notifications
    WHERE user_id = $1
      AND status NOT IN ('deleted','expired')
      AND (expires_at IS NULL OR expires_at > NOW())
      ${whereCursor}
    ORDER BY created_at DESC, id DESC
    LIMIT $${params.length}
    `,
    params
  );
  const nextCursor =
    rows.length === limit
      ? buildCursor(rows[rows.length - 1].created_at, rows[rows.length - 1].id)
      : null;
  const unread = await unreadCount(userId);
  return { items: rows.map(mapNotificationRow), nextCursor, unreadCount: unread };
}

async function unreadCount(userId) {
  const { rows } = await db.query(
    `
    SELECT count(*)::int AS count
    FROM notifications
    WHERE user_id = $1
      AND status = 'unread'
      AND (expires_at IS NULL OR expires_at > NOW())
    `,
    [userId]
  );
  return rows[0]?.count || 0;
}

async function createNotification(userId, payload) {
  const {
    title,
    message,
    body,
    category,
    deep_link: deepLink,
    nav_payload: navPayload,
    source_service: sourceService,
    reference_type: referenceType,
    reference_id: referenceId,
    event_type: eventType,
    expires_at: expiresAt,
  } = payload;

  const normalizedCategory = String(category || '').trim().toLowerCase();
  if (!CATEGORY_VALUES.has(normalizedCategory)) {
    await appendEvent(null, userId, 'failed_validation', {
      error: 'invalid_category',
      category,
    });
    return null;
  }
  const resolvedCategory = normalizedCategory;
  const resolvedNavPayload = parseNavPayload(navPayload);
  const schema = resolveNavSchema(resolvedCategory, deepLink);
  if (!allowDeepLink(deepLink)) {
    await appendEvent(null, userId, 'failed_validation', { deepLink });
    return null;
  }
  const navValidation = validateNavPayload(schema, resolvedNavPayload);
  if (!navValidation.ok) {
    await appendEvent(null, userId, 'failed_validation', {
      deepLink,
      error: navValidation.error,
    });
    return null;
  }

  // idempotency check
  if (sourceService && referenceType && referenceId && eventType) {
    const { rows } = await db.query(
      `SELECT id FROM notifications
       WHERE user_id = $1
         AND source_service = $2
         AND reference_type = $3
         AND reference_id = $4
         AND event_type = $5
       LIMIT 1`,
      [userId, sourceService, referenceType, referenceId, eventType]
    );
    if (rows[0]?.id) {
      return rows[0].id;
    }
  }

  const { rows } = await db.query(
    `INSERT INTO notifications (
       user_id, channel, title, body, data_payload, priority, status,
       category, deep_link,
       reference_type, reference_id, event_type,
       nav_payload, source_service, expires_at, updated_at, created_at
     ) VALUES (
       $1, 'in_app', $2, $3, $4::jsonb, 'normal', 'unread',
       $5, $6,
       $7, $8, $9,
       $10::jsonb, $11, $12, NOW(), NOW()
     )
     RETURNING id`,
    [
      userId,
      title,
      message || body,
      JSON.stringify(resolvedNavPayload || {}),
      resolvedCategory,
      deepLink,
      referenceType,
      referenceId,
      eventType,
      JSON.stringify(resolvedNavPayload || {}),
      sourceService,
      expiresAt,
    ]
  );
  const id = rows[0]?.id;
  await appendEvent(id, userId, 'created', {
    sourceService,
    referenceType,
    referenceId,
    eventType,
    deepLink,
  });
  return id;
}

async function markRead(userId, id) {
  const { rows } = await db.query(
    `UPDATE notifications
     SET status = 'read', read_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'unread'
     RETURNING id`,
    [id, userId]
  );
  if (rows[0]?.id) {
    await appendEvent(id, userId, 'read');
    return rows[0].id;
  }
  const existing = await db.query(
    `SELECT id FROM notifications WHERE id = $1 AND user_id = $2 AND status = 'read'`,
    [id, userId]
  );
  return existing.rows[0]?.id || null;
}

async function markAllRead(userId) {
  const { rows } = await db.query(
    `UPDATE notifications
     SET status = 'read', read_at = NOW(), updated_at = NOW()
     WHERE user_id = $1 AND status = 'unread'
     RETURNING id`,
    [userId]
  );
  const ids = rows.map((row) => row.id);
  for (const id of ids) {
    await appendEvent(id, userId, 'read', { bulk: true });
  }
  return ids;
}

async function softDelete(userId, id) {
  const { rows } = await db.query(
    `UPDATE notifications
     SET status = 'deleted', deleted_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status IN ('unread','read')
     RETURNING id`,
    [id, userId]
  );
  if (rows[0]?.id) {
    await appendEvent(id, userId, 'deleted');
    return rows[0].id;
  }
  const existing = await db.query(
    `SELECT id FROM notifications WHERE id = $1 AND user_id = $2 AND status = 'deleted'`,
    [id, userId]
  );
  return existing.rows[0]?.id || null;
}

async function appendEvent(notificationId, userId, action, metadata = {}) {
  try {
    const { rows } = await db.query(
      `INSERT INTO notification_events (
         notification_id, user_id, action, actor_type, actor_id, metadata
       ) VALUES ($1, $2, $3, 'system', NULL, $4::jsonb)
       RETURNING id`,
      [notificationId, userId, action, JSON.stringify(metadata || {})]
    );
    kafka.publish('notifications.events', {
      notificationId,
      userId,
      action,
      metadata,
    }).catch(() => {});
    return rows[0]?.id || null;
  } catch (err) {
    logger.warn('NOTIFICATIONS', `Failed to append event ${action}: ${err.message}`);
    return null;
  }
}

async function expireNotifications() {
  const { rows } = await db.query(
    `UPDATE notifications
       SET status = 'expired', updated_at = NOW()
     WHERE expires_at IS NOT NULL
       AND expires_at < NOW()
       AND status IN ('unread','read')
     RETURNING id, user_id`
  );
  for (const row of rows) {
    await appendEvent(row.id, row.user_id, 'expired');
  }
  return rows.length;
}

module.exports = {
  listNotifications,
  unreadCount,
  createNotification,
  markRead,
  markAllRead,
  softDelete,
  appendEvent,
  expireNotifications,
};
