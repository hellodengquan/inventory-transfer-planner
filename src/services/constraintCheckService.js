/**
 * 库存调拨约束检查服务
 * @module src/services/constraintCheckService
 * @description 提供 8 类调拨约束的 FATAL/WARNING/INFO 三级分级检查，
 *              支持单仓调拨校验与多仓自动分配（中心仓优先、安全库存保护）
 */

const { allQuery, getQuery } = require('../db/database');

/**
 * @typedef {'FATAL'|'WARNING'|'INFO'} Severity 约束严重度
 * @typedef {Object} Violation 单条约束违规
 * @property {string} violation_type 违规类型枚举
 * @property {Severity} severity 严重度
 * @property {string} message 可读消息
 * @property {?number} warehouse_id 关联仓库
 * @property {?number} sku_id 关联 SKU
 * @property {?number} current_value 当前值
 * @property {?number} required_value 需求值
 * @property {?number} threshold_value 阈值
 */

/**
 * 约束检查服务类
 */
class ConstraintCheckService {
  /**
   * 初始化服务与 8 类违规类型枚举
   */
  constructor() {
    this._allQuery = allQuery;
    this._getQuery = getQuery;
    this.VIOLATION_TYPES = {
      SOURCE_INSUFFICIENT: 'SOURCE_INSUFFICIENT',
      SOURCE_MIN_STOCK: 'SOURCE_MIN_STOCK',
      SOURCE_AFTER_MIN: 'SOURCE_AFTER_MIN',
      TARGET_OVER_MAX: 'TARGET_OVER_MAX',
      NEGATIVE_QTY: 'NEGATIVE_QTY',
      SKU_NOT_EXIST: 'SKU_NOT_EXIST',
      WAREHOUSE_NOT_EXIST: 'WAREHOUSE_NOT_EXIST',
      SAME_WAREHOUSE: 'SAME_WAREHOUSE'
    };
    this.SEVERITY = {
      FATAL: 'FATAL',
      WARNING: 'WARNING',
      INFO: 'INFO'
    };
  }

  /**
   * 测试场景下的依赖注入点（替换数据库方法）
   * @param {Function} [customGetQuery] 自定义单行查询方法
   * @param {Function} [customAllQuery] 自定义多行查询方法
   */
  setDbFunctions(customGetQuery, customAllQuery) {
    if (customGetQuery) this._getQuery = customGetQuery;
    if (customAllQuery) this._allQuery = customAllQuery;
  }

  /**
   * 恢复数据库方法为原始实现
   */
  resetDbFunctions() {
    this._getQuery = getQuery;
    this._allQuery = allQuery;
  }

  /**
   * 构造结构化违规对象
   * @param {string} type - 违规类型枚举
   * @param {Severity} severity - 严重度
   * @param {string} message - 面向业务的可读消息
   * @param {Object} [extras={}] - 可选上下文字段
   * @returns {Violation}
   */
  createViolation(type, severity, message, extras = {}) {
    return {
      violation_type: type,
      severity,
      message,
      warehouse_id: extras.warehouse_id || null,
      sku_id: extras.sku_id || null,
      current_value: extras.current_value !== undefined ? extras.current_value : null,
      required_value: extras.required_value !== undefined ? extras.required_value : null,
      threshold_value: extras.threshold_value !== undefined ? extras.threshold_value : null
    };
  }

