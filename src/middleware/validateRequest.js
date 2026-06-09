const { body, param, query, validationResult } = require('express-validator');

const REQUEST_STATUSES = ['DRAFT', 'SUBMITTED', 'PLANNING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'REJECTED'];
const PLAN_STATUSES = ['PENDING', 'CONFIRMED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'CANCELLED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const REQUEST_TYPES = ['NORMAL', 'URGENT', 'TRANSFER', 'RETURN'];
const WAREHOUSE_TYPES = ['CENTER', 'REGIONAL', 'NORMAL', 'TRANSIT'];
const WAREHOUSE_STATUSES = ['ACTIVE', 'INACTIVE', 'MAINTENANCE'];
const CHANGE_TYPES = ['IN', 'OUT', 'RESERVE', 'RELEASE', 'IN_TRANSIT_IN', 'IN_TRANSIT_OUT'];

function validate(validations) {
  return async function validationMiddleware(req, res, next) {
    for (const validation of validations) {
      await validation.run(req);
    }
    const errors = validationResult(req);
    if (errors.isEmpty()) {
      return next();
    }
    const formattedErrors = errors.array({ onlyFirstError: true }).map(e => ({
      path: e.path || e.param,
      message: e.msg,
      value: e.value !== undefined ? e.value : null
    }));
    return res.status(400).json({
      error: '请求参数校验失败',
      code: 'VALIDATION_ERROR',
      errors: formattedErrors
    });
  };
}

const idParam = [param('id').isInt({ min: 1 }).withMessage('ID 必须是正整数')];
const requestIdParam = [param('requestId').isInt({ min: 1 }).withMessage('申请 ID 必须是正整数')];
const warehouseSkuParams = [
  param('warehouse_id').isInt({ min: 1 }).withMessage('仓库 ID 必须是正整数'),
  param('sku_id').isInt({ min: 1 }).withMessage('SKU ID 必须是正整数')
];

const transferRequestCreate = [
  body('target_warehouse_id')
    .exists({ checkNull: true, checkFalsy: true })
    .withMessage('target_warehouse_id 必填')
    .isInt({ min: 1 })
    .withMessage('target_warehouse_id 必须是正整数'),
  body('source_warehouse_id')
    .optional({ nullable: true })
    .isInt({ min: 1 })
    .withMessage('source_warehouse_id 必须是正整数')
    .custom((value, { req }) => {
      if (value !== undefined && value !== null && Number(value) === Number(req.body.target_warehouse_id)) {
        throw new Error('源仓库和目标仓库不能相同');
      }
      return true;
    }),
  body('request_type')
    .optional()
    .isIn(REQUEST_TYPES)
    .withMessage(`request_type 必须是 ${REQUEST_TYPES.join('/')} 之一`),
  body('priority')
    .optional()
    .isIn(PRIORITIES)
    .withMessage(`priority 必须是 ${PRIORITIES.join('/')} 之一`),
  body('requester')
    .optional()
    .isString()
    .withMessage('requester 必须是字符串')
    .isLength({ max: 100 })
    .withMessage('requester 长度不得超过 100'),
  body('department')
    .optional()
    .isString()
    .withMessage('department 必须是字符串')
    .isLength({ max: 100 })
    .withMessage('department 长度不得超过 100'),
  body('reason')
    .optional()
    .isString()
    .withMessage('reason 必须是字符串')
    .isLength({ max: 500 })
    .withMessage('reason 长度不得超过 500'),
  body('expected_date')
    .optional({ nullable: true })
    .isISO8601()
    .withMessage('expected_date 必须是 ISO 8601 日期格式'),
  body('items')
    .exists({ checkNull: true })
    .withMessage('items 必填')
    .isArray({ min: 1 })
    .withMessage('items 必须是非空数组')
    .custom((items) => {
      if (!Array.isArray(items)) return true;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || typeof item !== 'object') {
          throw new Error(`items[${i}] 必须是对象`);
        }
        if (item.sku_id === undefined || item.sku_id === null ||
            !Number.isInteger(Number(item.sku_id)) || Number(item.sku_id) <= 0) {
          throw new Error(`items[${i}].sku_id 必填且必须是正整数`);
        }
        if (item.requested_qty === undefined || item.requested_qty === null) {
          throw new Error(`items[${i}].requested_qty 必填`);
        }
        const qty = Number(item.requested_qty);
        if (Number.isNaN(qty) || qty <= 0) {
          throw new Error(`items[${i}].requested_qty 必须是大于0的数字`);
        }
        if (item.unit_price !== undefined && item.unit_price !== null) {
          const up = Number(item.unit_price);
          if (Number.isNaN(up) || up < 0) {
            throw new Error(`items[${i}].unit_price 必须是非负数`);
          }
        }
        if (item.remark !== undefined && typeof item.remark !== 'string') {
          throw new Error(`items[${i}].remark 必须是字符串`);
        }
      }
      return true;
    }),
  body('auto_submit')
    .optional()
    .isBoolean()
    .withMessage('auto_submit 必须是布尔值')
];

