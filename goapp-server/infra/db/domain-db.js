'use strict';

const ConnectionManager = require('./connection-manager');

const manager = new ConnectionManager();

async function query(domain, text, params = [], options = {}) {
  return manager.query(domain, text, params, options);
}

async function getClient(domain, role = 'writer') {
  return manager.getPool(domain, role).connect();
}

async function withTx(domain, fn) {
  return manager.withTransaction(domain, fn);
}

async function withTransaction(domain, fn, options = {}) {
  return manager.withTransaction(domain, fn, options);
}

module.exports = {
  manager,
  query,
  getClient,
  withTx,
  withTransaction,
};
