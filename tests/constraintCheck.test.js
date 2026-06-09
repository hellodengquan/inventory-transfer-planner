const {
  initTestDb,
  removeTestDb,
  seedTestData,
  getSql,
  allSql
} = require('./test-helper');

const constraintCheckService = require('../src/services/constraintCheckService');

let db;
let ids;

function bindDbToService(database) {
  const customGet = (sql, params = []) => new Promise((res, rej) => {
    database.get(sql, params, (err, row) => err ? rej(err) : res(row));
  });
  const customAll = (sql, params = []) => new Promise((res, rej) => {
    database.all(sql, params, (err, rows) => err ? rej(err) : res(rows));
  });
  constraintCheckService.setDbFunctions(customGet, customAll);
}

beforeAll(async () => {
  db = await initTestDb();
  ids = await seedTestData(db);
  bindDbToService(db);
});

afterAll(async () => {
  constraintCheckService.resetDbFunctions();
  await new Promise(res => db.close(res));
  removeTestDb();
});

describe('约束分级 - FATAL 级别（检查不通过，必须阻止）', () => {

  test('FATAL: WAREHOUSE_NOT_EXIST - 源仓库 ID 不存在', async () => {
    const result = await constraintCheckService.checkTransferRequest({
      source_warehouse_id: 99999,
      target_warehouse_id: ids.warehouseIds['WH-SH'],
      items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 10 }]
    });

    expect(result.passed).toBe(false);
    expect(result.fatalCount).toBeGreaterThanOrEqual(1);
    const violation = result.violations.find(v => v.violation_type === 'WAREHOUSE_NOT_EXIST');
    expect(violation).toBeDefined();
    expect(violation.severity).toBe('FATAL');
    expect(violation.warehouse_id).toBe(99999);
  });

  test('FATAL: WAREHOUSE_NOT_EXIST - 目标仓库 ID 不存在', async () => {
    const result = await constraintCheckService.checkTransferRequest({
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: 88888,
      items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 10 }]
    });

    expect(result.passed).toBe(false);
    const violation = result.violations.find(
      v => v.violation_type === 'WAREHOUSE_NOT_EXIST' && v.warehouse_id === 88888
    );
    expect(violation).toBeDefined();
    expect(violation.severity).toBe('FATAL');
  });

  test('FATAL: WAREHOUSE_NOT_EXIST - 源仓库状态为 INACTIVE（非激活）', async () => {
    const result = await constraintCheckService.checkTransferRequest({
      source_warehouse_id: ids.warehouseIds['WH-CD'],
      target_warehouse_id: ids.warehouseIds['WH-SH'],
      items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 10 }]
    });

    expect(result.passed).toBe(false);
    const violation = result.violations.find(
      v => v.violation_type === 'WAREHOUSE_NOT_EXIST' && v.warehouse_id === ids.warehouseIds['WH-CD']
    );
    expect(violation).toBeDefined();
    expect(violation.severity).toBe('FATAL');
    expect(violation.message).toContain('状态非激活');
  });

  test('FATAL: SAME_WAREHOUSE - 源仓库和目标仓库相同', async () => {
    const sameWh = ids.warehouseIds['WH-BJ'];
    const result = await constraintCheckService.checkTransferRequest({
      source_warehouse_id: sameWh,
      target_warehouse_id: sameWh,
      items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 10 }]
    });

    expect(result.passed).toBe(false);
    const violation = result.violations.find(v => v.violation_type === 'SAME_WAREHOUSE');
    expect(violation).toBeDefined();
    expect(violation.severity).toBe('FATAL');
    expect(violation.message).toBe('源仓库和目标仓库不能相同');
  });

  test('FATAL: SKU_NOT_EXIST - 请求明细中 SKU ID 不存在', async () => {
    const result = await constraintCheckService.checkTransferRequest({
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: ids.warehouseIds['WH-SH'],
      items: [{ sku_id: 77777, requested_qty: 10 }]
    });

    expect(result.passed).toBe(false);
    const itemResult = result.itemResults[0];
    const violation = itemResult.violations.find(v => v.violation_type === 'SKU_NOT_EXIST');
    expect(violation).toBeDefined();
    expect(violation.severity).toBe('FATAL');
    expect(violation.sku_id).toBe(77777);
  });

  test('FATAL: NEGATIVE_QTY - 调拨数量为 0', async () => {
    const result = await constraintCheckService.checkTransferRequest({
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: ids.warehouseIds['WH-SH'],
      items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 0 }]
    });

    expect(result.passed).toBe(false);
    const violation = result.itemResults[0].violations.find(v => v.violation_type === 'NEGATIVE_QTY');
    expect(violation).toBeDefined();
    expect(violation.severity).toBe('FATAL');
  });

  test('FATAL: NEGATIVE_QTY - 调拨数量为负数', async () => {
    const result = await constraintCheckService.checkTransferRequest({
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: ids.warehouseIds['WH-SH'],
      items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: -50 }]
    });

    const violation = result.itemResults[0].violations.find(v => v.violation_type === 'NEGATIVE_QTY');
    expect(violation).toBeDefined();
    expect(violation.severity).toBe('FATAL');
    expect(violation.required_value).toBe(-50);
  });
});

