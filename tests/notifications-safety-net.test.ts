import { expect, test } from "bun:test";
import type { Config } from "../src/server/config.js";
import { SSE_EVENTS, type SseEvent, type SseEventPayloadMap } from "../src/shared/api-contracts.js";
import type { ThreadStatusSnapshotDto, WaitingEntryDto } from "../src/shared/api/thread-status.js";
import type { NotifyRequest } from "../src/server/modules/notifications/notification-service.js";
import { startNotificationWatch } from "../src/server/modules/notifications/safety-net.js";

// When the personal agent is the one stuck it cannot be relied on to say so: the
// system tells the user itself. And a notice whose matter no longer waits on
// the user is taken back.

function entry(fields: Partial<WaitingEntryDto> & Pick<WaitingEntryDto, "kind" | "waiting" | "text">): WaitingEntryDto {
  const id = fields.kind === "worker" ? fields.workerId : fields.threadId;
  return { key: `${fields.kind}:${id ?? "agent"}:${fields.waiting}`, threadId: null, threadTitle: null, workerId: null, workerName: null, place: null, ...fields };
}

const question = entry({ kind: "agent", waiting: "input", text: "Use the staging database for the migration test?" });
const held = entry({ kind: "agent", waiting: "input", threadId: "thr_global", text: "Held back 3 times in a row by the tool-call review. Last: it wrote outside the project." });
const threadAsks = entry({ kind: "question", waiting: "input", threadId: "thr_a", threadTitle: "Login fix", text: "Which branch?" });
const workerAsks = entry({ kind: "worker", waiting: "input", threadId: "thr_a", workerId: "wkr_w", text: "Which port?" });

