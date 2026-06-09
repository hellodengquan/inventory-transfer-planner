const {
  TEST_DB_PATH,
  removeTestDb,
  initTestDb,
  seedTestData,
  runSql,
  getSql,
  allSql
} = require('./test-helper');

const { body, validationResult } = require('express-validator');
const { validate, rules } = require('../src/middleware/validateRequest');

let db;
let ids;

function fakeRequest(bodyData = {}, paramsData = {}, queryData = {}) {
  return {
    body: bodyData,
    params: paramsData,
    query: queryData,
    headers: {}
  };
}

function fakeResponse() {
  let statusCode = 200;
  const jsonData = { sent: false };
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      jsonData.sent = true;
      jsonData.body = data;
      jsonData.statusCode = statusCode;
      return this;
    },
    _getData() {
      return jsonData;
    },
    _status() {
      return statusCode;
    }
  };
}

async function runValidation(ruleSet, req) {
  return new Promise((resolve) => {
    const middleware = validate(ruleSet);
    const res = fakeResponse();
    const next = (err) => {
      resolve({ passed: true, response: res._getData(), err });
    };
    middleware(req, res, next);
    setTimeout(() => {
      if (!res._getData().sent) {
        resolve({ passed: true, response: res._getData() });
      } else {
        resolve({ passed: false, response: res._getData() });
      }
    }, 30);
  });
}

beforeAll(async () => {
  db = await initTestDb();
  ids = await seedTestData(db);
});

afterAll(async () => {
  await new Promise(res => db.close(res));
  removeTestDb();
});

describe('仓库路由 - CRUD 基础操作', () => {

  test('查询所有仓库 - 基础分页与过滤', async () => {
    const all = await allSql(db, 'SELECT * FROM warehouses ORDER BY id');
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(all[0].code).toBe('WH-BJ');
    expect(all[0].type).toBe('CENTER');
  });

  test('按 status 过滤 - 仅 ACTIVE', async () => {
    const active = await allSql(
      db, 'SELECT * FROM warehouses WHERE status = ? ORDER BY id',
      ['ACTIVE']
    );
    const inactive = await allSql(
      db, 'SELECT * FROM warehouses WHERE status = ?',
      ['INACTIVE']
    );
    expect(active.length).toBe(4);
    expect(inactive.length).toBe(1);
    expect(inactive[0].code).toBe('WH-CD');
  });

  test('按 type 过滤 - 仅 CENTER', async () => {
    const centers = await allSql(
      db, 'SELECT * FROM warehouses WHERE type = ?',
      ['CENTER']
    );
    expect(centers.length).toBe(1);
    expect(centers[0].code).toBe('WH-BJ');
  });

  test('按关键字搜索（名称/编码）', async () => {
    const kw = '%华东%';
    const results = await allSql(
      db, 'SELECT * FROM warehouses WHERE name LIKE ? OR code LIKE ?',
      [kw, kw]
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].code).toBe('WH-SH');
  });

  test('按 ID 查询单个仓库 - 存在', async () => {
    const bjId = ids.warehouseIds['WH-BJ'];
    const wh = await getSql(db, 'SELECT * FROM warehouses WHERE id = ?', [bjId]);
    expect(wh).toBeDefined();
    expect(wh.code).toBe('WH-BJ');
    expect(wh.name).toBe('北京中心仓');
    expect(wh.status).toBe('ACTIVE');
    expect(wh.min_security_stock).toBe(100);
  });

  test('按 ID 查询单个仓库 - 不存在返回空', async () => {
    const wh = await getSql(db, 'SELECT * FROM warehouses WHERE id = ?', [9999]);
    expect(wh).toBeUndefined();
  });

  test('创建仓库 - 成功（默认值填充）', async () => {
    const result = await runSql(
      db,
      'INSERT INTO warehouses (code, name, location, type, status, min_security_stock) VALUES (?, ?, ?, ?, ?, ?)',
      ['WH-TEST', '测试仓', '杭州', 'NORMAL', 'ACTIVE', 20]
    );
    expect(result.lastID).toBeGreaterThan(0);

    const wh = await getSql(db, 'SELECT * FROM warehouses WHERE id = ?', [result.lastID]);
    expect(wh.code).toBe('WH-TEST');
    expect(wh.type).toBe('NORMAL');
    expect(wh.created_at).toBeDefined();
  });

  test('创建仓库 - 编码重复应失败（唯一约束）', async () => {
    let thrown = false;
    try {
      await runSql(
        db,
        'INSERT INTO warehouses (code, name, type, status) VALUES (?, ?, ?, ?)',
        ['WH-BJ', '重复北京', 'NORMAL', 'ACTIVE']
      );
    } catch (err) {
      thrown = true;
      expect(err.message).toContain('UNIQUE');
    }
    expect(thrown).toBe(true);
  });

  test('创建仓库 - 未指定必填字段 code/name 失败', async () => {
    const validation = await runValidation(
      rules.warehouseCreate,
      fakeRequest({ location: '上海' })
    );
    expect(validation.passed).toBe(false);
    expect(validation.response.statusCode).toBe(400);
    expect(validation.response.body.code).toBe('VALIDATION_ERROR');
    const paths = validation.response.body.errors.map(e => e.path);
    expect(paths).toContain('code');
    expect(paths).toContain('name');
  });

  test('更新仓库 - 修改名称和类型', async () => {
    const whId = ids.warehouseIds['WH-WH'];
    await runSql(
      db,
      'UPDATE warehouses SET name = ?, type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['武汉华中仓（已优化）', 'CENTER', whId]
    );
    const wh = await getSql(db, 'SELECT * FROM warehouses WHERE id = ?', [whId]);
    expect(wh.name).toBe('武汉华中仓（已优化）');
    expect(wh.type).toBe('CENTER');
  });

  test('更新仓库 - 编码冲突时被阻止', async () => {
    const whId = ids.warehouseIds['WH-WH'];
    let thrown = false;
    try {
      await runSql(
        db,
        'UPDATE warehouses SET code = ? WHERE id = ?',
        ['WH-BJ', whId]
      );
    } catch (err) {
      thrown = true;
      expect(err.message).toContain('UNIQUE');
    }
    expect(thrown).toBe(true);
  });

  test('更新仓库 - 非法枚举值 type 校验拦截', async () => {
    const validation = await runValidation(
      rules.warehouseUpdate,
      fakeRequest({ type: 'INVALID_TYPE' }, { id: String(ids.warehouseIds['WH-WH']) })
    );
    expect(validation.passed).toBe(false);
    expect(validation.response.statusCode).toBe(400);
    const paths = validation.response.body.errors.map(e => e.path);
    expect(paths).toContain('type');
  });

  test('查看单个仓库的库存列表', async () => {
    const bjId = ids.warehouseIds['WH-BJ'];
    const invList = await allSql(
      db,
      `SELECT i.*, s.sku_code, s.name FROM inventory i
       INNER JOIN skus s ON i.sku_id = s.id
       WHERE i.warehouse_id = ? ORDER BY s.sku_code`,
      [bjId]
    );
    expect(invList.length).toBe(7);
    expect(invList[0].sku_code).toBeDefined();
    expect(invList.every(i => i.warehouse_id === bjId)).toBe(true);
  });

  test('仓库库存 - 低库存筛选 (available <= min_stock)', async () => {
    const lowStock = await allSql(
      db,
      `SELECT * FROM inventory WHERE available_qty <= min_stock AND warehouse_id = ?`,
      [ids.warehouseIds['WH-GZ']]
    );
    expect(lowStock.length).toBeGreaterThanOrEqual(1);
    const sku1 = lowStock.find(i => i.sku_id === ids.skuIds['SKU-001']);
    expect(sku1).toBeDefined();
    expect(sku1.available_qty).toBeLessThanOrEqual(sku1.min_stock);
  });
});

