# 食品加工换线 · 过敏原追踪与放行系统

本地运行的食品加工过敏原追溯网页：录入**原料过敏原、设备、按时间排序的加工事件与已核实清洗事件**，
系统按时间顺序推导每个产出批次的过敏原集合及来源路径，管理设备残留，支持按**当时推导结果**登记批次放行，
并在**包装前按批次 + 有效放行登记过敏原标签卷**（按修订号核销贴用/作废，集合或放行变化时永久停用），
**包装出货时按批次把已贴用标签张数整单分配给出货单**（卷停用时相关已出货单待评估、不自动恢复）。

- 后端：Node.js + Express
- 数据库：SQLite（[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)，数据文件本地保存）
- 前端：浏览器单页应用（原生 HTML/CSS/JS，无需构建）

## 功能与规则

### 推导规则

- **批次产出过敏原** = 全部原料输入过敏原 ∪ 引用的此前批次产出 ∪ **设备当前残留**，并集计算。
- **设备残留更新**：每次加工后，该设备残留更新为本次产出的过敏原集合；新鲜来源路径会追加“设备残留”标记，
  已在残留中的路径原样保留（可追溯残留自哪次加工带入）。
- **已核实清洗**（CLEAN 事件）才会清空对应设备的残留；普通加工不会清空。
- 每个批次的每个过敏原都展示**来源路径链**，例如：
  `原料:全脂奶粉(MILK-01) → 批次引用:BATCH-002 → 设备残留:LINE-A`
- 更正/删除早期事件后，系统**全量重算**所有受影响的后续批次与设备残留。

### 放行

- 放行以登记时刻的过敏原集合作为**快照**保存。
- 早期事件更正后重算：某条放行登记时的集合与新结果**不同**，该放行自动置为**已失效**，
  页面红色标注并给出具体原因（新增了哪些过敏原 / 移除了哪些过敏原）；失效为终态，需重新登记放行。
- 集合相同则放行保持有效。

### 提交约束（整次提交事务化，违反任意一条则整单回滚拒绝）

- 加工只能引用**产出时间严格更早**的批次——引用未来批次被拒绝。
- 批次引用关系**形成循环**被拒绝。
- **同一设备同一时刻**存在多条事件（时间冲突）被拒绝。
- 同一批次不能被两次加工产出。

### 换线整组预演与确认应用（本轮新增）

车间调整加工顺序时，可**一次提交多条既有事件的更正（PROCESS/CLEAN）与拟插入的清洗事件**：

- `POST /api/replan/preview` 在**内存影子库**上应用整组变更，按整组变更后的时间线
  全量校验（引用先后、引用环、设备时间冲突、批次唯一产出）并重算，返回应用前后
  **每批过敏原、设备残留、将失效的放行记录**差异；**不修改正式事件、推导结果或放行状态**。
- **单条更正单独看暂时冲突、但整组最终合法时仍可预演**（例如交换两个事件的时间）。
- 预演返回业务版本 `version`（签名令牌，30 分钟有效；服务重启后旧版本作废）。
- `POST /api/replan/apply` 确认应用：**必须携带预演版本及与预演完全相同的 changes**，
  在**一次事务**中重新校验版本、重新做全量校验并重算落库。
- **预演后任何会影响这些结果的正式写入**（新增/更正/删除事件、改原料过敏原、登记/删除放行、
  确认出货等）**均使该版本过期**：应用返回 `409 VERSION_EXPIRED` 且**原状态不变**，需重新预演。
- 以下情况在预演阶段即明确拒绝（HTTP 400，`details` 给出逐条中文原因，预演失败可见原因）：
  未知事件、同一事件被重复更正、设备不存在、拟插入的清洗事件缺少时间、
  整组后时间线非法（未来引用 / 引用环 / 时间冲突 / 批次重复产出）等。

> 既有单条事件接口（`POST/PUT/DELETE /api/events/...`）与放行接口（`/api/releases`）
> 的语义完全保持不变；新接口只做“整组预演 + 确认应用”。

#### 变更项格式（`changes` 数组，顺序无关）

