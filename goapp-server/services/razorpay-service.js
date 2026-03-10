// GoApp Razorpay Payment Service
// Handles order creation, payment verification, and webhook processing
// Uses Node's built-in https module — no external SDK required

'use strict';

const crypto = require('crypto');
const https = require('https');
const redis = require('./redis-client');
const { logger, eventBus } = require('../utils/logger');

const ORDER_TTL_SEC = 24 * 3600;

function pendingOrderKey(orderId) {
  return `payment:pending_order:${orderId}`;
}

class RazorpayService {
  constructor() {
    this.keyId = process.env.RAZORPAY_KEY_ID || '';
    this.keySecret = process.env.RAZORPAY_KEY_SECRET || '';
    this.webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    this.currency = 'INR';
    this.enabled = Boolean(this.keyId && this.keySecret);

    this._stats = {
      ordersCreated: 0,
      paymentsVerified: 0,
      paymentsFailed: 0,
      webhooksReceived: 0,
      webhooksInvalid: 0,
      totalCreditedInr: 0,
    };

    if (!this.enabled) {
      logger.warn('RAZORPAY', 'Service disabled — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable payments');
    } else {
      logger.info('RAZORPAY', `Payment service ready (key: ${this.keyId.slice(0, 8)}...)`);
    }
  }

  async _saveOrder(order) {
    await redis.set(pendingOrderKey(order.orderId), JSON.stringify(order), { EX: ORDER_TTL_SEC });
  }

  async _getOrderInternal(orderId) {
    const raw = await redis.get(pendingOrderKey(orderId));
    return raw ? JSON.parse(raw) : null;
  }

  async createOrder({ amountInr, userId, userType, receipt, notes = {} }) {
    if (!this.enabled) {
      return { success: false, error: 'Razorpay is not configured on this server.' };
    }
    if (!amountInr || amountInr < 1) {
      return { success: false, error: 'amountInr must be ≥ 1' };
    }
    if (!userId || !userType) {
      return { success: false, error: 'userId and userType are required' };
    }

    const amountPaise = Math.round(amountInr * 100);
    const receiptId = (receipt || `rcpt_${userType}_${userId}_${Date.now()}`).slice(0, 40);

    const payload = {
      amount: amountPaise,
      currency: this.currency,
      receipt: receiptId,
      notes: { userId, userType, ...notes },
    };

    try {
      const order = await this._apiCall('POST', '/v1/orders', payload);
      const entry = {
        orderId: order.id,
        userId,
        userType,
        amountPaise,
        amountInr,
        receipt: receiptId,
        status: 'created',
        paymentId: null,
        createdAt: Date.now(),
        paidAt: null,
      };

      await this._saveOrder(entry);
      this._stats.ordersCreated += 1;

      logger.success('RAZORPAY', `Order created: ${order.id} | ₹${amountInr} | ${userType} ${userId}`);
      eventBus.publish('payment_order_created', {
        orderId: order.id,
        userId,
        userType,
        amountInr,
      });

      return {
        success: true,
        orderId: order.id,
        amount: amountPaise,
        currency: this.currency,
        keyId: this.keyId,
        receipt: receiptId,
      };
    } catch (err) {
      this._stats.paymentsFailed += 1;
      logger.error('RAZORPAY', `Order creation failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async verifyPayment({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
    if (!this.enabled) {
      return { success: false, error: 'Razorpay is not configured on this server.' };
    }
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return {
        success: false,
        error: 'razorpayOrderId, razorpayPaymentId, and razorpaySignature are required',
      };
    }

    const order = await this._getOrderInternal(razorpayOrderId);
    if (!order) {
      return { success: false, error: 'Order not found or has expired' };
    }
    if (order.status === 'paid') {
      return { success: false, error: 'Order already processed (duplicate verification attempt)' };
    }

    const expectedSig = crypto
      .createHmac('sha256', this.keySecret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');

    let isValid = false;
    try {
      const a = Buffer.from(expectedSig, 'hex');
      const b = Buffer.from(razorpaySignature, 'hex');
      isValid = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (_) {
      isValid = false;
    }

    if (!isValid) {
      this._stats.paymentsFailed += 1;
      logger.warn('RAZORPAY', `Signature mismatch for order ${razorpayOrderId} | payment ${razorpayPaymentId}`);
      eventBus.publish('payment_verification_failed', {
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
      });
      return { success: false, error: 'Payment signature verification failed. Do not credit this payment.' };
    }

    order.status = 'paid';
    order.paymentId = razorpayPaymentId;
    order.paidAt = Date.now();
    await this._saveOrder(order);

    this._stats.paymentsVerified += 1;
    this._stats.totalCreditedInr += order.amountInr;

    logger.success('RAZORPAY', `Payment verified: ${razorpayPaymentId} | ₹${order.amountInr} | ${order.userType} ${order.userId}`);
    eventBus.publish('payment_verified', {
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      userId: order.userId,
      userType: order.userType,
      amountInr: order.amountInr,
    });

    return {
      success: true,
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      userId: order.userId,
      userType: order.userType,
      amountInr: order.amountInr,
    };
  }

  verifyWebhookSignature(rawBody, signature) {
    if (!this.webhookSecret || !signature) return false;

    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');

    try {
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(signature, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (_) {
      return false;
    }
  }

  async getOrder(orderId) {
    const order = await this._getOrderInternal(orderId);
    if (!order) return null;

    const {
      orderId: oid,
      userId,
      userType,
      amountInr,
      status,
      createdAt,
      paidAt,
    } = order;

    return { orderId: oid, userId, userType, amountInr, status, createdAt, paidAt };
  }

  getStats() {
    return {
      enabled: this.enabled,
      keyId: this.enabled ? `${this.keyId.slice(0, 8)}...` : null,
      pendingOrders: null,
      ...this._stats,
    };
  }

  _apiCall(method, path, data) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(data);
      const authB64 = Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');

      const options = {
        hostname: 'api.razorpay.com',
        path,
        method,
        headers: {
          Authorization: `Basic ${authB64}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'GoApp/2.2 Node.js',
        },
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (_) {
            reject(new Error('Invalid JSON from Razorpay API'));
            return;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const msg = parsed?.error?.description || parsed?.error?.code || `HTTP ${res.statusCode}`;
            reject(new Error(msg));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(10_000, () => {
        req.destroy(new Error('Razorpay API request timed out after 10s'));
      });

      req.write(body);
      req.end();
    });
  }
}

module.exports = new RazorpayService();
