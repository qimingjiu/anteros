import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { dockerImageReference, IMAGE_SHA256 } from "./docker-image.js";
import { managedRuntimeEnv } from "./local.js";
import type { DockerMcpManifest } from "./manifest.js";

const PULL_TIMEOUT_MS = 5 * 60_000;
const DOCKER_OPERATION_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 32 * 1024;
const PIN_FILE = "docker-image.json";
const RUN_LABEL = "io.anteros.mcp.run";
const RUN_KEY = /^[a-f0-9]{32}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const DOCKER_PROFILE_ENV = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "DOCKER_CONFIG"];
const EMPTY_PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "FTP_PROXY"]
  .flatMap(name => ["--env", `${name}=`, "--env", `${name.toLowerCase()}=`]);

interface DockerInvocation {
  directory: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string>;
}
export type DockerExecutor = (args: string[], options: DockerInvocation) => Promise<string>;

/** Preserve the server account's Docker configuration and registry login for the CLI. */
export function managedDockerClientEnv(directory: string): Record<string, string> {
  const profile = DOCKER_PROFILE_ENV.flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []);
  return { ...managedRuntimeEnv(directory), ...Object.fromEntries(profile) };
}

export class DockerExecutionError extends Error {
  constructor(readonly reason: "missing" | "daemon" | "container_missing" | "image_missing" | "registry_auth" | "timeout" | "failed") {
    super({
      missing: "Docker CLI 未安装或不在服务器 PATH 上",
      daemon: "无法访问 Docker daemon，请确认它正在运行且网关账户有权限",
      container_missing: "Docker 容器已退出或不存在",
      image_missing: "找不到固定的 Docker 镜像，需重新提交安装或更新",
      registry_auth: "Docker 仓库拒绝访问，请检查镜像名称或服务器的 docker login",
      timeout: "Docker 操作被取消或超时",
      failed: "Docker 操作未完成，请核对镜像和 daemon 状态",
    }[reason]);
  }
}

function dockerFailure(output: string): DockerExecutionError {
  if (/No such container/i.test(output)) return new DockerExecutionError("container_missing");
  if (/No such image|manifest unknown|image.*not found/i.test(output)) return new DockerExecutionError("image_missing");
  if (/cannot connect to the docker daemon|error during connect|error from daemon.*connection refused|docker daemon is not running|permission denied while trying to connect/i.test(output)) {
    return new DockerExecutionError("daemon");
  }
  if (/pull access denied|unauthorized|authentication required|requested access.*denied/i.test(output)) return new DockerExecutionError("registry_auth");
  return new DockerExecutionError("failed");
}

export const executeDocker: DockerExecutor = async (args, options) => {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DOCKER_OPERATION_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  if (signal.aborted) throw new DockerExecutionError("timeout");
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd: options.directory, shell: false, windowsHide: true,
      env: { ...managedDockerClientEnv(options.directory), ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout = (stdout + String(chunk)).slice(-MAX_OUTPUT); });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + String(chunk)).slice(-MAX_OUTPUT); });
    const cancel = () => { try { child.kill("SIGKILL"); } catch { /* the process may already be gone */ } };
    const cleanup = () => signal.removeEventListener("abort", cancel);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    child.once("error", error => {
      cleanup();
      reject(new DockerExecutionError((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed"));
    });
    child.once("close", code => {
      cleanup();
      if (signal.aborted) reject(new DockerExecutionError("timeout"));
      else if (code !== 0) reject(dockerFailure(stderr + stdout));
      else resolve(stdout.trim());
    });
  });
};

interface DockerImagePin { reference: string; registryDigest: string; imageId: string }

