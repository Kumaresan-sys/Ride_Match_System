class IdentityRepository {
  requestOtp() { throw new Error('Not implemented'); }
  verifyOtp() { throw new Error('Not implemented'); }
  validateSession() { throw new Error('Not implemented'); }
  refreshSession() { throw new Error('Not implemented'); }
  revokeSession() { throw new Error('Not implemented'); }
  getUsers() { throw new Error('Not implemented'); }
  getStats() { throw new Error('Not implemented'); }
  isProfileComplete() { throw new Error('Not implemented'); }
  getUserProfile() { throw new Error('Not implemented'); }
}

module.exports = IdentityRepository;
