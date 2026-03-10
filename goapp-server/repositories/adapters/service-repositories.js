const IdentityRepository = require('../interfaces/identity-repository');
const RideRepository = require('../interfaces/ride-repository');
const MatchingStateRepository = require('../interfaces/matching-state-repository');
const WalletRepository = require('../interfaces/wallet-repository');

class ServiceIdentityRepository extends IdentityRepository {
  constructor(identityService) { super(); this.identityService = identityService; }
  requestOtp(payload) { return this.identityService.requestOtp(payload); }
  verifyOtp(payload) { return this.identityService.verifyOtp(payload); }
  validateSession(token) { return this.identityService.validateSession(token); }
  refreshSession(payload) { return this.identityService.refreshSession(payload); }
  revokeSession(payload) { return this.identityService.revokeSession(payload); }
  getUsers(limit) { return this.identityService.getUsers(limit); }
  getStats() { return this.identityService.getStats(); }
  isProfileComplete(userId) { return this.identityService.isProfileComplete(userId); }
  getUserProfile(userId) { return this.identityService.getUserProfile(userId); }
}

class ServiceRideRepository extends RideRepository {
  constructor(rideService) { super(); this.rideService = rideService; }
  createRide(payload) { return this.rideService.createRide(payload); }
  getRide(rideId) {
    if (typeof this.rideService.getRideAsync === 'function') {
      return this.rideService.getRideAsync(rideId);
    }
    return this.rideService.getRide(rideId);
  }
  getAllRides() { return this.rideService.getAllRides(); }
  getRidesPage(options) { return this.rideService.getRidesPage(options); }
  cancelRide(rideId, cancelledBy, userId, options) {
    return this.rideService.cancelRide(rideId, cancelledBy, userId, options);
  }
  completeTrip(rideId, distanceKm, durationMin) { return this.rideService.completeTrip(rideId, distanceKm, durationMin); }
}

class ServiceMatchingStateRepository extends MatchingStateRepository {
  constructor(matchingEngine) { super(); this.matchingEngine = matchingEngine; }
  registerDriver(driver) { return this.matchingEngine.registerDriver(driver); }
  getDriver(driverId) { return this.matchingEngine.getDriver(driverId); }
  updateDriverStatus(driverId, status) { return this.matchingEngine.updateDriverStatus(driverId, status); }
}

class ServiceWalletRepository extends WalletRepository {
  constructor(walletService) { super(); this.walletService = walletService; }
  getBalance(userId) { return this.walletService.getBalance(userId); }
  getCoinsBalance(userId) { return this.walletService.getCoinsBalance(userId); }
  getCoinsHistory(userId, page, limit) { return this.walletService.getCoinsHistory(userId, page, limit); }
  setCoinsAutoUse(userId, enabled) { return this.walletService.setCoinsAutoUse(userId, enabled); }
  previewRideDiscount(userId, fareInr, options = {}) { return this.walletService.previewRideDiscount(userId, fareInr, options); }
  payRide(userId, fareInr, rideId, paymentId = null, method = null, idempotencyKey = null) {
    return this.walletService.payWithWallet(userId, fareInr, rideId, paymentId, method, idempotencyKey);
  }
  refund(userId, amount, rideId, reason, idempotencyKey = null) {
    return this.walletService.refundToWallet(userId, amount, rideId, reason, idempotencyKey);
  }
  redeemCoins(userId, fareInr, coinsToUse) { return this.walletService.redeemCoins(userId, fareInr, coinsToUse); }
  getTransactions(userId, limit) { return this.walletService.getTransactions(userId, limit); }
  getRidePaymentInfo(userId, rideId) { return this.walletService.getRidePaymentInfo(userId, rideId); }
  getRidePaymentInfoBatch(userId, rideIds) { return this.walletService.getRidePaymentInfoBatch(userId, rideIds); }
}

module.exports = {
  ServiceIdentityRepository,
  ServiceRideRepository,
  ServiceMatchingStateRepository,
  ServiceWalletRepository,
};
