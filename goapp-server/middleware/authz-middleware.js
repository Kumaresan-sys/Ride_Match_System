'use strict';

async function requireOwnedResource({
  headers,
  resourceUserId,
  requireAuth,
  requireAdmin,
  allowAdmin = true,
  forbiddenMessage = 'Forbidden: cannot access another user resource.',
}) {
  if (allowAdmin && headers && headers['x-admin-token']) {
    const adminError = requireAdmin(headers);
    if (!adminError) {
      return { session: { userId: resourceUserId, role: 'admin' } };
    }
  }

  const auth = await requireAuth(headers || {});
  if (auth.error) return { error: auth.error };

  if (String(auth.session.userId) !== String(resourceUserId)) {
    return {
      error: {
        status: 403,
        data: { error: forbiddenMessage },
      },
    };
  }

  return { session: auth.session };
}

module.exports = {
  requireOwnedResource,
};
