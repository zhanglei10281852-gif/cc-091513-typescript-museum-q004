# 科学演示开场安全闸门

面向科技展览馆科学演示场次、人员资质和安全检查的 TypeScript 后端服务。

系统把每个场次的**演示脚本版本、设备点检、讲师资质、耗材批次、场地容量、应急人员到岗**汇成安全闸门，直接给出**放行结论、阻断原因、可补救动作与实际余量**，回答值班人员最关心的三个问题：哪项条件最先失效、补救后是否还能开场、余量还有多少。

## 闸门规则

- **六个强制项，任一失效即锁住开场**：脚本版本（不可例外）、设备点检、讲师资质、耗材批次、场地容量、应急人员到岗。
- **设备点检**按*实际检查时间*归属：有效窗口为开场前 30–240 分钟（见 `src/policy.ts`）；补录不改变判定点，倒签/预填（检查时间晚于当前时间）直接拒绝登记。
- **讲师资质**须覆盖至场次结束，余量以天计。
- **耗材批次**：扫码预留，标签批号必须与领用单批号一致，否则拒绝登记；扫码码是幂等键，重复扫码不重复预留、不重复消耗；批次被隔离后其预留不再计入有效量。
- **场地容量**：预计观众不得超过场地容量与脚本人数上限的较小者。
- **例外放行**：只能由具备对应检查项权限的复核者签发，仅对当前场次生效，有效期至场次结束；同一检查项同时最多一条有效例外。
- **开场即锁定**：脚本版本与人员名单（讲师 + 已到岗应急人员）锁定不可再改，本会话预留的耗材一次性转换为消耗（按预留幂等，只消耗一次）。
- **事故登记**：立即停止本场次与同场地计划开始时间更晚的后续场次，并保全原始记录（场次、闸门评估、点检、耗材事件、例外的快照）；事故未经复核者确认前，受影响场次不能恢复。
- **重启续推**：全部状态持久化到 `.runtime/state.json`（原子写入），倒计时、停用状态、未确认事故均由持久化时间戳推导，进程重启后按原时点继续推进。

## API 一览

所有接口收发 JSON，错误格式为 `{"error": {code, message, details}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/venues` `/scripts` `/instructors` `/staff` `/reviewers` | 登记场地、脚本版本、讲师、应急人员、复核者 |
| POST | `/sessions` | 创建场次 |
| GET | `/sessions` / `/sessions/:id` | 场次列表 / 场次详情（含实时闸门评估） |
| GET | `/sessions/:id/gate` | 评估安全闸门：放行结论、阻断原因（按首次失效排序）、可补救动作、实际余量 |
| POST | `/sessions/:id/script` `/instructors` `/audience` | 开场前调整脚本、讲师、预计观众 |
| DELETE | `/sessions/:id/instructors/:instructorId` | 移除讲师 |
| POST | `/sessions/:id/inspections` | 登记设备点检（`checkedAt` 为实际检查时间） |
| POST | `/sessions/:id/requisitions` | 登记耗材领用单（含批号） |
| POST | `/sessions/:id/materials/scan` | 扫码预留耗材（幂等；批号不一致返回 409） |
| POST | `/materials/batches` / `/materials/batches/:id/quarantine` | 批次入库 / 隔离 |
| GET | `/materials/batches/:id` | 批次库存（入库/预留/消耗/可用） |
| POST | `/sessions/:id/emergency-checkins` | 应急人员到岗签到 |
| POST | `/sessions/:id/exceptions` | 复核者签发例外（校验权限） |
| POST | `/sessions/:id/start` | 开场（闸门未放行返回 409 及评估报告） |
| POST | `/sessions/:id/complete` / `/stop` / `/reinstate` | 完成 / 停用 / 恢复（事故停用须先确认） |
| POST | `/incidents` / `/incidents/:id/confirm` | 事故登记 / 确认 |
| GET | `/incidents` / `/incidents/:id` | 事故查询（含保全的原始记录） |

## 运行

需要 Node.js 22 或更高版本。执行 `npm ci` 安装依赖，`npm test` 完成编译与测试，`npm start` 启动已编译服务。服务默认监听 8000 端口，访问 `GET /health` 可确认进程状态。也可以使用 `docker compose up --build` 启动容器。

环境变量：`PORT`（默认 8000）、`HOST`（默认 0.0.0.0）、`STATE_DIR`（状态目录，默认 `.runtime/`）。

## 代码结构

- `src/types.ts` — 领域模型与枚举（与 `reference/domain.json` 一致）
- `src/policy.ts` — 闸门策略参数（点检窗口等）
- `src/gate.ts` — 闸门评估引擎（纯函数）
- `src/service.ts` — 业务命令与查询（校验、锁定、例外、事故、耗材台账）
- `src/store.ts` — JSON 持久化（原子写入，重启恢复）
- `src/app.ts` — HTTP 路由层
- `tests/` — 服务规则、重启恢复、HTTP 端到端测试
