# GoApp Enterprise Database Architecture
## Complete 220+ Table Schema with Matching Engine Deep Dive

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      MOBILE CLIENTS                         │
│              (GoApp Rider / GoApp Captain)                   │
└──────────────────────┬──────────────────────────────────────┘
                       │
              ┌────────▼────────┐
              │   API GATEWAY   │  (Kong / AWS API Gateway)
              │   Rate Limit    │
              │   Auth Check    │
              └────────┬────────┘
                       │
    ┌──────────────────┼──────────────────────┐
    │                  │                      │
┌───▼───┐      ┌──────▼──────┐        ┌──────▼──────┐
│Identity│      │   Ride      │        │  Payment    │
│Service │      │   Service   │        │  Service    │
└───┬───┘      └──────┬──────┘        └──────┬──────┘
    │                  │                      │
    │          ┌───────▼────────┐              │
    │          │ DISPATCH/MATCH │              │
    │          │    ENGINE      │              │
    │          └───────┬────────┘              │
    │                  │                      │
┌───▼──────────────────▼──────────────────────▼───┐
│              APACHE KAFKA EVENT BUS              │
│  (ride_requested, driver_matched, ride_completed │
│   payment_processed, surge_updated, fraud_alert) │
└───┬──────────┬──────────┬──────────┬────────────┘
    │          │          │          │
┌───▼───┐ ┌───▼───┐ ┌───▼───┐ ┌───▼────────┐
│ Redis │ │Elastic│ │PostGIS│ │Data        │
│ Cache │ │Search │ │ + H3  │ │Warehouse   │
└───────┘ └───────┘ └───────┘ └────────────┘
```

### Database Scaling Strategy

```
┌─ identity_db ─────────────┐
│  Primary → Read Replica   │
│           → Analytics Rep  │
├─ drivers_db ──────────────┤
│  Primary → Read Replica   │
│           → Analytics Rep  │
├─ rides_db ────────────────┤
│  Primary (sharded by city)│
│  → Read Replica per shard │
├─ payments_db ─────────────┤
│  Primary → Read Replica   │
│  (PCI-DSS isolated)       │
├─ locations_db ────────────┤
│  PostGIS Primary          │
│  → TimescaleDB for hist.  │
├─ analytics_db ────────────┤
│  BigQuery / Redshift      │
└───────────────────────────┘
```

---

## 1. IDENTITY SERVICE (17 Tables)

### Core User Tables

```sql
CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number        VARCHAR(20) UNIQUE NOT NULL,
    email               VARCHAR(255) UNIQUE,
    phone_verified      BOOLEAN DEFAULT false,
    user_type           VARCHAR(20) NOT NULL CHECK (user_type IN ('rider','driver','admin','support')),
    status              VARCHAR(20) NOT NULL DEFAULT 'pending' 
                        CHECK (status IN ('pending','active','suspended','deactivated','banned')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ,
    version             INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_users_phone ON users(phone_number);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);

CREATE TABLE user_profiles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    first_name          VARCHAR(100),
    last_name           VARCHAR(100),
    display_name        VARCHAR(200),
    avatar_url          TEXT,
    date_of_birth       DATE,
    gender              VARCHAR(20),
    language            VARCHAR(10) DEFAULT 'en',
    country_code        VARCHAR(5),
    city                VARCHAR(100),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_user_profiles_user ON user_profiles(user_id);

CREATE TABLE user_roles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    role                VARCHAR(50) NOT NULL,
    granted_by          UUID REFERENCES users(id),
    granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ,
    is_active           BOOLEAN DEFAULT true,
    UNIQUE(user_id, role)
);

CREATE TABLE user_status_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    old_status          VARCHAR(20),
    new_status          VARCHAR(20) NOT NULL,
    reason              TEXT,
    changed_by          UUID REFERENCES users(id),
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_user_status_history_user ON user_status_history(user_id);

CREATE TABLE user_devices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    device_id           VARCHAR(255) NOT NULL,
    device_type         VARCHAR(20) CHECK (device_type IN ('ios','android','web')),
    device_model        VARCHAR(100),
    os_version          VARCHAR(50),
    app_version         VARCHAR(50),
    fcm_token           TEXT,
    apns_token          TEXT,
    is_active           BOOLEAN DEFAULT true,
    last_active_at      TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_user_devices_user ON user_devices(user_id);
CREATE INDEX idx_user_devices_fcm ON user_devices(fcm_token);

CREATE TABLE user_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    device_id           UUID REFERENCES user_devices(id),
    session_token       VARCHAR(512) UNIQUE NOT NULL,
    refresh_token       VARCHAR(512) UNIQUE,
    ip_address          INET,
    user_agent          TEXT,
    is_active           BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ
);
CREATE INDEX idx_user_sessions_token ON user_sessions(session_token);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);

CREATE TABLE user_login_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    login_method        VARCHAR(30) NOT NULL CHECK (login_method IN ('otp')),
    ip_address          INET,
    device_id           UUID REFERENCES user_devices(id),
    status              VARCHAR(20) NOT NULL CHECK (status IN ('success','failed','blocked')),
    failure_reason      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_login_history_user ON user_login_history(user_id, created_at DESC);

CREATE TABLE user_blocklist (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    blocked_user_id     UUID NOT NULL REFERENCES users(id),
    reason              TEXT,
    blocked_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, blocked_user_id)
);

CREATE TABLE user_preferences (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    preference_key      VARCHAR(100) NOT NULL,
    preference_value    JSONB NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, preference_key)
);

CREATE TABLE user_security_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    event_type          VARCHAR(50) NOT NULL,
    event_detail        JSONB,
    ip_address          INET,
    device_id           UUID REFERENCES user_devices(id),
    risk_level          VARCHAR(10) CHECK (risk_level IN ('low','medium','high','critical')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_security_logs_user ON user_security_logs(user_id, created_at DESC);
```

### OTP Authentication Tables

```sql
CREATE TABLE otp_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number        VARCHAR(20) NOT NULL,
    otp_code            VARCHAR(10) NOT NULL,
    otp_type            VARCHAR(20) NOT NULL CHECK (otp_type IN ('login','signup','reset','verify')),
    channel             VARCHAR(10) CHECK (channel IN ('sms','whatsapp','voice')),
    status              VARCHAR(20) DEFAULT 'pending' 
                        CHECK (status IN ('pending','verified','expired','failed')),
    attempts            INTEGER DEFAULT 0,
    max_attempts        INTEGER DEFAULT 3,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    verified_at         TIMESTAMPTZ
);
CREATE INDEX idx_otp_phone ON otp_requests(phone_number, created_at DESC);

CREATE TABLE otp_attempts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    otp_request_id      UUID NOT NULL REFERENCES otp_requests(id),
    entered_code        VARCHAR(10) NOT NULL,
    is_correct          BOOLEAN NOT NULL,
    ip_address          INET,
    attempted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE otp_rate_limits (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number        VARCHAR(20) NOT NULL,
    window_start        TIMESTAMPTZ NOT NULL,
    request_count       INTEGER DEFAULT 1,
    is_blocked          BOOLEAN DEFAULT false,
    blocked_until       TIMESTAMPTZ,
    UNIQUE(phone_number, window_start)
);
CREATE INDEX idx_otp_rate_phone ON otp_rate_limits(phone_number);
```

### Security Tables

```sql
CREATE TABLE user_api_keys (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    key_hash            VARCHAR(512) NOT NULL,
    key_prefix          VARCHAR(10) NOT NULL,
    label               VARCHAR(100),
    permissions         JSONB DEFAULT '[]',
    is_active           BOOLEAN DEFAULT true,
    last_used_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ
);

