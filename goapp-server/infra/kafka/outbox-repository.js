'use strict';

const crypto = require('crypto');
const domainDb = require('../db/domain-db');

class OutboxRepository {
  async enqueueWithClient(client, domain, event) {
    const payload = event?.payload || {};
    await client.query(
      `INSERT INTO outbox_events (
         id,
         domain,
         topic,
         partition_key,
         event_type,
         aggregate_type,
         aggregate_id,
         event_version,
         payload,
         region,
         idempotency_key,
         status,
         available_at,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, COALESCE($8, 1), $9::jsonb, COALESCE($10, 'ap-south-1'),
         $11, 'pending', NOW(), NOW(), NOW()
       )
       ON CONFLICT (domain, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO NOTHING`,
      [
        event.eventId || crypto.randomUUID(),
        domain,
        event.topic,
        event.partitionKey || null,
        event.eventType,
        event.aggregateType,
        event.aggregateId,
        event.version || 1,
        JSON.stringify(payload),
        event.region || null,
        event.idempotencyKey || null,
      ]
    );
  }

  async enqueue(domain, event) {
    return domainDb.withTransaction(domain, async (client) => {
      await this.enqueueWithClient(client, domain, event);
      return { queued: true };
    });
  }

  async claimBatch(domain, limit = 100) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return domainDb.withTransaction(domain, async (client) => {
      const { rows } = await client.query(
        `WITH picked AS (
           SELECT id
           FROM outbox_events
           WHERE status IN ('pending', 'failed')
             AND available_at <= NOW()
           ORDER BY created_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox_events o
         SET status = 'processing',
             attempts = o.attempts + 1,
             updated_at = NOW()
         FROM picked
         WHERE o.id = picked.id
         RETURNING
           o.id,
           o.domain,
           o.topic,
           o.partition_key AS "partitionKey",
           o.event_type AS "eventType",
           o.aggregate_type AS "aggregateType",
           o.aggregate_id AS "aggregateId",
           o.payload,
           o.attempts,
           o.idempotency_key AS "idempotencyKey"`,
        [safeLimit]
      );
      return rows;
    });
  }

  async markSent(domain, id) {
    await domainDb.query(
      domain,
      `UPDATE outbox_events
       SET status = 'sent',
           published_at = NOW(),
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [id],
      { role: 'writer', strongRead: true }
    );
  }

  async markFailed(domain, id, errorMessage, nextRetrySec = 30) {
    const retrySec = Math.max(5, Math.min(Number(nextRetrySec) || 30, 600));
    await domainDb.query(
      domain,
      `UPDATE outbox_events
       SET status = 'failed',
           last_error = LEFT($2, 1000),
           available_at = NOW() + make_interval(secs => $3),
           updated_at = NOW()
       WHERE id = $1`,
      [id, String(errorMessage || 'unknown_outbox_error'), retrySec],
      { role: 'writer', strongRead: true }
    );
  }
}

module.exports = OutboxRepository;
