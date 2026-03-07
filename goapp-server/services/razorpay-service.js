// GoApp Razorpay Payment Service
// Handles order creation, payment verification, and webhook processing
// Uses Node's built-in https module — no external SDK required

'use strict';

const crypto = require('crypto');
const https  = require('https');
const { logger, eventBus } = require('../utils/logger');

// ─── In-memory order store ────────────────────────────────────────────────────
// Maps orderId → PendingOrder. Evicts oldest when cap is hit.
const pendingOrders = new Map();
const MAX_PENDING_ORDERS = 10_000;

function _storePendingOrder(entry) {
  if (pendingOrders.size >= MAX_PENDING_ORDERS) {
    const firstKey = pendingOrders.keys().next().value;
    pendingOrders.delete(firstKey);
  }
  pendingOrders.set(entry.orderId, entry);
}

// ─── Razorpay Service ─────────────────────────────────────────────────────────
class RazorpayService {
  constructor() {
    this.keyId         = process.env.RAZORPAY_KEY_ID         || '';
    this.keySecret     = process.env.RAZORPAY_KEY_SECRET      || '';
    this.webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET  || '';
    this.currency      = 'INR';
    this.enabled       = Boolean(this.keyId && this.keySecret);

    // Operational counters
    this._stats = {
      ordersCreated:   0,
      paymentsVerified: 0,
      paymentsFailed:  0,
      webhooksReceived: 0,
      webhooksInvalid:  0,
      totalCreditedInr: 0,
    };

    if (!this.enabled) {
      logger.warn('RAZORPAY', 'Service disabled — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable payments');
    } else {
      logger.info('RAZORPAY', `Payment service ready (key: ${this.keyId.slice(0, 8)}...)`);
    }
  }

  // ─── Create Order ─────────────────────────────────────────────────────────
  // Called by both rider-topup and driver-recharge flows.
  //
  // Params:
  //   amountInr  {number}  — exact rupee amount (e.g. 500)
  //   userId     {string}  — rider/driver id
  //   userType   {string}  — 'rider' | 'driver'
  //   receipt    {string?} — unique receipt id (auto-generated if omitted)
  //   notes      {object?} — extra metadata stored with the order
  //
  // Returns { success, orderId, amount (paise), currency, keyId } on success.
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

    const amountPaise = Math.round(amountInr * 100); // Razorpay works in smallest currency unit
    const receiptId   = (receipt || `rcpt_${userType}_${userId}_${Date.now()}`).slice(0, 40);

    const payload = {
      amount:   amountPaise,
      currency: this.currency,
      receipt:  receiptId,
      notes:    { userId, userType, ...notes },
    };

