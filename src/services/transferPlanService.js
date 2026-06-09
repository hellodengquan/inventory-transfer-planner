/**
 * 调拨方案服务 - 方案生成/确认/驳回/执行/删除 与 事务性状态机
 * @module src/services/transferPlanService
 * @description 维护调拨方案状态机 PENDING→CONFIRMED→COMPLETED 与分支 REJECTED/CANCELLED，
 *              所有写操作均使用 serializeTransaction 保障事务原子性
 */

const { allQuery, getQuery, runQuery, db } = require('../db/database');
const constraintCheckService = require('./constraintCheckService');

/**
 * 生成调拨方案编号 TP-YYYYMMDD-NNNN
 * @returns {string}
 */
function generatePlanNo() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `TP-${yyyy}${mm}${dd}-${rand}`;
}

/**
 * 生成调拨记录编号 TRN-timestamp-rand
 * @returns {string}
 */
function generateRecordNo() {
  const now = new Date();
  return `TRN-${now.getTime()}-${Math.floor(Math.random() * 1000)}`;
}

/**
 * 调拨方案服务类
 */
class TransferPlanService {
  /**
   * 构造函数，绑定默认数据库方法
   */
  constructor() {
    this._allQuery = allQuery;
    this._getQuery = getQuery;
    this._runQuery = runQuery;
    this._db = db;
  }

  /**
   * 测试场景下的数据库方法依赖注入
   * @param {Function} [customGet] 单行查询
   * @param {Function} [customAll] 多行查询
   * @param {Function} [customRun] 执行写入
   * @param {object} [customDb] 数据库实例
   */
  setDbFunctions(customGet, customAll, customRun, customDb) {
    if (customGet) this._getQuery = customGet;
    if (customAll) this._allQuery = customAll;
    if (customRun) this._runQuery = customRun;
    if (customDb) this._db = customDb;
  }

  /**
   * 恢复数据库方法为默认实现
   */
  resetDbFunctions() {
    this._getQuery = getQuery;
    this._allQuery = allQuery;
    this._runQuery = runQuery;
    this._db = db;
  }

  /**
   * 在 serialize 模式下执行 BEGIN→callback→COMMIT；异常时自动 ROLLBACK
   * @param {Function} callback - 事务体，返回 Promise
   * @returns {Promise<any>} callback 的返回值
   * @throws {Error} 回滚后的原始异常
   */
  serializeTransaction(callback) {
    return new Promise((resolve, reject) => {
      const database = this._db;
      database.serialize(async () => {
        database.run('BEGIN TRANSACTION');
        try {
          const result = await callback();
          database.run('COMMIT', (err) => {
            if (err) {
              database.run('ROLLBACK', () => reject(err));
            } else {
              resolve(result);
            }
          });
        } catch (err) {
          database.run('ROLLBACK', () => reject(err));
        }
      });
    });
  }

