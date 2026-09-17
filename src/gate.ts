/**
 * 安全闸门评估：把脚本版本、设备点检、讲师资质、耗材批次、场地容量、
 * 应急人员到岗六项强制条件汇成一次评估，给出放行结论、阻断原因、
 * 可补救动作与实际余量。任一强制项失效即不放行；五个检查项可由
 * 具备相应权限的复核者针对当前场次例外豁免，脚本版本不可豁免。
 */
import { POLICY } from "./policy.js";
import {
  CONDITION_LABELS,
  type BlockingReason,
  type EmergencyCheckIn,
  type EquipmentInspection,
  type ExceptionGrant,
  type GateCheckResult,
  type GateCondition,
  type GateMargins,
  type GateReport,
  type Instructor,
  type MaterialBatch,
  type MaterialEvent,
  type MaterialMargin,
  type RemediableAction,
  type Requisition,
  type ScriptVersion,
  type Session,
  type Venue,
} from "./types.js";

export interface GateEvaluationInput {
  session: Session;
  script: ScriptVersion | null;
  venue: Venue | null;
  instructors: Instructor[];
  inspections: EquipmentInspection[];
  requisitions: Requisition[];
  batches: ReadonlyMap<string, MaterialBatch>;
  materialEvents: MaterialEvent[];
  checkIns: EmergencyCheckIn[];
  exceptions: ExceptionGrant[];
  now: Date;
}

interface CheckerOutput {
  check: GateCheckResult;
  /** 该项的余量（单位因项而异），无法计算时为 null。 */
  margin: number | null;
  materialMargins: MaterialMargin[];
}

function passOut(
  condition: GateCondition,
  summary: string,
  margin: number | null = null,
  materialMargins: MaterialMargin[] = [],
): CheckerOutput {
  return {
    check: {
      condition,
      conditionLabel: CONDITION_LABELS[condition],
      status: "pass",
      summary,
      problems: [],
      remediableActions: [],
      waivedByExceptionId: null,
    },
    margin,
    materialMargins,
  };
}

function failOut(
  condition: GateCondition,
  summary: string,
  problems: string[],
  actions: string[],
  materialMargins: MaterialMargin[] = [],
): CheckerOutput {
  return {
    check: {
      condition,
      conditionLabel: CONDITION_LABELS[condition],
      status: "fail",
      summary,
      problems,
      remediableActions: actions,
      waivedByExceptionId: null,
    },
    margin: null,
    materialMargins,
  };
}

function scriptMissingOut(condition: GateCondition, noun: string): CheckerOutput {
  return failOut(
    condition,
    `脚本版本未确定，无法核对${noun}`,
    ["脚本版本未确定"],
    ["先为场次指定一个已批准的脚本版本"],
  );
}

function checkScript(input: GateEvaluationInput): CheckerOutput {
  const { session, script } = input;
  if (session.scriptVersionId === null) {
    return failOut("script", "未指定演示脚本版本", ["未指定演示脚本版本"], [
      "为场次指定一个已批准的脚本版本",
    ]);
  }
  if (!script) {
    return failOut(
      "script",
      `脚本版本 ${session.scriptVersionId} 不存在`,
      [`脚本版本 ${session.scriptVersionId} 不存在`],
      ["改用已登记且已批准的脚本版本"],
    );
  }
  if (script.status !== "approved") {
    return failOut(
      "script",
      `脚本版本 ${script.id} 未处于已批准状态（当前：${script.status}）`,
      [`脚本版本 ${script.id} 未处于已批准状态（当前：${script.status}）`],
      ["改用已批准的脚本版本"],
    );
  }
  return passOut("script", `脚本版本 ${script.id}（${script.showId}）已批准`);
}

/**
 * 设备点检：以实际检查时间（checkedAt）归属，补录时间不影响判定。
 * 有效窗口为开场前 inspectionMinLeadMinutes 至 inspectionMaxAgeMinutes。
 */
