'use strict';

const { getAuthenticatedSession } = require('./response');

function registerClaimsRoutes(router, ctx) {
  const requireAuth = ctx.requireAuth;
  const referralService = ctx.services.referralService;

  async function getSession(headers = {}) {
    return getAuthenticatedSession(requireAuth, headers);
  }

  router.register('GET', '/api/v1/claims/referral', async ({ headers }) => {
    const auth = await getSession(headers || {});
    if (auth.error) return auth.error;

    const summary = await referralService.getReferralSummary(auth.session.userId);
    return { data: summary };
  });
}

module.exports = registerClaimsRoutes;
