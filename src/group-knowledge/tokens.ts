/** FTS5's unicode61 alone treats a whole Chinese sentence as one token. */
export function groupSearchTokens(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.slice(0, 64_000).normalize("NFKC").toLocaleLowerCase("en-US");
  const tokens = new Set<string>();
  for (const match of text.matchAll(/\p{Script=Han}+/gu)) {
    const chars = [...match[0]];
    for (let index = 0; index < chars.length; index++) {
      tokens.add(chars[index]!);
      if (index + 1 < chars.length) tokens.add(chars[index]! + chars[index + 1]!);
    }
  }
  for (const match of text.replace(/\p{Script=Han}+/gu, " ").matchAll(/[\p{L}\p{N}_]+/gu)) tokens.add(match[0]);
  return [...tokens].join(" ");
}

/** User text is always reduced to quoted literal tokens, never FTS operators. */
export function groupSearchMatch(query: string): string {
  const text = [...query.trim().normalize("NFKC")].slice(0, 120).join("");
  if (!text) return "";
  const all = groupSearchTokens(text).split(" ").filter(Boolean);
  // Bigrams are selective; single Chinese characters are needed only for single-character terms.
  const bigramCharacters = new Set(all.filter(token => /^\p{Script=Han}{2}$/u.test(token)).flatMap(token => [...token]));
  const tokens = all.filter(token => !(/^\p{Script=Han}$/u.test(token) && bigramCharacters.has(token)));
  return tokens.slice(0, 32).map(token => `"${token.replace(/"/g, '""')}"`).join(" AND ");
}
