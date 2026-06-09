const express = require('express');
const router = express.Router();
const { runQuery, getQuery, allQuery, db } = require('../db/database');
const constraintCheckService = require('../services/constraintCheckService');

function generatePlanNo() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `TP-${yyyy}${mm}${dd}-${rand}`;
}

function generateRecordNo() {
  const now = new Date();
  return `TRN-${now.getTime()}-${Math.floor(Math.random() * 1000)}`;
}

router.get('/', async (req, res, next) => {
  try {
    const { status, request_id, page = 1, pageSize = 50 } = req.query;
    let sql = `
      SELECT
        tp.*,
        tr.request_no,
        tr.status as request_status,
        sw.code as source_warehouse_code,
        sw.name as source_warehouse_name,
        tw.code as target_warehouse_code,
        tw.name as target_warehouse_name
      FROM transfer_plans tp
      INNER JOIN transfer_requests tr ON tp.request_id = tr.id
      LEFT JOIN warehouses sw ON tr.source_warehouse_id = sw.id
      INNER JOIN warehouses tw ON tr.target_warehouse_id = tw.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      sql += ' AND tp.status = ?';
      params.push(status);
    }
    if (request_id) {
      sql += ' AND tp.request_id = ?';
      params.push(request_id);
    }

    const countSql = `SELECT COUNT(*) as total FROM (${sql})`;
    const countResult = await getQuery(countSql, params);
    const total = countResult.total;

    sql += ' ORDER BY tp.created_at DESC, tp.id DESC';
    const offset = (page - 1) * pageSize;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(Number(pageSize), Number(offset));

    const plans = await allQuery(sql, params);
    res.json({
      data: plans,
      total,
      page: Number(page),
      pageSize: Number(pageSize),
      totalPages: Math.ceil(total / pageSize)
    });
  } catch (err) {
    next(err);
  }
});

router.get('/statuses', (req, res) => {
  res.json({
    data: {
      PENDING: '待确认',
      CONFIRMED: '已确认',
      REJECTED: '已驳回',
      PROCESSING: '执行中',
      COMPLETED: '已完成',
      CANCELLED: '已取消'
    }
  });
});

router.get('/:id', async (req, res, next) => {
  try {
    const plan = await getQuery(`
      SELECT
        tp.*,
        tr.request_no,
        tr.reason as request_reason,
        tr.priority as request_priority,
        tr.expected_date,
        tr.requester,
        tr.department,
        sw.id as source_warehouse_id,
        sw.code as source_warehouse_code,
        sw.name as source_warehouse_name,
        tw.id as target_warehouse_id,
        tw.code as target_warehouse_code,
        tw.name as target_warehouse_name
      FROM transfer_plans tp
      INNER JOIN transfer_requests tr ON tp.request_id = tr.id
      LEFT JOIN warehouses sw ON tr.source_warehouse_id = sw.id
      INNER JOIN warehouses tw ON tr.target_warehouse_id = tw.id
      WHERE tp.id = ?
    `, [req.params.id]);

    if (!plan) {
      return res.status(404).json({ error: '调拨方案不存在', code: 'PLAN_NOT_FOUND' });
    }

    const items = await allQuery(`
      SELECT
        tpi.*,
        s.sku_code,
        s.name as sku_name,
        s.category,
        s.unit,
        s.spec,
        sw.code as source_wh_code,
        sw.name as source_wh_name,
        tw.code as target_wh_code,
        tw.name as target_wh_name
      FROM transfer_plan_items tpi
      INNER JOIN skus s ON tpi.sku_id = s.id
      INNER JOIN warehouses sw ON tpi.source_warehouse_id = sw.id
      INNER JOIN warehouses tw ON tpi.target_warehouse_id = tw.id
      WHERE tpi.plan_id = ?
      ORDER BY tpi.id
    `, [req.params.id]);

    const violations = await allQuery(`
      SELECT
        cv.*,
        w.code as warehouse_code,
        w.name as warehouse_name,
        s.sku_code,
        s.name as sku_name
      FROM constraint_violations cv
      LEFT JOIN warehouses w ON cv.warehouse_id = w.id
      LEFT JOIN skus s ON cv.sku_id = s.id
      WHERE cv.plan_id = ?
      ORDER BY
        CASE cv.severity
          WHEN 'FATAL' THEN 1
          WHEN 'WARNING' THEN 2
          WHEN 'INFO' THEN 3
          ELSE 4
        END,
        cv.id
    `, [req.params.id]);

    res.json({
      data: {
        ...plan,
        items,
        violations
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/generate/:requestId', async (req, res, next) => {
  try {
    const { planner } = req.body;
    const request = await getQuery('SELECT * FROM transfer_requests WHERE id = ?', [req.params.requestId]);
    if (!request) {
      return res.status(404).json({ error: '调拨申请不存在', code: 'REQUEST_NOT_FOUND' });
    }
    if (!['SUBMITTED', 'PLANNING', 'REJECTED'].includes(request.status)) {
      return res.status(400).json({ error: `申请状态(${request.status})不允许生成方案`, code: 'STATUS_NOT_ALLOWED' });
    }

    const items = await allQuery(`
      SELECT
        tri.id as request_item_id,
        tri.sku_id,
        tri.requested_qty,
        tri.remark
      FROM transfer_request_items tri
      WHERE tri.request_id = ?
    `, [req.params.requestId]);

    if (items.length === 0) {
      return res.status(400).json({ error: '调拨申请明细为空', code: 'EMPTY_ITEMS' });
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
        for (const src of ir.sources) {
          const targetInv = checkResult.violations[0] || null;
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
            shortage_qty: 0,
            warning: src.warnings.join('; ') || null
          });
          total_transfer_qty += src.allocated_qty;
        }
        if (ir.shortage > 0) {
          const lastItem = planItems[planItems.length - 1];
          if (lastItem && lastItem.sku_id === ir.sku_id) {
            lastItem.shortage_qty = ir.shortage;
          }
        }
      }
    }

    const result = await new Promise((resolve, reject) => {
      db.serialize(async () => {
        db.run('BEGIN TRANSACTION');
        try {
          const planResult = await runQuery(
            `INSERT INTO transfer_plans
              (plan_no, request_id, status, plan_type, total_transfer_qty,
               constraint_check_result, constraint_check_passed, planner)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              plan_no,
              request.id,
              'PENDING',
              plan_type,
              total_transfer_qty,
              JSON.stringify({
                passed: checkResult.passed,
                summary: checkResult.summary,
                fatalCount: checkResult.fatalCount,
                warningCount: checkResult.warningCount,
                infoCount: checkResult.infoCount
              }),
              checkResult.passed ? 1 : 0,
              planner || ''
            ]
          );

          for (const pi of planItems) {
            await runQuery(
              `INSERT INTO transfer_plan_items
                (plan_id, request_item_id, sku_id, source_warehouse_id, target_warehouse_id,
                 planned_qty, source_before_qty, source_after_qty, target_before_qty, target_after_qty,
                 shortage_qty, warning)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                planResult.lastID,
                pi.request_item_id,
                pi.sku_id,
                pi.source_warehouse_id,
                pi.target_warehouse_id,
                pi.planned_qty,
                pi.source_before_qty,
                pi.source_after_qty,
                pi.target_before_qty,
                pi.target_after_qty,
                pi.shortage_qty,
                pi.warning
              ]
            );
          }

          for (const v of checkResult.violations) {
            await runQuery(
              `INSERT INTO constraint_violations
                (plan_id, plan_item_id, violation_type, severity, message,
                 warehouse_id, sku_id, current_value, required_value, threshold_value)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                planResult.lastID,
                null,
                v.violation_type,
                v.severity,
                v.message,
                v.warehouse_id,
                v.sku_id,
                v.current_value,
                v.required_value,
                v.threshold_value
              ]
            );
          }

          await runQuery(
            'UPDATE transfer_requests SET status = \'PLANNING\', updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [request.id]
          );

          db.run('COMMIT', (err) => {
            if (err) reject(err);
            else resolve(planResult);
          });
        } catch (err) {
          db.run('ROLLBACK', () => reject(err));
        }
      });
    });

    const savedPlan = await getQuery('SELECT * FROM transfer_plans WHERE id = ?', [result.lastID]);
    res.status(201).json({
      data: savedPlan,
      constraint_check: checkResult,
      message: '调拨方案已生成'
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/confirm', async (req, res, next) => {
  try {
    const { review_comment, operator } = req.body;
    const plan = await getQuery('SELECT * FROM transfer_plans WHERE id = ?', [req.params.id]);
    if (!plan) {
      return res.status(404).json({ error: '调拨方案不存在', code: 'PLAN_NOT_FOUND' });
    }
    if (plan.status !== 'PENDING') {
      return res.status(400).json({ error: `方案状态(${plan.status})不允许确认`, code: 'STATUS_NOT_ALLOWED' });
    }

    const planItems = await allQuery('SELECT * FROM transfer_plan_items WHERE plan_id = ?', [req.params.id]);
    if (planItems.length === 0) {
      return res.status(400).json({ error: '方案明细为空', code: 'EMPTY_ITEMS' });
    }

    await new Promise((resolve, reject) => {
      db.serialize(async () => {
        db.run('BEGIN TRANSACTION');
        try {
          for (const item of planItems) {
            if (item.planned_qty <= 0) continue;

            const sourceInv = await getQuery(
              'SELECT * FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
              [item.source_warehouse_id, item.sku_id]
            );

            if (!sourceInv || sourceInv.available_qty < item.planned_qty) {
              throw new Error(`源仓库库存不足: 仓库${item.source_warehouse_id} SKU${item.sku_id}`);
            }

            await runQuery(
              `UPDATE inventory SET
                available_qty = available_qty - ?,
                in_transit_qty = in_transit_qty + ?,
                updated_at = CURRENT_TIMESTAMP
               WHERE warehouse_id = ? AND sku_id = ?`,
              [item.planned_qty, item.planned_qty, item.source_warehouse_id, item.sku_id]
            );

            const targetInv = await getQuery(
              'SELECT id FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
              [item.target_warehouse_id, item.sku_id]
            );

            if (targetInv) {
              await runQuery(
                `UPDATE inventory SET
                  in_transit_qty = in_transit_qty + ?,
                  updated_at = CURRENT_TIMESTAMP
                 WHERE warehouse_id = ? AND sku_id = ?`,
                [item.planned_qty, item.target_warehouse_id, item.sku_id]
              );
            } else {
              await runQuery(
                `INSERT INTO inventory
                  (warehouse_id, sku_id, available_qty, reserved_qty, in_transit_qty, min_stock)
                 VALUES (?, ?, 0, 0, ?, 0)`,
                [item.target_warehouse_id, item.sku_id, item.planned_qty]
              );
            }

            await runQuery(
              `INSERT INTO transfer_records
                (record_no, plan_id, request_id, source_warehouse_id, target_warehouse_id,
                 sku_id, transfer_qty, operator, remark)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                generateRecordNo(),
                plan.id,
                plan.request_id,
                item.source_warehouse_id,
                item.target_warehouse_id,
                item.sku_id,
                item.planned_qty,
                operator || 'system',
                review_comment || ''
              ]
            );

            await runQuery(
              'UPDATE transfer_request_items SET allocated_qty = allocated_qty + ? WHERE id = ?',
              [item.planned_qty, item.request_item_id]
            );
          }

          await runQuery(
            `UPDATE transfer_plans SET
              status = 'CONFIRMED',
              review_comment = ?,
              confirmed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [review_comment || '', plan.id]
          );

          await runQuery(
            `UPDATE transfer_requests SET
              status = 'APPROVED',
              updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [plan.request_id]
          );

          db.run('COMMIT', (err) => {
            if (err) reject(err);
            else resolve();
          });
        } catch (err) {
          db.run('ROLLBACK', () => reject(err));
        }
      });
    });

    res.json({ message: '调拨方案已确认，库存已更新为在途状态' });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reject', async (req, res, next) => {
  try {
    const { review_comment, planner } = req.body;
    const plan = await getQuery('SELECT * FROM transfer_plans WHERE id = ?', [req.params.id]);
    if (!plan) {
      return res.status(404).json({ error: '调拨方案不存在', code: 'PLAN_NOT_FOUND' });
    }
    if (plan.status !== 'PENDING') {
      return res.status(400).json({ error: `方案状态(${plan.status})不允许驳回`, code: 'STATUS_NOT_ALLOWED' });
    }

    await new Promise((resolve, reject) => {
      db.serialize(async () => {
        db.run('BEGIN TRANSACTION');
        try {
          await runQuery(
            `UPDATE transfer_plans SET
              status = 'REJECTED',
              review_comment = ?,
              rejected_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [review_comment || '', plan.id]
          );

          const pendingCount = await getQuery(
            'SELECT COUNT(*) as cnt FROM transfer_plans WHERE request_id = ? AND status = \'PENDING\'',
            [plan.request_id]
          );
          if (pendingCount.cnt === 0) {
            await runQuery(
              'UPDATE transfer_requests SET status = \'REJECTED\', updated_at = CURRENT_TIMESTAMP WHERE id = ?',
              [plan.request_id]
            );
          }

          db.run('COMMIT', (err) => {
            if (err) reject(err);
            else resolve();
          });
        } catch (err) {
          db.run('ROLLBACK', () => reject(err));
        }
      });
    });

    res.json({ message: '调拨方案已驳回' });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/execute', async (req, res, next) => {
  try {
    const { operator } = req.body;
    const plan = await getQuery('SELECT * FROM transfer_plans WHERE id = ?', [req.params.id]);
    if (!plan) {
      return res.status(404).json({ error: '调拨方案不存在', code: 'PLAN_NOT_FOUND' });
    }
    if (plan.status !== 'CONFIRMED' && plan.status !== 'PROCESSING') {
      return res.status(400).json({ error: `方案状态(${plan.status})不允许执行入库`, code: 'STATUS_NOT_ALLOWED' });
    }

    const planItems = await allQuery('SELECT * FROM transfer_plan_items WHERE plan_id = ?', [req.params.id]);

    await new Promise((resolve, reject) => {
      db.serialize(async () => {
        db.run('BEGIN TRANSACTION');
        try {
          for (const item of planItems) {
            if (item.planned_qty <= 0) continue;

            await runQuery(
              `UPDATE inventory SET
                in_transit_qty = in_transit_qty - ?,
                updated_at = CURRENT_TIMESTAMP
               WHERE warehouse_id = ? AND sku_id = ?`,
              [item.planned_qty, item.source_warehouse_id, item.sku_id]
            );

            await runQuery(
              `UPDATE inventory SET
                available_qty = available_qty + ?,
                in_transit_qty = in_transit_qty - ?,
                updated_at = CURRENT_TIMESTAMP
               WHERE warehouse_id = ? AND sku_id = ?`,
              [item.planned_qty, item.planned_qty, item.target_warehouse_id, item.sku_id]
            );
          }

          await runQuery(
            `UPDATE transfer_plans SET
              status = 'COMPLETED',
              updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [plan.id]
          );

          await runQuery(
            `UPDATE transfer_requests SET
              status = 'COMPLETED',
              updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [plan.request_id]
          );

          db.run('COMMIT', (err) => {
            if (err) reject(err);
            else resolve();
          });
        } catch (err) {
          db.run('ROLLBACK', () => reject(err));
        }
      });
    });

    res.json({ message: '调拨执行完成，已完成出入库操作' });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const plan = await getQuery('SELECT * FROM transfer_plans WHERE id = ?', [req.params.id]);
    if (!plan) {
      return res.status(404).json({ error: '调拨方案不存在', code: 'PLAN_NOT_FOUND' });
    }
    if (!['PENDING', 'REJECTED', 'CANCELLED'].includes(plan.status)) {
      return res.status(400).json({ error: `方案状态(${plan.status})不允许删除`, code: 'STATUS_NOT_ALLOWED' });
    }

    await runQuery('DELETE FROM transfer_plans WHERE id = ?', [req.params.id]);

    const pendingCount = await getQuery(
      'SELECT COUNT(*) as cnt FROM transfer_plans WHERE request_id = ? AND status IN (\'PENDING\', \'CONFIRMED\')',
      [plan.request_id]
    );
    if (pendingCount.cnt === 0) {
      const reqInfo = await getQuery('SELECT status FROM transfer_requests WHERE id = ?', [plan.request_id]);
      if (reqInfo && reqInfo.status === 'PLANNING') {
        await runQuery(
          'UPDATE transfer_requests SET status = \'SUBMITTED\', updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [plan.request_id]
        );
      }
    }

    res.json({ message: '调拨方案已删除' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
