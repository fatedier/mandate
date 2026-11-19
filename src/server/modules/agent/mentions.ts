import type { TaskBoardService } from "../task-board/task-board-service.js";
import { renderTaskBlock } from "../task-board/task-text.js";
import { localTimeZone } from "../../platform/time/agent-time.js";
import type { AgentStore } from "./agent-store.js";
import type { CanvasStore } from "../canvas/canvas-store.js";
import { MENTION_LIMIT, mentionLabel, type Mention } from "../../../shared/mentions.js";

export interface MentionDeps {
  agentStore: Pick<AgentStore, "getThreadById">;
  /** Without it no canvas is mentioned. */
  canvases?: Pick<CanvasStore, "getById">;
  /** Without it no task is mentioned. */
  taskBoard?: Pick<TaskBoardService, "detail">;
  /** The personal agent's name, as a task's comments name it. */
  agentName?: () => string;
  timeZone?: () => string;
  now?: () => number;
}

/** A task as the conversation's reader gets it: the personal agent the
 *  comments it has not answered, a manager the latest. */
function taskText(deps: MentionDeps, conversationThreadId: string, id: string): string | undefined {
  const task = deps.taskBoard?.detail(id);
  if (!task) return undefined;
  const reader = deps.agentStore.getThreadById(conversationThreadId)?.scope === "personal" ? "personal" : "manager";
  return renderTaskBlock(task, reader, {
    timeZone: deps.timeZone?.() ?? localTimeZone(), now: deps.now?.() ?? Date.now(),
    agentName: deps.agentName?.() ?? "the personal agent", max: TASK_MENTION_MAX_CHARS
  });
}

/** How much of a task one mention carries; the rest is cut with a marker. */
const TASK_MENTION_MAX_CHARS = 8_000;

/** Each kind of mention: whether an id may be named in a conversation, and
 *  the line the model reads for it. A kind added later is one entry here
 *  (and its source in the composer). */
const KINDS: Record<string, {
  valid(deps: MentionDeps, conversationThreadId: string, id: string): boolean;
  modelLine(mention: Mention): string;
  /** What the model reads, captured when the message is sent: a kind whose
   *  thing changes after, so the conversation the model sees does not. */
  capture?(deps: MentionDeps, conversationThreadId: string, id: string): string | undefined;
}> = {
  thread: {
    // An open manager thread, not the conversation the message goes to.
    valid: (deps, conversationThreadId, id) => {
      if (id === conversationThreadId) return false;
      const thread = deps.agentStore.getThreadById(id);
      return Boolean(thread && thread.scope === "manager" && !thread.archivedAt);
    },
    modelLine: (m) => `[Mentioned thread "${m.label}", threadId ${m.id}; read it with read_thread]`
  },
  canvas: {
    // A canvas that is there: the personal agent and a manager read every one.
    valid: (deps, _conversationThreadId, id) => Boolean(deps.canvases?.getById(id)),
    modelLine: (m) => `[Mentioned canvas "${m.label}", canvasId ${m.id}; read it with canvas (action read)]`
  },
  task: {
    // A task on the board, not deleted: managers have no tool to read one,
    // so the mention carries it.
    valid: (deps, _conversationThreadId, id) => {
      const task = deps.taskBoard?.detail(id);
      return Boolean(task && !task.deletedAt);
    },
    modelLine: (m) => m.text ?? `[Task "${m.label}" (${m.id})]`,
    capture: taskText
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
    const text = known.capture?.(deps, conversationThreadId, id);
    kept.push({ kind, id, label: oneLine, ...(text !== undefined ? { text } : {}) });
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