  /**
   * 为指定调拨申请生成 PENDING 状态的调拨方案（含约束检查、方案明细、违规记录）
   * @param {number} requestId - 调拨申请 ID
   * @param {string} [planner=''] - 规划人
   * @returns {Promise<{planId:number, requestId:number, plan_no:string, status:string, checkResult:object, total_transfer_qty:number, request_id:number}>}
   * @throws {{status:number, code:string, message:string}} 业务错误
   */
  async generatePlan(requestId, planner = '') {
    const request = await this._getQuery('SELECT * FROM transfer_requests WHERE id = ?', [requestId]);
    if (!request) {
      throw { status: 404, message: '调拨申请不存在', code: 'REQUEST_NOT_FOUND' };
    }
    if (!['SUBMITTED', 'PLANNING', 'REJECTED'].includes(request.status)) {
      throw { status: 400, message: `申请状态(${request.status})不允许生成方案`, code: 'STATUS_NOT_ALLOWED' };
    }

    const items = await this._allQuery(`
      SELECT tri.id as request_item_id, tri.sku_id, tri.requested_qty, tri.remark
      FROM transfer_request_items tri WHERE tri.request_id = ?
    `, [requestId]);
    if (items.length === 0) {
      throw { status: 400, message: '调拨申请明细为空', code: 'EMPTY_ITEMS' };
    }

    const checkResult = await constraintCheckService.checkTransferRequest({
      source_warehouse_id: request.source_warehouse_id,
      target_warehouse_id: request.target_warehouse_id,
      items: items.map(i => ({ sku_id: i.sku_id, requested_qty: i.requested_qty }))
    });

    const plan_no = generatePlanNo();
    const plan_type = request.source_warehouse_id ? 'SINGLE_SOURCE' : 'MULTI_SOURCE';
    let total_transfer_qty = 0;

    const planItems = [];
    for (const ir of checkResult.itemResults) {
      if (request.source_warehouse_id) {
        const sourceInv = ir.details.sourceInventory;
        const targetInv = ir.details.targetInventory;
        planItems.push({
          request_item_id: items.find(x => x.sku_id === ir.sku_id).request_item_id,
          sku_id: ir.sku_id,
          source_warehouse_id: request.source_warehouse_id,
          target_warehouse_id: request.target_warehouse_id,
          planned_qty: ir.planned_qty || 0,
          source_before_qty: sourceInv ? sourceInv.available_qty : 0,
          source_after_qty: (sourceInv ? sourceInv.available_qty : 0) - (ir.planned_qty || 0),
          target_before_qty: targetInv ? targetInv.available_qty : 0,
          target_after_qty: (targetInv ? targetInv.available_qty : 0) + (ir.planned_qty || 0),
          shortage_qty: ir.shortage || 0,
          warning: ir.violations.filter(v => v.severity !== 'FATAL').map(v => v.message).join('; ') || null
        });
        total_transfer_qty += ir.planned_qty || 0;
      } else {
        const sources = ir.sources || [];
        let totalForSku = 0;
        for (let si = 0; si < sources.length; si++) {
          const src = sources[si];
          const isLast = si === sources.length - 1;
          planItems.push({
            request_item_id: items.find(x => x.sku_id === ir.sku_id).request_item_id,
            sku_id: ir.sku_id,
            source_warehouse_id: src.warehouse_id,
            target_warehouse_id: request.target_warehouse_id,
            planned_qty: src.allocated_qty,
            source_before_qty: src.available_qty,
            source_after_qty: src.after_qty,
            target_before_qty: 0,
            target_after_qty: src.allocated_qty,
            shortage_qty: (isLast && ir.shortage) ? ir.shortage : 0,
            warning: (src.warnings || []).join('; ') || null
          });
          totalForSku += src.allocated_qty;
        }
        total_transfer_qty += totalForSku;
      }
    }

    const planResult = await this.serializeTransaction(async () => {
      const inserted = await this._runQuery(
        `INSERT INTO transfer_plans
          (plan_no, request_id, status, plan_type, total_transfer_qty,
           constraint_check_result, constraint_check_passed, planner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          plan_no, request.id, 'PENDING', plan_type, total_transfer_qty,
          JSON.stringify({
            passed: checkResult.passed,
            summary: checkResult.summary,
            fatalCount: checkResult.fatalCount,
            warningCount: checkResult.warningCount,
            infoCount: checkResult.infoCount
          }),
          checkResult.passed ? 1 : 0,
          planner
        ]
      );

      for (const pi of planItems) {
        await this._runQuery(
          `INSERT INTO transfer_plan_items
            (plan_id, request_item_id, sku_id, source_warehouse_id, target_warehouse_id,
             planned_qty, source_before_qty, source_after_qty, target_before_qty, target_after_qty,
             shortage_qty, warning)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            inserted.lastID, pi.request_item_id, pi.sku_id, pi.source_warehouse_id, pi.target_warehouse_id,
            pi.planned_qty, pi.source_before_qty, pi.source_after_qty, pi.target_before_qty, pi.target_after_qty,
            pi.shortage_qty, pi.warning
          ]
        );
      }

      for (const v of checkResult.violations) {
        await this._runQuery(
          `INSERT INTO constraint_violations
            (plan_id, plan_item_id, violation_type, severity, message,
             warehouse_id, sku_id, current_value, required_value, threshold_value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            inserted.lastID, null, v.violation_type, v.severity, v.message,
            v.warehouse_id, v.sku_id, v.current_value, v.required_value, v.threshold_value
          ]
        );
      }

      await this._runQuery(
        "UPDATE transfer_requests SET status = 'PLANNING', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [request.id]
      );

      return inserted;
    });

    return { planId: planResult.lastID, requestId: request.id, plan_no, status: 'PENDING', checkResult, total_transfer_qty, request_id: request.id };
  }

  /**
   * 确认调拨方案（事务原子性：源仓扣减可用→在途、目标仓加在途、写入记录、更新状态）
   * @param {number} planId - 方案 ID
   * @param {string} [review_comment=''] - 审批意见
   * @param {string} [operator='system'] - 操作人
   * @returns {Promise<{success:boolean, status:string}>}
   */
  async confirmPlan(planId, review_comment = '', operator = 'system') {
    const plan = await this._getQuery('SELECT * FROM transfer_plans WHERE id = ?', [planId]);
    if (!plan) throw { status: 404, message: '调拨方案不存在', code: 'PLAN_NOT_FOUND' };
    if (plan.status !== 'PENDING') throw { status: 400, message: `方案状态(${plan.status})不允许确认`, code: 'STATUS_NOT_ALLOWED' };

    const planItems = await this._allQuery('SELECT * FROM transfer_plan_items WHERE plan_id = ?', [planId]);
    if (planItems.length === 0) throw { status: 400, message: '方案明细为空', code: 'EMPTY_ITEMS' };

    await this.serializeTransaction(async () => {
      for (const item of planItems) {
        if (item.planned_qty <= 0) continue;

        const sourceInv = await this._getQuery(
          'SELECT * FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
          [item.source_warehouse_id, item.sku_id]
        );
        if (!sourceInv || sourceInv.available_qty < item.planned_qty) {
          throw new Error(`源仓库库存不足: 仓库${item.source_warehouse_id} SKU${item.sku_id}`);
        }

        await this._runQuery(
          `UPDATE inventory SET available_qty = available_qty - ?, in_transit_qty = in_transit_qty + ?, updated_at = CURRENT_TIMESTAMP WHERE warehouse_id = ? AND sku_id = ?`,
          [item.planned_qty, item.planned_qty, item.source_warehouse_id, item.sku_id]
        );

        const targetInv = await this._getQuery(
          'SELECT id FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
          [item.target_warehouse_id, item.sku_id]
        );
        if (targetInv) {
          await this._runQuery(
            `UPDATE inventory SET in_transit_qty = in_transit_qty + ?, updated_at = CURRENT_TIMESTAMP WHERE warehouse_id = ? AND sku_id = ?`,
            [item.planned_qty, item.target_warehouse_id, item.sku_id]
          );
        } else {
          await this._runQuery(
            'INSERT INTO inventory (warehouse_id, sku_id, available_qty, reserved_qty, in_transit_qty, min_stock) VALUES (?, ?, 0, 0, ?, 0)',
            [item.target_warehouse_id, item.sku_id, item.planned_qty]
          );
        }

        await this._runQuery(
          `INSERT INTO transfer_records
            (record_no, plan_id, request_id, source_warehouse_id, target_warehouse_id, sku_id, transfer_qty, operator, remark)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [generateRecordNo(), plan.id, plan.request_id, item.source_warehouse_id, item.target_warehouse_id,
           item.sku_id, item.planned_qty, operator, review_comment]
        );

        await this._runQuery(
          'UPDATE transfer_request_items SET allocated_qty = allocated_qty + ? WHERE id = ?',
          [item.planned_qty, item.request_item_id]
        );
      }

      await this._runQuery(
        `UPDATE transfer_plans SET
          status = 'CONFIRMED', review_comment = ?, confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [review_comment, planId]
      );
      await this._runQuery(
        "UPDATE transfer_requests SET status = 'APPROVED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [plan.request_id]
      );
    });

    return { success: true, status: 'CONFIRMED' };
  }

  /**
   * 驳回调拨方案；若申请无其他 PENDING 方案则同步降级申请为 REJECTED
   * @param {number} planId - 方案 ID
   * @param {string} [review_comment=''] - 驳回原因
   * @returns {Promise<{success:boolean, status:string}>}
   */
  async rejectPlan(planId, review_comment = '') {
    const plan = await this._getQuery('SELECT * FROM transfer_plans WHERE id = ?', [planId]);
    if (!plan) throw { status: 404, message: '调拨方案不存在', code: 'PLAN_NOT_FOUND' };
    if (plan.status !== 'PENDING') throw { status: 400, message: `方案状态(${plan.status})不允许驳回`, code: 'STATUS_NOT_ALLOWED' };

    await this.serializeTransaction(async () => {
      await this._runQuery(
        `UPDATE transfer_plans SET
          status = 'REJECTED', review_comment = ?, rejected_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [review_comment, planId]
      );
      const pendingCount = await this._getQuery(
        "SELECT COUNT(*) as cnt FROM transfer_plans WHERE request_id = ? AND status = 'PENDING'",
        [plan.request_id]
      );
      if (pendingCount.cnt === 0) {
        await this._runQuery(
          "UPDATE transfer_requests SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [plan.request_id]
        );
      }
    });

    return { success: true, status: 'REJECTED' };
  }

  /**
   * 执行调拨方案入库：源仓扣减在途、目标仓在途转可用；方案与申请同步为 COMPLETED
   * @param {number} planId - 方案 ID
   * @param {string} [operator='system'] - 操作人
   * @returns {Promise<{success:boolean, status:string}>}
   */
  async executePlan(planId, operator = 'system') {
    const plan = await this._getQuery('SELECT * FROM transfer_plans WHERE id = ?', [planId]);
    if (!plan) throw { status: 404, message: '调拨方案不存在', code: 'PLAN_NOT_FOUND' };
    if (plan.status !== 'CONFIRMED' && plan.status !== 'PROCESSING') {
      throw { status: 400, message: `方案状态(${plan.status})不允许执行入库`, code: 'STATUS_NOT_ALLOWED' };
    }

    const planItems = await this._allQuery('SELECT * FROM transfer_plan_items WHERE plan_id = ?', [planId]);

    await this.serializeTransaction(async () => {
      for (const item of planItems) {
        if (item.planned_qty <= 0) continue;

        await this._runQuery(
          `UPDATE inventory SET in_transit_qty = in_transit_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE warehouse_id = ? AND sku_id = ?`,
          [item.planned_qty, item.source_warehouse_id, item.sku_id]
        );
        await this._runQuery(
          `UPDATE inventory SET
            available_qty = available_qty + ?, in_transit_qty = in_transit_qty - ?, updated_at = CURRENT_TIMESTAMP
           WHERE warehouse_id = ? AND sku_id = ?`,
          [item.planned_qty, item.planned_qty, item.target_warehouse_id, item.sku_id]
        );
      }

      await this._runQuery("UPDATE transfer_plans SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [planId]);
      await this._runQuery("UPDATE transfer_requests SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [plan.request_id]);
    });

    return { success: true, status: 'COMPLETED' };
  }

  /**
   * 取消/删除调拨方案；删除最后一个待处理方案后申请回退为 SUBMITTED
   * @param {number} planId - 方案 ID
   * @returns {Promise<{success:boolean, status:string}>}
   */
  async cancelPlan(planId) {
    const plan = await this._getQuery('SELECT * FROM transfer_plans WHERE id = ?', [planId]);
    if (!plan) throw { status: 404, message: '调拨方案不存在', code: 'PLAN_NOT_FOUND' };
    if (!['PENDING', 'REJECTED'].includes(plan.status)) {
      throw { status: 400, message: `方案状态(${plan.status})不允许删除/取消`, code: 'STATUS_NOT_ALLOWED' };
    }

    await this._runQuery('DELETE FROM transfer_plans WHERE id = ?', [planId]);

    const pendingCount = await this._getQuery(
      "SELECT COUNT(*) as cnt FROM transfer_plans WHERE request_id = ? AND status IN ('PENDING', 'CONFIRMED')",
      [plan.request_id]
    );
    if (pendingCount.cnt === 0) {
      const reqInfo = await this._getQuery('SELECT status FROM transfer_requests WHERE id = ?', [plan.request_id]);
      if (reqInfo && reqInfo.status === 'PLANNING') {
        await this._runQuery(
          "UPDATE transfer_requests SET status = 'SUBMITTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [plan.request_id]
        );
      }
    }

    return { success: true, status: 'CANCELLED' };
  }
}

module.exports = new TransferPlanService();
