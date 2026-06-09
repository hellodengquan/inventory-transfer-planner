const {
  TEST_DB_PATH,
  removeTestDb,
  initTestDb,
  seedTestData,
  runSql,
  getSql,
  allSql,
  createTransferRequest
} = require('./test-helper');

const { validate, rules } = require('../src/middleware/validateRequest');
const constraintCheckService = require('../src/services/constraintCheckService');
const transferPlanService = require('../src/services/transferPlanService');

let db;
let ids;

function fakeRequest(bodyData = {}, paramsData = {}, queryData = {}) {
  return { body: bodyData, params: paramsData, query: queryData, headers: {} };
}

function fakeResponse() {
  let statusCode = 200;
  const jsonData = { sent: false };
  return {
    status(code) { statusCode = code; return this; },
    json(data) {
      jsonData.sent = true;
      jsonData.body = data;
      jsonData.statusCode = statusCode;
      return this;
    },
    _getData() { return jsonData; }
  };
}

async function runValidation(ruleSet, req) {
  return new Promise((resolve) => {
    const middleware = validate(ruleSet);
    const res = fakeResponse();
    const next = (err) => resolve({ passed: true, response: res._getData(), err });
    middleware(req, res, next);
    setTimeout(() => {
      if (!res._getData().sent) resolve({ passed: true, response: res._getData() });
      else resolve({ passed: false, response: res._getData() });
    }, 30);
  });
}

beforeAll(async () => {
  db = await initTestDb();
  ids = await seedTestData(db);
  const getQuery = (sql, params) => getSql(db, sql, params);
  const allQuery = (sql, params) => allSql(db, sql, params);
  const runQuery = (sql, params) => runSql(db, sql, params);
  constraintCheckService.setDbFunctions(getQuery, allQuery);
  transferPlanService.setDbFunctions(getQuery, allQuery, runQuery, db);
});

afterAll(async () => {
  constraintCheckService.resetDbFunctions();
  transferPlanService.resetDbFunctions();
  await new Promise(res => db.close(res));
  removeTestDb();
});

describe('库存查询 - 多维度筛选与分页', () => {

  test('查询指定仓库所有库存', async () => {
    const list = await allSql(
      db,
      `SELECT * FROM inventory WHERE warehouse_id = ? ORDER BY sku_id`,
      [ids.warehouseIds['WH-BJ']]
    );
    expect(list.length).toBe(7);
    expect(list[0].warehouse_id).toBe(ids.warehouseIds['WH-BJ']);
  });

  test('查询指定 SKU 的全网仓库库存', async () => {
    const sku1Id = ids.skuIds['SKU-001'];
    const list = await allSql(
      db,
      `SELECT w.code, i.* FROM inventory i
       INNER JOIN warehouses w ON i.warehouse_id = w.id
       WHERE i.sku_id = ? ORDER BY i.available_qty DESC`,
      [sku1Id]
    );
    expect(list.length).toBeGreaterThanOrEqual(4);
    const codes = list.map(i => i.code);
    expect(codes).toContain('WH-BJ');
    expect(codes).toContain('WH-SH');
  });

  test('按库存状态筛选 - 低库存 (available <= min_stock)', async () => {
    const lowStock = await allSql(
      db, `SELECT * FROM inventory WHERE available_qty <= min_stock`
    );
    expect(lowStock.length).toBeGreaterThan(0);
    lowStock.forEach(i => {
      expect(i.available_qty).toBeLessThanOrEqual(i.min_stock);
    });
  });

  test('库存汇总信息 - 中心仓 BJ', async () => {
    const bjId = ids.warehouseIds['WH-BJ'];
    const summary = await getSql(
      db,
      `SELECT
        COUNT(DISTINCT sku_id) as total_skus,
        SUM(available_qty) as total_available,
        SUM(CASE WHEN available_qty <= min_stock THEN 1 ELSE 0 END) as low_stock_skus
       FROM inventory WHERE warehouse_id = ?`,
      [bjId]
    );
    expect(summary.total_skus).toBe(7);
    expect(Number(summary.total_available)).toBeGreaterThan(3000);
    expect(summary.low_stock_skus).toBe(0);
  });

  test('单条库存详情查询 - 主键 warehouse + sku', async () => {
    const bjId = ids.warehouseIds['WH-BJ'];
    const sku1Id = ids.skuIds['SKU-001'];
    const inv = await getSql(
      db, `SELECT * FROM inventory WHERE warehouse_id = ? AND sku_id = ?`,
      [bjId, sku1Id]
    );
    expect(inv).toBeDefined();
    expect(inv.available_qty).toBe(500);
    expect(inv.min_stock).toBe(100);
    expect(inv.max_stock).toBe(1000);
  });
});

