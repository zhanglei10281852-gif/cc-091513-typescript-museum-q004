import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "../src/domain/clock.js";
import { SafetyGateService } from "../src/domain/service.js";
import { Store } from "../src/domain/store.js";
import type { State } from "../src/domain/types.js";

export class FakeClock implements Clock {
  constructor(private current: string) {}
  now(): Date {
    return new Date(this.current);
  }
  set(value: string): void {
    this.current = value;
  }
  advanceMinutes(minutes: number): void {
    this.current = new Date(Date.parse(this.current) + minutes * 60_000).toISOString();
  }
}

export function makeService(clockIso?: string): {
  service: SafetyGateService;
  clock: FakeClock;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "gate-test-"));
  const clock = new FakeClock(clockIso ?? "2026-09-20T09:00:00.000Z");
  const service = new SafetyGateService(new Store(join(dir, "state.json"), clock), clock);
  return { service, clock, dir };
}

/** 液氮演示标准夹具：脚本/讲师/场地/设备/耗材/复核者齐全。 */
export function seedReference(service: SafetyGateService): void {
  service.upsertReference({
    scripts: [
      { id: "scr_ln2", version: "3", title: "液氮玫瑰实验", approved: true },
      { id: "scr_draft", version: "9", title: "液氮大象牙膏", approved: false },
    ],
    presenters: [
      {
        id: "p_wang",
        name: "王讲师",
        qualifications: [
          {
            type: "liquid_nitrogen",
            name: "液氮演示资质",
            validFrom: "2025-01-01T00:00:00.000Z",
            validUntil: "2026-12-31T00:00:00.000Z",
          },
        ],
      },
      {
        id: "p_li",
        name: "李讲师",
        qualifications: [
          {
            type: "liquid_nitrogen",
            name: "液氮演示资质",
            validFrom: "2025-01-01T00:00:00.000Z",
            // 资质已于演示前一天到期
            validUntil: "2026-09-19T00:00:00.000Z",
          },
        ],
      },
    ],
    venues: [{ id: "v_hall_a", name: "A 厅", capacity: 100 }],
    equipment: [
      { id: "eq_dewar", name: "杜瓦罐" },
      { id: "eq_gloves", name: "防冻手套" },
    ],
    materials: [{ id: "mat_ln2", name: "液氮", unit: "升" }],
    reviewers: [
      { id: "r_boss", name: "赵主管", permissions: ["waive:any", "incident:resolve"] },
      { id: "r_equip", name: "钱设备员", permissions: ["waive:equipment"] },
      { id: "r_nobody", name: "孙实习", permissions: [] },
    ],
  });
}

export function standardBatch(service: SafetyGateService, overrides: Partial<{
  id: string;
  quantity: number;
  expiresAt: string;
  quarantined: boolean;
}> = {}): void {
  service.receiveBatch({
    id: overrides.id ?? "b_0001",
    materialId: "mat_ln2",
    quantity: overrides.quantity ?? 50,
    receivedAt: "2026-09-19T08:00:00.000Z",
    ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
  });
  if (overrides.quarantined) {
    service.quarantineBatch(overrides.id ?? "b_0001", {
      at: "2026-09-19T12:00:00.000Z",
      reason: "测试隔离",
    });
  }
}

export interface StandardSessionOptions {
  id?: string;
  presenterId?: string;
  scriptId?: string;
  scriptVersion?: string;
  expectedBatchId?: string;
  leadMinutes?: number;
  emergencyStaffRequired?: number;
  startIso?: string;
}

export function createStandardSession(
  service: SafetyGateService,
  opts: StandardSessionOptions = {},
): string {
  const startIso = opts.startIso ?? "2026-09-20T10:00:00.000Z";
  const lead = opts.leadMinutes ?? 30;
  const session = service.createSession({
    id: opts.id ?? "sess_demo",
    title: "上午场液氮演示",
    scriptId: opts.scriptId ?? "scr_ln2",
    scriptVersion: opts.scriptVersion ?? "3",
    venueId: "v_hall_a",
    presenterId: opts.presenterId ?? "p_wang",
    requiredQualification: "liquid_nitrogen",
    equipmentIds: ["eq_dewar", "eq_gloves"],
    materials: [
      {
        materialId: "mat_ln2",
        expectedBatchId: opts.expectedBatchId ?? "b_0001",
        quantity: 10,
      },
    ],
    emergencyStaffRequired: opts.emergencyStaffRequired ?? 2,
    scheduledStart: startIso,
    scheduledEnd: new Date(Date.parse(startIso) + 60 * 60_000).toISOString(),
    leadMinutes: lead,
  });
  return session.id;
}

/** 满足全部六类闸门条件（在截止时间前），返回场次 id。 */
export function satisfyAllChecks(service: SafetyGateService, sessionId = "sess_demo"): void {
  service.recordEquipmentCheck(sessionId, {
    equipmentId: "eq_dewar",
    ok: true,
    checkedAt: "2026-09-20T09:20:00.000Z",
    checkedBy: "staff",
  });
  service.recordEquipmentCheck(sessionId, {
    equipmentId: "eq_gloves",
    ok: true,
    checkedAt: "2026-09-20T09:21:00.000Z",
    checkedBy: "staff",
  });
  service.scanMaterial(sessionId, {
    scanId: `SCAN-${sessionId}`,
    materialId: "mat_ln2",
    batchId: "b_0001",
    scannedAt: "2026-09-20T09:22:00.000Z",
    scannedBy: "staff",
  });
  service.recordAttendance(sessionId, {
    count: 80,
    countedAt: "2026-09-20T09:50:00.000Z",
  });
  service.recordArrival(sessionId, {
    personId: "e_01",
    name: "周安全员",
    arrivedAt: "2026-09-20T09:25:00.000Z",
  });
  service.recordArrival(sessionId, {
    personId: "e_02",
    name: "吴安全员",
    arrivedAt: "2026-09-20T09:26:00.000Z",
  });
}

export function snapshotState(service: SafetyGateService): State {
  return structuredClone(service.getState());
}
