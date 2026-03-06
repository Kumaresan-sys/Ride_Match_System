// GoApp Wallet / Coins Service
// Each user has a coin balance. Coins can be earned and optionally redeemed
// as a discount during ride payment.
//
// Coin Rules:
//   - 1 Coin = ₹0.10 discount (configurable via COIN_INR_VALUE env)
//   - Earn rate: 1 coin per ₹10 of ride fare (configurable)
//   - Min coins to redeem: 10 (configurable)
//   - Max redemption per ride: 20% of fare (configurable)
//   - Coins are OPTIONAL — rider must explicitly pass useCoins: true

const { logger, eventBus } = require('../utils/logger');

const COIN_INR_VALUE     = parseFloat(process.env.COIN_INR_VALUE    || '0.10');  // ₹ per coin
const COINS_PER_INR_EARN = parseFloat(process.env.COINS_PER_INR_EARN || '10');   // earn 1 coin per ₹10
const MIN_REDEEM_COINS   = parseInt(process.env.MIN_REDEEM_COINS    || '10', 10);
const MAX_REDEEM_PCT     = parseFloat(process.env.MAX_REDEEM_PCT     || '0.20'); // max 20% of fare

class WalletService {
  constructor() {
    // userId -> { balance, transactions[] }
    this.wallets = new Map();
  }

  // ─── Get or create wallet ────────────────────────────────────────────────
  _getWallet(userId) {
    if (!this.wallets.has(userId)) {
      this.wallets.set(userId, { userId, balance: 0, transactions: [] });
    }
    return this.wallets.get(userId);
  }

  getBalance(userId) {
    const wallet = this._getWallet(userId);
    return {
      userId,
      balance: wallet.balance,
      coinInrValue: COIN_INR_VALUE,
      balanceInr: Math.round(wallet.balance * COIN_INR_VALUE * 100) / 100,
    };
  }

  // ─── Earn coins after trip completion ────────────────────────────────────
  earnCoins(userId, fareInr, rideId) {
    if (!userId || !fareInr || fareInr <= 0) return null;

    const earned = Math.floor(fareInr / COINS_PER_INR_EARN);
    if (earned <= 0) return null;

    const wallet = this._getWallet(userId);
    wallet.balance += earned;

    const tx = {
      txId: `TXN-EARN-${Date.now()}`,
      type: 'earn',
      coins: earned,
      rideId,
      fareInr,
      balanceAfter: wallet.balance,
      createdAt: new Date().toISOString(),
    };
    wallet.transactions.push(tx);

    eventBus.publish('coins_earned', { userId, coins: earned, rideId, balance: wallet.balance });
    logger.info('WALLET', `User ${userId} earned ${earned} coins (ride ${rideId}). Balance: ${wallet.balance}`);

    return tx;
  }

  // ─── Redeem coins (optional during payment) ───────────────────────────────
  // Returns { coinsRedeemed, discountInr, finalFare } or error
  redeemCoins(userId, originalFareInr, coinsToUse) {
    const wallet = this._getWallet(userId);

    if (wallet.balance < MIN_REDEEM_COINS) {
      return { success: false, error: `Minimum ${MIN_REDEEM_COINS} coins required to redeem.`, balance: wallet.balance };
    }

    const maxAllowed = Math.min(
      wallet.balance,
      coinsToUse || wallet.balance,
      Math.floor((originalFareInr * MAX_REDEEM_PCT) / COIN_INR_VALUE)
    );

    if (maxAllowed <= 0) {
      return { success: false, error: 'No eligible coins for this fare.', balance: wallet.balance };
    }

    const discountInr   = Math.round(maxAllowed * COIN_INR_VALUE * 100) / 100;
    const finalFare     = Math.max(0, Math.round((originalFareInr - discountInr) * 100) / 100);

    wallet.balance -= maxAllowed;

    const tx = {
      txId: `TXN-REDEEM-${Date.now()}`,
      type: 'redeem',
      coins: -maxAllowed,
      discountInr,
      originalFare: originalFareInr,
      finalFare,
      balanceAfter: wallet.balance,
      createdAt: new Date().toISOString(),
    };
    wallet.transactions.push(tx);

    eventBus.publish('coins_redeemed', { userId, coinsRedeemed: maxAllowed, discountInr, finalFare });
    logger.info('WALLET', `User ${userId} redeemed ${maxAllowed} coins → ₹${discountInr} off. Final fare: ₹${finalFare}`);

    return {
      success: true,
      coinsRedeemed: maxAllowed,
      discountInr,
      originalFare: originalFareInr,
      finalFare,
      balanceAfter: wallet.balance,
    };
  }

  // ─── Admin: credit/debit coins manually ──────────────────────────────────
  adjustCoins(userId, coins, reason) {
    const wallet = this._getWallet(userId);
    wallet.balance = Math.max(0, wallet.balance + coins);

    const tx = {
      txId: `TXN-ADJ-${Date.now()}`,
      type: coins >= 0 ? 'credit' : 'debit',
      coins,
      reason,
      balanceAfter: wallet.balance,
      createdAt: new Date().toISOString(),
    };
    wallet.transactions.push(tx);
    logger.info('WALLET', `Admin adjusted ${coins} coins for ${userId} (${reason}). Balance: ${wallet.balance}`);
    return { success: true, transaction: tx, balance: wallet.balance };
  }

  getTransactions(userId, limit = 20) {
    const wallet = this._getWallet(userId);
    return {
      userId,
      balance: wallet.balance,
      transactions: wallet.transactions.slice(-limit).reverse(),
    };
  }

  getStats() {
    let totalCoins = 0;
    let totalUsers = 0;
    this.wallets.forEach(w => { totalCoins += w.balance; totalUsers++; });
    return { totalUsers, totalCoinsInCirculation: totalCoins, coinInrValue: COIN_INR_VALUE };
  }
}

module.exports = new WalletService();
