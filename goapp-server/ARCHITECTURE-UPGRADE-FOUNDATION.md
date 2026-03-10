# GoApp Enterprise Architecture Upgrade Foundation

This repository now contains the production-grade foundation for the scale-up plan (stateless API, Redis authority, Kafka outbox, multi-domain DB routing), while preserving existing `/api/v1/*` behavior.

## Implemented Core Upgrades

## 1) Runtime stability (R0)
- Kafka bootstrap hardening:
  - `services/kafka-client.js` now uses lazy connection and no longer exits the process on startup failure.
  - Kafka can be disabled via `KAFKA_BACKEND=disabled` for local dev fallback.
- Worker startup is feature-flag controlled:
  - `KAFKA_MATCHING_WORKER`
  - `KAFKA_NOTIFICATION_WORKER`
  - `KAFKA_OUTBOX_RELAY_WORKER`
- `kafkajs` dependency added in `package.json`.

## 2) Redis distributed state (R1)
- `infra/redis/state-store.js` now models shared state keys:
  - `driver:state:{driverId}`
  - `driver:location:{driverId}`
  - `ride:active:{rideId}`
  - `ride_rate:{userId}`
  - `cancel_count:{actor}:{userId}`
  - `ride:lock:{rideId}`
  - `ride:offers:{rideId}`
  - `idem:{scope}:{key}`
- Ride assignment lock is now compare-and-delete safe (tokenized lock value).
- Redis GEO usage is now `GEOSEARCH`-based and avoids recursion bug in the Redis adapter.

## 3) Matching engine redesign (R2)
- `services/matching-engine.js` now uses:
  - candidate discovery via Redis geo + eligibility filtering
  - deterministic scoring:
    - `0.40*eta_norm + 0.20*acceptance_rate + 0.15*completion_rate + 0.10*(1-cancel_rate) + 0.10*idle_time_norm + 0.05*fairness_jitter`
  - batched offer strategy (5 drivers / ~7 seconds / max ~30s)
  - distributed lock winner selection for single assignment
- Driver acceptance endpoints:
  - existing: `POST /api/v1/rides/:rideId/accept`
  - new: `POST /api/v2/rides/:rideId/offers/:offerId/accept`

## 4) Multi-DB connection routing foundation (R3)
- `infra/db/connection-manager.js` supports:
  - domain-aware writer/reader pools (`identity`, `drivers`, `rides`, `payments`, `analytics`)
  - query routing with strong-read override
  - `withTransaction(domain, fn, { isolationLevel })`
- convenience facade added at `db/connection-manager.js`.

## 5) Transactional outbox + idempotent ledger safety (R3/R4)
- New migration:
  - `enterprise-setup/sql/052_outbox_and_ledger_safety.sql`
- Added tables:
  - `outbox_events`
  - `ledger_idempotency`
- Added outbox repository + relay worker:
  - `infra/kafka/outbox-repository.js`
  - `workers/outbox-relay-worker.js`
- Ride creation now writes ride + outbox event in one DB transaction (`pg-ride-repository`).
- Wallet cash mutation path now supports idempotency and outbox event insertion in one DB transaction (`pg-wallet-repository`).

## 6) Wallet and payment correctness
- Wallet debit now rejects insufficient balance atomically (no silent clamp-to-zero).
- Idempotency key support propagated via routes/service paths for topup/pay/refund.
- Razorpay pending order state moved from in-memory map to Redis keys.

## 7) In-memory shared-state removals on critical paths
- Auth OTP/refresh IP rate limits moved from process memory to Redis counters.
- Ride session recovery state/log moved from in-memory maps to Redis.
- Razorpay pending order tracking moved from in-memory map to Redis.

## 8) Physical domain extraction + projectionized read paths (R4+)
- Added domain projection migration:
  - `enterprise-setup/sql/053_domain_projection_tables.sql`
- Added projection sync pipeline:
  - `services/domain-projection-service.js`
  - `workers/domain-projection-worker.js`
  - `scripts/backfill/backfill-domain-projections.js`
- Removed payments/ride request-path joins on `users/riders/drivers` and switched to projection tables:
  - `payment_rider_projection`
  - `payment_driver_projection`
  - `ride_rider_projection`
  - `ride_driver_projection`
  - `driver_user_projection`
  - `rider_user_projection`
- Added physical split tooling:
  - `migrations/domain-split/domain-table-groups.js`
  - `migrations/domain-split/plan-domain-extraction.js`
  - `migrations/domain-split/run-domain-extraction.js`
  - `migrations/domain-split/verify-domain-extraction.js`
- Added projection consistency checks:
  - `scripts/consistency-checks/check-domain-projections.js`

## Feature flags and rollout
- `MATCHING_V2`
- `REDIS_STATE_V2`
- `KAFKA_OUTBOX`
- `KAFKA_EVENT_BRIDGE`
- `KAFKA_MATCHING_WORKER`
- `KAFKA_NOTIFICATION_WORKER`
- `KAFKA_OUTBOX_RELAY_WORKER`

Rollout expectation: enable per environment/city canary, monitor outbox lag + match latency, then ramp.
