/**
 * 结构化日志模块
 * @module src/utils/logger
 * @description 基于 winston 的分级结构化日志输出，支持 requestId 自动注入、
 *              按 NODE_ENV 智能默认级别 + LOG_LEVEL 环境变量手动覆盖。
 *
 * 日志级别默认策略（NODE_ENV → level）：
 *   development → debug  (开发期细节可见)
 *   test        → warn   (仅告警+错误，保证测试输出干净)
 *   production  → error  (仅致命错误，降低吞吐成本)
 *   其他未知    → info   (通用默认)
 * 可通过显式设置 process.env.LOG_LEVEL 任意覆盖。
 */

const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

const VALID_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];

/**
 * 根据 NODE_ENV 返回推荐的日志级别
 * @param {string} [env] 可选环境字符串（测试注入用）
 * @returns {'debug'|'warn'|'error'|'info'}
 */
function resolveDefaultLevel(env) {
  const nodeEnv = (env || process.env.NODE_ENV || 'development').toLowerCase();
  switch (nodeEnv) {
    case 'development':
    case 'dev':
      return 'debug';
    case 'test':
    case 'testing':
      return 'warn';
    case 'production':
    case 'prod':
      return 'error';
    default:
      return 'info';
  }
}

/**
 * 计算最终日志级别：显式 LOG_LEVEL 覆盖优先，否则按环境默认
 * @param {object} [opts] 可选参数 { env, explicit } 用于测试注入
 * @returns {string} 合法 winston 级别
 */
function resolveLogLevel(opts = {}) {
  const explicit = opts.explicit !== undefined
    ? opts.explicit
    : (process.env.LOG_LEVEL || process.env.NPM_CONFIG_LOGLEVEL || '');

  if (typeof explicit === 'string' && explicit.length > 0) {
    const lower = explicit.toLowerCase();
    if (VALID_LEVELS.includes(lower)) {
      return lower;
    }
  }
  return resolveDefaultLevel(opts.env);
}

const LOG_LEVEL = resolveLogLevel();

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
    const metaStr = Object.keys(meta).length && !meta.component ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level} ${extras.join(' ')} ${message}${metaStr}`;
  })
);

const jsonFormat = winston.format.combine(
  enumerateErrorFormat(),
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  winston.format.json()
);

const getTransports = (level) => {
  const transports = [];
  transports.push(new winston.transports.Console({
    level,
    stderrLevels: ['error', 'warn'],
    format:
      (process.env.NODE_ENV || 'development').toLowerCase() === 'production'
        ? jsonFormat
        : consoleFormat
  }));
  return transports;
};

/**
 * 按给定级别创建新的 winston logger 实例（工厂，便于测试）
 * @param {object} [options]
 * @param {string} [options.level]
 * @param {object} [options.extraMeta]
 * @returns {winston.Logger}
 */
function createLoggerInstance(options = {}) {
  const level = options.level || LOG_LEVEL;
  return winston.createLogger({
    level,
    levels: winston.config.npm.levels,
    defaultMeta: options.extraMeta || undefined,
    transports: getTransports(level),
    exitOnError: false
  });
}

const logger = createLoggerInstance();

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
  createLoggerInstance,
  resolveLogLevel,
  resolveDefaultLevel,
  LOG_LEVEL,
  VALID_LEVELS,
  childWith,
  createRequestId,
  setRequestContext,
  clearRequestContext,
  getRequestContext,
  child: (opts) => logger.child(opts)
};
