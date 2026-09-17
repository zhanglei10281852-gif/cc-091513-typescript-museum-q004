import { isoNow, type Clock } from "./clock.js";
import { DomainError } from "./errors.js";
import { evaluateGate, type GateResult } from "./gate.js";
import { Store } from "./store.js";
import {
  CHECK_ITEMS,
  type Batch,
  type CheckItem,
  type Equipment,
  type ExceptionRecord,
  type Incident,
  type MaterialDef,
  type MaterialEventType,
  type Presenter,
  type Reviewer,
  type Script,
  type Session,
  type State,
  type Venue,
} from "./types.js";

let counter = 0;
function genId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") {
    throw new DomainError("invalid_param", `字段 ${key} 必须是非空字符串`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new DomainError("invalid_param", `字段 ${key} 必须是字符串`);
  }
  return value;
}

function isoOrNow(value: unknown, clock: Clock): string {
  if (value === undefined || value === null) return isoNow(clock);
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new DomainError("invalid_param", "时间字段必须是 ISO-8601 字符串");
  }
  return new Date(value).toISOString();
}

const PRE_SHOW_STATES = new Set(["preparing", "blocked", "ready"]);

/**
 * 安全闸门应用服务。所有修改：先校验、再改内存状态、原子快照落盘并追加审计日志。
 * 进程重启时由快照恢复——倒计时由评估时实时计算，停用与未确认事故随记录原样延续。
 */
export class SafetyGateService {
  private state: State;
  private readonly store: Store;
  private readonly clock: Clock;

  constructor(store: Store, clock: Clock) {
    this.store = store;
    this.clock = clock;
    this.state = store.load();
  }

  getState(): State {
    // 列表/全量取用前，把各开场前场次的 ready/blocked 重算为当前时点结果。
    for (const session of this.state.sessions) this.recomputeDerived(session);
    return this.state;
  }

  // —— 内部工具 ——

  private persist(action: string, detail: unknown, actor?: string, sessionId?: string): void {
    this.store.save(this.state);
    this.store.audit(action, detail, actor, sessionId);
  }

  /** 直接评估给定场次对象（纯计算，不再回查场次）。 */
  private computeGate(session: Session, at?: string): GateResult {
    return evaluateGate({
      state: this.state,
      session,
      at: at !== undefined ? new Date(at) : this.clock.now(),
    });
  }

  /**
   * ready/blocked 是随当前时间漂移的派生状态：每次取用场次时按闸门实时重算，
   * 但不落盘——持久化只发生在真正的写操作上，重启后同样立即重算。
   */
  private recomputeDerived(session: Session): void {
    if (!PRE_SHOW_STATES.has(session.state)) return;
    session.state = this.computeGate(session).decision === "go" ? "ready" : "blocked";
  }

