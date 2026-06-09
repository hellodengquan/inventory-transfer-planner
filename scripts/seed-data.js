const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/inventory.db');
const db = new sqlite3.Database(DB_PATH);

function runSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID });
    });
  });
}

async function seedData() {
  console.log('开始插入示例数据...\n');

  const warehouses = [
    { code: 'WH-BJ', name: '北京中心仓', location: '北京市朝阳区', type: 'CENTER', status: 'ACTIVE', min_security_stock: 100 },
    { code: 'WH-SH', name: '上海华东仓', location: '上海市浦东新区', type: 'REGIONAL', status: 'ACTIVE', min_security_stock: 50 },
    { code: 'WH-GZ', name: '广州华南仓', location: '广州市天河区', type: 'REGIONAL', status: 'ACTIVE', min_security_stock: 50 },
    { code: 'WH-CD', name: '成都西南仓', location: '成都市武侯区', type: 'REGIONAL', status: 'ACTIVE', min_security_stock: 30 },
    { code: 'WH-WH', name: '武汉华中仓', location: '武汉市洪山区', type: 'REGIONAL', status: 'ACTIVE', min_security_stock: 40 }
  ];

  const warehouseIds = {};
  for (const wh of warehouses) {
    const result = await runSql(
      'INSERT INTO warehouses (code, name, location, type, status, min_security_stock) VALUES (?, ?, ?, ?, ?, ?)',
      [wh.code, wh.name, wh.location, wh.type, wh.status, wh.min_security_stock]
    );
    warehouseIds[wh.code] = result.lastID;
    console.log(`✓ 仓库: ${wh.name}`);
  }

  const skus = [
    { sku_code: 'SKU-001', name: '高端狗粮 10kg', category: '宠物食品', unit: '袋', spec: '10kg/袋', weight: 10, volume: 0.05 },
    { sku_code: 'SKU-002', name: '中端狗粮 5kg', category: '宠物食品', unit: '袋', spec: '5kg/袋', weight: 5, volume: 0.025 },
    { sku_code: 'SKU-003', name: '幼犬粮 3kg', category: '宠物食品', unit: '袋', spec: '3kg/袋', weight: 3, volume: 0.015 },
    { sku_code: 'SKU-004', name: '猫粮 8kg', category: '宠物食品', unit: '袋', spec: '8kg/袋', weight: 8, volume: 0.04 },
    { sku_code: 'SKU-005', name: '宠物玩具球', category: '宠物玩具', unit: '个', spec: '直径8cm', weight: 0.1, volume: 0.001 },
    { sku_code: 'SKU-006', name: '牵引绳 L号', category: '宠物用品', unit: '条', spec: 'L号/1.5m', weight: 0.2, volume: 0.002 },
    { sku_code: 'SKU-007', name: '宠物沐浴露 500ml', category: '宠物洗护', unit: '瓶', spec: '500ml', weight: 0.55, volume: 0.001 },
    { sku_code: 'SKU-008', name: '狗窝 M号', category: '宠物用品', unit: '个', spec: 'M号/60*50cm', weight: 1.2, volume: 0.08 }
  ];

  const skuIds = {};
  for (const sku of skus) {
    const result = await runSql(
      'INSERT INTO skus (sku_code, name, category, unit, spec, weight, volume) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [sku.sku_code, sku.name, sku.category, sku.unit, sku.spec, sku.weight, sku.volume]
    );
    skuIds[sku.sku_code] = result.lastID;
    console.log(`✓ SKU: ${sku.name}`);
  }

  const inventoryData = [
    { wh: 'WH-BJ', sku: 'SKU-001', available: 500, reserved: 20, minStock: 100, maxStock: 1000 },
    { wh: 'WH-BJ', sku: 'SKU-002', available: 800, reserved: 50, minStock: 150, maxStock: 1500 },
    { wh: 'WH-BJ', sku: 'SKU-003', available: 300, reserved: 10, minStock: 80, maxStock: 600 },
    { wh: 'WH-BJ', sku: 'SKU-004', available: 450, reserved: 30, minStock: 100, maxStock: 800 },
    { wh: 'WH-BJ', sku: 'SKU-005', available: 1200, reserved: 100, minStock: 200, maxStock: 3000 },
    { wh: 'WH-BJ', sku: 'SKU-006', available: 600, reserved: 40, minStock: 100, maxStock: 1200 },
    { wh: 'WH-BJ', sku: 'SKU-007', available: 400, reserved: 15, minStock: 80, maxStock: 800 },
    { wh: 'WH-BJ', sku: 'SKU-008', available: 150, reserved: 5, minStock: 30, maxStock: 300 },
    { wh: 'WH-SH', sku: 'SKU-001', available: 80, reserved: 10, minStock: 50, maxStock: 500 },
    { wh: 'WH-SH', sku: 'SKU-002', available: 120, reserved: 20, minStock: 80, maxStock: 800 },
    { wh: 'WH-SH', sku: 'SKU-003', available: 200, reserved: 15, minStock: 50, maxStock: 500 },
    { wh: 'WH-SH', sku: 'SKU-004', available: 60, reserved: 5, minStock: 40, maxStock: 400 },
    { wh: 'WH-SH', sku: 'SKU-005', available: 500, reserved: 50, minStock: 100, maxStock: 1500 },
    { wh: 'WH-SH', sku: 'SKU-006', available: 150, reserved: 10, minStock: 40, maxStock: 600 },
    { wh: 'WH-GZ', sku: 'SKU-001', available: 40, reserved: 5, minStock: 50, maxStock: 400 },
    { wh: 'WH-GZ', sku: 'SKU-002', available: 90, reserved: 10, minStock: 80, maxStock: 600 },
    { wh: 'WH-GZ', sku: 'SKU-003', available: 300, reserved: 20, minStock: 50, maxStock: 500 },
    { wh: 'WH-GZ', sku: 'SKU-004', available: 100, reserved: 8, minStock: 40, maxStock: 350 },
    { wh: 'WH-GZ', sku: 'SKU-007', available: 200, reserved: 15, minStock: 50, maxStock: 500 },
    { wh: 'WH-GZ', sku: 'SKU-008', available: 80, reserved: 5, minStock: 20, maxStock: 200 },
    { wh: 'WH-CD', sku: 'SKU-001', available: 20, reserved: 2, minStock: 30, maxStock: 300 },
    { wh: 'WH-CD', sku: 'SKU-002', available: 50, reserved: 5, minStock: 30, maxStock: 400 },
    { wh: 'WH-CD', sku: 'SKU-005', available: 200, reserved: 20, minStock: 60, maxStock: 800 },
    { wh: 'WH-CD', sku: 'SKU-006', available: 80, reserved: 5, minStock: 25, maxStock: 400 },
    { wh: 'WH-WH', sku: 'SKU-001', available: 60, reserved: 8, minStock: 40, maxStock: 400 },
    { wh: 'WH-WH', sku: 'SKU-003', available: 150, reserved: 10, minStock: 40, maxStock: 450 },
    { wh: 'WH-WH', sku: 'SKU-004', available: 30, reserved: 3, minStock: 35, maxStock: 300 },
    { wh: 'WH-WH', sku: 'SKU-007', available: 100, reserved: 10, minStock: 40, maxStock: 400 },
    { wh: 'WH-WH', sku: 'SKU-008', available: 40, reserved: 2, minStock: 15, maxStock: 150 }
  ];

  for (const inv of inventoryData) {
    await runSql(
      'INSERT INTO inventory (warehouse_id, sku_id, available_qty, reserved_qty, in_transit_qty, min_stock, max_stock) VALUES (?, ?, ?, ?, 0, ?, ?)',
      [warehouseIds[inv.wh], skuIds[inv.sku], inv.available, inv.reserved, inv.minStock, inv.maxStock]
    );
  }
  console.log(`✓ 库存记录: ${inventoryData.length} 条`);

  console.log('\n示例数据插入完成！');
  db.close();
}

seedData().catch(err => {
  console.error('数据插入失败:', err);
  db.close();
  process.exit(1);
});
