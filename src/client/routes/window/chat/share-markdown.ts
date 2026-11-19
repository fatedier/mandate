import type { ShareItem } from "./share-selection";

/** The picked rows as Markdown, a blank line between: the user's words after
 *  "**You:** ", a reply as it was written, and a "…" paragraph where rows
 *  were left out. */
export function shareMarkdown(items: readonly ShareItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.skipBefore) parts.push("…");
    const text = item.text.trim();
    parts.push(item.side === "user" ? `**You:** ${text}` : text);
  }
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`;
}
