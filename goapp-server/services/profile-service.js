'use strict';

const pgRepo = require('../repositories/pg/pg-identity-repository');
const domainProjectionService = require('./domain-projection-service');
const { logger } = require('../utils/logger');

class ProfileService {
  async upsertUserProfileWithEmail(payload) {
    await pgRepo.upsertUserProfileWithEmail(payload);
    await this._syncRiderProjection(payload?.userId, 'profile_upsert');
  }

  getUserProfile(userId) {
    return pgRepo.getUserProfile(userId);
  }

  getUserById(userId) {
    return pgRepo.getUserById(userId);
  }

  async updateProfileFields(payload) {
    await pgRepo.updateProfileFields(payload);
    await this._syncRiderProjection(payload?.userId, 'profile_update');
  }

  awardWelcomeBonus(userId) {
    return pgRepo.awardWelcomeBonus(userId);
  }

  generateOrGetReferralCode(userId) {
    return pgRepo.generateOrGetReferralCode(userId);
  }

  async _syncRiderProjection(userId, source) {
    if (!userId) return;
    try {
      const syncResult = await domainProjectionService.syncRiderByUserId(userId);
      if (!syncResult?.synced) {
        logger.warn(
          'PROFILE',
          `Rider projection sync incomplete after ${source} for user ${userId}: ${syncResult?.reason || 'unknown'}`,
        );
      }
    } catch (err) {
      logger.warn('PROFILE', `Rider projection sync failed after ${source} for user ${userId}: ${err.message}`);
    }
  }
}

module.exports = new ProfileService();
