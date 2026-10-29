import type { AgentMessage, AgentStore } from "./agent-store.js";
import { sha256 } from "../../platform/crypto/hash.js";

/** The scheduler's deps the context upkeep uses. Read at each use, not kept:
 *  the scheduler hands over its own deps object, which a test may change
 *  after the scheduler is built. */
export interface WakeRuntimeContextDeps {
  agentStore: AgentStore;
  buildSystemPrompt: (threadId: string) => string | Promise<string>;
  buildInitialContext?: (threadId: string) => string | null | Promise<string | null>;
  buildTasksContext?: (threadId: string) => string | null | Promise<string | null>;
  buildRuntimeContext?: (threadId: string) => string | null | Promise<string | null>;
  /** Whether a thread's digest updates are sent as the changes since its
   *  window's last full digest (Your agent's, whose digest is large and
   *  changes a little at a time). Absent or false: the whole digest. */
  contextChangesOnly?: (threadId: string) => boolean;
}

interface WakeRuntimeContextState {
  messageAppended: boolean;
}

/** A thread's system message and its context messages ([initial_context],
 *  then [runtime_context] updates), kept in the prompt before each step.
 *  Begun and ended around each wake, which updates the context at most once. */
export class WakeRuntimeContext {
  private readonly stateByWake = new Map<string, WakeRuntimeContextState>();

  constructor(private readonly deps: WakeRuntimeContextDeps) {}

  begin(wakeId: string): void {
    this.stateByWake.set(wakeId, { messageAppended: false });
  }

  end(wakeId: string): void {
    this.stateByWake.delete(wakeId);
  }

  async ensurePromptContextMessages(threadId: string, wakeId: string): Promise<void> {
    if (!this.deps.agentStore.getSystemMessage(threadId)) {
      const systemPrompt = await this.deps.buildSystemPrompt(threadId);
      this.deps.agentStore.ensureSystemMessage(threadId, systemPrompt);
    }

    const active = this.deps.agentStore.getActiveMessages(threadId);
    const stateBody = renderContextBody(await this.runtimeStateParts(threadId));
    const stateHash = stateBody ? sha256(contextFingerprint(stateBody)) : "";
    const latest = latestRuntimeContextMessage(active);
    if (!latest) {
      await this.appendInitialContext(threadId, wakeId, stateBody, stateHash);
      return;
    }

    if (!stateBody) return;
    if (runtimeStateHash(latest) === stateHash) return;
    const wakeContext = this.stateByWake.get(wakeId);
    // One update per wake keeps the prompt cache steady.
    if (wakeContext?.messageAppended) return;
    const changes = this.deps.contextChangesOnly?.(threadId) ? changesSinceFullDigest(active, stateBody) : null;
    if (changes !== null) this.appendChangesMessage(threadId, wakeId, changes, stateHash);
    else this.appendContextMessage(threadId, wakeId, "update", stateBody, stateHash);
    if (wakeContext) wakeContext.messageAppended = true;
  }

  private appendChangesMessage(threadId: string, wakeId: string, changes: string, stateHash: string): void {
    const text = renderChangesMessage(changes);
    this.deps.agentStore.appendMessage({
      threadId,
      role: "user",
      source: "runtime-context",
      wakeId,
      content: {
        type: "text",
        text,
        metadata: {
          runtimeContextHash: sha256(text),
          runtimeStateHash: stateHash,
          runtimeContextKind: "update",
          runtimeContextMode: CHANGES_MODE,
          runtimeChangesChars: changes.length
        }
      }
    });
  }

  /** What the runtime context says now: the scope's own context. */
  private async runtimeStateParts(threadId: string): Promise<string[]> {
    const scopeContext = await this.deps.buildRuntimeContext?.(threadId);
    return scopeContext?.trim() ? [scopeContext.trim()] : [];
  }

  /** A thread's first context: its initial context, then the state. */
  private async appendInitialContext(threadId: string, wakeId: string, stateBody: string, stateHash: string): Promise<void> {
    const initialParts: string[] = [];
    const initialContext = await this.deps.buildInitialContext?.(threadId);
    if (initialContext?.trim()) initialParts.push(initialContext.trim());
    const tasks = await this.deps.buildTasksContext?.(threadId);
    if (tasks?.trim()) initialParts.push(tasks.trim());
    if (stateBody) initialParts.push(stateBody);
    const initialBody = renderContextBody(initialParts);
    if (!initialBody) return;
    this.appendContextMessage(threadId, wakeId, "initial", initialBody, stateHash, stateBody);
    const wakeContext = this.stateByWake.get(wakeId);
    if (wakeContext) wakeContext.messageAppended = true;
  }

  private appendContextMessage(
    threadId: string,
    wakeId: string,
    kind: "initial" | "update",
    body: string,
    stateHash: string,
    /** The digest this message holds, kept for the changes after it. */
    stateBody: string = body
  ): void {
    const text = kind === "initial"
      ? renderInitialContextMessage(body)
      : renderRuntimeContextMessage(body);
    this.deps.agentStore.appendMessage({
      threadId,
      role: "user",
      source: "runtime-context",
      wakeId,
      content: {
        type: "text",
        text,
        metadata: {
          runtimeContextHash: sha256(text),
          runtimeStateHash: stateHash,
          runtimeContextKind: kind,
          runtimeContextMode: "compact",
          ...(stateBody ? { runtimeStateBody: stateBody } : {})
        }
      }
    });
  }
}