  /**
   * 检查源/目标仓库存在且状态为 ACTIVE，以及源≠目标
   * @param {?number} sourceWarehouseId - 源仓库 ID（单仓路径必填，多仓为 null）
   * @param {number} targetWarehouseId - 目标仓库 ID（必填）
   * @returns {Promise<Violation[]>} 违规列表
   */
  async checkWarehousesExist(sourceWarehouseId, targetWarehouseId) {
    const violations = [];

    if (sourceWarehouseId !== null && sourceWarehouseId !== undefined) {
      const sourceWh = await this._getQuery('SELECT id, name, status FROM warehouses WHERE id = ?', [sourceWarehouseId]);
      if (!sourceWh) {
        violations.push(this.createViolation(
          this.VIOLATION_TYPES.WAREHOUSE_NOT_EXIST,
          this.SEVERITY.FATAL,
          `源仓库(ID: ${sourceWarehouseId})不存在`,
          { warehouse_id: sourceWarehouseId }
        ));
      } else if (sourceWh.status !== 'ACTIVE') {
        violations.push(this.createViolation(
          this.VIOLATION_TYPES.WAREHOUSE_NOT_EXIST,
          this.SEVERITY.FATAL,
          `源仓库(${sourceWh.name})状态非激活`,
          { warehouse_id: sourceWarehouseId }
        ));
      }
    }

    const targetWh = await this._getQuery('SELECT id, name, status FROM warehouses WHERE id = ?', [targetWarehouseId]);
    if (!targetWh) {
      violations.push(this.createViolation(
        this.VIOLATION_TYPES.WAREHOUSE_NOT_EXIST,
        this.SEVERITY.FATAL,
        `目标仓库(ID: ${targetWarehouseId})不存在`,
        { warehouse_id: targetWarehouseId }
      ));
    } else if (targetWh.status !== 'ACTIVE') {
      violations.push(this.createViolation(
        this.VIOLATION_TYPES.WAREHOUSE_NOT_EXIST,
        this.SEVERITY.FATAL,
        `目标仓库(${targetWh.name})状态非激活`,
        { warehouse_id: targetWarehouseId }
      ));
    }

    if (sourceWarehouseId && targetWarehouseId && sourceWarehouseId == targetWarehouseId) {
      violations.push(this.createViolation(
        this.VIOLATION_TYPES.SAME_WAREHOUSE,
        this.SEVERITY.FATAL,
        '源仓库和目标仓库不能相同'
      ));
    }

    return violations;
  }

  /**
   * 单仓路径下对单个 SKU 进行 6 类约束检查
   * @param {number} sourceWarehouseId - 源仓库 ID
   * @param {number} targetWarehouseId - 目标仓库 ID
   * @param {number} skuId - SKU ID
   * @param {number} requestedQty - 调拨数量
   * @returns {Promise<{violations: Violation[], details: object}>}
   */
  async checkSingleItemTransfer(sourceWarehouseId, targetWarehouseId, skuId, requestedQty) {
    const violations = [];
    const details = {};

    if (requestedQty <= 0) {
      violations.push(this.createViolation(
        this.VIOLATION_TYPES.NEGATIVE_QTY,
        this.SEVERITY.FATAL,
        '调拨数量必须大于0',
        { sku_id: skuId, required_value: requestedQty }
      ));
      return { violations, details };
    }

    const sku = await this._getQuery('SELECT id, sku_code, name, unit FROM skus WHERE id = ?', [skuId]);
    if (!sku) {
      violations.push(this.createViolation(
        this.VIOLATION_TYPES.SKU_NOT_EXIST,
        this.SEVERITY.FATAL,
        `SKU(ID: ${skuId})不存在`,
        { sku_id: skuId }
      ));
      return { violations, details };
    }

    const sourceInv = await this._getQuery(
      'SELECT * FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [sourceWarehouseId, skuId]
    );
    const targetInv = await this._getQuery(
      'SELECT * FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [targetWarehouseId, skuId]
    );

    details.sku = sku;
    details.sourceInventory = sourceInv || null;
    details.targetInventory = targetInv || null;

    const sourceAvailable = sourceInv ? sourceInv.available_qty : 0;
    details.sourceAvailable = sourceAvailable;

    if (sourceAvailable < requestedQty) {
      violations.push(this.createViolation(
        this.VIOLATION_TYPES.SOURCE_INSUFFICIENT,
        this.SEVERITY.WARNING,
        `${sku.sku_code} ${sku.name} 源仓库可用库存(${sourceAvailable}${sku.unit})不足调拨需求(${requestedQty}${sku.unit})`,
        {
          warehouse_id: sourceWarehouseId,
          sku_id: skuId,
          current_value: sourceAvailable,
          required_value: requestedQty,
          threshold_value: requestedQty
        }
      ));
    }

    const sourceAfter = sourceAvailable - requestedQty;
    details.sourceAfter = sourceAfter;
    const sourceMinStock = sourceInv ? sourceInv.min_stock : 0;
    details.sourceMinStock = sourceMinStock;

    if (sourceAfter < sourceMinStock) {
      violations.push(this.createViolation(
        this.VIOLATION_TYPES.SOURCE_AFTER_MIN,
        this.SEVERITY.WARNING,
        `${sku.sku_code} ${sku.name} 调拨后源仓库库存(${sourceAfter}${sku.unit})将低于安全库存(${sourceMinStock}${sku.unit})`,
        {
          warehouse_id: sourceWarehouseId,
          sku_id: skuId,
          current_value: sourceAfter,
          threshold_value: sourceMinStock,
          required_value: sourceMinStock
        }
      ));
    }

    if (sourceInv && sourceAvailable <= sourceInv.min_stock) {
      violations.push(this.createViolation(
        this.VIOLATION_TYPES.SOURCE_MIN_STOCK,
        this.SEVERITY.INFO,
        `${sku.sku_code} ${sku.name} 源仓库当前库存(${sourceAvailable}${sku.unit})已处于或低于安全库存线`,
        {
          warehouse_id: sourceWarehouseId,
          sku_id: skuId,
          current_value: sourceAvailable,
          threshold_value: sourceInv.min_stock
        }
      ));
    }

    const targetCurrent = targetInv ? targetInv.available_qty : 0;
    const targetAfter = targetCurrent + requestedQty;
    details.targetCurrent = targetCurrent;
    details.targetAfter = targetAfter;

    if (targetInv && targetInv.max_stock && targetAfter > targetInv.max_stock) {
      violations.push(this.createViolation(
        this.VIOLATION_TYPES.TARGET_OVER_MAX,
        this.SEVERITY.WARNING,
        `${sku.sku_code} ${sku.name} 调拨后目标仓库库存(${targetAfter}${sku.unit})将超过最大库存限制(${targetInv.max_stock}${sku.unit})`,
        {
          warehouse_id: targetWarehouseId,
          sku_id: skuId,
          current_value: targetAfter,
          threshold_value: targetInv.max_stock
        }
      ));
    }

    return { violations, details };
  }