更正既有事件（字段与单条 `PUT /api/events/:id` 相同，必须带 `type`；加工事件为全量覆盖输入/引用）：

```json
{
  "op": "update",
  "event_id": 1,
  "type": "PROCESS",
  "event_time": "2026-09-30T09:00",
  "equipment_id": 1,
  "note": "早班面团（改到清洗后）",
  "batch_code": "BATCH-001",
  "material_ids": [1, 7],
  "ref_batch_ids": []
}
```

拟插入的清洗事件（`client_key` 可选，便于多条时对应预演返回的新事件 id）：

```json
{ "op": "insert_clean", "client_key": "mid-wash", "event_time": "2026-09-30T09:30",
  "equipment_id": 1, "note": "换线中间追加一次已核实清洗" }
```

#### 调用示例（curl，基于演示数据）

```bash
# 1) 预演：交换 LINE-A 上 BATCH-001(08:00) 与清洗(09:00) 的时间
curl -s -X POST http://localhost:3000/api/replan/preview \
  -H 'Content-Type: application/json' -d '{
    "changes": [
      {"op":"update","event_id":1,"type":"PROCESS","event_time":"2026-09-30T09:00",
       "equipment_id":1,"note":"早班面团","batch_code":"BATCH-001",
       "material_ids":[1,7],"ref_batch_ids":[]},
      {"op":"update","event_id":2,"type":"CLEAN","event_time":"2026-09-30T08:00",
       "equipment_id":1,"note":"换线前已核实清洗"}
    ]
  }'
# -> { ok:true, phase:"PREVIEW", version:"<业务版本令牌>", business_version:"...",
#      changes:[...规范化回显...], inserted_clean_events:[],
#      diff:{ summary:{ batches_changed, equipment_residue_changed,
#                       releases_will_invalidate, releases_changed },
#             batches:[{batch_id,code,produced_at,
#                       before_allergens,after_allergens,added,removed}],
#             equipment_residue:[{equipment_id,equipment_code,
#                       before_allergens,after_allergens,added,removed,
#                       before_last_cleaned_at,after_last_cleaned_at}],
#             releases:[{release_id,batch_code,before_status,after_status:"INVALIDATED",
#                       after_invalid_reason,...}] } }

# 2) 确认应用：原样回传 version 与同一份 changes（事务内重新校验+重算）
curl -s -X POST http://localhost:3000/api/replan/apply \
  -H 'Content-Type: application/json' -d '{
    "version": "<上一步返回的 version>",
    "changes": [ ...与预演完全相同的内容... ]
  }'
# -> { ok:true, phase:"APPLIED", applied_version, business_version,
#      inserted_clean_events:[{client_key,event_id}], invalidated:[...],
#      diff:{ ...与预演同结构的实际落库差异... } }
```

预演失败示例（整组后时间线非法，HTTP 400）：

