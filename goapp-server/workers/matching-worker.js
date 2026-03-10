'use strict';

const { TOPICS } = require('../infra/kafka/topics');
const KafkaConsumer = require('../infra/kafka/consumer');
const logger = require('../infra/observability/logger');

class MatchingWorker {
  constructor({ rideService, matchingEngine }) {
    this.rideService = rideService;
    this.matchingEngine = matchingEngine;
    this.consumer = new KafkaConsumer();
  }

  async start() {
    const res = await this.consumer.subscribe(TOPICS.RIDE_REQUESTED, 'matching-worker', async (event) => {
      logger.info('matching_worker_event', { topic: TOPICS.RIDE_REQUESTED, rideId: event.rideId });
      const result = await this.rideService.processRideRequestedEvent(event);
      logger.info('matching_worker_result', { rideId: event.rideId, success: Boolean(result?.success), reason: result?.reason || null });
    });
    return res;
  }
}

module.exports = MatchingWorker;
