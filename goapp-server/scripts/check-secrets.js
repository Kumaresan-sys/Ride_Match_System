#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');

function trackedFiles() {
  const out = cp.execSync('git ls-files', { cwd: root, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function shouldScan(relPath) {
  if (relPath.startsWith('node_modules/')) return false;
  if (relPath.endsWith('.png') || relPath.endsWith('.jpg') || relPath.endsWith('.jpeg') || relPath.endsWith('.pdf')) return false;
  if (relPath.includes('package-lock.json')) return false;
  return true;
}

const suspectPatterns = [
  { name: 'Private key block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Razorpay test key', regex: /RAZORPAY_KEY_ID\s*=\s*rzp_test_[A-Za-z0-9]{8,}/ },
  { name: '2Factor API key', regex: /TWOFACTOR_API_KEY\s*=\s*[0-9a-fA-F-]{16,}/ },
  { name: 'Hardcoded admin token', regex: /GOAPP_ADMIN_TOKEN\s*=\s*[A-Za-z0-9_-]{24,}/ },
  { name: 'Hardcoded JWT secret', regex: /JWT_SECRET\s*=\s*(?!\$\{)(?!your_)(?!replace_)[^\s#]{8,}/ },
  { name: 'Hardcoded OTP secret', regex: /OTP_SECRET\s*=\s*(?!\$\{)(?!your_)(?!replace_)[^\s#]{8,}/ },
  { name: 'Hardcoded token hash secret', regex: /TOKEN_HASH_SECRET\s*=\s*(?!\$\{)(?!your_)(?!replace_)[^\s#]{8,}/ },
];

const allowListSnippets = [
  'your_',
  'replace_with_',
  'rzp_test_XXXXXXXXXXXXXXXX',
  'GOAPP_ADMIN_TOKEN=goapp-admin-secret',
];

const findings = [];
for (const relPath of trackedFiles()) {
  if (!shouldScan(relPath)) continue;
  const isEnvLike = /(^|\/)\.env(\.|$)/.test(relPath) || relPath.endsWith('.env') || relPath.endsWith('.md');
  const absPath = path.join(root, relPath);
  const content = fs.readFileSync(absPath, 'utf8');
  if (allowListSnippets.some((snippet) => content.includes(snippet))) {
    // keep scanning line-by-line so non-placeholder values still fail
  }
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    for (const pattern of suspectPatterns) {
      if (!isEnvLike && pattern.name !== 'Private key block') continue;
      if (!pattern.regex.test(line)) continue;
      if (/\$\{[A-Z0-9_]+\}/.test(line)) continue;
      if (/your_|replace_with_|ACxxxxxxxx|XXXX/.test(line)) continue;
      findings.push({
        file: relPath,
        line: idx + 1,
        pattern: pattern.name,
        value: line.trim().slice(0, 160),
      });
    }
  });
}

if (findings.length > 0) {
  console.error('Secret scan failed:\n');
  for (const f of findings) {
    console.error(`- ${f.file}:${f.line} [${f.pattern}] ${f.value}`);
  }
  process.exit(1);
}

console.log('Secret scan passed.');
