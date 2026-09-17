# 领域说明

科学演示开场前需要核对脚本、设备、讲师、耗材、容量和应急人员。检查时间、资质有效期、场次开始时间与事故停用时间共同决定是否可以放行。

`reference/domain.json` 保存公开的场次状态、检查项目、闸门结论与阻断码枚举。正式业务记录使用稳定标识，并保留脚本版本、检查证据和例外决定。

## 闸门六类强制项

| 项 | 阻断码（节选） | 失效时点的认定 |
| --- | --- | --- |
| `script` 脚本版本 | `script_not_found` / `script_not_approved` / `script_version_mismatch` | 场次创建即视为不满足 |
| `equipment` 设备点检 | `equipment_not_checked` / `equipment_failed` / `equipment_late` | **以实际检查时间 `checkedAt` 归属**，补登记时间 `recordedAt` 不改变迟到判定 |
| `operator` 讲师资质 | `qualification_missing` / `qualification_not_yet_valid` / `qualification_expired` | 资质必须在「开场～结束」整个区间有效，区间内到期即失效，`validUntil` 为实际失效时点 |
| `material` 耗材批次 | `material_not_scanned` / `material_batch_mismatch` / `material_quarantined` / `material_expired` / `material_insufficient` | 扫码批号必须等于领用单 `expectedBatchId`；批次有效期须覆盖到场次结束 |
| `capacity` 场地容量 | `attendance_not_counted` / `capacity_exceeded` | 以最近一次清点人数为准 |
| `emergency_staff` 应急人员 | `emergency_staff_missing` / `emergency_staff_late` | **以每人最早一次实际到岗时间为准**，重复签到同一人不多算 |

另有两个系统级阻断项，**不可被例外覆盖**：

- `incident`：该场次存在未结案事故（未确认同样锁场）；
- `session`：场次已被事故停止，须另排新场次。

## 闸门结论

`GET /sessions/:id/gate` 返回：

- `decision`：`go` / `no_go`（开场前），以及 `running` / `stopped` / `completed`；
- `firstFailure`：在所有仍生效阻断中，按**实际失效时间**最早者排序得出的“最先失效项”；
- `blocks[]`：每项含 `message`（人话原因）、`blockedAt`（实际失效时间）、`margin.ms/text`（实际余量，正数尚余、负数已超）、`remediation[]`（可补救动作）、`waivable`；
- `waived[]`：已被有效例外覆盖的阻断，仍然留痕展示；
- `margins`：距开场、距点检/到岗截止、距场次结束的分钟数。

## 例外放行

- 例外必须由复核者授予，权限形如 `waive:equipment`、`waive:operator`……`waive:any` 为通配；
- 例外**只对授予时指定的场次与阻断码生效**（`sessionId` + 可选 `code`），不跨场次、不覆盖未来出现的新阻断码；
- 例外必须针对当前确实存在的阻断，拒绝空白授权；默认在场次结束时失效，也可用 `ttlMinutes` 缩短；
- 事故与已停止场次不可豁免。

## 耗材扫码规则

- `scanId` 是扫码动作的幂等键：同一 `scanId` 重复扫码直接返回原记录（`deduplicated: true`），不重复扣减库存、不重复产生 `consumed` 事件；
- 扫到与领用单不一致的批号：留痕但**不消耗**；补扫正确批号后才消耗一次；
- 已隔离或库存不足的批号：留痕但不消耗，由闸门阻断。

## 开场锁定与事故

- `POST /sessions/:id/start` 在 `decision=go` 时才成功，随即锁定脚本版本与人员名单（`session.lock`）；开场后拒绝补点检、补签到、补扫码；
- 事故登记（`POST /sessions/:id/incidents`）立即把本场次及所有开始时间不早于登记时间的未结束场次置为 `stopped`，点检/扫码/签到/锁定名单等原始记录全部保留，不删除、不回改；
- 事故须经 `incident:resolve` 权限者确认、结案；结案解除事故闸门，但被停场次不自动复活，需另排新场次。

## 持久化与重启

- 状态以原子快照写入 `.runtime/state.json`（临时文件 + rename），所有变更同时追加只增的 `.runtime/audit.log`（JSONL）；
- 倒计时在每次评估时按当前时间实时计算；停用状态、未确认事故均作为记录持久化，进程重启后从快照恢复，按原登记时点继续推进。

## HTTP 接口

基础资料：`POST /reference`；`POST /batches`、`POST /batches/:id/quarantine`、`POST /batches/:id/events`。

场次：`GET /sessions`、`POST /sessions`、`GET /sessions/:id`、`GET /sessions/:id/gate?at=ISO`。

开场前登记：`POST /sessions/:id/equipment-checks`、`/attendance`、`/arrivals`、`/scans`、`/exceptions`。

生命周期：`POST /sessions/:id/start`、`/complete`、`/incidents`；`GET /incidents`、`POST /incidents/:id/confirm`、`/incidents/:id/resolve`。

所有时间字段使用 ISO-8601；业务错误返回 `{ error, message }`，状态码 4xx。
