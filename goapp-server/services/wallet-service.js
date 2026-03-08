// GoApp Wallet / Coins Service
// DB_BACKEND=mock  → in-memory Maps (zero setup)
// DB_BACKEND=pg    → PostgreSQL via pg-wallet-repository
//
// Rider wallet supports:
//   - Coin wallet: earned from rides, redeemable as discounts
//   - Cash wallet: topup via UPI/Card, pay directly for rides
//
// Coin Rules:
//   - 1 Coin = ₹0.10 discount (configurable via COIN_INR_VALUE env)
//   - Earn rate: 1 coin per ₹10 of ride fare (configurable)
//   - Min coins to redeem: 10 (configurable)
//   - Max redemption per ride: 20% of fare (configurable)
//   - Coins are OPTIONAL — rider must explicitly pass useCoins: true
//
// Cash Wallet Rules:
//   - Rider can topup via UPI/Card/NetBanking
//   - Can pay full ride fare from wallet balance
//   - Admin can credit/debit cash wallet

const config = require('../config');
const { logger, eventBus } = require('../utils/logger');

const USE_PG = config.db.backend === 'pg';
const pgRepo = USE_PG ? require('../repositories/pg/pg-wallet-repository') : null;

const COIN_INR_VALUE     = parseFloat(process.env.COIN_INR_VALUE    || '0.10');
const COINS_PER_INR_EARN = parseFloat(process.env.COINS_PER_INR_EARN || '10');
const MIN_REDEEM_COINS   = parseInt(process.env.MIN_REDEEM_COINS    || '10', 10);
const MAX_REDEEM_PCT     = parseFloat(process.env.MAX_REDEEM_PCT     || '0.20');
const MAX_WALLET_TRANSACTIONS = 100;

class WalletService {
  constructor() {
    this.wallets = new Map(); // userId -> { coinBalance, cashBalance, transactions[] }
  }

  _getWallet(userId) {
    if (!this.wallets.has(userId)) {
      this.wallets.set(userId, { userId, coinBalance: 0, cashBalance: 0, transactions: [] });
    }
    return this.wallets.get(userId);
  }

  _recordTx(wallet, tx) {
    wallet.transactions.push(tx);
    if (wallet.transactions.length > MAX_WALLET_TRANSACTIONS) wallet.transactions.shift();
  }

  async getBalance(userId) {
    if (USE_PG) {
      const row = await pgRepo.getBalance(userId);
      return {
        userId,
        coinBalance:    parseFloat(row.coin_balance || 0),
        coinInrValue:   COIN_INR_VALUE,
        coinBalanceInr: Math.round(parseFloat(row.coin_balance || 0) * COIN_INR_VALUE * 100) / 100,
        cashBalance:    parseFloat(row.cash_balance || 0),
        totalValueInr:  Math.round((parseFloat(row.coin_balance || 0) * COIN_INR_VALUE + parseFloat(row.cash_balance || 0)) * 100) / 100,
      };
    }
    const wallet = this._getWallet(userId);
    return {
      userId,
      coinBalance:    wallet.coinBalance,
      coinInrValue:   COIN_INR_VALUE,
      coinBalanceInr: Math.round(wallet.coinBalance * COIN_INR_VALUE * 100) / 100,
      cashBalance:    wallet.cashBalance,
      totalValueInr:  Math.round((wallet.coinBalance * COIN_INR_VALUE + wallet.cashBalance) * 100) / 100,
    };
  }

