import { expect, spyOn, test } from "bun:test";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { reportWorkerQuestion, reportWorkerSilentStop, reportWorkerWakeEnd } from "../src/server/runtime/worker-report.js";
import { formatWorkerReportText, workerReportOf } from "../src/shared/worker-report.js";
import { toolContext } from "./helpers/typed.js";
import { recordingInbox } from "./helpers/upward-inbox.js";
import { parseCut } from "./helpers/cut-line.js";

function setup(prefix: string) {
  const e = freshStoresEnv(prefix);
  const projectId = seedProject(e.projects, { name: "project-1" });
  const workerId = seedWorker(e.workers, projectId, { name: "project-2 cache expiry" });
  const workStore = new WorkItemStore(e.store.db);
  const planStore = new PlanStore(e.store.db);
  const workerThread = e.agentStore.getOrCreateThread("worker", workerId);
  const manager = e.agentStore.createManagerThread("General");
  e.workers.setOwner(workerId, manager.id);
  const changed: string[] = [];
  let busy = false;
  const { inbox, wakes } = recordingInbox(e.agentStore, { busy: () => busy });
  const deps = {
    agentStore: e.agentStore,
    workersStore: e.workers,
    projectsStore: e.projects,
    workStore,
    planStore,
    inbox,
    onWorkItemChanged: (item: { workerId: string }) => changed.push(item.workerId),
    now: () => "2026-09-27T12:00:00.000Z"
  };
  const reports = () => e.store.db
    .prepare("select thread_id, source, content from agent_mailbox where source = 'worker-report' order by created_at, id")
    .all() as Array<{ thread_id: string; source: string; content: string }>;
  return { ...e, projectId, workerId, workStore, planStore, workerThread, manager, wakes, changed, deps, reports, setBusy: (b: boolean) => { busy = b; } };
}

test("a wake that finishes the plan reports done once, to the latest thread, and wakes it", () => {
  const s = setup("md-wr-done-");
  s.planStore.update(s.workerId, { conclusion: "EvictHook wired; tests pass.", steps: [{ title: "Wire", status: "done", note: "commit abc123" }] });
  const r = reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null });
  expect(r?.key).toBe("done");
  const rows = s.reports();
  expect(rows.length).toBe(1);
  expect(rows[0]!.thread_id).toBe(s.manager.id);
  expect(workerReportOf(JSON.parse(rows[0]!.content))).toMatchObject({
    workerId: s.workerId, workerName: "project-2 cache expiry", projectName: "project-1", key: "done", line: "EvictHook wired; tests pass."
  });
  expect(s.wakes).toStrictEqual([{ threadId: s.manager.id, reason: "worker-report" }]);
  // Same key again: silent.
  expect(reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null })).toBe(null);
  expect(s.reports().length).toBe(1);
});

test("an in-progress wake end stores its key but reports nothing; the next arrival at done reports again", () => {
  const s = setup("md-wr-cycle-");
  s.planStore.update(s.workerId, { steps: [{ title: "Wire", status: "done", note: "ok" }] });
  reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null });
  s.planStore.update(s.workerId, { steps: [{ title: "More", status: "in_progress" }] });
  expect(reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null })).toBe(null);
  expect(s.workStore.getReportedState(s.workerId)).toBe("in_progress");
  s.planStore.update(s.workerId, { steps: [{ id: 2, status: "done", note: "ok" }] });
  expect(reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null })?.key).toBe("done");
  expect(s.reports().length).toBe(2);
});

test("error records the failure and reports failed; a later finished wake clears it", () => {
  const s = setup("md-wr-failed-");
  s.planStore.update(s.workerId, { steps: [{ title: "Run", status: "in_progress" }] });
  const r = reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "error", errorMessage: "provider returned 500" });
  expect(r).toMatchObject({ key: "failed", line: "provider returned 500" });
  expect(s.workStore.getByWorker(s.workerId)).toMatchObject({ failedAt: "2026-09-27T12:00:00.000Z", failedKind: "error", failedMessage: "provider returned 500" });
  expect(s.changed).toStrictEqual([s.workerId]);
  reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null });
  expect(s.workStore.getByWorker(s.workerId)).toMatchObject({ failedAt: null, failedMessage: null });
  expect(s.changed).toStrictEqual([s.workerId, s.workerId]);
});

