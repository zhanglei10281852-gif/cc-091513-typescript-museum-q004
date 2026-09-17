import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createStandardSession,
  makeService,
  satisfyAllChecks,
  seedReference,
  standardBatch,
} from "./helpers.js";

test("全部强制条件满足时放行，并给出关键时点余量", () => {
  const { service } = makeService("2026-09-20T09:30:00.000Z");
  seedReference(service);
  standardBatch(service);
  const id = createStandardSession(service);
  satisfyAllChecks(service, id);

  const gate = service.evaluate(id, "2026-09-20T09:30:00.000Z");
  assert.equal(gate.decision, "go");
  assert.equal(gate.blocks.length, 0);
  assert.equal(gate.margins.minutesToStart, 30);
  assert.equal(gate.margins.minutesToDeadline, 0);
  assert.equal(gate.margins.minutesToEnd, 90);
  assert.equal(service.getState().sessions[0]!.state, "ready");
});

test("资质先于批号失效时，最先失效项指向讲师资质；换讲师后转为批号问题", () => {
  const { service } = makeService("2026-09-20T09:25:00.000Z");
  seedReference(service);
  standardBatch(service);
  // 李讲师资质已于前一天到期；领用批号 b_0001 却扫成 b_0002
  service.receiveBatch({
    id: "b_0002",
    materialId: "mat_ln2",
    quantity: 20,
    receivedAt: "2026-09-19T08:00:00.000Z",
  });
  const id = createStandardSession(service, { presenterId: "p_li" });
  satisfyAllChecks(service, id);
  service.scanMaterial(id, {
    scanId: "SCAN-WRONG",
    materialId: "mat_ln2",
    batchId: "b_0002",
    scannedAt: "2026-09-20T09:23:30.000Z",
    scannedBy: "staff",
  });

  let gate = service.evaluate(id);
  assert.equal(gate.decision, "no_go");
  const codes = gate.blocks.map((b) => `${b.item}/${b.code}`);
  assert.ok(codes.includes("operator/qualification_expired"));
  assert.ok(codes.includes("material/material_batch_mismatch"));
  assert.ok(gate.firstFailure);
  assert.equal(gate.firstFailure.item, "operator");
  assert.equal(gate.firstFailure.code, "qualification_expired");
  // 余量如实反映已过期时长
  assert.ok(gate.firstFailure.margin.ms !== null && gate.firstFailure.margin.ms < 0);

  // 补救动作具体可执行
  const operatorBlock = gate.blocks.find((b) => b.item === "operator")!;
  assert.ok(operatorBlock.remediation.some((r) => r.includes("换用资质")));

  // 补救一：换用资质有效的王讲师——批号不一致成为最先失效项
  // 通过新建等价场次模拟重新指派（开场前场次不可直接改人，走例外或改派）
  const id2 = "sess_demo2";
  const s2 = service.createSession({
    id: id2,
    title: "改派场",
    scriptId: "scr_ln2",
    scriptVersion: "3",
    venueId: "v_hall_a",
    presenterId: "p_wang",
    requiredQualification: "liquid_nitrogen",
    equipmentIds: ["eq_dewar", "eq_gloves"],
    materials: [{ materialId: "mat_ln2", expectedBatchId: "b_0001", quantity: 10 }],
    emergencyStaffRequired: 2,
    scheduledStart: "2026-09-20T10:00:00.000Z",
    scheduledEnd: "2026-09-20T11:00:00.000Z",
    leadMinutes: 30,
  });
  satisfyAllChecks(service, id2);
  service.scanMaterial(id2, {
    scanId: "SCAN-WRONG-2",
    materialId: "mat_ln2",
    batchId: "b_0002",
    scannedAt: "2026-09-20T09:23:00.000Z",
    scannedBy: "staff",
  });
  gate = service.evaluate(id2);
  assert.equal(gate.firstFailure?.item, "material");
  assert.equal(gate.firstFailure?.code, "material_batch_mismatch");

  // 补救二：重新领用正确批号 b_0001 → 放行
  service.scanMaterial(id2, {
    scanId: "SCAN-RIGHT",
    materialId: "mat_ln2",
    batchId: "b_0001",
    scannedAt: "2026-09-20T09:24:00.000Z",
    scannedBy: "staff",
  });
  gate = service.evaluate(id2);
  assert.equal(gate.decision, "go", JSON.stringify(gate.blocks, null, 2));
  void s2;
});

