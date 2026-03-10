#!/usr/bin/env node

'use strict';

require('../../config/env-loader');

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DOMAINS = ['identity', 'drivers', 'rides', 'payments', 'analytics'];
const SQL_ROOT = path.resolve(__dirname, '../../enterprise-setup/sql');

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, 'true');
    }
  }
  return args;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function parseDomainList(raw) {
  if (!raw) return DOMAINS;
  const values = String(raw)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const invalid = values.filter((item) => !DOMAINS.includes(item));
  if (invalid.length) {
    throw new Error(`Invalid domain(s): ${invalid.join(', ')}`);
  }
  return values.length ? values : DOMAINS;
}

function sslConfigFromEnv() {
  const enabled = parseBool(process.env.POSTGRES_SSL, false);
  if (!enabled) return false;
  const rejectUnauthorized = parseBool(
    process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED,
    true
  );
  return { rejectUnauthorized };
}

function buildDomainConnectionConfig(domain) {
  const prefix = domain.toUpperCase();
  const directUrl = process.env[`${prefix}_DB_URL`];
  const ssl = sslConfigFromEnv();

  if (directUrl) {
    return {
      connectionString: directUrl,
      ...(ssl ? { ssl } : {}),
    };
  }

  const host =
    process.env[`${prefix}_DB_WRITER_HOST`] ||
    process.env.POSTGRES_HOST ||
    'localhost';
  const port = Number.parseInt(
    process.env[`${prefix}_DB_WRITER_PORT`] || process.env.POSTGRES_PORT || '5432',
    10
  );
  const user =
    process.env[`${prefix}_DB_WRITER_USER`] ||
    process.env.POSTGRES_USER ||
    'goapp';
  const password =
    process.env[`${prefix}_DB_WRITER_PASSWORD`] ||
    process.env.POSTGRES_PASSWORD ||
    'goapp';
  const database =
    process.env[`${prefix}_DB_NAME`] ||
    process.env.POSTGRES_DB ||
    'goapp_enterprise';

  return {
    host,
    port,
    user,
    password,
    database,
    ...(ssl ? { ssl } : {}),
  };
}

function summarizeConnection(config) {
  if (config.connectionString) {
    try {
      const url = new URL(config.connectionString);
      return `${url.hostname}:${url.port || '5432'}/${url.pathname.replace(/^\//, '')}`;
    } catch (_) {
      return '<connection-string>';
    }
  }
  return `${config.host}:${config.port}/${config.database}`;
}

function commonSteps() {
  return [
    {
      name: 'extension_pgcrypto',
      sql: 'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
    },
    {
      name: 'table_outbox_events',
      sql: `
        CREATE TABLE IF NOT EXISTS outbox_events (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            domain           VARCHAR(32) NOT NULL,
            topic            VARCHAR(120) NOT NULL,
            partition_key    VARCHAR(255),
            event_type       VARCHAR(120) NOT NULL,
            aggregate_type   VARCHAR(80) NOT NULL,
            aggregate_id     VARCHAR(120) NOT NULL,
            event_version    INTEGER NOT NULL DEFAULT 1,
            payload          JSONB NOT NULL,
            region           VARCHAR(50) NOT NULL DEFAULT 'ap-south-1',
            idempotency_key  VARCHAR(255),
            status           VARCHAR(20) NOT NULL DEFAULT 'pending',
            attempts         INTEGER NOT NULL DEFAULT 0,
            available_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            published_at     TIMESTAMPTZ,
            last_error       TEXT,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT chk_outbox_status CHECK (status IN ('pending', 'processing', 'sent', 'failed'))
        );
      `,
    },
    {
      name: 'index_outbox_status_available',
      sql: `
        CREATE INDEX IF NOT EXISTS idx_outbox_events_status_available
          ON outbox_events (status, available_at, created_at);
      `,
    },
    {
      name: 'index_outbox_topic_created',
      sql: `
        CREATE INDEX IF NOT EXISTS idx_outbox_events_topic_created
          ON outbox_events (topic, created_at DESC);
      `,
    },
    {
      name: 'index_outbox_aggregate',
      sql: `
        CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate
          ON outbox_events (aggregate_type, aggregate_id, created_at DESC);
      `,
    },
    {
      name: 'index_outbox_domain_idempotency',
      sql: `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_events_domain_idempotency
          ON outbox_events (domain, idempotency_key)
          WHERE idempotency_key IS NOT NULL;
      `,
    },
    {
      name: 'table_ledger_idempotency',
      sql: `
        CREATE TABLE IF NOT EXISTS ledger_idempotency (
            id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            domain            VARCHAR(32) NOT NULL DEFAULT 'payments',
            actor_id          UUID,
            idempotency_key   VARCHAR(255) NOT NULL,
            request_hash      VARCHAR(128),
            status            VARCHAR(20) NOT NULL DEFAULT 'pending',
            response_payload  JSONB,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT chk_ledger_idempotency_status CHECK (status IN ('pending', 'completed', 'failed'))
        );
      `,
    },
    {
      name: 'index_ledger_domain_key',
      sql: `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_idempotency_domain_key
          ON ledger_idempotency (domain, idempotency_key);
      `,
    },
    {
      name: 'index_ledger_status_created',
      sql: `
        CREATE INDEX IF NOT EXISTS idx_ledger_idempotency_status_created
          ON ledger_idempotency (status, created_at DESC);
      `,
    },
  ];
}