test("a stuck end records a Stopped failure and reports stopped with its reason; a finished wake clears Stopped", () => {
  const s = setup("md-wr-stuck-");
  const reason = "spawn_pane failed 5 times in a row: x";
  const r = reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "stuck", errorMessage: reason });
  expect(r).toMatchObject({ key: "stopped", line: reason });
  expect(s.workStore.getByWorker(s.workerId)).toMatchObject({ failedAt: "2026-09-27T12:00:00.000Z", failedKind: "stopped", failedMessage: reason });
  expect(s.changed).toStrictEqual([s.workerId]);
  reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null });
  expect(s.workStore.getByWorker(s.workerId)).toMatchObject({ failedAt: null, failedKind: null, failedMessage: null });
});

test("a stop after an error with the same text turns Failed into Stopped", () => {
  // Same instant, same message: only the kind differs, and it still counts as a change.
  const s = setup("md-wr-kind-");
  const reason = "read failed 5 times in a row: ENOENT";
  reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "error", errorMessage: reason });
  const r = reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "stuck", errorMessage: reason });
  expect(r).toMatchObject({ key: "stopped", line: reason });
  expect(s.workStore.getByWorker(s.workerId)).toMatchObject({ failedKind: "stopped", failedMessage: reason });
  expect(s.changed).toStrictEqual([s.workerId, s.workerId]);
});

test("a report that fails to queue is not marked as sent: the next wake in that state reports it", () => {
  const s = setup("md-wr-atomic-");
  s.planStore.update(s.workerId, { openQuestions: ["Accept the write-behind risk?"] });
  const refusing = Object.assign(Object.create(Object.getPrototypeOf(s.agentStore)), s.agentStore, {
    enqueueMailboxMessage: () => { throw new Error("disk full"); }
  });
  const failing = { ...s.deps, agentStore: refusing, inbox: recordingInbox(refusing).inbox };
  expect(() => reportWorkerWakeEnd(failing, { threadId: s.workerThread.id, status: "finished", errorMessage: null })).toThrow("disk full");
  expect(s.workStore.getReportedState(s.workerId)).not.toBe("input");
  expect(reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null })?.key).toBe("input");
  expect(s.reports().length).toBe(1);
});

test("a report whose mark the database refuses is not queued either: the next try sends it once", () => {
  const s = setup("md-wr-mark-");
  s.planStore.update(s.workerId, { openQuestions: ["Accept the write-behind risk?"] });
  const failing = {
    ...s.deps,
    workStore: Object.assign(Object.create(Object.getPrototypeOf(s.workStore)), s.workStore, {
      setReportedState: () => { throw new Error("database is locked"); }
    })
  };
  expect(() => reportWorkerWakeEnd(failing, { threadId: s.workerThread.id, status: "finished", errorMessage: null })).toThrow("database is locked");
  expect(s.reports()).toEqual([]);
  // Nothing went in, so no one is woken for it.
  expect(s.wakes).toStrictEqual([]);
  expect(reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null })?.key).toBe("input");
  expect(s.reports().length).toBe(1);
});

