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

describe('调拨方案状态机 - 主干路径 PENDING → CONFIRMED → COMPLETED', () => {

  let requestInfo;
  let planId;

  test('阶段1: 创建 SUBMITTED 状态的调拨申请', async () => {
    requestInfo = await createTransferRequest(db, {
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: ids.warehouseIds['WH-SH'],
      status: 'SUBMITTED',
      priority: 'HIGH',
      requester: '状态机测试',
      department: 'QA',
      reason: '测试方案完整生命周期',
      items: [
        { sku_id: ids.skuIds['SKU-001'], requested_qty: 100 },
        { sku_id: ids.skuIds['SKU-002'], requested_qty: 200 }
      ]
    }, ids);

    expect(requestInfo.requestId).toBeGreaterThan(0);
    const req = await getSql(db, 'SELECT status FROM transfer_requests WHERE id = ?', [requestInfo.requestId]);
    expect(req.status).toBe('SUBMITTED');
  });

  test('阶段2: 生成方案 → 方案状态 = PENDING，申请状态 = PLANNING', async () => {
    const result = await transferPlanService.generatePlan(requestInfo.requestId, '测试规划员');
    planId = result.planId;

    expect(result.plan_no).toBeDefined();
    expect(result.total_transfer_qty).toBe(300);

    const plan = await getSql(db, 'SELECT * FROM transfer_plans WHERE id = ?', [planId]);
    expect(plan.status).toBe('PENDING');
    expect(plan.plan_type).toBe('SINGLE_SOURCE');
    expect(plan.planner).toBe('测试规划员');
    expect(plan.constraint_check_passed).toBe(1);

    const req = await getSql(db, 'SELECT status FROM transfer_requests WHERE id = ?', [requestInfo.requestId]);
    expect(req.status).toBe('PLANNING');

    const items = await allSql(db, 'SELECT * FROM transfer_plan_items WHERE plan_id = ?', [planId]);
    expect(items.length).toBe(2);
    expect(items.reduce((s, i) => s + i.planned_qty, 0)).toBe(300);
  });

  test('阶段3: 确认方案 → 方案状态 = CONFIRMED，申请状态 = APPROVED，库存进入在途', async () => {
    const beforeInv = await getSql(
      db, 'SELECT available_qty, in_transit_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [ids.warehouseIds['WH-BJ'], ids.skuIds['SKU-001']]
    );
    const beforeTarget = await getSql(
      db, 'SELECT available_qty, in_transit_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [ids.warehouseIds['WH-SH'], ids.skuIds['SKU-001']]
    );

    const result = await transferPlanService.confirmPlan(planId, '库存充足，同意调拨', '测试审批员');
    expect(result.success).toBe(true);
    expect(result.status).toBe('CONFIRMED');

    const plan = await getSql(db, 'SELECT status, review_comment, confirmed_at FROM transfer_plans WHERE id = ?', [planId]);
    expect(plan.status).toBe('CONFIRMED');
    expect(plan.review_comment).toBe('库存充足，同意调拨');
    expect(plan.confirmed_at).not.toBeNull();

    const req = await getSql(db, 'SELECT status FROM transfer_requests WHERE id = ?', [requestInfo.requestId]);
    expect(req.status).toBe('APPROVED');

    const afterInv = await getSql(
      db, 'SELECT available_qty, in_transit_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [ids.warehouseIds['WH-BJ'], ids.skuIds['SKU-001']]
    );
    const afterTarget = await getSql(
      db, 'SELECT available_qty, in_transit_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [ids.warehouseIds['WH-SH'], ids.skuIds['SKU-001']]
    );

    expect(afterInv.available_qty).toBe(beforeInv.available_qty - 100);
    expect(afterInv.in_transit_qty).toBe(beforeInv.in_transit_qty + 100);
    expect(afterTarget.in_transit_qty).toBe(beforeTarget.in_transit_qty + 100);

    const records = await allSql(db, 'SELECT * FROM transfer_records WHERE plan_id = ?', [planId]);
    expect(records.length).toBe(2);
    expect(records[0].operator).toBe('测试审批员');
  });

  test('阶段4: 执行入库 → 方案状态 = COMPLETED，申请状态 = COMPLETED，在途清零', async () => {
    const beforeInv = await getSql(
      db, 'SELECT available_qty, in_transit_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [ids.warehouseIds['WH-SH'], ids.skuIds['SKU-001']]
    );

    const result = await transferPlanService.executePlan(planId, '测试仓管员');
    expect(result.success).toBe(true);
    expect(result.status).toBe('COMPLETED');

    const plan = await getSql(db, 'SELECT status FROM transfer_plans WHERE id = ?', [planId]);
    expect(plan.status).toBe('COMPLETED');

    const req = await getSql(db, 'SELECT status FROM transfer_requests WHERE id = ?', [requestInfo.requestId]);
    expect(req.status).toBe('COMPLETED');

    const afterTarget = await getSql(
      db, 'SELECT available_qty, in_transit_qty FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [ids.warehouseIds['WH-SH'], ids.skuIds['SKU-001']]
    );
    expect(afterTarget.available_qty).toBe(beforeInv.available_qty + 100);
    expect(afterTarget.in_transit_qty).toBe(beforeInv.in_transit_qty - 100);
    expect(afterTarget.in_transit_qty).toBeGreaterThanOrEqual(0);
  });
});