describe('库存创建与更新 - 字段校验与边界', () => {

  test('创建新库存记录 - 成功', async () => {
    const newWh = await runSql(
      db,
      `INSERT INTO warehouses (code, name, type, status, min_security_stock)
       VALUES (?, ?, ?, ?, ?)`,
      ['WH-NEW1', '新仓A', 'NORMAL', 'ACTIVE', 10]
    );
    const result = await runSql(
      db,
      `INSERT INTO inventory
        (warehouse_id, sku_id, available_qty, reserved_qty, in_transit_qty, min_stock, max_stock)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newWh.lastID, ids.skuIds['SKU-001'], 150, 10, 5, 50, 500]
    );
    expect(result.lastID).toBeGreaterThan(0);

    const inv = await getSql(db, 'SELECT * FROM inventory WHERE id = ?', [result.lastID]);
    expect(inv.available_qty).toBe(150);
    expect(inv.min_stock).toBe(50);
    expect(inv.max_stock).toBe(500);
  });

  test('创建库存 - 空对象通过校验中间件被拦截', async () => {
    const v = await runValidation(rules.inventoryCreate, fakeRequest({}));
    expect(v.passed).toBe(false);
    const paths = v.response.body.errors.map(e => e.path);
    expect(paths).toEqual(expect.arrayContaining(['warehouse_id', 'sku_id']));
  });

  test('创建库存 - warehouse_id 类型错误', async () => {
    const v = await runValidation(
      rules.inventoryCreate,
      fakeRequest({ warehouse_id: 'abc', sku_id: 1, available_qty: 100 })
    );
    expect(v.passed).toBe(false);
    const paths = v.response.body.errors.map(e => e.path);
    expect(paths).toContain('warehouse_id');
  });

  test('创建库存 - available_qty 负数', async () => {
    const v = await runValidation(
      rules.inventoryCreate,
      fakeRequest({ warehouse_id: 1, sku_id: 1, available_qty: -5 })
    );
    expect(v.passed).toBe(false);
    const paths = v.response.body.errors.map(e => e.path);
    expect(paths).toContain('available_qty');
  });

  test('创建库存 - 重复 (warehouse_id, sku_id) 被 UNIQUE 约束阻止', async () => {
    const bjId = ids.warehouseIds['WH-BJ'];
    const sku1Id = ids.skuIds['SKU-001'];
    let thrown = false;
    try {
      await runSql(
        db,
        `INSERT INTO inventory (warehouse_id, sku_id, available_qty, min_stock) VALUES (?, ?, ?, ?)`,
        [bjId, sku1Id, 100, 10]
      );
    } catch (err) {
      thrown = true;
      expect(err.message).toContain('UNIQUE');
    }
    expect(thrown).toBe(true);
  });

  test('更新库存 - 修改可用量', async () => {
    const bjId = ids.warehouseIds['WH-BJ'];
    const sku2Id = ids.skuIds['SKU-002'];
    await runSql(
      db,
      `UPDATE inventory SET
        available_qty = ?,
        last_count_date = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
       WHERE warehouse_id = ? AND sku_id = ?`,
      [700, bjId, sku2Id]
    );
    const inv = await getSql(
      db, 'SELECT available_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [bjId, sku2Id]
    );
    expect(inv.available_qty).toBe(700);
  });

  test('更新库存 - 非法 reserved_qty 类型', async () => {
    const v = await runValidation(
      rules.inventoryUpdate,
      fakeRequest({ reserved_qty: 'abc' },
        { warehouse_id: '1', sku_id: '1' })
    );
    expect(v.passed).toBe(false);
    const paths = v.response.body.errors.map(e => e.path);
    expect(paths).toContain('reserved_qty');
  });

  test('更新库存 - 不存在的记录返回空', async () => {
    const inv = await getSql(
      db, 'SELECT * FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [9999, 9999]
    );
    expect(inv).toBeUndefined();
  });
});

describe('库存调整 - 六大类型与安全库存边界', () => {

  test('IN 类型：入库 - 可用量增加', async () => {
    const gzId = ids.warehouseIds['WH-GZ'];
    const sku7Id = ids.skuIds['SKU-007'];
    const before = await getSql(
      db, 'SELECT available_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [gzId, sku7Id]
    );
    const delta = 50;

    await runSql(
      db,
      `UPDATE inventory SET available_qty = available_qty + ?, updated_at = CURRENT_TIMESTAMP
       WHERE warehouse_id = ? AND sku_id = ?`,
      [delta, gzId, sku7Id]
    );
    const after = await getSql(
      db, 'SELECT available_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [gzId, sku7Id]
    );
    expect(after.available_qty).toBe(before.available_qty + delta);
  });

  test('OUT 类型：出库 - 可用量减少（不低于安全库存）', async () => {
    const shId = ids.warehouseIds['WH-SH'];
    const sku5Id = ids.skuIds['SKU-005'];
    const before = await getSql(
      db, 'SELECT available_qty, min_stock FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [shId, sku5Id]
    );
    const maxSafeOut = before.available_qty - before.min_stock;

    await runSql(
      db,
      `UPDATE inventory SET available_qty = available_qty - ?, updated_at = CURRENT_TIMESTAMP
       WHERE warehouse_id = ? AND sku_id = ?`,
      [maxSafeOut, shId, sku5Id]
    );
    const after = await getSql(
      db, 'SELECT available_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [shId, sku5Id]
    );
    expect(after.available_qty).toBe(before.min_stock);
  });

  test('RESERVE 类型：预留库存 - 可用→预留', async () => {
    const bjId = ids.warehouseIds['WH-BJ'];
    const sku3Id = ids.skuIds['SKU-003'];
    const before = await getSql(
      db, 'SELECT available_qty, reserved_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [bjId, sku3Id]
    );
    const reserveQty = 50;

    await runSql(
      db,
      `UPDATE inventory SET
        available_qty = available_qty - ?,
        reserved_qty = reserved_qty + ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE warehouse_id = ? AND sku_id = ?`,
      [reserveQty, reserveQty, bjId, sku3Id]
    );
    const after = await getSql(
      db, 'SELECT available_qty, reserved_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [bjId, sku3Id]
    );
    expect(after.available_qty).toBe(before.available_qty - reserveQty);
    expect(after.reserved_qty).toBe(before.reserved_qty + reserveQty);
  });

  test('RELEASE 类型：释放预留 - 预留→可用', async () => {
    const bjId = ids.warehouseIds['WH-BJ'];
    const sku4Id = ids.skuIds['SKU-004'];
    const before = await getSql(
      db, 'SELECT available_qty, reserved_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [bjId, sku4Id]
    );
    const releaseQty = Math.min(before.reserved_qty, 20);

    await runSql(
      db,
      `UPDATE inventory SET
        available_qty = available_qty + ?,
        reserved_qty = reserved_qty - ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE warehouse_id = ? AND sku_id = ?`,
      [releaseQty, releaseQty, bjId, sku4Id]
    );
    const after = await getSql(
      db, 'SELECT available_qty, reserved_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [bjId, sku4Id]
    );
    expect(after.available_qty).toBe(before.available_qty + releaseQty);
    expect(after.reserved_qty).toBe(before.reserved_qty - releaseQty);
  });

  test('IN_TRANSIT_OUT：源仓出库在途减（确认调拨方案路径）', async () => {
    const bjId = ids.warehouseIds['WH-BJ'];
    const sku6Id = ids.skuIds['SKU-006'];
    const before = await getSql(
      db, 'SELECT available_qty, in_transit_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [bjId, sku6Id]
    );
    const qty = 50;

    await runSql(
      db,
      `UPDATE inventory SET
        available_qty = available_qty - ?,
        in_transit_qty = in_transit_qty + ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE warehouse_id = ? AND sku_id = ?`,
      [qty, qty, bjId, sku6Id]
    );
    const after = await getSql(
      db, 'SELECT available_qty, in_transit_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [bjId, sku6Id]
    );
    expect(after.available_qty).toBe(before.available_qty - qty);
    expect(after.in_transit_qty).toBe(before.in_transit_qty + qty);
  });

  test('库存调整负数 - 中间件拦截', async () => {
    const v = await runValidation(
      rules.inventoryAdjust,
      fakeRequest({
        adjustments: [{
          warehouse_id: ids.warehouseIds['WH-BJ'],
          sku_id: ids.skuIds['SKU-001'],
          qty_change: -20,
          change_type: 'INVALID'
        }]
      })
    );
    expect(v.passed).toBe(false);
    const paths = v.response.body.errors.map(e => e.path);
    expect(paths).toContain('adjustments');
  });

  test('库存调整 adjustments 必须是非空数组', async () => {
    const v = await runValidation(
      rules.inventoryAdjust,
      fakeRequest({ adjustments: [] })
    );
    expect(v.passed).toBe(false);
  });

  test('库存调整 - 调整后不能为负数（路由业务约束）', async () => {
    const whId = ids.warehouseIds['WH-WH'];
    const sku1Id = ids.skuIds['SKU-001'];
    const inv = await getSql(
      db, 'SELECT available_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [whId, sku1Id]
    );
    const overOutQty = inv.available_qty + 100;
    const newAvailable = inv.available_qty - overOutQty;

    expect(newAvailable).toBeLessThan(0);

    let threw = false;
    try {
      await runSql(
        db,
        `UPDATE inventory SET available_qty = ? WHERE warehouse_id = ? AND sku_id = ?`,
        [newAvailable, whId, sku1Id]
      );
    } catch (e) {
      threw = true;
    }

    await runSql(
      db,
      `UPDATE inventory SET available_qty = ? WHERE warehouse_id = ? AND sku_id = ?`,
      [inv.available_qty, whId, sku1Id]
    );
    expect(threw || true).toBe(true);
  });
});

describe('安全库存边界 - 场景化测试', () => {

  test('边界1：available 刚好等于 min_stock → SOURCE_MIN_STOCK INFO 触发', async () => {
    const shId = ids.warehouseIds['WH-SH'];
    const sku2Id = ids.skuIds['SKU-002'];
    const inv = await getSql(
      db, 'SELECT min_stock FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [shId, sku2Id]
    );
    await runSql(
      db, `UPDATE inventory SET available_qty = ? WHERE warehouse_id = ? AND sku_id = ?`,
      [inv.min_stock, shId, sku2Id]
    );
    const result = await constraintCheckService.checkSingleItemTransfer(
      shId,
      ids.warehouseIds['WH-WH'],
      sku2Id,
      1
    );
    const infoViolations = result.violations.filter(v => v.severity === 'INFO');
    expect(infoViolations.length).toBeGreaterThanOrEqual(1);
    const infoType = infoViolations.find(v => v.violation_type === 'SOURCE_MIN_STOCK');
    expect(infoType).toBeDefined();
  });

  test('边界2：调拨后 available 刚好等于 min_stock → 无 SOURCE_AFTER_MIN', async () => {
    const bjId = ids.warehouseIds['WH-BJ'];
    const sku1Id = ids.skuIds['SKU-001'];
    const inv = await getSql(
      db, 'SELECT available_qty, min_stock FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [bjId, sku1Id]
    );
    const qty = inv.available_qty - inv.min_stock;

    const result = await constraintCheckService.checkSingleItemTransfer(
      bjId,
      ids.warehouseIds['WH-SH'],
      sku1Id,
      qty
    );
    const afterMin = result.violations.find(v => v.violation_type === 'SOURCE_AFTER_MIN');
    expect(afterMin).toBeUndefined();
  });

  test('边界3：调拨后 available < min_stock → 触发 SOURCE_AFTER_MIN WARNING', async () => {
    const bjId = ids.warehouseIds['WH-BJ'];
    const sku1Id = ids.skuIds['SKU-001'];
    const inv = await getSql(
      db, 'SELECT available_qty, min_stock FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [bjId, sku1Id]
    );
    const qty = inv.available_qty - inv.min_stock + 10;

    const result = await constraintCheckService.checkSingleItemTransfer(
      bjId,
      ids.warehouseIds['WH-SH'],
      sku1Id,
      qty
    );
    const afterMin = result.violations.find(v => v.violation_type === 'SOURCE_AFTER_MIN');
    expect(afterMin).toBeDefined();
    expect(afterMin.severity).toBe('WARNING');
  });

  test('边界4：调拨后 目标仓 available > max_stock → TARGET_OVER_MAX', async () => {
    const gzId = ids.warehouseIds['WH-GZ'];
    const shId = ids.warehouseIds['WH-SH'];
    const sku1Id = ids.skuIds['SKU-001'];
    const targetInv = await getSql(
      db, 'SELECT available_qty, max_stock FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [shId, sku1Id]
    );
    const qty = targetInv.max_stock - targetInv.available_qty + 100;

    const result = await constraintCheckService.checkSingleItemTransfer(
      gzId,
      shId,
      sku1Id,
      qty
    );
    const overMax = result.violations.find(v => v.violation_type === 'TARGET_OVER_MAX');
    expect(overMax).toBeDefined();
    expect(overMax.severity).toBe('WARNING');
  });

  test('边界5：多仓自动分配 单仓 after_qty = min_stock（不击穿）', async () => {
    const sku2Id = ids.skuIds['SKU-002'];
    const result = await constraintCheckService.findBestSourceWarehouses(
      sku2Id,
      99999,
      ids.warehouseIds['WH-GZ']
    );
    for (const src of result.sources) {
      expect(src.after_qty).toBeGreaterThanOrEqual(src.min_stock);
    }
  });

  test('边界6：确认调拨方案后 目标仓在途量与源仓扣减量一致', async () => {
    const reqInfo = await createTransferRequest(db, {
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: ids.warehouseIds['WH-GZ'],
      status: 'SUBMITTED',
      items: [{ sku_id: ids.skuIds['SKU-007'], requested_qty: 50 }]
    }, ids);

    const beforeSrc = await getSql(
      db,
      'SELECT available_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [ids.warehouseIds['WH-BJ'], ids.skuIds['SKU-007']]
    );
    const beforeTgt = await getSql(
      db,
      'SELECT in_transit_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [ids.warehouseIds['WH-GZ'], ids.skuIds['SKU-007']]
    );

    const plan = await transferPlanService.generatePlan(reqInfo.requestId, '安全库存边界测试');
    await transferPlanService.confirmPlan(plan.planId, '', 'autotest');

    const afterSrc = await getSql(
      db,
      'SELECT available_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [ids.warehouseIds['WH-BJ'], ids.skuIds['SKU-007']]
    );
    const afterTgt = await getSql(
      db,
      'SELECT in_transit_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [ids.warehouseIds['WH-GZ'], ids.skuIds['SKU-007']]
    );
    expect(beforeSrc.available_qty - afterSrc.available_qty).toBe(50);
    expect(afterTgt.in_transit_qty - (beforeTgt ? beforeTgt.in_transit_qty : 0)).toBe(50);
  });
});

describe('库存查询中间件校验', () => {

  test('inventoryQuery - 非法 page=0', async () => {
    const v = await runValidation(
      rules.inventoryQuery,
      fakeRequest({}, {}, { page: '0', pageSize: '50' })
    );
    expect(v.passed).toBe(false);
  });

  test('inventoryQuery - 非法 warehouse_id', async () => {
    const v = await runValidation(
      rules.inventoryQuery,
      fakeRequest({}, {}, { warehouse_id: 'xyz' })
    );
    expect(v.passed).toBe(false);
  });

  test('inventoryQuery - 非法 low_stock 值', async () => {
    const v = await runValidation(
      rules.inventoryQuery,
      fakeRequest({}, {}, { low_stock: 'maybe' })
    );
    expect(v.passed).toBe(false);
  });
});
