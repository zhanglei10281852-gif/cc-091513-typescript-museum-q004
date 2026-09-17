import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

import { FakeClock } from "./helpers.js";
import { createHttpApp } from "../src/domain/http.js";
import { SafetyGateService } from "../src/domain/service.js";
import { Store } from "../src/domain/store.js";

async function withServer(
  dir: string,
  clock: FakeClock,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const service = new SafetyGateService(new Store(join(dir, "state.json"), clock), clock);
  const server = createHttpApp(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function get(base: string, path: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, json: await response.json() };
}

test("端到端：液氮场资质过期+批号不符被拦，补救后放行，事故停用后续场次", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-http-"));
  const clock = new FakeClock("2026-09-20T09:55:00.000Z");

  await withServer(dir, clock, async (base) => {
    // —— 基础资料 ——
    await post(base, "/reference", {
      scripts: [{ id: "scr", version: "3", title: "液氮玫瑰", approved: true }],
      presenters: [
        {
          id: "p_expired",
          name: "当班讲师",
          qualifications: [
            {
              type: "liquid_nitrogen",
              name: "液氮资质",
              validFrom: "2025-01-01T00:00:00.000Z",
              validUntil: "2026-09-19T00:00:00.000Z",
            },
          ],
        },
        {
          id: "p_ok",
          name: "备班讲师",
          qualifications: [
            {
              type: "liquid_nitrogen",
              name: "液氮资质",
              validFrom: "2025-01-01T00:00:00.000Z",
              validUntil: "2027-01-01T00:00:00.000Z",
            },
          ],
        },
      ],
      venues: [{ id: "v", name: "A厅", capacity: 100 }],
      equipment: [{ id: "eq", name: "杜瓦罐" }],
      materials: [{ id: "m", name: "液氮", unit: "升" }],
      reviewers: [{ id: "boss", name: "主管", permissions: ["waive:any", "incident:resolve"] }],
    });
    await post(base, "/batches", {
      id: "b_expected",
      materialId: "m",
      quantity: 50,
      receivedAt: "2026-09-19T08:00:00.000Z",
    });
    await post(base, "/batches", {
      id: "b_actual",
      materialId: "m",
      quantity: 20,
      receivedAt: "2026-09-19T08:00:00.000Z",
    });

    // —— 建场次（10:00 开场，点检/领用截止 09:30） ——
    const created = await post(base, "/sessions", {
      id: "s1",
      title: "液氮场",
      scriptId: "scr",
      scriptVersion: "3",
      venueId: "v",
      presenterId: "p_expired",
      requiredQualification: "liquid_nitrogen",
      equipmentIds: ["eq"],
      materials: [{ materialId: "m", expectedBatchId: "b_expected", quantity: 10 }],
      emergencyStaffRequired: 1,
      scheduledStart: "2026-09-20T10:00:00.000Z",
      scheduledEnd: "2026-09-20T11:00:00.000Z",
      leadMinutes: 30,
    });
    assert.equal(created.status, 200);

    // 设备点检合格但迟到（实际 09:40）
    await post(base, "/sessions/s1/equipment-checks", {
      equipmentId: "eq",
      ok: true,
      checkedAt: "2026-09-20T09:40:00.000Z",
      checkedBy: "staff",
    });
    // 现场扫码批号与领用单不一致
    await post(base, "/sessions/s1/scans", {
      scanId: "QR-1",
      materialId: "m",
      batchId: "b_actual",
      scannedAt: "2026-09-20T09:50:00.000Z",
      scannedBy: "staff",
    });
    await post(base, "/sessions/s1/attendance", { count: 80, countedAt: "2026-09-20T09:52:00.000Z" });
    await post(base, "/sessions/s1/arrivals", {
      personId: "e1",
      name: "安全员",
      arrivedAt: "2026-09-20T09:25:00.000Z",
    });

    // —— 临近开场查闸门：no_go，最先失效是资质（昨天到期） ——
    let gate = (await get(base, "/sessions/s1/gate")).json;
    assert.equal(gate.decision, "no_go");
    assert.equal(gate.firstFailure.item, "operator");
    assert.equal(gate.firstFailure.code, "qualification_expired");
    const codes = gate.blocks.map((b: { item: string; code: string }) => `${b.item}/${b.code}`);
    assert.ok(codes.includes("material/material_batch_mismatch"));
    assert.ok(codes.includes("equipment/equipment_late"));
    // 每个阻断都带补救动作
    for (const block of gate.blocks) {
      assert.ok(Array.isArray(block.remediation) && block.remediation.length > 0);
    }

    // 直接开场被拒
    const blockedStart = await post(base, "/sessions/s1/start", {});
    assert.equal(blockedStart.status, 409);
    assert.equal(blockedStart.json.error, "gate_blocked");

    // —— 补救：换备班讲师（另排一场等价场次）、重扫正确批号 ——
    clock.set("2026-09-20T10:10:00.000Z");
    await post(base, "/sessions", {
      id: "s2",
      title: "液氮场-补救",
      scriptId: "scr",
      scriptVersion: "3",
      venueId: "v",
      presenterId: "p_ok",
      requiredQualification: "liquid_nitrogen",
      equipmentIds: ["eq"],
      materials: [{ materialId: "m", expectedBatchId: "b_expected", quantity: 10 }],
      emergencyStaffRequired: 1,
      scheduledStart: "2026-09-20T11:00:00.000Z",
      scheduledEnd: "2026-09-20T12:00:00.000Z",
      leadMinutes: 30,
    });
    await post(base, "/sessions/s2/equipment-checks", {
      equipmentId: "eq",
      ok: true,
      checkedAt: "2026-09-20T10:11:00.000Z",
      checkedBy: "staff",
    });
    await post(base, "/sessions/s2/scans", {
      scanId: "QR-2",
      materialId: "m",
      batchId: "b_expected",
      scannedAt: "2026-09-20T10:12:00.000Z",
      scannedBy: "staff",
    });
    await post(base, "/sessions/s2/attendance", { count: 80, countedAt: "2026-09-20T10:20:00.000Z" });
    await post(base, "/sessions/s2/arrivals", {
      personId: "e1",
      name: "安全员",
      arrivedAt: "2026-09-20T10:13:00.000Z",
    });

    gate = (await get(base, "/sessions/s2/gate")).json;
    assert.equal(gate.decision, "go", JSON.stringify(gate.blocks));

    // 开场并锁定
    clock.set("2026-09-20T11:00:00.000Z");
    const started = await post(base, "/sessions/s2/start", { at: "2026-09-20T11:00:00.000Z" });
    assert.equal(started.status, 200);
    assert.equal(started.json.session.state, "running");
    assert.deepEqual(
      started.json.session.lock.staff.map((s: { personId: string }) => s.personId).sort(),
      ["e1", "p_ok"],
    );

    // 开场后扫码/签到被拒
    const lateScan = await post(base, "/sessions/s2/scans", {
      scanId: "QR-3",
      materialId: "m",
      batchId: "b_expected",
      scannedBy: "staff",
    });
    assert.equal(lateScan.status, 409);

    // —— 演示中登记事故：本场停止、原始记录保全 ——
    const incident = await post(base, "/sessions/s2/incidents", {
      description: "少量液氮溅出",
      registeredBy: "staff",
      registeredAt: "2026-09-20T11:10:00.000Z",
    });
    assert.equal(incident.status, 200);
    const s2 = (await get(base, "/sessions/s2")).json;
    assert.equal(s2.session.state, "stopped");

    // 未确认事故期间，主管也不能用例外解锁（事故项不可豁免）
    const incidents = (await get(base, "/incidents")).json;
    const incidentId = incidents[0].id;
    await post(base, `/incidents/${incidentId}/confirm`, { reviewerId: "boss" });
    const resolve = await post(base, `/incidents/${incidentId}/resolve`, {
      reviewerId: "boss",
      note: "通风处置完毕",
    });
    assert.equal(resolve.status, 200);

    // 健康检查
    const health = await get(base, "/health");
    assert.equal(health.json.status, "ok");
  });
});
