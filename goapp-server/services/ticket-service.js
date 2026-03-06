// GoApp Chat Ticket / Support System
//
// Users (rider/driver) raise support tickets. Each ticket has a chat thread.
// Admins/support agents can respond. Real-time via WebSocket channel.
//
// Ticket Status Flow:
//   OPEN → IN_PROGRESS → PENDING_USER → RESOLVED → CLOSED
//   Any status → ESCALATED (admin escalation)
//
// Message Roles:
//   user   — rider or driver who raised the ticket
//   agent  — support agent / admin
//   system — automated messages (e.g., "Your ticket has been assigned")

const { logger, eventBus } = require('../utils/logger');

const TICKET_CATEGORIES = [
  'payment_issue',
  'ride_problem',
  'driver_behaviour',
  'rider_behaviour',
  'app_bug',
  'lost_item',
  'account_issue',
  'incentive_issue',
  'sos_followup',
  'other',
];

const VALID_STATUSES = ['OPEN', 'IN_PROGRESS', 'PENDING_USER', 'RESOLVED', 'CLOSED', 'ESCALATED'];

class TicketService {
  constructor() {
    // ticketId -> ticket
    this.tickets = new Map();
    // agentId -> { name, assignedCount }
    this.agents = new Map();
    // Simple round-robin agent assignment index
    this._agentIndex = 0;

    // Seed a few default agents
    this._seedAgents();
  }

  _seedAgents() {
    const defaults = [
      { agentId: 'AGENT-001', name: 'Priya Support', email: 'priya@goapp.in' },
      { agentId: 'AGENT-002', name: 'Ravi Support', email: 'ravi@goapp.in' },
      { agentId: 'AGENT-003', name: 'Anjali Support', email: 'anjali@goapp.in' },
    ];
    defaults.forEach(a => this.agents.set(a.agentId, { ...a, assignedCount: 0, isOnline: true }));
  }

  // ─── Get ticket by ID ─────────────────────────────────────────────────────
  getTicket(ticketId) {
    return this.tickets.get(ticketId) || null;
  }

  // ─── Create a new support ticket ─────────────────────────────────────────
  createTicket({ userId, userType = 'rider', subject, message, category = 'other', rideId = null, priority = 'normal' }) {
    if (!userId || !subject || !message) {
      return { success: false, error: 'userId, subject, and message are required.' };
    }
    if (!TICKET_CATEGORIES.includes(category)) {
      return { success: false, error: `Invalid category. Must be one of: ${TICKET_CATEGORIES.join(', ')}` };
    }
    if (!['low', 'normal', 'high', 'urgent'].includes(priority)) {
      return { success: false, error: 'Invalid priority. Must be: low, normal, high, urgent.' };
    }

    const ticketId = `TICKET-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const now = new Date().toISOString();

    const firstMsg = {
      messageId: `MSG-${Date.now()}`,
      senderId: userId,
      senderRole: 'user',
      senderType: userType,
      content: message,
      attachments: [],
      createdAt: now,
      readAt: null,
    };

    const systemMsg = {
      messageId: `MSG-SYS-${Date.now()}`,
      senderId: 'system',
      senderRole: 'system',
      content: `Ticket #${ticketId} created. Our support team will respond shortly.`,
      attachments: [],
      createdAt: now,
      readAt: now,
    };

    // Auto-assign to an available agent (round-robin)
    const assignedAgent = this._autoAssignAgent();

    const ticket = {
      ticketId,
      userId,
      userType,              // rider | driver
      subject,
      category,
      priority,
      rideId,
      status: 'OPEN',
      assignedAgentId: assignedAgent ? assignedAgent.agentId : null,
      assignedAgentName: assignedAgent ? assignedAgent.name : null,
      messages: [firstMsg, systemMsg],
      tags: [],
      resolution: null,
      escalatedAt: null,
      resolvedAt: null,
      closedAt: null,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.tickets.set(ticketId, ticket);

    if (assignedAgent) {
      assignedAgent.assignedCount++;
      ticket.messages.push({
        messageId: `MSG-ASSIGN-${Date.now()}`,
        senderId: 'system',
        senderRole: 'system',
        content: `Ticket assigned to ${assignedAgent.name}.`,
        attachments: [],
        createdAt: now,
        readAt: now,
      });
    }

    eventBus.publish('ticket_created', { ticketId, userId, userType, category, priority });
    logger.info('TICKET', `Ticket ${ticketId} created by ${userType} ${userId} [${category}] [${priority}]`);

    return { success: true, ticket };
  }