describe('约束分级 - WARNING 级别（检查通过，但有风险告警）', () => {

  test('WARNING: SOURCE_INSUFFICIENT - 源仓库可用库存小于调拨需求', async () => {
    const result = await constraintCheckService.checkTransferRequest({
      source_warehouse_id: ids.warehouseIds['WH-GZ'],
      target_warehouse_id: ids.warehouseIds['WH-SH'],
      items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 500 }]
    });

    expect(result.passed).toBe(true);
    expect(result.warningCount).toBeGreaterThanOrEqual(1);
    const violation = result.itemResults[0].violations.find(v => v.violation_type === 'SOURCE_INSUFFICIENT');
    expect(violation).toBeDefined();
    expect(violation.severity).toBe('WARNING');
    expect(violation.current_value).toBe(40);
    expect(violation.required_value).toBe(500);
  });

  test('WARNING: SOURCE_AFTER_MIN - 调拨后源仓库库存将低于安全库存线', async () => {
    const result = await constraintCheckService.checkTransferRequest({
      source_warehouse_id: ids.warehouseIds['WH-SH'],
      target_warehouse_id: ids.warehouseIds['WH-GZ'],
      items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 60 }]
    });

    const violation = result.itemResults[0].violations.find(v => v.violation_type === 'SOURCE_AFTER_MIN');
    expect(violation).toBeDefined();
    expect(violation.severity).toBe('WARNING');
    expect(violation.current_value).toBe(80 - 60);
    expect(violation.threshold_value).toBe(50);
    expect(violation.message).toContain('将低于安全库存');
  });

  test('WARNING: TARGET_OVER_MAX - 调拨后目标仓库库存超过最大库存限制', async () => {
    await new Promise((res, rej) => {
      db.run(
        'UPDATE inventory SET max_stock = 100 WHERE warehouse_id = ? AND sku_id = ?',
        [ids.warehouseIds['WH-SH'], ids.skuIds['SKU-001']],
        err => err ? rej(err) : res()
      );
    });

    const result = await constraintCheckService.checkTransferRequest({
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: ids.warehouseIds['WH-SH'],
      items: [{ sku_id: ids.skuIds['SKU-001'], requested_qty: 50 }]
    });

    const violation = result.itemResults[0].violations.find(v => v.violation_type === 'TARGET_OVER_MAX');
    expect(violation).toBeDefined();
    expect(violation.severity).toBe('WARNING');
    expect(violation.current_value).toBe(80 + 50);
    expect(violation.threshold_value).toBe(100);

    await new Promise((res, rej) => {
      db.run(
        'UPDATE inventory SET max_stock = 500 WHERE warehouse_id = ? AND sku_id = ?',
        [ids.warehouseIds['WH-SH'], ids.skuIds['SKU-001']],
        err => err ? rej(err) : res()
      );
    });
  });
});

describe('约束分级 - INFO 级别（提示性信息，无风险）', () => {

  test('INFO: SOURCE_MIN_STOCK - 源仓库当前库存已处于或低于安全库存线', async () => {
    const result = await constraintCheckService.checkTransferRequest({
      source_warehouse_id: ids.warehouseIds['WH-WH'],
      target_warehouse_id: ids.warehouseIds['WH-SH'],
      items: [{ sku_id: ids.skuIds['SKU-004'], requested_qty: 5 }]
    });

    const violation = result.itemResults[0].violations.find(v => v.violation_type === 'SOURCE_MIN_STOCK');
    expect(violation).toBeDefined();
    expect(violation.severity).toBe('INFO');
    expect(violation.message).toContain('已处于或低于安全库存线');
  });
});

describe('8 类约束全覆盖验证', () => {

  test('完整覆盖：所有 8 种 VIOLATION_TYPES 均已在本测试文件中定义并触发', () => {
    const types = Object.values(constraintCheckService.VIOLATION_TYPES);
    expect(types).toEqual(expect.arrayContaining([
      'SOURCE_INSUFFICIENT',
      'SOURCE_MIN_STOCK',
      'SOURCE_AFTER_MIN',
      'TARGET_OVER_MAX',
      'NEGATIVE_QTY',
      'SKU_NOT_EXIST',
      'WAREHOUSE_NOT_EXIST',
      'SAME_WAREHOUSE'
    ]));
    expect(types.length).toBe(8);
  });

  test('完美场景：约束检查完全通过，FATAL=0 WARNING=0 INFO=0', async () => {
    const result = await constraintCheckService.checkTransferRequest({
      source_warehouse_id: ids.warehouseIds['WH-BJ'],
      target_warehouse_id: ids.warehouseIds['WH-SH'],
      items: [{ sku_id: ids.skuIds['SKU-005'], requested_qty: 100 }]
    });

    expect(result.passed).toBe(true);
    expect(result.fatalCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.infoCount).toBe(0);
    expect(result.summary).toBe('检查完全通过');
    expect(result.itemResults[0].shortage).toBe(0);
  });
});
