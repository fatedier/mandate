import type { AgentStore } from "./agent-store.js";
import { MENTION_LIMIT, mentionLabel, type Mention } from "../../../shared/mentions.js";

export interface MentionDeps {
  agentStore: Pick<AgentStore, "getThreadById">;
}

/** Each kind of mention: whether an id may be named in a conversation, and
 *  the line the model reads for it. A kind added later is one entry here
 *  (and its source in the composer). */
const KINDS: Record<string, {
  valid(deps: MentionDeps, conversationThreadId: string, id: string): boolean;
  modelLine(mention: Mention): string;
}> = {
  thread: {
    // An open manager thread, not the conversation the message goes to.
    valid: (deps, conversationThreadId, id) => {
      if (id === conversationThreadId) return false;
      const thread = deps.agentStore.getThreadById(id);
      return Boolean(thread && thread.scope === "manager" && !thread.archivedAt);
    },
    modelLine: (m) => `[Mentioned thread "${m.label}", threadId ${m.id}; read it with read_thread]`
  }
};

/** The registry's own entry for a kind: one an object inherits
 *  ("toString", "__proto__") is no kind. */
function kindOf(kind: string): (typeof KINDS)[string] | undefined {
  return Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined;
}

/** The mentions a sent message may carry: well formed, of a known kind, valid
 *  for its conversation, at most MENTION_LIMIT. The rest are dropped without
 *  a word: the message still goes. */
export function resolveMentions(deps: MentionDeps, conversationThreadId: string, raw: unknown): Mention[] {
  if (!Array.isArray(raw)) return [];
  const kept: Mention[] = [];
  for (const entry of raw) {
    if (kept.length >= MENTION_LIMIT) break;
    if (!entry || typeof entry !== "object") continue;
    const { kind, id, label } = entry as { kind?: unknown; id?: unknown; label?: unknown };
    if (typeof kind !== "string" || typeof id !== "string" || !id || typeof label !== "string") continue;
    const oneLine = mentionLabel(label);
    const known = kindOf(kind);
    if (!oneLine || !known?.valid(deps, conversationThreadId, id)) continue;
    kept.push({ kind, id, label: oneLine });
  }
  return kept;
}

/** The line the model reads for each mention, before the user's words. */
export function mentionModelLines(mentions: readonly Mention[]): string {
  return mentions.map((m) => {
    const known = kindOf(m.kind);
    return known ? `${known.modelLine(m)}\n` : "";
  }).join("");
}
