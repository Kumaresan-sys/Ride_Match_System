const SimpleRouter = require('./simple-router');
const registerSystemRoutes = require('./system-routes');
const registerAuthRoutes = require('./auth-routes');
const registerRideRoutes = require('./ride-routes');
const registerRideChatRoutes = require('./ride-chat-routes');
const registerWalletRoutes = require('./wallet-routes');
const registerNotificationRoutes = require('./notification-routes');
const registerCoinsRoutes = require('./coins-routes');
const registerClaimsRoutes = require('./claims-routes');
const registerFeedbackRoutes = require('./feedback-routes');
const registerPaymentRoutes = require('./payment-routes');
const registerCancelRideRoutes = require('./cancel-ride-routes');
const registerDriverDocumentRoutes = require('./driver-document-routes');
const registerProfileRoutes = require('./profile-routes');
const registerSafetyRoutes  = require('./safety-routes');
const registerPublicShareRoutes = require('./public-share-routes');
const registerDriverRoutes = require('./driver-routes');
const registerSosRoutes = require('./sos-routes');
const registerTicketRoutes = require('./ticket-routes');
const registerPoolRoutes = require('./pool-routes');
const registerIncentiveRoutes = require('./incentive-routes');
const registerDemandRoutes = require('./demand-routes');
const registerAdminSupportRoutes = require('./admin-support-routes');
const registerRecoveryRoutes = require('./recovery-routes');
const registerAdminVehicleRoutes = require('./admin-vehicle-routes');
const registerSavedLocationsRoutes   = require('./saved-locations-routes');
const registerZoneRestrictionRoutes  = require('./zone-restriction-routes');
const registerZoneAnalyticsRoutes = require('./zone-analytics-routes');
const { notFoundError } = require('./response');

function buildRouteDispatcher(context) {
  const router = new SimpleRouter();
  registerSystemRoutes(router, context);
  registerAuthRoutes(router, context);
  registerProfileRoutes(router, context);
  registerSafetyRoutes(router, context);
  registerPublicShareRoutes(router, context);
  registerSosRoutes(router, context);
  registerDriverRoutes(router, context);
  registerTicketRoutes(router, context);
  registerRideRoutes(router, context);
  registerRideChatRoutes(router, context);
  registerCancelRideRoutes(router, context);
  registerCoinsRoutes(router, context);
  registerClaimsRoutes(router, context);
  registerWalletRoutes(router, context);
  registerNotificationRoutes(router, context);
  registerFeedbackRoutes(router, context);
  registerPaymentRoutes(router, context);
  registerDriverDocumentRoutes(router, context);
  registerPoolRoutes(router, context);
  registerIncentiveRoutes(router, context);
  registerDemandRoutes(router, context);
  registerAdminSupportRoutes(router, context);
  registerRecoveryRoutes(router, context);
  registerAdminVehicleRoutes(router, context);
  registerSavedLocationsRoutes(router, context);
  registerZoneRestrictionRoutes(router, context);
  registerZoneAnalyticsRoutes(router, context);

  return async (method, path, body, params, headers, files, ip) => {
    const routed = await router.dispatch({ method, path, body, params, headers, files, ip });
    if (routed) return routed;
    return notFoundError('Not found', 'NOT_FOUND', { path, method });
  };
}

module.exports = buildRouteDispatcher;
