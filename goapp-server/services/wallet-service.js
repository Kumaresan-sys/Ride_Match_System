// GoApp Wallet / Coins Service — PostgreSQL via pg-wallet-repository
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

const { logger, eventBus } = require('../utils/logger');
const config = require('../config');
const notificationService = require('./notification-service');
const pgRepo = require('../repositories/pg/pg-wallet-repository');
const riderTopupRepo = require('../repositories/pg/pg-rider-topup-repository');
const razorpayService = require('./razorpay-service');

class WalletService {
  async _getCoinPolicy() {
    const cfg = config.coins || {};
    const defaults = {
      coinInrValue: Number.parseFloat(cfg.coinInrValue || '0.10') || 0.1,
      coinsPerInrEarn: Number.parseFloat(cfg.coinsPerInrEarn || '10') || 10,
      minRedeemCoins: Number.parseInt(cfg.minRedeemCoins || '10', 10) || 10,
      maxRedeemPct: Number.parseFloat(cfg.maxRedeemPct || '0.20') || 0.2,
    };
    try {
      return {
        ...defaults,
        ...(await pgRepo.getCoinPolicy()),
      };
    } catch (_) {
      return defaults;
    }
  }

  _toClientTx(tx) {
    const amountInr = typeof tx?.amountInr === 'number'
      ? tx.amountInr
      : (typeof tx?.amount === 'number'
        ? tx.amount
        : Number.parseFloat(tx?.amount || tx?.amountInr || 0) || 0);
    const coins = typeof tx?.coins === 'number'
      ? tx.coins
      : (typeof tx?.coinAmount === 'number'
        ? tx.coinAmount
        : Number.parseInt(tx?.coins || tx?.coinAmount || 0, 10) || 0);
    let metadata = {};
    if (tx?.metadata && typeof tx.metadata === 'object') {
      metadata = tx.metadata;
    } else if (typeof tx?.metadata === 'string' && tx.metadata.trim() !== '') {
      try {
        metadata = JSON.parse(tx.metadata);
      } catch (_) {
        metadata = {};
      }
    }
    const createdAtIso = typeof tx?.createdAt === 'number'
      ? new Date(tx.createdAt).toISOString()
      : (typeof tx?.createdAt === 'string' ? tx.createdAt : new Date().toISOString());
    return {
      txId: tx?.txId || tx?.id || metadata.txId || `txn_${Date.now()}`,
      type: tx?.type || metadata.type || 'cash_topup',
      amountInr,
      coins,
      rideId: tx?.rideId || metadata.rideId || null,
      referenceId: tx?.referenceId || metadata.referenceId || tx?.rideId || metadata.rideId || null,
      paymentId: tx?.paymentId || metadata.paymentId || metadata.referenceId || metadata.gatewayReference || null,
      orderId: tx?.orderId || metadata.orderId || null,
      method: tx?.method || metadata.method || metadata.paymentMethod || null,
      provider: tx?.provider || metadata.provider || null,
      gateway: tx?.gateway || metadata.gateway || 'wallet',
      paymentStatus: tx?.paymentStatus || metadata.paymentStatus || 'success',
      reason: tx?.reason || metadata.reason || tx?.description || metadata.description || null,
      serviceType: tx?.serviceType || metadata.serviceType || null,
      createdAt: createdAtIso,
    };
  }

  _paymentInfoFromTx(tx) {
    if (!tx) return null;
    let metadata = {};
    if (tx?.metadata && typeof tx.metadata === 'object') {
      metadata = tx.metadata;
    } else if (typeof tx?.metadata === 'string' && tx.metadata.trim() !== '') {
      try {
        metadata = JSON.parse(tx.metadata);
      } catch (_) {
        metadata = {};
      }
    }
    return {
      paymentTransactionId:
        tx.txId ||
        tx.id ||
        metadata.txId ||
        metadata.paymentId ||
        metadata.referenceId ||
        metadata.gatewayReference ||
        null,
      paymentMethod: tx.method || metadata.method || metadata.paymentMethod || null,
      createdAt: tx.createdAt || null,
    };
  }

