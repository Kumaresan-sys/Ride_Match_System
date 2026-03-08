'use strict';

const pgRepo = require('../repositories/pg/pg-identity-repository');

function formatMemberSince(createdAt) {
  if (createdAt === null || createdAt === undefined || createdAt === '') {
    return '';
  }

  let normalized = createdAt;
  if (typeof createdAt === 'string') {
    const trimmed = createdAt.trim();
    if (!trimmed) return '';

    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) {
      normalized = asNumber;
    } else {
      normalized = trimmed;
    }
  }

  const date = new Date(normalized);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

function registerProfileRoutes(router, ctx) {
  const { requireAuth } = ctx;
  const notificationService = ctx.services?.notificationService;

  // POST /api/v1/profile/create  — save/update rider profile
  const createProfileHandler = async ({ body, headers }) => {
    const authResult = await requireAuth(headers);
    if (authResult.error) return authResult.error;

    const { userId } = authResult.session;
    const name             = String(body?.name || '').trim();
    const gender           = String(body?.gender || '').trim();
    const dateOfBirth      = String(body?.date_of_birth || '').trim();
    const email            = String(body?.email || '').trim();
    const emergencyContact = String(body?.emergency_contact || '').trim();

    if (!name || !gender || !dateOfBirth) {
      return {
        status: 400,
        data: { success: false, message: 'name, gender and date_of_birth are required' },
      };
    }

    try {
      await pgRepo.upsertUserProfileWithEmail({
        userId,
        name,
        gender,
        dateOfBirth,
        emergencyContact,
        email,
      });
    } catch (err) {
      if (err.code === 'EMAIL_DUPLICATE') {
        return { status: 409, data: { success: false, message: err.message } };
      }
      throw err;
    }

    const [bonusResult, referralResult] = await Promise.all([
      pgRepo.awardWelcomeBonus(userId),
      pgRepo.generateOrGetReferralCode(userId),
    ]);

    if (bonusResult.coinsAwarded > 0 && notificationService) {
      notificationService.send(userId, {
        title: '🎉 100 Coins Added!',
        body: 'Your welcome bonus has been added to your wallet.',
        data: { type: 'WELCOME_COINS', coins: '100', channelId: 'goapp_auth' },
      }).catch(() => {});
    }

    return {
      status: 200,
      data: {
        id: userId,
        name,
        gender,
        date_of_birth: dateOfBirth,
        email,
        emergency_contact: emergencyContact,
        coinsAwarded: bonusResult.coinsAwarded,
        referralCode: referralResult.code,
      },
    };
  };

  // GET /api/v1/profile  — fetch current rider profile
  const getProfileHandler = async ({ headers }) => {
    const authResult = await requireAuth(headers);
    if (authResult.error) return authResult.error;

    const { userId } = authResult.session;
    const [profile, user] = await Promise.all([
      pgRepo.getUserProfile(userId),
      pgRepo.getUserById(userId),
    ]);

    if (!profile) {
      return {
        status: 404,
        data: { success: false, message: 'Profile not found' },
      };
    }

    const memberSince = formatMemberSince(profile.createdAt ?? user?.createdAt);

    return {
      status: 200,
      data: {
        id:                userId,
        name:              profile.name || '',
        gender:            profile.gender || '',
        date_of_birth:     profile.date_of_birth || '',
        email:             user?.email || '',
        emergency_contact: profile.emergency_contact || '',
        phone_number:      user?.phone_number || '',
        member_since:      memberSince,
      },
    };
  };

  // PUT /api/v1/profile  — update name and/or email
  const updateProfileHandler = async ({ body, headers }) => {
    const authResult = await requireAuth(headers);
    if (authResult.error) return authResult.error;

    const { userId } = authResult.session;
    const name  = body?.name  != null ? String(body.name).trim()  : null;
    const email = body?.email != null ? String(body.email).trim() : null;

    if (name === null && email === null) {
      return { status: 400, data: { success: false, message: 'Nothing to update' } };
    }

    try {
      await pgRepo.updateProfileFields({ userId, name, email });
    } catch (err) {
      if (err.code === 'EMAIL_DUPLICATE') {
        return { status: 409, data: { success: false, message: err.message } };
      }
      throw err;
    }

    return { status: 200, data: { success: true, message: 'Profile updated' } };
  };

  router.register('POST', '/api/v1/profile/create', createProfileHandler);
  router.register('GET',  '/api/v1/profile',        getProfileHandler);
  router.register('PUT',  '/api/v1/profile',        updateProfileHandler);
}

module.exports = registerProfileRoutes;
module.exports.formatMemberSince = formatMemberSince;