// A worker's question reaches its manager the moment it is written into the
// plan: the worker may work on for minutes before its turn ends.
test("a question is reported at once to the owner and wakes it; the end of that turn does not repeat it", () => {
  const s = setup("md-wr-question-");
  s.planStore.update(s.workerId, { openQuestions: ["Accept the write-behind risk?", "Ship behind a flag?"], steps: [{ title: "Decide", status: "in_progress" }] });
  const report = reportWorkerQuestion(s.deps, { workerId: s.workerId });
  expect(report).toMatchObject({ workerId: s.workerId, workerName: "project-2 cache expiry", projectName: "project-1", key: "input", line: "Accept the write-behind risk?" });
  const rows = s.reports();
  expect(rows.map((r) => r.thread_id)).toEqual([s.manager.id]);
  expect(JSON.parse(rows[0]!.content).text).toBe(`[Worker report] project-2 cache expiry (${s.workerId}, project project-1): input — Accept the write-behind risk?`);
  expect(s.wakes).toStrictEqual([{ threadId: s.manager.id, reason: "worker-report" }]);
  expect(s.workStore.getReportedState(s.workerId)).toBe("input");
  // The turn ends with the question still open: the manager has heard it.
  expect(reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null })).toBe(null);
  expect(s.reports().length).toBe(1);
  // A second question beside the first: the report says the new one, not the first again.
  expect(reportWorkerQuestion(s.deps, { workerId: s.workerId, questions: ["Ship behind a flag?"] })?.line).toBe("Ship behind a flag?");
  // Two new at once: the first, and that there is another.
  expect(reportWorkerQuestion(s.deps, { workerId: s.workerId, questions: ["Tag it too?", "Announce it?"] })?.line).toBe("Tag it too? (+1 more)");
  expect(s.reports().length).toBe(3);
});

test("the turn that asked and then failed still reports its failure", () => {
  const s = setup("md-wr-question-failed-");
  s.planStore.update(s.workerId, { openQuestions: ["Accept the write-behind risk?"] });
  reportWorkerQuestion(s.deps, { workerId: s.workerId });
  expect(reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "error", errorMessage: "provider returned 500" })?.key).toBe("failed");
  // Two rows of one millisecond have no order of their own: compare what was said.
  expect(s.reports().map((r) => workerReportOf(JSON.parse(r.content))!.key).sort()).toEqual(["failed", "input"]);
});

test("nothing is reported for a plan that asks nothing, an archived worker, or one with no work item", () => {
  const s = setup("md-wr-question-skip-");
  expect(reportWorkerQuestion(s.deps, { workerId: s.workerId })).toBe(null);
  expect(reportWorkerQuestion(s.deps, { workerId: "wkr_missing" })).toBe(null);
  s.planStore.update(s.workerId, { openQuestions: ["Accept the write-behind risk?"] });
  s.workers.archive(s.workerId);
  expect(reportWorkerQuestion(s.deps, { workerId: s.workerId })).toBe(null);
  expect(s.reports()).toEqual([]);
  expect(s.wakes).toStrictEqual([]);
});

test("canceled changes nothing: no key, no failure change, no report", () => {
  const s = setup("md-wr-cancel-");
  s.planStore.update(s.workerId, { openQuestions: ["Accept the write-behind risk?"] });
  expect(reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "canceled", errorMessage: null })).toBe(null);
  expect(s.workStore.getReportedState(s.workerId)).toBe(null);
  expect(s.reports().length).toBe(0);
});

// No wake starts on a busy target: the report waits in its mailbox, which the
// runtime reads for the wake that follows the one running.
test("a busy target keeps the report in its mailbox and starts no wake", () => {
  const s = setup("md-wr-busy-");
  s.setBusy(true);
  s.planStore.update(s.workerId, { openQuestions: ["Accept the write-behind risk?"] });
  reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null });
  expect(s.wakes).toStrictEqual([]);
  expect(s.reports().map((r) => r.thread_id)).toEqual([s.manager.id]);
});

