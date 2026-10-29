import type { AgentMessage, AgentStore } from "../modules/agent/agent-store.js";
import type { FeaturesStore } from "../modules/features/features-store.js";
import type { ProjectsStore } from "../modules/projects/projects-store.js";
import { extractFromWindow, type ExtractionProject, type ExtractionTrigger, type ExtractionWorker, type WindowExtractionInput } from "../modules/memory/extraction.js";
import { errorText } from "../../shared/error-text.js";
import { SSE_EVENTS } from "../../shared/api-contracts.js";
import type { AgentSseEmitter } from "../modules/sse/sse-events.js";

interface Deps {
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
}

/** What a window hands to extraction, or null when its thread has none left.
 *  Its memories may go — for a worker: its own project, and its task record;
 *  a manager thread: every active project, the ones it has had workers in
 *  first, most recent first; the global agent: every active project; a
 *  subagent's thread: nowhere (it gives none). Its
 *  messages are read as stored: compression keeps a user turn too large to
 *  retain whole as a shortened copy, and extraction reads the whole words. */
export function windowExtraction(
  threadId: string,
  messages: AgentMessage[],
  deps: Deps
): { messages: AgentMessage[]; projects: ExtractionProject[]; worker: ExtractionWorker | null } | null {
  const target = extractionTarget(threadId, deps);
  if (!target) return null;
  const stored = messages.map((message) =>
    message.content.type === "text" ? deps.agentStore.getMessageById(message.id) ?? message : message);
  return { messages: stored, ...target };
}

function extractionTarget(
  threadId: string,
  deps: Deps
): { projects: ExtractionProject[]; worker: ExtractionWorker | null } | null {
  const thread = deps.agentStore.getThreadById(threadId);
  // Archiving hands the whole window over first, so a closed window has
  // nothing left: a compression finishing after it would hand part of it over again.
  if (!thread || thread.archivedAt) return null;
  const active = deps.projectsStore.listActive().map((p) => ({ id: p.id, name: p.name }));
  if (thread.scope === "worker") {
    const feature = thread.scopeId ? deps.featuresStore.getById(thread.scopeId) : null;
    const project = feature ? deps.projectsStore.getById(feature.projectId) : null;
    if (!feature || feature.archivedAt || !project) return null;
    return {
      projects: [{ id: project.id, name: project.name }],
      worker: { featureId: feature.id, projectId: project.id, name: feature.name }
    };
  }
  if (thread.scope === "manager") {
    const owned = [...deps.featuresStore.listActiveOwnedBy(threadId), ...deps.featuresStore.listArchivedOwnedBy(threadId)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const first = [...new Set(owned.map((f) => f.projectId))];
    const ordered = [
      ...first.map((id) => active.find((p) => p.id === id)).filter((p): p is ExtractionProject => Boolean(p)),
      ...active.filter((p) => !first.includes(p.id))
    ];
    return { projects: ordered, worker: null };
  }
  if (thread.scope === "global") return { projects: active, worker: null };
  // A subagent's window is its parent's handover, already in the parent's
  // window, and what it did with it, which reaches the parent as its
  // result: nothing of the user's to remember.
  return null;
}

/**
 * Memories from the messages leaving a model's context, in the background on
 * memory extraction's route: nothing waits on it, and a failure (every model
 * on the route) is only logged. Each message leaves once — compression hands
 * over the hidden ones, archive the active ones — so each is read once.
 * Extractions run one at a time, in the order asked for. A thread's
 * extractions are counted from the moment one is asked for until it ends
 * (`inFlight`), its wait included: its call is recorded against the thread.
 */
export function createWindowExtractor(deps: Deps & {
  memory: WindowExtractionInput["memory"];
  records: WindowExtractionInput["records"];
  /** Memory extraction's route, with memory repeat check's, read when a window is handed over. */
  route: () => Pick<WindowExtractionInput, "candidates" | "repeatCheck">;
  /** Read when a window is handed over: the config can be reloaded. */
  budgetTokens: () => number;
  /** Tells the page a worker's task record was written (its Plan tab's row). */
  sse: Pick<AgentSseEmitter, "emit">;
}): {
  extractWindow(threadId: string, trigger: ExtractionTrigger, messages: AgentMessage[]): void;
  inFlight(threadId: string): boolean;
} {
  const inFlight = new Map<string, number>();
  // One at a time, in the order asked for: an extraction reads what memory
  // holds when it starts (the recent memories it may rewrite, the repeat
  // check's neighbours), so two at once each missed what the other wrote.
  let turn: Promise<unknown> = Promise.resolve();
  const extractInBackground = (threadId: string, label: string, extract: () => Promise<unknown>) => {
    inFlight.set(threadId, (inFlight.get(threadId) ?? 0) + 1);
    const run = turn.then(extract);
    turn = run.catch(() => {});
    void run.catch((err) => {
      const msg = errorText(err);
      console.warn(`[mandate] memory ${label} extraction failed: ${msg}`);
    }).finally(() => {
      const left = (inFlight.get(threadId) ?? 1) - 1;
      if (left > 0) inFlight.set(threadId, left);
      else inFlight.delete(threadId);
    });
  };
  return {
    extractWindow(threadId, trigger, messages) {
      const window = windowExtraction(threadId, messages, deps);
      if (!window || window.messages.length === 0) return;
      // The route and budget as they are at hand-over, however long it waits.
      const route = deps.route();
      const budgetTokens = deps.budgetTokens();
      extractInBackground(threadId, trigger, async () => {
        const result = await extractFromWindow({
          memory: deps.memory,
          records: deps.records,
          ...route,
          trigger,
          threadId,
          ...window,
          budgetTokens
        });
        if (result.taskRecord && window.worker) deps.sse.emit(SSE_EVENTS.featureRecordUpdated, { featureId: window.worker.featureId });
        return result;
      });
    },
    inFlight: (threadId) => inFlight.has(threadId)
  };
}
