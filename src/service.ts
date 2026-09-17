/**
 * 业务服务层：场次、档案、点检、耗材、例外、开场、事故等全部命令与查询。
 * 所有变更写审计日志并持久化；闸门评估结果直接驱动场次状态。
 */
import { randomUUID } from "node:crypto";

import { ServiceError } from "./errors.js";
import { evaluateGate, type GateEvaluationInput } from "./gate.js";
import { POLICY } from "./policy.js";
import type { Store } from "./store.js";
import {
  CHECK_TYPES,
  CONDITION_LABELS,
  type CheckType,
  type Clock,
  type EmergencyCheckIn,
  type EquipmentInspection,
  type ExceptionGrant,
  type GateCondition,
  type GateReport,
  type Incident,
  type IncidentSnapshot,
  type Instructor,
  type MaterialBatch,
  type MaterialEvent,
  type Qualification,
  type Requisition,
  type Reviewer,
  type ScriptVersion,
  type Session,
  type StaffMember,
  type Venue,
} from "./types.js";

// ---------- 入参校验 ----------

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServiceError(400, "invalid_body", "请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

function reqString(obj: Record<string, unknown>, field: string): string {
  const v = obj[field];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ServiceError(400, "invalid_field", `字段 ${field} 必须是非空字符串`);
  }
  return v.trim();
}

function optString(obj: Record<string, unknown>, field: string): string | null {
  const v = obj[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.trim() === "") {
    throw new ServiceError(400, "invalid_field", `字段 ${field} 必须是非空字符串`);
  }
  return v.trim();
}

function reqNumber(
  obj: Record<string, unknown>,
  field: string,
  opts: { int?: boolean; min?: number; exclusiveMin?: number } = {},
): number {
  const v = obj[field];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ServiceError(400, "invalid_field", `字段 ${field} 必须是数字`);
  }
  if (opts.int === true && !Number.isInteger(v)) {
    throw new ServiceError(400, "invalid_field", `字段 ${field} 必须是整数`);
  }
  if (opts.min !== undefined && v < opts.min) {
    throw new ServiceError(400, "invalid_field", `字段 ${field} 不能小于 ${opts.min}`);
  }
  if (opts.exclusiveMin !== undefined && v <= opts.exclusiveMin) {
    throw new ServiceError(400, "invalid_field", `字段 ${field} 必须大于 ${opts.exclusiveMin}`);
  }
  return v;
}

function reqDate(obj: Record<string, unknown>, field: string): string {
  const raw = reqString(obj, field);
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    throw new ServiceError(400, "invalid_field", `字段 ${field} 必须是合法的时间`);
  }
  return new Date(t).toISOString();
}

function reqStringArray(obj: Record<string, unknown>, field: string): string[] {
  const v = obj[field];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x === "")) {
    throw new ServiceError(400, "invalid_field", `字段 ${field} 必须是非空字符串数组`);
  }
  return v as string[];
}

// ---------- 服务 ----------

export interface ScanResult {
  event: MaterialEvent;
  deduplicated: boolean;
  stock: BatchStock;
}

export interface BatchStock {
  batchId: string;
  status: string;
  received: number;
  reservedActive: number;
  consumed: number;
  available: number;
}

export class SafetyGateService {
  readonly store: Store;
  private readonly clock: Clock;

  constructor(store: Store, clock: Clock = () => new Date()) {
    this.store = store;
    this.clock = clock;
  }

