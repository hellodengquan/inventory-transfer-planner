const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const YAML = require('yamljs');
const swaggerUi = require('swagger-ui-express');

const { logger } = require('./utils/logger');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');

const warehouseRoutes = require('./routes/warehouses');
const skuRoutes = require('./routes/skus');
const inventoryRoutes = require('./routes/inventory');
const transferRequestRoutes = require('./routes/transferRequests');
const transferPlanRoutes = require('./routes/transferPlans');
const transferRecordRoutes = require('./routes/transferRecords');

const app = express();
const PORT = process.env.PORT || 3000;

process.on('unhandledRejection', (reason, promise) => {
  logger.error('UNHANDLED_REJECTION', {
    component: 'process',
    reason: reason instanceof Error ? reason.stack : String(reason),
    promise: String(promise)
  });
  if (process.env.NODE_ENV === 'production') {
    setTimeout(() => process.exit(1), 1000);
  }
});

process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT_EXCEPTION', {
    component: 'process',
    stack: err.stack,
    message: err.message
  }, () => {
    process.exit(1);
  });
});

app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));

app.use(requestLogger());

try {
  const openapiPath = path.join(__dirname, 'docs', 'openapi.yaml');
  const swaggerDocument = YAML.load(openapiPath);
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
    explorer: true,
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: '库存调拨规划器 API',
    swaggerOptions: {
      docExpansion: 'list',
      defaultModelsExpandDepth: 1,
      filter: true,
      showRequestHeaders: true
    }
  }));
  app.get('/api-docs/openapi.yaml', (req, res) => {
    res.type('application/yaml');
    res.sendFile(openapiPath);
  });
} catch (err) {
  logger.warn('Swagger UI 初始化失败，跳过挂载', { component: 'swagger', error: err.message });
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: '库存调拨规划器',
    version: '1.0.0',
    requestId: req.requestId || null,
    timestamp: new Date().toISOString(),
    docs: '/api-docs'
  });
});

app.use('/api/warehouses', warehouseRoutes);
app.use('/api/skus', skuRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/transfer-requests', transferRequestRoutes);
app.use('/api/transfer-plans', transferPlanRoutes);
app.use('/api/transfer-records', transferRecordRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: `接口不存在: ${req.method} ${req.originalUrl}`,
    code: 'ROUTE_NOT_FOUND',
    requestId: req.requestId || null,
    timestamp: new Date().toISOString()
  });
});

app.use(errorHandler());

app.listen(PORT, () => {
  logger.info('库存调拨规划器服务已启动', {
    component: 'bootstrap',
    port: PORT,
    health_check: `http://localhost:${PORT}/api/health`,
    api_docs: `http://localhost:${PORT}/api-docs`
  });
});

module.exports = app;
