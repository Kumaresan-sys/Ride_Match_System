// GoApp Wallet / Coins Service
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

const { logger, eventBus } = require('../utils/logger');

const COIN_INR_VALUE     = parseFloat(process.env.COIN_INR_VALUE    || '0.10');  // ₹ per coin
const COINS_PER_INR_EARN = parseFloat(process.env.COINS_PER_INR_EARN || '10');   // earn 1 coin per ₹10
const MIN_REDEEM_COINS   = parseInt(process.env.MIN_REDEEM_COINS    || '10', 10);
const MAX_REDEEM_PCT     = parseFloat(process.env.MAX_REDEEM_PCT     || '0.20'); // max 20% of fare

class WalletService {
  constructor() {
    // userId -> { coinBalance, cashBalance, transactions[] }
    this.wallets = new Map();
  }

  // ─── Get or create wallet ────────────────────────────────────────────────
  _getWallet(userId) {
    if (!this.wallets.has(userId)) {
      this.wallets.set(userId, {
        userId,
        coinBalance: 0,
        cashBalance: 0,
        transactions: [],
      });
    }
    return this.wallets.get(userId);
  }

  getBalance(userId) {
    const wallet = this._getWallet(userId);
    return {
      userId,
      coinBalance: wallet.coinBalance,
      coinInrValue: COIN_INR_VALUE,
      coinBalanceInr: Math.round(wallet.coinBalance * COIN_INR_VALUE * 100) / 100,
      cashBalance: wallet.cashBalance,
      totalValueInr: Math.round((wallet.coinBalance * COIN_INR_VALUE + wallet.cashBalance) * 100) / 100,
    };
  }

  // ─── Earn coins after trip completion ────────────────────────────────────
  earnCoins(userId, fareInr, rideId) {
    if (!userId || !fareInr || fareInr <= 0) return null;

    const earned = Math.floor(fareInr / COINS_PER_INR_EARN);
    if (earned <= 0) return null;

    const wallet = this._getWallet(userId);
    wallet.coinBalance += earned;

    const tx = {
      txId: `TXN-EARN-${Date.now()}`,
      type: 'coin_earn',
      coins: earned,
      rideId,
      fareInr,
      coinBalanceAfter: wallet.coinBalance,
      cashBalanceAfter: wallet.cashBalance,
      createdAt: new Date().toISOString(),
    };
    wallet.transactions.push(tx);

    eventBus.publish('coins_earned', { userId, coins: earned, rideId, balance: wallet.coinBalance });
    logger.info('WALLET', `User ${userId} earned ${earned} coins (ride ${rideId}). Coin balance: ${wallet.coinBalance}`);

    return tx;
  }

  // ─── Redeem coins (optional during payment) ───────────────────────────────
  // Returns { coinsRedeemed, discountInr, finalFare } or error
  redeemCoins(userId, originalFareInr, coinsToUse) {
    const wallet = this._getWallet(userId);

    if (wallet.coinBalance < MIN_REDEEM_COINS) {
      return { success: false, error: `Minimum ${MIN_REDEEM_COINS} coins required to redeem.`, coinBalance: wallet.coinBalance };
    }

    const maxAllowed = Math.min(
      wallet.coinBalance,
      coinsToUse || wallet.coinBalance,
      Math.floor((originalFareInr * MAX_REDEEM_PCT) / COIN_INR_VALUE)
    );

    if (maxAllowed <= 0) {
      return { success: false, error: 'No eligible coins for this fare.', coinBalance: wallet.coinBalance };
    }

    const discountInr   = Math.round(maxAllowed * COIN_INR_VALUE * 100) / 100;
    const finalFare     = Math.max(0, Math.round((originalFareInr - discountInr) * 100) / 100);

    wallet.coinBalance -= maxAllowed;

    const tx = {
      txId: `TXN-REDEEM-${Date.now()}`,
      type: 'coin_redeem',
      coins: -maxAllowed,
      discountInr,
      originalFare: originalFareInr,
      finalFare,
      coinBalanceAfter: wallet.coinBalance,
      cashBalanceAfter: wallet.cashBalance,
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
      coinBalanceAfter: wallet.coinBalance,
    };
  }

