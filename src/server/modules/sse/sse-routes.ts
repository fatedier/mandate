import type { Hono } from "hono";
import { getBunServer } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { API_ROUTES, DEFAULT_SSE_HEARTBEAT_MS, SSE_EVENTS, SSE_HEARTBEAT_EVENT, type AppStateErrorDto, type ProjectStateDto } from "../../../shared/api-contracts.js";
import { endedMessageStream, type AgentSseEmitter } from "./sse-events.js";
import { toAgentClientMessage } from "../agent/agent-message-dto.js";
import { MessageStreamEncoder } from "./message-stream-encoder.js";
import { SnapshotStreamEncoder } from "./snapshot-stream-encoder.js";

export interface SseDeps {
  sse: AgentSseEmitter;
  /** Latest tmux snapshot to push on connection (or null if none yet). */
  getSnapshot: () => unknown | null;
  getSnapshotError?: () => AppStateErrorDto;
  /** Computes the current projectsState DTO. Pushed on connection so late
   *  joiners don't wait for the next dedup-miss. */
  getProjectsState: () => ProjectStateDto[];
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
    // Existing pages keep their cumulative protocol until they are refreshed.
    const incremental = c.req.query("messageFormat") === "delta";
    const incrementalSnapshots = c.req.query("snapshotFormat") === "delta";
    return streamSSE(c, async (stream) => {
      const writeJson = (event: string, data: string) => {
        void stream.writeSSE({ event, data }).catch(() => { /* stream closed */ });
      };
      const write = (event: string, data: unknown) => writeJson(event, JSON.stringify(data));
      const snapshots = incrementalSnapshots ? new SnapshotStreamEncoder() : null;
      const writeSnapshot = (snapshot: unknown) => {
        if (!snapshots) return write(SSE_EVENTS.snapshot, snapshot);
        const encoded = snapshots.encode(snapshot);
        writeJson(encoded.event, encoded.data);
      };
      // Queue initial state and attach the live sink without yielding between
      // them. A slow reader must not create a gap in which updates are lost.
      const snap = deps.getSnapshot();
      if (snap) writeSnapshot(snap);
      // Initial projectsState push.
      try {
        const ps = deps.getProjectsState();
        if (ps) write(SSE_EVENTS.projectsState, ps);
      } catch { /* projectsState compute failed — fall through */ }
      const error = deps.getSnapshotError?.();
      if (error) write(SSE_EVENTS.error, error);
      const activeStreams = incremental ? deps.sse.getMessageStreams() : [];
      const encoder = new MessageStreamEncoder(activeStreams);
      if (incremental) write(SSE_EVENTS.agentMessageStreams, { streams: activeStreams });
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
        if (incremental && e.event === SSE_EVENTS.agentMessageDelta) {
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
