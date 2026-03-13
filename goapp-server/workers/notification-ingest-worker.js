'use strict';

const kafka = require('../services/kafka-client');
const { logger } = require('../utils/logger');

const TOPIC = process.env.NOTIFICATIONS_INCOMING_TOPIC || 'notifications.incoming';

class NotificationIngestWorker {
  constructor({ notificationCenterService }) {
    this.notificationCenterService = notificationCenterService;
  }

  async start() {
    try {
      await kafka.subscribe(TOPIC, 'notification-ingest-worker', async (event) => {
        if (!event || !event.userId || !event.title || !event.message) {
          if (event?.userId) {
            await this.notificationCenterService.appendEvent(null, event.userId, 'failed_validation', {
              reason: 'missing_required_fields',
              event,
            });
          }
          logger.warn('NOTIFICATIONS', 'Discarded invalid notification event');
          return;
        }
        await this.notificationCenterService.createNotification(event.userId, event);
      });
      logger.info('BOOT', `Notification ingest worker subscribed to ${TOPIC}`);
    } catch (err) {
      logger.error('BOOT', `Notification ingest worker failed: ${err.message}`);
    }
  }
}

module.exports = NotificationIngestWorker;
