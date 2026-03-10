'use strict';

const TOPICS = {
  RIDE_REQUESTED: 'ride_requested',
  RIDE_MATCHED: 'ride_matched',
  RIDE_STARTED: 'ride_started',
  RIDE_COMPLETED: 'ride_completed',
  RIDE_CANCELLED: 'ride_cancelled',
  DRIVER_LOCATION_UPDATED: 'driver_location_updated',
  PAYMENT_COMPLETED: 'payment_completed',
  WALLET_UPDATED: 'wallet_updated',
  IDENTITY_PROFILE_UPDATED: 'identity_profile_updated',
  DRIVER_PROFILE_UPDATED: 'driver_profile_updated',
  NOTIFICATION_DISPATCH_REQUESTED: 'notification_dispatch_requested',
};

const EVENT_TO_TOPIC = {
  ride_requested: TOPICS.RIDE_REQUESTED,
  ride_matched: TOPICS.RIDE_MATCHED,
  ride_started: TOPICS.RIDE_STARTED,
  ride_completed: TOPICS.RIDE_COMPLETED,
  ride_cancelled_by_rider: TOPICS.RIDE_CANCELLED,
  ride_cancelled_by_driver: TOPICS.RIDE_CANCELLED,
  driver_location_update: TOPICS.DRIVER_LOCATION_UPDATED,
  payment_verified: TOPICS.PAYMENT_COMPLETED,
  wallet_updated: TOPICS.WALLET_UPDATED,
  otp_verified: TOPICS.IDENTITY_PROFILE_UPDATED,
  driver_wallet_recharged: TOPICS.DRIVER_PROFILE_UPDATED,
  driver_wallet_low: TOPICS.DRIVER_PROFILE_UPDATED,
  driver_ride_eligible: TOPICS.DRIVER_PROFILE_UPDATED,
  driver_earnings_credited: TOPICS.DRIVER_PROFILE_UPDATED,
  driver_commission_debited: TOPICS.DRIVER_PROFILE_UPDATED,
};

function mapEventToTopic(eventName) {
  return EVENT_TO_TOPIC[eventName] || null;
}

function keyForTopic(topic, payload = {}) {
  if (topic.startsWith('ride_')) return payload.rideId || payload.riderId || null;
  if (topic.startsWith('driver_')) return payload.driverId || null;
  if (topic.startsWith('payment_')) return payload.paymentId || payload.orderId || null;
  if (topic.startsWith('wallet_')) return payload.userId || payload.driverId || null;
  return null;
}

module.exports = {
  TOPICS,
  mapEventToTopic,
  keyForTopic,
};
