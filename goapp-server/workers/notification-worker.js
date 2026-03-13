const kafka = require('../services/kafka-client');
const { logger } = require('../utils/logger');

class NotificationWorker {
  constructor({ notificationService }) {
    this.notificationService = notificationService;
  }

  async start() {
    await kafka.subscribe('notifications.dispatch', 'notification-worker', async (event) => {
      logger.info('NOTIFICATIONS', `Processing dispatch request for ${event.userId}`);
      
      const { userId, title, message, deepLink, navPayload, category } = event;
      
      // Dispatch via FCM
      const result = await this.notificationService.send(userId, {
        title,
        body: message,
        data: {
          ...navPayload,
          deep_link: deepLink,
          category: category || 'system'
        }
      });

      if (result.sent) {
        logger.info('NOTIFICATIONS', `Dispatched notification ${result.notificationId} to ${userId}`);
      } else {
        logger.warn('NOTIFICATIONS', `Failed to dispatch notification to ${userId}: ${result.reason}`);
      }
    });

    // Also listen for system-level lifecycle events if needed
    await kafka.subscribe('notifications.events', 'notification-event-logger', async (event) => {
      // Trace lifecycle events for observability/analytics
      logger.debug('NOTIFICATIONS', `Event: ${event.action} for notification ${event.notificationId}`);
    });
  }
}

module.exports = NotificationWorker;