CREATE TABLE user_permissions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    resource            VARCHAR(100) NOT NULL,
    action              VARCHAR(50) NOT NULL,
    conditions          JSONB,
    granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, resource, action)
);
```

---

## 2. DRIVER SERVICE (22 Tables)

### Driver Core Tables

```sql
CREATE TABLE drivers (
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
CREATE INDEX idx_drivers_user ON drivers(user_id);
CREATE INDEX idx_drivers_status ON drivers(onboarding_status);
CREATE INDEX idx_drivers_city ON drivers(home_city);

CREATE TABLE driver_documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    document_type       VARCHAR(50) NOT NULL 
                        CHECK (document_type IN ('license','rc_book','insurance','permit',
                                                 'aadhar','pan','profile_photo','vehicle_photo')),
    document_url        TEXT NOT NULL,
    document_number     VARCHAR(100),
    expiry_date         DATE,
    verification_status VARCHAR(20) DEFAULT 'pending'
                        CHECK (verification_status IN ('pending','verified','rejected','expired')),
    rejection_reason    TEXT,
    verified_by         UUID REFERENCES users(id),
    verified_at         TIMESTAMPTZ,
    uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_driver_docs ON driver_documents(driver_id, document_type);

CREATE TABLE driver_background_checks (
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

CREATE TABLE driver_verification_status (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    verification_type   VARCHAR(50) NOT NULL,
    is_verified         BOOLEAN DEFAULT false,
    last_checked_at     TIMESTAMPTZ,
    next_check_at       TIMESTAMPTZ,
    metadata            JSONB,
    UNIQUE(driver_id, verification_type)
);

CREATE TABLE driver_ratings (
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
CREATE INDEX idx_driver_ratings ON driver_ratings(driver_id, created_at DESC);

CREATE TABLE driver_performance_metrics (
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
CREATE INDEX idx_driver_perf_date ON driver_performance_metrics(driver_id, metric_date DESC);

CREATE TABLE driver_online_status (
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
CREATE INDEX idx_driver_online ON driver_online_status(status);
CREATE INDEX idx_driver_online_h3 ON driver_online_status(h3_index) WHERE status = 'online';

CREATE TABLE driver_activity_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    activity_type       VARCHAR(50) NOT NULL,
    old_value           JSONB,
    new_value           JSONB,
    triggered_by        VARCHAR(30),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_driver_activity ON driver_activity_logs(driver_id, created_at DESC);

CREATE TABLE driver_training_status (
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

CREATE TABLE driver_insurance (
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

CREATE TABLE driver_bank_accounts (
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
CREATE INDEX idx_driver_bank ON driver_bank_accounts(driver_id);
```

### Vehicle Tables

```sql
CREATE TABLE vehicle_types (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(50) NOT NULL UNIQUE,
    display_name        VARCHAR(100) NOT NULL,
    category            VARCHAR(30) CHECK (category IN ('economy','comfort','premium','xl','auto','bike','ev')),
    max_passengers      INTEGER NOT NULL,
    icon_url            TEXT,
    sort_order          INTEGER DEFAULT 0,
    is_active           BOOLEAN DEFAULT true
);

CREATE TABLE vehicles (
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
CREATE INDEX idx_vehicles_driver ON vehicles(driver_id);
CREATE INDEX idx_vehicles_plate ON vehicles(license_plate);

CREATE TABLE vehicle_documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_id          UUID NOT NULL REFERENCES vehicles(id),
    document_type       VARCHAR(50) NOT NULL,
    document_url        TEXT NOT NULL,
    document_number     VARCHAR(100),
    expiry_date         DATE,
    verification_status VARCHAR(20) DEFAULT 'pending',
    uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vehicle_inspection_reports (
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

CREATE TABLE vehicle_features (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_id          UUID NOT NULL REFERENCES vehicles(id),
    feature             VARCHAR(50) NOT NULL,
    is_available        BOOLEAN DEFAULT true,
    UNIQUE(vehicle_id, feature)
);
-- Features: wifi, child_seat, wheelchair_accessible, pet_friendly, ev_charging

CREATE TABLE vehicle_status (
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
```

---

## 3. RIDER SERVICE (10 Tables)

```sql
CREATE TABLE riders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL UNIQUE REFERENCES users(id),
    default_payment_id  UUID,
    home_address        JSONB,
    work_address        JSONB,
    rider_tier          VARCHAR(20) DEFAULT 'standard' 
                        CHECK (rider_tier IN ('standard','silver','gold','platinum')),
    total_rides         INTEGER DEFAULT 0,
    lifetime_spend      DECIMAL(12,2) DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE rider_profiles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    accessibility_needs JSONB,
    preferred_vehicle   UUID REFERENCES vehicle_types(id),
    preferred_language  VARCHAR(10) DEFAULT 'en',
    emergency_contact   JSONB,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE rider_ratings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    ride_id             UUID NOT NULL,
    driver_id           UUID NOT NULL,
    rating              DECIMAL(2,1) NOT NULL CHECK (rating >= 1 AND rating <= 5),
    tags                TEXT[],
    comment             TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_rider_ratings ON rider_ratings(rider_id, created_at DESC);

CREATE TABLE rider_preferences (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    preference_key      VARCHAR(100) NOT NULL,
    preference_value    JSONB NOT NULL,
    UNIQUE(rider_id, preference_key)
);
-- Keys: ride_silence, temperature, music_genre, conversation_level, route_preference

CREATE TABLE rider_saved_places (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    label               VARCHAR(50) NOT NULL,
    name                VARCHAR(200),
    address             TEXT NOT NULL,
    latitude            DECIMAL(10,7) NOT NULL,
    longitude           DECIMAL(10,7) NOT NULL,
    place_id            VARCHAR(200),
    icon                VARCHAR(30) DEFAULT 'pin',
    sort_order          INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_rider_saved ON rider_saved_places(rider_id);

CREATE TABLE rider_trip_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    ride_id             UUID NOT NULL,
    pickup_address      TEXT,
    dropoff_address     TEXT,
    fare_amount         DECIMAL(10,2),
    rating_given        DECIMAL(2,1),
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_rider_history ON rider_trip_history(rider_id, created_at DESC);

CREATE TABLE rider_behavior_metrics (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    metric_date         DATE NOT NULL,
    rides_taken         INTEGER DEFAULT 0,
    cancellations       INTEGER DEFAULT 0,
    no_shows            INTEGER DEFAULT 0,
    avg_rating_given    DECIMAL(3,2),
    avg_wait_tolerance  INTEGER,
    peak_hour_rides     INTEGER DEFAULT 0,
    total_spend         DECIMAL(10,2) DEFAULT 0,
    UNIQUE(rider_id, metric_date)
);

CREATE TABLE rider_favorites (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    reason              TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(rider_id, driver_id)
);

CREATE TABLE rider_blocklist (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    reason              TEXT,
    blocked_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(rider_id, driver_id)
);

CREATE TABLE rider_loyalty_points (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    points_balance      INTEGER DEFAULT 0,
    lifetime_earned     INTEGER DEFAULT 0,
    lifetime_redeemed   INTEGER DEFAULT 0,
    tier_expiry         DATE,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 4. RIDE SERVICE — CORE DOMAIN (28 Tables)

### Ride Lifecycle Tables

```sql
CREATE TABLE rides (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_number         VARCHAR(20) UNIQUE NOT NULL,
    rider_id            UUID NOT NULL REFERENCES riders(id),
    driver_id           UUID REFERENCES drivers(id),
    vehicle_id          UUID REFERENCES vehicles(id),
    vehicle_type_id     UUID REFERENCES vehicle_types(id),
    
    -- Ride Type
    ride_type           VARCHAR(30) NOT NULL 
                        CHECK (ride_type IN ('on_demand','scheduled','shared','rental','intercity')),
    is_shared           BOOLEAN DEFAULT false,
    
    -- Locations
    pickup_lat          DECIMAL(10,7) NOT NULL,
    pickup_lng          DECIMAL(10,7) NOT NULL,
    pickup_address      TEXT,
    pickup_place_id     VARCHAR(200),
    dropoff_lat         DECIMAL(10,7),
    dropoff_lng         DECIMAL(10,7),
    dropoff_address     TEXT,
    dropoff_place_id    VARCHAR(200),
    
    -- Multi-stop support
    waypoints           JSONB DEFAULT '[]',
    
    -- Status
    status              VARCHAR(30) NOT NULL DEFAULT 'requested'
                        CHECK (status IN ('requested','searching','driver_assigned','driver_arriving',
                                          'driver_arrived','ride_started','in_progress','completing',
                                          'completed','cancelled','no_drivers','failed')),
    
    -- Distance & Time
    estimated_distance_m INTEGER,
    actual_distance_m    INTEGER,
    estimated_duration_s INTEGER,
    actual_duration_s    INTEGER,
    
    -- Fare
    estimated_fare      DECIMAL(10,2),
    actual_fare         DECIMAL(10,2),
    currency            VARCHAR(3) DEFAULT 'INR',
    surge_multiplier    DECIMAL(4,2) DEFAULT 1.00,
    
    -- Scheduling
    scheduled_at        TIMESTAMPTZ,
    
    -- Timestamps
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at         TIMESTAMPTZ,
    arrived_at          TIMESTAMPTZ,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    cancelled_at        TIMESTAMPTZ,
    
    -- Metadata
    source_app          VARCHAR(20) CHECK (source_app IN ('rider_app','web','api','corporate')),
    payment_method_id   UUID,
    promo_code_id       UUID,
    corporate_id        UUID,
    idempotency_key     VARCHAR(200) UNIQUE,
    
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_rides_rider ON rides(rider_id, created_at DESC);
CREATE INDEX idx_rides_driver ON rides(driver_id, created_at DESC);
CREATE INDEX idx_rides_status ON rides(status);
CREATE INDEX idx_rides_created ON rides(created_at DESC);
CREATE INDEX idx_rides_scheduled ON rides(scheduled_at) WHERE ride_type = 'scheduled';

CREATE TABLE ride_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    pickup_location     GEOMETRY(Point, 4326) NOT NULL,
    dropoff_location    GEOMETRY(Point, 4326),
    pickup_h3_index     VARCHAR(20) NOT NULL,
    dropoff_h3_index    VARCHAR(20),
    requested_vehicle_types UUID[] NOT NULL,
    passenger_count     INTEGER DEFAULT 1,
    special_requests    JSONB,
    fare_estimate_id    UUID,
    search_radius_m     INTEGER DEFAULT 5000,
    max_wait_seconds    INTEGER DEFAULT 300,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ride_req_h3 ON ride_requests(pickup_h3_index);

CREATE TABLE ride_status_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    old_status          VARCHAR(30),
    new_status          VARCHAR(30) NOT NULL,
    actor_type          VARCHAR(20) CHECK (actor_type IN ('system','driver','rider','admin')),
    actor_id            UUID,
    reason              TEXT,
    metadata            JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ride_status_hist ON ride_status_history(ride_id, created_at);

CREATE TABLE ride_routes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    route_type          VARCHAR(20) CHECK (route_type IN ('estimated','actual','alternative')),
    polyline            TEXT,
    route_geometry      GEOMETRY(LineString, 4326),
    distance_m          INTEGER,
    duration_s          INTEGER,
    waypoints           JSONB,
    traffic_model       VARCHAR(20),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ride_routes ON ride_routes(ride_id);

CREATE TABLE ride_fare_breakdown (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL UNIQUE REFERENCES rides(id),
    base_fare           DECIMAL(10,2) NOT NULL,
    distance_fare       DECIMAL(10,2) NOT NULL,
    time_fare           DECIMAL(10,2) NOT NULL,
    surge_amount        DECIMAL(10,2) DEFAULT 0,
    surge_multiplier    DECIMAL(4,2) DEFAULT 1.00,
    toll_charges        DECIMAL(10,2) DEFAULT 0,
    parking_fees        DECIMAL(10,2) DEFAULT 0,
    taxes               DECIMAL(10,2) DEFAULT 0,
    tax_breakdown       JSONB,
    booking_fee         DECIMAL(10,2) DEFAULT 0,
    platform_fee        DECIMAL(10,2) DEFAULT 0,
    tip_amount          DECIMAL(10,2) DEFAULT 0,
    promo_discount      DECIMAL(10,2) DEFAULT 0,
    wallet_deduction    DECIMAL(10,2) DEFAULT 0,
    total_fare          DECIMAL(10,2) NOT NULL,
    driver_payout       DECIMAL(10,2),
    platform_commission DECIMAL(10,2),
    currency            VARCHAR(3) DEFAULT 'INR',
    calculated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ride_cancellations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    cancelled_by        VARCHAR(20) NOT NULL CHECK (cancelled_by IN ('rider','driver','system')),
    canceller_id        UUID,
    reason_code         VARCHAR(50),
    reason_text         TEXT,
    cancellation_fee    DECIMAL(10,2) DEFAULT 0,
    is_fee_waived       BOOLEAN DEFAULT false,
    waiver_reason       TEXT,
    time_since_request  INTEGER,
    time_since_accept   INTEGER,
    driver_distance_m   INTEGER,
    cancelled_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ride_cancel ON ride_cancellations(ride_id);

CREATE TABLE ride_disputes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    raised_by           UUID NOT NULL REFERENCES users(id),
    dispute_type        VARCHAR(50) NOT NULL 
                        CHECK (dispute_type IN ('fare','route','safety','behavior',
                                                'damage','lost_item','overcharge','other')),
    description         TEXT NOT NULL,
    evidence_urls       TEXT[],
    status              VARCHAR(20) DEFAULT 'open'
                        CHECK (status IN ('open','investigating','resolved','escalated','closed')),
    assigned_to         UUID REFERENCES users(id),
    resolution          TEXT,
    refund_amount       DECIMAL(10,2),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ
);

CREATE TABLE ride_feedback (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    from_user_id        UUID NOT NULL REFERENCES users(id),
    to_user_id          UUID NOT NULL REFERENCES users(id),
    rating              DECIMAL(2,1) NOT NULL CHECK (rating >= 1 AND rating <= 5),
    tags                TEXT[],
    comment             TEXT,
    is_flagged          BOOLEAN DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ride_feedback ON ride_feedback(ride_id);

CREATE TABLE ride_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    event_type          VARCHAR(50) NOT NULL,
    event_data          JSONB NOT NULL,
    actor_type          VARCHAR(20),
    actor_id            UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ride_events ON ride_events(ride_id, created_at);
-- Event types: route_deviated, long_stop, speed_alert, harsh_brake, sos_triggered

CREATE TABLE ride_safety_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    event_type          VARCHAR(50) NOT NULL 
                        CHECK (event_type IN ('sos','crash_detected','route_deviation',
                                              'long_stop','speed_violation','driver_switch',
                                              'unsafe_behavior')),
    severity            VARCHAR(10) CHECK (severity IN ('low','medium','high','critical')),
    location            GEOMETRY(Point, 4326),
    details             JSONB,
    auto_actions_taken  JSONB,
    reported_by         UUID,
    resolved            BOOLEAN DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ride_safety ON ride_safety_events(ride_id);
CREATE INDEX idx_ride_safety_sev ON ride_safety_events(severity) WHERE resolved = false;

CREATE TABLE ride_timestamps (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL UNIQUE REFERENCES rides(id),
    requested_at        TIMESTAMPTZ,
    dispatched_at       TIMESTAMPTZ,
    driver_notified_at  TIMESTAMPTZ,
    driver_accepted_at  TIMESTAMPTZ,
    driver_arriving_at  TIMESTAMPTZ,
    driver_arrived_at   TIMESTAMPTZ,
    otp_verified_at     TIMESTAMPTZ,
    ride_started_at     TIMESTAMPTZ,
    ride_completed_at   TIMESTAMPTZ,
    payment_initiated_at TIMESTAMPTZ,
    payment_completed_at TIMESTAMPTZ,
    rated_at            TIMESTAMPTZ
);

CREATE TABLE ride_metadata (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL UNIQUE REFERENCES rides(id),
    weather_conditions  JSONB,
    traffic_conditions  JSONB,
    route_options_shown INTEGER,
    eta_accuracy_pct    DECIMAL(5,2),
    fare_accuracy_pct   DECIMAL(5,2),
    app_version_rider   VARCHAR(20),
    app_version_driver  VARCHAR(20),
    experiment_flags    JSONB,
    ab_test_group       VARCHAR(50)
);

CREATE TABLE ride_otp (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    otp_code            VARCHAR(6) NOT NULL,
    is_verified         BOOLEAN DEFAULT false,
    attempts            INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    verified_at         TIMESTAMPTZ
);

CREATE TABLE ride_shared_pool (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id             VARCHAR(50) NOT NULL,
    ride_id             UUID NOT NULL REFERENCES rides(id),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    pickup_order        INTEGER NOT NULL,
    dropoff_order       INTEGER NOT NULL,
    detour_factor       DECIMAL(4,2),
    discount_pct        DECIMAL(5,2),
    joined_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_shared_pool ON ride_shared_pool(pool_id);
```

---

## 5. DISPATCH / MATCHING ENGINE (18 Tables)

> **This is the most critical domain. See Section 21 for the complete deep dive.**

```sql
-- ═══════════════════════════════════════════════════════
-- PHASE 1: SUPPLY TRACKING
-- ═══════════════════════════════════════════════════════

CREATE TABLE driver_location_cache (
    driver_id           UUID PRIMARY KEY REFERENCES drivers(id),
    location            GEOMETRY(Point, 4326) NOT NULL,
    h3_index_res7       VARCHAR(20) NOT NULL,
    h3_index_res8       VARCHAR(20) NOT NULL,
    h3_index_res9       VARCHAR(20) NOT NULL,
    heading             DECIMAL(5,2),
    speed_kmh           DECIMAL(6,2),
    accuracy_m          DECIMAL(6,2),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_dlc_h3_r8 ON driver_location_cache(h3_index_res8);
CREATE INDEX idx_dlc_h3_r9 ON driver_location_cache(h3_index_res9);
CREATE INDEX idx_dlc_geo ON driver_location_cache USING GIST(location);

CREATE TABLE driver_availability (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    is_available        BOOLEAN NOT NULL DEFAULT false,
    current_ride_id     UUID,
    vehicle_type_id     UUID REFERENCES vehicle_types(id),
    capacity_remaining  INTEGER DEFAULT 1,
    will_be_free_at     TIMESTAMPTZ,
    destination_bias    GEOMETRY(Point, 4326),
    last_ride_dropoff   GEOMETRY(Point, 4326),
    shift_end_time      TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(driver_id)
);
CREATE INDEX idx_driver_avail ON driver_availability(is_available, vehicle_type_id);

CREATE TABLE driver_supply_snapshots (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    h3_index            VARCHAR(20) NOT NULL,
    resolution          INTEGER NOT NULL CHECK (resolution IN (7, 8, 9)),
    available_drivers   INTEGER NOT NULL,
    busy_drivers        INTEGER NOT NULL,
    total_drivers       INTEGER NOT NULL,
    vehicle_breakdown   JSONB,
    snapshot_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_supply_snap ON driver_supply_snapshots(h3_index, snapshot_at DESC);

-- ═══════════════════════════════════════════════════════
-- PHASE 2: DEMAND TRACKING
-- ═══════════════════════════════════════════════════════

CREATE TABLE demand_forecasts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    h3_index            VARCHAR(20) NOT NULL,
    resolution          INTEGER NOT NULL,
    forecast_for        TIMESTAMPTZ NOT NULL,
    predicted_requests  DECIMAL(8,2),
    confidence_lower    DECIMAL(8,2),
    confidence_upper    DECIMAL(8,2),
    model_version       VARCHAR(50),
    features_used       JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_demand_forecast ON demand_forecasts(h3_index, forecast_for);

CREATE TABLE demand_realtime (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    h3_index            VARCHAR(20) NOT NULL,
    resolution          INTEGER NOT NULL,
    active_requests     INTEGER NOT NULL DEFAULT 0,
    unfulfilled_requests INTEGER NOT NULL DEFAULT 0,
    avg_wait_seconds    INTEGER,
    window_start        TIMESTAMPTZ NOT NULL,
    window_end          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_demand_rt ON demand_realtime(h3_index, window_start DESC);

-- ═══════════════════════════════════════════════════════
-- PHASE 3: DISPATCH & MATCHING
-- ═══════════════════════════════════════════════════════

CREATE TABLE dispatch_jobs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_request_id     UUID NOT NULL,
    ride_id             UUID NOT NULL REFERENCES rides(id),
    status              VARCHAR(30) NOT NULL DEFAULT 'created'
                        CHECK (status IN ('created','collecting','matching','dispatching',
                                          'assigned','exhausted','cancelled','expired')),
    
    -- Matching window (batch collection)
    batch_window_ms     INTEGER DEFAULT 2000,
    batch_started_at    TIMESTAMPTZ,
    batch_closed_at     TIMESTAMPTZ,
    
    -- Search parameters
    search_radius_m     INTEGER NOT NULL DEFAULT 5000,
    max_radius_m        INTEGER DEFAULT 10000,
    radius_expansion_step INTEGER DEFAULT 1000,
    current_radius_m    INTEGER,
    
    -- Results
    candidates_found    INTEGER DEFAULT 0,
    attempts_made       INTEGER DEFAULT 0,
    max_attempts        INTEGER DEFAULT 10,
    assigned_driver_id  UUID REFERENCES drivers(id),
    
    -- Timing
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_at         TIMESTAMPTZ,
    expired_at          TIMESTAMPTZ,
    ttl_seconds         INTEGER DEFAULT 300
);
CREATE INDEX idx_dispatch_status ON dispatch_jobs(status);
CREATE INDEX idx_dispatch_ride ON dispatch_jobs(ride_id);

CREATE TABLE dispatch_batches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_window_start  TIMESTAMPTZ NOT NULL,
    batch_window_end    TIMESTAMPTZ NOT NULL,
    h3_region           VARCHAR(20) NOT NULL,
    requests_in_batch   INTEGER NOT NULL,
    drivers_in_batch    INTEGER NOT NULL,
    algorithm_used      VARCHAR(50) NOT NULL,
    optimization_score  DECIMAL(8,4),
    computation_ms      INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_dispatch_batch ON dispatch_batches(batch_window_start);

CREATE TABLE dispatch_attempts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispatch_job_id     UUID NOT NULL REFERENCES dispatch_jobs(id),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    attempt_number      INTEGER NOT NULL,
    
    -- Driver state at dispatch time
    driver_location     GEOMETRY(Point, 4326),
    driver_h3_index     VARCHAR(20),
    distance_to_pickup_m INTEGER,
    eta_seconds         INTEGER,
    
    -- Scoring
    match_score         DECIMAL(8,4),
    score_breakdown     JSONB,
    
    -- Response
    status              VARCHAR(20) NOT NULL DEFAULT 'sent'
                        CHECK (status IN ('sent','seen','accepted','rejected','expired','cancelled')),
    response_time_ms    INTEGER,
    rejection_reason    VARCHAR(100),
    
    -- Timing
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at        TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_dispatch_att_job ON dispatch_attempts(dispatch_job_id);
CREATE INDEX idx_dispatch_att_driver ON dispatch_attempts(driver_id, sent_at DESC);

CREATE TABLE dispatch_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispatch_job_id     UUID NOT NULL REFERENCES dispatch_jobs(id),
    log_level           VARCHAR(10) CHECK (log_level IN ('debug','info','warn','error')),
    phase               VARCHAR(30),
    message             TEXT NOT NULL,
    details             JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_dispatch_log ON dispatch_logs(dispatch_job_id);

CREATE TABLE ride_driver_matches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    dispatch_job_id     UUID REFERENCES dispatch_jobs(id),
    match_type          VARCHAR(30) CHECK (match_type IN ('optimal','fallback','manual','rebalance')),
    match_score         DECIMAL(8,4),
    score_components    JSONB,
    eta_at_match        INTEGER,
    distance_at_match   INTEGER,
    matched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_match_ride ON ride_driver_matches(ride_id);

CREATE TABLE driver_acceptance_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    dispatch_attempt_id UUID REFERENCES dispatch_attempts(id),
    ride_id             UUID REFERENCES rides(id),
    action              VARCHAR(20) NOT NULL CHECK (action IN ('accepted','rejected','expired','missed')),
    response_time_ms    INTEGER,
    reason              VARCHAR(100),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_accept_hist ON driver_acceptance_history(driver_id, created_at DESC);

CREATE TABLE driver_rejections (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    reason_code         VARCHAR(50) NOT NULL,
    reason_text         TEXT,
    consecutive_rejects INTEGER DEFAULT 1,
    penalty_applied     BOOLEAN DEFAULT false,
    penalty_type        VARCHAR(50),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_driver_rejects ON driver_rejections(driver_id, created_at DESC);

CREATE TABLE matching_algorithm_metrics (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    algorithm_version   VARCHAR(50) NOT NULL,
    h3_region           VARCHAR(20),
    time_window         TSTZRANGE NOT NULL,
    total_requests      INTEGER,
    matched_requests    INTEGER,
    avg_match_time_ms   INTEGER,
    avg_eta_seconds     INTEGER,
    avg_match_score     DECIMAL(8,4),
    p50_wait_seconds    INTEGER,
    p90_wait_seconds    INTEGER,
    p99_wait_seconds    INTEGER,
    first_attempt_success_rate DECIMAL(5,2),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE matching_weights_config (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    config_name         VARCHAR(100) NOT NULL,
    city                VARCHAR(100),
    vehicle_type_id     UUID REFERENCES vehicle_types(id),
    
    -- Scoring weights (must sum to 1.0)
    weight_distance     DECIMAL(4,3) NOT NULL DEFAULT 0.30,
    weight_eta          DECIMAL(4,3) NOT NULL DEFAULT 0.25,
    weight_driver_rating DECIMAL(4,3) NOT NULL DEFAULT 0.15,
    weight_acceptance_rate DECIMAL(4,3) NOT NULL DEFAULT 0.10,
    weight_driver_idle_time DECIMAL(4,3) NOT NULL DEFAULT 0.10,
    weight_destination_bias DECIMAL(4,3) NOT NULL DEFAULT 0.05,
    weight_rider_preference DECIMAL(4,3) NOT NULL DEFAULT 0.05,
    
    -- Thresholds
    max_pickup_distance_m INTEGER DEFAULT 5000,
    max_eta_seconds     INTEGER DEFAULT 600,
    min_driver_rating   DECIMAL(3,2) DEFAULT 4.0,
    min_acceptance_rate DECIMAL(5,2) DEFAULT 50.0,
    
    is_active           BOOLEAN DEFAULT true,
    version             INTEGER DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE driver_eta_cache (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    destination_h3      VARCHAR(20) NOT NULL,
    eta_seconds         INTEGER NOT NULL,
    distance_m          INTEGER NOT NULL,
    route_polyline      TEXT,
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    UNIQUE(driver_id, destination_h3)
);
CREATE INDEX idx_eta_cache ON driver_eta_cache(driver_id, destination_h3);
```

---

## 6. LOCATION SERVICE (12 Tables)

```sql
CREATE TABLE driver_locations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    location            GEOMETRY(Point, 4326) NOT NULL,
    h3_index            VARCHAR(20) NOT NULL,
    altitude            DECIMAL(8,2),
    heading             DECIMAL(5,2),
    speed_kmh           DECIMAL(6,2),
    accuracy_m          DECIMAL(6,2),
    battery_level       DECIMAL(5,2),
    source              VARCHAR(20) CHECK (source IN ('gps','network','fused','mock')),
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Partitioned by day for performance
CREATE INDEX idx_driver_loc ON driver_locations(driver_id, recorded_at DESC);
CREATE INDEX idx_driver_loc_h3 ON driver_locations(h3_index);

CREATE TABLE driver_location_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL,
    ride_id             UUID,
    location            GEOMETRY(Point, 4326) NOT NULL,
    h3_index            VARCHAR(20) NOT NULL,
    speed_kmh           DECIMAL(6,2),
    heading             DECIMAL(5,2),
    recorded_at         TIMESTAMPTZ NOT NULL
) PARTITION BY RANGE (recorded_at);
-- Create monthly partitions
CREATE INDEX idx_loc_hist ON driver_location_history(driver_id, recorded_at DESC);

CREATE TABLE ride_live_locations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL,
    driver_id           UUID NOT NULL,
    location            GEOMETRY(Point, 4326) NOT NULL,
    speed_kmh           DECIMAL(6,2),
    heading             DECIMAL(5,2),
    distance_remaining_m INTEGER,
    eta_remaining_s     INTEGER,
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ride_live ON ride_live_locations(ride_id, recorded_at DESC);

CREATE TABLE location_update_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL,
    update_count        INTEGER,
    avg_interval_ms     INTEGER,
    dropped_updates     INTEGER,
    battery_drain_pct   DECIMAL(5,2),
    session_start       TIMESTAMPTZ NOT NULL,
    session_end         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE geo_zones (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(200) NOT NULL,
    zone_type           VARCHAR(30) NOT NULL 
                        CHECK (zone_type IN ('city','airport','station','mall','hospital',
                                             'event_venue','restricted','surge_zone','geo_fence')),
    boundary            GEOMETRY(Polygon, 4326) NOT NULL,
    h3_indices          TEXT[] NOT NULL,
    properties          JSONB,
    is_active           BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_geo_zones_boundary ON geo_zones USING GIST(boundary);
CREATE INDEX idx_geo_zones_type ON geo_zones(zone_type);

CREATE TABLE geo_fences (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_id             UUID NOT NULL REFERENCES geo_zones(id),
    fence_type          VARCHAR(30) NOT NULL 
                        CHECK (fence_type IN ('pickup_only','dropoff_only','no_service',
                                              'speed_limit','queue_zone','staging_area')),
    rules               JSONB NOT NULL,
    priority            INTEGER DEFAULT 0,
    is_active           BOOLEAN DEFAULT true,
    effective_from      TIMESTAMPTZ,
    effective_until     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE city_regions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    city_name           VARCHAR(100) NOT NULL,
    country_code        VARCHAR(5) NOT NULL,
    timezone            VARCHAR(50) NOT NULL,
    currency            VARCHAR(3) NOT NULL,
    boundary            GEOMETRY(MultiPolygon, 4326),
    center_point        GEOMETRY(Point, 4326),
    is_active           BOOLEAN DEFAULT true,
    service_config      JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_city_regions ON city_regions(city_name);

CREATE TABLE traffic_conditions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    h3_index            VARCHAR(20) NOT NULL,
    speed_kmh_avg       DECIMAL(6,2),
    speed_kmh_freeflow  DECIMAL(6,2),
    congestion_level    VARCHAR(10) CHECK (congestion_level IN ('free','light','moderate','heavy','gridlock')),
    incident_count      INTEGER DEFAULT 0,
    sample_size         INTEGER,
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_traffic ON traffic_conditions(h3_index, recorded_at DESC);

CREATE TABLE h3_hex_indices (
    h3_index            VARCHAR(20) PRIMARY KEY,
    resolution          INTEGER NOT NULL,
    parent_index        VARCHAR(20),
    center_lat          DECIMAL(10,7),
    center_lng          DECIMAL(10,7),
    city_region_id      UUID REFERENCES city_regions(id),
    zone_type           VARCHAR(30),
    is_serviceable      BOOLEAN DEFAULT true,
    properties          JSONB
);
CREATE INDEX idx_h3_parent ON h3_hex_indices(parent_index);
CREATE INDEX idx_h3_city ON h3_hex_indices(city_region_id);

CREATE TABLE location_snapshots (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_type       VARCHAR(30) NOT NULL,
    h3_index            VARCHAR(20) NOT NULL,
    driver_count        INTEGER,
    rider_count         INTEGER,
    avg_speed           DECIMAL(6,2),
    data                JSONB,
    snapshot_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE route_cache (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    origin_h3           VARCHAR(20) NOT NULL,
    destination_h3      VARCHAR(20) NOT NULL,
    distance_m          INTEGER NOT NULL,
    duration_s          INTEGER NOT NULL,
    polyline            TEXT,
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    UNIQUE(origin_h3, destination_h3)
);
CREATE INDEX idx_route_cache ON route_cache(origin_h3, destination_h3);

CREATE TABLE map_data_versions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    region              VARCHAR(100) NOT NULL,
    provider            VARCHAR(50) NOT NULL,
    version             VARCHAR(50) NOT NULL,
    tile_url            TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 7. PRICING SERVICE (14 Tables)

```sql
CREATE TABLE pricing_rules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    city_region_id      UUID REFERENCES city_regions(id),
    vehicle_type_id     UUID REFERENCES vehicle_types(id),
    ride_type           VARCHAR(30),
    rule_name           VARCHAR(100) NOT NULL,
    rule_type           VARCHAR(30) CHECK (rule_type IN ('base','surge','discount','cap','minimum','special')),
    conditions          JSONB,
    priority            INTEGER DEFAULT 0,
    is_active           BOOLEAN DEFAULT true,
    effective_from      TIMESTAMPTZ NOT NULL,
    effective_until     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE base_fares (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    city_region_id      UUID NOT NULL REFERENCES city_regions(id),
    vehicle_type_id     UUID NOT NULL REFERENCES vehicle_types(id),
    base_fare           DECIMAL(10,2) NOT NULL,
    minimum_fare        DECIMAL(10,2) NOT NULL,
    booking_fee         DECIMAL(10,2) DEFAULT 0,
    cancellation_fee    DECIMAL(10,2) DEFAULT 0,
    currency            VARCHAR(3) DEFAULT 'INR',
    effective_from      TIMESTAMPTZ NOT NULL,
    effective_until     TIMESTAMPTZ,
    UNIQUE(city_region_id, vehicle_type_id, effective_from)
);

CREATE TABLE distance_rates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    base_fare_id        UUID NOT NULL REFERENCES base_fares(id),
    from_km             DECIMAL(6,2) NOT NULL DEFAULT 0,
    to_km               DECIMAL(6,2),
    rate_per_km         DECIMAL(8,2) NOT NULL
);

CREATE TABLE time_rates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    base_fare_id        UUID NOT NULL REFERENCES base_fares(id),
    time_of_day_start   TIME,
    time_of_day_end     TIME,
    day_of_week         INTEGER[],
    rate_per_minute     DECIMAL(8,2) NOT NULL,
    idle_rate_per_minute DECIMAL(8,2) DEFAULT 0
);

CREATE TABLE city_pricing (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    city_region_id      UUID NOT NULL REFERENCES city_regions(id),
    tax_rate            DECIMAL(5,4) NOT NULL DEFAULT 0,
    tax_components      JSONB,
    service_tax_pct     DECIMAL(5,2) DEFAULT 0,
    gst_pct             DECIMAL(5,2) DEFAULT 0,
    toll_enabled        BOOLEAN DEFAULT true,
    dynamic_pricing     BOOLEAN DEFAULT true,
    fare_cap_enabled    BOOLEAN DEFAULT false,
    max_surge_cap       DECIMAL(4,2) DEFAULT 3.00,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE surge_zones (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    h3_index            VARCHAR(20) NOT NULL,
    city_region_id      UUID REFERENCES city_regions(id),
    current_multiplier  DECIMAL(4,2) NOT NULL DEFAULT 1.00,
    supply_count        INTEGER,
    demand_count        INTEGER,
    supply_demand_ratio DECIMAL(6,3),
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_surge_zone ON surge_zones(h3_index);

CREATE TABLE surge_multipliers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    surge_zone_id       UUID NOT NULL REFERENCES surge_zones(id),
    vehicle_type_id     UUID REFERENCES vehicle_types(id),
    multiplier          DECIMAL(4,2) NOT NULL,
    reason              VARCHAR(50) CHECK (reason IN ('demand','event','weather','time_of_day','manual')),
    override_by         UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE surge_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    h3_index            VARCHAR(20) NOT NULL,
    multiplier          DECIMAL(4,2) NOT NULL,
    supply_count        INTEGER,
    demand_count        INTEGER,
    ratio               DECIMAL(6,3),
    weather_factor      DECIMAL(4,2) DEFAULT 1.0,
    event_factor        DECIMAL(4,2) DEFAULT 1.0,
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (recorded_at);
CREATE INDEX idx_surge_hist ON surge_history(h3_index, recorded_at DESC);

CREATE TABLE fare_estimations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id            UUID REFERENCES riders(id),
    pickup_location     GEOMETRY(Point, 4326) NOT NULL,
    dropoff_location    GEOMETRY(Point, 4326) NOT NULL,
    vehicle_type_id     UUID REFERENCES vehicle_types(id),
    estimated_distance_m INTEGER,
    estimated_duration_s INTEGER,
    base_fare           DECIMAL(10,2),
    surge_multiplier    DECIMAL(4,2),
    estimated_total     DECIMAL(10,2),
    fare_range_low      DECIMAL(10,2),
    fare_range_high     DECIMAL(10,2),
    valid_until         TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE pricing_experiments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    experiment_name     VARCHAR(200) NOT NULL,
    description         TEXT,
    variant_a           JSONB NOT NULL,
    variant_b           JSONB NOT NULL,
    allocation_pct      DECIMAL(5,2) DEFAULT 50.0,
    target_city         UUID REFERENCES city_regions(id),
    target_vehicle_type UUID REFERENCES vehicle_types(id),
    status              VARCHAR(20) DEFAULT 'draft'
                        CHECK (status IN ('draft','running','paused','completed','cancelled')),
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    results             JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE toll_rates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    toll_name           VARCHAR(200) NOT NULL,
    location            GEOMETRY(Point, 4326) NOT NULL,
    toll_road_segment   GEOMETRY(LineString, 4326),
    vehicle_category    VARCHAR(30),
    rate                DECIMAL(10,2) NOT NULL,
    currency            VARCHAR(3) DEFAULT 'INR',
    effective_from      TIMESTAMPTZ,
    effective_until     TIMESTAMPTZ,
    is_active           BOOLEAN DEFAULT true
);
CREATE INDEX idx_toll_loc ON toll_rates USING GIST(location);

CREATE TABLE fare_caps (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    city_region_id      UUID NOT NULL REFERENCES city_regions(id),
    vehicle_type_id     UUID REFERENCES vehicle_types(id),
    max_fare_per_km     DECIMAL(8,2),
    max_total_fare      DECIMAL(10,2),
    max_surge           DECIMAL(4,2) DEFAULT 3.00,
    regulatory_ref      VARCHAR(200),
    effective_from      TIMESTAMPTZ NOT NULL,
    effective_until     TIMESTAMPTZ
);

CREATE TABLE booking_fees (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    city_region_id      UUID NOT NULL REFERENCES city_regions(id),
    vehicle_type_id     UUID REFERENCES vehicle_types(id),
    fee_amount          DECIMAL(10,2) NOT NULL,
    fee_type            VARCHAR(20) CHECK (fee_type IN ('flat','percentage')),
    description         VARCHAR(200),
    is_active           BOOLEAN DEFAULT true,
    effective_from      TIMESTAMPTZ NOT NULL
);
```

---

## 8. PAYMENT SERVICE (20 Tables)

```sql
CREATE TABLE payment_methods (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    method_type         VARCHAR(30) NOT NULL 
                        CHECK (method_type IN ('card','upi','netbanking','wallet','cash','corporate')),
    provider            VARCHAR(50),
    token               TEXT,
    last_four           VARCHAR(4),
    card_brand          VARCHAR(20),
    upi_id              VARCHAR(100),
    is_default          BOOLEAN DEFAULT false,
    is_verified         BOOLEAN DEFAULT false,
    metadata            JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ
);
CREATE INDEX idx_payment_methods ON payment_methods(user_id);

CREATE TABLE payments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    payment_method_id   UUID REFERENCES payment_methods(id),
    amount              DECIMAL(10,2) NOT NULL,
    currency            VARCHAR(3) DEFAULT 'INR',
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','authorized','captured','completed',
                                          'failed','refunded','partially_refunded','disputed')),
    gateway             VARCHAR(50),
    gateway_ref_id      VARCHAR(200),
    idempotency_key     VARCHAR(200) UNIQUE NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_payments_ride ON payments(ride_id);
CREATE INDEX idx_payments_status ON payments(status);

CREATE TABLE payment_transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id          UUID NOT NULL REFERENCES payments(id),
    transaction_type    VARCHAR(30) NOT NULL 
                        CHECK (transaction_type IN ('authorize','capture','void','refund',
                                                    'chargeback','settlement')),
    amount              DECIMAL(10,2) NOT NULL,
    status              VARCHAR(20) NOT NULL,
    gateway             VARCHAR(50),
    gateway_txn_id      VARCHAR(200),
    gateway_response    JSONB,
    error_code          VARCHAR(50),
    error_message       TEXT,
    idempotency_key     VARCHAR(200) UNIQUE NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pay_txn ON payment_transactions(payment_id);

CREATE TABLE payment_refunds (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id          UUID NOT NULL REFERENCES payments(id),
    ride_id             UUID NOT NULL,
    refund_amount       DECIMAL(10,2) NOT NULL,
    reason              TEXT NOT NULL,
    initiated_by        UUID REFERENCES users(id),
    status              VARCHAR(20) DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','completed','failed')),
    gateway_refund_id   VARCHAR(200),
    idempotency_key     VARCHAR(200) UNIQUE NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at        TIMESTAMPTZ
);

CREATE TABLE payment_disputes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id          UUID NOT NULL REFERENCES payments(id),
    dispute_type        VARCHAR(30) NOT NULL,
    amount              DECIMAL(10,2) NOT NULL,
    reason              TEXT,
    evidence            JSONB,
    status              VARCHAR(20) DEFAULT 'open',
    gateway_dispute_id  VARCHAR(200),
    deadline            TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ
);

CREATE TABLE payment_webhooks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gateway             VARCHAR(50) NOT NULL,
    event_type          VARCHAR(100) NOT NULL,
    payload             JSONB NOT NULL,
    signature           TEXT,
    is_verified         BOOLEAN DEFAULT false,
    is_processed        BOOLEAN DEFAULT false,
    process_attempts    INTEGER DEFAULT 0,
    error_message       TEXT,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at        TIMESTAMPTZ
);
CREATE INDEX idx_webhooks ON payment_webhooks(is_processed, received_at);

CREATE TABLE payment_failures (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id          UUID NOT NULL REFERENCES payments(id),
    failure_code        VARCHAR(50) NOT NULL,
    failure_message     TEXT,
    gateway_error       JSONB,
    retry_eligible      BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE payment_retries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id          UUID NOT NULL REFERENCES payments(id),
    attempt_number      INTEGER NOT NULL,
    status              VARCHAR(20) NOT NULL,
    error_code          VARCHAR(50),
    next_retry_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE idempotency_keys (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key                 VARCHAR(200) UNIQUE NOT NULL,
    request_hash        VARCHAR(64) NOT NULL,
    response_code       INTEGER,
    response_body       JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_idemp ON idempotency_keys(key);
```

### Wallet Tables

```sql
CREATE TABLE wallets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL UNIQUE REFERENCES users(id),
    balance             DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    promo_balance       DECIMAL(12,2) NOT NULL DEFAULT 0,
    currency            VARCHAR(3) DEFAULT 'INR',
    status              VARCHAR(20) DEFAULT 'active'
                        CHECK (status IN ('active','frozen','suspended','closed')),
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE wallet_transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id           UUID NOT NULL REFERENCES wallets(id),
    transaction_type    VARCHAR(30) NOT NULL 
                        CHECK (transaction_type IN ('topup','ride_payment','refund','promo_credit',
                                                    'cashback','withdrawal','adjustment','hold','release')),
    amount              DECIMAL(12,2) NOT NULL,
    balance_before      DECIMAL(12,2) NOT NULL,
    balance_after       DECIMAL(12,2) NOT NULL,
    reference_type      VARCHAR(30),
    reference_id        UUID,
    description         TEXT,
    idempotency_key     VARCHAR(200) UNIQUE NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_wallet_txn ON wallet_transactions(wallet_id, created_at DESC);

CREATE TABLE wallet_topups (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id           UUID NOT NULL REFERENCES wallets(id),
    amount              DECIMAL(12,2) NOT NULL,
    payment_method_id   UUID REFERENCES payment_methods(id),
    gateway_ref         VARCHAR(200),
    status              VARCHAR(20) DEFAULT 'pending',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE wallet_refunds (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id           UUID NOT NULL REFERENCES wallets(id),
    ride_id             UUID,
    amount              DECIMAL(12,2) NOT NULL,
    reason              TEXT,
    status              VARCHAR(20) DEFAULT 'pending',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE wallet_holds (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id           UUID NOT NULL REFERENCES wallets(id),
    ride_id             UUID NOT NULL,
    hold_amount         DECIMAL(12,2) NOT NULL,
    status              VARCHAR(20) DEFAULT 'held'
                        CHECK (status IN ('held','captured','released','expired')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    resolved_at         TIMESTAMPTZ
);

CREATE TABLE wallet_limits (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id           UUID NOT NULL REFERENCES wallets(id),
    limit_type          VARCHAR(30) NOT NULL,
    max_amount          DECIMAL(12,2) NOT NULL,
    current_usage       DECIMAL(12,2) DEFAULT 0,
    reset_at            TIMESTAMPTZ,
    UNIQUE(wallet_id, limit_type)
);

CREATE TABLE wallet_audit_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id           UUID NOT NULL REFERENCES wallets(id),
    action              VARCHAR(50) NOT NULL,
    performed_by        UUID REFERENCES users(id),
    old_value           JSONB,
    new_value           JSONB,
    reason              TEXT,
    ip_address          INET,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE wallet_expiry_rules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id           UUID NOT NULL REFERENCES wallets(id),
    promo_credit_id     UUID,
    amount              DECIMAL(12,2) NOT NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    is_expired          BOOLEAN DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 9. DRIVER INCENTIVES (12 Tables)

```sql
CREATE TABLE driver_incentives (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(200) NOT NULL,
    description         TEXT,
    incentive_type      VARCHAR(30) NOT NULL 
                        CHECK (incentive_type IN ('trip_count','earnings_guarantee','streak',
                                                  'peak_hour','area_bonus','referral','quest')),
    city_region_id      UUID REFERENCES city_regions(id),
    vehicle_type_id     UUID REFERENCES vehicle_types(id),
    rules               JSONB NOT NULL,
    budget_total        DECIMAL(12,2),
    budget_spent        DECIMAL(12,2) DEFAULT 0,
    status              VARCHAR(20) DEFAULT 'draft'
                        CHECK (status IN ('draft','active','paused','completed','expired')),
    start_date          TIMESTAMPTZ NOT NULL,
    end_date            TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE driver_bonus_rules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incentive_id        UUID NOT NULL REFERENCES driver_incentives(id),
    tier                INTEGER NOT NULL,
    target_value        INTEGER NOT NULL,
    bonus_amount        DECIMAL(10,2) NOT NULL,
    bonus_type          VARCHAR(20) CHECK (bonus_type IN ('flat','percentage','per_trip')),
    conditions          JSONB
);

CREATE TABLE driver_bonus_progress (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    incentive_id        UUID NOT NULL REFERENCES driver_incentives(id),
    current_value       INTEGER DEFAULT 0,
    target_value        INTEGER NOT NULL,
    bonus_earned        DECIMAL(10,2) DEFAULT 0,
    status              VARCHAR(20) DEFAULT 'in_progress'
                        CHECK (status IN ('in_progress','achieved','failed','expired')),
    period_start        TIMESTAMPTZ NOT NULL,
    period_end          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(driver_id, incentive_id, period_start)
);

CREATE TABLE driver_daily_targets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    target_date         DATE NOT NULL,
    target_rides        INTEGER,
    completed_rides     INTEGER DEFAULT 0,
    target_hours        DECIMAL(4,1),
    online_hours        DECIMAL(4,1) DEFAULT 0,
    target_earnings     DECIMAL(10,2),
    actual_earnings     DECIMAL(10,2) DEFAULT 0,
    bonus_earned        DECIMAL(10,2) DEFAULT 0,
    UNIQUE(driver_id, target_date)
);

CREATE TABLE driver_weekly_targets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    week_start          DATE NOT NULL,
    week_end            DATE NOT NULL,
    target_rides        INTEGER,
    completed_rides     INTEGER DEFAULT 0,
    target_earnings     DECIMAL(12,2),
    actual_earnings     DECIMAL(12,2) DEFAULT 0,
    acceptance_rate     DECIMAL(5,2),
    cancellation_rate   DECIMAL(5,2),
    bonus_earned        DECIMAL(10,2) DEFAULT 0,
    UNIQUE(driver_id, week_start)
);

CREATE TABLE driver_streaks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    streak_type         VARCHAR(30) NOT NULL,
    current_count       INTEGER DEFAULT 0,
    target_count        INTEGER NOT NULL,
    bonus_per_completion DECIMAL(10,2),
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ
);

CREATE TABLE driver_payouts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    payout_type         VARCHAR(30) NOT NULL 
                        CHECK (payout_type IN ('weekly','instant','bonus','adjustment')),
    amount              DECIMAL(12,2) NOT NULL,
    breakdown           JSONB NOT NULL,
    bank_account_id     UUID REFERENCES driver_bank_accounts(id),
    status              VARCHAR(20) DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','completed','failed','reversed')),
    gateway_ref         VARCHAR(200),
    payout_date         DATE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);
CREATE INDEX idx_payouts ON driver_payouts(driver_id, created_at DESC);

CREATE TABLE driver_commissions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    ride_fare           DECIMAL(10,2) NOT NULL,
    commission_rate     DECIMAL(5,4) NOT NULL,
    commission_amount   DECIMAL(10,2) NOT NULL,
    driver_earnings     DECIMAL(10,2) NOT NULL,
    incentive_bonus     DECIMAL(10,2) DEFAULT 0,
    total_driver_pay    DECIMAL(10,2) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_commission ON driver_commissions(driver_id, created_at DESC);

CREATE TABLE driver_tax_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    tax_year            INTEGER NOT NULL,
    total_earnings      DECIMAL(14,2),
    total_commission    DECIMAL(14,2),
    total_incentives    DECIMAL(14,2),
    tds_deducted        DECIMAL(12,2),
    gst_collected       DECIMAL(12,2),
    tax_document_url    TEXT,
    generated_at        TIMESTAMPTZ,
    UNIQUE(driver_id, tax_year)
);

CREATE TABLE driver_earnings_summary (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    summary_date        DATE NOT NULL,
    total_rides         INTEGER DEFAULT 0,
    gross_earnings      DECIMAL(12,2) DEFAULT 0,
    commission_deducted DECIMAL(12,2) DEFAULT 0,
    incentive_earned    DECIMAL(12,2) DEFAULT 0,
    tips_received       DECIMAL(12,2) DEFAULT 0,
    tolls_reimbursed    DECIMAL(12,2) DEFAULT 0,
    net_earnings        DECIMAL(12,2) DEFAULT 0,
    online_hours        DECIMAL(5,2) DEFAULT 0,
    earnings_per_hour   DECIMAL(8,2),
    UNIQUE(driver_id, summary_date)
);

CREATE TABLE driver_heat_map_nudges (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    h3_index            VARCHAR(20) NOT NULL,
    nudge_type          VARCHAR(30) CHECK (nudge_type IN ('high_demand','surge','bonus_zone','event')),
    message             TEXT,
    estimated_earnings  DECIMAL(10,2),
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ,
    driver_responded    BOOLEAN DEFAULT false
);

CREATE TABLE area_incentive_zones (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_name           VARCHAR(200),
    h3_indices          TEXT[] NOT NULL,
    bonus_multiplier    DECIMAL(4,2) DEFAULT 1.0,
    bonus_flat          DECIMAL(10,2) DEFAULT 0,
    effective_from      TIMESTAMPTZ NOT NULL,
    effective_until     TIMESTAMPTZ NOT NULL,
    is_active           BOOLEAN DEFAULT true
);
```

---

## 10. NOTIFICATION SERVICE (8 Tables)

```sql
CREATE TABLE notification_templates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_key        VARCHAR(100) UNIQUE NOT NULL,
    channel             VARCHAR(20) NOT NULL CHECK (channel IN ('push','sms','email','in_app','whatsapp')),
    title_template      TEXT,
    body_template       TEXT NOT NULL,
    variables           TEXT[],
    language            VARCHAR(10) DEFAULT 'en',
    is_active           BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE notifications (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    template_id         UUID REFERENCES notification_templates(id),
    channel             VARCHAR(20) NOT NULL,
    title               VARCHAR(200),
    body                TEXT NOT NULL,
    data_payload        JSONB,
    priority            VARCHAR(10) DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
    status              VARCHAR(20) DEFAULT 'pending'
                        CHECK (status IN ('pending','sent','delivered','read','failed','cancelled')),
    reference_type      VARCHAR(30),
    reference_id        UUID,
    sent_at             TIMESTAMPTZ,
    delivered_at        TIMESTAMPTZ,
    read_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_notif_user ON notifications(user_id, created_at DESC);

CREATE TABLE notification_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id     UUID NOT NULL REFERENCES notifications(id),
    event               VARCHAR(30) NOT NULL,
    provider_response   JSONB,
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE push_tokens (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    device_id           UUID REFERENCES user_devices(id),
    platform            VARCHAR(10) NOT NULL CHECK (platform IN ('ios','android','web')),
    token               TEXT NOT NULL,
    is_active           BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_push_tokens ON push_tokens(user_id);

CREATE TABLE sms_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number        VARCHAR(20) NOT NULL,
    message             TEXT NOT NULL,
    provider            VARCHAR(50),
    provider_msg_id     VARCHAR(200),
    status              VARCHAR(20),
    cost                DECIMAL(8,4),
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE email_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    to_email            VARCHAR(255) NOT NULL,
    subject             VARCHAR(500) NOT NULL,
    template_id         UUID REFERENCES notification_templates(id),
    provider            VARCHAR(50),
    provider_msg_id     VARCHAR(200),
    status              VARCHAR(20),
    opened_at           TIMESTAMPTZ,
    clicked_at          TIMESTAMPTZ,
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE notification_preferences (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    notification_type   VARCHAR(50) NOT NULL,
    push_enabled        BOOLEAN DEFAULT true,
    sms_enabled         BOOLEAN DEFAULT true,
    email_enabled       BOOLEAN DEFAULT true,
    quiet_hours_start   TIME,
    quiet_hours_end     TIME,
    UNIQUE(user_id, notification_type)
);

CREATE TABLE in_app_messages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    message_type        VARCHAR(30),
    title               VARCHAR(200),
    body                TEXT,
    action_url          TEXT,
    image_url           TEXT,
    is_read             BOOLEAN DEFAULT false,
    expires_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 11. FRAUD & RISK SYSTEM (12 Tables)

```sql
CREATE TABLE fraud_rules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_name           VARCHAR(200) NOT NULL,
    rule_type           VARCHAR(30) NOT NULL,
    conditions          JSONB NOT NULL,
    action              VARCHAR(30) NOT NULL 
                        CHECK (action IN ('flag','block','suspend','alert','manual_review')),
    severity            VARCHAR(10) CHECK (severity IN ('low','medium','high','critical')),
    is_active           BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE fraud_flags (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES users(id),
    ride_id             UUID REFERENCES rides(id),
    rule_id             UUID REFERENCES fraud_rules(id),
    flag_type           VARCHAR(50) NOT NULL,
    severity            VARCHAR(10) NOT NULL,
    evidence            JSONB NOT NULL,
    status              VARCHAR(20) DEFAULT 'open'
                        CHECK (status IN ('open','investigating','confirmed','dismissed','resolved')),
    assigned_to         UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ,
    resolution_notes    TEXT
);
CREATE INDEX idx_fraud_flags ON fraud_flags(user_id, status);

CREATE TABLE fraud_detection_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id             UUID REFERENCES fraud_rules(id),
    user_id             UUID,
    ride_id             UUID,
    input_data          JSONB,
    result              VARCHAR(20) NOT NULL,
    score               DECIMAL(6,4),
    processing_ms       INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE fraud_blacklist (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identifier_type     VARCHAR(30) NOT NULL 
                        CHECK (identifier_type IN ('phone','email','device','ip','card','upi')),
    identifier_value    VARCHAR(500) NOT NULL,
    reason              TEXT NOT NULL,
    added_by            UUID REFERENCES users(id),
    is_active           BOOLEAN DEFAULT true,
    expires_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_blacklist ON fraud_blacklist(identifier_type, identifier_value);

CREATE TABLE suspicious_activity (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES users(id),
    activity_type       VARCHAR(50) NOT NULL,
    description         TEXT,
    risk_score          DECIMAL(5,2),
    indicators          JSONB,
    auto_action_taken   VARCHAR(50),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE device_fingerprints (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES users(id),
    fingerprint_hash    VARCHAR(128) NOT NULL,
    device_data         JSONB NOT NULL,
    is_trusted          BOOLEAN DEFAULT false,
    is_flagged          BOOLEAN DEFAULT false,
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    seen_count          INTEGER DEFAULT 1
);
CREATE INDEX idx_fingerprint ON device_fingerprints(fingerprint_hash);

CREATE TABLE risk_scores (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    overall_score       DECIMAL(5,2) NOT NULL,
    score_components    JSONB NOT NULL,
    risk_level          VARCHAR(10) CHECK (risk_level IN ('low','medium','high','critical')),
    model_version       VARCHAR(50),
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_risk ON risk_scores(user_id, computed_at DESC);

CREATE TABLE fraud_gps_spoofing (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    ride_id             UUID REFERENCES rides(id),
    detection_method    VARCHAR(50) NOT NULL,
    evidence            JSONB NOT NULL,
    confidence          DECIMAL(5,2),
    action_taken        VARCHAR(30),
    detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE fraud_collusion_detection (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID REFERENCES drivers(id),
    rider_id            UUID REFERENCES riders(id),
    pattern_type        VARCHAR(50) NOT NULL,
    ride_ids            UUID[] NOT NULL,
    evidence            JSONB NOT NULL,
    confidence          DECIMAL(5,2),
    detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE fraud_wallet_abuse (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id           UUID NOT NULL,
    user_id             UUID NOT NULL REFERENCES users(id),
    abuse_type          VARCHAR(50) NOT NULL,
    amount_involved     DECIMAL(12,2),
    evidence            JSONB,
    action_taken        VARCHAR(30),
    detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE fraud_investigation_queue (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fraud_flag_id       UUID REFERENCES fraud_flags(id),
    priority            INTEGER NOT NULL,
    assigned_to         UUID REFERENCES users(id),
    status              VARCHAR(20) DEFAULT 'queued',
    sla_deadline        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE fraud_ml_models (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_name          VARCHAR(100) NOT NULL,
    model_version       VARCHAR(50) NOT NULL,
    model_type          VARCHAR(50),
    accuracy            DECIMAL(5,4),
    precision_score     DECIMAL(5,4),
    recall_score        DECIMAL(5,4),
    is_active           BOOLEAN DEFAULT false,
    deployed_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 12. PROMOTIONS & COUPONS (12 Tables)

```sql
CREATE TABLE promo_campaigns (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_name       VARCHAR(200) NOT NULL,
    description         TEXT,
    campaign_type       VARCHAR(30) NOT NULL 
                        CHECK (campaign_type IN ('acquisition','retention','reactivation',
                                                 'seasonal','partnership','loyalty')),
    budget              DECIMAL(14,2),
    spent               DECIMAL(14,2) DEFAULT 0,
    target_audience     JSONB,
    status              VARCHAR(20) DEFAULT 'draft',
    start_date          TIMESTAMPTZ NOT NULL,
    end_date            TIMESTAMPTZ NOT NULL,
    created_by          UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE promo_codes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id         UUID REFERENCES promo_campaigns(id),
    code                VARCHAR(50) UNIQUE NOT NULL,
    discount_type       VARCHAR(20) NOT NULL CHECK (discount_type IN ('flat','percentage','cashback')),
    discount_value      DECIMAL(10,2) NOT NULL,
    max_discount        DECIMAL(10,2),
    min_ride_fare       DECIMAL(10,2),
    applicable_vehicle_types UUID[],
    applicable_cities   UUID[],
    is_first_ride_only  BOOLEAN DEFAULT false,
    max_uses_total      INTEGER,
    max_uses_per_user   INTEGER DEFAULT 1,
    current_uses        INTEGER DEFAULT 0,
    is_active           BOOLEAN DEFAULT true,
    valid_from          TIMESTAMPTZ NOT NULL,
    valid_until         TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_promo_code ON promo_codes(code);

CREATE TABLE promo_usage (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promo_code_id       UUID NOT NULL REFERENCES promo_codes(id),
    user_id             UUID NOT NULL REFERENCES users(id),
    ride_id             UUID REFERENCES rides(id),
    discount_applied    DECIMAL(10,2) NOT NULL,
    used_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_promo_usage ON promo_usage(user_id, promo_code_id);

CREATE TABLE promo_limits (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promo_code_id       UUID NOT NULL REFERENCES promo_codes(id),
    limit_type          VARCHAR(30) NOT NULL,
    limit_value         INTEGER NOT NULL,
    current_value       INTEGER DEFAULT 0,
    UNIQUE(promo_code_id, limit_type)
);

CREATE TABLE promo_rules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promo_code_id       UUID NOT NULL REFERENCES promo_codes(id),
    rule_type           VARCHAR(50) NOT NULL,
    rule_conditions     JSONB NOT NULL,
    priority            INTEGER DEFAULT 0
);

CREATE TABLE promo_redemptions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promo_code_id       UUID NOT NULL REFERENCES promo_codes(id),
    user_id             UUID NOT NULL REFERENCES users(id),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    original_fare       DECIMAL(10,2) NOT NULL,
    discount_amount     DECIMAL(10,2) NOT NULL,
    final_fare          DECIMAL(10,2) NOT NULL,
    redeemed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE referral_programs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_name        VARCHAR(200) NOT NULL,
    referrer_reward     DECIMAL(10,2) NOT NULL,
    referee_reward      DECIMAL(10,2) NOT NULL,
    reward_type         VARCHAR(20) CHECK (reward_type IN ('wallet_credit','promo_code','cashback')),
    conditions          JSONB,
    is_active           BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE referral_codes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    program_id          UUID NOT NULL REFERENCES referral_programs(id),
    code                VARCHAR(20) UNIQUE NOT NULL,
    uses_count          INTEGER DEFAULT 0,
    max_uses            INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE referral_tracking (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referral_code_id    UUID NOT NULL REFERENCES referral_codes(id),
    referrer_id         UUID NOT NULL REFERENCES users(id),
    referee_id          UUID NOT NULL REFERENCES users(id),
    status              VARCHAR(20) DEFAULT 'pending'
                        CHECK (status IN ('pending','signup_complete','first_ride','reward_issued','expired')),
    referrer_rewarded   BOOLEAN DEFAULT false,
    referee_rewarded    BOOLEAN DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);

CREATE TABLE referral_payouts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tracking_id         UUID NOT NULL REFERENCES referral_tracking(id),
    user_id             UUID NOT NULL REFERENCES users(id),
    amount              DECIMAL(10,2) NOT NULL,
    payout_type         VARCHAR(20) NOT NULL,
    status              VARCHAR(20) DEFAULT 'pending',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE promo_analytics (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id         UUID REFERENCES promo_campaigns(id),
    promo_code_id       UUID REFERENCES promo_codes(id),
    analytics_date      DATE NOT NULL,
    impressions         INTEGER DEFAULT 0,
    redemptions         INTEGER DEFAULT 0,
    total_discount      DECIMAL(12,2) DEFAULT 0,
    incremental_rides   INTEGER DEFAULT 0,
    roi_estimate        DECIMAL(8,4)
);

CREATE TABLE promo_ab_tests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_name           VARCHAR(200),
    variant_a_code_id   UUID REFERENCES promo_codes(id),
    variant_b_code_id   UUID REFERENCES promo_codes(id),
    target_metric       VARCHAR(50),
    status              VARCHAR(20) DEFAULT 'running',
    winner              VARCHAR(10),
    results             JSONB,
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ
);
```

---

## 13. SAFETY / SOS SERVICE (8 Tables)

```sql
CREATE TABLE emergency_contacts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    contact_name        VARCHAR(200) NOT NULL,
    phone_number        VARCHAR(20) NOT NULL,
    relationship        VARCHAR(50),
    is_primary          BOOLEAN DEFAULT false,
    auto_share_rides    BOOLEAN DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_emergency ON emergency_contacts(user_id);

CREATE TABLE sos_triggers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    triggered_by        UUID NOT NULL REFERENCES users(id),
    trigger_type        VARCHAR(30) NOT NULL 
                        CHECK (trigger_type IN ('manual','crash_detect','long_stop','route_deviation','shake')),
    location            GEOMETRY(Point, 4326),
    status              VARCHAR(20) DEFAULT 'triggered'
                        CHECK (status IN ('triggered','acknowledged','responding','resolved','false_alarm')),
    auto_actions        JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ
);

CREATE TABLE sos_response_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sos_id              UUID NOT NULL REFERENCES sos_triggers(id),
    responder_type      VARCHAR(30) NOT NULL 
                        CHECK (responder_type IN ('safety_team','police','ambulance','emergency_contact','system')),
    responder_id        UUID,
    action_taken        TEXT NOT NULL,
    response_time_sec   INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE safety_check_ins (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    user_id             UUID NOT NULL REFERENCES users(id),
    check_in_type       VARCHAR(30) CHECK (check_in_type IN ('auto_prompt','manual','timer_based')),
    response            VARCHAR(20) CHECK (response IN ('safe','unsafe','no_response')),
    prompted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at        TIMESTAMPTZ,
    escalated           BOOLEAN DEFAULT false
);

CREATE TABLE ride_audio_recordings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    recording_url       TEXT NOT NULL,
    duration_seconds    INTEGER,
    started_at          TIMESTAMPTZ NOT NULL,
    ended_at            TIMESTAMPTZ,
    is_encrypted        BOOLEAN DEFAULT true,
    retention_until     TIMESTAMPTZ NOT NULL,
    accessed_by         UUID[],
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE trusted_contacts_shares (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    user_id             UUID NOT NULL REFERENCES users(id),
    contact_id          UUID NOT NULL REFERENCES emergency_contacts(id),
    share_type          VARCHAR(20) CHECK (share_type IN ('auto','manual')),
    share_url           TEXT NOT NULL,
    shared_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    viewed_at           TIMESTAMPTZ
);

CREATE TABLE safety_incidents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID REFERENCES rides(id),
    reported_by         UUID NOT NULL REFERENCES users(id),
    incident_type       VARCHAR(50) NOT NULL,
    severity            VARCHAR(10) NOT NULL,
    description         TEXT NOT NULL,
    evidence_urls       TEXT[],
    location            GEOMETRY(Point, 4326),
    status              VARCHAR(20) DEFAULT 'reported',
    assigned_to         UUID REFERENCES users(id),
    resolution          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ
);

CREATE TABLE safety_scores (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    user_type           VARCHAR(10) NOT NULL,
    safety_score        DECIMAL(5,2) NOT NULL,
    score_factors       JSONB NOT NULL,
    incidents_count     INTEGER DEFAULT 0,
    sos_count           INTEGER DEFAULT 0,
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 14. SCHEDULING / RESERVATION SERVICE (5 Tables)

```sql
CREATE TABLE scheduled_rides (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    scheduled_pickup_at TIMESTAMPTZ NOT NULL,
    reminder_sent       BOOLEAN DEFAULT false,
    pre_dispatch_at     TIMESTAMPTZ,
    status              VARCHAR(20) DEFAULT 'scheduled'
                        CHECK (status IN ('scheduled','reminder_sent','dispatching','dispatched',
                                          'cancelled','expired')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_scheduled ON scheduled_rides(scheduled_pickup_at, status);

CREATE TABLE recurring_ride_templates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    template_name       VARCHAR(200),
    pickup_lat          DECIMAL(10,7) NOT NULL,
    pickup_lng          DECIMAL(10,7) NOT NULL,
    pickup_address      TEXT,
    dropoff_lat         DECIMAL(10,7) NOT NULL,
    dropoff_lng         DECIMAL(10,7) NOT NULL,
    dropoff_address     TEXT,
    vehicle_type_id     UUID REFERENCES vehicle_types(id),
    recurrence_rule     JSONB NOT NULL,
    pickup_time         TIME NOT NULL,
    is_active           BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE schedule_dispatch_queue (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scheduled_ride_id   UUID NOT NULL REFERENCES scheduled_rides(id),
    dispatch_at         TIMESTAMPTZ NOT NULL,
    status              VARCHAR(20) DEFAULT 'queued'
                        CHECK (status IN ('queued','dispatching','dispatched','failed','cancelled')),
    attempts            INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE schedule_reminders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scheduled_ride_id   UUID NOT NULL REFERENCES scheduled_rides(id),
    reminder_type       VARCHAR(20) CHECK (reminder_type IN ('30min','15min','5min','custom')),
    channel             VARCHAR(20),
    sent_at             TIMESTAMPTZ,
    status              VARCHAR(20) DEFAULT 'pending'
);

CREATE TABLE schedule_analytics (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date                DATE NOT NULL,
    city_region_id      UUID REFERENCES city_regions(id),
    total_scheduled     INTEGER DEFAULT 0,
    converted_to_ride   INTEGER DEFAULT 0,
    cancelled           INTEGER DEFAULT 0,
    no_driver_found     INTEGER DEFAULT 0,
    avg_advance_minutes INTEGER,
    UNIQUE(date, city_region_id)
);
```

---

## 15. CORPORATE / B2B ACCOUNTS (6 Tables)

```sql
CREATE TABLE corporate_accounts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name        VARCHAR(300) NOT NULL,
    company_email       VARCHAR(255),
    billing_address     JSONB,
    tax_id              VARCHAR(50),
    account_manager_id  UUID REFERENCES users(id),
    credit_limit        DECIMAL(14,2),
    current_balance     DECIMAL(14,2) DEFAULT 0,
    billing_cycle       VARCHAR(20) DEFAULT 'monthly',
    status              VARCHAR(20) DEFAULT 'active',
    contract_url        TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE corporate_policies (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    corporate_id        UUID NOT NULL REFERENCES corporate_accounts(id),
    policy_name         VARCHAR(200) NOT NULL,
    max_fare_per_ride   DECIMAL(10,2),
    max_rides_per_month INTEGER,
    allowed_vehicle_types UUID[],
    allowed_hours       JSONB,
    allowed_zones       UUID[],
    requires_approval   BOOLEAN DEFAULT false,
    is_active           BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE corporate_billing (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    corporate_id        UUID NOT NULL REFERENCES corporate_accounts(id),
    billing_period_start DATE NOT NULL,
    billing_period_end  DATE NOT NULL,
    total_rides         INTEGER,
    total_amount        DECIMAL(14,2),
    tax_amount          DECIMAL(12,2),
    invoice_number      VARCHAR(50) UNIQUE,
    invoice_url         TEXT,
    status              VARCHAR(20) DEFAULT 'pending'
                        CHECK (status IN ('pending','generated','sent','paid','overdue')),
    due_date            DATE,
    paid_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE employee_ride_allocations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    corporate_id        UUID NOT NULL REFERENCES corporate_accounts(id),
    user_id             UUID NOT NULL REFERENCES users(id),
    policy_id           UUID REFERENCES corporate_policies(id),
    monthly_limit       DECIMAL(10,2),
    used_amount         DECIMAL(10,2) DEFAULT 0,
    rides_used          INTEGER DEFAULT 0,
    period_start        DATE NOT NULL,
    period_end          DATE NOT NULL,
    UNIQUE(corporate_id, user_id, period_start)
);

CREATE TABLE corporate_invoices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    corporate_id        UUID NOT NULL REFERENCES corporate_accounts(id),
    billing_id          UUID NOT NULL REFERENCES corporate_billing(id),
    invoice_number      VARCHAR(50) UNIQUE NOT NULL,
    line_items          JSONB NOT NULL,
    subtotal            DECIMAL(14,2),
    tax                 DECIMAL(12,2),
    total               DECIMAL(14,2),
    pdf_url             TEXT,
    generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE corporate_ride_approvals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    employee_id         UUID NOT NULL REFERENCES users(id),
    corporate_id        UUID NOT NULL REFERENCES corporate_accounts(id),
    approver_id         UUID REFERENCES users(id),
    status              VARCHAR(20) DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected','auto_approved')),
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at        TIMESTAMPTZ
);
```

---

## 16. SUPPORT & CUSTOMER SERVICE (8 Tables)

```sql
CREATE TABLE support_categories (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(200) NOT NULL,
    parent_id           UUID REFERENCES support_categories(id),
    icon                VARCHAR(50),
    sort_order          INTEGER DEFAULT 0,
    is_active           BOOLEAN DEFAULT true
);

CREATE TABLE support_tickets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_number       VARCHAR(20) UNIQUE NOT NULL,
    user_id             UUID NOT NULL REFERENCES users(id),
    ride_id             UUID REFERENCES rides(id),
    category_id         UUID REFERENCES support_categories(id),
    subject             VARCHAR(500) NOT NULL,
    description         TEXT NOT NULL,
    priority            VARCHAR(10) DEFAULT 'medium' 
                        CHECK (priority IN ('low','medium','high','urgent')),
    status              VARCHAR(20) DEFAULT 'open'
                        CHECK (status IN ('open','assigned','in_progress','waiting_user',
                                          'resolved','closed','reopened')),
    assigned_to         UUID REFERENCES users(id),
    sla_deadline        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ,
    closed_at           TIMESTAMPTZ
);
CREATE INDEX idx_tickets ON support_tickets(user_id, status);

CREATE TABLE support_ticket_messages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL REFERENCES support_tickets(id),
    sender_id           UUID NOT NULL REFERENCES users(id),
    sender_type         VARCHAR(20) CHECK (sender_type IN ('user','agent','system','bot')),
    message             TEXT NOT NULL,
    attachments         TEXT[],
    is_internal         BOOLEAN DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE support_agents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL UNIQUE REFERENCES users(id),
    agent_name          VARCHAR(200),
    team                VARCHAR(100),
    skills              TEXT[],
    max_concurrent      INTEGER DEFAULT 5,
    current_load        INTEGER DEFAULT 0,
    is_available        BOOLEAN DEFAULT true,
    shift_start         TIME,
    shift_end           TIME
);

CREATE TABLE ticket_status_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL REFERENCES support_tickets(id),
    old_status          VARCHAR(20),
    new_status          VARCHAR(20) NOT NULL,
    changed_by          UUID REFERENCES users(id),
    reason              TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ticket_escalations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL REFERENCES support_tickets(id),
    escalated_from      UUID REFERENCES users(id),
    escalated_to        UUID REFERENCES users(id),
    escalation_level    INTEGER NOT NULL,
    reason              TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE support_csat (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL REFERENCES support_tickets(id),
    user_id             UUID NOT NULL REFERENCES users(id),
    rating              INTEGER CHECK (rating >= 1 AND rating <= 5),
    feedback            TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE support_faq (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id         UUID REFERENCES support_categories(id),
    question            TEXT NOT NULL,
    answer              TEXT NOT NULL,
    language            VARCHAR(10) DEFAULT 'en',
    view_count          INTEGER DEFAULT 0,
    helpful_count       INTEGER DEFAULT 0,
    is_active           BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 17. COMPLIANCE & REGULATORY (6 Tables)

```sql
CREATE TABLE regulatory_reports (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_type         VARCHAR(50) NOT NULL,
    jurisdiction        VARCHAR(100) NOT NULL,
    reporting_period    TSTZRANGE NOT NULL,
    data                JSONB NOT NULL,
    status              VARCHAR(20) DEFAULT 'generated',
    submitted_at        TIMESTAMPTZ,
    acknowledged_at     TIMESTAMPTZ,
    document_url        TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tax_jurisdiction_rules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jurisdiction        VARCHAR(100) NOT NULL,
    tax_type            VARCHAR(50) NOT NULL,
    rate                DECIMAL(6,4) NOT NULL,
    applies_to          VARCHAR(30) CHECK (applies_to IN ('rider','driver','platform')),
    conditions          JSONB,
    effective_from      TIMESTAMPTZ NOT NULL,
    effective_until     TIMESTAMPTZ
);

CREATE TABLE driver_tax_withholdings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    tax_type            VARCHAR(50) NOT NULL,
    period_start        DATE NOT NULL,
    period_end          DATE NOT NULL,
    gross_amount        DECIMAL(14,2),
    withholding_rate    DECIMAL(6,4),
    withheld_amount     DECIMAL(12,2),
    remitted            BOOLEAN DEFAULT false,
    remitted_at         TIMESTAMPTZ
);

CREATE TABLE data_retention_policies (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    data_category       VARCHAR(100) NOT NULL,
    retention_days      INTEGER NOT NULL,
    jurisdiction        VARCHAR(100),
    deletion_strategy   VARCHAR(30) CHECK (deletion_strategy IN ('hard_delete','anonymize','archive')),
    is_active           BOOLEAN DEFAULT true,
    last_executed_at    TIMESTAMPTZ
);

CREATE TABLE data_deletion_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    request_type        VARCHAR(30) NOT NULL CHECK (request_type IN ('gdpr_delete','ccpa_delete','account_delete')),
    status              VARCHAR(20) DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','completed','rejected')),
    data_categories     TEXT[],
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deadline            TIMESTAMPTZ NOT NULL,
    completed_at        TIMESTAMPTZ,
    processed_by        UUID REFERENCES users(id)
);

CREATE TABLE audit_trails (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type         VARCHAR(50) NOT NULL,
    entity_id           UUID NOT NULL,
    action              VARCHAR(30) NOT NULL,
    actor_id            UUID REFERENCES users(id),
    actor_type          VARCHAR(20),
    old_values          JSONB,
    new_values          JSONB,
    ip_address          INET,
    user_agent          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit ON audit_trails(entity_type, entity_id, created_at DESC);
```

---

## 18. SAGA ORCHESTRATION (4 Tables)

```sql
CREATE TABLE saga_instances (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    saga_type           VARCHAR(50) NOT NULL 
                        CHECK (saga_type IN ('ride_lifecycle','payment_flow','refund_flow',
                                             'driver_payout','scheduled_ride')),
    correlation_id      UUID NOT NULL,
    current_step        VARCHAR(50) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running','compensating','completed','failed','timed_out')),
    state_data          JSONB NOT NULL,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    timeout_at          TIMESTAMPTZ
);
CREATE INDEX idx_saga ON saga_instances(saga_type, status);
CREATE INDEX idx_saga_corr ON saga_instances(correlation_id);

CREATE TABLE saga_step_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    saga_id             UUID NOT NULL REFERENCES saga_instances(id),
    step_name           VARCHAR(50) NOT NULL,
    step_order          INTEGER NOT NULL,
    action              VARCHAR(20) NOT NULL CHECK (action IN ('execute','compensate')),
    status              VARCHAR(20) NOT NULL 
                        CHECK (status IN ('pending','running','completed','failed','compensated')),
    input_data          JSONB,
    output_data         JSONB,
    error_message       TEXT,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);
CREATE INDEX idx_saga_steps ON saga_step_logs(saga_id, step_order);

CREATE TABLE saga_compensations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    saga_id             UUID NOT NULL REFERENCES saga_instances(id),
    step_name           VARCHAR(50) NOT NULL,
    compensation_action VARCHAR(100) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempts            INTEGER DEFAULT 0,
    max_attempts        INTEGER DEFAULT 3,
    error_log           JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    executed_at         TIMESTAMPTZ
);

CREATE TABLE dead_letter_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_topic      VARCHAR(200) NOT NULL,
    event_key           VARCHAR(200),
    event_payload       JSONB NOT NULL,
    error_message       TEXT NOT NULL,
    retry_count         INTEGER DEFAULT 0,
    max_retries         INTEGER DEFAULT 5,
    status              VARCHAR(20) DEFAULT 'pending'
                        CHECK (status IN ('pending','retrying','resolved','abandoned')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_retry_at       TIMESTAMPTZ,
    resolved_at         TIMESTAMPTZ
);
CREATE INDEX idx_dle ON dead_letter_events(status, next_retry_at);
```

---

## 19. EVENT SYSTEM & SCHEMA REGISTRY (4 Tables)

```sql
CREATE TABLE event_schemas (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type          VARCHAR(100) NOT NULL,
    version             INTEGER NOT NULL,
    schema_definition   JSONB NOT NULL,
    is_latest           BOOLEAN DEFAULT true,
    backward_compatible BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(event_type, version)
);

CREATE TABLE schema_versions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schema_id           UUID NOT NULL REFERENCES event_schemas(id),
    change_description  TEXT,
    migration_script    TEXT,
    breaking_change     BOOLEAN DEFAULT false,
    deployed_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE event_publish_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type          VARCHAR(100) NOT NULL,
    event_id            UUID NOT NULL,
    topic               VARCHAR(200) NOT NULL,
    partition_key       VARCHAR(200),
    payload_size_bytes  INTEGER,
    published_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged        BOOLEAN DEFAULT false
);

CREATE TABLE event_consumer_offsets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consumer_group      VARCHAR(100) NOT NULL,
    topic               VARCHAR(200) NOT NULL,
    partition_id        INTEGER NOT NULL,
    current_offset      BIGINT NOT NULL,
    committed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(consumer_group, topic, partition_id)
);
```

---

## 20. DATA WAREHOUSE / ANALYTICS (22 Tables)

### Fact Tables

```sql
CREATE TABLE fact_rides (
    ride_id             UUID PRIMARY KEY,
    ride_number         VARCHAR(20),
    rider_dim_id        UUID,
    driver_dim_id       UUID,
    vehicle_type_dim_id UUID,
    pickup_location_dim_id UUID,
    dropoff_location_dim_id UUID,
    time_dim_id         UUID,
    
    ride_type           VARCHAR(30),
    status              VARCHAR(30),
    distance_m          INTEGER,
    duration_s          INTEGER,
    wait_time_s         INTEGER,
    pickup_time_s       INTEGER,
    
    base_fare           DECIMAL(10,2),
    surge_multiplier    DECIMAL(4,2),
    total_fare          DECIMAL(10,2),
    driver_earnings     DECIMAL(10,2),
    platform_revenue    DECIMAL(10,2),
    promo_discount      DECIMAL(10,2),
    
    match_score         DECIMAL(8,4),
    dispatch_attempts   INTEGER,
    
    requested_at        TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    etl_loaded_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE fact_payments (
    payment_id          UUID PRIMARY KEY,
    ride_id             UUID,
    rider_dim_id        UUID,
    time_dim_id         UUID,
    
    payment_method      VARCHAR(30),
    gateway             VARCHAR(50),
    amount              DECIMAL(10,2),
    currency            VARCHAR(3),
    status              VARCHAR(20),
    
    processing_time_ms  INTEGER,
    retry_count         INTEGER,
    
    created_at          TIMESTAMPTZ,
    etl_loaded_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE fact_driver_activity (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_dim_id       UUID,
    time_dim_id         UUID,
    location_dim_id     UUID,
    
    activity_date       DATE,
    online_minutes      INTEGER,
    idle_minutes        INTEGER,
    on_ride_minutes     INTEGER,
    rides_completed     INTEGER,
    rides_cancelled     INTEGER,
    acceptance_rate     DECIMAL(5,2),
    gross_earnings      DECIMAL(12,2),
    incentive_earnings  DECIMAL(12,2),
    
    etl_loaded_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE fact_user_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_dim_id         UUID,
    time_dim_id         UUID,
    
    session_date        DATE,
    app_type            VARCHAR(20),
    session_duration_s  INTEGER,
    screens_viewed      INTEGER,
    rides_requested     INTEGER,
    rides_completed     INTEGER,
    search_count        INTEGER,
    
    etl_loaded_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE fact_dispatch (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID,
    time_dim_id         UUID,
    location_dim_id     UUID,
    
    algorithm_version   VARCHAR(50),
    candidates_evaluated INTEGER,
    attempts_made       INTEGER,
    match_time_ms       INTEGER,
    success             BOOLEAN,
    final_eta_s         INTEGER,
    
    etl_loaded_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE fact_surge (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_dim_id     UUID,
    time_dim_id         UUID,
    
    h3_index            VARCHAR(20),
    multiplier          DECIMAL(4,2),
    supply_count        INTEGER,
    demand_count        INTEGER,
    supply_demand_ratio DECIMAL(6,3),
    
    recorded_at         TIMESTAMPTZ,
    etl_loaded_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE fact_fraud (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_dim_id         UUID,
    time_dim_id         UUID,
    
    fraud_type          VARCHAR(50),
    severity            VARCHAR(10),
    confirmed           BOOLEAN,
    amount_involved     DECIMAL(12,2),
    
    detected_at         TIMESTAMPTZ,
    etl_loaded_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE fact_support (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_dim_id         UUID,
    agent_dim_id        UUID,
    time_dim_id         UUID,
    
    category            VARCHAR(100),
    priority            VARCHAR(10),
    resolution_time_min INTEGER,
    messages_count      INTEGER,
    csat_rating         INTEGER,
    
    created_at          TIMESTAMPTZ,
    etl_loaded_at       TIMESTAMPTZ DEFAULT NOW()
);
```

### Dimension Tables

```sql
CREATE TABLE dim_users (
    dim_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL,
    user_type           VARCHAR(20),
    city                VARCHAR(100),
    country             VARCHAR(50),
    registration_date   DATE,
    tier                VARCHAR(20),
    is_active           BOOLEAN,
    valid_from          TIMESTAMPTZ NOT NULL,
    valid_to            TIMESTAMPTZ,
    is_current          BOOLEAN DEFAULT true
);

CREATE TABLE dim_drivers (
    dim_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL,
    driver_type         VARCHAR(30),
    city                VARCHAR(100),
    avg_rating          DECIMAL(3,2),
    total_rides         INTEGER,
    experience_months   INTEGER,
    valid_from          TIMESTAMPTZ NOT NULL,
    valid_to            TIMESTAMPTZ,
    is_current          BOOLEAN DEFAULT true
);

CREATE TABLE dim_locations (
    dim_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    h3_index            VARCHAR(20) NOT NULL,
    city                VARCHAR(100),
    region              VARCHAR(100),
    country             VARCHAR(50),
    zone_type           VARCHAR(30),
    latitude            DECIMAL(10,7),
    longitude           DECIMAL(10,7)
);

CREATE TABLE dim_time (
    dim_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_date           DATE NOT NULL UNIQUE,
    year                INTEGER,
    quarter             INTEGER,
    month               INTEGER,
    week                INTEGER,
    day_of_week         INTEGER,
    day_name            VARCHAR(10),
    is_weekend          BOOLEAN,
    is_holiday          BOOLEAN,
    holiday_name        VARCHAR(100),
    hour                INTEGER,
    time_of_day         VARCHAR(20)
);

CREATE TABLE dim_vehicle_types (
    dim_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_type_id     UUID NOT NULL,
    name                VARCHAR(50),
    category            VARCHAR(30),
    max_passengers      INTEGER,
    valid_from          TIMESTAMPTZ NOT NULL,
    is_current          BOOLEAN DEFAULT true
);

CREATE TABLE dim_promo_campaigns (
    dim_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id         UUID NOT NULL,
    campaign_name       VARCHAR(200),
    campaign_type       VARCHAR(30),
    discount_type       VARCHAR(20),
    start_date          DATE,
    end_date            DATE
);
```

### Analytics Aggregates

```sql
CREATE TABLE agg_daily_city_metrics (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    metric_date         DATE NOT NULL,
    city_region_id      UUID NOT NULL,
    total_rides         INTEGER,
    completed_rides     INTEGER,
    cancelled_rides     INTEGER,
    total_revenue       DECIMAL(14,2),
    total_driver_pay    DECIMAL(14,2),
    avg_fare            DECIMAL(10,2),
    avg_surge           DECIMAL(4,2),
    avg_wait_time_s     INTEGER,
    avg_ride_distance_m INTEGER,
    unique_riders       INTEGER,
    unique_drivers      INTEGER,
    new_riders          INTEGER,
    UNIQUE(metric_date, city_region_id)
);

CREATE TABLE agg_hourly_supply_demand (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hour_start          TIMESTAMPTZ NOT NULL,
    city_region_id      UUID NOT NULL,
    h3_index            VARCHAR(20),
    supply_drivers      INTEGER,
    demand_requests     INTEGER,
    fulfilled_requests  INTEGER,
    avg_surge           DECIMAL(4,2),
    avg_eta_s           INTEGER,
    UNIQUE(hour_start, city_region_id, h3_index)
);

CREATE TABLE agg_driver_cohort_analysis (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cohort_month        DATE NOT NULL,
    months_since_join   INTEGER NOT NULL,
    drivers_count       INTEGER,
    active_drivers      INTEGER,
    avg_rides_per_driver DECIMAL(8,2),
    avg_earnings        DECIMAL(12,2),
    retention_rate      DECIMAL(5,2),
    churn_rate          DECIMAL(5,2)
);

CREATE TABLE agg_rider_cohort_analysis (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cohort_month        DATE NOT NULL,
    months_since_join   INTEGER NOT NULL,
    riders_count        INTEGER,
    active_riders       INTEGER,
    avg_rides_per_rider DECIMAL(8,2),
    avg_spend           DECIMAL(12,2),
    retention_rate      DECIMAL(5,2)
);

CREATE TABLE ml_feature_store (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type         VARCHAR(30) NOT NULL,
    entity_id           UUID NOT NULL,
    feature_name        VARCHAR(100) NOT NULL,
    feature_value       DECIMAL(20,6),
    feature_vector      JSONB,
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(entity_type, entity_id, feature_name)
);

CREATE TABLE etl_job_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_name            VARCHAR(100) NOT NULL,
    source_table        VARCHAR(100),
    target_table        VARCHAR(100),
    records_processed   BIGINT,
    records_inserted    BIGINT,
    records_updated     BIGINT,
    records_failed      BIGINT,
    status              VARCHAR(20),
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    error_message       TEXT
);
```

---

## 21. MATCHING ENGINE — COMPLETE DEEP DIVE

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    MATCHING ENGINE                           │
│                                                             │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐             │
│  │  DEMAND  │    │  SUPPLY  │    │  SCORING │             │
│  │  QUEUE   │    │  INDEX   │    │  ENGINE  │             │
│  └────┬─────┘    └────┬─────┘    └────┬─────┘             │
│       │               │               │                    │
│       └───────┬───────┘               │                    │
│               │                       │                    │
│       ┌───────▼───────┐              │                    │
│       │   CANDIDATE   │──────────────┘                    │
│       │   FILTERING   │                                    │
│       └───────┬───────┘                                    │
│               │                                            │
│       ┌───────▼───────┐                                    │
│       │   BATCH       │                                    │
│       │   OPTIMIZER   │                                    │
│       └───────┬───────┘                                    │
│               │                                            │
│       ┌───────▼───────┐    ┌──────────┐                   │
│       │   DISPATCH    │───▶│  DRIVER   │                   │
│       │   MANAGER     │    │  NOTIFIER │                   │
│       └───────────────┘    └──────────┘                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Phase 1: Request Collection (Batch Window)

When a ride request arrives, the engine does **NOT** immediately search for a driver. Instead, it enters a collection window.

```
Timeline:
t=0ms      Request A arrives in H3 cell "8928308280fffff"
t=200ms    Request B arrives in same H3 region
t=800ms    Request C arrives in neighboring cell
t=2000ms   BATCH WINDOW CLOSES → All 3 requests enter optimization
```

**Why batch?** Individual greedy matching (first-come-first-served) is suboptimal. Batching allows global optimization. Consider:

```
Without batching (Greedy):
  Request A → gets Driver 1 (closest, 2min ETA)
  Request B → gets Driver 3 (8min ETA, Driver 2 was further from A but closer to B)
  
With batching (Optimal):
  Request A → gets Driver 2 (3min ETA)
  Request B → gets Driver 1 (3min ETA)
  Total wait: 6min vs 10min = 40% improvement
```

The batch window is configurable per city and demand level:

```
Low demand:   batch_window = 3000ms  (wait longer to collect)
Medium:       batch_window = 2000ms  (standard)
High demand:  batch_window = 1000ms  (match faster)
Surge:        batch_window = 500ms   (instant matching needed)
```

### Phase 2: Supply Indexing (Real-time)

Driver positions are stored in a multi-resolution H3 hexagonal grid, not traditional lat/lng radius queries.

```
H3 Resolution Hierarchy:
┌─────────────────────────────┐
│  Resolution 7 (5.16 km²)   │  ← City-level demand forecasting
│  ┌───────────────────────┐  │
│  │ Resolution 8 (0.74km²)│  │  ← Surge zone calculation
│  │ ┌─────────────────┐   │  │
│  │ │ Res 9 (0.105km²)│   │  │  ← Driver matching precision
│  │ └─────────────────┘   │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

**Supply Index Structure (Redis):**

```
Key: supply:{h3_res8}:{vehicle_type}
Value: Sorted Set (score = idle_time_seconds)
Members: driver_id

Example:
supply:8928308280fffff:standard → {
  driver_abc: 120,   // idle 2 min
  driver_def: 45,    // idle 45 sec
  driver_ghi: 300    // idle 5 min
}

Key: driver_meta:{driver_id}
Value: Hash
Fields: lat, lng, heading, speed, h3_r9, rating, 
        acceptance_rate, current_ride, will_free_at,
        destination_bias_h3, shift_ends_at
```

### Phase 3: Candidate Filtering

For each request in the batch, the engine identifies candidate drivers through progressive radius expansion:

```
Step 1: Query drivers in same H3 res9 cell (< 500m)
Step 2: If < min_candidates → expand to neighboring res9 cells
Step 3: If still < min_candidates → expand to res8 parent cell
Step 4: Continue until max_radius_m reached or sufficient candidates found

min_candidates = 3 (need at least 3 for scoring comparison)
max_candidates = 20 (cap for computational efficiency)
```

**Filtering Criteria (in order):**

```
1. is_available = true AND capacity_remaining > 0
2. vehicle_type matches requested types
3. driver NOT in rider's blocklist
4. rider NOT in driver's blocklist
5. driver rating >= min_rating threshold (city-specific)
6. driver acceptance_rate >= min_acceptance (city-specific)
7. driver NOT already dispatched to another request in this batch
8. If driver finishing ride: will_be_free_at + ETA < max_wait
```

### Phase 4: Scoring Engine

Each candidate receives a composite match score. The scoring formula:

```
MATCH_SCORE = 
    W_dist  × normalize(distance_score)     +
    W_eta   × normalize(eta_score)           +
    W_rat   × normalize(rating_score)        +
    W_acc   × normalize(acceptance_score)    +
    W_idle  × normalize(idle_time_score)     +
    W_dest  × normalize(destination_score)   +
    W_pref  × normalize(preference_score)

Where:
    W_dist = 0.30  (distance to pickup)
    W_eta  = 0.25  (ETA to pickup)
    W_rat  = 0.15  (driver rating)
    W_acc  = 0.10  (acceptance rate)
    W_idle = 0.10  (time idle / fairness)
    W_dest = 0.05  (destination alignment)
    W_pref = 0.05  (rider preferences match)
    
    Σ weights = 1.00
```

**Individual Score Calculations:**

```
distance_score:
  Raw: straight-line distance in meters
  Normalized: 1 - (distance / max_pickup_distance)
  Bonus: +0.1 if driver heading toward pickup

eta_score:
  Raw: routing API ETA in seconds (cached in driver_eta_cache)
  Normalized: 1 - (eta / max_eta_seconds)
  Penalty: -0.2 if ETA > 2× average for this area

rating_score:
  Raw: driver's average rating (last 500 rides)
  Normalized: (rating - min_rating) / (5.0 - min_rating)
  Decay: recent ratings weighted 2× vs older ratings

acceptance_score:
  Raw: acceptance rate last 7 days
  Normalized: acceptance_rate / 100
  Penalty: -0.3 if 3+ consecutive rejections today

idle_time_score (FAIRNESS):
  Raw: seconds since last completed ride
  Normalized: min(idle_time / 600, 1.0)  // caps at 10 min
  Purpose: drivers waiting longer get priority

destination_score:
  If driver has set destination preference:
    Raw: distance from ride dropoff to driver's destination
    Normalized: 1 - (distance / max_detour_distance)
  Else: 0.5 (neutral)

preference_score:
  Checks: favorite driver (+0.3), language match (+0.1),
           vehicle features match (+0.1), gender preference (+0.1)
  Normalized: sum / max_possible
```

### Phase 5: Batch Optimization

With scores computed, the engine solves an **assignment problem** to optimally match N requests to M drivers.

**For small batches (≤ 5 requests):**
Uses the Hungarian Algorithm (O(n³)) for globally optimal assignment.

```
Cost Matrix (lower = better, using 1 - match_score):

              Driver1   Driver2   Driver3   Driver4
Request_A     0.15      0.45      0.70      0.30
Request_B     0.55      0.20      0.40      0.65
Request_C     0.30      0.60      0.25      0.50

Hungarian Algorithm Result:
  Request_A → Driver1 (score 0.85)
  Request_B → Driver2 (score 0.80)
  Request_C → Driver3 (score 0.75)
  
Total system score: 2.40 (maximized)
```

**For large batches (> 5 requests):**
Uses Greedy Assignment with Local Search optimization:

```
Step 1: Sort all (request, driver) pairs by match_score descending
Step 2: Greedily assign top-scoring pairs (skip conflicts)
Step 3: Local search: try swapping pairs to improve total score
Step 4: Repeat local search until no improvement found or time limit (50ms)
```

**For high-surge scenarios:**
Skip batch optimization entirely. Use instant greedy matching to minimize rider wait time.

### Phase 6: Dispatch & Response Handling

After optimal assignment, the dispatch manager sends offers to drivers:

```
Dispatch Flow:
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Offer    │────▶│ Driver   │────▶│ Response │
│ Created  │     │ Notified │     │ Window   │
└──────────┘     └──────────┘     └──┬───┬───┘
                                     │   │
                              ┌──────┘   └──────┐
                              ▼                  ▼
                        ┌──────────┐      ┌──────────┐
                        │ ACCEPTED │      │ REJECTED/ │
                        │          │      │ EXPIRED   │
                        └────┬─────┘      └────┬─────┘
                             │                  │
                             ▼                  ▼
                        ┌──────────┐      ┌──────────┐
                        │ RIDE     │      │ NEXT     │
                        │ ASSIGNED │      │ CANDIDATE│
                        └──────────┘      └──────────┘
```

**Response window:** 15 seconds (configurable per city)

**Rejection cascade:**
When a driver rejects or expires, the engine:
1. Takes the next-highest-scored candidate from the original scoring
2. Does NOT re-run the full scoring pipeline
3. After 3 rejections, re-expands the search radius and re-scores
4. After max_attempts (10), marks ride as "no_drivers"

**Driver info shown in dispatch offer:**
```json
{
  "ride_id": "uuid",
  "pickup_address": "123 Main St",
  "dropoff_address": "456 Oak Ave",
  "distance_km": 8.5,
  "estimated_fare": 250.00,
  "surge_multiplier": 1.5,
  "eta_to_pickup_min": 4,
  "rider_rating": 4.8,
  "ride_type": "on_demand",
  "expires_in_seconds": 15
}
```

### Phase 7: Finishing-Trip Matching (Forward Dispatch)

One of the most powerful optimizations: matching drivers who are completing their current ride to new requests.

```
Scenario:
  Driver_X is dropping off Rider_1 in 3 minutes
  Rider_2 requests pickup 500m from Driver_X's dropoff point

Forward Dispatch Logic:
  1. Compute: time_until_free = 3 min
  2. Compute: eta_from_dropoff_to_pickup = 2 min  
  3. Total ETA = 5 min
  4. Compare vs available drivers: nearest available = 7 min ETA
  5. Forward dispatch wins → reserve Driver_X for Rider_2
```

```sql
-- Forward dispatch query
SELECT 
    da.driver_id,
    da.will_be_free_at,
    ST_Distance(da.last_ride_dropoff::geography, 
                ST_SetSRID(ST_Point(:pickup_lng, :pickup_lat), 4326)::geography) 
        AS dropoff_to_pickup_m,
    EXTRACT(EPOCH FROM (da.will_be_free_at - NOW())) 
        + (ST_Distance(...) / 8.33)  -- 30kmh avg speed = 8.33 m/s
        AS total_eta_seconds
FROM driver_availability da
WHERE da.is_available = false
  AND da.current_ride_id IS NOT NULL
  AND da.will_be_free_at IS NOT NULL
  AND da.will_be_free_at < NOW() + INTERVAL '5 minutes'
  AND da.vehicle_type_id = ANY(:requested_vehicle_types)
ORDER BY total_eta_seconds ASC
LIMIT 5;
```

### Phase 8: Shared Ride Matching

For pool/shared rides, the matching engine optimizes for minimal total detour:

```
Existing Pool: Driver has Rider_A (pickup done, heading to dropoff)

New Request: Rider_B wants to join pool

Detour Calculation:
  Original route: A_pickup → A_dropoff (done: heading to A_dropoff)
  
  Option 1: A_dropoff → B_pickup → B_dropoff
    detour_factor = new_total_distance / (remaining_A + direct_B)
    
  Option 2: B_pickup → A_dropoff → B_dropoff  
    detour_factor = new_total_distance / (remaining_A + direct_B)
    
  Option 3: B_pickup → B_dropoff → A_dropoff
    Only if B_dropoff is between current pos and A_dropoff

Constraint: detour_factor < 1.4 (max 40% longer for any rider)
Discount: Both riders get discount proportional to sharing savings
```

### Matching Engine Performance Targets

```
┌────────────────────────────────────┬───────────┐
│ Metric                             │ Target    │
├────────────────────────────────────┼───────────┤
│ Batch window                       │ ≤ 2000ms  │
│ Candidate filtering                │ ≤ 50ms    │
│ Score computation per candidate    │ ≤ 5ms     │
│ Batch optimization (Hungarian)     │ ≤ 100ms   │
│ Total match time (request→dispatch)│ ≤ 3000ms  │
│ P50 rider wait (request→pickup)    │ ≤ 4 min   │
│ P90 rider wait (request→pickup)    │ ≤ 8 min   │
│ First-attempt acceptance rate      │ ≥ 70%     │
│ Overall match rate                 │ ≥ 95%     │
│ Forward dispatch rate              │ ≥ 20%     │
└────────────────────────────────────┴───────────┘
```

### Real-time Data Flow

```
Driver GPS Update (every 4s)
    │
    ▼
Kafka Topic: driver.location.updates
    │
    ├──▶ Redis: Update driver_location_cache
    │         Update supply:{h3}:{type} sorted set
    │
    ├──▶ PostGIS: Append to driver_location_history
    │
    ├──▶ H3 Recalculation:
    │         If h3_cell changed → update supply index
    │
    └──▶ Surge Service:
              Recalculate supply/demand ratio per hex

Ride Request Arrives
    │
    ▼
Kafka Topic: ride.requests
    │
    ├──▶ Demand Tracker: Increment demand count for h3 cell
    │
    ├──▶ Surge Recalculation: Update surge_zones
    │
    └──▶ Dispatch Service:
              1. Enter batch window
              2. Close batch → filter candidates
              3. Score candidates
              4. Optimize assignment
              5. Dispatch to driver
              6. Publish: ride.driver.matched
```

### Surge Pricing Integration

The matching engine feeds into and is affected by surge pricing:

```
Surge Calculation (runs every 30 seconds per H3 res8 cell):

supply = COUNT(drivers WHERE h3_res8 = cell AND is_available = true)
demand = COUNT(ride_requests WHERE pickup_h3_res8 = cell 
               AND created_at > NOW() - INTERVAL '5 minutes'
               AND status IN ('requested','searching'))

ratio = supply / demand

surge_multiplier = CASE
    WHEN ratio >= 2.0 THEN 1.0      -- plenty of supply
    WHEN ratio >= 1.5 THEN 1.2
    WHEN ratio >= 1.0 THEN 1.5
    WHEN ratio >= 0.7 THEN 1.8
    WHEN ratio >= 0.5 THEN 2.0
    WHEN ratio >= 0.3 THEN 2.5
    WHEN ratio < 0.3  THEN 3.0      -- severe shortage
END

-- Apply smoothing (prevent rapid fluctuation)
final_surge = 0.7 × new_surge + 0.3 × previous_surge

-- Apply caps
final_surge = LEAST(final_surge, city_max_surge_cap)

-- Weather/event overrides
IF active_weather_alert THEN final_surge = final_surge × 1.2
IF active_event THEN final_surge = final_surge × event_factor
```

### Driver Rebalancing (Proactive)

The engine doesn't just react to requests—it proactively moves supply:

```
Every 5 minutes:
    1. Compute demand_forecast for next 15 minutes per H3 cell
    2. Compute current supply per H3 cell
    3. Identify deficit zones (predicted_demand > supply × 1.5)
    4. Identify surplus zones (supply > predicted_demand × 2.0)
    5. For surplus drivers with idle_time > 5min:
         → Send heat_map_nudge to move toward deficit zone
         → Offer area_incentive_bonus for completing rides in deficit zone
```

---

## 22. COMPLETE TABLE COUNT

| Domain | Tables | Status |
|--------|--------|--------|
| Identity Service | 17 | ✅ Complete |
| Driver Service | 22 | ✅ Complete |
| Rider Service | 10 | ✅ Complete |
| Ride Service (Core) | 28 | ✅ Complete |
| Dispatch / Matching Engine | 18 | ✅ Complete |
| Location Service | 12 | ✅ Complete |
| Pricing Service | 14 | ✅ Complete |
| Payment + Wallet Service | 20 | ✅ Complete |
| Driver Incentives | 12 | ✅ Complete |
| Notification Service | 8 | ✅ Complete |
| Fraud & Risk | 12 | ✅ Complete |
| Promotions & Referrals | 12 | ✅ Complete |
| Safety / SOS | 8 | ✅ Complete |
| Scheduling | 5 | ✅ Complete |
| Corporate / B2B | 6 | ✅ Complete |
| Support | 8 | ✅ Complete |
| Compliance | 6 | ✅ Complete |
| Saga Orchestration | 4 | ✅ Complete |
| Event System | 4 | ✅ Complete |
| Analytics / Data Warehouse | 22 | ✅ Complete |
| **TOTAL** | **248** | **✅ 100%** |

---

## 23. CACHING STRATEGY (Redis)

```
┌─────────────────────────────────────────────────────────────┐
│                     REDIS CACHE LAYERS                       │
│                                                              │
│  HOT DATA (TTL: 5-30s)                                      │
│  ├── driver_location:{id} → {lat, lng, h3, heading, speed}  │
│  ├── supply:{h3}:{type} → SortedSet of driver_ids           │
│  ├── surge:{h3} → {multiplier, computed_at}                  │
│  ├── ride_status:{id} → current_status                       │
│  └── dispatch_lock:{driver_id} → ride_id (prevent double)    │
│                                                              │
│  WARM DATA (TTL: 5-30min)                                    │
│  ├── driver_eta:{driver}:{h3} → eta_seconds                  │
│  ├── fare_estimate:{origin_h3}:{dest_h3}:{type} → fare      │
│  ├── route:{origin_h3}:{dest_h3} → polyline                  │
│  ├── driver_score:{id} → {rating, acceptance, idle_time}     │
│  └── otp:{ride_id} → otp_code                                │
│                                                              │
│  COLD DATA (TTL: 1-24hr)                                     │
│  ├── user_session:{token} → user_data                        │
│  ├── pricing_config:{city}:{type} → pricing_rules            │
│  ├── promo:{code} → promo_details                             │
│  └── city_config:{id} → service_config                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 24. KAFKA EVENT TOPICS

```
RIDE LIFECYCLE:
  ride.requested          → Dispatch, Surge, Analytics
  ride.driver.matched     → Notification, Ride, Analytics
  ride.driver.arrived     → Notification, Analytics
  ride.started            → Location, Payment (hold), Analytics
  ride.completed          → Payment (capture), Rating, Analytics
  ride.cancelled          → Payment (release), Incentive, Analytics
  
DRIVER EVENTS:
  driver.location.update  → Location Cache, Supply Index, Surge
  driver.status.changed   → Supply Index, Analytics
  driver.shift.started    → Supply, Incentive
  driver.shift.ended      → Supply, Payout
  
PAYMENT EVENTS:
  payment.authorized      → Ride, Wallet
  payment.captured        → Driver Payout, Analytics
  payment.failed          → Ride, Notification, Retry
  payment.refunded        → Wallet, Analytics
  
SYSTEM EVENTS:
  surge.updated           → Pricing, Driver Nudge, Analytics
  fraud.detected          → Safety, Notification, Block
  demand.forecast.updated → Surge, Rebalancing
  
Each event includes:
  event_id (UUID)
  event_type
  timestamp
  schema_version
  correlation_id (for distributed tracing)
  payload (JSON)
```

---

## 25. INFRASTRUCTURE DIAGRAM

```
┌─────────────────────────────────────────────────────────────────┐
│                        AWS ARCHITECTURE                          │
│                                                                  │
│  ┌─────────┐   ┌──────────┐   ┌──────────┐                     │
│  │CloudFront│──▶│   ALB    │──▶│   EKS    │                     │
│  │  (CDN)  │   │(Gateway) │   │(Services)│                     │
│  └─────────┘   └──────────┘   └────┬─────┘                     │
│                                     │                            │
│       ┌─────────────────────────────┼────────────────────┐       │
│       │                             │                    │       │
│  ┌────▼────┐   ┌────────┐   ┌─────▼─────┐   ┌────────┐ │       │
│  │ Aurora  │   │ElastiC.│   │   MSK     │   │  S3    │ │       │
│  │PostgreSQL│  │ Redis  │   │  (Kafka)  │   │(Media) │ │       │
│  │ (RDS)  │   │ Cluster│   │           │   │        │ │       │
│  └────────┘   └────────┘   └───────────┘   └────────┘ │       │
│       │                                                  │       │
│  ┌────▼────┐   ┌─────────┐   ┌──────────┐              │       │
│  │Redshift │   │OpenSearch│   │ SageMaker│              │       │
│  │  (DW)  │   │ (Logs)  │   │   (ML)   │              │       │
│  └────────┘   └─────────┘   └──────────┘              │       │
│                                                         │       │
│  ┌─────────┐   ┌─────────┐   ┌──────────┐              │       │
│  │CloudWatch│  │  SNS    │   │  SQS     │              │       │
│  │(Monitor)│   │(Notify) │   │ (Queue)  │              │       │
│  └─────────┘   └─────────┘   └──────────┘              │       │
└─────────────────────────────────────────────────────────────────┘
```
