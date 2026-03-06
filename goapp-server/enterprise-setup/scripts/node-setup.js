#!/usr/bin/env node
// ============================================================
// GoApp Node Setup Script
// Initializes database tables, seeds default config, and
// validates all service dependencies.
//
// Usage:
//   node enterprise-setup/scripts/node-setup.js [--env=production]
//   node enterprise-setup/scripts/node-setup.js --check   (health check only)
//   node enterprise-setup/scripts/node-setup.js --seed    (seed test data)
// ============================================================

'use strict';

const path = require('path');
const fs   = require('fs');

const args = process.argv.slice(2);
const ENV         = process.env.NODE_ENV || 'development';
const CHECK_ONLY  = args.includes('--check');
const SEED_ONLY   = args.includes('--seed');
const DRY_RUN     = args.includes('--dry-run');

// ─── Color helpers ────────────────────────────────────────────────────────
const c = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
};

function log(tag, msg, ok = true) {
  const icon   = ok ? c.green('✓') : c.red('✗');
  const tagFmt = c.cyan(`[${tag}]`);
  console.log(`  ${icon} ${tagFmt} ${msg}`);
}

function warn(tag, msg) {
  console.log(`  ${c.yellow('!')} ${c.cyan(`[${tag}]`)} ${c.yellow(msg)}`);
}

function fail(tag, msg) {
  console.log(`  ${c.red('✗')} ${c.cyan(`[${tag}]`)} ${c.red(msg)}`);
}

// ─── Migration order ─────────────────────────────────────────────────────
const SQL_DIR = path.join(__dirname, '..', 'sql');

const MIGRATIONS = [
  '001_identity_and_otp.sql',
  '002_driver_service.sql',
  '003_rider_service.sql',
  '004_ride_service.sql',
  '005_dispatch_matching.sql',
  '006_location_service.sql',
  '007_pricing_service.sql',
  '008_payment_wallet.sql',
  '009_driver_incentives.sql',
  '010_notification_service.sql',
  '011_fraud_risk.sql',
  '012_promotions_referrals.sql',
  '013_safety_sos.sql',
  '014_scheduling.sql',
  '015_corporate_b2b.sql',
  '016_support.sql',
  '017_compliance.sql',
  '018_saga_orchestration.sql',
  '019_event_system.sql',
  '020_analytics_warehouse.sql',
  '021_coins_rewards.sql',
  '022_sos_logs.sql',
];

// ─── Required environment variables ─────────────────────────────────────
const REQUIRED_ENV = {
  production: [
    'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB',
    'REDIS_HOST', 'REDIS_PORT',
    'GOAPP_ADMIN_TOKEN',
    'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY',
    'SMS_PROVIDER',
  ],
  development: [],  // All vars have safe defaults in dev
};

// ─── Optional env variables with defaults ─────────────────────────────────
const OPTIONAL_ENV = {
  SMS_PROVIDER:      { default: 'console',  desc: 'SMS provider: twilio | msg91 | 2factor | console' },
  TWILIO_ACCOUNT_SID:{ default: '',         desc: 'Twilio account SID (required if SMS_PROVIDER=twilio)' },
  TWILIO_AUTH_TOKEN: { default: '',         desc: 'Twilio auth token' },
  TWILIO_FROM_NUMBER:{ default: '',         desc: 'Twilio sender number (+1XXXXXXXXXX)' },
  MSG91_AUTH_KEY:    { default: '',         desc: 'MSG91 auth key (required if SMS_PROVIDER=msg91)' },
  MSG91_SENDER_ID:   { default: 'GOAPP',    desc: 'MSG91 sender ID (6 chars)' },
  MSG91_TEMPLATE_ID: { default: '',         desc: 'MSG91 OTP template ID' },
  TWOFACTOR_API_KEY: { default: '',         desc: '2Factor API key (required if SMS_PROVIDER=2factor)' },
  COIN_INR_VALUE:    { default: '0.10',     desc: '1 coin = ₹X discount' },
  COINS_PER_INR_EARN:{ default: '10',       desc: 'Earn 1 coin per ₹X of fare' },
  MIN_REDEEM_COINS:  { default: '10',       desc: 'Minimum coins to redeem' },
  MAX_REDEEM_PCT:    { default: '0.20',     desc: 'Max % of fare discountable via coins' },
  GOAPP_ADMIN_TOKEN: { default: 'goapp-admin-secret', desc: 'Admin API token (override in production!)' },
  EVENT_BUS_MAX_EVENTS: { default: '5000', desc: 'Max in-memory events' },
};

