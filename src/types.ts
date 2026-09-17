/**
 * 领域模型与枚举。枚举取值与 reference/domain.json 保持一致。
 */

export const SESSION_STATES = [
  "preparing",
  "blocked",
  "ready",
  "running",
  "stopped",
  "completed",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const CHECK_TYPES = [
  "equipment",
  "operator",
  "material",
  "capacity",
  "emergency_staff",
] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

/** 闸门强制项：五个可例外检查项，外加不可例外的脚本版本项。 */
export const GATE_CONDITIONS = ["script", ...CHECK_TYPES] as const;
export type GateCondition = (typeof GATE_CONDITIONS)[number];

export const MATERIAL_EVENT_TYPES = [
  "received",
  "reserved",
  "consumed",
  "quarantined",
] as const;
export type MaterialEventType = (typeof MATERIAL_EVENT_TYPES)[number];

export const CONDITION_LABELS: Record<GateCondition, string> = {
  script: "演示脚本版本",
  equipment: "设备点检",
  operator: "讲师资质",
  material: "耗材批次",
  capacity: "场地容量",
  emergency_staff: "应急人员到岗",
};

export type Clock = () => Date;

export interface Venue {
  id: string;
  name: string;
  capacity: number;
}

export interface MaterialRequirement {
  materialId: string;
  quantity: number;
  unit: string;
}

export interface EmergencyRoleRequirement {
  role: string;
  count: number;
}

export interface ScriptVersion {
  id: string;
  showId: string;
  version: string;
  status: "approved" | "retired";
  durationMinutes: number;
  requiredEquipment: string[];
  requiredQualifications: string[];
  requiredMaterials: MaterialRequirement[];
  requiredEmergencyRoles: EmergencyRoleRequirement[];
  maxAudience: number;
}

export interface Session {
  id: string;
  showId: string;
  scriptVersionId: string | null;
  venueId: string;
  /** 计划开场时间（ISO 8601），倒计时以此为基准。 */
  scheduledStart: string;
  expectedAudience: number;
  instructorIds: string[];
  status: SessionState;
  /** 各强制项首次判定失效的时间，用于回答“哪项条件最先失效”。 */
  firstFailedAt: Record<string, string>;
  startedAt: string | null;
  completedAt: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
  stopIncidentId: string | null;
  /** 开场后锁定：脚本版本与人员名单不可再改。 */
  lockedScriptVersionId: string | null;
  lockedRoster: string[] | null;
}

export interface EquipmentInspection {
  id: string;
  sessionId: string;
  equipmentId: string;
  result: "pass" | "fail";
  /** 实际检查时间：点检归属与有效性一律以此为准。 */
  checkedAt: string;
  /** 系统登记时间；补录不改变判定点。 */
  recordedAt: string;
  inspectorId: string;
  notes: string | null;
}

export interface Qualification {
  code: string;
  validUntil: string;
}

export interface Instructor {
  id: string;
  name: string;
  qualifications: Qualification[];
}

export interface StaffMember {
  id: string;
  name: string;
  roles: string[];
}

export interface Reviewer {
  id: string;
  name: string;
  /** 该复核者有权例外放行的检查项。 */
  permissions: CheckType[];
}

export interface Requisition {
  id: string;
  sessionId: string;
  materialId: string;
  /** 领用单批号：扫码耗材的标签批号必须与之保持一致。 */
  batchNo: string;
  quantity: number;
  createdAt: string;
}

export interface MaterialBatch {
  id: string;
  materialId: string;
  /** 耗材标签上的批号。 */
  labelBatchNo: string;
  unit: string;
  status: "available" | "quarantined";
  receivedQuantity: number;
  quarantineReason: string | null;
}

export interface MaterialEvent {
  id: string;
  type: MaterialEventType;
  batchId: string;
  sessionId: string | null;
  requisitionId: string | null;
  /** consumed 事件对应的 reserved 事件 id，保证一次预留只消耗一次。 */
  reservationId: string | null;
  quantity: number;
  /** 扫码幂等键：重复扫码不重复登记、不重复消耗。 */
  scanCode: string | null;
  at: string;
}

export interface EmergencyCheckIn {
  id: string;
  sessionId: string;
  staffId: string;
  role: string;
  checkedInAt: string;
}

export interface ExceptionGrant {
  id: string;
  sessionId: string;
  checkType: CheckType;
  reviewerId: string;
  reason: string;
  createdAt: string;
  /** 例外有效期，默认至场次结束。 */
  expiresAt: string;
}

export interface GateCheckResult {
  condition: GateCondition;
  conditionLabel: string;
  status: "pass" | "fail" | "waived";
  summary: string;
  problems: string[];
  remediableActions: string[];
  waivedByExceptionId: string | null;
}

export interface MaterialMargin {
  materialId: string;
  required: number;
  reserved: number;
  margin: number;
  unit: string;
}

/** 实际余量：各项强制项距离失效边界的富余量。 */
export interface GateMargins {
  countdownSeconds: number;
  capacitySeats: number | null;
  materials: MaterialMargin[];
  qualificationDays: number | null;
  inspectionMinutes: number | null;
  emergencyStaff: number | null;
}

export interface BlockingReason {
  condition: GateCondition;
  conditionLabel: string;
  summary: string;
  problems: string[];
  /** 该条件首次失效时间（按失效先后排序）。 */
  since: string | null;
}

export interface RemediableAction {
  condition: GateCondition;
  conditionLabel: string;
  actions: string[];
}

export interface GateReport {
  sessionId: string;
  evaluatedAt: string;
  decision: "go" | "no_go";
  /** 距计划开场的秒数，负值表示已超过开场时间。 */
  countdownSeconds: number;
  checks: GateCheckResult[];
  blockingReasons: BlockingReason[];
  remediableActions: RemediableAction[];
  margins: GateMargins;
  activeExceptions: ExceptionGrant[];
}

/** 事故登记时保全的原始记录。 */
export interface IncidentSnapshot {
  session: Session;
  gateReport: GateReport;
  inspections: EquipmentInspection[];
  materialEvents: MaterialEvent[];
  exceptions: ExceptionGrant[];
}

export interface Incident {
  id: string;
  sessionId: string;
  venueId: string;
  description: string;
  occurredAt: string;
  registeredAt: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
  /** 因本事故被停止的后续场次。 */
  affectedSessionIds: string[];
  snapshot: IncidentSnapshot;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  entityId: string;
  details: Record<string, unknown>;
}
