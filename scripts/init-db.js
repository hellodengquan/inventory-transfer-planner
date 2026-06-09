const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const DB_PATH = path.join(dataDir, 'inventory.db');

if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  console.log('已删除旧数据库文件');
}

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      location TEXT,
      type TEXT DEFAULT 'NORMAL',
      status TEXT DEFAULT 'ACTIVE',
      min_security_stock REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✓ 创建仓库表 warehouses');

  db.run(`
    CREATE TABLE skus (
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
    )
  `);
  console.log('✓ 创建SKU表 skus');

  db.run(`
    CREATE TABLE inventory (
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
    )
  `);
  console.log('✓ 创建库存表 inventory');

  db.run(`
    CREATE TABLE transfer_requests (
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
    )
  `);
  console.log('✓ 创建调拨申请表 transfer_requests');

  db.run(`
    CREATE TABLE transfer_request_items (
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
    )
  `);
  console.log('✓ 创建调拨申请明细表 transfer_request_items');

  db.run(`
    CREATE TABLE transfer_plans (
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
    )
  `);
  console.log('✓ 创建调拨方案表 transfer_plans');

  db.run(`
    CREATE TABLE transfer_plan_items (
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
    )
  `);
  console.log('✓ 创建调拨方案明细表 transfer_plan_items');

  db.run(`
    CREATE TABLE constraint_violations (
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
    )
  `);
  console.log('✓ 创建约束违规记录表 constraint_violations');

  db.run(`
    CREATE TABLE transfer_records (
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
    )
  `);
  console.log('✓ 创建调拨记录表 transfer_records');

  console.log('\n数据库初始化完成！');
});

db.close();
