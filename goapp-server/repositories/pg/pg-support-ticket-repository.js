'use strict';

const crypto = require('crypto');
const domainDb = require('../../infra/db/domain-db');
const OutboxRepository = require('../../infra/kafka/outbox-repository');

const outboxRepository = new OutboxRepository();
const SUPPORT_DOMAIN = 'support';

function asDateIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toAttachment(row, ticketId) {
  if (!row) return null;
  return {
    id: row.id,
    fileName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes || 0),
    checksum: row.checksumSha256,
    downloadUrl: `/api/v1/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(row.id)}`,
  };
}

function toAssignedAgent(row) {
  if (!row?.assignedAgentId) return null;
  return {
    id: row.assignedAgentId,
    displayName: row.assignedAgentDisplayName || 'Support Team',
    role: row.assignedAgentRole || 'support_agent',
  };
}

function toTicketSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    ticketCode: row.ticketCode,
    category: row.category,
    subject: row.subject,
    status: row.status,
    statusDisplay: String(row.status || '').replaceAll('_', ' '),
    priority: row.priority,
    rideId: row.rideId || null,
    lastActivityAt: asDateIso(row.lastActivityAt),
    createdAt: asDateIso(row.createdAt),
    resolvedAt: asDateIso(row.resolvedAt),
    closedAt: asDateIso(row.closedAt),
    latestMessagePreview: row.latestMessagePreview || null,
    unreadCount: Number(row.unreadCount || 0),
    canReply: row.canReply === true,
  };
}

class PgSupportTicketRepository {
  async withTransaction(fn) {
    return domainDb.withTransaction(SUPPORT_DOMAIN, fn);
  }

  async resolveRideForRider(rideRef, riderUserId, client = null) {
    const queryable = client || {
      query: (text, params) => domainDb.query('rides', text, params, { role: 'reader', strongRead: true }),
    };
    const { rows } = await queryable.query(
      `SELECT
         r.id,
         r.ride_number AS "rideNumber",
         r.status,
         r.estimated_fare AS "fareEstimate",
         r.pickup_address AS "pickupAddress",
         r.dropoff_address AS "destinationAddress",
         rrp.user_id AS "riderUserId",
         rdp.user_id AS "driverUserId"
       FROM rides r
       LEFT JOIN ride_rider_projection rrp ON rrp.rider_id = r.rider_id
       LEFT JOIN ride_driver_projection rdp ON rdp.driver_id = r.driver_id
       WHERE (r.id::text = $1 OR r.ride_number = $1)
         AND rrp.user_id::text = $2
       LIMIT 1`,
      [String(rideRef || '').trim(), String(riderUserId || '').trim()],
    );
    return rows[0] || null;
  }

  async canAccessTicket(ticketId, userId, { isAdmin = false } = {}) {
    if (isAdmin) return true;
    const { rows } = await domainDb.query(
      SUPPORT_DOMAIN,
      `SELECT 1
       FROM support_tickets
       WHERE id::text = $1
         AND user_id::text = $2
       LIMIT 1`,
      [String(ticketId || '').trim(), String(userId || '').trim()],
      { role: 'reader', strongRead: true },
    );
    return rows.length > 0;
  }

  async createTicket(client, payload) {
    const ticketId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await client.query(
      `INSERT INTO support_tickets (
         id,
         ticket_code,
         user_id,
         user_type,
         subject,
         category,
         priority,
         status,
         ride_id,
         description,
         metadata_json,
         last_activity_at,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3::uuid, $4, $5, $6, $7, $8, $9::uuid, $10, $11::jsonb, $12, $12, $12
       )`,
      [
        ticketId,
        payload.ticketCode,
        payload.userId,
        payload.userType,
        payload.subject,
        payload.category,
        payload.priority,
        payload.status,
        payload.rideId || null,
        payload.description,
        JSON.stringify(payload.metadata || {}),
        createdAt,
      ],
    );
    return ticketId;
  }

  async createMessage(client, payload) {
    const messageId = crypto.randomUUID();
    await client.query(
      `INSERT INTO ticket_messages (
         id,
         ticket_id,
         sender_id,
         sender_role,
         sender_type,
         sender_display_name,
         message,
         content,
         message_type,
         visibility,
         attachments,
         attachments_json,
         created_at
       ) VALUES (
         $1, $2::uuid, $3, $4, $5, $6, $7, $7, $8, $9, ARRAY[]::text[], $10::jsonb, NOW()
       )`,
      [
        messageId,
        payload.ticketId,
        payload.senderId,
        payload.senderRole,
        payload.senderType,
        payload.senderDisplayName || null,
        payload.content,
        payload.messageType,
        payload.visibility || 'public',
        JSON.stringify(payload.attachments || []),
      ],
    );
    return messageId;
  }