// ─── Check environment ────────────────────────────────────────────────────
function checkEnvironment() {
  console.log(c.bold('\n  Environment Check'));
  console.log('  ' + '─'.repeat(50));

  let hasErrors = false;
  const required = REQUIRED_ENV[ENV] || REQUIRED_ENV.development;

  for (const key of required) {
    if (!process.env[key]) {
      fail('ENV', `${key} is required in ${ENV} mode`);
      hasErrors = true;
    } else {
      log('ENV', `${key} = ${key.toLowerCase().includes('key') || key.toLowerCase().includes('password') || key.toLowerCase().includes('token') ? '***' : process.env[key]}`);
    }
  }

  // Warn about optional but useful vars
  for (const [key, meta] of Object.entries(OPTIONAL_ENV)) {
    if (!required.includes(key)) {
      const val = process.env[key] || meta.default;
      if (!process.env[key] && meta.default) {
        warn('ENV', `${key} not set — using default: "${meta.default}" (${meta.desc})`);
      } else if (process.env[key]) {
        const display = key.toLowerCase().includes('key') || key.toLowerCase().includes('password') || key.toLowerCase().includes('token') ? '***' : process.env[key];
        log('ENV', `${key} = ${display}`);
      }
    }
  }

  // Warn about insecure admin token
  if ((process.env.GOAPP_ADMIN_TOKEN || '') === 'goapp-admin-secret' && ENV === 'production') {
    fail('SECURITY', 'GOAPP_ADMIN_TOKEN is set to the default value — CHANGE THIS before production!');
    hasErrors = true;
  }

  return !hasErrors;
}

// ─── Check SQL migration files ─────────────────────────────────────────────
function checkMigrations() {
  console.log(c.bold('\n  SQL Migration Files'));
  console.log('  ' + '─'.repeat(50));

  let allFound = true;
  for (const file of MIGRATIONS) {
    const fullPath = path.join(SQL_DIR, file);
    if (fs.existsSync(fullPath)) {
      const lines = fs.readFileSync(fullPath, 'utf8').split('\n').length;
      log('SQL', `${file} (${lines} lines)`);
    } else {
      fail('SQL', `${file} NOT FOUND`);
      allFound = false;
    }
  }

  // Check for any extra SQL files not in the list
  const sqlFiles = fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const f of sqlFiles) {
    if (!MIGRATIONS.includes(f)) {
      warn('SQL', `Unlisted migration file: ${f}`);
    }
  }

  return allFound;
}

// ─── Check Node.js services ────────────────────────────────────────────────
function checkServices() {
  console.log(c.bold('\n  Service Modules'));
  console.log('  ' + '─'.repeat(50));

  // Paths relative to goapp-server root (this script lives in enterprise-setup/scripts/)
  const ROOT = path.resolve(__dirname, '../..');
  const services = [
    'services/identity-service.js',
    'services/sms-service.js',
    'services/wallet-service.js',
    'services/sos-service.js',
    'services/ride-service.js',
    'services/matching-engine.js',
    'services/pricing-service.js',
    'services/location-service.js',
    'services/notification-service.js',
    'services/zone-service.js',
    'services/redis-mock.js',
    'services/mock-db.js',
    'config/index.js',
    'utils/logger.js',
    'utils/formulas.js',
    'websocket/ws-gateway.js',
  ].map(s => path.join(ROOT, s));

  let allOk = true;
  for (const fullPath of services) {
    if (fs.existsSync(fullPath)) {
      try {
        require(fullPath);
        log('MODULE', path.basename(fullPath));
      } catch (e) {
        fail('MODULE', `${path.basename(fullPath)} — require() error: ${e.message}`);
        allOk = false;
      }
    } else {
      fail('MODULE', `${path.basename(fullPath)} — FILE NOT FOUND`);
      allOk = false;
    }
  }

  return allOk;
}