function checkEquipment(input: GateEvaluationInput, startMs: number): CheckerOutput {
  const { script, inspections } = input;
  if (!script) return scriptMissingOut("equipment", "设备点检要求");

  const problems: string[] = [];
  const actions = new Set<string>();
  let minRemaining = Number.POSITIVE_INFINITY;

  for (const equipmentId of script.requiredEquipment) {
    const related = inspections
      .filter((i) => i.equipmentId === equipmentId)
      .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt));
    const passing = related.filter((i) => i.result === "pass");
    const valid = passing.filter((i) => {
      const ageMin = (startMs - Date.parse(i.checkedAt)) / 60_000;
      return ageMin >= POLICY.inspectionMinLeadMinutes && ageMin <= POLICY.inspectionMaxAgeMinutes;
    });
    const chosen = valid[0];
    if (chosen) {
      const ageMin = (startMs - Date.parse(chosen.checkedAt)) / 60_000;
      minRemaining = Math.min(minRemaining, POLICY.inspectionMaxAgeMinutes - ageMin);
      continue;
    }

    const latestPassing = passing[0];
    if (latestPassing === undefined) {
      if (related.length > 0) {
        problems.push(`设备 ${equipmentId} 最近一次点检未通过`);
        actions.add(`排除设备 ${equipmentId} 故障后重新点检`);
      } else {
        problems.push(`设备 ${equipmentId} 尚未点检`);
        actions.add(
          `在开场前至少 ${POLICY.inspectionMinLeadMinutes} 分钟完成设备 ${equipmentId} 点检`,
        );
      }
      continue;
    }

    const ageMin = (startMs - Date.parse(latestPassing.checkedAt)) / 60_000;
    if (ageMin < 0) {
      problems.push(
        `设备 ${equipmentId} 点检的实际检查时间（${latestPassing.checkedAt}）晚于计划开场时间`,
      );
      actions.add(`在开场前完成设备 ${equipmentId} 点检`);
    } else if (ageMin < POLICY.inspectionMinLeadMinutes) {
      problems.push(
        `设备 ${equipmentId} 点检过晚：实际检查时间距开场仅 ${Math.floor(ageMin)} 分钟，` +
          `不足 ${POLICY.inspectionMinLeadMinutes} 分钟要求`,
      );
      actions.add(`下次提前完成点检；本场可请具备设备检查项权限的复核者评估例外放行`);
    } else {
      problems.push(
        `设备 ${equipmentId} 点检结果已过期：实际检查时间距开场 ${Math.floor(ageMin)} 分钟，` +
          `超过 ${POLICY.inspectionMaxAgeMinutes} 分钟有效期`,
      );
      actions.add(`重新点检设备 ${equipmentId}`);
    }
  }

  if (problems.length > 0) {
    return failOut("equipment", problems.join("；"), problems, [...actions]);
  }
  const margin = minRemaining === Number.POSITIVE_INFINITY ? null : Math.floor(minRemaining);
  return passOut(
    "equipment",
    script.requiredEquipment.length === 0
      ? "脚本无设备点检要求"
      : `全部 ${script.requiredEquipment.length} 台设备点检有效`,
    margin,
  );
}

/** 讲师资质：每项必需资质至少一名已指派讲师持有，且有效期覆盖至场次结束。 */
function checkOperator(input: GateEvaluationInput, endMs: number): CheckerOutput {
  const { script, instructors } = input;
  if (!script) return scriptMissingOut("operator", "讲师资质要求");

  const problems: string[] = [];
  const actions = new Set<string>();
  if (instructors.length === 0) {
    problems.push("尚未指派讲师");
    actions.add("指派至少一名持有必需资质的讲师");
  }

  let minDays = Number.POSITIVE_INFINITY;
  for (const code of script.requiredQualifications) {
    let best: number | null = null;
    for (const instructor of instructors) {
      for (const q of instructor.qualifications) {
        if (q.code !== code) continue;
        const t = Date.parse(q.validUntil);
        if (Number.isNaN(t)) continue;
        if (best === null || t > best) best = t;
      }
    }
    if (best === null) {
      problems.push(`没有已指派讲师持有必需资质 ${code}`);
      actions.add(`指派持有资质 ${code} 的讲师`);
      continue;
    }
    if (best < endMs) {
      problems.push(
        `资质 ${code} 最晚有效至 ${new Date(best).toISOString()}，` +
          `早于场次结束 ${new Date(endMs).toISOString()}`,
      );
      actions.add(`为资质 ${code} 办理续期，或更换持有效资质的讲师`);
      continue;
    }
    minDays = Math.min(minDays, (best - endMs) / 86_400_000);
  }

  if (problems.length > 0) {
    return failOut("operator", problems.join("；"), problems, [...actions]);
  }
  const margin = minDays === Number.POSITIVE_INFINITY ? null : Math.floor(minDays);
  return passOut("operator", `已指派 ${instructors.length} 名讲师，必需资质均有效`, margin);
}