/** Which context message a message is, read back from the kind
 *  appendContextMessage wrote. Null for any other message. */
export function runtimeContextKind(message: AgentMessage): "initial" | "update" | null {
  if (message.source !== "runtime-context") return null;
  if (message.content.type !== "text") return "update";
  return message.content.metadata?.runtimeContextKind === "initial" ? "initial" : "update";
}

function latestRuntimeContextMessage(messages: AgentMessage[]): AgentMessage | null {
  return [...messages].reverse().find((message) =>
    message.role === "user"
    && message.source === "runtime-context"
    && message.content.type === "text"
  ) ?? null;
}

function runtimeStateHash(message: AgentMessage): unknown {
  if (message.content.type !== "text") return null;
  return message.content.metadata?.runtimeStateHash ?? null;
}

function renderContextBody(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}

function renderInitialContextMessage(body: string): string {
  const text = body.trim();
  if (!text) return "";
  return [
    "[initial_context]",
    "Baseline capabilities and compact starting context for this prompt window. Later runtime_context entries are append-only compact digests; use tools for authoritative current state. Capability manifests remain valid until a newer initial_context appears.",
    "",
    text
  ].join("\n");
}

function renderRuntimeContextMessage(body: string): string {
  const text = body.trim();
  if (!text) return "";
  return [
    "[runtime_context]",
    "Compact routing digest, not a conversation event and not authoritative state. This message is append-only; use tools for exact current state.",
    "",
    text
  ].join("\n");
}

const CHANGES_MODE = "changes";

/** What changed since the window's last full digest, to send in place of the
 *  whole: null when there is no full digest to read it against (none kept
 *  beside it by this version), or when the changed lines sent since it, these
 *  included, would outweigh it (a full digest is then due). Measured from the
 *  full digest, never from the last changes: the latest changes and that
 *  digest are the state. */
function changesSinceFullDigest(active: AgentMessage[], stateBody: string): string | null {
  let sent = 0;
  for (let i = active.length - 1; i >= 0; i--) {
    const message = active[i]!;
    if (message.source !== "runtime-context" || message.content.type !== "text") continue;
    const metadata = message.content.metadata;
    if (metadata?.runtimeContextMode === CHANGES_MODE) {
      sent += typeof metadata.runtimeChangesChars === "number" ? metadata.runtimeChangesChars : 0;
      continue;
    }
    const base = metadata?.runtimeStateBody;
    if (typeof base !== "string" || !base) return null;
    const changes = renderStateChanges(base, stateBody);
    return changes === null || sent + changes.length > base.length ? null : changes;
  }
  return null;
}

/** The lines added ("+") or gone ("-") between two digests, under the
 *  heading of the section they are in; a line's own bullet is left off.
 *  Lines are counted, so a line repeated counts each time. Empty when they
 *  say the same; null when changes cannot say it (a heading with nothing
 *  under it came or went), and the whole digest is due. */
export function renderStateChanges(before: string, after: string): string | null {
  const old = digestSections(before);
  const now = digestSections(after);
  // A heading that repeats (the notes may reuse one) leaves the section a line is in unclear.
  if (!old || !now) return null;
  const bare = (heading: string, sections: Map<string, string[]>, other: Map<string, string[]>) =>
    !other.has(heading) && (sections.get(heading)?.length ?? 0) === 0;
  if ([...old.keys()].some((heading) => bare(heading, old, now)) || [...now.keys()].some((heading) => bare(heading, now, old))) return null;
  const headings = [...now.keys(), ...[...old.keys()].filter((heading) => !now.has(heading))];
  const blocks: string[] = [];
  for (const heading of headings) {
    const gone = minus(old.get(heading) ?? [], now.get(heading) ?? []);
    const added = minus(now.get(heading) ?? [], old.get(heading) ?? []);
    if (gone.length === 0 && added.length === 0) continue;
    blocks.push([
      ...(heading ? [heading] : []),
      ...gone.map((line) => `- ${unbulleted(line)}`),
      ...added.map((line) => `+ ${unbulleted(line)}`)
    ].join("\n"));
  }
  return blocks.join("\n\n");
}

/** A digest's lines by section: each "## " heading's non-empty lines, and
 *  those before any heading under ""; null when a heading repeats. */
function digestSections(digest: string): Map<string, string[]> | null {
  const sections = new Map<string, string[]>();
  let heading = "";
  for (const raw of digest.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) {
      if (sections.has(line)) return null;
      heading = line;
      sections.set(heading, []);
      continue;
    }
    if (!line.trim()) continue;
    const lines = sections.get(heading) ?? [];
    lines.push(line);
    sections.set(heading, lines);
  }
  return sections;
}

/** The lines of `a` not matched one for one by a line of `b`, in `a`'s order. */
function minus(a: readonly string[], b: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const line of b) left.set(line, (left.get(line) ?? 0) + 1);
  return a.filter((line) => {
    const n = left.get(line) ?? 0;
    if (n === 0) return true;
    left.set(line, n - 1);
    return false;
  });
}

function unbulleted(line: string): string {
  return line.startsWith("- ") ? line.slice(2) : line;
}

function renderChangesMessage(changes: string): string {
  return [
    "[runtime_context update]",
    "Changes since the last full digest above, by section: \"+\" lines are new or changed, \"-\" lines are gone or replaced; lines not listed stand as that digest has them. Not authoritative state; use tools for exact current state.",
    ...(changes ? ["", changes] : [])
  ].join("\n");
}

function contextFingerprint(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