```json
{ "error": "整组变更应用后的时间线校验未通过",
  "code": "REPLAN_REJECTED",
  "details": ["事件 #3（2026-09-30T11:30）引用了未来或同时刻批次 #4（产出时间 2026-09-30T11:00），不允许引用未来批次"] }
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 请求体/变更内容问题（非数组、缺时间、未知事件、重复更正、设备不存在…） | 400 | `INVALID_REQUEST` / `REPLAN_REJECTED` |
| 整组后时间线校验失败（未来引用/环/时间冲突/批次重复产出） | 400 | `REPLAN_REJECTED` |
| 版本签名损坏或格式非法 | 400 | `VERSION_INVALID` |
| apply 的 changes 与预演不一致 | 409 | `CHANGES_MISMATCH` |
| 预演后正式数据已变更导致版本过期（含重复应用同一版本、版本过期） | 409 | `VERSION_EXPIRED` |

## 过敏原标签卷（包装前登记 → 核销贴用/作废）

包装前，按**现有批次**与其**有效放行记录**登记一卷过敏原标签：

- 登记必须录入**拟印过敏原集合**、**正整数印量（张）**与**操作人**；
  拟印集合必须与①该批次**当前推导结果**、②所选**放行快照****完全一致**（三方一致，顺序/重复不敏感），
  否则整次拒绝。登记成功返回**卷号**（`LABEL-0001` 起）与**可用张数**。
- 每卷凭**预期修订号**（`expected_revision`，登记时为 0，每次核销 +1）核销**贴用**与**作废**张数；
  累计贴用 + 作废不得超过印量。**旧修订号、负数、超量均整次拒绝**（事务回滚，修订号不前进）。
- **永久停用（终态）**：原料或加工事件变更、整组换线确认应用使该批次集合改变，
  或绑定的放行记录失效、被删除时，该卷立即永久停用——
  **余量不可再贴，已贴数量标记“待复核”**；即使过敏原集合后来恢复一致，**也不会自动解冻**，
  需在新的有效放行下登记新卷。
- “过敏原标签卷”页按**批次分组**显示每卷的**印量、贴用、作废、剩余**及**停用原因**；
  批次卡片上也有该批标签卷数量摘要，可一键跳转。
- 整组预演返回的 `diff.label_rolls_will_retire` 会列出应用后**将被永久停用**的卷（含待复核张数），
  预演本身不停用任何正式卷；确认应用的响应 `retired_rolls` 为实际停用的卷。

### HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/label-rolls` | 登记一卷（三方一致校验），返回卷对象（含 `roll_code`、`remaining_qty`） |
| `POST /api/label-rolls/:id/consume` | 按预期修订号核销贴用/作废，返回更新后的卷对象（含新 `revision`） |
| `GET /api/state` | 顶层新增 `label_rolls` 数组（既有字段不变），按批次含卷号/印量/贴用/作废/剩余/修订号/状态/停用原因 |
| `DELETE /api/releases/:id` | 语义不变（仍返回 `ok:true`），另附 `retired_rolls`：其名下有效卷被永久停用；以及 `pending_shipments`：相关已确认出货单被标记待评估 |
| 事件 `POST/PUT/DELETE`、原料 `PUT` | 响应形状不变，另附 `retired_rolls`（本次重算导致停用的卷）与 `pending_shipments`（联动标记待评估的出货单） |

登记请求体：

```json
{ "batch_id": 3, "release_id": 1,
  "allergens": ["乳", "蛋", "芝麻"],
  "print_qty": 500,
  "registered_by": "包装组长-李雷",
  "registered_at": "2026-09-30T12:10" }
```

核销请求体（`applied`/`voided` 也可写作 `used`/`void_qty`；`expected_revision` 必传）：

```json
{ "expected_revision": 0, "applied": 100, "voided": 3,
  "used_by": "包装工-赵强", "used_at": "2026-09-30T13:05" }
```

#### 调用示例（curl，基于演示数据；演示库自带 BATCH-003 的一卷 LABEL-0001：印 500 / 贴 120 / 作废 5 / 剩 375）