/**
 * 耗材批次：按领用单扫码预留，标签批号与领用单批号一致且批次未隔离
 * 的预留/已消耗数量计入有效量；重复扫码由服务层幂等拦截。
 */
function checkMaterial(input: GateEvaluationInput): CheckerOutput {
  const { script, session, materialEvents, batches, requisitions } = input;
  if (!script) return scriptMissingOut("material", "耗材需求");

  const sessionEvents = materialEvents.filter((e) => e.sessionId === session.id);
  const consumedReservationIds = new Set(
    sessionEvents
      .filter((e) => e.type === "consumed" && e.reservationId !== null)
      .map((e) => e.reservationId),
  );
  const usable = sessionEvents.filter((e) => {
    if (e.type === "consumed") return true;
    if (e.type !== "reserved") return false;
    return !consumedReservationIds.has(e.id);
  });

  const problems: string[] = [];
  const actions = new Set<string>();
  const margins: MaterialMargin[] = [];

  for (const req of script.requiredMaterials) {
    let valid = 0;
    let quarantinedHeld = 0;
    for (const e of usable) {
      const batch = batches.get(e.batchId);
      if (!batch || batch.materialId !== req.materialId) continue;
      if (batch.status !== "available") {
        quarantinedHeld += e.quantity;
        continue;
      }
      if (e.requisitionId !== null) {
        const requisition = requisitions.find((r) => r.id === e.requisitionId);
        if (requisition && requisition.batchNo !== batch.labelBatchNo) continue;
      }
      valid += e.quantity;
    }
    const margin = valid - req.quantity;
    margins.push({
      materialId: req.materialId,
      required: req.quantity,
      reserved: valid,
      margin,
      unit: req.unit,
    });
    if (margin < 0) {
      problems.push(
        `耗材 ${req.materialId} 有效预留 ${valid} ${req.unit}，` +
          `距需求 ${req.quantity} ${req.unit} 尚缺 ${-margin} ${req.unit}`,
      );
      actions.add(`按领用单批号扫码预留足量耗材 ${req.materialId}`);
      actions.add("核对耗材标签批号与领用单批号是否一致");
    }
    if (quarantinedHeld > 0) {
      problems.push(
        `耗材 ${req.materialId} 有 ${quarantinedHeld} ${req.unit} 来自已隔离批次，不计入有效预留`,
      );
      actions.add("更换未隔离批次并重新扫码");
    }
  }

  if (problems.length > 0) {
    return failOut("material", problems.join("；"), problems, [...actions], margins);
  }
  return passOut("material", "耗材预留满足脚本需求", null, margins);
}

/** 场地容量：预计观众不得超过场地容量与脚本上限的较小者。 */
function checkCapacity(input: GateEvaluationInput): CheckerOutput {
  const { session, venue, script } = input;
  if (!venue) {
    return failOut(
      "capacity",
      `场地 ${session.venueId} 不存在`,
      [`场地 ${session.venueId} 不存在`],
      ["核对场次场地信息"],
    );
  }
  const limits = [{ source: "场地容量", value: venue.capacity }];
  if (script) limits.push({ source: "脚本人数上限", value: script.maxAudience });
  const binding = limits.reduce((a, b) => (b.value < a.value ? b : a));
  const margin = binding.value - session.expectedAudience;
  if (margin < 0) {
    return failOut(
      "capacity",
      `预计观众 ${session.expectedAudience} 人超过${binding.source} ${binding.value} 人`,
      [`预计观众 ${session.expectedAudience} 人超过${binding.source} ${binding.value} 人`],
      [`将预计观众人数降至 ${binding.value} 人以内`, "更换更大容量的场地"],
    );
  }
  return passOut(
    "capacity",
    `预计观众 ${session.expectedAudience} 人，容量上限 ${binding.value} 人（${binding.source}）`,
    margin,
  );
}

