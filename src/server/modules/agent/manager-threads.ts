import type { AgentStore, AgentWake } from "./agent-store.js";
import { OUTPUT_LIMIT_STOPPED } from "./output-limit.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { ManagerThreadDto, ThreadWorkerRefDto } from "../../../shared/api/agents.js";
import type { FeaturesStore } from "../features/features-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";

const FALLBACK_TITLE_CHARS = 60;
const MAX_TITLE_CHARS = 80;

/** One line, trimmed, 1–80 characters; null otherwise. */
export function normalizeThreadTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const title = raw.replace(/\s+/g, " ").trim();
  if (title.length === 0 || title.length > MAX_TITLE_CHARS) return null;
  return title;
}

/** The workers a thread owns: its active ones, or with `archived` its
 *  archived ones, newest first. */
export function threadWorkerRefs(
  deps: { features: Pick<FeaturesStore, "listActiveOwnedBy" | "listArchivedOwnedBy">; projects: Pick<ProjectsStore, "getById">; agentStore: Pick<AgentStore, "latestMainThreadId"> },
  threadId: string,
  archived: boolean
): ThreadWorkerRefDto[] {
  const rows = archived ? deps.features.listArchivedOwnedBy(threadId) : deps.features.listActiveOwnedBy(threadId);
  return rows.map((f) => ({
    featureId: f.id,
    name: f.name,
    projectId: f.projectId,
    projectName: deps.projects.getById(f.projectId)?.name ?? "",
    workerThreadId: deps.agentStore.latestMainThreadId("worker", f.id),
    archivedAt: f.archivedAt
  }));
}

/** The title a person sees: stored, else the first user line (≤60 + "…"), else "New thread". */
export function threadDisplayTitle(agentStore: AgentStore, threadId: string): string {
  const t = agentStore.getThreadById(threadId);
  if (t?.title) return t.title;
  const line = agentStore.firstUserLine(threadId);
  if (!line) return "New thread";
  return line.length > FALLBACK_TITLE_CHARS ? `${line.slice(0, FALLBACK_TITLE_CHARS)}…` : line;
}

type Result = ManagerThreadDto | { error: string };

/** Why the turn stopped short of finishing, when it did: null for an error,
 *  which is a failure but not a stop. */
function wakeStopReason(agentStore: AgentStore, wake: AgentWake): string | null {
  if (wake.status === "stuck") return wake.errorMessage ?? "Stopped.";
  if (wake.status === "finished" && agentStore.wakeFailureStatus(wake.id) === "cut_off") return OUTPUT_LIMIT_STOPPED;
  return null;
}

export class ManagerThreadService {
  constructor(private readonly deps: {
    agentStore: AgentStore;
    sse?: Pick<AgentSseEmitter, "emit">;
    isRunning?: (threadId: string) => boolean;
  }) {}

  dto(threadId: string): ManagerThreadDto | null {
    const t = this.deps.agentStore.getThreadById(threadId);
    if (!t || t.scope !== "manager") return null;
    const latest = this.deps.agentStore.getLatestWakeForThread(t.id);
    const stopReason = latest ? wakeStopReason(this.deps.agentStore, latest) : null;
    return {
      id: t.id,
      title: threadDisplayTitle(this.deps.agentStore, t.id),
      named: t.title !== null,
      createdAt: t.createdAt,
      lastActivityAt: this.deps.agentStore.lastActivityAt(t.id) ?? t.createdAt,
      lastVisibleSeq: this.deps.agentStore.lastVisibleSeq(t.id),
      seenSeq: t.seenSeq,
      running: this.deps.isRunning?.(t.id) ?? Boolean(this.deps.agentStore.getRunningWakeForThread(t.id)),
      // A turn that ended in an error, stopped repeating a failing call, or
      // stopped on replies that kept being cut off: the thread itself broke.
      failed: latest?.status === "error" || stopReason !== null,
      stopReason,
      questions: this.deps.agentStore.openQuestions(t.id),
      archivedAt: t.archivedAt
    };
  }

