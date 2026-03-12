-- 064_support_ticket_legacy_alignment.sql
-- Align legacy support schema shapes with the canonical support ticket runtime contract.

ALTER TABLE support_agents
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE support_tickets
  ALTER COLUMN ticket_number DROP NOT NULL;

ALTER TABLE support_tickets
  DROP CONSTRAINT IF EXISTS support_tickets_priority_check;

ALTER TABLE support_tickets
  ADD CONSTRAINT support_tickets_priority_check
  CHECK ((priority)::text = ANY (ARRAY[
    'low',
    'medium',
    'normal',
    'high',
    'urgent'
  ]));

ALTER TABLE support_tickets
  DROP CONSTRAINT IF EXISTS support_tickets_status_check;

ALTER TABLE support_tickets
  ADD CONSTRAINT support_tickets_status_check
  CHECK ((status)::text = ANY (ARRAY[
    'open',
    'assigned',
    'in_progress',
    'waiting_user',
    'resolved',
    'closed',
    'reopened',
    'OPEN',
    'IN_PROGRESS',
    'PENDING_USER',
    'RESOLVED',
    'CLOSED',
    'ESCALATED'
  ]));

DO $$
DECLARE
  attachments_udt text;
BEGIN
  SELECT c.udt_name
    INTO attachments_udt
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'ticket_messages'
    AND c.column_name = 'attachments';

  IF attachments_udt = 'jsonb' THEN
    ALTER TABLE ticket_messages
      ADD COLUMN IF NOT EXISTS attachments_text_array text[] NOT NULL DEFAULT ARRAY[]::text[];

    UPDATE ticket_messages
    SET attachments_text_array = CASE
      WHEN attachments IS NULL THEN ARRAY[]::text[]
      ELSE ARRAY(
        SELECT jsonb_array_elements_text(attachments)
      )
    END;

    ALTER TABLE ticket_messages
      DROP COLUMN attachments;

    ALTER TABLE ticket_messages
      RENAME COLUMN attachments_text_array TO attachments;
  ELSIF attachments_udt IS NULL THEN
    ALTER TABLE ticket_messages
      ADD COLUMN attachments text[] NOT NULL DEFAULT ARRAY[]::text[];
  END IF;
END $$;
