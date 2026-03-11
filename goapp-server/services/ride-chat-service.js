'use strict';

const crypto = require('crypto');
const config = require('../config');
const redis = require('./redis-client');
const { logger, eventBus } = require('../utils/logger');
const pgRideRepository = require('../repositories/pg/pg-ride-repository');
const rideChatRepository = require('../repositories/pg/pg-ride-chat-repository');

const READABLE_ROLES = new Set(['rider', 'driver']);
const IMAGE_MIME_RE = /^image\/(jpeg|png|webp)$/i;
const VOICE_MIME_RE = /^(audio\/(aac|mpeg|mp3|ogg|wav|x-m4a|m4a|webm)|application\/ogg)$/i;

class RideChatService {
  constructor({ rideService = null, notificationService = null, storageService = null, wsServer = null } = {}) {
    this.rideService = rideService;
    this.notificationService = notificationService;
    this.storageService = storageService;
    this.wsServer = wsServer;
    this._lifecycleAttached = false;
    this._attachLifecycleListeners();
  }

  setWebSocketServer(wsServer) {
    this.wsServer = wsServer;
  }

  setNotificationService(notificationService) {
    this.notificationService = notificationService;
  }

  _attachLifecycleListeners() {
    if (this._lifecycleAttached) return;
    this._lifecycleAttached = true;

    eventBus.on('ride_matched', async (event) => {
      await this._handleRideMatched(event?.data || event).catch((err) => {
        logger.warn('RIDE-CHAT', `ride_matched hook failed: ${err.message}`);
      });
    });

    eventBus.on('ride_cancelled_by_driver', async (event) => {
      await this._closeConversationForRide(event?.data?.rideId, 'driver_reassigned', {
        actorRole: 'system',
      }).catch((err) => logger.warn('RIDE-CHAT', `ride_cancelled_by_driver hook failed: ${err.message}`));
    });

    eventBus.on('ride_cancelled_by_rider', async (event) => {
      await this._closeConversationForRide(event?.data?.rideId, 'ride_cancelled', {
        actorRole: 'rider',
        actorUserId: event?.data?.userId || null,
      }).catch((err) => logger.warn('RIDE-CHAT', `ride_cancelled_by_rider hook failed: ${err.message}`));
    });

    eventBus.on('ride_completed', async (event) => {
      await this._closeConversationForRide(event?.data?.rideId, 'ride_completed', {
        actorRole: 'system',
      }).catch((err) => logger.warn('RIDE-CHAT', `ride_completed hook failed: ${err.message}`));
    });

    eventBus.on('ride_no_drivers', async (event) => {
      await this._closeConversationForRide(event?.data?.rideId, 'no_drivers', {
        actorRole: 'system',
      }).catch((err) => logger.warn('RIDE-CHAT', `ride_no_drivers hook failed: ${err.message}`));
    });
  }

  async _handleRideMatched(event = {}) {
    const rideId = String(event.rideId || '').trim();
    if (!rideId) return null;
    const ride = await pgRideRepository.getRide(rideId).catch(() => null);
    if (!ride?.riderId || !ride?.driverId) return null;

    const opened = await rideChatRepository.openConversationForAssignment(
      rideId,
      ride.riderId,
      ride.driverId,
      { actorUserId: ride.driverId },
    );
    if (!opened?.conversation) return null;

    const payload = await this._buildConversationPayload(opened.conversation.id, rideId);
    if (!payload) return null;

    if (opened.switchedFromConversationId) {
      this._broadcastConversationClosed(opened.switchedFromConversationId, {
        rideId,
        closedReason: 'driver_reassigned',
        replacementConversationId: opened.conversation.id,
      });
    }

    this._broadcastConversationSwitched(payload, opened.switchedFromConversationId);
    return payload;
  }

  async _closeConversationForRide(rideId, closedReason, { actorRole = 'system', actorUserId = null } = {}) {
    if (!rideId) return null;
    const conversation = await rideChatRepository.closeActiveConversation(rideId, closedReason, {
      actorRole,
      actorUserId,
    });
    if (!conversation) return null;
    this._broadcastConversationClosed(conversation.id, {
      rideId: conversation.rideId,
      conversationId: conversation.id,
      closedReason,
    });
    return conversation;
  }

