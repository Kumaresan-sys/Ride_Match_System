-- Notifications v2 enhancements: additional fields, audit events, delivery attempts

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS nav_payload JSONB,
  ADD COLUMN IF NOT EXISTS source_service TEXT,
  ADD COLUMN IF NOT EXISTS reference_type TEXT,
  ADD COLUMN IF NOT EXISTS event_type TEXT,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- reference_id was already UUID; keep type but ensure column exists
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS reference_id UUID;

-- extend status domain
ALTER TABLE notifications
  ALTER COLUMN status DROP DEFAULT;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_status_check
  CHECK (status IN (
    'pending','sent','delivered','unread','read','deleted','expired','failed'
  ));

ALTER TABLE notifications
  ALTER COLUMN status SET DEFAULT 'unread';

-- delivered_at already exists? if not add; keep nullable
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_notifications_user_status_created
  ON notifications (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_source_ref
  ON notifications (source_service, reference_type, reference_id);

-- Audit trail of notification lifecycle
CREATE TABLE IF NOT EXISTS notification_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id),
  user_id UUID NOT NULL REFERENCES users(id),
  action VARCHAR(40) NOT NULL,
  actor_type VARCHAR(20) DEFAULT 'system',
  actor_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_events_notification
  ON notification_events (notification_id, created_at DESC);

-- Delivery attempts table for push providers
CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id),
  device_id TEXT,
  token_id TEXT,
  attempt_no INT DEFAULT 1,
  provider TEXT,
  provider_message_id TEXT,
  status VARCHAR(20) CHECK (status IN ('pending','sent','failed')),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_delivery_attempts_notif
  ON notification_delivery_attempts (notification_id, created_at DESC);

-- Optional partitioning note: handled at table definition in admin ops; not enforced here.
