const REPOSITORY_PART = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const REGISTRY = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9]\d{0,4})?$/;
export const IMAGE_SHA256 = /^sha256:[a-f0-9]{64}$/;

export function dockerImageReference(value: string): { repository: string; digest?: string } | undefined {
  if (!value || value.length > 250) return;
  const digestMatch = /^(.+)@(sha256:[a-f0-9]{64})$/.exec(value);
  const tagMatch = digestMatch ? undefined : /^(.+):([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/.exec(value);
  const repository = digestMatch?.[1] ?? tagMatch?.[1];
  if (!repository || (tagMatch && /^(?:latest|main|master|stable|nightly|edge|dev|snapshot)$/i.test(tagMatch[2]!))) return;
  const parts = repository.split("/");
  const first = parts[0]!;
  if (parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost")) {
    if (!REGISTRY.test(first) || first.includes("..") || (first.includes(":") && Number(first.split(":")[1]) > 65535)) return;
    parts.shift();
  }
  if (!parts.length || !parts.every(part => REPOSITORY_PART.test(part))) return;
  return { repository, digest: digestMatch?.[2] };
}
