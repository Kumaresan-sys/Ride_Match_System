#!/usr/bin/env node

'use strict';

require('../config/env-loader');

const devDriverSeedService = require('../services/dev-driver-seed-service');

async function main() {
  const result = await devDriverSeedService.seedDrivers({ reason: 'manual_script' });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
