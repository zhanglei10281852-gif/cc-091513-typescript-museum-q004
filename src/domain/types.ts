/**
 * 安全闸门领域模型。
 * 所有时间均使用 ISO-8601 字符串（UTC）持久化，评估时再换算为毫秒比较。
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

/** 六类强制闸门项；incident / session 为系统级阻断，不在可授予例外的范围内。 */
export const CHECK_ITEMS = [
  "script",
  "equipment",
  "operator",
  "material",
  "capacity",
  "emergency_staff",
] as const;
export type CheckItem = (typeof CHECK_ITEMS)[number];

export const MATERIAL_EVENTS = [
  "received",
  "reserved",
  "consumed",
  "quarantined",
] as const;
export type MaterialEventType = (typeof MATERIAL_EVENTS)[number];

export interface Script {
  id: string;
  version: string;
  title: string;
  approved: boolean;
}

export interface Qualification {
  /** 资质类型，如 liquid_nitrogen（液氮演示） */
  type: string;
  name: string;
  validFrom: string;
  validUntil: string;
}

export interface Presenter {
  id: string;
  name: string;
  qualifications: Qualification[];
}

export interface Venue {
  id: string;
  name: string;
  capacity: number;
}

export interface Equipment {
  id: string;
  name: string;
}

export interface MaterialDef {
  id: string;
  name: string;
  unit: string;
}

export interface Batch {
  id: string;
  materialId: string;
  /** 当前库存（received 累计减去 consumed），隔离批次保留数量但不可使用。 */
  quantity: number;
  receivedAt: string;
  expiresAt?: string | undefined;
  quarantined: boolean;
}

export interface Reviewer {
  id: string;
  name: string;
  /** 如 waive:equipment、waive:any、incident:resolve */
  permissions: string[];
}

export interface MaterialLine {
  materialId: string;
  /** 领用单上登记的批号，现场扫码批号必须与其一致。 */
  expectedBatchId: string;
  quantity: number;
}

export interface SessionStopReason {
  code: string;
  incidentId?: string | undefined;
  at: string;
}

export interface LockedStaff {
  personId: string;
  name: string;
  arrivedAt: string;
}

export interface SessionLock {
  lockedAt: string;
  scriptId: string;
  scriptVersion: string;
  presenterId: string;
  staff: LockedStaff[];
}

export interface Session {
  id: string;
  title: string;
  scriptId: string;
  scriptVersion: string;
  venueId: string;
  presenterId: string;
  requiredQualification: string;
  equipmentIds: string[];
  materials: MaterialLine[];
  emergencyStaffRequired: number;
  scheduledStart: string;
  scheduledEnd: string;
  /** 设备点检与应急人员到岗的共同截止时间（开场前 leadMinutes 分钟）。 */
  checkDeadline: string;
  state: SessionState;
  createdAt: string;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  suspendedByIncidentId?: string | undefined;
  stopReason?: SessionStopReason | undefined;
  lock?: SessionLock | undefined;
}

export interface EquipmentCheck {
  id: string;
  sessionId: string;
  equipmentId: string;
  ok: boolean;
  /** 实际检查时间——迟到点检按此时间归属，而非登记时间。 */
  checkedAt: string;
  checkedBy: string;
  note?: string | undefined;
  recordedAt: string;
}

export interface AttendanceCount {
  id: string;
  sessionId: string;
  count: number;
  countedAt: string;
}

export interface EmergencyArrival {
  id: string;
  sessionId: string;
  personId: string;
  name: string;
  arrivedAt: string;
}

export interface MaterialScan {
  id: string;
  /** 扫码设备/二维码自带的幂等键，重复扫码返回原记录且不重复消耗。 */
  scanId: string;
  sessionId: string;
  materialId: string;
  batchId: string;
  quantity: number;
  scannedAt: string;
  scannedBy: string;
}

export interface MaterialEvent {
  id: string;
  type: MaterialEventType;
  materialId: string;
  batchId: string;
  quantity: number;
  at: string;
  ref?: string | undefined;
}

export interface ExceptionRecord {
  id: string;
  sessionId: string;
  item: CheckItem;
  /** 限定阻断码；省略表示覆盖该场次该项下的全部阻断。 */
  code?: string | undefined;
  reason: string;
  reviewerId: string;
  grantedAt: string;
  expiresAt?: string | undefined;
}

export interface Incident {
  id: string;
  sessionId: string;
  description: string;
  registeredAt: string;
  registeredBy: string;
  confirmedAt?: string | undefined;
  confirmedBy?: string | undefined;
  resolvedAt?: string | undefined;
  resolvedBy?: string | undefined;
  resolutionNote?: string | undefined;
}

export interface State {
  version: 1;
  scripts: Script[];
  presenters: Presenter[];
  venues: Venue[];
  equipment: Equipment[];
  materials: MaterialDef[];
  batches: Batch[];
  reviewers: Reviewer[];
  sessions: Session[];
  equipmentChecks: EquipmentCheck[];
  attendanceCounts: AttendanceCount[];
  arrivals: EmergencyArrival[];
  scans: MaterialScan[];
  materialEvents: MaterialEvent[];
  exceptions: ExceptionRecord[];
  incidents: Incident[];
}

export function emptyState(): State {
  return {
    version: 1,
    scripts: [],
    presenters: [],
    venues: [],
    equipment: [],
    materials: [],
    batches: [],
    reviewers: [],
    sessions: [],
    equipmentChecks: [],
    attendanceCounts: [],
    arrivals: [],
    scans: [],
    materialEvents: [],
    exceptions: [],
    incidents: [],
  };
}
