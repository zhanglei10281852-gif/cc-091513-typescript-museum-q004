import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { emptyState, type State } from "./types.js";
import type { Clock } from "./clock.js";

/** 审计事件：只增不改，事故等关键动作的原始凭据。 */
export interface AuditEvent {
  at: string;
  action: string;
  actor?: string | undefined;
  sessionId?: string | undefined;
  detail: unknown;
}

/**
 * JSON 快照 + JSONL 审计日志。
 * 快照通过临时文件 rename 原子落盘；进程重启后从快照恢复，
 * 倒计时、停用状态、未确认事故均按快照中的时点继续。
 */
export class Store {
  readonly path: string;
  readonly auditPath: string;
  private readonly clock: Clock;

  constructor(path: string, clock: Clock) {
    this.path = path;
    this.clock = clock;
    this.auditPath = join(dirname(path), "audit.log");
  }

  load(): State {
    if (!existsSync(this.path)) return emptyState();
    const raw = readFileSync(this.path, "utf8");
    if (raw.trim() === "") return emptyState();
    const parsed = JSON.parse(raw) as State;
    return { ...emptyState(), ...parsed };
  }

  save(state: State): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, this.path);
  }

  audit(action: string, detail: unknown, actor?: string, sessionId?: string): void {
    mkdirSync(dirname(this.auditPath), { recursive: true });
    const event: AuditEvent = {
      at: this.clock.now().toISOString(),
      action,
      ...(actor !== undefined ? { actor } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      detail,
    };
    appendFileSync(this.auditPath, `${JSON.stringify(event)}\n`);
  }
}
