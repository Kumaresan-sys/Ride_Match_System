'use strict';

const crypto = require('crypto');

const { logger } = require('../utils/logger');
const supportTicketRepository = require('../repositories/pg/pg-support-ticket-repository');

const TICKET_CATEGORIES = new Set([
  'fare_issue',
  'driver_vehicle_issue',
  'payment_wallet_issue',
  'coins_issue',
  'referral_issue',
  'app_issue',
  'account_deactivation',
  'general_support',
  'ride_related_issue',
]);

const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const VALID_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'PENDING_USER', 'RESOLVED', 'CLOSED']);
const ATTACHMENT_MIME_ALLOWLIST = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'video/mp4',
]);
const SUPPORT_SECTION_TREE = Object.freeze([
  {
    id: 'fare_issues',
    title: 'Fare Issues',
    description: 'Help with charges, estimates, and route-related fare disputes.',
    backendCategory: 'fare_issue',
    children: [],
  },
  {
    id: 'driver_vehicle_issues',
    title: 'Driver or Vehicle Issues',
    description: 'Report driver, vehicle, or ride conduct issues.',
    backendCategory: 'driver_vehicle_issue',
    children: [],
  },
  {
    id: 'payment_related_issues',
    title: 'Payment Related Issues',
    description: 'Wallet, payment, and coins support requests.',
    backendCategory: 'payment_wallet_issue',
    children: [],
  },
  {
    id: 'other_help',
    title: 'Other Help',
    description: 'App, referral, account, and general support.',
    backendCategory: 'general_support',
    children: [],
  },
]);
const RATE_LIMITS = {
  createPerMinute: 5,
  messagePerMinute: 20,
  attachmentCount: 3,
  attachmentBytes: 10 * 1024 * 1024,
};
const WRITABLE_RIDE_STATUSES = new Set([
  'driver_assigned',
  'driver_arriving',
  'driver_arrived',
  'ride_started',
  'in_progress',
  'completed',
  'cancelled',
  'cancelled_by_rider',
  'cancelled_by_driver',
  'no_drivers',
]);
const LEGACY_CATEGORY_MAP = Object.freeze({
  wallet: 'payment_wallet_issue',
  payment_issue: 'payment_wallet_issue',
  ride_problem: 'ride_related_issue',
  driver_behaviour: 'driver_vehicle_issue',
  rider_behaviour: 'ride_related_issue',
  app_bug: 'app_issue',
  incentive_issue: 'coins_issue',
  account_issue: 'account_deactivation',
  other: 'general_support',
});

