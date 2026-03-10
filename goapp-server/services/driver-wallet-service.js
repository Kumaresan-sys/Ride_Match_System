// GoApp Driver Wallet Service — PostgreSQL via pg-driver-wallet-repository
//
// Rules:
//   - Driver must maintain minimum ₹300 balance to receive ride requests
//   - If balance drops below ₹300, driver is blocked from accepting rides
//   - Driver can recharge wallet via UPI/Card/NetBanking
//   - Platform deducts commission from driver wallet after each ride
//   - Admin can credit/debit driver wallet

const { logger, eventBus } = require('../utils/logger');
const pgRepo = require('../repositories/pg/pg-driver-wallet-repository');

const DRIVER_MIN_BALANCE = parseFloat(process.env.DRIVER_MIN_WALLET_BALANCE || '300');

class DriverWalletService {
  // ─── Check if driver can receive rides ───────────────────────────────────
  async canReceiveRide(driverId) {
    const row = await pgRepo.getBalance(driverId);
    const balance = row ? parseFloat(row.balance || 0) : 0;
    const eligible = balance >= DRIVER_MIN_BALANCE;
    return {
      eligible,
      balance,
      minRequired: DRIVER_MIN_BALANCE,
      shortfall: eligible ? 0 : Math.round((DRIVER_MIN_BALANCE - balance) * 100) / 100,
      message: eligible
        ? 'Driver is eligible to receive rides.'
        : `Wallet balance ₹${balance} is below minimum ₹${DRIVER_MIN_BALANCE}. Please recharge to receive rides.`,
    };
  }

  // ─── Get driver wallet balance ────────────────────────────────────────────
  async getBalance(driverId) {
    const row = await pgRepo.getBalance(driverId);
    if (!row) return { driverId, balance: 0, minRequired: DRIVER_MIN_BALANCE, canReceiveRide: false, shortfall: DRIVER_MIN_BALANCE };
    const balance = parseFloat(row.balance || 0);
    return {
      driverId,
      balance,
      minRequired: DRIVER_MIN_BALANCE,
      canReceiveRide: balance >= DRIVER_MIN_BALANCE,
      shortfall: balance < DRIVER_MIN_BALANCE ? Math.round((DRIVER_MIN_BALANCE - balance) * 100) / 100 : 0,
      totalEarned: parseFloat(row.total_earned || 0),
      totalDeducted: parseFloat(row.total_deducted || 0),
    };
  }

  // ─── Recharge driver wallet ───────────────────────────────────────────────
  async rechargeWallet(driverId, amount, method = 'manual', referenceId = null, idempotencyKey = null) {
    if (!amount || amount <= 0) return { success: false, error: 'Invalid recharge amount.' };

    const tx = {
      type: 'wallet_recharge',
      amountInr: amount,
      method,
      referenceId,
      idempotencyKey,
      createdAt: new Date().toISOString(),
    };

    const row = await pgRepo.adjustAndRecord(driverId, amount, tx).catch(err => {
      logger.warn('DRIVER_WALLET', `pg rechargeWallet failed: ${err.message}`);
      return null;
    });
    const balance = row ? parseFloat(row.balance) : 0;

    eventBus.publish('driver_wallet_recharged', { driverId, amount, method, balance });
    logger.info('DRIVER_WALLET', `Driver ${driverId} recharged ₹${amount} via ${method}. Balance: ₹${balance}`);

    if (balance >= DRIVER_MIN_BALANCE) {
      eventBus.publish('driver_ride_eligible', { driverId });
    }

    return {
      success: true,
      transaction: { txId: `DRV-RCH-${Date.now()}`, ...tx },
      balance,
      canReceiveRide: balance >= DRIVER_MIN_BALANCE,
    };
  }

  // ─── Deduct commission/platform fee from driver wallet ───────────────────
  async deductCommission(driverId, amount, rideId, reason = 'platform_commission') {
    if (!amount || amount <= 0) return { success: false, error: 'Invalid deduction amount.' };

    const tx = { type: 'commission_deduction', amountInr: amount, rideId, reason, createdAt: new Date().toISOString() };

    const row = await pgRepo.adjustAndRecord(driverId, -amount, tx).catch(err => {
      logger.warn('DRIVER_WALLET', `pg deductCommission failed: ${err.message}`);
      return null;
    });
    const balance = row ? parseFloat(row.balance) : 0;
    const belowMin = balance < DRIVER_MIN_BALANCE;
    if (belowMin) eventBus.publish('driver_wallet_low', { driverId, balance, minRequired: DRIVER_MIN_BALANCE });
    logger.info('DRIVER_WALLET', `Driver ${driverId} commission ₹${amount} deducted (ride ${rideId})`);
    return { success: true, transaction: { txId: `DRV-COM-${Date.now()}`, ...tx }, balance, canReceiveRide: !belowMin };
  }

  // ─── Credit earnings to driver wallet (ride fare share) ──────────────────
  async creditEarnings(driverId, amount, rideId, reason = 'ride_earnings') {
    if (!amount || amount <= 0) return { success: false, error: 'Invalid earnings amount.' };

    const tx = { type: 'ride_earnings', amountInr: amount, rideId, reason, createdAt: new Date().toISOString() };

    const row = await pgRepo.adjustAndRecord(driverId, amount, tx).catch(err => {
      logger.warn('DRIVER_WALLET', `pg creditEarnings failed: ${err.message}`);
      return null;
    });
    const balance = row ? parseFloat(row.balance) : 0;
    eventBus.publish('driver_earnings_credited', { driverId, amount, rideId, balance });
    logger.info('DRIVER_WALLET', `Driver ${driverId} earned ₹${amount} (ride ${rideId})`);
    return { success: true, transaction: { txId: `DRV-EARN-${Date.now()}`, ...tx }, balance };
  }

  // ─── Atomic ride settlement (commission debit + earnings credit) ─────────
  async settleRidePayout(driverId, { platformFee = 0, earnings = 0, rideId = null } = {}) {
    const debit = Math.max(0, Number(platformFee) || 0);
    const credit = Math.max(0, Number(earnings) || 0);
    if (debit <= 0 && credit <= 0) return { success: true, balance: 0 };

    const row = await pgRepo.settleRidePayoutAtomic(driverId, debit, credit, rideId).catch(err => {
      logger.warn('DRIVER_WALLET', `pg settleRidePayout failed: ${err.message}`);
      return null;
    });
    const balance = row ? parseFloat(row.balance) : 0;

    if (debit > 0) eventBus.publish('driver_commission_debited', { driverId, amount: debit, rideId, balance });
    if (credit > 0) eventBus.publish('driver_earnings_credited', { driverId, amount: credit, rideId, balance });

    return {
      success: true,
      rideId,
      platformFee: debit,
      earnings: credit,
      balance,
      canReceiveRide: balance >= DRIVER_MIN_BALANCE,
    };
  }

  async getTransactions(driverId, limit = 20) {
    const rows = await pgRepo.getTransactions(driverId, Math.max(1, Math.min(Number(limit) || 20, 100)));
    return {
      driverId,
      transactions: (rows || []).map((row) => ({
        type: row.type,
        amountInr: Number(row.amount || 0),
        rideId: row.rideId || null,
        metadata: row.metadata || null,
        createdAt: typeof row.createdAt === 'number'
          ? new Date(row.createdAt).toISOString()
          : (row.createdAt || new Date().toISOString()),
      })),
    };
  }

  // ─── Global stats ─────────────────────────────────────────────────────────
  async getStats() {
    return pgRepo.getStats();
  }
}

module.exports = new DriverWalletService();