```bash
# 1) 登记一卷：集合必须同时等于当前推导与放行快照
curl -s -X POST http://localhost:3000/api/label-rolls \
  -H 'Content-Type: application/json' -d '{
    "batch_id": 3, "release_id": 1,
    "allergens": ["乳","蛋","芝麻"],
    "print_qty": 500, "registered_by": "包装组长-李雷"
  }'
# -> { id:2, roll_code:"LABEL-0002", print_qty:500, applied_qty:0, void_qty:0,
#      remaining_qty:500, revision:0, status:"ACTIVE", active:true, ... }

# 2) 按修订号 0 核销 100 贴用 + 3 作废 -> 剩 397，修订号前进到 1
curl -s -X POST http://localhost:3000/api/label-rolls/2/consume \
  -H 'Content-Type: application/json' \
  -d '{"expected_revision":0,"applied":100,"voided":3,"used_by":"赵强"}'

# 3) 再用旧修订号 0 核销 -> 409 REVISION_MISMATCH，整次拒绝、数量不变
curl -s -X POST http://localhost:3000/api/label-rolls/2/consume \
  -H 'Content-Type: application/json' -d '{"expected_revision":0,"applied":5,"voided":0}'
# -> { error:"修订号已过期：卷当前修订号为 1，提交的预期修订号为 0；整次拒绝",
#      code:"REVISION_MISMATCH" }

# 4) 负数 / 超量 -> 400 INVALID_REQUEST / 409 OVER_LIMIT
curl -s -X POST http://localhost:3000/api/label-rolls/2/consume \
  -H 'Content-Type: application/json' -d '{"expected_revision":1,"applied":-1,"voided":0}'
curl -s -X POST http://localhost:3000/api/label-rolls/2/consume \
  -H 'Content-Type: application/json' -d '{"expected_revision":1,"applied":99999,"voided":0}'

# 5) 集合改变 / 放行失效后：卷 RETIRED，余量冻结、已贴待复核，再核销 -> 409 ROLL_RETIRED
#    （例如到“事件时间线”给 BATCH-002 加入花生原料，BATCH-003 推导集合变化）
curl -s http://localhost:3000/api/state | node -e 'let d="";process.stdin.on("data",c=>d+=c)
  .on("end",()=>{for(const r of JSON.parse(d).label_rolls)
    console.log(r.batch_code,r.roll_code,r.status,r.print_qty,r.applied_qty,r.void_qty,
      r.remaining_qty,r.retired_reason);})'

# 6) 删除放行 -> 其名下有效卷立即永久停用（响应附 retired_rolls）
curl -s -X DELETE http://localhost:3000/api/releases/1
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 拟印集合与当前推导/放行快照不一致、印量非正整数、批次或放行缺失、放行不属于该批次、放行已失效 | 400 | `ALLERGENS_MISMATCH` / `INVALID_REQUEST` / `BATCH_NOT_FOUND` / `BATCH_NOT_PRODUCED` / `RELEASE_NOT_FOUND` / `RELEASE_BATCH_MISMATCH` / `RELEASE_INACTIVE` |
| 核销：旧修订号 / 累计超印量 / 卷已停用 | 409 | `REVISION_MISMATCH` / `OVER_LIMIT` / `ROLL_RETIRED` |
| 核销：负数、全零、缺少修订号、卷号不合法 | 400 | `INVALID_REQUEST` |
| 核销不存在的卷 | 404 | `ROLL_NOT_FOUND` |

## 包装出货（按批次分配已贴用标签张数）

包装出货时，按**批次**把该批各卷**已贴用**标签的张数分配给一张出货单，整单事务化确认。

- 确认必须录入：**批次**、**正整数出货量（张）**、**各卷分配张数**（每卷一条）与**操作人**。
- 每条分配都要满足：该卷**属于该批次**、**未停用（ACTIVE）**、**绑定有效放行**、分配张数为正整数、同一卷不重复出现。
- **各卷分配总数必须恰好等于出货量**；每卷「此前累计已分配 + 本次分配」**不得超过该卷已贴用数**
  （`applied_qty`，作废张数不计入可出货）。
- 任一条件不满足则**整单拒绝、事务回滚，不占用任何数量**；响应 `details` 逐条给出中文原因。
- 确认成功返回**出货单号**（`SHIP-0001` 起）与**状态**，并为每条分配保存**当时快照**：
  放行标识（`release_id`）、过敏原集合、卷号、卷修订号。
- **出货记录不可因后续更正消失**：不提供删除/修改接口；即使放行后来被删除，快照中的放行标识与卷号仍可查。
- **待评估（终态，不自动恢复）**：原料或加工事件变更、整组换线确认应用使批次集合改变，
  或绑定放行失效/删除导致卷**永久停用**时，使用了该卷的所有**已确认出货单**整单标记为
  **待评估（PENDING_REVIEW）**并显示具体原因（逐卷追加，不覆盖旧原因）；即使过敏原集合后来恢复一致，
  出货单也**不会自动恢复为已确认**。
- 卷停用后，其**尚未分配的已贴张数立即冻结**，余额恒为 0，不得再出货；
  需在新的有效放行下登记新卷、核销贴用后才能继续出货。
- 可查询**批次可出货余额**（每卷：已贴用/已分配/可出货/冻结）与**出货单状态**。
- 整组换线预演返回的 `diff.shipments_will_pending_review` 会列出应用后**将被标记待评估**的出货单
  （预演本身不改正式出货单）；确认应用响应中的 `pending_shipments` 为实际标记的出货单。
- 触发卷停用的既有写接口（事件 `POST/PUT/DELETE`、原料 `PUT`、放行 `DELETE`、整组确认应用）
  响应在原有 `retired_rolls` 之外另附 **`pending_shipments`**；其余字段形状保持不变。

### HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/shipments` | 整单确认出货（事务化），返回出货单对象（含 `shipment_code`、`status` 与各卷快照明细） |
| `GET /api/shipments` | 出货单列表（可按 `?batch_id=`、`?status=CONFIRMED|PENDING_REVIEW` 过滤），按出货时间倒序 |
| `GET /api/shipments/:id` | 单张出货单详情（含每条分配的放行标识/过敏原集合/卷号/修订号快照） |
| `GET /api/batches/shipment-balance` | 全部已产出批次的可出货余额 |
| `GET /api/batches/:id/shipment-balance` | 单批次可出货余额（同上，也支持 `?batch_id=`） |
| `GET /api/state` | 顶层新增 `shipments` 数组（既有字段不变） |

