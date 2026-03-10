'use strict';

const config = require('../../config');

class KafkaConsumer {
  constructor() {
    this.enabled = config.kafka?.backend === 'real';
    this.client = null;
  }

  _getClient() {
    if (!this.enabled) return null;
    if (!this.client) {
      this.client = require('../../services/kafka-client');
    }
    return this.client;
  }

  async subscribe(topic, groupSuffix, handler) {
    const client = this._getClient();
    if (!client) return { subscribed: false, reason: 'kafka_outbox_disabled' };
    const groupId = `${config.kafka.groupPrefix}-${groupSuffix}`;
    await client.subscribe(topic, groupId, handler);
    return { subscribed: true, topic, groupId };
  }
}

module.exports = KafkaConsumer;
