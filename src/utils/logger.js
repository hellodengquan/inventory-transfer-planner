const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const enumerateErrorFormat = winston.format((info) => {
  if (info instanceof Error) {
    Object.assign(info, { message: info.stack });
  }
  return info;
});

const consoleFormat = winston.format.combine(
  enumerateErrorFormat(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.colorize({ level: true }),
  winston.format.printf(({ timestamp, level, message, requestId, durationMs, userId, ...meta }) => {
    const extras = [];
    if (requestId) extras.push(`[reqId=${requestId}]`);
    if (userId) extras.push(`[uid=${userId}]`);
    if (durationMs !== undefined) extras.push(`[${durationMs}ms]`);
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level} ${extras.join(' ')} ${message}${metaStr}`;
  })
);

const jsonFormat = winston.format.combine(
  enumerateErrorFormat(),
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  winston.format.json()
);

const getTransports = () => {
  const transports = [];
  transports.push(new winston.transports.Console({
    level: LOG_LEVEL,
    stderrLevels: ['error', 'warn'],
    format: process.env.NODE_ENV === 'production' ? jsonFormat : consoleFormat
  }));
  return transports;
};

const logger = winston.createLogger({
  level: LOG_LEVEL,
  levels: winston.config.npm.levels,
  transports: getTransports(),
  exitOnError: false
});

const requestContextStore = new Map();

function createRequestId() {
  return uuidv4().replace(/-/g, '').slice(0, 16);
}

function childWith(overrides = {}) {
  const defaults = {};
  if (requestContextStore.has('current')) {
    const ctx = requestContextStore.get('current');
    if (ctx.requestId) defaults.requestId = ctx.requestId;
  }
  return logger.child({ ...defaults, ...overrides });
}

function setRequestContext(ctx) {
  requestContextStore.set('current', ctx);
}

function clearRequestContext() {
  requestContextStore.delete('current');
}

function getRequestContext() {
  return requestContextStore.get('current') || {};
}

module.exports = {
  logger,
  childWith,
  createRequestId,
  setRequestContext,
  clearRequestContext,
  getRequestContext,
  child: (opts) => logger.child(opts)
};
