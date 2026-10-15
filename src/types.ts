/** 核心数据类型。QQ 号与平台消息标识一律按字符串处理。 */

export type MessageSegment =
  | { type: "text"; data: { text: string } }
  | { type: "image"; data: { url?: string; file?: string } }
  | { type: "at"; data: { qq: string } }
  | { type: "reply"; data: { id: string } }
  | { type: "face"; data: { id: string } }
  | { type: "record"; data: { url?: string; file?: string } }
  | { type: "video"; data: { url?: string; file?: string } }
  | { type: "file"; data: { fileId: string; name: string; size?: number; busId?: number } }
  | { type: "json"; data: { data: string } }
  | { type: "forward"; data: { id: string } }
  | { type: "share"; data: { url?: string; title?: string; content?: string } }
  | { type: "unknown"; data: Record<string, unknown> };

export interface MessageRecord {
  eventKey: string;
  accountId: string;
  providerId: string;
  conversationId: string; // group_<gid> | private_<uid>
  groupId?: string;
  messageId: string;
  senderId: string;
  displayNameAtTime: string;
  sentAt: string; // ISO
  receivedAt: string; // ISO
  replyToMessageId?: string;
  segments: MessageSegment[];
  textContent: string;
  status: "active" | "recalled";
  origin: "live" | "backfill";
  /** Internal transient interaction marker; never accepted from message JSON. */
  interaction?: "poke";
}

/** A real OneBot notify/poke notice, never inferred from message text. */
export interface PokeEvent {
  kind: "poke";
  eventKey: string;
  accountId: string;
  providerId: string;
  conversationId: string;
  groupId?: string;
  /** Actual actor. Friend notices may carry this in sender_id, not user_id. */
  userId: string;
  targetId: string;
  sentAt: string;
  receivedAt: string;
  origin: "live";
}

/** 统一事件（Provider 输出） */
export type GatewayEvent =
  | { kind: "message"; message: MessageRecord }
  | PokeEvent
  | {
      kind: "recall";
      accountId: string;
      conversationId: string;
      groupId?: string;
      messageId: string;
      operatorId?: string;
      recalledAt: string;
    }
  | { kind: "connection"; state: "connected" | "disconnected" | "reconnecting"; at: string; detail?: string }
  | { kind: "login"; state: "online" | "offline" | "unknown"; at: string; detail?: string };

export type SendStatus = "queued" | "in_flight" | "confirmed" | "failed" | "unknown";

export interface SendResult {
  status: "confirmed" | "failed" | "unknown";
  messageId?: string;
  error?: string;
}

export type CapabilityState = "supported" | "unsupported" | "unverified";

export interface CapabilityMap {
  receiveMessages: CapabilityState;
  sendText: CapabilityState;
  sendImage: CapabilityState;
  sendPrivateFile: CapabilityState;
  /** 可选以兼容尚未实现群文件的 Provider。 */
  sendGroupFile?: CapabilityState;
  sendPoke?: CapabilityState;
  groupHistory: CapabilityState;
}

export interface ProviderHealth {
  connection: "connected" | "disconnected" | "connecting";
  login: "online" | "offline" | "unknown";
  selfId?: string;
  lastHeartbeatAt?: string;
  lastError?: string;
  reconnectCount: number;
}

export interface Provider {
  readonly providerId: string;
  start(): void;
  stop(): Promise<void>;
  health(): ProviderHealth;
  capabilities(): CapabilityMap;
  onEvent(cb: (ev: GatewayEvent) => void): void;
  sendPrivateMsg(userId: string, segments: MessageSegment[]): Promise<SendResult>;
  sendGroupMsg(groupId: string, segments: MessageSegment[]): Promise<SendResult>;
  sendPrivateFile?(userId: string, filePath: string, fileName: string): Promise<SendResult>;
  sendGroupFile?(groupId: string, filePath: string, fileName: string): Promise<SendResult>;
  sendPoke?(userId: string, groupId?: string): Promise<SendResult>;
  /** Resolve a protocol-issued file ID; never return a local server path. */
  resolveIncomingFile?(file: { fileId: string; groupId?: string; userId?: string; busId?: number }): Promise<
    { ok: true; url: string } | { ok: false; error: string }
  >;
  getGroupMsgHistory?(
    groupId: string,
    anchor?: string,
    limit?: number,
  ): Promise<
    | { ok: true; messages: NormalizedIncomingMessage[]; hasMore: boolean }
    | { ok: false; error: string }
  >;
}

/** Provider 原始消息（规范化到统一段格式，尚未入库） */
export interface NormalizedIncomingMessage {
  accountId: string;
  providerId: string;
  messageId: string;
  groupId?: string;
  privateUserId?: string;
  senderId: string;
  senderName: string;
  sentAt: Date;
  replyToMessageId?: string;
  segments: MessageSegment[];
  raw?: unknown;
}

export interface ToolParamSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: ToolParamSchema;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
  /** private=true 的工具只在私聊或管理员场景开放 */
  private?: boolean;
}

export interface ToolContext {
  accountId: string;
  groupId?: string;
  requesterId?: string;
  isPrivate: boolean;
}

export interface MemoryFact {
  id?: number;
  groupId: string;
  kind: "fact" | "plan" | "convention" | "joke";
  subjectUserId?: string;
  subjectName?: string;
  statement: string;
  narratorId: string;
  narratorName?: string;
  sourceMessageId?: string;
  sourceSentAt?: string;
  status: "candidate" | "confirmed" | "invalid";
  confidence: number;
  supersededBy?: number;
  createdAt?: string;
  updatedAt?: string;
}
