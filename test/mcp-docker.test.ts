import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { McpAdmin, type McpAdminJobCompletion, type McpAdminOptions } from "../src/mcp-admin/index.js";
import { DockerExecutionError, deployManagedDocker, removeManagedDocker, type DockerExecutor } from "../src/mcp-admin/docker.js";
import { validateManagedManifest } from "../src/mcp-admin/manifest.js";
import type { ToolContext } from "../src/types.js";

const REPO = "ghcr.io/example/mcp-tools";
const REGISTRY_DIGEST = `sha256:${"a".repeat(64)}`;
const REGISTRY_DIGEST_2 = `sha256:${"b".repeat(64)}`;
const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const IMAGE_ID_2 = `sha256:${"d".repeat(64)}`;
const secret = "fixture-do-not-log-value";
const manifest = { id: "docker-tools", kind: "docker", image: `${REPO}:1.2.3`, args: ["--privileged", "--mount=fixture"],
  allowedAgents: ["member"], allowedRooms: ["private-room"], allowedTools: ["allowed"],
  env: { APP_MODE: "live" }, secretEnv: { APP_TOKEN: "api-token" } };

async function temp(t: TestContext) {
  const parent = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(parent, "anteros-mcp-docker-"));
  t.after(async () => {
    const resolved = await fs.realpath(dir);
    assert.equal(path.relative(parent, resolved), path.basename(dir));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return dir;
}

async function settled(admin: McpAdmin, id: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const job = admin.job(id);
    if (job && !["queued", "running"].includes(job.status)) { await delay(0); return job; }
    await delay(10);
  }
  assert.fail("Docker MCP job did not settle");
}

test("Docker 清单只接受具体标签或 SHA-256 引用，拒绝主机选项和 daemon 环境覆盖", () => {
  assert.equal(validateManagedManifest(manifest).kind, "docker");
  assert.equal(validateManagedManifest({ ...manifest, image: `registry.local:5000/demo/server@${REGISTRY_DIGEST}` }).kind, "docker");
  for (const image of [REPO, `${REPO}:latest`, `${REPO}:stable`, "--all-tags", `${REPO}:1.2.3 && whoami`,
    `https://${REPO}:1.0`, `${REPO}@sha256:1234`]) {
    assert.throws(() => validateManagedManifest({ ...manifest, image }), /镜像/);
  }
  assert.throws(() => validateManagedManifest({ ...manifest, volumes: ["/:/host"] }), /不支持/);
  assert.throws(() => validateManagedManifest({ ...manifest, privileged: true }), /不支持/);
  assert.throws(() => validateManagedManifest({ ...manifest, command: "echo" }), /不支持/);
  assert.throws(() => validateManagedManifest({ ...manifest, env: { DOCKER_HOST: "tcp://127.0.0.1:2375" } }), /环境/);
  assert.throws(() => validateManagedManifest({ ...manifest, secretEnv: { DOCKER_CONTEXT: "api-token" } }), /环境/);
});

