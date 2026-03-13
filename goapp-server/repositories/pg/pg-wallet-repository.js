// PostgreSQL-backed Rider Wallet Repository
// Tables: rider_wallets, wallet_transactions
// Used by wallet-service.js when DB_BACKEND=pg

'use strict';

const domainDb = require('../../infra/db/domain-db');
const { logger } = require('../../utils/logger');

class PgWalletRepository {
  constructor() {
    this.coinDriftWarnings = 0;
    this.userCoinPrefsTableExists = null;
    this.enterpriseWalletLedgerExists = null;
  }

  // ─── Ensure wallet row exists ─────────────────────────────────────────────

  _isUuid(value) {
    if (!value) return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));
  }

  async _resolvePaymentRiderId(userId, client = null, { required = false } = {}) {
    const queryText = `SELECT rider_id AS id
                       FROM payment_rider_projection
                       WHERE user_id = $1
                       LIMIT 1`;
    const result = client
      ? await client.query(queryText, [userId])
      : await domainDb.query('payments', queryText, [userId], { role: 'reader' });
    const riderId = result.rows[0]?.id || null;
    if (!riderId && required) {
      const err = new Error(`Rider projection missing for user ${userId}`);
      err.code = 'RIDER_PROJECTION_MISSING';
      throw err;
    }
    return riderId;
  }

  async _ensureWallet(userId) {
    const queries = [
      {
        sql: `INSERT INTO rider_wallets (rider_id)
              SELECT rider_id
              FROM payment_rider_projection
              WHERE user_id = $1
              ON CONFLICT (rider_id) DO NOTHING`,
        values: [userId],
      },
      {
        sql: `INSERT INTO wallets (user_id, balance, promo_balance, currency, status)
              VALUES ($1, 0, 0, 'INR', 'active')
              ON CONFLICT (user_id) DO NOTHING`,
        values: [userId],
      },
      {
        sql: `INSERT INTO coin_wallets (user_id, balance, lifetime_earned, lifetime_redeemed)
              VALUES ($1, 0, 0, 0)
              ON CONFLICT (user_id) DO NOTHING`,
        values: [userId],
      },
    ];

    let lastErr = null;
    let successCount = 0;
    for (const query of queries) {
      try {
        await domainDb.query('payments', query.sql, query.values);
        successCount += 1;
      } catch (err) {
        lastErr = err;
        if (!this._isSchemaCompatibilityError(err)) {
          throw err;
        }
      }
    }
    if (successCount === 0 && lastErr) throw lastErr;
  }

  // ─── Balance ──────────────────────────────────────────────────────────────

  async getBalance(userId) {
    await this._ensureWallet(userId);
    const isEnterpriseLedger = await this._hasEnterpriseWalletLedger();
    const cashBalanceExpr = isEnterpriseLedger
      ? 'COALESCE(NULLIF(w.balance, 0), NULLIF(rw.cash_balance, 0), 0)'
      : 'COALESCE(NULLIF(rw.cash_balance, 0), NULLIF(w.balance, 0), 0)';
    const { rows } = await domainDb.query('payments',
      `SELECT
         COALESCE(cw.balance, rw.coin_balance, 0) AS coin_balance,
         ${cashBalanceExpr} AS cash_balance,
         cw.balance AS coin_wallet_balance,
         rw.coin_balance AS rider_wallet_coin_balance
       FROM (SELECT $1::uuid AS user_id) request_user
       LEFT JOIN coin_wallets cw ON cw.user_id = request_user.user_id
       LEFT JOIN wallets w ON w.user_id = request_user.user_id
       LEFT JOIN payment_rider_projection pr ON pr.user_id = request_user.user_id
       LEFT JOIN rider_wallets rw ON rw.rider_id = pr.rider_id
       LIMIT 1`,
      [userId]
    );
    const row = rows[0] || { coin_balance: 0, cash_balance: 0 };
    if (
      row.coin_wallet_balance != null &&
      row.rider_wallet_coin_balance != null &&
      Number(row.coin_wallet_balance) !== Number(row.rider_wallet_coin_balance)
    ) {
      this.coinDriftWarnings += 1;
      logger.warn(
        'WALLET',
        `metric=wallet.coin_mirror_drift.detected count=${this.coinDriftWarnings} userId=${userId} coin_wallets=${row.coin_wallet_balance} rider_wallets=${row.rider_wallet_coin_balance}`
      );
    }
    return row;
  }

  async getCoinAutoUsePreference(userId) {
    if (!await this._hasUserCoinPreferencesTable()) {
      return false;
    }
    try {
      const { rows } = await domainDb.query('payments', 
        `SELECT auto_use_enabled
         FROM user_coin_preferences
         WHERE user_id = $1
         LIMIT 1`,
        [userId]
      );
      return rows[0]?.auto_use_enabled === true;
    } catch (err) {
      if (!this._isSchemaCompatibilityError(err)) throw err;
      return false;
    }
  }

  async setCoinAutoUsePreference(userId, enabled) {
    if (!await this._hasUserCoinPreferencesTable()) {
      return enabled === true;
    }
    try {
      const { rows } = await domainDb.query('payments', 
        `INSERT INTO user_coin_preferences (user_id, auto_use_enabled)
         VALUES ($1, $2)
         ON CONFLICT (user_id)
         DO UPDATE SET auto_use_enabled = EXCLUDED.auto_use_enabled,
                       updated_at = NOW()
         RETURNING auto_use_enabled`,
        [userId, enabled === true]
      );
      return rows[0]?.auto_use_enabled === true;
    } catch (err) {
      if (!this._isSchemaCompatibilityError(err)) throw err;
      return enabled === true;
    }
  }

  async getCoinPolicy() {
    const defaults = {
      coinInrValue: 0.1,
      coinsPerInrEarn: 10,
      minRedeemCoins: 10,
      maxRedeemPct: 0.2,
    };

    try {
      const { rows } = await domainDb.query('payments', 
        `SELECT config_key, config_value
         FROM coin_config
         WHERE config_key = ANY($1::text[])`,
        [['coin_inr_value', 'coins_per_inr_earn', 'min_redeem_coins', 'max_redeem_pct']]
      );
      const map = new Map(rows.map((row) => [String(row.config_key), String(row.config_value)]));
      return {
        coinInrValue: Number.parseFloat(map.get('coin_inr_value') || String(defaults.coinInrValue)) || defaults.coinInrValue,
        coinsPerInrEarn: Number.parseFloat(map.get('coins_per_inr_earn') || String(defaults.coinsPerInrEarn)) || defaults.coinsPerInrEarn,
        minRedeemCoins: Number.parseInt(map.get('min_redeem_coins') || String(defaults.minRedeemCoins), 10) || defaults.minRedeemCoins,
        maxRedeemPct: Number.parseFloat(map.get('max_redeem_pct') || String(defaults.maxRedeemPct)) || defaults.maxRedeemPct,
      };
    } catch (err) {
      if (!this._isSchemaCompatibilityError(err)) throw err;
      return defaults;
    }
  }

  async getCoinTransactions(userId, page = 1, limit = 20) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    const queries = [
      {
        sql: `SELECT ct.id::text AS "txId",
                     ct.transaction_type AS type,
                     ct.coins,
                     ct.reference_type AS "referenceType",
                     ct.reference_id::text AS "referenceId",
                     ct.description,
                     EXTRACT(EPOCH FROM ct.created_at) * 1000 AS "createdAt"
              FROM coin_transactions ct
              WHERE ct.user_id = $1
              ORDER BY ct.created_at DESC
              LIMIT $2 OFFSET $3`,
        values: [userId, safeLimit, offset],
      },
      {
        sql: `SELECT wt.id::text AS "txId",
                     wt.transaction_type AS type,
                     CASE
                       WHEN wt.transaction_type IN ('coin_redeem', 'coin_debit') THEN -ABS(COALESCE(wt.coins, 0))
                       ELSE ABS(COALESCE(wt.coins, 0))
                     END AS coins,
                     'ride'::text AS "referenceType",
                     wt.reference_id::text AS "referenceId",
                     wt.description,
                     EXTRACT(EPOCH FROM wt.created_at) * 1000 AS "createdAt"
              FROM wallet_transactions wt
              WHERE wt.user_id = $1
                AND COALESCE(wt.coins, 0) <> 0
              ORDER BY wt.created_at DESC
              LIMIT $2 OFFSET $3`,
        values: [userId, safeLimit, offset],
      },
      {
        sql: `SELECT wt.id::text AS "txId",
                     wt.transaction_type AS type,
                     CASE
                       WHEN wt.transaction_type IN ('coin_redeem', 'coin_debit') THEN -ABS(COALESCE(wt.coins, 0))
                       ELSE ABS(COALESCE(wt.coins, 0))
                     END AS coins,
                     'ride'::text AS "referenceType",
                     wt.reference_id::text AS "referenceId",
                     wt.description,
                     EXTRACT(EPOCH FROM wt.created_at) * 1000 AS "createdAt"
              FROM wallet_transactions wt
              JOIN payment_rider_projection pr ON pr.rider_id = wt.rider_id
              WHERE pr.user_id = $1
                AND COALESCE(wt.coins, 0) <> 0
              ORDER BY wt.created_at DESC
              LIMIT $2 OFFSET $3`,
        values: [userId, safeLimit, offset],
      },
    ];
    return this._queryWithSchemaFallback(queries);
  }

  async creditCoins(userId, coins, {
    referenceType = 'referral',
    referenceId = null,
    description = 'Coin credit',
    idempotencyKey = null,
  } = {}) {
    const numericCoins = Math.max(0, Math.floor(Number(coins || 0)));
    if (!numericCoins) {
      return {
        coinBalance: Number((await this.getBalance(userId)).coin_balance || 0),
        coinTransactionId: null,
      };
    }

    const client = await domainDb.getClient('payments');
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO coin_wallets (user_id, balance, lifetime_earned, lifetime_redeemed)
         VALUES ($1, 0, 0, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );

      const { rows: walletRows } = await client.query(
        `SELECT id, balance
         FROM coin_wallets
         WHERE user_id = $1
         FOR UPDATE`,
        [userId],
      );
      const wallet = walletRows[0];
      if (!wallet) {
        throw new Error(`Coin wallet not found for user ${userId}`);
      }

      const balanceBefore = Number(wallet.balance || 0);
      const balanceAfter = balanceBefore + numericCoins;
      const resolvedIdempotencyKey = idempotencyKey || `coin_credit:${userId}:${Date.now()}`;
      const { rows: txRows } = await client.query(
        `INSERT INTO coin_transactions (
           wallet_id,
           user_id,
           transaction_type,
           coins,
           balance_before,
           balance_after,
           reference_type,
           reference_id,
           description,
           idempotency_key
         ) VALUES ($1, $2, 'credit', $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id::text AS "coinTransactionId", balance_after AS "balanceAfter"`,
        [
          wallet.id,
          userId,
          numericCoins,
          balanceBefore,
          balanceAfter,
          referenceType,
          this._isUuid(referenceId) ? referenceId : null,
          description,
          resolvedIdempotencyKey,
        ],
      );

      if (!txRows[0]) {
        const { rows: existingRows } = await client.query(
          `SELECT id::text AS "coinTransactionId",
                  balance_after AS "balanceAfter"
           FROM coin_transactions
           WHERE idempotency_key = $1
           LIMIT 1`,
          [resolvedIdempotencyKey],
        );
        await client.query('COMMIT');
        return {
          coinBalance: Number(existingRows[0]?.balanceAfter || balanceBefore),
          coinTransactionId: existingRows[0]?.coinTransactionId || null,
        };
      }

      const coinTransactionId = txRows[0].coinTransactionId || null;
      const persistedBalanceAfter = Number(txRows[0].balanceAfter || balanceAfter);

      await client.query(
        `UPDATE coin_wallets
         SET balance = $2,
             lifetime_earned = lifetime_earned + $3,
             updated_at = NOW()
         WHERE id = $1`,
        [wallet.id, persistedBalanceAfter, numericCoins],
      );
      await this._syncRiderCoinMirror(client, userId, persistedBalanceAfter);

      await client.query('COMMIT');
      return {
        coinBalance: persistedBalanceAfter,
        coinTransactionId,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── Atomic balance adjustment + transaction log ──────────────────────────

  async adjustAndRecord(userId, { coinDelta = 0, cashDelta = 0 }, tx, options = {}) {
    const idempotencyKey = options.idempotencyKey || tx?.idempotencyKey || null;
    const outboxEvent = options.outboxEvent || tx?.outboxEvent || null;
    const client = await domainDb.getClient('payments');
    try {
      await client.query('BEGIN');

      if (idempotencyKey) {
        const { rows: idemRows } = await client.query(
          `SELECT status, response_payload
           FROM ledger_idempotency
           WHERE domain = 'payments'
             AND idempotency_key = $1
           FOR UPDATE`,
          [idempotencyKey]
        ).catch((err) => {
          if (!this._isSchemaCompatibilityError(err)) throw err;
          return { rows: [] };
        });

        if (idemRows?.length && idemRows[0].status === 'completed' && idemRows[0].response_payload) {
          await client.query('COMMIT');
          return idemRows[0].response_payload;
        }

        if (!idemRows?.length) {
          await client.query(
            `INSERT INTO ledger_idempotency (domain, actor_id, idempotency_key, status)
             VALUES ('payments', $1, $2, 'pending')
             ON CONFLICT (domain, idempotency_key) DO NOTHING`,
            [userId, idempotencyKey]
          ).catch((err) => {
            if (!this._isSchemaCompatibilityError(err)) throw err;
          });
        }
      }
      const walletTxColumns = await this._getSchemaColumns(client, 'wallet_transactions');
      const useEnterpriseWalletLedger =
        walletTxColumns.has('wallet_id') &&
        walletTxColumns.has('balance_before') &&
        walletTxColumns.has('balance_after');

      let coinBalance = 0;
      let cashBalance = 0;
      let walletContext = null;

      if (useEnterpriseWalletLedger) {
        walletContext = await this._adjustEnterpriseWallet(client, userId, cashDelta);
        cashBalance = walletContext.cashBalance;
        if (coinDelta !== 0) {
          coinBalance = await this._adjustCoinWalletIfAvailable(client, userId, coinDelta);
          await this._syncRiderCoinMirror(client, userId, coinBalance);
        }
      } else {
        try {
          const riderBalances = await this._adjustRiderWallet(client, userId, {
            coinDelta: 0,
            cashDelta,
          });
          cashBalance = riderBalances.cashBalance;
          if (coinDelta !== 0) {
            coinBalance = await this._adjustCoinWalletIfAvailable(client, userId, coinDelta);
            await this._syncRiderCoinMirror(client, userId, coinBalance);
          } else {
            coinBalance = riderBalances.coinBalance;
          }
        } catch (err) {
          if (!this._isSchemaCompatibilityError(err)) throw err;
          walletContext = await this._adjustEnterpriseWallet(client, userId, cashDelta);
          cashBalance = walletContext.cashBalance;
          if (coinDelta !== 0) {
            coinBalance = await this._adjustCoinWalletIfAvailable(client, userId, coinDelta);
            await this._syncRiderCoinMirror(client, userId, coinBalance);
          }
        }
      }

      if (coinDelta === 0) {
        const current = await this._getCoinCashSnapshot(client, userId);
        coinBalance = Number(current.coinBalance || 0);
        cashBalance = Number(current.cashBalance || cashBalance || 0);
      }

      await this._insertWalletTransaction(client, {
        userId,
        tx,
        coinDelta,
        cashDelta,
        walletTxColumns,
        walletContext,
      });

      if (outboxEvent) {
        await this._insertOutboxWithClient(client, outboxEvent);
      }

      if (idempotencyKey) {
        await client.query(
          `UPDATE ledger_idempotency
           SET status = 'completed',
               response_payload = $2::jsonb,
               updated_at = NOW()
           WHERE domain = 'payments'
             AND idempotency_key = $1`,
          [idempotencyKey, JSON.stringify({ coinBalance, cashBalance })]
        ).catch((err) => {
          if (!this._isSchemaCompatibilityError(err)) throw err;
        });
      }

      await client.query('COMMIT');
      return { coinBalance, cashBalance };
    } catch (err) {
      if (idempotencyKey) {
        await client.query(
          `UPDATE ledger_idempotency
           SET status = 'failed',
               updated_at = NOW()
           WHERE domain = 'payments'
             AND idempotency_key = $1`,
          [idempotencyKey]
        ).catch(() => {});
      }
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── Transaction history ──────────────────────────────────────────────────

  async getTransactions(userId, limit = 20) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const txCols = await this._getTableColumns('wallet_transactions');
    const rideIdExpr = txCols.has('reference_id')
      ? 'wt.reference_id'
      : txCols.has('ride_id')
        ? 'wt.ride_id'
        : 'NULL';
    const metadataExpr = txCols.has('metadata')
      ? 'wt.metadata'
      : `'{}'::jsonb`;
    const coinsExpr = txCols.has('coins') ? 'wt.coins' : '0';
    const amountExpr = txCols.has('amount') ? 'wt.amount' : '0';

    const relation = this._resolveWalletTxUserRelation(txCols);
    const query = {
      sql: `SELECT wt.id::text AS "txId",
                   wt.transaction_type AS type,
                   ${amountExpr} AS amount,
                   ${coinsExpr} AS coins,
                   ${rideIdExpr} AS "rideId",
                   ${metadataExpr} AS metadata,
                   EXTRACT(EPOCH FROM wt.created_at) * 1000 AS "createdAt"
            FROM wallet_transactions wt
            ${relation.joinClause}
            WHERE ${relation.userWhere}
            ORDER BY wt.created_at DESC
            LIMIT $2`,
      values: [userId, safeLimit],
    };
    const { rows } = await domainDb.query('payments', query.sql, query.values);
    return rows;
  }

  async getLatestRidePaymentInfo(userId, rideId) {
    const txCols = await this._getTableColumns('wallet_transactions');
    const relation = this._resolveWalletTxUserRelation(txCols);
    const rideIdExpr = txCols.has('reference_id')
      ? 'wt.reference_id'
      : txCols.has('ride_id')
        ? 'wt.ride_id'
        : 'NULL';
    const metadataExpr = txCols.has('metadata')
      ? 'wt.metadata'
      : `'{}'::jsonb`;
    const matchByMetadata = txCols.has('metadata');
    const rideMatch = matchByMetadata
      ? `(${rideIdExpr}::text = $2 OR ${metadataExpr}->>'rideId' = $2)`
      : `${rideIdExpr}::text = $2`;

    const { rows } = await domainDb.query('payments', 
      `SELECT wt.id::text AS "txId",
              wt.transaction_type AS type,
              ${rideIdExpr} AS "rideId",
              ${metadataExpr} AS metadata,
              EXTRACT(EPOCH FROM wt.created_at) * 1000 AS "createdAt"
       FROM wallet_transactions wt
       ${relation.joinClause}
       WHERE ${relation.userWhere}
         AND ${rideMatch}
       ORDER BY wt.created_at DESC
       LIMIT 1`,
      [userId, rideId]
    );
    return rows[0] || null;
  }

  async getRidePaymentInfoBatch(userId, rideIds = []) {
    const uniqRideIds = Array.from(new Set((rideIds || []).map((id) => String(id)).filter(Boolean)));
    if (!uniqRideIds.length) return [];

    const txCols = await this._getTableColumns('wallet_transactions');
    const relation = this._resolveWalletTxUserRelation(txCols);
    const metadataExpr = txCols.has('metadata')
      ? 'wt.metadata'
      : `'{}'::jsonb`;

    let rideExpr = `''::text`;
    if (txCols.has('reference_id') && txCols.has('metadata')) {
      rideExpr = `COALESCE(wt.reference_id::text, ${metadataExpr}->>'rideId')`;
    } else if (txCols.has('reference_id')) {
      rideExpr = 'wt.reference_id::text';
    } else if (txCols.has('ride_id')) {
      rideExpr = 'wt.ride_id::text';
    } else if (txCols.has('metadata')) {
      rideExpr = `${metadataExpr}->>'rideId'`;
    } else {
      return [];
    }

    const { rows } = await domainDb.query('payments',
      `SELECT DISTINCT ON (${rideExpr})
              ${rideExpr} AS "rideId",
              wt.id::text AS "txId",
              wt.transaction_type AS type,
              ${metadataExpr} AS metadata,
              EXTRACT(EPOCH FROM wt.created_at) * 1000 AS "createdAt"
       FROM wallet_transactions wt
       ${relation.joinClause}
       WHERE ${relation.userWhere}
         AND ${rideExpr} = ANY($2::text[])
       ORDER BY ${rideExpr}, wt.created_at DESC`,
      [userId, uniqRideIds]
    );

    return rows.filter((row) => row.rideId);
  }

  _resolveWalletTxUserRelation(txCols) {
    if (txCols.has('user_id')) {
      return { joinClause: '', userWhere: 'wt.user_id = $1' };
    }
    if (txCols.has('rider_id')) {
      return {
        joinClause: 'JOIN payment_rider_projection pr ON pr.rider_id = wt.rider_id',
        userWhere: 'pr.user_id = $1',
      };
    }
    if (txCols.has('wallet_id')) {
      return {
        joinClause: 'JOIN wallets w ON w.id = wt.wallet_id',
        userWhere: 'w.user_id = $1',
      };
    }
    throw new Error('wallet_transactions has no supported user-link column');
  }

  async _queryWithSchemaFallback(queries) {
    let lastErr = null;
    for (const query of queries) {
      try {
        const { rows } = await domainDb.query('payments', query.sql, query.values);
        return rows;
      } catch (err) {
        lastErr = err;
        if (!/column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''))) {
          throw err;
        }
      }
    }
    throw lastErr || new Error('Wallet transaction query failed');
  }

  async _getSchemaColumns(client, tableName) {
    const { rows } = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = $1`,
      [tableName]
    );
    return new Set(rows.map((row) => row.column_name));
  }

  async _getTableColumns(tableName) {
    const { rows } = await domainDb.query('payments', 
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = $1`,
      [tableName]
    );
    return new Set(rows.map((row) => row.column_name));
  }

  async _hasUserCoinPreferencesTable() {
    if (this.userCoinPrefsTableExists !== null) {
      return this.userCoinPrefsTableExists;
    }
    try {
      const columns = await this._getTableColumns('user_coin_preferences');
      this.userCoinPrefsTableExists = columns.size > 0;
    } catch (_) {
      this.userCoinPrefsTableExists = false;
    }
    return this.userCoinPrefsTableExists;
  }

  _isSchemaCompatibilityError(err) {
    return /column .* does not exist|relation .* does not exist/i.test(
      String(err?.message || '')
    );
  }

  async _adjustRiderWallet(client, userId, { coinDelta = 0, cashDelta = 0 }) {
    const riderId = await this._resolvePaymentRiderId(userId, client, { required: true });
    await client.query(
      `INSERT INTO rider_wallets (rider_id)
       VALUES ($1)
       ON CONFLICT (rider_id) DO NOTHING`,
      [riderId]
    );

    const { rows } = await client.query(
      `UPDATE rider_wallets SET
         coin_balance = GREATEST(0, coin_balance + $2),
         cash_balance = GREATEST(0, cash_balance + $3),
         updated_at   = NOW()
       WHERE rider_id = $1
       RETURNING coin_balance, cash_balance`,
      [riderId, coinDelta, cashDelta]
    );

    if (!rows.length) throw new Error(`Wallet not found for user ${userId}`);
    return {
      coinBalance: Number(rows[0].coin_balance || 0),
      cashBalance: Number(rows[0].cash_balance || 0),
    };
  }

  async _adjustEnterpriseWallet(client, userId, cashDelta = 0) {
    await client.query(
      `INSERT INTO wallets (user_id, balance, promo_balance, currency, status)
       VALUES ($1, 0, 0, 'INR', 'active')
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    const { rows } = await client.query(
      `SELECT id, balance
       FROM wallets
       WHERE user_id = $1
       FOR UPDATE`,
      [userId]
    );
    if (!rows.length) throw new Error(`Wallet not found for user ${userId}`);

    const walletId = rows[0].id;
    const balanceBefore = Number(rows[0].balance || 0);
    const delta = Number(cashDelta || 0);
    if (delta < 0 && (balanceBefore + delta) < 0) {
      throw new Error(`INSUFFICIENT_BALANCE:${balanceBefore}`);
    }
    const balanceAfter = Math.max(0, balanceBefore + delta);

    await client.query(
      `UPDATE wallets
       SET balance = $2, updated_at = NOW()
       WHERE id = $1`,
      [walletId, balanceAfter]
    );

    return { walletId, balanceBefore, balanceAfter, cashBalance: balanceAfter };
  }

  async _adjustCoinWalletIfAvailable(client, userId, coinDelta = 0) {
    if (!coinDelta) return 0;

    const coinWalletCols = await this._getSchemaColumns(client, 'coin_wallets');
    if (!coinWalletCols.size) {
      throw new Error('coin_wallets table not found for coin wallet operations');
    }

    await client.query(
      `INSERT INTO coin_wallets (user_id, balance, lifetime_earned, lifetime_redeemed)
       VALUES ($1, 0, 0, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    const { rows } = await client.query(
      `UPDATE coin_wallets
       SET balance = GREATEST(0, balance + $2),
           lifetime_earned = lifetime_earned + GREATEST($2, 0),
           lifetime_redeemed = lifetime_redeemed + GREATEST(-$2, 0),
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING balance`,
      [userId, coinDelta]
    );
    return Number(rows[0]?.balance || 0);
  }

  async _getCoinCashSnapshot(client, userId) {
    const isEnterpriseLedger = await this._hasEnterpriseWalletLedger(client);
    const cashBalanceExpr = isEnterpriseLedger
      ? 'COALESCE(NULLIF(w.balance, 0), NULLIF(rw.cash_balance, 0), 0)'
      : 'COALESCE(NULLIF(rw.cash_balance, 0), NULLIF(w.balance, 0), 0)';
    const { rows } = await client.query(
      `SELECT
         COALESCE(cw.balance, rw.coin_balance, 0) AS coin_balance,
         ${cashBalanceExpr} AS cash_balance
       FROM (SELECT $1::uuid AS user_id) request_user
       LEFT JOIN coin_wallets cw ON cw.user_id = request_user.user_id
       LEFT JOIN wallets w ON w.user_id = request_user.user_id
       LEFT JOIN payment_rider_projection pr ON pr.user_id = request_user.user_id
       LEFT JOIN rider_wallets rw ON rw.rider_id = pr.rider_id
       LIMIT 1`,
      [userId]
    );
    return {
      coinBalance: Number(rows[0]?.coin_balance || 0),
      cashBalance: Number(rows[0]?.cash_balance || 0),
    };
  }

  async _hasEnterpriseWalletLedger(client = null) {
    if (this.enterpriseWalletLedgerExists !== null) {
      return this.enterpriseWalletLedgerExists;
    }
    try {
      const columns = client
        ? await this._getSchemaColumns(client, 'wallet_transactions')
        : await this._getTableColumns('wallet_transactions');
      this.enterpriseWalletLedgerExists = (
        columns.has('wallet_id') &&
        columns.has('balance_before') &&
        columns.has('balance_after')
      );
    } catch (_) {
      this.enterpriseWalletLedgerExists = false;
    }
    return this.enterpriseWalletLedgerExists;
  }

  async _syncRiderCoinMirror(client, userId, authoritativeCoinBalance) {
    const riderId = await this._resolvePaymentRiderId(userId, client, { required: true });
    await client.query(
      `INSERT INTO rider_wallets (rider_id, coin_balance, cash_balance)
       VALUES ($1, $2, 0)
       ON CONFLICT (rider_id) DO NOTHING`,
      [riderId, authoritativeCoinBalance]
    );
    const before = await client.query(
      `SELECT rw.coin_balance
       FROM rider_wallets rw
       WHERE rw.rider_id = $1
       FOR UPDATE`,
      [riderId]
    );
    const previous = Number(before.rows[0]?.coin_balance || 0);
    if (Number(previous) !== Number(authoritativeCoinBalance)) {
      this.coinDriftWarnings += 1;
      logger.warn(
        'WALLET',
        `metric=wallet.coin_mirror_drift.detected count=${this.coinDriftWarnings} userId=${userId} before=${previous} after=${authoritativeCoinBalance}`
      );
    }
    await client.query(
      `UPDATE rider_wallets
       SET coin_balance = $2,
           updated_at = NOW()
       WHERE rider_id = $1`,
      [riderId, authoritativeCoinBalance]
    );
  }

  async _insertWalletTransaction(client, {
    userId,
    tx,
    coinDelta = 0,
    cashDelta = 0,
    walletTxColumns,
    walletContext = null,
  }) {
    if (!walletTxColumns?.size) return;

    const txId = String(
      tx?.txId || `TXN-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    );

    if (
      walletTxColumns.has('wallet_id') &&
      walletTxColumns.has('balance_before') &&
      walletTxColumns.has('balance_after')
    ) {
      const txType = this._toEnterpriseTxType(tx?.type);
      const amount = Math.abs(Number(cashDelta || tx?.amountInr || 0));
      const columns = [
        'wallet_id',
        'transaction_type',
        'amount',
        'balance_before',
        'balance_after',
        'reference_type',
        'reference_id',
        'description',
        'idempotency_key',
      ];
      const params = [
        walletContext?.walletId || null,
        txType,
        amount,
        walletContext?.balanceBefore || 0,
        walletContext?.balanceAfter || 0,
        tx?.rideId ? 'ride' : 'wallet',
        this._isUuid(tx?.rideId) ? tx.rideId : null,
        tx?.reason || tx?.type || 'wallet_tx',
        txId,
      ];
      if (walletTxColumns.has('metadata')) {
        columns.push('metadata');
        params.push(JSON.stringify(tx || {}));
      }
      await client.query(
        `INSERT INTO wallet_transactions
           (${columns.join(', ')})
         VALUES (${params.map((_, index) => `$${index + 1}`).join(', ')})`,
        params,
      );
      return;
    }

    const columns = [];
    const values = [];
    const params = [];
    const push = (column, value) => {
      params.push(value);
      columns.push(column);
      values.push(`$${params.length}`);
    };

    if (walletTxColumns.has('rider_id')) {
      const riderId = await this._resolvePaymentRiderId(userId, client, { required: true });
      params.push(riderId);
      columns.push('rider_id');
      values.push(`$${params.length}`);
    } else if (walletTxColumns.has('user_id')) {
      push('user_id', userId);
    } else if (walletTxColumns.has('wallet_id') && walletContext?.walletId) {
      push('wallet_id', walletContext.walletId);
    }

    if (walletTxColumns.has('transaction_type')) {
      push('transaction_type', tx?.type || 'adjustment');
    }
    if (walletTxColumns.has('amount')) {
      push('amount', Math.abs(Number(cashDelta || tx?.amountInr || 0)));
    }
    if (walletTxColumns.has('coins')) {
      push('coins', Math.abs(Number(coinDelta || 0)));
    }
    if (walletTxColumns.has('reference_id')) {
      push('reference_id', this._isUuid(tx?.rideId) ? tx.rideId : null);
    }
    if (walletTxColumns.has('metadata')) {
      push('metadata', JSON.stringify(tx || {}));
    }
    if (walletTxColumns.has('description')) {
      push('description', tx?.reason || tx?.type || 'wallet_tx');
    }
    if (walletTxColumns.has('reference_type')) {
      push('reference_type', tx?.rideId ? 'ride' : 'wallet');
    }
    if (walletTxColumns.has('idempotency_key')) {
      push('idempotency_key', txId);
    }

    if (!columns.length) return;

    await client.query(
      `INSERT INTO wallet_transactions (${columns.join(', ')})
       VALUES (${values.join(', ')})`,
      params
    );
  }

  _toEnterpriseTxType(type) {
    const normalized = String(type || '').toLowerCase();
    if (normalized === 'cash_topup') return 'topup';
    if (normalized === 'ride_payment') return 'ride_payment';
    if (normalized === 'refund') return 'refund';
    return 'adjustment';
  }

  async _insertOutboxWithClient(client, event) {
    await client.query(
      `INSERT INTO outbox_events (
         id,
         domain,
         topic,
         partition_key,
         event_type,
         aggregate_type,
         aggregate_id,
         event_version,
         payload,
         region,
         idempotency_key,
         status,
         available_at,
         created_at,
         updated_at
       ) VALUES (
         gen_random_uuid(),
         'payments',
         $1,
         $2,
         $3,
         $4,
         $5,
         COALESCE($6, 1),
         $7::jsonb,
         COALESCE($8, 'ap-south-1'),
         $9,
         'pending',
         NOW(),
         NOW(),
         NOW()
       )
       ON CONFLICT (domain, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO NOTHING`,
      [
        event.topic,
        event.partitionKey || null,
        event.eventType,
        event.aggregateType,
        event.aggregateId,
        event.version || 1,
        JSON.stringify(event.payload || {}),
        event.region || null,
        event.idempotencyKey || null,
      ]
    );
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  async getStats() {
    const { rows } = await domainDb.query('payments', 
      `SELECT COUNT(*)::int          AS "totalUsers",
              SUM(coin_balance)::int AS "totalCoinsInCirculation",
              SUM(cash_balance)      AS "totalCashInWallets"
       FROM rider_wallets`
    );
    const r = rows[0];
    return {
      totalUsers:                r.totalUsers || 0,
      totalCoinsInCirculation:   r.totalCoinsInCirculation || 0,
      totalCashInWallets:        parseFloat(r.totalCashInWallets || 0).toFixed(2),
    };
  }
}

module.exports = new PgWalletRepository();
