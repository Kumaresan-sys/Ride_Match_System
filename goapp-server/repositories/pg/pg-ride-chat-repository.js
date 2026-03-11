'use strict';

const crypto = require('crypto');
const domainDb = require('../../infra/db/domain-db');
const OutboxRepository = require('../../infra/kafka/outbox-repository');
const { TOPICS } = require('../../infra/kafka/topics');

const outboxRepository = new OutboxRepository();

function toConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    rideId: row.rideId,
    riderId: row.riderId,
    driverId: row.driverId,
    assignmentSeq: Number(row.assignmentSeq || 1),
    status: row.status,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    closedReason: row.closedReason,
    messageCount: Number(row.messageCount || 0),
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

class PgRideChatRepository {
  constructor() {
    this.allowedWritableStatuses = new Set([
      'driver_assigned',
      'driver_arriving',
      'driver_arrived',
      'ride_started',
      'in_progress',
    ]);
  }

  async resolveRideByRef(rideRef, client = null, { forUpdate = false } = {}) {
    const queryable = client || {
      query: (text, params) => domainDb.query('rides', text, params, { role: 'reader', strongRead: true }),
    };
    const lockClause = forUpdate ? 'FOR UPDATE OF r' : '';
    const { rows } = await queryable.query(
      `SELECT
         r.id,
         r.ride_number AS "rideNumber",
         r.status,
         rrp.user_id AS "riderUserId",
         rdp.user_id AS "driverUserId"
       FROM rides r
       LEFT JOIN ride_rider_projection rrp ON rrp.rider_id = r.rider_id
       LEFT JOIN ride_driver_projection rdp ON rdp.driver_id = r.driver_id
       WHERE r.id::text = $1 OR r.ride_number = $1
       LIMIT 1
       ${lockClause}`,
      [String(rideRef || '').trim()],
    );
    return rows[0] || null;
  }

  async canUserAccessRide(rideRef, userId) {
    const ride = await this.resolveRideByRef(rideRef);
    if (!ride) return false;
    return String(ride.riderUserId || '') === String(userId || '')
      || String(ride.driverUserId || '') === String(userId || '');
  }

  async getActiveConversationByRide(rideRef, client = null) {
    const queryable = client || {
      query: (text, params) => domainDb.query('rides', text, params, { role: 'reader', strongRead: true }),
    };
    const { rows } = await queryable.query(
      `SELECT
         c.id,
         r.ride_number AS "rideId",
         c.rider_id AS "riderId",
         c.driver_id AS "driverId",
         c.assignment_seq AS "assignmentSeq",
         c.status,
         c.opened_at AS "openedAt",
         c.closed_at AS "closedAt",
         c.closed_reason AS "closedReason",
         c.message_count AS "messageCount",
         c.last_message_at AS "lastMessageAt",
         c.created_at AS "createdAt",
         c.updated_at AS "updatedAt"
       FROM ride_chat_conversations c
       JOIN rides r ON r.id = c.ride_id
       WHERE (r.id::text = $1 OR r.ride_number = $1)
         AND c.status = 'active'
       ORDER BY c.created_at DESC
       LIMIT 1`,
      [String(rideRef || '').trim()],
    );
    return toConversation(rows[0] || null);
  }

  async getLatestConversationByRide(rideRef, client = null) {
    const queryable = client || {
      query: (text, params) => domainDb.query('rides', text, params, { role: 'reader', strongRead: true }),
    };
    const { rows } = await queryable.query(
      `SELECT
         c.id,
         r.ride_number AS "rideId",
         c.rider_id AS "riderId",
         c.driver_id AS "driverId",
         c.assignment_seq AS "assignmentSeq",
         c.status,
         c.opened_at AS "openedAt",
         c.closed_at AS "closedAt",
         c.closed_reason AS "closedReason",
         c.message_count AS "messageCount",
         c.last_message_at AS "lastMessageAt",
         c.created_at AS "createdAt",
         c.updated_at AS "updatedAt"
       FROM ride_chat_conversations c
       JOIN rides r ON r.id = c.ride_id
       WHERE r.id::text = $1 OR r.ride_number = $1
       ORDER BY c.created_at DESC
       LIMIT 1`,
      [String(rideRef || '').trim()],
    );
    return toConversation(rows[0] || null);
  }

  async getConversationById(conversationId) {
    const { rows } = await domainDb.query(
      'rides',
      `SELECT
         c.id,
         r.ride_number AS "rideId",
         c.rider_id AS "riderId",
         c.driver_id AS "driverId",
         c.assignment_seq AS "assignmentSeq",
         c.status,
         c.opened_at AS "openedAt",
         c.closed_at AS "closedAt",
         c.closed_reason AS "closedReason",
         c.message_count AS "messageCount",
         c.last_message_at AS "lastMessageAt",
         c.created_at AS "createdAt",
         c.updated_at AS "updatedAt"
       FROM ride_chat_conversations c
       JOIN rides r ON r.id = c.ride_id
       WHERE c.id::text = $1
       LIMIT 1`,
      [String(conversationId || '').trim()],
      { role: 'reader', strongRead: true },
    );
    return toConversation(rows[0] || null);
  }

