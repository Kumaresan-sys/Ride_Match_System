// PostgreSQL-backed Driver Wallet Repository
// Tables: driver_wallets, driver_wallet_transactions
// Used by driver-wallet-service.js when DB_BACKEND=pg

'use strict';

const domainDb = require('../../infra/db/domain-db');

const DRIVER_MIN_BALANCE = parseFloat(process.env.DRIVER_MIN_WALLET_BALANCE || '300');

class PgDriverWalletRepository {
  // Resolve external driverId/userId via payments-domain projection.
  async _resolveDriverDbId(driverId) {
    const { rows } = await domainDb.query(
      'payments',
      `SELECT driver_id AS id
       FROM payment_driver_projection
       WHERE driver_id::text = $1
          OR user_id::text = $1
       LIMIT 1`,
      [driverId]
    );
    return rows[0]?.id || null;
  }

  async _ensureWallet(driverDbId) {
    await domainDb.query(
      'payments',
      `INSERT INTO driver_wallets (driver_id, balance)
       VALUES ($1, 0)
       ON CONFLICT (driver_id) DO NOTHING`,
      [driverDbId]
    );
  }

  // ─── Balance ──────────────────────────────────────────────────────────────

  async getBalance(driverId) {
    const driverDbId = await this._resolveDriverDbId(driverId);
    if (!driverDbId) return null;
    await this._ensureWallet(driverDbId);

    const { rows } = await domainDb.query(
      'payments',
      `SELECT dw.balance, dw.total_earned, dw.total_deducted
       FROM driver_wallets dw WHERE dw.driver_id = $1`,
      [driverDbId]
    );
    return rows[0] || { balance: 0, total_earned: 0, total_deducted: 0 };
  }

  // ─── Atomic adjustment ────────────────────────────────────────────────────

  async adjustAndRecord(driverId, delta, tx) {
    const driverDbId = await this._resolveDriverDbId(driverId);
    if (!driverDbId) throw new Error(`Driver ${driverId} not found in DB`);
    await this._ensureWallet(driverDbId);

    const client = await domainDb.getClient('payments');
    try {
      await client.query('BEGIN');

      const earnedDelta   = delta > 0 ? delta : 0;
      const deductedDelta = delta < 0 ? Math.abs(delta) : 0;

      const { rows } = await client.query(
        `UPDATE driver_wallets SET
           balance        = GREATEST(0, balance + $2),
           total_earned   = total_earned   + $3,
           total_deducted = total_deducted + $4,
           updated_at     = NOW()
         WHERE driver_id = $1
         RETURNING balance, total_earned, total_deducted`,
        [driverDbId, delta, earnedDelta, deductedDelta]
      );

      if (!rows.length) throw new Error(`Wallet not found for driver ${driverId}`);

      await client.query(
        `INSERT INTO driver_wallet_transactions
           (driver_id, transaction_type, amount, ride_id, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          driverDbId,
          tx.type,
          Math.abs(delta),
          tx.rideId || null,
          JSON.stringify(tx),
        ]
      );

      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async settleRidePayoutAtomic(driverId, platformFee, earnings, rideId) {
    const driverDbId = await this._resolveDriverDbId(driverId);
    if (!driverDbId) throw new Error(`Driver ${driverId} not found in DB`);
    await this._ensureWallet(driverDbId);

    const debit = Math.max(0, Number(platformFee) || 0);
    const credit = Math.max(0, Number(earnings) || 0);
    const netDelta = credit - debit;

    const client = await domainDb.getClient('payments');
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `UPDATE driver_wallets SET
           balance        = GREATEST(0, balance + $2),
           total_earned   = total_earned   + $3,
           total_deducted = total_deducted + $4,
           updated_at     = NOW()
         WHERE driver_id = $1
         RETURNING balance, total_earned, total_deducted`,
        [driverDbId, netDelta, credit, debit]
      );

      if (!rows.length) throw new Error(`Wallet not found for driver ${driverId}`);

      if (debit > 0) {
        await client.query(
          `INSERT INTO driver_wallet_transactions
             (driver_id, transaction_type, amount, ride_id, metadata)
           VALUES ($1, 'commission_deduction', $2, $3, $4)`,
          [driverDbId, debit, rideId || null, JSON.stringify({ type: 'commission_deduction', amountInr: debit, rideId })]
        );
      }

      if (credit > 0) {
        await client.query(
          `INSERT INTO driver_wallet_transactions
             (driver_id, transaction_type, amount, ride_id, metadata)
           VALUES ($1, 'ride_earnings', $2, $3, $4)`,
          [driverDbId, credit, rideId || null, JSON.stringify({ type: 'ride_earnings', amountInr: credit, rideId })]
        );
      }

      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── Transaction history ──────────────────────────────────────────────────

  async getTransactions(driverId, limit = 20) {
    const driverDbId = await this._resolveDriverDbId(driverId);
    if (!driverDbId) return [];

    const { rows } = await domainDb.query(
      'payments',
      `SELECT transaction_type AS type, amount, ride_id AS "rideId", metadata,
              EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
       FROM driver_wallet_transactions
       WHERE driver_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [driverDbId, limit]
    );
    return rows;
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  async getStats() {
    const { rows } = await domainDb.query(
      'payments',
      `SELECT COUNT(*)::int                                               AS "totalDrivers",
              COUNT(*) FILTER (WHERE balance < $1)::int                   AS "blockedDrivers",
              COUNT(*) FILTER (WHERE balance >= $1)::int                  AS "eligibleDrivers",
              COALESCE(SUM(balance), 0)                                   AS "totalBalanceInWallets"
       FROM driver_wallets`,
      [DRIVER_MIN_BALANCE]
    );
    return {
      ...rows[0],
      totalBalanceInWallets: parseFloat(rows[0]?.totalBalanceInWallets || 0).toFixed(2),
      minBalanceRequired: DRIVER_MIN_BALANCE,
    };
  }
}

module.exports = new PgDriverWalletRepository();
