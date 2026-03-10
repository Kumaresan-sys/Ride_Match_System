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
      const normalized = this._normalizeEvent(event);
      logger.info('matching_worker_event', {
        topic: TOPICS.RIDE_REQUESTED,
        rideId: normalized.rideId || null,
        aggregateId: normalized.aggregateId || null,
      });
      const result = await this.rideService.processRideRequestedEvent(normalized);
      logger.info('matching_worker_result', {
        rideId: normalized.rideId || normalized.aggregateId || null,
        success: Boolean(result?.success),
        reason: result?.reason || null,
      });
    });
    return res;
  }

  _normalizeEvent(event) {
    if (!event || typeof event !== 'object') return {};
    if (event.payload && typeof event.payload === 'object') {
      return {
        ...event.payload,
        eventId: event.eventId || event.payload.eventId,
        eventType: event.eventType || event.payload.eventType,
        aggregateId: event.aggregateId || event.payload.aggregateId,
      };
    }
    return event;
  }
}

module.exports = MatchingWorker;
