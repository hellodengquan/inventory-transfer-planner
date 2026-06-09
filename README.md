# 库存调拨规划器 (Inventory Transfer Planner)

基于 **Node.js + Express + SQLite** 的库存调拨规划管理系统，支持调拨申请、库存约束检查、调拨方案自动生成与确认、多仓智能分配等核心功能，配套完整的自动化测试用例。

---

## 目录

- [快速启动](#快速启动)
- [项目结构](#项目结构)
- [核心功能](#核心功能)
- [约束检查分级体系](#约束检查分级体系)
  - [8 类约束类型](#8-类约束类型)
  - [三级严重度分级](#三级严重度分级)
- [调拨方案状态机](#调拨方案状态机)
  - [状态迁移图](#状态迁移图)
  - [迁移规则表](#迁移规则表)
- [多仓自动分配优先级算法](#多仓自动分配优先级算法)
- [API 接口参考](#api-接口参考)
- [自动化测试](#自动化测试)

---

## 快速启动

### 环境要求
- Node.js >= 16
- npm >= 8

### 安装与启动

```bash
# 1. 安装依赖
npm install

# 2. 初始化数据库（8 张核心业务表）
npm run init-db

# 3. 插入示例数据（5 个仓库、7 个 SKU、26 条库存记录）
npm run seed-data

# 4. 启动服务
npm start
# 或开发模式（文件变更自动重启）
npm run dev

# 5. 健康检查
curl http://localhost:3000/api/health

# 6. 打开 Swagger UI 交互文档
open http://localhost:3000/api-docs
```

### 环境变量配置

项目通过 `dotenv` 加载 `.env` 文件，可从 `.env.example` 复制模板。核心环境变量：

| 变量 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `PORT` | integer | `3000` | HTTP 服务监听端口 |
| `NODE_ENV` | enum | `development` | 运行环境，影响默认日志级别 |
| `LOG_LEVEL` | enum | 按 `NODE_ENV` 自动推导 | 覆盖默认日志级别：`error`/`warn`/`info`/`http`/`verbose`/`debug`/`silly` |
| `DB_PATH` | string | `data/inventory.db` | SQLite 数据库文件路径 |

**默认日志级别策略（未设置 LOG_LEVEL 时）：**

| NODE_ENV | 默认级别 | 说明 |
|----------|---------|------|
| `development` / `dev` | `debug` | 开发期细节可见，便于调试 |
| `test` / `testing` | `warn` | 仅告警及以上，测试输出干净 |
| `production` / `prod` | `error` | 仅致命错误，降低 IO 成本 |
| 其他 | `info` | 通用默认 |

### 运行自动化测试

```bash
# 运行全部测试
npm test

# 监听模式（文件变更自动重跑）
npm run test:watch
```

测试覆盖范围参见 [自动化测试章节](#自动化测试)。

---

## 项目结构

```
22-inventory-transfer-planner/
├── src/
│   ├── app.js                          # Express 应用入口（请求 ID、日志、Swagger UI、错误处理）
│   ├── db/
│   │   └── database.js                 # SQLite 连接封装 (runQuery/getQuery/allQuery)
│   ├── utils/
│   │   └── logger.js                   # ⭐ winston 结构化日志（分级 + requestId 注入）
│   ├── middleware/
│   │   ├── validateRequest.js          # ⭐ express-validator 统一请求校验（20+规则集）
│   │   ├── requestLogger.js            # ⭐ 请求/响应日志 + 耗时 + requestId 头
│   │   └── errorHandler.js             # ⭐ 全局错误处理（4xx/5xx 分类 + 统一 JSON）
│   ├── routes/
│   │   ├── warehouses.js               # 仓库管理 API
│   │   ├── skus.js                     # SKU 管理 API
│   │   ├── inventory.js                # 库存查询/调整 API
│   │   ├── transferRequests.js         # 调拨申请 API
│   │   ├── transferPlans.js            # 调拨方案 API
│   │   └── transferRecords.js          # 调拨记录 API
│   └── services/
│       ├── constraintCheckService.js   # ⭐ 约束检查核心服务（8类约束+多仓分配）
│       └── transferPlanService.js      # ⭐ 方案状态机服务（生成/确认/驳回/执行）
├── tests/
│   ├── test-helper.js                  # 测试工具（独立数据库初始化/播种）
│   ├── constraintCheck.test.js         # 约束检查测试（14 用例）
│   ├── transferPlan.test.js            # 状态机测试（12 用例）
│   ├── multiWarehouseAllocation.test.js# 多仓分配测试（14 用例）
│   ├── warehouses.test.js              # 仓库 CRUD 与停用保护（20 用例）
│   ├── inventory.test.js               # 库存调整与安全库存边界（29 用例）
│   ├── transferRecords.test.js         # 调拨记录创建与状态联动（33 用例）
│   └── observability.test.js           # 可观测性集成（swagger-jsdoc + 日志级别切换）
├── scripts/
│   ├── init-db.js                      # 数据库初始化脚本
│   └── seed-data.js                    # 示例数据脚本
├── data/                               # SQLite 数据文件目录
├── .env.example                        # 环境变量示例（PORT/NODE_ENV/LOG_LEVEL/DB_PATH）
├── package.json
└── README.md
```

---

## 核心功能

| 模块 | 说明 |
|------|------|
| **调拨申请** | 创建/修改/提交/取消调拨申请，支持草稿→提交的状态流转 |
| **约束检查引擎** | 8 类约束规则，FATAL/WARNING/INFO 三级严重度 |
| **方案自动生成** | 两种模式：①指定源仓的单仓调拨 ②不指定源仓的全网多仓智能分配 |
| **方案状态机** | PENDING → CONFIRMED → COMPLETED，支持驳回/取消分支 |
| **两阶段库存** | 确认方案：源仓可用→在途；执行入库：在途→目标仓可用 |
| **库存辅助** | 仓库/SKU/库存 CRUD、低库存预警、出入库汇总统计 |

---

## 约束检查分级体系

约束检查是调拨规划的核心**把关机制**。所有约束均通过 `ConstraintCheckService` 统一执行，在 `src/services/constraintCheckService.js` 中定义。

### 8 类约束类型

| # | 约束类型 | 英文标识 | 触发场景 |
|---|----------|----------|----------|
| 1 | **仓库不存在/未激活** | `WAREHOUSE_NOT_EXIST` | 源/目标仓 ID 不存在，或 `status != 'ACTIVE'` |
| 2 | **源仓=目标仓** | `SAME_WAREHOUSE` | 调拨的源仓和目标仓为同一个 |
| 3 | **SKU 不存在** | `SKU_NOT_EXIST` | 申请明细中的 SKU ID 在 `skus` 表中查不到 |
| 4 | **调拨数量非法** | `NEGATIVE_QTY` | `requested_qty <= 0`（0 或负数） |
| 5 | **源仓可用库存不足** | `SOURCE_INSUFFICIENT` | `available_qty < requested_qty`（单仓模式）或全网可调配总量 < 需求（多仓模式） |
| 6 | **调拨后低于安全库存** | `SOURCE_AFTER_MIN` | `(available_qty - planned_qty) < min_stock` |
| 7 | **源仓当前已低于安全线** | `SOURCE_MIN_STOCK` | 调拨前 `available_qty <= min_stock`（提示性信息） |
| 8 | **目标仓超过最大库存** | `TARGET_OVER_MAX` | `(target_available + planned_qty) > max_stock` |

### 三级严重度分级

| 严重度 | 级别 | `passed` 字段 | 业务含义 | 系统动作 |
|--------|------|---------------|----------|----------|
| **FATAL** | 致命错误 | ❌ `false` | **不允许**继续 | 阻止方案生成/提交 |
| **WARNING** | 风险告警 | ✅ `true` | **可继续，但需人工确认** | 方案生成时记录至 `constraint_violations` 表，审批人可见 |
| **INFO** | 提示信息 | ✅ `true` | **仅作参考** | 保留在约束详情中，不影响流程 |

### 约束结果字段说明

```javascript
{
  passed: boolean,        // 是否通过（无 FATAL 即为 true）
  summary: string,        // 人类可读摘要
  fatalCount: number,     // FATAL 数量
  warningCount: number,   // WARNING 数量
  infoCount: number,      // INFO 数量
  violations: Array,      // 全部违规详情（跨 SKU）
  itemResults: Array      // 按 SKU 维度的明细结果
}
```

### 测试覆盖

`tests/constraintCheck.test.js` 覆盖全部 8 类约束、三级严重度、完美场景等 **14 个测试用例**。

---

## 调拨方案状态机

调拨方案的生命周期由 `TransferPlanService` (`src/services/transferPlanService.js`) 严格管理，**非法状态转换会被阻止并抛出异常**。

### 状态迁移图

```
                    ┌─────────────────────────────┐
                    │         PENDING             │
                    │      (待确认/初始态)        │
                    └───────┬───────────┬─────────┘
                            │           │
                   confirm  │           │ reject / cancel
                  (确认)    │           │ (驳回/删除)
                            ▼           ▼
              ┌─────────────────┐    ┌───────────────┐
              │   CONFIRMED     │    │   REJECTED    │
              │  (已确认-在途)  │    │   CANCELLED   │
              └────────┬────────┘    └───────┬───────┘
                       │                     │
              execute  │                     │ （终态）
             (执行入库)│
                       ▼
              ┌─────────────────┐
              │   COMPLETED     │
              │  (已完成-终态)   │
              └─────────────────┘
```

### 迁移规则表

| 当前状态 | 允许的操作 | 目标状态 | 方法 |
|----------|-----------|----------|------|
| **PENDING** | `confirm()` | → `CONFIRMED` | `transferPlanService.confirmPlan()` |
| **PENDING** | `reject()` | → `REJECTED` | `transferPlanService.rejectPlan()` |
| **PENDING** | `cancel()` | → 删除记录 + 申请回退为 `SUBMITTED` | `transferPlanService.cancelPlan()` |
| **CONFIRMED** | `execute()` | → `COMPLETED` | `transferPlanService.executePlan()` |
| **CONFIRMED** | confirm / reject / cancel | ❌ **不允许** | 抛出 `STATUS_NOT_ALLOWED` |
| **COMPLETED** | 任何操作 | ❌ **不允许**（终态） | 抛出 `STATUS_NOT_ALLOWED` |
| **REJECTED** | 重新生成方案 | → 新 PENDING 记录 | 申请状态为 `REJECTED` 时可再次调用 `generatePlan()` |

### 对应调拨申请状态同步

方案状态变更会**自动同步**到关联的 `transfer_requests.status`：

| 事件 | 方案状态 | 申请状态 |
|------|---------|----------|
| 生成方案 | `PENDING` | `PLANNING` |
| 确认方案 | `CONFIRMED` | `APPROVED` |
| 执行入库 | `COMPLETED` | `COMPLETED` |
| 驳回（最后一个待处理方案） | `REJECTED` | `REJECTED` |
| 删除（最后一个待处理方案） | 被删除 | `SUBMITTED`（回退）|

### 测试覆盖

`tests/transferPlan.test.js` 覆盖主干路径、REJECTED 分支、非法转换拦截、CANCELLED 分支等 **12 个测试用例**。

---

## 多仓自动分配优先级算法

当调拨申请**不指定 `source_warehouse_id`** 时，系统会触发**全网多仓智能分配**逻辑，核心规则定义在 `ConstraintCheckService.findBestSourceWarehouses()` 中。

### 算法步骤

```
步骤1：筛选候选仓库
  ├─ 条件1: 库存中有该 SKU（available_qty > 0）
  ├─ 条件2: 仓库状态 = 'ACTIVE'
  └─ 条件3: 仓库 ≠ 目标仓（不从目标仓调货到目标仓）

步骤2：按优先级规则排序（3 级排序键，从高到低）
  ├─ 排序键1（最高优先级）: warehouse_type = 'CENTER' DESC
  │   └─ 含义：中心仓（CENTER）永远排在区域仓（REGIONAL）前面
  │
  ├─ 排序键2（次优先级）: (available_qty - min_stock) DESC
  │   └─ 含义：可调配余量越大，优先级越高（先消耗余量充足的仓）
  │
  └─ 排序键3（兜底）: available_qty DESC
      └─ 含义：同类型、同余量时，库存总量大者优先

步骤3：安全库存保护分配
  ├─ for (遍历排序后的候选仓):
  │   ├─ transferable = max(0, 可用量 - 安全库存)   // 保护安全库存，不低于安全线
  │   ├─ allocated = min(transferable, 剩余需求)
  │   └─ if allocated > 0:
  │       ├─ 记录该仓库分配 allocated 数量
  │       └─ 剩余需求 -= allocated
  │
  └─ 剩余需求 > 0 ? → 记录 shortage（短缺量）

步骤4：返回
  ├─ sources: 已分配的仓库明细（含分配后余量、警告信息）
  ├─ shortage: 全网可调配不足的缺口数量
  └─ totalAllocated: 总已分配量 = 需求 - shortage
```

### 关键设计原则

| 原则 | 说明 |
|------|------|
| **中心仓优先** | 中心仓作为调拨枢纽优先出货，降低跨区域运输成本 |
| **安全库存保底** | 任何源仓调拨后库存 ≥ 该仓安全库存（`min_stock`）|
| **不抢目标仓** | 目标仓自身库存不参与调配，避免循环调拨 |
| **短缺透明** | 全网不足时显式返回 `shortage`，并触发 `SOURCE_INSUFFICIENT` 告警 |

### 示例：典型分配场景

假设成都仓申请 500 袋 SKU-001（高端狗粮），不指定源仓：

| 排序优先级 | 仓库 | 类型 | 可用 | 安全库存 | 可调配余量 | 实际分配 | 调拨后余量 |
|:---:|------|------|------|---------|----------|---------|-----------|
| 1 | 北京中心仓 | CENTER | 500 | 100 | **400** | 200 | 300（≥100 ✅）|
| 2 | 上海华东仓 | REGIONAL | 280 | 50 | **230** | 230 | 50（≥50 ✅）|
| 3 | 武汉华中仓 | REGIONAL | 60 | 40 | **20** | 70 → 20 | 40（≥40 ✅）|
| - | 广州华南仓 | REGIONAL | 40 | 50 | **0** | 0（跳过）| 40（不变）|
| - | **合计** | - | - | - | 650 | **450** | - |

最终结果：
- `shortage = 50`（50 袋全网无法调配）
- 触发 1 条 `SOURCE_INSUFFICIENT` WARNING（提示缺口）
- 触发多条 `SOURCE_AFTER_MIN` WARNING（提示分配后部分仓库刚好踩线）

### 测试覆盖

`tests/multiWarehouseAllocation.test.js` 覆盖优先级排序、安全库存保护（4 种机制）、全网调配（4 种场景）、方案落库完整性等 **14 个测试用例**。

---

## API 接口参考

服务默认端口 `3000`，统一前缀 `/api`，响应格式为 JSON。

### Swagger UI 交互文档（推荐）

OpenAPI 3.0 规范由 **swagger-jsdoc** 自动从路由文件的 `@swagger` JSDoc 注解生成，
确保代码与文档**实时一致**（不再需要手写 YAML）。

| 入口 | 地址 | 说明 |
|------|------|------|
| Swagger UI 交互页 | `GET /api-docs` | 支持 Try it out 在线调试、筛选、请求头显示 |
| OpenAPI JSON | `GET /api-docs/openapi.json` | 供客户端代码生成工具消费 |
| 健康检查 | `GET /api/health` | 返回服务状态、版本、请求 ID、docs 地址 |

### 接口摘要（全部共 37 个端点）

**调拨申请** (`/api/transfer-requests`)
GET 列表/详情、POST 创建+校验、PUT 更新、POST 提交/取消/检查约束、DELETE 删除

**调拨方案** (`/api/transfer-plans`)
GET 列表/详情、POST 生成/确认/驳回/执行、DELETE 取消（含完整状态机 PENDING→CONFIRMED→COMPLETED）

**辅助接口**
- 仓库：`GET/POST/PUT/DELETE /api/warehouses` + `GET :id/inventory`
- SKU：`GET/POST/PUT/DELETE /api/skus` + `GET :id/inventory` + `GET /categories`
- 库存：`GET/POST /api/inventory` + `GET :warehouse_id/:sku_id`(查询/更新) + `POST /adjust`（6 种类型事务调整） + `GET /summary` + `GET /low-stock`
- 调拨记录：`GET /api/transfer-records`（7 维度过滤） + `GET /summary`（方向聚合） + `GET :id`

### 统一错误响应格式

所有 4xx/5xx 错误均通过全局错误处理中间件返回统一结构：
```json
{
  "error": "面向用户的可读消息",
  "code": "WAREHOUSE_NOT_FOUND",
  "requestId": "a1b2c3d4e5f6789",
  "timestamp": "2025-07-01T12:00:00.000Z"
}
```

### 请求校验错误（VALIDATION_ERROR）

express-validator 校验失败时 `code=VALIDATION_ERROR`，并附加 `errors` 数组，包含字段路径和消息：
```json
{
  "error": "请求参数校验失败",
  "code": "VALIDATION_ERROR",
  "errors": [{ "path": "target_warehouse_id", "message": "target_warehouse_id 必填", "value": null }]
}
```

---

## 自动化测试

项目采用 **Jest 29** 作为测试框架，全部测试使用**独立的测试数据库**（`data/test-inventory.db`），不影响开发环境数据。

### 测试文件与用例统计

| 测试文件 | 测试场景数 | 核心覆盖内容 |
|---------|-----------|-------------|
| `tests/constraintCheck.test.js` | **14** | 8 类约束全覆盖、FATAL(7)/WARNING(3)/INFO(1) 三级严重度触发、完美场景、8 类类型断言 |
| `tests/transferPlan.test.js` | **12** | 主干路径4步(PENDING→CONFIRMED→COMPLETED)、REJECTED分支3步、非法转换拦截3种、CANCELLED回退、约束落库 |
| `tests/multiWarehouseAllocation.test.js` | **14** | 4条排序规则验证、4种安全库存保护、4种调配场景（单仓/多仓/全网不足/目标仓排除）、2种落库完整性 |
| `tests/warehouses.test.js` | **20** | CRUD、编码唯一约束、HAS_INVENTORY 删除保护、INACTIVE 调拨拦截、关键字/状态/类型过滤、库存列表、低库存筛选 |
| `tests/inventory.test.js` | **29** | 6 类调整事务、安全库存 6 边界场景、复合主键 UNIQUE、低库存筛选/汇总、数量范围校验 |
| `tests/transferRecords.test.js` | **33** | 单仓/多仓 4 阶段状态联动、6 维度筛选、方向汇总、唯一性约束、外键约束、字段校验、中间件 13 规则 |
| `tests/observability.test.js` | **≥5** | swagger-jsdoc 自动生成规范（paths/schemas/tags 验证）、日志级别切换（NODE_ENV 默认+ LOG_LEVEL 覆盖） |
| **合计** | **≥127** | - |

### 运行测试

```bash
# 安装依赖（首次）
npm install

# 运行全部测试（输出详细日志）
npm test

# 输出示例：
#  PASS  tests/constraintCheck.test.js (14 tests)
#  PASS  tests/transferPlan.test.js (12 tests)
#  PASS  tests/multiWarehouseAllocation.test.js (14 tests)
#  Test Suites: 3 passed, 3 total
#  Tests:       40 passed, 40 total
```

### 测试工具说明

`tests/test-helper.js` 提供：
- `initTestDb()` — 创建独立测试数据库（`data/test-inventory.db`），含完整 8 张表
- `seedTestData()` — 播种与生产环境同结构的示例数据（含 1 个 INACTIVE 仓库专门用于边界测试）
- `createTransferRequest()` — 快速创建调拨申请（含明细）
- 测试间互不干扰：每个 `test` 文件使用独立数据库实例，`afterAll` 自动清理

---

## 设计亮点

1. **约束服务依赖注入**：`ConstraintCheckService` 支持通过 `setDbFunctions()` 注入自定义数据库方法，测试使用独立数据库不影响开发数据。
2. **事务安全的状态机**：方案确认/执行等写操作使用 SQLite 事务，库存扣减+记录写入+状态变更原子执行，异常时自动 ROLLBACK。
3. **两阶段库存模型**：`available_qty`（可用）/`in_transit_qty`（在途）分离，确认方案走在途，实际到货再入库，符合真实物流业务。
4. **短缺透明化**：多仓分配不足时，不静默截断，而是返回结构化 `shortage` 字段并写入 `constraint_violations` 表。
5. **完整测试三角**：约束（输入正确性）→ 状态机（流程正确性）→ 分配算法（业务规则正确性），3 个维度共 40 个用例保驾护航。
