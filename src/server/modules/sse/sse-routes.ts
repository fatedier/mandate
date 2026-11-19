import type { Hono } from "hono";
import { getBunServer } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { API_ROUTES, DEFAULT_SSE_HEARTBEAT_MS, SSE_EVENTS, SSE_HEARTBEAT_EVENT, type AppStateErrorDto, type ProjectStateDto } from "../../../shared/api-contracts.js";
import type { WorkerPlanDto } from "../../../shared/api/plans.js";
import type { ManagerThreadDto } from "../../../shared/api/agents.js";
import type { ThreadStatusSnapshotDto } from "../../../shared/api/thread-status.js";
import type { PersonalAgentDto } from "../../../shared/api/personal-agent.js";
import type { TaskDto } from "../../../shared/api/task-board.js";
import type { StickyNotesDto } from "../../../shared/api/sticky-notes.js";
import type { SideChatDto } from "../../../shared/api/side-chat.js";
import { endedMessageStream, type AgentSseEmitter } from "./sse-events.js";
import { toAgentClientMessage } from "../agent/agent-message-dto.js";
import { MessageStreamEncoder } from "./message-stream-encoder.js";
import { SnapshotStreamEncoder } from "./snapshot-stream-encoder.js";

interface SseDeps {
  sse: AgentSseEmitter;
  /** Latest tmux snapshot to push on connection (or null if none yet). */
  getSnapshot: () => unknown | null;
  getSnapshotError?: () => AppStateErrorDto | null;
  /** Computes the current projectsState DTO, asking tmux. Pushed on
   *  connection, when no answer of tmux is known yet, so late joiners don't
   *  wait for the next dedup-miss. */
  getProjectsState: () => Promise<ProjectStateDto[]>;
  /** The projectsState DTO from tmux's newest answer, without asking it;
   *  null before tmux has answered once. */
  getProjectsStateNow?: () => ProjectStateDto[] | null;
  /** Every active worker plan as the page receives it (planForPage), pushed
   *  on connection before the projects so no worker is drawn without its plan. */
  getWorkerPlans?: () => WorkerPlanDto[];
  /** Every open manager thread, pushed on connection first, so the thread
   *  list is whole before anything refers to a thread. */
  getManagerThreads?: () => ManagerThreadDto[];
  /** Every open thread's state and what waits on the user, as last worked out. */
  getThreadStatus?: () => ThreadStatusSnapshotDto;
  /** The personal agent's state, pushed with the threads. */
  getPersonalAgent?: () => PersonalAgentDto;
  getSideChats?: () => SideChatDto[];
  getTaskBoard?: () => TaskDto[];
  getStickyNotes?: () => StickyNotesDto;
  heartbeatMs: number;
}

/**
 * Mounts `GET /api/events` on the given Hono app, using `hono/streaming`'s
 * `streamSSE` to back the response with Bun's native ReadableStream — which,
 * unlike node:http under Bun's compat layer, actually flushes on every write.
 *
 * Each connection:
 *   1. Pushes the current tmux snapshot if available.
 *   2. Subscribes to the shared bus via `sse.addSink(...)`.
 *   3. Sends `_hb` heartbeats every `heartbeatMs` to keep the connection alive
 *      (browsers / proxies will drop quiet long-lived connections).
 *   4. Cleans up subscription + interval when the stream is aborted.
 */
