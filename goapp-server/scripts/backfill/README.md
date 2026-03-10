# Backfill

## Domain Projections

Backfill projection tables used to remove cross-domain joins from request paths:

```bash
node scripts/backfill/backfill-domain-projections.js
```

Optional tuning:

- `PROJECTION_BACKFILL_BATCH` (default `500`, bounds `50..2000`)

Projection worker can then keep tables current from Kafka:

- enable `KAFKA_DOMAIN_PROJECTION_WORKER=true`
