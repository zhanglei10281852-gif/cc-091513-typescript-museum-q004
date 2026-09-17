import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { SystemClock } from "../src/domain/clock.js";
import { DomainError } from "../src/domain/errors.js";
import { SafetyGateService } from "../src/domain/service.js";
import { Store } from "../src/domain/store.js";
import {
  createStandardSession,
  makeService,
  satisfyAllChecks,
  seedReference,
  standardBatch,
} from "./helpers.js";

test("重复扫码不多次消耗耗材，返回去重标记", () => {
  const { service } = makeService("2026-09-20T09:22:00.000Z");
  seedReference(service);
  standardBatch(service, { quantity: 50 });
  const id = createStandardSession(service);

  const first = service.scanMaterial(id, {
    scanId: "QR-DUP-1",
    materialId: "mat_ln2",
    batchId: "b_0001",
    scannedAt: "2026-09-20T09:22:00.000Z",
    scannedBy: "staff",
  });
  assert.equal(first.deduplicated, false);
  const batchAfterFirst = service.getState().batches.find((b) => b.id === "b_0001")!;
  assert.equal(batchAfterFirst.quantity, 40);

  const second = service.scanMaterial(id, {
    scanId: "QR-DUP-1",
    materialId: "mat_ln2",
    batchId: "b_0001",
    scannedAt: "2026-09-20T09:25:00.000Z",
    scannedBy: "staff",
  });
  assert.equal(second.deduplicated, true);
  const batchAfterSecond = service.getState().batches.find((b) => b.id === "b_0001")!;
  assert.equal(batchAfterSecond.quantity, 40);
  const consumeEvents = service
    .getState()
    .materialEvents.filter((e) => e.type === "consumed");
  assert.equal(consumeEvents.length, 1);
});

test("批号与领用单不一致时不消耗；补扫正确批号才消耗一次", () => {
  const { service } = makeService("2026-09-20T09:22:00.000Z");
  seedReference(service);
  standardBatch(service, { quantity: 50 });
  service.receiveBatch({
    id: "b_9999",
    materialId: "mat_ln2",
    quantity: 30,
    receivedAt: "2026-09-19T08:00:00.000Z",
  });
  const id = createStandardSession(service);
  // 除扫码外其余五项检查齐备
  for (const equipmentId of ["eq_dewar", "eq_gloves"]) {
    service.recordEquipmentCheck(id, {
      equipmentId,
      ok: true,
      checkedAt: "2026-09-20T09:20:00.000Z",
      checkedBy: "staff",
    });
  }
  service.recordAttendance(id, { count: 80, countedAt: "2026-09-20T09:21:00.000Z" });
  service.recordArrival(id, { personId: "e_01", name: "周安全员", arrivedAt: "2026-09-20T09:20:00.000Z" });
  service.recordArrival(id, { personId: "e_02", name: "吴安全员", arrivedAt: "2026-09-20T09:21:00.000Z" });

  // 先扫错批号：两个批号库存都不变，闸门判批号不一致
  service.scanMaterial(id, {
    scanId: "QR-WRONG",
    materialId: "mat_ln2",
    batchId: "b_9999",
    scannedAt: "2026-09-20T09:22:00.000Z",
    scannedBy: "staff",
  });
  assert.equal(service.getState().batches.find((b) => b.id === "b_0001")!.quantity, 50);
  assert.equal(service.getState().batches.find((b) => b.id === "b_9999")!.quantity, 30);
  assert.equal(service.evaluate(id).decision, "no_go");

  // 补扫正确批号：此时才消耗一次
  service.scanMaterial(id, {
    scanId: "QR-RIGHT",
    materialId: "mat_ln2",
    batchId: "b_0001",
    scannedAt: "2026-09-20T09:23:00.000Z",
    scannedBy: "staff",
  });
  assert.equal(service.getState().batches.find((b) => b.id === "b_0001")!.quantity, 40);
  assert.equal(service.evaluate(id).decision, "go");

  // 正确批号再扫一次：不多次消耗
  service.scanMaterial(id, {
    scanId: "QR-RIGHT-2",
    materialId: "mat_ln2",
    batchId: "b_0001",
    scannedAt: "2026-09-20T09:24:00.000Z",
    scannedBy: "staff",
  });
  assert.equal(service.getState().batches.find((b) => b.id === "b_0001")!.quantity, 40);
});

test("开场锁定脚本与人员名单，开场后不能再补点检或改签到", () => {
  const { service } = makeService("2026-09-20T09:55:00.000Z");
  seedReference(service);
  standardBatch(service);
  const id = createStandardSession(service);
  satisfyAllChecks(service, id);
  const started = service.start(id, { at: "2026-09-20T10:00:00.000Z" });
  assert.equal(started.session.state, "running");
  assert.ok(started.session.lock);
  assert.equal(started.session.lock!.scriptVersion, "3");
  const staffIds = started.session.lock!.staff.map((s) => s.personId).sort();
  assert.deepEqual(staffIds, ["e_01", "e_02", "p_wang"]);

  assert.throws(
    () =>
      service.recordEquipmentCheck(id, {
        equipmentId: "eq_gloves",
        ok: false,
        checkedAt: "2026-09-20T10:05:00.000Z",
        checkedBy: "staff",
      }),
    (e: unknown) => e instanceof DomainError && e.code === "session_locked",
  );
  assert.throws(
    () =>
      service.recordArrival(id, {
        personId: "e_99",
        name: "后来者",
        arrivedAt: "2026-09-20T10:01:00.000Z",
      }),
    (e: unknown) => e instanceof DomainError && e.code === "session_locked",
  );

  service.complete(id, { at: "2026-09-20T11:00:00.000Z" });
  assert.equal(service.getState().sessions[0]!.state, "completed");
});

