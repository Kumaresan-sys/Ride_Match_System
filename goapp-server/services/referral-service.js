'use strict';

const domainDb = require('../infra/db/domain-db');
const pgIdentityRepository = require('../repositories/pg/pg-identity-repository');
const walletService = require('./wallet-service');
const notificationService = require('./notification-service');
const { logger } = require('../utils/logger');

class ReferralService {
  async validateReferralCode(userId, referralCode) {
    return pgIdentityRepository.validateReferralCode({ userId, referralCode });
  }

  async applyReferralCode(userId, referralCode) {
    const applied = await pgIdentityRepository.applyReferralCode({ userId, referralCode });
    const notificationResult = await notificationService.notifyReferralApplied(userId, {
      referralCode: applied.code,
      rewardCoins: applied.rewardCoins,
    }).catch((err) => ({ sent: false, reason: err.message }));

    await pgIdentityRepository.recordReferralEvent({
      trackingId: applied.trackingId,
      eventType: notificationResult?.sent ? 'notification_sent' : 'notification_failed',
      actorUserId: userId,
      metadata: {
        notificationType: 'referral_applied',
        sent: notificationResult?.sent === true,
        reason: notificationResult?.reason || null,
      },
    }).catch(() => {});

    return {
      ...applied,
      notificationSent: notificationResult?.sent === true,
    };
  }

  async getReferralSummary(userId) {
    const ownCode = await pgIdentityRepository.generateOrGetReferralCode(userId);
    const summary = await pgIdentityRepository.getReferralSummary(userId);
    const rewardCoins = Number(summary.rewardCoins || 100);
    const code = ownCode.code || '';
    const description =
      summary.description ||
      `Share your code and earn ${rewardCoins} coins when your friend completes their first ride.`;
    return {
      code,
      rewardCoins,
      description,
      shareMessage:
        summary.shareMessage ||
        `Join GoApp with my referral code ${code}. When you complete your first ride, I get ${rewardCoins} coins.`,
      totalEarnedCoins: summary.totalEarnedCoins,
      totalReferrals: summary.totalReferrals,
      completedReferrals: summary.completedReferrals,
      pendingReferrals: summary.pendingReferrals,
      history: summary.history,
    };
  }

  async processFirstRideReward({ refereeUserId, rideId }) {
    const pendingReferral = await pgIdentityRepository.getPendingReferralForReferee(refereeUserId);
    if (!pendingReferral) {
      return { success: true, rewardIssued: false, skipped: 'no_pending_referral' };
    }

    const completedRideCount = await this._getCompletedRideCount(refereeUserId);
    if (completedRideCount !== 1) {
      return {
        success: true,
        rewardIssued: false,
        skipped: 'not_first_completed_ride',
        completedRideCount,
      };
    }

    const qualification = await pgIdentityRepository.markReferralFirstRideQualified({
      trackingId: pendingReferral.trackingId,
      rideId,
    });
    if (!qualification.qualified) {
      return {
        success: true,
        rewardIssued: false,
        skipped: qualification.reason || 'not_qualified',
      };
    }

    const rewardCoins = Number(pendingReferral.rewardCoins || 100);
    const payoutIdempotencyKey = `referral_reward:${pendingReferral.trackingId}:${rideId}`;
    const refereeName = qualification.refereeName || 'your friend';
    const creditResult = await walletService.creditCoins(
      pendingReferral.referrerId,
      rewardCoins,
      {
        referenceType: 'referral',
        referenceId: pendingReferral.trackingId,
        description: `Referral reward for ${refereeName}'s first ride`,
        idempotencyKey: payoutIdempotencyKey,
        metadata: {
          trackingId: pendingReferral.trackingId,
          rideId: String(rideId || ''),
          refereeUserId,
        },
      },
    );

    await pgIdentityRepository.markReferralRewardIssued({
      trackingId: pendingReferral.trackingId,
      referrerUserId: pendingReferral.referrerId,
      rewardCoins,
      rideId,
      coinTransactionId: creditResult.coinTransactionId,
      payoutIdempotencyKey,
    });

    const notificationResult = await notificationService.notifyReferralRewardIssued(
      pendingReferral.referrerId,
      {
        rewardCoins,
        rideId,
        trackingId: pendingReferral.trackingId,
        refereeName,
      },
    ).catch((err) => ({ sent: false, reason: err.message }));

    await pgIdentityRepository.recordReferralEvent({
      trackingId: pendingReferral.trackingId,
      eventType: notificationResult?.sent ? 'notification_sent' : 'notification_failed',
      actorUserId: pendingReferral.referrerId,
      metadata: {
        notificationType: 'referral_reward_issued',
        sent: notificationResult?.sent === true,
        reason: notificationResult?.reason || null,
      },
    }).catch(() => {});

    logger.info('REFERRAL', `Issued referral reward for tracking ${pendingReferral.trackingId}`, {
      trackingId: pendingReferral.trackingId,
      referrerId: pendingReferral.referrerId,
      refereeUserId,
      rideId,
      rewardCoins,
      coinTransactionId: creditResult.coinTransactionId,
    });

    return {
      success: true,
      rewardIssued: true,
      trackingId: pendingReferral.trackingId,
      rewardCoins,
      coinTransactionId: creditResult.coinTransactionId,
      referrerId: pendingReferral.referrerId,
    };
  }

  async _getCompletedRideCount(userId) {
    const { rows } = await domainDb.query(
      'rides',
      `SELECT COUNT(*)::int AS cnt
       FROM rides r
       JOIN ride_rider_projection rrp ON rrp.rider_id = r.rider_id
       WHERE rrp.user_id = $1
         AND r.status = 'completed'`,
      [userId],
    );
    return Number(rows[0]?.cnt || 0);
  }
}

module.exports = new ReferralService();