test("a manager thread, a worker whose work item is gone and an archived worker report nothing", () => {
  const s = setup("md-wr-skip-");
  expect(reportWorkerWakeEnd(s.deps, { threadId: s.manager.id, status: "error", errorMessage: "x" })).toBe(null);
  const bare = seedWorker(s.workers, s.projectId, { name: "no work item", tmuxWindowName: "bare" });
  s.store.db.prepare("delete from work_items where worker_id = ?").run(bare);
  expect(reportWorkerWakeEnd(s.deps, { threadId: s.agentStore.getOrCreateThread("worker", bare).id, status: "error", errorMessage: "x" })).toBe(null);
  s.workers.archive(s.workerId);
  expect(reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "error", errorMessage: "x" })).toBe(null);
  expect(s.reports().length).toBe(0);
});

test("reports go to the owner, not the latest thread", () => {
  const s = setup("md-wr-owner-");
  const other = s.agentStore.createManagerThread("Other");
  s.agentStore.appendMessage({ threadId: other.id, role: "user", source: "user", content: { type: "text", text: "newer" } });
  s.planStore.update(s.workerId, { openQuestions: ["Accept the write-behind risk?"] });
  reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null });
  expect(s.reports()[0]!.thread_id).toBe(s.manager.id);
});

test("report to a missing owner goes to the latest thread and re-owns", () => {
  const s = setup("md-wr-lost-");
  const owners: string[] = [];
  const latest = s.agentStore.createManagerThread("Latest");
  s.agentStore.appendMessage({ threadId: latest.id, role: "user", source: "user", content: { type: "text", text: "here" } });
  s.agentStore.archiveThread(s.manager.id);
  s.planStore.update(s.workerId, { openQuestions: ["Accept the write-behind risk?"] });
  reportWorkerWakeEnd({ ...s.deps, onOwnerChanged: (workerId: string, threadId: string) => owners.push(`${workerId}->${threadId}`) },
    { threadId: s.workerThread.id, status: "finished", errorMessage: null });
  expect(s.reports()[0]!.thread_id).toBe(latest.id);
  expect(s.workers.getById(s.workerId)?.ownerThreadId).toBe(latest.id);
  expect(owners).toStrictEqual([`${s.workerId}->${latest.id}`]);
});

test("report with no thread open at all opens one named after the worker", () => {
  const s = setup("md-wr-none-");
  s.agentStore.archiveThread(s.manager.id);
  s.planStore.update(s.workerId, { openQuestions: ["Accept the write-behind risk?"] });
  reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null });
  const target = s.reports()[0]!.thread_id;
  expect(s.agentStore.getThreadById(target)?.title).toBe("project-2 cache expiry");
  expect(s.workers.getById(s.workerId)?.ownerThreadId).toBe(target);
});

test("follow-up work after a finished plan reports again: the reopened plan leaves done, and finishing it reports done anew", async () => {
  const s = setup("md-wr-followup-");
  const { buildPlanToolPacks } = await import("../src/server/modules/plans/plan-tools.js");
  const update = buildPlanToolPacks({ scope: "worker", store: s.store, agentStore: s.agentStore, workersStore: s.workers, workStore: s.workStore })
    .flatMap((p) => p.tools).find((t) => t.name === "update_plan")!;
  const ctx = toolContext({
    threadId: s.workerThread.id, wakeId: "w",
    scope: { kind: "worker", worker: { workingDir: null }, project: { workingDir: "/tmp" } },
    worker: s.workers.getById(s.workerId) ?? undefined
  });
  const wakeEnd = () => reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null })?.key ?? null;
  await update.handler({ steps: [{ title: "Wire", status: "done", note: "ok" }] }, ctx);
  const keys = [wakeEnd()];
  // Asked for a change: a follow-up step, over more than one wake.
  await update.handler({ steps: [{ title: "Rename the flag", status: "in_progress" }] }, ctx);
  keys.push(wakeEnd());
  await update.handler({ steps: [{ id: 2, status: "done", note: "renamed" }] }, ctx);
  keys.push(wakeEnd());
  expect(keys).toStrictEqual(["done", null, "done"]);
  expect(s.reports().length).toBe(2);
});

