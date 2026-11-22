import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { LocalMcpManifest } from "./manifest.js";

const INSTALL_LIMIT_MS = 5 * 60_000;
const WINDOWS = process.platform === "win32";
const systemVariables = ["PATH", "Path", "PATHEXT", "WINDIR", "SYSTEMROOT", "SystemRoot", "LANG"];

export function managedRuntimeEnv(directory: string): Record<string, string> {
  const values = systemVariables.flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []);
  const temp = path.join(directory, "tmp");
  return { ...Object.fromEntries(values), TMPDIR: temp, TEMP: temp, TMP: temp };
}

async function installProcess(label: string, executable: string, args: string[], directory: string, signal: AbortSignal): Promise<void> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(INSTALL_LIMIT_MS)]);
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: directory, env: managedRuntimeEnv(directory), shell: false,
      stdio: "ignore", windowsHide: true, detached: !WINDOWS });
    const terminate = () => {
      try {
        if (!WINDOWS && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill();
      } catch { /* the process may have already exited */ }
    };
    const cleanup = () => signal.removeEventListener("abort", terminate);
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) terminate();
    child.once("error", () => { cleanup(); reject(new Error(`无法运行 ${label}，请检查服务器运行环境`)); });
    child.once("close", code => {
      cleanup();
      if (signal.aborted) reject(new Error(`${label} 被取消或安装超时`));
      else if (code !== 0) reject(new Error(`${label} 未完成（退出码 ${code ?? "未知"}）`));
      else resolve();
    });
  });
}

async function npmRuntime(): Promise<{ command: string; prefix: string[] }> {
  const npmCli = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")];
  for (const candidate of npmCli) {
    if (candidate && path.isAbsolute(candidate) && path.basename(candidate) === "npm-cli.js") {
      try { await fs.access(candidate); return { command: process.execPath, prefix: [candidate] }; } catch { /* try the next installed npm */ }
    }
  }
  if (WINDOWS) throw new Error("找不到 Node.js 附带的 npm CLI");
  return { command: "npm", prefix: [] };
}

const venvBin = (directory: string) => path.join(directory, "venv", WINDOWS ? "Scripts" : "bin");
const venvPython = (directory: string) => path.join(venvBin(directory), WINDOWS ? "python.exe" : "python");

export async function deployManagedLocal(manifest: LocalMcpManifest, directory: string, signal: AbortSignal): Promise<void> {
  await fs.mkdir(path.join(directory, "tmp"), { recursive: true, mode: 0o700 });
  if (manifest.kind === "npm") {
    const npm = await npmRuntime();
    const config = path.join(directory, "npm-config.empty");
    await fs.writeFile(config, "", { mode: 0o600, flag: "wx" });
    await installProcess("npm", npm.command, [...npm.prefix, "install", "--ignore-scripts", "--no-audit", "--no-fund",
      "--no-package-lock", "--omit=dev", "--registry=https://registry.npmjs.org/", "--userconfig", config,
      "--globalconfig", path.join(directory, "npm-global-config.empty"), "--cache", path.join(directory, "npm-cache"),
      "--", `${manifest.package}@${manifest.version}`], directory, signal);
    return;
  }
  await installProcess("Python venv", WINDOWS ? "python" : "python3", ["-I", "-m", "venv", path.join(directory, "venv")], directory, signal);
  await installProcess("pip", venvPython(directory), ["-I", "-m", "pip", "--isolated", "install", "--disable-pip-version-check",
    "--no-input", "--only-binary=:all:", "--index-url", "https://pypi.org/simple", "--", `${manifest.package}==${manifest.version}`], directory, signal);
}

async function inside(root: string, candidate: string): Promise<string> {
  const canonicalRoot = await fs.realpath(root);
  const entry = await fs.realpath(candidate);
  const rel = path.relative(canonicalRoot, entry);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !(await fs.stat(entry)).isFile()) {
    throw new Error("MCP 启动项超出安装目录");
  }
  return entry;
}

async function npmLaunch(manifest: LocalMcpManifest, directory: string): Promise<{ command: string; args: string[] }> {
  const modules = path.join(directory, "node_modules");
  const packageRoot = path.join(modules, manifest.package);
  const packageFile = await inside(modules, path.join(packageRoot, "package.json"));
  if ((await fs.stat(packageFile)).size > 1024 * 1024) throw new Error("npm 包元数据超出上限");
  const pkg = JSON.parse(await fs.readFile(packageFile, "utf8")) as {
    name?: string; version?: string; bin?: string | Record<string, unknown>;
  };
  if (pkg.name !== manifest.package || pkg.version !== manifest.version) throw new Error("已安装 npm 包名或版本与清单不符");
  const bins = typeof pkg.bin === "string" ? { [manifest.package.split("/").at(-1)!]: pkg.bin } : pkg.bin ?? {};
  const names = Object.keys(bins);
  const selected = manifest.executable ?? (names.length === 1 ? names[0] : undefined);
  const relative = selected && Object.hasOwn(bins, selected) ? bins[selected] : undefined;
  if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error("需要选择已安装 npm 包声明的启动项");
  const entry = await inside(packageRoot, path.resolve(packageRoot, relative));
  return { command: process.execPath, args: [entry, ...manifest.args] };
}

function normalizedPackage(value: string): string { return value.toLowerCase().replace(/[-_.]+/g, "-"); }
async function verifyPythonPackage(manifest: LocalMcpManifest, directory: string): Promise<void> {
  const venv = path.join(directory, "venv");
  const lib = path.join(venv, WINDOWS ? "Lib" : "lib");
  const roots = WINDOWS ? [path.join(lib, "site-packages")] : (await fs.readdir(lib, { withFileTypes: true }))
    .filter(dirent => dirent.isDirectory() && /^python\d+\.\d+$/.test(dirent.name))
    .map(dirent => path.join(lib, dirent.name, "site-packages"));
  const expectedName = normalizedPackage(manifest.package);
  for (const root of roots) {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")
        || normalizedPackage(entry.name.split("-")[0] ?? "") !== expectedName) continue;
      const file = await inside(root, path.join(root, entry.name, "METADATA"));
      if ((await fs.stat(file)).size > 1024 * 1024) continue;
      const metadata = await fs.readFile(file, "utf8");
      const name = /^Name:\s*(\S+)/mi.exec(metadata)?.[1];
      const version = /^Version:\s*(\S+)/mi.exec(metadata)?.[1];
      if (name && normalizedPackage(name) === expectedName && version?.toLowerCase() === manifest.version.toLowerCase()) return;
    }
  }
  throw new Error("已安装 Python 包名或版本与清单不符");
}

export async function managedLocalLaunch(manifest: LocalMcpManifest, directory: string): Promise<{ command: string; args: string[] }> {
  if (manifest.kind === "npm") return npmLaunch(manifest, directory);
  await verifyPythonPackage(manifest, directory);
  const python = venvPython(directory);
  await fs.access(python);
  if (manifest.module) return { command: python, args: ["-I", "-m", manifest.module, ...manifest.args] };
  const bin = venvBin(directory);
  const executable = await inside(bin, path.join(bin, `${manifest.executable}${WINDOWS ? ".exe" : ""}`));
  return { command: executable, args: manifest.args };
}