export function mountSseRoutes(app: Hono, deps: SseDeps): void {
  const heartbeatMs = Number.isFinite(deps.heartbeatMs) && deps.heartbeatMs > 0
    ? deps.heartbeatMs : DEFAULT_SSE_HEARTBEAT_MS;
  app.get(API_ROUTES.events, (c) => {
    // SSE can be quiet longer than Bun's idle timeout between heartbeats.
    // In-process app.request() calls do not have a Bun server.
    const server = c.env ? getBunServer<{
      timeout?: (request: Request, seconds: number) => void;
    }>(c) : undefined;
    server?.timeout?.(c.req.raw, 0);
    return streamSSE(c, async (stream) => {
      // Listened for before anything waits: a stream that goes away while
      // tmux answers is not told again.
      let aborted = false;
      const gone = new Promise<void>((resolve) => {
        stream.onAbort(() => { aborted = true; resolve(); });
      });
      // The projects need tmux's sessions. Its newest answer is used; only
      // before it ever answered is it asked, and that first, so nothing waits
      // between the opening reads below and the live sink. No projects, no
      // stream: projectsState is sent again only when it changes, and the
      // client has no other way to get it, so a page would wait for the
      // projects forever. Ended instead; the browser's EventSource reconnects
      // and this burst runs again.
      let projects: ProjectStateDto[] | null;
      try {
        projects = deps.getProjectsStateNow?.() ?? null;
        if (projects === null) {
          const asked = await deps.getProjectsState();
          // A broadcast that answered meanwhile is what the live updates are
          // compared with, so it is what this connection starts from.
          projects = deps.getProjectsStateNow?.() ?? asked;
        }
      } catch {
        await stream.close();
        return;
      }
      if (aborted) return;
      // The writes are fire-and-forget.
      const writeJson = (event: string, data: string) => {
        void stream.writeSSE({ event, data }).catch(() => { /* stream closed */ });
      };
      const write = (event: string, data: unknown) => writeJson(event, JSON.stringify(data));
      // A snapshot goes out as a patch on the last one this connection got
      // (or whole, when that is smaller); a reply's text as a patch on the
      // text the connection already has.
      const snapshots = new SnapshotStreamEncoder();
      const writeSnapshot = (snapshot: unknown) => {
        const encoded = snapshots.encode(snapshot);
        writeJson(encoded.event, encoded.data);
      };
      // Queue initial state and attach the live sink without yielding between
      // them. A slow reader must not create a gap in which updates are lost.
      const snap = deps.getSnapshot();
      if (snap) writeSnapshot(snap);
      try {
        const threads = deps.getManagerThreads?.();
        if (threads) write(SSE_EVENTS.managerThreads, { threads });
      } catch { /* threads read failed — the sidebar fills on the next update */ }
      try {
        const agent = deps.getPersonalAgent?.();
        if (agent) write(SSE_EVENTS.personalAgent, { agent });
      } catch { /* the personal agent's row fills on the next update */ }
      try {
        const sideChats = deps.getSideChats?.();
        if (sideChats) write(SSE_EVENTS.sideChats, { sideChats });
      } catch { /* the side chats fill in on the next update */ }
      try {
        const tasks = deps.getTaskBoard?.();
        if (tasks) write(SSE_EVENTS.taskBoard, { tasks });
      } catch { /* the board fills in on the next update */ }
      try {
        const notes = deps.getStickyNotes?.();
        if (notes) write(SSE_EVENTS.stickyNotes, notes);
      } catch { /* the notes fill in on the next update */ }
      // Plans first: a worker the projects list draws already has its plan.
      try {
        const plans = deps.getWorkerPlans?.();
        if (plans) write(SSE_EVENTS.workerPlans, { plans });
      } catch { /* plans read failed — workers read as Planning until a push */ }
      write(SSE_EVENTS.projectsState, projects);
      // Last: its rows name the threads, the personal agent and the workers sent
      // above. Already worked out, so sending it reads nothing.
      const status = deps.getThreadStatus?.();
      if (status) write(SSE_EVENTS.threadStatus, status);
      const error = deps.getSnapshotError?.();
      if (error) write(SSE_EVENTS.error, error);
      const activeStreams = deps.sse.getMessageStreams();
      const encoder = new MessageStreamEncoder(activeStreams);
      write(SSE_EVENTS.agentMessageStreams, { streams: activeStreams });
      // Advertise the interval immediately, including custom server settings,
      // so clients can detect a stalled stream without polling another route.
      const heartbeat = () => write(SSE_HEARTBEAT_EVENT, { intervalMs: heartbeatMs });
      heartbeat();

      // Subscribe this stream to all bus events. Fire-and-forget the writes:
      // awaiting would serialize all events through this stream and slow
      // every other consumer; the underlying stream backpressures internally.
      const unsubscribe = deps.sse.addSink((e) => {
        if (e.event === SSE_EVENTS.snapshot) {
          writeSnapshot(e.data);
          return;
        }
        if (e.event === SSE_EVENTS.agentMessageDelta) {
          const patch = encoder.patch(e.data);
          if (patch) write(SSE_EVENTS.agentMessagePatch, patch);
          return;
        }
        const ended = endedMessageStream(e);
        if (ended) encoder.finish(ended.threadId, ended.wakeId);
        const data = e.event === SSE_EVENTS.agentMessageAppended
          ? { ...e.data, message: toAgentClientMessage(e.data.message) }
          : e.data;
        write(e.event, data);
      });

      const interval = setInterval(heartbeat, heartbeatMs);

      // Block until the stream is aborted (client disconnect).
      await gone;

      clearInterval(interval);
      unsubscribe();
    });
  });
}
