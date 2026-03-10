// GoApp Payment Routes — Razorpay integration
//
// Flow:
//   1. Client calls create-order   → server creates Razorpay order → returns { orderId, amount, keyId }
//   2. Client opens Razorpay Checkout with those fields
//   3. After payment, Razorpay SDK gives client { razorpay_order_id, razorpay_payment_id, razorpay_signature }
//   4. Client calls verify         → server validates HMAC, credits wallet, returns updated balance
//
// All user-facing routes require Bearer session token.

'use strict';

function registerPaymentRoutes(router, ctx) {
  const { services } = ctx;
  const eventBus = ctx.eventBus;
  const razorpay       = services.razorpayService;
  const walletSvc      = services.walletService;
  const driverWalletSvc = services.driverWalletService;
  const requireAuth    = ctx.requireAuth;  // injected helper

  // ═══════════════════════════════════════════════════════════
  // RIDER WALLET — Razorpay recharge
  // ═══════════════════════════════════════════════════════════

  // POST /api/v1/payments/rider/create-order
  // Body: { userId, amountInr }
  // Returns: { orderId, amount (paise), currency, keyId }
  router.register('POST', '/api/v1/payments/rider/create-order', async ({ body, headers }) => {
    const auth = await requireAuth(headers);
    if (auth.error) return auth.error;

    const { userId, amountInr } = body;
    if (!userId) return { status: 400, data: { error: 'userId is required' } };
    if (auth.session.userId !== userId) return { status: 403, data: { error: 'Forbidden: userId must match authenticated user.' } };
    if (!amountInr || amountInr < 1) {
      return { status: 400, data: { error: 'amountInr must be ≥ 1' } };
    }

    const result = await razorpay.createOrder({
      amountInr: parseFloat(amountInr),
      userId,
      userType: 'rider',
      receipt: `rider_${userId}_${Date.now()}`,
      notes: { purpose: 'wallet_recharge', platform: 'goapp' },
    });

    return { status: result.success ? 200 : 400, data: result };
  });

  // POST /api/v1/payments/rider/verify
  // Body: { razorpayOrderId, razorpayPaymentId, razorpaySignature }
  // On success: credits rider's wallet cash balance, returns updated balance
  router.register('POST', '/api/v1/payments/rider/verify', async ({ body, headers }) => {
    const auth = await requireAuth(headers);
    if (auth.error) return auth.error;

    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = body;
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return {
        status: 400,
        data: { error: 'razorpayOrderId, razorpayPaymentId, and razorpaySignature are required' },
      };
    }

    const verification = await razorpay.verifyPayment({
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });

    if (!verification.success) {
      return { status: 400, data: verification };
    }
    if (auth.session.userId !== verification.userId) {
      return { status: 403, data: { error: 'Forbidden: cannot verify payment for another user.' } };
    }

    // Credit rider wallet cash balance
    const topup = await walletSvc.topupWallet(
      verification.userId,
      verification.amountInr,
      'razorpay',
      razorpayPaymentId,
      `rzp_rider_verify:${razorpayPaymentId}`,
    );
    eventBus.publish('payment_processed', {
      userId: verification.userId,
      userType: 'rider',
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      amountInr: verification.amountInr,
    });

    return {
      status: 200,
      data: {
        success:    true,
        message:    `₹${verification.amountInr} credited to your wallet`,
        orderId:    razorpayOrderId,
        paymentId:  razorpayPaymentId,
        amountInr:  verification.amountInr,
        wallet:     topup,
      },
    };
  });

  // ═══════════════════════════════════════════════════════════
  // DRIVER WALLET — Razorpay recharge
  // ═══════════════════════════════════════════════════════════

  // POST /api/v1/payments/driver/create-order
  // Body: { driverId, amountInr }
  router.register('POST', '/api/v1/payments/driver/create-order', async ({ body, headers }) => {
    const auth = await requireAuth(headers);
    if (auth.error) return auth.error;

    const { driverId, amountInr } = body;
    if (!driverId) return { status: 400, data: { error: 'driverId is required' } };
    if (auth.session.userId !== driverId) {
      return { status: 403, data: { error: 'Forbidden: driverId must match authenticated user.' } };
    }
    if (!amountInr || amountInr < 1) {
      return { status: 400, data: { error: 'amountInr must be ≥ 1' } };
    }

    const result = await razorpay.createOrder({
      amountInr: parseFloat(amountInr),
      userId:    driverId,
      userType:  'driver',
      receipt:   `driver_${driverId}_${Date.now()}`,
      notes:     { purpose: 'wallet_recharge', platform: 'goapp_driver' },
    });

    return { status: result.success ? 200 : 400, data: result };
  });

  // POST /api/v1/payments/driver/verify
  // Body: { razorpayOrderId, razorpayPaymentId, razorpaySignature }
  // On success: credits driver wallet, returns updated balance + eligibility
  router.register('POST', '/api/v1/payments/driver/verify', async ({ body, headers }) => {
    const auth = await requireAuth(headers);
    if (auth.error) return auth.error;

    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = body;
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return {
        status: 400,
        data: { error: 'razorpayOrderId, razorpayPaymentId, and razorpaySignature are required' },
      };
    }

    const verification = await razorpay.verifyPayment({
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });

    if (!verification.success) {
      return { status: 400, data: verification };
    }
    if (auth.session.userId !== verification.userId) {
      return { status: 403, data: { error: 'Forbidden: cannot verify payment for another user.' } };
    }

    // Credit driver wallet
    const recharge = await driverWalletSvc.rechargeWallet(
      verification.userId,
      verification.amountInr,
      'razorpay',
      razorpayPaymentId,
      `rzp_driver_verify:${razorpayPaymentId}`,
    );
    eventBus.publish('payment_processed', {
      userId: verification.userId,
      userType: 'driver',
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      amountInr: verification.amountInr,
    });

    // Check updated eligibility (driver needs ≥ ₹300 to receive rides)
    const eligibility = await driverWalletSvc.canReceiveRide(verification.userId);

    return {
      status: 200,
      data: {
        success:     true,
        message:     `₹${verification.amountInr} credited to your driver wallet`,
        orderId:     razorpayOrderId,
        paymentId:   razorpayPaymentId,
        amountInr:   verification.amountInr,
        wallet:      recharge,
        eligibility,
      },
    };
  });

  // ═══════════════════════════════════════════════════════════
  // ORDER STATUS — lookup a pending order
  // ═══════════════════════════════════════════════════════════

  // GET /api/v1/payments/orders/:orderId
  router.register('GET', '/api/v1/payments/orders/:orderId', async ({ pathParams, headers }) => {
    const auth = await requireAuth(headers);
    if (auth.error) return auth.error;

    const order = await razorpay.getOrder(pathParams.orderId);
    if (!order) {
      return { status: 404, data: { error: 'Order not found' } };
    }
    if (auth.session.userId !== order.userId) {
      return { status: 403, data: { error: 'Forbidden: cannot access another user order.' } };
    }
    return { data: order };
  });

  // ═══════════════════════════════════════════════════════════
  // PAYMENT STATS — admin only
  // ═══════════════════════════════════════════════════════════

  // GET /api/v1/admin/payments/stats
  router.register('GET', '/api/v1/admin/payments/stats', async ({ headers }) => {
    const { requireAdmin } = ctx;
    const authErr = requireAdmin(headers);
    if (authErr) return authErr;
    return { data: razorpay.getStats() };
  });
}

module.exports = registerPaymentRoutes;
