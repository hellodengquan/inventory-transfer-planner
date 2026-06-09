/**
 * SKU 管理路由模块
 * @module src/routes/skus
 * @description 提供商品 SKU 的 CRUD、分类枚举、编码唯一约束、全网库存查询等接口。
 *              删除 SKU 前校验是否存在库存引用（HAS_INVENTORY）
 *
 * @swagger
 * tags:
 *   - name: SKUs
 *     description: 商品 SKU 管理
 */

/**
 * @swagger
 * /api/skus:
 *   get:
 *     tags: [SKUs]
 *     summary: 查询 SKU 列表（支持状态/分类/关键字过滤）
 *     parameters:
 *       - name: status
 *         in: query
 *         schema: { type: string, enum: [ACTIVE, INACTIVE] }
 *       - name: category
 *         in: query
 *         schema: { type: string }
 *       - name: keyword
 *         in: query
 *         schema: { type: string }
 *     responses:
 *       '200': { description: SKU 分页列表 }
 *   post:
 *     tags: [SKUs]
 *     summary: 创建 SKU
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sku_code, name]
 *             properties:
 *               sku_code: { type: string }
 *               name: { type: string }
 *               category: { type: string }
 *               unit: { type: string, default: 件 }
 *               spec: { type: string }
 *               weight: { type: number, minimum: 0 }
 *               volume: { type: number, minimum: 0 }
 *               status: { type: string, enum: [ACTIVE, INACTIVE], default: ACTIVE }
 *     responses:
 *       '201': { description: 创建成功 }
 *
 * /api/skus/categories:
 *   get:
 *     tags: [SKUs]
 *     summary: 获取所有 SKU 分类集合
 *     responses:
 *       '200': { description: 分类名称数组 }
 *
 * /api/skus/{id}:
 *   parameters: [{ $ref: '#/components/parameters/IdParam' }]
 *   get:
 *     tags: [SKUs]
 *     summary: 查询单个 SKU
 *     responses:
 *       '200': { description: SKU 详情 }
 *       '404': { $ref: '#/components/responses/NotFound' }
 *   put:
 *     tags: [SKUs]
 *     summary: 更新 SKU
 *     responses:
 *       '200': { description: 更新成功 }
 *   delete:
 *     tags: [SKUs]
 *     summary: 删除 SKU（仅无库存引用）
 *     responses:
 *       '200': { description: 删除成功 }
 *
 * /api/skus/{id}/inventory:
 *   parameters: [{ $ref: '#/components/parameters/IdParam' }]
 *   get:
 *     tags: [SKUs]
 *     summary: 查询 SKU 全网各仓库库存
 *     responses:
 *       '200': { description: 各仓库库存列表 }
 */

const express = require('express');
const router = express.Router();
const { runQuery, getQuery, allQuery } = require('../db/database');

router.get('/', async (req, res, next) => {
  try {
    const { status, category, keyword } = req.query;
    let sql = 'SELECT * FROM skus WHERE 1=1';
    const params = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    if (keyword) {
      sql += ' AND (name LIKE ? OR sku_code LIKE ? OR category LIKE ?)';
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw);
    }
    sql += ' ORDER BY id';

    const skus = await allQuery(sql, params);
    res.json({ data: skus, total: skus.length });
  } catch (err) {
    next(err);
  }
});

router.get('/categories', async (req, res, next) => {
  try {
    const categories = await allQuery('SELECT DISTINCT category FROM skus WHERE category IS NOT NULL AND category != \'\' ORDER BY category');
    res.json({ data: categories.map(c => c.category) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const sku = await getQuery('SELECT * FROM skus WHERE id = ?', [req.params.id]);
    if (!sku) {
      return res.status(404).json({ error: 'SKU不存在', code: 'SKU_NOT_FOUND' });
    }
    res.json({ data: sku });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { sku_code, name, category, unit, spec, weight, volume, status } = req.body;
    if (!sku_code || !name) {
      return res.status(400).json({ error: 'SKU编码和名称必填', code: 'INVALID_INPUT' });
    }

    const existing = await getQuery('SELECT id FROM skus WHERE sku_code = ?', [sku_code]);
    if (existing) {
      return res.status(400).json({ error: 'SKU编码已存在', code: 'DUPLICATE_CODE' });
    }

    const result = await runQuery(
      'INSERT INTO skus (sku_code, name, category, unit, spec, weight, volume, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [sku_code, name, category || '', unit || '件', spec || '', weight || 0, volume || 0, status || 'ACTIVE']
    );

    const sku = await getQuery('SELECT * FROM skus WHERE id = ?', [result.lastID]);
    res.status(201).json({ data: sku, message: 'SKU创建成功' });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { sku_code, name, category, unit, spec, weight, volume, status } = req.body;
    const existing = await getQuery('SELECT * FROM skus WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'SKU不存在', code: 'SKU_NOT_FOUND' });
    }

    if (sku_code && sku_code !== existing.sku_code) {
      const dup = await getQuery('SELECT id FROM skus WHERE sku_code = ? AND id != ?', [sku_code, req.params.id]);
      if (dup) {
        return res.status(400).json({ error: 'SKU编码已存在', code: 'DUPLICATE_CODE' });
      }
    }

    await runQuery(
      'UPDATE skus SET sku_code = ?, name = ?, category = ?, unit = ?, spec = ?, weight = ?, volume = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [
        sku_code || existing.sku_code,
        name || existing.name,
        category !== undefined ? category : existing.category,
        unit || existing.unit,
        spec !== undefined ? spec : existing.spec,
        weight !== undefined ? weight : existing.weight,
        volume !== undefined ? volume : existing.volume,
        status || existing.status,
        req.params.id
      ]
    );

    const sku = await getQuery('SELECT * FROM skus WHERE id = ?', [req.params.id]);
    res.json({ data: sku, message: 'SKU更新成功' });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await getQuery('SELECT * FROM skus WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'SKU不存在', code: 'SKU_NOT_FOUND' });
    }

    const invCount = await getQuery('SELECT COUNT(*) as cnt FROM inventory WHERE sku_id = ?', [req.params.id]);
    if (invCount.cnt > 0) {
      return res.status(400).json({ error: '该SKU下存在库存记录，无法删除', code: 'HAS_INVENTORY' });
    }

    await runQuery('DELETE FROM skus WHERE id = ?', [req.params.id]);
    res.json({ message: 'SKU删除成功' });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/inventory', async (req, res, next) => {
  try {
    const inventory = await allQuery(`
      SELECT
        i.id,
        i.warehouse_id,
        w.code as warehouse_code,
        w.name as warehouse_name,
        i.sku_id,
        s.sku_code,
        s.name as sku_name,
        i.available_qty,
        i.reserved_qty,
        i.in_transit_qty,
        (i.available_qty + i.in_transit_qty) as total_qty,
        i.min_stock,
        i.max_stock
      FROM inventory i
      INNER JOIN warehouses w ON i.warehouse_id = w.id
      INNER JOIN skus s ON i.sku_id = s.id
      WHERE i.sku_id = ?
      ORDER BY i.available_qty DESC
    `, [req.params.id]);
    res.json({ data: inventory, total: inventory.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
