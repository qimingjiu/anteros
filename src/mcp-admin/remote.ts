import dns from "node:dns";
import net from "node:net";
import { Agent as HttpAgent } from "undici";
import { isPrivateAddress } from "../tools/web-http.js";

export function validateManagedMcpUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("远程 MCP 地址必须是公开 HTTPS URL"); }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const isIp = net.isIP(host) !== 0;
  if (value.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.port || url.hash
    || (isIp ? isPrivateAddress(host) : !host.includes(".") || /\.(?:local|internal|localhost)$/i.test(host))
    || [...url.searchParams.keys()].some(key => /token|key|auth|secret|pass|credential|signature/i.test(key))) {
    throw new Error("远程 MCP 地址必须是公开 HTTPS URL，凭据通过请求头引用");
  }
  return url;
}

/** Each managed request resolves again and uses only its checked public addresses. */
export async function openManagedMcpResponse(value: string, init: RequestInit): Promise<{
  response: Response; close(): Promise<void>;
}> {
  const url = validateManagedMcpUrl(value);
  const records = await dns.promises.lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true, verbatim: true });
  init.signal?.throwIfAborted();
  if (!records.length || records.some(record => isPrivateAddress(record.address))) throw new Error("远程 MCP 解析到非公开地址");
  const lookup = ((_host: string, options: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) => {
    const allowed = records.filter(record => !options.family || record.family === options.family);
    if (options.all) callback(null, allowed);
    else if (allowed[0]) callback(null, allowed[0].address, allowed[0].family);
    else callback(new Error("远程 MCP 没有有效公开地址"));
  }) as typeof dns.lookup;
  const dispatcher = new HttpAgent({ connect: { lookup, timeout: 10_000 } });
  try {
    const response = await fetch(url, { ...init, redirect: "error", dispatcher } as RequestInit);
    return { response, close: () => dispatcher.destroy() };
  } catch (error) {
    await dispatcher.destroy();
    throw error;
  }
}
