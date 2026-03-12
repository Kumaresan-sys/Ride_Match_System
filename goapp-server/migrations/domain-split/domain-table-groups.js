'use strict';

const DOMAINS = ['identity', 'drivers', 'rides', 'payments', 'analytics', 'support'];

// Extension/system-managed tables that should not be domain-owned or extracted.
const IGNORED_TABLES = new Set([
  'spatial_ref_sys',
]);

// Exact overrides for ambiguous/shared names.
const EXACT_TABLE_OWNERS = Object.freeze({
  // Shared infra/state tables
  schema_versions: 'analytics',
  dead_letter_events: 'analytics',
  event_consumer_offsets: 'analytics',
  event_publish_logs: 'analytics',
  event_schemas: 'analytics',
  idempotency_keys: 'identity',
  outbox_events: 'rides',
  ledger_idempotency: 'payments',

  // Projection tables
  ride_rider_projection: 'rides',
  ride_driver_projection: 'rides',
  ride_chat_conversations: 'rides',
  ride_chat_messages: 'rides',
  ride_chat_attachments: 'rides',
  ride_chat_message_receipts: 'rides',
  ride_chat_events: 'rides',
  ride_tracking_shares: 'rides',
  trip_share_delivery_logs: 'rides',
  zone_vehicle_type_availability: 'rides',
  zone_vehicle_type_pricing: 'rides',
  payment_rider_projection: 'payments',
  payment_driver_projection: 'payments',
  driver_user_projection: 'drivers',
  rider_user_projection: 'drivers',
  analytics_rider_projection: 'analytics',

  // Payments explicit ownership
  wallets: 'payments',
  wallet_transactions: 'payments',
  wallet_topups: 'payments',
  wallet_refunds: 'payments',
  wallet_holds: 'payments',
  wallet_limits: 'payments',
  wallet_expiry_rules: 'payments',
  wallet_audit_logs: 'payments',
  payments: 'payments',
  payment_transactions: 'payments',
  payment_methods: 'payments',
  payment_webhooks: 'payments',
  payment_failures: 'payments',
  payment_retries: 'payments',
  payment_refunds: 'payments',
  payment_disputes: 'payments',
  rider_wallets: 'payments',
  rider_wallet_transactions: 'payments',
  rider_wallet_kyc_tiers: 'payments',
  rider_topup_requests: 'payments',
  driver_wallets: 'payments',
  driver_wallet_transactions: 'payments',
  driver_wallet_alerts: 'payments',
  driver_recharge_requests: 'payments',
  referral_payouts: 'payments',
  coin_wallets: 'payments',
  coin_transactions: 'payments',
  coin_config: 'payments',
  coin_earn_rules: 'payments',
  coin_expiry_schedules: 'payments',
  coin_redemptions: 'payments',
  promo_campaigns: 'payments',
  promo_codes: 'payments',
  promo_limits: 'payments',
  promo_redemptions: 'payments',
  promo_rules: 'payments',
  promo_usage: 'payments',

  // Analytics explicit ownership
  promo_ab_tests: 'analytics',
  promo_analytics: 'analytics',
  suspicious_activity: 'analytics',

  // Identity explicit ownership
  referral_codes: 'identity',
  referral_tracking: 'identity',
  referral_programs: 'identity',
  notification_preferences: 'identity',

  // Drivers explicit ownership
  area_incentive_zones: 'drivers',
  incentive_leaderboard: 'drivers',
  incentive_reward_disbursements: 'drivers',

  // Rides / dispatch / support explicit ownership
  tax_jurisdiction_rules: 'rides',
  notification_templates: 'rides',
  notification_logs: 'rides',
  notifications: 'rides',
  in_app_messages: 'rides',
  email_logs: 'rides',
  sms_logs: 'rides',
  support_agents: 'support',
  support_categories: 'support',
  support_csat: 'support',
  support_faq: 'support',
  support_ticket_messages: 'support',
  support_ticket_read_state: 'support',
  support_ticket_attachments: 'support',
  support_tickets: 'support',
  ticket_escalations: 'support',
  ticket_messages: 'support',
  ticket_ratings: 'support',
  ticket_status_history: 'support',
  sos_logs: 'rides',
  sos_admin_actions: 'rides',
  sos_location_track: 'rides',
  sos_notifications_sent: 'rides',
  sos_response_logs: 'rides',
  sos_triggers: 'rides',
  scheduled_rides: 'rides',
  recurring_ride_templates: 'rides',
});