  async getConversationParticipants(conversationId) {
    const { rows } = await domainDb.query(
      'rides',
      `SELECT
         c.id,
         r.ride_number AS "rideId",
         c.rider_id AS "riderId",
         c.driver_id AS "driverId",
         c.assignment_seq AS "assignmentSeq",
         c.status,
         c.closed_reason AS "closedReason",
         rider.display_name AS "riderName",
         rider.phone_number AS "riderPhone",
         driver.display_name AS "driverName",
         driver.phone_number AS "driverPhone",
         driver.vehicle_type AS "driverVehicleType",
         driver.vehicle_number AS "driverVehicleNumber",
         driver.average_rating AS "driverRating",
         driver.avatar_url AS "driverAvatarUrl",
         driver.completed_rides_count AS "driverCompletedRides"
       FROM ride_chat_conversations c
       JOIN rides r ON r.id = c.ride_id
       LEFT JOIN ride_rider_projection rider ON rider.user_id = c.rider_id
       LEFT JOIN ride_driver_projection driver ON driver.user_id = c.driver_id
       WHERE c.id::text = $1
       LIMIT 1`,
      [String(conversationId || '').trim()],
      { role: 'reader', strongRead: true },
    );
    return rows[0] || null;
  }

  async canUserAccessConversation(conversationId, userId, { isAdmin = false } = {}) {
    if (isAdmin) return true;
    const participants = await this.getConversationParticipants(conversationId);
    if (!participants) return false;
    const normalizedUserId = String(userId || '');
    if (String(participants.riderId || '') === normalizedUserId) return true;
    if (String(participants.driverId || '') !== normalizedUserId) return false;
    const closedReason = String(participants.closedReason || '').trim().toLowerCase();
    if (closedReason === 'driver_reassigned') return false;
    return true;
  }