  // ─── Topup cash wallet (rider recharges) ─────────────────────────────────
  topupWallet(userId, amount, method = 'upi', referenceId = null) {
    if (!amount || amount <= 0) {
      return { success: false, error: 'Invalid topup amount.' };
    }
    if (amount > 50000) {
      return { success: false, error: 'Max topup per transaction is ₹50,000.' };
    }

    const wallet = this._getWallet(userId);
    wallet.cashBalance = Math.round((wallet.cashBalance + amount) * 100) / 100;

    const tx = {
      txId: `TXN-TOPUP-${Date.now()}`,
      type: 'cash_topup',
      amountInr: amount,
      method,           // upi, card, netbanking, cash
      referenceId,
      coinBalanceAfter: wallet.coinBalance,
      cashBalanceAfter: wallet.cashBalance,
      createdAt: new Date().toISOString(),
    };
    wallet.transactions.push(tx);

    eventBus.publish('wallet_topup', { userId, amount, method, cashBalance: wallet.cashBalance });
    logger.info('WALLET', `User ${userId} topped up ₹${amount} via ${method}. Cash balance: ₹${wallet.cashBalance}`);

    return {
      success: true,
      transaction: tx,
      cashBalance: wallet.cashBalance,
    };
  }

  // ─── Pay for ride using cash wallet ──────────────────────────────────────
  payWithWallet(userId, fareInr, rideId) {
    if (!fareInr || fareInr <= 0) {
      return { success: false, error: 'Invalid fare amount.' };
    }

    const wallet = this._getWallet(userId);

    if (wallet.cashBalance < fareInr) {
      return {
        success: false,
        error: 'Insufficient wallet balance.',
        cashBalance: wallet.cashBalance,
        required: fareInr,
        shortfall: Math.round((fareInr - wallet.cashBalance) * 100) / 100,
      };
    }

    wallet.cashBalance = Math.round((wallet.cashBalance - fareInr) * 100) / 100;

    const tx = {
      txId: `TXN-PAY-${Date.now()}`,
      type: 'ride_payment',
      amountInr: fareInr,
      rideId,
      coinBalanceAfter: wallet.coinBalance,
      cashBalanceAfter: wallet.cashBalance,
      createdAt: new Date().toISOString(),
    };
    wallet.transactions.push(tx);

    eventBus.publish('wallet_payment', { userId, fareInr, rideId, cashBalance: wallet.cashBalance });
    logger.info('WALLET', `User ${userId} paid ₹${fareInr} for ride ${rideId} via wallet. Cash balance: ₹${wallet.cashBalance}`);

    return {
      success: true,
      transaction: tx,
      cashBalance: wallet.cashBalance,
      amountPaid: fareInr,
    };
  }

  // ─── Refund to cash wallet ────────────────────────────────────────────────
  refundToWallet(userId, amount, rideId, reason = 'ride_cancelled') {
    if (!amount || amount <= 0) return { success: false, error: 'Invalid refund amount.' };

    const wallet = this._getWallet(userId);
    wallet.cashBalance = Math.round((wallet.cashBalance + amount) * 100) / 100;

    const tx = {
      txId: `TXN-REFUND-${Date.now()}`,
      type: 'refund',
      amountInr: amount,
      rideId,
      reason,
      coinBalanceAfter: wallet.coinBalance,
      cashBalanceAfter: wallet.cashBalance,
      createdAt: new Date().toISOString(),
    };
    wallet.transactions.push(tx);

    eventBus.publish('wallet_refund', { userId, amount, rideId, reason });
    logger.info('WALLET', `Refunded ₹${amount} to user ${userId} wallet (${reason}). Cash balance: ₹${wallet.cashBalance}`);

    return { success: true, transaction: tx, cashBalance: wallet.cashBalance };
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
    wallet.transactions.push(tx);
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
    wallet.transactions.push(tx);
    logger.info('WALLET', `Admin adjusted ₹${amount} cash for ${userId} (${reason}). Cash balance: ₹${wallet.cashBalance}`);
    return { success: true, transaction: tx, cashBalance: wallet.cashBalance };
  }

  getTransactions(userId, limit = 20) {
    const wallet = this._getWallet(userId);
    return {
      userId,
      coinBalance: wallet.coinBalance,
      cashBalance: wallet.cashBalance,
      transactions: wallet.transactions.slice(-limit).reverse(),
    };
  }

  getStats() {
    let totalCoins = 0;
    let totalCash = 0;
    let totalUsers = 0;
    this.wallets.forEach(w => {
      totalCoins += w.coinBalance;
      totalCash += w.cashBalance;
      totalUsers++;
    });
    return {
      totalUsers,
      totalCoinsInCirculation: totalCoins,
      totalCashInWallets: Math.round(totalCash * 100) / 100,
      coinInrValue: COIN_INR_VALUE,
    };
  }
}

module.exports = new WalletService();