function harness(options: { on?: boolean; name?: string; initial?: WaitingEntryDto[]; open?: string[]; wakeReason?: string } = {}) {
  const sinks: Array<(e: SseEvent) => void> = [];
  const sent: NotifyRequest[] = [];
  const settled: string[] = [];
  let on = options.on ?? true;
  const open = new Set(options.open ?? []);
  const stop = startNotificationWatch({
    sse: { addSink: (sink) => { sinks.push(sink); return () => {}; } },
    service: {
      notify: async (request) => { sent.push(request); open.add(request.matter.key); return { line: "Sent to: Phone." }; },
      settle: async (key) => { settled.push(key); open.delete(key); },
      isOn: () => on,
      openMatterKeys: () => [...open]
    },
    agentStore: { getWakeById: () => ({ reason: options.wakeReason ?? "user" }) as never },
    getConfig: () => ({ agent: { personalAgentName: options.name ?? "" } }) as unknown as Config,
    current: () => ({ threads: [], waiting: options.initial ?? [] })
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const status = async (waiting: WaitingEntryDto[]) => {
    for (const sink of sinks) sink({ event: SSE_EVENTS.threadStatus, data: { threads: [], waiting } satisfies ThreadStatusSnapshotDto });
    await flush();
  };
  const wakeFinished = async (data: Partial<SseEventPayloadMap["agentWakeFinished"]> & { status: "finished" | "error" | "stuck" | "canceled" }) => {
    for (const sink of sinks) sink({ event: SSE_EVENTS.agentWakeFinished, data: { threadId: "thr_global", wakeId: "wake_1", scope: "personal", ...data } } as SseEvent);
    await flush();
  };
  return { sent, settled, status, wakeFinished, stop, setOn: (value: boolean) => { on = value; }, open };
}

test("The personal agent's question is notified once and withdrawn when answered", async () => {
  const h = harness();
  await h.status([question, threadAsks]);
  await h.status([question, threadAsks]);
  expect(h.sent).toEqual([{ source: "system", matter: { key: "agent:question", link: "/agent" }, title: "Mandate asks", text: "Use the staging database for the migration test?", level: "needs_you" }]);
  await h.status([threadAsks]);
  expect(h.settled).toEqual(["agent:question"]);
});

test("held back is notified as stopped, with what waits", async () => {
  const h = harness({ name: "Rin" });
  await h.status([held, threadAsks]);
  expect(h.sent).toEqual([{
    source: "system", matter: { key: "agent:held", link: "/agent" }, title: "Rin stopped",
    text: "Held back 3 times in a row by the tool-call review. Last: it wrote outside the project. 2 things wait on you.", level: "needs_you"
  }]);
});

test("a failed turn the user started is notified with the count", async () => {
  const h = harness({ initial: [threadAsks, workerAsks] });
  await h.wakeFinished({ status: "error", error: { message: "The tool-call loop broke", category: "unknown"} });
  expect(h.sent).toEqual([{ source: "system", matter: { key: "agent:failed", link: "/agent" }, title: "Mandate stopped", text: "The tool-call loop broke. 2 things wait on you.", level: "needs_you" }]);
});

// A side chat's turn fails on the page the user is on, where they see it:
// it sends no notification.
test("a side chat's failed turn sends no notice", async () => {
  const h = harness({ initial: [threadAsks] });
  await h.wakeFinished({ threadId: "thr_side", scope: "side_chat", status: "error", error: { message: "The tool-call loop broke", category: "unknown" } });
  await h.wakeFinished({ threadId: "thr_side", scope: "side_chat", status: "stuck" });
  expect(h.sent).toEqual([]);
});

test("a provider failure says it can't reach its model", async () => {
  const h = harness();
  await h.wakeFinished({ status: "error", error: { message: "Connection refused after 3 tries", category: "timeout"} });
  expect(h.sent.map((r) => [r.title, r.text])).toEqual([["Mandate can't reach its model", "Connection refused after 3 tries."]]);
});

test("a turn nobody waits on, that the user did not start, is silent", async () => {
  const h = harness({ wakeReason: "alarm" });
  await h.wakeFinished({ status: "error", error: { message: "x", category: "unknown"} });
  expect(h.sent).toStrictEqual([]);
});

test("a canceled turn is silent, and a manager's failure is not the safety net's", async () => {
  const h = harness();
  await h.wakeFinished({ status: "canceled" });
  await h.wakeFinished({ status: "error", scope: "manager", threadId: "thr_a" });
  expect(h.sent).toStrictEqual([]);
});

test("a later finished turn takes the failure notice back", async () => {
  const h = harness();
  await h.wakeFinished({ status: "stuck", errorMessage: "The same call failed 3 times." });
  expect(h.sent.map((r) => r.text)).toEqual(["The same call failed 3 times."]);
  await h.wakeFinished({ status: "finished" });
  expect(h.settled).toEqual(["agent:failed"]);
});

test("nothing is sent while notifications are off", async () => {
  const h = harness({ on: false });
  await h.status([question]);
  await h.wakeFinished({ status: "error", error: { message: "x", category: "unknown"} });
  expect(h.sent).toStrictEqual([]);
});

test("what waits when the watch starts is not sent again", async () => {
  const h = harness({ initial: [question] });
  await h.status([question]);
  expect(h.sent).toStrictEqual([]);
});

test("a thread matter settles when its entries go; one never listed stays", async () => {
  const h = harness({ open: ["thread:thr_a", "thread:thr_quiet", "worker:wkr_w"] });
  await h.status([threadAsks, workerAsks]);
  await h.status([threadAsks]);
  expect(h.settled).toEqual(["worker:wkr_w"]);
  await h.status([]);
  expect(h.settled).toEqual(["worker:wkr_w", "thread:thr_a"]);
  expect(h.open.has("thread:thr_quiet")).toBe(true);
});

test("one thing waits reads in the singular", async () => {
  const h = harness();
  await h.status([held]);
  expect(h.sent[0]!.text.endsWith("Last: it wrote outside the project. 1 thing waits on you.")).toBe(true);
});

test("a failure notice that outlived a restart is taken back by the next finished turn", async () => {
  const h = harness({ open: ["agent:failed"] });
  await h.wakeFinished({ status: "finished" });
  expect(h.settled).toEqual(["agent:failed"]);
});

test("a failure just before its waiting list arrives is still sent", async () => {
  // Woken by a thread's notice, the turn failed before the list that shows
  // the thread waiting was sent.
  const h = harness({ wakeReason: "thread-notice" });
  await h.wakeFinished({ status: "error", error: { message: "Invalid API key", category: "auth_failed"} });
  expect(h.sent).toStrictEqual([]);
  await h.status([threadAsks]);
  expect(h.sent.map((r) => [r.title, r.text])).toEqual([["Mandate can't reach its model", "Invalid API key. 1 thing waits on you."]]);
  await h.status([threadAsks]);
  expect(h.sent).toHaveLength(1);
});

test("a failure nobody waits on stays unsent when the next list is empty too", async () => {
  const h = harness({ wakeReason: "alarm" });
  await h.wakeFinished({ status: "error", error: { message: "x", category: "unknown"} });
  await h.status([]);
  await h.status([threadAsks]);
  expect(h.sent).toStrictEqual([]);
});

test("a list that comes long after the failure does not send it", async () => {
  const realNow = Date.now;
  const h = harness({ wakeReason: "thread-notice" });
  try {
    await h.wakeFinished({ status: "error", error: { message: "x", category: "unknown"} });
    const later = realNow() + 60_000;
    Date.now = () => later;
    await h.status([threadAsks]);
  } finally {
    Date.now = realNow;
  }
  expect(h.sent).toStrictEqual([]);
});
