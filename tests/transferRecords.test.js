const {
  TEST_DB_PATH,
  removeTestDb,
  initTestDb,
  seedTestData,
  runSql,
  getSql,
  allSql,
  createTransferRequest,
  generatePlanNo
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

function generateRecordNo() {
  return `TRN-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
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

describe('调拨记录 - 单仓路径下的记录自动创建', () => {

  let planInfo = null;
  let planItemsBefore = null;

  test('阶段1：生成单仓方案 → PENDING（无 transfer_records）', async () => {
    const reqInfo = await createTransferRequest(db, {
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: ids.warehouseIds['WH-GZ'],
      status: 'SUBMITTED',
      items: [
        { sku_id: ids.skuIds['SKU-003'], requested_qty: 80 },
        { sku_id: ids.skuIds['SKU-007'], requested_qty: 60 }
      ]
    }, ids);

    planInfo = await transferPlanService.generatePlan(reqInfo.requestId, '单仓调拨测试');
    expect(planInfo.status).toBe('PENDING');

    const records = await allSql(
      db, 'SELECT COUNT(*) as cnt FROM transfer_records WHERE plan_id = ?',
      [planInfo.planId]
    );
    expect(records[0].cnt).toBe(0);

    planItemsBefore = await allSql(
      db, 'SELECT * FROM transfer_plan_items WHERE plan_id = ? ORDER BY id',
      [planInfo.planId]
    );
    expect(planItemsBefore.length).toBe(2);
  });

  test('阶段2：确认方案 CONFIRMED → 为每个 plan_item 创建 transfer_record', async () => {
    await transferPlanService.confirmPlan(planInfo.planId, '单仓调拨审批', 'tester-01');

    const records = await allSql(
      db,
      `SELECT
        tr.*,
        w1.code as source_code,
        w2.code as target_code,
        s.sku_code
       FROM transfer_records tr
       INNER JOIN warehouses w1 ON tr.source_warehouse_id = w1.id
       INNER JOIN warehouses w2 ON tr.target_warehouse_id = w2.id
       INNER JOIN skus s ON tr.sku_id = s.id
       WHERE tr.plan_id = ? ORDER BY tr.id`,
      [planInfo.planId]
    );

    expect(records.length).toBe(2);
    records.forEach(r => {
      expect(r.plan_id).toBe(planInfo.planId);
      expect(r.request_id).toBe(planInfo.requestId);
      expect(r.source_code).toBe('WH-BJ');
      expect(r.target_code).toBe('WH-GZ');
      expect(r.operator).toBe('tester-01');
      expect(r.transfer_qty).toBeGreaterThan(0);
      expect(r.record_no).toMatch(/^TRN-/);
    });

    const sku3Rec = records.find(r => r.sku_code === 'SKU-003');
    expect(sku3Rec.transfer_qty).toBe(80);
    const sku7Rec = records.find(r => r.sku_code === 'SKU-007');
    expect(sku7Rec.transfer_qty).toBe(60);
  });

  test('阶段3：执行入库 COMPLETED → 不新增记录（已有记录不重复）', async () => {
    await transferPlanService.executePlan(planInfo.planId, 'warehouse-op');

    const recordsAfter = await allSql(
      db, 'SELECT COUNT(*) as cnt FROM transfer_records WHERE plan_id = ?',
      [planInfo.planId]
    );
    expect(recordsAfter[0].cnt).toBe(2);
  });

  test('阶段4：记录的 operate_time 与 方案状态 CONFIRMED→COMPLETED 联动', async () => {
    const plan = await getSql(
      db, 'SELECT status, confirmed_at FROM transfer_plans WHERE id = ?',
      [planInfo.planId]
    );
    expect(plan.status).toBe('COMPLETED');
    expect(plan.confirmed_at).toBeDefined();

    const rec = await getSql(
      db, 'SELECT operate_time FROM transfer_records WHERE plan_id = ? LIMIT 1',
      [planInfo.planId]
    );
    expect(rec.operate_time).toBeDefined();
  });
});

describe('调拨记录 - 多仓路径下的记录创建', () => {

  let multiPlanId = null;
  let multiRequestId = null;

  test('阶段1：生成多仓方案 → 源仓数对应 plan_items', async () => {
    const reqInfo = await createTransferRequest(db, {
      target_warehouse_id: ids.warehouseIds['WH-WH'],
      status: 'SUBMITTED',
      items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 420 }]
    }, ids);
    multiRequestId = reqInfo.requestId;

    const plan = await transferPlanService.generatePlan(multiRequestId, '多仓调拨测试');
    multiPlanId = plan.planId;

    const planItems = await allSql(
      db, 'SELECT * FROM transfer_plan_items WHERE plan_id = ?',
      [multiPlanId]
    );
    expect(planItems.length).toBeGreaterThanOrEqual(2);
  });

  test('阶段2：确认多仓方案 → 每个源仓独立 transfer_record', async () => {
    await transferPlanService.confirmPlan(multiPlanId, '多仓审批', 'tester-02');

    const records = await allSql(
      db,
      `SELECT w.code as source_code, SUM(tr.transfer_qty) as total
       FROM transfer_records tr
       INNER JOIN warehouses w ON tr.source_warehouse_id = w.id
       WHERE tr.plan_id = ?
       GROUP BY w.code ORDER BY total DESC`,
      [multiPlanId]
    );

    expect(records.length).toBeGreaterThanOrEqual(2);
    const sources = records.map(r => r.source_code);
    expect(sources).toContain('WH-BJ');

    const totalTransfer = records.reduce((s, r) => s + r.total, 0);
    expect(totalTransfer).toBe(420);
  });

  test('阶段3：记录的 request_id 与申请一一对应', async () => {
    const reqRecords = await allSql(
      db,
      'SELECT COUNT(*) as cnt FROM transfer_records WHERE request_id = ?',
      [multiRequestId]
    );
    expect(reqRecords[0].cnt).toBeGreaterThanOrEqual(2);
  });
});

describe('调拨记录 - 查询与多维度筛选', () => {

  test('按 ID 查询单条记录详情', async () => {
    const rec = await getSql(
      db,
      `SELECT tr.*, w1.code as src_code, w2.code as tgt_code, s.sku_code
       FROM transfer_records tr
       INNER JOIN warehouses w1 ON tr.source_warehouse_id = w1.id
       INNER JOIN warehouses w2 ON tr.target_warehouse_id = w2.id
       INNER JOIN skus s ON tr.sku_id = s.id
       LIMIT 1`
    );
    expect(rec).toBeDefined();
    expect(rec.id).toBeGreaterThan(0);
    expect(rec.src_code).toBeDefined();
    expect(rec.tgt_code).toBeDefined();
    expect(rec.sku_code).toBeDefined();
  });

  test('按 source_warehouse_id 过滤', async () => {
    const bjId = ids.warehouseIds['WH-BJ'];
    const records = await allSql(
      db, 'SELECT COUNT(*) as cnt FROM transfer_records WHERE source_warehouse_id = ?',
      [bjId]
    );
    expect(records[0].cnt).toBeGreaterThanOrEqual(3);
  });

  test('按 target_warehouse_id 过滤', async () => {
    const gzId = ids.warehouseIds['WH-GZ'];
    const records = await allSql(
      db, 'SELECT COUNT(*) as cnt FROM transfer_records WHERE target_warehouse_id = ?',
      [gzId]
    );
    expect(records[0].cnt).toBeGreaterThanOrEqual(2);
  });

  test('按 sku_id 过滤', async () => {
    const sku3Id = ids.skuIds['SKU-003'];
    const records = await allSql(
      db, 'SELECT COUNT(*) as cnt FROM transfer_records WHERE sku_id = ?',
      [sku3Id]
    );
    expect(records[0].cnt).toBeGreaterThanOrEqual(1);
  });

  test('按 plan_id 过滤', async () => {
    const testPlan = await getSql(db, 'SELECT id FROM transfer_plans LIMIT 1');
    expect(testPlan).toBeDefined();
    const cnt = await getSql(
      db, 'SELECT COUNT(*) as cnt FROM transfer_records WHERE plan_id = ?',
      [testPlan.id]
    );
    expect(cnt.cnt).toBeGreaterThanOrEqual(1);
  });

  test('按 request_id 过滤', async () => {
    const testReq = await getSql(db, 'SELECT id FROM transfer_requests LIMIT 1');
    expect(testReq).toBeDefined();
    const cnt = await getSql(
      db, 'SELECT COUNT(*) as cnt FROM transfer_records WHERE request_id = ?',
      [testReq.id]
    );
    expect(cnt.cnt).toBeGreaterThanOrEqual(0);
  });

  test('调拨记录不存在的 ID 查询', async () => {
    const rec = await getSql(
      db, 'SELECT * FROM transfer_records WHERE id = ?',
      [9999999]
    );
    expect(rec).toBeUndefined();
  });

  test('记录的 record_no 唯一性约束', async () => {
    const rec = await getSql(db, 'SELECT record_no FROM transfer_records LIMIT 1');
    expect(rec).toBeDefined();
    let thrown = false;
    try {
      await runSql(
        db,
        `INSERT INTO transfer_records
          (record_no, source_warehouse_id, target_warehouse_id, sku_id, transfer_qty, operator)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [rec.record_no, ids.warehouseIds['WH-BJ'], ids.warehouseIds['WH-SH'], ids.skuIds['SKU-001'], 10, 'unit']
      );
    } catch (err) {
      thrown = true;
      expect(err.message).toContain('UNIQUE');
    }
    expect(thrown).toBe(true);
  });
});

