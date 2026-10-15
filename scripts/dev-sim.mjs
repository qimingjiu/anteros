/**
 * 本地模拟联调环境（不需要真实 QQ）：
 *  - ws://127.0.0.1:3001  模拟 OneBot v11 协议端（SnowLuma/NapCat 的替身）
 *  - http://127.0.0.1:3002  注入模拟消息：POST /inject {"group_id":"123456","user_id":"222","text":"...", "at_bot":true}
 *  - http://127.0.0.1:3003  模拟 OpenAI 兼容模型服务
 *
 * 用法：
 *   1. npm run sim            （启动模拟环境，保持运行）
 *   2. 另开终端：npx tsx src/index.ts --config config.sim.yaml
 *   3. 用浏览器打开 http://127.0.0.1:8642 查看状态面板
 *   4. 注入消息：
 *      curl -X POST http://127.0.0.1:3002/inject -H "Content-Type: application/json" ^
 *        -d "{\"group_id\":\"123456\",\"user_id\":\"222\",\"text\":\"在吗\",\"at_bot\":true}"
 */
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

let msgIdCounter = 5000;
const clients = new Set();
const actionLog = [];

// ---------- OneBot v11 模拟协议端 ----------
const wss = new WebSocketServer({ port: 3001, path: "/ws" });
wss.on("connection", (ws) => {
  console.log("[onebot-mock] 机器人已连入");
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
  ws.on("message", (raw) => {
    let req;
    try {
      req = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!req.action || !req.echo) return;
    let resp;
    switch (req.action) {
      case "get_login_info":
        resp = { retcode: 0, status: "ok", data: { user_id: 10001, nickname: "SimBot" } };
        break;
      case "send_group_msg":
      case "send_private_msg": {
        const id = ++msgIdCounter;
        actionLog.push({ action: req.action, params: req.params, time: new Date().toISOString() });
        console.log(`[onebot-mock] ${req.action} →`, JSON.stringify(req.params));
        resp = { retcode: 0, status: "ok", data: { message_id: id } };
        break;
      }
      case "upload_private_file":
      case "upload_group_file":
        actionLog.push({ action: req.action, params: req.params, time: new Date().toISOString() });
        console.log(`[onebot-mock] ${req.action} → target=${req.params.user_id ?? req.params.group_id} file=${req.params.file}`);
        resp = { retcode: 0, status: "ok", data: { file_id: String(++msgIdCounter) } };
        break;
      case "get_group_msg_history":
        resp = { retcode: 0, status: "ok", data: { messages: [] } };
        break;
      default:
        console.log(`[onebot-mock] 未知动作 ${req.action}（返回成功）`);
        resp = { retcode: 0, status: "ok", data: {} };
    }
    ws.send(JSON.stringify({ ...resp, echo: req.echo }));
  });
  // 心跳
  const hb = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", time: Math.floor(Date.now() / 1000), interval: 3000, self_id: 10001 }));
    }
  }, 3000);
  ws.on("close", () => clearInterval(hb));
});

function broadcast(obj) {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
}

// ---------- 消息注入 ----------
http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url === "/inject") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const p = JSON.parse(body);
          const groupId = String(p.group_id ?? "123456");
          const userId = String(p.user_id ?? "222");
          const nick = p.nickname ?? `用户${userId}`;
          const segments = [];
          if (p.at_bot) segments.push({ type: "at", data: { qq: "10001" } });
          if (p.reply_to) segments.push({ type: "reply", data: { id: String(p.reply_to) } });
          segments.push({ type: "text", data: { text: p.text ?? "" } });
          const event = {
            post_type: "message",
            message_type: "group",
            time: Math.floor(Date.now() / 1000),
            self_id: 10001,
            group_id: Number(groupId),
            user_id: Number(userId),
            message_id: ++msgIdCounter,
            sender: { user_id: Number(userId), nickname: nick, card: nick },
            message: segments,
            raw_message: p.text ?? "",
          };
          broadcast(event);
          console.log(`[inject] 群${groupId} ${nick}: ${p.at_bot ? "@SimBot " : ""}${p.text}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, message_id: event.message_id }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
      return;
    }
    if (req.url === "/log") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ actions: actionLog }));
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(3002, () => console.log("[inject] 消息注入端口: http://127.0.0.1:3002/inject"));

// ---------- 模拟 OpenAI 兼容模型 ----------
http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let lastUser = "";
        try {
          const p = JSON.parse(body);
          const users = (p.messages ?? []).filter((m) => m.role === "user");
          lastUser = users[users.length - 1]?.content ?? "";
        } catch { /* ignore */ }
        const text = `（模拟回复）我看到了你的消息：「${String(lastUser).slice(-80)}」。这是一条用于本地联调的固定回复。`;
        console.log(`[llm-mock] 生成回复 (${text.length} 字符)`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(3003, () => console.log("[llm-mock] 模型服务: http://127.0.0.1:3003/v1/chat/completions"));

console.log("\n模拟环境已就绪。下一步：");
console.log("  npx tsx src/index.ts --config config.sim.yaml\n");