const transferRequestUpdate = [
  ...idParam,
  body('target_warehouse_id')
    .optional({ nullable: true })
    .isInt({ min: 1 })
    .withMessage('target_warehouse_id 必须是正整数'),
  body('source_warehouse_id')
    .optional({ nullable: true })
    .isInt({ min: 1 })
    .withMessage('source_warehouse_id 必须是正整数'),
  body('request_type')
    .optional()
    .isIn(REQUEST_TYPES)
    .withMessage(`request_type 必须是 ${REQUEST_TYPES.join('/')} 之一`),
  body('priority')
    .optional()
    .isIn(PRIORITIES)
    .withMessage(`priority 必须是 ${PRIORITIES.join('/')} 之一`),
  body('requester')
    .optional()
    .isString()
    .withMessage('requester 必须是字符串'),
  body('department')
    .optional()
    .isString()
    .withMessage('department 必须是字符串'),
  body('reason')
    .optional()
    .isString()
    .withMessage('reason 必须是字符串'),
  body('expected_date')
    .optional({ nullable: true })
    .isISO8601()
    .withMessage('expected_date 必须是 ISO 8601 日期格式'),
  body('items')
    .optional()
    .isArray({ min: 1 })
    .withMessage('items 必须是非空数组')
    .custom((items) => {
      if (!Array.isArray(items)) return true;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || typeof item !== 'object') {
          throw new Error(`items[${i}] 必须是对象`);
        }
        if (item.sku_id === undefined || item.sku_id === null ||
            !Number.isInteger(Number(item.sku_id)) || Number(item.sku_id) <= 0) {
          throw new Error(`items[${i}].sku_id 必填且必须是正整数`);
        }
        if (item.requested_qty === undefined || item.requested_qty === null) {
          throw new Error(`items[${i}].requested_qty 必填`);
        }
        const qty = Number(item.requested_qty);
        if (Number.isNaN(qty) || qty <= 0) {
          throw new Error(`items[${i}].requested_qty 必须是大于0的数字`);
        }
      }
      return true;
    })
];

const transferPlanConfirm = [
  ...idParam,
  body('review_comment')
    .optional()
    .isString()
    .withMessage('review_comment 必须是字符串')
    .isLength({ max: 500 })
    .withMessage('review_comment 长度不得超过 500'),
  body('operator')
    .optional()
    .isString()
    .withMessage('operator 必须是字符串')
    .isLength({ max: 50 })
    .withMessage('operator 长度不得超过 50')
];

const transferPlanReject = [
  ...idParam,
  body('review_comment')
    .optional()
    .isString()
    .withMessage('review_comment 必须是字符串')
    .isLength({ max: 500 })
    .withMessage('review_comment 长度不得超过 500'),
  body('planner')
    .optional()
    .isString()
    .withMessage('planner 必须是字符串')
    .isLength({ max: 50 })
    .withMessage('planner 长度不得超过 50')
];

const transferPlanExecute = [
  ...idParam,
  body('operator')
    .optional()
    .isString()
    .withMessage('operator 必须是字符串')
    .isLength({ max: 50 })
    .withMessage('operator 长度不得超过 50')
];

const transferPlanGenerate = [
  ...requestIdParam,
  body('planner')
    .optional()
    .isString()
    .withMessage('planner 必须是字符串')
    .isLength({ max: 50 })
    .withMessage('planner 长度不得超过 50')
];

