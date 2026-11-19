import { expect, test } from "bun:test";
import { Hono } from "hono";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { ScheduleStore } from "../src/server/modules/schedules/schedule-store.js";
import { dutySummary } from "../src/server/modules/schedules/schedule-dto.js";
import { schedulesModule } from "../src/server/modules/schedules/module.js";
import { ManagerThreadService } from "../src/server/modules/agent/manager-threads.js";
import { withDutyMarks } from "../src/server/modules/agent/agent-message-dto.js";
import { API_PATHS } from "../src/shared/api-contracts.js";
import type { AppDeps } from "../src/server/app/deps.js";
import type { AgentClientMessageDto } from "../src/shared/api/agents.js";
import { mountAgentsRoutes } from "../src/server/modules/agent/agents-api.js";
import { AgentUserMessageQueue } from "../src/server/modules/agent/user-message-queue.js";
import type { ScopeRuntime } from "../src/server/runtime/scope.js";
import { stub } from "./helpers/typed.js";

const AT = "2026-11-04T08:21:00.000Z";

function setup() {
  const env = freshStoresEnv("md-duty-summary-");
  const store = new ScheduleStore(env.store.db);
  const duty = env.agentStore.createManagerThread("greenhouse watch");
  const ordinary = env.agentStore.createManagerThread("Release 3.21");
  const sch = store.insert({ threadId: duty.id, name: "greenhouse daily check", cron: "0 9 * * *", timezone: "UTC", checkScript: "c", checkTimeoutMs: 60_000, brief: "b", status: "active", nextDueAt: "2026-11-05T09:00:00.000Z" }, AT);
  store.ensureDutyThread(duty.id, "fix_for_review", "/tmp/n", AT);
  return { env, store, duty, ordinary, sch };
}

test("a duty thread's summary: its level, its schedules and whether schedules are off", () => {
  const s = setup();
  expect(dutySummary(s.store, true, s.duty.id)).toStrictEqual({
    level: "fix_for_review", schedulesOff: true,
    schedules: [{ id: s.sch.id, threadId: s.duty.id, name: "greenhouse daily check", cron: "0 9 * * *", cronText: "Daily 09:00", timezone: "UTC", status: "active", pausedReason: null, nextDueAt: "2026-11-05T09:00:00.000Z", lastRunAt: null, lastOutcome: null, consecutiveFailures: 0, checksRun: 0, running: false, briefLine: "b" }],
    reportedSeq: null, sidebarAddedAt: null
  });
  expect(dutySummary(s.store, false, s.ordinary.id)).toBeNull();
  // A check in flight, as the manager says.
  expect(dutySummary(s.store, false, s.duty.id, (id) => id === s.sch.id)!.schedules[0]!.running).toBe(true);
});

test("a duty thread's summary says its newest sent report, not one kept as NO_REPORT", () => {
  const s = setup();
  const reply = (text: string) => s.env.agentStore.appendMessage({ threadId: s.duty.id, role: "assistant", source: "self", content: { type: "assistant", text, toolCalls: [] } });
  expect(dutySummary(s.store, false, s.duty.id)!.reportedSeq).toBeNull();
  const sent = reply("Bed 3 moisture down");
  const kept = reply("NO_REPORT");
  s.store.recordReport(sent.id, s.duty.id, "sent", AT);
  s.store.recordReport(kept.id, s.duty.id, "no_report", AT);
  expect(dutySummary(s.store, false, s.duty.id)!.reportedSeq).toBe(sent.seq);
});

test("a summary says when the thread was put in the sidebar", () => {
  const s = setup();
  expect(dutySummary(s.store, false, s.duty.id)!.sidebarAddedAt).toBeNull();
  s.store.addToSidebar(s.duty.id, AT);
  s.store.addToSidebar(s.duty.id, "2026-11-05T10:00:00.000Z");
  expect(dutySummary(s.store, false, s.duty.id)!.sidebarAddedAt).toBe(AT);
  expect(s.store.removeFromSidebar(s.duty.id)).toBe(true);
  expect(s.store.removeFromSidebar(s.duty.id)).toBe(false);
  expect(dutySummary(s.store, false, s.duty.id)!.sidebarAddedAt).toBeNull();
});

