'use strict';

const db = require('../services/db');
const { logger } = require('../utils/logger');
const notificationCenterService = require('../services/notification-center-service');

const RETAIN_DAYS = Number(process.env.NOTIFICATION_RETAIN_DAYS || 90);
const EVENT_RETAIN_DAYS = Number(process.env.NOTIFICATION_EVENT_RETAIN_DAYS || 180);
const ATTEMPT_RETAIN_DAYS = Number(process.env.NOTIFICATION_ATTEMPT_RETAIN_DAYS || 30);
const SWEEP_INTERVAL_MS = Number(process.env.NOTIFICATION_SWEEP_INTERVAL_MS || (6 * 60 * 60 * 1000)); // 6h

class NotificationRetentionWorker {
  async start() {
    await this.runSweep();
    setInterval(() => {
      this.runSweep().catch((err) => logger.error('NOTIFICATIONS', `Retention sweep failed: ${err.message}`));
    }, SWEEP_INTERVAL_MS);
    logger.info('BOOT', `Notification retention worker started (interval=${SWEEP_INTERVAL_MS}ms)`);
  }

  async runSweep() {
    // expire (and emit events)
    await notificationCenterService.expireNotifications();
    // purge old expired/deleted
    await db.query(
      `DELETE FROM notifications
       WHERE status IN ('deleted','expired')
        AND created_at < NOW() - INTERVAL '${RETAIN_DAYS} days'`
    );
    await db.query(
      `DELETE FROM notification_events
       WHERE created_at < NOW() - INTERVAL '${EVENT_RETAIN_DAYS} days'`
    );
    await db.query(
      `DELETE FROM notification_delivery_attempts
       WHERE created_at < NOW() - INTERVAL '${ATTEMPT_RETAIN_DAYS} days'`
    );
  }
}

module.exports = NotificationRetentionWorker;