  async openConversationForAssignment(rideRef, riderUserId, driverUserId, options = {}) {
    const actorUserId = options.actorUserId || null;
    return domainDb.withTransaction('rides', async (client) => {
      const ride = await this.resolveRideByRef(rideRef, client, { forUpdate: true });
      if (!ride) return null;

      const { rows: activeRows } = await client.query(
        `SELECT
           id,
           ride_id,
           rider_id,
           driver_id,
           assignment_seq,
           status,
           opened_at,
           closed_at,
           closed_reason,
           message_count,
           last_message_at,
           created_at,
           updated_at
         FROM ride_chat_conversations
         WHERE ride_id = $1
           AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [ride.id],
      );

      const active = activeRows[0] || null;
      if (active && String(active.rider_id || '') === String(riderUserId || '') && String(active.driver_id || '') === String(driverUserId || '')) {
        return {
          conversation: toConversation({
            id: active.id,
            rideId: ride.rideNumber,
            riderId: active.rider_id,
            driverId: active.driver_id,
            assignmentSeq: active.assignment_seq,
            status: active.status,
            openedAt: active.opened_at,
            closedAt: active.closed_at,
            closedReason: active.closed_reason,
            messageCount: active.message_count,
            lastMessageAt: active.last_message_at,
            createdAt: active.created_at,
            updatedAt: active.updated_at,
          }),
          created: false,
          switchedFromConversationId: null,
        };
      }

      let switchedFromConversationId = null;
      let nextAssignmentSeq = 1;
      if (active) {
        switchedFromConversationId = active.id;
        nextAssignmentSeq = Number(active.assignment_seq || 0) + 1;
        await client.query(
          `UPDATE ride_chat_conversations
           SET status = 'closed',
               closed_at = NOW(),
               closed_reason = 'driver_reassigned',
               updated_at = NOW()
           WHERE id = $1`,
          [active.id],
        );
        await client.query(
          `INSERT INTO ride_chat_events (
             id,
             conversation_id,
             ride_id,
             event_type,
             actor_user_id,
             actor_role,
             event_data
           ) VALUES ($1, $2, $3, 'conversation_closed', $4, 'system', $5::jsonb)`,
          [
            crypto.randomUUID(),
            active.id,
            ride.id,
            actorUserId,
            JSON.stringify({ closedReason: 'driver_reassigned' }),
          ],
        );
      } else {
        const { rows: seqRows } = await client.query(
          `SELECT COALESCE(MAX(assignment_seq), 0) AS seq
           FROM ride_chat_conversations
           WHERE ride_id = $1`,
          [ride.id],
        );
        nextAssignmentSeq = Number(seqRows[0]?.seq || 0) + 1;
      }

      const conversationId = crypto.randomUUID();
      const { rows } = await client.query(
        `INSERT INTO ride_chat_conversations (
           id,
           ride_id,
           rider_id,
           driver_id,
           assignment_seq,
           status,
           opened_at,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW(), NOW())
         RETURNING
           id,
           rider_id AS "riderId",
           driver_id AS "driverId",
           assignment_seq AS "assignmentSeq",
           status,
           opened_at AS "openedAt",
           closed_at AS "closedAt",
           closed_reason AS "closedReason",
           message_count AS "messageCount",
           last_message_at AS "lastMessageAt",
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [conversationId, ride.id, riderUserId, driverUserId, nextAssignmentSeq],
      );

      await client.query(
        `INSERT INTO ride_chat_events (
           id,
           conversation_id,
           ride_id,
           event_type,
           actor_user_id,
           actor_role,
           event_data
         ) VALUES ($1, $2, $3, 'conversation_opened', $4, 'system', $5::jsonb)`,
        [
          crypto.randomUUID(),
          conversationId,
          ride.id,
          actorUserId,
          JSON.stringify({ assignmentSeq: nextAssignmentSeq }),
        ],
      );

      if (switchedFromConversationId) {
        await client.query(
          `INSERT INTO ride_chat_events (
             id,
             conversation_id,
             ride_id,
             event_type,
             actor_user_id,
             actor_role,
             event_data
           ) VALUES ($1, $2, $3, 'conversation_switched', $4, 'system', $5::jsonb)`,
          [
            crypto.randomUUID(),
            conversationId,
            ride.id,
            actorUserId,
            JSON.stringify({
              previousConversationId: switchedFromConversationId,
              assignmentSeq: nextAssignmentSeq,
            }),
          ],
        );
      }

      await outboxRepository.enqueueWithClient(client, 'rides', {
        topic: TOPICS.RIDE_CHAT_CONVERSATION_STATE_CHANGED,
        eventType: 'ride_chat_conversation_state_changed',
        aggregateType: 'ride_chat_conversation',
        aggregateId: conversationId,
        partitionKey: conversationId,
        idempotencyKey: `chat-conversation-open:${conversationId}`,
        payload: {
          rideId: ride.rideNumber,
          conversationId,
          riderId: riderUserId,
          driverId: driverUserId,
          assignmentSeq: nextAssignmentSeq,
          switchedFromConversationId,
          status: 'active',
        },
      });

      return {
        conversation: {
          ...toConversation({ ...rows[0], rideId: ride.rideNumber }),
          rideId: ride.rideNumber,
        },
        created: true,
        switchedFromConversationId,
      };
    });
  }