  async _buildConversationPayload(conversationId, rideIdOverride = null) {
    const participants = await rideChatRepository.getConversationParticipants(conversationId);
    if (!participants) return null;
    const { messages, nextCursor } = await rideChatRepository.getMessages(conversationId, {
      limit: config.chat.defaultPageSize,
    });
    const rideId = rideIdOverride || participants.rideId;
    return {
      conversationId,
      rideId,
      status: participants.status,
      assignmentSeq: Number(participants.assignmentSeq || 1),
      closedReason: participants.closedReason || null,
      messageCount: Number(participants.messageCount || 0),
      lastMessageAt: participants.lastMessageAt || null,
      channel: `ride_chat_${conversationId}`,
      rider: {
        userId: participants.riderId,
        name: participants.riderName || 'Rider',
        phone: participants.riderPhone || null,
      },
      driver: {
        userId: participants.driverId,
        name: participants.driverName || 'Driver',
        phone: participants.driverPhone || null,
        vehicleType: participants.driverVehicleType || null,
        vehicleNumber: participants.driverVehicleNumber || null,
        rating: participants.driverRating != null ? Number(participants.driverRating) : null,
        avatarUrl: participants.driverAvatarUrl || null,
        completedRides: participants.driverCompletedRides != null
          ? Number(participants.driverCompletedRides)
          : null,
      },
      messages,
      nextCursor,
    };
  }

  async getChatForRide(rideId, userId, { isAdmin = false } = {}) {
    if (!isAdmin) {
      const allowed = await rideChatRepository.canUserAccessRide(rideId, userId);
      if (!allowed) {
        return { success: false, status: 403, code: 'FORBIDDEN_RIDE_CHAT_ACCESS', message: 'Forbidden ride chat access.' };
      }
    }

    const conversation = await rideChatRepository.getConversationSnapshotByRide(rideId);
    if (!conversation) {
      return { success: false, status: 409, code: 'CHAT_NOT_READY', message: 'Ride chat is not available yet.' };
    }

    const payload = await this._buildConversationPayload(conversation.id, conversation.rideId);
    if (!payload) {
      return { success: false, status: 404, code: 'CHAT_NOT_FOUND', message: 'Ride chat not found.' };
    }

    const canSend = await this._canUserSendToRide(rideId, userId, { isAdmin });
    return {
      success: true,
      chat: {
        ...payload,
        canSend,
        writableWindowOpen: canSend,
      },
    };
  }

  async getMessagesForRide(rideId, userId, { cursor = null, limit = null, isAdmin = false } = {}) {
    const chat = await this.getChatForRide(rideId, userId, { isAdmin });
    if (!chat.success) return chat;

    const { messages, nextCursor } = await rideChatRepository.getMessages(chat.chat.conversationId, {
      cursor,
      limit: limit || config.chat.defaultPageSize,
    });
    return {
      success: true,
      conversationId: chat.chat.conversationId,
      messages,
      nextCursor,
    };
  }

