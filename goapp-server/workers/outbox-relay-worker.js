'use strict';

const config = require('../config');
const OutboxRepository = require('../infra/kafka/outbox-repository');
const KafkaProducer = require('../infra/kafka/producer');
const logger = require('../infra/observability/logger');

class OutboxRelayWorker {
  constructor({ domains, batchSize = 100, pollMs = 500 } = {}) {
    this.repo = new OutboxRepository();
    this.producer = new KafkaProducer();
    this.batchSize = Math.max(1, Math.min(Number(batchSize) || 100, 500));
    this.pollMs = Math.max(100, Number(pollMs) || 500);
    this.domains = domains || Object.keys(config.architecture?.dbTopology || {}).filter(Boolean);
    if (!this.domains.length) {
      this.domains = ['rides', 'payments', 'drivers', 'identity', 'analytics'];
    }

    this.running = false;
    this._busy = false;
    this._timer = null;
  }

  async start() {
    if (this.running) return { started: true, alreadyRunning: true };
    this.running = true;

    logger.info('outbox_relay_start', {
      domains: this.domains,
      batchSize: this.batchSize,
      pollMs: this.pollMs,
      kafkaBackend: config.kafka?.backend || 'unknown',
    });

    await this._tick();
    this._timer = setInterval(() => {
      this._tick().catch((err) => {
        logger.error('outbox_relay_tick_error', { error: err.message });
      });
    }, this.pollMs);

    return { started: true };
  }

  async stop() {
    this.running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    return { stopped: true };
  }

  async _tick() {
    if (!this.running || this._busy) return;
    if (!this.producer.enabled) return;

    this._busy = true;
    try {
      for (const domain of this.domains) {
        const claimed = await this.repo.claimBatch(domain, this.batchSize).catch((err) => {
          logger.warn('outbox_relay_claim_failed', { domain, error: err.message });
          return [];
        });

        if (!claimed.length) continue;

        for (const event of claimed) {
          const payload = (event.payload && typeof event.payload === 'string')
            ? JSON.parse(event.payload)
            : (event.payload || {});

          try {
            await this.producer.publish(
              event.topic,
              {
                ...payload,
                eventType: event.eventType,
                aggregateType: event.aggregateType,
                aggregateId: event.aggregateId,
                idempotencyKey: event.idempotencyKey || undefined,
              },
              event.partitionKey || event.aggregateId || event.id
            );

            await this.repo.markSent(domain, event.id);
          } catch (err) {
            const retrySec = Math.min(300, Math.max(5, 2 ** Math.min(Number(event.attempts || 1), 8)));
            await this.repo.markFailed(domain, event.id, err.message, retrySec);
            logger.warn('outbox_relay_publish_failed', {
              domain,
              outboxId: event.id,
              topic: event.topic,
              attempts: event.attempts,
              retrySec,
              error: err.message,
            });
          }
        }
      }
    } finally {
      this._busy = false;
    }
  }
}

module.exports = OutboxRelayWorker;
