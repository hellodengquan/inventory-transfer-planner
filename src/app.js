const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const swaggerJSDoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

try {
  require('dotenv').config();
} catch (_err) {
  /* 无 dotenv 不影响运行，保持兼容 */
}

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
  const swaggerSpec = swaggerJSDoc({
    definition: {
      openapi: '3.0.3',
      info: {
        title: '库存调拨规划器 API',
        version: '1.0.0',
        description: `库存调拨规划器提供完整的调拨申请、库存约束检查、调拨方案生成与确认、
多仓自动分配、仓库/SKU/库存/调拨记录等能力。
**约束分级**: FATAL / WARNING / INFO。
**调拨方案状态机**: PENDING → CONFIRMED → COMPLETED；分支 REJECTED / CANCELLED。
Swagger UI 由 swagger-jsdoc 自动从路由 JSDoc 注解生成，保证代码与文档实时一致。`,
        contact: { name: 'Inventory Ops Team' }
      },
      servers: [
        { url: `http://localhost:${PORT}`, description: '本地开发环境' },
        { url: '/', description: '当前部署' }
      ],
      tags: [
        { name: 'Health', description: '健康检查' },
        { name: 'Warehouses', description: '仓库管理' },
        { name: 'SKUs', description: 'SKU 管理' },
        { name: 'Inventory', description: '库存管理' },
        { name: 'Transfer Requests', description: '调拨申请' },
        { name: 'Transfer Plans', description: '调拨方案' },
        { name: 'Transfer Records', description: '调拨记录' }
      ]
    },
    apis: [path.join(__dirname, 'routes', '*.js')]
  });

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
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

  app.get('/api-docs/openapi.json', (req, res) => {
    res.json(swaggerSpec);
  });
} catch (err) {
  logger.warn('Swagger UI/文档初始化失败，跳过挂载', { component: 'swagger', error: err.message, stack: err.stack });
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