  /**
   * 多仓路径下为单个 SKU 寻找最佳源仓库组合
   * 优先级排序规则：
   *   1. 中心仓（CENTER）优先；2. 可调拨余量(available-min_stock)降序；3. 可用量降序
   * 安全库存保护：调拨后不击穿单仓安全库存线
   * @param {number} skuId - SKU ID
   * @param {number} requestedQty - 需求总量
   * @param {?number} [excludeWarehouseId=null] - 排除仓库（通常为目标仓）
   * @returns {Promise<{sources:Array, shortage:number, totalAllocated:number}>}
   */
  async findBestSourceWarehouses(skuId, requestedQty, excludeWarehouseId = null) {
    let sql = `
      SELECT
        w.id as warehouse_id,
        w.code as warehouse_code,
        w.name as warehouse_name,
        w.type as warehouse_type,
        i.available_qty,
        i.min_stock,
        i.max_stock,
        (i.available_qty - i.min_stock) as transferable_qty
      FROM inventory i
      INNER JOIN warehouses w ON i.warehouse_id = w.id
      WHERE i.sku_id = ? AND w.status = 'ACTIVE' AND i.available_qty > 0
    `;
    const params = [skuId];

    if (excludeWarehouseId) {
      sql += ' AND i.warehouse_id != ?';
      params.push(excludeWarehouseId);
    }

    sql += ' ORDER BY w.type = \'CENTER\' DESC, (i.available_qty - i.min_stock) DESC, i.available_qty DESC';

    const sources = await this._allQuery(sql, params);

    const results = [];
    let remainingQty = requestedQty;

    for (const source of sources) {
      if (remainingQty <= 0) break;

      const transferable = Math.max(0, source.transferable_qty);
      const canTake = Math.min(transferable, remainingQty);

      if (canTake > 0) {
        const warnings = [];
        if (source.available_qty < requestedQty) {
          warnings.push(`该仓库最多可调出 ${canTake}，需多仓调拨`);
        }
        if ((source.available_qty - canTake) < source.min_stock) {
          warnings.push(`调拨后将低于安全库存线`);
        }

        results.push({
          ...source,
          allocated_qty: canTake,
          after_qty: source.available_qty - canTake,
          warnings
        });
        remainingQty -= canTake;
      }
    }

    const shortage = remainingQty > 0 ? remainingQty : 0;
    return { sources: results, shortage, totalAllocated: requestedQty - shortage };
  }