  _formatPaymentMethodLabel(method, provider = null) {
    const normalizedMethod = String(method || '').trim().toLowerCase();
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    if (normalizedMethod === 'upi' || normalizedMethod === 'razorpay') {
      switch (normalizedProvider) {
        case 'google_pay':
          return 'UPI • Google Pay';
        case 'phonepe':
          return 'UPI • PhonePe';
        case 'paytm':
          return 'UPI • Paytm';
        case 'bhim':
          return 'UPI • BHIM';
        case 'amazonpay':
          return 'UPI • Amazon Pay';
        default:
          return 'UPI';
      }
    }
    if (normalizedMethod === 'card') return 'Card';
    if (normalizedMethod === 'netbanking') return 'Netbanking';
    if (normalizedMethod === 'wallet') return 'Wallet';
    return normalizedMethod ? normalizedMethod.toUpperCase() : 'Wallet';
  }

  async createRazorpayTopupOrder(userId, amountInr, {
    method = 'upi',
    provider = null,
    requestId = null,
    idempotencyKey = null,
  } = {}) {
    if (!amountInr || amountInr < 1) {
      return { success: false, error: 'amountInr must be ≥ 1' };
    }

    const result = await razorpayService.createOrder({
      amountInr: parseFloat(amountInr),
      userId,
      userType: 'rider',
      receipt: `rider_wallet_${userId}_${Date.now()}`,
      notes: {
        purpose: 'wallet_recharge',
        platform: 'goapp',
        method,
        provider,
      },
    });

    if (!result.success) {
      logger.error('WALLET', `Razorpay top-up order creation failed for user ${userId}: ${result.error}`);
      return result;
    }

    await riderTopupRepo.createTopupRequest({
      userId,
      amountInr,
      method,
      provider,
      orderId: result.orderId,
      receipt: result.receipt,
      requestId,
      idempotencyKey,
      orderResponse: result,
    });

    logger.info('WALLET', `Razorpay top-up order created for user ${userId}`, {
      userId,
      amountInr,
      method,
      provider,
      orderId: result.orderId,
      requestId,
    });

    return result;
  }

  async verifyRazorpayTopup(userId, {
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
    requestId = null,
  }) {
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return {
        success: false,
        error: 'razorpayOrderId, razorpayPaymentId, and razorpaySignature are required',
      };
    }

    const topupRequest = await riderTopupRepo.getTopupRequestByOrderId(razorpayOrderId);
    if (!topupRequest) {
      return { success: false, error: 'Top-up order not found.' };
    }
    if (String(topupRequest.userId) !== String(userId)) {
      return { success: false, error: 'Forbidden: cannot verify payment for another user.' };
    }

    const signatureValid = razorpayService.verifyPaymentSignature({
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });
    if (!signatureValid) {
      await riderTopupRepo.markTopupFailed({
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        source: 'client_verify',
        requestId,
        failureReason: 'Payment signature verification failed.',
        failurePayload: {
          orderId: razorpayOrderId,
          paymentId: razorpayPaymentId,
        },
      });
      logger.warn('WALLET', `Razorpay top-up signature mismatch for user ${userId}`, {
        userId,
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        requestId,
      });
      return {
        success: false,
        error: 'Payment signature verification failed. Do not credit this payment.',
      };
    }

    const method = topupRequest.method || 'upi';
    const provider = topupRequest.provider || null;
    const methodLabel = this._formatPaymentMethodLabel(method, provider);
    const topup = await this.topupWallet(
      userId,
      Number(topupRequest.amountInr || 0),
      methodLabel,
      razorpayPaymentId,
      `rzp_rider_verify:${razorpayPaymentId}`,
      {
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        provider,
        gateway: 'razorpay',
        paymentStatus: 'success',
        reason: `Wallet top-up via ${methodLabel}`,
        topupRequestId: topupRequest.topupRequestId,
      }
    );
    if (!topup.success) {
      return topup;
    }

    await riderTopupRepo.markTopupCompleted({
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      signature: razorpaySignature,
      provider,
      source: 'client_verify',
      requestId,
      verificationPayload: {
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
      },
    });

