'use strict';

const domainDb = require('../infra/db/domain-db');
const redis = require('./redis-client');
const RedisStateStore = require('../infra/redis/state-store');
const matchingEngine = require('./matching-engine');
const rideService = require('./ride-service');
const devDriverSeedService = require('./dev-driver-seed-service');
const { createSeedFleet } = require('./dev-driver-seed-service');
const { logger } = require('../utils/logger');

const TEST_RIDER_EMAIL_SUFFIX = '@goapp.local';
const TEST_RIDER_NAME_PATTERNS = ['Dev Rider%', 'Test Rider%'];

function isDevelopmentRuntime() {
  return String(process.env.NODE_ENV || 'development').trim() === 'development';
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(identifier || ''))) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => String(value)))];
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || '').trim());
}

class DevResetService {
  constructor(deps = {}) {
    this.domainDb = deps.domainDb || domainDb;
    this.redis = deps.redis || redis;
    this.stateStore = deps.stateStore || new RedisStateStore(this.redis);
    this.matchingEngine = deps.matchingEngine || matchingEngine;
    this.rideService = deps.rideService || rideService;
    this.devDriverSeedService = deps.devDriverSeedService || devDriverSeedService;
    this._columnTypeCache = new Map();
  }

  async reset(options = {}) {
    if (!isDevelopmentRuntime()) {
      return { skipped: true, reason: 'non_development_runtime' };
    }

    const dryRun = options.dryRun === true;
    const reseedDrivers = options.reseedDrivers !== false;
    const clearTrace = options.clearTrace !== false;
    const seededFleet = createSeedFleet();
    const seededDriverIds = unique(seededFleet.map((driver) => driver.driverId));

    const riderSnapshot = await this._findTestRiders();
    const rideSnapshot = await this._findTargetRides({
      seededDriverIds,
      riderIds: riderSnapshot.riderIds,
    });

    const targetSummary = {
      testRiderCount: riderSnapshot.rows.length,
      rideCount: rideSnapshot.rows.length,
      seededDriverCount: seededDriverIds.length,
      testRiders: riderSnapshot.rows,
      rides: rideSnapshot.rows,
    };

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        target: targetSummary,
      };
    }

    const redisSummary = await this._clearRedisState({
      rideRows: rideSnapshot.rows,
      riderUserIds: riderSnapshot.userIds,
      seededDriverIds,
    });
    const cacheSummary = this._clearRuntimeCaches({
      rideIds: rideSnapshot.rows.map((row) => row.rideId),
      riderUserIds: riderSnapshot.userIds,
    });
    const ridesSummary = await this._cleanupRidesDomain({
      rideRows: rideSnapshot.rows,
      riderIds: riderSnapshot.riderIds,
      riderUserIds: riderSnapshot.userIds,
    });
    const supportSummary = await this._cleanupSupportDomain({
      rideRows: rideSnapshot.rows,
      riderUserIds: riderSnapshot.userIds,
    });
    const paymentsSummary = await this._cleanupPaymentsDomain({
      riderIds: riderSnapshot.riderIds,
      riderUserIds: riderSnapshot.userIds,
    });
    const identitySummary = await this._cleanupIdentityDomain({
      riderIds: riderSnapshot.riderIds,
      riderUserIds: riderSnapshot.userIds,
      phoneNumbers: riderSnapshot.phoneNumbers,
    });

    const diagnostics = {
      clearedAutoAcceptTrace: clearTrace && this.matchingEngine?.clearDevAutoAcceptTrace
        ? (this.matchingEngine.clearDevAutoAcceptTrace().cleared || 0)
        : 0,
    };

    const reseed = reseedDrivers
      ? await this.devDriverSeedService.seedDrivers({ reason: 'reset_cleanup', keepAlive: true })
      : { skipped: true, reason: 'reseed_disabled' };

    const result = {
      success: true,
      dryRun: false,
      target: targetSummary,
      redis: redisSummary,
      cache: cacheSummary,
      rides: ridesSummary,
      support: supportSummary,
      payments: paymentsSummary,
      identity: identitySummary,
      diagnostics,
      reseed,
    };

    logger.info('DEV_RESET', 'Completed dev reset for seeded rides and test riders', {
      rideCount: targetSummary.rideCount,
      testRiderCount: targetSummary.testRiderCount,
      clearedRedisKeys: redisSummary.deletedKeys,
      clearedRideCacheEntries: cacheSummary.clearedRideCacheEntries,
      clearedAutoAcceptTrace: diagnostics.clearedAutoAcceptTrace,
    });

    return result;
  }

  async _findTestRiders() {
    const { rows } = await this.domainDb.query(
      'identity',
      `SELECT
         u.id AS user_id,
         COALESCE(r.id, NULL) AS rider_id,
         u.phone_number,
         u.email,
         COALESCE(up.display_name, '') AS display_name
       FROM users u
       LEFT JOIN riders r ON r.user_id = u.id
       LEFT JOIN user_profiles up ON up.user_id = u.id
       WHERE u.user_type = 'rider'
         AND (
           LOWER(COALESCE(u.email, '')) LIKE $1
           OR COALESCE(up.display_name, '') ILIKE ANY($2::text[])
         )
       ORDER BY u.created_at DESC`,
      [`%${TEST_RIDER_EMAIL_SUFFIX}`, TEST_RIDER_NAME_PATTERNS],
      { role: 'writer', strongRead: true },
    );

    return {
      rows: rows.map((row) => ({
        userId: row.user_id,
        riderId: row.rider_id,
        phoneNumber: row.phone_number,
        email: row.email,
        displayName: row.display_name,
      })),
      userIds: unique(rows.map((row) => row.user_id)),
      riderIds: unique(rows.map((row) => row.rider_id)),
      phoneNumbers: unique(rows.map((row) => row.phone_number)),
    };
  }

  async _findTargetRides({ seededDriverIds = [], riderIds = [] } = {}) {
    if (!seededDriverIds.length && !riderIds.length) {
      return { rows: [], rideDbIds: [], rideNumbers: [] };
    }

    const { rows } = await this.domainDb.query(
      'rides',
      `SELECT DISTINCT
         id,
         ride_number,
         rider_id,
         driver_id,
         status,
         created_at
       FROM rides
       WHERE driver_id = ANY($1::uuid[])
          OR rider_id = ANY($2::uuid[])
       ORDER BY created_at DESC`,
      [seededDriverIds, riderIds],
      { role: 'writer', strongRead: true },
    );

    return {
      rows: rows.map((row) => ({
        dbRideId: row.id,
        rideId: row.ride_number,
        riderId: row.rider_id,
        driverId: row.driver_id,
        status: row.status,
        createdAt: row.created_at,
      })),
      rideDbIds: unique(rows.map((row) => row.id)),
      rideNumbers: unique(rows.map((row) => row.ride_number)),
    };
  }

  async _clearRedisState({ rideRows = [], riderUserIds = [], seededDriverIds = [] } = {}) {
    const keys = new Set();
    const rideIds = unique(rideRows.map((row) => row.rideId));
    const rideDriverIds = unique(rideRows.map((row) => row.driverId));
    const offerDriverIds = unique([...seededDriverIds, ...rideDriverIds]);

    for (const rideId of rideIds) {
      keys.add(this.stateStore.rideActiveKey(rideId));
      keys.add(this.stateStore.rideOffersKey(rideId));
      keys.add(this.stateStore.rideAcceptedKey(rideId));
      keys.add(this.stateStore.rideAssignLockKey(rideId));
      keys.add(this.stateStore.rideExcludedSetKey(rideId));
      keys.add(this.stateStore.rideMatchStateKey(rideId));
      for (const driverId of offerDriverIds) {
        keys.add(this.stateStore.rideOfferKey(rideId, driverId));
      }
    }

    for (const riderUserId of unique(riderUserIds)) {
      keys.add(this.stateStore.riderActiveRideKey(riderUserId));
      keys.add(`active_ride:${riderUserId}`);
    }

    const keyList = [...keys].filter(Boolean);
    if (!keyList.length) {
      return { deletedKeys: 0, keys: [] };
    }

    const deletedCounts = await Promise.all(keyList.map((key) => this.redis.del(key).catch(() => 0)));
    return {
      deletedKeys: deletedCounts.reduce((sum, count) => sum + Number(count || 0), 0),
      keys: keyList,
    };
  }

  _clearRuntimeCaches({ rideIds = [], riderUserIds = [] } = {}) {
    const clearedRideIds = [];
    const rideMap = this.rideService?.rides;
    if (rideMap && typeof rideMap.delete === 'function') {
      for (const rideId of unique(rideIds)) {
        if (rideMap.delete(rideId)) {
          clearedRideIds.push(rideId);
        }
      }
    }

    let clearedCancellationCounters = 0;
    const cancellationCounts = this.rideService?.cancellationCounts;
    if (cancellationCounts && typeof cancellationCounts.delete === 'function') {
      for (const riderUserId of unique(riderUserIds)) {
        for (const actor of ['rider', 'driver', 'system']) {
          if (cancellationCounts.delete(`${actor}:${riderUserId}`)) {
            clearedCancellationCounters += 1;
          }
        }
      }
    }

    return {
      clearedRideCacheEntries: clearedRideIds.length,
      clearedCancellationCounters,
      rideIds: clearedRideIds,
    };
  }

  async _cleanupRidesDomain({ rideRows = [], riderIds = [], riderUserIds = [] } = {}) {
    const rideDbIds = unique(rideRows.map((row) => row.dbRideId));
    const summary = { deleted: {} };
    if (!rideDbIds.length && !riderIds.length && !riderUserIds.length) {
      return summary;
    }

    return this.domainDb.withTransaction('rides', async (client) => {
      const dispatchJobIds = await this._selectIds(client, 'dispatch_jobs', 'id', 'ride_id', rideDbIds);
      const supportTicketIds = await this._selectTicketIds(client, rideDbIds, riderUserIds);

      summary.deleted.dispatch_attempts = await this._deleteByIds(client, 'dispatch_attempts', 'dispatch_job_id', dispatchJobIds);
      summary.deleted.dispatch_logs = await this._deleteByIds(client, 'dispatch_logs', 'dispatch_job_id', dispatchJobIds);
      summary.deleted.ticket_escalations = await this._deleteByIds(client, 'ticket_escalations', 'ticket_id', supportTicketIds);
      summary.deleted.ticket_status_history = await this._deleteByIds(client, 'ticket_status_history', 'ticket_id', supportTicketIds);

      await this._deleteAcrossTables(client, summary.deleted, {
        column: 'ride_id',
        ids: rideDbIds,
        type: 'uuid',
        excludeTables: ['rides', 'dispatch_attempts', 'dispatch_logs', 'ticket_escalations', 'ticket_status_history'],
      });
      await this._deleteAcrossTables(client, summary.deleted, {
        column: 'rider_id',
        ids: riderIds,
        type: 'uuid',
        excludeTables: ['rides'],
      });
      await this._deleteAcrossTables(client, summary.deleted, {
        column: 'user_id',
        ids: riderUserIds,
        type: 'uuid',
        excludeTables: [],
      });

      summary.deleted.rides = await this._deleteByIds(client, 'rides', 'id', rideDbIds);
      return summary;
    });
  }

  async _cleanupPaymentsDomain({ riderIds = [], riderUserIds = [] } = {}) {
    const summary = { deleted: {} };
    if (!riderIds.length && !riderUserIds.length) {
      return summary;
    }

    return this.domainDb.withTransaction('payments', async (client) => {
      const walletIds = [
        ...(await this._selectIds(client, 'wallets', 'id', 'user_id', riderUserIds)),
        ...(await this._selectIds(client, 'coin_wallets', 'id', 'user_id', riderUserIds)),
        ...(await this._selectIds(client, 'rider_wallets', 'id', 'rider_id', riderIds)),
      ];

      await this._deleteAcrossTables(client, summary.deleted, {
        column: 'wallet_id',
        ids: walletIds,
        type: 'uuid',
        excludeTables: ['wallets', 'coin_wallets', 'rider_wallets'],
      });
      await this._deleteAcrossTables(client, summary.deleted, {
        column: 'rider_id',
        ids: riderIds,
        type: 'uuid',
        excludeTables: ['rider_wallets'],
      });
      await this._deleteAcrossTables(client, summary.deleted, {
        column: 'user_id',
        ids: riderUserIds,
        type: 'uuid',
        excludeTables: ['wallets', 'coin_wallets'],
      });

      summary.deleted.payment_rider_projection = await this._deleteByIds(client, 'payment_rider_projection', 'user_id', riderUserIds);
      summary.deleted.rider_wallets = await this._deleteByIds(client, 'rider_wallets', 'rider_id', riderIds);
      summary.deleted.coin_wallets = await this._deleteByIds(client, 'coin_wallets', 'user_id', riderUserIds);
      summary.deleted.wallets = await this._deleteByIds(client, 'wallets', 'user_id', riderUserIds);
      return summary;
    });
  }

  async _cleanupSupportDomain({ rideRows = [], riderUserIds = [] } = {}) {
    const rideDbIds = unique(rideRows.map((row) => row.dbRideId));
    const summary = { deleted: {} };
    if (!rideDbIds.length && !riderUserIds.length) {
      return summary;
    }

    return this.domainDb.withTransaction('support', async (client) => {
      const supportTicketIds = await this._selectTicketIds(client, rideDbIds, riderUserIds);

      summary.deleted.support_ticket_read_state = await this._deleteByIds(
        client,
        'support_ticket_read_state',
        'ticket_id',
        supportTicketIds,
      );
      summary.deleted.support_ticket_attachments = await this._deleteByIds(
        client,
        'support_ticket_attachments',
        'ticket_id',
        supportTicketIds,
      );
      summary.deleted.ticket_ratings = await this._deleteByIds(
        client,
        'ticket_ratings',
        'ticket_id',
        supportTicketIds,
      );
      summary.deleted.support_csat = await this._deleteByIds(
        client,
        'support_csat',
        'ticket_id',
        supportTicketIds,
      );
      summary.deleted.ticket_escalations = await this._deleteByIds(
        client,
        'ticket_escalations',
        'ticket_id',
        supportTicketIds,
      );
      summary.deleted.ticket_status_history = await this._deleteByIds(
        client,
        'ticket_status_history',
        'ticket_id',
        supportTicketIds,
      );
      summary.deleted.ticket_messages = await this._deleteByIds(
        client,
        'ticket_messages',
        'ticket_id',
        supportTicketIds,
      );
      summary.deleted.support_ticket_messages = await this._deleteByIds(
        client,
        'support_ticket_messages',
        'ticket_id',
        supportTicketIds,
      );
      summary.deleted.support_tickets = await this._deleteByIds(
        client,
        'support_tickets',
        'id',
        supportTicketIds,
      );
      return summary;
    });
  }

  async _cleanupIdentityDomain({ riderIds = [], riderUserIds = [], phoneNumbers = [] } = {}) {
    const summary = { deleted: {} };
    if (!riderIds.length && !riderUserIds.length && !phoneNumbers.length) {
      return summary;
    }

    return this.domainDb.withTransaction('identity', async (client) => {
      const riderRefs = await this._loadForeignKeyRefs(client, 'riders');
      const userRefs = await this._loadForeignKeyRefs(client, 'users');
      const otpRequestRefs = await this._loadForeignKeyRefs(client, 'otp_requests');
      const otpRequestIds = await this._selectIds(client, 'otp_requests', 'id', 'phone_number', phoneNumbers, 'text');
      const referralCodeIds = await this._selectIds(client, 'referral_codes', 'id', 'user_id', riderUserIds);
      const referralTrackingIds = unique([
        ...(await this._selectIds(client, 'referral_tracking', 'id', 'referral_code_id', referralCodeIds)),
        ...(await this._selectIds(client, 'referral_tracking', 'id', 'referrer_id', riderUserIds)),
        ...(await this._selectIds(client, 'referral_tracking', 'id', 'referee_id', riderUserIds)),
      ]);
      const deviceIds = await this._selectIds(client, 'user_devices', 'id', 'user_id', riderUserIds);
      const deviceRefs = await this._loadForeignKeyRefs(client, 'user_devices');

      summary.deleted.referral_payouts = await this._deleteByIds(
        client,
        'referral_payouts',
        'tracking_id',
        referralTrackingIds,
      );
      summary.deleted.referral_tracking = await this._deleteByIds(
        client,
        'referral_tracking',
        'id',
        referralTrackingIds,
      );
      summary.deleted.referral_codes = await this._deleteByIds(
        client,
        'referral_codes',
        'id',
        referralCodeIds,
      );

      await this._deleteForeignKeyRefs(client, summary.deleted, deviceRefs, deviceIds);
      summary.deleted.user_devices = await this._deleteByIds(client, 'user_devices', 'id', deviceIds);

      await this._deleteForeignKeyRefs(client, summary.deleted, riderRefs, riderIds);
      summary.deleted.riders = await this._deleteByIds(client, 'riders', 'id', riderIds);
      await this._deleteForeignKeyRefs(client, summary.deleted, userRefs, riderUserIds);
      await this._deleteForeignKeyRefs(client, summary.deleted, otpRequestRefs, otpRequestIds);
      summary.deleted.otp_requests = await this._deleteByIds(client, 'otp_requests', 'phone_number', phoneNumbers, 'text');
      summary.deleted.otp_rate_limits = await this._deleteByIds(client, 'otp_rate_limits', 'phone_number', phoneNumbers, 'text');
      summary.deleted.users = await this._deleteByIds(client, 'users', 'id', riderUserIds);
      return summary;
    });
  }

  async _loadForeignKeyRefs(client, referencedTable) {
    const { rows } = await client.query(
      `SELECT DISTINCT
         tc.table_name,
         kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = 'public'
         AND ccu.table_name = $1
       ORDER BY tc.table_name, kcu.column_name`,
      [referencedTable],
    );
    return rows;
  }

  async _deleteForeignKeyRefs(client, summary, refs, ids) {
    for (const ref of refs) {
      summary[ref.table_name] = (summary[ref.table_name] || 0) + await this._deleteByIds(
        client,
        ref.table_name,
        ref.column_name,
        ids,
      );
    }
  }

  async _loadTablesWithColumn(client, column, excludeTables = []) {
    const exclusions = excludeTables.length ? excludeTables : [''];
    const { rows } = await client.query(
      `SELECT table_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name = $1
         AND table_name <> ALL($2::text[])
       ORDER BY table_name`,
      [column, exclusions],
    );
    return rows.map((row) => row.table_name);
  }

  async _resolveColumnInfo(client, table, column, preferredType = null) {
    const key = `${table}:${column}`;
    let baseInfo = this._columnTypeCache.get(key);
    if (!baseInfo) {
      const { rows } = await client.query(
        `SELECT data_type, udt_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = $1
           AND column_name = $2
         LIMIT 1`,
        [table, column],
      );
      if (!rows.length) {
        baseInfo = { exists: false, isUuid: false, actualType: null };
      } else {
        const dataType = rows[0]?.data_type || '';
        const udtName = rows[0]?.udt_name || '';
        const isUuid = dataType === 'uuid' || udtName === 'uuid';
        baseInfo = { exists: true, isUuid, actualType: dataType || udtName || null };
      }
      this._columnTypeCache.set(key, baseInfo);
    }
    let resolvedType = baseInfo.isUuid ? 'uuid' : 'text';
    if (preferredType === 'text') {
      resolvedType = 'text';
    }
    return { ...baseInfo, resolvedType };
  }

  async _deleteAcrossTables(client, summary, { column, ids, type = 'uuid', excludeTables = [] }) {
    const values = unique(ids);
    if (!values.length) return;
    const tables = await this._loadTablesWithColumn(client, column, excludeTables);
    for (const table of tables) {
      summary[table] = (summary[table] || 0) + await this._deleteByIds(client, table, column, values, type);
    }
  }

  async _selectIds(client, table, targetColumn, filterColumn, values, type = 'uuid') {
    const normalizedValues = unique(values);
    if (!normalizedValues.length) return [];
    const columnInfo = await this._resolveColumnInfo(client, table, filterColumn, type);
    if (!columnInfo.exists) return [];
    let resolvedType = columnInfo.resolvedType || type;
    if (resolvedType === 'uuid' && !normalizedValues.every(isUuidLike)) {
      resolvedType = 'text';
    }
    const columnExpr = resolvedType === 'text' && columnInfo.isUuid
      ? `${quoteIdentifier(filterColumn)}::text`
      : quoteIdentifier(filterColumn);
    const { rows } = await client.query(
      `SELECT ${quoteIdentifier(targetColumn)} AS id
       FROM ${quoteIdentifier(table)}
       WHERE ${columnExpr} = ANY($1::${resolvedType}[])`,
      [normalizedValues],
    );
    return unique(rows.map((row) => row.id));
  }

  async _selectTicketIds(client, rideDbIds, riderUserIds) {
    const rides = unique(rideDbIds);
    const users = unique(riderUserIds);
    if (!rides.length && !users.length) return [];

    const { rows } = await client.query(
      `SELECT id
       FROM support_tickets
       WHERE ride_id = ANY($1::uuid[])
          OR user_id = ANY($2::uuid[])`,
      [rides, users],
    );
    return unique(rows.map((row) => row.id));
  }

  async _deleteByIds(client, table, column, values, type = 'uuid') {
    const ids = unique(values);
    if (!ids.length) return 0;
    const columnInfo = await this._resolveColumnInfo(client, table, column, type);
    if (!columnInfo.exists) return 0;
    let resolvedType = columnInfo.resolvedType || type;
    if (resolvedType === 'uuid' && !ids.every(isUuidLike)) {
      resolvedType = 'text';
    }
    const columnExpr = resolvedType === 'text' && columnInfo.isUuid
      ? `${quoteIdentifier(column)}::text`
      : quoteIdentifier(column);
    const { rowCount } = await client.query(
      `DELETE FROM ${quoteIdentifier(table)}
       WHERE ${columnExpr} = ANY($1::${resolvedType}[])`,
      [ids],
    );
    return Number(rowCount || 0);
  }
}

module.exports = new DevResetService();
module.exports.DevResetService = DevResetService;
module.exports.isDevelopmentRuntime = isDevelopmentRuntime;
