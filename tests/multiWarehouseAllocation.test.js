const {
  initTestDb,
  removeTestDb,
  seedTestData,
  getSql,
  allSql,
  runSql,
  createTransferRequest
} = require('./test-helper');

const constraintCheckService = require('../src/services/constraintCheckService');
const transferPlanService = require('../src/services/transferPlanService');

let db;
let ids;

function bindServicesToDb(database) {
  const customGet = (sql, params = []) => new Promise((res, rej) => {
    database.get(sql, params, (err, row) => err ? rej(err) : res(row));
  });
  const customAll = (sql, params = []) => new Promise((res, rej) => {
    database.all(sql, params, (err, rows) => err ? rej(err) : res(rows));
  });
  const customRun = (sql, params = []) => new Promise((res, rej) => {
    database.run(sql, params, function(err) {
      if (err) rej(err);
      else res({ lastID: this.lastID, changes: this.changes });
    });
  });
  constraintCheckService.setDbFunctions(customGet, customAll);
  transferPlanService.setDbFunctions(customGet, customAll, customRun, database);
}

beforeAll(async () => {
  db = await initTestDb();
  ids = await seedTestData(db);
  bindServicesToDb(db);
});

afterAll(async () => {
  constraintCheckService.resetDbFunctions();
  transferPlanService.resetDbFunctions();
  await new Promise(res => db.close(res));
  removeTestDb();
});

describe('多仓自动分配 - 优先级排序算法（核心业务规则）', () => {

  test('排序规则1: 中心仓(CENTER) 优先级高于 区域仓(REGIONAL)', async () => {
    const result = await constraintCheckService.findBestSourceWarehouses(
      ids.skuIds['SKU-001'],
      999999,
      ids.warehouseIds['WH-CD']
    );

    expect(result.sources.length).toBeGreaterThanOrEqual(2);
    const bjIdx = result.sources.findIndex(s => s.warehouse_code === 'WH-BJ');
    const shIdx = result.sources.findIndex(s => s.warehouse_code === 'WH-SH');
    const gzIdx = result.sources.findIndex(s => s.warehouse_code === 'WH-GZ');

    expect(bjIdx).toBe(0);
    expect(bjIdx).toBeLessThan(shIdx);
    expect(result.sources[0].warehouse_type).toBe('CENTER');
  });

  test('排序规则2: 同级别仓库按 可调配余量(available - min_stock) 从大到小排序', async () => {
    const result = await constraintCheckService.findBestSourceWarehouses(
      ids.skuIds['SKU-003'],
      999999,
      ids.warehouseIds['WH-CD']
    );

    expect(result.sources.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < result.sources.length; i++) {
      const prev = result.sources[i - 1];
      const curr = result.sources[i];
      if (prev.warehouse_type === curr.warehouse_type) {
        expect(prev.transferable_qty).toBeGreaterThanOrEqual(curr.transferable_qty);
      }
    }
  });

  test('排序规则3: 排除目标仓库自身（不从目标仓调货到目标仓）', async () => {
    const targetWhId = ids.warehouseIds['WH-SH'];
    const result = await constraintCheckService.findBestSourceWarehouses(
      ids.skuIds['SKU-002'],
      50,
      targetWhId
    );

    const containsSelf = result.sources.some(s => s.warehouse_id === targetWhId);
    expect(containsSelf).toBe(false);

    const targetWhCode = (await getSql(db, 'SELECT code FROM warehouses WHERE id = ?', [targetWhId])).code;
    result.sources.forEach(s => {
      expect(s.warehouse_code).not.toBe(targetWhCode);
    });
  });

  test('排序规则4: INACTIVE 状态的仓库不参与候选', async () => {
    const inactiveWhId = ids.warehouseIds['WH-CD'];
    const result = await constraintCheckService.findBestSourceWarehouses(
      ids.skuIds['SKU-001'],
      100,
      ids.warehouseIds['WH-WH']
    );

    const inactiveInSources = result.sources.some(s => s.warehouse_id === inactiveWhId);
    expect(inactiveInSources).toBe(false);
  });
});