  list(): ManagerThreadDto[] {
    // Newest activity first; a tie (two threads opened in one millisecond)
    // puts the later-created first, as latestManagerThread() picks it.
    return this.deps.agentStore.listOpenManagerThreads()
      .map((t, created) => ({ dto: this.dto(t.id), created }))
      .filter((t): t is { dto: ManagerThreadDto; created: number } => t.dto !== null)
      .sort((a, b) => b.dto.lastActivityAt.localeCompare(a.dto.lastActivityAt) || b.created - a.created)
      .map((t) => t.dto);
  }

  /** Opened through the API: a title given here is the user's. */
  create(title: string | null = null): ManagerThreadDto {
    // Published by startManagerThreadBroadcast, as every new thread is.
    const t = this.deps.agentStore.createManagerThread(title, { titleByUser: true });
    return this.dto(t.id)!;
  }

  rename(threadId: string, raw: unknown): Result {
    const open = this.open(threadId);
    if ("error" in open) return open;
    const title = normalizeThreadTitle(raw);
    if (!title) return { error: "title must be 1-80 characters on one line" };
    this.deps.agentStore.setThreadTitle(threadId, title);
    return this.publish(threadId)!;
  }

  /** The manager's name for the thread: its first, or a new one when the
   *  thread moved on to another task. A title the user set stays. */
  nameByAgent(threadId: string, raw: unknown):
    | { kind: "named"; title: string }
    | { kind: "renamed"; title: string; previous: string }
    | { kind: "same" | "user"; title: string }
    | { error: string } {
    const open = this.open(threadId);
    if ("error" in open) return open;
    const title = normalizeThreadTitle(raw);
    if (!title) return { error: "title must be 1-80 characters on one line" };
    const outcome = this.deps.agentStore.nameThreadByAgent(threadId, title);
    if (!outcome) return { error: "thread not found" };
    if (outcome.kind === "user") return outcome;
    if (outcome.kind === "same") return { kind: "same", title };
    this.publish(threadId);
    return outcome.previous === null ? { kind: "named", title } : { kind: "renamed", title, previous: outcome.previous };
  }

  markSeen(threadId: string, seq: unknown): Result {
    const open = this.open(threadId);
    if ("error" in open) return open;
    if (typeof seq !== "number" || !Number.isFinite(seq)) return { error: "seq must be a number" };
    this.deps.agentStore.markThreadSeen(threadId, seq);
    return this.publish(threadId)!;
  }

  /** Emit the thread's current DTO. Returns it (null when not a manager thread). */
  publish(threadId: string): ManagerThreadDto | null {
    const dto = this.dto(threadId);
    if (dto) this.deps.sse?.emit(SSE_EVENTS.managerThreadUpdated, { thread: dto });
    return dto;
  }

  private open(threadId: string): ManagerThreadDto | { error: string } {
    const dto = this.dto(threadId);
    if (!dto || dto.archivedAt) return { error: "thread not found" };
    return dto;
  }
}

/** Re-publishes a manager thread's DTO when something on the bus changed it:
 *  a message landed, or a wake started or finished. Deferred to a microtask so
 *  every sink sees the causing event first — the bus fans out synchronously.
 *  Also publishes every thread the store opens, whichever path opened it (the
 *  thread API, a worker's owner, an adopted project's, a fallback): a connected
 *  client would otherwise link to a thread it does not have. */
export function startManagerThreadBroadcast(input: {
  sse: AgentSseEmitter;
  service: ManagerThreadService;
  agentStore: AgentStore;
}): () => void {
  const pending = new Set<string>();
  const stopCreated = input.agentStore.onManagerThreadCreated((t) => { input.service.publish(t.id); });
  const stopChanged = input.sse.addSink((e) => {
    if (
      e.event !== SSE_EVENTS.agentMessageAppended &&
      e.event !== SSE_EVENTS.agentWakeStarted &&
      e.event !== SSE_EVENTS.agentWakeFinished
    ) return;
    const threadId = (e.data as { threadId: string }).threadId;
    const scope = (e.data as { scope?: string }).scope;
    if (scope && scope !== "manager") return;
    if (!scope && input.agentStore.getThreadById(threadId)?.scope !== "manager") return;
    if (pending.has(threadId)) return;
    pending.add(threadId);
    queueMicrotask(() => {
      pending.delete(threadId);
      input.service.publish(threadId);
    });
  });
  return () => { stopCreated(); stopChanged(); };
}
