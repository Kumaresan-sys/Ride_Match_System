-- ============================================================
-- 055_driver_media_projection.sql
-- Backend-owned driver media metadata and rider-facing projection fields
-- ============================================================

ALTER TABLE IF EXISTS driver_documents
  ADD COLUMN IF NOT EXISTS storage_backend VARCHAR(32) NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS storage_key TEXT,
  ADD COLUMN IF NOT EXISTS stored_path TEXT,
  ADD COLUMN IF NOT EXISTS mime_type VARCHAR(255),
  ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS checksum_sha256 VARCHAR(128),
  ADD COLUMN IF NOT EXISTS original_filename VARCHAR(255),
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF to_regclass('public.driver_documents') IS NOT NULL THEN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS idx_driver_docs_profile_photo_active
        ON driver_documents(driver_id, uploaded_at DESC)
        WHERE document_type = ''profile_photo'' AND is_active = true
    ';
  END IF;
END $$;

ALTER TABLE IF EXISTS ride_driver_projection
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS avatar_version BIGINT,
  ADD COLUMN IF NOT EXISTS completed_rides_count INTEGER DEFAULT 0;

ALTER TABLE IF EXISTS payment_driver_projection
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS avatar_version BIGINT,
  ADD COLUMN IF NOT EXISTS completed_rides_count INTEGER DEFAULT 0;

ALTER TABLE IF EXISTS driver_user_projection
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS avatar_version BIGINT,
  ADD COLUMN IF NOT EXISTS completed_rides_count INTEGER DEFAULT 0;