  async createAttachment(client, payload) {
    const attachmentId = crypto.randomUUID();
    await client.query(
      `INSERT INTO support_ticket_attachments (
         id,
         ticket_id,
         message_id,
         storage_backend,
         storage_key,
         original_name,
         safe_name,
         mime_type,
         size_bytes,
         checksum_sha256,
         uploaded_by,
         scan_status,
         created_at
       ) VALUES (
         $1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW()
       )`,
      [
        attachmentId,
        payload.ticketId,
        payload.messageId || null,
        payload.storageBackend,
        payload.storageKey,
        payload.originalName,
        payload.safeName,
        payload.mimeType,
        payload.sizeBytes,
        payload.checksumSha256,
        payload.uploadedBy,
        payload.scanStatus || 'not_scanned',
      ],
    );
    return attachmentId;
  }

  async insertStatusHistory(client, payload) {
    await client.query(
      `INSERT INTO ticket_status_history (
         id,
         ticket_id,
         old_status,
         new_status,
         from_status,
         to_status,
         changed_by,
         reason,
         change_reason,
         source,
         created_at
       ) VALUES (
         gen_random_uuid(),
         $1::uuid,
         $2,
         $3,
         $2,
         $3,
         $4,
         $5,
         $5,
         $6,
         NOW()
       )`,
      [
        payload.ticketId,
        payload.fromStatus || null,
        payload.toStatus,
        payload.changedBy || null,
        payload.reason || null,
        payload.source || 'api',
      ],
    );
  }

  async updateTicketAfterCreate(client, ticketId, { assignedAgentId = null }) {
    await client.query(
      `UPDATE support_tickets
       SET assigned_agent_id = COALESCE($2::uuid, assigned_agent_id),
           assigned_at = CASE WHEN $2::uuid IS NULL THEN assigned_at ELSE NOW() END
       WHERE id::text = $1`,
      [ticketId, assignedAgentId],
    );
  }

