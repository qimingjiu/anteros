/**
 * Remove MiniMax's legacy inline reasoning prefix from user-facing content.
 * Only a leading protocol block is recognized; quoted examples and tags in an
 * ordinary answer must remain untouched. The caller retains the raw response
 * separately when the provider needs it for tool-call replay.
 */
export function stripLeadingThinkBlocks(content: string): string {
  const openingTag = /<\s*think\s*>/iy;
  const tag = /<\s*(\/\s*)?think\s*>/gi;
  const whitespace = /\s/;
  let cursor = 0;
  let removed = false;

  const skipWhitespace = () => {
    while (cursor < content.length && whitespace.test(content[cursor]!)) cursor++;
  };

  skipWhitespace();
  while (cursor < content.length) {
    openingTag.lastIndex = cursor;
    if (!openingTag.test(content)) break;

    removed = true;
    let depth = 1;
    tag.lastIndex = openingTag.lastIndex;
    let token: RegExpExecArray | null;
    while ((token = tag.exec(content)) !== null) {
      depth += token[1] ? -1 : 1;
      if (depth === 0) break;
    }

    // A truncated reasoning block has no safely identifiable visible answer.
    if (depth !== 0) return "";
    cursor = tag.lastIndex;
    skipWhitespace();
  }

  return removed ? content.slice(cursor) : content;
}
