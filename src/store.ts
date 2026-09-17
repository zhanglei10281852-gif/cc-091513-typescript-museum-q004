/**
 * 持久化存储：全部状态保存在单个 JSON 文件中，原子写入。
 * 倒计时、停用状态、未确认事故均由持久化的时间戳与状态推导，
 * 进程重启后按原时点继续推进。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  AuditEntry,
  EmergencyCheckIn,
  EquipmentInspection,
  ExceptionGrant,
  Incident,
  Instructor,
  MaterialBatch,
  MaterialEvent,
  Requisition,
  Reviewer,
  ScriptVersion,
  Session,
  StaffMember,
  Venue,
} from "./types.js";

export interface State {
  venues: Record<string, Venue>;
  scripts: Record<string, ScriptVersion>;
  instructors: Record<string, Instructor>;
  staff: Record<string, StaffMember>;
  reviewers: Record<string, Reviewer>;
  sessions: Record<string, Session>;
  inspections: Record<string, EquipmentInspection>;
  requisitions: Record<string, Requisition>;
  batches: Record<string, MaterialBatch>;
  materialEvents: Record<string, MaterialEvent>;
  /** 扫码幂等键 → 耗材事件 id。 */
  scanIndex: Record<string, string>;
  checkIns: Record<string, EmergencyCheckIn>;
  exceptions: Record<string, ExceptionGrant>;
  incidents: Record<string, Incident>;
  audit: AuditEntry[];
}

export function emptyState(): State {
  return {
    venues: {},
    scripts: {},
    instructors: {},
    staff: {},
    reviewers: {},
    sessions: {},
    inspections: {},
    requisitions: {},
    batches: {},
    materialEvents: {},
    scanIndex: {},
    checkIns: {},
    exceptions: {},
    incidents: {},
    audit: [],
  };
}

export class Store {
  readonly filePath: string | null;
  state: State;

  /**
   * @param dir 状态目录；传 null 表示纯内存（测试用）。
   */
  constructor(dir: string | null) {
    this.filePath = dir === null ? null : join(dir, "state.json");
    if (this.filePath !== null && existsSync(this.filePath)) {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<State>;
      this.state = { ...emptyState(), ...parsed };
    } else {
      this.state = emptyState();
    }
  }

  save(): void {
    if (this.filePath === null) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.filePath);
  }
}