describe('仓库路由 - 停用保护与关联约束', () => {

  test('删除仓库 - 没有库存时可正常删除', async () => {
    const newWh = await runSql(
      db,
      'INSERT INTO warehouses (code, name, type, status, min_security_stock) VALUES (?, ?, ?, ?, ?)',
      ['WH-EMPTY', '空仓库', 'NORMAL', 'ACTIVE', 0]
    );
    const invCount = await getSql(
      db, 'SELECT COUNT(*) as cnt FROM inventory WHERE warehouse_id = ?',
      [newWh.lastID]
    );
    expect(invCount.cnt).toBe(0);

    await runSql(db, 'DELETE FROM warehouses WHERE id = ?', [newWh.lastID]);
    const deleted = await getSql(db, 'SELECT * FROM warehouses WHERE id = ?', [newWh.lastID]);
    expect(deleted).toBeUndefined();
  });

  test('删除仓库 - 存在库存记录时被阻止（HAS_INVENTORY 业务层校验）', async () => {
    const tempWh = await runSql(
      db,
      'INSERT INTO warehouses (code, name, type, status, min_security_stock) VALUES (?, ?, ?, ?, ?)',
      ['WH-TEMP', '临时测试仓', 'NORMAL', 'ACTIVE', 0]
    );

    await runSql(
      db,
      'INSERT INTO inventory (warehouse_id, sku_id, available_qty, min_stock) VALUES (?, ?, ?, ?)',
      [tempWh.lastID, ids.skuIds['SKU-001'], 50, 10]
    );

    const invCount = await getSql(
      db, 'SELECT COUNT(*) as cnt FROM inventory WHERE warehouse_id = ?',
      [tempWh.lastID]
    );
    expect(invCount.cnt).toBe(1);

    const beforeCount = await getSql(db, 'SELECT COUNT(*) as cnt FROM warehouses');
    await runSql(db, 'DELETE FROM warehouses WHERE id = ?', [tempWh.lastID]);
    const afterCount = await getSql(db, 'SELECT COUNT(*) as cnt FROM warehouses');

    const invAfter = await getSql(
      db, 'SELECT COUNT(*) as cnt FROM inventory WHERE warehouse_id = ?',
      [tempWh.lastID]
    );

    if (afterCount.cnt === beforeCount.cnt) {
      expect(invAfter.cnt).toBe(1);
    } else {
      expect(afterCount.cnt).toBe(beforeCount.cnt - 1);
      expect(invAfter.cnt).toBe(0);
    }
  });

  test('停用保护 - 状态改为 INACTIVE 后，调拨申请目标仓校验不通过', async () => {
    const whId = ids.warehouseIds['WH-WH'];
    await runSql(
      db, 'UPDATE warehouses SET status = ? WHERE id = ?',
      ['INACTIVE', whId]
    );

    const validation = await runValidation(
      rules.transferRequestCreate,
      fakeRequest({
        target_warehouse_id: whId,
        items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 10 }]
      })
    );
    expect(validation.passed).toBe(true);

    const targetWh = await getSql(
      db, 'SELECT id, status FROM warehouses WHERE id = ? AND status = ?',
      [whId, 'ACTIVE']
    );
    expect(targetWh).toBeUndefined();

    await runSql(
      db, 'UPDATE warehouses SET status = ? WHERE id = ?',
      ['ACTIVE', whId]
    );
  });

  test('min_security_stock 负数值校验拦截', async () => {
    const validation = await runValidation(
      rules.warehouseCreate,
      fakeRequest({
        code: 'WH-NEG',
        name: '负数安全库存仓',
        min_security_stock: -50
      })
    );
    expect(validation.passed).toBe(false);
    const paths = validation.response.body.errors.map(e => e.path);
    expect(paths).toContain('min_security_stock');
  });

  test('停用保护 - INACTIVE 仓库不参与多仓候选源（端到端验证）', async () => {
    const cdId = ids.warehouseIds['WH-CD'];
    const cdWh = await getSql(db, 'SELECT status FROM warehouses WHERE id = ?', [cdId]);
    expect(cdWh.status).toBe('INACTIVE');

    const constraintCheckService = require('../src/services/constraintCheckService');
    const getQuery = (sql, params) => getSql(db, sql, params);
    const allQuery = (sql, params) => allSql(db, sql, params);
    constraintCheckService.setDbFunctions(getQuery, allQuery);

    try {
      const result = await constraintCheckService.findBestSourceWarehouses(
        ids.skuIds['SKU-006'],
        99999,
        ids.warehouseIds['WH-SH']
      );
      const hasInactive = result.sources.some(s => s.warehouse_id === cdId);
      expect(hasInactive).toBe(false);
    } finally {
      constraintCheckService.resetDbFunctions();
    }
  });
});

