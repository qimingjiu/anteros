import type { AppConfig } from "./config.js";
import type { Database } from "./db/index.js";
import { DiscordProvider } from "./discord/provider.js";
import { OneBotProvider } from "./onebot/provider.js";
import { TelegramProvider } from "./telegram/provider.js";
import type { Provider } from "./types.js";

export function configuredAccounts(primary: AppConfig): AppConfig[] {
  return [primary, ...(primary.gateway.additionalAccounts ?? []).map(account => ({
    ...primary,
    persona: { ...primary.persona },
    gateway: {
      provider: account.provider,
      accountId: account.accountId,
      discord: account.provider === "discord" ? { tokenEnv: account.tokenEnv, token: account.token } : undefined,
      telegram: account.provider === "telegram" ? { tokenEnv: account.tokenEnv, token: account.token } : undefined,
      onebot: account.provider === "onebot" ? {
        ...primary.gateway.onebot, endpoint: account.endpoint!, tokenEnv: account.tokenEnv, accessToken: account.token,
      } : primary.gateway.onebot,
    },
    admins: [account.ownerId],
    tools: { ...primary.tools, ownerIds: [account.ownerId] },
    groups: {
      ...primary.groups,
      allowlist: account.groups,
      mentionOnly: account.mentionOnly,
      ownerOnlySearch: [],
      ownerPresentOnly: [],
      conversation: primary.groups.conversation && { ...primary.groups.conversation, ownerWakeAliases: [] },
    },
    reports: { ...primary.reports, enabled: false, groups: [], recipientIds: [] },
    proactive: primary.proactive && { ...primary.proactive, enabled: false },
    presence: primary.presence && { ...primary.presence, enabled: false },
  }))];
}

export function createPlatformProvider(config: AppConfig, db: Database, legacyDiscordAutoAllow = true): Provider {
  const gateway = config.gateway;
  const ownerIds = config.tools.ownerIds ?? config.admins;
  if (gateway.provider === "discord") {
    if (!gateway.discord?.token) throw new Error(`请设置 Discord 凭据环境变量 ${gateway.discord?.tokenEnv ?? "DISCORD_BOT_TOKEN"}`);
    return new DiscordProvider({ accountId: gateway.accountId, token: gateway.discord.token,
      autoAllow: legacyDiscordAutoAllow ? { ownerIds, allowlist: config.groups.allowlist } : undefined });
  }
  if (gateway.provider === "telegram") {
    if (!gateway.telegram?.token) throw new Error(`请设置 Telegram 凭据环境变量 ${gateway.telegram?.tokenEnv ?? "TELEGRAM_BOT_TOKEN"}`);
    const key = `telegram:offset:${gateway.accountId}`;
    return new TelegramProvider({
      accountId: gateway.accountId,
      token: gateway.telegram.token,
      ownerIds,
      groupAllowlist: config.groups.allowlist,
      offsetStore: {
        load: () => {
          try { return JSON.parse(db.kvGet(key) ?? "null") ?? undefined; }
          catch { return undefined; }
        },
        save: value => db.kvSet(key, JSON.stringify(value)),
      },
    });
  }
  const onebot = gateway.onebot;
  return new OneBotProvider({
    accountId: gateway.accountId,
    endpoint: onebot.endpoint,
    accessToken: onebot.accessToken,
    reconnectBaseMs: onebot.reconnectBaseMs,
    reconnectMaxMs: onebot.reconnectMaxMs,
    heartbeatTimeoutFactor: onebot.heartbeatTimeoutFactor,
    requestTimeoutMs: onebot.requestTimeoutMs,
    privateFileAction: onebot.privateFileAction,
    groupFileAction: onebot.groupFileAction,
    historyAction: onebot.historyAction,
  });
}