  private findSession(sessionId: string): Session {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) throw DomainError.notFound(`场次 ${sessionId}`);
    this.recomputeDerived(session);
    return session;
  }

  private findReviewer(reviewerId: string): Reviewer {
    const reviewer = this.state.reviewers.find((r) => r.id === reviewerId);
    if (!reviewer) throw DomainError.notFound(`复核者 ${reviewerId}`);
    return reviewer;
  }

  private assertPreShow(session: Session): void {
    if (!PRE_SHOW_STATES.has(session.state)) {
      throw new DomainError(
        "session_locked",
        `场次已处于 ${session.state}，开场前的检查登记已关闭`,
        409,
      );
    }
  }

  private afterPreShowMutation(session: Session, action: string, detail: unknown, actor?: string): void {
    this.recomputeDerived(session);
    this.persist(action, detail, actor, session.id);
  }

  // —— 基础资料登记 ——

  upsertReference(input: {
    scripts?: Script[];
    presenters?: Presenter[];
    venues?: Venue[];
    equipment?: Equipment[];
    materials?: MaterialDef[];
    reviewers?: Reviewer[];
  }): State {
    const lists: Array<[keyof State, { id: string }[] | undefined]> = [
      ["scripts", input.scripts],
      ["presenters", input.presenters],
      ["venues", input.venues],
      ["equipment", input.equipment],
      ["materials", input.materials],
      ["reviewers", input.reviewers],
    ];
    for (const [key, items] of lists) {
      if (!items) continue;
      const existing = this.state[key] as { id: string }[];
      for (const item of items) {
        const idx = existing.findIndex((x) => x.id === item.id);
        if (idx >= 0) existing[idx] = item as never;
        else existing.push(item as never);
      }
    }
    this.persist("reference_upsert", {
      scripts: input.scripts?.length ?? 0,
      presenters: input.presenters?.length ?? 0,
      venues: input.venues?.length ?? 0,
      equipment: input.equipment?.length ?? 0,
      materials: input.materials?.length ?? 0,
      reviewers: input.reviewers?.length ?? 0,
    });
    return this.state;
  }

  receiveBatch(body: Record<string, unknown>): Batch {
    const id = typeof body.id === "string" ? body.id : genId("batch");
    const materialId = requireString(body, "materialId");
    if (!this.state.materials.some((m) => m.id === materialId)) {
      throw DomainError.notFound(`耗材 ${materialId}`);
    }
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new DomainError("invalid_param", "入库数量必须为正数");
    }
    const at = isoOrNow(body.receivedAt, this.clock);
    const expiresAt = optionalString(body, "expiresAt");
    if (expiresAt !== undefined && Number.isNaN(Date.parse(expiresAt))) {
      throw new DomainError("invalid_param", "expiresAt 必须是 ISO-8601 字符串");
    }
    const known = this.state.batches.find((b) => b.id === id);
    if (known) {
      throw new DomainError("batch_exists", `批号 ${id} 已存在`, 409);
    }
    const batch: Batch = {
      id,
      materialId,
      quantity,
      receivedAt: at,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      quarantined: false,
    };
    this.state.batches.push(batch);
    this.state.materialEvents.push({
      id: genId("evt"),
      type: "received",
      materialId,
      batchId: id,
      quantity,
      at,
    });
    this.persist("batch_receive", { batchId: id, materialId, quantity, at });
    return batch;
  }

  quarantineBatch(batchId: string, body: Record<string, unknown>): Batch {
    const batch = this.state.batches.find((b) => b.id === batchId);
    if (!batch) throw DomainError.notFound(`批号 ${batchId}`);
    if (batch.quarantined) {
      throw new DomainError("batch_quarantined", `批号 ${batchId} 已处于隔离状态`, 409);
    }
    const at = isoOrNow(body.at, this.clock);
    batch.quarantined = true;
    this.state.materialEvents.push({
      id: genId("evt"),
      type: "quarantined",
      materialId: batch.materialId,
      batchId: batch.id,
      quantity: 0,
      at,
      ref: optionalString(body, "reason"),
    });
    // 隔离影响所有未开场且计划使用该批号的场次，派生状态由评估实时反映。
    for (const session of this.state.sessions) {
      if (PRE_SHOW_STATES.has(session.state)) this.recomputeDerived(session);
    }
    this.persist("batch_quarantine", { batchId, at, reason: body.reason ?? null });
    return batch;
  }

  recordMaterialEvent(batchId: string, body: Record<string, unknown>): unknown {
    const batch = this.state.batches.find((b) => b.id === batchId);
    if (!batch) throw DomainError.notFound(`批号 ${batchId}`);
    const type = requireString(body, "type") as MaterialEventType;
    if (type !== "received" && type !== "consumed" && type !== "reserved") {
      throw new DomainError("invalid_param", "手工登记仅支持 received/consumed/reserved 事件");
    }
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new DomainError("invalid_param", "数量必须为正数");
    }
    if (type === "consumed") {
      if (batch.quarantined) {
        throw new DomainError("batch_quarantined", "隔离批号不可消耗", 409);
      }
      if (batch.quantity < quantity) {
        throw new DomainError("material_insufficient", "批号库存不足");
      }
      batch.quantity -= quantity;
    }
    if (type === "received") batch.quantity += quantity;
    const event = {
      id: genId("evt"),
      type,
      materialId: batch.materialId,
      batchId,
      quantity,
      at: isoOrNow(body.at, this.clock),
    };
    this.state.materialEvents.push(event);
    this.persist("material_event", event);
    return event;
  }

  // —— 场次 ——

  createSession(body: Record<string, unknown>): Session {
    const scheduledStart = isoOrNow(body.scheduledStart, this.clock);
    const scheduledEnd = isoOrNow(body.scheduledEnd, this.clock);
    if (Date.parse(scheduledEnd) <= Date.parse(scheduledStart)) {
      throw new DomainError("invalid_param", "场次结束时间必须晚于开始时间");
    }
    const leadMinutes = body.leadMinutes === undefined ? 30 : Number(body.leadMinutes);
    if (!Number.isFinite(leadMinutes) || leadMinutes < 0) {
      throw new DomainError("invalid_param", "leadMinutes 必须是非负数字");
    }
    const materialLines = Array.isArray(body.materials) ? body.materials : [];
    const materials = materialLines.map((raw) => {
      const line = raw as Record<string, unknown>;
      return {
        materialId: requireString(line, "materialId"),
        expectedBatchId: requireString(line, "expectedBatchId"),
        quantity: Number(line.quantity),
      };
    });
    for (const line of materials) {
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
        throw new DomainError("invalid_param", `耗材 ${line.materialId} 数量必须为正数`);
      }
    }
    const equipmentIds = Array.isArray(body.equipmentIds)
      ? (body.equipmentIds as unknown[]).map((x) => String(x))
      : [];
    const emergencyStaffRequired = Number(body.emergencyStaffRequired ?? 1);
    if (!Number.isInteger(emergencyStaffRequired) || emergencyStaffRequired < 0) {
      throw new DomainError("invalid_param", "应急人员人数必须是非负整数");
    }
    const session: Session = {
      id: typeof body.id === "string" ? body.id : genId("sess"),
      title: requireString(body, "title"),
      scriptId: requireString(body, "scriptId"),
      scriptVersion: requireString(body, "scriptVersion"),
      venueId: requireString(body, "venueId"),
      presenterId: requireString(body, "presenterId"),
      requiredQualification: requireString(body, "requiredQualification"),
      equipmentIds,
      materials,
      emergencyStaffRequired,
      scheduledStart,
      scheduledEnd,
      checkDeadline: new Date(Date.parse(scheduledStart) - leadMinutes * 60_000).toISOString(),
      state: "preparing",
      createdAt: isoNow(this.clock),
    };
    if (this.state.sessions.some((s) => s.id === session.id)) {
      throw new DomainError("session_exists", `场次 ${session.id} 已存在`, 409);
    }
    this.state.sessions.push(session);
    this.recomputeDerived(session);
    this.persist("session_create", { sessionId: session.id }, undefined, session.id);
    return session;
  }

  evaluate(sessionId: string, at?: string): GateResult {
    const session = this.findSession(sessionId);
    return this.computeGate(session, at);
  }

  sessionDetail(sessionId: string): { session: Session; gate: GateResult } {
    const session = this.findSession(sessionId);
    return { session, gate: this.evaluate(sessionId) };
  }

  // —— 检查登记（均以实际发生时间为准，登记时间仅留痕） ——

  recordEquipmentCheck(sessionId: string, body: Record<string, unknown>): unknown {
    const session = this.findSession(sessionId);
    this.assertPreShow(session);
    const equipmentId = requireString(body, "equipmentId");
    if (!session.equipmentIds.includes(equipmentId)) {
      throw new DomainError(
        "not_in_session",
        `设备 ${equipmentId} 不属于场次 ${sessionId} 的点检清单`,
      );
    }
    if (typeof body.ok !== "boolean") {
      throw new DomainError("invalid_param", "ok 必须是布尔值");
    }
    const check = {
      id: typeof body.id === "string" ? body.id : genId("chk"),
      sessionId,
      equipmentId,
      ok: body.ok,
      checkedAt: isoOrNow(body.checkedAt, this.clock),
      checkedBy: requireString(body, "checkedBy"),
      recordedAt: isoNow(this.clock),
      ...(optionalString(body, "note") !== undefined ? { note: optionalString(body, "note") } : {}),
    };
    this.state.equipmentChecks.push(check);
    this.afterPreShowMutation(session, "equipment_check", check, check.checkedBy);
    return check;
  }

  recordAttendance(sessionId: string, body: Record<string, unknown>): unknown {
    const session = this.findSession(sessionId);
    this.assertPreShow(session);
    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 0) {
      throw new DomainError("invalid_param", "入场人数必须是非负整数");
    }
    const record = {
      id: typeof body.id === "string" ? body.id : genId("att"),
      sessionId,
      count,
      countedAt: isoOrNow(body.countedAt, this.clock),
    };
    this.state.attendanceCounts.push(record);
    this.afterPreShowMutation(session, "attendance_count", record);
    return record;
  }

  recordArrival(sessionId: string, body: Record<string, unknown>): unknown {
    const session = this.findSession(sessionId);
    // 开场后人员名单锁定，不允许再补签到。
    this.assertPreShow(session);
    const arrival = {
      id: typeof body.id === "string" ? body.id : genId("arr"),
      sessionId,
      personId: requireString(body, "personId"),
      name: requireString(body, "name"),
      arrivedAt: isoOrNow(body.arrivedAt, this.clock),
    };
    this.state.arrivals.push(arrival);
    this.afterPreShowMutation(session, "emergency_arrival", arrival);
    return arrival;
  }

  /**
   * 耗材扫码：scanId 是二维码+扫码动作的幂等键。
   * 重复扫码直接返回原记录，不重复产生消耗事件、不重复扣减库存。
   */
  scanMaterial(sessionId: string, body: Record<string, unknown>): { scan: unknown; deduplicated: boolean } {
    const session = this.findSession(sessionId);
    this.assertPreShow(session);
    const scanId = requireString(body, "scanId");
    const materialId = requireString(body, "materialId");
    const line = session.materials.find((m) => m.materialId === materialId);
    if (!line) {
      throw new DomainError("not_in_session", `耗材 ${materialId} 不在场次领用单上`);
    }

    const duplicate = this.state.scans.find((s) => s.scanId === scanId);
    if (duplicate) {
      if (duplicate.sessionId !== sessionId || duplicate.materialId !== materialId) {
        throw new DomainError("scan_conflict", "该扫码记录已属于其他场次或耗材", 409);
      }
      return { scan: duplicate, deduplicated: true };
    }

    const batchId = requireString(body, "batchId");
    const batch = this.state.batches.find((b) => b.id === batchId);
    const quantity =
      body.quantity === undefined ? line.quantity : Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new DomainError("invalid_param", "扫码数量必须为正数");
    }
    const scan = {
      id: genId("scan"),
      scanId,
      sessionId,
      materialId,
      batchId,
      quantity,
      scannedAt: isoOrNow(body.scannedAt, this.clock),
      scannedBy: requireString(body, "scannedBy"),
    };
    this.state.scans.push(scan);

    // 仅当本场次此前从未扫过与领用单一致的批号时才消耗：
    // 错批号不消耗，错扫后补扫正确批号正常消耗，正确批号重复扫码不多次消耗。
    const priorValidScan = this.state.scans.some(
      (s) =>
        s !== scan &&
        s.sessionId === sessionId &&
        s.materialId === materialId &&
        s.batchId === line.expectedBatchId,
    );
    let consumed = false;
    let consumeNote: string | undefined;
    if (!priorValidScan && batchId === line.expectedBatchId) {
      if (!batch) {
        consumeNote = `批号 ${batchId} 未入库，扫码留痕但不消耗库存`;
      } else if (batch.quarantined) {
        consumeNote = `批号 ${batchId} 已隔离，扫码留痕但不消耗库存`;
      } else if (batch.quantity < line.quantity) {
        consumeNote = `批号 ${batchId} 库存不足，扫码留痕但不消耗库存`;
      } else {
        batch.quantity -= line.quantity;
        this.state.materialEvents.push({
          id: genId("evt"),
          type: "consumed",
          materialId,
          batchId,
          quantity: line.quantity,
          at: scan.scannedAt,
          ref: sessionId,
        });
        consumed = true;
      }
    }

    this.afterPreShowMutation(
      session,
      "material_scan",
      { scan, consumed, deduplicated: false, ...(consumeNote !== undefined ? { consumeNote } : {}) },
      scan.scannedBy,
    );
    return { scan, deduplicated: false };
  }

  // —— 例外放行 ——

  private assertPermission(reviewer: Reviewer, permission: string): void {
    const wildcard = `${permission.split(":")[0]}:any`;
    if (!reviewer.permissions.includes(permission) && !reviewer.permissions.includes(wildcard)) {
      throw new DomainError(
        "forbidden",
        `复核者 ${reviewer.name} 缺少 ${permission}（或 ${wildcard}）权限`,
        403,
      );
    }
  }

  grantException(sessionId: string, body: Record<string, unknown>): ExceptionRecord {
    const session = this.findSession(sessionId);
    this.assertPreShow(session);
    const item = requireString(body, "item") as CheckItem;
    if (!CHECK_ITEMS.includes(item)) {
      throw new DomainError("invalid_param", `例外项必须是 ${CHECK_ITEMS.join("/")} 之一`);
    }
    const reviewer = this.findReviewer(requireString(body, "reviewerId"));
    this.assertPermission(reviewer, `waive:${item}`);

    const code = optionalString(body, "code");
    // 例外必须针对当前确实存在的阻断，避免空白授权。
    const gate = this.evaluate(sessionId);
    const target = gate.blocks.find((b) => b.item === item && (code === undefined || b.code === code));
    if (!target) {
      throw new DomainError(
        "no_matching_block",
        code === undefined
          ? `当前闸门不存在 ${item} 项阻断，无需例外`
          : `当前闸门不存在 ${item}/${code} 阻断，无需例外`,
        409,
      );
    }

    const ttlMinutes = body.ttlMinutes === undefined ? undefined : Number(body.ttlMinutes);
    if (ttlMinutes !== undefined && (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0)) {
      throw new DomainError("invalid_param", "ttlMinutes 必须是正数");
    }
    const now = this.clock.now();
    const record: ExceptionRecord = {
      id: genId("exc"),
      sessionId,
      item,
      ...(code !== undefined ? { code } : {}),
      reason: requireString(body, "reason"),
      reviewerId: reviewer.id,
      grantedAt: now.toISOString(),
      // 例外仅覆盖本场次：默认在场次结束时失效。
      expiresAt:
        ttlMinutes !== undefined
          ? new Date(now.getTime() + ttlMinutes * 60_000).toISOString()
          : session.scheduledEnd,
    };
    this.state.exceptions.push(record);
    this.afterPreShowMutation(session, "exception_grant", record, reviewer.id);
    return record;
  }

  // —— 事故 ——

  registerIncident(sessionId: string, body: Record<string, unknown>): Incident {
    const session = this.findSession(sessionId);
    if (session.state === "completed") {
      throw new DomainError("session_completed", "已完成场次只可补录安全记录，不在此登记事故", 409);
    }
    if (this.state.incidents.some((i) => i.sessionId === sessionId && i.resolvedAt === undefined)) {
      throw new DomainError("incident_open", "该场次已有未结案事故", 409);
    }
    const registeredAt = isoOrNow(body.registeredAt, this.clock);
    const incident: Incident = {
      id: typeof body.id === "string" ? body.id : genId("inc"),
      sessionId,
      description: requireString(body, "description"),
      registeredAt,
      registeredBy: requireString(body, "registeredBy"),
    };
    this.state.incidents.push(incident);

    // 事故登记即停止：本场次（含进行中）及所有后续未开场场次一律停用，原始记录全部保留。
    const stopped: string[] = [];
    for (const other of this.state.sessions) {
      if (other.state === "completed" || other.state === "stopped") continue;
      const isOwn = other.id === session.id;
      const isLater = Date.parse(other.scheduledStart) >= Date.parse(registeredAt);
      if (isOwn || isLater) {
        other.state = "stopped";
        other.suspendedByIncidentId = incident.id;
        other.stopReason = {
          code: "stopped_by_incident",
          incidentId: incident.id,
          at: registeredAt,
        };
        stopped.push(other.id);
      }
    }
    this.persist(
      "incident_register",
      { incident, stoppedSessions: stopped },
      incident.registeredBy,
      sessionId,
    );
    return incident;
  }

  private findIncident(incidentId: string): Incident {
    const incident = this.state.incidents.find((i) => i.id === incidentId);
    if (!incident) throw DomainError.notFound(`事故 ${incidentId}`);
    return incident;
  }

  private assertIncidentPermission(reviewer: Reviewer): void {
    if (
      !reviewer.permissions.includes("incident:resolve") &&
      !reviewer.permissions.includes("incident:any")
    ) {
      throw new DomainError("forbidden", "确认/结案事故需要 incident:resolve 权限", 403);
    }
  }

  confirmIncident(incidentId: string, body: Record<string, unknown>): Incident {
    const incident = this.findIncident(incidentId);
    if (incident.confirmedAt !== undefined) {
      throw new DomainError("incident_confirmed", "事故已确认", 409);
    }
    const reviewer = this.findReviewer(requireString(body, "reviewerId"));
    this.assertIncidentPermission(reviewer);
    incident.confirmedAt = isoNow(this.clock);
    incident.confirmedBy = reviewer.id;
    // 未确认事故也在阻断开场；确认只更新事实，不解除停用。
    this.persist("incident_confirm", { incidentId }, reviewer.id, incident.sessionId);
    return incident;
  }

  resolveIncident(incidentId: string, body: Record<string, unknown>): Incident {
    const incident = this.findIncident(incidentId);
    if (incident.resolvedAt !== undefined) {
      throw new DomainError("incident_resolved", "事故已结案", 409);
    }
    const reviewer = this.findReviewer(requireString(body, "reviewerId"));
    this.assertIncidentPermission(reviewer);
    incident.resolvedAt = isoNow(this.clock);
    incident.resolvedBy = reviewer.id;
    const note = optionalString(body, "note");
    if (note !== undefined) incident.resolutionNote = note;
    // 已停止的场次不自动复活——事故阻断解除后需另排新场次；这里只解除闸门事故锁。
    this.persist("incident_resolve", { incidentId, note: note ?? null }, reviewer.id, incident.sessionId);
    return incident;
  }

  // —— 开场与结束 ——

  start(sessionId: string, body: Record<string, unknown> = {}): { session: Session; gate: GateResult } {
    const session = this.findSession(sessionId);
    this.assertPreShow(session);
    const gate = this.evaluate(sessionId);
    if (gate.decision !== "go") {
      throw new DomainError(
        "gate_blocked",
        `开场被 ${gate.blocks.length} 项强制条件阻断，最先失效：${
          gate.firstFailure ? `${gate.firstFailure.item}/${gate.firstFailure.code}` : "见阻断明细"
        }`,
        409,
      );
    }
    const atIso = isoOrNow(body.at, this.clock);
    if (Date.parse(atIso) > Date.parse(session.scheduledStart) + 15 * 60_000) {
      throw new DomainError("session_overdue", "已超过开场窗口，请改期后重新编排场次", 409);
    }
    session.state = "running";
    session.startedAt = atIso;

    // 演示开始即锁定脚本版本与人员名单（含实际到岗应急人员）。
    const presenter = this.state.presenters.find((p) => p.id === session.presenterId);
    const arrivals = this.state.arrivals
      .filter((a) => a.sessionId === sessionId)
      .sort((a, b) => Date.parse(a.arrivedAt) - Date.parse(b.arrivedAt));
    const seen = new Set<string>();
    session.lock = {
      lockedAt: atIso,
      scriptId: session.scriptId,
      scriptVersion: session.scriptVersion,
      presenterId: session.presenterId,
      staff: [
        ...(presenter
          ? [{ personId: presenter.id, name: presenter.name, arrivedAt: atIso }]
          : []),
        ...arrivals
          .filter((a) => {
            if (seen.has(a.personId)) return false;
            seen.add(a.personId);
            return true;
          })
          .map((a) => ({ personId: a.personId, name: a.name, arrivedAt: a.arrivedAt })),
      ],
    };
    this.persist("session_start", { sessionId, at: atIso, lock: session.lock }, undefined, sessionId);
    return { session, gate };
  }

  complete(sessionId: string, body: Record<string, unknown> = {}): Session {
    const session = this.findSession(sessionId);
    if (session.state !== "running") {
      throw new DomainError("not_running", `场次处于 ${session.state}，无法结束`, 409);
    }
    session.state = "completed";
    session.completedAt = isoOrNow(body.at, this.clock);
    this.persist("session_complete", { sessionId, at: session.completedAt }, undefined, sessionId);
    return session;
  }
}
