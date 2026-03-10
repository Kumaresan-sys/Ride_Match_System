# GoApp Enterprise Setup

Complete enterprise infrastructure aligned to `GoApp-Enterprise-Architecture-248-Tables-OTP-Login.md`.

## Architecture Overview

```
248 tables across 20 service domains:

 Identity (17) → Driver (22) → Rider (10) → Ride Core (28)
 Dispatch/Matching (18) → Location (12) → Pricing (14)
 Payment+Wallet (20) → Incentives (12) → Notifications (8)
 Fraud/Risk (12) → Promotions (12) → Safety/SOS (8)
 Scheduling (5) → Corporate (6) → Support (8)
 Compliance (6) → Saga (4) → Events (4) → Analytics (22)
```

## Quick Start

### 1) Start infrastructure

```bash
cd goapp-server
docker compose up -d --build
```

This starts:
- **PostgreSQL 17 + PostGIS** on `localhost:5432` (database: `goapp_enterprise`)
- **Redis 7** on `localhost:6379`
- **Kafka (KRaft, no Zookeeper)** on `localhost:9092`
- **GoApp API** on `localhost:3000` / `localhost:3001`

Or use the one-command bootstrap (recommended):

```bash
cd goapp-server
./scripts/setup-docker.sh
```

### 2) Verify infrastructure

```bash
cd goapp-server
docker compose ps
```

All containers should show healthy status.

### 3) Schema bootstrap (automatic)

On first startup, PostgreSQL auto-loads all SQL migration files from `./sql/` in alphabetical order.
The base enterprise schema remains 20 core migrations / 248 tables, plus extension migrations (`021+`) for feature expansions.

If you need to re-run migrations (reset database):

```bash
cd goapp-server
docker compose down -v
docker compose up -d --build
```

### 4) Manual migration (existing database)

```bash
cd goapp-server/enterprise-setup/sql
./run-migrations.sh
```

Environment variables:
- `DB_HOST` (default: localhost)
- `DB_PORT` (default: 5432)
- `DB_NAME` (default: goapp_enterprise)
- `DB_USER` (default: goapp)
- `DB_PASS` (default: goapp)

### 5) Initialize Kafka topics

```bash
cd goapp-server
./enterprise-setup/scripts/init-topics.sh
```

### 6) Run the application

```bash
cd goapp-server
npm start
```

### 7) Validate endpoints

```bash
curl http://localhost:3000/api/v1/health
curl http://localhost:3000/api/v1/microservices
curl http://localhost:3000/api/v1/aws/readiness
curl -X POST http://localhost:3000/api/v1/auth/otp/request \
  -H 'Content-Type: application/json' \
  -d '{"phoneNumber":"+919876543210","otpType":"login"}'
```

## SQL Migration Files

| File | Domain | Tables |
|------|--------|--------|
| `001_identity_and_otp.sql` | Identity Service | 17 |
| `002_driver_service.sql` | Driver + Vehicle | 22 |
| `003_rider_service.sql` | Rider | 10 |
| `004_ride_service.sql` | Ride Core | 28 |
| `005_dispatch_matching.sql` | Dispatch/Matching Engine | 18 |
| `006_location_service.sql` | Location (PostGIS) | 12 |
| `007_pricing_service.sql` | Pricing + Surge | 14 |
| `008_payment_wallet.sql` | Payment + Wallet | 20 |
| `009_driver_incentives.sql` | Driver Incentives | 12 |
| `010_notification_service.sql` | Notifications | 8 |
| `011_fraud_risk.sql` | Fraud & Risk | 12 |
| `012_promotions_referrals.sql` | Promotions & Referrals | 12 |
| `013_safety_sos.sql` | Safety / SOS | 8 |
| `014_scheduling.sql` | Scheduling | 5 |
| `015_corporate_b2b.sql` | Corporate B2B | 6 |
| `016_support.sql` | Support | 8 |
| `017_compliance.sql` | Compliance | 6 |
| `018_saga_orchestration.sql` | Saga Orchestration | 4 |
| `019_event_system.sql` | Event System | 4 |
| `020_analytics_warehouse.sql` | Analytics/DW | 22 |
| **Total (core)** | **20 domains** | **248** |

### Extension Migration Files (present in repository)

| File | Purpose |
|------|---------|
| `021_coins_rewards.sql` | Coins/reward ledger extensions |
| `022_sos_logs.sql` | SOS event and audit expansion |
| `023_driver_wallet.sql` | Driver wallet accounting extensions |
| `024_demand_aggregation.sql` | Demand aggregation read models |
| `025_incentive_tasks.sql` | Incentive campaign/task expansion |
| `026_chat_tickets.sql` | Support chat/ticket detail tables |
| `027_rider_wallet_cash.sql` | Rider cash wallet extensions |
| `028_demand_analytics.sql` | Demand analytics rollups |
| `029_ride_session_recovery.sql` | Ride session recovery persistence |

## Current Implementation Status

### Implemented (In-Memory, Production-Grade Logic)
- OTP-based identity service
- Multi-stage ride matching engine (3 stages, composite scoring)
- Real-time driver location tracking (Redis GEO)
- Surge pricing with EMA smoothing
- Fare calculation with 4 vehicle type rate cards
- Ride lifecycle state machine
- GPS spoofing detection
- WebSocket real-time updates
- Event bus (Kafka-compatible)
- Distributed locks (SETNX pattern)

### Next Phase (Database Migration)
- Replace in-memory Maps with PostgreSQL repositories
- Replace Redis mock with real ElastiCache Redis
- Replace event bus with MSK Kafka producers/consumers
- Split into separate deployable services by `SERVICE_NAME`
- Implement Payment, Fraud, Safety, Notification services