  async closeActiveConversation(rideRef, closedReason, options = {}) {
    const actorUserId = options.actorUserId || null;
    const actorRole = options.actorRole || 'system';
    return domainDb.withTransaction('rides', async (client) => {
      const ride = await this.resolveRideByRef(rideRef, client, { forUpdate: true });
      if (!ride) return null;
      const { rows } = await client.query(
        `UPDATE ride_chat_conversations
         SET status = 'closed',
             closed_at = NOW(),
             closed_reason = $2,
             updated_at = NOW()
         WHERE id = (
           SELECT id
           FROM ride_chat_conversations
           WHERE ride_id = $1
             AND status = 'active'
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE
         )
         RETURNING
           id,
           rider_id AS "riderId",
           driver_id AS "driverId",
           assignment_seq AS "assignmentSeq",
           status,
           opened_at AS "openedAt",
           closed_at AS "closedAt",
           closed_reason AS "closedReason",
           message_count AS "messageCount",
           last_message_at AS "lastMessageAt",
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [ride.id, closedReason],
      );

      const conversation = rows[0] || null;
      if (!conversation) return null;

      await client.query(
        `INSERT INTO ride_chat_events (
           id,
           conversation_id,
           ride_id,
           event_type,
           actor_user_id,
           actor_role,
           event_data
         ) VALUES ($1, $2, $3, 'conversation_closed', $4, $5, $6::jsonb)`,
        [
          crypto.randomUUID(),
          conversation.id,
          ride.id,
          actorUserId,
          actorRole,
          JSON.stringify({ closedReason }),
        ],
      );

      await outboxRepository.enqueueWithClient(client, 'rides', {
        topic: TOPICS.RIDE_CHAT_CONVERSATION_STATE_CHANGED,
        eventType: 'ride_chat_conversation_state_changed',
        aggregateType: 'ride_chat_conversation',
        aggregateId: conversation.id,
        partitionKey: conversation.id,
        idempotencyKey: `chat-conversation-close:${conversation.id}:${closedReason}`,
        payload: {
          rideId: ride.rideNumber,
          conversationId: conversation.id,
          status: 'closed',
          closedReason,
        },
      });

      return { ...toConversation({ ...conversation, rideId: ride.rideNumber }), rideId: ride.rideNumber };
    });
  }

  async getConversationSnapshotByRide(rideRef) {
    const active = await this.getActiveConversationByRide(rideRef);
    if (active) return active;
    return this.getLatestConversationByRide(rideRef);
  }

  async getWritableConversationByRide(rideRef, client = null) {
    const queryable = client || {
      query: (text, params) => domainDb.query('rides', text, params, { role: 'reader', strongRead: true }),
    };
    const { rows } = await queryable.query(
      `SELECT
         c.id,
         r.id AS "dbRideId",
         r.ride_number AS "rideId",
         r.status AS "rideStatus",
         c.rider_id AS "riderId",
         c.driver_id AS "driverId",
         c.assignment_seq AS "assignmentSeq",
         c.status,
         c.opened_at AS "openedAt",
         c.closed_at AS "closedAt",
         c.closed_reason AS "closedReason",
         c.message_count AS "messageCount",
         c.last_message_at AS "lastMessageAt",
         c.created_at AS "createdAt",
         c.updated_at AS "updatedAt"
       FROM ride_chat_conversations c
       JOIN rides r ON r.id = c.ride_id
       WHERE (r.id::text = $1 OR r.ride_number = $1)
         AND c.status = 'active'
       ORDER BY c.created_at DESC
       LIMIT 1`,
      [String(rideRef || '').trim()],
    );
    return rows[0] || null;
  }

  async getMessages(conversationId, { cursor = null, limit = 50 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    let createdBefore = null;
    let idBefore = null;
    if (cursor && cursor.createdAt && cursor.id) {
      createdBefore = cursor.createdAt;
      idBefore = cursor.id;
    }
    const values = [conversationId];
    let pagination = '';
    if (createdBefore && idBefore) {
      values.push(createdBefore, idBefore);
      pagination = `AND (m.created_at, m.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
    }
    values.push(safeLimit);

    const { rows } = await domainDb.query(
      'rides',
      `SELECT
         m.id,
         m.conversation_id AS "conversationId",
         r.ride_number AS "rideId",
         m.sender_user_id AS "senderUserId",
         m.sender_role AS "senderRole",
         m.message_type AS "messageType",
         m.text_content AS "textContent",
         m.reply_to_message_id AS "replyToMessageId",
         m.client_message_id AS "clientMessageId",
         m.metadata,
         m.created_at AS "createdAt"
       FROM ride_chat_messages m
       JOIN rides r ON r.id = m.ride_id
       WHERE m.conversation_id = $1
       ${pagination}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $${values.length}`,
      values,
      { role: 'reader', strongRead: true },
    );

    const orderedRows = rows.reverse();
    const messageIds = orderedRows.map((row) => row.id);
    if (!messageIds.length) {
      return { messages: [], nextCursor: null };
    }

    const [attachmentResult, receiptResult] = await Promise.all([
      domainDb.query(
        'rides',
        `SELECT
           id,
           message_id AS "messageId",
           conversation_id AS "conversationId",
           attachment_type AS "attachmentType",
           document_url AS "documentUrl",
           mime_type AS "mimeType",
           file_size_bytes AS "fileSizeBytes",
           original_filename AS "originalFilename",
           duration_ms AS "durationMs",
           is_active AS "isActive",
           created_at AS "createdAt"
         FROM ride_chat_attachments
         WHERE message_id = ANY($1::uuid[])
           AND is_active = true
         ORDER BY created_at ASC`,
        [messageIds],
        { role: 'reader', strongRead: true },
      ),
      domainDb.query(
        'rides',
        `SELECT
           message_id AS "messageId",
           recipient_user_id AS "recipientUserId",
           delivery_status AS "deliveryStatus",
           delivery_channel AS "deliveryChannel",
           attempt_count AS "attemptCount",
           delivered_at AS "deliveredAt",
           read_at AS "readAt",
           failure_reason AS "failureReason",
           updated_at AS "updatedAt"
         FROM ride_chat_message_receipts
         WHERE message_id = ANY($1::uuid[])
         ORDER BY updated_at ASC`,
        [messageIds],
        { role: 'reader', strongRead: true },
      ),
    ]);

    const attachmentsByMessageId = new Map();
    attachmentResult.rows.forEach((row) => {
      const list = attachmentsByMessageId.get(row.messageId) || [];
      list.push(row);
      attachmentsByMessageId.set(row.messageId, list);
    });

    const receiptsByMessageId = new Map();
    receiptResult.rows.forEach((row) => {
      const list = receiptsByMessageId.get(row.messageId) || [];
      list.push(row);
      receiptsByMessageId.set(row.messageId, list);
    });

    const messages = orderedRows.map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      rideId: row.rideId,
      senderUserId: row.senderUserId,
      senderRole: row.senderRole,
      messageType: row.messageType,
      textContent: row.textContent,
      replyToMessageId: row.replyToMessageId,
      clientMessageId: row.clientMessageId,
      metadata: row.metadata || {},
      createdAt: row.createdAt,
      attachments: attachmentsByMessageId.get(row.id) || [],
      receipts: receiptsByMessageId.get(row.id) || [],
    }));

    const oldest = rows[rows.length - 1];
    const nextCursor = rows.length === safeLimit
      ? { id: oldest.id, createdAt: oldest.createdAt }
      : null;

    return { messages, nextCursor };
  }

