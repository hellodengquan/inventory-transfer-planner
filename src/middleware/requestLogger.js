const { logger, createRequestId, setRequestContext, clearRequestContext, childWith } = require('../utils/logger');

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'x-auth-token', 'proxy-authorization'];

const DEFAULT_SKIP_PATHS = [
  '/api/health',
  '/favicon.ico',
  '/api-docs',
  '/api-docs/swagger-ui'
];

const DEFAULT_SKIP_METHODS = ['OPTIONS'];

function shouldSkip(req, options = {}) {
  const skipPaths = options.skipPaths || DEFAULT_SKIP_PATHS;
  const skipMethods = options.skipMethods || DEFAULT_SKIP_METHODS;
  if (skipMethods.includes(req.method)) return true;
  for (const p of skipPaths) {
    if (req.path.startsWith(p)) return true;
  }
  return false;
}

function sanitizeHeaders(headers) {
  const safe = {};
  for (const key of Object.keys(headers || {})) {
    if (SENSITIVE_HEADERS.includes(key.toLowerCase())) {
      safe[key] = '[REDACTED]';
    } else {
      safe[key] = headers[key];
    }
  }
  return safe;
}

function getStatusCategory(status) {
  if (status < 400) return 'SUCCESS';
  if (status < 500) return 'CLIENT_ERROR';
  return 'SERVER_ERROR';
}

function requestLogger(options = {}) {
  const log = options.logger || logger;

  return (req, res, next) => {
    if (shouldSkip(req, options)) return next();

    const requestId = req.headers['x-request-id'] || createRequestId();
    const startTime = Date.now();

    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    setRequestContext({ requestId });

    const reqLogger = childWith({ requestId });
    req.log = reqLogger;

    const url = req.originalUrl || req.url;
    const headers = sanitizeHeaders(req.headers);
    const queryString = JSON.stringify(req.query || {});

    reqLogger.info(`REQ ${req.method} ${url}`, {
      component: 'http.in',
      http_method: req.method,
      http_path: req.path,
      http_url: url,
      http_query: queryString,
      http_headers: headers,
      request_size: req.headers['content-length'] || 0
    });

    const originalJson = res.json;
    let responseBodySize = 0;
    res.json = function patchedJson(body) {
      try {
        if (body && typeof body === 'object') {
          responseBodySize = Buffer.byteLength(JSON.stringify(body), 'utf8');
        }
      } catch (e) {}
      return originalJson.apply(this, arguments);
    };

    res.on('finish', () => {
      const durationMs = Date.now() - startTime;
      const status = res.statusCode;
      const category = getStatusCategory(status);

      const meta = {
        component: 'http.out',
        http_method: req.method,
        http_path: req.path,
        http_url: url,
        http_status: status,
        http_status_category: category,
        duration_ms: durationMs,
        response_size: responseBodySize,
        requestId
      };

      const msg = `RES ${req.method} ${url} ${status} ${durationMs}ms`;

      if (status >= 500) {
        reqLogger.error(msg, meta);
      } else if (status >= 400) {
        reqLogger.warn(msg, meta);
      } else {
        reqLogger.info(msg, meta);
      }

      clearRequestContext();
    });

    res.on('close', () => {
      if (!res.writableFinished) {
        const durationMs = Date.now() - startTime;
        reqLogger.warn(`CONN_CLOSED ${req.method} ${url} premature (${durationMs}ms)`, {
          component: 'http.close',
          duration_ms: durationMs,
          requestId
        });
        clearRequestContext();
      }
    });

    next();
  };
}

module.exports = requestLogger;
