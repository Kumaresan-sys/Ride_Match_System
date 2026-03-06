function registerAuthRoutes(router, ctx) {
  const { repositories } = ctx;

  router.register('POST', '/api/v1/auth/otp/request', async ({ body }) => {
    const result = repositories.identity.requestOtp(body);
    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('POST', '/api/v1/auth/otp/verify', async ({ body }) => {
    const result = repositories.identity.verifyOtp(body);
    return { status: result.success ? 200 : 400, data: result };
  });
}

module.exports = registerAuthRoutes;