describe('调拨方案状态机 - REJECTED 分支路径', () => {

  let requestInfo;
  let planId;

  test('创建申请并生成 PENDING 方案', async () => {
    requestInfo = await createTransferRequest(db, {
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: ids.warehouseIds['WH-GZ'],
      status: 'SUBMITTED',
      items: [{ sku_id: ids.skuIds['SKU-003'], requested_qty: 50 }]
    }, ids);

    const gen = await transferPlanService.generatePlan(requestInfo.requestId);
    planId = gen.planId;

    const plan = await getSql(db, 'SELECT status FROM transfer_plans WHERE id = ?', [planId]);
    expect(plan.status).toBe('PENDING');
  });

  test('驳回方案 → 状态变为 REJECTED，记录审批意见和驳回时间', async () => {
    const result = await transferPlanService.rejectPlan(planId, '审批驳回：库存不足，等下月补货');
    expect(result.status).toBe('REJECTED');

    const plan = await getSql(db, 'SELECT status, review_comment, rejected_at FROM transfer_plans WHERE id = ?', [planId]);
    expect(plan.status).toBe('REJECTED');
    expect(plan.review_comment).toContain('审批驳回');
    expect(plan.rejected_at).not.toBeNull();
  });

  test('驳回后：最后一个待处理方案被驳回 → 申请状态自动变为 REJECTED', async () => {
    const req = await getSql(db, 'SELECT status FROM transfer_requests WHERE id = ?', [requestInfo.requestId]);
    expect(req.status).toBe('REJECTED');
  });
});

describe('调拨方案状态机 - 非法状态转换拦截', () => {

  test('CONFIRMED 状态的方案不能再次 confirm（防重复提交）', async () => {
    const reqInfo = await createTransferRequest(db, {
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: ids.warehouseIds['WH-SH'],
      status: 'SUBMITTED',
      items: [{ sku_id: ids.skuIds['SKU-005'], requested_qty: 50 }]
    }, ids);

    const gen = await transferPlanService.generatePlan(reqInfo.requestId);
    await transferPlanService.confirmPlan(gen.planId);

    await expect(transferPlanService.confirmPlan(gen.planId)).rejects.toMatchObject({
      code: 'STATUS_NOT_ALLOWED'
    });
  });

  test('COMPLETED 状态的方案不能被驳回（逆向状态流转阻止）', async () => {
    const reqInfo = await createTransferRequest(db, {
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: ids.warehouseIds['WH-SH'],
      status: 'SUBMITTED',
      items: [{ sku_id: ids.skuIds['SKU-006'], requested_qty: 50 }]
    }, ids);

    const gen = await transferPlanService.generatePlan(reqInfo.requestId);
    await transferPlanService.confirmPlan(gen.planId);
    await transferPlanService.executePlan(gen.planId);

    await expect(transferPlanService.rejectPlan(gen.planId)).rejects.toMatchObject({
      code: 'STATUS_NOT_ALLOWED'
    });
  });

  test('从非 PENDING/CONFIRMED 状态的方案不能直接执行 execute（需先确认）', async () => {
    const reqInfo = await createTransferRequest(db, {
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: ids.warehouseIds['WH-SH'],
      status: 'SUBMITTED',
      items: [{ sku_id: ids.skuIds['SKU-007'], requested_qty: 50 }]
    }, ids);

    const gen = await transferPlanService.generatePlan(reqInfo.requestId);

    await expect(transferPlanService.executePlan(gen.planId)).rejects.toMatchObject({
      code: 'STATUS_NOT_ALLOWED'
    });
  });
});

describe('调拨方案状态机 - CANCELLED / 删除分支', () => {

  test('PENDING 方案删除 → 若为申请最后一个待处理方案，申请回退为 SUBMITTED', async () => {
    const reqInfo = await createTransferRequest(db, {
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: ids.warehouseIds['WH-WH'],
      status: 'SUBMITTED',
      items: [{ sku_id: ids.skuIds['SKU-007'], requested_qty: 30 }]
    }, ids);

    const gen = await transferPlanService.generatePlan(reqInfo.requestId);

    let req = await getSql(db, 'SELECT status FROM transfer_requests WHERE id = ?', [reqInfo.requestId]);
    expect(req.status).toBe('PLANNING');

    const cancelResult = await transferPlanService.cancelPlan(gen.planId);
    expect(cancelResult.status).toBe('CANCELLED');

    req = await getSql(db, 'SELECT status FROM transfer_requests WHERE id = ?', [reqInfo.requestId]);
    expect(req.status).toBe('SUBMITTED');
  });
});

describe('方案约束违规记录落库验证', () => {

  test('生成带 WARNING 级约束的方案 → 违规记录已写入 constraint_violations 表', async () => {
    const reqInfo = await createTransferRequest(db, {
      source_warehouse_id: ids.warehouseIds['WH-GZ'],
      target_warehouse_id: ids.warehouseIds['WH-WH'],
      status: 'SUBMITTED',
      items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 100 }]
    }, ids);

    const gen = await transferPlanService.generatePlan(reqInfo.requestId);

    const violations = await allSql(
      db, 'SELECT * FROM constraint_violations WHERE plan_id = ?',
      [gen.planId]
    );
    expect(violations.length).toBeGreaterThan(0);
    const srcViolation = violations.find(v => v.violation_type === 'SOURCE_INSUFFICIENT');
    expect(srcViolation).toBeDefined();
    expect(srcViolation.severity).toBe('WARNING');
    expect(srcViolation.sku_id).toBe(ids.skuIds['SKU-001']);
  });
});
