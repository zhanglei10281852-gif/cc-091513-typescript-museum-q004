import { msToIsoDuration, parseTime } from "./clock.js";
import type {
  CheckItem,
  ExceptionRecord,
  Incident,
  Session,
  State,
} from "./types.js";

/** 系统级阻断项不可被例外覆盖；只有处置事故/改期才能解除。 */
export type GateItem = CheckItem | "incident" | "session";

export interface Margin {
  ms: number | null;
  text: string;
}

export interface GateBlock {
  item: GateItem;
  code: string;
  message: string;
  /** 条件实际失效的时间点；未到截止时间的待办项为 null。 */
  blockedAt: string | null;
  /** 实际余量：正数尚余、负数已超，附带人类可读描述。 */
  margin: Margin;
  remediation: string[];
  waivable: boolean;
  exception?: ExceptionRecord | undefined;
}

export interface GateResult {
  sessionId: string;
  evaluatedAt: string;
  phase: "pre_show" | "running" | "stopped" | "completed";
  decision: "go" | "no_go" | "running" | "stopped" | "completed";
  /** 最先失效的强制项（按实际失效时间，不含已被例外覆盖者）。 */
  firstFailure: GateBlock | null;
  /** 仍在阻断开场的原因。 */
  blocks: GateBlock[];
  /** 已被有效例外覆盖的阻断，留痕展示但不再锁开场。 */
  waived: GateBlock[];
  /** 关键时点的实际余量。 */
  margins: {
    minutesToStart: number;
    minutesToDeadline: number;
    minutesToEnd: number;
  };
}

function margin(ms: number | null, text: string): Margin {
  return { ms, text };
}

function latestBy<T>(items: T[], timeOf: (item: T) => string): T | undefined {
  return items.reduce<T | undefined>((best, item) => {
    if (best === undefined || parseTime(timeOf(item)) > parseTime(timeOf(best))) {
      return item;
    }
    return best;
  }, undefined);
}

export interface EvaluationContext {
  state: State;
  session: Session;
  at: Date;
}

/** 找出对该阻断生效的例外：项匹配、场次匹配、未过期、码匹配（省略码=覆盖该项全部码）。 */
function findException(
  state: State,
  session: Session,
  item: CheckItem,
  code: string,
  nowMs: number,
): ExceptionRecord | undefined {
  return state.exceptions.find((ex) => {
    if (ex.sessionId !== session.id || ex.item !== item) return false;
    if (ex.code !== undefined && ex.code !== code) return false;
    if (ex.expiresAt !== undefined && parseTime(ex.expiresAt) <= nowMs) {
      return false;
    }
    return true;
  });
}

function openIncidentFor(state: State, session: Session): Incident | undefined {
  return state.incidents.find(
    (incident) => incident.sessionId === session.id && incident.resolvedAt === undefined,
  );
}

