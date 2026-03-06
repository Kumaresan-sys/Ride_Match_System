// GoApp Demand Log Service
//
// Three responsibilities:
//   A) Area Demand Map  — real-time per-grid-cell demand vs supply
//   B) Time-series      — 15-minute bucket demand timeline
//   C) Scenario Logs    — every pool/match event with full context
//
// Area grid resolution: lat/lng rounded to 2 decimals ≈ 1.1 km cell
// Peak hours: 07:00–10:00 and 17:00–21:00
//
// Demand level thresholds (ratio = activeRequests / max(drivers, 1)):
//   < 1.0  → LOW
//   1.0–1.5 → MEDIUM
//   1.5–2.5 → HIGH
//   > 2.5  → SURGE

const { logger, eventBus } = require('../utils/logger');

const MAX_SCENARIO_LOGS = 10000;   // circular cap
const BUCKET_MINUTES    = 15;      // time-series bucket size
const PEAK_HOURS        = [[7, 10], [17, 21]]; // [startHour, endHour] pairs

// Demand level calc
function calcDemandLevel(ratio) {
  if (ratio >= 2.5) return 'SURGE';
  if (ratio >= 1.5) return 'HIGH';
  if (ratio >= 1.0) return 'MEDIUM';
  return 'LOW';
}

function isPeakHour(date = new Date()) {
  const h = date.getHours();
  return PEAK_HOURS.some(([s, e]) => h >= s && h < e);
}

// Round to 15-min bucket: "YYYY-MM-DD HH:MM"
function timeBucketKey(date = new Date()) {
  const y  = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d  = String(date.getDate()).padStart(2, '0');
  const h  = String(date.getHours()).padStart(2, '0');
  const m  = String(Math.floor(date.getMinutes() / BUCKET_MINUTES) * BUCKET_MINUTES).padStart(2, '0');
  return `${y}-${mo}-${d} ${h}:${m}`;
}

function bucketStartEnd(key) {
  // key = "YYYY-MM-DD HH:MM"
  const start = new Date(key.replace(' ', 'T') + ':00.000Z');
  // Adjust for local timezone offset difference — use Date parsing directly
  const startISO = new Date(`${key.replace(' ', 'T')}:00`).toISOString();
  const endISO   = new Date(new Date(`${key.replace(' ', 'T')}:00`).getTime() + BUCKET_MINUTES * 60000).toISOString();
  return { startISO, endISO };
}

class DemandLogService {
  constructor() {
    // A) Area demand map: areaKey → area object
    this.areaDemand = new Map();

    // B) Time-series: bucketKey → bucket object
    this.timeBuckets = new Map();

    // C) Scenario logs: circular array, capped at MAX_SCENARIO_LOGS
    this.scenarioLogs = [];
    this._logIndex = 0;
    this._totalLogged = 0;

    // Fail-reason aggregator for no-match analysis
    // reason → { count, totalValue }
    this._failReasonAgg = new Map();

    // Periodic snapshot every 5 minutes
    this._snapshotInterval = setInterval(() => this._takeDemandSnapshot(), 5 * 60 * 1000);

    // Daily reset of area totals at midnight
    this._scheduleDaily();

    logger.info('DEMAND_LOG', 'Demand Log Service initialized (area map + timeline + scenario logs)');
  }

  // ═══════════════════════════════════════════════════════
  // A) AREA DEMAND MAP
  // ═══════════════════════════════════════════════════════

  _areaKey(lat, lng) {
    return `${parseFloat(lat).toFixed(2)}_${parseFloat(lng).toFixed(2)}`;
  }

  _getArea(lat, lng) {
    const key = this._areaKey(lat, lng);
    if (!this.areaDemand.has(key)) {
      this.areaDemand.set(key, {
        areaKey:           key,
        centerLat:         parseFloat(parseFloat(lat).toFixed(2)),
        centerLng:         parseFloat(parseFloat(lng).toFixed(2)),
        activeRequests:    0,
        openPools:         0,
        availableDrivers:  0,
        demandRatio:       0,
        demandLevel:       'LOW',
        totalRequestsToday: 0,
        totalSavingsToday:  0,
        lastUpdated:       new Date().toISOString(),
      });
    }
    return this.areaDemand.get(key);
  }

  _refreshArea(area) {
    area.demandRatio  = Math.round((area.activeRequests / Math.max(area.availableDrivers, 1)) * 100) / 100;
    area.demandLevel  = calcDemandLevel(area.demandRatio);
    area.lastUpdated  = new Date().toISOString();
  }

