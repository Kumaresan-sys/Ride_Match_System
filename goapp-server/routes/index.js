const SimpleRouter = require('./simple-router');
const registerSystemRoutes = require('./system-routes');
const registerAuthRoutes = require('./auth-routes');
const registerRideRoutes = require('./ride-routes');
const registerWalletRoutes = require('./wallet-routes');

function buildRouteDispatcher(context, legacyHandler) {
  const router = new SimpleRouter();
  registerSystemRoutes(router, context);
  registerAuthRoutes(router, context);
  registerRideRoutes(router, context);
  registerWalletRoutes(router, context);

  return async (method, path, body, params, headers) => {
    const routed = await router.dispatch({ method, path, body, params, headers });
    if (routed) return routed;
    return legacyHandler(method, path, body, params, headers);
  };
}

module.exports = buildRouteDispatcher;
