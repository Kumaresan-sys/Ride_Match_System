'use strict';

const ConnectionManager = require('./db/connection-manager');
const RedisStateStore = require('./redis/state-store');
const KafkaProducer = require('./kafka/producer');
const KafkaConsumer = require('./kafka/consumer');
const metrics = require('./observability/metrics');
const tracing = require('./observability/tracing');
const logger = require('./observability/logger');
const { attachEventBridge } = require('./kafka/event-bridge');
const config = require('../config');

async function bootstrapArchitecture({ eventBus }) {
  const connectionManager = new ConnectionManager();
  const stateStore = new RedisStateStore();
  const producer = new KafkaProducer();
  const consumer = new KafkaConsumer();

  const bridge = config.architecture?.featureFlags?.kafkaEventBridge
    ? attachEventBridge(eventBus, producer)
    : { enabled: false, detach: () => {} };

  logger.info('architecture_bootstrap', {
    matchingV2: process.env.MATCHING_V2 === 'true',
    redisStateV2: process.env.REDIS_STATE_V2 === 'true',
    kafkaOutbox: process.env.KAFKA_OUTBOX === 'true',
    eventBridgeEnabled: bridge.enabled,
    kafkaOutboxRelayWorker: process.env.KAFKA_OUTBOX_RELAY_WORKER === 'true',
    kafkaDomainProjectionWorker: process.env.KAFKA_DOMAIN_PROJECTION_WORKER === 'true',
  });

  return {
    db: connectionManager,
    redis: stateStore,
    kafka: { producer, consumer, bridge },
    observability: { logger, metrics, tracing },
  };
}

module.exports = {
  bootstrapArchitecture,
};
