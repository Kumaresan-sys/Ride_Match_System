'use strict';

const pgRepo = require('../repositories/pg/pg-identity-repository');

class ProfileService {
  upsertUserProfileWithEmail(payload) {
    return pgRepo.upsertUserProfileWithEmail(payload);
  }

  getUserProfile(userId) {
    return pgRepo.getUserProfile(userId);
  }

  getUserById(userId) {
    return pgRepo.getUserById(userId);
  }

  updateProfileFields(payload) {
    return pgRepo.updateProfileFields(payload);
  }

  awardWelcomeBonus(userId) {
    return pgRepo.awardWelcomeBonus(userId);
  }

  generateOrGetReferralCode(userId) {
    return pgRepo.generateOrGetReferralCode(userId);
  }
}

module.exports = new ProfileService();
