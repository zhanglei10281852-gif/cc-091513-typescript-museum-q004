import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { ServiceError } from "./errors.js";
import { SafetyGateService } from "./service.js";
import { Store } from "./store.js";

export const serviceName = "科学演示开场安全闸门";

export function healthPayload(): { status: "ok"; service: string } {
  return { status: "ok", service: serviceName };
}

interface HandlerResult {
  status: number;
  body: unknown;
}

interface RequestContext {
  params: Record<string, string>;
  body: unknown;
}

type Handler = (ctx: RequestContext) => HandlerResult | Promise<HandlerResult>;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

function compilePath(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const regex = new RegExp(
    "^" +
      pattern
        .split("/")
        .map((seg) => {
          if (seg.startsWith(":")) {
            keys.push(seg.slice(1));
            return "([^/]+)";
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/") +
      "$",
  );
  return { regex, keys };
}

function ok(body: unknown): HandlerResult {
  return { status: 200, body };
}

function created(body: unknown): HandlerResult {
  return { status: 201, body };
}

function param(params: Record<string, string>, name: string): string {
  const v = params[name];
  if (v === undefined) {
    throw new ServiceError(500, "route_param_missing", `缺少路径参数 ${name}`);
  }
  return decodeURIComponent(v);
}

function buildRoutes(service: SafetyGateService): Route[] {
  const defs: [string, string, Handler][] = [
    ["GET", "/health", () => ok(healthPayload())],

    // 基础档案
    ["POST", "/venues", ({ body }) => created(service.createVenue(body))],
    ["GET", "/venues", () => ok(service.listVenues())],
    ["POST", "/scripts", ({ body }) => created(service.createScript(body))],
    ["POST", "/instructors", ({ body }) => created(service.createInstructor(body))],
    ["POST", "/staff", ({ body }) => created(service.createStaff(body))],
    ["POST", "/reviewers", ({ body }) => created(service.createReviewer(body))],

    // 场次与闸门
    ["POST", "/sessions", ({ body }) => created(service.createSession(body))],
    ["GET", "/sessions", () => ok(service.listSessions())],
    ["GET", "/sessions/:id", ({ params }) => ok(service.getSessionView(param(params, "id")))],
    ["GET", "/sessions/:id/gate", ({ params }) => ok(service.evaluate(param(params, "id")))],
    ["POST", "/sessions/:id/script", ({ params, body }) =>
      ok(service.assignScript(param(params, "id"), body))],
    ["POST", "/sessions/:id/instructors", ({ params, body }) =>
      ok(service.assignInstructor(param(params, "id"), body))],
    ["DELETE", "/sessions/:id/instructors/:instructorId", ({ params }) =>
      ok(service.removeInstructor(param(params, "id"), param(params, "instructorId")))],
    ["POST", "/sessions/:id/audience", ({ params, body }) =>
      ok(service.setAudience(param(params, "id"), body))],
    ["POST", "/sessions/:id/start", ({ params }) => ok(service.startSession(param(params, "id")))],
    ["POST", "/sessions/:id/complete", ({ params }) =>
      ok(service.completeSession(param(params, "id")))],
    ["POST", "/sessions/:id/stop", ({ params, body }) =>
      ok(service.stopSession(param(params, "id"), body))],
    ["POST", "/sessions/:id/reinstate", ({ params, body }) =>
      ok(service.reinstateSession(param(params, "id"), body))],

    // 设备点检（迟到点检按实际检查时间归属）
    ["POST", "/sessions/:id/inspections", ({ params, body }) =>
      created(service.recordInspection(param(params, "id"), body))],

    // 耗材：领用单、批次、扫码（幂等）、隔离
    ["POST", "/sessions/:id/requisitions", ({ params, body }) =>
      created(service.createRequisition(param(params, "id"), body))],
    ["POST", "/sessions/:id/materials/scan", ({ params, body }) =>
      ok(service.scanMaterial(param(params, "id"), body))],
    ["POST", "/materials/batches", ({ body }) => created(service.registerBatch(body))],
    ["GET", "/materials/batches/:id", ({ params }) =>
      ok(service.getBatchView(param(params, "id")))],
    ["POST", "/materials/batches/:id/quarantine", ({ params, body }) =>
      ok(service.quarantineBatch(param(params, "id"), body))],

    // 应急人员与例外放行
    ["POST", "/sessions/:id/emergency-checkins", ({ params, body }) =>
      created(service.checkInEmergency(param(params, "id"), body))],
    ["POST", "/sessions/:id/exceptions", ({ params, body }) =>
      created(service.grantException(param(params, "id"), body))],

    // 事故
    ["POST", "/incidents", ({ body }) => created(service.registerIncident(body))],
    ["GET", "/incidents", () => ok(service.listIncidents())],
    ["GET", "/incidents/:id", ({ params }) => ok(service.getIncident(param(params, "id")))],
    ["POST", "/incidents/:id/confirm", ({ params, body }) =>
      ok(service.confirmIncident(param(params, "id"), body))],
  ];
  return defs.map(([method, pattern, handler]) => ({ method, ...compilePath(pattern), handler }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new ServiceError(413, "payload_too_large", "请求体超过 1MB 上限");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ServiceError(400, "invalid_json", "请求体不是合法 JSON");
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

export function createApp(service?: SafetyGateService): Server {
  const svc = service ?? new SafetyGateService(new Store(null));
  const routes = buildRoutes(svc);
  return createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      let matched: { route: Route; params: Record<string, string> } | null = null;
      for (const route of routes) {
        if (route.method !== method) continue;
        const m = route.regex.exec(path);
        if (!m) continue;
        const params: Record<string, string> = {};
        route.keys.forEach((key, i) => {
          params[key] = m[i + 1] ?? "";
        });
        matched = { route, params };
        break;
      }
      if (!matched) {
        sendJson(res, 404, { error: { code: "not_found", message: "接口不存在" } });
        return;
      }

      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
      const result = await matched.route.handler({ params: matched.params, body });
      sendJson(res, result.status, result.body);
    } catch (error) {
      if (error instanceof ServiceError) {
        sendJson(res, error.status, {
          error: { code: error.code, message: error.message, details: error.details },
        });
        return;
      }
      console.error(error);
      sendJson(res, 500, { error: { code: "internal_error", message: "服务内部错误" } });
    }
  });
}