const warehouseCreate = [
  body('code')
    .exists({ checkNull: true, checkFalsy: true })
    .withMessage('code 必填')
    .isString()
    .withMessage('code 必须是字符串')
    .isLength({ min: 1, max: 50 })
    .withMessage('code 长度应为 1-50'),
  body('name')
    .exists({ checkNull: true, checkFalsy: true })
    .withMessage('name 必填')
    .isString()
    .withMessage('name 必须是字符串')
    .isLength({ min: 1, max: 100 })
    .withMessage('name 长度应为 1-100'),
  body('location')
    .optional()
    .isString()
    .withMessage('location 必须是字符串')
    .isLength({ max: 200 })
    .withMessage('location 长度不得超过 200'),
  body('type')
    .optional()
    .isIn(WAREHOUSE_TYPES)
    .withMessage(`type 必须是 ${WAREHOUSE_TYPES.join('/')} 之一`),
  body('status')
    .optional()
    .isIn(WAREHOUSE_STATUSES)
    .withMessage(`status 必须是 ${WAREHOUSE_STATUSES.join('/')} 之一`),
  body('min_security_stock')
    .optional()
    .isNumeric()
    .withMessage('min_security_stock 必须是数字')
    .custom((v) => Number(v) >= 0)
    .withMessage('min_security_stock 必须是非负数')
];

const warehouseUpdate = [
  ...idParam,
  body('code')
    .optional({ checkFalsy: true })
    .isString()
    .withMessage('code 必须是字符串')
    .isLength({ min: 1, max: 50 })
    .withMessage('code 长度应为 1-50'),
  body('name')
    .optional({ checkFalsy: true })
    .isString()
    .withMessage('name 必须是字符串')
    .isLength({ min: 1, max: 100 })
    .withMessage('name 长度应为 1-100'),
  body('location')
    .optional()
    .isString()
    .withMessage('location 必须是字符串'),
  body('type')
    .optional()
    .isIn(WAREHOUSE_TYPES)
    .withMessage(`type 必须是 ${WAREHOUSE_TYPES.join('/')} 之一`),
  body('status')
    .optional()
    .isIn(WAREHOUSE_STATUSES)
    .withMessage(`status 必须是 ${WAREHOUSE_STATUSES.join('/')} 之一`),
  body('min_security_stock')
    .optional()
    .isNumeric()
    .withMessage('min_security_stock 必须是数字')
    .custom((v) => Number(v) >= 0)
    .withMessage('min_security_stock 必须是非负数')
];

const inventoryCreate = [
  body('warehouse_id')
    .exists({ checkNull: true, checkFalsy: true })
    .withMessage('warehouse_id 必填')
    .isInt({ min: 1 })
    .withMessage('warehouse_id 必须是正整数'),
  body('sku_id')
    .exists({ checkNull: true, checkFalsy: true })
    .withMessage('sku_id 必填')
    .isInt({ min: 1 })
    .withMessage('sku_id 必须是正整数'),
  body('available_qty')
    .optional()
    .isNumeric()
    .withMessage('available_qty 必须是数字')
    .custom((v) => Number(v) >= 0)
    .withMessage('available_qty 必须是非负数'),
  body('reserved_qty')
    .optional()
    .isNumeric()
    .withMessage('reserved_qty 必须是数字')
    .custom((v) => Number(v) >= 0)
    .withMessage('reserved_qty 必须是非负数'),
  body('in_transit_qty')
    .optional()
    .isNumeric()
    .withMessage('in_transit_qty 必须是数字')
    .custom((v) => Number(v) >= 0)
    .withMessage('in_transit_qty 必须是非负数'),
  body('min_stock')
    .optional()
    .isNumeric()
    .withMessage('min_stock 必须是数字')
    .custom((v) => Number(v) >= 0)
    .withMessage('min_stock 必须是非负数'),
  body('max_stock')
    .optional({ nullable: true })
    .isNumeric()
    .withMessage('max_stock 必须是数字')
    .custom((v) => v === null || Number(v) >= 0)
    .withMessage('max_stock 必须是非负数或 null')
];

const inventoryUpdate = [
  ...warehouseSkuParams,
  body('available_qty')
    .optional()
    .isNumeric()
    .withMessage('available_qty 必须是数字')
    .custom((v) => Number(v) >= 0)
    .withMessage('available_qty 必须是非负数'),
  body('reserved_qty')
    .optional()
    .isNumeric()
    .withMessage('reserved_qty 必须是数字')
    .custom((v) => Number(v) >= 0)
    .withMessage('reserved_qty 必须是非负数'),
  body('in_transit_qty')
    .optional()
    .isNumeric()
    .withMessage('in_transit_qty 必须是数字')
    .custom((v) => Number(v) >= 0)
    .withMessage('in_transit_qty 必须是非负数'),
  body('min_stock')
    .optional()
    .isNumeric()
    .withMessage('min_stock 必须是数字')
    .custom((v) => Number(v) >= 0)
    .withMessage('min_stock 必须是非负数'),
  body('max_stock')
    .optional({ nullable: true })
    .isNumeric()
    .withMessage('max_stock 必须是数字')
    .custom((v) => v === null || Number(v) >= 0)
    .withMessage('max_stock 必须是非负数或 null')
];

