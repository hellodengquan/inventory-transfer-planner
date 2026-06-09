const express = require('express');
const router = express.Router();
const { runQuery, getQuery, allQuery } = require('../db/database');

router.get('/', async (req, res, next) => {
  try {
    const { status, type, keyword } = req.query;
    let sql = 'SELECT * FROM warehouses WHERE 1=1';
    const params = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    if (keyword) {
      sql += ' AND (name LIKE ? OR code LIKE ? OR location LIKE ?)';
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw);
    }
    sql += ' ORDER BY id';

    const warehouses = await allQuery(sql, params);
    res.json({ data: warehouses, total: warehouses.length });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const warehouse = await getQuery('SELECT * FROM warehouses WHERE id = ?', [req.params.id]);
    if (!warehouse) {
      return res.status(404).json({ error: '仓库不存在', code: 'WAREHOUSE_NOT_FOUND' });
    }
    res.json({ data: warehouse });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { code, name, location, type, status, min_security_stock } = req.body;
    if (!code || !name) {
      return res.status(400).json({ error: '仓库编码和名称必填', code: 'INVALID_INPUT' });
    }

    const existing = await getQuery('SELECT id FROM warehouses WHERE code = ?', [code]);
    if (existing) {
      return res.status(400).json({ error: '仓库编码已存在', code: 'DUPLICATE_CODE' });
    }

    const result = await runQuery(
      'INSERT INTO warehouses (code, name, location, type, status, min_security_stock) VALUES (?, ?, ?, ?, ?, ?)',
      [code, name, location || '', type || 'NORMAL', status || 'ACTIVE', min_security_stock || 0]
    );

    const warehouse = await getQuery('SELECT * FROM warehouses WHERE id = ?', [result.lastID]);
    res.status(201).json({ data: warehouse, message: '仓库创建成功' });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { code, name, location, type, status, min_security_stock } = req.body;
    const existing = await getQuery('SELECT * FROM warehouses WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: '仓库不存在', code: 'WAREHOUSE_NOT_FOUND' });
    }

    if (code && code !== existing.code) {
      const dup = await getQuery('SELECT id FROM warehouses WHERE code = ? AND id != ?', [code, req.params.id]);
      if (dup) {
        return res.status(400).json({ error: '仓库编码已存在', code: 'DUPLICATE_CODE' });
      }
    }

    await runQuery(
      'UPDATE warehouses SET code = ?, name = ?, location = ?, type = ?, status = ?, min_security_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [
        code || existing.code,
        name || existing.name,
        location !== undefined ? location : existing.location,
        type || existing.type,
        status || existing.status,
        min_security_stock !== undefined ? min_security_stock : existing.min_security_stock,
        req.params.id
      ]
    );

    const warehouse = await getQuery('SELECT * FROM warehouses WHERE id = ?', [req.params.id]);
    res.json({ data: warehouse, message: '仓库更新成功' });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await getQuery('SELECT * FROM warehouses WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: '仓库不存在', code: 'WAREHOUSE_NOT_FOUND' });
    }

    const invCount = await getQuery('SELECT COUNT(*) as cnt FROM inventory WHERE warehouse_id = ?', [req.params.id]);
    if (invCount.cnt > 0) {
      return res.status(400).json({ error: '该仓库下存在库存记录，无法删除', code: 'HAS_INVENTORY' });
    }

    await runQuery('DELETE FROM warehouses WHERE id = ?', [req.params.id]);
    res.json({ message: '仓库删除成功' });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/inventory', async (req, res, next) => {
  try {
    const { sku_id, low_stock } = req.query;
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
        i.available_qty,
        i.reserved_qty,
        i.in_transit_qty,
        (i.available_qty + i.in_transit_qty) as total_qty,
        i.min_stock,
        i.max_stock,
        i.updated_at
      FROM inventory i
      INNER JOIN warehouses w ON i.warehouse_id = w.id
      INNER JOIN skus s ON i.sku_id = s.id
      WHERE i.warehouse_id = ?
    `;
    const params = [req.params.id];

    if (sku_id) {
      sql += ' AND i.sku_id = ?';
      params.push(sku_id);
    }
    if (low_stock === 'true') {
      sql += ' AND i.available_qty <= i.min_stock';
    }
    sql += ' ORDER BY i.available_qty ASC';

    const inventory = await allQuery(sql, params);
    res.json({ data: inventory, total: inventory.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