  // ─── Earn coins after trip completion ────────────────────────────────────
  async earnCoins(userId, fareInr, rideId) {
    if (!userId || !fareInr || fareInr <= 0) return null;

    const earned = Math.floor(fareInr / COINS_PER_INR_EARN);
    if (earned <= 0) return null;

    const tx = { type: 'coin_earn', coins: earned, rideId, fareInr, createdAt: new Date().toISOString() };

    if (USE_PG) {
      await pgRepo._ensureWallet(userId);
      const balances = await pgRepo.adjustAndRecord(userId, { coinDelta: earned }, tx);
      eventBus.publish('coins_earned', { userId, coins: earned, rideId, balance: balances.coinBalance });
      eventBus.publish('wallet_updated', { userId, reason: 'coins_earned' });
      logger.info('WALLET', `User ${userId} earned ${earned} coins (ride ${rideId})`);
      return { ...tx, txId: `TXN-EARN-${Date.now()}`, coinBalanceAfter: balances.coinBalance };
    }

    const wallet = this._getWallet(userId);
    wallet.coinBalance += earned;
    const fullTx = { txId: `TXN-EARN-${Date.now()}`, ...tx, coinBalanceAfter: wallet.coinBalance, cashBalanceAfter: wallet.cashBalance };
    this._recordTx(wallet, fullTx);
    eventBus.publish('coins_earned', { userId, coins: earned, rideId, balance: wallet.coinBalance });
    eventBus.publish('wallet_updated', { userId, reason: 'coins_earned' });
    logger.info('WALLET', `User ${userId} earned ${earned} coins (ride ${rideId}). Coin balance: ${wallet.coinBalance}`);
    return fullTx;
  }

  // ─── Redeem coins (optional during payment) ───────────────────────────────
  // Returns { coinsRedeemed, discountInr, finalFare } or error
  async redeemCoins(userId, originalFareInr, coinsToUse) {
    const bal     = USE_PG ? await this.getBalance(userId) : null;
    const wallet  = USE_PG ? null : this._getWallet(userId);
    const coinBal = USE_PG ? bal.coinBalance : wallet.coinBalance;

    if (coinBal < MIN_REDEEM_COINS) {
      return { success: false, error: `Minimum ${MIN_REDEEM_COINS} coins required to redeem.`, coinBalance: coinBal };
    }

    const maxAllowed = Math.min(
      coinBal,
      coinsToUse || coinBal,
      Math.floor((originalFareInr * MAX_REDEEM_PCT) / COIN_INR_VALUE)
    );

    if (maxAllowed <= 0) {
      return { success: false, error: 'No eligible coins for this fare.', coinBalance: coinBal };
    }

    const discountInr = Math.round(maxAllowed * COIN_INR_VALUE * 100) / 100;
    const finalFare   = Math.max(0, Math.round((originalFareInr - discountInr) * 100) / 100);
    const tx = { type: 'coin_redeem', coins: -maxAllowed, discountInr, originalFare: originalFareInr, finalFare, createdAt: new Date().toISOString() };

    if (USE_PG) {
      const balances = await pgRepo.adjustAndRecord(userId, { coinDelta: -maxAllowed }, tx);
      eventBus.publish('coins_redeemed', { userId, coinsRedeemed: maxAllowed, discountInr, finalFare });
      eventBus.publish('wallet_updated', { userId, reason: 'coins_redeemed' });
      logger.info('WALLET', `User ${userId} redeemed ${maxAllowed} coins → ₹${discountInr} off`);
      return { success: true, coinsRedeemed: maxAllowed, discountInr, originalFare: originalFareInr, finalFare, coinBalanceAfter: balances.coinBalance };
    }

    wallet.coinBalance -= maxAllowed;
    const fullTx = { txId: `TXN-REDEEM-${Date.now()}`, ...tx, coinBalanceAfter: wallet.coinBalance, cashBalanceAfter: wallet.cashBalance };
    this._recordTx(wallet, fullTx);
    eventBus.publish('coins_redeemed', { userId, coinsRedeemed: maxAllowed, discountInr, finalFare });
    eventBus.publish('wallet_updated', { userId, reason: 'coins_redeemed' });
    logger.info('WALLET', `User ${userId} redeemed ${maxAllowed} coins → ₹${discountInr} off. Final fare: ₹${finalFare}`);
    return { success: true, coinsRedeemed: maxAllowed, discountInr, originalFare: originalFareInr, finalFare, coinBalanceAfter: wallet.coinBalance };
  }