export function evaluateGate(ctx: EvaluationContext): GateResult {
  const { state, session } = ctx;
  const nowMs = ctx.at.getTime();
  const nowIso = ctx.at.toISOString();
  const startMs = parseTime(session.scheduledStart);
  const endMs = parseTime(session.scheduledEnd);
  const deadlineMs = parseTime(session.checkDeadline);

  const baseMargins = {
    minutesToStart: Math.round((startMs - nowMs) / 60_000),
    minutesToDeadline: Math.round((deadlineMs - nowMs) / 60_000),
    minutesToEnd: Math.round((endMs - nowMs) / 60_000),
  };

  if (session.state === "running") {
    return {
      sessionId: session.id,
      evaluatedAt: nowIso,
      phase: "running",
      decision: "running",
      firstFailure: null,
      blocks: [],
      waived: [],
      margins: baseMargins,
    };
  }
  if (session.state === "completed") {
    return {
      sessionId: session.id,
      evaluatedAt: nowIso,
      phase: "completed",
      decision: "completed",
      firstFailure: null,
      blocks: [],
      waived: [],
      margins: baseMargins,
    };
  }
  if (session.state === "stopped") {
    const reason = session.stopReason;
    return {
      sessionId: session.id,
      evaluatedAt: nowIso,
      phase: "stopped",
      decision: "stopped",
      firstFailure: null,
      blocks: [
        {
          item: "session",
          code: reason?.code ?? "stopped",
          message:
            reason?.incidentId !== undefined
              ? `场次已被事故 ${reason.incidentId} 停止，原始记录已保全`
              : "场次已停止",
          blockedAt: reason?.at ?? null,
          margin:
            reason !== undefined
              ? margin(-(nowMs - parseTime(reason.at)), `已停止 ${msToIsoDuration(nowMs - parseTime(reason.at))}`)
              : margin(null, "场次已停止"),
          remediation: [
            reason?.incidentId !== undefined
              ? `先由持 incident:resolve 权限者结案事故 ${reason.incidentId}，再另行安排场次`
              : "另行安排新场次",
          ],
          waivable: false,
        },
      ],
      waived: [],
      margins: baseMargins,
    };
  }

  const blocks: GateBlock[] = [];
  const add = (block: GateBlock): void => {
    if (block.waivable) {
      const exception = findException(state, session, block.item as CheckItem, block.code, nowMs);
      if (exception) {
        blocks.push({ ...block, exception });
        return;
      }
    }
    blocks.push(block);
  };

  // —— 系统级：超过开场宽限窗口仍未开场，必须改期 ——
  const openUntilMs = startMs + 15 * 60_000;
  if (nowMs > openUntilMs) {
    blocks.push({
      item: "session",
      code: "session_overdue",
      message: `已超过开场时间 ${msToIsoDuration(nowMs - openUntilMs)}，本场次不可再开场`,
      blockedAt: new Date(openUntilMs).toISOString(),
      margin: margin(
        -(nowMs - openUntilMs),
        `已超开场窗口 ${msToIsoDuration(nowMs - openUntilMs)}`,
      ),
      remediation: ["改期并重新编制场次后重新走全部闸门检查"],
      waivable: false,
    });
  }

  // —— 系统级：未结案事故 ——
  const incident = openIncidentFor(state, session);
  if (incident) {
    const confirmed = incident.confirmedAt !== undefined;
    blocks.push({
      item: "incident",
      code: confirmed ? "incident_open" : "incident_unconfirmed",
      message: confirmed
        ? `事故 ${incident.id} 已确认尚未结案`
        : `事故 ${incident.id} 已登记但尚未确认`,
      blockedAt: incident.registeredAt,
      margin: margin(
        -(nowMs - parseTime(incident.registeredAt)),
        `已持续 ${msToIsoDuration(nowMs - parseTime(incident.registeredAt))}`,
      ),
      remediation: confirmed
        ? [`由持 incident:resolve 权限者结案事故 ${incident.id}`]
        : [
            `由持 incident:resolve 权限者确认并结案事故 ${incident.id}`,
            "事故未确认期间开场保持锁定",
          ],
      waivable: false,
    });
  }

  // —— 1. 脚本版本 ——
  const script = state.scripts.find((s) => s.id === session.scriptId);
  if (!script) {
    add({
      item: "script",
      code: "script_not_found",
      message: `脚本 ${session.scriptId} 未登记`,
      blockedAt: session.createdAt,
      margin: margin(startMs - nowMs, `距开场 ${msToIsoDuration(startMs - nowMs)}`),
      remediation: ["登记并审批演示脚本", "更换为已审批脚本后改派场次"],
      waivable: true,
    });
  } else if (!script.approved) {
    add({
      item: "script",
      code: "script_not_approved",
      message: `脚本《${script.title}》尚未通过审批`,
      blockedAt: session.createdAt,
      margin: margin(startMs - nowMs, `距开场 ${msToIsoDuration(startMs - nowMs)}`),
      remediation: ["完成脚本审批流程"],
      waivable: true,
    });
  } else if (script.version !== session.scriptVersion) {
    add({
      item: "script",
      code: "script_version_mismatch",
      message: `场次锁定脚本 v${session.scriptVersion}，当前审批版本为 v${script.version}`,
      blockedAt: session.createdAt,
      margin: margin(startMs - nowMs, `距开场 ${msToIsoDuration(startMs - nowMs)}`),
      remediation: [
        `按当前审批版本 v${script.version} 重新编制场次`,
        "或由持 waive:script 权限的复核者针对本场次例外放行旧版本",
      ],
      waivable: true,
    });
  }

  // —— 2. 设备点检（迟到按实际检查时间归属） ——
  const sessionChecks = state.equipmentChecks.filter((c) => c.sessionId === session.id);
  for (const equipmentId of session.equipmentIds) {
    const equipment = state.equipment.find((e) => e.id === equipmentId);
    const name = equipment?.name ?? equipmentId;
    const check = latestBy(
      sessionChecks.filter((c) => c.equipmentId === equipmentId),
      (c) => c.checkedAt,
    );
    if (!check) {
      const overdue = nowMs >= deadlineMs;
      add({
        item: "equipment",
        code: "equipment_not_checked",
        message: `设备「${name}」尚未点检`,
        blockedAt: overdue ? session.checkDeadline : null,
        margin: overdue
          ? margin(-(nowMs - deadlineMs), `已过点检截止 ${msToIsoDuration(nowMs - deadlineMs)}`)
          : margin(deadlineMs - nowMs, `距点检截止 ${msToIsoDuration(deadlineMs - nowMs)}`),
        remediation: ["在截止时间前完成设备点检并登记"],
        waivable: true,
      });
    } else if (!check.ok) {
      add({
        item: "equipment",
        code: "equipment_failed",
        message: `设备「${name}」点检不合格${check.note !== undefined ? `：${check.note}` : ""}`,
        blockedAt: check.checkedAt,
        margin: margin(
          -(nowMs - parseTime(check.checkedAt)),
          `不合格已登记 ${msToIsoDuration(nowMs - parseTime(check.checkedAt))}`,
        ),
        remediation: ["检修设备并重新点检合格"],
        waivable: true,
      });
    } else if (parseTime(check.checkedAt) > deadlineMs) {
      add({
        item: "equipment",
        code: "equipment_late",
        message: `设备「${name}」实际点检时间 ${check.checkedAt} 晚于截止 ${session.checkDeadline}`,
        // 迟到点检归属到实际检查时间：失效证据在该时刻才成立。
        blockedAt: check.checkedAt,
        margin: margin(
          -(parseTime(check.checkedAt) - deadlineMs),
          `迟到 ${msToIsoDuration(parseTime(check.checkedAt) - deadlineMs)}`,
        ),
        remediation: [
          "推迟开场并重新设定点检截止",
          "或由持 waive:equipment 权限的复核者针对本场次确认放行",
        ],
        waivable: true,
      });
    }
  }

  // —— 3. 讲师资质 ——
  const presenter = state.presenters.find((p) => p.id === session.presenterId);
  if (!presenter) {
    add({
      item: "operator",
      code: "operator_not_found",
      message: `讲师 ${session.presenterId} 未登记`,
      blockedAt: session.createdAt,
      margin: margin(startMs - nowMs, `距开场 ${msToIsoDuration(startMs - nowMs)}`),
      remediation: ["指派已登记讲师"],
      waivable: true,
    });
  } else {
    const qualification = presenter.qualifications.find(
      (q) => q.type === session.requiredQualification,
    );
    if (!qualification) {
      add({
        item: "operator",
        code: "qualification_missing",
        message: `讲师「${presenter.name}」缺少「${session.requiredQualification}」资质`,
        blockedAt: null,
        margin: margin(startMs - nowMs, `距开场 ${msToIsoDuration(startMs - nowMs)}，仍未取得资质`),
        remediation: [
          "换用具备该资质的讲师",
          "或由持 waive:operator 权限的复核者针对本场次例外放行",
        ],
        waivable: true,
      });
    } else {
      if (parseTime(qualification.validFrom) > startMs) {
        add({
          item: "operator",
          code: "qualification_not_yet_valid",
          message: `讲师「${presenter.name}」资质 ${qualification.validFrom} 才生效`,
          blockedAt: null,
          margin: margin(
            parseTime(qualification.validFrom) - startMs,
            `开场后 ${msToIsoDuration(parseTime(qualification.validFrom) - startMs)} 才生效`,
          ),
          remediation: ["换用资质已生效的讲师"],
          waivable: true,
        });
      }
      if (parseTime(qualification.validUntil) < endMs) {
        const expired = parseTime(qualification.validUntil) <= nowMs;
        add({
          item: "operator",
          code: "qualification_expired",
          message: `讲师「${presenter.name}」资质于 ${qualification.validUntil} 到期，不能覆盖全场（结束 ${session.scheduledEnd}）`,
          blockedAt: qualification.validUntil,
          margin: expired
            ? margin(
                -(nowMs - parseTime(qualification.validUntil)),
                `资质已过期 ${msToIsoDuration(nowMs - parseTime(qualification.validUntil))}`,
              )
            : margin(
                parseTime(qualification.validUntil) - nowMs,
                `距资质到期仅剩 ${msToIsoDuration(parseTime(qualification.validUntil) - nowMs)}`,
              ),
          remediation: [
            "换用资质有效期覆盖全场的讲师",
            "或由持 waive:operator 权限的复核者针对本场次例外放行",
          ],
          waivable: true,
        });
      }
    }
  }

  // —— 4. 耗材批次（批号须与领用单一致） ——
  const sessionScans = state.scans.filter((s) => s.sessionId === session.id);
  for (const line of session.materials) {
    const material = state.materials.find((m) => m.id === line.materialId);
    const materialName = material?.name ?? line.materialId;
    const scan = latestBy(
      sessionScans.filter((s) => s.materialId === line.materialId),
      (s) => s.scannedAt,
    );
    if (!scan) {
      const overdue = nowMs >= deadlineMs;
      add({
        item: "material",
        code: "material_not_scanned",
        message: `耗材「${materialName}」尚未扫码领用`,
        blockedAt: overdue ? session.checkDeadline : null,
        margin: overdue
          ? margin(-(nowMs - deadlineMs), `已过领用截止 ${msToIsoDuration(nowMs - deadlineMs)}`)
          : margin(deadlineMs - nowMs, `距领用截止 ${msToIsoDuration(deadlineMs - nowMs)}`),
        remediation: [`领用批号 ${line.expectedBatchId} 的耗材并扫码登记`],
        waivable: true,
      });
      continue;
    }
    if (scan.batchId !== line.expectedBatchId) {
      add({
        item: "material",
        code: "material_batch_mismatch",
        message: `耗材「${materialName}」扫码批号 ${scan.batchId} 与领用单批号 ${line.expectedBatchId} 不一致`,
        blockedAt: scan.scannedAt,
        margin: margin(
          -(nowMs - parseTime(scan.scannedAt)),
          `批号不一致已发现 ${msToIsoDuration(nowMs - parseTime(scan.scannedAt))}`,
        ),
        remediation: [
          `退换新批号，重新领用批号为 ${line.expectedBatchId} 的耗材`,
          "或由持 waive:material 权限的复核者针对本场次例外放行",
        ],
        waivable: true,
      });
      continue;
    }
    const batch = state.batches.find((b) => b.id === line.expectedBatchId);
    if (!batch) {
      add({
        item: "material",
        code: "batch_not_found",
        message: `批号 ${line.expectedBatchId} 未登记`,
        blockedAt: scan.scannedAt,
        margin: margin(null, "批号未入库，无可计算余量"),
        remediation: ["先完成批号入库登记"],
        waivable: true,
      });
      continue;
    }
    if (batch.quarantined) {
      const quarantineEvent = state.materialEvents.find(
        (e) => e.batchId === batch.id && e.type === "quarantined",
      );
      add({
        item: "material",
        code: "material_quarantined",
        message: `批号 ${batch.id} 已被隔离停用`,
        blockedAt: quarantineEvent?.at ?? session.createdAt,
        margin: margin(null, "批号已隔离，无可计算余量"),
        remediation: ["更换未隔离的同品批号耗材"],
        waivable: true,
      });
      continue;
    }
    if (batch.expiresAt !== undefined && parseTime(batch.expiresAt) < endMs) {
      const expired = parseTime(batch.expiresAt) <= nowMs;
      add({
        item: "material",
        code: "material_expired",
        message: `批号 ${batch.id} 于 ${batch.expiresAt} 到期，不能覆盖到场次结束`,
        blockedAt: batch.expiresAt,
        margin: expired
          ? margin(
              -(nowMs - parseTime(batch.expiresAt)),
              `耗材已过期 ${msToIsoDuration(nowMs - parseTime(batch.expiresAt))}`,
            )
          : margin(
              parseTime(batch.expiresAt) - nowMs,
              `距到期 ${msToIsoDuration(parseTime(batch.expiresAt) - nowMs)}，有效期比场次结束早 ${msToIsoDuration(endMs - parseTime(batch.expiresAt))}`,
            ),
        remediation: ["更换有效期覆盖全场的批号"],
        waivable: true,
      });
    }
    if (batch.quantity < line.quantity) {
      add({
        item: "material",
        code: "material_insufficient",
        message: `批号 ${batch.id} 库存 ${batch.quantity}${material?.unit ?? ""}，本场次需 ${line.quantity}${material?.unit ?? ""}`,
        blockedAt: null,
        margin: margin(
          batch.quantity - line.quantity,
          `缺 ${line.quantity - batch.quantity}${material?.unit ?? ""}`,
        ),
        remediation: ["补足库存或更换足量批号"],
        waivable: true,
      });
    }
  }

  // —— 5. 场地容量 ——
  const venue = state.venues.find((v) => v.id === session.venueId);
  const attendance = latestBy(
    state.attendanceCounts.filter((a) => a.sessionId === session.id),
    (a) => a.countedAt,
  );
  if (!venue) {
    add({
      item: "capacity",
      code: "venue_not_found",
      message: `场地 ${session.venueId} 未登记`,
      blockedAt: session.createdAt,
      margin: margin(null, "场地未登记，无法核算容量余量"),
      remediation: ["登记场地信息"],
      waivable: true,
    });
  } else if (!attendance) {
    add({
      item: "capacity",
      code: "attendance_not_counted",
      message: `场地「${venue.name}」尚未清点入场人数`,
      blockedAt: null,
      margin: margin(
        venue.capacity,
        `核定容量 ${venue.capacity} 人，尚未清点`,
      ),
      remediation: ["开场前完成入场人数清点"],
      waivable: true,
    });
  } else if (attendance.count > venue.capacity) {
    add({
      item: "capacity",
      code: "capacity_exceeded",
      message: `入场 ${attendance.count} 人，超过场地「${venue.name}」核定容量 ${venue.capacity} 人`,
      blockedAt: attendance.countedAt,
      margin: margin(
        venue.capacity - attendance.count,
        `超出 ${attendance.count - venue.capacity} 人`,
      ),
      remediation: [
        `疏散 ${attendance.count - venue.capacity} 人后重新清点`,
        "或由持 waive:capacity 权限的复核者针对本场次例外放行",
      ],
      waivable: true,
    });
  }

  // —— 6. 应急人员到岗 ——
  const arrivals = state.arrivals.filter((a) => a.sessionId === session.id);
  // 同一人员最早一次到岗为准（重复签到不多算）。
  const earliestArrivalByPerson = new Map<string, string>();
  for (const arrival of arrivals) {
    const known = earliestArrivalByPerson.get(arrival.personId);
    if (known === undefined || parseTime(arrival.arrivedAt) < parseTime(known)) {
      earliestArrivalByPerson.set(arrival.personId, arrival.arrivedAt);
    }
  }
  const onTime = [...earliestArrivalByPerson.values()].filter((t) => parseTime(t) <= deadlineMs);
  const late = [...earliestArrivalByPerson.entries()]
    .filter(([, t]) => parseTime(t) > deadlineMs)
    .sort((a, b) => parseTime(a[1]) - parseTime(b[1]));
  if (onTime.length < session.emergencyStaffRequired) {
    const missing = session.emergencyStaffRequired - onTime.length;
    if (late.length > 0) {
      const [personId, arrivedAt] = late[0]!;
      const person = arrivals.find((a) => a.personId === personId);
      add({
        item: "emergency_staff",
        code: "emergency_staff_late",
        message: `应急人员「${person?.name ?? personId}」实际到岗 ${arrivedAt} 晚于截止 ${session.checkDeadline}，按时到岗仅 ${onTime.length}/${session.emergencyStaffRequired}`,
        blockedAt: arrivedAt,
        margin: margin(
          -(parseTime(arrivedAt) - deadlineMs),
          `迟到 ${msToIsoDuration(parseTime(arrivedAt) - deadlineMs)}，仍缺 ${missing} 名`,
        ),
        remediation: [
          `紧急补员 ${missing} 名并在截止前到岗`,
          "或由持 waive:emergency_staff 权限的复核者针对本场次例外放行",
        ],
        waivable: true,
      });
    } else {
      const overdue = nowMs >= deadlineMs;
      add({
        item: "emergency_staff",
        code: "emergency_staff_missing",
        message: `应急人员按时到岗 ${onTime.length}/${session.emergencyStaffRequired}`,
        blockedAt: overdue ? session.checkDeadline : null,
        margin: overdue
          ? margin(-missing, `已过到岗截止，仍缺 ${missing} 名`)
          : margin(deadlineMs - nowMs, `距到岗截止 ${msToIsoDuration(deadlineMs - nowMs)}，仍缺 ${missing} 名`),
        remediation: [`紧急调配 ${missing} 名应急人员到岗`],
        waivable: true,
      });
    }
  }

  const active = blocks.filter((b) => b.exception === undefined);
  const waived = blocks.filter((b): b is GateBlock & { exception: ExceptionRecord } => b.exception !== undefined);

  // 最先失效：在仍生效的阻断中，取实际失效时间最早者；已失效优先于待办项。
  const failed = active
    .filter((b) => b.blockedAt !== null && parseTime(b.blockedAt) <= nowMs)
    .sort((a, b) => parseTime(a.blockedAt!) - parseTime(b.blockedAt!));
  const firstFailure = failed[0] ?? null;

  return {
    sessionId: session.id,
    evaluatedAt: nowIso,
    phase: "pre_show",
    decision: active.length === 0 ? "go" : "no_go",
    firstFailure,
    blocks: active,
    waived,
    margins: baseMargins,
  };
}
