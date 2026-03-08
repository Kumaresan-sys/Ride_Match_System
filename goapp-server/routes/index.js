const SimpleRouter = require('./simple-router');
const registerSystemRoutes = require('./system-routes');
const registerAuthRoutes = require('./auth-routes');
const registerRideRoutes = require('./ride-routes');
const registerWalletRoutes = require('./wallet-routes');
const registerFeedbackRoutes = require('./feedback-routes');
const registerPaymentRoutes = require('./payment-routes');
const registerDriverDocumentRoutes = require('./driver-document-routes');
const registerProfileRoutes = require('./profile-routes');
const registerSafetyRoutes  = require('./safety-routes');

function buildRouteDispatcher(context, legacyHandler) {
  const router = new SimpleRouter();
  registerSystemRoutes(router, context);
  registerAuthRoutes(router, context);
  registerProfileRoutes(router, context);
  registerSafetyRoutes(router, context);
  registerRideRoutes(router, context);
  registerWalletRoutes(router, context);
  registerFeedbackRoutes(router, context);
  registerPaymentRoutes(router, context);
  registerDriverDocumentRoutes(router, context);

  return async (method, path, body, params, headers, files, ip) => {
    const routed = await router.dispatch({ method, path, body, params, headers, files, ip });
    if (routed) return routed;
    return legacyHandler(method, path, body, params, headers);
  };
}

module.exports = buildRouteDispatcher;
