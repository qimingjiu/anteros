import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const owner = args.get("--owner"), device = args.get("--device"), output = args.get("--out-dir");
if (!/^\d{5,20}$/u.test(owner ?? "") || !/^[A-Za-z0-9_-]{1,64}$/u.test(device ?? "") || !output
  || [...args.keys()].some(key => !["--owner", "--device", "--out-dir"].includes(key))) {
  throw new Error("Usage: node scripts/supabase/register-device.mjs --owner 123456789 --device my-phone --out-dir <local-private-directory>");
}
const directory = path.resolve(output);
fs.mkdirSync(directory, { recursive: true });
const token = randomBytes(32).toString("hex");
const hash = createHash("sha256").update(token).digest("hex");
const sql = `-- Only a token hash is stored. Put the raw token only on your phone.\ninsert into public.phone_presence_devices (owner_id, device_id, token_hash, enabled)\nvalues ('${owner}', '${device}', '${hash}', true)\non conflict (owner_id, device_id) do update set token_hash = excluded.token_hash, enabled = true;\n`;
fs.writeFileSync(path.join(directory, "device-token.txt"), token + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
fs.writeFileSync(path.join(directory, "device-registration.sql"), sql, { encoding: "utf8", mode: 0o600, flag: "wx" });
console.log(`Created device-token.txt and device-registration.sql in ${directory}. Keep the raw token off shared chats and source control.`);
