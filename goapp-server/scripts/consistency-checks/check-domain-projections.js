#!/usr/bin/env node

'use strict';

require('../../config/env-loader');

const domainDb = require('../../infra/db/domain-db');

async function tableHasColumn(domain, tableName, columnName) {
  const { rows } = await domainDb.query(
    domain,
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName],
    { role: 'reader' }
  );
  return rows.length > 0;
}

async function count(domain, sql, params = []) {
  const { rows } = await domainDb.query(domain, sql, params, { role: 'reader' });
  return Number(rows[0]?.cnt || 0);
}

async function main() {
  const checks = [];

  checks.push({
    name: 'rides_missing_rider_projection',
    domain: 'rides',
    count: await count(
      'rides',
      `SELECT COUNT(*)::int AS cnt
       FROM rides r
       LEFT JOIN ride_rider_projection rp ON rp.rider_id = r.rider_id
       WHERE r.rider_id IS NOT NULL
         AND rp.rider_id IS NULL`
    ),
  });

  checks.push({
    name: 'rides_missing_driver_projection',
    domain: 'rides',
    count: await count(
      'rides',
      `SELECT COUNT(*)::int AS cnt
       FROM rides r
       LEFT JOIN ride_driver_projection dp ON dp.driver_id = r.driver_id
       WHERE r.driver_id IS NOT NULL
         AND dp.driver_id IS NULL`
    ),
  });

  if (await tableHasColumn('payments', 'wallet_transactions', 'rider_id')) {
    checks.push({
      name: 'payments_wallet_tx_missing_rider_projection',
      domain: 'payments',
      count: await count(
        'payments',
        `SELECT COUNT(*)::int AS cnt
         FROM wallet_transactions wt
         LEFT JOIN payment_rider_projection rp ON rp.rider_id = wt.rider_id
         WHERE wt.rider_id IS NOT NULL
           AND rp.rider_id IS NULL`
      ),
    });
  }

  if (await tableHasColumn('payments', 'driver_wallets', 'driver_id')) {
    checks.push({
      name: 'payments_driver_wallet_missing_driver_projection',
      domain: 'payments',
      count: await count(
        'payments',
        `SELECT COUNT(*)::int AS cnt
         FROM driver_wallets dw
         LEFT JOIN payment_driver_projection dp ON dp.driver_id = dw.driver_id
         WHERE dw.driver_id IS NOT NULL
           AND dp.driver_id IS NULL`
      ),
    });
  }

  if (await tableHasColumn('drivers', 'driver_locations', 'driver_id')) {
    checks.push({
      name: 'drivers_location_missing_user_projection',
      domain: 'drivers',
      count: await count(
        'drivers',
        `SELECT COUNT(*)::int AS cnt
         FROM driver_locations dl
         LEFT JOIN driver_user_projection dup ON dup.driver_id = dl.driver_id
         WHERE dl.driver_id IS NOT NULL
           AND dup.driver_id IS NULL`
      ),
    });
  }

  checks.push({
    name: 'payments_stale_rider_projection_over_24h',
    domain: 'payments',
    count: await count(
      'payments',
      `SELECT COUNT(*)::int AS cnt
       FROM payment_rider_projection
       WHERE updated_at < NOW() - INTERVAL '24 hours'`
    ),
  });

  checks.push({
    name: 'rides_stale_driver_projection_over_24h',
    domain: 'rides',
    count: await count(
      'rides',
      `SELECT COUNT(*)::int AS cnt
       FROM ride_driver_projection
       WHERE updated_at < NOW() - INTERVAL '24 hours'`
    ),
  });

  const failing = checks.filter((item) => item.count > 0);
  const result = {
    ok: failing.length === 0,
    totalChecks: checks.length,
    failingChecks: failing.length,
    checks,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  const message = err?.message || err?.code || String(err);
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    ok: false,
    error: message,
    code: 'PROJECTION_CONSISTENCY_FAILED',
    errorDetails: {
      sourceCode: err?.code || null,
      errno: err?.errno || null,
      syscall: err?.syscall || null,
      address: err?.address || null,
      port: err?.port || null,
    },
  }, null, 2));
  process.exit(1);
});
