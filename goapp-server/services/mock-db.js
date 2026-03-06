// GoApp Mock Database
// In-memory repository that emulates future DB-backed read models.

const { generateDrivers, generateRiders } = require('../data/test-data');

class MockDb {
  constructor() {
    this.drivers = new Map();
    this.riders = new Map();
    this.seedMeta = null;
  }

  seed({ driverCount = 20, riderCount = 10, driverSeed = 42, riderSeed = 99 } = {}) {
    const drivers = generateDrivers(driverCount, driverSeed);
    const riders = generateRiders(riderCount, riderSeed);

    this.drivers.clear();
    this.riders.clear();

    for (const driver of drivers) this.drivers.set(driver.driverId, { ...driver });
    for (const rider of riders) this.riders.set(rider.riderId, { ...rider });

    this.seedMeta = {
      seededAt: Date.now(),
      driverCount,
      riderCount,
      driverSeed,
      riderSeed,
    };

    return {
      drivers,
      riders,
      ...this.seedMeta,
    };
  }

  listDrivers() {
    return [...this.drivers.values()];
  }

  listRiders() {
    return [...this.riders.values()];
  }

  getRider(riderId) {
    return this.riders.get(riderId) || null;
  }

  updateRiderRating(riderId, newRating) {
    const rider = this.riders.get(riderId);
    if (rider) rider.rating = newRating;
  }

  getStats() {
    return {
      driverRecords: this.drivers.size,
      riderRecords: this.riders.size,
      seedMeta: this.seedMeta,
    };
  }
}

module.exports = new MockDb();
