import { createInterface } from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { createMusicBuiltin, type MusicBuiltin } from "./music-builtin.js";

type RpcId = string | number | null;
export interface MusicRpcResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === "object" && !Array.isArray(value);
const rpcError = (id: RpcId, code: number, message: string): MusicRpcResponse => ({
  jsonrpc: "2.0", id, error: { code, message },
});

/** The QQ bot's existing MCP client uses newline JSON-RPC over stdio.
 * Importing this module never opens stdin or starts any network requests. */
export function createMusicRpcHandler(builtin: MusicBuiltin = createMusicBuiltin()) {
  return async (request: unknown): Promise<MusicRpcResponse | undefined> => {
    if (!object(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return rpcError(null, -32600, "Invalid Request");
    }
    // Notifications, including notifications/initialized, have no response.
    if (!Object.hasOwn(request, "id")) return undefined;
    const id = request.id;
    if (id !== null && typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id))) {
      return rpcError(null, -32600, "Invalid Request ID");
    }
    const result = (value: Record<string, unknown>): MusicRpcResponse => ({ jsonrpc: "2.0", id: id as RpcId, result: value });
    if (request.method === "initialize") {
      const requestedVersion = object(request.params) ? request.params.protocolVersion : undefined;
      const supported = ["2024-11-05", "2025-03-26", "2025-06-18"];
      return result({
        protocolVersion: typeof requestedVersion === "string" && supported.includes(requestedVersion)
          ? requestedVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "qq-music", version: "0.1.0" },
      });
    }
    if (request.method === "ping") return result({});
    if (request.method === "tools/list") return result({ tools: builtin.tools });
    if (request.method !== "tools/call") return rpcError(id as RpcId, -32601, "Method not found");

    const params = request.params;
    if (!object(params) || typeof params.name !== "string") return rpcError(id as RpcId, -32602, "Tool name required");
    if (!builtin.tools.some(tool => tool.name === params.name)) return rpcError(id as RpcId, -32602, "Unknown music tool");
    const args = params.arguments ?? {};
    if (!object(args)) return rpcError(id as RpcId, -32602, "Tool arguments must be an object");
    try {
      const text = await builtin.call(params.name, args);
      return result({ content: [{ type: "text", text }] });
    } catch (error) {
      // MCP tool failures are normal results marked isError; never print API
      // responses, credentials or diagnostics to the protocol stdout.
      let message = error instanceof Error ? error.message : "Music lookup failed";
      const clientId = process.env.JAMENDO_CLIENT_ID;
      if (clientId) message = message.replaceAll(clientId, "[redacted]");
      return result({ isError: true, content: [{ type: "text", text: message.slice(0, 300) }] });
    }
  };
}

export async function runMusicServer(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  builtin: MusicBuiltin = createMusicBuiltin(),
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const handle = createMusicRpcHandler(builtin);
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let response: MusicRpcResponse | undefined;
      if (line.length > 65_536) {
        response = rpcError(null, -32600, "Request exceeds size limit");
      } else {
        let request: unknown;
        try { request = JSON.parse(line); }
        catch {
          output.write(JSON.stringify(rpcError(null, -32700, "Parse error")) + "\n");
          continue;
        }
        response = await handle(request);
      }
      if (response) output.write(JSON.stringify(response) + "\n");
    }
  } finally {
    lines.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  runMusicServer().catch(() => {
    process.stderr.write("Music MCP server stopped after an unexpected error.\n");
    process.exitCode = 1;
  });
}
