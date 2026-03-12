// GoApp Pricing Service
// Fare calculation + EMA surge pricing
// Rate cards loaded from DB (vehicle_types table) with 60s in-memory cache

const config = require('../config');
const { haversine } = require('../utils/formulas');
const { logger, eventBus } = require('../utils/logger');
const googleMapsService = require('./google-maps-service');
const zoneVehicleTypePricingService = require('./zone-vehicle-type-pricing-service');

const CACHE_TTL_MS = 60_000; // reload from DB every 60 seconds

class PricingService {
  constructor() {
    this.surgeByZone = new Map();
    this.stats = {
      fareCalculations: 0,
      surgeUpdates: 0,
    };
    this._rateCardCache = null;
    this._rateCardCachedAt = 0;
    this._db = null; // injected lazily to avoid circular require
    this._taxConfigCache = null;
    this._taxConfigCachedAt = 0;
  }

  _getDb() {
    if (!this._db) this._db = require('./db');
    return this._db;
  }

  _normalizeCard(card) {
    if (!card) return null;
    return {
      ...card,
      baseFare: Number.parseFloat(card.baseFare),
      perKm: Number.parseFloat(card.perKm ?? card.perKmRate),
      perMin: Number.parseFloat(card.perMin ?? card.perMinRate),
      minFare: Number.parseFloat(card.minFare),
      commission: card.commission != null
        ? Number.parseFloat(card.commission)
        : card.commissionPct != null
        ? Number.parseFloat(card.commissionPct)
        : null,
    };
  }

  async _getEffectiveRateCards({ pickupLat, pickupLng, role = 'rider' } = {}) {
    const cards = await this._loadRateCards();
    const normalizedCards = [...cards.values()].map((card) => this._normalizeCard(card));
    if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
      return new Map(normalizedCards.map((card) => [card.name, card]));
    }

    const zonePriced = await zoneVehicleTypePricingService.applyZonePricingForLocation(
      normalizedCards.map((card) => ({
        ...card,
        perKmRate: card.perKm,
        perMinRate: card.perMin,
        commissionPct: card.commission,
      })),
      { pickupLat, pickupLng, role },
    );