test("开场时仍有阻断则拒绝并指明最先失效项", () => {
  const { service } = makeService("2026-09-20T09:55:00.000Z");
  seedReference(service);
  standardBatch(service);
  const id = createStandardSession(service);
  // 什么都没登记
  assert.throws(
    () => service.start(id),
    (e: unknown) => e instanceof DomainError && e.code === "gate_blocked",
  );
});

test("事故登记停止本场次及所有后续场次，原始记录全部保留", () => {
  const { service } = makeService("2026-09-20T09:44:00.000Z");
  seedReference(service);
  standardBatch(service);
  const first = createStandardSession(service, { id: "sess_am" });
  satisfyAllChecks(service, first);
  const next = createStandardSession(service, {
    id: "sess_pm",
    startIso: "2026-09-20T14:00:00.000Z",
  });
  satisfyAllChecks(service, next);
  const later = createStandardSession(service, {
    id: "sess_tomorrow",
    startIso: "2026-09-21T10:00:00.000Z",
  });
  satisfyAllChecks(service, later);

  // 上午场已开场
  service.start(first, { at: "2026-09-20T10:00:00.000Z" });

  const incident = service.registerIncident(first, {
    description: "演示中冻伤",
    registeredBy: "staff",
    registeredAt: "2026-09-20T10:20:00.000Z",
  });

  const states = Object.fromEntries(
    service.getState().sessions.map((s) => [s.id, s.state]),
  );
  assert.equal(states[first], "stopped");
  assert.equal(states[next], "stopped");
  assert.equal(states[later], "stopped");
  assert.equal(service.getState().sessions[0]!.suspendedByIncidentId, incident.id);

  // 运行中开场的锁定记录仍在（原始记录保全）
  assert.ok(service.getState().sessions[0]!.lock);
  // 点检/扫码/签到记录一条不少
  assert.equal(service.getState().equipmentChecks.length, 6);
  assert.equal(service.getState().scans.length, 3);
  assert.equal(service.getState().arrivals.length, 6);

  // 未确认事故同样锁住后续场次开场
  assert.throws(() => service.start(later), (e: unknown) => e instanceof DomainError);

  // 无权限者不能确认
  assert.throws(
    () => service.confirmIncident(incident.id, { reviewerId: "r_nobody" }),
    (e: unknown) => e instanceof DomainError && e.code === "forbidden",
  );
  service.confirmIncident(incident.id, { reviewerId: "r_boss" });
  service.resolveIncident(incident.id, { reviewerId: "r_boss", note: "整改完成" });

  // 事故结案后被停场次不自动复活，必须另排
  assert.equal(service.getState().sessions.find((s) => s.id === later)!.state, "stopped");
});

test("重启后状态、停用、未确认事故、倒计时按原时点延续", () => {
  const { service, dir, clock } = makeService("2026-09-20T09:44:00.000Z");
  seedReference(service);
  standardBatch(service);
  const id = createStandardSession(service);
  satisfyAllChecks(service, id);
  service.registerIncident(id, {
    description: "未确认事故",
    registeredBy: "staff",
    registeredAt: "2026-09-20T09:40:00.000Z",
  });
  assert.ok(existsSync(join(dir, "state.json")));
  assert.ok(existsSync(join(dir, "audit.log")));

  // 模拟进程重启：新服务实例从同一快照恢复，时钟推进 20 分钟
  clock.set("2026-09-20T10:04:00.000Z");
  const restarted = new SafetyGateService(
    new Store(join(dir, "state.json"), new SystemClock()),
    clock,
  );
  const session = restarted.getState().sessions[0]!;
  assert.equal(session.state, "stopped");
  assert.equal(session.suspendedByIncidentId !== undefined, true);

  const incident = restarted.getState().incidents[0]!;
  assert.equal(incident.confirmedAt, undefined);

  const gate = restarted.evaluate(id);
  assert.equal(gate.decision, "stopped");
  // 事故持续时间按原登记时点推进到重启后（24 分钟），已超为负
  const block = gate.blocks[0]!;
  assert.equal(block.margin.ms, -24 * 60_000);

  // 审计日志只增：包含重启前全部关键动作
  const auditLines = readFileSync(join(dir, "audit.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { action: string });
  const actions = auditLines.map((e) => e.action);
  assert.ok(actions.includes("incident_register"));
  assert.ok(actions.includes("material_scan"));
});
