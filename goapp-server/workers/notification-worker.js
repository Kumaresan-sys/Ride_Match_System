'use strict';

const { TOPICS } = require('../infra/kafka/topics');
const KafkaConsumer = require('../infra/kafka/consumer');
const logger = require('../infra/observability/logger');

class NotificationWorker {
  constructor({ notificationService }) {
    this.notificationService = notificationService;
    this.consumer = new KafkaConsumer();
  }

  async start() {
    const res = await this.consumer.subscribe(TOPICS.NOTIFICATION_DISPATCH_REQUESTED, 'notification-worker', async (event) => {
      logger.info('notification_worker_event', { topic: TOPICS.NOTIFICATION_DISPATCH_REQUESTED, userId: event.userId, rideId: event.rideId });
      // Extend with provider routing and retry policies.
    });
    return res;
  }
}

module.exports = NotificationWorker;