/** 应急人员：脚本要求的每个岗位到岗人数须达标。 */
function checkEmergencyStaff(input: GateEvaluationInput): CheckerOutput {
  const { script, checkIns } = input;
  if (!script) return scriptMissingOut("emergency_staff", "应急人员要求");

  const problems: string[] = [];
  const actions = new Set<string>();
  let present = 0;
  let required = 0;
  let extra = 0;
  for (const roleReq of script.requiredEmergencyRoles) {
    required += roleReq.count;
    const n = new Set(
      checkIns.filter((c) => c.role === roleReq.role).map((c) => c.staffId),
    ).size;
    present += n;
    extra += Math.max(0, n - roleReq.count);
    if (n < roleReq.count) {
      problems.push(`应急岗位「${roleReq.role}」到岗 ${n}/${roleReq.count} 人`);
      actions.add(`通知「${roleReq.role}」岗位应急人员到岗签到`);
    }
  }

  if (problems.length > 0) {
    return failOut("emergency_staff", problems.join("；"), problems, [...actions]);
  }
  return passOut(
    "emergency_staff",
    script.requiredEmergencyRoles.length === 0
      ? "脚本无应急人员要求"
      : `应急人员到岗满足要求（${present}/${required} 人）`,
    script.requiredEmergencyRoles.length === 0 ? null : extra,
  );
}

/** 评估一个场次的安全闸门。 */
export function evaluateGate(input: GateEvaluationInput): GateReport {
  const { session, now } = input;
  const startMs = Date.parse(session.scheduledStart);
  const durationMs = (input.script?.durationMinutes ?? 0) * 60_000;
  const endMs = startMs + durationMs;
  const countdownSeconds = Math.floor((startMs - now.getTime()) / 1000);

  const scriptOut = checkScript(input);
  const equipmentOut = checkEquipment(input, startMs);
  const operatorOut = checkOperator(input, endMs);
  const materialOut = checkMaterial(input);
  const capacityOut = checkCapacity(input);
  const emergencyOut = checkEmergencyStaff(input);

  const checks = [
    scriptOut.check,
    equipmentOut.check,
    operatorOut.check,
    materialOut.check,
    capacityOut.check,
    emergencyOut.check,
  ];

  // 例外放行：仅对五个检查项生效，脚本版本不可豁免；例外只在有效期内生效。
  const activeExceptions = input.exceptions.filter(
    (e) => Date.parse(e.expiresAt) > now.getTime(),
  );
  for (const check of checks) {
    if (check.status !== "fail" || check.condition === "script") continue;
    const grant = activeExceptions.find((e) => e.checkType === check.condition);
    if (!grant) continue;
    check.status = "waived";
    check.waivedByExceptionId = grant.id;
    check.summary += `（已由复核者 ${grant.reviewerId} 签发的例外 ${grant.id} 豁免）`;
  }

  const blockingReasons: BlockingReason[] = checks
    .filter((c) => c.status === "fail")
    .map((c) => ({
      condition: c.condition,
      conditionLabel: c.conditionLabel,
      summary: c.summary,
      problems: c.problems,
      since: null,
    }));

  const remediableActions: RemediableAction[] = checks
    .filter((c) => c.status === "fail" && c.remediableActions.length > 0)
    .map((c) => ({
      condition: c.condition,
      conditionLabel: c.conditionLabel,
      actions: c.remediableActions,
    }));

  const margins: GateMargins = {
    countdownSeconds,
    capacitySeats: capacityOut.margin,
    materials: materialOut.materialMargins,
    qualificationDays: operatorOut.margin,
    inspectionMinutes: equipmentOut.margin,
    emergencyStaff: emergencyOut.margin,
  };

  return {
    sessionId: session.id,
    evaluatedAt: now.toISOString(),
    decision: blockingReasons.length === 0 ? "go" : "no_go",
    countdownSeconds,
    checks,
    blockingReasons,
    remediableActions,
    margins,
    activeExceptions,
  };
}
