/**
 * 仓库管理路由模块
 * @module src/routes/warehouses
 * @description 提供仓库的 CRUD、停用保护、编码唯一约束、库存子资源查询等接口。
 *              删除仓库前会校验 HAS_INVENTORY；INACTIVE 仓库会被约束检查排除
 *
 * @swagger
 * components:
 *   schemas:
 *     Warehouse:
 *       type: object
 *       description: 仓库实体
 *       properties:
 *         id: { type: integer, example: 1 }
 *         code: { type: string, example: WH-BJ, description: 仓库编码 }
 *         name: { type: string, example: 北京中心仓 }
 *         location: { type: string, example: 北京市朝阳区 }
 *         type: { type: string, enum: [CENTER, REGIONAL, NORMAL], description: 仓库类型 }
 *         status: { type: string, enum: [ACTIVE, INACTIVE] }
 *         min_security_stock: { type: integer, minimum: 0 }
 *         created_at: { type: string, format: date-time }
 *         updated_at: { type: string, format: date-time }
 *     WarehouseCreate:
 *       type: object
 *       required: [code, name]
 *       properties:
 *         code: { type: string, maxLength: 32 }
 *         name: { type: string, maxLength: 100 }
 *         location: { type: string, maxLength: 200 }
 *         type: { type: string, enum: [CENTER, REGIONAL, NORMAL], default: NORMAL }
 *         status: { type: string, enum: [ACTIVE, INACTIVE], default: ACTIVE }
 *         min_security_stock: { type: integer, minimum: 0, default: 0 }
 *   parameters:
 *     Page:
 *       name: page
 *       in: query
 *       schema: { type: integer, minimum: 1, default: 1 }
 *     PageSize:
 *       name: pageSize
 *       in: query
 *       schema: { type: integer, minimum: 1, maximum: 500, default: 100 }
 *     IdParam:
 *       name: id
 *       in: path
 *       required: true
 *       schema: { type: integer, minimum: 1 }
 *   responses:
 *     NotFound:
 *       description: 资源不存在
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               error: { type: string }
 *               code: { type: string, example: WAREHOUSE_NOT_FOUND }
 *               requestId: { type: string }
 *               timestamp: { type: string, format: date-time }
 *
 * tags:
 *   - name: Warehouses
 *     description: 仓库管理
 */

/**
 * @swagger
 * /api/warehouses:
 *   get:
 *     tags: [Warehouses]
 *     summary: 查询仓库列表（支持多维度过滤）
 *     parameters:
 *       - name: status
 *         in: query
 *         schema: { type: string, enum: [ACTIVE, INACTIVE] }
 *       - name: type
 *         in: query
 *         schema: { type: string, enum: [CENTER, REGIONAL, NORMAL] }
 *       - name: keyword
 *         in: query
 *         schema: { type: string }
 *         description: 关键字（名称/编码/位置）
 *     responses:
 *       '200':
 *         description: 仓库列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { type: array, items: { $ref: '#/components/schemas/Warehouse' } }
 *                 total: { type: integer }
 *   post:
 *     tags: [Warehouses]
 *     summary: 创建仓库
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/WarehouseCreate' }
 *     responses:
 *       '201': { description: 创建成功 }
 *       '400': { description: 编码重复或必填项缺失 }
 *
 * /api/warehouses/{id}:
 *   parameters:
 *     - $ref: '#/components/parameters/IdParam'
 *   get:
 *     tags: [Warehouses]
 *     summary: 查询单个仓库
 *     responses:
 *       '200':
 *         description: 仓库详情
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data: { $ref: '#/components/schemas/Warehouse' }
 *       '404': { $ref: '#/components/responses/NotFound' }
 *   put:
 *     tags: [Warehouses]
 *     summary: 更新仓库
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/WarehouseCreate' }
 *     responses:
 *       '200': { description: 更新成功 }
 *       '404': { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Warehouses]
 *     summary: 删除仓库（仅当无库存引用）
 *     responses:
 *       '200': { description: 删除成功 }
 *       '400': { description: 有库存引用 HAS_INVENTORY }
 *       '404': { $ref: '#/components/responses/NotFound' }
 *
 * /api/warehouses/{id}/inventory:
 *   parameters:
 *     - $ref: '#/components/parameters/IdParam'
 *   get:
 *     tags: [Warehouses]
 *     summary: 查询仓库的库存明细
 *     parameters:
 *       - name: sku_id
 *         in: query
 *         schema: { type: integer }
 *       - name: low_stock
 *         in: query
 *         schema: { type: boolean, description: 仅筛选低库存 }
 *     responses:
 *       '200': { description: 库存明细 }
 */

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
