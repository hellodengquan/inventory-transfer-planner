/**
 * SQLite 数据库连接与通用查询封装层
 * @module src/db/database
 * @description 提供 SQLite 单例连接与 Promise 风格的 CRUD 查询方法（run/get/all）
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { logger } = require('../utils/logger');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/inventory.db');

/**
 * SQLite 数据库实例（开启外键约束）
 * @type {sqlite3.Database}
 */
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    logger.error('数据库连接失败', {
      component: 'db',
      db_path: DB_PATH,
      error: err.message,
      code: err.code
    });
    throw err;
  }
  logger.info('数据库连接成功', {
    component: 'db',
    db_path: DB_PATH
  });
  db.run('PRAGMA foreign_keys = ON', (e) => {
    if (e) {
      logger.warn('启用外键约束失败', { component: 'db', error: e.message });
    }
  });
});

/**
 * 执行写入型 SQL（INSERT / UPDATE / DELETE）
 * @param {string} sql - SQL 语句，使用 ? 占位符
 * @param {Array} [params=[]] - 绑定参数数组
 * @returns {Promise<{lastID:number, changes:number}>} 插入 ID 和受影响行数
 * @throws {Error} SQL 执行错误
 */
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        logger.debug('DB runQuery failed', {
          component: 'db.query',
          sql: sql.slice(0, 200),
          code: err.code
        });
        reject(err);
      } else {
        resolve({ lastID: this.lastID, changes: this.changes });
      }
    });
  });
}

/**
 * 查询单行结果
 * @param {string} sql - SELECT 语句
 * @param {Array} [params=[]] - 绑定参数
 * @returns {Promise<object|undefined>} 第一行结果或 undefined
 * @throws {Error} SQL 执行错误
 */
function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        logger.debug('DB getQuery failed', {
          component: 'db.query',
          sql: sql.slice(0, 200),
          code: err.code
        });
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

/**
 * 查询多行结果
 * @param {string} sql - SELECT 语句
 * @param {Array} [params=[]] - 绑定参数
 * @returns {Promise<object[]>} 结果行数组
 * @throws {Error} SQL 执行错误
 */
function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        logger.debug('DB allQuery failed', {
          component: 'db.query',
          sql: sql.slice(0, 200),
          code: err.code
        });
        reject(err);
      } else {
        resolve(rows || []);
      }
    });
  });
}

/**
 * 在 serialize 模式下串行执行事务
 * @param {function(sqlite3.Database, runQuery, getQuery, allQuery):Promise<T>} fn - 事务体函数
 * @returns {Promise<T>} 事务返回值
 * @template T
 */
function serializeTransaction(fn) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      fn(db, runQuery, getQuery, allQuery)
        .then(resolve)
        .catch(reject);
    });
  });
}

module.exports = {
  db,
  runQuery,
  getQuery,
  allQuery,
  serializeTransaction
};