  async sendMessageForRide(rideId, userId, payload = {}) {
    const senderRole = await this._resolveSenderRole(rideId, userId);
    if (!senderRole) {
      return { success: false, status: 403, code: 'FORBIDDEN_RIDE_CHAT_ACCESS', message: 'Forbidden ride chat access.' };
    }

    const chat = await this.getChatForRide(rideId, userId);
    if (!chat.success) {
      return chat;
    }
    if (!chat.chat.canSend) {
      return { success: false, status: 409, code: 'CHAT_WINDOW_CLOSED', message: 'Chat is closed for this ride.' };
    }

    const normalized = await this._normalizeOutgoingPayload(
      rideId,
      chat.chat.conversationId,
      payload,
    );
    if (!normalized.success) return normalized;

    try {
      const created = await rideChatRepository.createMessage(rideId, {
        id: normalized.messageId,
        senderUserId: userId,
        senderRole,
        messageType: normalized.messageType,
        textContent: normalized.textContent,
        replyToMessageId: normalized.replyToMessageId,
        clientMessageId: normalized.clientMessageId,
        metadata: normalized.metadata,
        attachments: normalized.attachments,
      });

      if (created?.error === 'RIDE_NOT_FOUND') {
        await this._deleteStoredAttachments(normalized.attachments);
        return { success: false, status: 404, code: 'RIDE_NOT_FOUND', message: 'Ride not found.' };
      }
      if (created?.error === 'CHAT_NOT_READY') {
        await this._deleteStoredAttachments(normalized.attachments);
        return { success: false, status: 409, code: 'CHAT_NOT_READY', message: 'Ride chat is not available yet.' };
      }
      if (created?.error === 'CHAT_WINDOW_CLOSED') {
        await this._deleteStoredAttachments(normalized.attachments);
        return { success: false, status: 409, code: 'CHAT_WINDOW_CLOSED', message: 'Chat is closed for this ride.' };
      }

      const message = created.message;
      const conversation = created.conversation;
      const recipientUserId = senderRole === 'rider' ? conversation.driverId : conversation.riderId;

      this._broadcastMessageCreated(conversation.id, {
        rideId: conversation.rideId,
        conversationId: conversation.id,
        message,
      }, { recipientUserId, senderRole });

      const online = await this._isUserPresent(conversation.id, recipientUserId);
      if (online) {
        const delivered = await rideChatRepository.markDelivered(message.id, recipientUserId, {
          deliveryChannel: 'websocket',
        }).catch(() => null);
        if (delivered) {
          this._broadcastReceiptUpdated(conversation.id, {
            rideId: conversation.rideId,
            conversationId: conversation.id,
            messageId: message.id,
            receipt: delivered,
          });
        }
      } else if (this.notificationService?.notifyRideChatMessage) {
        await this.notificationService.notifyRideChatMessage(recipientUserId, {
          rideId: conversation.rideId,
          conversationId: conversation.id,
          senderRole,
          senderName: senderRole === 'rider' ? 'Rider' : 'Driver',
          preview: normalized.textContent || (message.attachments?.length ? 'Sent an attachment' : 'New message'),
        }).catch((err) => logger.warn('RIDE-CHAT', `chat push failed: ${err.message}`));
      }

      return {
        success: true,
        conversationId: conversation.id,
        message,
      };
    } catch (err) {
      await this._deleteStoredAttachments(normalized.attachments || []);
      logger.error('RIDE-CHAT', `sendMessageForRide failed: ${err.message}`);
      return { success: false, status: 500, code: 'CHAT_SEND_FAILED', message: 'Unable to send chat message.' };
    }
  }

  async markReadForRide(rideId, userId, { upToMessageId = null } = {}) {
    const senderRole = await this._resolveSenderRole(rideId, userId);
    if (!senderRole) {
      return { success: false, status: 403, code: 'FORBIDDEN_RIDE_CHAT_ACCESS', message: 'Forbidden ride chat access.' };
    }
    const marked = await rideChatRepository.markReadByRide(rideId, userId, { upToMessageId });
    if (marked?.error === 'CHAT_NOT_FOUND') {
      return { success: false, status: 404, code: 'CHAT_NOT_FOUND', message: 'Ride chat not found.' };
    }
    this._broadcastReadUpdated(marked.conversationId, {
      rideId,
      conversationId: marked.conversationId,
      readerUserId: userId,
      upToMessageId,
      receipts: marked.receipts,
    });
    return {
      success: true,
      conversationId: marked.conversationId,
      readCount: marked.readCount,
    };
  }

  async getAttachmentFile(rideId, attachmentId, userId, { isAdmin = false } = {}) {
    const attachment = await rideChatRepository.getAttachment(rideId, attachmentId);
    if (!attachment || attachment.isActive === false) {
      return { success: false, status: 404, code: 'CHAT_ATTACHMENT_NOT_FOUND', message: 'Chat attachment not found.' };
    }
    const allowed = await rideChatRepository.canUserAccessConversation(attachment.conversationId, userId, { isAdmin });
    if (!allowed) {
      return { success: false, status: 403, code: 'FORBIDDEN_CHAT_ATTACHMENT_ACCESS', message: 'Forbidden chat attachment access.' };
    }
    const buffer = await this.storageService.read(attachment.storageKey, attachment.storedPath);
    return {
      success: true,
      buffer,
      mimeType: attachment.mimeType || 'application/octet-stream',
      filename: attachment.originalFilename || 'attachment',
    };
  }

