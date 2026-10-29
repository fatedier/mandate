import type { AgentMessageContent } from "./agent-message-types.js";

/** One thing a message names beside its words, written into it as
 *  `@<label>`: by its kind (only "thread" so far) and its id, so the agent
 *  acts on exactly that one. The label is the words the user's text holds. */
export interface Mention {
  kind: string;
  id: string;
  label: string;
}

/** At most this many mentions go with one message. */
export const MENTION_LIMIT = 10;

const LABEL_MAX_CHARS = 120;
/** Whitespace, and every control character: the label is one line in the
 *  model's text whatever a client sent (NEXT LINE and the C1 range are not
 *  whitespace to \s). */
const LABEL_BREAKS = /[\s\x00-\x1f\x7f-\x9f]+/g;

/** The label a mention of `title` carries: on one line, at most 120
 *  characters (whole ones: an emoji is never halved). The composer writes it
 *  and the server keeps it, so the words in the text are the label the
 *  message stores. */
export function mentionLabel(title: string): string {
  const oneLine = title.replace(LABEL_BREAKS, " ").trim();
  return Array.from(oneLine).slice(0, LABEL_MAX_CHARS).join("").trimEnd();
}

const MENTIONS_KEY = "mentions";

export function mentionsMetadata(mentions: readonly Mention[]): Record<string, unknown> {
  return { [MENTIONS_KEY]: mentions.map((m) => ({ kind: m.kind, id: m.id, label: m.label })) };
}

/** The mentions a message carries; malformed entries are left out. */
export function mentionsOf(content: AgentMessageContent): Mention[] {
  if (content.type !== "text") return [];
  const raw = content.metadata?.[MENTIONS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { kind, id, label } = entry as { kind?: unknown; id?: unknown; label?: unknown };
    return typeof kind === "string" && kind && typeof id === "string" && id && typeof label === "string" && label
      ? [{ kind, id, label }]
      : [];
  });
}

/** A message's text cut at its mentions, left to right: each mention is
 *  taken, in order, at the next `@<label>` after the last one; one not
 *  written further on is skipped. */
export function splitMentions(text: string, mentions: readonly Mention[]): Array<string | Mention> {
  const parts: Array<string | Mention> = [];
  let cursor = 0;
  for (const mention of mentions) {
    const token = `@${mention.label}`;
    const at = text.indexOf(token, cursor);
    if (at < 0) continue;
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(mention);
    cursor = at + token.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