  // Called when a ride/pool request is initiated
  recordDemand(lat, lng, eventType = 'ride_requested') {
    if (!lat || !lng) return;
    const area = this._getArea(lat, lng);
    area.activeRequests++;
    area.totalRequestsToday++;
    if (eventType === 'pool_created') area.openPools++;
    this._refreshArea(area);

    // Check if just crossed into HIGH/SURGE — emit alert event
    if (area.demandLevel === 'SURGE' && area.activeRequests % 5 === 1) {
      eventBus.publish('demand_surge_alert', {
        areaKey: area.areaKey, lat: area.centerLat, lng: area.centerLng,
        ratio: area.demandRatio, requests: area.activeRequests, drivers: area.availableDrivers,
      });
      logger.warn('DEMAND_LOG', `SURGE detected in area ${area.areaKey} — ratio ${area.demandRatio} (${area.activeRequests} requests, ${area.availableDrivers} drivers)`);
    }
  }

  // Called when a request is fulfilled (ride complete) or cancelled
  releaseRequest(lat, lng, poolClosed = false) {
    if (!lat || !lng) return;
    const area = this._getArea(lat, lng);
    area.activeRequests = Math.max(0, area.activeRequests - 1);
    if (poolClosed) area.openPools = Math.max(0, area.openPools - 1);
    this._refreshArea(area);
  }

  // Called from location service or matching engine to update driver supply
  updateDriverCount(lat, lng, count) {
    if (!lat || !lng || count === undefined) return;
    const area = this._getArea(lat, lng);
    area.availableDrivers = Math.max(0, count);
    this._refreshArea(area);
  }

  // Add savings to area stats (when pool completes)
  recordSavings(lat, lng, savingsInr) {
    if (!lat || !lng || !savingsInr) return;
    const area = this._getArea(lat, lng);
    area.totalSavingsToday = Math.round((area.totalSavingsToday + savingsInr) * 100) / 100;
  }

  // All areas sorted by demandRatio DESC
  getDemandMap() {
    const areas = Array.from(this.areaDemand.values());
    return areas.sort((a, b) => b.demandRatio - a.demandRatio);
  }

  // Top N high-demand areas
  getHotAreas(limit = 10) {
    return this.getDemandMap()
      .filter(a => a.demandLevel === 'HIGH' || a.demandLevel === 'SURGE')
      .slice(0, limit);
  }

  // ═══════════════════════════════════════════════════════
  // B) TIME-SERIES DEMAND (15-min buckets)
  // ═══════════════════════════════════════════════════════

  _getBucket(date = new Date()) {
    const key = timeBucketKey(date);
    if (!this.timeBuckets.has(key)) {
      const { startISO, endISO } = bucketStartEnd(key);
      this.timeBuckets.set(key, {
        bucketKey:       key,
        startTime:       startISO,
        endTime:         endISO,
        totalRequests:   0,
        poolMatches:     0,   // rider joined existing pool
        newPools:        0,   // new pool created
        noMatches:       0,   // no compatible pool at all (solo fallback)
        poolCompleted:   0,
        poolExpired:     0,
        poolCancelled:   0,
        totalSavingsInr: 0,
        waitSumSec:      0,   // sum of wait times (for averaging)
        waitCount:       0,
        peakHour:        isPeakHour(date),
      });
    }
    return this.timeBuckets.get(key);
  }

  // computed helper
  _bucketAvgWait(b) {
    return b.waitCount > 0 ? Math.round(b.waitSumSec / b.waitCount) : 0;
  }

  // Record demand event into current time bucket
  recordTimeslot(type, data = {}) {
    const bucket = this._getBucket();
    switch (type) {
      case 'ride_requested':
      case 'pool_requested':
        bucket.totalRequests++;
        break;
      case 'pool_joined':
        bucket.poolMatches++;
        if (data.waitSec) { bucket.waitSumSec += data.waitSec; bucket.waitCount++; }
        if (data.savingsInr) bucket.totalSavingsInr = Math.round((bucket.totalSavingsInr + data.savingsInr) * 100) / 100;
        break;
      case 'pool_created':
        bucket.newPools++;
        bucket.totalRequests++;
        break;
      case 'no_match_found':
        bucket.noMatches++;
        bucket.totalRequests++;
        break;
      case 'pool_completed':
        bucket.poolCompleted++;
        if (data.savingsInr) bucket.totalSavingsInr = Math.round((bucket.totalSavingsInr + data.savingsInr) * 100) / 100;
        break;
      case 'pool_expired':
        bucket.poolExpired++;
        break;
      case 'pool_cancelled':
        bucket.poolCancelled++;
        break;
    }
  }

