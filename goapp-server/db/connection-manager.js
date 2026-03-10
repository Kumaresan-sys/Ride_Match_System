'use strict';

const ConnectionManager = require('../infra/db/connection-manager');

const manager = new ConnectionManager();

function getPool(domain, role = 'writer') {
  return manager.getPool(domain, role);
}

async function query(domain, sql, params = [], options = {}) {
  return manager.query(domain, sql, params, options);
}

async function withTransaction(domain, fn, options = {}) {
  return manager.withTransaction(domain, fn, options);
}

module.exports = {
  manager,
  getPool,
  query,
  withTransaction,
};