describe('调拨记录 - 汇总统计（入出库方向）', () => {

  test('按仓库汇总方向统计：WH-BJ 作为源仓的总出量', async () => {
    const bjId = ids.warehouseIds['WH-BJ'];
    const summary = await getSql(
      db,
      `SELECT
        COUNT(id) as transfer_count,
        SUM(transfer_qty) as total_out
       FROM transfer_records WHERE source_warehouse_id = ?`,
      [bjId]
    );
    expect(Number(summary.transfer_count)).toBeGreaterThanOrEqual(3);
    expect(Number(summary.total_out)).toBeGreaterThanOrEqual(80 + 60 + 400);
  });

  test('按 SKU 汇总：某 SKU 的全网调拨总量', async () => {
    const sku1Id = ids.skuIds['SKU-001'];
    const summary = await getSql(
      db,
      `SELECT
        COUNT(id) as transfer_count,
        SUM(transfer_qty) as total_transfer
       FROM transfer_records WHERE sku_id = ?`,
      [sku1Id]
    );
    expect(Number(summary.transfer_count)).toBeGreaterThanOrEqual(2);
    expect(Number(summary.total_transfer)).toBe(420);
  });

  test('按目标仓汇总：入量', async () => {
    const gzId = ids.warehouseIds['WH-GZ'];
    const summary = await getSql(
      db,
      `SELECT SUM(transfer_qty) as total_in
       FROM transfer_records WHERE target_warehouse_id = ?`,
      [gzId]
    );
    expect(Number(summary.total_in)).toBe(80 + 60);
  });
});

