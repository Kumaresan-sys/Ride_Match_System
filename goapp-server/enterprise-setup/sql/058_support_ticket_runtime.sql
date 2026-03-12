-- 058_support_ticket_runtime.sql
-- Harden support tickets for persistent rider support chat.

CREATE TABLE IF NOT EXISTS support_ticket_read_state (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    actor_type          VARCHAR(20) NOT NULL
                        CHECK (actor_type IN ('rider','support_agent','supervisor','admin')),
    actor_id            VARCHAR(100) NOT NULL,
    last_read_message_id UUID REFERENCES ticket_messages(id) ON DELETE SET NULL,
    last_read_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(ticket_id, actor_type, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_read_state_ticket
  ON support_ticket_read_state(ticket_id, actor_type, actor_id);

CREATE TABLE IF NOT EXISTS support_ticket_attachments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    message_id          UUID REFERENCES ticket_messages(id) ON DELETE SET NULL,
    storage_backend     VARCHAR(20) NOT NULL DEFAULT 'local',
    storage_key         TEXT NOT NULL,
    original_name       TEXT NOT NULL,
    safe_name           TEXT NOT NULL,
    mime_type           VARCHAR(200) NOT NULL,
    size_bytes          INTEGER NOT NULL,
    checksum_sha256     VARCHAR(64) NOT NULL,
    uploaded_by         VARCHAR(100) NOT NULL,
    scan_status         VARCHAR(20) NOT NULL DEFAULT 'not_scanned'
                        CHECK (scan_status IN ('not_scanned','clean','infected','failed')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_attachments_ticket
  ON support_ticket_attachments(ticket_id, created_at ASC);

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS user_type VARCHAR(10) NOT NULL DEFAULT 'rider',
  ADD COLUMN IF NOT EXISTS category VARCHAR(64) NOT NULL DEFAULT 'general_support',
  ADD COLUMN IF NOT EXISTS priority VARCHAR(10) NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  ADD COLUMN IF NOT EXISTS ride_id UUID,
  ADD COLUMN IF NOT EXISTS assigned_agent_id UUID,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS ticket_code VARCHAR(40),
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_ticket_code
  ON support_tickets(ticket_code)
  WHERE ticket_code IS NOT NULL;

ALTER TABLE ticket_messages
  ADD COLUMN IF NOT EXISTS message TEXT,
  ADD COLUMN IF NOT EXISTS content TEXT,
  ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS sender_display_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS attachments TEXT[],
  ADD COLUMN IF NOT EXISTS attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE ticket_messages
  DROP CONSTRAINT IF EXISTS ticket_messages_message_type_check;

ALTER TABLE ticket_messages
  ADD CONSTRAINT ticket_messages_message_type_check
  CHECK (message_type IN ('user','agent','system'));

ALTER TABLE ticket_messages
  DROP CONSTRAINT IF EXISTS ticket_messages_visibility_check;

ALTER TABLE ticket_messages
  ADD CONSTRAINT ticket_messages_visibility_check
  CHECK (visibility IN ('public','internal'));

ALTER TABLE support_agents
  ADD COLUMN IF NOT EXISTS user_id UUID,
  ADD COLUMN IF NOT EXISTS name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS email VARCHAR(200),
  ADD COLUMN IF NOT EXISTS role VARCHAR(30) NOT NULL DEFAULT 'support_agent',
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE ticket_status_history
  ADD COLUMN IF NOT EXISTS old_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS new_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS from_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS to_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS change_reason TEXT,
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'api';

ALTER TABLE ticket_status_history
  DROP CONSTRAINT IF EXISTS ticket_status_history_source_check;

ALTER TABLE ticket_status_history
  ADD CONSTRAINT ticket_status_history_source_check
  CHECK (source IN ('api','system','migration'));

CREATE OR REPLACE FUNCTION update_support_ticket_read_state_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS support_ticket_read_state_updated_at
  ON support_ticket_read_state;

CREATE TRIGGER support_ticket_read_state_updated_at
  BEFORE UPDATE ON support_ticket_read_state
  FOR EACH ROW EXECUTE FUNCTION update_support_ticket_read_state_timestamp();