  /**
   * 对完整调拨申请执行 8 类约束检查（入口方法）
   * @param {Object} request - 调拨申请
   * @param {?number} request.source_warehouse_id - 源仓（单仓）/null 触发多仓
   * @param {number} request.target_warehouse_id - 目标仓
   * @param {Array<{sku_id:number, requested_qty:number}>} request.items - 明细
   * @returns {Promise<{passed:boolean, summary:string, fatalCount:number, warningCount:number, infoCount:number, violations:Violation[], itemResults:Array}>}
   */
  async checkTransferRequest(request) {
    const { source_warehouse_id, target_warehouse_id, items } = request;
    const allViolations = [];
    const itemResults = [];

    const whViolations = await this.checkWarehousesExist(source_warehouse_id, target_warehouse_id);
    allViolations.push(...whViolations);

    if (whViolations.some(v => v.severity === this.SEVERITY.FATAL)) {
      return this.buildResult(allViolations, itemResults);
    }

    for (const item of items) {
      if (source_warehouse_id) {
        const { violations, details } = await this.checkSingleItemTransfer(
          source_warehouse_id,
          target_warehouse_id,
          item.sku_id,
          item.requested_qty
        );
        allViolations.push(...violations);
        itemResults.push({
          sku_id: item.sku_id,
          requested_qty: item.requested_qty,
          violations,
          details,
          source_warehouse_id,
          planned_qty: details.sourceAvailable >= item.requested_qty ? item.requested_qty : details.sourceAvailable,
          shortage: Math.max(0, item.requested_qty - (details.sourceAvailable || 0))
        });
      } else {
        const { sources, shortage, totalAllocated } = await this.findBestSourceWarehouses(
          item.sku_id,
          item.requested_qty,
          target_warehouse_id
        );
        const sku = await this._getQuery('SELECT sku_code, name, unit FROM skus WHERE id = ?', [item.sku_id]);

        if (shortage > 0) {
          allViolations.push(this.createViolation(
            this.VIOLATION_TYPES.SOURCE_INSUFFICIENT,
            this.SEVERITY.WARNING,
            `${sku ? sku.sku_code : `SKU_${item.sku_id}`} 全网可用库存不足，短缺 ${shortage}${sku ? sku.unit : ''}`,
            { sku_id: item.sku_id, current_value: totalAllocated, required_value: item.requested_qty }
          ));
        }

        for (const src of sources) {
          if ((src.after_qty) < src.min_stock && src.after_qty >= 0) {
            allViolations.push(this.createViolation(
              this.VIOLATION_TYPES.SOURCE_AFTER_MIN,
              this.SEVERITY.WARNING,
              `${sku ? sku.sku_code : ''} 从${src.warehouse_name}调拨${src.allocated_qty}后将低于安全库存`,
              { warehouse_id: src.warehouse_id, sku_id: item.sku_id, current_value: src.after_qty, threshold_value: src.min_stock }
            ));
          }
        }

        itemResults.push({
          sku_id: item.sku_id,
          requested_qty: item.requested_qty,
          sources,
          shortage,
          totalAllocated
        });
      }
    }

    return this.buildResult(allViolations, itemResults);
  }

  /**
   * 组装最终检查结果（计数、通过与否、摘要文本）
   * @param {Violation[]} violations - 所有违规
   * @param {object[]} itemResults - 每个 SKU 的逐行结果
   * @returns {{passed:boolean, summary:string, fatalCount:number, warningCount:number, infoCount:number, violations:Violation[], itemResults:object[]}}
   */
  buildResult(violations, itemResults) {
    const fatalCount = violations.filter(v => v.severity === this.SEVERITY.FATAL).length;
    const warningCount = violations.filter(v => v.severity === this.SEVERITY.WARNING).length;
    const infoCount = violations.filter(v => v.severity === this.SEVERITY.INFO).length;

    const passed = fatalCount === 0;
    let summary = passed
      ? (warningCount > 0 ? `检查通过，存在${warningCount}条警告` : '检查完全通过')
      : `检查失败，存在${fatalCount}条严重错误`;

    return {
      passed,
      summary,
      fatalCount,
      warningCount,
      infoCount,
      violations,
      itemResults
    };
  }
}

module.exports = new ConstraintCheckService();
