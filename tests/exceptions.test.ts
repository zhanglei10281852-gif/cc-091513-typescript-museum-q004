import assert from "node:assert/strict";
import { test } from "node:test";

import { DomainError } from "../src/domain/errors.js";
import {
  createStandardSession,
  makeService,
  satisfyAllChecks,
  seedReference,
  standardBatch,
} from "./helpers.js";

test("例外只能由具备相应权限的复核者针对当前场次授予", () => {
  const { service } = makeService("2026-09-20T09:45:00.000Z");
  seedReference(service);
  standardBatch(service);
  const id = createStandardSession(service);
  satisfyAllChecks(service, id);
  // 手套点检迟到
  service.recordEquipmentCheck(id, {
    equipmentId: "eq_gloves",
    ok: true,
    checkedAt: "2026-09-20T09:45:00.000Z",
    checkedBy: "late-staff",
  });
  assert.equal(service.evaluate(id).decision, "no_go");

  // 无权限复核者拒绝
  assert.throws(
    () =>
      service.grantException(id, {
        item: "equipment",
        reviewerId: "r_nobody",
        reason: "现场确认无风险",
      }),
    (e: unknown) => e instanceof DomainError && e.code === "forbidden",
  );

  // 只有设备权限的复核者不能豁免资质
  assert.throws(
    () =>
      service.grantException(id, {
        item: "operator",
        reviewerId: "r_equip",
        reason: "x",
      }),
    (e: unknown) => e instanceof DomainError && e.code === "forbidden",
  );

  // 设备权限足够豁免设备迟到
  service.grantException(id, {
    item: "equipment",
    code: "equipment_late",
    reviewerId: "r_equip",
    reason: "已现场复核设备状态，迟到不影响安全",
  });
  const gate = service.evaluate(id);
  assert.equal(gate.decision, "go");
  assert.equal(gate.waived.length, 1);
  assert.equal(gate.waived[0]!.item, "equipment");
  assert.equal(gate.waived[0]!.exception!.reviewerId, "r_equip");
});

test("不能为不存在的阻断授予空白例外", () => {
  const { service } = makeService("2026-09-20T09:25:00.000Z");
  seedReference(service);
  standardBatch(service);
  const id = createStandardSession(service);
  satisfyAllChecks(service, id);
  assert.throws(
    () =>
      service.grantException(id, {
        item: "equipment",
        reviewerId: "r_boss",
        reason: "预防性授权",
      }),
    (e: unknown) => e instanceof DomainError && e.code === "no_matching_block",
  );
});

test("例外绑定场次：A 场例外不覆盖 B 场", () => {
  const { service } = makeService("2026-09-20T09:45:00.000Z");
  seedReference(service);
  standardBatch(service);
  const a = createStandardSession(service, { id: "sess_a" });
  const b = createStandardSession(service, {
    id: "sess_b",
    startIso: "2026-09-20T14:00:00.000Z",
  });
  // 两场点检都晚于各自的截止时间（A 场截止 09:30，B 场截止 13:30）
  satisfyAllChecks(service, a);
  service.recordEquipmentCheck(a, {
    equipmentId: "eq_gloves",
    ok: true,
    checkedAt: "2026-09-20T09:45:00.000Z",
    checkedBy: "late-staff",
  });
  satisfyAllChecks(service, b);
  service.recordEquipmentCheck(b, {
    equipmentId: "eq_gloves",
    ok: true,
    checkedAt: "2026-09-20T13:45:00.000Z",
    checkedBy: "late-staff",
  });
  service.grantException(a, {
    item: "equipment",
    code: "equipment_late",
    reviewerId: "r_equip",
    reason: "A 场现场确认",
  });
  assert.equal(service.evaluate(a).decision, "go");
  assert.equal(service.evaluate(b).decision, "no_go");
});

test("例外可设置 TTL，过期后阻断恢复", () => {
  const { service, clock } = makeService("2026-09-20T09:45:00.000Z");
  seedReference(service);
  standardBatch(service);
  const id = createStandardSession(service);
  satisfyAllChecks(service, id);
  service.recordEquipmentCheck(id, {
    equipmentId: "eq_gloves",
    ok: true,
    checkedAt: "2026-09-20T09:45:00.000Z",
    checkedBy: "late-staff",
  });
  service.grantException(id, {
    item: "equipment",
    code: "equipment_late",
    reviewerId: "r_equip",
    reason: "短时例外",
    ttlMinutes: 5,
  });
  assert.equal(service.evaluate(id).decision, "go");
  clock.set("2026-09-20T09:51:00.000Z");
  assert.equal(service.evaluate(id).decision, "no_go");
});

test("事故阻断不可被任何例外覆盖", () => {
  const { service } = makeService("2026-09-20T09:45:00.000Z");
  seedReference(service);
  standardBatch(service);
  const id = createStandardSession(service);
  satisfyAllChecks(service, id);
  service.registerIncident(id, {
    description: "杜瓦罐轻微倾倒",
    registeredBy: "staff",
    registeredAt: "2026-09-20T09:44:00.000Z",
  });
  const gate = service.evaluate(id);
  assert.equal(gate.decision, "stopped");
  assert.ok(gate.blocks.some((b) => b.item === "session" && b.waivable === false));
});
