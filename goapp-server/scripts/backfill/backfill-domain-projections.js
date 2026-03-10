#!/usr/bin/env node

'use strict';

require('../../config/env-loader');

const domainProjectionService = require('../../services/domain-projection-service');
const domainDb = require('../../infra/db/domain-db');

async function main() {
  try {
    const batchSize = Number(process.env.PROJECTION_BACKFILL_BATCH || 500);
    const startedAt = Date.now();

    const result = await domainProjectionService.backfill({ batchSize });

    const elapsedMs = Date.now() - startedAt;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      ok: true,
      batchSize,
      elapsedMs,
      ...result,
    }, null, 2));
  } finally {
    await domainDb.manager.close().catch(() => {});
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});
