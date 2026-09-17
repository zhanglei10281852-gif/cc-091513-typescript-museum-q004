import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SafetyGateService } from "../src/service.js";
import { Store } from "../src/store.js";

const START = "2026-09-17T10:00:00.000Z";

function seed(service: SafetyGateService): void {
  service.createVenue({ id: "hall-1", name: "主展厅", capacity: 100 });
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
  service.createStaff({ id: "staff-1", name: "李急救", roles: ["first-aid"] });
  service.createReviewer({ id: "rev-op", name: "资质复核员", permissions: ["operator"] });
  service.registerBatch({
    id: "batch-1",
    materialId: "ln2",
    labelBatchNo: "B202609",
    quantity: 10,
    unit: "L",
  });
  service.createSession({
    id: "sess-1",
    showId: "liquid-nitrogen",
    scriptVersionId: "ln2-v1",
    venueId: "hall-1",
    scheduledStart: START,
    expectedAudience: 50,
    instructorIds: ["inst-1"],
  });
  service.recordInspection("sess-1", {
    equipmentId: "dewar-1",
    result: "pass",
    checkedAt: "2026-09-17T08:30:00Z",
    inspectorId: "tech-1",
  });
  service.createRequisition("sess-1", { id: "req-1", materialId: "ln2", batchNo: "B202609", quantity: 5 });
  service.scanMaterial("sess-1", {
    code: "SCAN-1",
    requisitionId: "req-1",
    batchId: "batch-1",
    quantity: 5,
  });
  service.checkInEmergency("sess-1", { staffId: "staff-1", role: "first-aid" });
}

test("进程重启后倒计时、停用状态和未确认事故按原时点推进", () => {
  const dir = mkdtempSync(join(tmpdir(), "safety-gate-"));
  try {
    let now = new Date("2026-09-17T09:00:00.000Z");
    const first = new SafetyGateService(new Store(dir), () => now);
    seed(first);

    // 放行评估（ready），随后登记一起未确认事故
    const report = first.evaluate("sess-1");
    assert.equal(report.decision, "go");
    assert.equal(report.countdownSeconds, 3600);
    now = new Date("2026-09-17T09:05:00.000Z");
    const incident = first.registerIncident({
      id: "inc-1",
      sessionId: "sess-1",
      description: "演示中液氮容器破损",
      occurredAt: "2026-09-17T09:04:00Z",
    });
    assert.equal(incident.confirmedAt, null);
    assert.equal(first.getSession("sess-1").status, "stopped");

    // 模拟进程重启：新的 Store 与 Service，时钟走到 09:30
    now = new Date("2026-09-17T09:30:00.000Z");
    const restarted = new SafetyGateService(new Store(dir), () => now);

    // 停用状态保留
    const session = restarted.getSession("sess-1");
    assert.equal(session.status, "stopped");
    assert.match(session.stopReason ?? "", /inc-1/);
    assert.equal(session.stopIncidentId, "inc-1");

    // 倒计时按原开场时间继续推进
    const gate = restarted.evaluate("sess-1");
    assert.equal(gate.countdownSeconds, 1800);
    assert.equal(session.status, "stopped"); // 评估不会清除停用状态

    // 未确认事故仍未确认，且继续阻止恢复
    const loaded = restarted.getIncident("inc-1");
    assert.equal(loaded.confirmedAt, null);
    assert.throws(() => restarted.reinstateSession("sess-1", { reviewerId: "rev-op" }));

    // 确认与恢复在重启后依然可用
    restarted.confirmIncident("inc-1", { reviewerId: "rev-op" });
    const restored = restarted.reinstateSession("sess-1", { reviewerId: "rev-op" });
    assert.equal(restored.status, "ready");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("重启后首次失效时间不丢失", () => {
  const dir = mkdtempSync(join(tmpdir(), "safety-gate-"));
  try {
    const now = new Date("2026-09-17T09:00:00.000Z");
    const first = new SafetyGateService(new Store(dir), () => now);
    seed(first);
    // 让资质项失效：换用资质已过期的讲师
    first.createInstructor({
      id: "inst-2",
      name: "赵老师",
      qualifications: [{ code: "LN2-OPS", validUntil: "2026-09-01T00:00:00Z" }],
    });
    first.removeInstructor("sess-1", "inst-1");
    first.assignInstructor("sess-1", { instructorId: "inst-2" });
    const report = first.evaluate("sess-1");
    assert.equal(report.decision, "no_go");
    assert.equal(report.blockingReasons[0]?.since, "2026-09-17T09:00:00.000Z");

    const restarted = new SafetyGateService(new Store(dir), () => now);
    const again = restarted.evaluate("sess-1");
    assert.equal(again.blockingReasons[0]?.since, "2026-09-17T09:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
