// GoApp Logger & Event Bus

const { EventEmitter } = require('events');

// ─── Color Logger ───
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
};

function timestamp() {
  return new Date().toISOString().substr(11, 12);
}

const logger = {
  info: (service, msg, data) => {
    console.log(`${colors.dim}[${timestamp()}]${colors.reset} ${colors.cyan}[${service}]${colors.reset} ${msg}`, data ? JSON.stringify(data) : '');
  },
  success: (service, msg, data) => {
    console.log(`${colors.dim}[${timestamp()}]${colors.reset} ${colors.green}✓ [${service}]${colors.reset} ${msg}`, data ? JSON.stringify(data) : '');
  },
  warn: (service, msg, data) => {
    console.log(`${colors.dim}[${timestamp()}]${colors.reset} ${colors.yellow}⚠ [${service}]${colors.reset} ${msg}`, data ? JSON.stringify(data) : '');
  },
  error: (service, msg, data) => {
    console.log(`${colors.dim}[${timestamp()}]${colors.reset} ${colors.red}✗ [${service}]${colors.reset} ${msg}`, data ? JSON.stringify(data) : '');
  },
  event: (eventName, data) => {
    console.log(`${colors.dim}[${timestamp()}]${colors.reset} ${colors.magenta}⚡ [EVENT]${colors.reset} ${eventName}`, data ? JSON.stringify(data) : '');
  },
  divider: (title) => {
    console.log(`\n${colors.bright}${colors.blue}${'═'.repeat(60)}${colors.reset}`);
    if (title) console.log(`${colors.bright}${colors.blue}  ${title}${colors.reset}`);
    console.log(`${colors.bright}${colors.blue}${'═'.repeat(60)}${colors.reset}\n`);
  },
  table: (data) => {
    console.table(data);
  },
};

// ─── Event Bus (Kafka Mock) ───
class EventBus extends EventEmitter {
  constructor() {
    super();
    this.events = [];
    this.setMaxListeners(100);
  }

  publish(eventName, data) {
    const event = {
      id: crypto.randomUUID(),
      event: eventName,
      data,
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
    };
    this.events.push(event);
    logger.event(eventName, { rideId: data.rideId, driverId: data.driverId });
    this.emit(eventName, event);
    this.emit('*', event); // wildcard listener
    return event;
  }

  getEvents(filter) {
    if (!filter) return this.events;
    return this.events.filter(e => e.event === filter);
  }

  getRecentEvents(count = 20) {
    return this.events.slice(-count);
  }

  clear() {
    this.events = [];
  }
}

const crypto = require('crypto');
const eventBus = new EventBus();

module.exports = { logger, eventBus };
