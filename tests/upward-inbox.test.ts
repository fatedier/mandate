import { expect, test } from "bun:test";
import { createUpwardInbox, wakesReceiver, type UpwardMessage } from "../src/server/modules/agent/upward-inbox.js";
import { mailboxWakeReason } from "../src/server/runtime/mailbox-wake-reason.js";
import { SSE_EVENTS } from "../src/shared/api/sse.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { onCleanup } from "./helpers/cleanup.js";

// The unified inbox: every message between agent levels goes in through one
// entry, which decides from its kind alone whether it wakes its receiver. A
// note never does; the other kinds do.

function setup(busy = false) {
  const env = freshStoresEnv("md-upward-inbox-");
  onCleanup(() => env.cleanup());
  const manager = env.agentStore.createManagerThread("project-1 release");
  const emits: Array<{ event: string; data: unknown }> = [];
  const wakes: Array<[string, string]> = [];
  const inbox = createUpwardInbox({
    agentStore: env.agentStore,
    sse: { emit: (event: string, data: unknown) => { emits.push({ event, data }); } } as never,
    busy: () => busy,
    wake: (threadId, source) => { wakes.push([threadId, mailboxWakeReason([source])]); }
  });
  const message = (over: Partial<UpwardMessage> = {}): UpwardMessage => ({
    to: manager.id, kind: "report", key: "feature:feat_notes", source: "worker-report", sourceThreadId: null,
    content: { type: "text", text: "[Worker report] Release notes: done — drafted.", metadata: { workerReport: { key: "done" } } },
    ...over
  });
  return { env, manager, emits, wakes, inbox, message };
}

test("wakesReceiver: a note never wakes; a request, a report and a lifecycle event do", () => {
  expect((["request", "report", "note", "lifecycle"] as const).map(wakesReceiver)).toEqual([true, true, false, true]);
});

test("a report is queued with a turn and wakes its receiver once, after the caller asks", () => {
  for (const [source, reason] of [["worker-report", "worker-report"], ["thread-notice", "thread-notice"], ["feature-message", "user"]] as const) {
    const s = setup();
    const posted = s.inbox.post(s.message({ source }));
    expect([posted.mailboxItem?.triggerTurn, posted.message, s.wakes]).toEqual([true, null, []]);
    posted.wake();
    expect(s.wakes).toEqual([[s.manager.id, reason]]);
  }
});

test("a note to an idle receiver lands at once and is announced; to a busy one it waits without a turn", () => {
  const idle = setup(false);
  const landed = idle.inbox.post(idle.message({ kind: "note" }));
  landed.wake();
  expect([Boolean(landed.message), landed.mailboxItem, idle.wakes]).toEqual([true, null, []]);
  expect(idle.emits.map((e) => e.event)).toEqual([SSE_EVENTS.agentMessageAppended]);
  const busy = setup(true);
  const waiting = busy.inbox.post(busy.message({ kind: "note" }));
  waiting.wake();
  expect([waiting.mailboxItem?.triggerTurn, waiting.message, busy.emits, busy.wakes]).toEqual([false, null, [], []]);
});

test("every posted message carries its kind and key, and keeps its own metadata", () => {
  const s = setup();
  const report = s.inbox.post(s.message()).mailboxItem!;
  expect(report.content.type === "text" && report.content.metadata).toEqual({ workerReport: { key: "done" }, inbox: { kind: "report", key: "feature:feat_notes" } });
  const failed = s.inbox.post(s.message({ kind: "lifecycle", lifecycleReason: "failed" })).mailboxItem!;
  expect(failed.content.type === "text" && failed.content.metadata?.inbox).toEqual({ kind: "lifecycle", key: "feature:feat_notes", lifecycleReason: "failed" });
  const note = s.inbox.post(s.message({ kind: "note" })).message!;
  expect(note.content.type === "text" && note.content.metadata?.inbox).toEqual({ kind: "note", key: "feature:feat_notes" });
});
