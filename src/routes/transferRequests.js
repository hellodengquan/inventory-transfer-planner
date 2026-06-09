/**
 * 调拨申请路由模块
 * @module src/routes/transferRequests
 * @description 提供调拨申请的 CRUD、状态流转（提交/取消/删除）、
 *              约束检查预览等接口。创建接口挂载 transferRequestCreate 校验规则；
 *              状态流转遵循状态机约束，允许 DRAFT→SUBMITTED→PLANNING→APPROVED→COMPLETED
 */

const express = require('express');
const router = express.Router();
const { runQuery, getQuery, allQuery, db } = require('../db/database');
const constraintCheckService = require('../services/constraintCheckService');
const { validate, rules } = require('../middleware/validateRequest');

function generateRequestNo() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `TR-${yyyy}${mm}${dd}-${rand}`;
}

router.get('/', async (req, res, next) => {
  try {
    const { status, priority, source_warehouse_id, target_warehouse_id, keyword, page = 1, pageSize = 50 } = req.query;
    let sql = `
      SELECT
        tr.*,
        sw.code as source_warehouse_code,
        sw.name as source_warehouse_name,
        tw.code as target_warehouse_code,
        tw.name as target_warehouse_name
      FROM transfer_requests tr
      LEFT JOIN warehouses sw ON tr.source_warehouse_id = sw.id
      INNER JOIN warehouses tw ON tr.target_warehouse_id = tw.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      sql += ' AND tr.status = ?';
      params.push(status);
    }
    if (priority) {
      sql += ' AND tr.priority = ?';
      params.push(priority);
    }
    if (source_warehouse_id) {
      sql += ' AND tr.source_warehouse_id = ?';
      params.push(source_warehouse_id);
    }
    if (target_warehouse_id) {
      sql += ' AND tr.target_warehouse_id = ?';
      params.push(target_warehouse_id);
    }
    if (keyword) {
      sql += ' AND (tr.request_no LIKE ? OR tr.reason LIKE ? OR tr.requester LIKE ? OR tr.department LIKE ?)';
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw, kw);
    }

    const countSql = `SELECT COUNT(*) as total FROM (${sql})`;
    const countResult = await getQuery(countSql, params);
    const total = countResult.total;

    sql += ' ORDER BY tr.created_at DESC, tr.id DESC';
    const offset = (page - 1) * pageSize;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(Number(pageSize), Number(offset));

    const requests = await allQuery(sql, params);
    res.json({
      data: requests,
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
      DRAFT: '草稿',
      SUBMITTED: '已提交',
      PLANNING: '规划中',
      APPROVED: '已审批',
      PROCESSING: '执行中',
      COMPLETED: '已完成',
      CANCELLED: '已取消',
      REJECTED: '已驳回'
    }
  });
});

router.get('/:id', async (req, res, next) => {
  try {
    const request = await getQuery(`
      SELECT
        tr.*,
        sw.code as source_warehouse_code,
        sw.name as source_warehouse_name,
        tw.code as target_warehouse_code,
        tw.name as target_warehouse_name
      FROM transfer_requests tr
      LEFT JOIN warehouses sw ON tr.source_warehouse_id = sw.id
      INNER JOIN warehouses tw ON tr.target_warehouse_id = tw.id
      WHERE tr.id = ?
    `, [req.params.id]);

    if (!request) {
      return res.status(404).json({ error: '调拨申请不存在', code: 'REQUEST_NOT_FOUND' });
    }

    const items = await allQuery(`
      SELECT
        tri.*,
        s.sku_code,
        s.name as sku_name,
        s.category,
        s.unit,
        s.spec
      FROM transfer_request_items tri
      INNER JOIN skus s ON tri.sku_id = s.id
      WHERE tri.request_id = ?
      ORDER BY tri.id
    `, [req.params.id]);

    const plans = await allQuery(`
      SELECT * FROM transfer_plans WHERE request_id = ? ORDER BY id DESC
    `, [req.params.id]);

    res.json({
      data: {
        ...request,
        items,
        plans
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(rules.transferRequestCreate), async (req, res, next) => {
  try {
    const {
      source_warehouse_id,
      target_warehouse_id,
      request_type = 'NORMAL',
      priority = 'NORMAL',
      requester,
      department,
      reason,
      expected_date,
      items,
      auto_submit = false
    } = req.body;

    if (!target_warehouse_id) {
      return res.status(400).json({ error: '目标仓库必填', code: 'INVALID_INPUT' });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: '调拨明细不能为空', code: 'INVALID_INPUT' });
    }

    const targetWh = await getQuery('SELECT id FROM warehouses WHERE id = ? AND status = \'ACTIVE\'', [target_warehouse_id]);
    if (!targetWh) {
      return res.status(400).json({ error: '目标仓库不存在或未激活', code: 'WAREHOUSE_INVALID' });
    }
    if (source_warehouse_id) {
      const sourceWh = await getQuery('SELECT id FROM warehouses WHERE id = ? AND status = \'ACTIVE\'', [source_warehouse_id]);
      if (!sourceWh) {
        return res.status(400).json({ error: '源仓库不存在或未激活', code: 'WAREHOUSE_INVALID' });
      }
      if (source_warehouse_id == target_warehouse_id) {
        return res.status(400).json({ error: '源仓库和目标仓库不能相同', code: 'INVALID_INPUT' });
      }
    }

    for (const item of items) {
      if (!item.sku_id || !item.requested_qty || item.requested_qty <= 0) {
        return res.status(400).json({ error: '明细SKU和数量(大于0)必填', code: 'INVALID_INPUT' });
      }
      const sku = await getQuery('SELECT id FROM skus WHERE id = ?', [item.sku_id]);
      if (!sku) {
        return res.status(400).json({ error: `SKU(ID: ${item.sku_id})不存在`, code: 'SKU_NOT_FOUND' });
      }
    }

    const request_no = generateRequestNo();
    const status = auto_submit ? 'SUBMITTED' : 'DRAFT';
    const total_qty = items.reduce((sum, item) => sum + Number(item.requested_qty), 0);
    const total_skus = items.length;

    const result = await new Promise((resolve, reject) => {
      db.serialize(async () => {
        db.run('BEGIN TRANSACTION');
        try {
          const reqResult = await runQuery(
            `INSERT INTO transfer_requests
              (request_no, source_warehouse_id, target_warehouse_id, request_type, priority, status,
               requester, department, reason, expected_date, total_qty, total_skus)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [request_no, source_warehouse_id || null, target_warehouse_id, request_type, priority, status,
             requester || '', department || '', reason || '', expected_date || null, total_qty, total_skus]
          );

          for (const item of items) {
            await runQuery(
              'INSERT INTO transfer_request_items (request_id, sku_id, requested_qty, unit_price, remark) VALUES (?, ?, ?, ?, ?)',
              [reqResult.lastID, item.sku_id, item.requested_qty, item.unit_price || 0, item.remark || '']
            );
          }

          db.run('COMMIT', (err) => {
            if (err) reject(err);
            else resolve(reqResult);
          });
        } catch (err) {
          db.run('ROLLBACK', () => reject(err));
        }
      });
    });

    const savedRequest = await getQuery('SELECT * FROM transfer_requests WHERE id = ?', [result.lastID]);
    res.status(201).json({
      data: savedRequest,
      message: auto_submit ? '调拨申请已提交' : '调拨申请已创建'
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validate(rules.transferRequestUpdate), async (req, res, next) => {
  try {
    const existing = await getQuery('SELECT * FROM transfer_requests WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: '调拨申请不存在', code: 'REQUEST_NOT_FOUND' });
    }
    if (['COMPLETED', 'PROCESSING', 'APPROVED'].includes(existing.status)) {
      return res.status(400).json({ error: `当前状态(${existing.status})不允许修改`, code: 'STATUS_NOT_ALLOWED' });
    }

    const {
      source_warehouse_id,
      target_warehouse_id,
      request_type,
      priority,
      requester,
      department,
      reason,
      expected_date,
      items
    } = req.body;

    if (target_warehouse_id) {
      const targetWh = await getQuery('SELECT id FROM warehouses WHERE id = ? AND status = \'ACTIVE\'', [target_warehouse_id]);
      if (!targetWh) {
        return res.status(400).json({ error: '目标仓库不存在或未激活', code: 'WAREHOUSE_INVALID' });
      }
    }

    await new Promise((resolve, reject) => {
      db.serialize(async () => {
        db.run('BEGIN TRANSACTION');
        try {
          await runQuery(
            `UPDATE transfer_requests SET
              source_warehouse_id = ?,
              target_warehouse_id = ?,
              request_type = ?,
              priority = ?,
              requester = ?,
              department = ?,
              reason = ?,
              expected_date = ?,
              updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              source_warehouse_id !== undefined ? source_warehouse_id : existing.source_warehouse_id,
              target_warehouse_id || existing.target_warehouse_id,
              request_type || existing.request_type,
              priority || existing.priority,
              requester !== undefined ? requester : existing.requester,
              department !== undefined ? department : existing.department,
              reason !== undefined ? reason : existing.reason,
              expected_date !== undefined ? expected_date : existing.expected_date,
              req.params.id
            ]
          );

          if (items && Array.isArray(items) && items.length > 0) {
            await runQuery('DELETE FROM transfer_request_items WHERE request_id = ?', [req.params.id]);
            for (const item of items) {
              await runQuery(
                'INSERT INTO transfer_request_items (request_id, sku_id, requested_qty, unit_price, remark) VALUES (?, ?, ?, ?, ?)',
                [req.params.id, item.sku_id, item.requested_qty, item.unit_price || 0, item.remark || '']
              );
            }
            const total_qty = items.reduce((sum, item) => sum + Number(item.requested_qty), 0);
            await runQuery(
              'UPDATE transfer_requests SET total_qty = ?, total_skus = ? WHERE id = ?',
              [total_qty, items.length, req.params.id]
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

    const updated = await getQuery('SELECT * FROM transfer_requests WHERE id = ?', [req.params.id]);
    res.json({ data: updated, message: '调拨申请已更新' });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/submit', async (req, res, next) => {
  try {
    const existing = await getQuery('SELECT * FROM transfer_requests WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: '调拨申请不存在', code: 'REQUEST_NOT_FOUND' });
    }
    if (!['DRAFT', 'REJECTED'].includes(existing.status)) {
      return res.status(400).json({ error: `当前状态(${existing.status})不允许提交`, code: 'STATUS_NOT_ALLOWED' });
    }

    const items = await allQuery('SELECT sku_id, requested_qty FROM transfer_request_items WHERE request_id = ?', [req.params.id]);
    if (items.length === 0) {
      return res.status(400).json({ error: '调拨明细为空，无法提交', code: 'EMPTY_ITEMS' });
    }

    await runQuery(
      'UPDATE transfer_requests SET status = \'SUBMITTED\', updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [req.params.id]
    );

    res.json({ message: '调拨申请已提交' });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/cancel', async (req, res, next) => {
  try {
    const existing = await getQuery('SELECT * FROM transfer_requests WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: '调拨申请不存在', code: 'REQUEST_NOT_FOUND' });
    }
    if (['COMPLETED', 'CANCELLED'].includes(existing.status)) {
      return res.status(400).json({ error: `当前状态(${existing.status})不允许取消`, code: 'STATUS_NOT_ALLOWED' });
    }

    await runQuery(
      'UPDATE transfer_requests SET status = \'CANCELLED\', updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [req.params.id]
    );

    res.json({ message: '调拨申请已取消' });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/check-constraints', async (req, res, next) => {
  try {
    const request = await getQuery('SELECT * FROM transfer_requests WHERE id = ?', [req.params.id]);
    if (!request) {
      return res.status(404).json({ error: '调拨申请不存在', code: 'REQUEST_NOT_FOUND' });
    }

    const items = await allQuery('SELECT sku_id, requested_qty FROM transfer_request_items WHERE request_id = ?', [req.params.id]);
    if (items.length === 0) {
      return res.status(400).json({ error: '调拨明细为空', code: 'EMPTY_ITEMS' });
    }

    const checkResult = await constraintCheckService.checkTransferRequest({
      source_warehouse_id: request.source_warehouse_id,
      target_warehouse_id: request.target_warehouse_id,
      items
    });

    res.json({
      data: checkResult,
      request_id: request.id,
      request_no: request.request_no
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await getQuery('SELECT * FROM transfer_requests WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: '调拨申请不存在', code: 'REQUEST_NOT_FOUND' });
    }
    if (!['DRAFT', 'CANCELLED', 'REJECTED'].includes(existing.status)) {
      return res.status(400).json({ error: `当前状态(${existing.status})不允许删除`, code: 'STATUS_NOT_ALLOWED' });
    }

    const planCount = await getQuery('SELECT COUNT(*) as cnt FROM transfer_plans WHERE request_id = ?', [req.params.id]);
    if (planCount.cnt > 0) {
      return res.status(400).json({ error: '该申请下存在调拨方案，无法删除，请先删除相关方案', code: 'HAS_PLANS' });
    }

    await runQuery('DELETE FROM transfer_requests WHERE id = ?', [req.params.id]);
    res.json({ message: '调拨申请已删除' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