  async getAssignableAgent(client) {
    const { rows } = await client.query(
      `SELECT
         id,
         COALESCE(agent_name, name, 'Support Team') AS "displayName",
         COALESCE(role, 'support_agent') AS role
       FROM support_agents
       WHERE COALESCE(is_available, true) = true
         AND COALESCE(is_active, true) = true
         AND COALESCE(current_load, current_tickets, 0) < COALESCE(max_concurrent, max_tickets, 10)
       ORDER BY COALESCE(current_load, current_tickets, 0) ASC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [],
    );
    return rows[0] || null;
  }

  async bumpAgentLoad(client, agentId, delta) {
    if (!agentId) return;
    await client.query(
      `UPDATE support_agents
       SET current_load = GREATEST(0, COALESCE(current_load, current_tickets, 0) + $2),
           current_tickets = GREATEST(0, COALESCE(current_tickets, current_load, 0) + $2),
           updated_at = NOW()
       WHERE id::text = $1`,
      [agentId, delta],
    );
  }

  async updateTicketState(client, payload) {
    const { rows } = await client.query(
      `UPDATE support_tickets
       SET status = COALESCE($2, status),
           resolution = COALESCE($3, resolution),
           assigned_agent_id = COALESCE($4::uuid, assigned_agent_id),
           assigned_at = CASE WHEN $4::uuid IS NULL THEN assigned_at ELSE COALESCE(assigned_at, NOW()) END,
           first_response_at = CASE WHEN $5 THEN COALESCE(first_response_at, NOW()) ELSE first_response_at END,
           resolved_at = CASE WHEN $2 = 'RESOLVED' THEN NOW() ELSE resolved_at END,
           closed_at = CASE WHEN $2 = 'CLOSED' THEN NOW() ELSE closed_at END,
           reopened_at = CASE WHEN $6 THEN NOW() ELSE reopened_at END,
           last_activity_at = NOW()
       WHERE id::text = $1
       RETURNING id`,
      [
        payload.ticketId,
        payload.status || null,
        payload.resolution || null,
        payload.assignedAgentId || null,
        payload.markFirstResponse === true,
        payload.markReopened === true,
      ],
    );
    return rows[0] || null;
  }

  async getTicketForUpdate(client, ticketId) {
    const { rows } = await client.query(
      `SELECT
         t.id,
         t.ticket_code AS "ticketCode",
         t.user_id::text AS "userId",
         t.user_type AS "userType",
         t.subject,
         t.description,
         t.category,
         t.priority,
         t.status,
         t.ride_id::text AS "rideId",
         t.assigned_agent_id::text AS "assignedAgentId",
         t.metadata_json AS metadata,
         t.last_activity_at AS "lastActivityAt",
         t.created_at AS "createdAt",
         t.resolved_at AS "resolvedAt",
         t.closed_at AS "closedAt"
       FROM support_tickets t
       WHERE t.id::text = $1
       LIMIT 1
       FOR UPDATE`,
      [String(ticketId || '').trim()],
    );
    return rows[0] || null;
  }

  async upsertReadState(client, payload) {
    await client.query(
      `INSERT INTO support_ticket_read_state (
         ticket_id,
         actor_type,
         actor_id,
         last_read_message_id,
         last_read_at
       ) VALUES ($1::uuid, $2, $3, $4::uuid, NOW())
       ON CONFLICT (ticket_id, actor_type, actor_id)
       DO UPDATE SET
         last_read_message_id = EXCLUDED.last_read_message_id,
         last_read_at = EXCLUDED.last_read_at`,
      [
        payload.ticketId,
        payload.actorType,
        payload.actorId,
        payload.lastReadMessageId || null,
      ],
    );
  }

  async enqueueOutbox(client, event) {
    await outboxRepository.enqueueWithClient(client, SUPPORT_DOMAIN, event);
  }

  async getTicketDetail(ticketId, actorType, actorId, { includeInternal = false } = {}) {
    const latestMessageVisibilityClause = includeInternal
      ? ''
      : `AND m.visibility <> 'internal'`;
    const unreadVisibilityClause = includeInternal
      ? ''
      : `AND tm.visibility <> 'internal'`;
    const { rows } = await domainDb.query(
      SUPPORT_DOMAIN,
      `WITH latest_message AS (
         SELECT m.ticket_id, m.content
         FROM ticket_messages m
         WHERE m.ticket_id::text = $1
           ${latestMessageVisibilityClause}
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 1
       ),
       read_state AS (
         SELECT last_read_message_id, last_read_at
         FROM support_ticket_read_state
         WHERE ticket_id::text = $1
           AND actor_type = $2
           AND actor_id = $3
         LIMIT 1
       ),
       unread AS (
         SELECT COUNT(*)::int AS count
         FROM ticket_messages tm
         WHERE tm.ticket_id::text = $1
           ${unreadVisibilityClause}
           AND tm.sender_role <> CASE WHEN $2 = 'rider' THEN 'user' ELSE 'agent' END
           AND (
             (SELECT last_read_at FROM read_state) IS NULL
             OR tm.created_at > (SELECT last_read_at FROM read_state)
           )
       )
       SELECT
         t.id,
         t.ticket_code AS "ticketCode",
         t.user_id::text AS "userId",
         t.user_type AS "userType",
         t.subject,
         t.description,
         t.category,
         t.priority,
         t.status,
         t.ride_id::text AS "rideId",
         t.metadata_json AS metadata,
         t.last_activity_at AS "lastActivityAt",
         t.created_at AS "createdAt",
         t.resolved_at AS "resolvedAt",
         t.closed_at AS "closedAt",
         t.assigned_agent_id::text AS "assignedAgentId",
         sa.user_id::text AS "assignedAgentUserId",
         COALESCE(sa.agent_name, sa.name, 'Support Team') AS "assignedAgentDisplayName",
         COALESCE(sa.role, 'support_agent') AS "assignedAgentRole",
         lm.content AS "latestMessagePreview",
         (SELECT count FROM unread) AS "unreadCount",
         CASE WHEN t.status IN ('RESOLVED','CLOSED') THEN false ELSE true END AS "canReply",
         (SELECT last_read_message_id::text FROM read_state) AS "lastReadMessageId",
         (SELECT last_read_at FROM read_state) AS "lastReadAt"
       FROM support_tickets t
       LEFT JOIN support_agents sa ON sa.id = t.assigned_agent_id
       LEFT JOIN latest_message lm ON lm.ticket_id = t.id
       WHERE t.id::text = $1
       LIMIT 1`,
      [String(ticketId || '').trim(), actorType, String(actorId || '')],
      { role: 'reader', strongRead: true },
    );
    const row = rows[0] || null;
    if (!row) return null;
    const attachments = await this.listAttachments(ticketId);
    return {
      ...toTicketSummary(row),
      description: row.description,
      assignedAgent: toAssignedAgent(row),
      metadata: row.metadata || {},
      attachments,
      readState: {
        actorType,
        actorId,
        lastReadMessageId: row.lastReadMessageId || null,
        lastReadAt: asDateIso(row.lastReadAt),
      },
    };
  }

  async listAttachments(ticketId) {
    const { rows } = await domainDb.query(
      SUPPORT_DOMAIN,
      `SELECT
         id,
         original_name AS "originalName",
         mime_type AS "mimeType",
         size_bytes AS "sizeBytes",
         checksum_sha256 AS "checksumSha256"
       FROM support_ticket_attachments
       WHERE ticket_id::text = $1
       ORDER BY created_at ASC`,
      [String(ticketId || '').trim()],
      { role: 'reader', strongRead: true },
    );
    return rows.map((row) => toAttachment(row, ticketId));
  }

  async getAttachmentById(ticketId, attachmentId) {
    const { rows } = await domainDb.query(
      SUPPORT_DOMAIN,
      `SELECT
         id,
         ticket_id::text AS "ticketId",
         storage_backend AS "storageBackend",
         storage_key AS "storageKey",
         original_name AS "originalName",
         safe_name AS "safeName",
         mime_type AS "mimeType",
         size_bytes AS "sizeBytes",
         checksum_sha256 AS "checksumSha256"
       FROM support_ticket_attachments
       WHERE ticket_id::text = $1
         AND id::text = $2
       LIMIT 1`,
      [String(ticketId || '').trim(), String(attachmentId || '').trim()],
      { role: 'reader', strongRead: true },
    );
    return rows[0] || null;
  }

  async listTicketsForUser(userId, actorType, { status = null, search = null, limit = 20, cursor = null } = {}) {
    const params = [String(userId || '').trim(), actorType];
    let whereSql = `WHERE t.user_id::text = $1`;
    if (status) {
      params.push(status);
      whereSql += ` AND t.status = $${params.length}`;
    }
    if (search) {
      params.push(`%${String(search).trim().toLowerCase()}%`);
      whereSql += ` AND (LOWER(t.ticket_code) LIKE $${params.length} OR LOWER(t.subject) LIKE $${params.length})`;
    }
    if (cursor?.lastActivityAt && cursor?.id) {
      params.push(cursor.lastActivityAt, cursor.id);
      whereSql += ` AND (t.last_activity_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(Math.max(1, Math.min(Number(limit) || 20, 100)));
    const { rows } = await domainDb.query(
      SUPPORT_DOMAIN,
      `SELECT
         t.id,
         t.ticket_code AS "ticketCode",
         t.subject,
         t.category,
         t.priority,
         t.status,
         t.ride_id::text AS "rideId",
         t.last_activity_at AS "lastActivityAt",
         t.created_at AS "createdAt",
         t.resolved_at AS "resolvedAt",
         t.closed_at AS "closedAt",
         (
           SELECT tm.content
           FROM ticket_messages tm
           WHERE tm.ticket_id = t.id
             AND tm.visibility <> 'internal'
           ORDER BY tm.created_at DESC, tm.id DESC
           LIMIT 1
         ) AS "latestMessagePreview",
         (
           SELECT COUNT(*)::int
           FROM ticket_messages tm
           LEFT JOIN support_ticket_read_state rs
             ON rs.ticket_id = t.id
            AND rs.actor_type = $2
            AND rs.actor_id = $1
           WHERE tm.ticket_id = t.id
             AND tm.visibility <> 'internal'
             AND tm.sender_role <> 'user'
             AND (rs.last_read_at IS NULL OR tm.created_at > rs.last_read_at)
         ) AS "unreadCount",
         CASE WHEN t.status IN ('RESOLVED','CLOSED') THEN false ELSE true END AS "canReply"
       FROM support_tickets t
       ${whereSql}
       ORDER BY t.last_activity_at DESC, t.id DESC
       LIMIT $${params.length}`,
      params,
      { role: 'reader', strongRead: true },
    );
    return rows.map(toTicketSummary);
  }

  async listMessages(ticketId, actorType, actorId, { includeInternal = false, cursor = null, limit = 20 } = {}) {
    const params = [String(ticketId || '').trim(), actorType, String(actorId || '')];
    let whereSql = `WHERE tm.ticket_id::text = $1`;
    if (!includeInternal) {
      whereSql += ` AND tm.visibility <> 'internal'`;
    }
    if (cursor?.createdAt && cursor?.id) {
      params.push(cursor.createdAt, cursor.id);
      whereSql += ` AND (tm.created_at, tm.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(Math.max(1, Math.min(Number(limit) || 20, 100)));
    const { rows } = await domainDb.query(
      SUPPORT_DOMAIN,
      `WITH read_state AS (
         SELECT last_read_message_id, last_read_at
         FROM support_ticket_read_state
         WHERE ticket_id::text = $1
           AND actor_type = $2
           AND actor_id = $3
         LIMIT 1
       )
       SELECT
         tm.id,
         tm.ticket_id::text AS "ticketId",
         tm.message_type AS "messageType",
         tm.visibility,
         tm.sender_role AS "senderRole",
         COALESCE(tm.sender_display_name, CASE WHEN tm.sender_role = 'user' THEN 'You' ELSE 'Support Team' END) AS "senderDisplayName",
         tm.sender_id AS "senderId",
         tm.content,
         tm.attachments_json AS attachments,
         tm.created_at AS "createdAt",
         CASE
           WHEN (SELECT last_read_at FROM read_state) IS NULL THEN false
           WHEN tm.created_at <= (SELECT last_read_at FROM read_state) THEN true
           ELSE false
         END AS "readByCurrentActor"
       FROM ticket_messages tm
       ${whereSql}
       ORDER BY tm.created_at DESC, tm.id DESC
       LIMIT $${params.length}`,
      params,
      { role: 'reader', strongRead: true },
    );
    return rows.reverse().map((row) => ({
      id: row.id,
      ticketId: row.ticketId,
      messageType: row.messageType,
      visibility: row.visibility,
      senderRole: row.senderRole,
      senderDisplayName: row.senderDisplayName,
      senderId: row.senderId,
      content: row.content || '',
      attachments: Array.isArray(row.attachments) ? row.attachments : [],
      createdAt: asDateIso(row.createdAt),
      readByCurrentActor: row.readByCurrentActor === true,
    }));
  }

  async listAdminTickets({ status = null, category = null, priority = null, agentId = null, limit = 50 } = {}) {
    const params = [];
    const where = [];
    if (status) {
      params.push(status);
      where.push(`t.status = $${params.length}`);
    }
    if (category) {
      params.push(category);
      where.push(`t.category = $${params.length}`);
    }
    if (priority) {
      params.push(priority);
      where.push(`t.priority = $${params.length}`);
    }
    if (agentId) {
      params.push(agentId);
      where.push(`t.assigned_agent_id::text = $${params.length}`);
    }
    params.push(Math.max(1, Math.min(Number(limit) || 50, 200)));
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await domainDb.query(
      SUPPORT_DOMAIN,
      `SELECT
         t.id,
         t.ticket_code AS "ticketCode",
         t.subject,
         t.category,
         t.priority,
         t.status,
         t.ride_id::text AS "rideId",
         t.last_activity_at AS "lastActivityAt",
         t.created_at AS "createdAt",
         t.resolved_at AS "resolvedAt",
         t.closed_at AS "closedAt",
         NULL::text AS "latestMessagePreview",
         0::int AS "unreadCount",
         CASE WHEN t.status IN ('RESOLVED','CLOSED') THEN false ELSE true END AS "canReply"
       FROM support_tickets t
       ${whereSql}
       ORDER BY t.last_activity_at DESC, t.id DESC
       LIMIT $${params.length}`,
      params,
      { role: 'reader', strongRead: true },
    );
    return rows.map(toTicketSummary);
  }

  async listAgents() {
    const { rows } = await domainDb.query(
      SUPPORT_DOMAIN,
      `SELECT
         id,
         user_id::text AS "userId",
         COALESCE(agent_name, name, 'Support Team') AS "displayName",
         COALESCE(role, 'support_agent') AS role,
         COALESCE(current_load, current_tickets, 0) AS "currentLoad",
         COALESCE(max_concurrent, max_tickets, 10) AS "maxConcurrent",
         COALESCE(is_available, true) AS "isAvailable",
         COALESCE(is_active, true) AS "isActive"
       FROM support_agents
       ORDER BY COALESCE(agent_name, name, 'Support Team') ASC`,
      [],
      { role: 'reader', strongRead: true },
    );
    return rows;
  }

  async addAgent(client, payload) {
    const { rows } = await client.query(
      `INSERT INTO support_agents (
         id,
         user_id,
         agent_name,
         name,
         email,
         role,
         is_available,
         is_active,
         max_concurrent,
         max_tickets,
         current_load,
         current_tickets,
         created_at,
         updated_at
       ) VALUES (
         gen_random_uuid(),
         $1::uuid,
         $2,
         $2,
         $3,
         $4,
         true,
         true,
         $5,
         $5,
         0,
         0,
         NOW(),
         NOW()
       )
       RETURNING id`,
      [
        payload.userId,
        payload.displayName,
        payload.email || `${payload.userId}@support.local`,
        payload.role || 'support_agent',
        payload.maxConcurrent || 10,
      ],
    );
    return rows[0] || null;
  }

  async listPastRideIssueGroups({ activeOnly = false } = {}) {
    const groupParams = [];
    const groupWhere = [];
    if (activeOnly) {
      groupParams.push(true);
      groupWhere.push(`is_active = $${groupParams.length}`);
    }

    const groupQuery = `
      SELECT
        id,
        title,
        description,
        backend_category AS "backendCategory",
        show_driver_details AS "showDriverDetails",
        sort_order AS "sortOrder",
        is_active AS "isActive"
      FROM support_trip_issue_groups
      ${groupWhere.length ? `WHERE ${groupWhere.join(' AND ')}` : ''}
      ORDER BY sort_order ASC, created_at ASC
    `;
    const { rows: groups } = await domainDb.query(
      SUPPORT_DOMAIN,
      groupQuery,
      groupParams,
      { role: 'reader', strongRead: true },
    );
    if (groups.length == 0) {
      return [];
    }

    const subParams = [groups.map((group) => group.id)];
    const subWhere = [`group_id = ANY($1::uuid[])`];
    if (activeOnly) {
      subParams.push(true);
      subWhere.push(`is_active = $${subParams.length}`);
    }

    const { rows: subIssues } = await domainDb.query(
      SUPPORT_DOMAIN,
      `SELECT
         id,
         group_id AS "groupId",
         title,
         description,
         sort_order AS "sortOrder",
         is_active AS "isActive"
       FROM support_trip_issue_subissues
       WHERE ${subWhere.join(' AND ')}
       ORDER BY group_id ASC, sort_order ASC, created_at ASC`,
      subParams,
      { role: 'reader', strongRead: true },
    );

    const subIssuesByGroup = new Map();
    for (const subIssue of subIssues) {
      const current = subIssuesByGroup.get(subIssue.groupId) || [];
      current.push(subIssue);
      subIssuesByGroup.set(subIssue.groupId, current);
    }

    return groups.map((group) => ({
      ...group,
      subIssues: subIssuesByGroup.get(group.id) || [],
    }));
  }

  async getPastRideIssueGroupById(groupId) {
    const { rows } = await domainDb.query(
      SUPPORT_DOMAIN,
      `SELECT
         id,
         title,
         description,
         backend_category AS "backendCategory",
         show_driver_details AS "showDriverDetails",
         sort_order AS "sortOrder",
         is_active AS "isActive"
       FROM support_trip_issue_groups
       WHERE id::text = $1
       LIMIT 1`,
      [String(groupId || '').trim()],
      { role: 'reader', strongRead: true },
    );
    return rows[0] || null;
  }

  async createPastRideIssueGroup(client, payload) {
    const { rows } = await client.query(
      `INSERT INTO support_trip_issue_groups (
         id,
         title,
         description,
         backend_category,
         show_driver_details,
         sort_order,
         is_active,
         created_at,
         updated_at
       ) VALUES (
         gen_random_uuid(),
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         NOW(),
         NOW()
       )
       RETURNING id`,
      [
        payload.title,
        payload.description || null,
        payload.backendCategory,
        payload.showDriverDetails === true,
        payload.sortOrder ?? 0,
        payload.isActive !== false,
      ],
    );
    return rows[0]?.id || null;
  }

  async updatePastRideIssueGroup(client, groupId, payload) {
    const updates = [];
    const params = [];
    const assign = (column, value) => {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    };

    if (Object.prototype.hasOwnProperty.call(payload, 'title')) {
      assign('title', payload.title);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'description')) {
      assign('description', payload.description || null);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'backendCategory')) {
      assign('backend_category', payload.backendCategory);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'showDriverDetails')) {
      assign('show_driver_details', payload.showDriverDetails === true);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'sortOrder')) {
      assign('sort_order', payload.sortOrder);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'isActive')) {
      assign('is_active', payload.isActive === true);
    }
    if (updates.length === 0) {
      return 0;
    }
    updates.push('updated_at = NOW()');
    params.push(String(groupId || '').trim());
    const result = await client.query(
      `UPDATE support_trip_issue_groups
       SET ${updates.join(', ')}
       WHERE id::text = $${params.length}`,
      params,
    );
    return result.rowCount || 0;
  }

  async deletePastRideIssueGroup(client, groupId) {
    const result = await client.query(
      `DELETE FROM support_trip_issue_groups
       WHERE id::text = $1`,
      [String(groupId || '').trim()],
    );
    return result.rowCount || 0;
  }

  async getPastRideSubIssueById(subIssueId) {
    const { rows } = await domainDb.query(
      SUPPORT_DOMAIN,
      `SELECT
         id,
         group_id AS "groupId",
         title,
         description,
         sort_order AS "sortOrder",
         is_active AS "isActive"
       FROM support_trip_issue_subissues
       WHERE id::text = $1
       LIMIT 1`,
      [String(subIssueId || '').trim()],
      { role: 'reader', strongRead: true },
    );
    return rows[0] || null;
  }

  async createPastRideSubIssue(client, payload) {
    const { rows } = await client.query(
      `INSERT INTO support_trip_issue_subissues (
         id,
         group_id,
         title,
         description,
         sort_order,
         is_active,
         created_at,
         updated_at
       ) VALUES (
         gen_random_uuid(),
         $1::uuid,
         $2,
         $3,
         $4,
         $5,
         NOW(),
         NOW()
       )
       RETURNING id`,
      [
        payload.groupId,
        payload.title,
        payload.description || null,
        payload.sortOrder ?? 0,
        payload.isActive !== false,
      ],
    );
    return rows[0]?.id || null;
  }

  async updatePastRideSubIssue(client, subIssueId, payload) {
    const updates = [];
    const params = [];
    const assign = (column, value) => {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    };

    if (Object.prototype.hasOwnProperty.call(payload, 'groupId')) {
      assign('group_id', payload.groupId);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'title')) {
      assign('title', payload.title);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'description')) {
      assign('description', payload.description || null);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'sortOrder')) {
      assign('sort_order', payload.sortOrder);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'isActive')) {
      assign('is_active', payload.isActive === true);
    }
    if (updates.length === 0) {
      return 0;
    }
    updates.push('updated_at = NOW()');
    params.push(String(subIssueId || '').trim());
    const result = await client.query(
      `UPDATE support_trip_issue_subissues
       SET ${updates.join(', ')}
       WHERE id::text = $${params.length}`,
      params,
    );
    return result.rowCount || 0;
  }

  async deletePastRideSubIssue(client, subIssueId) {
    const result = await client.query(
      `DELETE FROM support_trip_issue_subissues
       WHERE id::text = $1`,
      [String(subIssueId || '').trim()],
    );
    return result.rowCount || 0;
  }

  async getStats() {
    const { rows } = await domainDb.query(
      SUPPORT_DOMAIN,
      `SELECT
         COUNT(*)::int AS "totalTickets",
         COUNT(*) FILTER (WHERE status = 'OPEN')::int AS "openTickets",
         COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS "inProgressTickets",
         COUNT(*) FILTER (WHERE status = 'PENDING_USER')::int AS "pendingUserTickets",
         COUNT(*) FILTER (WHERE status = 'RESOLVED')::int AS "resolvedTickets",
         COUNT(*) FILTER (WHERE status = 'CLOSED')::int AS "closedTickets"
       FROM support_tickets`,
      [],
      { role: 'reader', strongRead: true },
    );
    return rows[0] || {
      totalTickets: 0,
      openTickets: 0,
      inProgressTickets: 0,
      pendingUserTickets: 0,
      resolvedTickets: 0,
      closedTickets: 0,
    };
  }
}

module.exports = new PgSupportTicketRepository();