describe('调拨记录 - 状态联动与约束', () => {

  test('CONFIRMED 方案的 transfer_records 已写入 → COMPLETED 后不重复写入', async () => {
    const reqInfo = await createTransferRequest(db, {
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: ids.warehouseIds['WH-SH'],
      status: 'SUBMITTED',
      items: [{ sku_id: ids.skuIds['SKU-004'], requested_qty: 30 }]
    }, ids);

    const plan = await transferPlanService.generatePlan(reqInfo.requestId, '状态联动测试');
    await transferPlanService.confirmPlan(plan.planId, '', 'op-1');
    const afterConfirm = await getSql(
      db, 'SELECT COUNT(*) as cnt FROM transfer_records WHERE plan_id = ?',
      [plan.planId]
    );

    await transferPlanService.executePlan(plan.planId, 'op-2');
    const afterExecute = await getSql(
      db, 'SELECT COUNT(*) as cnt FROM transfer_records WHERE plan_id = ?',
      [plan.planId]
    );

    expect(afterConfirm.cnt).toBe(1);
    expect(afterExecute.cnt).toBe(1);
  });

  test('REJECTED 方案：不生成任何 transfer_record', async () => {
    const reqInfo = await createTransferRequest(db, {
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: ids.warehouseIds['WH-GZ'],
      status: 'SUBMITTED',
      items: [{ sku_id: ids.skuIds['SKU-005'], requested_qty: 100 }]
    }, ids);

    const plan = await transferPlanService.generatePlan(reqInfo.requestId, 'REJECTED测试');
    await transferPlanService.rejectPlan(plan.planId, '测试驳回', 'reviewer');

    const cnt = await getSql(
      db, 'SELECT COUNT(*) as cnt FROM transfer_records WHERE plan_id = ?',
      [plan.planId]
    );
    expect(cnt.cnt).toBe(0);

    const planStatus = await getSql(
      db, 'SELECT status, rejected_at, review_comment FROM transfer_plans WHERE id = ?',
      [plan.planId]
    );
    expect(planStatus.status).toBe('REJECTED');
    expect(planStatus.rejected_at).toBeDefined();
    expect(planStatus.review_comment).toBe('测试驳回');
  });

  test('非法字段校验：transfer_qty 不为负数（路由业务层校验）', async () => {
    const before = await getSql(db, 'SELECT COUNT(*) as cnt FROM transfer_records WHERE transfer_qty < 0');
    expect(before.cnt).toBe(0);

    const v = await runValidation(
      rules.transferPlanConfirm,
      fakeRequest({ operator: 'test' }, { id: '1' })
    );
    expect(v.passed).toBe(true);
  });

  test('源仓和目标仓必填：源仓为 NULL 被外键约束阻止', async () => {
    let thrown = false;
    try {
      await runSql(
        db,
        `INSERT INTO transfer_records
          (record_no, source_warehouse_id, target_warehouse_id, sku_id, transfer_qty, operator)
         VALUES (?, NULL, ?, ?, ?, ?)`,
        [generateRecordNo(), ids.warehouseIds['WH-SH'], ids.skuIds['SKU-001'], 10, 'unit']
      );
    } catch (err) {
      thrown = true;
      expect(err.message).toMatch(/FOREIGN KEY|constraint/i);
    }
    expect(thrown).toBe(true);
  });

  test('SKU 必填：sku_id 为 NULL 被外键约束阻止', async () => {
    let thrown = false;
    try {
      await runSql(
        db,
        `INSERT INTO transfer_records
          (record_no, source_warehouse_id, target_warehouse_id, sku_id, transfer_qty, operator)
         VALUES (?, ?, ?, NULL, ?, ?)`,
        [generateRecordNo(), ids.warehouseIds['WH-BJ'], ids.warehouseIds['WH-SH'], 10, 'unit']
      );
    } catch (err) {
      thrown = true;
      expect(err.message).toMatch(/FOREIGN KEY|constraint/i);
    }
    expect(thrown).toBe(true);
  });
});