  private now(): Date {
    return this.clock();
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private audit(
    actor: string,
    action: string,
    entityId: string,
    details: Record<string, unknown> = {},
  ): void {
    this.store.state.audit.push({ at: this.nowIso(), actor, action, entityId, details });
  }

  // ---------- 基础档案 ----------

  createVenue(body: unknown): Venue {
    const input = asRecord(body);
    const id = reqString(input, "id");
    if (this.store.state.venues[id] !== undefined) {
      throw new ServiceError(409, "duplicate_id", `场地 ${id} 已存在`);
    }
    const venue: Venue = {
      id,
      name: reqString(input, "name"),
      capacity: reqNumber(input, "capacity", { int: true, min: 1 }),
    };
    this.store.state.venues[id] = venue;
    this.audit("system", "venue.create", id);
    this.store.save();
    return venue;
  }

  listVenues(): Venue[] {
    return Object.values(this.store.state.venues);
  }

  createScript(body: unknown): ScriptVersion {
    const input = asRecord(body);
    const id = reqString(input, "id");
    if (this.store.state.scripts[id] !== undefined) {
      throw new ServiceError(409, "duplicate_id", `脚本版本 ${id} 已存在`);
    }
    const status = reqString(input, "status");
    if (status !== "approved" && status !== "retired") {
      throw new ServiceError(400, "invalid_field", "字段 status 必须是 approved 或 retired");
    }
    const rawMaterials = input["requiredMaterials"];
    if (!Array.isArray(rawMaterials)) {
      throw new ServiceError(400, "invalid_field", "字段 requiredMaterials 必须是数组");
    }
    const requiredMaterials = rawMaterials.map((m) => {
      const r = asRecord(m);
      return {
        materialId: reqString(r, "materialId"),
        quantity: reqNumber(r, "quantity", { exclusiveMin: 0 }),
        unit: reqString(r, "unit"),
      };
    });
    const rawRoles = input["requiredEmergencyRoles"];
    if (!Array.isArray(rawRoles)) {
      throw new ServiceError(400, "invalid_field", "字段 requiredEmergencyRoles 必须是数组");
    }
    const requiredEmergencyRoles = rawRoles.map((m) => {
      const r = asRecord(m);
      return {
        role: reqString(r, "role"),
        count: reqNumber(r, "count", { int: true, min: 1 }),
      };
    });
    const script: ScriptVersion = {
      id,
      showId: reqString(input, "showId"),
      version: reqString(input, "version"),
      status,
      durationMinutes: reqNumber(input, "durationMinutes", { int: true, min: 1 }),
      requiredEquipment: reqStringArray(input, "requiredEquipment"),
      requiredQualifications: reqStringArray(input, "requiredQualifications"),
      requiredMaterials,
      requiredEmergencyRoles,
      maxAudience: reqNumber(input, "maxAudience", { int: true, min: 1 }),
    };
    this.store.state.scripts[id] = script;
    this.audit("system", "script.create", id);
    this.store.save();
    return script;
  }

  createInstructor(body: unknown): Instructor {
    const input = asRecord(body);
    const id = reqString(input, "id");
    if (this.store.state.instructors[id] !== undefined) {
      throw new ServiceError(409, "duplicate_id", `讲师 ${id} 已存在`);
    }
    const rawQuals = input["qualifications"];
    if (!Array.isArray(rawQuals)) {
      throw new ServiceError(400, "invalid_field", "字段 qualifications 必须是数组");
    }
    const qualifications: Qualification[] = rawQuals.map((q) => {
      const r = asRecord(q);
      return { code: reqString(r, "code"), validUntil: reqDate(r, "validUntil") };
    });
    const instructor: Instructor = { id, name: reqString(input, "name"), qualifications };
    this.store.state.instructors[id] = instructor;
    this.audit("system", "instructor.create", id);
    this.store.save();
    return instructor;
  }

  createStaff(body: unknown): StaffMember {
    const input = asRecord(body);
    const id = reqString(input, "id");
    if (this.store.state.staff[id] !== undefined) {
      throw new ServiceError(409, "duplicate_id", `员工 ${id} 已存在`);
    }
    const member: StaffMember = {
      id,
      name: reqString(input, "name"),
      roles: reqStringArray(input, "roles"),
    };
    this.store.state.staff[id] = member;
    this.audit("system", "staff.create", id);
    this.store.save();
    return member;
  }

  createReviewer(body: unknown): Reviewer {
    const input = asRecord(body);
    const id = reqString(input, "id");
    if (this.store.state.reviewers[id] !== undefined) {
      throw new ServiceError(409, "duplicate_id", `复核者 ${id} 已存在`);
    }
    const permissions = reqStringArray(input, "permissions");
    if (permissions.length === 0) {
      throw new ServiceError(400, "invalid_field", "字段 permissions 不能为空");
    }
    for (const p of permissions) {
      if (!CHECK_TYPES.includes(p as CheckType)) {
        throw new ServiceError(
          400,
          "invalid_field",
          `权限 ${p} 无效，只能是：${CHECK_TYPES.join("、")}`,
        );
      }
    }
    const reviewer: Reviewer = { id, name: reqString(input, "name"), permissions: permissions as CheckType[] };
    this.store.state.reviewers[id] = reviewer;
    this.audit("system", "reviewer.create", id);
    this.store.save();
    return reviewer;
  }

  // ---------- 场次 ----------

  createSession(body: unknown): Session {
    const input = asRecord(body);
    const id = reqString(input, "id");
    if (this.store.state.sessions[id] !== undefined) {
      throw new ServiceError(409, "duplicate_id", `场次 ${id} 已存在`);
    }
    const venueId = reqString(input, "venueId");
    if (this.store.state.venues[venueId] === undefined) {
      throw new ServiceError(404, "venue_not_found", `场地 ${venueId} 不存在`);
    }
    const scriptVersionId = optString(input, "scriptVersionId");
    if (scriptVersionId !== null && this.store.state.scripts[scriptVersionId] === undefined) {
      throw new ServiceError(404, "script_not_found", `脚本版本 ${scriptVersionId} 不存在`);
    }
    const instructorIds =
      input["instructorIds"] === undefined ? [] : reqStringArray(input, "instructorIds");
    for (const iid of instructorIds) {
      if (this.store.state.instructors[iid] === undefined) {
        throw new ServiceError(404, "instructor_not_found", `讲师 ${iid} 不存在`);
      }
    }
    const session: Session = {
      id,
      showId: reqString(input, "showId"),
      scriptVersionId,
      venueId,
      scheduledStart: reqDate(input, "scheduledStart"),
      expectedAudience: reqNumber(input, "expectedAudience", { int: true, min: 0 }),
      instructorIds,
      status: "preparing",
      firstFailedAt: {},
      startedAt: null,
      completedAt: null,
      stoppedAt: null,
      stopReason: null,
      stopIncidentId: null,
      lockedScriptVersionId: null,
      lockedRoster: null,
    };
    this.store.state.sessions[id] = session;
    this.audit("system", "session.create", id);
    this.store.save();
    return session;
  }

  listSessions(): Session[] {
    return Object.values(this.store.state.sessions).sort((a, b) =>
      a.scheduledStart.localeCompare(b.scheduledStart),
    );
  }

  getSession(sessionId: string): Session {
    return this.requireSession(sessionId);
  }

  private requireSession(id: string): Session {
    const session = this.store.state.sessions[id];
    if (session === undefined) {
      throw new ServiceError(404, "session_not_found", `场次 ${id} 不存在`);
    }
    return session;
  }

  /** 开场后脚本与人员名单锁定；停用/完成的场次不可再变更。 */
  private requireNotLocked(session: Session): void {
    if (session.startedAt !== null) {
      throw new ServiceError(409, "session_locked", "演示已开始，脚本版本与人员名单已锁定");
    }
    if (session.status === "stopped") {
      throw new ServiceError(409, "session_stopped", "场次已停用，请先恢复");
    }
    if (session.status === "completed") {
      throw new ServiceError(409, "session_completed", "场次已完成");
    }
  }

  assignScript(sessionId: string, body: unknown): Session {
    const session = this.requireSession(sessionId);
    this.requireNotLocked(session);
    const input = asRecord(body);
    const scriptVersionId = reqString(input, "scriptVersionId");
    if (this.store.state.scripts[scriptVersionId] === undefined) {
      throw new ServiceError(404, "script_not_found", `脚本版本 ${scriptVersionId} 不存在`);
    }
    session.scriptVersionId = scriptVersionId;
    this.audit("system", "session.assign_script", sessionId, { scriptVersionId });
    this.store.save();
    return session;
  }

  assignInstructor(sessionId: string, body: unknown): Session {
    const session = this.requireSession(sessionId);
    this.requireNotLocked(session);
    const input = asRecord(body);
    const instructorId = reqString(input, "instructorId");
    if (this.store.state.instructors[instructorId] === undefined) {
      throw new ServiceError(404, "instructor_not_found", `讲师 ${instructorId} 不存在`);
    }
    if (!session.instructorIds.includes(instructorId)) {
      session.instructorIds.push(instructorId);
    }
    this.audit("system", "session.assign_instructor", sessionId, { instructorId });
    this.store.save();
    return session;
  }

  removeInstructor(sessionId: string, instructorId: string): Session {
    const session = this.requireSession(sessionId);
    this.requireNotLocked(session);
    session.instructorIds = session.instructorIds.filter((x) => x !== instructorId);
    this.audit("system", "session.remove_instructor", sessionId, { instructorId });
    this.store.save();
    return session;
  }

  setAudience(sessionId: string, body: unknown): Session {
    const session = this.requireSession(sessionId);
    this.requireNotLocked(session);
    const input = asRecord(body);
    session.expectedAudience = reqNumber(input, "expectedAudience", { int: true, min: 0 });
    this.audit("system", "session.set_audience", sessionId, {
      expectedAudience: session.expectedAudience,
    });
    this.store.save();
    return session;
  }

  // ---------- 设备点检 ----------

  recordInspection(sessionId: string, body: unknown): EquipmentInspection {
    const session = this.requireSession(sessionId);
    this.requireNotLocked(session);
    const input = asRecord(body);
    const checkedAt = reqDate(input, "checkedAt");
    if (Date.parse(checkedAt) > this.now().getTime()) {
      throw new ServiceError(
        400,
        "future_check_time",
        "实际检查时间不能晚于当前时间，不允许倒签或预填",
      );
    }
    const result = reqString(input, "result");
    if (result !== "pass" && result !== "fail") {
      throw new ServiceError(400, "invalid_field", "字段 result 必须是 pass 或 fail");
    }
    const inspection: EquipmentInspection = {
      id: randomUUID(),
      sessionId,
      equipmentId: reqString(input, "equipmentId"),
      result,
      checkedAt,
      recordedAt: this.nowIso(),
      inspectorId: reqString(input, "inspectorId"),
      notes: optString(input, "notes"),
    };
    this.store.state.inspections[inspection.id] = inspection;
    this.audit(inspection.inspectorId, "inspection.record", inspection.id, {
      sessionId,
      equipmentId: inspection.equipmentId,
      result,
      checkedAt,
    });
    this.store.save();
    return inspection;
  }

  // ---------- 耗材 ----------

  registerBatch(body: unknown): MaterialBatch {
    const input = asRecord(body);
    const id = reqString(input, "id");
    if (this.store.state.batches[id] !== undefined) {
      throw new ServiceError(409, "duplicate_id", `耗材批次 ${id} 已存在`);
    }
    const batch: MaterialBatch = {
      id,
      materialId: reqString(input, "materialId"),
      labelBatchNo: reqString(input, "labelBatchNo"),
      unit: reqString(input, "unit"),
      status: "available",
      receivedQuantity: reqNumber(input, "quantity", { exclusiveMin: 0 }),
      quarantineReason: null,
    };
    this.store.state.batches[id] = batch;
    const event: MaterialEvent = {
      id: randomUUID(),
      type: "received",
      batchId: id,
      sessionId: null,
      requisitionId: null,
      reservationId: null,
      quantity: batch.receivedQuantity,
      scanCode: null,
      at: this.nowIso(),
    };
    this.store.state.materialEvents[event.id] = event;
    this.audit("system", "material.receive", id, { quantity: batch.receivedQuantity });
    this.store.save();
    return batch;
  }

  quarantineBatch(batchId: string, body: unknown): MaterialBatch {
    const batch = this.store.state.batches[batchId];
    if (batch === undefined) {
      throw new ServiceError(404, "batch_not_found", `耗材批次 ${batchId} 不存在`);
    }
    const input = asRecord(body);
    batch.status = "quarantined";
    batch.quarantineReason = reqString(input, "reason");
    const event: MaterialEvent = {
      id: randomUUID(),
      type: "quarantined",
      batchId,
      sessionId: null,
      requisitionId: null,
      reservationId: null,
      quantity: 0,
      scanCode: null,
      at: this.nowIso(),
    };
    this.store.state.materialEvents[event.id] = event;
    this.audit("system", "material.quarantine", batchId, { reason: batch.quarantineReason });
    this.store.save();
    return batch;
  }

  batchStock(batchId: string): BatchStock {
    const batch = this.store.state.batches[batchId];
    if (batch === undefined) {
      throw new ServiceError(404, "batch_not_found", `耗材批次 ${batchId} 不存在`);
    }
    const events = Object.values(this.store.state.materialEvents).filter(
      (e) => e.batchId === batchId,
    );
    const consumedReservationIds = new Set(
      events.filter((e) => e.type === "consumed" && e.reservationId !== null).map((e) => e.reservationId),
    );
    const reservedActive = events
      .filter((e) => e.type === "reserved" && !consumedReservationIds.has(e.id))
      .reduce((s, e) => s + e.quantity, 0);
    const consumed = events
      .filter((e) => e.type === "consumed")
      .reduce((s, e) => s + e.quantity, 0);
    return {
      batchId,
      status: batch.status,
      received: batch.receivedQuantity,
      reservedActive,
      consumed,
      available: batch.receivedQuantity - reservedActive - consumed,
    };
  }

  getBatchView(batchId: string): { batch: MaterialBatch; stock: BatchStock } {
    const batch = this.store.state.batches[batchId];
    if (batch === undefined) {
      throw new ServiceError(404, "batch_not_found", `耗材批次 ${batchId} 不存在`);
    }
    return { batch, stock: this.batchStock(batchId) };
  }

  createRequisition(sessionId: string, body: unknown): Requisition {
    const session = this.requireSession(sessionId);
    this.requireNotLocked(session);
    const input = asRecord(body);
    const id = reqString(input, "id");
    if (this.store.state.requisitions[id] !== undefined) {
      throw new ServiceError(409, "duplicate_id", `领用单 ${id} 已存在`);
    }
    const requisition: Requisition = {
      id,
      sessionId,
      materialId: reqString(input, "materialId"),
      batchNo: reqString(input, "batchNo"),
      quantity: reqNumber(input, "quantity", { exclusiveMin: 0 }),
      createdAt: this.nowIso(),
    };
    this.store.state.requisitions[id] = requisition;
    this.audit("system", "requisition.create", id, { sessionId });
    this.store.save();
    return requisition;
  }

  /** 领用单已被有效占用（未隔离批次的预留 + 已消耗）的数量。 */
  private requisitionUsage(requisitionId: string): number {
    const all = Object.values(this.store.state.materialEvents);
    const consumedReservationIds = new Set(
      all.filter((e) => e.type === "consumed" && e.reservationId !== null).map((e) => e.reservationId),
    );
    let used = 0;
    for (const e of all) {
      if (e.requisitionId !== requisitionId) continue;
      if (e.type === "reserved") {
        if (consumedReservationIds.has(e.id)) continue;
        const batch = this.store.state.batches[e.batchId];
        if (batch !== undefined && batch.status !== "available") continue;
        used += e.quantity;
      } else if (e.type === "consumed") {
        used += e.quantity;
      }
    }
    return used;
  }

  /**
   * 扫码预留耗材。扫码码为幂等键：重复扫码返回首次登记结果，
   * 不重复预留、不重复消耗；标签批号必须与领用单批号一致。
   */
  scanMaterial(sessionId: string, body: unknown): ScanResult {
    const session = this.requireSession(sessionId);
    this.requireNotLocked(session);
    const input = asRecord(body);
    const code = reqString(input, "code");
    const requisitionId = reqString(input, "requisitionId");
    const batchId = reqString(input, "batchId");
    const quantity = reqNumber(input, "quantity", { exclusiveMin: 0 });

    const existingId = this.store.state.scanIndex[code];
    if (existingId !== undefined) {
      const existing = this.store.state.materialEvents[existingId];
      if (
        existing !== undefined &&
        existing.sessionId === sessionId &&
        existing.requisitionId === requisitionId &&
        existing.batchId === batchId &&
        existing.quantity === quantity
      ) {
        return { event: existing, deduplicated: true, stock: this.batchStock(batchId) };
      }
      throw new ServiceError(
        409,
        "scan_conflict",
        "该扫码已登记，且内容与首次登记不一致；重复扫码不会重复消耗耗材",
      );
    }

    const requisition = this.store.state.requisitions[requisitionId];
    if (requisition === undefined || requisition.sessionId !== sessionId) {
      throw new ServiceError(404, "requisition_not_found", `领用单 ${requisitionId} 不存在`);
    }
    const batch = this.store.state.batches[batchId];
    if (batch === undefined) {
      throw new ServiceError(404, "batch_not_found", `耗材批次 ${batchId} 不存在`);
    }
    if (batch.materialId !== requisition.materialId) {
      throw new ServiceError(
        409,
        "material_mismatch",
        `耗材批次 ${batchId} 的物料 ${batch.materialId} 与领用单物料 ${requisition.materialId} 不符`,
      );
    }
    if (batch.status !== "available") {
      throw new ServiceError(409, "batch_quarantined", `耗材批次 ${batchId} 已隔离，不能使用`);
    }
    if (batch.labelBatchNo !== requisition.batchNo) {
      throw new ServiceError(
        409,
        "batch_no_mismatch",
        `耗材标签批号 ${batch.labelBatchNo} 与领用单批号 ${requisition.batchNo} 不一致`,
      );
    }
    const stock = this.batchStock(batchId);
    if (stock.available < quantity) {
      throw new ServiceError(
        409,
        "insufficient_stock",
        `批次 ${batchId} 可用余量 ${stock.available} ${batch.unit}，不足 ${quantity} ${batch.unit}`,
      );
    }
    const used = this.requisitionUsage(requisitionId);
    if (used + quantity > requisition.quantity) {
      throw new ServiceError(
        409,
        "requisition_exceeded",
        `领用单 ${requisitionId} 额度 ${requisition.quantity}，已占用 ${used}，本次 ${quantity} 超出`,
      );
    }

    const event: MaterialEvent = {
      id: randomUUID(),
      type: "reserved",
      batchId,
      sessionId,
      requisitionId,
      reservationId: null,
      quantity,
      scanCode: code,
      at: this.nowIso(),
    };
    this.store.state.materialEvents[event.id] = event;
    this.store.state.scanIndex[code] = event.id;
    this.audit("system", "material.scan_reserve", event.id, { sessionId, batchId, quantity, code });
    this.store.save();
    return { event, deduplicated: false, stock: this.batchStock(batchId) };
  }

  // ---------- 应急人员 ----------

  checkInEmergency(sessionId: string, body: unknown): EmergencyCheckIn {
    const session = this.requireSession(sessionId);
    this.requireNotLocked(session);
    const input = asRecord(body);
    const staffId = reqString(input, "staffId");
    const role = reqString(input, "role");
    const member = this.store.state.staff[staffId];
    if (member === undefined) {
      throw new ServiceError(404, "staff_not_found", `员工 ${staffId} 不存在`);
    }
    if (!member.roles.includes(role)) {
      throw new ServiceError(400, "role_not_held", `员工 ${staffId} 不具备「${role}」岗位资质`);
    }
    const existing = Object.values(this.store.state.checkIns).find(
      (c) => c.sessionId === sessionId && c.staffId === staffId && c.role === role,
    );
    if (existing !== undefined) return existing;
    const checkIn: EmergencyCheckIn = {
      id: randomUUID(),
      sessionId,
      staffId,
      role,
      checkedInAt: this.nowIso(),
    };
    this.store.state.checkIns[checkIn.id] = checkIn;
    this.audit(staffId, "emergency.check_in", checkIn.id, { sessionId, role });
    this.store.save();
    return checkIn;
  }

  // ---------- 例外放行 ----------

  grantException(sessionId: string, body: unknown): ExceptionGrant {
    const session = this.requireSession(sessionId);
    this.requireNotLocked(session);
    const input = asRecord(body);
    const checkTypeRaw = reqString(input, "checkType");
    if (!CHECK_TYPES.includes(checkTypeRaw as CheckType)) {
      throw new ServiceError(
        400,
        "invalid_field",
        `例外只能针对检查项：${CHECK_TYPES.join("、")}；脚本版本不可例外`,
      );
    }
    const checkType = checkTypeRaw as CheckType;
    const reviewerId = reqString(input, "reviewerId");
    const reviewer = this.store.state.reviewers[reviewerId];
    if (reviewer === undefined) {
      throw new ServiceError(404, "reviewer_not_found", `复核者 ${reviewerId} 不存在`);
    }
    if (!reviewer.permissions.includes(checkType)) {
      throw new ServiceError(
        403,
        "permission_denied",
        `复核者 ${reviewerId} 不具备「${CONDITION_LABELS[checkType]}」的例外权限`,
      );
    }
    const nowMs = this.now().getTime();
    const duplicate = Object.values(this.store.state.exceptions).find(
      (e) =>
        e.sessionId === sessionId && e.checkType === checkType && Date.parse(e.expiresAt) > nowMs,
    );
    if (duplicate !== undefined) {
      throw new ServiceError(
        409,
        "exception_exists",
        `该场次「${CONDITION_LABELS[checkType]}」已存在有效例外 ${duplicate.id}`,
      );
    }
    const script =
      session.scriptVersionId !== null ? this.store.state.scripts[session.scriptVersionId] : undefined;
    const durationMin = script?.durationMinutes ?? POLICY.defaultExceptionValidityMinutes;
    const expiresAt = new Date(Date.parse(session.scheduledStart) + durationMin * 60_000);
    const grant: ExceptionGrant = {
      id: randomUUID(),
      sessionId,
      checkType,
      reviewerId,
      reason: reqString(input, "reason"),
      createdAt: this.nowIso(),
      expiresAt: expiresAt.toISOString(),
    };
    this.store.state.exceptions[grant.id] = grant;
    this.audit(reviewerId, "exception.grant", grant.id, { sessionId, checkType, reason: grant.reason });
    this.store.save();
    return grant;
  }

  // ---------- 闸门评估 ----------

  private gateInput(session: Session): GateEvaluationInput {
    const s = this.store.state;
    const script =
      session.scriptVersionId !== null ? (s.scripts[session.scriptVersionId] ?? null) : null;
    const venue = s.venues[session.venueId] ?? null;
    const instructors = session.instructorIds
      .map((id) => s.instructors[id])
      .filter((i): i is Instructor => i !== undefined);
    return {
      session,
      script,
      venue,
      instructors,
      inspections: Object.values(s.inspections).filter((i) => i.sessionId === session.id),
      requisitions: Object.values(s.requisitions).filter((r) => r.sessionId === session.id),
      batches: new Map(Object.values(s.batches).map((b) => [b.id, b])),
      materialEvents: Object.values(s.materialEvents).filter((e) => e.sessionId === session.id),
      checkIns: Object.values(s.checkIns).filter((c) => c.sessionId === session.id),
      exceptions: Object.values(s.exceptions).filter((e) => e.sessionId === session.id),
      now: this.now(),
    };
  }

  /**
   * 评估闸门并刷新场次状态（preparing/blocked/ready）。
   * 同时维护各强制项的首次失效时间，阻断原因按失效先后排序。
   */
  evaluate(sessionId: string): GateReport {
    const session = this.requireSession(sessionId);
    const report = evaluateGate(this.gateInput(session));
    const nowIso = this.nowIso();

    const failing = new Set(
      report.checks.filter((c) => c.status === "fail").map((c) => c.condition),
    );
    for (const condition of failing) {
      if (session.firstFailedAt[condition] === undefined) {
        session.firstFailedAt[condition] = nowIso;
      }
    }
    for (const key of Object.keys(session.firstFailedAt)) {
      if (!failing.has(key as GateCondition)) {
        delete session.firstFailedAt[key];
      }
    }
    for (const reason of report.blockingReasons) {
      reason.since = session.firstFailedAt[reason.condition] ?? null;
    }
    report.blockingReasons.sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));

