#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const routesDir = path.join(root, 'routes');
const serverFile = path.join(root, 'server.js');
const dispatcherFile = path.join(root, 'routes', 'index.js');

function listJsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(fullPath);
    if (entry.isFile() && entry.name.endsWith('.js')) return [fullPath];
    return [];
  });
}

const violations = [];
const forbiddenRouteImports = [
  /require\((['"])\.\.\/repositories\/pg\//,
  /require\((['"])\.\.\/services\/db\1\)/,
  /require\((['"])\.\.\/\.\.\/services\/db\1\)/,
];

for (const file of listJsFiles(routesDir)) {
  const content = fs.readFileSync(file, 'utf8');
  for (const pattern of forbiddenRouteImports) {
    if (pattern.test(content)) {
      violations.push(`Forbidden import in routes layer: ${path.relative(root, file)} (${pattern})`);
    }
  }
}

const serverContent = fs.readFileSync(serverFile, 'utf8');
const forbiddenServerRouteBranches = [
  /if\s*\(\s*path\s*===\s*['"]\/api\/v1\/(?!payments\/webhook)/,
];

for (const pattern of forbiddenServerRouteBranches) {
  if (pattern.test(serverContent)) {
    violations.push(`server.js contains direct API route branching (${pattern}).`);
  }
}

if (!/buildRouteDispatcher\(/.test(serverContent)) {
  violations.push('server.js must register modular route dispatcher via buildRouteDispatcher.');
}

if (/handleLegacyRoute/.test(serverContent)) {
  violations.push('server.js must not define or reference handleLegacyRoute.');
}

const dispatcherContent = fs.readFileSync(dispatcherFile, 'utf8');
if (/legacyHandler/.test(dispatcherContent)) {
  violations.push('routes/index.js must not accept or invoke legacy handler fallback.');
}

if (!/status:\s*404[\s\S]*code:\s*['"]NOT_FOUND['"]/.test(dispatcherContent)) {
  violations.push('routes/index.js must return standardized 404 envelope with NOT_FOUND code.');
}

if (violations.length > 0) {
  console.error('Architecture guard failed:\n');
  for (const v of violations) console.error(`- ${v}`);
  process.exit(1);
}

console.log('Architecture guard passed.');
