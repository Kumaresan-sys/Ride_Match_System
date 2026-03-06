// GoApp Feedback Service
// Mutual feedback and ratings for riders and drivers after trip completion

const config = require('../config');
const { logger, eventBus } = require('../utils/logger');

const S = config.rideStatuses;

class FeedbackService {
  constructor() {
    this.feedbacks = new Map();       // rideId → { riderFeedback, driverFeedback }
    this.driverFeedbacks = new Map(); // driverId → [{ rideId, rating, comment, at }]
    this.riderFeedbacks = new Map();  // riderId  → [{ rideId, rating, comment, at }]
  }

  // ═══════════════════════════════════════════
  // RIDER RATES DRIVER
  // ═══════════════════════════════════════════
  submitRiderFeedback(rideId, riderId, rating, comment = '') {
    const validationError = this._validateInput(rating);
    if (validationError) return { success: false, error: validationError, status: 400 };

    const rideService = require('./ride-service');
    const ride = rideService.getRide(rideId);
    if (!ride) return { success: false, error: 'Ride not found', status: 404 };
    if (ride.status !== S.TRIP_COMPLETED) {
      return { success: false, error: 'Feedback can only be submitted for completed trips', status: 400 };
    }
    if (ride.riderId !== riderId) {
      return { success: false, error: 'Rider does not belong to this ride', status: 403 };
    }

    const existing = this.feedbacks.get(rideId) || {};
    if (existing.riderFeedback) {
      return { success: false, error: 'Rider has already submitted feedback for this ride', status: 409 };
    }

    const entry = { rideId, raterId: riderId, rating, comment, at: Date.now() };

    // Store per-ride
    this.feedbacks.set(rideId, { ...existing, riderFeedback: entry });

    // Store in driver's feedback history
    const driverId = ride.driverId;
    if (!this.driverFeedbacks.has(driverId)) this.driverFeedbacks.set(driverId, []);
    const driverHistory = this.driverFeedbacks.get(driverId);
    driverHistory.push(entry);

    // Recompute driver rating and apply live update
    const newRating = this._computeRollingRating(driverHistory, null);
    const matchingEngine = require('./matching-engine');
    matchingEngine.updateDriverRating(driverId, newRating);

    logger.info('FEEDBACK', `Rider ${riderId} rated Driver ${driverId}: ${rating}/5 for ride ${rideId}`);
    eventBus.publish('rider_rated_driver', { rideId, riderId, driverId, rating });

    return { success: true, updatedDriverRating: newRating };
  }

  // ═══════════════════════════════════════════
  // DRIVER RATES RIDER
  // ═══════════════════════════════════════════
  submitDriverFeedback(rideId, driverId, rating, comment = '') {
    const validationError = this._validateInput(rating);
    if (validationError) return { success: false, error: validationError, status: 400 };

    const rideService = require('./ride-service');
    const ride = rideService.getRide(rideId);
    if (!ride) return { success: false, error: 'Ride not found', status: 404 };
    if (ride.status !== S.TRIP_COMPLETED) {
      return { success: false, error: 'Feedback can only be submitted for completed trips', status: 400 };
    }
    if (ride.driverId !== driverId) {
      return { success: false, error: 'Driver does not belong to this ride', status: 403 };
    }

    const existing = this.feedbacks.get(rideId) || {};
    if (existing.driverFeedback) {
      return { success: false, error: 'Driver has already submitted feedback for this ride', status: 409 };
    }

    const entry = { rideId, raterId: driverId, rating, comment, at: Date.now() };

    // Store per-ride
    this.feedbacks.set(rideId, { ...existing, driverFeedback: entry });

    // Store in rider's feedback history
    const riderId = ride.riderId;
    if (!this.riderFeedbacks.has(riderId)) this.riderFeedbacks.set(riderId, []);
    const riderHistory = this.riderFeedbacks.get(riderId);
    riderHistory.push(entry);

    // Recompute rider rating and apply live update
    const newRating = this._computeRollingRating(riderHistory, null);
    const mockDb = require('./mock-db');
    mockDb.updateRiderRating(riderId, newRating);

    logger.info('FEEDBACK', `Driver ${driverId} rated Rider ${riderId}: ${rating}/5 for ride ${rideId}`);
    eventBus.publish('driver_rated_rider', { rideId, driverId, riderId, rating });

    return { success: true, updatedRiderRating: newRating };
  }

  // ═══════════════════════════════════════════
  // QUERIES
  // ═══════════════════════════════════════════
  getFeedbackForRide(rideId) {
    const fb = this.feedbacks.get(rideId);
    if (!fb) return { rideId, riderFeedback: null, driverFeedback: null };
    return { rideId, riderFeedback: fb.riderFeedback || null, driverFeedback: fb.driverFeedback || null };
  }

  getDriverFeedbacks(driverId, limit = 50) {
    const history = this.driverFeedbacks.get(driverId) || [];
    const slice = history.slice(-limit).reverse();
    return {
      driverId,
      totalFeedbacks: history.length,
      averageRating: history.length > 0
        ? +(history.reduce((s, f) => s + f.rating, 0) / history.length).toFixed(2)
        : null,
      feedbacks: slice,
    };
  }

  getRiderFeedbacks(riderId, limit = 50) {
    const history = this.riderFeedbacks.get(riderId) || [];
    const slice = history.slice(-limit).reverse();
    return {
      riderId,
      totalFeedbacks: history.length,
      averageRating: history.length > 0
        ? +(history.reduce((s, f) => s + f.rating, 0) / history.length).toFixed(2)
        : null,
      feedbacks: slice,
    };
  }

  // ═══════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════
  _validateInput(rating) {
    const r = Number(rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) {
      return 'Rating must be an integer between 1 and 5';
    }
    return null;
  }

  _computeRollingRating(feedbackList) {
    const windowSize = config.rating.windowSize || 500;
    const window = feedbackList.slice(-windowSize);
    if (window.length === 0) return config.rating.defaultRating;
    const sum = window.reduce((acc, f) => acc + f.rating, 0);
    return +(sum / window.length).toFixed(2);
  }
}

module.exports = new FeedbackService();