const inventoryAdjust = [
  body('adjustments')
    .exists({ checkNull: true })
    .withMessage('adjustments 必填')
    .isArray({ min: 1 })
    .withMessage('adjustments 必须是非空数组')
    .custom((adjustments) => {
      if (!Array.isArray(adjustments)) return true;
      for (let i = 0; i < adjustments.length; i++) {
        const adj = adjustments[i];
        if (!adj || typeof adj !== 'object') {
          throw new Error(`adjustments[${i}] 必须是对象`);
        }
        if (adj.warehouse_id === undefined || adj.warehouse_id === null ||
            !Number.isInteger(Number(adj.warehouse_id)) || Number(adj.warehouse_id) <= 0) {
          throw new Error(`adjustments[${i}].warehouse_id 必填且必须是正整数`);
        }
        if (adj.sku_id === undefined || adj.sku_id === null ||
            !Number.isInteger(Number(adj.sku_id)) || Number(adj.sku_id) <= 0) {
          throw new Error(`adjustments[${i}].sku_id 必填且必须是正整数`);
        }
        if (adj.qty_change === undefined || adj.qty_change === null) {
          throw new Error(`adjustments[${i}].qty_change 必填`);
        }
        const qty = Number(adj.qty_change);
        if (Number.isNaN(qty)) {
          throw new Error(`adjustments[${i}].qty_change 必须是数字`);
        }
        if (adj.change_type !== undefined && !CHANGE_TYPES.includes(adj.change_type)) {
          throw new Error(`adjustments[${i}].change_type 必须是 ${CHANGE_TYPES.join('/')} 之一`);
        }
      }
      return true;
    }),
  body('operator')
    .optional()
    .isString()
    .withMessage('operator 必须是字符串'),
  body('remark')
    .optional()
    .isString()
    .withMessage('remark 必须是字符串')
];

const transferRecordQuery = [
  query('source_warehouse_id').optional().isInt({ min: 1 }).withMessage('source_warehouse_id 必须是正整数'),
  query('target_warehouse_id').optional().isInt({ min: 1 }).withMessage('target_warehouse_id 必须是正整数'),
  query('sku_id').optional().isInt({ min: 1 }).withMessage('sku_id 必须是正整数'),
  query('plan_id').optional().isInt({ min: 1 }).withMessage('plan_id 必须是正整数'),
  query('request_id').optional().isInt({ min: 1 }).withMessage('request_id 必须是正整数'),
  query('page').optional().isInt({ min: 1 }).withMessage('page 必须是正整数'),
  query('pageSize').optional().isInt({ min: 1, max: 1000 }).withMessage('pageSize 必须是 1-1000 的整数')
];

const warehouseQuery = [
  query('status').optional().isIn(WAREHOUSE_STATUSES).withMessage(`status 必须是 ${WAREHOUSE_STATUSES.join('/')} 之一`),
  query('type').optional().isIn(WAREHOUSE_TYPES).withMessage(`type 必须是 ${WAREHOUSE_TYPES.join('/')} 之一`),
  query('keyword').optional().isString().withMessage('keyword 必须是字符串')
];

const inventoryQuery = [
  query('warehouse_id').optional().isInt({ min: 1 }).withMessage('warehouse_id 必须是正整数'),
  query('sku_id').optional().isInt({ min: 1 }).withMessage('sku_id 必须是正整数'),
  query('low_stock').optional().isIn(['true', 'false']).withMessage('low_stock 必须是 true/false'),
  query('page').optional().isInt({ min: 1 }).withMessage('page 必须是正整数'),
  query('pageSize').optional().isInt({ min: 1, max: 1000 }).withMessage('pageSize 必须是 1-1000 的整数')
];

module.exports = {
  validate,
  REQUEST_STATUSES,
  PLAN_STATUSES,
  PRIORITIES,
  WAREHOUSE_TYPES,
  WAREHOUSE_STATUSES,
  CHANGE_TYPES,
  rules: {
    idParam,
    requestIdParam,
    warehouseSkuParams,
    warehouseQuery,
    inventoryQuery,
    transferRecordQuery,
    transferRequestCreate,
    transferRequestUpdate,
    transferPlanGenerate,
    transferPlanConfirm,
    transferPlanReject,
    transferPlanExecute,
    warehouseCreate,
    warehouseUpdate,
    inventoryCreate,
    inventoryUpdate,
    inventoryAdjust
  }
};
