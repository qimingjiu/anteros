export const crossPlatformKinds = ["text", "file", "image", "voice"] as const;
export type CrossPlatformKind = typeof crossPlatformKinds[number];

export interface CrossPlatformDestination {
  id: string;
  aliases: string[];
  accountId: string;
  conversationType: "group" | "private";
  targetId: string;
  capabilities: CrossPlatformKind[];
  maxFileBytes: number;
}

export interface CrossPlatformConfig {
  destinations: CrossPlatformDestination[];
}

const currentConversationNames = new Set(["current", "private", "me", "here", "我", "主人", "这里", "当前", "群", "群里", "私聊"]);

export function normalizeAlias(alias: string): string {
  return alias.trim().normalize("NFKC").toLowerCase().replace(/\s+/gu, " ");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseCrossPlatformConfig(value: unknown): CrossPlatformConfig {
  if (value === undefined) return { destinations: [] };
  if (!isObject(value) || Object.keys(value).some(key => key !== "destinations")) {
    throw new Error("配置错误: cross_platform 只接受 destinations");
  }
  const raw = value.destinations ?? [];
  if (!Array.isArray(raw) || raw.length > 100) {
    throw new Error("配置错误: cross_platform.destinations 必须是最多 100 项的列表");
  }

  const names = new Set<string>();
  const destinations: CrossPlatformDestination[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) throw new Error("配置错误: cross_platform 目的地需要是对象");
    const fields = ["id", "aliases", "account_id", "conversation_type", "target_id", "capabilities", "max_file_bytes"];
    if (Object.keys(entry).some(key => !fields.includes(key))) {
      throw new Error("配置错误: cross_platform 目的地包含未知字段");
    }
    const id = entry.id;
    const accountId = entry.account_id;
    const targetId = entry.target_id;
    const conversationType = entry.conversation_type;
    const aliases = entry.aliases ?? [];
    const capabilities = entry.capabilities ?? [...crossPlatformKinds];
    const maxFileBytes = entry.max_file_bytes ?? 8 * 1024 * 1024;

    if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/u.test(id)
      || typeof accountId !== "string" || !accountId.trim() || accountId.length > 100
      || typeof targetId !== "string" || !targetId || targetId.length > 64
      || (conversationType !== "group" && conversationType !== "private")) {
      throw new Error("配置错误: cross_platform 目的地需要有效的 id、account_id、conversation_type 和字符串 target_id");
    }
    if (!Array.isArray(aliases) || aliases.length > 20 || aliases.some(alias =>
      typeof alias !== "string" || !/^[\p{L}\p{N}_-]+(?: [\p{L}\p{N}_-]+)*$/u.test(normalizeAlias(alias)) || alias.length > 40)) {
      throw new Error(`配置错误: cross_platform 目的地 ${id} 的 aliases 无效`);
    }
    if (!Array.isArray(capabilities) || !capabilities.length
      || capabilities.some(capability => !crossPlatformKinds.includes(capability))
      || typeof maxFileBytes !== "number" || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 25 * 1024 * 1024) {
      throw new Error(`配置错误: cross_platform 目的地 ${id} 的能力或文件大小限制无效`);
    }
    const destinationNames = new Set([id, ...aliases.map(normalizeAlias)]);
    for (const name of destinationNames) {
      if (currentConversationNames.has(name)) throw new Error(`配置错误: ${name} 指当前会话或请求者，请选择唯一的跨端别名`);
      if (names.has(name)) throw new Error(`配置错误: cross_platform 目的地名称 ${name} 重复`);
      names.add(name);
    }
    destinations.push({
      id,
      aliases: [...destinationNames].filter(name => name !== id),
      accountId,
      conversationType,
      targetId,
      capabilities: [...new Set(capabilities)],
      maxFileBytes,
    });
  }
  return { destinations };
}
