import assert from "node:assert/strict";
import type { Server } from "node:http";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import { SafetyGateService } from "../src/service.js";
import { Store } from "../src/store.js";

interface Response {
  status: number;
  json: Record<string, any>;
}

async function request(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit =
    body === undefined
      ? { method }
      : {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function withServer(
  run: (base: string) => Promise<void>,
  service = new SafetyGateService(new Store(null)),
): Promise<void> {
  const server: Server = createApp(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("HTTP 端到端：建档 → 闸门放行 → 开场 → 锁定", async () => {
  // 场次时间取当前时间之后 2 小时，点检取 90 分钟前，落在有效窗口内
  const scheduledStart = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const checkedAt = new Date(Date.now() - 90 * 60_000).toISOString();
  await withServer(async (base) => {
    assert.equal((await request(base, "POST", "/venues", { id: "hall-1", name: "主展厅", capacity: 100 })).status, 201);
    assert.equal(
      (
        await request(base, "POST", "/scripts", {
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
        })
      ).status,
      201,
    );
    await request(base, "POST", "/instructors", {
      id: "inst-1",
      name: "王老师",
      qualifications: [{ code: "LN2-OPS", validUntil: "2026-12-31T00:00:00Z" }],
    });
    await request(base, "POST", "/staff", { id: "staff-1", name: "李急救", roles: ["first-aid"] });
    await request(base, "POST", "/materials/batches", {
      id: "batch-1",
      materialId: "ln2",
      labelBatchNo: "B202609",
      quantity: 10,
      unit: "L",
    });

    const session = await request(base, "POST", "/sessions", {
      id: "sess-1",
      showId: "liquid-nitrogen",
      scriptVersionId: "ln2-v1",
      venueId: "hall-1",
      scheduledStart,
      expectedAudience: 50,
      instructorIds: ["inst-1"],
    });
    assert.equal(session.status, 201);
    assert.equal(session.json.status, "preparing");

    // 点检：实际检查时间不能在未来
    const future = await request(base, "POST", "/sessions/sess-1/inspections", {
      equipmentId: "dewar-1",
      result: "pass",
      checkedAt: "2099-03-01T00:00:00Z",
      inspectorId: "tech-1",
    });
    assert.equal(future.status, 400);
    assert.equal(future.json.error.code, "future_check_time");

    const inspection = await request(base, "POST", "/sessions/sess-1/inspections", {
      equipmentId: "dewar-1",
      result: "pass",
      checkedAt,
      inspectorId: "tech-1",
    });
    assert.equal(inspection.status, 201);

    await request(base, "POST", "/sessions/sess-1/requisitions", {
      id: "req-1",
      materialId: "ln2",
      batchNo: "B202609",
      quantity: 5,
    });
    const scan = await request(base, "POST", "/sessions/sess-1/materials/scan", {
      code: "SCAN-1",
      requisitionId: "req-1",
      batchId: "batch-1",
      quantity: 5,
    });
    assert.equal(scan.status, 200);
    assert.equal(scan.json.deduplicated, false);
    const scanAgain = await request(base, "POST", "/sessions/sess-1/materials/scan", {
      code: "SCAN-1",
      requisitionId: "req-1",
      batchId: "batch-1",
      quantity: 5,
    });
    assert.equal(scanAgain.json.deduplicated, true);

    await request(base, "POST", "/sessions/sess-1/emergency-checkins", {
      staffId: "staff-1",
      role: "first-aid",
    });

    const gate = await request(base, "GET", "/sessions/sess-1/gate");
    assert.equal(gate.status, 200);
    assert.equal(gate.json.decision, "go");
    assert.ok(gate.json.countdownSeconds > 0);
    assert.equal(gate.json.margins.capacitySeats, 30);

    const started = await request(base, "POST", "/sessions/sess-1/start");
    assert.equal(started.status, 200);
    assert.equal(started.json.session.status, "running");
    assert.deepEqual(new Set(started.json.session.lockedRoster), new Set(["inst-1", "staff-1"]));

    // 开场后脚本与人员名单锁定
    const locked = await request(base, "POST", "/sessions/sess-1/script", {
      scriptVersionId: "ln2-v1",
    });
    assert.equal(locked.status, 409);
    assert.equal(locked.json.error.code, "session_locked");

    const view = await request(base, "GET", "/sessions/sess-1");
    assert.equal(view.json.session.status, "running");
  });
});

test("HTTP 错误行为：404 与非法 JSON", async () => {
  await withServer(async (base) => {
    const missing = await request(base, "GET", "/sessions/nope");
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, "session_not_found");

    const noRoute = await request(base, "GET", "/nope");
    assert.equal(noRoute.status, 404);
    assert.equal(noRoute.json.error.code, "not_found");

    const res = await fetch(`${base}/venues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).error.code, "invalid_json");

    const invalid = await request(base, "POST", "/venues", { id: "v1" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, "invalid_field");
  });
});
