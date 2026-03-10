'use strict';

const crypto = require('crypto');
const config = require('../../config');
const log = require('../observability/logger');

class KafkaProducer {
  constructor() {
    this.enabled = config.kafka?.backend === 'real';
    this.client = null;
  }

  _getClient() {
    if (!this.enabled) return null;
    if (!this.client) {
      // Lazy require to avoid startup hard-fail when Kafka is intentionally disabled.
      this.client = require('../../services/kafka-client');
    }
    return this.client;
  }

  async publish(topic, payload = {}, key = null) {
    const client = this._getClient();
    if (!client) return { queued: false, reason: 'kafka_outbox_disabled' };

    const envelope = {
      eventId: payload.eventId || crypto.randomUUID(),
      occurredAt: payload.occurredAt || new Date().toISOString(),
      ...payload,
    };

    await client.publish(topic, { ...envelope, _key: key || undefined });
    log.info('kafka_publish', { topic, key: key || null, eventId: envelope.eventId });
    return { queued: true, eventId: envelope.eventId };
  }
}

module.exports = KafkaProducer;