    try {
      const order = await this._apiCall('POST', '/v1/orders', payload);
      const entry = {
        orderId:    order.id,
        userId,
        userType,   // 'rider' | 'driver'
        amountPaise,
        amountInr,
        receipt:    receiptId,
        status:     'created',   // created → paid | failed
        paymentId:  null,
        createdAt:  Date.now(),
        paidAt:     null,
      };
      _storePendingOrder(entry);
      this._stats.ordersCreated++;

      logger.success('RAZORPAY', `Order created: ${order.id} | ₹${amountInr} | ${userType} ${userId}`);
      eventBus.publish('payment_order_created', {
        orderId: order.id, userId, userType, amountInr,
      });

      return {
        success:    true,
        orderId:    order.id,
        amount:     amountPaise,   // paise — needed by Razorpay Checkout SDK
        currency:   this.currency,
        keyId:      this.keyId,    // public key — safe to send to client
        receipt:    receiptId,
      };
    } catch (err) {
      this._stats.paymentsFailed++;
      logger.error('RAZORPAY', `Order creation failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ─── Verify Client-Side Payment ───────────────────────────────────────────
  // Called after the Razorpay Checkout popup completes.
  // The client sends razorpayOrderId, razorpayPaymentId, razorpaySignature.
  //
  // Signature algorithm (from Razorpay docs):
  //   HMAC-SHA256( orderId + "|" + paymentId, keySecret )
  //
  // Returns { success, orderId, paymentId, userId, userType, amountInr } on success.
  verifyPayment({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
    if (!this.enabled) {
      return { success: false, error: 'Razorpay is not configured on this server.' };
    }
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return { success: false, error: 'razorpayOrderId, razorpayPaymentId, and razorpaySignature are required' };
    }

    const order = pendingOrders.get(razorpayOrderId);
    if (!order) {
      return { success: false, error: 'Order not found or has expired' };
    }
    if (order.status === 'paid') {
      return { success: false, error: 'Order already processed (duplicate verification attempt)' };
    }

    // Constant-time HMAC comparison prevents timing attacks
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
      this._stats.paymentsFailed++;
      logger.warn('RAZORPAY', `Signature mismatch for order ${razorpayOrderId} | payment ${razorpayPaymentId}`);
      eventBus.publish('payment_verification_failed', {
        orderId: razorpayOrderId, paymentId: razorpayPaymentId,
      });
      return { success: false, error: 'Payment signature verification failed. Do not credit this payment.' };
    }

    // Mark order as paid (idempotent guard is the status check above)
    order.status    = 'paid';
    order.paymentId = razorpayPaymentId;
    order.paidAt    = Date.now();
    this._stats.paymentsVerified++;
    this._stats.totalCreditedInr += order.amountInr;

    logger.success('RAZORPAY',
      `Payment verified: ${razorpayPaymentId} | ₹${order.amountInr} | ${order.userType} ${order.userId}`);
    eventBus.publish('payment_verified', {
      orderId:   razorpayOrderId,
      paymentId: razorpayPaymentId,
      userId:    order.userId,
      userType:  order.userType,
      amountInr: order.amountInr,
    });

    return {
      success:   true,
      orderId:   razorpayOrderId,
      paymentId: razorpayPaymentId,
      userId:    order.userId,
      userType:  order.userType,
      amountInr: order.amountInr,
    };
  }

  // ─── Verify Webhook Signature ─────────────────────────────────────────────
  // Used by the webhook handler (POST /api/v1/payments/webhook).
  // Razorpay signs the raw request body with the webhook secret.
  //
  // rawBody must be the original Buffer/string — NOT the parsed JSON object.
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

  // ─── Get Order ────────────────────────────────────────────────────────────
  getOrder(orderId) {
    const order = pendingOrders.get(orderId);
    if (!order) return null;
    // Never expose secret data
    const { orderId: oid, userId, userType, amountInr, status, createdAt, paidAt } = order;
    return { orderId: oid, userId, userType, amountInr, status, createdAt, paidAt };
  }

  // ─── Stats ────────────────────────────────────────────────────────────────
  getStats() {
    return {
      enabled:       this.enabled,
      keyId:         this.enabled ? `${this.keyId.slice(0, 8)}...` : null,
      pendingOrders: pendingOrders.size,
      ...this._stats,
    };
  }

  // ─── Internal: Razorpay REST API call ─────────────────────────────────────
  _apiCall(method, path, data) {
    return new Promise((resolve, reject) => {
      const body    = JSON.stringify(data);
      const authB64 = Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');

      const options = {
        hostname: 'api.razorpay.com',
        path,
        method,
        headers: {
          'Authorization':  `Basic ${authB64}`,
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent':     'GoApp/2.2 Node.js',
        },
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch (_) { reject(new Error('Invalid JSON from Razorpay API')); return; }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const msg = parsed?.error?.description || parsed?.error?.code || `HTTP ${res.statusCode}`;
            reject(new Error(msg));
          }
        });
      });

      req.on('error', reject);
      // 10-second timeout — Razorpay API is usually fast
      req.setTimeout(10_000, () => {
        req.destroy(new Error('Razorpay API request timed out after 10s'));
      });

      req.write(body);
      req.end();
    });
  }
}

module.exports = new RazorpayService();