    if (session.status === "preparing" || session.status === "blocked" || session.status === "ready") {
      session.status = report.decision === "go" ? "ready" : "blocked";
    }
    this.store.save();
    return report;
  }

  getSessionView(sessionId: string): { session: Session; gate: GateReport } {
    const session = this.requireSession(sessionId);
    const gate = this.evaluate(sessionId);
    return { session, gate };
  }

  // ---------- 开场 / 完成 / 停用 ----------

  startSession(sessionId: string): { session: Session; report: GateReport } {
    const session = this.requireSession(sessionId);
    if (session.status === "running") {
      throw new ServiceError(409, "already_running", "场次已在进行中");
    }
    if (session.status === "completed" || session.status === "stopped") {
      throw new ServiceError(409, "invalid_state", `场次状态为 ${session.status}，不能开场`);
    }
    const report = this.evaluate(sessionId);
    if (report.decision !== "go") {
      throw new ServiceError(409, "gate_blocked", "安全闸门未放行，不能开场", report);
    }
    const nowIso = this.nowIso();
    session.status = "running";
    session.startedAt = nowIso;
    session.lockedScriptVersionId = session.scriptVersionId;
    const roster = new Set<string>(session.instructorIds);
    for (const c of Object.values(this.store.state.checkIns)) {
      if (c.sessionId === session.id) roster.add(c.staffId);
    }
    session.lockedRoster = [...roster];

    // 预留耗材转为消耗；按预留事件幂等，一次预留只消耗一次。
    const events = Object.values(this.store.state.materialEvents);
    const consumedReservationIds = new Set(
      events.filter((e) => e.type === "consumed" && e.reservationId !== null).map((e) => e.reservationId),
    );
    for (const e of events) {
      if (e.sessionId !== session.id || e.type !== "reserved") continue;
      if (consumedReservationIds.has(e.id)) continue;
      const consumed: MaterialEvent = {
        id: randomUUID(),
        type: "consumed",
        batchId: e.batchId,
        sessionId: session.id,
        requisitionId: e.requisitionId,
        reservationId: e.id,
        quantity: e.quantity,
        scanCode: null,
        at: nowIso,
      };
      this.store.state.materialEvents[consumed.id] = consumed;
    }

    this.audit("system", "session.start", session.id, {
      lockedScriptVersionId: session.lockedScriptVersionId,
      lockedRoster: session.lockedRoster,
    });
    this.store.save();
    return { session, report };
  }

  completeSession(sessionId: string): Session {
    const session = this.requireSession(sessionId);
    if (session.status !== "running") {
      throw new ServiceError(409, "invalid_state", "只有进行中的场次才能标记完成");
    }
    session.status = "completed";
    session.completedAt = this.nowIso();
    this.audit("system", "session.complete", sessionId);
    this.store.save();
    return session;
  }

  stopSession(sessionId: string, body: unknown): Session {
    const session = this.requireSession(sessionId);
    if (session.status === "completed") {
      throw new ServiceError(409, "invalid_state", "场次已完成，不能停用");
    }
    if (session.status === "stopped") {
      throw new ServiceError(409, "invalid_state", "场次已处于停用状态");
    }
    const input = asRecord(body);
    const reason = reqString(input, "reason");
    const actor = optString(input, "actorId") ?? "system";
    session.status = "stopped";
    session.stoppedAt = this.nowIso();
    session.stopReason = reason;
    session.stopIncidentId = null;
    this.audit(actor, "session.stop", sessionId, { reason });
    this.store.save();
    return session;
  }

  reinstateSession(sessionId: string, body: unknown): Session {
    const session = this.requireSession(sessionId);
    const input = asRecord(body);
    const reviewerId = reqString(input, "reviewerId");
    if (this.store.state.reviewers[reviewerId] === undefined) {
      throw new ServiceError(404, "reviewer_not_found", `复核者 ${reviewerId} 不存在`);
    }
    if (session.status !== "stopped") {
      throw new ServiceError(409, "invalid_state", "只有停用状态的场次才能恢复");
    }
    if (session.stopIncidentId !== null) {
      const incident = this.store.state.incidents[session.stopIncidentId];
      if (incident === undefined || incident.confirmedAt === null) {
        throw new ServiceError(409, "incident_unconfirmed", "关联事故尚未确认，不能恢复场次");
      }
    }
    session.status = "preparing";
    session.stoppedAt = null;
    session.stopReason = null;
    session.stopIncidentId = null;
    this.audit(reviewerId, "session.reinstate", sessionId);
    this.evaluate(sessionId);
    this.store.save();
    return session;
  }

  // ---------- 事故 ----------

  registerIncident(body: unknown): Incident {
    const input = asRecord(body);
    const sessionId = reqString(input, "sessionId");
    const session = this.requireSession(sessionId);
    const description = reqString(input, "description");
    const occurredAt = reqDate(input, "occurredAt");
    if (Date.parse(occurredAt) > this.now().getTime()) {
      throw new ServiceError(400, "invalid_field", "事故时间不能晚于当前时间");
    }
    const id = optString(input, "id") ?? randomUUID();
    if (this.store.state.incidents[id] !== undefined) {
      throw new ServiceError(409, "duplicate_id", `事故 ${id} 已存在`);
    }
    const nowIso = this.nowIso();

    // 保全原始记录：场次、闸门评估、点检、耗材事件与例外。
    const snapshot: IncidentSnapshot = {
      session: structuredClone(session),
      gateReport: evaluateGate(this.gateInput(session)),
      inspections: structuredClone(
        Object.values(this.store.state.inspections).filter((i) => i.sessionId === sessionId),
      ),
      materialEvents: structuredClone(
        Object.values(this.store.state.materialEvents).filter((e) => e.sessionId === sessionId),
      ),
      exceptions: structuredClone(
        Object.values(this.store.state.exceptions).filter((e) => e.sessionId === sessionId),
      ),
    };

    const incident: Incident = {
      id,
      sessionId,
      venueId: session.venueId,
      description,
      occurredAt,
      registeredAt: nowIso,
      confirmedAt: null,
      confirmedBy: null,
      affectedSessionIds: [],
      snapshot,
    };

    if (session.status !== "completed") {
      session.status = "stopped";
      session.stoppedAt = nowIso;
      session.stopReason = `事故 ${id}：${description}`;
      session.stopIncidentId = id;
    }

    // 停止同场地计划开始时间不早于本场的后续场次。
    for (const other of Object.values(this.store.state.sessions)) {
      if (other.id === session.id || other.venueId !== session.venueId) continue;
      if (other.status !== "preparing" && other.status !== "blocked" && other.status !== "ready") {
        continue;
      }
      if (Date.parse(other.scheduledStart) < Date.parse(session.scheduledStart)) continue;
      other.status = "stopped";
      other.stoppedAt = nowIso;
      other.stopReason = `受事故 ${id} 影响停用`;
      other.stopIncidentId = id;
      incident.affectedSessionIds.push(other.id);
    }

    this.store.state.incidents[id] = incident;
    this.audit("system", "incident.register", id, {
      sessionId,
      affectedSessionIds: incident.affectedSessionIds,
    });
    this.store.save();
    return incident;
  }

  confirmIncident(incidentId: string, body: unknown): Incident {
    const incident = this.store.state.incidents[incidentId];
    if (incident === undefined) {
      throw new ServiceError(404, "incident_not_found", `事故 ${incidentId} 不存在`);
    }
    const input = asRecord(body);
    const reviewerId = reqString(input, "reviewerId");
    if (this.store.state.reviewers[reviewerId] === undefined) {
      throw new ServiceError(404, "reviewer_not_found", `复核者 ${reviewerId} 不存在`);
    }
    if (incident.confirmedAt !== null) {
      throw new ServiceError(409, "already_confirmed", "事故已确认");
    }
    incident.confirmedAt = this.nowIso();
    incident.confirmedBy = reviewerId;
    this.audit(reviewerId, "incident.confirm", incidentId);
    this.store.save();
    return incident;
  }

  getIncident(incidentId: string): Incident {
    const incident = this.store.state.incidents[incidentId];
    if (incident === undefined) {
      throw new ServiceError(404, "incident_not_found", `事故 ${incidentId} 不存在`);
    }
    return incident;
  }

  listIncidents(): Incident[] {
    return Object.values(this.store.state.incidents).sort((a, b) =>
      a.registeredAt.localeCompare(b.registeredAt),
    );
  }
}
