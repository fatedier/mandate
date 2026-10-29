import { beforeEach, expect, test } from "bun:test";
import { useMonitorActivityStore, type MonitorWait } from "@/store/monitor-activity";
import type { AgentPendingMonitorDto } from "@shared/api/agents";
import { mockFetch } from "../helpers/fetch.js";

// What every thread's agent waits on, for the sidebar's
// watching state: the list at boot and on reconnect, the events in between.
// One revision orders them, the feed's count, so neither replays the other.

const pane: AgentPendingMonitorDto = {
  kind: "pane", id: "ww_dev", windowKey: "md-project-1:dispatcher", paneId: "%112", paneName: "Codex build",
  stableMs: 30_000, timeoutAt: "2026-10-09T10:21:00.000Z", note: "review the diff", createdAt: "2026-10-09T09:51:00.000Z"
};
const command: AgentPendingMonitorDto = {
  kind: "command", id: "mon_ci", command: "gh pr checks 56", description: "project-1 CI", everyMs: 300_000,
  wakeWhen: "succeeds", timeoutAt: "2026-10-09T11:00:00.000Z", note: "merge when green", createdAt: "2026-10-09T10:00:00.000Z",
  runCount: 0, lastRunAt: null, nextRunAt: "2026-10-09T10:05:00.000Z", recentRuns: []
};
const subagent: AgentPendingMonitorDto = {
  kind: "subagent", id: "task_1", title: "project-1 release notes", status: "queued", createdAt: "2026-10-09T10:05:00.000Z"
};
const backgroundCommand: AgentPendingMonitorDto = {
  kind: "background-command", id: "task_2", title: "Run the e2e suite", status: "running", createdAt: "2026-10-09T10:06:00.000Z"
};
const alarm: AgentPendingMonitorDto = { kind: "alarm", id: "alm_1", fireAt: "2026-10-09T11:00:00.000Z", note: "", createdAt: "2026-10-09T10:07:00.000Z" };
const rev = (seq: number, boot = 1) => ({ boot, seq });
const worker = (monitors: AgentPendingMonitorDto[]) => ({ threadId: "thr_w", scope: "worker" as const, scopeId: "feat_dispatcher", monitors });
const manager = (monitors: AgentPendingMonitorDto[]) => ({ threadId: "thr_m", scope: "manager" as const, scopeId: null, monitors });
const waits = () => Object.fromEntries(
  [...useMonitorActivityStore.getState().waitingByThread].filter(([, w]) => w.waitsOn).map(([id, w]) => [id, w.waitsOn])
);
const store = () => useMonitorActivityStore.getState();

function deferResponses() {
  const requests: Array<(response: Response) => void> = [];
  mockFetch(() => new Promise<Response>((resolve) => { requests.push(resolve); }));
  return requests;
}

beforeEach(() => {
  useMonitorActivityStore.setState({ waitingByThread: new Map(), listRevision: null });
});

test("the list says what each thread waits on, a pane before a command; an event after it changes one thread", () => {
  store().applyList({ threads: [worker([command, pane]), manager([command])], revision: rev(3) });
  expect(waits()).toEqual({ thr_w: "pane", thr_m: "command" });
  expect(store().waitingByThread.get("thr_w")).toMatchObject({ scope: "worker", scopeId: "feat_dispatcher" });
  store().changed({ ...worker([]), revision: rev(4) });
  expect(waits()).toEqual({ thr_m: "command" });
  // An event the list already counted changes nothing.
  store().changed({ ...manager([]), revision: rev(3) });
  expect(waits()).toEqual({ thr_m: "command" });
});

test("each thread's waits are kept as listed or sent, for the strip that names what a worker waits on", () => {
  store().applyList({ threads: [worker([command, pane])], revision: rev(3) });
  expect(store().waitingByThread.get("thr_w")!.monitors).toEqual([command, pane]);
  store().changed({ ...worker([pane]), revision: rev(4) });
  expect(store().waitingByThread.get("thr_w")!.monitors).toEqual([pane]);
  store().changed({ ...worker([]), revision: rev(5) });
  expect(store().waitingByThread.get("thr_w")!.monitors).toEqual([]);
});

test("a list read before an event cannot undo it, whether the event started a wait or ended one", () => {
  store().changed({ ...worker([pane]), revision: rev(5) });
  store().changed({ ...manager([]), revision: rev(6) });
  store().applyList({ threads: [manager([command])], revision: rev(4) });
  expect(waits()).toEqual({ thr_w: "pane" });
  // A newer list replaces both.
  store().applyList({ threads: [manager([command])], revision: rev(7) });
  expect(waits()).toEqual({ thr_m: "command" });
});

test("a restarted server's list replaces what the old one said, and the old one's late events are ignored", () => {
  store().changed({ ...worker([pane]), revision: rev(90) });
  store().applyList({ threads: [], revision: rev(0, 2) });
  expect(waits()).toEqual({});
  store().changed({ ...manager([command]), revision: rev(91) });
  expect(waits()).toEqual({});
  store().changed({ ...manager([command]), revision: rev(1, 2) });
  expect(waits()).toEqual({ thr_m: "command" });
});

test("only the latest refetch applies, and a failed one changes nothing", async () => {
  const requests = deferResponses();
  const first = store().refetch();
  const second = store().refetch();
  requests[1]!(Response.json({ threads: [manager([command])], revision: rev(8) }));
  await second;
  requests[0]!(Response.json({ threads: [worker([pane])], revision: rev(9) }));
  await first;
  expect(waits()).toEqual({ thr_m: "command" });
  const third = store().refetch();
  requests[2]!(new Response("down", { status: 502 }));
  await third;
  expect(waits()).toEqual({ thr_m: "command" });
});

// Each kind alone names the thread's wait; beside the kind that outranks it,
// that one does (command > subagent > background command > alarm).
const kindRows: Array<{ name: string; monitor: AgentPendingMonitorDto; beside: AgentPendingMonitorDto; waits: Record<string, MonitorWait> }> = [
  {
    name: "a subagent is a wait too: a thread waiting on one alone is watching, named after a pane or a command",
    monitor: subagent, beside: command, waits: { thr_w: "subagent", thr_m: "command" }
  },
  {
    name: "a background command is a wait too: alone it names the thread's wait, after a subagent",
    monitor: backgroundCommand, beside: subagent, waits: { thr_w: "background-command", thr_m: "subagent" }
  },
  {
    name: "an alarm is a wait too: alone it names the thread's wait, after every other kind",
    monitor: alarm, beside: backgroundCommand, waits: { thr_w: "alarm", thr_m: "background-command" }
  }
];

test.each(kindRows)("$name", ({ monitor, beside, waits: expected }) => {
  store().applyList({ threads: [worker([monitor]), manager([monitor, beside])], revision: rev(3) });
  expect(waits()).toEqual(expected);
});