// Each state goes up as its kind: a final answer is a report, a question a
// request, a failure or a stop a lifecycle event; all keyed on the worker's
// worker.
test("each reported state goes up as its kind, keyed on its worker, and wakes the owner once after its write", () => {
  const s = setup("md-wr-kinds-");
  const sent: Array<{ key: string; inbox: unknown }> = [];
  const seen = new Set<string>();
  const end = (status: "finished" | "error" | "stuck") => {
    const r = reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status, errorMessage: status === "finished" ? null : "x" });
    // The one row this end wrote (rows of one millisecond sort by random ids).
    const fresh = s.reports().filter((row) => !seen.has(row.content));
    expect(fresh).toHaveLength(1);
    seen.add(fresh[0]!.content);
    const content = JSON.parse(fresh[0]!.content);
    expect(workerReportOf(content)?.key).toBe(r!.key);
    sent.push({ key: r!.key, inbox: content.metadata.inbox });
  };
  s.planStore.update(s.workerId, { steps: [{ title: "Wire", status: "done", note: "ok" }] });
  end("finished");
  s.planStore.update(s.workerId, { steps: [{ id: 1, status: "blocked", note: "waits on upstream" }] });
  end("finished");
  s.planStore.update(s.workerId, { openQuestions: ["Ship behind a flag?"] });
  end("finished");
  end("error");
  end("stuck");
  const key = `worker:${s.workerId}`;
  expect(sent).toStrictEqual([
    { key: "done", inbox: { kind: "report", key } },
    { key: "blocked", inbox: { kind: "report", key } },
    { key: "input", inbox: { kind: "request", key } },
    { key: "failed", inbox: { kind: "lifecycle", key, lifecycleReason: "failed" } },
    { key: "stopped", inbox: { kind: "lifecycle", key, lifecycleReason: "failed" } }
  ]);
  expect(s.wakes).toStrictEqual(sent.map(() => ({ threadId: s.manager.id, reason: "worker-report" })));
});

test("a question written mid-turn goes up as a request keyed on its worker", () => {
  const s = setup("md-wr-question-kind-");
  s.planStore.update(s.workerId, { openQuestions: ["Accept the write-behind risk?"] });
  reportWorkerQuestion(s.deps, { workerId: s.workerId });
  expect(JSON.parse(s.reports()[0]!.content).metadata.inbox).toStrictEqual({ kind: "request", key: `worker:${s.workerId}` });
});

// A report at a turn's end carries what the worker last said, so its manager
// need not read the worker's thread for it.
function endedTurn(s: ReturnType<typeof setup>, reply: string | null) {
  const wake = s.agentStore.createWake({ threadId: s.workerThread.id, reason: "user", triggerMessageId: null });
  if (reply !== null) s.agentStore.appendMessage({ threadId: s.workerThread.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: reply } });
  s.agentStore.finishWake(wake.id, "finished");
  return wake.id;
}
const reportText = (s: ReturnType<typeof setup>) => JSON.parse(s.reports().at(-1)!.content) as { text: string; metadata: unknown };

test("a report at a turn's end carries the worker's last reply; its card reads the same", () => {
  const s = setup("md-wr-last-reply-");
  s.planStore.update(s.workerId, { conclusion: "EvictHook wired.", steps: [{ title: "Wire", status: "done", note: "ok" }] });
  const wakeId = endedTurn(s, "Wired the hook; 41 tests pass. The flag stays off by default.");
  const report = reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null, lastTurn: { wakeId, relayedTo: () => false } })!;
  const content = reportText(s);
  expect(content.text).toBe(`${formatWorkerReportText(report)}\n\nLast reply:\nWired the hook; 41 tests pass. The flag stays off by default.`);
  expect(workerReportOf(content as never)).toEqual(report);
});