  async canUserAccessConversation(conversationId, userId, { isAdmin = false } = {}) {
    return rideChatRepository.canUserAccessConversation(conversationId, userId, { isAdmin });
  }

  async listAdminConversations(filters = {}) {
    const conversations = await rideChatRepository.listConversations(filters);
    return { success: true, conversations };
  }

  async getAdminConversation(conversationId) {
    const conversation = await rideChatRepository.getConversationById(conversationId);
    if (!conversation) {
      return { success: false, status: 404, code: 'CHAT_NOT_FOUND', message: 'Ride chat not found.' };
    }
    const payload = await this._buildConversationPayload(conversation.id, conversation.rideId);
    return { success: true, chat: payload };
  }

  async listAdminMessages(conversationId, { cursor = null, limit = null } = {}) {
    const conversation = await rideChatRepository.getConversationById(conversationId);
    if (!conversation) {
      return { success: false, status: 404, code: 'CHAT_NOT_FOUND', message: 'Ride chat not found.' };
    }
    const page = await rideChatRepository.getMessages(conversationId, {
      cursor,
      limit: limit || config.chat.defaultPageSize,
    });
    return { success: true, ...page };
  }

  async listAdminEvents(conversationId, { cursor = null, limit = null } = {}) {
    const conversation = await rideChatRepository.getConversationById(conversationId);
    if (!conversation) {
      return { success: false, status: 404, code: 'CHAT_NOT_FOUND', message: 'Ride chat not found.' };
    }
    const page = await rideChatRepository.listEvents(conversationId, {
      cursor,
      limit: limit || config.chat.defaultPageSize,
    });
    return { success: true, ...page };
  }

  async handleWebSocketMessage(socketId, message) {
    const action = String(message?.action || '').trim();
    if (!this.wsServer) return;
    const client = this.wsServer.getClientInfo(socketId);
    if (!client?.userId) return;

    if (action === 'chat:typing') {
      const conversationId = String(message.conversationId || '').trim();
      if (!conversationId) return;
      const allowed = await rideChatRepository.canUserAccessConversation(conversationId, client.userId, {
        isAdmin: Boolean(client.isAdmin),
      });
      if (!allowed) return;
      await this._setTyping(conversationId, client.userId, {
        value: Boolean(message.value),
      });
      this._broadcastRealtime(conversationId, {
        type: 'chat:typing',
        conversationId,
        userId: client.userId,
        value: Boolean(message.value),
        at: new Date().toISOString(),
      });
      return;
    }

    if (action === 'chat:read') {
      const rideId = String(message.rideId || '').trim();
      if (!rideId) return;
      await this.markReadForRide(rideId, client.userId, {
        upToMessageId: message.upToMessageId || null,
      });
    }
  }

  async handleChannelSubscribed(socketId, channel) {
    if (!channel || !String(channel).startsWith('ride_chat_')) return;
    const client = this.wsServer?.getClientInfo(socketId);
    if (!client?.userId) return;
    const conversationId = String(channel).slice('ride_chat_'.length);
    await this._setPresence(conversationId, client.userId, true);
  }

  async handleChannelUnsubscribed(socketId, channel) {
    if (!channel || !String(channel).startsWith('ride_chat_')) return;
    const client = this.wsServer?.getClientInfo(socketId);
    if (!client?.userId) return;
    const conversationId = String(channel).slice('ride_chat_'.length);
    await this._setPresence(conversationId, client.userId, false);
  }

  async _resolveSenderRole(rideId, userId) {
    const chat = await this.getChatForRide(rideId, userId, { isAdmin: false });
    if (!chat.success) return null;
    const conversation = chat.chat;
    if (String(conversation.rider.userId || '') === String(userId || '')) return 'rider';
    if (String(conversation.driver.userId || '') === String(userId || '')) return 'driver';
    return null;
  }

