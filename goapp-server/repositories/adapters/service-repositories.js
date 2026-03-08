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
}

class ServiceRideRepository extends RideRepository {
  constructor(rideService) { super(); this.rideService = rideService; }
  createRide(payload) { return this.rideService.createRide(payload); }
  getRide(rideId) { return this.rideService.getRide(rideId); }
  getAllRides() { return this.rideService.getAllRides(); }
  cancelRide(rideId, cancelledBy, userId) { return this.rideService.cancelRide(rideId, cancelledBy, userId); }
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
  payRide(userId, fareInr, rideId) { return this.walletService.payWithWallet(userId, fareInr, rideId); }
  refund(userId, amount, rideId, reason) { return this.walletService.refundToWallet(userId, amount, rideId, reason); }
  redeemCoins(userId, fareInr, coinsToUse) { return this.walletService.redeemCoins(userId, fareInr, coinsToUse); }
  getTransactions(userId, limit) { return this.walletService.getTransactions(userId, limit); }
}

module.exports = {
  ServiceIdentityRepository,
  ServiceRideRepository,
  ServiceMatchingStateRepository,
  ServiceWalletRepository,
};
