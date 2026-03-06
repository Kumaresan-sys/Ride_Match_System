// GoApp WebSocket Gateway - Pure Node.js implementation
// No external dependencies - uses raw HTTP upgrade + crypto

const http = require('http');
const crypto = require('crypto');
const { logger } = require('../utils/logger');

const MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WebSocketServer {
  constructor() {
    this.clients = new Map();       // socketId -> { socket, channels, userId, userType }
    this.channels = new Map();      // channelName -> Set of socketIds
    this.server = null;
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
    };

    this.clients.set(socketId, clientInfo);
    logger.info('WS-GATEWAY', `Client connected: ${socketId.substr(0, 8)}`);

    // Handle incoming frames
    socket.on('data', (buffer) => {
      try {
        const message = this._decodeFrame(buffer);
        if (message) {
          this._handleMessage(socketId, message);
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

  _handleMessage(socketId, message) {
    const client = this.clients.get(socketId);
    if (!client) return;

    switch (message.action) {
      case 'auth':
        client.userId = message.userId;
        client.userType = message.userType; // 'rider' or 'driver'
        logger.info('WS-GATEWAY', `Authenticated: ${message.userType} ${message.userId}`);
        break;

      case 'subscribe':
        this._subscribe(socketId, message.channel);
        break;

      case 'unsubscribe':
        this._unsubscribe(socketId, message.channel);
        break;

      case 'driver:location':
        // Forward to location service via event
        if (this.onLocationUpdate) {
          this.onLocationUpdate(client.userId, message.data);
        }
        break;

      case 'reconnect':
        // Rider app reopened after kill — re-subscribe and push current state
        this._handleReconnect(socketId, message);
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

  _subscribe(socketId, channel) {
    const client = this.clients.get(socketId);
    if (!client) return;

    client.channels.add(channel);
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }
    this.channels.get(channel).add(socketId);
    logger.info('WS-GATEWAY', `${socketId.substr(0, 8)} subscribed to ${channel}`);
  }

  _unsubscribe(socketId, channel) {
    const client = this.clients.get(socketId);
    if (!client) return;

    client.channels.delete(channel);
    const ch = this.channels.get(channel);
    if (ch) {
      ch.delete(socketId);
      if (ch.size === 0) this.channels.delete(channel);
    }
  }

  _handleDisconnect(socketId) {
    const client = this.clients.get(socketId);
    if (!client) return;

    // Clean up channel subscriptions
    for (const channel of client.channels) {
      const ch = this.channels.get(channel);
      if (ch) {
        ch.delete(socketId);
        if (ch.size === 0) this.channels.delete(channel);
      }
    }

    this.clients.delete(socketId);
    logger.info('WS-GATEWAY', `Client disconnected: ${socketId.substr(0, 8)}`);
  }

  // ─── Reconnect Handler ───

  _handleReconnect(socketId, message) {
    const { userId, userType, rideId } = message;
    const client = this.clients.get(socketId);
    if (!client || !rideId) return;

    // Set identity
    client.userId = userId;
    client.userType = userType || 'rider';

    // Subscribe to ride channel
    const channel = `ride:${rideId}`;
    this._subscribe(socketId, channel);

    logger.info('WS-GATEWAY', `Reconnect: ${userType} ${userId} → channel ${channel}`);

    // Acknowledge reconnect; full snapshot pushed by rideSessionService via HTTP /restore
    this.sendToClient(socketId, {
      type: 'reconnect:ack',
      rideId,
      channel,
      message: 'Resubscribed to ride channel. Call POST /riders/:id/restore for full state.',
    });

    // Log to rideSessionService if injected
    if (this.rideSessionService) {
      this.rideSessionService.logWsReconnect(userId, rideId, null);
    }
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
}

module.exports = WebSocketServer;
