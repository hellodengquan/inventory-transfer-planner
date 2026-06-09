/**
 * 可观测性集成测试：Swagger JSDoc 自动生成 + 日志级别切换
 *
 * 覆盖两类关键基础设施：
 * 1. swagger-jsdoc 从路由 @swagger JSDoc 注解成功生成 OpenAPI 3.0 规范
 *    - paths 中包含全部核心模块（warehouses/skus/inventory/transfer-requests/transfer-plans/transfer-records）
 *    - components.schemas.Warehouse 存在（源自 warehouses.js 的公共组件定义）
 * 2. 日志级别切换（NODE_ENV 默认策略 + LOG_LEVEL 显式覆盖）
 *    - resolveDefaultLevel：development→debug / test→warn / production→error
 *    - resolveLogLevel：LOG_LEVEL 显式设置时覆盖 NODE_ENV 默认
 */

const path = require('path');
const swaggerJSDoc = require('swagger-jsdoc');
const {
  resolveDefaultLevel,
  resolveLogLevel,
  createLoggerInstance
} = require('../src/utils/logger');

const PORT = process.env.PORT || 3000;

describe('Swagger JSDoc 自动生成集成', () => {
  let swaggerSpec;

  beforeAll(() => {
    swaggerSpec = swaggerJSDoc({
      definition: {
        openapi: '3.0.3',
        info: {
          title: '库存调拨规划器 API (Test)',
          version: '1.0.0'
        },
        servers: [{ url: `http://localhost:${PORT}` }]
      },
      apis: [path.join(__dirname, '..', 'src', 'routes', '*.js')]
    });
  });

  test('规范基础元信息正确', () => {
    expect(swaggerSpec.openapi).toBe('3.0.3');
    expect(swaggerSpec.info.title).toBeDefined();
    expect(Array.isArray(swaggerSpec.servers)).toBe(true);
  });

  test('paths 中包含 6 大核心模块的路由路径（代码与文档实时一致）', () => {
    const paths = Object.keys(swaggerSpec.paths || {});
    const expected = [
      '/api/warehouses',
      '/api/skus',
      '/api/inventory',
      '/api/transfer-requests',
      '/api/transfer-plans',
      '/api/transfer-records'
    ];
    expected.forEach(p => {
      const matched = paths.some(pathKey => pathKey.startsWith(p));
      expect(matched).toBe(true);
    });
  });

  test('components.schemas.Warehouse 存在（由 warehouses.js 的 @swagger 组件定义）', () => {
    const schemas = ((swaggerSpec.components || {}).schemas || {});
    expect(schemas.Warehouse).toBeDefined();
    expect(schemas.Warehouse.type).toBe('object');
    expect(schemas.Warehouse.properties.code).toBeDefined();
    expect(schemas.Warehouse.properties.id).toBeDefined();
  });

  test('核心端点包含合理的请求/响应结构', () => {
    const trCreate = (swaggerSpec.paths || {})['/api/transfer-requests'];
    expect(trCreate).toBeDefined();
    expect(trCreate.post).toBeDefined();
    expect(trCreate.post.requestBody).toBeDefined();
    expect(trCreate.post.responses['201']).toBeDefined();
    expect(trCreate.post.responses['400']).toBeDefined();
  });
});

describe('日志级别按 NODE_ENV 区分策略（默认值）', () => {
  test('development → debug（开发期细节可见）', () => {
    expect(resolveDefaultLevel('development')).toBe('debug');
    expect(resolveDefaultLevel('dev')).toBe('debug');
  });

  test('test → warn（测试输出保持干净）', () => {
    expect(resolveDefaultLevel('test')).toBe('warn');
    expect(resolveDefaultLevel('testing')).toBe('warn');
  });

  test('production → error（生产仅致命错误）', () => {
    expect(resolveDefaultLevel('production')).toBe('error');
    expect(resolveDefaultLevel('prod')).toBe('error');
  });

  test('未知环境 → info（通用默认）', () => {
    expect(resolveDefaultLevel('staging')).toBe('info');
    expect(resolveDefaultLevel('custom-env')).toBe('info');
  });
});

describe('LOG_LEVEL 显式覆盖（优先于 NODE_ENV 默认）', () => {
  test('设置 LOG_LEVEL=debug 时生产环境也能输出 debug（临时排障）', () => {
    const level = resolveLogLevel({ env: 'production', explicit: 'debug' });
    expect(level).toBe('debug');
  });

  test('设置 LOG_LEVEL=error 时开发环境也收敛为 error（模拟生产）', () => {
    const level = resolveLogLevel({ env: 'development', explicit: 'error' });
    expect(level).toBe('error');
  });

  test('LOG_LEVEL 大小写不敏感', () => {
    expect(resolveLogLevel({ env: 'test', explicit: 'INFO' })).toBe('info');
    expect(resolveLogLevel({ env: 'production', explicit: 'WarN' })).toBe('warn');
  });

  test('非法 LOG_LEVEL 回退到 NODE_ENV 默认', () => {
    expect(resolveLogLevel({ env: 'test', explicit: 'invalid-level' })).toBe('warn');
    expect(resolveLogLevel({ env: 'production', explicit: '' })).toBe('error');
  });
});

describe('createLoggerInstance 工厂（创建带指定级别的实例）', () => {
  test('指定 level=error 的实例不输出 info 级别（silent 验证）', () => {
    const inst = createLoggerInstance({ level: 'error' });
    expect(inst.level).toBe('error');
    expect(inst.isLevelEnabled('error')).toBe(true);
    expect(inst.isLevelEnabled('info')).toBe(false);
  });

  test('指定 level=debug 的实例输出 debug 级别', () => {
    const inst = createLoggerInstance({ level: 'debug' });
    expect(inst.level).toBe('debug');
    expect(inst.isLevelEnabled('debug')).toBe(true);
    expect(inst.isLevelEnabled('warn')).toBe(true);
    expect(inst.isLevelEnabled('error')).toBe(true);
  });
});
