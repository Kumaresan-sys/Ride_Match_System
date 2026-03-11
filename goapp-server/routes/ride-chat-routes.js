'use strict';

const {
  badRequest,
  buildErrorFromResult,
  forbiddenError,
  normalizeRouteError,
  getAuthenticatedSession,
} = require('./response');

function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
    if (!parsed?.id || !parsed?.createdAt) return null;
    return { id: parsed.id, createdAt: parsed.createdAt };
  } catch (_) {
    return null;
  }
}

function encodeCursor(cursor) {
  if (!cursor?.id || !cursor?.createdAt) return null;
  return Buffer.from(JSON.stringify(cursor)).toString('base64');
}

function registerRideChatRoutes(router, ctx) {
  const { requireAuth, requireAdmin, services } = ctx;
  const rideChatService = services.rideChatService;
  if (!rideChatService) {
    return;
  }

  async function authenticate(headers = {}) {
    return getAuthenticatedSession(requireAuth, headers);
  }

  function hasAdminToken(headers = {}) {
    return Boolean(headers['x-admin-token']);
  }

  async function ensureChatAccess(headers, rideId) {
    if (hasAdminToken(headers)) {
      const adminCheck = requireAdmin(headers);
      if (adminCheck) return { error: normalizeRouteError(adminCheck, 'ADMIN_AUTH_REQUIRED') };
      return { isAdmin: true, userId: 'admin' };
    }
    const auth = await authenticate(headers);
    if (auth.error) return { error: auth.error };
    return { session: auth.session, userId: auth.session.userId, isAdmin: false };
  }

  router.register('GET', '/api/v1/rides/:rideId/chat', async ({ pathParams, headers }) => {
    const access = await ensureChatAccess(headers, pathParams.rideId);
    if (access.error) return access.error;

    const result = await rideChatService.getChatForRide(pathParams.rideId, access.userId, {
      isAdmin: access.isAdmin,
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'RIDE_CHAT_FETCH_FAILED',
        defaultMessage: 'Unable to load ride chat.',
      });
    }
    return {
      data: {
        success: true,
        message: 'Ride chat loaded successfully.',
        data: {
          chat: result.chat,
        },
      },
    };
  });

  router.register('GET', '/api/v1/rides/:rideId/chat/messages', async ({ pathParams, params, headers }) => {
    const access = await ensureChatAccess(headers, pathParams.rideId);
    if (access.error) return access.error;

    const result = await rideChatService.getMessagesForRide(pathParams.rideId, access.userId, {
      isAdmin: access.isAdmin,
      cursor: decodeCursor(params.get('cursor')),
      limit: params.get('limit') ? Number(params.get('limit')) : null,
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'RIDE_CHAT_MESSAGES_FETCH_FAILED',
        defaultMessage: 'Unable to load ride chat messages.',
      });
    }
    return {
      data: {
        success: true,
        message: 'Ride chat messages loaded successfully.',
        data: {
          conversationId: result.conversationId,
          messages: result.messages,
          nextCursor: encodeCursor(result.nextCursor),
        },
      },
    };
  });

  router.register('POST', '/api/v1/rides/:rideId/chat/messages', async ({ pathParams, body, headers, files }) => {
    const access = await ensureChatAccess(headers, pathParams.rideId);
    if (access.error) return access.error;
    if (access.isAdmin) {
      return forbiddenError('Admin monitoring is read-only for ride chat.', 'ADMIN_CHAT_READ_ONLY');
    }

    const result = await rideChatService.sendMessageForRide(pathParams.rideId, access.userId, {
      text: body.text || body.textContent || '',
      clientMessageId: body.clientMessageId || body.client_message_id || null,
      replyToMessageId: body.replyToMessageId || body.reply_to_message_id || null,
      attachmentType: body.attachmentType || body.attachment_type || null,
      durationMs: body.durationMs || body.duration_ms || null,
      files: Array.isArray(files) ? files.filter((file) => file.fieldName === 'attachment' || file.fieldName === 'attachments' || file.fieldName === 'file') : [],
    });

    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'RIDE_CHAT_SEND_FAILED',
        defaultMessage: 'Unable to send ride chat message.',
      });
    }

    return {
      status: 201,
      data: {
        success: true,
        message: 'Ride chat message sent successfully.',
        data: {
          conversationId: result.conversationId,
          message: result.message,
        },
      },
    };
  });

  router.register('POST', '/api/v1/rides/:rideId/chat/read', async ({ pathParams, body, headers }) => {
    const access = await ensureChatAccess(headers, pathParams.rideId);
    if (access.error) return access.error;
    if (access.isAdmin) {
      return forbiddenError('Admin monitoring is read-only for ride chat.', 'ADMIN_CHAT_READ_ONLY');
    }

    const result = await rideChatService.markReadForRide(pathParams.rideId, access.userId, {
      upToMessageId: body.upToMessageId || body.up_to_message_id || body.messageId || null,
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 400,
        defaultCode: 'RIDE_CHAT_READ_FAILED',
        defaultMessage: 'Unable to mark ride chat as read.',
      });
    }

    return {
      data: {
        success: true,
        message: 'Ride chat read receipt stored successfully.',
        data: result,
      },
    };
  });

  router.register('GET', '/api/v1/rides/:rideId/chat/attachments/:attachmentId', async ({ pathParams, headers }) => {
    const access = await ensureChatAccess(headers, pathParams.rideId);
    if (access.error) return access.error;

    const result = await rideChatService.getAttachmentFile(
      pathParams.rideId,
      pathParams.attachmentId,
      access.userId,
      { isAdmin: access.isAdmin },
    );
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 404,
        defaultCode: 'CHAT_ATTACHMENT_NOT_FOUND',
        defaultMessage: 'Chat attachment not found.',
      });
    }

    return {
      raw: true,
      contentType: result.mimeType,
      filename: result.filename,
      buffer: result.buffer,
    };
  });

  router.register('GET', '/api/v1/admin/ride-chats', async ({ params, headers }) => {
    const adminCheck = requireAdmin(headers);
    if (adminCheck) return normalizeRouteError(adminCheck, 'ADMIN_AUTH_REQUIRED');
    const result = await rideChatService.listAdminConversations({
      status: params.get('status') || null,
      rideId: params.get('rideId') || null,
      userId: params.get('userId') || null,
      limit: params.get('limit') ? Number(params.get('limit')) : null,
    });
    return {
      data: {
        success: true,
        message: 'Ride chat conversations loaded successfully.',
        data: {
          conversations: result.conversations,
        },
      },
    };
  });

  router.register('GET', '/api/v1/admin/ride-chats/:conversationId', async ({ pathParams, headers }) => {
    const adminCheck = requireAdmin(headers);
    if (adminCheck) return normalizeRouteError(adminCheck, 'ADMIN_AUTH_REQUIRED');
    const result = await rideChatService.getAdminConversation(pathParams.conversationId);
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 404,
        defaultCode: 'CHAT_NOT_FOUND',
        defaultMessage: 'Ride chat not found.',
      });
    }
    return {
      data: {
        success: true,
        message: 'Ride chat conversation loaded successfully.',
        data: {
          chat: result.chat,
        },
      },
    };
  });

  router.register('GET', '/api/v1/admin/ride-chats/:conversationId/messages', async ({ pathParams, params, headers }) => {
    const adminCheck = requireAdmin(headers);
    if (adminCheck) return normalizeRouteError(adminCheck, 'ADMIN_AUTH_REQUIRED');
    const result = await rideChatService.listAdminMessages(pathParams.conversationId, {
      cursor: decodeCursor(params.get('cursor')),
      limit: params.get('limit') ? Number(params.get('limit')) : null,
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 404,
        defaultCode: 'CHAT_NOT_FOUND',
        defaultMessage: 'Ride chat not found.',
      });
    }
    return {
      data: {
        success: true,
        message: 'Ride chat messages loaded successfully.',
        data: {
          messages: result.messages,
          nextCursor: encodeCursor(result.nextCursor),
        },
      },
    };
  });

  router.register('GET', '/api/v1/admin/ride-chats/:conversationId/events', async ({ pathParams, params, headers }) => {
    const adminCheck = requireAdmin(headers);
    if (adminCheck) return normalizeRouteError(adminCheck, 'ADMIN_AUTH_REQUIRED');
    const result = await rideChatService.listAdminEvents(pathParams.conversationId, {
      cursor: decodeCursor(params.get('cursor')),
      limit: params.get('limit') ? Number(params.get('limit')) : null,
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: result.status || 404,
        defaultCode: 'CHAT_NOT_FOUND',
        defaultMessage: 'Ride chat not found.',
      });
    }
    return {
      data: {
        success: true,
        message: 'Ride chat events loaded successfully.',
        data: {
          events: result.events,
          nextCursor: encodeCursor(result.nextCursor),
        },
      },
    };
  });
}

module.exports = registerRideChatRoutes;