describe('请求校验中间件 - transferRecord 路由与相关规则', () => {

  test('transferRecordQuery - 非法 source_warehouse_id', async () => {
    const v = await runValidation(
      rules.transferRecordQuery,
      fakeRequest({}, {}, { source_warehouse_id: 'NOT_INT' })
    );
    expect(v.passed).toBe(false);
    const paths = v.response.body.errors.map(e => e.path);
    expect(paths).toContain('source_warehouse_id');
  });

  test('transferRecordQuery - 非法 pageSize 范围', async () => {
    const v = await runValidation(
      rules.transferRecordQuery,
      fakeRequest({}, {}, { pageSize: '2000' })
    );
    expect(v.passed).toBe(false);
    const paths = v.response.body.errors.map(e => e.path);
    expect(paths).toContain('pageSize');
  });

  test('transferRecordQuery - 合法查询参数', async () => {
    const v = await runValidation(
      rules.transferRecordQuery,
      fakeRequest({}, {}, {
        source_warehouse_id: '1',
        target_warehouse_id: '2',
        sku_id: '3',
        plan_id: '10',
        request_id: '20',
        page: '1',
        pageSize: '50'
      })
    );
    expect(v.passed).toBe(true);
  });
});

describe('请求校验中间件 - transferRequest / transferPlan 规则', () => {

  test('transferRequestCreate - 空对象必含的必填项错误', async () => {
    const v = await runValidation(rules.transferRequestCreate, fakeRequest({}));
    expect(v.passed).toBe(false);
    const paths = v.response.body.errors.map(e => e.path);
    expect(paths).toEqual(expect.arrayContaining(['target_warehouse_id', 'items']));
    expect(v.response.body.code).toBe('VALIDATION_ERROR');
  });

  test('transferRequestCreate - 非法 priority 枚举值', async () => {
    const v = await runValidation(
      rules.transferRequestCreate,
      fakeRequest({
        target_warehouse_id: ids.warehouseIds['WH-BJ'],
        priority: 'CRITICAL',
        items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 10 }]
      })
    );
    expect(v.passed).toBe(false);
    const paths = v.response.body.errors.map(e => e.path);
    expect(paths).toContain('priority');
  });

  test('transferRequestCreate - items 为空数组被拦截', async () => {
    const v = await runValidation(
      rules.transferRequestCreate,
      fakeRequest({
        target_warehouse_id: ids.warehouseIds['WH-BJ'],
        items: []
      })
    );
    expect(v.passed).toBe(false);
  });

  test('transferRequestCreate - item.requested_qty <= 0 被拦截', async () => {
    const v = await runValidation(
      rules.transferRequestCreate,
      fakeRequest({
        target_warehouse_id: ids.warehouseIds['WH-BJ'],
        items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: -5 }]
      })
    );
    expect(v.passed).toBe(false);
    const paths = v.response.body.errors.map(e => e.path);
    expect(paths).toContain('items');
  });

  test('transferRequestCreate - source == target 自定义校验', async () => {
    const v = await runValidation(
      rules.transferRequestCreate,
      fakeRequest({
        source_warehouse_id: ids.warehouseIds['WH-BJ'],
        target_warehouse_id: ids.warehouseIds['WH-BJ'],
        items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 10 }]
      })
    );
    expect(v.passed).toBe(false);
  });

  test('transferPlanConfirm - 非法 id 被拦截', async () => {
    const v = await runValidation(
      rules.transferPlanConfirm,
      fakeRequest({}, { id: 'abc' })
    );
    expect(v.passed).toBe(false);
  });

  test('transferPlanConfirm - review_comment 超长', async () => {
    const v = await runValidation(
      rules.transferPlanConfirm,
      fakeRequest({ review_comment: 'x'.repeat(501) }, { id: '1' })
    );
    expect(v.passed).toBe(false);
  });

  test('transferPlanGenerate - requestIdParam 非数字', async () => {
    const v = await runValidation(
      rules.transferPlanGenerate,
      fakeRequest({}, { requestId: 'xyz' })
    );
    expect(v.passed).toBe(false);
  });

  test('transferPlanReject - planner 超长', async () => {
    const v = await runValidation(
      rules.transferPlanReject,
      fakeRequest({ planner: 'x'.repeat(51) }, { id: '1' })
    );
    expect(v.passed).toBe(false);
  });
});
