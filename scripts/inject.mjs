// UTF-8 安全的消息注入工具：
//   TEXT="/帮助" node scripts/inject.mjs --user 8888 [--at] [--reply <id>] [--group 123456]
// （用环境变量传文本，避免 shell 转义/路径改写问题）
const args = process.argv.slice(2);
// --cmd 帮助  → 发送 "/帮助"（避免 Git Bash 把以 / 开头的参数改写成路径）
const cmdIdx = args.indexOf("--cmd");
const text = process.env.TEXT ?? (cmdIdx >= 0 ? `/${args[cmdIdx + 1] ?? ""} ${args[cmdIdx + 2] && !args[cmdIdx + 2].startsWith("--") ? args[cmdIdx + 2] : ""}`.trim() : args[0] ?? "");
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const body = JSON.stringify({
  group_id: opt("--group", "123456"),
  user_id: opt("--user", "222"),
  nickname: opt("--nick", undefined),
  text,
  at_bot: args.includes("--at"),
  reply_to: opt("--reply", undefined),
});
const resp = await fetch("http://127.0.0.1:3002/inject", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
});
console.log(await resp.text());
