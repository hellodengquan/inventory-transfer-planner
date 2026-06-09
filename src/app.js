const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const warehouseRoutes = require('./routes/warehouses');
const skuRoutes = require('./routes/skus');
const inventoryRoutes = require('./routes/inventory');
const transferRequestRoutes = require('./routes/transferRequests');
const transferPlanRoutes = require('./routes/transferPlans');
const transferRecordRoutes = require('./routes/transferRecords');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: '库存调拨规划器',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.use('/api/warehouses', warehouseRoutes);
app.use('/api/skus', skuRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/transfer-requests', transferRequestRoutes);
app.use('/api/transfer-plans', transferPlanRoutes);
app.use('/api/transfer-records', transferRecordRoutes);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || '服务器内部错误',
    code: err.code || 'INTERNAL_ERROR'
  });
});

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  库存调拨规划器服务已启动`);
  console.log(`  端口: ${PORT}`);
  console.log(`  健康检查: http://localhost:${PORT}/api/health`);
  console.log(`========================================\n`);
});
