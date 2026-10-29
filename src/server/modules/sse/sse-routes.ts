import type { Hono } from "hono";
import { getBunServer } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { API_ROUTES, DEFAULT_SSE_HEARTBEAT_MS, SSE_EVENTS, SSE_HEARTBEAT_EVENT, type AppStateErrorDto, type ProjectStateDto } from "../../../shared/api-contracts.js";
import type { FeaturePlanDto } from "../../../shared/api/plans.js";
import type { ManagerThreadDto } from "../../../shared/api/agents.js";
import type { ThreadStatusSnapshotDto } from "../../../shared/api/thread-status.js";
import type { GlobalAgentDto } from "../../../shared/api/global-agent.js";
import { endedMessageStream, type AgentSseEmitter } from "./sse-events.js";
import { toAgentClientMessage } from "../agent/agent-message-dto.js";
import { MessageStreamEncoder } from "./message-stream-encoder.js";
import { SnapshotStreamEncoder } from "./snapshot-stream-encoder.js";
import { planForPage } from "../../../shared/plan-rounds.js";

interface SseDeps {
  sse: AgentSseEmitter;
  /** Latest tmux snapshot to push on connection (or null if none yet). */
  getSnapshot: () => unknown | null;
  getSnapshotError?: () => AppStateErrorDto;
  /** Computes the current projectsState DTO. Pushed on connection so late
   *  joiners don't wait for the next dedup-miss. */
  getProjectsState: () => ProjectStateDto[];
  /** Every active feature plan, pushed on connection before the projects so
   *  no feature is drawn without its plan. */
  getFeaturePlans?: () => FeaturePlanDto[];
  /** Every open manager thread, pushed on connection first, so the thread
   *  list is whole before anything refers to a thread. */
  getManagerThreads?: () => ManagerThreadDto[];
  /** Every open thread's state and what waits on the user, as last worked out. */
  getThreadStatus?: () => ThreadStatusSnapshotDto;
  /** The global agent's state, pushed with the threads. */
  getGlobalAgent?: () => GlobalAgentDto;
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
      // The writes are fire-and-forget; the ones of the opening burst are
      // kept so a burst that has to end the stream can let them land first.
      let burst: Array<Promise<unknown>> | null = [];
      const writeJson = (event: string, data: string) => {
        const written = stream.writeSSE({ event, data }).catch(() => { /* stream closed */ });
        burst?.push(written);
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
        const agent = deps.getGlobalAgent?.();
        if (agent) write(SSE_EVENTS.globalAgent, { agent });
      } catch { /* the global row fills on the next update */ }
      // Plans first: a feature the projects list draws already has its plan.
      try {
        const plans = deps.getFeaturePlans?.();
        if (plans) write(SSE_EVENTS.featurePlans, { plans: plans.map(planForPage) });
      } catch { /* plans read failed — features read as Planning until a push */ }
      // Initial projectsState push. Unlike the reads above, there is no next
      // update to fill it in: projectsState is sent again only when it
      // changes, and the client has no other way to get it, so a page would
      // wait for the projects forever. End the stream instead; the browser's
      // EventSource reconnects and this burst runs again.
      try {
        const ps = deps.getProjectsState();
        if (ps) write(SSE_EVENTS.projectsState, ps);
      } catch {
        await Promise.all(burst);
        await stream.close();
        return;
      }
      // Last: its rows name the threads, Your agent and the workers sent
      // above. Already worked out, so sending it reads nothing.
      const status = deps.getThreadStatus?.();
      if (status) write(SSE_EVENTS.threadStatus, status);
      burst = null;
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
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });

      clearInterval(interval);
      unsubscribe();
    });
  });
}
