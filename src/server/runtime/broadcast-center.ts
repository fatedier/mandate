import type { AgentSseEmitter } from "../modules/sse/sse-events.js";
import type { ProjectsStore } from "../modules/projects/projects-store.js";
import type { FeaturesStore } from "../modules/features/features-store.js";
import type { TmuxClient } from "../platform/tmux/tmux.js";
import type { Analyzer } from "../modules/analysis/analyzer.js";
import type { TmuxSnapshot } from "../platform/tmux/tmux-types.js";
import { tmuxListSessionsWithWindows } from "../platform/tmux/tmux.js";
import {
  SSE_EVENTS,
  type ProjectStateDto,
  type SseEventName,
  type SseEventPayloadMap
} from "../../shared/api-contracts.js";
import { computeProjectsState, tmuxStateKey } from "../modules/projects/projects-state.js";
import type { LifecycleEvent } from "./events.js";

// Lifecycle events that mutate the projects DTO. Receiving any of these
// triggers a recompute + projectsState broadcast so connected clients
// don't have to re-poll. List intentionally lives next to the dispatch
// site (lifecycle method) rather than at the call sites.
const LIFECYCLE_EVENT_TYPES: ReadonlySet<LifecycleEvent["type"]> = new Set([
  SSE_EVENTS.projectCreated, SSE_EVENTS.projectArchived, SSE_EVENTS.projectAdopted,
  SSE_EVENTS.projectReordered, SSE_EVENTS.projectReconciled,
  SSE_EVENTS.featureCreated, SSE_EVENTS.featureArchived,
  SSE_EVENTS.paneCreated
]);

interface ProjectTmuxState {
  sessions: Map<string, string[]>;
}

interface BroadcastCenterDeps {
  sse: AgentSseEmitter;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  tmuxClient: TmuxClient;
  analyzer?: Pick<Analyzer, "getWindowAnalysis">;
}

/** Single point of truth for "talk to connected clients". Wraps the raw
 *  SSE emitter with two pieces of derived behavior:
 *
 *  - **Snapshot dedup** (`snapshot()`): tmux polling sends a snapshot every
 *    few seconds but the payload is usually unchanged on idle. JSON-equality skip
 *    avoids burning bandwidth, battery, and React re-renders.
 *  - **Lifecycle fan-out** (`lifecycle()`): mutations to projects/features
 *    rows recompute and re-broadcast the projectsState DTO automatically. */
export class BroadcastCenter {
  private lastSnapshotJson: string | null = null;
  private lastProjectsStateJson: string | null = null;

  constructor(private deps: BroadcastCenterDeps) {}

  /** Wire the Analyzer in after construction. */
  attachAnalyzer(analyzer: Pick<Analyzer, "getWindowAnalysis">): void {
    this.deps.analyzer = analyzer;
  }

  /** Raw passthrough — fire any single SSE event with no dedup. */
  emit<T extends SseEventName>(type: T, data: SseEventPayloadMap[T]): void {
    this.deps.sse.emit(type, data);
  }

  /** Emit `event`, and if its type is a workspace-lifecycle event, also
   *  recompute and broadcast the projectsState DTO. */
  lifecycle(event: LifecycleEvent): void {
    this.emit(event.type, event.data);
    if (LIFECYCLE_EVENT_TYPES.has(event.type)) this.projectsState();
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
  getProjectsStateSnapshot(): ProjectStateDto[] {
    const projects = this.deps.projectsStore.listActive();
    const features = projects.flatMap((p) => this.deps.featuresStore.listActiveByProject(p.id));
    const tmuxState = this.buildProjectTmuxState();
    return computeProjectsState(projects, features, tmuxState.sessions);
  }

  /** Compute + emit the projects DTO with JSON-dedup. */
  projectsState(): void {
    const projects = this.deps.projectsStore.listActive();
    const features = projects.flatMap((p) => this.deps.featuresStore.listActiveByProject(p.id));
    const tmuxState = this.buildProjectTmuxState();
    const dto = computeProjectsState(projects, features, tmuxState.sessions);
    const json = JSON.stringify(dto);
    if (json === this.lastProjectsStateJson) return;
    this.lastProjectsStateJson = json;
    this.deps.sse.emit(SSE_EVENTS.projectsState, dto);
  }

  private buildProjectTmuxState(): ProjectTmuxState {
    const sessions = new Map<string, string[]>();
    for (const session of tmuxListSessionsWithWindows(this.deps.tmuxClient)) {
      sessions.set(tmuxStateKey(session.name), session.windows);
    }
    return { sessions };
  }
}
