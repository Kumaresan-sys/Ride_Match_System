'use strict';

const domainDb = require('../../infra/db/domain-db');
const { logger } = require('../../utils/logger');

class PgRiderTopupRepository {
  async _resolveRiderId(userId, client = null, { required = false } = {}) {
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

  async createTopupRequest({
    userId,
    amountInr,
    method,
    provider = null,
    orderId,
    receipt,
    requestId = null,
    idempotencyKey = null,
    orderResponse = {},
  }) {
    const riderId = await this._resolveRiderId(userId, null, { required: true });
    const metadata = {
      gateway: 'razorpay',
      purpose: 'wallet_topup',
      provider,
      requestId,
      receipt,
      idempotencyKey,
    };
    const gatewayResponse = {
      order: orderResponse,
    };

    const { rows } = await domainDb.query(
      'payments',
      `INSERT INTO rider_topup_requests (
         rider_id,
         amount,
         payment_method,
         payment_provider,
         status,
         gateway_order_id,
         gateway_response,
         idempotency_key,
         metadata
       ) VALUES ($1, $2, $3, $4, 'pending', $5, $6::jsonb, $7, $8::jsonb)
       RETURNING
         id::text AS "topupRequestId",
         gateway_order_id AS "orderId"`,
      [
        riderId,
        amountInr,
        method,
        provider,
        orderId,
        JSON.stringify(gatewayResponse),
        idempotencyKey,
        JSON.stringify(metadata),
      ]
    );

    await this.appendWalletAuditLog(userId, {
      action: 'wallet_topup_order_created',
      reason: 'Razorpay wallet top-up order created',
      newValue: {
        topupRequestId: rows[0]?.topupRequestId || null,
        orderId,
        amountInr,
        method,
        provider,
      },
    }).catch((err) => {
      logger.warn('WALLET', `wallet top-up audit log skipped: ${err.message}`);
    });

    return {
      topupRequestId: rows[0]?.topupRequestId || null,
      orderId: rows[0]?.orderId || orderId,
    };
  }

  async getTopupRequestByOrderId(orderId) {
    const { rows } = await domainDb.query(
      'payments',
      `SELECT
         rtr.id::text AS "topupRequestId",
         pr.user_id::text AS "userId",
         rtr.rider_id::text AS "riderId",
         rtr.amount::float8 AS "amountInr",
         rtr.payment_method AS method,
         rtr.payment_provider AS provider,
         rtr.status,
         rtr.gateway_order_id AS "orderId",
         rtr.gateway_payment_id AS "paymentId",
         rtr.gateway_signature AS "gatewaySignature",
         rtr.gateway_reference AS "gatewayReference",
         rtr.failed_reason AS "failedReason",
         rtr.verified_via AS "verifiedVia",
         rtr.last_webhook_event_id AS "lastWebhookEventId",
         rtr.gateway_response AS "gatewayResponse",
         rtr.metadata AS metadata,
         EXTRACT(EPOCH FROM rtr.initiated_at) * 1000 AS "initiatedAt",
         EXTRACT(EPOCH FROM rtr.completed_at) * 1000 AS "completedAt",
         EXTRACT(EPOCH FROM rtr.verified_at) * 1000 AS "verifiedAt"
       FROM rider_topup_requests rtr
       JOIN payment_rider_projection pr ON pr.rider_id = rtr.rider_id
       WHERE rtr.gateway_order_id = $1
       LIMIT 1`,
      [orderId],
      { role: 'reader' }
    );
    return rows[0] || null;
  }

  async getTopupOrderStatus(orderId) {
    const row = await this.getTopupRequestByOrderId(orderId);
    if (!row) return null;
    return {
      orderId: row.orderId,
      userId: row.userId,
      userType: 'rider',
      amountInr: Number(row.amountInr || 0),
      status: row.status,
      createdAt: row.initiatedAt || null,
      paidAt: row.completedAt || row.verifiedAt || null,
      paymentId: row.paymentId || row.gatewayReference || null,
    };
  }

  async markTopupCompleted({
    orderId,
    paymentId,
    signature = null,
    source = 'client_verify',
    webhookEventId = null,
    requestId = null,
    provider = null,
    verificationPayload = {},
  }) {
    const gatewayResponsePatch = {
      verification: verificationPayload,
    };
    const metadataPatch = {
      gateway: 'razorpay',
      orderId,
      paymentId,
      provider,
      paymentStatus: 'success',
      verifiedVia: source,
      lastWebhookEventId: webhookEventId,
      requestId,
    };

    const { rows } = await domainDb.query(
      'payments',
      `UPDATE rider_topup_requests
       SET status = 'completed',
           gateway_payment_id = $2,
           gateway_reference = $2,
           gateway_signature = COALESCE($3, gateway_signature),
           payment_provider = COALESCE($4, payment_provider),
           verified_via = $5,
           verified_at = NOW(),
           completed_at = COALESCE(completed_at, NOW()),
           last_webhook_event_id = COALESCE($6, last_webhook_event_id),
           failed_reason = NULL,
           gateway_response = COALESCE(gateway_response, '{}'::jsonb) || $7::jsonb,
           metadata = COALESCE(metadata, '{}'::jsonb) || $8::jsonb
       WHERE gateway_order_id = $1
       RETURNING
         id::text AS "topupRequestId",
         gateway_order_id AS "orderId",
         gateway_payment_id AS "paymentId"`,
      [
        orderId,
        paymentId,
        signature,
        provider,
        source,
        webhookEventId,
        JSON.stringify(gatewayResponsePatch),
        JSON.stringify(metadataPatch),
      ]
    );

    const updated = rows[0] || null;
    if (updated) {
      const topup = await this.getTopupRequestByOrderId(orderId);
      await this.appendWalletAuditLog(topup?.userId, {
        action: 'wallet_topup_completed',
        reason: `Razorpay wallet top-up completed via ${source}`,
        newValue: {
          topupRequestId: updated.topupRequestId,
          orderId,
          paymentId,
          source,
          provider,
        },
      }).catch((err) => {
        logger.warn('WALLET', `wallet top-up completion audit log skipped: ${err.message}`);
      });
    }

    return updated;
  }

  async markTopupFailed({
    orderId,
    paymentId = null,
    source = 'client_verify',
    requestId = null,
    failureReason,
    failurePayload = {},
  }) {
    const gatewayResponsePatch = {
      failure: failurePayload,
    };
    const metadataPatch = {
      gateway: 'razorpay',
      orderId,
      paymentId,
      paymentStatus: 'failed',
      failedVia: source,
      requestId,
    };

    const { rows } = await domainDb.query(
      'payments',
      `UPDATE rider_topup_requests
       SET status = 'failed',
           gateway_payment_id = COALESCE($2, gateway_payment_id),
           gateway_reference = COALESCE($2, gateway_reference),
           failed_reason = $3,
           verified_via = $4,
           gateway_response = COALESCE(gateway_response, '{}'::jsonb) || $5::jsonb,
           metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb
       WHERE gateway_order_id = $1
       RETURNING id::text AS "topupRequestId"`,
      [
        orderId,
        paymentId,
        failureReason,
        source,
        JSON.stringify(gatewayResponsePatch),
        JSON.stringify(metadataPatch),
      ]
    );

    if (rows[0]) {
      const topup = await this.getTopupRequestByOrderId(orderId);
      await this.appendWalletAuditLog(topup?.userId, {
        action: 'wallet_topup_failed',
        reason: `Razorpay wallet top-up failed via ${source}`,
        newValue: {
          topupRequestId: rows[0].topupRequestId,
          orderId,
          paymentId,
          failureReason,
        },
      }).catch((err) => {
        logger.warn('WALLET', `wallet top-up failure audit log skipped: ${err.message}`);
      });
    }

    return rows[0] || null;
  }

  async recordWebhook({
    gatewayEventId,
    eventType,
    payload,
    signature,
    isVerified,
    referenceType = null,
    referenceId = null,
  }) {
    const insertResult = await domainDb.query(
      'payments',
      `INSERT INTO payment_webhooks (
         gateway,
         gateway_event_id,
         event_type,
         payload,
         signature,
         is_verified,
         reference_type,
         reference_id
       ) VALUES ('razorpay', $1, $2, $3::jsonb, $4, $5, $6, $7)
       ON CONFLICT (gateway, gateway_event_id) DO NOTHING
       RETURNING id::text AS id, is_processed AS "isProcessed"`,
      [
        gatewayEventId,
        eventType,
        JSON.stringify(payload || {}),
        signature || null,
        isVerified === true,
        referenceType,
        referenceId,
      ]
    );

    if (insertResult.rows.length) {
      return {
        webhookId: insertResult.rows[0].id,
        duplicate: false,
        isProcessed: insertResult.rows[0].isProcessed === true,
      };
    }

    const { rows } = await domainDb.query(
      'payments',
      `SELECT id::text AS id, is_processed AS "isProcessed"
       FROM payment_webhooks
       WHERE gateway = 'razorpay'
         AND gateway_event_id = $1
       LIMIT 1`,
      [gatewayEventId],
      { role: 'reader' }
    );

    return {
      webhookId: rows[0]?.id || null,
      duplicate: true,
      isProcessed: rows[0]?.isProcessed === true,
    };
  }

  async finalizeWebhook({
    webhookId,
    success,
    errorMessage = null,
    processedResult = null,
  }) {
    if (!webhookId) return;
    await domainDb.query(
      'payments',
      `UPDATE payment_webhooks
       SET is_processed = $2,
           process_attempts = process_attempts + 1,
           error_message = $3,
           processed_result = COALESCE($4::jsonb, processed_result),
           processed_at = CASE WHEN $2 THEN NOW() ELSE processed_at END
       WHERE id = $1::uuid`,
      [
        webhookId,
        success === true,
        errorMessage,
        processedResult ? JSON.stringify(processedResult) : null,
      ]
    );
  }

  async appendWalletAuditLog(userId, {
    action,
    reason = null,
    oldValue = null,
    newValue = null,
    ipAddress = null,
  }) {
    if (!userId) return;
    const { rows } = await domainDb.query(
      'payments',
      `SELECT id
       FROM wallets
       WHERE user_id = $1
       LIMIT 1`,
      [userId],
      { role: 'reader' }
    );
    const walletId = rows[0]?.id || null;
    if (!walletId) return;

    await domainDb.query(
      'payments',
      `INSERT INTO wallet_audit_logs (
         wallet_id,
         action,
         old_value,
         new_value,
         reason,
         ip_address
       ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)`,
      [
        walletId,
        action,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        reason,
        ipAddress,
      ]
    );
  }
}

module.exports = new PgRiderTopupRepository();
