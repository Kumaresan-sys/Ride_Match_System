'use strict';

class MetricsRegistry {
  constructor() {
    this.counters = new Map();
    this.histograms = new Map();
  }

  inc(name, by = 1) {
    const current = this.counters.get(name) || 0;
    this.counters.set(name, current + by);
  }

  observe(name, value) {
    if (!this.histograms.has(name)) this.histograms.set(name, []);
    this.histograms.get(name).push(Number(value));
  }

  getCounter(name) {
    return this.counters.get(name) || 0;
  }

  snapshot() {
    const histogramSummary = {};
    for (const [name, values] of this.histograms.entries()) {
      if (values.length === 0) {
        histogramSummary[name] = { count: 0, p50: null, p95: null, max: null };
        continue;
      }
      const sorted = [...values].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      histogramSummary[name] = {
        count: values.length,
        p50,
        p95,
        max: sorted[sorted.length - 1],
      };
    }

    return {
      counters: Object.fromEntries(this.counters.entries()),
      histograms: histogramSummary,
    };
  }
}

module.exports = new MetricsRegistry();
