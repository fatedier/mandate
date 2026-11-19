import type { ThreadLabelDto } from "../../../shared/api/agents.js";
import { LABEL_REFUSED, labelKey, labelName } from "../../../shared/labels.js";
import type { AgentStore } from "./agent-store.js";

/** A label change that is refused, in words its asker reads. */
export class ThreadLabelRefusal extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message);
  }
}

interface ThreadLabelsDeps {
  agentStore: Pick<AgentStore, "getThreadById" | "transaction" | "threadLabels" | "threadLabelSpelling" | "putThreadLabel" | "removeThreadLabel">;
  /** After a thread's labels changed: whoever shows the thread is told. */
  publish?: (threadId: string) => void;
  /** The spelling the task board has for a name, on any task. */
  taskLabelSpelling?: (name: string) => string | null;
  now?: () => number;
}

/**
 * The labels of manager threads, open or archived: free names the owner or
 * the personal agent puts on a thread to sort and filter by. A thread has
 * each name once whatever its case, and a name already in use (on a thread
 * or on a task) keeps the spelling it has. The owner putting on a label the
 * agent added makes it theirs; the agent putting on one that is there
 * changes nothing.
 */
export class ThreadLabels {
  constructor(private readonly deps: ThreadLabelsDeps) {}

  add(threadId: string, name: string, by: ThreadLabelDto["by"]): ThreadLabelDto[] {
    this.thread(threadId);
    const trimmed = labelName(name);
    if (trimmed === null) throw new ThreadLabelRefusal(LABEL_REFUSED);
    const store = this.deps.agentStore;
    const spelling = store.threadLabelSpelling(trimmed) ?? this.deps.taskLabelSpelling?.(trimmed) ?? trimmed;
    const changed = store.transaction(() => {
      const had = store.threadLabels(threadId).find((label) => labelKey(label.name) === labelKey(spelling));
      if (had && (had.by === by || by === "agent")) return false;
      store.putThreadLabel(threadId, had?.name ?? spelling, by, new Date(this.deps.now?.() ?? Date.now()).toISOString());
      return true;
    });
    if (changed) this.deps.publish?.(threadId);
    return store.threadLabels(threadId);
  }

  remove(threadId: string, name: string): ThreadLabelDto[] {
    this.thread(threadId);
    const trimmed = name.trim();
    if (!this.deps.agentStore.removeThreadLabel(threadId, trimmed)) throw new ThreadLabelRefusal(`That thread has no label "${trimmed}".`);
    this.deps.publish?.(threadId);
    return this.deps.agentStore.threadLabels(threadId);
  }

  private thread(threadId: string): void {
    const thread = this.deps.agentStore.getThreadById(threadId);
    if (!thread || thread.scope !== "manager") throw new ThreadLabelRefusal(`No such thread: ${threadId}.`, 404);
  }
}