function stepsByDomain(domain) {
  if (domain === 'rides') {
    return [
      { name: 'extension_postgis', sql: 'CREATE EXTENSION IF NOT EXISTS postgis;' },
      {
        name: 'table_ride_rider_projection',
        sql: `
          CREATE TABLE IF NOT EXISTS ride_rider_projection (
              rider_id         UUID PRIMARY KEY,
              user_id          UUID UNIQUE NOT NULL,
              display_name     VARCHAR(255),
              phone_number     VARCHAR(32),
              status           VARCHAR(32) DEFAULT 'active',
              total_rides      INTEGER DEFAULT 0,
              lifetime_spend   NUMERIC(12,2) DEFAULT 0,
              rider_tier       VARCHAR(64),
              updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `,
      },
      {
        name: 'index_ride_rider_projection_user_id',
        sql: `
          CREATE INDEX IF NOT EXISTS idx_ride_rider_projection_user_id
            ON ride_rider_projection (user_id);
        `,
      },
      {
        name: 'table_ride_driver_projection',
        sql: `
          CREATE TABLE IF NOT EXISTS ride_driver_projection (
              driver_id           UUID PRIMARY KEY,
              user_id             UUID UNIQUE NOT NULL,
              display_name        VARCHAR(255),
              phone_number        VARCHAR(32),
              status              VARCHAR(32) DEFAULT 'active',
              onboarding_status   VARCHAR(64),
              is_eligible         BOOLEAN,
              home_city           VARCHAR(120),
              vehicle_number      VARCHAR(64),
              vehicle_type        VARCHAR(80),
              average_rating      NUMERIC(4,2),
              acceptance_rate     NUMERIC(6,4),
              completion_rate     NUMERIC(6,4),
              updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `,
      },
      {
        name: 'index_ride_driver_projection_user_id',
        sql: `
          CREATE INDEX IF NOT EXISTS idx_ride_driver_projection_user_id
            ON ride_driver_projection (user_id);
        `,
      },
    ];
  }

  if (domain === 'payments') {
    return [
      {
        name: 'table_payment_rider_projection',
        sql: `
          CREATE TABLE IF NOT EXISTS payment_rider_projection (
              rider_id         UUID PRIMARY KEY,
              user_id          UUID UNIQUE NOT NULL,
              display_name     VARCHAR(255),
              phone_number     VARCHAR(32),
              status           VARCHAR(32) DEFAULT 'active',
              total_rides      INTEGER DEFAULT 0,
              lifetime_spend   NUMERIC(12,2) DEFAULT 0,
              rider_tier       VARCHAR(64),
              updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `,
      },
      {
        name: 'index_payment_rider_projection_user_id',
        sql: `
          CREATE INDEX IF NOT EXISTS idx_payment_rider_projection_user_id
            ON payment_rider_projection (user_id);
        `,
      },
      {
        name: 'table_payment_driver_projection',
        sql: `
          CREATE TABLE IF NOT EXISTS payment_driver_projection (
              driver_id           UUID PRIMARY KEY,
              user_id             UUID UNIQUE NOT NULL,
              display_name        VARCHAR(255),
              phone_number        VARCHAR(32),
              status              VARCHAR(32) DEFAULT 'active',
              onboarding_status   VARCHAR(64),
              is_eligible         BOOLEAN,
              home_city           VARCHAR(120),
              vehicle_number      VARCHAR(64),
              vehicle_type        VARCHAR(80),
              average_rating      NUMERIC(4,2),
              acceptance_rate     NUMERIC(6,4),
              completion_rate     NUMERIC(6,4),
              updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `,
      },
      {
        name: 'index_payment_driver_projection_user_id',
        sql: `
          CREATE INDEX IF NOT EXISTS idx_payment_driver_projection_user_id
            ON payment_driver_projection (user_id);
        `,
      },
      {
        name: 'table_user_coin_preferences',
        sql: `
          CREATE TABLE IF NOT EXISTS user_coin_preferences (
            user_id            UUID PRIMARY KEY,
            auto_use_enabled   BOOLEAN NOT NULL DEFAULT false,
            created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `,
      },
      {
        name: 'index_user_coin_preferences_auto_use',
        sql: `
          CREATE INDEX IF NOT EXISTS idx_user_coin_preferences_auto_use
            ON user_coin_preferences (auto_use_enabled);
        `,
      },
      {
        name: 'seed_coin_config_defaults',
        sql: `
          DO $$
          BEGIN
            IF to_regclass('public.coin_config') IS NOT NULL THEN
              INSERT INTO coin_config (config_key, config_value, description)
              VALUES
                ('coin_inr_value', '0.10', '1 coin = INR value for redemption'),
                ('coins_per_inr_earn', '10', 'earn 1 coin per N INR fare'),
                ('min_redeem_coins', '10', 'minimum coins needed to redeem'),
                ('max_redeem_pct', '0.20', 'max share of fare redeemable by coins')
              ON CONFLICT (config_key) DO NOTHING;
            END IF;
          END $$;
        `,
      },
    ];
  }

  if (domain === 'drivers') {
    return [
      { name: 'extension_postgis', sql: 'CREATE EXTENSION IF NOT EXISTS postgis;' },
      {
        name: 'table_driver_user_projection',
        sql: `
          CREATE TABLE IF NOT EXISTS driver_user_projection (
              driver_id           UUID PRIMARY KEY,
              user_id             UUID UNIQUE NOT NULL,
              display_name        VARCHAR(255),
              phone_number        VARCHAR(32),
              status              VARCHAR(32) DEFAULT 'active',
              onboarding_status   VARCHAR(64),
              is_eligible         BOOLEAN,
              home_city           VARCHAR(120),
              vehicle_number      VARCHAR(64),
              vehicle_type        VARCHAR(80),
              average_rating      NUMERIC(4,2),
              acceptance_rate     NUMERIC(6,4),
              completion_rate     NUMERIC(6,4),
              updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `,
      },
      {
        name: 'index_driver_user_projection_user_id',
        sql: `
          CREATE INDEX IF NOT EXISTS idx_driver_user_projection_user_id
            ON driver_user_projection (user_id);
        `,
      },
      {
        name: 'table_rider_user_projection',
        sql: `
          CREATE TABLE IF NOT EXISTS rider_user_projection (
              rider_id         UUID PRIMARY KEY,
              user_id          UUID UNIQUE NOT NULL,
              display_name     VARCHAR(255),
              phone_number     VARCHAR(32),
              status           VARCHAR(32) DEFAULT 'active',
              total_rides      INTEGER DEFAULT 0,
              lifetime_spend   NUMERIC(12,2) DEFAULT 0,
              rider_tier       VARCHAR(64),
              updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `,
      },
      {
        name: 'index_rider_user_projection_user_id',
        sql: `
          CREATE INDEX IF NOT EXISTS idx_rider_user_projection_user_id
            ON rider_user_projection (user_id);
        `,
      },
    ];
  }

  if (domain === 'analytics') {
    return [
      {
        name: 'table_analytics_rider_projection',
        sql: `
          CREATE TABLE IF NOT EXISTS analytics_rider_projection (
              rider_id     UUID PRIMARY KEY,
              user_id      UUID UNIQUE NOT NULL,
              updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `,
      },
      {
        name: 'index_analytics_rider_projection_user_id',
        sql: `
          CREATE INDEX IF NOT EXISTS idx_analytics_rider_projection_user_id
            ON analytics_rider_projection (user_id);
        `,
      },
    ];
  }

  return [];
}