export async function deployManagedDocker(manifest: DockerMcpManifest, directory: string, signal: AbortSignal,
  execute: DockerExecutor = executeDocker): Promise<void> {
  const parsed = dockerImageReference(manifest.image);
  if (!parsed) throw new Error("Docker 镜像引用无效");
  await fs.mkdir(path.join(directory, "tmp"), { recursive: true, mode: 0o700 });
  const result = await execute(["image", "pull", "--", manifest.image], { directory, signal, timeoutMs: PULL_TIMEOUT_MS });
  const reported = new Set([...result.matchAll(/^Digest:\s+(sha256:[a-f0-9]{64})\s*$/gm)].map(match => match[1]!));
  const digest = parsed.digest ?? (reported.size === 1 ? [...reported][0] : undefined);
  if (!digest || (reported.size && (reported.size !== 1 || !reported.has(digest)))) {
    throw new Error("Docker 未确认拉取的镜像 digest");
  }
  const pinnedRef = `${parsed.repository}@${digest}`;
  const inspected = await execute(["image", "inspect", "--format={{.Id}} {{.Os}}", "--", pinnedRef], { directory, signal });
  const [imageId, os, extra] = inspected.split(/\s+/);
  if (!imageId || !IMAGE_SHA256.test(imageId) || !!extra || os !== "linux") throw new Error("需要可验证的 Linux Docker 镜像");
  const pin: DockerImagePin = { reference: manifest.image, registryDigest: digest, imageId };
  await fs.writeFile(path.join(directory, PIN_FILE), JSON.stringify(pin), { mode: 0o600, flag: "wx" });
}

async function readPin(manifest: DockerMcpManifest, directory: string): Promise<DockerImagePin> {
  const filename = path.join(directory, PIN_FILE);
  const stat = await fs.lstat(filename).catch(() => { throw new Error("找不到 Docker 镜像固定记录，请提交更新"); });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error("Docker 镜像固定记录无效");
  let pin: Partial<DockerImagePin> | undefined;
  try { pin = JSON.parse(await fs.readFile(filename, "utf8")) as Partial<DockerImagePin>; } catch { /* fixed error below */ }
  const requested = dockerImageReference(manifest.image);
  if (!pin || pin.reference !== manifest.image || typeof pin.registryDigest !== "string" || !IMAGE_SHA256.test(pin.registryDigest)
    || typeof pin.imageId !== "string" || !IMAGE_SHA256.test(pin.imageId) || (requested?.digest && pin.registryDigest !== requested.digest)) {
    throw new Error("Docker 镜像固定记录无效，请提交更新");
  }
  return { reference: pin.reference, registryDigest: pin.registryDigest, imageId: pin.imageId };
}

function containerName(runKey: string): string {
  if (!RUN_KEY.test(runKey)) throw new Error("Docker 容器运行标识无效");
  return `anteros-mcp-${runKey}`;
}

export async function createManagedDocker(manifest: DockerMcpManifest, directory: string, runKey: string,
  env: Record<string, string>, signal: AbortSignal, execute: DockerExecutor = executeDocker): Promise<{ command: string; args: string[] }> {
  const { imageId } = await readPin(manifest, directory);
  const name = containerName(runKey);
  const envNames = Object.keys(env).flatMap(key => ["--env", key]);
  const id = await execute(["container", "create",
    "--rm", "--interactive", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--init",
    "--pull=never", "--network=bridge", "--memory=512m", "--memory-swap=512m", "--cpus=1", "--pids-limit=128",
    "--log-driver=none", "--stop-timeout=3", "--tmpfs=/tmp:rw,nosuid,nodev,size=128m,mode=1777",
    "--name", name, "--label", `${RUN_LABEL}=${runKey}`,
    ...EMPTY_PROXY_ENV, ...envNames, "--", imageId, ...manifest.args], { directory, signal, env });
  if (!CONTAINER_ID.test(id)) throw new Error("Docker 未确认创建的容器");
  return { command: "docker", args: ["container", "start", "--attach", "--interactive", "--", id] };
}

export async function removeManagedDocker(runKey: string, directory: string,
  execute: DockerExecutor = executeDocker): Promise<void> {
  const name = containerName(runKey);
  let metadata: string;
  try {
    metadata = await execute(["container", "inspect", `--format={{.Id}} {{index .Config.Labels "${RUN_LABEL}"}}`, "--", name], { directory });
  } catch (error) {
    if (error instanceof DockerExecutionError && error.reason === "container_missing") return;
    throw error;
  }
  const [id, owner, extra] = metadata.split(/\s+/);
  if (!id || !CONTAINER_ID.test(id) || owner !== runKey || !!extra) throw new Error("Docker 容器标签不匹配");
  try {
    await execute(["container", "rm", "--force", "--volumes", "--", id], { directory });
  } catch (error) {
    if (!(error instanceof DockerExecutionError && error.reason === "container_missing")) throw error;
  }
}
