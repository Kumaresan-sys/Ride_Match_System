// GoApp WebSocket Gateway - Pure Node.js implementation
// No external dependencies - uses raw HTTP upgrade + crypto

const http = require('http');
const crypto = require('crypto');
const { logger } = require('../utils/logger');

const MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WebSocketServer {
  constructor({
    authenticateToken = null,
    canAccessRide = null,
    canAccessConversation = null,
    authTimeoutMs = 10000,
  } = {}) {
    this.clients = new Map();       // socketId -> { socket, channels, userId, userType }
    this.channels = new Map();      // channelName -> Set of socketIds
    this.server = null;
    this.authenticateToken = authenticateToken;
    this.canAccessRide = canAccessRide;
    this.canAccessConversation = canAccessConversation;
    this.authTimeoutMs = Number.isFinite(authTimeoutMs) ? authTimeoutMs : 10000;
    this.securityStats = {
      authTimeoutDisconnects: 0,
      unauthenticatedSubscribeDenied: 0,
      channelDeniedTotal: 0,
      channelDeniedByPattern: { rider: 0, driver: 0, ride: 0, other: 0 },
      subscriptionsAccepted: 0,
      subscriptionsDenied: 0,
    };
  }

  start(port) {
    this.server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'GoApp WebSocket Server', clients: this.clients.size }));
    });

    this.server.on('upgrade', (req, socket, head) => {
      this._handleUpgrade(req, socket);
    });

    this.server.listen(port, () => {
      logger.success('WS-GATEWAY', `WebSocket server running on ws://localhost:${port}`);
    });

    return this;
  }

  _handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    // WebSocket handshake
    const acceptKey = crypto.createHash('sha1')
      .update(key + MAGIC_STRING)
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '', '',
    ].join('\r\n');

    socket.write(headers);

    const socketId = crypto.randomUUID();
    const clientInfo = {
      socket,
      channels: new Set(),
      userId: null,
      userType: null,
      connectedAt: Date.now(),
      authenticatedAt: null,
      authTimeout: null,
      isAdmin: false,
    };

    this.clients.set(socketId, clientInfo);
    logger.info('WS-GATEWAY', `Client connected: ${socketId.substr(0, 8)}`);
    clientInfo.authTimeout = setTimeout(() => {
      const activeClient = this.clients.get(socketId);
      if (!activeClient || activeClient.userId) return;
      this.securityStats.authTimeoutDisconnects += 1;
      logger.warn('WS-GATEWAY', `Auth timeout disconnect for socket ${socketId.substr(0, 8)} (${this.authTimeoutMs}ms)`);
      this.sendToClient(socketId, { type: 'auth:error', error: 'Authentication timeout.', code: 'AUTH_TIMEOUT' });
      try { activeClient.socket.destroy(); } catch (_) {}
    }, this.authTimeoutMs);

    // Handle incoming frames
    socket.on('data', (buffer) => {
      try {
        const message = this._decodeFrame(buffer);
        if (message) {
          Promise.resolve(this._handleMessage(socketId, message)).catch(() => {});
        }
      } catch (e) {
        // ignore malformed frames
      }
    });

    socket.on('close', () => {
      this._handleDisconnect(socketId);
    });

    socket.on('error', () => {
      this._handleDisconnect(socketId);
    });

    // Send welcome
    this.sendToClient(socketId, {
      type: 'connected',
      socketId: socketId.substr(0, 8),
      message: 'Connected to GoApp WebSocket Gateway',
    });
  }

  _decodeFrame(buffer) {
    if (buffer.length < 2) return null;

    const secondByte = buffer[1];
    const isMasked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7F;
    let offset = 2;

    if (payloadLength === 126) {
      payloadLength = buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      payloadLength = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }

    let maskKey = null;
    if (isMasked) {
      maskKey = buffer.slice(offset, offset + 4);
      offset += 4;
    }

    const data = buffer.slice(offset, offset + payloadLength);
    if (isMasked && maskKey) {
      for (let i = 0; i < data.length; i++) {
        data[i] ^= maskKey[i % 4];
      }
    }

    try {
      return JSON.parse(data.toString('utf8'));
    } catch {
      return data.toString('utf8');
    }
  }

  _encodeFrame(data) {
    const payload = Buffer.from(JSON.stringify(data), 'utf8');
    const length = payload.length;
    let header;

    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text frame
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    return Buffer.concat([header, payload]);
  }

  async _handleMessage(socketId, message) {
    const client = this.clients.get(socketId);
    if (!client) return;

    switch (message.action) {
      case 'auth':
        {
          const token = String(message.token || '').trim();
          if (!token || !this.authenticateToken) {
            this.sendToClient(socketId, { type: 'auth:error', error: 'Authentication token is required.' });
            return;
          }
          const identity = await this.authenticateToken(token);
          if (!identity?.userId) {
            this.sendToClient(socketId, { type: 'auth:error', error: 'Invalid or expired auth token.' });
            return;
          }
          client.userId = identity.userId;
          client.userType = identity.userType || message.userType || 'rider';
          client.isAdmin = Boolean(identity.isAdmin);
          client.authenticatedAt = Date.now();
          if (client.authTimeout) {
            clearTimeout(client.authTimeout);
            client.authTimeout = null;
          }
          logger.info('WS-GATEWAY', `Authenticated socket ${socketId.substr(0, 8)} for user ${client.userId}`);
          this.sendToClient(socketId, { type: 'auth:ok', userId: client.userId });
        }
        break;

      case 'subscribe':
        await this._subscribe(socketId, String(message.channel || '').trim());
        break;

      case 'unsubscribe':
        await this._unsubscribe(socketId, message.channel);
        break;

      case 'driver:location':
        // Forward to location service via event
        if (!client.userId) {
          this.sendToClient(socketId, { type: 'auth:error', error: 'Authenticate before sending location updates.' });
          return;
        }
        if (this.onLocationUpdate) {
          this.onLocationUpdate(client.userId, message.data);
        }
        break;

      case 'reconnect':
        // Rider app reopened after kill — re-subscribe and push current state
        await this._handleReconnect(socketId, message);
        break;

      case 'chat:message':
        this._broadcastToChannel(message.channel, {
          type: 'chat:message',
          senderId: client.userId,
          message: message.data,
          timestamp: Date.now(),
        }, socketId); // exclude sender
        break;

      default:
        if (this.onMessage) {
          this.onMessage(socketId, message);
        }
    }
  }

  async _subscribe(socketId, channel) {
    const client = this.clients.get(socketId);
    if (!client) return;
    const normalizedChannel = this._normalizeChannelName(channel);
    if (!client.userId) {
      this.securityStats.unauthenticatedSubscribeDenied += 1;
      this.securityStats.subscriptionsDenied += 1;
      this.sendToClient(socketId, { type: 'subscribe:error', error: 'Authenticate before subscribing.', code: 'AUTH_REQUIRED' });
      return;
    }
    if (!(await this._isAuthorizedForChannel(client, normalizedChannel))) {
      this._recordDeniedChannel(normalizedChannel);
      this.securityStats.subscriptionsDenied += 1;
      this._recordSubscriptionAudit(client, normalizedChannel, false);
      this.sendToClient(socketId, { type: 'subscribe:error', error: `Forbidden channel subscription: ${normalizedChannel}`, code: 'FORBIDDEN_CHANNEL' });
      return;
    }

    client.channels.add(normalizedChannel);
    if (!this.channels.has(normalizedChannel)) {
      this.channels.set(normalizedChannel, new Set());
    }
    this.channels.get(normalizedChannel).add(socketId);
    if (typeof this.onSubscribe === 'function') {
      Promise.resolve(this.onSubscribe(socketId, normalizedChannel)).catch(() => {});
    }
    this.securityStats.subscriptionsAccepted += 1;
    this._recordSubscriptionAudit(client, normalizedChannel, true);
    logger.info('WS-GATEWAY', `${socketId.substr(0, 8)} subscribed to ${normalizedChannel}`);
  }

  async _unsubscribe(socketId, channel) {
    const client = this.clients.get(socketId);
    if (!client) return;
    const normalizedChannel = this._normalizeChannelName(channel);

    client.channels.delete(normalizedChannel);
    const ch = this.channels.get(normalizedChannel);
    if (ch) {
      ch.delete(socketId);
      if (ch.size === 0) this.channels.delete(normalizedChannel);
    }
    if (typeof this.onUnsubscribe === 'function') {
      Promise.resolve(this.onUnsubscribe(socketId, normalizedChannel)).catch(() => {});
    }
  }

  _handleDisconnect(socketId) {
    const client = this.clients.get(socketId);
    if (!client) return;
    if (client.authTimeout) {
      clearTimeout(client.authTimeout);
      client.authTimeout = null;
    }

    // Clean up channel subscriptions
    for (const channel of client.channels) {
      const ch = this.channels.get(channel);
      if (ch) {
        ch.delete(socketId);
        if (ch.size === 0) this.channels.delete(channel);
      }
      if (typeof this.onUnsubscribe === 'function') {
        Promise.resolve(this.onUnsubscribe(socketId, channel)).catch(() => {});
      }
    }

    this.clients.delete(socketId);
    logger.info('WS-GATEWAY', `Client disconnected: ${socketId.substr(0, 8)}`);
  }

  // ─── Reconnect Handler ───

  async _handleReconnect(socketId, message) {
    const { rideId } = message;
    const client = this.clients.get(socketId);
    if (!client || !rideId) return;
    if (!client.userId) {
      this.sendToClient(socketId, { type: 'reconnect:error', error: 'Authenticate before reconnect.' });
      return;
    }

    // Subscribe to ride channel
    const channel = `ride_${rideId}`;
    await this._subscribe(socketId, channel);

    logger.info('WS-GATEWAY', `Reconnect: ${client.userId} → channel ${channel}`);

    // Acknowledge reconnect; full snapshot pushed by rideSessionService via HTTP /restore
    this.sendToClient(socketId, {
      type: 'reconnect:ack',
      rideId,
      channel,
      message: 'Resubscribed to ride channel. Call POST /riders/:id/restore for full state.',
    });

    // Log to rideSessionService if injected
    if (this.rideSessionService) {
      this.rideSessionService.logWsReconnect(client.userId, rideId, null);
    }
  }

  async _isAuthorizedForChannel(client, channel) {
    if (!channel) return false;
    if (channel === `rider_${client.userId}`) return true;
    if (channel === `driver_${client.userId}`) return true;
    if (channel === 'admin_chat_monitor') return Boolean(client.isAdmin);
    if (channel.startsWith('admin_chat_')) return Boolean(client.isAdmin);
    if (channel.startsWith('ride_chat_')) {
      const conversationId = channel.slice('ride_chat_'.length);
      if (!conversationId || typeof this.canAccessConversation !== 'function') return false;
      return Boolean(await this.canAccessConversation(client.userId, conversationId, { isAdmin: client.isAdmin }));
    }
    if (channel.startsWith('ride_')) {
      const rideId = channel.slice('ride_'.length);
      if (!rideId) return false;
      if (typeof this.canAccessRide === 'function') {
        return Boolean(await this.canAccessRide(client.userId, rideId, {
          isAdmin: client.isAdmin,
          userType: client.userType,
        }));
      }
      return false;
    }
    return false;
  }

  _normalizeChannelName(channel) {
    const raw = String(channel || '').trim();
    return raw;
  }

  _recordDeniedChannel(channel) {
    this.securityStats.channelDeniedTotal += 1;
    const pattern = this._channelPattern(channel);
    this.securityStats.channelDeniedByPattern[pattern] += 1;
  }

  _channelPattern(channel) {
    if (String(channel).startsWith('rider_')) return 'rider';
    if (String(channel).startsWith('driver_')) return 'driver';
    if (String(channel).startsWith('ride_chat_')) return 'ride';
    if (String(channel).startsWith('ride_')) return 'ride';
    if (String(channel).startsWith('admin_chat_')) return 'other';
    return 'other';
  }

  _recordSubscriptionAudit(client, channel, allowed) {
    logger.info(
      'WS-AUDIT',
      `subscribe user=${client.userId || 'anonymous'} type=${client.userType || 'unknown'} channel=${channel} allowed=${allowed ? 'true' : 'false'}`
    );
  }

  // Push a full ride state snapshot to a single socket (called after /restore)
  sendRideSnapshot(socketId, ride, driverLocation) {
    const now = Date.now();
    const elapsedSec = ride.startedAt
      ? Math.floor((now - new Date(ride.startedAt).getTime()) / 1000)
      : 0;

    this.sendToClient(socketId, {
      type: 'ride:snapshot',
      rideId: ride.rideId,
      status: ride.status,
      elapsedSec,
      pickupLat: ride.pickupLat,
      pickupLng: ride.pickupLng,
      destLat: ride.destLat,
      destLng: ride.destLng,
      driver: driverLocation || null,
      fareEstimate: ride.fareEstimate || null,
      statusHistory: ride.statusHistory || [],
      snapshotAt: new Date(now).toISOString(),
    });
  }

  // ─── Public API ───

  sendToClient(socketId, data) {
    const client = this.clients.get(socketId);
    if (client && !client.socket.destroyed) {
      try {
        client.socket.write(this._encodeFrame(data));
      } catch (e) {
        // Client disconnected
      }
    }
  }

  sendToUser(userId, data) {
    for (const [socketId, client] of this.clients) {
      if (client.userId === userId) {
        this.sendToClient(socketId, data);
      }
    }
  }

  broadcastToChannel(channel, data) {
    this._broadcastToChannel(channel, data);
  }

  _broadcastToChannel(channel, data, excludeSocketId) {
    const subscribers = this.channels.get(channel);
    if (!subscribers) return;

    for (const socketId of subscribers) {
      if (socketId !== excludeSocketId) {
        this.sendToClient(socketId, data);
      }
    }
  }

  broadcastAll(data) {
    for (const socketId of this.clients.keys()) {
      this.sendToClient(socketId, data);
    }
  }

  getConnectedUsers() {
    const users = [];
    for (const [id, client] of this.clients) {
      users.push({
        socketId: id.substr(0, 8),
        userId: client.userId,
        userType: client.userType,
        isAdmin: client.isAdmin,
        channels: [...client.channels],
        connectedSec: Math.round((Date.now() - client.connectedAt) / 1000),
      });
    }
    return users;
  }

  getStats() {
    return {
      totalClients: this.clients.size,
      totalChannels: this.channels.size,
      security: this.securityStats,
      channels: Object.fromEntries(
        [...this.channels.entries()].map(([ch, subs]) => [ch, subs.size])
      ),
    };
  }

  stop() {
    for (const [, client] of this.clients) {
      client.socket.destroy();
    }
    this.clients.clear();
    this.channels.clear();
    if (this.server) this.server.close();
  }

  getClientInfo(socketId) {
    const client = this.clients.get(socketId);
    if (!client) return null;
    return {
      userId: client.userId,
      userType: client.userType,
      isAdmin: client.isAdmin,
      channels: [...client.channels],
    };
  }

  isUserSubscribedToChannel(userId, channel) {
    const subscribers = this.channels.get(channel);
    if (!subscribers || !userId) return false;
    for (const socketId of subscribers) {
      const client = this.clients.get(socketId);
      if (client?.userId && String(client.userId) === String(userId)) {
        return true;
      }
    }
    return false;
  }
}

module.exports = WebSocketServer;