// ─── Check npm dependencies ────────────────────────────────────────────────
function checkDependencies() {
  console.log(c.bold('\n  npm Dependencies'));
  console.log('  ' + '─'.repeat(50));

  const pkgPath = path.resolve(__dirname, '../../package.json');  // goapp-server/package.json
  if (!fs.existsSync(pkgPath)) {
    fail('NPM', 'package.json not found');
    return false;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  let allOk = true;

  for (const dep of Object.keys(deps)) {
    const depPath = path.resolve(__dirname, '../../node_modules', dep);
    if (fs.existsSync(depPath)) {
      log('NPM', `${dep}@${deps[dep]}`);
    } else {
      fail('NPM', `${dep} not installed — run: npm install`);
      allOk = false;
    }
  }

  return allOk;
}

// ─── Print setup summary ───────────────────────────────────────────────────
function printSummary(checks) {
  console.log(c.bold('\n  Setup Summary'));
  console.log('  ' + '─'.repeat(50));

  const allPassed = Object.values(checks).every(Boolean);
  for (const [name, ok] of Object.entries(checks)) {
    const icon = ok ? c.green('PASS') : c.red('FAIL');
    console.log(`  [${icon}] ${name}`);
  }

  console.log('');
  if (allPassed) {
    console.log(c.green(c.bold('  ✓ All checks passed! Ready to start.')));
    console.log(c.dim('    Run: node server.js --api-only'));
  } else {
    console.log(c.red(c.bold('  ✗ Some checks failed. Fix issues above before starting.')));
    if (ENV === 'production') process.exit(1);
  }
  console.log('');
}

// ─── Print config reference ────────────────────────────────────────────────
function printConfigReference() {
  console.log(c.bold('\n  Configuration Reference'));
  console.log('  ' + '─'.repeat(50));
  console.log(c.dim('  Copy .env.example → .env and fill in your values:\n'));

  const groups = {
    'Server': ['PORT', 'WS_PORT', 'NODE_ENV'],
    'Database': ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'],
    'Redis': ['REDIS_HOST', 'REDIS_PORT'],
    'Admin': ['GOAPP_ADMIN_TOKEN'],
    'SMS — choose one provider': ['SMS_PROVIDER', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'MSG91_AUTH_KEY', 'MSG91_SENDER_ID', 'MSG91_TEMPLATE_ID', 'TWOFACTOR_API_KEY'],
    'Firebase FCM': ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'],
    'Coins / Wallet': ['COIN_INR_VALUE', 'COINS_PER_INR_EARN', 'MIN_REDEEM_COINS', 'MAX_REDEEM_PCT'],
  };

  for (const [group, keys] of Object.entries(groups)) {
    console.log(c.yellow(`\n    # ${group}`));
    for (const key of keys) {
      const meta = OPTIONAL_ENV[key];
      const dflt = meta?.default ? ` (default: ${meta.default})` : '';
      const desc = meta?.desc    ? `  # ${meta.desc}` : '';
      console.log(c.dim(`    ${key}=<value>${dflt}${desc}`));
    }
  }
  console.log('');
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log(c.bold(c.cyan('  ╔══════════════════════════════════════════════════════╗')));
  console.log(c.bold(c.cyan('  ║   GoApp Node Setup & Health Check                   ║')));
  console.log(c.bold(c.cyan(`  ║   Environment: ${ENV.padEnd(36)}║`)));
  console.log(c.bold(c.cyan('  ╚══════════════════════════════════════════════════════╝')));

  if (DRY_RUN) warn('MODE', 'DRY RUN — no changes will be made');

  const checks = {
    'Environment Variables': checkEnvironment(),
    'SQL Migration Files':   checkMigrations(),
    'Service Modules':       checkServices(),
    'npm Dependencies':      checkDependencies(),
  };

  printSummary(checks);

  if (args.includes('--config')) {
    printConfigReference();
  }
}

main().catch(err => {
  console.error(c.red(`\nSetup failed: ${err.message}`));
  process.exit(1);
});