  async _canUserSendToRide(rideId, userId, { isAdmin = false } = {}) {
    if (isAdmin) return false;
    const ride = await pgRideRepository.getRide(rideId).catch(() => null);
    if (!ride) return false;
    const status = String(ride.status || '').trim().toUpperCase();
    const writableStatuses = new Set([
      'DRIVER_ASSIGNED',
      'DRIVER_ARRIVING',
      'DRIVER_ARRIVED',
      'RIDE_STARTED',
      'IN_PROGRESS',
      'TRIP_STARTED',
    ]);
    if (!writableStatuses.has(status)) return false;
    return String(ride.riderId || '') === String(userId || '') || String(ride.driverId || '') === String(userId || '');
  }

  async _normalizeOutgoingPayload(rideId, conversationId, payload) {
    const textContent = String(payload.text || payload.textContent || '').trim();
    const files = Array.isArray(payload.files) ? payload.files : [];
    if (!textContent && !files.length) {
      return { success: false, status: 400, code: 'CHAT_MESSAGE_REQUIRED', message: 'Text or attachment is required.' };
    }
    if (textContent.length > config.chat.textMaxChars) {
      return { success: false, status: 400, code: 'CHAT_TEXT_TOO_LONG', message: `Message exceeds ${config.chat.textMaxChars} characters.` };
    }
    if (files.length > config.chat.maxAttachments) {
      return { success: false, status: 400, code: 'CHAT_TOO_MANY_ATTACHMENTS', message: `Maximum ${config.chat.maxAttachments} attachments allowed.` };
    }

    const messageId = crypto.randomUUID();
    const attachments = [];
    for (const file of files) {
      const attachmentType = this._detectAttachmentType(file.mimeType, payload.attachmentType);
      const fileLimit = attachmentType === 'voice' ? config.chat.maxVoiceSizeBytes : config.chat.maxImageSizeBytes;
      if (file.data.length > fileLimit) {
        return {
          success: false,
          status: 400,
          code: 'CHAT_ATTACHMENT_TOO_LARGE',
          message: `${attachmentType} attachment exceeds allowed size.`,
        };
      }
      const durationMs = attachmentType === 'voice'
        ? Number(payload.durationMs || payload.duration_ms || 0) || null
        : null;
      if (attachmentType === 'voice' && durationMs != null && durationMs > config.chat.maxVoiceDurationMs) {
        return {
          success: false,
          status: 400,
          code: 'CHAT_VOICE_TOO_LONG',
          message: `Voice note exceeds ${config.chat.maxVoiceDurationMs} ms.`,
        };
      }
      const saved = await this.storageService.save(
        conversationId,
        messageId,
        attachmentType,
        file.filename || 'attachment',
        file.data,
      );
      attachments.push({
        id: crypto.randomUUID(),
        attachmentType,
        documentUrl: this.storageService.buildPublicUrl(rideId, crypto.randomUUID()),
        storageBackend: saved.storageBackend,
        storageKey: saved.storageKey,
        storedPath: saved.storedPath,
        mimeType: file.mimeType,
        fileSizeBytes: saved.fileSizeBytes,
        checksumSha256: saved.checksumSha256,
        originalFilename: file.filename || 'attachment',
        durationMs,
        isActive: true,
      });
    }

    // Preserve attachment ids in public URLs.
    const normalizedAttachments = attachments.map((attachment) => ({
      ...attachment,
      documentUrl: this.storageService.buildPublicUrl(rideId, attachment.id),
    }));

    let messageType = 'text';
    if (normalizedAttachments.length > 0) {
      const kinds = new Set(normalizedAttachments.map((attachment) => attachment.attachmentType));
      if (kinds.size > 1 || textContent) {
        messageType = 'mixed';
      } else if (kinds.has('voice')) {
        messageType = 'voice';
      } else if (kinds.has('image')) {
        messageType = 'image';
      } else {
        messageType = 'mixed';
      }
    }

    return {
      success: true,
      messageId,
      messageType,
      textContent: textContent || null,
      replyToMessageId: payload.replyToMessageId || null,
      clientMessageId: String(payload.clientMessageId || '').trim() || null,
      metadata: {
        attachmentCount: normalizedAttachments.length,
      },
      attachments: normalizedAttachments,
    };
  }

