-- Notifications v2 alignment: categories, status tightening, reference_id text, constraints, indexes

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'notifications'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS category VARCHAR(20),
  ADD COLUMN IF NOT EXISTS deep_link TEXT,
  ADD COLUMN IF NOT EXISTS nav_payload JSONB,
  ADD COLUMN IF NOT EXISTS source_service TEXT,
  ADD COLUMN IF NOT EXISTS reference_type TEXT,
  ADD COLUMN IF NOT EXISTS event_type TEXT,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'notifications'
      AND column_name = 'reference_id'
      AND data_type <> 'text'
  ) THEN
    ALTER TABLE notifications
      ALTER COLUMN reference_id TYPE TEXT USING reference_id::text;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'notifications'
      AND column_name = 'reference_id'
  ) THEN
    ALTER TABLE notifications
      ADD COLUMN reference_id TEXT;
  END IF;
END $$;

UPDATE notifications
  SET updated_at = COALESCE(updated_at, created_at, NOW());

ALTER TABLE notifications
  ALTER COLUMN updated_at SET DEFAULT NOW();

ALTER TABLE notifications
  ALTER COLUMN updated_at SET NOT NULL;

UPDATE notifications
  SET category = COALESCE(category, 'system');

ALTER TABLE notifications
  ALTER COLUMN category SET DEFAULT 'system';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'notifications_category_check'
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT notifications_category_check
      CHECK (category IN ('ride','payment','promo','system','security','other'));
  END IF;
END $$;

UPDATE notifications
  SET status = 'unread'
  WHERE status IS NULL
     OR status NOT IN ('unread','read','deleted','expired');

ALTER TABLE notifications
  ALTER COLUMN status DROP DEFAULT;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('unread','read','deleted','expired'));

ALTER TABLE notifications
  ALTER COLUMN status SET DEFAULT 'unread';

ALTER TABLE notification_events
  ALTER COLUMN notification_id DROP NOT NULL;

UPDATE notification_events
  SET action = 'read'
  WHERE action = 'bulk_read';

UPDATE notification_events
  SET actor_type = COALESCE(actor_type, 'system');

ALTER TABLE notification_events
  ALTER COLUMN actor_type SET DEFAULT 'system';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'notification_events_action_check'
  ) THEN
    ALTER TABLE notification_events
      ADD CONSTRAINT notification_events_action_check
      CHECK (action IN ('created','delivered','read','deleted','expired','failed_validation'));
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'notification_events_actor_type_check'
  ) THEN
    ALTER TABLE notification_events
      ADD CONSTRAINT notification_events_actor_type_check
      CHECK (actor_type IN ('system','user','job'));
  END IF;
END $$;

ALTER TABLE notification_delivery_attempts
  ADD COLUMN IF NOT EXISTS attempt_no INT DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_notifications_user_status
  ON notifications (user_id, status);

CREATE INDEX IF NOT EXISTS idx_notifications_expires
  ON notifications (expires_at);