describe('多仓自动分配 - 安全库存保护机制', () => {

  test('保护1: 源仓分配量 = min(需求剩余量, 可用量 - 安全库存)', async () => {
    const invBJ = await getSql(
      db, 'SELECT available_qty, min_stock FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [ids.warehouseIds['WH-BJ'], ids.skuIds['SKU-002']]
    );
    const expectedMaxFromBJ = invBJ.available_qty - invBJ.min_stock;

    const result = await constraintCheckService.findBestSourceWarehouses(
      ids.skuIds['SKU-002'],
      99999,
      ids.warehouseIds['WH-CD']
    );

    const bjSource = result.sources.find(s => s.warehouse_code === 'WH-BJ');
    expect(bjSource.allocated_qty).toBeLessThanOrEqual(expectedMaxFromBJ);
    expect(bjSource.after_qty).toBeGreaterThanOrEqual(invBJ.min_stock);
  });

  test('保护2: 单个源仓分配后剩余库存 刚好等于 安全库存（边界值）', async () => {
    const result = await constraintCheckService.findBestSourceWarehouses(
      ids.skuIds['SKU-005'],
      500,
      ids.warehouseIds['WH-WH']
    );

    result.sources.forEach(src => {
      expect(src.after_qty).toBeGreaterThanOrEqual(src.min_stock);
    });
  });

  test('保护3: 源仓可用 ≤ 安全库存 时不参与分配（transferable_qty ≤ 0 被跳过）', async () => {
    const invGZ = await getSql(
      db, 'SELECT * FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [ids.warehouseIds['WH-GZ'], ids.skuIds['SKU-001']]
    );
    expect(invGZ.available_qty).toBeLessThanOrEqual(invGZ.min_stock);

    const result = await constraintCheckService.findBestSourceWarehouses(
      ids.skuIds['SKU-001'],
      50,
      ids.warehouseIds['WH-CD']
    );

    const gzSource = result.sources.find(s => s.warehouse_code === 'WH-GZ');
    if (gzSource) {
      expect(gzSource.allocated_qty).toBe(0);
    }
  });

  test('保护4: 多仓自动分配严格遵守安全库存 - 分配后所有源仓 after_qty >= min_stock', async () => {
    const result = await constraintCheckService.checkTransferRequest({
      target_warehouse_id: ids.warehouseIds['WH-WH'],
      items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 500 }]
    });

    const itemResult = result.itemResults.find(r => r.sku_id === ids.skuIds['SKU-001']);
    expect(itemResult).toBeDefined();
    expect(itemResult.sources.length).toBeGreaterThanOrEqual(1);

    for (const src of itemResult.sources) {
      expect(src.after_qty).toBeGreaterThanOrEqual(src.min_stock);
    }

    const hasUnprotectedViolation = result.violations.some(v =>
      v.violation_type === 'SOURCE_AFTER_MIN' && v.severity === 'WARNING'
    );
    expect(hasUnprotectedViolation).toBe(false);
  });
});

describe('多仓自动分配 - 全网调配与短缺告警', () => {

  test('场景1: 需求 ≤ 单仓最大可调配 → 单仓满足', async () => {
    const result = await constraintCheckService.findBestSourceWarehouses(
      ids.skuIds['SKU-006'],
      100,
      ids.warehouseIds['WH-WH']
    );

    expect(result.shortage).toBe(0);
    expect(result.totalAllocated).toBe(100);
    expect(result.sources[0].allocated_qty).toBe(100);
    expect(result.sources.length).toBeGreaterThanOrEqual(1);
  });

  test('场景2: 需求 > 单仓但 ≤ 全网可调配 → 多仓合并满足', async () => {
    const result = await constraintCheckService.findBestSourceWarehouses(
      ids.skuIds['SKU-001'],
      420,
      ids.warehouseIds['WH-GZ']
    );

    expect(result.shortage).toBe(0);
    expect(result.totalAllocated).toBe(420);
    expect(result.sources.length).toBeGreaterThanOrEqual(2);
    expect(result.sources.reduce((s, src) => s + src.allocated_qty, 0)).toBe(420);
  });

  test('场景3: 需求 > 全网可调配总量 → 返回短缺数量并记录 SOURCE_INSUFFICIENT 告警', async () => {
    const hugeQty = 99999;
    const checkResult = await constraintCheckService.checkTransferRequest({
      target_warehouse_id: ids.warehouseIds['WH-GZ'],
      items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: hugeQty }]
    });

    const itemResult = checkResult.itemResults[0];
    expect(itemResult.shortage).toBeGreaterThan(0);

    const violation = checkResult.violations.find(v => v.violation_type === 'SOURCE_INSUFFICIENT');
    expect(violation).toBeDefined();
    expect(violation.severity).toBe('WARNING');
    expect(violation.current_value).toBe(itemResult.totalAllocated);
    expect(violation.required_value).toBe(hugeQty);
  });

  test('场景4: 目标仓有库存但不参与分配（仅作为接收方），短缺量计算不受目标仓影响', async () => {
    const targetId = ids.warehouseIds['WH-SH'];
    const targetInv = await getSql(
      db, 'SELECT available_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [targetId, ids.skuIds['SKU-001']]
    );

    const hugeDemand = targetInv.available_qty + 100000;
    const result = await constraintCheckService.findBestSourceWarehouses(
      ids.skuIds['SKU-001'],
      hugeDemand,
      targetId
    );

    expect(result.totalAllocated).toBeLessThan(hugeDemand);
    expect(result.shortage).toBe(hugeDemand - result.totalAllocated);
  });
});