test("a schedule's brief line is its brief's first line, at most 120 characters", () => {
  const s = setup();
  const brief = (b: string) => s.store.insert({ threadId: s.duty.id, name: "n", cron: "0 9 * * *", timezone: "UTC", checkScript: "c", checkTimeoutMs: 60_000, brief: b, status: "active", nextDueAt: null }, AT);
  const a = brief("\n  Watch the soil sensors for dry beds.\nThen look at the water tank.");
  const b = brief("x".repeat(200));
  const lines = new Map(dutySummary(s.store, false, s.duty.id)!.schedules.map((x) => [x.id, x.briefLine]));
  expect(lines.get(a.id)).toBe("Watch the soil sensors for dry beds.");
  expect(lines.get(b.id)).toBe(`${"x".repeat(119)}…`);
});

test("the thread list carries the duty summary; a thread without one has null", () => {
  const s = setup();
  const service = new ManagerThreadService({ agentStore: s.env.agentStore, dutySummary: (threadId) => dutySummary(s.store, false, threadId) });
  expect(service.dto(s.duty.id)!.duty).toMatchObject({ level: "fix_for_review", schedules: [{ id: s.sch.id }] });
  expect(service.dto(s.ordinary.id)!.duty).toBeNull();
  expect(new ManagerThreadService({ agentStore: s.env.agentStore }).dto(s.duty.id)!.duty).toBeNull();
});

test("a duty reply carries what became of it; others carry nothing", () => {
  const messages = [{ id: "m1" }, { id: "m2" }, { id: "m3" }] as unknown as AgentClientMessageDto[];
  const marked = withDutyMarks(messages, (ids) => new Map(ids.filter((id) => id !== "m2").map((id) => [id, id === "m1" ? "sent" : "no_report"] as const)));
  expect(marked.map((m) => m.dutyReport)).toStrictEqual(["sent", undefined, "no_report"]);
  expect(withDutyMarks(messages, undefined)).toBe(messages);
});

test("a schedule's last checks are read; nothing else is offered over HTTP", async () => {
  const calls: Array<[string, number]> = [];
  const app = new Hono();
  schedulesModule.mountRoutes!(app, { deps: { schedules: { runs: (id: string, limit: number) => { calls.push([id, limit]); return [{ dueAt: AT, startedAt: AT, outcome: "quiet", line: "", missed: 0, durationMs: 3 }]; } } } as unknown as AppDeps, upgradeWebSocket: (() => {}) as never });
  const res = await app.request(API_PATHS.scheduleRuns("sch_1"));
  expect(res.status).toBe(200);
  expect(await res.json()).toStrictEqual({ runs: [{ dueAt: AT, startedAt: AT, outcome: "quiet", line: "", missed: 0, durationMs: 3 }] });
  expect(calls).toStrictEqual([["sch_1", 10]]);
  for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
    expect((await app.request(API_PATHS.scheduleRuns("sch_1"), { method })).status).toBe(404);
  }
});

test("a thread's history carries what became of its duty replies, recorded ones only", async () => {
  const s = setup();
  const reply = (text: string) => s.env.agentStore.appendMessage({ threadId: s.duty.id, role: "assistant", source: "self", content: { type: "assistant", text, toolCalls: [] } });
  const sent = reply("Bed 3 moisture down");
  const plain = reply("Looking.");
  const silent = reply("NO_REPORT");
  s.store.recordReport(sent.id, s.duty.id, "sent", AT);
  s.store.recordReport(silent.id, s.duty.id, "no_report", AT);
  const hono = new Hono();
  const wakeScheduler = { wake: () => "wake-1" };
  mountAgentsRoutes(hono, {
    agentStore: s.env.agentStore, wakeScheduler,
    userMessageQueue: new AgentUserMessageQueue({ agentStore: s.env.agentStore, wakeScheduler }),
    scopes: { worker: stub<ScopeRuntime>({ verifyScopeId: () => null }) },
    dutyReportsFor: (ids) => s.store.reportsFor(ids)
  });
  const marks = async (query: string) => {
    const body = await (await hono.request(`${API_PATHS.agentThread(s.duty.id)}${query}`)).json() as { messages: AgentClientMessageDto[] };
    return Object.fromEntries(body.messages.map((m) => [m.id, m.dutyReport ?? null])) as Record<string, string | null>;
  };
  const expected = { [sent.id]: "sent", [plain.id]: null, [silent.id]: "no_report" };
  expect(await marks("")).toStrictEqual(expected);
  expect(await marks("?since=0")).toStrictEqual(expected);
});
