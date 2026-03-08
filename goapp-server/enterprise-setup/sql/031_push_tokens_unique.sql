-- Ensure push token persistence can upsert safely by token.
-- Keep the newest row for duplicate tokens, then enforce uniqueness.

DELETE FROM push_tokens a
USING push_tokens b
WHERE a.token = b.token
  AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_tokens_token_unique
ON push_tokens(token);
