/**
 * 调拨记录路由模块
 * @module src/routes/transferRecords
 * @description 提供调拨历史记录的多维度筛选查询、单条详情、
 *              入/出方向的汇总统计（按仓库或 SKU 聚合）等只读接口。
 *              transfer_records 数据由 transferPlans.confirm 事务自动写入，不提供直接创建接口
 */

const express = require('express');
const router = express.Router();
const { runQuery, getQuery, allQuery } = require('../db/database');

router.get('/', async (req, res, next) => {
  try {
    const {
      source_warehouse_id,
      target_warehouse_id,
      sku_id,
      plan_id,
      request_id,
      start_date,
      end_date,
      keyword,
      page = 1,
      pageSize = 50
    } = req.query;

    let sql = `
      SELECT
        tr.*,
        sw.code as source_warehouse_code,
        sw.name as source_warehouse_name,
        tw.code as target_warehouse_code,
        tw.name as target_warehouse_name,
        s.sku_code,
        s.name as sku_name,
        s.category,
        s.unit,
        tp.plan_no,
        trq.request_no
      FROM transfer_records tr
      INNER JOIN warehouses sw ON tr.source_warehouse_id = sw.id
      INNER JOIN warehouses tw ON tr.target_warehouse_id = tw.id
      INNER JOIN skus s ON tr.sku_id = s.id
      LEFT JOIN transfer_plans tp ON tr.plan_id = tp.id
      LEFT JOIN transfer_requests trq ON tr.request_id = trq.id
      WHERE 1=1
    `;
    const params = [];

    if (source_warehouse_id) {
      sql += ' AND tr.source_warehouse_id = ?';
      params.push(source_warehouse_id);
    }
    if (target_warehouse_id) {
      sql += ' AND tr.target_warehouse_id = ?';
      params.push(target_warehouse_id);
    }
    if (sku_id) {
      sql += ' AND tr.sku_id = ?';
      params.push(sku_id);
    }
    if (plan_id) {
      sql += ' AND tr.plan_id = ?';
      params.push(plan_id);
    }
    if (request_id) {
      sql += ' AND tr.request_id = ?';
      params.push(request_id);
    }
    if (start_date) {
      sql += ' AND DATE(tr.operate_time) >= DATE(?)';
      params.push(start_date);
    }
    if (end_date) {
      sql += ' AND DATE(tr.operate_time) <= DATE(?)';
      params.push(end_date);
    }
    if (keyword) {
      sql += ' AND (tr.record_no LIKE ? OR s.sku_code LIKE ? OR s.name LIKE ? OR tr.remark LIKE ?)';
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw, kw);
    }

    const countSql = `SELECT COUNT(*) as total FROM (${sql})`;
    const countResult = await getQuery(countSql, params);
    const total = countResult.total;

    sql += ' ORDER BY tr.operate_time DESC, tr.id DESC';
    const offset = (page - 1) * pageSize;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(Number(pageSize), Number(offset));

    const records = await allQuery(sql, params);
    res.json({
      data: records,
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
    const { warehouse_id, start_date, end_date, group_by = 'warehouse' } = req.query;

    let selectFields, groupClause;
    if (group_by === 'sku') {
      selectFields = `
        s.id as sku_id,
        s.sku_code,
        s.name as sku_name,
        s.unit,
        s.category
      `;
      groupClause = 's.id, s.sku_code, s.name';
    } else {
      selectFields = `
        w.id as warehouse_id,
        w.code as warehouse_code,
        w.name as warehouse_name
      `;
      groupClause = 'w.id, w.code, w.name';
    }

    const outSql = `
      SELECT
        ${selectFields},
        SUM(tr.transfer_qty) as total_out_qty,
        COUNT(DISTINCT tr.id) as transfer_count,
        'OUT' as direction
      FROM transfer_records tr
      INNER JOIN warehouses w ON tr.source_warehouse_id = w.id
      INNER JOIN skus s ON tr.sku_id = s.id
      WHERE 1=1
    `;

    const inSql = `
      SELECT
        ${selectFields},
        SUM(tr.transfer_qty) as total_in_qty,
        COUNT(DISTINCT tr.id) as transfer_count,
        'IN' as direction
      FROM transfer_records tr
      INNER JOIN warehouses w ON tr.target_warehouse_id = w.id
      INNER JOIN skus s ON tr.sku_id = s.id
      WHERE 1=1
    `;

    const params = [];
    if (warehouse_id) {
      outSql += (params.length ? '' : '') + ' AND (tr.source_warehouse_id = ?)';
      inSql += (params.length ? '' : '') + ' AND (tr.target_warehouse_id = ?)';
      params.push(warehouse_id, warehouse_id);
    }
    if (start_date) {
      outSql += ' AND DATE(tr.operate_time) >= DATE(?)';
      inSql += ' AND DATE(tr.operate_time) >= DATE(?)';
      params.push(start_date, start_date);
    }
    if (end_date) {
      outSql += ' AND DATE(tr.operate_time) <= DATE(?)';
      inSql += ' AND DATE(tr.operate_time) <= DATE(?)';
      params.push(end_date, end_date);
    }

    outSql += ` GROUP BY ${groupClause} ORDER BY total_out_qty DESC`;
    inSql += ` GROUP BY ${groupClause} ORDER BY total_in_qty DESC`;

    const outData = await allQuery(outSql, params.slice(0, params.length / 2));
    const inData = await allQuery(inSql, params.slice(params.length / 2));

    res.json({
      data: {
        outbound: outData,
        inbound: inData
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const record = await getQuery(`
      SELECT
        tr.*,
        sw.code as source_warehouse_code,
        sw.name as source_warehouse_name,
        sw.location as source_warehouse_location,
        tw.code as target_warehouse_code,
        tw.name as target_warehouse_name,
        tw.location as target_warehouse_location,
        s.sku_code,
        s.name as sku_name,
        s.category,
        s.unit,
        s.spec,
        s.weight,
        s.volume,
        tp.plan_no,
        tp.status as plan_status,
        trq.request_no,
        trq.status as request_status,
        trq.reason as request_reason
      FROM transfer_records tr
      INNER JOIN warehouses sw ON tr.source_warehouse_id = sw.id
      INNER JOIN warehouses tw ON tr.target_warehouse_id = tw.id
      INNER JOIN skus s ON tr.sku_id = s.id
      LEFT JOIN transfer_plans tp ON tr.plan_id = tp.id
      LEFT JOIN transfer_requests trq ON tr.request_id = trq.id
      WHERE tr.id = ?
    `, [req.params.id]);

    if (!record) {
      return res.status(404).json({ error: '调拨记录不存在', code: 'RECORD_NOT_FOUND' });
    }
    res.json({ data: record });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
