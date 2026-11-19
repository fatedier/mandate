import { expect, test } from "bun:test";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { recordingInbox } from "./helpers/upward-inbox.js";
import { ScheduleStore } from "../src/server/modules/schedules/schedule-store.js";
import { createDutyReports } from "../src/server/modules/schedules/duty-reports.js";
import type { ThreadStop } from "../src/shared/thread-dot.js";
import type { DutyReportOutcome } from "../src/shared/api/schedules.js";

const AT = "2026-11-06T01:31:00.000Z";

function setup(opts: { tasksOf?: (threadId: string) => Array<{ id: string; title: string }> } = {}) {
  const env = freshStoresEnv("md-duty-reports-");
  const store = new ScheduleStore(env.store.db);
  const duty = env.agentStore.createManagerThread("greenhouse watch");
  store.insert({ threadId: duty.id, name: "greenhouse daily check", cron: "0 9 * * *", timezone: "UTC", checkScript: "c", checkTimeoutMs: 60_000, brief: "b", status: "active", nextDueAt: null }, AT);
  store.ensureDutyThread(duty.id, "investigate", "/tmp/notes", AT);
  const personal = env.agentStore.getOrCreatePersonalThread();
  const { inbox, wakes } = recordingInbox(env.agentStore);
  let stop: ThreadStop | null = "stopped";
  let waits = 0;
  const recorded: Array<[string, DutyReportOutcome]> = [];
  const reports = createDutyReports({
    store, agentStore: env.agentStore, workersStore: env.workers, inbox,
    stopOf: () => stop,
    waitsOn: () => waits,
    agentName: () => "Juno",
    onRecorded: (_threadId, messageId, outcome) => { recorded.push([messageId, outcome]); },
    now: () => AT,
    ...(opts.tasksOf ? { tasksOf: opts.tasksOf } : {})
  });
  const reply = (text: string) => env.agentStore.appendMessage({ threadId: duty.id, role: "assistant", source: "self", content: { type: "assistant", text, toolCalls: [] } });
  const told = () => env.store.db.prepare("select content, trigger_turn from agent_mailbox where thread_id = ? order by rowid").all(personal.id) as Array<{ content: string; trigger_turn: number }>;
  const notes = () => env.agentStore.getActiveMessages(personal.id).filter((m) => m.source === "thread-notice");
  const asked = () => env.store.db.prepare("select source, content from agent_mailbox where thread_id = ? order by rowid").all(duty.id) as Array<{ source: string; content: string }>;
  /** The duty thread's mail lands, as its next turn starts. */
  const land = () => {
    const wake = env.agentStore.createWake({ threadId: duty.id, reason: "schedule", triggerMessageId: null, metadata: null });
    env.agentStore.drainMailboxToMessages(duty.id, wake.id);
    env.agentStore.finishWake(wake.id, "finished");
  };
  return {
    env, store, duty, personal, reports, reply, told, notes, wakes, recorded, asked, land,
    set: (o: { stop?: ThreadStop | null; waits?: number }) => {
      if (o.stop !== undefined) stop = o.stop;
      if (o.waits !== undefined) waits = o.waits;
    }
  };
}

const textOf = (content: string) => (JSON.parse(content) as { text: string }).text;

test("a schedule round's final reply is reported to the personal agent", () => {
  const s = setup();
  const r = s.reply("Bed 3 too dry: the drip line was blocked; one new clamp fixes it. Fix it?");
  s.reports.noteSettled(s.duty.id);
  const told = s.told();
  expect(told).toHaveLength(1);
  expect(textOf(told[0]!.content)).toBe(`[Thread notice] Duty thread "greenhouse watch" (${s.duty.id}): reports.\nReport:\nBed 3 too dry: the drip line was blocked; one new clamp fixes it. Fix it?`);
  expect(s.wakes).toStrictEqual([{ threadId: s.personal.id, reason: "thread-notice" }]);
  expect(s.recorded).toStrictEqual([[r.id, "sent"]]);
});

test("NO_REPORT alone, or as the last line under a note for the record, is silent; anything else is sent", () => {
  for (const [text, outcome] of [[" NO_REPORT \n", "no_report"], ["Both reviewers are running; next check in 10 min.\n\nNO_REPORT\n", "no_report"], ["NO_REPORT.", "sent"], ["no_report", "sent"], ["NO_REPORT\n\nmore", "sent"], ["Nothing new. NO_REPORT", "sent"]] as const) {
    const s = setup();
    const r = s.reply(text);
    s.reports.noteSettled(s.duty.id);
    expect(s.recorded).toStrictEqual([[r.id, outcome]]);
    expect(s.told()).toHaveLength(outcome === "sent" ? 1 : 0);
  }
});

