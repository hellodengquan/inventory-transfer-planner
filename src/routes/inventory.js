const express = require('express');
const router = express.Router();
const { runQuery, getQuery, allQuery, db } = require('../db/database');

router.get('/', async (req, res, next) => {
  try {
    const { warehouse_id, sku_id, category, low_stock, keyword, page = 1, pageSize = 100 } = req.query;
    let sql = `
      SELECT
        i.id,
        i.warehouse_id,
        w.code as warehouse_code,
        w.name as warehouse_name,
        i.sku_id,
        s.sku_code,
        s.name as sku_name,
        s.category,
        s.unit,
        s.spec,
        i.available_qty,
        i.reserved_qty,
        i.in_transit_qty,
        (i.available_qty + i.in_transit_qty) as total_qty,
        i.min_stock,
        i.max_stock,
        CASE
          WHEN i.available_qty <= i.min_stock THEN 'LOW'
          WHEN i.max_stock IS NOT NULL AND i.available_qty >= i.max_stock THEN 'HIGH'
          ELSE 'NORMAL'
        END as stock_status,
        i.updated_at
      FROM inventory i
      INNER JOIN warehouses w ON i.warehouse_id = w.id
      INNER JOIN skus s ON i.sku_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (warehouse_id) {
      sql += ' AND i.warehouse_id = ?';
      params.push(warehouse_id);
    }
    if (sku_id) {
      sql += ' AND i.sku_id = ?';
      params.push(sku_id);
    }
    if (category) {
      sql += ' AND s.category = ?';
      params.push(category);
    }
    if (low_stock === 'true') {
      sql += ' AND i.available_qty <= i.min_stock';
    }
    if (keyword) {
      sql += ' AND (s.name LIKE ? OR s.sku_code LIKE ? OR w.name LIKE ? OR w.code LIKE ?)';
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw, kw);
    }

    const countSql = `SELECT COUNT(*) as total FROM (${sql})`;
    const countResult = await getQuery(countSql, params);
    const total = countResult.total;

    sql += ' ORDER BY i.warehouse_id, s.category, s.sku_code';
    const offset = (page - 1) * pageSize;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(Number(pageSize), Number(offset));

    const inventory = await allQuery(sql, params);
    res.json({
      data: inventory,
      total,
      page: Number(page),
      pageSize: Number(pageSize),
      totalPages: Math.ceil(total / pageSize)
    });
  } catch (err) {
    next(err);
  }
});

router.get('/summary', async (req, res, next) => {
  try {
    const { warehouse_id } = req.query;
    let sql = `
      SELECT
        COUNT(DISTINCT i.sku_id) as total_skus,
        SUM(i.available_qty) as total_available,
        SUM(i.reserved_qty) as total_reserved,
        SUM(i.in_transit_qty) as total_in_transit,
        SUM(CASE WHEN i.available_qty <= i.min_stock THEN 1 ELSE 0 END) as low_stock_skus,
        w.id as warehouse_id,
        w.code as warehouse_code,
        w.name as warehouse_name
      FROM inventory i
      INNER JOIN warehouses w ON i.warehouse_id = w.id
    `;
    const params = [];
    if (warehouse_id) {
      sql += ' WHERE i.warehouse_id = ?';
      params.push(warehouse_id);
    }
    sql += ' GROUP BY w.id, w.code, w.name ORDER BY w.id';

    const summary = await allQuery(sql, params);
    res.json({ data: summary });
  } catch (err) {
    next(err);
  }
});

router.get('/low-stock', async (req, res, next) => {
  try {
    const { warehouse_id, threshold } = req.query;
    let sql = `
      SELECT
        i.id,
        i.warehouse_id,
        w.code as warehouse_code,
        w.name as warehouse_name,
        i.sku_id,
        s.sku_code,
        s.name as sku_name,
        s.unit,
        i.available_qty,
        i.min_stock,
        (i.min_stock - i.available_qty) as shortage,
        i.in_transit_qty
      FROM inventory i
      INNER JOIN warehouses w ON i.warehouse_id = w.id
      INNER JOIN skus s ON i.sku_id = s.id
      WHERE i.available_qty <= i.min_stock
    `;
    const params = [];
    if (warehouse_id) {
      sql += ' AND i.warehouse_id = ?';
      params.push(warehouse_id);
    }
    if (threshold) {
      sql += ' AND (i.min_stock - i.available_qty) >= ?';
      params.push(Number(threshold));
    }
    sql += ' ORDER BY shortage DESC, i.available_qty ASC';

    const lowStock = await allQuery(sql, params);
    res.json({ data: lowStock, total: lowStock.length });
  } catch (err) {
    next(err);
  }
});

router.get('/:warehouse_id/:sku_id', async (req, res, next) => {
  try {
    const inv = await getQuery(`
      SELECT
        i.*,
        w.code as warehouse_code,
        w.name as warehouse_name,
        s.sku_code,
        s.name as sku_name,
        s.category,
        s.unit,
        s.spec
      FROM inventory i
      INNER JOIN warehouses w ON i.warehouse_id = w.id
      INNER JOIN skus s ON i.sku_id = s.id
      WHERE i.warehouse_id = ? AND i.sku_id = ?
    `, [req.params.warehouse_id, req.params.sku_id]);

    if (!inv) {
      return res.status(404).json({ error: '库存记录不存在', code: 'INVENTORY_NOT_FOUND' });
    }
    res.json({ data: inv });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { warehouse_id, sku_id, available_qty, reserved_qty, in_transit_qty, min_stock, max_stock } = req.body;
    if (!warehouse_id || !sku_id) {
      return res.status(400).json({ error: '仓库和SKU必填', code: 'INVALID_INPUT' });
    }

    const wh = await getQuery('SELECT id FROM warehouses WHERE id = ?', [warehouse_id]);
    if (!wh) {
      return res.status(400).json({ error: '仓库不存在', code: 'WAREHOUSE_NOT_FOUND' });
    }
    const sku = await getQuery('SELECT id FROM skus WHERE id = ?', [sku_id]);
    if (!sku) {
      return res.status(400).json({ error: 'SKU不存在', code: 'SKU_NOT_FOUND' });
    }

    const existing = await getQuery('SELECT id FROM inventory WHERE warehouse_id = ? AND sku_id = ?', [warehouse_id, sku_id]);
    if (existing) {
      return res.status(400).json({ error: '该仓库SKU库存已存在，请使用更新接口', code: 'DUPLICATE_INVENTORY' });
    }

    const result = await runQuery(
      'INSERT INTO inventory (warehouse_id, sku_id, available_qty, reserved_qty, in_transit_qty, min_stock, max_stock) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        warehouse_id,
        sku_id,
        available_qty || 0,
        reserved_qty || 0,
        in_transit_qty || 0,
        min_stock || 0,
        max_stock || null
      ]
    );

    const inv = await getQuery('SELECT * FROM inventory WHERE id = ?', [result.lastID]);
    res.status(201).json({ data: inv, message: '库存创建成功' });
  } catch (err) {
    next(err);
  }
});

router.put('/:warehouse_id/:sku_id', async (req, res, next) => {
  try {
    const { available_qty, reserved_qty, in_transit_qty, min_stock, max_stock } = req.body;
    const existing = await getQuery(
      'SELECT * FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [req.params.warehouse_id, req.params.sku_id]
    );
    if (!existing) {
      return res.status(404).json({ error: '库存记录不存在', code: 'INVENTORY_NOT_FOUND' });
    }

    await runQuery(
      `UPDATE inventory SET
        available_qty = ?,
        reserved_qty = ?,
        in_transit_qty = ?,
        min_stock = ?,
        max_stock = ?,
        last_count_date = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE warehouse_id = ? AND sku_id = ?`,
      [
        available_qty !== undefined ? available_qty : existing.available_qty,
        reserved_qty !== undefined ? reserved_qty : existing.reserved_qty,
        in_transit_qty !== undefined ? in_transit_qty : existing.in_transit_qty,
        min_stock !== undefined ? min_stock : existing.min_stock,
        max_stock !== undefined ? max_stock : existing.max_stock,
        req.params.warehouse_id,
        req.params.sku_id
      ]
    );

    const inv = await getQuery(
      'SELECT * FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
      [req.params.warehouse_id, req.params.sku_id]
    );
    res.json({ data: inv, message: '库存更新成功' });
  } catch (err) {
    next(err);
  }
});

router.post('/adjust', async (req, res, next) => {
  const { adjustments, operator, remark } = req.body;
  if (!adjustments || !Array.isArray(adjustments) || adjustments.length === 0) {
    return res.status(400).json({ error: '调整数据不能为空', code: 'INVALID_INPUT' });
  }

  try {
    await new Promise((resolve, reject) => {
      db.serialize(async () => {
        db.run('BEGIN TRANSACTION');
        try {
          const results = [];
          for (const adj of adjustments) {
            const { warehouse_id, sku_id, qty_change, change_type } = adj;
            const inv = await getQuery(
              'SELECT * FROM inventory WHERE warehouse_id = ? AND sku_id = ?',
              [warehouse_id, sku_id]
            );
            if (!inv) {
              throw new Error(`仓库${warehouse_id}的SKU${sku_id}库存不存在`);
            }

            let newAvailable = inv.available_qty;
            let newReserved = inv.reserved_qty;
            let newInTransit = inv.in_transit_qty;

            switch (change_type) {
              case 'IN':
                newAvailable += Number(qty_change);
                break;
              case 'OUT':
                newAvailable -= Number(qty_change);
                break;
              case 'RESERVE':
                newReserved += Number(qty_change);
                newAvailable -= Number(qty_change);
                break;
              case 'RELEASE':
                newReserved -= Number(qty_change);
                newAvailable += Number(qty_change);
                break;
              case 'IN_TRANSIT_IN':
                newInTransit += Number(qty_change);
                break;
              case 'IN_TRANSIT_OUT':
                newInTransit -= Number(qty_change);
                break;
              default:
                newAvailable += Number(qty_change);
            }

            if (newAvailable < 0 || newReserved < 0 || newInTransit < 0) {
              throw new Error(`库存调整后数量不能为负数`);
            }

            await runQuery(
              `UPDATE inventory SET available_qty = ?, reserved_qty = ?, in_transit_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE warehouse_id = ? AND sku_id = ?`,
              [newAvailable, newReserved, newInTransit, warehouse_id, sku_id]
            );
            results.push({ warehouse_id, sku_id, success: true });
          }

          db.run('COMMIT', (err) => {
            if (err) reject(err);
            else resolve(results);
          });
        } catch (err) {
          db.run('ROLLBACK', () => reject(err));
        }
      });
    });

    res.json({ message: '库存调整成功', count: adjustments.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
