# Consistency Checks

## Projection Consistency

Validate that request-path projection tables are complete and fresh after backfill/worker rollout:

```bash
node scripts/consistency-checks/check-domain-projections.js
```

The script exits non-zero if any mismatch is detected:

- rides missing rider/driver projections
- payments wallet rows without payment projections
- driver locations without driver user projection
- stale projections (`updated_at` older than 24h)
