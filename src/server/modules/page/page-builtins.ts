import type { Database } from "bun:sqlite";
import type { AgentStore } from "../agent/agent-store.js";
import type { ManagerThreadService } from "../agent/manager-threads.js";
import type { CanvasStore } from "../canvas/canvas-store.js";
import type { WaitingOnUserDeps } from "../global/waiting-on-user.js";
import { buildActivitySummary } from "../activity/activity-summary.js";
import { featureStateFor, featureStateLine } from "../../../shared/feature-state.js";
import type { AgentPageAnswerDto, AgentPageBuiltin } from "../../../shared/api/agent-page.js";
import type { ThreadStatusSnapshotDto } from "../../../shared/api/thread-status.js";

/** How many days the usage source covers, and how many canvases it lists. */
const USAGE_DAYS = 14;
const CANVASES_MAX = 50;

export interface PageBuiltinDeps extends WaitingOnUserDeps {
  db: Database;
  agentStore: Pick<AgentStore, "getThreadByScope" | "getLatestWakeForThread" | "openGlobalThread" | "openQuestions">;
  managerThreads: Pick<ManagerThreadService, "list">;
  canvasStore: Pick<CanvasStore, "listAll">;
  /** What the user gave on the page, newest first. */
  answers?: () => AgentPageAnswerDto[];
  /** Each thread's state and what waits on the user, as the server last
   *  worked them out: the page reads what the sidebar and Home show. */
  statusSnapshot: () => ThreadStatusSnapshotDto;
}

const threadLink = (threadId: string) => `/threads/${encodeURIComponent(threadId)}`;
const workerLink = (threadId: string | null, featureId: string) =>
  (threadId ? `${threadLink(threadId)}?worker=${encodeURIComponent(featureId)}` : "/home");

/** A built-in source's value, read when asked: in the shapes the agent-page
 *  skill names, from what Mandate shows elsewhere (the thread list, Home,
 *  Activity, the canvases). */
export function readBuiltin(name: AgentPageBuiltin, deps: PageBuiltinDeps): unknown {
  switch (name) {
    case "threads": return readThreads(deps);
    case "workers": return readWorkers(deps);
    case "waiting": return readWaiting(deps);
    case "usage": return {
      days: buildActivitySummary(deps.db, USAGE_DAYS, "day").daily.map((day) => ({
        day: day.date, inputTokens: day.inputTokens, outputTokens: day.outputTokens, cacheReadTokens: day.cacheReadTokens, calls: day.calls
      }))
    };
    case "canvases": return deps.canvasStore.listAll(CANVASES_MAX).map((canvas) => ({
      id: canvas.id, title: canvas.title, kind: canvas.kind, updatedAt: canvas.updatedAt, link: `/canvas/${encodeURIComponent(canvas.id)}`
    }));
    case "questions": {
      const global = deps.agentStore.openGlobalThread();
      return global ? deps.agentStore.openQuestions(global.id).map((q) => ({ id: q.id, question: q.question, askedAt: q.askedAt })) : [];
    }
    case "answers": return deps.answers?.() ?? [];
  }
}

function readThreads(deps: PageBuiltinDeps) {
  const states = new Map(deps.statusSnapshot().threads.map((thread) => [thread.threadId, thread.state]));
  return deps.managerThreads.list().map((thread) => ({
    id: thread.id, title: thread.title, state: states.get(thread.id) ?? "idle", lastActivityAt: thread.lastActivityAt, link: threadLink(thread.id)
  }));
}

function readWorkers(deps: PageBuiltinDeps) {
  return deps.featuresStore.listAllActive().map((feature) => {
    const item = deps.workStore.getByFeature(feature.id);
    const plan = deps.planStore.get(feature.id);
    const worker = deps.agentStore.getThreadByScope("worker", feature.id);
    const running = worker ? deps.isBusy?.(worker.id) ?? false : false;
    const failure = { at: item?.failedAt ?? null, message: item?.failedMessage ?? null, kind: item?.failedKind ?? null };
    const line = featureStateLine(plan, failure, running);
    return {
      id: feature.id,
      name: feature.name,
      threadId: feature.ownerThreadId ?? null,
      state: featureStateFor(plan, failure.at, failure.kind, running),
      line: [line.lead, line.text].filter(Boolean).join(" "),
      link: workerLink(feature.ownerThreadId ?? null, feature.id)
    };
  });
}

/** Home's list, its kind carried as data, without Your agent's own
 *  questions (they are the "questions" source). */
function readWaiting(deps: PageBuiltinDeps) {
  return deps.statusSnapshot().waiting.flatMap((entry) => {
    if (entry.kind === "agent") return [];
    const link = entry.kind === "worker" ? workerLink(entry.threadId, entry.featureId ?? "") : entry.threadId ? threadLink(entry.threadId) : "/home";
    return [{ waiting: entry.waiting, title: entry.threadTitle ?? entry.workerName ?? "", text: entry.text, link }];
  });
}
