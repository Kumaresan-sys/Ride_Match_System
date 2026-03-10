// GoApp Kafka client wrapper
// Safe bootstrap behavior:
// - No process exit on startup failure
// - Lazy producer/consumer connect
// - Graceful no-op when Kafka backend is disabled or kafkajs is missing

'use strict';

const config = require('../config');
const { logger } = require('../utils/logger');

class RealKafkaBus {
  constructor() {
    this._producer = null;
    this._consumers = new Map(); // `${topic}:${groupId}` => consumer
    this._ready = false;
    this._connectPromise = null;
    this._backendEnabled = config.kafka?.backend === 'real';
    this._kafkaLibAvailable = true;

    try {
      // Probe dependency at startup for clear operator signal.
      // eslint-disable-next-line global-require
      require.resolve('kafkajs');
    } catch (_) {
      this._kafkaLibAvailable = false;
      logger.error('KAFKA', 'kafkajs dependency not installed. Kafka publish/consume is disabled.');
    }
  }

  async connect() {
    if (!this._backendEnabled || !this._kafkaLibAvailable) return false;
    if (this._ready) return true;
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = (async () => {
      try {
        const { Kafka, logLevel, Partitioners } = require('kafkajs');
        this._kafka = new Kafka({
          clientId: config.kafka.clientId || 'goapp-server',
          brokers: config.kafka.brokers || ['localhost:9092'],
          logLevel: logLevel.WARN,
          retry: {
            initialRetryTime: 200,
            retries: 8,
          },
        });

        const configuredPartitioner = String(
          process.env.KAFKA_PRODUCER_PARTITIONER ||
          config.kafka?.producerPartitioner ||
          'legacy'
        )
          .trim()
          .toLowerCase();

        const useDefaultPartitioner = configuredPartitioner === 'default';
        const createPartitioner = useDefaultPartitioner
          ? Partitioners.DefaultPartitioner
          : Partitioners.LegacyPartitioner;

        this._producer = this._kafka.producer({
          allowAutoTopicCreation: true,
          createPartitioner,
        });
        await this._producer.connect();
        this._ready = true;
        logger.info(
          'KAFKA',
          `Producer partitioner set to ${useDefaultPartitioner ? 'default' : 'legacy'}`
        );
        logger.info('KAFKA', `Producer connected to ${(config.kafka.brokers || ['localhost:9092']).join(',')}`);
        return true;
      } catch (err) {
        this._ready = false;
        logger.error('KAFKA', `Producer connection failed: ${err.message}`);
        return false;
      } finally {
        this._connectPromise = null;
      }
    })();

    return this._connectPromise;
  }

  publish(topic, payload) {
    if (!this._backendEnabled || !this._kafkaLibAvailable) {
      return Promise.resolve({ queued: false, reason: 'kafka_disabled' });
    }

    return this._publishInternal(topic, payload);
  }

  async _publishInternal(topic, payload) {
    const connected = await this.connect();
    if (!connected || !this._producer) {
      throw new Error(`Producer unavailable for topic ${topic}`);
    }

    await this._producer.send({
      topic,
      messages: [{ value: JSON.stringify({ ...payload, _ts: Date.now() }) }],
    });
    return { queued: true };
  }

  async subscribe(topic, groupId, handler) {
    if (!this._backendEnabled || !this._kafkaLibAvailable) {
      logger.warn('KAFKA', `Subscribe skipped [${topic}/${groupId}] because Kafka backend is disabled.`);
      return;
    }

    const connected = await this.connect();
    if (!connected || !this._kafka) {
      throw new Error(`Kafka not connected for subscription ${topic}/${groupId}`);
    }

    const consumer = this._kafka.consumer({
      groupId,
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
    });

    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        try {
          if (!message || message.value == null) return;
          const payload = this._decodeMessagePayload(message.value, topic, groupId);
          if (payload == null) return;
          await handler(payload);
        } catch (err) {
          logger.error('KAFKA', `Consumer error [${topic}/${groupId}]: ${err.message}`, {
            stack: err?.stack || null,
            valueType: message?.value == null ? null : typeof message.value,
          });
        }
      },
    });

    this._consumers.set(`${topic}:${groupId}`, consumer);
    logger.info('KAFKA', `Subscribed to [${topic}] as group [${groupId}]`);
  }

  _decodeMessagePayload(rawValue, topic, groupId) {
    if (rawValue == null) return null;

    // Handle nested wrapper payloads from some producers/libraries.
    if (rawValue && typeof rawValue === 'object' && rawValue.value != null) {
      return this._decodeMessagePayload(rawValue.value, topic, groupId);
    }

    if (typeof rawValue === 'object' && !Buffer.isBuffer(rawValue) && !(rawValue instanceof Uint8Array)) {
      // Handle JSON-serialized Buffer objects: { type: 'Buffer', data: [...] }
      if (rawValue.type === 'Buffer' && Array.isArray(rawValue.data)) {
        const text = Buffer.from(rawValue.data).toString('utf8');
        const trimmed = text.trim();
        if (!trimmed) return null;
        return JSON.parse(trimmed);
      }
      return rawValue;
    }

    let text;
    if (Buffer.isBuffer(rawValue) || rawValue instanceof Uint8Array) {
      text = Buffer.from(rawValue).toString('utf8');
    } else if (typeof rawValue === 'string') {
      text = rawValue;
    } else {
      logger.warn(
        'KAFKA',
        `Skipping message with unsupported payload type [${topic}/${groupId}]: ${typeof rawValue}`
      );
      return null;
    }

    const trimmed = text.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  }

  async disconnect() {
    for (const consumer of this._consumers.values()) {
      await consumer.disconnect().catch(() => {});
    }

    if (this._producer) {
      await this._producer.disconnect().catch(() => {});
    }

    this._ready = false;
    logger.info('KAFKA', 'Disconnected');
  }

  getRecentEvents() {
    return [];
  }

  getStats() {
    return {
      backend: this._backendEnabled ? 'real' : 'disabled',
      ready: this._ready,
      consumers: this._consumers.size,
      brokers: config.kafka?.brokers || ['localhost:9092'],
    };
  }
}

module.exports = new RealKafkaBus();