    return new Map(zonePriced.map((card) => [card.name, this._normalizeCard(card)]));
  }

  _calculateFareFromCard(card, rideType, distanceKm, durationMin, surgeMultiplier, taxConfig) {
    const normalizedCard = this._normalizeCard(card);
    const baseFare = normalizedCard.baseFare;
    const distanceCharge = distanceKm * normalizedCard.perKm;
    const timeCharge = durationMin * normalizedCard.perMin;
    const subtotal = Math.max(normalizedCard.minFare, baseFare + distanceCharge + timeCharge);
    const serviceCostRaw = subtotal * surgeMultiplier;
    const gstAmountRaw = serviceCostRaw * ((taxConfig.gstPct || 0) / 100);
    const finalFareRaw = serviceCostRaw + gstAmountRaw;
    const serviceCost = Math.round(serviceCostRaw * 100) / 100;
    const gstAmount = Math.round(gstAmountRaw * 100) / 100;
    const finalFare = Math.round(finalFareRaw * 100) / 100;
    const commissionPct = Number.isFinite(taxConfig.platformCommissionPct)
      ? taxConfig.platformCommissionPct
      : normalizedCard.commission;
    const platformCommission = Math.round(finalFare * commissionPct * 100) / 100;
    const driverEarnings = Math.round((finalFare - platformCommission) * 100) / 100;

    return {
      rideType,
      distanceKm: Math.round(distanceKm * 100) / 100,
      durationMin: Math.round(durationMin * 10) / 10,
      finalFare,
      serviceCost,
      gstAmount,
      gstPct: taxConfig.gstPct || 0,
      commissionPct,
      driverEarnings,
      platformCommission,
      breakdown: {
        baseFare,
        distanceCharge: Math.round(distanceCharge * 100) / 100,
        timeCharge: Math.round(timeCharge * 100) / 100,
        subtotal: Math.round(subtotal * 100) / 100,
        serviceCost,
        gstPct: taxConfig.gstPct || 0,
        gstAmount,
        commissionPct,
        surgeMultiplier: Math.round(surgeMultiplier * 100) / 100,
      },
    };
  }

  // Load rate cards from vehicle_types table; returns Map<name, card>
  async _loadRateCards() {
    const now = Date.now();
    if (this._rateCardCache && (now - this._rateCardCachedAt) < CACHE_TTL_MS) {
      return this._rateCardCache;
    }

    try {
      const db = this._getDb();
      const { rows } = await db.query(
        `SELECT name, display_name, category, base_fare, per_km_rate, per_min_rate,
                min_fare, commission_pct, max_passengers, sort_order, icon_url, description, is_active
         FROM vehicle_types
         WHERE is_active = true
         ORDER BY sort_order ASC`
      );

      const cards = new Map();
      for (const row of rows) {
        cards.set(row.name, {
          name:          row.name,
          displayName:   row.display_name,
          category:      row.category,
          baseFare:      parseFloat(row.base_fare),
          perKm:         parseFloat(row.per_km_rate),
          perMin:        parseFloat(row.per_min_rate),
          minFare:       parseFloat(row.min_fare),
          commission:    parseFloat(row.commission_pct),
          maxPassengers: row.max_passengers,
          sortOrder:     row.sort_order,
          iconUrl:       row.icon_url,
          description:   row.description,
        });
      }

      this._rateCardCache = cards;
      this._rateCardCachedAt = now;
      return cards;
    } catch (err) {
      logger.warn('PRICING', `DB rate card load failed, using config fallback: ${err.message}`);
      // Fallback to hardcoded config
      const cards = new Map();
      for (const [name, card] of Object.entries(config.pricing.rateCards)) {
        cards.set(name, card);
      }
      return cards;
    }
  }

  // Invalidate cache (called after admin updates)
  invalidateCache() {
    this._rateCardCache = null;
    this._rateCardCachedAt = 0;
    this._taxConfigCache = null;
    this._taxConfigCachedAt = 0;
  }

  async _ensureTaxConfigTable() {
    const db = this._getDb();
    await db.query(
      `CREATE TABLE IF NOT EXISTS pricing_tax_config (
         id          INTEGER PRIMARY KEY CHECK (id = 1),
         gst_pct     NUMERIC(5,2) NOT NULL DEFAULT 5.00,
         platform_commission_pct NUMERIC(6,4),
         updated_by  TEXT,
         updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    await db.query(
      `CREATE TABLE IF NOT EXISTS pricing_tax_transactions (
         id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         old_gst_pct   NUMERIC(5,2),
         new_gst_pct   NUMERIC(5,2),
         old_platform_commission_pct NUMERIC(6,4),
         new_platform_commission_pct NUMERIC(6,4),
         action        VARCHAR(30) NOT NULL DEFAULT 'UPDATE_TAX_CONFIG',
         changed_by    TEXT,
         request_id    TEXT,
         created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    await db.query(
      `INSERT INTO pricing_tax_config (id, gst_pct)
       VALUES (1, 5.00)
       ON CONFLICT (id) DO NOTHING`
    );
  }

  async getTaxConfig() {
    const now = Date.now();
    if (this._taxConfigCache && (now - this._taxConfigCachedAt) < CACHE_TTL_MS) {
      return this._taxConfigCache;
    }
    try {
      await this._ensureTaxConfigTable();
      const db = this._getDb();
      const { rows } = await db.query(
        `SELECT gst_pct, platform_commission_pct, updated_by, updated_at
         FROM pricing_tax_config
         WHERE id = 1`
      );
      const row = rows[0] || { gst_pct: 5 };
      const cfg = {
        gstPct: Number.parseFloat(row.gst_pct) || 0,
        platformCommissionPct: row.platform_commission_pct != null
          ? Number.parseFloat(row.platform_commission_pct)
          : null,
        updatedBy: row.updated_by || null,
        updatedAt: row.updated_at || null,
      };
      this._taxConfigCache = cfg;
      this._taxConfigCachedAt = now;
      return cfg;
    } catch (err) {
      logger.warn('PRICING', `Tax config load failed, using default GST 5%: ${err.message}`);
      return { gstPct: 5, platformCommissionPct: null, updatedBy: null, updatedAt: null };
    }
  }

  async setTaxConfig({ gstPct, platformCommissionPct }, updatedBy = null, requestId = null) {
    const hasGst = gstPct !== undefined;
    const hasCommission = platformCommissionPct !== undefined;
    if (!hasGst && !hasCommission) {
      throw new Error('At least one of gstPct or platformCommissionPct must be provided');
    }

    let gstValue = null;
    let commissionValue = null;
    if (hasGst) {
      gstValue = Number(gstPct);
      if (!Number.isFinite(gstValue) || gstValue < 0 || gstValue > 100) {
        throw new Error('gstPct must be a number between 0 and 100');
      }
    }
    if (hasCommission) {
      commissionValue = Number(platformCommissionPct);
      if (!Number.isFinite(commissionValue) || commissionValue < 0 || commissionValue > 1) {
        throw new Error('platformCommissionPct must be a number between 0 and 1');
      }
    }

    await this._ensureTaxConfigTable();
    const db = this._getDb();
    const before = await db.query(
      `SELECT gst_pct, platform_commission_pct
       FROM pricing_tax_config
       WHERE id = 1`
    );
    const prev = before.rows[0] || {};

    const { rows } = await db.query(
      `UPDATE pricing_tax_config
       SET gst_pct = COALESCE($1, gst_pct),
           platform_commission_pct = COALESCE($2, platform_commission_pct),
           updated_by = $3,
           updated_at = NOW()
       WHERE id = 1
       RETURNING gst_pct, platform_commission_pct, updated_by, updated_at`,
      [hasGst ? gstValue : null, hasCommission ? commissionValue : null, updatedBy]
    );

    await db.query(
      `INSERT INTO pricing_tax_transactions
        (old_gst_pct, new_gst_pct, old_platform_commission_pct, new_platform_commission_pct,
         action, changed_by, request_id)
       VALUES ($1,$2,$3,$4,'UPDATE_TAX_CONFIG',$5,$6)`,
      [
        prev.gst_pct ?? null,
        rows[0]?.gst_pct ?? null,
        prev.platform_commission_pct ?? null,
        rows[0]?.platform_commission_pct ?? null,
        updatedBy,
        requestId,
      ]
    );

    const row = rows[0];
    const cfg = {
      gstPct: Number.parseFloat(row.gst_pct) || 0,
      platformCommissionPct: row.platform_commission_pct != null
        ? Number.parseFloat(row.platform_commission_pct)
        : null,
      updatedBy: row.updated_by || null,
      updatedAt: row.updated_at || null,
    };
    this._taxConfigCache = cfg;
    this._taxConfigCachedAt = Date.now();
    return cfg;
  }

  // Returns all active vehicle types for the app
  async getVehicleTypes(options = {}) {
    const cards = await this._getEffectiveRateCards(options);
    return [...cards.values()];
  }

  async calculateFare(rideType, distanceKm, durationMin, surgeMultiplier = 1, options = {}) {
    const cards = options.cardMap instanceof Map
      ? options.cardMap
      : await this._getEffectiveRateCards(options);
    const taxConfig = await this.getTaxConfig();
    const card = cards.get(rideType) || cards.get('sedan') || cards.values().next().value;

    this.stats.fareCalculations += 1;

    return this._calculateFareFromCard(card, rideType, distanceKm, durationMin, surgeMultiplier, taxConfig);
  }

  // Synchronous fallback used internally when async isn't available
  _estimatesSync(pickupLat, pickupLng, destLat, destLng) {
    const distanceKm = haversine(pickupLat, pickupLng, destLat, destLng) * 1.25;
    const durationMin = (distanceKm / config.scoring.avgCitySpeedKmh) * 60;
    return { distanceKm, durationMin, source: 'haversine' };
  }

  async getEstimates(pickupLat, pickupLng, destLat, destLng) {
    const { distanceKm, durationMin, source } = await googleMapsService.getRoadDistance(
      pickupLat, pickupLng, destLat, destLng,
    );

    const zoneId = 'chennai:default';
    const surge  = this.getSurgeMultiplier(zoneId);
    const cards  = await this._getEffectiveRateCards({ pickupLat, pickupLng, role: 'rider' });

    const estimates = {};
    for (const [rideType] of cards) {
      const fare = await this.calculateFare(rideType, distanceKm, durationMin, surge.multiplier, {
        cardMap: cards,
        pickupLat,
        pickupLng,
        role: 'rider',
      });
      estimates[rideType] = {
        ...fare,
        etaMin: Math.max(3, Math.round(durationMin * 0.25)),
      };
    }

    return {
      zoneId,
      surgeMultiplier: surge.multiplier,
      distanceSource: source,
      estimates,
    };
  }

  getSurgeMultiplier(zoneId) {
    const zone = this.surgeByZone.get(zoneId);
    if (!zone) return { zoneId, multiplier: 1.0, rawSurge: 1.0, smoothedSurge: 1.0 };
    return zone;
  }

  updateSurge(zoneId, demand, supply) {
    const alpha = config.pricing.surge.alpha;
    const prev  = this.surgeByZone.get(zoneId);

    const safeSupply   = Math.max(1, supply);
    const rawSurge     = Math.min(config.pricing.surge.maxCap, Math.max(1, demand / safeSupply));
    const prevSmooth   = prev ? prev.smoothedSurge : 1.0;
    const smoothedSurge = (alpha * rawSurge) + ((1 - alpha) * prevSmooth);

    const multiplier = smoothedSurge >= config.pricing.surge.minThreshold
      ? Math.min(config.pricing.surge.maxCap, Math.max(1, smoothedSurge))
      : 1.0;

    const data = {
      zoneId,
      demand,
      supply,
      rawSurge:      Math.round(rawSurge * 100) / 100,
      smoothedSurge: Math.round(smoothedSurge * 100) / 100,
      multiplier:    Math.round(multiplier * 100) / 100,
      updatedAt:     Date.now(),
    };

    this.surgeByZone.set(zoneId, data);
    this.stats.surgeUpdates += 1;

    eventBus.publish('surge_updated', data);
    logger.info('PRICING', `Surge ${zoneId}: raw=${data.rawSurge} smooth=${data.smoothedSurge} final=${data.multiplier}x`);

    return data;
  }

  getSurgeZones() {
    return [...this.surgeByZone.values()];
  }

  getStats() {
    return {
      ...this.stats,
      activeSurgeZones: this.surgeByZone.size,
    };
  }
}

module.exports = new PricingService();