describe('多仓自动分配 - 方案生成与落库完整性', () => {

  test('多仓分配的方案：每个源仓生成独立的 plan_item 记录', async () => {
    const reqInfo = await createTransferRequest(db, {
      target_warehouse_id: ids.warehouseIds['WH-WH'],
      status: 'SUBMITTED',
      items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 430 }]
    }, ids);

    const gen = await transferPlanService.generatePlan(reqInfo.requestId, '自动分配测试');
    expect(gen.plan_no).toBeDefined();

    const planItems = await allSql(
      db, `SELECT pi.*, w.code as wh_code FROM transfer_plan_items pi
           INNER JOIN warehouses w ON pi.source_warehouse_id = w.id
           WHERE pi.plan_id = ? ORDER BY pi.id`,
      [gen.planId]
    );

    expect(planItems.length).toBeGreaterThanOrEqual(2);
    const warehouseCodes = planItems.map(p => p.wh_code);
    expect(warehouseCodes).toContain('WH-BJ');

    const totalPlanned = planItems.reduce((s, p) => s + p.planned_qty, 0);
    expect(totalPlanned).toBe(gen.total_transfer_qty);
  });

  test('多仓方案确认：每个源仓的可用库存正确扣减，目标仓在途正确累加', async () => {
    const targetId = ids.warehouseIds['WH-WH'];
    const reqInfo = await createTransferRequest(db, {
      target_warehouse_id: targetId,
      status: 'SUBMITTED',
      items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 410 }]
    }, ids);

    const gen = await transferPlanService.generatePlan(reqInfo.requestId);
    const planItemsBefore = await allSql(
      db, 'SELECT * FROM transfer_plan_items WHERE plan_id = ?',
      [gen.planId]
    );

    expect(planItemsBefore.length).toBeGreaterThanOrEqual(2);

    const beforeBySource = {};
    for (const pi of planItemsBefore) {
      const inv = await getSql(
        db, 'SELECT available_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
        [pi.source_warehouse_id, pi.sku_id]
      );
      beforeBySource[pi.source_warehouse_id] = inv.available_qty;
    }

    const targetInvBefore = await getSql(
      db, 'SELECT in_transit_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [targetId, ids.skuIds['SKU-001']]
    );

    await transferPlanService.confirmPlan(gen.planId, '多仓确认测试', 'autotest');

    for (const pi of planItemsBefore) {
      const after = await getSql(
        db, 'SELECT available_qty, in_transit_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
        [pi.source_warehouse_id, pi.sku_id]
      );
      expect(after.available_qty).toBe(beforeBySource[pi.source_warehouse_id] - pi.planned_qty);
    }

    const targetInvAfter = await getSql(
      db, 'SELECT in_transit_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [targetId, ids.skuIds['SKU-001']]
    );

    const expectedInTransit = (targetInvBefore ? targetInvBefore.in_transit_qty : 0) +
      planItemsBefore.reduce((s, p) => s + p.planned_qty, 0);
    expect(targetInvAfter.in_transit_qty).toBe(expectedInTransit);

    const plan = await getSql(db, 'SELECT status, plan_type FROM transfer_plans WHERE id = ?', [gen.planId]);
    expect(plan.status).toBe('CONFIRMED');
    expect(plan.plan_type).toBe('MULTI_SOURCE');
  });
});
