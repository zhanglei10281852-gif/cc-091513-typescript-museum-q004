import assert from "node:assert/strict";
import { test } from "node:test";

import { ServiceError } from "../src/errors.js";
import { SafetyGateService } from "../src/service.js";
import { Store } from "../src/store.js";

const START = "2026-09-17T10:00:00.000Z";
const T0900 = new Date("2026-09-17T09:00:00.000Z");

function makeService(now: Date) {
  let current = now;
  const service = new SafetyGateService(new Store(null), () => current);
  return {
    service,
    setNow(d: Date) {
      current = d;
    },
  };
}

function seed(service: SafetyGateService): void {
  service.createVenue({ id: "hall-1", name: "主展厅", capacity: 100 });
  service.createVenue({ id: "hall-2", name: "副展厅", capacity: 40 });
  service.createScript({
    id: "ln2-v1",
    showId: "liquid-nitrogen",
    version: "2026.09",
    status: "approved",
    durationMinutes: 45,
    requiredEquipment: ["dewar-1"],
    requiredQualifications: ["LN2-OPS"],
    requiredMaterials: [{ materialId: "ln2", quantity: 5, unit: "L" }],
    requiredEmergencyRoles: [{ role: "first-aid", count: 1 }],
    maxAudience: 80,
  });
  service.createInstructor({
    id: "inst-1",
    name: "王老师",
    qualifications: [{ code: "LN2-OPS", validUntil: "2026-12-31T00:00:00Z" }],
  });
  service.createInstructor({
    id: "inst-2",
    name: "赵老师",
    qualifications: [{ code: "LN2-OPS", validUntil: "2026-09-01T00:00:00Z" }],
  });
  service.createStaff({ id: "staff-1", name: "李急救", roles: ["first-aid"] });
  service.createReviewer({ id: "rev-equip", name: "设备复核员", permissions: ["equipment"] });
  service.createReviewer({ id: "rev-op", name: "资质复核员", permissions: ["operator"] });
  service.registerBatch({
    id: "batch-1",
    materialId: "ln2",
    labelBatchNo: "B202609",
    quantity: 10,
    unit: "L",
  });
}

function seedSession(service: SafetyGateService, overrides: Record<string, unknown> = {}) {
  return service.createSession({
    id: "sess-1",
    showId: "liquid-nitrogen",
    scriptVersionId: "ln2-v1",
    venueId: "hall-1",
    scheduledStart: START,
    expectedAudience: 50,
    instructorIds: ["inst-1"],
    ...overrides,
  });
}

/** 补齐点检、耗材、应急签到，使场次满足放行条件。 */
function fulfill(service: SafetyGateService, sessionId = "sess-1"): void {
  service.recordInspection(sessionId, {
    equipmentId: "dewar-1",
    result: "pass",
    checkedAt: "2026-09-17T08:30:00Z",
    inspectorId: "tech-1",
  });
  service.createRequisition(sessionId, {
    id: `req-${sessionId}`,
    materialId: "ln2",
    batchNo: "B202609",
    quantity: 5,
  });
  service.scanMaterial(sessionId, {
    code: `SCAN-${sessionId}`,
    requisitionId: `req-${sessionId}`,
    batchId: "batch-1",
    quantity: 5,
  });
  service.checkInEmergency(sessionId, { staffId: "staff-1", role: "first-aid" });
}

test("全部条件满足时放行，并给出倒计时与各项实际余量", () => {
  const { service } = makeService(T0900);
  seed(service);
  seedSession(service);
  fulfill(service);

  const report = service.evaluate("sess-1");
  assert.equal(report.decision, "go");
  assert.equal(report.countdownSeconds, 3600);
  assert.equal(report.blockingReasons.length, 0);
  assert.equal(report.checks.every((c) => c.status === "pass"), true);

  // 实际余量
  assert.equal(report.margins.countdownSeconds, 3600);
  assert.equal(report.margins.capacitySeats, 30); // min(100, 80) - 50
  assert.equal(report.margins.qualificationDays, 104);
  assert.equal(report.margins.inspectionMinutes, 150); // 240 - 90
  assert.equal(report.margins.emergencyStaff, 0);
  assert.deepEqual(report.margins.materials, [
    { materialId: "ln2", required: 5, reserved: 5, margin: 0, unit: "L" },
  ]);

  assert.equal(service.getSession("sess-1").status, "ready");
});

