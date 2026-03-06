-- ============================================================
-- GoApp Enterprise Schema: 026 - Chat Ticket Support System
-- Domain: Customer support with real-time chat (5 tables)
-- ============================================================

CREATE TABLE IF NOT EXISTS support_agents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_code          VARCHAR(30) UNIQUE NOT NULL,      -- e.g., AGENT-001
    name                VARCHAR(200) NOT NULL,
    email               VARCHAR(200) UNIQUE NOT NULL,
    role                VARCHAR(30) NOT NULL DEFAULT 'agent'
                        CHECK (role IN ('agent','senior_agent','supervisor','admin')),
    is_online           BOOLEAN NOT NULL DEFAULT false,
    max_tickets         SMALLINT NOT NULL DEFAULT 10,     -- Max concurrent tickets
    current_tickets     SMALLINT NOT NULL DEFAULT 0,
    total_resolved      INTEGER NOT NULL DEFAULT 0,
    avg_resolution_sec  INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_online ON support_agents(is_online) WHERE is_online = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- Support tickets (main ticket record)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_tickets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_code         VARCHAR(40) UNIQUE NOT NULL,   -- e.g., TICKET-1234-ABCD
    user_id             UUID NOT NULL,                 -- Rider or Driver user ID
    user_type           VARCHAR(10) NOT NULL
                        CHECK (user_type IN ('rider','driver')),
    subject             VARCHAR(300) NOT NULL,
    category            VARCHAR(40) NOT NULL DEFAULT 'other'
                        CHECK (category IN (
                            'payment_issue','ride_problem','driver_behaviour',
                            'rider_behaviour','app_bug','lost_item','account_issue',
                            'incentive_issue','sos_followup','other'
                        )),
    priority            VARCHAR(10) NOT NULL DEFAULT 'normal'
                        CHECK (priority IN ('low','normal','high','urgent')),
    status              VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN ('OPEN','IN_PROGRESS','PENDING_USER','RESOLVED','CLOSED','ESCALATED')),
    ride_id             UUID REFERENCES rides(id),
    assigned_agent_id   UUID REFERENCES support_agents(id),
    tags                TEXT[] DEFAULT '{}',
    resolution          TEXT,
    escalated_at        TIMESTAMPTZ,
    resolved_at         TIMESTAMPTZ,
    resolved_by         UUID REFERENCES support_agents(id),
    closed_at           TIMESTAMPTZ,
    last_activity_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_user     ON support_tickets(user_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_status   ON support_tickets(status, priority, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_agent    ON support_tickets(assigned_agent_id, status) WHERE assigned_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_category ON support_tickets(category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_ride     ON support_tickets(ride_id) WHERE ride_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Ticket messages (chat thread)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_messages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    sender_id           VARCHAR(100) NOT NULL,          -- userId, agentId, or 'system'
    sender_role         VARCHAR(10) NOT NULL
                        CHECK (sender_role IN ('user','agent','system')),
    sender_type         VARCHAR(20),                    -- rider, driver, agent, system
    content             TEXT NOT NULL,
    content_type        VARCHAR(20) NOT NULL DEFAULT 'text'
                        CHECK (content_type IN ('text','image','file','voice','system_event')),
    attachments         JSONB DEFAULT '[]',             -- [{ url, filename, size, mimeType }]
    is_internal_note    BOOLEAN NOT NULL DEFAULT false, -- Agent-only notes not shown to user
    read_at             TIMESTAMPTZ,                    -- When the other party read the message
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_unread ON ticket_messages(ticket_id, read_at) WHERE read_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Ticket status history (audit log of every status change)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_status_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL REFERENCES support_tickets(id),
    from_status         VARCHAR(20),
    to_status           VARCHAR(20) NOT NULL,
    changed_by          VARCHAR(100),                   -- agentId, userId, or 'system'
    change_reason       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_status_history ON ticket_status_history(ticket_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Ticket satisfaction ratings (CSAT)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_ratings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL UNIQUE REFERENCES support_tickets(id),
    user_id             UUID NOT NULL,
    agent_id            UUID REFERENCES support_agents(id),
    rating              SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    feedback            TEXT,
    rated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_ratings_agent ON ticket_ratings(agent_id, rated_at DESC) WHERE agent_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Auto-update updated_at on support_tickets
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_support_ticket_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER support_ticket_updated_at
    BEFORE UPDATE ON support_tickets
    FOR EACH ROW EXECUTE FUNCTION update_support_ticket_timestamp();

-- Chat Ticket System: 5 tables total