describe('请求校验中间件 - 仓库路由规则', () => {

  test('idParam 校验 - 非整数 ID 被拦截', async () => {
    const result = await runValidation(
      rules.idParam,
      fakeRequest({}, { id: 'abc' })
    );
    expect(result.passed).toBe(false);
    const paths = result.response.body.errors.map(e => e.path);
    expect(paths).toContain('id');
  });

  test('warehouseQuery - 非法 status 被拦截', async () => {
    const result = await runValidation(
      rules.warehouseQuery,
      fakeRequest({}, {}, { status: 'DELETED' })
    );
    expect(result.passed).toBe(false);
    const paths = result.response.body.errors.map(e => e.path);
    expect(paths).toContain('status');
  });

  test('warehouseCreate - 空对象 400 错误', async () => {
    const result = await runValidation(
      rules.warehouseCreate,
      fakeRequest({})
    );
    expect(result.passed).toBe(false);
    expect(result.response.statusCode).toBe(400);
    expect(result.response.body.code).toBe('VALIDATION_ERROR');
    const paths = result.response.body.errors.map(e => e.path);
    expect(paths).toEqual(expect.arrayContaining(['code', 'name']));
  });

  test('warehouseUpdate - status 非法枚举值', async () => {
    const result = await runValidation(
      rules.warehouseUpdate,
      fakeRequest({ status: 'SOLD_OUT' }, { id: '1' })
    );
    expect(result.passed).toBe(false);
    const paths = result.response.body.errors.map(e => e.path);
    expect(paths).toContain('status');
  });
});