test("迟到点检按实际检查时间归属：09:45 才实际检查，即使 09:10 补登记也判迟到", () => {
  const { service } = makeService("2026-09-20T09:50:00.000Z");
  seedReference(service);
  standardBatch(service);
  const id = createStandardSession(service);
  satisfyAllChecks(service, id);
  // 手套重新点检：登记动作发生在 09:10（clock），但实际检查时间填报 09:45
  service.recordEquipmentCheck(id, {
    equipmentId: "eq_gloves",
    ok: true,
    checkedAt: "2026-09-20T09:45:00.000Z",
    checkedBy: "late-staff",
  });
  const gate = service.evaluate(id);
  const block = gate.blocks.find((b) => b.code === "equipment_late");
  assert.ok(block, "应有迟到点检阻断");
  assert.equal(block!.blockedAt, "2026-09-20T09:45:00.000Z");
  assert.match(block!.message, /晚于截止/);
  assert.equal(gate.firstFailure?.code, "equipment_late");
});

test("点检不合格阻断，重新点检合格后解除", () => {
  const { service } = makeService("2026-09-20T09:20:00.000Z");
  seedReference(service);
  standardBatch(service);
  const id = createStandardSession(service);
  satisfyAllChecks(service, id);
  service.recordEquipmentCheck(id, {
    equipmentId: "eq_dewar",
    ok: false,
    checkedAt: "2026-09-20T09:25:00.000Z",
    checkedBy: "staff",
    note: "阀门结霜",
  });
  let gate = service.evaluate(id);
  assert.ok(gate.blocks.some((b) => b.code === "equipment_failed"));
  assert.match(gate.blocks.find((b) => b.code === "equipment_failed")!.message, /阀门结霜/);

  service.recordEquipmentCheck(id, {
    equipmentId: "eq_dewar",
    ok: true,
    checkedAt: "2026-09-20T09:27:00.000Z",
    checkedBy: "staff",
  });
  gate = service.evaluate(id);
  assert.equal(gate.decision, "go");
});

test("超员阻断并给出负余量，疏散后重新清点可放行", () => {
  const { service } = makeService("2026-09-20T09:57:00.000Z");
  seedReference(service);
  standardBatch(service);
  const id = createStandardSession(service);
  satisfyAllChecks(service, id);
  service.recordAttendance(id, { count: 105, countedAt: "2026-09-20T09:54:00.000Z" });
  let gate = service.evaluate(id);
  const block = gate.blocks.find((b) => b.code === "capacity_exceeded")!;
  assert.ok(block);
  assert.equal(block.margin.ms, -5);
  assert.match(block.margin.text, /超出 5 人/);

  service.recordAttendance(id, { count: 99, countedAt: "2026-09-20T09:56:00.000Z" });
  gate = service.evaluate(id);
  assert.equal(gate.decision, "go");
});

test("应急人员迟到：按实际到岗时间判定，同一人重复签到不多算", () => {
  const { service } = makeService("2026-09-20T09:50:00.000Z");
  seedReference(service);
  standardBatch(service);
  const id = createStandardSession(service);
  // 除应急人员外其余条件齐备
  service.recordEquipmentCheck(id, {
    equipmentId: "eq_dewar",
    ok: true,
    checkedAt: "2026-09-20T09:20:00.000Z",
    checkedBy: "staff",
  });
  service.recordEquipmentCheck(id, {
    equipmentId: "eq_gloves",
    ok: true,
    checkedAt: "2026-09-20T09:21:00.000Z",
    checkedBy: "staff",
  });
  service.scanMaterial(id, {
    scanId: `SCAN-${id}`,
    materialId: "mat_ln2",
    batchId: "b_0001",
    scannedAt: "2026-09-20T09:22:00.000Z",
    scannedBy: "staff",
  });
  service.recordAttendance(id, { count: 80, countedAt: "2026-09-20T09:50:00.000Z" });

  // 一人按时（09:25），另一人实际到岗 09:40，晚于截止 09:30
  service.recordArrival(id, {
    personId: "e_01",
    name: "周安全员",
    arrivedAt: "2026-09-20T09:25:00.000Z",
  });
  service.recordArrival(id, {
    personId: "e_02",
    name: "吴安全员",
    arrivedAt: "2026-09-20T09:40:00.000Z",
  });
  let gate = service.evaluate(id);
  const lateBlock = gate.blocks.find((b) => b.code === "emergency_staff_late");
  assert.ok(lateBlock);
  assert.equal(lateBlock!.blockedAt, "2026-09-20T09:40:00.000Z");

  // e_02 再多签几次（均为迟到时间）也不能凑数
  service.recordArrival(id, {
    personId: "e_02",
    name: "吴安全员",
    arrivedAt: "2026-09-20T09:41:00.000Z",
  });
  gate = service.evaluate(id);
  assert.ok(gate.blocks.some((b) => b.code === "emergency_staff_late"));

  // 新人 09:29 实际到岗（补员）→ 按时到岗 2 人，放行
  service.recordArrival(id, {
    personId: "e_03",
    name: "郑安全员",
    arrivedAt: "2026-09-20T09:29:00.000Z",
  });
  gate = service.evaluate(id);
  assert.equal(gate.decision, "go", JSON.stringify(gate.blocks, null, 2));
});

