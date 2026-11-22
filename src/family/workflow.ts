import { isDeepStrictEqual } from "node:util";

export type WorkflowStep =
  | { op: "pick" | "unique"; path?: string }
  | { op: "filter"; path?: string; compare: "eq" | "includes" | "gte" | "lte"; value: unknown }
  | { op: "map"; fields: Record<string, string> }
  | { op: "sort"; path?: string; descending?: boolean }
  | { op: "limit"; count: number }
  | { op: "aggregate"; path?: string; mode: "count" | "sum" | "average" | "min" | "max" }
  | { op: "template"; text: string; join?: string };

const SAFE_KEY = /^(?!(?:__proto__|constructor|prototype)$)[\p{L}\p{N}_-]{1,80}$/u;
const MAX_BYTES = 128_000;

function property(input: unknown, path?: string): unknown {
  if (!path || path === "$") return input;
  if (typeof path !== "string") throw new Error("字段路径需要是字符串。");
  const segments = path.replace(/^\$\./, "").split(".");
  if (segments.length > 12 || !segments.every(part => SAFE_KEY.test(part))) throw new Error("字段路径无效。");
  let value = input;
  for (const part of segments) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return null;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("需要数组，最多 1000 项。");
  return value;
}

function budget(value: unknown): void {
  const data = JSON.stringify(value);
  if (typeof data !== "string" || Buffer.byteLength(data) > MAX_BYTES) throw new Error("流程输入或输出超过 128 KB。");
}

function runStep(input: unknown, step: WorkflowStep): unknown {
  if (!step || typeof step !== "object") throw new Error("流程步骤无效。");
  switch (step.op) {
    case "pick":
      return property(input, step.path);
    case "unique":
      return array(input).filter((row, i, rows) => rows.findIndex(
        candidate => isDeepStrictEqual(property(candidate, step.path), property(row, step.path)),
      ) === i);
    case "filter":
      if (!["eq", "includes", "gte", "lte"].includes(step.compare)) throw new Error("过滤条件无效。");
      return array(input).filter(row => {
        const field = property(row, step.path);
        if (step.compare === "eq") return isDeepStrictEqual(field, step.value);
        if (step.compare === "includes") return typeof field === "string" && field.includes(String(step.value));
        if (typeof field !== "number" || typeof step.value !== "number") return false;
        return step.compare === "gte" ? field >= step.value : field <= step.value;
      });
    case "map": {
      const fields = Object.entries(step.fields ?? {});
      if (!fields.length || fields.length > 30 || fields.some(([key, path]) => !SAFE_KEY.test(key) || typeof path !== "string")) {
        throw new Error("需要最多 30 个有效字段映射。");
      }
      return array(input).map(row => Object.fromEntries(fields.map(([key, path]) => [key, property(row, path)])));
    }
    case "sort":
      return array(input).toSorted((a, b) => {
        const left = property(a, step.path);
        const right = property(b, step.path);
        const comparison = typeof left === "number" && typeof right === "number"
          ? left - right : String(left ?? "").localeCompare(String(right ?? ""));
        return step.descending ? -comparison : comparison;
      });
    case "limit":
      if (!Number.isInteger(step.count) || step.count < 0 || step.count > 1000) throw new Error("截取数需在 0 到 1000 之间。");
      return array(input).slice(0, step.count);
    case "aggregate": {
      if (!["count", "sum", "average", "min", "max"].includes(step.mode)) throw new Error("统计方式无效。");
      const rows = array(input);
      if (step.mode === "count") return rows.length;
      const numbers = rows.map(row => property(row, step.path))
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      const sum = numbers.reduce((total, n) => total + n, 0);
      if (step.mode === "sum") return sum;
      if (!numbers.length) return null;
      if (step.mode === "average") return sum / numbers.length;
      return step.mode === "min" ? Math.min(...numbers) : Math.max(...numbers);
    }
    case "template": {
      if (typeof step.text !== "string" || step.text.length > 4000
        || (step.join !== undefined && (typeof step.join !== "string" || step.join.length > 100))) {
        throw new Error("模板内容或分隔符超出上限。");
      }
      const render = (row: unknown): string => step.text.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
        const value = property(row, path.trim());
        return value != null && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
      });
      return Array.isArray(input) ? array(input).map(render).join(step.join ?? "\n") : render(input);
    }
    default:
      throw new Error("这个流程步骤需要开发支持。");
  }
}

export function runWorkflow(input: unknown, steps: WorkflowStep[]): unknown {
  if (!Array.isArray(steps) || !steps.length || steps.length > 30) throw new Error("流程需要 1 至 30 步。");
  budget(input);
  let value = input;
  for (const step of steps) {
    value = runStep(value, step);
    budget(value);
  }
  return value;
}

export function checkWorkflow(steps: WorkflowStep[], examples: unknown): number {
  if (!Array.isArray(examples) || !examples.length || examples.length > 10) throw new Error("请提供 1 至 10 个验收样例。");
  for (const sample of examples) {
    if (!sample || typeof sample !== "object" || !Object.hasOwn(sample, "input") || !Object.hasOwn(sample, "expected")
      || !isDeepStrictEqual(runWorkflow(sample.input, steps), sample.expected)) {
      throw new Error("流程样例与预期结果不一致。");
    }
  }
  return examples.length;
}