function encodeCursor(payload) {
  if (!payload) return null;
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
    if (!parsed?.id) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

class SupportTicketService {
  constructor({
    repository = supportTicketRepository,
    notificationService = null,
    storageService = null,
    wsServer = null,
    redis = null,
  } = {}) {
    this.repository = repository;
    this.notificationService = notificationService;
    this.storageService = storageService;
    this.wsServer = wsServer;
    this.redis = redis;
  }

  setWebSocketServer(wsServer) {
    this.wsServer = wsServer;
  }

  setNotificationService(notificationService) {
    this.notificationService = notificationService;
  }

  getSupportSections() {
    return SUPPORT_SECTION_TREE;
  }

  async listPastRideIssueCatalog({ activeOnly = true } = {}) {
    const groups = await this.repository.listPastRideIssueGroups({ activeOnly });
    return {
      success: true,
      data: {
        groups: groups.map((group) => ({
          id: group.id,
          title: group.title,
          description: group.description || '',
          backendCategory: group.backendCategory,
          showDriverDetails: group.showDriverDetails === true,
          sortOrder: Number(group.sortOrder || 0),
          isActive: group.isActive === true,
          subIssues: (group.subIssues || []).map((subIssue) => ({
            id: subIssue.id,
            title: subIssue.title,
            description: subIssue.description || '',
            sortOrder: Number(subIssue.sortOrder || 0),
            isActive: subIssue.isActive === true,
          })),
        })),
      },
    };
  }

  async adminCreatePastRideIssueGroup(payload = {}) {
    const title = String(payload.title || '').trim();
    const backendCategory = this._normalizeCategory(payload.backendCategory);
    if (title.length < 2) {
      return this._error('SUPPORT_TRIP_ISSUE_GROUP_INVALID_TITLE', 'Issue group title is required.');
    }
    if (!TICKET_CATEGORIES.has(backendCategory)) {
      return this._error('SUPPORT_INVALID_CATEGORY', 'Invalid ticket category.');
    }

    const groupId = await this.repository.withTransaction(async (client) => this.repository.createPastRideIssueGroup(client, {
      title,
      description: String(payload.description || '').trim() || null,
      backendCategory,
      showDriverDetails: payload.showDriverDetails === true,
      sortOrder: Number(payload.sortOrder || 0),
      isActive: payload.isActive !== false,
    }));
    const group = await this.repository.getPastRideIssueGroupById(groupId);
    return { success: true, data: group };
  }

  async adminUpdatePastRideIssueGroup(groupId, payload = {}) {
    const updates = {};
    if (Object.prototype.hasOwnProperty.call(payload, 'title')) {
      const title = String(payload.title || '').trim();
      if (title.length < 2) {
        return this._error('SUPPORT_TRIP_ISSUE_GROUP_INVALID_TITLE', 'Issue group title is required.');
      }
      updates.title = title;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'description')) {
      updates.description = String(payload.description || '').trim() || null;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'backendCategory')) {
      const backendCategory = this._normalizeCategory(payload.backendCategory);
      if (!TICKET_CATEGORIES.has(backendCategory)) {
        return this._error('SUPPORT_INVALID_CATEGORY', 'Invalid ticket category.');
      }
      updates.backendCategory = backendCategory;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'showDriverDetails')) {
      updates.showDriverDetails = payload.showDriverDetails === true;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'sortOrder')) {
      updates.sortOrder = Number(payload.sortOrder || 0);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'isActive')) {
      updates.isActive = payload.isActive === true;
    }

    const rowCount = await this.repository.withTransaction(async (client) => this.repository.updatePastRideIssueGroup(client, groupId, updates));
    if (rowCount === 0) {
      return this._error('SUPPORT_TRIP_ISSUE_GROUP_NOT_FOUND', 'Past ride issue group not found.', { status: 404 });
    }
    const group = await this.repository.getPastRideIssueGroupById(groupId);
    return { success: true, data: group };
  }

  async adminDeletePastRideIssueGroup(groupId) {
    const rowCount = await this.repository.withTransaction(async (client) => this.repository.deletePastRideIssueGroup(client, groupId));
    if (rowCount === 0) {
      return this._error('SUPPORT_TRIP_ISSUE_GROUP_NOT_FOUND', 'Past ride issue group not found.', { status: 404 });
    }
    return { success: true, data: { id: groupId } };
  }

  async adminCreatePastRideSubIssue(groupId, payload = {}) {
    const title = String(payload.title || '').trim();
    if (title.length < 2) {
      return this._error('SUPPORT_TRIP_SUB_ISSUE_INVALID_TITLE', 'Sub-issue title is required.');
    }
    const parent = await this.repository.getPastRideIssueGroupById(groupId);
    if (!parent) {
      return this._error('SUPPORT_TRIP_ISSUE_GROUP_NOT_FOUND', 'Past ride issue group not found.', { status: 404 });
    }

    const subIssueId = await this.repository.withTransaction(async (client) => this.repository.createPastRideSubIssue(client, {
      groupId,
      title,
      description: String(payload.description || '').trim() || null,
      sortOrder: Number(payload.sortOrder || 0),
      isActive: payload.isActive !== false,
    }));
    const subIssue = await this.repository.getPastRideSubIssueById(subIssueId);
    return { success: true, data: subIssue };
  }

  async adminUpdatePastRideSubIssue(subIssueId, payload = {}) {
    const updates = {};
    if (Object.prototype.hasOwnProperty.call(payload, 'groupId')) {
      const parent = await this.repository.getPastRideIssueGroupById(payload.groupId);
      if (!parent) {
        return this._error('SUPPORT_TRIP_ISSUE_GROUP_NOT_FOUND', 'Past ride issue group not found.', { status: 404 });
      }
      updates.groupId = payload.groupId;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'title')) {
      const title = String(payload.title || '').trim();
      if (title.length < 2) {
        return this._error('SUPPORT_TRIP_SUB_ISSUE_INVALID_TITLE', 'Sub-issue title is required.');
      }
      updates.title = title;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'description')) {
      updates.description = String(payload.description || '').trim() || null;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'sortOrder')) {
      updates.sortOrder = Number(payload.sortOrder || 0);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'isActive')) {
      updates.isActive = payload.isActive === true;
    }

    const rowCount = await this.repository.withTransaction(async (client) => this.repository.updatePastRideSubIssue(client, subIssueId, updates));
    if (rowCount === 0) {
      return this._error('SUPPORT_TRIP_SUB_ISSUE_NOT_FOUND', 'Past ride sub-issue not found.', { status: 404 });
    }
    const subIssue = await this.repository.getPastRideSubIssueById(subIssueId);
    return { success: true, data: subIssue };
  }

  async adminDeletePastRideSubIssue(subIssueId) {
    const rowCount = await this.repository.withTransaction(async (client) => this.repository.deletePastRideSubIssue(client, subIssueId));
    if (rowCount === 0) {
      return this._error('SUPPORT_TRIP_SUB_ISSUE_NOT_FOUND', 'Past ride sub-issue not found.', { status: 404 });
    }
    return { success: true, data: { id: subIssueId } };
  }

  async canUserAccessTicket(ticketId, userId, options = {}) {
    return this.repository.canAccessTicket(ticketId, userId, options);
  }

  async createTicket({
    userId,
    userType = 'rider',
    category,
    subject,
    message,
    priority = 'normal',
    rideId = null,
    metadata = {},
    files = [],
    idempotencyKey = null,
    requestId = null,
    ip = '',
  }) {
    const normalizedCategory = this._normalizeCategory(category);
    const normalizedPriority = String(priority || 'normal').trim().toLowerCase();
    const normalizedSubject = String(subject || '').trim();
    const normalizedMessage = String(message || '').trim();
    const normalizedRideId = String(rideId || '').trim() || null;
    const normalizedMetadata = metadata && typeof metadata === 'object' ? metadata : {};

    this._log('SUPPORT_TICKET_CREATE_ATTEMPT', {
      requestId,
      userId,
      actorRole: 'user',
      actorType: userType,
      category: normalizedCategory,
      attachmentCount: Array.isArray(files) ? files.length : 0,
      ip,
    });

    if (!TICKET_CATEGORIES.has(normalizedCategory)) {
      return this._error('SUPPORT_INVALID_CATEGORY', 'Invalid ticket category.');
    }
    if (!VALID_PRIORITIES.has(normalizedPriority)) {
      return this._error('SUPPORT_INVALID_PRIORITY', 'Invalid ticket priority.');
    }
    if (normalizedSubject.length < 3 || normalizedMessage.length < 2) {
      return this._error('SUPPORT_INVALID_BODY', 'Subject and message are required.');
    }
    if (Array.isArray(files) && files.length > RATE_LIMITS.attachmentCount) {
      return this._error('SUPPORT_ATTACHMENT_LIMIT_EXCEEDED', 'Too many attachments.');
    }

    const rateLimit = await this._applyRateLimit(`support:create:${userId}`, RATE_LIMITS.createPerMinute, 60);
    if (!rateLimit.ok) {
      return this._error('SUPPORT_RATE_LIMITED', 'Too many support tickets. Please try again shortly.', { status: 429 });
    }

    const idempotencyScope = idempotencyKey ? `support:create:${userId}:${idempotencyKey}` : null;
    if (idempotencyScope && this.redis) {
      const check = await this.redis.checkIdempotency(idempotencyScope);
      if (check.isDuplicate) {
        return check.existingResult;
      }
    }

    let rideSnapshot = null;
    if (normalizedRideId) {
      const ride = await this.repository.resolveRideForRider(normalizedRideId, userId);
      if (!ride) {
        return this._error('SUPPORT_RIDE_NOT_FOUND', 'Ride not found for this user.', { status: 404 });
      }
      if (!WRITABLE_RIDE_STATUSES.has(String(ride.status || '').trim().toLowerCase())) {
        return this._error('SUPPORT_RIDE_NOT_ELIGIBLE', 'This ride is not eligible for support ticket creation.');
      }
      rideSnapshot = {
        rideId: ride.id,
        rideNumber: ride.rideNumber,
        rideStatus: ride.status,
        pickupAddress: ride.pickupAddress || null,
        destinationAddress: ride.destinationAddress || null,
        fareEstimate: ride.fareEstimate ?? null,
        riderUserId: ride.riderUserId || null,
        driverUserId: ride.driverUserId || null,
      };
    }

    const ticketCode = this._buildTicketCode();
    const afterCommit = {
      attachments: [],
      notify: null,
      websocketEvents: [],
    };

    try {
      const ticketId = await this.repository.withTransaction(async (client) => {
        const assignedAgent = await this.repository.getAssignableAgent(client);
        const createdTicketId = await this.repository.createTicket(client, {
          ticketCode,
          userId,
          userType,
          subject: normalizedSubject,
          category: normalizedCategory,
          priority: normalizedPriority,
          status: 'OPEN',
          rideId: rideSnapshot?.rideId || null,
          description: normalizedMessage,
          metadata: {
            ...normalizedMetadata,
            ...(rideSnapshot ? { rideSnapshot } : {}),
          },
        });
        await this.repository.updateTicketAfterCreate(client, createdTicketId, {
          assignedAgentId: assignedAgent?.id || null,
        });
        await this.repository.createMessage(client, {
          ticketId: createdTicketId,
          senderId: userId,
          senderRole: 'user',
          senderType: userType,
          senderDisplayName: 'You',
          content: normalizedMessage,
          messageType: 'user',
          visibility: 'public',
          attachments: [],
        });
        const systemMessageId = await this.repository.createMessage(client, {
          ticketId: createdTicketId,
          senderId: 'system',
          senderRole: 'system',
          senderType: 'system',
          senderDisplayName: 'Support Team',
          content: `Ticket ${ticketCode} created. Our support team will review it shortly.`,
          messageType: 'system',
          visibility: 'public',
          attachments: [],
        });
        await this.repository.insertStatusHistory(client, {
          ticketId: createdTicketId,
          fromStatus: null,
          toStatus: 'OPEN',
          changedBy: userId,
          reason: 'ticket_created',
          source: 'api',
        });
        await this.repository.upsertReadState(client, {
          ticketId: createdTicketId,
          actorType: 'rider',
          actorId: userId,
          lastReadMessageId: systemMessageId,
        });
        if (assignedAgent?.id) {
          await this.repository.bumpAgentLoad(client, assignedAgent.id, 1);
        }

        for (const file of files || []) {
          const validated = this._validateAttachment(file);
          if (!validated.ok) {
            throw Object.assign(new Error(validated.message), { supportCode: validated.code, supportStatus: validated.status || 400 });
          }
          const stored = await this.storageService.save(createdTicketId, file.filename, file.data);
          const attachmentId = await this.repository.createAttachment(client, {
            ticketId: createdTicketId,
            storageBackend: stored.storageBackend,
            storageKey: stored.storageKey,
            originalName: stored.originalName,
            safeName: stored.safeName,
            mimeType: file.mimeType,
            sizeBytes: stored.sizeBytes,
            checksumSha256: stored.checksumSha256,
            uploadedBy: userId,
            scanStatus: 'not_scanned',
          });
          afterCommit.attachments.push({
            id: attachmentId,
            fileName: stored.originalName,
            mimeType: file.mimeType,
            sizeBytes: stored.sizeBytes,
            checksum: stored.checksumSha256,
            downloadUrl: this.storageService.buildDownloadUrl(createdTicketId, attachmentId),
          });
        }

        await this.repository.enqueueOutbox(client, {
          topic: 'support.ticket.created',
          eventType: 'support.ticket.created',
          aggregateType: 'support_ticket',
          aggregateId: createdTicketId,
          idempotencyKey: idempotencyKey ? `ticket-create:${idempotencyKey}` : null,
          payload: {
            ticketId: createdTicketId,
            ticketCode,
            userId,
            category: normalizedCategory,
            priority: normalizedPriority,
            requestId,
          },
        });
        afterCommit.notify = {
          userId,
          ticketId: createdTicketId,
          ticketCode,
          category: normalizedCategory,
          priority: normalizedPriority,
        };
        return createdTicketId;
      });

      const detail = await this.repository.getTicketDetail(ticketId, 'rider', userId);
      afterCommit.websocketEvents.push({
        channel: `support_ticket_${ticketId}`,
        payload: {
          type: 'ticket:status',
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          ticketId,
          status: 'OPEN',
          previousStatus: null,
          canReply: true,
          timestamp: new Date().toISOString(),
        },
      });
      await this._flushAfterCommit(afterCommit);
      const result = {
        success: true,
        message: 'Support ticket created successfully.',
        id: detail?.id || ticketId,
        ticketId: detail?.id || ticketId,
        ticketCode: detail?.ticketCode || ticketCode,
        data: detail,
      };
      if (idempotencyScope && this.redis) {
        await this.redis.setIdempotency(idempotencyScope, result, 600);
      }
      this._log('SUPPORT_TICKET_CREATED', {
        requestId,
        ticketId,
        ticketCode,
        userId,
        category: normalizedCategory,
        status: 'OPEN',
        attachmentCount: afterCommit.attachments.length,
        ip,
      });
      return result;
    } catch (err) {
      const code = err.supportCode || 'SUPPORT_TICKET_CREATE_FAILED';
      const status = err.supportStatus || 400;
      this._log('SUPPORT_TICKET_CREATE_FAILED', {
        requestId,
        userId,
        category: normalizedCategory,
        errorCode: code,
        ip,
      });
      return this._error(code, err.message || 'Unable to create support ticket.', { status });
    }
  }

  async getTicket(ticketId, userId, options = {}) {
    const actorType = options.isAdmin ? 'admin' : 'rider';
    const allowed = await this.repository.canAccessTicket(ticketId, userId, options);
    if (!allowed) {
      this._log('SUPPORT_TICKET_ACCESS_DENIED', {
        ticketId,
        userId,
        actorType,
        errorCode: 'SUPPORT_TICKET_FORBIDDEN',
      });
      return this._error('SUPPORT_TICKET_FORBIDDEN', 'Forbidden support ticket access.', { status: 403 });
    }
    const detail = await this.repository.getTicketDetail(ticketId, actorType, userId, {
      includeInternal: options.isAdmin === true,
    });
    if (!detail) {
      return this._error('SUPPORT_TICKET_NOT_FOUND', 'Support ticket not found.', { status: 404 });
    }
    this._log('SUPPORT_TICKET_FETCHED', {
      ticketId,
      ticketCode: detail.ticketCode,
      userId,
      actorType,
      status: detail.status,
    });
    return {
      success: true,
      message: 'Support ticket loaded successfully.',
      data: detail,
    };
  }

  async listUserTickets(userId, { status = null, search = null, limit = 20, cursor = null } = {}) {
    const decodedCursor = decodeCursor(cursor);
    const tickets = await this.repository.listTicketsForUser(userId, 'rider', {
      status,
      search,
      limit,
      cursor: decodedCursor,
    });
    const last = tickets.isNotEmpty ? tickets.last : null;
    this._log('SUPPORT_TICKET_LISTED', {
      userId,
      actorType: 'rider',
      status: status || null,
      count: tickets.length,
    });
    return {
      success: true,
      message: 'Support tickets loaded successfully.',
      data: {
        tickets,
        nextCursor: last == null ? null : encodeCursor({
          id: last.id,
          lastActivityAt: last.lastActivityAt,
        }),
      },
    };
  }

  async listMessages(ticketId, userId, options = {}) {
    const actorType = options.isAdmin ? 'admin' : 'rider';
    const allowed = await this.repository.canAccessTicket(ticketId, userId, options);
    if (!allowed) {
      return this._error('SUPPORT_TICKET_FORBIDDEN', 'Forbidden support ticket access.', { status: 403 });
    }
    const decodedCursor = decodeCursor(options.cursor);
    const messages = await this.repository.listMessages(ticketId, actorType, userId, {
      includeInternal: options.isAdmin === true,
      cursor: decodedCursor,
      limit: options.limit,
    });
    const first = messages.isNotEmpty ? messages.first : null;
    return {
      success: true,
      message: 'Support ticket messages loaded successfully.',
      data: {
        ticketId,
        messages,
        nextCursor: first == null ? null : encodeCursor({
          id: first.id,
          createdAt: first.createdAt,
        }),
      },
    };
  }

  async markRead(ticketId, actorId, options = {}) {
    const actorType = options.isAdmin ? 'admin' : 'rider';
    const allowed = await this.repository.canAccessTicket(ticketId, actorId, options);
    if (!allowed) {
      return this._error('SUPPORT_TICKET_FORBIDDEN', 'Forbidden support ticket access.', { status: 403 });
    }
    const detail = await this.repository.getTicketDetail(ticketId, actorType, actorId, {
      includeInternal: options.isAdmin === true,
    });
    const lastReadMessageId = String(options.upToMessageId || '').trim() || detail?.readState?.lastReadMessageId || null;
    await this.repository.withTransaction(async (client) => {
      await this.repository.upsertReadState(client, {
        ticketId,
        actorType,
        actorId,
        lastReadMessageId,
      });
    });
    const eventPayload = {
      type: 'ticket:read',
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      ticketId,
      actorRole: actorType,
      lastReadMessageId,
      lastReadAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    };
    this._publishTicketEvent(ticketId, eventPayload);
    this._log('SUPPORT_TICKET_READ_MARKED', {
      ticketId,
      userId: actorId,
      actorType,
      status: detail?.status || null,
    });
    return {
      success: true,
      message: 'Support ticket read state updated successfully.',
      data: eventPayload,
    };
  }

  async addMessage(ticketId, payload) {
    const actorType = payload.isAdmin ? 'admin' : 'rider';
    const allowed = await this.repository.canAccessTicket(ticketId, payload.actorId, { isAdmin: payload.isAdmin === true });
    if (!allowed) {
      this._log('SUPPORT_TICKET_ACCESS_DENIED', {
        ticketId,
        userId: payload.actorId,
        actorType,
        errorCode: 'SUPPORT_TICKET_FORBIDDEN',
      });
      return this._error('SUPPORT_TICKET_FORBIDDEN', 'Forbidden support ticket access.', { status: 403 });
    }
    const rateLimit = await this._applyRateLimit(`support:message:${payload.actorId}:${ticketId}`, RATE_LIMITS.messagePerMinute, 60);
    if (!rateLimit.ok) {
      return this._error('SUPPORT_RATE_LIMITED', 'Too many messages. Please try again shortly.', { status: 429 });
    }
    const normalizedContent = String(payload.content || '').trim();
    if (!normalizedContent) {
      return this._error('SUPPORT_MESSAGE_EMPTY', 'Message content is required.');
    }
    const idempotencyScope = payload.idempotencyKey && this.redis
      ? `support:message:${payload.actorId}:${ticketId}:${payload.idempotencyKey}`
      : null;
    if (idempotencyScope && this.redis) {
      const check = await this.redis.checkIdempotency(idempotencyScope);
      if (check.isDuplicate) return check.existingResult;
    }
    try {
      const state = await this.repository.withTransaction(async (client) => {
        const ticket = await this.repository.getTicketForUpdate(client, ticketId);
        if (!ticket) {
          throw Object.assign(new Error('Support ticket not found.'), { supportCode: 'SUPPORT_TICKET_NOT_FOUND', supportStatus: 404 });
        }
        if (!payload.isAdmin && ['RESOLVED', 'CLOSED'].includes(ticket.status)) {
          throw Object.assign(new Error('This ticket is closed. Please create a new support request.'), {
            supportCode: 'SUPPORT_TICKET_REPLY_BLOCKED',
            supportStatus: 409,
          });
        }
        let nextStatus = ticket.status;
        if (payload.isAdmin) {
          if (payload.visibility !== 'internal') {
            if (payload.requestUserReply) {
              nextStatus = 'PENDING_USER';
            } else if (ticket.status === 'OPEN' || ticket.status === 'PENDING_USER') {
              nextStatus = 'IN_PROGRESS';
            }
          }
        } else if (ticket.status === 'PENDING_USER') {
          nextStatus = 'IN_PROGRESS';
        }
        const messageId = await this.repository.createMessage(client, {
          ticketId,
          senderId: payload.actorId,
          senderRole: payload.isAdmin ? 'agent' : 'user',
          senderType: payload.isAdmin ? 'agent' : 'rider',
          senderDisplayName: payload.isAdmin ? 'Support Team' : 'You',
          content: normalizedContent,
          messageType: payload.isAdmin ? 'agent' : 'user',
          visibility: payload.visibility || 'public',
          attachments: [],
        });
        if (nextStatus !== ticket.status) {
          await this.repository.updateTicketState(client, {
            ticketId,
            status: nextStatus,
            markFirstResponse: payload.isAdmin && payload.visibility !== 'internal',
            markReopened: false,
          });
          await this.repository.insertStatusHistory(client, {
            ticketId,
            fromStatus: ticket.status,
            toStatus: nextStatus,
            changedBy: payload.actorId,
            reason: payload.requestUserReply ? 'requested_user_reply' : 'message_added',
            source: 'api',
          });
        } else {
          await this.repository.updateTicketState(client, {
            ticketId,
            status: ticket.status,
            markFirstResponse: payload.isAdmin && payload.visibility !== 'internal',
          });
        }
        await this.repository.upsertReadState(client, {
          ticketId,
          actorType: payload.isAdmin ? 'admin' : 'rider',
          actorId: payload.actorId,
          lastReadMessageId: messageId,
        });
        await this.repository.enqueueOutbox(client, {
          topic: 'support.ticket.message.created',
          eventType: 'support.ticket.message.created',
          aggregateType: 'support_ticket',
          aggregateId: ticketId,
          idempotencyKey: payload.idempotencyKey ? `ticket-message:${payload.idempotencyKey}` : null,
          payload: {
            ticketId,
            messageId,
            actorId: payload.actorId,
            actorRole: payload.isAdmin ? 'agent' : 'user',
            requestId: payload.requestId || null,
          },
        });
        return {
          ticketStatus: nextStatus,
          userId: ticket.userId,
          messageId,
        };
      });

      const [detail, messagePage] = await Promise.all([
        this.repository.getTicketDetail(ticketId, payload.isAdmin ? 'admin' : 'rider', payload.actorId, {
          includeInternal: payload.isAdmin === true,
        }),
        this.repository.listMessages(ticketId, payload.isAdmin ? 'admin' : 'rider', payload.actorId, {
          includeInternal: payload.isAdmin === true,
          limit: 1,
        }),
      ]);
      const message = messagePage[0];
      const messageEvent = {
        type: 'ticket:message',
        schemaVersion: 1,
        eventId: crypto.randomUUID(),
        ticketId,
        messageId: message.id,
        messageType: message.messageType,
        senderRole: message.senderRole,
        message,
        timestamp: new Date().toISOString(),
      };
      this._publishTicketEvent(ticketId, messageEvent);
      if (state.ticketStatus && detail) {
        this._publishTicketEvent(ticketId, {
          type: 'ticket:status',
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          ticketId,
          status: detail.status,
          previousStatus: null,
          canReply: detail.canReply,
          timestamp: new Date().toISOString(),
        });
      }
      if (payload.isAdmin && payload.visibility !== 'internal') {
        await this.notificationService?.notifyTicketMessage(state.userId, {
          ticketId,
          senderRole: 'support',
        });
      }
      this._log('SUPPORT_TICKET_MESSAGE_ADDED', {
        requestId: payload.requestId,
        ticketId,
        userId: payload.actorId,
        actorRole: payload.isAdmin ? 'agent' : 'user',
        actorType,
        status: detail?.status,
      });
      const result = {
        success: true,
        message: 'Support ticket message added successfully.',
        data: {
          ticket: detail,
          message,
        },
      };
      if (idempotencyScope && this.redis) {
        await this.redis.setIdempotency(idempotencyScope, result, 600);
      }
      return result;
    } catch (err) {
      return this._error(err.supportCode || 'SUPPORT_MESSAGE_ADD_FAILED', err.message || 'Unable to add support ticket message.', {
        status: err.supportStatus || 400,
      });
    }
  }

  async adminListTickets(filters) {
    const tickets = await this.repository.listAdminTickets(filters || {});
    return {
      success: true,
      message: 'Support tickets loaded successfully.',
      data: { tickets },
    };
  }

  async adminListAgents() {
    return {
      success: true,
      message: 'Support agents loaded successfully.',
      data: { agents: await this.repository.listAgents() },
    };
  }

  async adminAddAgent(payload) {
    try {
      const row = await this.repository.withTransaction((client) => this.repository.addAgent(client, payload));
      return {
        success: true,
        message: 'Support agent created successfully.',
        data: row,
      };
    } catch (err) {
      return this._error('SUPPORT_AGENT_CREATE_FAILED', err.message || 'Unable to create support agent.');
    }
  }

  async adminUpdateStatus(ticketId, payload) {
    const normalizedStatus = String(payload.status || '').trim().toUpperCase();
    if (!VALID_STATUSES.has(normalizedStatus)) {
      return this._error('SUPPORT_INVALID_STATUS', 'Invalid support ticket status.');
    }
    try {
      const userId = await this.repository.withTransaction(async (client) => {
        const ticket = await this.repository.getTicketForUpdate(client, ticketId);
        if (!ticket) {
          throw Object.assign(new Error('Support ticket not found.'), { supportCode: 'SUPPORT_TICKET_NOT_FOUND', supportStatus: 404 });
        }
        if (!this._isValidTransition(ticket.status, normalizedStatus, true)) {
          throw Object.assign(new Error(`Invalid transition from ${ticket.status} to ${normalizedStatus}.`), {
            supportCode: 'SUPPORT_INVALID_STATUS_TRANSITION',
            supportStatus: 409,
          });
        }
        await this.repository.updateTicketState(client, {
          ticketId,
          status: normalizedStatus,
          resolution: payload.resolution || null,
          markReopened: normalizedStatus === 'IN_PROGRESS' && ['RESOLVED', 'CLOSED'].includes(ticket.status),
        });
        await this.repository.insertStatusHistory(client, {
          ticketId,
          fromStatus: ticket.status,
          toStatus: normalizedStatus,
          changedBy: payload.actorId || 'admin',
          reason: payload.reason || null,
          source: 'api',
        });
        if (normalizedStatus === 'RESOLVED') {
          await this.repository.createMessage(client, {
            ticketId,
            senderId: 'system',
            senderRole: 'system',
            senderType: 'system',
            senderDisplayName: 'Support Team',
            content: payload.resolution || 'Your support request has been resolved.',
            messageType: 'system',
            visibility: 'public',
            attachments: [],
          });
        }
        return ticket.userId;
      });
      const detail = await this.repository.getTicketDetail(ticketId, 'admin', payload.actorId || 'admin', {
        includeInternal: true,
      });
      this._publishTicketEvent(ticketId, {
        type: 'ticket:status',
        schemaVersion: 1,
        eventId: crypto.randomUUID(),
        ticketId,
        status: detail?.status || normalizedStatus,
        previousStatus: null,
        canReply: detail?.canReply ?? (normalizedStatus !== 'RESOLVED' && normalizedStatus !== 'CLOSED'),
        timestamp: new Date().toISOString(),
      });
      await this.notificationService?.notifyTicketUpdated(userId, {
        ticketId,
        status: detail?.status || normalizedStatus,
      });
      this._log('SUPPORT_TICKET_STATUS_CHANGED', {
        ticketId,
        userId: payload.actorId || 'admin',
        actorRole: 'agent',
        actorType: 'admin',
        status: normalizedStatus,
      });
      return {
        success: true,
        message: 'Support ticket status updated successfully.',
        data: detail,
      };
    } catch (err) {
      return this._error(err.supportCode || 'SUPPORT_STATUS_UPDATE_FAILED', err.message || 'Unable to update support ticket status.', {
        status: err.supportStatus || 400,
      });
    }
  }

  async adminAssignTicket(ticketId, payload) {
    try {
      await this.repository.withTransaction(async (client) => {
        const ticket = await this.repository.getTicketForUpdate(client, ticketId);
        if (!ticket) {
          throw Object.assign(new Error('Support ticket not found.'), { supportCode: 'SUPPORT_TICKET_NOT_FOUND', supportStatus: 404 });
        }
        await this.repository.updateTicketState(client, {
          ticketId,
          assignedAgentId: payload.agentId || null,
        });
        await this.repository.insertStatusHistory(client, {
          ticketId,
          fromStatus: ticket.status,
          toStatus: ticket.status,
          changedBy: payload.actorId || 'admin',
          reason: payload.agentId ? 'ticket_assigned' : 'ticket_unassigned',
          source: 'api',
        });
      });
      const detail = await this.repository.getTicketDetail(ticketId, 'admin', payload.actorId || 'admin', {
        includeInternal: true,
      });
      this._log('SUPPORT_TICKET_ASSIGNED', {
        ticketId,
        userId: payload.actorId || 'admin',
        actorRole: 'agent',
        actorType: 'admin',
        status: detail?.status || null,
      });
      return {
        success: true,
        message: 'Support ticket assignment updated successfully.',
        data: detail,
      };
    } catch (err) {
      return this._error(err.supportCode || 'SUPPORT_ASSIGN_FAILED', err.message || 'Unable to assign support ticket.', {
        status: err.supportStatus || 400,
      });
    }
  }

  async getAttachmentFile(ticketId, attachmentId, actorId, options = {}) {
    const allowed = await this.repository.canAccessTicket(ticketId, actorId, options);
    if (!allowed) {
      this._log('SUPPORT_TICKET_ACCESS_DENIED', {
        ticketId,
        userId: actorId,
        actorType: options.isAdmin ? 'admin' : 'rider',
        errorCode: 'SUPPORT_ATTACHMENT_FORBIDDEN',
      });
      return this._error('SUPPORT_ATTACHMENT_FORBIDDEN', 'Forbidden support ticket attachment access.', { status: 403 });
    }
    const attachment = await this.repository.getAttachmentById(ticketId, attachmentId);
    if (!attachment) {
      return this._error('SUPPORT_ATTACHMENT_NOT_FOUND', 'Support ticket attachment not found.', { status: 404 });
    }
    const buffer = await this.storageService.read(attachment.storageKey);
    this._log('SUPPORT_TICKET_ATTACHMENT_FETCHED', {
      ticketId,
      userId: actorId,
      actorType: options.isAdmin ? 'admin' : 'rider',
    });
    return {
      success: true,
      raw: true,
      contentType: attachment.mimeType,
      filename: attachment.originalName,
      buffer,
    };
  }

  async getStats() {
    return this.repository.getStats();
  }

  _validateAttachment(file) {
    if (!file || !Buffer.isBuffer(file.data)) {
      return { ok: false, code: 'SUPPORT_ATTACHMENT_INVALID', message: 'Invalid support attachment.' };
    }
    if (!ATTACHMENT_MIME_ALLOWLIST.has(String(file.mimeType || '').toLowerCase())) {
      this._log('SUPPORT_TICKET_ATTACHMENT_REJECTED', {
        errorCode: 'SUPPORT_ATTACHMENT_TYPE_NOT_ALLOWED',
        attachmentCount: 1,
      });
      return { ok: false, code: 'SUPPORT_ATTACHMENT_TYPE_NOT_ALLOWED', message: 'Attachment type is not allowed.' };
    }
    if (file.data.length > RATE_LIMITS.attachmentBytes) {
      return { ok: false, code: 'SUPPORT_ATTACHMENT_TOO_LARGE', message: 'Attachment exceeds size limit.', status: 413 };
    }
    this._log('SUPPORT_TICKET_ATTACHMENT_ACCEPTED', {
      attachmentCount: 1,
    });
    return { ok: true };
  }

  async _applyRateLimit(key, limit, ttlSec) {
    if (!this.redis?.incr || !this.redis?.expire) {
      return { ok: true };
    }
    const current = await this.redis.incr(key);
    if (current === 1) {
      await this.redis.expire(key, ttlSec);
    }
    return { ok: current <= limit, current };
  }

  _buildTicketCode() {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `SUP-${stamp}-${suffix}`;
  }

  _normalizeCategory(category) {
    const raw = String(category || '').trim();
    return LEGACY_CATEGORY_MAP[raw] || raw;
  }

  _isValidTransition(fromStatus, toStatus, isAdmin) {
    if (fromStatus === toStatus) return true;
    if (!VALID_STATUSES.has(fromStatus) || !VALID_STATUSES.has(toStatus)) return false;
    if (isAdmin) {
      if (fromStatus === 'OPEN' && ['IN_PROGRESS', 'PENDING_USER'].includes(toStatus)) return true;
      if (fromStatus === 'IN_PROGRESS' && ['PENDING_USER', 'RESOLVED'].includes(toStatus)) return true;
      if (fromStatus === 'PENDING_USER' && ['IN_PROGRESS', 'RESOLVED'].includes(toStatus)) return true;
      if (fromStatus === 'RESOLVED' && ['CLOSED', 'IN_PROGRESS'].includes(toStatus)) return true;
      if (fromStatus === 'CLOSED' && toStatus === 'IN_PROGRESS') return true;
    }
    return false;
  }

  async _flushAfterCommit(afterCommit) {
    if (afterCommit.notify) {
      await this.notificationService?.notifyTicketCreated(afterCommit.notify.userId, {
        ticketId: afterCommit.notify.ticketId,
        ticketCode: afterCommit.notify.ticketCode,
        category: afterCommit.notify.category,
        priority: afterCommit.notify.priority,
      });
    }
    for (const event of afterCommit.websocketEvents) {
      this._publishChannelEvent(event.channel, event.payload);
    }
  }

  _publishTicketEvent(ticketId, payload) {
    this._publishChannelEvent(`support_ticket_${ticketId}`, payload);
  }

  _publishChannelEvent(channel, payload) {
    if (!this.wsServer) return;
    this.wsServer.broadcastToChannel(channel, payload);
    this._log('SUPPORT_TICKET_WS_PUBLISHED', {
      ticketId: payload.ticketId || null,
      channel,
    });
  }

  _error(code, message, { status = 400 } = {}) {
    return {
      success: false,
      code,
      message,
      status,
    };
  }

  _log(eventName, data = {}) {
    logger.info('SUPPORT', eventName, data);
  }
}

module.exports = new SupportTicketService();
