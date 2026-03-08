// GoApp Environment Loader
// MUST be the first require() in server.js — loads .env.<NODE_ENV> before
// any other module reads process.env.

'use strict';

const path   = require('path');
const fs     = require('fs');
const dotenv = require('dotenv');

const NODE_ENV = process.env.NODE_ENV || 'development';
const rootDir = path.resolve(__dirname, '..');
const envFile = path.resolve(rootDir, `.env.${NODE_ENV}`);
const localEnvFile = path.resolve(rootDir, `.env.${NODE_ENV}.local`);

function loadEnvFile(filePath, { override = false } = {}) {
  const result = dotenv.config({ path: filePath, override });
  if (result.error) {
    console.error('[env-loader] Failed to parse env file:', result.error.message);
    process.exit(1);
  }
  console.log(`[env-loader] Loaded ${filePath}`);
}

if (!fs.existsSync(envFile)) {
  if (NODE_ENV !== 'development') {
    console.error(`[env-loader] FATAL: Required env file not found: ${envFile}`);
    console.error(`[env-loader] Copy .env.example to .env.${NODE_ENV} and fill in values.`);
    process.exit(1);
  }
  console.warn(`[env-loader] WARNING: ${envFile} not found — booting with defaults (mock DB + mock Redis)`);
} else {
  loadEnvFile(envFile);
}

if (fs.existsSync(localEnvFile)) {
  loadEnvFile(localEnvFile, { override: true });
}

// Ensure NODE_ENV is always explicitly set for downstream modules
process.env.NODE_ENV = NODE_ENV;

module.exports = { NODE_ENV };
