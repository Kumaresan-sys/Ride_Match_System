'use strict';

const safetyRepo = require('../repositories/pg/pg-safety-repository');

class SafetyService {
  getContacts(userId) { return safetyRepo.getContacts(userId); }
  addContact(userId, payload) { return safetyRepo.addContact(userId, payload); }
  deleteContact(userId, contactId) { return safetyRepo.deleteContact(userId, contactId); }
  updateContact(userId, contactId, payload) { return safetyRepo.updateContact(userId, contactId, payload); }
  makePrimary(userId, contactId) { return safetyRepo.makePrimary(userId, contactId); }
  getPreferences(userId) { return safetyRepo.getPreferences(userId); }
  updatePreferences(userId, payload) { return safetyRepo.updatePreferences(userId, payload); }
  seedProfileEmergencyContact(userId, emergencyContact) { return safetyRepo.seedProfileEmergencyContact(userId, emergencyContact); }
  getPrimaryContact(userId) { return safetyRepo.getPrimaryContact(userId); }
}

module.exports = new SafetyService();
