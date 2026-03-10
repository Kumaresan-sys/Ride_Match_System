#!/usr/bin/env node

'use strict';

require('../../config/env-loader');

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { DOMAINS } = require('./domain-table-groups');

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

function quoteForShell(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
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

function quoteSqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteSqlIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function wrapWithDockerExec(containerName, command) {
  const container = String(containerName || '').trim();
  if (!container) return command;
  return `docker exec -i ${container} /bin/sh -lc ${quoteForShell(command)}`;
}

function sourceUrlFromEnv() {
  if (hasValue(process.env.SOURCE_DB_URL)) return process.env.SOURCE_DB_URL;
  if (hasValue(process.env.POSTGRES_URL)) return process.env.POSTGRES_URL;
  if (!hasValue(process.env.POSTGRES_DB)) return '';

  return toPgUrl({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: process.env.POSTGRES_PORT || 5432,
    user: process.env.POSTGRES_USER || 'goapp',
    password: process.env.POSTGRES_PASSWORD || 'goapp',
    database: process.env.POSTGRES_DB,
  });
}

function targetUrlForDomain(domain) {
  const key = `${domain.toUpperCase()}_DB_URL`;
  if (hasValue(process.env[key])) return process.env[key];

  const prefix = domain.toUpperCase();
  const writerUrl = process.env[`${prefix}_DB_WRITER_URL`];
  if (hasValue(writerUrl)) return writerUrl;

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

function run(command, { execute, capture = false } = {}) {
  if (!execute) {
    // eslint-disable-next-line no-console
    console.log(command);
    return '';
  }
  if (capture) {
    const output = execSync(command, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: '/bin/zsh',
    });
    return String(output || '').trim();
  }
  execSync(command, { stdio: 'inherit', shell: '/bin/zsh' });
  return '';
}

function tableExists({ targetUrl, table, execute, dockerContainer = '' }) {
  const target = quoteForShell(targetUrl);
  const sql = `SELECT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ${quoteSqlLiteral(table)}
  );`;
  const innerCmd = `psql ${target} -Atc ${quoteForShell(sql)}`;
  const cmd = wrapWithDockerExec(dockerContainer, innerCmd);
  const out = run(cmd, { execute, capture: true });
  return /^t(rue)?$/i.test(String(out).trim());
}

function truncateTables({
  targetUrl,
  tables,
  execute,
  dockerContainer = '',
}) {
  if (!Array.isArray(tables) || tables.length === 0) return;
  const target = quoteForShell(targetUrl);
  const tableList = tables.map((table) => quoteSqlIdentifier(table)).join(', ');
  const sql = `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`;
  const innerCmd = `psql ${target} -v ON_ERROR_STOP=1 -c ${quoteForShell(sql)}`;
  const cmd = wrapWithDockerExec(dockerContainer, innerCmd);
  run(cmd, { execute });
}

function dumpAndLoadTable({
  sourceUrl,
  targetUrl,
  table,
  execute,
  dockerContainer = '',
  skipSchemaIfExists = true,
  tableAlreadyExists = null,
}) {
  const source = quoteForShell(sourceUrl);
  const target = quoteForShell(targetUrl);
  const tableArg = quoteForShell(table);

  const exists = tableAlreadyExists === null
    ? tableExists({
      targetUrl,
      table,
      execute,
      dockerContainer,
    })
    : Boolean(tableAlreadyExists);

  const schemaInnerCmd = [
    `pg_dump ${source}`,
    '--schema-only',
    '--section=pre-data',
    '--no-owner',
    '--no-privileges',
    `--table=${tableArg}`,
    `| psql ${target} -v ON_ERROR_STOP=1`,
  ].join(' ');

  const dataInnerCmd = [
    `pg_dump ${source}`,
    '--data-only',
    '--disable-triggers',
    '--no-owner',
    '--no-privileges',
    `--table=${tableArg}`,
    `| psql ${target} -v ON_ERROR_STOP=1`,
  ].join(' ');

  const schemaCmd = wrapWithDockerExec(dockerContainer, schemaInnerCmd);
  const dataCmd = wrapWithDockerExec(dockerContainer, dataInnerCmd);

  if (!skipSchemaIfExists || !exists) {
    run(schemaCmd, { execute });
  } else {
    // eslint-disable-next-line no-console
    console.log(`# skip schema (exists): ${table}`);
  }

  run(dataCmd, { execute });
}

function ensureUrls(sourceUrl, domainPlans) {
  if (!sourceUrl) throw new Error('SOURCE_DB_URL (or --source-url) is required');
  for (const domain of DOMAINS) {
    if ((domainPlans[domain] || []).length > 0 && !targetUrlForDomain(domain)) {
      throw new Error(`${domain.toUpperCase()}_DB_URL is required for domain '${domain}'`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceUrl = args.get('source-url') || sourceUrlFromEnv();
  const planPath = args.get('plan') || path.join(__dirname, 'domain-extraction-plan.json');
  const execute = args.get('execute') === 'true';
  const skipSchemaIfExists = parseBool(args.get('skip-schema-if-exists'), true);
  const truncateTarget = parseBool(args.get('truncate-target'), true);
  const dockerContainer =
    args.get('docker-container') ||
    process.env.DOCKER_POSTGRES_CONTAINER ||
    '';

  const rawPlan = fs.readFileSync(planPath, 'utf8');
  const plan = JSON.parse(rawPlan);
  const domainPlans = plan.domains || {};

  ensureUrls(sourceUrl, domainPlans);

  for (const domain of DOMAINS) {
    const targetUrl = targetUrlForDomain(domain);
    const tables = domainPlans[domain] || [];
    if (!tables.length) continue;

    // eslint-disable-next-line no-console
    console.log(`# Domain ${domain} -> ${tables.length} tables`);

    const tableExistsMap = new Map();
    for (const table of tables) {
      const exists = tableExists({
        targetUrl,
        table,
        execute,
        dockerContainer,
      });
      tableExistsMap.set(table, exists);
    }

    if (truncateTarget) {
      const existingTables = tables.filter((table) => tableExistsMap.get(table));
      truncateTables({
        targetUrl,
        tables: existingTables,
        execute,
        dockerContainer,
      });
    }

    for (const table of tables) {
      dumpAndLoadTable({
        sourceUrl,
        targetUrl,
        table,
        execute,
        dockerContainer,
        skipSchemaIfExists,
        tableAlreadyExists: tableExistsMap.get(table),
      });
    }
  }

  if (!execute) {
    // eslint-disable-next-line no-console
    console.log('# Dry run complete. Re-run with --execute true to apply extraction.');
  }
}

try {
  main();
} catch (err) {
  const message = err?.message || err?.code || String(err);
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    ok: false,
    error: message,
    code: 'DOMAIN_EXTRACT_FAILED',
    errorDetails: {
      sourceCode: err?.code || null,
      errno: err?.errno || null,
      syscall: err?.syscall || null,
      address: err?.address || null,
      port: err?.port || null,
    },
  }, null, 2));
  process.exit(1);
}
