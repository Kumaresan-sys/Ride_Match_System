'use strict';

const { TOPICS } = require('../infra/kafka/topics');
const KafkaConsumer = require('../infra/kafka/consumer');
const logger = require('../infra/observability/logger');
const domainProjectionService = require('../services/domain-projection-service');

class DomainProjectionWorker {
  constructor() {
    this.consumer = new KafkaConsumer();
    this.topics = [
      TOPICS.RIDE_REQUESTED,
      TOPICS.RIDE_MATCHED,
      TOPICS.PAYMENT_COMPLETED,
      TOPICS.WALLET_UPDATED,
      TOPICS.IDENTITY_PROFILE_UPDATED,
      TOPICS.DRIVER_PROFILE_UPDATED,
    ].filter(Boolean);
  }

  async start() {
    for (const topic of this.topics) {
      const groupSuffix = `domain-projection-worker-${String(topic).toLowerCase()}`;
      // eslint-disable-next-line no-await-in-loop
      await this.consumer.subscribe(topic, groupSuffix, async (event) => {
        try {
          const result = await domainProjectionService.syncFromEvent(topic, event || {});
          logger.info('domain_projection_event', {
            topic,
            synced: Boolean(result?.synced),
            attempted: result?.attempted || 0,
            failures: result?.failures || 0,
          });
        } catch (err) {
          logger.error('domain_projection_event_error', {
            topic,
            error: err.message,
          });
        }
      });
    }

    return {
      started: true,
      topics: this.topics,
    };
  }
}

module.exports = DomainProjectionWorker;
