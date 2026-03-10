'use strict';

const { mapEventToTopic, keyForTopic } = require('./topics');
const log = require('../observability/logger');

function attachEventBridge(eventBus, producer) {
  if (!eventBus || !producer || !producer.enabled) {
    return { enabled: false, detach: () => {} };
  }

  const handler = async (event) => {
    const topic = mapEventToTopic(event.event);
    if (!topic) return;

    const payload = {
      eventId: event.id,
      occurredAt: event.isoTime,
      eventType: event.event,
      ...event.data,
    };

    const partitionKey = keyForTopic(topic, payload);
    await producer.publish(topic, payload, partitionKey);
  };

  eventBus.on('*', handler);
  log.info('kafka_event_bridge_enabled', {});

  return {
    enabled: true,
    detach: () => eventBus.off('*', handler),
  };
}

module.exports = {
  attachEventBridge,
};