  // ─── Add a message to a ticket (chat) ────────────────────────────────────
  addMessage(ticketId, { senderId, senderRole = 'user', senderType = 'rider', content, attachments = [] }) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return { success: false, error: 'Ticket not found.' };
    if (ticket.status === 'CLOSED') return { success: false, error: 'Ticket is closed. Please create a new ticket.' };
    if (!content || content.trim().length === 0) return { success: false, error: 'Message content cannot be empty.' };
    if (content.length > 5000) return { success: false, error: 'Message too long (max 5000 chars).' };

    const now = new Date().toISOString();
    const message = {
      messageId: `MSG-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      senderId,
      senderRole,           // user | agent | system
      senderType,           // rider | driver | agent | system
      content: content.trim(),
      attachments,
      createdAt: now,
      readAt: null,
    };

    ticket.messages.push(message);
    ticket.lastActivityAt = now;
    ticket.updatedAt = now;

    // Status transitions based on who replies
    if (senderRole === 'agent' && ticket.status === 'OPEN') {
      ticket.status = 'IN_PROGRESS';
    } else if (senderRole === 'agent' && ticket.status === 'PENDING_USER') {
      ticket.status = 'IN_PROGRESS';
    } else if (senderRole === 'user' && ticket.status === 'IN_PROGRESS') {
      ticket.status = 'IN_PROGRESS';    // stays in progress
    } else if (senderRole === 'user' && ticket.status === 'PENDING_USER') {
      ticket.status = 'IN_PROGRESS';    // user replied, back to agent
    }

    eventBus.publish('ticket_message_added', {
      ticketId,
      messageId: message.messageId,
      senderId,
      senderRole,
    });

    return { success: true, message, ticket: { ticketId, status: ticket.status } };
  }

  // ─── Update ticket status ─────────────────────────────────────────────────
  updateStatus(ticketId, { status, resolvedBy = null, resolution = null, agentId = null }) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return { success: false, error: 'Ticket not found.' };
    if (!VALID_STATUSES.includes(status)) {
      return { success: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` };
    }

    const now = new Date().toISOString();
    const prevStatus = ticket.status;
    ticket.status = status;
    ticket.updatedAt = now;
    ticket.lastActivityAt = now;

    if (status === 'RESOLVED') {
      ticket.resolvedAt = now;
      ticket.resolvedBy = resolvedBy || agentId;
      if (resolution) ticket.resolution = resolution;
      ticket.messages.push({
        messageId: `MSG-RES-${Date.now()}`,
        senderId: resolvedBy || 'system',
        senderRole: resolvedBy ? 'agent' : 'system',
        content: resolution || 'Your issue has been resolved. Thank you for contacting GoApp Support.',
        attachments: [],
        createdAt: now,
        readAt: now,
      });
    } else if (status === 'CLOSED') {
      ticket.closedAt = now;
    } else if (status === 'ESCALATED') {
      ticket.escalatedAt = now;
      ticket.priority = 'urgent';
      ticket.messages.push({
        messageId: `MSG-ESC-${Date.now()}`,
        senderId: 'system',
        senderRole: 'system',
        content: 'This ticket has been escalated to our senior support team.',
        attachments: [],
        createdAt: now,
        readAt: now,
      });
    }

    eventBus.publish('ticket_status_updated', { ticketId, prevStatus, newStatus: status });
    logger.info('TICKET', `Ticket ${ticketId} status: ${prevStatus} → ${status}`);

    return { success: true, ticket };
  }

  // ─── Assign ticket to an agent ────────────────────────────────────────────
  assignAgent(ticketId, agentId) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return { success: false, error: 'Ticket not found.' };

    const agent = this.agents.get(agentId);
    if (!agent) return { success: false, error: 'Agent not found.' };

    ticket.assignedAgentId = agentId;
    ticket.assignedAgentName = agent.name;
    ticket.updatedAt = new Date().toISOString();

    const msg = {
      messageId: `MSG-ASSIGN-${Date.now()}`,
      senderId: 'system',
      senderRole: 'system',
      content: `Ticket assigned to ${agent.name}.`,
      attachments: [],
      createdAt: ticket.updatedAt,
      readAt: ticket.updatedAt,
    };
    ticket.messages.push(msg);

    return { success: true, ticket };
  }

  // ─── Add tags to ticket ───────────────────────────────────────────────────
  addTag(ticketId, tag) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return { success: false, error: 'Ticket not found.' };
    if (!ticket.tags.includes(tag)) ticket.tags.push(tag);
    return { success: true, tags: ticket.tags };
  }

  // ─── Mark messages as read ────────────────────────────────────────────────
  markMessagesRead(ticketId, readBy) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return { success: false, error: 'Ticket not found.' };

    const now = new Date().toISOString();
    ticket.messages.forEach(m => {
      if (m.readAt === null && m.senderId !== readBy) {
        m.readAt = now;
      }
    });
    return { success: true };
  }

  // ─── Get all tickets for a user ───────────────────────────────────────────
  getUserTickets(userId, { limit = 20, status = null } = {}) {
    let tickets = Array.from(this.tickets.values()).filter(t => t.userId === userId);
    if (status) tickets = tickets.filter(t => t.status === status);
    return tickets
      .sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt))
      .slice(0, Math.min(limit, 100))
      .map(t => ({
        ...t,
        unreadCount: t.messages.filter(m => m.readAt === null && m.senderId !== userId).length,
      }));
  }

  // ─── Admin: list all tickets ──────────────────────────────────────────────
  listTickets({ status = null, category = null, priority = null, agentId = null, limit = 50 } = {}) {
    let tickets = Array.from(this.tickets.values());
    if (status)   tickets = tickets.filter(t => t.status === status);
    if (category) tickets = tickets.filter(t => t.category === category);
    if (priority) tickets = tickets.filter(t => t.priority === priority);
    if (agentId)  tickets = tickets.filter(t => t.assignedAgentId === agentId);

    return tickets
      .sort((a, b) => {
        const prio = { urgent: 4, high: 3, normal: 2, low: 1 };
        if (prio[b.priority] !== prio[a.priority]) return prio[b.priority] - prio[a.priority];
        return new Date(b.lastActivityAt) - new Date(a.lastActivityAt);
      })
      .slice(0, Math.min(limit, 500));
  }

  // ─── Round-robin agent assignment ────────────────────────────────────────
  _autoAssignAgent() {
    const online = Array.from(this.agents.values()).filter(a => a.isOnline);
    if (!online.length) return null;
    const agent = online[this._agentIndex % online.length];
    this._agentIndex++;
    return agent;
  }

  // ─── Admin: agent management ──────────────────────────────────────────────
  addAgent({ agentId, name, email }) {
    if (!agentId || !name) return { success: false, error: 'agentId and name required.' };
    this.agents.set(agentId, { agentId, name, email, assignedCount: 0, isOnline: true });
    return { success: true, agent: this.agents.get(agentId) };
  }

  listAgents() {
    return Array.from(this.agents.values());
  }

  // ─── Stats ────────────────────────────────────────────────────────────────
  getStats() {
    const counts = {};
    VALID_STATUSES.forEach(s => { counts[s] = 0; });
    const catCounts = {};
    TICKET_CATEGORIES.forEach(c => { catCounts[c] = 0; });

    this.tickets.forEach(t => {
      counts[t.status] = (counts[t.status] || 0) + 1;
      catCounts[t.category] = (catCounts[t.category] || 0) + 1;
    });

    return {
      totalTickets: this.tickets.size,
      statusBreakdown: counts,
      categoryBreakdown: catCounts,
      totalAgents: this.agents.size,
      onlineAgents: Array.from(this.agents.values()).filter(a => a.isOnline).length,
    };
  }
}

module.exports = new TicketService();
