import type { AgentSseEmitter } from "../modules/sse/sse-events.js";
import type { ProjectsStore } from "../modules/projects/projects-store.js";
import type { WorkersStore } from "../modules/workers/workers-store.js";
import type { TmuxClient } from "../platform/tmux/tmux.js";
import type { TmuxSnapshot } from "../platform/tmux/tmux-types.js";
import { tmuxListSessionsWithWindows } from "../platform/tmux/tmux.js";
import { CommandDidNotAnswerError } from "../platform/process/command-runner.js";
import { logError } from "../platform/logger.js";
import {
  SSE_EVENTS,
  type ProjectStateDto,
  type SseEventName,
  type SseEventPayloadMap
} from "../../shared/api-contracts.js";
import { computeProjectsState } from "../modules/projects/projects-state.js";
import type { LifecycleEvent } from "./events.js";
import type { WorkerPlanDto } from "../../shared/api/plans.js";
import { planForPage } from "../../shared/plan-rounds.js";

// Lifecycle events that mutate the projects DTO. Receiving any of these
// triggers a recompute + projectsState broadcast so connected clients
// don't have to re-poll. List intentionally lives next to the dispatch
// site (lifecycle method) rather than at the call sites.
const LIFECYCLE_EVENT_TYPES: ReadonlySet<LifecycleEvent["type"]> = new Set([
  SSE_EVENTS.projectCreated, SSE_EVENTS.projectArchived,
  SSE_EVENTS.projectReordered, SSE_EVENTS.projectReconciled, SSE_EVENTS.projectUpdated,
  SSE_EVENTS.workerCreated, SSE_EVENTS.workerArchived,
  SSE_EVENTS.workerOwnerChanged,
  SSE_EVENTS.paneCreated
]);

interface ProjectTmuxState {
  sessions: Map<string, string[]>;
}

interface BroadcastCenterDeps {
  sse: AgentSseEmitter;
  projectsStore: ProjectsStore;
  workersStore: WorkersStore;
  tmuxClient: TmuxClient;
  /** A worker's plan, pushed when the worker is restored: the plan list a
   *  connection opened with holds active workers only. */
  getWorkerPlan?: (workerId: string) => WorkerPlanDto;
}

/** Single point of truth for "talk to connected clients". Wraps the raw
 *  SSE emitter with two pieces of derived behavior:
 *
 *  - **Snapshot dedup** (`snapshot()`): tmux polling sends a snapshot every
 *    few seconds but the payload is usually unchanged on idle. JSON-equality skip
 *    avoids burning bandwidth, battery, and React re-renders.
 *  - **Lifecycle fan-out** (`lifecycle()`): mutations to projects/workers
 *    rows recompute and re-broadcast the projectsState DTO automatically. */
export class BroadcastCenter {
  private lastSnapshotJson: string | null = null;
  private lastProjectsStateJson: string | null = null;
  /** Each projects-state read is numbered: tmux may answer two in either
   *  order, and an older answer never replaces a newer one. */
  private projectsReads = 0;
  private projectsShown = 0;
  /** tmux's sessions as its newest answer had them. */
  private lastTmuxState: ProjectTmuxState | null = null;

  constructor(private deps: BroadcastCenterDeps) {}

  /** Raw passthrough — fire any single SSE event with no dedup. */
  emit<T extends SseEventName>(type: T, data: SseEventPayloadMap[T]): void {
    this.deps.sse.emit(type, data);
  }

  /** Emit `event`, and if its type is a workspace-lifecycle event, also
   *  recompute and broadcast the projectsState DTO. */
  lifecycle(event: LifecycleEvent): void {
    this.emit(event.type, event.data);
    if (event.type === SSE_EVENTS.workerRestored) {
      const plan = this.deps.getWorkerPlan?.(event.data.id);
      if (plan?.updatedAt) this.emit(SSE_EVENTS.workerPlanUpdated, { plan: planForPage(plan) });
    }
    if (LIFECYCLE_EVENT_TYPES.has(event.type)) {
      this.projectsState().catch((err: unknown) => logError("projects-state", err, `projects state after ${event.type} failed`));
    }
  }

  /** Emit a `snapshot` event with JSON-dedup against the last broadcast. */
  snapshot(snapshot: TmuxSnapshot, options: { force?: boolean } = {}): void {
    // Poll time changes even when every pane is idle. Keep it on the wire,
    // but compare only state so it cannot defeat deduplication.
    const json = JSON.stringify({ ...snapshot, generatedAt: undefined, snapshotVersion: undefined });
    if (!options.force && json === this.lastSnapshotJson) return;
    this.lastSnapshotJson = json;
    this.deps.sse.emit(SSE_EVENTS.snapshot, snapshot);
  }

  /** Compute + return the current projects DTO without emitting. Used by
   *  the SSE handler to push initial state on a new client connection so
   *  late joiners don't have to wait for the next dedup-miss. */
  async getProjectsStateSnapshot(): Promise<ProjectStateDto[]> {
    const tmuxState = await this.buildProjectTmuxState();
    return this.computeProjects(tmuxState);
  }

  /** The projects DTO from the rows as they are now and tmux's newest
   *  answer, without asking tmux: null before tmux has answered once. A new
   *  connection takes it with its other opening reads, with nothing waiting
   *  between them and the live updates. */
  projectsStateNow(): ProjectStateDto[] | null {
    return this.lastTmuxState ? this.computeProjects(this.lastTmuxState) : null;
  }

  /** Compute + emit the projects DTO with JSON-dedup. */
  async projectsState(): Promise<void> {
    const read = ++this.projectsReads;
    let tmuxState: ProjectTmuxState;
    try {
      tmuxState = await this.buildProjectTmuxState();
    } catch (err) {
      // Not known this time: what was last sent stands, rather than every
      // project read as gone. The next tick asks again.
      if (err instanceof CommandDidNotAnswerError) return;
      throw err;
    }
    if (read < this.projectsShown) return;
    this.projectsShown = read;
    this.lastTmuxState = tmuxState;
    // The rows as they are now that tmux answered.
    const dto = this.computeProjects(tmuxState);
    const json = JSON.stringify(dto);
    if (json === this.lastProjectsStateJson) return;
    this.lastProjectsStateJson = json;
    this.deps.sse.emit(SSE_EVENTS.projectsState, dto);
  }

  private computeProjects(tmuxState: ProjectTmuxState): ProjectStateDto[] {
    const projects = this.deps.projectsStore.listActive();
    const workers = projects.flatMap((p) => this.deps.workersStore.listActiveByProject(p.id));
    return computeProjectsState(projects, workers, tmuxState.sessions);
  }

  private async buildProjectTmuxState(): Promise<ProjectTmuxState> {
    const sessions = new Map<string, string[]>();
    for (const session of await tmuxListSessionsWithWindows(this.deps.tmuxClient)) {
      sessions.set(session.name, session.windows);
    }
    return { sessions };
  }
}
