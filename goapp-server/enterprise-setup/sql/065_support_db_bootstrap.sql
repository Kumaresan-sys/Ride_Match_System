-- 065_support_db_bootstrap.sql
-- Bootstrap a dedicated support/help database without cross-database foreign keys.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS support_categories (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(120) NOT NULL,
    description         TEXT,
    parent_id           UUID REFERENCES support_categories(id) ON DELETE SET NULL,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_agents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID,
    agent_name          VARCHAR(200),
    name                VARCHAR(200),
    email               VARCHAR(200),
    team                VARCHAR(100),
    skills              TEXT[],
    role                VARCHAR(30) NOT NULL DEFAULT 'support_agent',
    max_concurrent      INTEGER DEFAULT 5,
    current_load        INTEGER DEFAULT 0,
    is_available        BOOLEAN NOT NULL DEFAULT true,
    is_online           BOOLEAN NOT NULL DEFAULT false,
    max_tickets         SMALLINT NOT NULL DEFAULT 10,
    current_tickets     SMALLINT NOT NULL DEFAULT 0,
    total_resolved      INTEGER NOT NULL DEFAULT 0,
    avg_resolution_sec  INTEGER,
    shift_start         TIME,
    shift_end           TIME,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_agents_available
  ON support_agents(is_available, is_active, created_at);

CREATE TABLE IF NOT EXISTS support_tickets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_number       VARCHAR(40) UNIQUE,
    ticket_code         VARCHAR(40) UNIQUE,
    user_id             UUID NOT NULL,
    user_type           VARCHAR(10) NOT NULL DEFAULT 'rider',
    ride_id             UUID,
    category_id         UUID REFERENCES support_categories(id) ON DELETE SET NULL,
    category            VARCHAR(64) NOT NULL DEFAULT 'general_support',
    subject             VARCHAR(300) NOT NULL,
    description         TEXT NOT NULL,
    priority            VARCHAR(10) NOT NULL DEFAULT 'normal',
    status              VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    assigned_to         UUID,
    assigned_agent_id   UUID REFERENCES support_agents(id) ON DELETE SET NULL,
    assigned_at         TIMESTAMPTZ,
    sla_deadline        TIMESTAMPTZ,
    last_activity_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    first_response_at   TIMESTAMPTZ,
    resolved_at         TIMESTAMPTZ,
    closed_at           TIMESTAMPTZ,
    reopened_at         TIMESTAMPTZ,
    escalated_at        TIMESTAMPTZ,
    resolved_by         UUID REFERENCES support_agents(id) ON DELETE SET NULL,
    resolution          TEXT,
    tags                TEXT[] DEFAULT '{}',
    metadata_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT support_tickets_priority_check
      CHECK ((priority)::text = ANY (ARRAY['low','medium','normal','high','urgent'])),
    CONSTRAINT support_tickets_status_check
      CHECK ((status)::text = ANY (ARRAY[
        'open','assigned','in_progress','waiting_user','resolved','closed','reopened',
        'OPEN','IN_PROGRESS','PENDING_USER','RESOLVED','CLOSED','ESCALATED'
      ]))
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user
  ON support_tickets(user_id, last_activity_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status
  ON support_tickets(status, priority, last_activity_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_ride
  ON support_tickets(ride_id)
  WHERE ride_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ticket_messages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    sender_id           VARCHAR(100) NOT NULL,
    sender_role         VARCHAR(10) NOT NULL,
    sender_type         VARCHAR(20),
    sender_display_name VARCHAR(200),
    message             TEXT,
    content             TEXT NOT NULL,
    content_type        VARCHAR(20) NOT NULL DEFAULT 'text',
    message_type        VARCHAR(20) NOT NULL DEFAULT 'user',
    visibility          VARCHAR(20) NOT NULL DEFAULT 'public',
    is_internal_note    BOOLEAN NOT NULL DEFAULT false,
    attachments         TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
    attachments_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
    read_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ticket_messages_sender_role_check
      CHECK (sender_role IN ('user','agent','system')),
    CONSTRAINT ticket_messages_message_type_check
      CHECK (message_type IN ('user','agent','system')),
    CONSTRAINT ticket_messages_visibility_check
      CHECK (visibility IN ('public','internal'))
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket
  ON ticket_messages(ticket_id, created_at ASC);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    sender_id           UUID,
    sender_type         VARCHAR(20),
    message             TEXT NOT NULL,
    attachments         TEXT[],
    is_internal         BOOLEAN DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_status_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    old_status          VARCHAR(20),
    new_status          VARCHAR(20),
    from_status         VARCHAR(20),
    to_status           VARCHAR(20) NOT NULL,
    changed_by          UUID,
    change_reason       TEXT,
    reason              TEXT,
    source              VARCHAR(20) NOT NULL DEFAULT 'api',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ticket_status_history_source_check
      CHECK (source IN ('api','system','migration'))
);

CREATE INDEX IF NOT EXISTS idx_ticket_status_history_ticket
  ON ticket_status_history(ticket_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ticket_escalations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    escalated_by        UUID,
    escalated_to        UUID REFERENCES support_agents(id) ON DELETE SET NULL,
    reason              TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_ratings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL UNIQUE REFERENCES support_tickets(id) ON DELETE CASCADE,
    agent_id            UUID REFERENCES support_agents(id) ON DELETE SET NULL,
    rating              SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    feedback            TEXT,
    rated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_csat (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL UNIQUE REFERENCES support_tickets(id) ON DELETE CASCADE,
    rating              SMALLINT CHECK (rating BETWEEN 1 AND 5),
    feedback            TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_faq (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id         UUID REFERENCES support_categories(id) ON DELETE SET NULL,
    question            TEXT NOT NULL,
    answer              TEXT NOT NULL,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_ticket_read_state (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id            UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    actor_type           VARCHAR(20) NOT NULL,
    actor_id             VARCHAR(100) NOT NULL,
    last_read_message_id UUID REFERENCES ticket_messages(id) ON DELETE SET NULL,
    last_read_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(ticket_id, actor_type, actor_id),
    CONSTRAINT support_ticket_read_state_actor_type_check
      CHECK (actor_type IN ('rider','support_agent','supervisor','admin'))
);

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
    scan_status         VARCHAR(20) NOT NULL DEFAULT 'not_scanned',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT support_ticket_attachments_scan_status_check
      CHECK (scan_status IN ('not_scanned','clean','infected','failed'))
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_attachments_ticket
  ON support_ticket_attachments(ticket_id, created_at ASC);

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
