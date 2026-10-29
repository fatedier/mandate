import type { AgentStore } from "../agent/agent-store.js";
import type { FeatureRow, FeaturesStore } from "../features/features-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { ProjectRow } from "./projects-store.js";
import { SSE_EVENTS } from "../../../shared/api/sse.js";
import { projectChangeMetadata } from "../../../shared/project-change.js";

interface WorkingDirNoteDeps {
  agentStore: Pick<AgentStore, "getThreadByScope" | "getThreadById" | "appendMessage" | "enqueueMailboxMessage">;
  features: Pick<FeaturesStore, "listActiveByProject">;
  sse: Pick<AgentSseEmitter, "emit">;
  /** The conversation runs a turn: a note then waits for its next step. */
  isThreadBusy: (threadId: string) => boolean;
}

const quoted = (names: string[]) => names.length === 1
  ? `"${names[0]}"`
  : `${names.slice(0, -1).map((name) => `"${name}"`).join(", ")} and "${names.at(-1)}"`;

function changed(project: ProjectRow, from: string): string {
  return `[Project change] The user changed the working directory of project "${project.name}" from ${from} to ${project.workingDir}.`;
}

/**
 * A project's working directory changed: each worker that works in it (not
 * in a worktree of its own) is told, and so is its manager, once for all of
 * its workers there. Their shells and tools follow the project at once, but
 * what already runs in their panes stays where it was. A note, not a
 * request: it wakes nobody. Resting, it lands now, where the user sees it;
 * mid-turn it waits in the mailbox for the next step.
 */
export function noteWorkingDirChanged(deps: WorkingDirNoteDeps, input: { project: ProjectRow; from: string }): void {
  const { project, from } = input;
  const inProject = deps.features.listActiveByProject(project.id).filter((feature) => feature.mode === "shared-cwd");
  const metadata = projectChangeMetadata({ projectId: project.id, projectName: project.name, from, to: project.workingDir });
  const byManager = new Map<string, FeatureRow[]>();
  for (const feature of inProject) {
    const chat = deps.agentStore.getThreadByScope("worker", feature.id);
    if (chat && !chat.archivedAt) {
      deliver(deps, chat.id, `${changed(project, from)} Your shell and file tools start in ${project.workingDir} from now on; ` +
        `panes already open in your window keep running in ${from} until they are restarted.`, metadata);
    }
    if (feature.ownerThreadId) byManager.set(feature.ownerThreadId, [...(byManager.get(feature.ownerThreadId) ?? []), feature]);
  }
  for (const [threadId, workers] of byManager) {
    const thread = deps.agentStore.getThreadById(threadId);
    if (!thread || thread.scope !== "manager" || thread.archivedAt) continue;
    const one = workers.length === 1;
    deliver(deps, threadId, `${changed(project, from)} ${one ? "Worker" : "Workers"} ${quoted(workers.map((w) => w.name).sort())} ` +
      `${one ? "works" : "work"} in the project directory: panes already open in ${one ? "its window" : "their windows"} ` +
      `keep running in ${from} until they are restarted.`, metadata);
  }
}

function deliver(deps: WorkingDirNoteDeps, threadId: string, text: string, metadata: Record<string, unknown>): void {
  const content = { type: "text" as const, text, metadata };
  if (deps.isThreadBusy(threadId)) {
    deps.agentStore.enqueueMailboxMessage({ threadId, role: "user", source: "project-change", content, triggerTurn: false });
    return;
  }
  const message = deps.agentStore.appendMessage({ threadId, role: "user", source: "project-change", content });
  deps.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId, message });
}
