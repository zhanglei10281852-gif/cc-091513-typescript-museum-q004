import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { SafetyGateService } from "./service.js";
import { isDomainError } from "./errors.js";

interface Route {
  method: string;
  pattern: RegExp;
  handler: (params: Record<string, string>, body: Record<string, unknown>, query: URLSearchParams) => unknown;
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new Error("请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw === "") {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new Error("请求体必须是 JSON 对象"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

export function createHttpApp(service: SafetyGateService): Server {
  const routes: Route[] = [
    {
      method: "POST",
      pattern: /^\/reference$/,
      handler: (_p, body) => service.upsertReference(body),
    },
    {
      method: "POST",
      pattern: /^\/batches$/,
      handler: (_p, body) => service.receiveBatch(body),
    },
    {
      method: "POST",
      pattern: /^\/batches\/([^/]+)\/quarantine$/,
      handler: (p, body) => service.quarantineBatch(p.id!, body),
    },
    {
      method: "POST",
      pattern: /^\/batches\/([^/]+)\/events$/,
      handler: (p, body) => service.recordMaterialEvent(p.id!, body),
    },
    {
      method: "GET",
      pattern: /^\/sessions$/,
      handler: () => service.getState().sessions,
    },
    {
      method: "POST",
      pattern: /^\/sessions$/,
      handler: (_p, body) => service.createSession(body),
    },
    {
      method: "GET",
      pattern: /^\/sessions\/([^/]+)$/,
      handler: (p, _b, q) => service.sessionDetail(p.id!),
    },
    {
      method: "GET",
      pattern: /^\/sessions\/([^/]+)\/gate$/,
      handler: (p, _b, q) => service.evaluate(p.id!, q.get("at") ?? undefined),
    },
    {
      method: "POST",
      pattern: /^\/sessions\/([^/]+)\/equipment-checks$/,
      handler: (p, body) => service.recordEquipmentCheck(p.id!, body),
    },
    {
      method: "POST",
      pattern: /^\/sessions\/([^/]+)\/attendance$/,
      handler: (p, body) => service.recordAttendance(p.id!, body),
    },
    {
      method: "POST",
      pattern: /^\/sessions\/([^/]+)\/arrivals$/,
      handler: (p, body) => service.recordArrival(p.id!, body),
    },
    {
      method: "POST",
      pattern: /^\/sessions\/([^/]+)\/scans$/,
      handler: (p, body) => service.scanMaterial(p.id!, body),
    },
    {
      method: "POST",
      pattern: /^\/sessions\/([^/]+)\/exceptions$/,
      handler: (p, body) => service.grantException(p.id!, body),
    },
    {
      method: "POST",
      pattern: /^\/sessions\/([^/]+)\/start$/,
      handler: (p, body) => service.start(p.id!, body),
    },
    {
      method: "POST",
      pattern: /^\/sessions\/([^/]+)\/complete$/,
      handler: (p, body) => service.complete(p.id!, body),
    },
    {
      method: "POST",
      pattern: /^\/sessions\/([^/]+)\/incidents$/,
      handler: (p, body) => service.registerIncident(p.id!, body),
    },
    {
      method: "GET",
      pattern: /^\/incidents$/,
      handler: () => service.getState().incidents,
    },
    {
      method: "POST",
      pattern: /^\/incidents\/([^/]+)\/confirm$/,
      handler: (p, body) => service.confirmIncident(p.id!, body),
    },
    {
      method: "POST",
      pattern: /^\/incidents\/([^/]+)\/resolve$/,
      handler: (p, body) => service.resolveIncident(p.id!, body),
    },
  ];

  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, payload: unknown): void => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(payload));
    };

    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        send(200, { status: "ok", service: "科学演示开场安全闸门" });
        return;
      }

      const body = request.method === "POST" ? await readBody(request) : {};
      for (const route of routes) {
        if (route.method !== request.method) continue;
        const match = url.pathname.match(route.pattern);
        if (!match) continue;
        const params: Record<string, string> = {};
        if (match[1] !== undefined) params.id = match[1];
        send(200, route.handler(params, body, url.searchParams));
        return;
      }
      send(404, { error: "not_found" });
    } catch (error) {
      if (isDomainError(error)) {
        send(error.statusCode, { error: error.code, message: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : "内部错误";
      send(400, { error: "bad_request", message });
    }
  });
}
