// GoApp Performance Monitor
// Lightweight in-memory request metrics tracker

class PerfMonitor {
  constructor() {
    this.requestsTotal = 0;
    this.responseTimes = [];     // sliding window of last 500 response times (ms)
    this.windowSize = 500;
    this.startTime = Date.now();

    // Matching stats
    this.matchingTotal = 0;
    this.matchingSuccess = 0;
    this.matchingFailed = 0;
    this.matchingTimes = [];     // sliding window of matching durations (ms)
  }

  // Call at the start of every request; returns a done() callback
  startRequest() {
    const t0 = Date.now();
    return () => {
      const elapsed = Date.now() - t0;
      this.requestsTotal++;
      this.responseTimes.push(elapsed);
      if (this.responseTimes.length > this.windowSize) {
        this.responseTimes.shift();
      }
    };
  }

  recordMatch(success, durationMs) {
    this.matchingTotal++;
    if (success) this.matchingSuccess++;
    else this.matchingFailed++;

    this.matchingTimes.push(durationMs);
    if (this.matchingTimes.length > this.windowSize) {
      this.matchingTimes.shift();
    }
  }

  getSnapshot(services) {
    const mem = process.memoryUsage();
    const uptimeSec = Math.floor(process.uptime());

    // Response time stats
    const rt = this.responseTimes;
    const avgResponseMs = rt.length > 0
      ? Math.round(rt.reduce((s, v) => s + v, 0) / rt.length)
      : 0;
    const p95ResponseMs = rt.length > 0
      ? rt.slice().sort((a, b) => a - b)[Math.floor(rt.length * 0.95)]
      : 0;

    // Requests per minute
    const uptimeMin = Math.max(uptimeSec / 60, 1 / 60);
    const requestsPerMin = Math.round(this.requestsTotal / uptimeMin);

    // Matching time stats
    const mt = this.matchingTimes;
    const avgMatchTimeMs = mt.length > 0
      ? Math.round(mt.reduce((s, v) => s + v, 0) / mt.length)
      : 0;

    // Map sizes from services
    const maps = {};
    try {
      maps.rides = services.rideService?.rides?.size ?? 'n/a';
      maps.driverPool = services.matchingEngine?.driverPool?.size ?? 'n/a';
      maps.activeMatches = services.matchingEngine?.activeMatches?.size ?? 'n/a';
      maps.excludedDrivers = services.matchingEngine?.excludedDrivers?.size ?? 'n/a';
      maps.cancellationCounts = services.rideService?.cancellationCounts?.size ?? 'n/a';
      maps.wallets = services.walletService?.wallets?.size ?? 'n/a';
      maps.driverWallets = services.driverWalletService?.wallets?.size ?? 'n/a';
    } catch (_) { /* safe fallback */ }

    return {
      uptime: { seconds: uptimeSec, humanReadable: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s` },
      memory: {
        heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(1),
        heapTotalMB: +(mem.heapTotal / 1024 / 1024).toFixed(1),
        rssMB: +(mem.rss / 1024 / 1024).toFixed(1),
        externalMB: +(mem.external / 1024 / 1024).toFixed(1),
      },
      maps,
      throughput: {
        requestsTotal: this.requestsTotal,
        requestsPerMin,
        sampledRequests: rt.length,
        avgResponseMs,
        p95ResponseMs,
      },
      matching: {
        totalMatches: this.matchingTotal,
        successfulMatches: this.matchingSuccess,
        failedMatches: this.matchingFailed,
        avgMatchTimeMs,
      },
    };
  }
}

module.exports = new PerfMonitor();