确认出货请求体：

```json
{ "batch_id": 3, "ship_qty": 60,
  "items": [
    { "roll_id": 1, "alloc_qty": 40 },
    { "roll_id": 2, "alloc_qty": 20 }
  ],
  "shipped_by": "出货员-陈静",
  "shipped_at": "2026-09-30T14:20" }
```

返回示例（明细中的 `release_id` / `allergens` / `roll_code` / `roll_revision` 均为出货当时的留痕快照）：

```json
{ "id": 2, "shipment_code": "SHIP-0002", "batch_id": 3, "batch_code": "BATCH-003",
  "ship_qty": 60, "allocated_qty": 60, "status": "CONFIRMED",
  "confirmed": true, "pending_review": false, "review_reason": "",
  "reviewed_rolls": [], "shipped_at": "2026-09-30T14:20", "shipped_by": "出货员-陈静",
  "items": [
    { "id": 3, "roll_id": 1, "roll_code": "LABEL-0001", "release_id": 1,
      "allergens": ["蛋", "乳", "芝麻"], "roll_revision": 2, "alloc_qty": 40 } ] }
```

批次余额示例：

```json
{ "batch_id": 3, "batch_code": "BATCH-003", "produced_at": "2026-09-30T11:00",
  "shippable_qty": 60, "allocated_qty": 60, "active_rolls": 1, "retired_rolls": 0,
  "rolls": [
    { "roll_id": 1, "roll_code": "LABEL-0001", "status": "ACTIVE", "active": true,
      "applied_qty": 120, "allocated_qty": 60, "shippable_qty": 60,
      "frozen_qty": 0, "retired_reason": "" } ] }
```

#### 调用示例（curl，基于演示数据；演示库自带 LABEL-0001：印 500 / 贴 120 / 作废 5，及一笔 SHIP-0001 已分配 60 张，故批次可出货余额为 60）

