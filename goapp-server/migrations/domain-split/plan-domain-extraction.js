#!/usr/bin/env node

'use strict';

require('../../config/env-loader');

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { DOMAINS, groupTables } = require('./domain-table-groups');

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

function toConnectionConfig(url, fallback) {
  if (url) return { connectionString: url };
  return fallback;
}

function summarize(grouped) {
  const result = {};
  for (const domain of DOMAINS) {
    result[domain] = grouped[domain]?.length || 0;
  }
  return result;
}

async function loadPublicTables(client) {
  const { rows } = await client.query(
    `SELECT tablename
     FROM pg_tables
     WHERE schemaname = 'public'
     ORDER BY tablename ASC`
  );
  return rows.map((row) => row.tablename);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceUrl = args.get('source-url') || process.env.SOURCE_DB_URL || process.env.POSTGRES_URL || '';
  const tablesFile = args.get('tables-file') || '';
  const outputFile = args.get('output') || path.join(__dirname, 'domain-extraction-plan.json');
  const allowUnknown = args.get('allow-unknown') === 'true';

  const fallbackConfig = {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER || 'goapp',
    password: process.env.POSTGRES_PASSWORD || 'goapp',
    database: process.env.POSTGRES_DB || 'goapp_enterprise',
  };

  let tables = [];
  if (tablesFile) {
    const raw = fs.readFileSync(tablesFile, 'utf8').trim();
    tables = raw.startsWith('[')
      ? JSON.parse(raw).map((item) => String(item))
      : raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } else {
    const client = new Client(toConnectionConfig(sourceUrl, fallbackConfig));
    await client.connect();
    try {
      tables = await loadPublicTables(client);
    } finally {
      await client.end().catch(() => {});
    }
  }

  const { grouped, unknown, ignored } = groupTables(tables, { strict: false });
  if (unknown.length && !allowUnknown) {
    const err = new Error(
      `Unmapped tables found (${unknown.length}). Re-run with --allow-unknown true after assigning owners.`
    );
    err.code = 'UNMAPPED_TABLES';
    err.unknownTables = unknown;
    throw err;
  }

  const plan = {
    generatedAt: new Date().toISOString(),
    sourceDatabase: tablesFile
      ? `tables-file:${path.resolve(tablesFile)}`
      : sourceUrl || `${fallbackConfig.host}:${fallbackConfig.port}/${fallbackConfig.database}`,
    totals: {
      tables: tables.length,
      byDomain: summarize(grouped),
      unknown: unknown.length,
      ignored: ignored.length,
    },
    domains: grouped,
    ignoredTables: ignored,
    unknownTables: unknown,
  };

  fs.writeFileSync(outputFile, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

main().catch((err) => {
  const message = err?.message || err?.code || String(err);
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    ok: false,
    error: message,
    code: err.code || 'DOMAIN_PLAN_FAILED',
    errorDetails: {
      errno: err?.errno || null,
      syscall: err?.syscall || null,
      address: err?.address || null,
      port: err?.port || null,
    },
    unknownTables: err.unknownTables || [],
  }, null, 2));
  process.exit(1);
});
