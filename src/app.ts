import { resolve } from "node:path";

import { SystemClock } from "./domain/clock.js";
import { createHttpApp } from "./domain/http.js";
import { SafetyGateService } from "./domain/service.js";
import { Store } from "./domain/store.js";
import type { Server } from "node:http";

export const serviceName = "科学演示开场安全闸门";

export const runtimeDir = process.env.RUNTIME_DIR ?? resolve(process.cwd(), ".runtime");

export function healthPayload(): { status: "ok"; service: string } {
  return { status: "ok", service: serviceName };
}

/** 装配持久化服务；快照损坏时抛出，避免带着被污染的状态运行。 */
export function createService(path: string = resolve(runtimeDir, "state.json")): SafetyGateService {
  const clock = new SystemClock();
  const store = new Store(path, clock);
  return new SafetyGateService(store, clock);
}

export function createApp(path?: string): Server {
  return createHttpApp(createService(path));
}