  // ─── Topup cash wallet (rider recharges) ─────────────────────────────────
  async topupWallet(userId, amount, method = 'upi', referenceId = null) {
    if (!amount || amount <= 0)  return { success: false, error: 'Invalid topup amount.' };
    if (amount > 50000)          return { success: false, error: 'Max topup per transaction is ₹50,000.' };

    const tx = { type: 'cash_topup', amountInr: amount, method, referenceId, createdAt: new Date().toISOString() };

    if (USE_PG) {
      await pgRepo._ensureWallet(userId);
      const balances = await pgRepo.adjustAndRecord(userId, { cashDelta: amount }, tx);
      eventBus.publish('wallet_topup', { userId, amount, method, cashBalance: balances.cashBalance });
      eventBus.publish('wallet_updated', { userId, reason: 'wallet_topup' });
      logger.info('WALLET', `User ${userId} topped up ₹${amount} via ${method}`);
      return { success: true, transaction: { txId: `TXN-TOPUP-${Date.now()}`, ...tx }, cashBalance: balances.cashBalance };
    }

    const wallet = this._getWallet(userId);
    wallet.cashBalance = Math.round((wallet.cashBalance + amount) * 100) / 100;
    const fullTx = { txId: `TXN-TOPUP-${Date.now()}`, ...tx, coinBalanceAfter: wallet.coinBalance, cashBalanceAfter: wallet.cashBalance };
    this._recordTx(wallet, fullTx);
    eventBus.publish('wallet_topup', { userId, amount, method, cashBalance: wallet.cashBalance });
    eventBus.publish('wallet_updated', { userId, reason: 'wallet_topup' });
    logger.info('WALLET', `User ${userId} topped up ₹${amount} via ${method}. Cash balance: ₹${wallet.cashBalance}`);
    return { success: true, transaction: fullTx, cashBalance: wallet.cashBalance };
  }

  // ─── Pay for ride using cash wallet ──────────────────────────────────────
  async payWithWallet(userId, fareInr, rideId) {
    if (!fareInr || fareInr <= 0) return { success: false, error: 'Invalid fare amount.' };

    if (USE_PG) {
      const bal = await this.getBalance(userId);
      if (bal.cashBalance < fareInr) {
        return { success: false, error: 'Insufficient wallet balance.', cashBalance: bal.cashBalance, required: fareInr, shortfall: Math.round((fareInr - bal.cashBalance) * 100) / 100 };
      }
      const tx = { type: 'ride_payment', amountInr: fareInr, rideId, createdAt: new Date().toISOString() };
      const balances = await pgRepo.adjustAndRecord(userId, { cashDelta: -fareInr }, tx);
      eventBus.publish('wallet_payment', { userId, fareInr, rideId, cashBalance: balances.cashBalance });
      eventBus.publish('wallet_updated', { userId, reason: 'wallet_payment' });
      logger.info('WALLET', `User ${userId} paid ₹${fareInr} for ride ${rideId}`);
      return { success: true, transaction: { txId: `TXN-PAY-${Date.now()}`, ...tx }, cashBalance: balances.cashBalance, amountPaid: fareInr };
    }

    const wallet = this._getWallet(userId);
    if (wallet.cashBalance < fareInr) {
      return { success: false, error: 'Insufficient wallet balance.', cashBalance: wallet.cashBalance, required: fareInr, shortfall: Math.round((fareInr - wallet.cashBalance) * 100) / 100 };
    }
    wallet.cashBalance = Math.round((wallet.cashBalance - fareInr) * 100) / 100;
    const fullTx = { txId: `TXN-PAY-${Date.now()}`, type: 'ride_payment', amountInr: fareInr, rideId, coinBalanceAfter: wallet.coinBalance, cashBalanceAfter: wallet.cashBalance, createdAt: new Date().toISOString() };
    this._recordTx(wallet, fullTx);
    eventBus.publish('wallet_payment', { userId, fareInr, rideId, cashBalance: wallet.cashBalance });
    eventBus.publish('wallet_updated', { userId, reason: 'wallet_payment' });
    logger.info('WALLET', `User ${userId} paid ₹${fareInr} for ride ${rideId} via wallet. Cash balance: ₹${wallet.cashBalance}`);
    return { success: true, transaction: fullTx, cashBalance: wallet.cashBalance, amountPaid: fareInr };
  }

