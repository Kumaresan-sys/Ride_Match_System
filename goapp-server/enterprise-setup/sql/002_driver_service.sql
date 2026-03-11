-- ============================================================
-- GoApp Enterprise Schema: 002 - Driver Service
-- Domain: Driver Service (22 tables)
-- ============================================================

-- ──────────────────────────────────────────────────────
-- Driver Core Tables
-- ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS drivers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL UNIQUE REFERENCES users(id),
    license_number      VARCHAR(50) UNIQUE NOT NULL,
    license_expiry      DATE NOT NULL,
    license_state       VARCHAR(50),
    driver_type         VARCHAR(30) CHECK (driver_type IN ('standard','premium','xl','auto','bike')),
    onboarding_status   VARCHAR(30) DEFAULT 'pending'
                        CHECK (onboarding_status IN ('pending','documents_submitted','under_review',
                                                     'approved','rejected','suspended')),
    is_eligible         BOOLEAN DEFAULT false,
    max_concurrent_rides INTEGER DEFAULT 1,
    home_city           VARCHAR(100),
    service_area_id     UUID,
    approved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_drivers_user ON drivers(user_id);
CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(onboarding_status);
CREATE INDEX IF NOT EXISTS idx_drivers_city ON drivers(home_city);

CREATE TABLE IF NOT EXISTS driver_documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    document_type       VARCHAR(50) NOT NULL
                        CHECK (document_type IN ('license','rc_book','insurance','permit',
                                                 'aadhar','pan','profile_photo','vehicle_photo')),
    document_url        TEXT NOT NULL,
    storage_backend     VARCHAR(32) NOT NULL DEFAULT 'local',
    storage_key         TEXT,
    stored_path         TEXT,
    mime_type           VARCHAR(255),
    file_size_bytes     BIGINT,
    checksum_sha256     VARCHAR(128),
    original_filename   VARCHAR(255),
    is_active           BOOLEAN NOT NULL DEFAULT true,
    document_number     VARCHAR(100),
    expiry_date         DATE,
    verification_status VARCHAR(20) DEFAULT 'pending'
                        CHECK (verification_status IN ('pending','verified','rejected','expired')),
    rejection_reason    TEXT,
    verified_by         UUID REFERENCES users(id),
    verified_at         TIMESTAMPTZ,
    uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_driver_docs ON driver_documents(driver_id, document_type);
CREATE INDEX IF NOT EXISTS idx_driver_docs_profile_photo_active
  ON driver_documents(driver_id, uploaded_at DESC)
  WHERE document_type = 'profile_photo' AND is_active = true;

CREATE TABLE IF NOT EXISTS driver_background_checks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    check_type          VARCHAR(50) NOT NULL,
    provider            VARCHAR(100),
    external_ref_id     VARCHAR(200),
    status              VARCHAR(20) DEFAULT 'pending'
                        CHECK (status IN ('pending','in_progress','passed','failed','expired')),
    result_data         JSONB,
    initiated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS driver_verification_status (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    verification_type   VARCHAR(50) NOT NULL,
    is_verified         BOOLEAN DEFAULT false,
    last_checked_at     TIMESTAMPTZ,
    next_check_at       TIMESTAMPTZ,
    metadata            JSONB,
    UNIQUE(driver_id, verification_type)
);

CREATE TABLE IF NOT EXISTS driver_ratings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    ride_id             UUID NOT NULL,
    rider_id            UUID NOT NULL,
    rating              DECIMAL(2,1) NOT NULL CHECK (rating >= 1 AND rating <= 5),
    tags                TEXT[],
    comment             TEXT,
    is_visible          BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_driver_ratings ON driver_ratings(driver_id, created_at DESC);

CREATE TABLE IF NOT EXISTS driver_performance_metrics (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    metric_date         DATE NOT NULL,
    total_rides         INTEGER DEFAULT 0,
    completed_rides     INTEGER DEFAULT 0,
    cancelled_rides     INTEGER DEFAULT 0,
    acceptance_rate     DECIMAL(5,2),
    cancellation_rate   DECIMAL(5,2),
    avg_rating          DECIMAL(3,2),
    online_hours        DECIMAL(5,2),
    total_earnings      DECIMAL(12,2),
    total_distance_km   DECIMAL(10,2),
    avg_pickup_time_sec INTEGER,
    complaints          INTEGER DEFAULT 0,
    UNIQUE(driver_id, metric_date)
);
CREATE INDEX IF NOT EXISTS idx_driver_perf_date ON driver_performance_metrics(driver_id, metric_date DESC);