test("owner round then schedule round tell differently", () => {
  const s = setup();
  s.env.agentStore.appendMessage({ threadId: s.duty.id, role: "user", source: "user", content: { type: "text", text: "What are you keeping track of now?" } });
  const own = s.reply("Open: none. Known noise: fan 2 hums at night.");
  s.reports.noteSettled(s.duty.id);
  expect(s.told()).toStrictEqual([]);
  const quiet = s.notes();
  expect(quiet).toHaveLength(1);
  const text = (quiet[0]!.content as { text: string }).text;
  expect(text).toContain(`[Thread notice] Duty thread "greenhouse watch" (${s.duty.id}): the user wrote to it directly`);
  expect(text).toContain("The user said:\nWhat are you keeping track of now?");
  expect(text).toContain("Its reply:\nOpen: none. Known noise: fan 2 hums at night.");
  s.env.agentStore.appendMessage({ threadId: s.duty.id, role: "user", source: "schedule", content: { type: "text", text: "[Mandate schedule check]\nschedule: greenhouse daily check (id sch_1)" } });
  const scheduled = s.reply("qwer is gone since the line was cleared: closed.");
  s.reports.noteSettled(s.duty.id);
  expect(s.told()).toHaveLength(1);
  expect(s.recorded).toStrictEqual([[own.id, "owner_note"], [scheduled.id, "sent"]]);
});

test("an open wait from the personal agent tells instead", () => {
  const s = setup();
  const r = s.reply("A new drip line is ordered.");
  s.set({ waits: 1 });
  s.reports.noteSettled(s.duty.id);
  expect(s.told()).toStrictEqual([]);
  expect(s.recorded).toStrictEqual([[r.id, "told_by_wait"]]);
});

test("settling twice tells once; nothing while not stopped or after a newer word", () => {
  const s = setup();
  s.reply("first");
  s.set({ stop: null });
  s.reports.noteSettled(s.duty.id);
  expect(s.told()).toStrictEqual([]);
  s.set({ stop: "stopped" });
  s.env.agentStore.appendMessage({ threadId: s.duty.id, role: "user", source: "user", content: { type: "text", text: "wait" } });
  s.reports.noteSettled(s.duty.id);
  expect(s.told()).toStrictEqual([]);
  s.reply("second");
  s.reports.noteSettled(s.duty.id);
  s.reports.noteSettled(s.duty.id);
  // The owner's "wait" made the round theirs: told once, as their note.
  expect([s.told().length, s.notes().length]).toStrictEqual([0, 1]);
  expect(s.recorded.map(([, outcome]) => outcome)).toStrictEqual(["owner_note"]);
});

test("a worker's settle reports its duty thread", () => {
  const s = setup();
  const projectId = seedProject(s.env.projects);
  const workerId = seedWorker(s.env.workers, projectId, { ownerThreadId: s.duty.id } as never);
  const worker = s.env.agentStore.getOrCreateThread("worker", workerId);
  s.reply("dry-bed found the cause.");
  s.reports.noteSettled(worker.id);
  expect(s.told()).toHaveLength(1);
});

test("a failed round tells the personal agent, with the error its turn ended on", () => {
  const s = setup();
  s.reply("Halfway through the sensor readings.");
  const wake = s.env.agentStore.createWake({ threadId: s.duty.id, reason: "schedule", triggerMessageId: null, metadata: null });
  s.env.agentStore.finishWake(wake.id, "error", "The provider is overloaded (529).");
  s.set({ stop: "failed" });
  s.reports.noteSettled(s.duty.id);
  const told = s.told();
  expect(told).toHaveLength(1);
  expect(textOf(told[0]!.content)).toBe(
    `[Thread notice] Duty thread "greenhouse watch" (${s.duty.id}): its round failed.\nLast error: The provider is overloaded (529).\nLast reply:\nHalfway through the sensor readings.`
  );
});