test("应急人员重复签到同一人不能凑数，必须补员新到岗者", () => {
  const { service } = makeService("2026-09-20T09:50:00.000Z");
  seedReference(service);
  standardBatch(service);
  const id = createStandardSession(service);
  service.recordEquipmentCheck(id, {
    equipmentId: "eq_dewar",
    ok: true,
    checkedAt: "2026-09-20T09:20:00.000Z",
    checkedBy: "staff",
  });
  service.recordEquipmentCheck(id, {
    equipmentId: "eq_gloves",
    ok: true,
    checkedAt: "2026-09-20T09:21:00.000Z",
    checkedBy: "staff",
  });
  service.scanMaterial(id, {
    scanId: `SCAN-${id}`,
    materialId: "mat_ln2",
    batchId: "b_0001",
    scannedAt: "2026-09-20T09:22:00.000Z",
    scannedBy: "staff",
  });
  service.recordAttendance(id, { count: 80, countedAt: "2026-09-20T09:50:00.000Z" });

  service.recordArrival(id, {
    personId: "e_01",
    name: "周安全员",
    arrivedAt: "2026-09-20T09:25:00.000Z",
  });
  // 同一人重复签到两次不能凑成 2 人
  service.recordArrival(id, {
    personId: "e_01",
    name: "周安全员",
    arrivedAt: "2026-09-20T09:26:00.000Z",
  });
  service.recordArrival(id, {
    personId: "e_01",
    name: "周安全员",
    arrivedAt: "2026-09-20T09:27:00.000Z",
  });
  let gate = service.evaluate(id);
  assert.ok(gate.blocks.some((b) => b.code === "emergency_staff_missing"));

  // 新人 09:29 到岗 → 满足 2 人
  service.recordArrival(id, {
    personId: "e_03",
    name: "郑安全员",
    arrivedAt: "2026-09-20T09:29:00.000Z",
  });
  gate = service.evaluate(id);
  assert.equal(gate.decision, "go", JSON.stringify(gate.blocks, null, 2));
});

test("未审批脚本与版本不一致均阻断", () => {
  const { service } = makeService("2026-09-20T09:30:00.000Z");
  seedReference(service);
  standardBatch(service);
  let id = createStandardSession(service, { id: "sess_unapproved", scriptId: "scr_draft", scriptVersion: "9" });
  satisfyAllChecks(service, id);
  let gate = service.evaluate(id);
  assert.ok(gate.blocks.some((b) => b.code === "script_not_approved"));

  id = createStandardSession(service, { id: "sess_oldver", scriptVersion: "2" });
  satisfyAllChecks(service, id);
  gate = service.evaluate(id);
  assert.ok(gate.blocks.some((b) => b.code === "script_version_mismatch"));
});

test("耗材有效期不覆盖场次结束时阻断", () => {
  const { service } = makeService("2026-09-20T09:30:00.000Z");
  seedReference(service);
  standardBatch(service, { expiresAt: "2026-09-20T10:30:00.000Z" });
  const id = createStandardSession(service);
  satisfyAllChecks(service, id);
  const gate = service.evaluate(id);
  assert.ok(gate.blocks.some((b) => b.code === "material_expired"));
});

test("超过开场宽限窗口（15 分钟）仍未开场，闸门锁定且不可豁免", () => {
  const { service } = makeService("2026-09-20T10:20:00.000Z");
  seedReference(service);
  standardBatch(service);
  const id = createStandardSession(service);
  satisfyAllChecks(service, id);
  const gate = service.evaluate(id);
  assert.equal(gate.decision, "no_go");
  const overdue = gate.blocks.find((b) => b.code === "session_overdue");
  assert.ok(overdue);
  assert.equal(overdue!.waivable, false);
  assert.ok(overdue!.margin.ms !== null && overdue!.margin.ms < 0);
  // 持久化的派生状态也已变为 blocked
  assert.equal(service.getState().sessions[0]!.state, "blocked");
});
