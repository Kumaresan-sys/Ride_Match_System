// GoApp Test Data

const chennaiLocations = {
  central: { lat: 13.0827, lng: 80.2707 },
  tNagar: { lat: 13.0418, lng: 80.2341 },
  mylapore: { lat: 13.0339, lng: 80.2619 },
  airport: { lat: 12.9941, lng: 80.1709 },
  velachery: { lat: 12.9755, lng: 80.2211 },
  sholinganallur: { lat: 12.9010, lng: 80.2279 },
  egmore: { lat: 13.0732, lng: 80.2609 },
  marina: { lat: 13.0500, lng: 80.2824 },
  tambaram: { lat: 12.9249, lng: 80.1000 },
  guindy: { lat: 13.0067, lng: 80.2206 },
  adyar: { lat: 13.0012, lng: 80.2565 },
};

const names = ['Arun', 'Bala', 'Charan', 'Deepak', 'Ezhil', 'Farook', 'Gokul', 'Hari', 'Imran', 'Jai', 'Karthik', 'Lokesh'];
const vehicleTypes = ['mini', 'sedan', 'suv', 'premium'];
const vehicleBrands = ['Suzuki', 'Hyundai', 'Honda', 'Toyota'];
const FIXED_NOW = 1700000000000;

function createRng(seed = 42) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function jitter(base, rng, range = 0.02) {
  return base + ((rng() - 0.5) * range);
}

function generateDrivers(count = 20, seed = 42) {
  const hubs = Object.values(chennaiLocations);
  const rng = createRng(seed);

  return Array.from({ length: count }, (_, i) => {
    const hub = hubs[i % hubs.length];
    const type = vehicleTypes[i % vehicleTypes.length];
    const offered = 50 + Math.floor(rng() * 150);
    const accepted = Math.floor(offered * (0.65 + rng() * 0.3));

    return {
      driverId: `D${String(i + 1).padStart(3, '0')}`,
      name: names[i % names.length],
      vehicleType: type,
      vehicleBrand: vehicleBrands[i % vehicleBrands.length],
      vehicleNumber: `TN-${10 + (i % 80)}-AB-${1000 + i}`,
      lat: jitter(hub.lat, rng),
      lng: jitter(hub.lng, rng),
      speed: 4 + rng() * 10,
      heading: Math.floor(rng() * 360),
      rating: +(4.0 + rng()).toFixed(1),
      ridesOffered: offered,
      ridesAccepted: accepted,
      ridesCompleted: Math.floor(accepted * (0.9 + rng() * 0.1)),
      status: 'online',
      lastLocationUpdate: FIXED_NOW,
      lastTripEndTime: FIXED_NOW - Math.floor(rng() * 40 * 60 * 1000),
    };
  });
}

function generateRiders(count = 10, seed = 99) {
  const rng = createRng(seed);

  return Array.from({ length: count }, (_, i) => ({
    riderId: `R${String(i + 1).padStart(3, '0')}`,
    name: `Rider-${i + 1}`,
    rating: +(4.2 + rng() * 0.8).toFixed(1),
  }));
}

function generateIdentityUsers(count = 20, seed = 123) {
  const rng = createRng(seed);
  const countries = ['+91', '+1', '+44'];

  return Array.from({ length: count }, (_, i) => {
    const country = countries[i % countries.length];
    const localNumber = `${Math.floor(6000000000 + (rng() * 3999999999))}`;
    return {
      userId: `USR-${String(i + 1).padStart(4, '0')}`,
      phoneNumber: `${country}${localNumber}`,
      name: `${names[i % names.length]} User`,
      userType: i % 7 === 0 ? 'driver' : 'rider',
      phoneVerified: i % 4 !== 0,
      status: 'active',
      createdAt: FIXED_NOW - Math.floor(rng() * 10 * 24 * 60 * 60 * 1000),
    };
  });
}

function generateRideScenarios() {
  return [
    {
      name: 'Peak hour office commute',
      description: 'T. Nagar to Mylapore evening trip',
      riderId: 'R001',
      pickup: chennaiLocations.tNagar,
      dest: chennaiLocations.mylapore,
      rideType: 'sedan',
    },
    {
      name: 'Airport transfer',
      description: 'Central to Airport morning trip',
      riderId: 'R002',
      pickup: chennaiLocations.central,
      dest: chennaiLocations.airport,
      rideType: 'premium',
    },
    {
      name: 'Budget short hop',
      description: 'Egmore to Marina',
      riderId: 'R003',
      pickup: chennaiLocations.egmore,
      dest: chennaiLocations.marina,
      rideType: 'mini',
    },
    {
      name: 'Tech corridor',
      description: 'Velachery to Sholinganallur',
      riderId: 'R004',
      pickup: chennaiLocations.velachery,
      dest: chennaiLocations.sholinganallur,
      rideType: 'suv',
    },
  ];
}

function generateSurgeScenarios() {
  return [
    { zone: 'chennai:central', name: 'Central', demand: 120, supply: 100 },
    { zone: 'chennai:t-nagar', name: 'T. Nagar', demand: 180, supply: 95 },
    { zone: 'chennai:airport', name: 'Airport', demand: 140, supply: 60 },
    { zone: 'chennai:omr', name: 'OMR', demand: 210, supply: 90 },
  ];
}

function generateFraudTestData() {
  return [
    {
      name: 'Normal movement',
      prev: { lat: 13.0418, lng: 80.2341 },
      curr: { lat: 13.0425, lng: 80.2350 },
      timeDiff: 20,
    },
    {
      name: 'Suspicious jump',
      prev: { lat: 13.0418, lng: 80.2341 },
      curr: { lat: 13.0900, lng: 80.2500 },
      timeDiff: 5,
    },
  ];
}

module.exports = {
  chennaiLocations,
  generateDrivers,
  generateRiders,
  generateIdentityUsers,
  generateRideScenarios,
  generateSurgeScenarios,
  generateFraudTestData,
};
