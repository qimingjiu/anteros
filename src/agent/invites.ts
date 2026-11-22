/**
 * 邀请码派发（2026-11-11 主人要求：「把这 20 个邀请码给机器人，艾特一个给一个」）。
 * 纯关键词判断，不经模型：@机器人 / 回复机器人 / 私聊里要邀请码 → 发一个未用的码。
 * 一个 QQ 号只给一个；发完回「邀请码发完了」。池子文件原子写入（tmp + rename，0600）。
 * 只在 features.invite_codes: true 且 onebot（QQ）实例里启用，Discord 实例不用。
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";

export const INVITE_SITE = process.env.INVITE_SITE || "";

export interface InviteEntry {
  code: string;
  given_to: string | null;
  group_id: string | null;
  given_at: string | null;
}

export interface InvitePoolFile { codes: InviteEntry[] }

export type InviteResult =
  | { kind: "given"; code: string; reply: string }
  | { kind: "already"; reply: string }
  | { kind: "empty"; reply: string }
  | { kind: "status"; reply: string };

const NON_INVITE_MA = /(密码|二维码|验证码|代码|源码|编码|号码|乱码|条码|扫码|付款码|收款码|健康码|码字|码农|打码|马赛克)/gu;

/** 要邀请码的说法。传入去掉 @ 之后的文字。 */
export function isInviteRequest(raw: string): boolean {
  const t = raw.normalize("NFKC").replace(/\[CQ:[^\]]*\]/g, "").replace(/^(@\S+\s*)+/u, "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "").replace(/\s+/g, "").trim();
  if (!t || t.length > 80) return false;
  if (/(不要|不用|不需要|别给|别发|不想要)/u.test(t)) return false;
  if (/邀请码/u.test(t)) {
    if (/[要给求来发领讨拿]|还有|有没有|需要|吗|么|嘛/u.test(t)) return true;
    return t.replace(/[九阙的个一\p{P}\p{S}]/gu, "").length <= 4; // 光说「邀请码」「九阙邀请码？」
  }
  const rest = t.replace(NON_INVITE_MA, "");
  if (!/码/u.test(rest)) return false;
  if (/九阙/u.test(rest)) return true;
  return /[要给求]/u.test(rest);
}

export class InvitePool {
  constructor(private readonly path: string) {}

  exists(): boolean { return existsSync(this.path); }

  private load(): InvitePoolFile {
    const data = JSON.parse(readFileSync(this.path, "utf8")) as InvitePoolFile;
    if (!data || !Array.isArray(data.codes)) throw new Error("invite pool malformed");
    return data;
  }

  private save(data: InvitePoolFile): void {
    const tmp = `${this.path}.tmp-${process.pid}`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, JSON.stringify(data, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
  }

  remaining(): number { return this.load().codes.filter(c => !c.given_to).length; }

  /** 同步执行（单线程内不会交错），读-改-写一次完成。 */
  claim(userId: string, groupId: string | undefined, now = new Date()): InviteResult {
    const data = this.load();
    if (data.codes.some(c => c.given_to === userId)) return { kind: "already", reply: "你已经领过一个邀请码了，一人一个。" };
    const free = data.codes.find(c => !c.given_to);
    if (!free) return { kind: "empty", reply: "邀请码发完了" };
    free.given_to = userId;
    free.group_id = groupId ?? null;
    free.given_at = now.toISOString();
    this.save(data);
    return { kind: "given", code: free.code, reply: `九阙邀请码：${free.code}，只能注册一次，去 ${INVITE_SITE} 登记。` };
  }
}