function loadSqlFile(relativePath) {
  const absolutePath = path.resolve(SQL_ROOT, relativePath);
  return fs.readFileSync(absolutePath, 'utf8');
}

function sqlFileStepsByDomain(domain) {
  if (domain === 'rides') {
    return [
      {
        name: 'sql_054_ride_cancellation_reason_catalog',
        sql: loadSqlFile('054_ride_cancellation_reason_catalog.sql'),
      },
    ];
  }

  return [];
}

async function runDomainBootstrap({ domain, dryRun }) {
  const connectionConfig = buildDomainConnectionConfig(domain);
  const summary = summarizeConnection(connectionConfig);
  const steps = [
    ...commonSteps(),
    ...stepsByDomain(domain),
    ...sqlFileStepsByDomain(domain),
  ];

  // eslint-disable-next-line no-console
  console.log(`# Bootstrap domain=${domain} target=${summary} steps=${steps.length}`);

  if (dryRun) {
    for (const step of steps) {
      // eslint-disable-next-line no-console
      console.log(`[dry-run] [${domain}] ${step.name}`);
    }
    return { domain, applied: 0, dryRun: true };
  }

  const client = new Client(connectionConfig);
  await client.connect();

  let applied = 0;
  try {
    for (const step of steps) {
      await client.query(step.sql);
      applied += 1;
      // eslint-disable-next-line no-console
      console.log(`[ok] [${domain}] ${step.name}`);
    }
  } finally {
    await client.end().catch(() => {});
  }

  return { domain, applied, dryRun: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = parseBool(args.get('dry-run'), false);
  const domains = parseDomainList(args.get('domains'));

  const results = [];
  for (const domain of domains) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runDomainBootstrap({ domain, dryRun });
    results.push(result);
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    dryRun,
    domains,
    results,
  }, null, 2));
}

main().catch((err) => {
  const message = err?.message || err?.code || String(err);
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    ok: false,
    error: message,
    code: 'DOMAIN_BOOTSTRAP_FAILED',
  }, null, 2));
  process.exit(1);
});
