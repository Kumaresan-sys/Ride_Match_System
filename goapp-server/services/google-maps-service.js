// Google Maps Service
// Wraps Distance Matrix API and Places Autocomplete API.
// Falls back gracefully to Haversine-based estimates when the API key is
// absent, the quota is exceeded, or a network error occurs.

const config = require('../config');
const { haversine } = require('../utils/formulas');
const { logger } = require('../utils/logger');

// Lazy-require the SDK so the server still boots without the package installed.
let Client;
try {
  ({ Client } = require('@googlemaps/google-maps-services-js'));
} catch {
  Client = null;
}

class GoogleMapsService {
  constructor() {
    this._client = Client && config.googleMaps.apiKey ? new Client({}) : null;
    this._enabled = !!this._client;
    this.stats = {
      distanceMatrixCalls: 0,
      distanceMatrixFallbacks: 0,
      autocompleteCalls: 0,
      geocodeCalls: 0,
    };

    if (this._enabled) {
      logger.info('MAPS', 'Google Maps service enabled (Distance Matrix + Places)');
    } else {
      logger.warn('MAPS', 'GOOGLE_MAPS_API_KEY not set — using Haversine fallback for distances');
    }
  }

  get isEnabled() {
    return this._enabled;
  }

  // ─── Distance Matrix ────────────────────────────────────────────────────
  // Returns { distanceKm, durationMin, source: 'google'|'haversine' }
  // Always resolves (never rejects) — falls back to Haversine on any error.
  async getRoadDistance(originLat, originLng, destLat, destLng) {
    if (this._enabled) {
      try {
        const response = await this._client.distancematrix(
          {
            params: {
              origins: [{ lat: originLat, lng: originLng }],
              destinations: [{ lat: destLat, lng: destLng }],
              key: config.googleMaps.apiKey,
              departure_time: 'now',
              traffic_model: config.googleMaps.trafficModel,
            },
            timeout: config.googleMaps.timeoutMs,
          },
        );

        const element = response.data.rows[0]?.elements[0];
        if (element?.status === 'OK') {
          this.stats.distanceMatrixCalls += 1;
          const distanceKm = element.distance.value / 1000;
          // Use duration_in_traffic when available (requires departure_time: 'now')
          const durationSec = (element.duration_in_traffic || element.duration).value;
          const durationMin = durationSec / 60;
          return { distanceKm, durationMin, source: 'google' };
        }

        logger.warn('MAPS', `Distance Matrix element status: ${element?.status}`);
      } catch (err) {
        logger.warn('MAPS', `Distance Matrix error: ${err.message} — falling back to Haversine`);
      }
    }

    return this._haversineFallback(originLat, originLng, destLat, destLng);
  }

  _haversineFallback(originLat, originLng, destLat, destLng) {
    this.stats.distanceMatrixFallbacks += 1;
    const straightLineKm = haversine(originLat, originLng, destLat, destLng);
    // Apply 1.25 road-winding factor (same as legacy pricing-service)
    const distanceKm = straightLineKm * 1.25;
    const durationMin = (distanceKm / config.scoring.avgCitySpeedKmh) * 60;
    return { distanceKm, durationMin, source: 'haversine' };
  }

  // ─── Places Autocomplete ────────────────────────────────────────────────
  // Returns array of { placeId, description, mainText, secondaryText }
  async autocomplete(input, sessionToken, lat, lng) {
    if (!this._enabled) {
      return { error: 'Google Maps not configured. Set GOOGLE_MAPS_API_KEY.', suggestions: [] };
    }

    try {
      const params = {
        input,
        key: config.googleMaps.apiKey,
        components: [`country:${config.googleMaps.autocompleteCountry}`],
        sessiontoken: sessionToken,
      };

      // Bias results toward the user's current location if provided
      if (lat != null && lng != null) {
        params.location = { lat, lng };
        params.radius = 50000; // 50 km bias radius
      }

      const response = await this._client.placeAutocomplete(
        { params, timeout: config.googleMaps.timeoutMs },
      );

      this.stats.autocompleteCalls += 1;

      const suggestions = (response.data.predictions || []).map(p => ({
        placeId: p.place_id,
        description: p.description,
        mainText: p.structured_formatting?.main_text || p.description,
        secondaryText: p.structured_formatting?.secondary_text || '',
      }));

      return { suggestions };
    } catch (err) {
      logger.warn('MAPS', `Autocomplete error: ${err.message}`);
      return { error: err.message, suggestions: [] };
    }
  }

  // ─── Place Details → lat/lng ────────────────────────────────────────────
  // Returns { lat, lng, formattedAddress } for a given placeId
  async getPlaceCoordinates(placeId, sessionToken) {
    if (!this._enabled) {
      return { error: 'Google Maps not configured. Set GOOGLE_MAPS_API_KEY.' };
    }

    try {
      const response = await this._client.placeDetails(
        {
          params: {
            place_id: placeId,
            fields: ['geometry', 'formatted_address'],
            key: config.googleMaps.apiKey,
            sessiontoken: sessionToken,
          },
          timeout: config.googleMaps.timeoutMs,
        },
      );

      this.stats.geocodeCalls += 1;
      const result = response.data.result;
      return {
        lat: result.geometry.location.lat,
        lng: result.geometry.location.lng,
        formattedAddress: result.formatted_address,
      };
    } catch (err) {
      logger.warn('MAPS', `Place Details error: ${err.message}`);
      return { error: err.message };
    }
  }

  // ─── Reverse Geocode ─────────────────────────────────────────────────────
  // Returns human-readable address for a lat/lng pair
  async reverseGeocode(lat, lng) {
    if (!this._enabled) {
      return { error: 'Google Maps not configured. Set GOOGLE_MAPS_API_KEY.' };
    }

    try {
      const response = await this._client.reverseGeocode(
        {
          params: {
            latlng: { lat, lng },
            key: config.googleMaps.apiKey,
          },
          timeout: config.googleMaps.timeoutMs,
        },
      );

      this.stats.geocodeCalls += 1;
      const results = response.data.results;
      if (!results || results.length === 0) return { error: 'No results' };
      return { formattedAddress: results[0].formatted_address };
    } catch (err) {
      logger.warn('MAPS', `Reverse Geocode error: ${err.message}`);
      return { error: err.message };
    }
  }

  getStats() {
    return {
      enabled: this._enabled,
      ...this.stats,
    };
  }
}

module.exports = new GoogleMapsService();