  _detectAttachmentType(mimeType, explicitType = null) {
    const explicit = String(explicitType || '').trim().toLowerCase();
    if (explicit === 'image' || explicit === 'voice' || explicit === 'file') return explicit;
    const mime = String(mimeType || '').trim().toLowerCase();
    if (IMAGE_MIME_RE.test(mime)) return 'image';
    if (VOICE_MIME_RE.test(mime)) return 'voice';
    return 'file';
  }

  async _deleteStoredAttachments(attachments = []) {
    for (const attachment of attachments) {
      try {
        await this.storageService.delete(attachment.storageKey, attachment.storedPath);
      } catch (_) {}
    }
  }

  async _setPresence(conversationId, userId, online) {
    const key = `chat:presence:${conversationId}:${userId}`;
    if (online) {
      await redis.set(key, '1', { EX: config.chat.presenceTtlSec });
      return;
    }
    await redis.del(key);
  }

  async _setTyping(conversationId, userId, { value }) {
    const key = `chat:typing:${conversationId}:${userId}`;
    if (value) {
      await redis.set(key, '1', { EX: config.chat.typingTtlSec });
      return;
    }
    await redis.del(key);
  }

  async _isUserPresent(conversationId, userId) {
    if (!conversationId || !userId) return false;
    if (this.wsServer?.isUserSubscribedToChannel(userId, `ride_chat_${conversationId}`)) {
      return true;
    }
    const present = await redis.get(`chat:presence:${conversationId}:${userId}`).catch(() => null);
    return present === '1';
  }

  _broadcastConversationClosed(conversationId, payload) {
    if (!this.wsServer || !conversationId) return;
    const event = {
      type: 'chat:conversation.closed',
      ...payload,
      conversationId,
      at: new Date().toISOString(),
    };
    this._broadcastRealtime(conversationId, event);
  }

  _broadcastConversationSwitched(payload, previousConversationId = null) {
    if (!this.wsServer || !payload?.conversationId) return;
    const event = {
      type: 'chat:conversation.switched',
      previousConversationId,
      ...payload,
      at: new Date().toISOString(),
    };
    if (previousConversationId) {
      this._broadcastRealtime(previousConversationId, event);
    }
    this.wsServer.broadcastToChannel(`rider_${payload.rider.userId}`, event);
    this.wsServer.broadcastToChannel(`driver_${payload.driver.userId}`, event);
    this.wsServer.broadcastToChannel('admin_chat_monitor', event);
    this.wsServer.broadcastToChannel(`admin_chat_${payload.conversationId}`, event);
  }

  _broadcastMessageCreated(conversationId, payload, { recipientUserId = null, senderRole = null } = {}) {
    if (!this.wsServer) return;
    const event = {
      type: 'chat:message.created',
      ...payload,
      at: new Date().toISOString(),
    };
    this._broadcastRealtime(conversationId, event);
    if (recipientUserId) {
      const targetChannel = senderRole === 'rider' ? `driver_${recipientUserId}` : `rider_${recipientUserId}`;
      this.wsServer.broadcastToChannel(targetChannel, event);
    }
  }

  _broadcastReceiptUpdated(conversationId, payload) {
    if (!this.wsServer) return;
    this._broadcastRealtime(conversationId, {
      type: 'chat:message.delivered',
      ...payload,
      at: new Date().toISOString(),
    });
  }

  _broadcastReadUpdated(conversationId, payload) {
    if (!this.wsServer) return;
    this._broadcastRealtime(conversationId, {
      type: 'chat:message.read',
      ...payload,
      at: new Date().toISOString(),
    });
  }

  _broadcastRealtime(conversationId, data) {
    if (!this.wsServer || !conversationId) return;
    this.wsServer.broadcastToChannel(`ride_chat_${conversationId}`, data);
    this.wsServer.broadcastToChannel('admin_chat_monitor', data);
    this.wsServer.broadcastToChannel(`admin_chat_${conversationId}`, data);
  }
}

module.exports = RideChatService;