test("讲师资质过期：阻断开场并给出补救动作", () => {
  const { service } = makeService(T0900);
  seed(service);
  seedSession(service, { instructorIds: ["inst-2"] });
  fulfill(service);

  const report = service.evaluate("sess-1");
  assert.equal(report.decision, "no_go");
  assert.equal(service.getSession("sess-1").status, "blocked");

  const operator = report.blockingReasons.find((r) => r.condition === "operator");
  assert.ok(operator);
  assert.match(operator.summary, /LN2-OPS/);
  assert.match(operator.summary, /早于场次结束/);

  const actions = report.remediableActions.find((a) => a.condition === "operator");
  assert.ok(actions);
  assert.ok(actions.actions.some((a) => a.includes("续期") || a.includes("更换")));
});

test("迟到点检按实际检查时间归属，补录不改变判定", () => {
  const { service, setNow } = makeService(new Date("2026-09-17T09:50:00.000Z"));
  seed(service);
  seedSession(service);
  service.createRequisition("sess-1", { id: "req-1", materialId: "ln2", batchNo: "B202609", quantity: 5 });
  service.scanMaterial("sess-1", { code: "SCAN-1", requisitionId: "req-1", batchId: "batch-1", quantity: 5 });
  service.checkInEmergency("sess-1", { staffId: "staff-1", role: "first-aid" });

  // 实际检查时间距开场仅 10 分钟 → 迟到点检，阻断
  service.recordInspection("sess-1", {
    equipmentId: "dewar-1",
    result: "pass",
    checkedAt: "2026-09-17T09:50:00Z",
    inspectorId: "tech-1",
  });
  const late = service.evaluate("sess-1");
  assert.equal(late.decision, "no_go");
  const equipment = late.checks.find((c) => c.condition === "equipment");
  assert.ok(equipment);
  assert.equal(equipment.status, "fail");
  assert.match(equipment.summary, /点检过晚/);
  assert.match(equipment.summary, /实际检查时间/);

  // 补录：登记时间晚，但实际检查时间合规 → 仍然有效
  const { service: service2 } = makeService(new Date("2026-09-17T09:50:00.000Z"));
  seed(service2);
  seedSession(service2);
  service2.createRequisition("sess-1", { id: "req-1", materialId: "ln2", batchNo: "B202609", quantity: 5 });
  service2.scanMaterial("sess-1", { code: "SCAN-1", requisitionId: "req-1", batchId: "batch-1", quantity: 5 });
  service2.checkInEmergency("sess-1", { staffId: "staff-1", role: "first-aid" });
  service2.recordInspection("sess-1", {
    equipmentId: "dewar-1",
    result: "pass",
    checkedAt: "2026-09-17T08:30:00Z",
    inspectorId: "tech-1",
  });
  const backfilled = service2.evaluate("sess-1");
  assert.equal(backfilled.decision, "go");

  // 倒签/预填：实际检查时间晚于当前时间 → 拒绝登记
  setNow(new Date("2026-09-17T09:55:00.000Z"));
  assert.throws(
    () =>
      service.recordInspection("sess-1", {
        equipmentId: "dewar-1",
        result: "pass",
        checkedAt: "2026-09-17T10:30:00Z",
        inspectorId: "tech-1",
      }),
    (error: unknown) =>
      error instanceof ServiceError && error.status === 400 && error.code === "future_check_time",
  );
});

test("耗材标签批号与领用单不一致：扫码被拒，闸门显示缺口", () => {
  const { service } = makeService(T0900);
  seed(service);
  seedSession(service);
  service.recordInspection("sess-1", {
    equipmentId: "dewar-1",
    result: "pass",
    checkedAt: "2026-09-17T08:30:00Z",
    inspectorId: "tech-1",
  });
  service.checkInEmergency("sess-1", { staffId: "staff-1", role: "first-aid" });
  service.registerBatch({
    id: "batch-wrong",
    materialId: "ln2",
    labelBatchNo: "B202610",
    quantity: 5,
    unit: "L",
  });
  service.createRequisition("sess-1", { id: "req-1", materialId: "ln2", batchNo: "B202609", quantity: 5 });

  assert.throws(
    () =>
      service.scanMaterial("sess-1", {
        code: "SCAN-WRONG",
        requisitionId: "req-1",
        batchId: "batch-wrong",
        quantity: 5,
      }),
    (error: unknown) =>
      error instanceof ServiceError && error.status === 409 && error.code === "batch_no_mismatch",
  );

  const report = service.evaluate("sess-1");
  assert.equal(report.decision, "no_go");
  const material = report.checks.find((c) => c.condition === "material");
  assert.ok(material);
  assert.equal(material.status, "fail");
  assert.deepEqual(report.margins.materials, [
    { materialId: "ln2", required: 5, reserved: 0, margin: -5, unit: "L" },
  ]);
});

