# 科学演示开场安全闸门

面向科技展览馆科学演示场次的 TypeScript 后端服务：把演示脚本版本、设备点检、讲师资质、耗材批次、场地容量、应急人员到岗六项强制条件汇成开场安全闸门，直接给出**放行结论、阻断原因、最先失效项、可补救动作与实际余量**。

## 核心规则

- **六类强制闸门**：`script` / `equipment` / `operator` / `material` / `capacity` / `emergency_staff`，任一失效即锁住开场；
- **最先失效项**：按每项的实际失效时间排序（资质到期日、点检实际检查时间、扫码时间、到岗时间……），值班人员可直接看到“先坏的是哪一项”；
- **例外放行**：只有持 `waive:<项>`（或 `waive:any`）权限的复核者能针对**当前场次、当前阻断码**授予，带原因、可设有效期，默认场次结束即失效，全程留痕；事故与已停场次不可豁免；
- **迟到归属**：设备点检、应急到岗均以“实际发生时间”判定，补登记时间不改变迟到事实；
- **扫码幂等**：同一 `scanId` 重复扫码返回原记录且不重复消耗；错批号留痕但不消耗，补扫正确批号才消耗一次；
- **开场锁定**：`start` 成功即冻结脚本版本与人员名单，之后拒绝补点检/补签到/补扫码；
- **事故登记**：立即停止本场次及所有后续未结束场次，点检、扫码、签到、锁定名单等原始记录全部只增保全；事故须由持 `incident:resolve` 权限者确认、结案，被停场次不自动复活；
- **重启延续**：状态原子快照落盘 `.runtime/state.json`，关键动作追加只增审计日志 `.runtime/audit.log`；倒计时实时计算，停用状态与未确认事故按原时点继续。

## 运行

需要 Node.js 22 或更高版本。

```bash
npm ci      # 安装依赖
npm test    # tsc 严格编译 + node:test 全部用例
npm start   # 启动服务，默认 0.0.0.0:8000
```

也可以 `docker compose up --build`（`.runtime` 通过命名卷持久化）。

## 主要接口

所有时间字段为 ISO-8601。返回结构与阻断码枚举见 [`reference/domain.json`](reference/domain.json)，领域语义见 [`docs/domain.md`](docs/domain.md)。

| 方法 & 路径 | 说明 |
| --- | --- |
| `POST /reference` | 批量登记脚本、讲师（含资质有效期）、场地、设备、耗材品类、复核者（含权限） |
| `POST /batches` / `POST /batches/:id/quarantine` | 批号入库（数量、有效期）/ 隔离停用 |
| `POST /sessions` | 创建场次（计划起止、领用批号、设备清单、应急人数、开场前 lead 分钟数） |
| `GET /sessions/:id/gate?at=ISO` | **闸门结论**：decision、firstFailure、blocks、waived、margins |
| `POST /sessions/:id/equipment-checks` | 登记点检（`checkedAt` 为实际检查时间） |
| `POST /sessions/:id/attendance` | 登记入场人数（取最新一次） |
| `POST /sessions/:id/arrivals` | 应急人员到岗（按人去重，取最早实际到岗） |
| `POST /sessions/:id/scans` | 耗材扫码（`scanId` 幂等，批号须匹配领用单） |
| `POST /sessions/:id/exceptions` | 复核者授予例外（校验权限、场次、阻断码、理由） |
| `POST /sessions/:id/start` / `/complete` | 开场（go 才成功，锁定脚本与名单）/ 正常结束 |
| `POST /sessions/:id/incidents` | 登记事故，连锁停止后续场次 |
| `POST /incidents/:id/confirm` / `/resolve` | 事故确认 / 结案（需 `incident:resolve`） |

闸门阻断对象示例：

```json
{
  "item": "operator",
  "code": "qualification_expired",
  "message": "讲师「李讲师」资质于 2026-09-19T00:00:00.000Z 到期，不能覆盖全场",
  "blockedAt": "2026-09-19T00:00:00.000Z",
  "margin": { "ms": -122400000, "text": "资质已过期 1天10小时" },
  "remediation": ["换用资质有效期覆盖全场的讲师", "或由持 waive:operator 权限的复核者针对本场次例外放行"],
  "waivable": true
}
```

运行时数据目录为 `.runtime/`（可用 `RUNTIME_DIR` 覆盖），已在 `.gitignore` 中忽略。