test("a turn that stopped repeating a failing call names that stop as its error", () => {
  const s = setup();
  s.reply("Reading the sensors.");
  const wake = s.env.agentStore.createWake({ threadId: s.duty.id, reason: "schedule", triggerMessageId: null, metadata: null });
  s.env.agentStore.finishWake(wake.id, "stuck", "Stopped: the same call failed 5 times.");
  s.set({ stop: "failed" });
  s.reports.noteSettled(s.duty.id);
  expect(textOf(s.told()[0]!.content)).toContain("its round failed.\nLast error: Stopped: the same call failed 5 times.\n");
});

test("an ordinary manager thread is not reported", () => {
  const s = setup();
  const other = s.env.agentStore.createManagerThread("Release 3.21");
  s.env.agentStore.appendMessage({ threadId: other.id, role: "assistant", source: "self", content: { type: "assistant", text: "done", toolCalls: [] } });
  s.reports.noteSettled(other.id);
  expect(s.told()).toStrictEqual([]);
  expect(s.recorded).toStrictEqual([]);
});

test("a failed round with no new reply is told once", () => {
  const s = setup();
  s.reply("earlier report");
  s.reports.noteSettled(s.duty.id);
  expect(s.told()).toHaveLength(1);
  s.env.agentStore.appendMessage({ threadId: s.duty.id, role: "user", source: "wake-failure", content: { type: "text", text: "the model was unreachable" } });
  s.set({ stop: "failed" });
  s.reports.noteSettled(s.duty.id);
  s.reports.noteSettled(s.duty.id);
  const told = s.told();
  expect(told).toHaveLength(2);
  expect(textOf(told[1]!.content)).toContain("its round failed.");
});

test("a failed round with an open wait is told by the wait alone", () => {
  const s = setup();
  const r = s.reply("halfway");
  s.set({ stop: "failed", waits: 1 });
  s.reports.noteSettled(s.duty.id);
  expect(s.told()).toStrictEqual([]);
  expect(s.recorded).toStrictEqual([[r.id, "told_by_wait"]]);
});

test("a round that stopped on a worker's open question is still reported", () => {
  const s = setup();
  const r = s.reply("dry-bed asks whether to replace the whole drip line; I recommend no.");
  s.set({ stop: "needs_you" });
  s.reports.noteSettled(s.duty.id);
  expect(s.told()).toHaveLength(1);
  expect(s.recorded).toStrictEqual([[r.id, "sent"]]);
});

const ASK_AGAIN = "[Duty] This round ended with an empty reply. Your last reply is your report to Juno: reply with it, or with exactly NO_REPORT.";

test("an empty last reply asks the duty thread, once, for its report; the personal agent hears nothing yet", () => {
  const s = setup();
  s.env.agentStore.appendMessage({ threadId: s.duty.id, role: "user", source: "schedule", content: { type: "text", text: "[Mandate schedule check]\nschedule: greenhouse daily check (id sch_1)" } });
  s.reply("");
  s.reports.noteSettled(s.duty.id);
  // Settled again before the ask lands: still one ask.
  s.reports.noteSettled(s.duty.id);
  expect(s.asked().map((m) => [m.source, textOf(m.content)])).toStrictEqual([["schedule", ASK_AGAIN]]);
  expect(s.wakes).toStrictEqual([{ threadId: s.duty.id, reason: "schedule" }]);
  expect([s.told(), s.recorded]).toStrictEqual([[], []]);
  s.land();
  const report = s.reply("New: bed 5 at half its usual moisture since 09:00.");
  s.reports.noteSettled(s.duty.id);
  expect(s.told()).toHaveLength(1);
  expect(s.recorded).toStrictEqual([[report.id, "sent"]]);
});

test("an empty reply to the ask is no report, and is not asked about again", () => {
  const s = setup();
  s.reply("");
  s.reports.noteSettled(s.duty.id);
  s.land();
  const again = s.reply("");
  s.reports.noteSettled(s.duty.id);
  s.reports.noteSettled(s.duty.id);
  expect(s.asked()).toHaveLength(1);
  expect(s.told()).toStrictEqual([]);
  expect(s.recorded).toStrictEqual([[again.id, "no_report"]]);
});