test("重复扫码不多次消耗耗材", () => {
  const { service } = makeService(T0900);
  seed(service);
  seedSession(service);
  service.createRequisition("sess-1", { id: "req-1", materialId: "ln2", batchNo: "B202609", quantity: 5 });

  const first = service.scanMaterial("sess-1", {
    code: "SCAN-1",
    requisitionId: "req-1",
    batchId: "batch-1",
    quantity: 5,
  });
  assert.equal(first.deduplicated, false);
  assert.equal(first.stock.reservedActive, 5);
  assert.equal(first.stock.available, 5);

  // 相同内容重复扫码：幂等返回，不重复预留
  const dup = service.scanMaterial("sess-1", {
    code: "SCAN-1",
    requisitionId: "req-1",
    batchId: "batch-1",
    quantity: 5,
  });
  assert.equal(dup.deduplicated, true);
  assert.equal(dup.event.id, first.event.id);
  assert.equal(dup.stock.reservedActive, 5);
  assert.equal(dup.stock.available, 5);

  // 同一扫码码但内容不一致：冲突拒绝
  assert.throws(
    () =>
      service.scanMaterial("sess-1", {
        code: "SCAN-1",
        requisitionId: "req-1",
        batchId: "batch-1",
        quantity: 3,
      }),
    (error: unknown) =>
      error instanceof ServiceError && error.status === 409 && error.code === "scan_conflict",
  );
});

test("例外放行：权限校验、仅当前场次、脚本项不可例外", () => {
  const { service } = makeService(T0900);
  seed(service);
  seedSession(service, { instructorIds: ["inst-2"] });
  fulfill(service);

  // 无对应权限的复核者 → 403
  assert.throws(
    () =>
      service.grantException("sess-1", {
        checkType: "operator",
        reviewerId: "rev-equip",
        reason: "资质续期办理中",
      }),
    (error: unknown) =>
      error instanceof ServiceError && error.status === 403 && error.code === "permission_denied",
  );

  // 脚本版本不可例外
  assert.throws(
    () =>
      service.grantException("sess-1", {
        checkType: "script",
        reviewerId: "rev-op",
        reason: "试图豁免脚本",
      }),
    (error: unknown) => error instanceof ServiceError && error.status === 400,
  );

  // 有权限的复核者 → 放行，检查项标记为 waived
  const grant = service.grantException("sess-1", {
    checkType: "operator",
    reviewerId: "rev-op",
    reason: "资质续期办理中，复核后放行",
  });
  const report = service.evaluate("sess-1");
  assert.equal(report.decision, "go");
  const operator = report.checks.find((c) => c.condition === "operator");
  assert.ok(operator);
  assert.equal(operator.status, "waived");
  assert.equal(operator.waivedByExceptionId, grant.id);
  assert.equal(report.activeExceptions.length, 1);

  // 例外仅对当前场次有效：另一场次同样问题仍然阻断
  seedSession(service, { id: "sess-2", instructorIds: ["inst-2"] });
  const other = service.evaluate("sess-2");
  assert.equal(other.decision, "no_go");
  const otherOperator = other.checks.find((c) => c.condition === "operator");
  assert.ok(otherOperator);
  assert.equal(otherOperator.status, "fail");
});

test("演示开始后锁定脚本与人员名单，预留耗材转为消耗", () => {
  const { service } = makeService(T0900);
  seed(service);
  seedSession(service);
  fulfill(service);

  const { session } = service.startSession("sess-1");
  assert.equal(session.status, "running");
  assert.equal(session.lockedScriptVersionId, "ln2-v1");
  assert.deepEqual(new Set(session.lockedRoster ?? []), new Set(["inst-1", "staff-1"]));

  // 锁定后不可再改
  for (const mutate of [
    () => service.assignScript("sess-1", { scriptVersionId: "ln2-v1" }),
    () => service.assignInstructor("sess-1", { instructorId: "inst-2" }),
    () => service.removeInstructor("sess-1", "inst-1"),
    () =>
      service.recordInspection("sess-1", {
        equipmentId: "dewar-1",
        result: "pass",
        checkedAt: "2026-09-17T08:40:00Z",
        inspectorId: "tech-1",
      }),
    () => service.checkInEmergency("sess-1", { staffId: "staff-1", role: "first-aid" }),
  ]) {
    assert.throws(mutate, (error: unknown) => error instanceof ServiceError && error.status === 409);
  }

  // 预留已转为消耗，且只消耗一次
  const stock = service.batchStock("batch-1");
  assert.equal(stock.consumed, 5);
  assert.equal(stock.reservedActive, 0);
  assert.equal(stock.available, 5);
});