  // Get timeline for last N hours (returns array of bucket objects, newest last)
  getTimeline(hours = 6) {
    const cutoff = new Date(Date.now() - hours * 3600000);
    const result = [];
    this.timeBuckets.forEach(b => {
      if (new Date(b.startTime) >= cutoff) {
        const poolMatchRate = b.totalRequests > 0
          ? Math.round((b.poolMatches / b.totalRequests) * 100) + '%'
          : '0%';
        result.push({
          ...b,
          avgWaitSec:    this._bucketAvgWait(b),
          poolMatchRate,
        });
      }
    });
    result.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

    const totalRequests = result.reduce((s, b) => s + b.totalRequests, 0);
    const peakBucket    = result.reduce((max, b) => (!max || b.totalRequests > max.totalRequests) ? b : max, null);

    return {
      hours,
      bucketCount: result.length,
      buckets: result,
      summary: {
        totalRequests,
        totalPoolMatches:  result.reduce((s, b) => s + b.poolMatches, 0),
        totalSavingsInr:   Math.round(result.reduce((s, b) => s + b.totalSavingsInr, 0) * 100) / 100,
        peakBucket:        peakBucket ? peakBucket.bucketKey : null,
        peakRequests:      peakBucket ? peakBucket.totalRequests : 0,
        overallMatchRate:  totalRequests > 0
          ? Math.round((result.reduce((s, b) => s + b.poolMatches, 0) / totalRequests) * 100) + '%'
          : '0%',
      },
    };
  }

  // Buckets sorted by totalRequests DESC (peak hours analysis)
  getPeakHours(limit = 20) {
    const result = Array.from(this.timeBuckets.values())
      .map(b => ({ ...b, avgWaitSec: this._bucketAvgWait(b) }))
      .sort((a, b) => b.totalRequests - a.totalRequests)
      .slice(0, limit);
    return result;
  }

  // Current live bucket
  getCurrentBucket() {
    const b = this._getBucket();
    return { ...b, avgWaitSec: this._bucketAvgWait(b) };
  }

  // ═══════════════════════════════════════════════════════
  // C) SCENARIO LOGS
  // ═══════════════════════════════════════════════════════