    logger.success('WALLET', `Razorpay top-up verified for user ${userId}`, {
      userId,
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      amountInr: Number(topupRequest.amountInr || 0),
      cashBalance: topup.cashBalance,
      requestId,
    });

    return {
      success: true,
      message: `₹${Number(topupRequest.amountInr || 0)} credited to your wallet`,
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      amountInr: Number(topupRequest.amountInr || 0),
      wallet: topup,
    };
  }

  async processRazorpayWebhook(event, {
    signature = null,
    requestId = null,
  } = {}) {
    const eventName = event?.event || '';
    const payment = event?.payload?.payment?.entity || null;
    const orderId = payment?.order_id || null;
    const paymentId = payment?.id || null;
    const gatewayEventId = event?.id || paymentId || `${eventName}:${orderId || 'na'}`;

    const webhook = await riderTopupRepo.recordWebhook({
      gatewayEventId,
      eventType: eventName,
      payload: event,
      signature,
      isVerified: true,
      referenceType: 'rider_topup',
      referenceId: orderId,
    });

    if (webhook.duplicate && webhook.isProcessed) {
      return { handled: true, duplicate: true, eventName, orderId, paymentId };
    }

    if (!orderId) {
      await riderTopupRepo.finalizeWebhook({
        webhookId: webhook.webhookId,
        success: true,
        processedResult: { handled: false, reason: 'missing_order_id' },
      });
      return { handled: false, duplicate: false, eventName, reason: 'missing_order_id' };
    }

    const topupRequest = await riderTopupRepo.getTopupRequestByOrderId(orderId);
    if (!topupRequest) {
      await riderTopupRepo.finalizeWebhook({
        webhookId: webhook.webhookId,
        success: true,
        processedResult: { handled: false, reason: 'topup_order_not_found', orderId },
      });
      return { handled: false, duplicate: webhook.duplicate, eventName, orderId, reason: 'topup_order_not_found' };
    }

    if (eventName === 'payment.failed') {
      await riderTopupRepo.markTopupFailed({
        orderId,
        paymentId,
        source: 'webhook',
        requestId,
        failureReason: payment?.error_description || payment?.error_reason || 'Payment failed at gateway.',
        failurePayload: event,
      });
      await riderTopupRepo.finalizeWebhook({
        webhookId: webhook.webhookId,
        success: true,
        processedResult: { handled: true, status: 'failed', orderId, paymentId },
      });
      logger.warn('WALLET', `Razorpay webhook marked top-up failed for user ${topupRequest.userId}`, {
        userId: topupRequest.userId,
        orderId,
        paymentId,
        eventName,
        requestId,
      });
      return { handled: true, duplicate: webhook.duplicate, eventName, orderId, paymentId, status: 'failed' };
    }

    if (eventName !== 'payment.captured' && eventName !== 'payment.authorized') {
      await riderTopupRepo.finalizeWebhook({
        webhookId: webhook.webhookId,
        success: true,
        processedResult: { handled: false, reason: 'unsupported_event', eventName, orderId },
      });
      return { handled: false, duplicate: webhook.duplicate, eventName, orderId, reason: 'unsupported_event' };
    }

    const method = topupRequest.method || 'upi';
    const provider = topupRequest.provider || null;
    const methodLabel = this._formatPaymentMethodLabel(method, provider);
    const topup = await this.topupWallet(
      topupRequest.userId,
      Number(topupRequest.amountInr || 0),
      methodLabel,
      paymentId,
      `rzp_rider_verify:${paymentId}`,
      {
        orderId,
        paymentId,
        provider,
        gateway: 'razorpay',
        paymentStatus: 'success',
        reason: `Wallet top-up via ${methodLabel}`,
        topupRequestId: topupRequest.topupRequestId,
      }
    );
    if (!topup.success) {
      await riderTopupRepo.finalizeWebhook({
        webhookId: webhook.webhookId,
        success: false,
        errorMessage: topup.error || 'Wallet credit failed during webhook processing.',
      });
      return {
        handled: true,
        duplicate: webhook.duplicate,
        eventName,
        orderId,
        paymentId,
        status: 'credit_failed',
        error: topup.error || 'Wallet credit failed during webhook processing.',
      };
    }

    await riderTopupRepo.markTopupCompleted({
      orderId,
      paymentId,
      signature: null,
      provider,
      source: 'webhook',
      webhookEventId: gatewayEventId,
      requestId,
      verificationPayload: event,
    });
    await riderTopupRepo.finalizeWebhook({
      webhookId: webhook.webhookId,
      success: true,
      processedResult: {
        handled: true,
        status: 'completed',
        orderId,
        paymentId,
        amountInr: Number(topupRequest.amountInr || 0),
      },
    });

    logger.success('WALLET', `Razorpay webhook credited wallet for user ${topupRequest.userId}`, {
      userId: topupRequest.userId,
      orderId,
      paymentId,
      amountInr: Number(topupRequest.amountInr || 0),
      cashBalance: topup.cashBalance,
      eventName,
      requestId,
    });

    return {
      handled: true,
      duplicate: webhook.duplicate,
      eventName,
      orderId,
      paymentId,
      status: 'completed',
      amountInr: Number(topupRequest.amountInr || 0),
    };
  }

  async getRazorpayTopupOrder(orderId) {
    return riderTopupRepo.getTopupOrderStatus(orderId);
  }

  async getBalance(userId) {
    const policy = await this._getCoinPolicy();
    const row = await pgRepo.getBalance(userId);
    return {
      userId,
      coinBalance:    parseFloat(row.coin_balance || 0),
      coinInrValue:   policy.coinInrValue,
      coinBalanceInr: Math.round(parseFloat(row.coin_balance || 0) * policy.coinInrValue * 100) / 100,
      cashBalance:    parseFloat(row.cash_balance || 0),
      totalValueInr:  Math.round((parseFloat(row.coin_balance || 0) * policy.coinInrValue + parseFloat(row.cash_balance || 0)) * 100) / 100,
    };
  }

  async creditCoins(userId, coins, {
    referenceType = 'referral',
    referenceId = null,
    description = 'Coin credit',
    idempotencyKey = null,
    metadata = {},
  } = {}) {
    const numericCoins = Math.max(0, Math.floor(Number(coins || 0)));
    if (!numericCoins) {
      return {
        success: true,
        coinsCredited: 0,
        coinTransactionId: null,
        coinBalanceAfter: (await this.getBalance(userId)).coinBalance,
      };
    }

    await pgRepo._ensureWallet(userId);
    const result = await pgRepo.creditCoins(userId, numericCoins, {
      referenceType,
      referenceId,
      description,
      idempotencyKey,
    });
    eventBus.publish('coins_credited', {
      userId,
      coins: numericCoins,
      referenceType,
      referenceId,
      metadata,
      balance: result.coinBalance,
    });
    eventBus.publish('wallet_updated', { userId, reason: 'coins_credited' });
    logger.info('WALLET', `User ${userId} credited ${numericCoins} coins`, {
      userId,
      coins: numericCoins,
      referenceType,
      referenceId,
      idempotencyKey,
    });
    return {
      success: true,
      coinsCredited: numericCoins,
      coinTransactionId: result.coinTransactionId,
      coinBalanceAfter: result.coinBalance,
    };
  }

  // ─── Earn coins after trip completion ────────────────────────────────────
  async earnCoins(userId, fareInr, rideId) {
    if (!userId || !fareInr || fareInr <= 0) return null;
    const policy = await this._getCoinPolicy();

    const earned = Math.floor(fareInr / Math.max(policy.coinsPerInrEarn, 1));
    if (earned <= 0) return null;

    const tx = { type: 'coin_earn', coins: earned, rideId, fareInr, createdAt: new Date().toISOString() };

    await pgRepo._ensureWallet(userId);
    const balances = await pgRepo.adjustAndRecord(userId, { coinDelta: earned }, tx);
    eventBus.publish('coins_earned', { userId, coins: earned, rideId, balance: balances.coinBalance });
    eventBus.publish('wallet_updated', { userId, reason: 'coins_earned' });
    logger.info('WALLET', `User ${userId} earned ${earned} coins (ride ${rideId})`);
    return { ...tx, txId: `TXN-EARN-${Date.now()}`, coinBalanceAfter: balances.coinBalance };
  }

  // ─── Redeem coins (optional during payment) ───────────────────────────────
  // Returns { coinsRedeemed, discountInr, finalFare } or error
  async redeemCoins(userId, originalFareInr, coinsToUse) {
    const policy = await this._getCoinPolicy();
    const bal     = await this.getBalance(userId);
    const coinBal = bal.coinBalance;

    if (coinBal < policy.minRedeemCoins) {
      return { success: false, error: `Minimum ${policy.minRedeemCoins} coins required to redeem.`, coinBalance: coinBal };
    }

    const maxAllowed = Math.min(
      coinBal,
      coinsToUse || coinBal,
      Math.floor((originalFareInr * policy.maxRedeemPct) / policy.coinInrValue)
    );

    if (maxAllowed <= 0) {
      return { success: false, error: 'No eligible coins for this fare.', coinBalance: coinBal };
    }

    const discountInr = Math.round(maxAllowed * policy.coinInrValue * 100) / 100;
    const finalFare   = Math.max(0, Math.round((originalFareInr - discountInr) * 100) / 100);
    const tx = { type: 'coin_redeem', coins: -maxAllowed, discountInr, originalFare: originalFareInr, finalFare, createdAt: new Date().toISOString() };

    const balances = await pgRepo.adjustAndRecord(userId, { coinDelta: -maxAllowed }, tx);
    eventBus.publish('coins_redeemed', { userId, coinsRedeemed: maxAllowed, discountInr, finalFare });
    eventBus.publish('wallet_updated', { userId, reason: 'coins_redeemed' });
    logger.info('WALLET', `User ${userId} redeemed ${maxAllowed} coins → ₹${discountInr} off`);
    return { success: true, coinsRedeemed: maxAllowed, discountInr, originalFare: originalFareInr, finalFare, coinBalanceAfter: balances.coinBalance };
  }

  // ─── Topup cash wallet (rider recharges) ─────────────────────────────────
  async topupWallet(userId, amount, method = 'upi', referenceId = null, idempotencyKey = null, details = {}) {
    if (!amount || amount <= 0)  return { success: false, error: 'Invalid topup amount.' };
    if (amount > 50000)          return { success: false, error: 'Max topup per transaction is ₹50,000.' };

    const tx = {
      txId: idempotencyKey ? `wallet_topup:${idempotencyKey}` : `TXN-TOPUP-${Date.now()}`,
      type: 'cash_topup',
      amountInr: amount,
      method,
      referenceId,
      paymentId: details.paymentId || referenceId || null,
      orderId: details.orderId || null,
      provider: details.provider || null,
      gateway: details.gateway || 'wallet',
      paymentStatus: details.paymentStatus || 'success',
      reason: details.reason || `Wallet top-up via ${method}`,
      topupRequestId: details.topupRequestId || null,
      idempotencyKey,
      createdAt: new Date().toISOString(),
    };
    const outboxEnabled = Boolean(config.architecture?.featureFlags?.kafkaOutbox);

    await pgRepo._ensureWallet(userId);
    const balances = await pgRepo.adjustAndRecord(
      userId,
      { cashDelta: amount },
      tx,
      {
        idempotencyKey,
        outboxEvent: outboxEnabled ? {
          topic: 'payment_completed',
          partitionKey: referenceId || userId,
          eventType: 'payment_completed',
          aggregateType: 'wallet',
          aggregateId: userId,
          idempotencyKey: idempotencyKey || referenceId || null,
          payload: {
            userId,
            amountInr: amount,
            method,
            referenceId: referenceId || null,
            orderId: details.orderId || null,
            paymentId: details.paymentId || referenceId || null,
            provider: details.provider || null,
          },
        } : null,
      }
    );
    eventBus.publish('wallet_topup', { userId, amount, method, cashBalance: balances.cashBalance });
    eventBus.publish('wallet_updated', { userId, reason: 'wallet_topup' });
    notificationService.notifyWalletTopup(userId, {
      amount,
      method,
      txId: tx.txId,
    }).catch(() => {});
    logger.info('WALLET', `User ${userId} topped up ₹${amount} via ${method}`, {
      userId,
      amountInr: amount,
      method,
      referenceId,
      orderId: details.orderId || null,
      paymentId: details.paymentId || referenceId || null,
      provider: details.provider || null,
    });
    return { success: true, transaction: tx, cashBalance: balances.cashBalance };
  }

  // ─── Pay for ride using cash wallet ──────────────────────────────────────
  async payWithWallet(userId, fareInr, rideId, paymentId = null, method = null, idempotencyKey = null) {
    if (!fareInr || fareInr <= 0) return { success: false, error: 'Invalid fare amount.' };

    const bal = await this.getBalance(userId);
    if (bal.cashBalance < fareInr) {
      return {
        success: false,
        error: 'Insufficient wallet balance.',
        cashBalance: bal.cashBalance,
        required: fareInr,
        shortfall: Math.round((fareInr - bal.cashBalance) * 100) / 100,
      };
    }
    const tx = {
      txId: idempotencyKey ? `wallet_pay:${idempotencyKey}` : `TXN-PAY-${Date.now()}`,
      type: 'ride_payment',
      amountInr: fareInr,
      rideId,
      paymentId,
      method: method || 'wallet',
      paymentMethod: method || 'wallet',
      idempotencyKey,
      createdAt: new Date().toISOString(),
    };
    const outboxEnabled = Boolean(config.architecture?.featureFlags?.kafkaOutbox);
    let balances;
    try {
      balances = await pgRepo.adjustAndRecord(
        userId,
        { cashDelta: -fareInr },
        tx,
        {
          idempotencyKey,
          outboxEvent: outboxEnabled ? {
            topic: 'payment_completed',
            partitionKey: paymentId || rideId || userId,
            eventType: 'payment_completed',
            aggregateType: 'ride_payment',
            aggregateId: rideId || userId,
            idempotencyKey: idempotencyKey || paymentId || null,
            payload: {
              userId,
              fareInr,
              rideId: rideId || null,
              paymentId: paymentId || null,
              method: method || 'wallet',
            },
          } : null,
        }
      );
    } catch (err) {
      if (String(err.message || '').startsWith('INSUFFICIENT_BALANCE:')) {
        const currentBalance = Number(String(err.message).split(':')[1] || 0);
        return {
          success: false,
          error: 'Insufficient wallet balance.',
          cashBalance: currentBalance,
          required: fareInr,
          shortfall: Math.round((fareInr - currentBalance) * 100) / 100,
        };
      }
      throw err;
    }
    eventBus.publish('wallet_payment', { userId, fareInr, rideId, cashBalance: balances.cashBalance });
    eventBus.publish('wallet_updated', { userId, reason: 'wallet_payment' });
    notificationService.notifyWalletPayment(userId, {
      rideId,
      fareInr,
      txId: tx.txId,
    }).catch(() => {});
    logger.info('WALLET', `User ${userId} paid ₹${fareInr} for ride ${rideId}`);
    return { success: true, transaction: tx, cashBalance: balances.cashBalance, amountPaid: fareInr };
  }

  // ─── Refund to cash wallet ────────────────────────────────────────────────
  async refundToWallet(userId, amount, rideId, reason = 'ride_cancelled', idempotencyKey = null) {
    if (!amount || amount <= 0) return { success: false, error: 'Invalid refund amount.' };

    const tx = {
      txId: idempotencyKey ? `wallet_refund:${idempotencyKey}` : `TXN-REFUND-${Date.now()}`,
      type: 'refund',
      amountInr: amount,
      rideId,
      reason,
      idempotencyKey,
      createdAt: new Date().toISOString(),
    };
    const outboxEnabled = Boolean(config.architecture?.featureFlags?.kafkaOutbox);

    await pgRepo._ensureWallet(userId);
    const balances = await pgRepo.adjustAndRecord(
      userId,
      { cashDelta: amount },
      tx,
      {
        idempotencyKey,
        outboxEvent: outboxEnabled ? {
          topic: 'payment_completed',
          partitionKey: rideId || userId,
          eventType: 'payment_completed',
          aggregateType: 'refund',
          aggregateId: rideId || userId,
          idempotencyKey: idempotencyKey || null,
          payload: {
            userId,
            amountInr: amount,
            rideId: rideId || null,
            reason,
          },
        } : null,
      }
    );
    eventBus.publish('wallet_refund', { userId, amount, rideId, reason });
    eventBus.publish('wallet_updated', { userId, reason: 'wallet_refund' });
    notificationService.notifyWalletRefund(userId, {
      rideId,
      amount,
      reason,
      txId: tx.txId,
    }).catch(() => {});
    logger.info('WALLET', `Refunded ₹${amount} to user ${userId} wallet (${reason})`);
    return { success: true, transaction: tx, cashBalance: balances.cashBalance };
  }

  async getTransactions(userId, limit = 20) {
    const rows = await pgRepo.getTransactions(userId, limit);
    return { userId, transactions: rows.map(row => this._toClientTx(row)) };
  }

  async getCoinsBalance(userId) {
    const [balance, autoUseEnabled, policy] = await Promise.all([
      this.getBalance(userId),
      pgRepo.getCoinAutoUsePreference(userId),
      this._getCoinPolicy(),
    ]);
    return {
      userId,
      totalCoins: Math.max(0, Math.floor(Number(balance.coinBalance || 0))),
      autoUseEnabled,
      conversionRate: policy.coinInrValue,
      maxDiscountPct: policy.maxRedeemPct,
      minRedeemCoins: policy.minRedeemCoins,
    };
  }

  async getCoinsHistory(userId, page = 1, limit = 20) {
    return pgRepo.getCoinTransactions(userId, page, limit);
  }

  async setCoinsAutoUse(userId, enabled) {
    await pgRepo.setCoinAutoUsePreference(userId, enabled === true);
    return this.getCoinsBalance(userId);
  }

  async previewRideDiscount(userId, fareInr, { autoUse = null, requestedCoins = null } = {}) {
    const policy = await this._getCoinPolicy();
    const [balance, autoUseStored] = await Promise.all([
      this.getBalance(userId),
      pgRepo.getCoinAutoUsePreference(userId),
    ]);
    const enabled = autoUse == null ? autoUseStored : autoUse === true;
    const availableCoins = Math.max(0, Math.floor(Number(balance.coinBalance || 0)));
    let appliedCoins = 0;
    if (enabled && fareInr > 0 && availableCoins >= policy.minRedeemCoins) {
      const maxByFare = Math.floor((fareInr * policy.maxRedeemPct) / policy.coinInrValue);
      const requested = requestedCoins == null ? availableCoins : Math.max(0, Math.floor(Number(requestedCoins)));
      appliedCoins = Math.min(availableCoins, maxByFare, requested);
    }
    const coinsDiscountAmount = Math.round(appliedCoins * policy.coinInrValue * 100) / 100;
    const payableFare = Math.max(0, Math.round((Number(fareInr || 0) - coinsDiscountAmount) * 100) / 100);
    return {
      enabled: true,
      autoUseEnabled: enabled,
      conversionRate: policy.coinInrValue,
      maxDiscountPct: policy.maxRedeemPct,
      minRedeemCoins: policy.minRedeemCoins,
      availableCoins,
      appliedCoins,
      coinsDiscountAmount,
      payableFare,
    };
  }

  async getRidePaymentInfo(userId, rideId) {
    if (!userId || !rideId) return null;
    const row = await pgRepo.getLatestRidePaymentInfo(userId, rideId);
    return this._paymentInfoFromTx(row);
  }

  async getRidePaymentInfoBatch(userId, rideIds = []) {
    if (!userId || !Array.isArray(rideIds) || !rideIds.length) return {};
    const rows = await pgRepo.getRidePaymentInfoBatch(userId, rideIds);
    const byRideId = {};
    for (const row of rows) {
      if (!row?.rideId) continue;
      byRideId[String(row.rideId)] = this._paymentInfoFromTx(row);
    }
    return byRideId;
  }

  async getStats() {
    return pgRepo.getStats();
  }
}

module.exports = new WalletService();
