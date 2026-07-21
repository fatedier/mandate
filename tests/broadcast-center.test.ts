import { expect, test } from "bun:test";
import { BroadcastCenter } from "../src/server/runtime/broadcast-center.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { Analyzer } from "../src/server/modules/analysis/analyzer.js";
import { buildTmuxSnapshot } from "../src/server/platform/tmux/tmux-snapshot.js";
import type { RawTmuxState } from "../src/server/platform/tmux/tmux-types.js";
import type { SseEvent } from "../src/shared/api-contracts.js";
import { TmuxPoller } from "../src/server/runtime/tmux-poller.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux.js";

test("idle polls suppress duplicate snapshots but still broadcast state changes", async () => {
  const raw: RawTmuxState = {
    sessions: [{ sessionName: "fixture", sessionWindows: 1, sessionAttached: 0, created: "2026-01-01" }],
    windows: [{ sessionName: "fixture", windowId: "@1", windowIndex: 0, windowName: "worker", windowActive: true, windowPanes: 1, windowLayout: "fixture", windowZoomed: false }],
    panes: [{ sessionName: "fixture", windowId: "@1", paneId: "%1", windowIndex: 0, windowName: "worker", paneIndex: 0, paneActive: true, windowActive: true, currentPath: "/tmp", currentCommand: "zsh", paneTitle: "worker", panePid: 123, paneTty: "fixture", paneWidth: 120, paneHeight: 40, captureHash: "static", changedAt: "2026-01-01T00:00:00Z", preview: "prompt", processes: [], foregroundProcesses: [] }],
    clients: []
  };
  const analyzer = new Analyzer();
  const sse = new AgentSseEmitter();
  const seen: SseEvent[] = [];
  sse.addSink((event) => seen.push(event));
  const broadcaster = new BroadcastCenter({ sse } as ConstructorParameters<typeof BroadcastCenter>[0]);
  const first = buildTmuxSnapshot(raw, analyzer);
  broadcaster.snapshot(first);
  await Bun.sleep(3);
  const idle = buildTmuxSnapshot(raw, analyzer);
  expect(idle.generatedAt).not.toBe(first.generatedAt);
  broadcaster.snapshot(idle);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.data).toEqual(first);

  raw.panes[0]!.paneWidth = 90;
  const resized = buildTmuxSnapshot(raw, analyzer);
  broadcaster.snapshot(resized);
  expect(seen).toHaveLength(2);
  expect(seen[1]!.data).toEqual(resized);
  broadcaster.snapshot(resized, { force: true });
  expect(seen).toHaveLength(3);
});

test("persistent polling errors emit once and an idle recovery still reaches clients", async () => {
  const sse = new AgentSseEmitter();
  const seen: SseEvent[] = [];
  sse.addSink((event) => seen.push(event));
  // An empty in-memory tmux inventory; no commands leave the process.
  const tmuxClient: TmuxClient = { socketArgs: [], runner: {
    run: () => ({ status: 0, signal: null, stdout: "", stderr: "" })
  } };
  const broadcaster = new BroadcastCenter({
    sse, tmuxClient, projectsStore: { listActive: () => [] }, featuresStore: {}
  } as unknown as ConstructorParameters<typeof BroadcastCenter>[0]);
  let failure: string | null = null;
  const poller = new TmuxPoller({
    sse, broadcaster, tmuxClient, analyzer: new Analyzer(), captureLines: 0,
    store: { listFeatureWindowKeys: () => {
      if (failure) throw new Error(failure);
      return new Set();
    } }
  } as unknown as ConstructorParameters<typeof TmuxPoller>[0]);
  await poller.poll();
  const firstVersion = poller.getSnapshot()!.snapshotVersion!;
  await poller.poll();
  expect(poller.getSnapshot()!.snapshotVersion).toEqual({ epoch: firstVersion.epoch, revision: firstVersion.revision + 1 });
  expect(seen.filter((event) => event.event === "snapshot")).toHaveLength(1);
  failure = "tmux unavailable";
  await poller.poll();
  await poller.poll();
  expect(seen.filter((event) => event.event === "error")).toHaveLength(1);
  failure = null;
  await poller.poll();
  expect(poller.getLastError()).toBeNull();
  expect(seen.filter((event) => event.event === "snapshot")).toHaveLength(2);
  failure = "tmux unavailable";
  await poller.poll();
  expect(seen.filter((event) => event.event === "error")).toHaveLength(2);
});