  logScenario(type, data) {
    const entry = {
      logId:     `LOG-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      type,
      ...data,
      peakHour:  isPeakHour(),
      timestamp: new Date().toISOString(),
    };

    // Circular buffer
    if (this.scenarioLogs.length < MAX_SCENARIO_LOGS) {
      this.scenarioLogs.push(entry);
    } else {
      this.scenarioLogs[this._logIndex % MAX_SCENARIO_LOGS] = entry;
    }
    this._logIndex++;
    this._totalLogged++;

    // Aggregate fail reasons for no-match analysis
    if (type === 'no_match_found' && Array.isArray(data.failReasons)) {
      for (const fr of data.failReasons) {
        const agg = this._failReasonAgg.get(fr.reason) || { count: 0, totalValue: 0 };
        agg.count++;
        agg.totalValue += (fr.value || 0);
        this._failReasonAgg.set(fr.reason, agg);
      }
    }

    // Log to time-series
    const timeslotData = {};
    if (type === 'pool_joined')    { timeslotData.waitSec = data.waitTimeSec; timeslotData.savingsInr = data.savingsInr; }
    if (type === 'pool_completed') { timeslotData.savingsInr = data.totalSavingsInr; }
    this.recordTimeslot(type, timeslotData);

    return entry;
  }

  // Query scenario logs with filters
  getScenarioLogs({ type = null, areaKey = null, limit = 100, since = null, poolId = null } = {}) {
    const sinceDate = since ? new Date(since) : null;

    let logs = this.scenarioLogs.filter(l => {
      if (type && l.type !== type) return false;
      if (poolId && l.poolId !== poolId) return false;
      if (sinceDate && new Date(l.timestamp) < sinceDate) return false;
      if (areaKey) {
        const logKey = l.areaKey ||
          (l.pickupLat && l.pickupLng ? this._areaKey(l.pickupLat, l.pickupLng) : null);
        if (logKey !== areaKey) return false;
      }
      return true;
    });

    // Most recent first
    logs = logs.slice().reverse().slice(0, Math.min(limit, 500));
    return logs;
  }

  // Counts by scenario type
  getLogSummary() {
    const counts = {};
    this.scenarioLogs.forEach(l => {
      counts[l.type] = (counts[l.type] || 0) + 1;
    });
    return {
      totalLogged: this._totalLogged,
      inMemory:    Math.min(this._totalLogged, MAX_SCENARIO_LOGS),
      byType:      counts,
    };
  }

  // Aggregate no-match failure reasons with percentages and recommendations
  getNoMatchAnalysis() {
    const noMatchLogs = this.scenarioLogs.filter(l => l.type === 'no_match_found');
    const totalNoMatches = noMatchLogs.length;

    if (totalNoMatches === 0) {
      return { totalNoMatches: 0, failReasons: [], recommendation: 'No no-match events recorded yet.' };
    }

    // Build sorted fail reason list
    const failReasons = Array.from(this._failReasonAgg.entries()).map(([reason, agg]) => {
      const entry = {
        reason,
        count: agg.count,
        pct:   Math.round((agg.count / totalNoMatches) * 100) + '%',
      };
      if (reason === 'pickup_too_far')   entry.avgDistKm = Math.round((agg.totalValue / agg.count) * 100) / 100;
      if (reason === 'bearing_mismatch') entry.avgDiffDeg = Math.round((agg.totalValue / agg.count) * 10) / 10;
      if (reason === 'dest_too_far')     entry.avgDistKm = Math.round((agg.totalValue / agg.count) * 100) / 100;
      if (reason === 'pool_full')        entry.avgRiders = Math.round((agg.totalValue / agg.count) * 10) / 10;
      return entry;
    }).sort((a, b) => b.count - a.count);

    // Auto-recommend fix for top reason
    let recommendation = 'Demand is well-distributed across pools.';
    if (failReasons.length > 0) {
      const top = failReasons[0];
      if (top.reason === 'pickup_too_far')
        recommendation = `${top.pct} of failures are due to pickup distance (avg ${top.avgDistKm}km). Consider increasing POOL_PICKUP_RADIUS_KM.`;
      else if (top.reason === 'bearing_mismatch')
        recommendation = `${top.pct} of failures are direction mismatches (avg ${top.avgDiffDeg}°). Consider increasing POOL_BEARING_TOLERANCE_DEG.`;
      else if (top.reason === 'dest_too_far')
        recommendation = `${top.pct} of failures are destination range issues (avg ${top.avgDistKm}km). Consider increasing POOL_DEST_RANGE_KM.`;
      else if (top.reason === 'pool_full')
        recommendation = `${top.pct} of failures are due to full pools. Consider increasing POOL_MAX_RIDERS.`;
    }

    return { totalNoMatches, failReasons, recommendation };
  }

  // ═══════════════════════════════════════════════════════
  // PERIODIC SNAPSHOTS (every 5 min)
  // ═══════════════════════════════════════════════════════

  _takeDemandSnapshot() {
    const hotAreas = this.getDemandMap().slice(0, 20);
    if (hotAreas.length === 0) return;

    hotAreas.forEach(area => {
      if (area.activeRequests > 0 || area.demandLevel !== 'LOW') {
        this.logScenario('demand_snapshot', {
          areaKey:         area.areaKey,
          pickupLat:       area.centerLat,
          pickupLng:       area.centerLng,
          activeRequests:  area.activeRequests,
          openPools:       area.openPools,
          availableDrivers: area.availableDrivers,
          demandRatio:     area.demandRatio,
          demandLevel:     area.demandLevel,
          totalRequestsToday: area.totalRequestsToday,
          totalSavingsToday:  area.totalSavingsToday,
        });
      }
    });

    logger.info('DEMAND_LOG', `Demand snapshot taken for ${hotAreas.length} areas. Hot areas: ${hotAreas.filter(a => a.demandLevel !== 'LOW').length}`);
  }

  // ═══════════════════════════════════════════════════════
  // DAILY RESET
  // ═══════════════════════════════════════════════════════

  _scheduleDaily() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const msUntilMidnight = tomorrow - now;

    setTimeout(() => {
      this._dailyReset();
      this._scheduleDaily(); // reschedule for next day
    }, msUntilMidnight);
  }

  _dailyReset() {
    this.areaDemand.forEach(area => {
      area.totalRequestsToday = 0;
      area.totalSavingsToday  = 0;
    });
    logger.info('DEMAND_LOG', 'Daily area demand counters reset at midnight.');
  }

  // ═══════════════════════════════════════════════════════
  // STATS
  // ═══════════════════════════════════════════════════════

  getStats() {
    const areas = Array.from(this.areaDemand.values());
    const levelCounts = { LOW: 0, MEDIUM: 0, HIGH: 0, SURGE: 0 };
    areas.forEach(a => { levelCounts[a.demandLevel]++; });

    const currentBucket = this.getCurrentBucket();

    return {
      areaStats: {
        totalAreas:  areas.length,
        byLevel:     levelCounts,
        hotAreas:    levelCounts.HIGH + levelCounts.SURGE,
      },
      timeline: {
        totalBuckets: this.timeBuckets.size,
        currentBucket: {
          key:           currentBucket.bucketKey,
          totalRequests: currentBucket.totalRequests,
          poolMatches:   currentBucket.poolMatches,
          peakHour:      currentBucket.peakHour,
        },
      },
      scenarioLogs: this.getLogSummary(),
    };
  }
}

module.exports = new DemandLogService();