  // ─── Refund to cash wallet ────────────────────────────────────────────────
  async refundToWallet(userId, amount, rideId, reason = 'ride_cancelled') {
    if (!amount || amount <= 0) return { success: false, error: 'Invalid refund amount.' };

    const tx = { type: 'refund', amountInr: amount, rideId, reason, createdAt: new Date().toISOString() };

    if (USE_PG) {
      await pgRepo._ensureWallet(userId);
      const balances = await pgRepo.adjustAndRecord(userId, { cashDelta: amount }, tx);
      eventBus.publish('wallet_refund', { userId, amount, rideId, reason });
      eventBus.publish('wallet_updated', { userId, reason: 'wallet_refund' });
      logger.info('WALLET', `Refunded ₹${amount} to user ${userId} wallet (${reason})`);
      return { success: true, transaction: { txId: `TXN-REFUND-${Date.now()}`, ...tx }, cashBalance: balances.cashBalance };
    }

    const wallet = this._getWallet(userId);
    wallet.cashBalance = Math.round((wallet.cashBalance + amount) * 100) / 100;
    const fullTx = { txId: `TXN-REFUND-${Date.now()}`, ...tx, coinBalanceAfter: wallet.coinBalance, cashBalanceAfter: wallet.cashBalance };
    this._recordTx(wallet, fullTx);
    eventBus.publish('wallet_refund', { userId, amount, rideId, reason });
    eventBus.publish('wallet_updated', { userId, reason: 'wallet_refund' });
    logger.info('WALLET', `Refunded ₹${amount} to user ${userId} wallet (${reason}). Cash balance: ₹${wallet.cashBalance}`);
    return { success: true, transaction: fullTx, cashBalance: wallet.cashBalance };
  }

  // ─── Admin: credit/debit coins manually ──────────────────────────────────
  adjustCoins(userId, coins, reason) {
    const wallet = this._getWallet(userId);
    wallet.coinBalance = Math.max(0, wallet.coinBalance + coins);

    const tx = {
      txId: `TXN-ADJ-${Date.now()}`,
      type: coins >= 0 ? 'coin_credit' : 'coin_debit',
      coins,
      reason,
      coinBalanceAfter: wallet.coinBalance,
      cashBalanceAfter: wallet.cashBalance,
      createdAt: new Date().toISOString(),
    };
    this._recordTx(wallet, tx);
    logger.info('WALLET', `Admin adjusted ${coins} coins for ${userId} (${reason}). Coin balance: ${wallet.coinBalance}`);
    return { success: true, transaction: tx, coinBalance: wallet.coinBalance };
  }

  // ─── Admin: credit/debit cash balance manually ────────────────────────────
  adjustCash(userId, amount, reason) {
    const wallet = this._getWallet(userId);
    wallet.cashBalance = Math.max(0, Math.round((wallet.cashBalance + amount) * 100) / 100);

    const tx = {
      txId: `TXN-CASHADJ-${Date.now()}`,
      type: amount >= 0 ? 'cash_credit' : 'cash_debit',
      amountInr: amount,
      reason,
      coinBalanceAfter: wallet.coinBalance,
      cashBalanceAfter: wallet.cashBalance,
      createdAt: new Date().toISOString(),
    };
    this._recordTx(wallet, tx);
    logger.info('WALLET', `Admin adjusted ₹${amount} cash for ${userId} (${reason}). Cash balance: ₹${wallet.cashBalance}`);
    return { success: true, transaction: tx, cashBalance: wallet.cashBalance };
  }

  async getTransactions(userId, limit = 20) {
    if (USE_PG) {
      const rows = await pgRepo.getTransactions(userId, limit);
      return { userId, transactions: rows };
    }
    const wallet = this._getWallet(userId);
    return { userId, coinBalance: wallet.coinBalance, cashBalance: wallet.cashBalance, transactions: wallet.transactions.slice(-limit).reverse() };
  }

  async getStats() {
    if (USE_PG) return pgRepo.getStats();
    let totalCoins = 0, totalCash = 0, totalUsers = 0;
    this.wallets.forEach(w => { totalCoins += w.coinBalance; totalCash += w.cashBalance; totalUsers++; });
    return { totalUsers, totalCoinsInCirculation: totalCoins, totalCashInWallets: Math.round(totalCash * 100) / 100, coinInrValue: COIN_INR_VALUE };
  }
}

module.exports = new WalletService();
