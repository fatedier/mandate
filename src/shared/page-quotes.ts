import type { AgentMessageContent } from "./agent-message-types.js";

/** An item of the personal agent's page the user quoted in the chat: the
 *  page it is on (its path in the page's folder) and what it says. */
export interface PageQuote {
  path: string;
  text: string;
}

/** How many items a message may quote, and how long each may be. */
export const PAGE_QUOTES_MAX = 3;
export const PAGE_QUOTE_MAX_CHARS = 500;
const PAGE_QUOTE_PATH_MAX_CHARS = 1024;

const PAGE_QUOTES_KEY = "pageQuotes";

/** A quote's text as it is kept: on one line, its whitespace folded, cut to
 *  the limit by characters (never inside one). */
export function foldPageQuote(text: string): string {
  const folded = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(folded);
  return chars.length > PAGE_QUOTE_MAX_CHARS ? chars.slice(0, PAGE_QUOTE_MAX_CHARS).join("").trimEnd() : folded;
}

/** The quotes a message may carry, from what was sent or kept: each one
 *  folded, empty ones and ones of the wrong shape left out, the same one
 *  once, and no more than the limit. */
export function readPageQuotes(raw: unknown): PageQuote[] {
  if (!Array.isArray(raw)) return [];
  const kept: PageQuote[] = [];
  for (const entry of raw) {
    if (kept.length >= PAGE_QUOTES_MAX) break;
    if (!entry || typeof entry !== "object") continue;
    const { path, text } = entry as { path?: unknown; text?: unknown };
    if (typeof path !== "string" || !path || path.length > PAGE_QUOTE_PATH_MAX_CHARS || typeof text !== "string") continue;
    const folded = foldPageQuote(text);
    if (!folded || kept.some((q) => q.path === path && q.text === folded)) continue;
    kept.push({ path, text: folded });
  }
  return kept;
}

export function pageQuotesMetadata(quotes: readonly PageQuote[]): Record<string, unknown> {
  return { [PAGE_QUOTES_KEY]: quotes.map((q) => ({ path: q.path, text: q.text })) };
}

/** The page's items a user's message quotes, above its words. */
export function pageQuotesOf(content: AgentMessageContent): PageQuote[] {
  return content.type === "text" ? readPageQuotes(content.metadata?.[PAGE_QUOTES_KEY]) : [];
}