```bash
# 1) 查批次可出货余额（每卷已贴用/已分配/可出货/冻结）
curl -s http://localhost:3000/api/batches/3/shipment-balance

# 2) 整单确认出货 60 张（全部来自 LABEL-0001 的已贴用余量）
curl -s -X POST http://localhost:3000/api/shipments \
  -H 'Content-Type: application/json' -d '{
    "batch_id": 3, "ship_qty": 60,
    "items": [{"roll_id": 1, "alloc_qty": 60}],
    "shipped_by": "出货员-陈静"
  }'
# -> { shipment_code:"SHIP-0002", status:"CONFIRMED", ship_qty:60, items:[{roll_code:"LABEL-0001",...}] }

# 3) 超过已贴用余量（此时 120 张已全部分配，再出 1 张）-> 409 ROLL_QTY_EXCEEDED，整单拒绝不占用
curl -s -X POST http://localhost:3000/api/shipments \
  -H 'Content-Type: application/json' \
  -d '{"batch_id":3,"ship_qty":1,"items":[{"roll_id":1,"alloc_qty":1}]}'
# -> { error:"卷 LABEL-0001 分配超出已贴用数：...累计 121 超过已贴用数；整单拒绝",
#      code:"ROLL_QTY_EXCEEDED", details:[...] }

# 4) 分配总数与出货量不一致 -> 400 ALLOCATION_MISMATCH（整单拒绝，不占用数量）
curl -s -X POST http://localhost:3000/api/shipments \
  -H 'Content-Type: application/json' \
  -d '{"batch_id":3,"ship_qty":10,"items":[{"roll_id":1,"alloc_qty":9}]}'

# 5) 查询出货单状态（全部 / 按批次 / 按状态 / 详情）
curl -s 'http://localhost:3000/api/shipments?batch_id=3'
curl -s 'http://localhost:3000/api/shipments?status=PENDING_REVIEW'
curl -s http://localhost:3000/api/shipments/1

# 6) 卷停用联动（例如删除放行）：相关已出货单整单待评估，余额冻结
curl -s -X DELETE http://localhost:3000/api/releases/1
# -> { ok:true, retired_rolls:[...], pending_shipments:[
#      {id:1, shipment_code:"SHIP-0001", batch_code:"BATCH-003", reason:"相关标签卷已停用，出货单待评估：..."} ] }
curl -s http://localhost:3000/api/shipments/1
# -> { status:"PENDING_REVIEW", review_reason:"相关标签卷已停用...",
#      items:[{ roll_code:"LABEL-0001", release_id:1, allergens:[...], roll_revision:2, alloc_qty:60 }] }
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 缺批次/出货量或分配非正整数、缺 items、同一卷重复分配 | 400 | `INVALID_REQUEST` |
| 分配总数 ≠ 出货量、卷不属于该批次 | 400 | `ALLOCATION_MISMATCH` / `ROLL_BATCH_MISMATCH` |
| 批次/卷不存在 | 404 | `BATCH_NOT_FOUND` / `ROLL_NOT_FOUND` |
| 卷已停用（未分配已贴张数冻结）、卷未绑定有效放行、累计分配超已贴用数 | 409 | `ROLL_RETIRED` / `ROLL_RELEASE_INACTIVE` / `ROLL_QTY_EXCEEDED` |
| 查询不存在的出货单 | 404 | `SHIPMENT_NOT_FOUND` |
| 该批次尚无加工记录 | 400 | `BATCH_NOT_PRODUCED` |

## 一键启动（Docker，从空环境开始）

要求安装 Docker 与 Docker Compose（v2）。在项目目录执行：

```bash
docker compose up --build -d
```

该命令会依次完成：构建镜像 → 安装 npm 依赖 → 初始化 SQLite 库与表结构 →
首次启动写入演示数据 → 启动 Web 服务。

查看日志 / 停止：

```bash
docker compose logs -f
docker compose down            # 停止（保留数据卷）
docker compose down -v         # 停止并删除本地数据（恢复空白/演示初始状态）
```

## 本地直接运行（无 Docker）

要求 Node.js 20+：

```bash
npm install
npm start                      # 自动创建 data/allergen.db、建表并写入演示数据
```

可选单独初始化数据库：`npm run init-db`。

测试（不依赖外部框架，直接在临时库上跑）：

```bash
npm test                 # 校验引擎：无环/成环用例
npm run test:replan      # 启动临时端口的真实服务，端到端验证整组预演/确认应用全部语义
npm run test:labels      # 启动临时端口的真实服务，端到端验证标签卷登记/核销/永久停用全部语义
npm run test:shipments   # 端到端验证包装出货整单事务、余额查询、卷停用→出货单待评估全部语义
```

## 访问地址与端口

启动后浏览器打开：

- **http://localhost:3000**

端口可通过环境变量 `PORT` 修改；使用 Compose 时可在宿主机设置
`PORT=8080 docker compose up --build`（容器内仍监听 3000，宿主机映射变为 8080，
届时访问 http://localhost:8080 ）。

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Web 服务监听端口（容器内） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `data/allergen.db`（本地）/ `/app/data/allergen.db`（容器） | SQLite 数据文件路径 |
| `SEED_DEMO` | `true` | 首次启动（库为空）时是否写入演示数据；`false` 则得到空白库 |

数据保存在 SQLite 文件中：本地运行位于项目 `data/` 目录；Docker 运行位于
名为 `allergen-data` 的数据卷（容器内 `/app/data`），重启与重建镜像均不丢失。

## 页面说明

- **批次与放行**：设备当前残留（含来源路径）、每个批次的推导过敏原与逐条来源路径、
  放行记录（绿色“放行有效”/红色“已失效”及失效原因），可在此登记放行；
  批次卡片底部显示该批标签卷摘要，点击直达标签卷页。
- **过敏原标签卷**：按批次分组展示每卷印量、贴用、作废、剩余及当前修订号；
  可在此包装前登记新卷、按修订号核销贴用/作废；停用卷红色标注并给出具体停用原因，
  已贴数量标注“待复核”、余量标注“冻结”。
- **包装出货**：展示各批次**可出货余额**（每卷已贴用/已分配/可出货/冻结，停用卷红标停用原因）
  与全部出货单（已确认 / 待评估）；可在此按批次整单确认出货，逐卷填写分配张数并实时核对合计与上限，
  待评估出货单整单高亮并显示逐卷原因，明细中的放行标识/过敏原集合/卷号/修订号为出货当时快照。
- **事件时间线**：按时间排列全部加工/清洗事件，展示输入、引用批次与推导结果；
  “更正”可修改早期事件，保存时整单校验并触发重算。
- **原料与设备**：维护原料档案（编码、名称、过敏原标签）与设备档案。

## 快速体验失效场景

1. 打开“批次与放行”，可以看到演示数据中 `BATCH-003` 已登记放行（放行有效），
   “过敏原标签卷”页有其演示卷 `LABEL-0001`（印 500、贴 120、作废 5、剩 375）；
   “包装出货”页有演示出货单 `SHIP-0001`（60 张），该批可出货余额为 60 张。
2. 到“事件时间线”，找到 `BATCH-002`（10:00 蛋糕糊），点击“更正”并加入原料 **花生碎(PEANUT-01)**，提交。
3. 由于设备残留沿时间线传播并经 `BATCH-002` 被 `BATCH-003` 引用，重算后 `BATCH-003`
   新增过敏原“花生”，原放行记录自动变为**已失效**，`LABEL-0001` **永久停用**：
   剩余 375 张冻结不可再贴，已贴 120 张标记待复核；同时 `SHIP-0001` 整单变为**待评估**并显示原因，
   该批可出货余额归 0；撤销改动使集合恢复后，标签卷与出货单都不会自动恢复。
4. 在“过敏原标签卷”页尝试对停用卷核销，会收到 `ROLL_RETIRED` 拒绝；
   在“包装出货”页尝试用停用卷出货，会收到同样的拒绝；
   重新登记放行、登记新卷并核销贴用后，可继续包装出货。

## 目录结构

```
server/
  db.js          # SQLite 连接与表结构（导出 initSchema 供内存影子库复用）
  validation.js  # 全量校验（未来批次/循环/时间冲突/重复产出）
  recompute.js   # 推导引擎：回放事件、批次并集、设备残留、放行核对、标签卷停用/出货单待评估核对
  labels.js      # 过敏原标签卷：三方一致登记、按修订号核销、永久停用（联动出货单待评估）
  shipments.js   # 包装出货：整单事务化分配、快照留痕、批次余额/出货单查询、待评估标记
  replan.js      # 整组换线：影子库预演（含出货单将待评估差异）、业务版本签名令牌、事务确认应用
  seed.js        # 首次启动演示数据（含一卷演示标签卷与一笔演示出货单）
  server.js      # Express API 与静态页面（含 /api/label-rolls、/api/shipments、/api/batches/.../shipment-balance、/api/replan/preview|apply）
public/
  index.html  styles.css  app.js
scripts/
  test-cycle.js      # 校验引擎单测
  test-replan.js     # 整组预演/确认应用端到端测试
  test-labels.js     # 标签卷登记/核销/停用端到端测试
  test-shipments.js  # 包装出货整单事务/余额/待评估端到端测试
Dockerfile  docker-compose.yml
```
