const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const TEST_DATA_DIR = path.join(__dirname, '../data');
const WORKER_ID = process.env.JEST_WORKER_ID || '0';
const TEST_DB_PATH = path.join(TEST_DATA_DIR, `test-inventory-${WORKER_ID}.db`);

function ensureDataDir() {
  if (!fs.existsSync(TEST_DATA_DIR)) {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }
}

function removeTestDb() {
  ensureDataDir();
  if (fs.existsSync(TEST_DB_PATH)) {
    try {
      fs.unlinkSync(TEST_DB_PATH);
    } catch (e) {}
  }
}

function initTestDb() {
  return new Promise((resolve, reject) => {
    ensureDataDir();
    removeTestDb();
    const db = new sqlite3.Database(TEST_DB_PATH);
    db.serialize(() => {
      db.run('PRAGMA foreign_keys = ON');

      db.run(`CREATE TABLE warehouses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        location TEXT,
        type TEXT DEFAULT 'NORMAL',
        status TEXT DEFAULT 'ACTIVE',
        min_security_stock REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      db.run(`CREATE TABLE skus (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku_code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        category TEXT,
        unit TEXT DEFAULT '件',
        spec TEXT,
        weight REAL DEFAULT 0,
        volume REAL DEFAULT 0,
        status TEXT DEFAULT 'ACTIVE',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      db.run(`CREATE TABLE inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        sku_id INTEGER NOT NULL,
        available_qty REAL NOT NULL DEFAULT 0,
        reserved_qty REAL NOT NULL DEFAULT 0,
        in_transit_qty REAL NOT NULL DEFAULT 0,
        min_stock REAL DEFAULT 0,
        max_stock REAL DEFAULT NULL,
        last_count_date DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (warehouse_id, sku_id),
        FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
        FOREIGN KEY (sku_id) REFERENCES skus(id) ON DELETE CASCADE
      )`);

      db.run(`CREATE TABLE transfer_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_no TEXT NOT NULL UNIQUE,
        source_warehouse_id INTEGER,
        target_warehouse_id INTEGER NOT NULL,
        request_type TEXT DEFAULT 'NORMAL',
        priority TEXT DEFAULT 'NORMAL',
        status TEXT DEFAULT 'DRAFT',
        requester TEXT,
        department TEXT,
        reason TEXT,
        expected_date DATE,
        total_qty REAL DEFAULT 0,
        total_skus INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id),
        FOREIGN KEY (target_warehouse_id) REFERENCES warehouses(id)
      )`);

      db.run(`CREATE TABLE transfer_request_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL,
        sku_id INTEGER NOT NULL,
        requested_qty REAL NOT NULL,
        allocated_qty REAL DEFAULT 0,
        unit_price REAL DEFAULT 0,
        remark TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (request_id) REFERENCES transfer_requests(id) ON DELETE CASCADE,
        FOREIGN KEY (sku_id) REFERENCES skus(id)
      )`);

      db.run(`CREATE TABLE transfer_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_no TEXT NOT NULL UNIQUE,
        request_id INTEGER NOT NULL,
        status TEXT DEFAULT 'PENDING',
        plan_type TEXT DEFAULT 'SINGLE_SOURCE',
        total_transfer_qty REAL DEFAULT 0,
        constraint_check_result TEXT,
        constraint_check_passed INTEGER DEFAULT 0,
        planner TEXT,
        review_comment TEXT,
        confirmed_at DATETIME,
        rejected_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (request_id) REFERENCES transfer_requests(id) ON DELETE CASCADE
      )`);

      db.run(`CREATE TABLE transfer_plan_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL,
        request_item_id INTEGER NOT NULL,
        sku_id INTEGER NOT NULL,
        source_warehouse_id INTEGER NOT NULL,
        target_warehouse_id INTEGER NOT NULL,
        planned_qty REAL NOT NULL,
        source_before_qty REAL,
        source_after_qty REAL,
        target_before_qty REAL,
        target_after_qty REAL,
        shortage_qty REAL DEFAULT 0,
        warning TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plan_id) REFERENCES transfer_plans(id) ON DELETE CASCADE,
        FOREIGN KEY (request_item_id) REFERENCES transfer_request_items(id) ON DELETE CASCADE,
        FOREIGN KEY (sku_id) REFERENCES skus(id),
        FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id),
        FOREIGN KEY (target_warehouse_id) REFERENCES warehouses(id)
      )`);

      db.run(`CREATE TABLE constraint_violations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL,
        plan_item_id INTEGER,
        violation_type TEXT NOT NULL,
        severity TEXT DEFAULT 'WARNING',
        message TEXT NOT NULL,
        warehouse_id INTEGER,
        sku_id INTEGER,
        current_value REAL,
        required_value REAL,
        threshold_value REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plan_id) REFERENCES transfer_plans(id) ON DELETE CASCADE,
        FOREIGN KEY (plan_item_id) REFERENCES transfer_plan_items(id) ON DELETE CASCADE
      )`);

      db.run(`CREATE TABLE transfer_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_no TEXT NOT NULL UNIQUE,
        plan_id INTEGER,
        request_id INTEGER,
        source_warehouse_id INTEGER NOT NULL,
        target_warehouse_id INTEGER NOT NULL,
        sku_id INTEGER NOT NULL,
        transfer_qty REAL NOT NULL,
        operator TEXT,
        operate_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        remark TEXT,
        FOREIGN KEY (plan_id) REFERENCES transfer_plans(id),
        FOREIGN KEY (request_id) REFERENCES transfer_requests(id),
        FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id),
        FOREIGN KEY (target_warehouse_id) REFERENCES warehouses(id),
        FOREIGN KEY (sku_id) REFERENCES skus(id)
      )`, (err) => {
        if (err) {
          db.close(() => reject(err));
        } else {
          resolve(db);
        }
      });
    });
  });
}

function seedTestData(db) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      const warehouses = [
        { code: 'WH-BJ', name: '北京中心仓', type: 'CENTER', status: 'ACTIVE', min_security_stock: 100 },
        { code: 'WH-SH', name: '上海华东仓', type: 'REGIONAL', status: 'ACTIVE', min_security_stock: 50 },
        { code: 'WH-GZ', name: '广州华南仓', type: 'REGIONAL', status: 'ACTIVE', min_security_stock: 50 },
        { code: 'WH-CD', name: '成都西南仓', type: 'REGIONAL', status: 'INACTIVE', min_security_stock: 30 },
        { code: 'WH-WH', name: '武汉华中仓', type: 'REGIONAL', status: 'ACTIVE', min_security_stock: 40 }
      ];
      const warehouseIds = {};
      let whPending = warehouses.length;

      for (const wh of warehouses) {
        db.run(
          'INSERT INTO warehouses (code, name, type, status, min_security_stock) VALUES (?, ?, ?, ?, ?)',
          [wh.code, wh.name, wh.type, wh.status, wh.min_security_stock],
          function(err) {
            if (err) {
              db.run('ROLLBACK', () => reject(err));
              return;
            }
            warehouseIds[wh.code] = this.lastID;
            if (--whPending === 0) doSkus();
          }
        );
      }

      const skuIds = {};
      const skus = [
        { sku_code: 'SKU-001', name: '高端狗粮 10kg', category: '宠物食品', unit: '袋' },
        { sku_code: 'SKU-002', name: '中端狗粮 5kg', category: '宠物食品', unit: '袋' },
        { sku_code: 'SKU-003', name: '幼犬粮 3kg', category: '宠物食品', unit: '袋' },
        { sku_code: 'SKU-004', name: '猫粮 8kg', category: '宠物食品', unit: '袋' },
        { sku_code: 'SKU-005', name: '宠物玩具球', category: '宠物玩具', unit: '个' },
        { sku_code: 'SKU-006', name: '牵引绳 L号', category: '宠物用品', unit: '条' },
        { sku_code: 'SKU-007', name: '宠物沐浴露 500ml', category: '宠物洗护', unit: '瓶' }
      ];

      function doSkus() {
        let skuPending = skus.length;
        for (const sku of skus) {
          db.run(
            'INSERT INTO skus (sku_code, name, category, unit) VALUES (?, ?, ?, ?)',
            [sku.sku_code, sku.name, sku.category, sku.unit],
            function(err) {
              if (err) {
                db.run('ROLLBACK', () => reject(err));
                return;
              }
              skuIds[sku.sku_code] = this.lastID;
              if (--skuPending === 0) doInventory();
            }
          );
        }
      }

      const inventoryData = [
        { wh: 'WH-BJ', sku: 'SKU-001', available: 500, reserved: 20, minStock: 100, maxStock: 1000 },
        { wh: 'WH-BJ', sku: 'SKU-002', available: 800, reserved: 50, minStock: 150, maxStock: 1500 },
        { wh: 'WH-BJ', sku: 'SKU-003', available: 300, reserved: 10, minStock: 80, maxStock: 600 },
        { wh: 'WH-BJ', sku: 'SKU-004', available: 450, reserved: 30, minStock: 100, maxStock: 800 },
        { wh: 'WH-BJ', sku: 'SKU-005', available: 1200, reserved: 100, minStock: 200, maxStock: 3000 },
        { wh: 'WH-BJ', sku: 'SKU-006', available: 600, reserved: 40, minStock: 100, maxStock: 1200 },
        { wh: 'WH-BJ', sku: 'SKU-007', available: 400, reserved: 15, minStock: 80, maxStock: 800 },
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
        { wh: 'WH-CD', sku: 'SKU-001', available: 20, reserved: 2, minStock: 30, maxStock: 300 },
        { wh: 'WH-CD', sku: 'SKU-002', available: 50, reserved: 5, minStock: 30, maxStock: 400 },
        { wh: 'WH-CD', sku: 'SKU-005', available: 200, reserved: 20, minStock: 60, maxStock: 800 },
        { wh: 'WH-CD', sku: 'SKU-006', available: 80, reserved: 5, minStock: 25, maxStock: 400 },
        { wh: 'WH-WH', sku: 'SKU-001', available: 60, reserved: 8, minStock: 40, maxStock: 400 },
        { wh: 'WH-WH', sku: 'SKU-003', available: 150, reserved: 10, minStock: 40, maxStock: 450 },
        { wh: 'WH-WH', sku: 'SKU-004', available: 30, reserved: 3, minStock: 35, maxStock: 300 },
        { wh: 'WH-WH', sku: 'SKU-007', available: 100, reserved: 10, minStock: 40, maxStock: 400 }
      ];

      function doInventory() {
        let invPending = inventoryData.length;
        if (invPending === 0) finish();
        for (const inv of inventoryData) {
          db.run(
            'INSERT INTO inventory (warehouse_id, sku_id, available_qty, reserved_qty, min_stock, max_stock) VALUES (?, ?, ?, ?, ?, ?)',
            [warehouseIds[inv.wh], skuIds[inv.sku], inv.available, inv.reserved, inv.minStock, inv.maxStock],
            function(err) {
              if (err) {
                db.run('ROLLBACK', () => reject(err));
                return;
              }
              if (--invPending === 0) finish();
            }
          );
        }
      }

      function finish() {
        db.run('COMMIT', (err) => {
          if (err) {
            db.run('ROLLBACK', () => reject(err));
          } else {
            resolve({ warehouseIds, skuIds });
          }
        });
      }
    });
  });
}

function runSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function generateRequestNo() {
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `TR-TEST-${rand}-${Date.now()}`;
}

function generatePlanNo() {
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `TP-TEST-${rand}-${Date.now()}`;
}

function createTransferRequest(db, data, ids) {
  return new Promise((resolve, reject) => {
    const {
      source_warehouse_id = null,
      target_warehouse_id,
      status = 'SUBMITTED',
      priority = 'NORMAL',
      items = []
    } = data;

    const request_no = generateRequestNo();
    const total_qty = items.reduce((sum, i) => sum + Number(i.requested_qty || 0), 0);
    const total_skus = items.length;

    db.run(
      `INSERT INTO transfer_requests
        (request_no, source_warehouse_id, target_warehouse_id, priority, status, total_qty, total_skus, requester, department, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [request_no, source_warehouse_id, target_warehouse_id, priority, status, total_qty, total_skus,
       data.requester || 'tester', data.department || 'QA', data.reason || 'test'],
      function(err) {
        if (err) {
          reject(err);
          return;
        }
        const requestId = this.lastID;
        if (items.length === 0) {
          resolve({ requestId, request_no, total_qty, total_skus });
          return;
        }
        let pending = items.length;
        for (const item of items) {
          db.run(
            'INSERT INTO transfer_request_items (request_id, sku_id, requested_qty, remark) VALUES (?, ?, ?, ?)',
            [requestId, item.sku_id, item.requested_qty, item.remark || ''],
            function(err2) {
              if (err2) {
                reject(err2);
                return;
              }
              if (--pending === 0) {
                resolve({ requestId, request_no, total_qty, total_skus });
              }
            }
          );
        }
      }
    );
  });
}

module.exports = {
  TEST_DB_PATH,
  removeTestDb,
  initTestDb,
  seedTestData,
  runSql,
  getSql,
  allSql,
  createTransferRequest,
  generateRequestNo,
  generatePlanNo
};
