import { validateManagedMcpUrl } from "./remote.js";
import { dockerImageReference } from "./docker-image.js";

export const MCP_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const SECRET_REF = /^[a-z][a-z0-9_-]{0,63}$/;
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const NPM_VERSION = /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i;
const PYTHON_PACKAGE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const PYTHON_VERSION = /^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9.]+)?$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;
const RUNTIME_ENV = /^(?:path|home|userprofile|shell|comspec|pathext|systemroot|windir|node_.*|npm_.*|pnpm_.*|ld_.*|dyld_.*|py_.*|python.*|pip_.*|bash_env|env|electron_.*)$/i;
const DOCKER_CLI_ENV = /^(?:DOCKER.*|CONTAINER_HOST|BUILDKIT_.*|BUILDX_.*|XDG_.*|SSL_CERT_.*|(?:HTTP|HTTPS|ALL|NO|FTP)_PROXY|TMPDIR|TEMP|TMP|SYSTEMDRIVE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|SSH_.*)$/i;
const SECRET_ENV = /token|secret|password|api_?key|credential|authorization/i;
const IDENTITY = /^[\p{L}\p{N}_.:/-]{1,100}$/u;
const HEADER = /^(?!(?:host|content-length|content-type|connection|transfer-encoding|accept|mcp-.*)$)[A-Za-z][A-Za-z0-9-]{0,79}$/i;

interface SharedManifest {
  id: string;
  allowedAgents: string[];
  allowedRooms: string[];
  allowedTools?: string[];
}
export interface RemoteMcpManifest extends SharedManifest { kind: "remote"; url: string; secretHeaders: Record<string, string> }
interface StdioManifest extends SharedManifest {
  args: string[];
  env: Record<string, string>;
  secretEnv: Record<string, string>;
}
export interface LocalMcpManifest extends StdioManifest {
  kind: "npm" | "python";
  package: string;
  version: string;
  executable?: string;
  module?: string;
}
export interface DockerMcpManifest extends StdioManifest { kind: "docker"; image: string }
export type ManagedMcpManifest = RemoteMcpManifest | LocalMcpManifest | DockerMcpManifest;

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function strings(value: unknown, max: number, validate: (s: string) => boolean, error: string): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !validate(item))) throw new Error(error);
  return value as string[];
}

function record(value: unknown, validate: (key: string, value: string) => boolean, error: string): Record<string, string> {
  if (value === undefined) return {};
  const input = asObject(value);
  if (!input || Object.keys(input).length > 24) throw new Error(error);
  const entries: [string, string][] = [];
  for (const [key, item] of Object.entries(input)) {
    if (typeof item !== "string" || !validate(key, item)) throw new Error(error);
    entries.push([key, item]);
  }
  return Object.fromEntries(entries);
}

export function validateManagedManifest(input: unknown): ManagedMcpManifest {
  const source = asObject(input);
  if (!source) throw new Error("请提供 MCP 安装清单");
  const { id, kind } = source;
  if (typeof id !== "string" || !MCP_ID.test(id)) throw new Error("MCP ID 必须由小写字母、数字或连字符组成");
  if (kind !== "npm" && kind !== "python" && kind !== "docker" && kind !== "remote") throw new Error("MCP 安装类型须为 npm、python、docker 或 remote");
  const common = ["id", "kind", "allowedAgents", "allowedRooms", "allowedTools"];
  const stdio = ["args", "env", "secretEnv"];
  const specific = kind === "remote" ? ["url", "secretHeaders"] : kind === "docker" ? ["image", ...stdio] : ["package", "version", "executable", "module", ...stdio];
  const accepted = new Set([...common, ...specific]);
  if (Object.keys(source).some(key => !accepted.has(key))) throw new Error("安装清单内含不支持的字段");
  const allowedAgents = [...new Set(strings(source.allowedAgents, 40, value => IDENTITY.test(value), "必须指定可用成员 ID"))];
  const allowedRooms = [...new Set(strings(source.allowedRooms, 40, value => IDENTITY.test(value), "必须指定可用房间 ID"))];
  if (!allowedAgents.length || !allowedRooms.length) throw new Error("至少指定一个可用成员和房间");
  const allowedTools = source.allowedTools === undefined ? undefined : [...new Set(strings(source.allowedTools, 100,
    value => value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value), "工具名单无效"))];
  const shared = { id, allowedAgents, allowedRooms, allowedTools };
  if (kind === "remote") {
    if (typeof source.url !== "string") throw new Error("请填写远程 MCP 的 HTTPS URL");
    const url = validateManagedMcpUrl(source.url).href;
    const secretHeaders = record(source.secretHeaders, (name, ref) => HEADER.test(name) && SECRET_REF.test(ref), "鉴权请求头必须使用凭据引用");
    if (Object.keys(secretHeaders).map(key => key.toLowerCase()).length !== new Set(Object.keys(secretHeaders).map(key => key.toLowerCase())).size) {
      throw new Error("鉴权请求头名称重复");
    }
    return { ...shared, kind, url, secretHeaders };
  }
  const args = source.args === undefined ? [] : strings(source.args, 20,
    value => value.length <= 1000 && !/[\x00-\x1f\x7f]/.test(value) && !/^--[\w-]*(?:token|secret|password|api[-_]?key)[\w-]*(?:=|$)/i.test(value),
    "启动参数无效，凭据通过引用传递");
  const validEnv = (name: string) => ENV_NAME.test(name) && !RUNTIME_ENV.test(name) && (kind !== "docker" || !DOCKER_CLI_ENV.test(name));
  const env = record(source.env, (name, value) => validEnv(name) && !SECRET_ENV.test(name)
    && value.length <= 2000 && !/[\x00-\x1f\x7f]/.test(value), "环境配置无效，凭据需要引用");
  const secretEnv = record(source.secretEnv, (name, ref) => validEnv(name) && SECRET_REF.test(ref), "环境凭据引用无效");
  const stdioConfig = { ...shared, args, env, secretEnv };
  if (kind === "docker") {
    const image = source.image;
    if (typeof image !== "string" || !dockerImageReference(image)) throw new Error("Docker 镜像需要明确版本标签或 SHA-256 digest");
    return { ...stdioConfig, kind, image };
  }
  const pkg = source.package;
  const version = source.version;
  if (typeof pkg !== "string" || pkg.length > 150 || !(kind === "npm" ? NPM_PACKAGE : PYTHON_PACKAGE).test(pkg)) throw new Error("请提供包管理器中的有效包名");
  if (typeof version !== "string" || version.length > 64 || !(kind === "npm" ? NPM_VERSION : PYTHON_VERSION).test(version)) throw new Error("请提供精确版本号");
  const executable = source.executable;
  const module = source.module;
  if (executable !== undefined && (typeof executable !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(executable))) throw new Error("启动项必须是包声明的可执行名称");
  if (module !== undefined && (kind !== "python" || typeof module !== "string" || module.length > 100 || !/^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*$/.test(module))) {
    throw new Error("Python 模块名称无效");
  }
  if (kind === "python" && Boolean(executable) === Boolean(module)) throw new Error("请选择一个 Python 模块或包声明的可执行名称");
  return { ...stdioConfig, kind, package: pkg, version, executable, module };
}
