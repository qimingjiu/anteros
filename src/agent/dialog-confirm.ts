// 2026-11-17 主人：确认类问题走手机 termux 弹窗；弹窗点「是」等同于她在聊天里说「去发/可以」。
// 只记在内存里，按会话+请求人区分，3 分钟内有效，用一次就作废。
type Ctx = { accountId: string; groupId?: string; requesterId?: string; isPrivate: boolean };
const yes = new Map<string, { at: number; hint: string }>();
export const dialogKey = (c: Ctx) => `${c.accountId}|${c.isPrivate ? "p" : "g"}|${c.groupId ?? ""}|${c.requesterId ?? ""}`;
export function noteDialogResult(c: Ctx, args: Record<string, unknown>, output: string): void {
  if (args?.widget !== "confirm") return;
  const k = dialogKey(c);
  if (/"confirmed"\s*:\s*true/.test(output)) yes.set(k, { at: Date.now(), hint: `${String(args.title ?? "")}\n${String(args.hint ?? "")}` });
  else yes.delete(k);
}
export function takeDialogYes(c: Ctx, maxAgeMs = 180_000): { hint: string } | undefined {
  const k = dialogKey(c), v = yes.get(k);
  if (!v) return undefined;
  yes.delete(k);
  return Date.now() - v.at <= maxAgeMs ? { hint: v.hint } : undefined;
}
