const { childWith, getRequestContext, clearRequestContext } = require('../utils/logger');

const ERROR_CODE_MAP = {
  SQLITE_CONSTRAINT: 'DB_CONSTRAINT_VIOLATION',
  SQLITE_ERROR: 'DB_QUERY_ERROR',
  SQLITE_READONLY: 'DB_READONLY',
  SQLITE_BUSY: 'DB_BUSY',
  SQLITE_LOCKED: 'DB_LOCKED',
  ERR_HTTP_INVALID_STATUS_CODE: 'INVALID_STATUS_CODE',
  ECONNREFUSED: 'CONNECTION_REFUSED',
  ECONNRESET: 'CONNECTION_RESET',
  ETIMEDOUT: 'TIMEOUT',
  ENOTFOUND: 'HOST_NOT_FOUND'
};

const CLIENT_ERROR_CODES = new Set([
  'INVALID_INPUT', 'DUPLICATE_CODE', 'WAREHOUSE_NOT_FOUND', 'SKU_NOT_FOUND',
  'WAREHOUSE_INVALID', 'HAS_INVENTORY', 'PLAN_NOT_FOUND', 'REQUEST_NOT_FOUND',
  'RECORD_NOT_FOUND', 'INVENTORY_NOT_FOUND', 'DUPLICATE_INVENTORY',
  'STATUS_NOT_ALLOWED', 'EMPTY_ITEMS', 'HAS_PLANS', 'VALIDATION_ERROR'
]);

function classifyError(err) {
  if (err.expose || (err.status && err.status >= 400 && err.status < 500)) {
    return 'CLIENT';
  }
  const code = err.code || '';
  if (CLIENT_ERROR_CODES.has(code)) return 'CLIENT';
  if (code.startsWith('SQLITE') && code !== 'SQLITE_ERROR') {
    return 'DB';
  }
  if (code.startsWith('ECONN') || code.startsWith('ETIMED') || code.startsWith('ENOT')) {
    return 'NETWORK';
  }
  if (err.type === 'entity.parse.failed') {
    return 'CLIENT';
  }
  return 'SERVER';
}

function deriveStatusCode(err, classification) {
  if (err.status && err.status >= 400) return err.status;
  if (err.statusCode && err.statusCode >= 400) return err.statusCode;

  switch (classification) {
    case 'CLIENT':
      return 400;
    case 'DB':
      return 503;
    case 'NETWORK':
      return 503;
    case 'SERVER':
    default:
      return 500;
  }
}

function deriveErrorCode(err, classification) {
  if (err.code && typeof err.code === 'string') {
    const mapped = ERROR_CODE_MAP[err.code];
    return mapped || err.code;
  }
  switch (classification) {
    case 'CLIENT':
      return 'BAD_REQUEST';
    case 'DB':
      return 'DATABASE_ERROR';
    case 'NETWORK':
      return 'NETWORK_ERROR';
    case 'SERVER':
    default:
      return 'INTERNAL_SERVER_ERROR';
  }
}

function userFacingMessage(err, classification, statusCode) {
  if (err.expose && err.message) return err.message;
  if (classification === 'CLIENT' && err.message) {
    return err.message;
  }
  if (classification === 'DB') {
    return '数据服务暂时不可用，请稍后重试或联系运维';
  }
  if (classification === 'NETWORK') {
    return '依赖服务连接异常，请稍后重试';
  }
  if (statusCode === 404) {
    return err.message || '资源不存在';
  }
  if (process.env.NODE_ENV === 'production') {
    return '服务器内部错误，请联系运维人员';
  }
  return err.message || '服务器内部错误';
}

function errorHandler() {
  return (err, req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }

    const ctx = getRequestContext();
    const requestId = (req && req.requestId) || (ctx && ctx.requestId) || null;
    const reqLogger = requestId ? childWith({ requestId }) : require('../utils/logger').logger;

    const classification = classifyError(err);
    const statusCode = deriveStatusCode(err, classification);
    const errorCode = deriveErrorCode(err, classification);
    const message = userFacingMessage(err, classification, statusCode);

    const logPayload = {
      component: 'http.error',
      error_class: classification,
      error_code: errorCode,
      http_status: statusCode,
      stack: classification === 'SERVER' || process.env.NODE_ENV !== 'production'
        ? (err.stack || undefined) : undefined,
      request_id: requestId,
      url: req ? req.originalUrl || req.url : undefined,
      method: req ? req.method : undefined,
      remote_addr: req
        ? (req.headers && (req.headers['x-forwarded-for'] || req.ip))
        : undefined
    };

    if (classification === 'CLIENT' || classification === 'DB') {
      reqLogger.warn(`${classification}_ERROR: ${message}`, logPayload);
    } else {
      reqLogger.error(`UNHANDLED_ERROR: ${message}`, logPayload);
    }

    const responseBody = {
      error: message,
      code: errorCode,
      requestId,
      timestamp: new Date().toISOString()
    };

    if (err.details && Array.isArray(err.details)) {
      responseBody.details = err.details;
    }
    if (process.env.NODE_ENV !== 'production' && err.stack) {
      responseBody._stack = err.stack.split('\n').slice(0, 10);
    }

    res.status(statusCode).json(responseBody);
    clearRequestContext();
  };
}

module.exports = errorHandler;