test("stopped before it answers the ask, the round ends as no report and nothing is asked again", () => {
  const s = setup();
  const empty = s.reply("");
  s.reports.noteSettled(s.duty.id);
  // The ask lands and its turn is stopped before any reply.
  s.land();
  s.reports.noteSettled(s.duty.id);
  s.reports.noteSettled(s.duty.id);
  expect(s.asked()).toHaveLength(1);
  expect(s.wakes).toHaveLength(1);
  expect(s.told()).toStrictEqual([]);
  expect(s.recorded).toStrictEqual([[empty.id, "no_report"]]);
  // That ask belonged to that round: a later round that ends empty is asked its own.
  s.env.agentStore.appendMessage({ threadId: s.duty.id, role: "user", source: "worker-report", content: { type: "text", text: "[Worker report] dry-bed: done" } });
  s.reply("");
  s.reports.noteSettled(s.duty.id);
  expect(s.asked()).toHaveLength(2);
  expect(s.recorded).toStrictEqual([[empty.id, "no_report"]]);
});

test("an empty last reply of the owner's own round, or one the personal agent waits on, is told as before", () => {
  const s = setup();
  s.env.agentStore.appendMessage({ threadId: s.duty.id, role: "user", source: "user", content: { type: "text", text: "anything new?" } });
  const own = s.reply("");
  s.reports.noteSettled(s.duty.id);
  const waited = setup();
  waited.set({ waits: 1 });
  const r = waited.reply("");
  waited.reports.noteSettled(waited.duty.id);
  expect([s.asked(), waited.asked()]).toStrictEqual([[], []]);
  expect(s.recorded).toStrictEqual([[own.id, "owner_note"]]);
  expect(waited.recorded).toStrictEqual([[r.id, "told_by_wait"]]);
});

test("the owner's round that went through a worker is told as theirs, with their words, though its last turn was the worker's report", () => {
  const s = setup();
  s.env.agentStore.appendMessage({ threadId: s.duty.id, role: "user", source: "user", content: { type: "text", text: "dig into the dry soil in bed 3" } });
  s.env.agentStore.appendMessage({ threadId: s.duty.id, role: "assistant", source: "self", wakeId: "wake_1", content: { type: "assistant", text: "A worker is on it.", toolCalls: [] } });
  // The worker's report starts another turn; its reply ends the round.
  s.env.agentStore.appendMessage({ threadId: s.duty.id, role: "user", source: "worker-report", content: { type: "text", text: "[Worker report] fixed on branch fix-drip-line" } });
  const last = s.env.agentStore.appendMessage({ threadId: s.duty.id, role: "assistant", source: "self", wakeId: "wake_2", content: { type: "assistant", text: "Fixed on branch fix-drip-line, for review.", toolCalls: [] } });
  s.reports.noteSettled(s.duty.id);
  expect(s.recorded).toStrictEqual([[last.id, "owner_note"]]);
  expect(s.told()).toStrictEqual([]);
  const text = (s.notes()[0]!.content as { text: string }).text;
  expect(text).toContain("The user said:\ndig into the dry soil in bed 3");
  expect(text).toContain("Its reply:\nFixed on branch fix-drip-line, for review.");
});

test("a schedule's wake after the owner's words makes the round the schedule's", () => {
  const s = setup();
  s.env.agentStore.appendMessage({ threadId: s.duty.id, role: "user", source: "user", content: { type: "text", text: "keep an eye on bed 5 too" } });
  s.env.agentStore.appendMessage({ threadId: s.duty.id, role: "user", source: "schedule", content: { type: "text", text: "[Mandate schedule check]\nschedule: greenhouse daily check (id sch_1)" } });
  const r = s.reply("New: bed 5 at half its usual moisture.");
  s.reports.noteSettled(s.duty.id);
  expect(s.recorded).toStrictEqual([[r.id, "sent"]]);
});

// A duty thread linked to a task reports by its own rule,
// naming the task, so the personal agent can move it.
test("a duty report names the thread's open tasks", () => {
  const s = setup({ tasksOf: () => [{ id: "tsk_aaaaaaaaaaa", title: "Keep the beds watered" }] });
  s.reply("Bed 3 too dry: the drip line was blocked.");
  s.reports.noteSettled(s.duty.id);
  expect(textOf(s.told()[0]!.content)).toContain(`Linked to task: "Keep the beds watered" (tsk_aaaaaaaaaaa)`);
  s.set({ stop: "failed" });
  s.reply("The check script timed out.");
  s.reports.noteSettled(s.duty.id);
  expect(textOf(s.told()[1]!.content)).toContain(`Linked to task: "Keep the beds watered" (tsk_aaaaaaaaaaa)`);
});
