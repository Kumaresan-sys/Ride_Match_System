# Domain Split Runbook

This folder contains the physical database extraction tooling for the domain split:

- `identity_db`
- `drivers_db`
- `rides_db`
- `payments_db`
- `analytics_db`

## What This Pass Implements

1. Deterministic table ownership rules in [`domain-table-groups.js`](./domain-table-groups.js).
2. Extraction planning from live source schema in [`plan-domain-extraction.js`](./plan-domain-extraction.js).
3. Physical table copy runner in [`run-domain-extraction.js`](./run-domain-extraction.js).
4. Post-copy row-count verifier in [`verify-domain-extraction.js`](./verify-domain-extraction.js).

Request-path cross-domain joins are removed in repositories and replaced with projection tables (`*_projection`) fed by Kafka-backed projection workers.

## Environment Variables

- Source:
  - `SOURCE_DB_URL` (recommended)
  - or `POSTGRES_HOST/PORT/USER/PASSWORD/DB`
- Targets:
  - `IDENTITY_DB_URL`
  - `DRIVERS_DB_URL`
  - `RIDES_DB_URL`
  - `PAYMENTS_DB_URL`
  - `ANALYTICS_DB_URL`

## Workflow

1. Generate ownership plan:

```bash
node migrations/domain-split/plan-domain-extraction.js
```

Offline mode (no DB connection) is also supported:

```bash
node migrations/domain-split/plan-domain-extraction.js \
  --tables-file /path/to/table-list.txt \
  --allow-unknown true
```

2. Review generated `domain-extraction-plan.json`.

3. Dry-run extraction commands:

```bash
node migrations/domain-split/run-domain-extraction.js --plan migrations/domain-split/domain-extraction-plan.json
```

4. Execute extraction:

```bash
node migrations/domain-split/run-domain-extraction.js \
  --plan migrations/domain-split/domain-extraction-plan.json \
  --execute true
```

If `pg_dump`/`psql` are not installed on host, run extraction via Docker Postgres container:

```bash
DOCKER_POSTGRES_CONTAINER=goapp-postgres \
node migrations/domain-split/run-domain-extraction.js \
  --plan migrations/domain-split/domain-extraction-plan.json \
  --execute true
```

5. Run post-extract bootstrap (creates projection tables, outbox/idempotency safety tables, split-safe payment preference tables, and the ride cancellation reason catalog in `rides_db`):

```bash
npm run domain:bootstrap
```

Optional dry-run:

```bash
npm run domain:bootstrap:dry-run
```

6. Verify row counts:

```bash
node migrations/domain-split/verify-domain-extraction.js --plan migrations/domain-split/domain-extraction-plan.json
```

## Ownership Rules

- `identity_db`: `users`, `riders`, `otp_*`, `auth_*`, `session_*`, `refresh_*`, `user_*` (except explicit overrides).
- `drivers_db`: `drivers`, `driver_*`, `vehicle_*`, `fleet_*` (except wallet overrides).
- `rides_db`: `rides`, `ride_*`, `dispatch_*`, `matching_*`, `zone_*`, `geo_*`, `surge_*`, `schedule_*`, support/SOS/ticketing tables.
- `payments_db`: `wallet_*`, `wallets`, `payment_*`, `payments`, `driver_wallet*`, `rider_wallet*`, `coin_*`, payouts/refunds/commission artifacts.
- `analytics_db`: `analytics_*`, `fact_*`, `dim_*`, `agg_*`, `demand_*`, `fraud_*`, `ml_*`, consumer offset/dead-letter artifacts.

If a table is ambiguous, it is pinned via explicit override in `EXACT_TABLE_OWNERS`.