test("a long last reply is cut at 4,000 characters, the whole saved for the manager", () => {
  const s = setup("md-wr-last-reply-long-");
  s.planStore.update(s.workerId, { steps: [{ title: "Wire", status: "blocked", note: "waits on review" }] });
  const reply = `${"w".repeat(4999)}.`;
  const wakeId = endedTurn(s, reply);
  reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null, lastTurn: { wakeId, relayedTo: () => false } });
  const tail = reportText(s).text.split("\n\nLast reply:\n")[1]!;
  expect(parseCut(tail)).toEqual({ kept: "w".repeat(4000), first: 4000, of: 5000, whole: reply });
});

test("a report carries no reply when the turn's reply already went up to the manager, or the turn said nothing", () => {
  const s = setup("md-wr-no-last-reply-");
  s.planStore.update(s.workerId, { steps: [{ title: "Wire", status: "done", note: "ok" }] });
  const relayed = endedTurn(s, "Done, as I told you.");
  reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null, lastTurn: { wakeId: relayed, relayedTo: (threadId) => threadId === s.manager.id } });
  expect(reportText(s).text).not.toContain("Last reply:");
  s.planStore.update(s.workerId, { steps: [{ id: 1, status: "blocked", note: "waits" }] });
  const silent = endedTurn(s, null);
  reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null, lastTurn: { wakeId: silent, relayedTo: () => false } });
  expect(reportText(s).text).not.toContain("Last reply:");
});

test("a question written mid-turn carries no reply: the turn has not ended", () => {
  const s = setup("md-wr-question-no-reply-");
  endedTurn(s, "Earlier words.");
  s.planStore.update(s.workerId, { openQuestions: ["Ship behind a flag?"] });
  reportWorkerQuestion(s.deps, { workerId: s.workerId });
  expect(reportText(s).text).not.toContain("Last reply:");
});

test("a silent stop goes up as a lifecycle event with the turn's last reply, wakes the owner once, and leaves the reported state as it was", () => {
  const s = setup("md-wr-silent-");
  s.planStore.update(s.workerId, { steps: [{ title: "Wire", status: "done", note: "ok" }, { title: "Report", status: "in_progress" }] });
  reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null });
  expect(s.workStore.getReportedState(s.workerId)).toBe("in_progress");
  const wakeId = endedTurn(s, "Half of the report is written.");
  const report = reportWorkerSilentStop(s.deps, { threadId: s.workerThread.id, wakeId })!;
  expect(report).toMatchObject({ key: "silent", line: "It stopped with steps still open and nothing set to wake it, so it stays idle until you message it. Next open step: #2 Report" });
  const content = reportText(s) as { text: string; metadata: Record<string, unknown> };
  expect(content.text).toBe(`${formatWorkerReportText(report)}\n\nLast reply:\nHalf of the report is written.`);
  expect(content.metadata.inbox).toStrictEqual({ kind: "lifecycle", key: `worker:${s.workerId}`, lifecycleReason: "stopped_silent" });
  expect(s.wakes).toStrictEqual([{ threadId: s.manager.id, reason: "worker-report" }]);
  expect(s.workStore.getReportedState(s.workerId)).toBe("in_progress");
});

test("a report carries the reply when it went up to another thread than the one the report reaches, and reads no whole conversation for it", () => {
  const s = setup("md-wr-relayed-elsewhere-");
  s.planStore.update(s.workerId, { steps: [{ title: "Wire", status: "done", note: "ok" }] });
  const wakeId = endedTurn(s, "Done; the old owner heard it.");
  // The one read left that runs to a thread's end.
  const whole = spyOn(s.agentStore, "getMessagesSince");
  reportWorkerWakeEnd(s.deps, { threadId: s.workerThread.id, status: "finished", errorMessage: null, lastTurn: { wakeId, relayedTo: (threadId) => threadId === "thr_archived_owner" } });
  expect(reportText(s).text.endsWith("\n\nLast reply:\nDone; the old owner heard it.")).toBe(true);
  expect(whole).not.toHaveBeenCalled();
  whole.mockRestore();
});
