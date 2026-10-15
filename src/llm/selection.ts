import type { ModelSwitcher } from "./switcher.js";

interface SelectionSession {
  provider?: string;
  touchedAt: number;
}

/** 管理员私聊菜单由本地处理，不依赖当前模型或 function calling。 */
export class ModelSelection {
  private sessions = new Map<string, SelectionSession>();
  constructor(private switcher: ModelSwitcher, private now = () => Date.now()) {}

  start(owner: string): string {
    this.sessions.set(owner, { touchedAt: this.now() });
    return this.switcher.listProviders();
  }

  handle(owner: string, input: string): string | null {
    const text = input.trim().replace(/[。！？!?]+$/, "").trim();
    const start = /^(?:(?:我)?(?:想|要|想要)|请|帮我|给我)?\s*(?:换(?:个|一下)?模型|更换模型|切换模型|列出(?:可用的?|所有)?模型|查看(?:可用的?)?模型|模型列表|模型商|\/模型|\/换模型|\/models?)(?:\s.*)?$/i;
    if (start.test(text)) {
      return this.start(owner);
    }
    let session = this.sessions.get(owner);
    if (session && this.now() - session.touchedAt > 10 * 60_000) {
      this.sessions.delete(owner);
      session = undefined;
    }
    if (!session) {
      return /^(?:请|帮我)?\s*(?:换成|切换到|换到)\s*\S+/i.test(text) ? this.start(owner) : null;
    }
    // 菜单期间仍能查询状态、帮助或处理其他指令。
    if (text.startsWith("/") && text !== "/取消") return null;
    if (/^(?:取消|算了|退出|\/取消)$/i.test(text)) {
      this.sessions.delete(owner);
      return `已取消，当前仍是 ${this.switcher.activeDisplayName()}。`;
    }
    if (/^(?:返回|上一步|返回模型商|换模型商)$/i.test(text)) return this.start(owner);
    if (/^(?:列表|重列|再列一次)$/i.test(text)) {
      session.touchedAt = this.now();
      return session.provider ? this.switcher.list(session.provider) : this.switcher.listProviders();
    }
    const choice = text.replace(/^(?:我选|选择|选|用|换成|切换到|换到)\s*/i, "").trim();
    const index = /^\d+$/.test(choice) ? Number(choice) - 1 : undefined;
    if (!session.provider) {
      const providers = this.switcher.providerNames();
      const provider = index === undefined
        ? providers.find(p => p.toLowerCase() === choice.toLowerCase())
        : providers[index];
      if (!provider) {
        if (!/^[\w./-]+$/.test(choice) && choice === text) return null;
        return `没有这个模型商，请回复列表中的编号或名称。\n\n${this.switcher.listProviders()}`;
      }
      session.provider = provider;
      session.touchedAt = this.now();
      return this.switcher.list(provider);
    }
    // 允许在选模型时直接改选另一个模型商，但不能跨商按同名模型切换。
    const otherProvider = this.switcher.providerNames().find(p => p.toLowerCase() === choice.toLowerCase());
    if (otherProvider) {
      session.provider = otherProvider;
      session.touchedAt = this.now();
      return this.switcher.list(otherProvider);
    }
    const models = this.switcher.modelsFor(session.provider);
    const matches = index === undefined
      ? models.filter(p => [p.name, p.model, p.displayName].some(v => v?.toLowerCase() === choice.toLowerCase()))
      : (models[index] ? [models[index]!] : []);
    if (matches.length !== 1) {
      return `请从 ${session.provider} 的列表中选择具体模型，回复编号或完整名称。\n\n${this.switcher.list(session.provider)}`;
    }
    session.touchedAt = this.now();
    const result = this.switcher.switchTo(matches[0]!.name);
    if (result.ok) this.sessions.delete(owner);
    return result.message;
  }
}