test("闸门未放行时不能开场", () => {
  const { service } = makeService(T0900);
  seed(service);
  seedSession(service, { instructorIds: ["inst-2"] });

  assert.throws(
    () => service.startSession("sess-1"),
    (error: unknown) => {
      if (!(error instanceof ServiceError)) return false;
      if (error.status !== 409 || error.code !== "gate_blocked") return false;
      const report = error.details as { decision: string; blockingReasons: unknown[] };
      return report.decision === "no_go" && report.blockingReasons.length > 0;
    },
  );
});

test("事故登记停止后续场次并保全原始记录，确认后才可恢复", () => {
  const { service, setNow } = makeService(T0900);
  seed(service);
  seedSession(service, { id: "sess-a" });
  fulfill(service, "sess-a");
  seedSession(service, { id: "sess-b", scheduledStart: "2026-09-17T11:00:00.000Z" });
  fulfill(service, "sess-b");
  seedSession(service, {
    id: "sess-c",
    venueId: "hall-2",
    scheduledStart: "2026-09-17T11:00:00.000Z",
    expectedAudience: 30,
  });

  service.startSession("sess-a");
  service.evaluate("sess-b");
  assert.equal(service.getSession("sess-b").status, "ready");

  setNow(new Date("2026-09-17T09:10:00.000Z"));
  const incident = service.registerIncident({
    id: "inc-1",
    sessionId: "sess-a",
    description: "液氮洒出，观众疏散",
    occurredAt: "2026-09-17T09:08:00Z",
  });

  // 本场次与同场地后续场次被停止，其它场地不受影响
  assert.equal(service.getSession("sess-a").status, "stopped");
  assert.equal(service.getSession("sess-b").status, "stopped");
  assert.notEqual(service.getSession("sess-c").status, "stopped");
  assert.deepEqual(incident.affectedSessionIds, ["sess-b"]);

  // 原始记录保全
  assert.equal(incident.snapshot.session.id, "sess-a");
  assert.equal(incident.snapshot.session.status, "running");
  assert.equal(incident.snapshot.gateReport.sessionId, "sess-a");
  assert.equal(incident.snapshot.gateReport.decision, "go");
  assert.ok(incident.snapshot.inspections.length > 0);
  assert.ok(incident.snapshot.materialEvents.length > 0);
  assert.equal(incident.confirmedAt, null);

  // 未确认事故：不能恢复
  assert.throws(
    () => service.reinstateSession("sess-b", { reviewerId: "rev-op" }),
    (error: unknown) =>
      error instanceof ServiceError && error.status === 409 && error.code === "incident_unconfirmed",
  );

  // 确认后可恢复，恢复后重新评估闸门
  service.confirmIncident("inc-1", { reviewerId: "rev-op" });
  const restored = service.reinstateSession("sess-b", { reviewerId: "rev-op" });
  assert.equal(restored.status, "ready");
  assert.equal(restored.stopReason, null);
  assert.equal(restored.stopIncidentId, null);
});

test("阻断原因按首次失效时间排序，回答哪项条件最先失效", () => {
  const { service, setNow } = makeService(T0900);
  seed(service);
  seedSession(service, { instructorIds: ["inst-2"] });
  fulfill(service);

  const first = service.evaluate("sess-1");
  assert.deepEqual(
    first.blockingReasons.map((r) => r.condition),
    ["operator"],
  );
  assert.equal(first.blockingReasons[0]?.since, "2026-09-17T09:00:00.000Z");

  // 之后耗材批次被隔离，出现第二个失效条件
  setNow(new Date("2026-09-17T09:05:00.000Z"));
  service.quarantineBatch("batch-1", { reason: "批次复检不合格" });
  const second = service.evaluate("sess-1");
  assert.deepEqual(
    second.blockingReasons.map((r) => r.condition),
    ["operator", "material"],
  );
  assert.equal(second.blockingReasons[0]?.since, "2026-09-17T09:00:00.000Z");
  assert.equal(second.blockingReasons[1]?.since, "2026-09-17T09:05:00.000Z");
});