test("Docker MCP 固定镜像，用原有 stdio 挂载，失败更新保留旧容器，重启清理遗留容器", async t => {
  const directory = await temp(t);
  const db = new DatabaseSync(":memory:");
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const containers = new Map<string, { id: string; image: string; runKey: string }>();
  const completed: McpAdminJobCompletion[] = [];
  let mount: { config: Parameters<McpAdminOptions["manager"]["upsertManaged"]>[0]; allowed: (ctx: ToolContext) => boolean } | undefined;
  let sequence = 0;
  const command: DockerExecutor = async (args, { env }) => {
    calls.push({ args, env });
    const [object, verb] = args;
    const target = args.at(-1)!;
    if (object === "image" && verb === "pull") {
      assert.ok(target === manifest.image || target === `${REPO}:2.0.0`);
      const digest = target === manifest.image ? REGISTRY_DIGEST : REGISTRY_DIGEST_2;
      return `Pull complete\nDigest: ${digest}\nStatus: Downloaded\n${target}`;
    }
    if (object === "image" && verb === "inspect") {
      assert.ok(target === `${REPO}@${REGISTRY_DIGEST}` || target === `${REPO}@${REGISTRY_DIGEST_2}`);
      return `${target.endsWith(REGISTRY_DIGEST) ? IMAGE_ID : IMAGE_ID_2} linux`;
    }
    if (object === "container" && verb === "create") {
      const name = args[args.indexOf("--name") + 1]!;
      const runKey = args[args.indexOf("--label") + 1]!.split("=")[1]!;
      const image = args[args.indexOf("--") + 1]!;
      const id = (++sequence).toString(16).padStart(64, "0");
      assert.equal(name, `anteros-mcp-${runKey}`);
      containers.set(name, { runKey, id, image });
      return id;
    }
    if (object === "container" && verb === "inspect") {
      const container = containers.get(target);
      if (!container) throw new DockerExecutionError("container_missing");
      return `${container.id} ${container.runKey}`;
    }
    if (object === "container" && verb === "rm") {
      const match = [...containers].find(([, entry]) => entry.id === target);
      assert.ok(match);
      containers.delete(match[0]);
      return match[1].id;
    }
    assert.fail(`Unexpected Docker operation ${object} ${verb}`);
  };
  const options: McpAdminOptions = { db, directory, dockerExecute: command, isOwner: (account, requester) => account === "main" && requester === "789",
    manager: {
      async upsertManaged(config, allowed) {
        const container = [...containers.values()].find(entry => entry.id === config.args?.at(-1));
        assert.ok(container);
        if (container.image === IMAGE_ID_2) throw new Error("fixture handshake failed");
        mount = { config, allowed };
      },
      async removeManaged() { mount = undefined; },
      managedStatus() { return { connected: !!mount, tools: mount ? 1 : 0 }; },
      hasStaticServer() { return false; },
    },
    onJobCompleted(job) {
      assert.equal(admin.job(job.id)?.status, job.status);
      completed.push(job);
    },
  };
  let admin = new McpAdmin(options);
  try {
    const unconfigured = admin.submit("install", { manifest });
    assert.equal((await settled(admin, unconfigured.id)).status, "awaiting_input");
    assert.deepEqual(calls, []);
    await admin.vault.write("api-token", secret);
    const install = admin.retry(unconfigured.id);
    assert.equal((await settled(admin, install.id)).status, "succeeded");
    const deployment = db.prepare("SELECT deployment FROM managed_mcp_services").get() as { deployment: string };
    const pinPath = path.join(directory, "installs", manifest.id, deployment.deployment, "docker-image.json");
    assert.deepEqual(JSON.parse(await fs.readFile(pinPath, "utf8")),
      { reference: manifest.image, registryDigest: REGISTRY_DIGEST, imageId: IMAGE_ID });

    const create = calls.find(call => call.args[1] === "create")!;
    const split = create.args.indexOf("--");
    const flags = create.args.slice(0, split);
    for (const option of ["--pull=never", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=512m", "--cpus=1", "--pids-limit=128"]) {
      assert.ok(flags.includes(option), option);
    }
    assert.equal(flags.some(arg => /^(?:--privileged|--mount|--volume|--device|--use-api-socket|--publish)(?:=|$)/.test(arg)), false);
    assert.deepEqual(create.args.slice(split + 1), [IMAGE_ID, ...manifest.args]);
    assert.deepEqual(create.env, { APP_MODE: "live", APP_TOKEN: secret });
    assert.ok(!JSON.stringify(create.args).includes(secret));
    assert.deepEqual(mount?.config.args?.slice(0, -1), ["container", "start", "--attach", "--interactive", "--"]);
    assert.deepEqual(mount?.config.allowTools, ["allowed"]);
    assert.equal(mount?.config.env, undefined);
    const access = { accountId: "main", requesterId: "789", isPrivate: true, personaId: "member", roomId: "private-room" };
    assert.equal(mount?.allowed(access), true);
    assert.equal(mount?.allowed({ ...access, roomId: "unbound" }), false);
    assert.equal(mount?.allowed({ ...access, requesterId: "456" }), false);
    const original = [...containers.values()][0]!.id;

    const failed = admin.submit("update", { manifest: { ...manifest, image: `${REPO}:2.0.0` } });
    assert.equal((await settled(admin, failed.id)).status, "failed");
    assert.equal(mount?.config.args?.at(-1), original);
    assert.deepEqual([...containers.values()].map(entry => entry.image), [IMAGE_ID]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM managed_mcp_docker_runs").get()?.count, 1);
    assert.equal(admin.list()[0]?.manifest.kind, "docker");
    const pulls = () => calls.filter(call => call.args[0] === "image" && call.args[1] === "pull").length;
    assert.equal(pulls(), 2);

    const restart = admin.submit("restart", { id: manifest.id });
    assert.equal((await settled(admin, restart.id)).status, "succeeded");
    assert.notEqual(mount?.config.args?.at(-1), original);
    assert.equal(pulls(), 2);
    const interruptedId = "interrupted-fixture-job";
    db.prepare("INSERT INTO managed_mcp_jobs(id,service,action,status,updatedAt) VALUES(?,?,?,?,?)")
      .run(interruptedId, manifest.id, "update", "running", new Date().toISOString());
    const orphan = mount!.config.args!.at(-1)!;
    admin = new McpAdmin(options);
    await admin.restore();
    assert.equal(admin.job(interruptedId)?.status, "interrupted");
    assert.equal(containers.size, 1);
    assert.notEqual(mount?.config.args?.at(-1), orphan);
    assert.equal(pulls(), 2);

    const uninstall = admin.submit("uninstall", { id: manifest.id });
    assert.equal((await settled(admin, uninstall.id)).status, "succeeded");
    assert.equal(containers.size, 0);
    await assert.rejects(fs.stat(pinPath), { code: "ENOENT" });
    assert.deepEqual(completed.map(job => job.status), ["awaiting_input", "succeeded", "failed", "succeeded", "interrupted", "succeeded"]);
    assert.equal(new Set(completed.map(job => job.id)).size, completed.length);
    assert.ok(!JSON.stringify(completed).includes(secret));
    assert.ok(completed.every(job => Object.keys(job).sort().join() === "action,id,service,status"));
  } finally {
    await admin.stop();
    db.close();
  }
});

test("Docker 拒绝非 Linux 或 digest 不匹配的拉取结果，清理时核验容器归属", async t => {
  const directory = await temp(t);
  const pinned = validateManagedManifest({ ...manifest, image: `${REPO}@${REGISTRY_DIGEST}` });
  assert.equal(pinned.kind, "docker");
  const abort = new AbortController();
  await assert.rejects(deployManagedDocker(pinned, directory, abort.signal,
    async () => `Digest: ${REGISTRY_DIGEST_2}`), /digest/);
  await assert.rejects(deployManagedDocker(pinned, directory, abort.signal, async args =>
    args[1] === "pull" ? `Digest: ${REGISTRY_DIGEST}` : `${IMAGE_ID} windows`), /Linux/);
  const runKey = "e".repeat(32);
  const operations: string[] = [];
  await assert.rejects(removeManagedDocker(runKey, directory, async args => {
    operations.push(args[1]!);
    return `${"1".repeat(64)} unrelated-run`;
  }), /标签/);
  assert.deepEqual(operations, ["inspect"]);
});
