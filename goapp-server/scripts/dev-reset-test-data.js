#!/usr/bin/env node

'use strict';

require('../config/env-loader');

const devResetService = require('../services/dev-reset-service');

function parseBool(value, fallback) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseArgs(argv = []) {
  const parsed = {
    dryRun: false,
    reseedDrivers: true,
    clearTrace: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    const next = argv[index + 1];
    if (token === '--dry-run') {
      parsed.dryRun = parseBool(next, true);
      if (next && !String(next).startsWith('--')) index += 1;
      continue;
    }
    if (token === '--reseed-drivers') {
      parsed.reseedDrivers = parseBool(next, true);
      if (next && !String(next).startsWith('--')) index += 1;
      continue;
    }
    if (token === '--clear-trace') {
      parsed.clearTrace = parseBool(next, true);
      if (next && !String(next).startsWith('--')) index += 1;
      continue;
    }
  }

  return parsed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await devResetService.reset(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