const PREFIX_RULES = Object.freeze([
  {
    domain: 'analytics',
    prefixes: ['analytics_', 'agg_', 'fact_', 'dim_', 'demand_', 'etl_', 'ml_', 'fraud_', 'risk_'],
  },
  {
    domain: 'payments',
    prefixes: ['wallet_', 'payment_', 'payout_', 'commission_', 'invoice_', 'coin_'],
  },
  {
    domain: 'rides',
    prefixes: [
      'ride_',
      'rides',
      'trip_',
      'dispatch_',
      'matching_',
      'geo_',
      'zone_',
      'surge_',
      'schedule_',
      'pool_',
      'route_',
      'traffic_',
      'fare_',
      'pricing_',
      'booking_',
      'base_fares',
      'distance_rates',
      'time_rates',
      'toll_rates',
      'city_pricing',
      'city_regions',
      'h3_hex_indices',
      'map_data_versions',
      'location_snapshots',
      'location_update_logs',
      'safety_',
      'saga_',
      'corporate_',
      'employee_ride_allocations',
      'regulatory_',
    ],
  },
  {
    domain: 'drivers',
    prefixes: ['driver_', 'drivers', 'vehicle_', 'vehicles', 'fleet_', 'incentive_'],
  },
  {
    domain: 'identity',
    prefixes: [
      'user_',
      'users',
      'rider_',
      'riders',
      'otp_',
      'auth_',
      'session_',
      'refresh_',
      'device_',
      'push_tokens',
      'data_deletion_requests',
      'data_retention_policies',
      'audit_trails',
      'trusted_contacts_shares',
      'emergency_contacts',
    ],
  },
]);

function classifyTable(tableName) {
  const normalized = String(tableName || '').trim().toLowerCase();
  if (!normalized) return null;
  if (Object.prototype.hasOwnProperty.call(EXACT_TABLE_OWNERS, normalized)) {
    return EXACT_TABLE_OWNERS[normalized];
  }
  for (const rule of PREFIX_RULES) {
    if (rule.prefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix))) {
      return rule.domain;
    }
  }
  return null;
}

function groupTables(tableNames, { strict = true } = {}) {
  const grouped = {
    identity: [],
    drivers: [],
    rides: [],
    payments: [],
    analytics: [],
  };
  const unknown = [];
  const ignored = [];
  for (const tableName of tableNames || []) {
    const normalized = String(tableName || '').trim().toLowerCase();
    if (IGNORED_TABLES.has(normalized)) {
      ignored.push(String(tableName));
      continue;
    }
    const domain = classifyTable(normalized);
    if (!domain) {
      unknown.push(String(tableName));
      continue;
    }
    grouped[domain].push(String(tableName));
  }

  for (const domain of DOMAINS) {
    grouped[domain] = Array.from(new Set(grouped[domain])).sort();
  }
  unknown.sort();
  ignored.sort();

  if (strict && unknown.length > 0) {
    const err = new Error(`Unowned tables detected: ${unknown.join(', ')}`);
    err.code = 'UNMAPPED_TABLES';
    err.unknownTables = unknown;
    throw err;
  }

  return { grouped, unknown, ignored };
}

module.exports = {
  DOMAINS,
  IGNORED_TABLES,
  EXACT_TABLE_OWNERS,
  PREFIX_RULES,
  classifyTable,
  groupTables,
};
