#!/usr/bin/env node

'use strict';

require('../../config/env-loader');

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { DOMAINS } = require('./domain-table-groups');

const REQUIRED_SCHEMA_CHECKS = {
  identity: [
    {
      table: 'safety_preferences',
      columns: ['user_id', 'auto_share', 'share_at_night', 'updated_at'],
    },
    {
      table: 'trusted_contacts_shares',
      columns: ['ride_id', 'user_id', 'contact_id', 'share_type', 'share_url', 'shared_at', 'expires_at'],
    },
  ],
  rides: [
    {
      table: 'ride_tracking_shares',
      columns: ['ride_id', 'rider_user_id', 'contact_id', 'token', 'status', 'created_at', 'expires_at'],
    },
  ],
  support: [
    {
      table: 'support_tickets',
      columns: [
        'id',
        'ticket_code',
        'user_id',
        'user_type',
        'category',
        'subject',
        'description',
        'status',
        'priority',
        'last_activity_at',
        'metadata_json',
      ],
    },
    {
      table: 'ticket_messages',
      columns: [
        'id',
        'ticket_id',
        'message_type',
        'visibility',
        'sender_id',
        'sender_role',
        'sender_display_name',
        'content',
        'attachments_json',
        'created_at',
      ],
    },
    {
      table: 'support_ticket_read_state',
      columns: [
        'ticket_id',
        'actor_type',
        'actor_id',
        'last_read_message_id',
        'last_read_at',
        'updated_at',
      ],
    },
    {
      table: 'support_ticket_attachments',
      columns: [
        'id',
        'ticket_id',
        'storage_key',
        'original_name',
        'safe_name',
        'mime_type',
        'size_bytes',
        'checksum_sha256',
        'uploaded_by',
        'created_at',
      ],
    },
  ],
};

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

function clientFor(url, fallbackConfig = null) {
  if (url) return new Client({ connectionString: url });
  if (!fallbackConfig) throw new Error('Missing DB URL for verify');
  return new Client(fallbackConfig);
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function toPgUrl({ host, port, user, password, database }) {
  const safeHost = hasValue(host) ? String(host).trim() : 'localhost';
  const safePort = Number(port || 5432);
  const safeUser = encodeURIComponent(String(user || 'goapp'));
  const safePassword = encodeURIComponent(String(password || 'goapp'));
  const safeDatabase = encodeURIComponent(String(database || 'goapp_enterprise'));
  return `postgresql://${safeUser}:${safePassword}@${safeHost}:${safePort}/${safeDatabase}`;
}

function targetUrlForDomain(domain) {
  const prefix = domain.toUpperCase();
  const directUrl =
    process.env[`${prefix}_DB_URL`] ||
    process.env[`${prefix}_DB_WRITER_URL`];
  if (hasValue(directUrl)) return directUrl;

  const database =
    process.env[`${prefix}_DB_NAME`] ||
    process.env.POSTGRES_DB ||
    `${domain}_db`;

  if (!hasValue(database)) return null;

  return toPgUrl({
    host: process.env[`${prefix}_DB_WRITER_HOST`] || process.env.POSTGRES_HOST || 'localhost',
    port: process.env[`${prefix}_DB_WRITER_PORT`] || process.env.POSTGRES_PORT || 5432,
    user: process.env[`${prefix}_DB_WRITER_USER`] || process.env.POSTGRES_USER || 'goapp',
    password: process.env[`${prefix}_DB_WRITER_PASSWORD`] || process.env.POSTGRES_PASSWORD || 'goapp',
    database,
  });
}

async function countRows(client, tableName) {
  const safe = String(tableName).replace(/"/g, '""');
  const { rows } = await client.query(`SELECT COUNT(*)::bigint AS cnt FROM "${safe}"`);
  return Number(rows[0]?.cnt || 0);
}

async function getTableColumns(client, tableName) {
  const { rows } = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position`,
    [tableName]
  );
  return rows.map((row) => row.column_name);
}

async function verifyRequiredSchemaForDomain(client, domain) {
  const checks = REQUIRED_SCHEMA_CHECKS[domain] || [];
  const failures = [];

  for (const check of checks) {
    // eslint-disable-next-line no-await-in-loop
    const columns = await getTableColumns(client, check.table);
    if (!columns.length) {
      failures.push({
        domain,
        table: check.table,
        type: 'missing_table',
        expectedColumns: check.columns,
      });
      continue;
    }

    const missingColumns = check.columns.filter((column) => !columns.includes(column));
    if (missingColumns.length) {
      failures.push({
        domain,
        table: check.table,
        type: 'missing_columns',
        missingColumns,
        expectedColumns: check.columns,
        actualColumns: columns,
      });
    }
  }

  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceUrl = args.get('source-url') || process.env.SOURCE_DB_URL || process.env.POSTGRES_URL || '';
  const planPath = args.get('plan') || path.join(__dirname, 'domain-extraction-plan.json');
  const schemaOnly = String(args.get('schema-only') || 'false').toLowerCase() === 'true';

  const fallbackConfig = {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER || 'goapp',
    password: process.env.POSTGRES_PASSWORD || 'goapp',
    database: process.env.POSTGRES_DB || 'goapp_enterprise',
  };

  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const domains = plan.domains || {};

  const source = schemaOnly ? null : clientFor(sourceUrl, fallbackConfig);
  if (source) {
    await source.connect();
  }

  const mismatches = [];
  const checks = [];
  const schemaFailures = [];
  try {
    for (const domain of DOMAINS) {
      const tables = domains[domain] || [];
      if (!tables.length && !(REQUIRED_SCHEMA_CHECKS[domain] || []).length) continue;

      const target = clientFor(targetUrlForDomain(domain));
      await target.connect();
      try {
        // eslint-disable-next-line no-await-in-loop
        schemaFailures.push(...await verifyRequiredSchemaForDomain(target, domain));
        if (schemaOnly) {
          continue;
        }
        for (const table of tables) {
          // eslint-disable-next-line no-await-in-loop
          const sourceCount = await countRows(source, table);
          // eslint-disable-next-line no-await-in-loop
          const targetCount = await countRows(target, table);
          const item = { domain, table, sourceCount, targetCount };
          checks.push(item);
          if (sourceCount !== targetCount) {
            mismatches.push(item);
          }
        }
      } finally {
        await target.end().catch(() => {});
      }
    }
  } finally {
    if (source) {
      await source.end().catch(() => {});
    }
  }

  const result = {
    ok: mismatches.length === 0 && schemaFailures.length === 0,
    schemaOnly,
    checkedTables: checks.length,
    schemaFailures,
    mismatches,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (mismatches.length > 0 || schemaFailures.length > 0) process.exit(1);
}

main().catch((err) => {
  const message = err?.message || err?.code || String(err);
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    ok: false,
    error: message,
    code: 'DOMAIN_VERIFY_FAILED',
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