  async createMessage(rideRef, payload) {
    return domainDb.withTransaction('rides', async (client) => {
      const conversation = await this.getWritableConversationByRide(rideRef, client);
      if (!conversation) {
        const ride = await this.resolveRideByRef(rideRef, client);
        return {
          error: ride ? 'CHAT_NOT_READY' : 'RIDE_NOT_FOUND',
          rideStatus: ride?.status || null,
        };
      }
      if (!this.allowedWritableStatuses.has(String(conversation.rideStatus || '').toLowerCase())) {
        return {
          error: 'CHAT_WINDOW_CLOSED',
          rideStatus: conversation.rideStatus,
        };
      }

      const senderUserId = String(payload.senderUserId || '').trim();
      const senderRole = String(payload.senderRole || '').trim();
      const recipientUserId = senderRole === 'rider' ? conversation.driverId : conversation.riderId;
      if (payload.clientMessageId) {
        const { rows: existingRows } = await client.query(
          `SELECT id
           FROM ride_chat_messages
           WHERE conversation_id = $1
             AND sender_user_id = $2
             AND client_message_id = $3
           LIMIT 1`,
          [conversation.id, senderUserId, payload.clientMessageId],
        );
        if (existingRows[0]?.id) {
          const existing = await this.getMessages(conversation.id, { limit: 100 });
          const message = existing.messages.find((entry) => entry.id === existingRows[0].id) || null;
          return { message, duplicate: true, conversation };
        }
      }

      const messageId = payload.id || crypto.randomUUID();
      const metadata = payload.metadata || {};
      const { rows } = await client.query(
        `INSERT INTO ride_chat_messages (
           id,
           conversation_id,
           ride_id,
           sender_user_id,
           sender_role,
           message_type,
           text_content,
           reply_to_message_id,
           client_message_id,
           metadata,
           created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
         RETURNING
           id,
           conversation_id AS "conversationId",
           sender_user_id AS "senderUserId",
           sender_role AS "senderRole",
           message_type AS "messageType",
           text_content AS "textContent",
           reply_to_message_id AS "replyToMessageId",
           client_message_id AS "clientMessageId",
           metadata,
           created_at AS "createdAt"`,
        [
          messageId,
          conversation.id,
          conversation.dbRideId,
          senderUserId,
          senderRole,
          payload.messageType,
          payload.textContent || null,
          payload.replyToMessageId || null,
          payload.clientMessageId || null,
          JSON.stringify(metadata),
        ],
      );

      const attachments = [];
      for (const attachment of payload.attachments || []) {
        const attachmentId = attachment.id || crypto.randomUUID();
        const { rows: attachmentRows } = await client.query(
          `INSERT INTO ride_chat_attachments (
             id,
             message_id,
             conversation_id,
             ride_id,
             attachment_type,
             document_url,
             storage_backend,
             storage_key,
             stored_path,
             mime_type,
             file_size_bytes,
             checksum_sha256,
             original_filename,
             duration_ms,
             is_active,
             created_at,
             updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE($15, true), NOW(), NOW()
           )
           RETURNING
             id,
             message_id AS "messageId",
             conversation_id AS "conversationId",
             attachment_type AS "attachmentType",
             document_url AS "documentUrl",
             mime_type AS "mimeType",
             file_size_bytes AS "fileSizeBytes",
             original_filename AS "originalFilename",
             duration_ms AS "durationMs",
             is_active AS "isActive",
             created_at AS "createdAt"`,
          [
            attachmentId,
            messageId,
            conversation.id,
            conversation.dbRideId,
            attachment.attachmentType,
            attachment.documentUrl,
            attachment.storageBackend || 'local',
            attachment.storageKey || null,
            attachment.storedPath || null,
            attachment.mimeType || null,
            attachment.fileSizeBytes || null,
            attachment.checksumSha256 || null,
            attachment.originalFilename || null,
            attachment.durationMs || null,
            attachment.isActive,
          ],
        );
        attachments.push(attachmentRows[0]);
      }

      const receipts = [];
      if (recipientUserId) {
        const { rows: receiptRows } = await client.query(
          `INSERT INTO ride_chat_message_receipts (
             id,
             message_id,
             recipient_user_id,
             delivery_status,
             delivery_channel,
             attempt_count,
             created_at,
             updated_at
           ) VALUES ($1, $2, $3, 'queued', 'websocket', 0, NOW(), NOW())
           RETURNING
             message_id AS "messageId",
             recipient_user_id AS "recipientUserId",
             delivery_status AS "deliveryStatus",
             delivery_channel AS "deliveryChannel",
             attempt_count AS "attemptCount",
             delivered_at AS "deliveredAt",
             read_at AS "readAt",
             failure_reason AS "failureReason",
             updated_at AS "updatedAt"`,
          [crypto.randomUUID(), messageId, recipientUserId],
        );
        receipts.push(...receiptRows);
      }

      await client.query(
        `UPDATE ride_chat_conversations
         SET message_count = message_count + 1,
             last_message_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [conversation.id],
      );

      await client.query(
        `INSERT INTO ride_chat_events (
           id,
           conversation_id,
           ride_id,
           event_type,
           actor_user_id,
           actor_role,
           event_data
         ) VALUES ($1, $2, $3, 'message_created', $4, $5, $6::jsonb)`,
        [
          crypto.randomUUID(),
          conversation.id,
          conversation.dbRideId,
          senderUserId,
          senderRole,
          JSON.stringify({
            messageId,
            messageType: payload.messageType,
            attachmentCount: attachments.length,
          }),
        ],
      );

      for (const attachment of attachments) {
        await client.query(
          `INSERT INTO ride_chat_events (
             id,
             conversation_id,
             ride_id,
             event_type,
             actor_user_id,
             actor_role,
             event_data
           ) VALUES ($1, $2, $3, 'attachment_saved', $4, $5, $6::jsonb)`,
          [
            crypto.randomUUID(),
            conversation.id,
            conversation.dbRideId,
            senderUserId,
            senderRole,
            JSON.stringify({
              messageId,
              attachmentId: attachment.id,
              attachmentType: attachment.attachmentType,
            }),
          ],
        );
      }

      await outboxRepository.enqueueWithClient(client, 'rides', {
        topic: TOPICS.RIDE_CHAT_MESSAGE_CREATED,
        eventType: 'ride_chat_message_created',
        aggregateType: 'ride_chat_conversation',
        aggregateId: conversation.id,
        partitionKey: conversation.id,
        idempotencyKey: payload.clientMessageId ? `chat-message:${conversation.id}:${senderUserId}:${payload.clientMessageId}` : null,
        payload: {
          rideId: conversation.rideId,
          conversationId: conversation.id,
          messageId,
          senderUserId,
          senderRole,
          messageType: payload.messageType,
          recipientUserId,
          attachmentCount: attachments.length,
        },
      });

      return {
        conversation: {
          id: conversation.id,
          rideId: conversation.rideId,
          riderId: conversation.riderId,
          driverId: conversation.driverId,
          assignmentSeq: Number(conversation.assignmentSeq || 1),
          status: conversation.status,
          openedAt: conversation.openedAt,
          closedAt: conversation.closedAt,
          closedReason: conversation.closedReason,
          messageCount: Number(conversation.messageCount || 0) + 1,
          lastMessageAt: rows[0].createdAt,
        },
        message: {
          id: rows[0].id,
          conversationId: rows[0].conversationId,
          rideId: conversation.rideId,
          senderUserId: rows[0].senderUserId,
          senderRole: rows[0].senderRole,
          messageType: rows[0].messageType,
          textContent: rows[0].textContent,
          replyToMessageId: rows[0].replyToMessageId,
          clientMessageId: rows[0].clientMessageId,
          metadata: rows[0].metadata || {},
          createdAt: rows[0].createdAt,
          attachments,
          receipts,
        },
      };
    });
  }

  async markDelivered(messageId, recipientUserId, { deliveryChannel = 'websocket' } = {}) {
    return domainDb.withTransaction('rides', async (client) => {
      const { rows } = await client.query(
        `UPDATE ride_chat_message_receipts receipt
         SET delivery_status = CASE
               WHEN receipt.delivery_status = 'read' THEN 'read'
               ELSE 'delivered'
             END,
             delivery_channel = $3,
             attempt_count = receipt.attempt_count + 1,
             delivered_at = COALESCE(receipt.delivered_at, NOW()),
             updated_at = NOW()
         WHERE receipt.message_id = $1
           AND receipt.recipient_user_id = $2
         RETURNING
           receipt.message_id AS "messageId",
           receipt.recipient_user_id AS "recipientUserId",
           receipt.delivery_status AS "deliveryStatus",
           receipt.delivery_channel AS "deliveryChannel",
           receipt.attempt_count AS "attemptCount",
           receipt.delivered_at AS "deliveredAt",
           receipt.read_at AS "readAt",
           receipt.failure_reason AS "failureReason",
           receipt.updated_at AS "updatedAt"`,
        [messageId, recipientUserId, deliveryChannel],
      );
      const receipt = rows[0] || null;
      if (!receipt) return null;

      const { rows: messageRows } = await client.query(
        `SELECT conversation_id, ride_id
         FROM ride_chat_messages
         WHERE id = $1
         LIMIT 1`,
        [messageId],
      );
      const message = messageRows[0] || null;
      if (!message) return null;

      await client.query(
        `INSERT INTO ride_chat_events (
           id,
           conversation_id,
           ride_id,
           event_type,
           actor_user_id,
           actor_role,
           event_data
         ) VALUES ($1, $2, $3, 'delivered', $4, 'system', $5::jsonb)`,
        [
          crypto.randomUUID(),
          message.conversation_id,
          message.ride_id,
          recipientUserId,
          JSON.stringify({ messageId, deliveryChannel }),
        ],
      );

      await outboxRepository.enqueueWithClient(client, 'rides', {
        topic: TOPICS.RIDE_CHAT_RECEIPT_UPDATED,
        eventType: 'ride_chat_receipt_updated',
        aggregateType: 'ride_chat_conversation',
        aggregateId: message.conversation_id,
        partitionKey: message.conversation_id,
        idempotencyKey: `chat-delivered:${messageId}:${recipientUserId}`,
        payload: {
          conversationId: message.conversation_id,
          messageId,
          recipientUserId,
          deliveryStatus: receipt.deliveryStatus,
          deliveryChannel,
        },
      });

      return receipt;
    });
  }

  async markReadByRide(rideRef, readerUserId, { upToMessageId = null } = {}) {
    return domainDb.withTransaction('rides', async (client) => {
      const conversation = await this.getWritableConversationByRide(rideRef, client)
        || await this.getLatestConversationByRide(rideRef, client);
      if (!conversation) return { error: 'CHAT_NOT_FOUND' };
      const normalizedReaderUserId = String(readerUserId || '').trim();
      const normalizedConversationId = String(conversation.id || '').trim();
      const normalizedUpToMessageId = upToMessageId ? String(upToMessageId).trim() : null;
      const { rows } = await client.query(
        `WITH target AS (
           SELECT created_at
           FROM ride_chat_messages
           WHERE id = $3::uuid
             AND conversation_id = $1::uuid
           LIMIT 1
         )
         UPDATE ride_chat_message_receipts receipt
         SET delivery_status = 'read',
             delivered_at = COALESCE(receipt.delivered_at, NOW()),
             read_at = NOW(),
             updated_at = NOW()
         FROM ride_chat_messages m
         WHERE receipt.message_id = m.id
           AND m.conversation_id = $1::uuid
           AND receipt.recipient_user_id = $2::uuid
           AND m.sender_user_id <> $2::uuid
           AND (
             $3::uuid IS NULL
             OR m.created_at <= (SELECT created_at FROM target)
           )
         RETURNING
           receipt.message_id AS "messageId",
           receipt.recipient_user_id AS "recipientUserId",
           receipt.delivery_status AS "deliveryStatus",
           receipt.delivery_channel AS "deliveryChannel",
           receipt.attempt_count AS "attemptCount",
           receipt.delivered_at AS "deliveredAt",
           receipt.read_at AS "readAt",
           receipt.failure_reason AS "failureReason",
           receipt.updated_at AS "updatedAt"`,
        [normalizedConversationId, normalizedReaderUserId, normalizedUpToMessageId],
      );

      await client.query(
        `INSERT INTO ride_chat_events (
           id,
           conversation_id,
           ride_id,
           event_type,
           actor_user_id,
           actor_role,
           event_data
         )
         SELECT
           $1,
           c.id,
           r.id,
           'read',
           $2,
           CASE
             WHEN c.rider_id = $2 THEN 'rider'
             WHEN c.driver_id = $2 THEN 'driver'
             ELSE 'system'
           END,
           $3::jsonb
         FROM ride_chat_conversations c
         JOIN rides r ON r.id = c.ride_id
         WHERE c.id = $4`,
        [
          crypto.randomUUID(),
          normalizedReaderUserId,
          JSON.stringify({
            upToMessageId: normalizedUpToMessageId || null,
            readCount: rows.length,
          }),
          normalizedConversationId,
        ],
      );

      await outboxRepository.enqueueWithClient(client, 'rides', {
        topic: TOPICS.RIDE_CHAT_RECEIPT_UPDATED,
        eventType: 'ride_chat_receipt_updated',
        aggregateType: 'ride_chat_conversation',
        aggregateId: conversation.id,
        partitionKey: conversation.id,
        idempotencyKey: upToMessageId ? `chat-read:${conversation.id}:${readerUserId}:${upToMessageId}` : null,
        payload: {
          rideId: conversation.rideId,
          conversationId: normalizedConversationId,
          readerUserId: normalizedReaderUserId,
          upToMessageId: normalizedUpToMessageId || null,
          readCount: rows.length,
        },
      });

      return {
        conversationId: normalizedConversationId,
        readCount: rows.length,
        receipts: rows,
      };
    });
  }

  async listEvents(conversationId, { cursor = null, limit = 50 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const values = [conversationId];
    let pagination = '';
    if (cursor?.createdAt && cursor?.id) {
      values.push(cursor.createdAt, cursor.id);
      pagination = `AND (created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
    }
    values.push(safeLimit);
    const { rows } = await domainDb.query(
      'rides',
      `SELECT
         id,
         conversation_id AS "conversationId",
         event_type AS "eventType",
         actor_user_id AS "actorUserId",
         actor_role AS "actorRole",
         event_data AS "eventData",
         created_at AS "createdAt"
       FROM ride_chat_events
       WHERE conversation_id = $1
       ${pagination}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`,
      values,
      { role: 'reader', strongRead: true },
    );

    const ordered = rows.reverse();
    const oldest = rows[rows.length - 1];
    return {
      events: ordered,
      nextCursor: rows.length === safeLimit && oldest
        ? { id: oldest.id, createdAt: oldest.createdAt }
        : null,
    };
  }

  async listConversations({ status = null, rideId = null, userId = null, limit = 50 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const values = [];
    const where = [];
    if (status) {
      values.push(status);
      where.push(`c.status = $${values.length}`);
    }
    if (rideId) {
      values.push(rideId);
      where.push(`(r.id::text = $${values.length} OR r.ride_number = $${values.length})`);
    }
    if (userId) {
      values.push(userId);
      where.push(`(c.rider_id::text = $${values.length} OR c.driver_id::text = $${values.length})`);
    }
    values.push(safeLimit);

    const { rows } = await domainDb.query(
      'rides',
      `SELECT
         c.id,
         r.ride_number AS "rideId",
         c.rider_id AS "riderId",
         c.driver_id AS "driverId",
         c.assignment_seq AS "assignmentSeq",
         c.status,
         c.opened_at AS "openedAt",
         c.closed_at AS "closedAt",
         c.closed_reason AS "closedReason",
         c.message_count AS "messageCount",
         c.last_message_at AS "lastMessageAt",
         rider.display_name AS "riderName",
         driver.display_name AS "driverName",
         driver.vehicle_type AS "driverVehicleType",
         driver.vehicle_number AS "driverVehicleNumber",
         c.created_at AS "createdAt",
         c.updated_at AS "updatedAt"
       FROM ride_chat_conversations c
       JOIN rides r ON r.id = c.ride_id
       LEFT JOIN ride_rider_projection rider ON rider.user_id = c.rider_id
       LEFT JOIN ride_driver_projection driver ON driver.user_id = c.driver_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.created_at DESC
       LIMIT $${values.length}`,
      values,
      { role: 'reader', strongRead: true },
    );

    return rows.map((row) => ({
      ...toConversation(row),
      riderName: row.riderName,
      driverName: row.driverName,
      driverVehicleType: row.driverVehicleType,
      driverVehicleNumber: row.driverVehicleNumber,
    }));
  }

  async getAttachment(rideRef, attachmentId) {
    const { rows } = await domainDb.query(
      'rides',
      `SELECT
         a.id,
         a.message_id AS "messageId",
         c.id AS "conversationId",
         r.ride_number AS "rideId",
         c.rider_id AS "riderId",
         c.driver_id AS "driverId",
         c.closed_reason AS "closedReason",
         a.attachment_type AS "attachmentType",
         a.document_url AS "documentUrl",
         a.storage_backend AS "storageBackend",
         a.storage_key AS "storageKey",
         a.stored_path AS "storedPath",
         a.mime_type AS "mimeType",
         a.file_size_bytes AS "fileSizeBytes",
         a.original_filename AS "originalFilename",
         a.duration_ms AS "durationMs",
         a.is_active AS "isActive"
       FROM ride_chat_attachments a
       JOIN ride_chat_messages m ON m.id = a.message_id
       JOIN ride_chat_conversations c ON c.id = a.conversation_id
       JOIN rides r ON r.id = a.ride_id
       WHERE a.id::text = $1
         AND (r.id::text = $2 OR r.ride_number = $2)
       LIMIT 1`,
      [String(attachmentId || '').trim(), String(rideRef || '').trim()],
      { role: 'reader', strongRead: true },
    );
    return rows[0] || null;
  }
}

module.exports = new PgRideChatRepository();
