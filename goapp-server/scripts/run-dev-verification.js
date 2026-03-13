#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PORT = 3100;
const port = Number(process.env.GOAPP_DEV_PORT || DEFAULT_PORT);
const wsPort = Number(process.env.GOAPP_DEV_WS_PORT || (port + 1));
const baseUrl = process.env.GOAPP_DEV_BASE_URL || `http://127.0.0.1:${port}`;
const shouldStartServer = !process.env.GOAPP_DEV_BASE_URL;

async function waitForHealth(url, timeoutMs = 20000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/v1/health`);
      if (response.ok) return true;
    } catch (_) {
      // Retry until timeout.
    }
    await delay(intervalMs);
  }
  return false;
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });
    resolve.child = child;
  });
}

async function main() {
  let server = null;

  if (shouldStartServer) {
    server = spawn(
      process.execPath,
      ['server.js', '--api-only'],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'development',
          PORT: String(port),
          WS_PORT: String(wsPort),
        },
        stdio: 'inherit',
      },
    );

    const healthy = await waitForHealth(baseUrl);
    if (!healthy) {
      server.kill('SIGTERM');
      throw new Error(`Development API did not become healthy at ${baseUrl}`);
    }
  }

  const seedResult = spawnSync(
    process.execPath,
    ['scripts/dev-seed-drivers.js'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'development' },
      stdio: 'inherit',
    },
  );
  if (seedResult.status !== 0) {
    if (server) server.kill('SIGTERM');
    process.exit(seedResult.status || 1);
  }

  const testArgs = [
    '--require',
    './config/env-loader.js',
    '--test',
    '--test-concurrency=1',
    '--test-force-exit',
    'tests/integration/driver-avatar.integration.test.js',
    'tests/integration/ride-request-dev.integration.test.js',
    'tests/integration/safety-preferences.integration.test.js',
    'tests/integration/zone-vehicle-types.integration.test.js',
    'tests/integration/admin-zone-vehicle-types.integration.test.js',
    'tests/integration/admin-zone-vehicle-types-bulk.integration.test.js',
    'tests/integration/admin-zone-vehicle-type-pricing.integration.test.js',
    'tests/integration/admin-zone-vehicle-type-pricing-bulk.integration.test.js',
  ];

  const testRun = await runProcess(
    process.execPath,
    testArgs,
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        GOAPP_DEV_BASE_URL: baseUrl,
      },
      stdio: 'inherit',
    },
  );

  if (server) {
    server.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      if (server.exitCode == null) {
        server.kill('SIGKILL');
      }
    }, 5000);
    if (typeof killTimer.unref === 'function') {
      killTimer.unref();
    }
  }

  process.exit(testRun.code || 0);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
