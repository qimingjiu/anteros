import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ConflictingFamilyEvent } from "./scheduler.js";

export interface ExternalSignal {
  id: string;
  name: string;
  data: Record<string, string>;
}

const namePattern = /^[\p{L}\p{N}][\p{L}\p{N}._:/-]{0,99}$/u;

export function signalName(input: unknown): string {
  if (typeof input !== "string" || !namePattern.test(input)) throw new Error("事件名称应为 1 到 100 个字母、数字或 ._:/-。");
  return input;
}

export function signalData(input: unknown): Record<string, string> {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("事件数据必须是字符串字段的对象。");
  const entries = Object.entries(input);
  if (entries.length > 20 || entries.some(([key, value]) => !/^[a-z][a-z0-9_-]{0,39}$/iu.test(key)
    || typeof value !== "string" || value.length > 500 || /[\x00-\x1f\x7f]/u.test(value))) {
    throw new Error("事件数据最多 20 个字段，每个值最多 500 字。");
  }
  return Object.fromEntries(entries);
}

interface SignalOptions {
  token: string;
  resolveRoom: (room: string | undefined) => string | undefined;
  dispatch: (room: string, signal: ExternalSignal) => { duplicate: boolean; notified: number };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export async function serveFamilySignals(
  request: IncomingMessage, response: ServerResponse, url: URL, options: SignalOptions,
): Promise<boolean> {
  if (url.pathname !== "/api/family/signals") return false;
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    json(response, 405, { error: "事件入口只接受 POST。" });
    return true;
  }
  const authorization = request.headers.authorization ?? "";
  if (!options.token || !authorization.startsWith("Bearer ")
    || !timingSafeEqual(digest(authorization.slice(7)), digest(options.token))) {
    request.resume();
    json(response, 401, { error: "需要有效的事件令牌。" });
    return true;
  }
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")) {
    request.resume();
    json(response, 415, { error: "请发送 JSON。" });
    return true;
  }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    // Keep the connection available to send a 413 response if the limit is exceeded.
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 16_384) {
        request.resume();
        json(response, 413, { error: "事件请求超过 16 KiB。" });
        return true;
      }
      chunks.push(bytes);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<ExternalSignal> & { room?: string };
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !["id", "name", "room", "data"].includes(key))
      || typeof input.id !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(input.id)
      || (input.room !== undefined && (typeof input.room !== "string" || input.room.length > 150))) {
      throw new Error("请提供事件 id、name 和可选的 room、data。");
    }
    const room = options.resolveRoom(input.room);
    if (!room) {
      json(response, 404, { error: "找不到事件房间。" });
      return true;
    }
    json(response, 202, options.dispatch(room, { id: input.id, name: signalName(input.name), data: signalData(input.data) }));
  } catch (error) {
    if (!response.destroyed && !response.writableEnded) {
      const conflict = error instanceof ConflictingFamilyEvent;
      json(response, conflict ? 409 : 400, { error: conflict ? error.message : "事件格式无效或暂时无法登记。" });
    }
  }
  return true;
}