CREATE TABLE IF NOT EXISTS driver_online_status (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    status              VARCHAR(20) NOT NULL
                        CHECK (status IN ('offline','online','busy','on_ride','break')),
    last_location       GEOMETRY(Point, 4326),
    h3_index            VARCHAR(20),
    vehicle_id          UUID,
    went_online_at      TIMESTAMPTZ,
    last_heartbeat      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_driver_online ON driver_online_status(status);
CREATE INDEX IF NOT EXISTS idx_driver_online_h3 ON driver_online_status(h3_index) WHERE status = 'online';

CREATE TABLE IF NOT EXISTS driver_activity_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    activity_type       VARCHAR(50) NOT NULL,
    old_value           JSONB,
    new_value           JSONB,
    triggered_by        VARCHAR(30),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_driver_activity ON driver_activity_logs(driver_id, created_at DESC);

CREATE TABLE IF NOT EXISTS driver_training_status (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    training_module     VARCHAR(100) NOT NULL,
    status              VARCHAR(20) DEFAULT 'pending'
                        CHECK (status IN ('pending','in_progress','completed','failed')),
    score               INTEGER,
    completed_at        TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ,
    UNIQUE(driver_id, training_module)
);

CREATE TABLE IF NOT EXISTS driver_insurance (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    insurance_type      VARCHAR(50) NOT NULL,
    policy_number       VARCHAR(100),
    provider            VARCHAR(200),
    coverage_amount     DECIMAL(12,2),
    premium_amount      DECIMAL(10,2),
    start_date          DATE NOT NULL,
    end_date            DATE NOT NULL,
    status              VARCHAR(20) DEFAULT 'active'
                        CHECK (status IN ('active','expired','cancelled','pending')),
    document_url        TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS driver_bank_accounts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    account_holder_name VARCHAR(200) NOT NULL,
    bank_name           VARCHAR(200),
    account_number_enc  TEXT NOT NULL,
    ifsc_code           VARCHAR(20),
    routing_number      VARCHAR(20),
    account_type        VARCHAR(20) CHECK (account_type IN ('savings','current','checking')),
    is_primary          BOOLEAN DEFAULT false,
    is_verified         BOOLEAN DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_driver_bank ON driver_bank_accounts(driver_id);

-- ──────────────────────────────────────────────────────
-- Vehicle Tables
-- ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vehicle_types (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(50) NOT NULL UNIQUE,
    display_name        VARCHAR(100) NOT NULL,
    category            VARCHAR(30) CHECK (category IN ('economy','comfort','premium','xl','auto','bike','ev')),
    max_passengers      INTEGER NOT NULL,
    icon_url            TEXT,
    sort_order          INTEGER DEFAULT 0,
    is_active           BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS vehicles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    vehicle_type_id     UUID NOT NULL REFERENCES vehicle_types(id),
    make                VARCHAR(100) NOT NULL,
    model               VARCHAR(100) NOT NULL,
    year                INTEGER NOT NULL,
    color               VARCHAR(50),
    license_plate       VARCHAR(20) NOT NULL,
    vin                 VARCHAR(50),
    registration_number VARCHAR(50),
    registration_expiry DATE,
    status              VARCHAR(20) DEFAULT 'pending'
                        CHECK (status IN ('pending','active','suspended','deactivated')),
    is_primary          BOOLEAN DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vehicles_driver ON vehicles(driver_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles(license_plate);

CREATE TABLE IF NOT EXISTS vehicle_documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_id          UUID NOT NULL REFERENCES vehicles(id),
    document_type       VARCHAR(50) NOT NULL,
    document_url        TEXT NOT NULL,
    document_number     VARCHAR(100),
    expiry_date         DATE,
    verification_status VARCHAR(20) DEFAULT 'pending',
    uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vehicle_inspection_reports (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_id          UUID NOT NULL REFERENCES vehicles(id),
    inspector_id        UUID REFERENCES users(id),
    inspection_type     VARCHAR(50) NOT NULL,
    overall_result      VARCHAR(20) CHECK (overall_result IN ('pass','fail','conditional')),
    checklist           JSONB NOT NULL,
    notes               TEXT,
    photos              TEXT[],
    inspected_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_inspection_due DATE
);

CREATE TABLE IF NOT EXISTS vehicle_features (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_id          UUID NOT NULL REFERENCES vehicles(id),
    feature             VARCHAR(50) NOT NULL,
    is_available        BOOLEAN DEFAULT true,
    UNIQUE(vehicle_id, feature)
);
-- Features: wifi, child_seat, wheelchair_accessible, pet_friendly, ev_charging

CREATE TABLE IF NOT EXISTS vehicle_status (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_id          UUID NOT NULL REFERENCES vehicles(id),
    status              VARCHAR(20) NOT NULL,
    odometer_km         DECIMAL(10,1),
    fuel_level          DECIMAL(5,2),
    battery_level       DECIMAL(5,2),
    last_service_date   DATE,
    next_service_due    DATE,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Driver Service: 22 tables total
