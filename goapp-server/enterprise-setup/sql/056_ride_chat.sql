-- ============================================================
-- 056_ride_chat.sql
-- Realtime rider-driver ride chat with audit trail and receipts
-- Domain: rides
-- ============================================================

CREATE TABLE IF NOT EXISTS ride_chat_conversations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    rider_id            UUID NOT NULL,
    driver_id           UUID NOT NULL,
    assignment_seq      INTEGER NOT NULL DEFAULT 1,
    status              VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'closed')),
    opened_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at           TIMESTAMPTZ,
    closed_reason       VARCHAR(50),
    message_count       INTEGER NOT NULL DEFAULT 0,
    last_message_at     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ride_chat_conversations_ride
  ON ride_chat_conversations(ride_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ride_chat_conversations_rider
  ON ride_chat_conversations(rider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ride_chat_conversations_driver
  ON ride_chat_conversations(driver_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ride_chat_active_conversation
  ON ride_chat_conversations(ride_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS ride_chat_messages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id     UUID NOT NULL REFERENCES ride_chat_conversations(id) ON DELETE CASCADE,
    ride_id             UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    sender_user_id      UUID NOT NULL,
    sender_role         VARCHAR(20) NOT NULL
                        CHECK (sender_role IN ('rider', 'driver', 'admin', 'system')),
    message_type        VARCHAR(20) NOT NULL
                        CHECK (message_type IN ('text', 'image', 'voice', 'mixed', 'system')),
    text_content        TEXT,
    reply_to_message_id UUID REFERENCES ride_chat_messages(id),
    client_message_id   VARCHAR(200),
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ride_chat_messages_conversation
  ON ride_chat_messages(conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ride_chat_messages_ride
  ON ride_chat_messages(ride_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ride_chat_messages_client_id
  ON ride_chat_messages(conversation_id, sender_user_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ride_chat_attachments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id          UUID NOT NULL REFERENCES ride_chat_messages(id) ON DELETE CASCADE,
    conversation_id     UUID NOT NULL REFERENCES ride_chat_conversations(id) ON DELETE CASCADE,
    ride_id             UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    attachment_type     VARCHAR(20) NOT NULL
                        CHECK (attachment_type IN ('image', 'voice', 'file')),
    document_url        TEXT NOT NULL,
    storage_backend     VARCHAR(32) NOT NULL DEFAULT 'local',
    storage_key         TEXT,
    stored_path         TEXT,
    mime_type           VARCHAR(255),
    file_size_bytes     BIGINT,
    checksum_sha256     VARCHAR(128),
    original_filename   VARCHAR(255),
    duration_ms         INTEGER,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ride_chat_attachments_message
  ON ride_chat_attachments(message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ride_chat_attachments_conversation
  ON ride_chat_attachments(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ride_chat_message_receipts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id          UUID NOT NULL REFERENCES ride_chat_messages(id) ON DELETE CASCADE,
    recipient_user_id   UUID NOT NULL,
    delivery_status     VARCHAR(20) NOT NULL DEFAULT 'queued'
                        CHECK (delivery_status IN ('queued', 'delivered', 'read', 'failed')),
    delivery_channel    VARCHAR(30),
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    delivered_at        TIMESTAMPTZ,
    read_at             TIMESTAMPTZ,
    failure_reason      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(message_id, recipient_user_id)
);
CREATE INDEX IF NOT EXISTS idx_ride_chat_receipts_message
  ON ride_chat_message_receipts(message_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ride_chat_receipts_recipient
  ON ride_chat_message_receipts(recipient_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ride_chat_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id     UUID NOT NULL REFERENCES ride_chat_conversations(id) ON DELETE CASCADE,
    ride_id             UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    event_type          VARCHAR(50) NOT NULL,
    actor_user_id       UUID,
    actor_role          VARCHAR(20)
                        CHECK (actor_role IN ('rider', 'driver', 'admin', 'system')),
    event_data          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ride_chat_events_conversation
  ON ride_chat_events(conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ride_chat_events_ride
  ON ride_chat_events(ride_id, created_at DESC, id DESC);
