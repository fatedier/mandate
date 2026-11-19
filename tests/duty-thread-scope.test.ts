import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { freshStoresEnv, withTempDataDir } from "./helpers/fixtures.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { testShellRunner } from "./helpers/shell-runner.js";
import { tempDir } from "./helpers/temp.js";
import type { ScheduleRunner } from "../src/server/modules/schedules/schedule-manager.js";
import { threadNotesDir } from "../src/server/platform/fs/resources.js";

function setup() {
  const data = withTempDataDir();
  const env = freshStoresEnv("md-duty-scope-");
  const scheduleRunner: ScheduleRunner = { run: async () => ({ stdout: '{"wake":false}', stderr: "", exitCode: 0, timedOut: false }) };
  const runtime = testAgentRuntime(env, {
    scheduleRunner,
    scheduleClock: { now: () => Date.parse("2026-11-04T08:20:00.000Z"), setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
    commandRunner: testShellRunner(tempDir("shell-home-"))
  });
  const manager = runtime.scopes.manager;
  const toolsOf = (threadId: string) => Object.keys((manager.dispatcherForThread?.(threadId) ?? manager.wrappedDispatcher).registry.tools);
  const context = async (threadId: string) => (await manager.buildRuntimeContext?.(threadId)) ?? "";
  const duty = async (over: Record<string, unknown> = {}) => {
    const made = await runtime.schedules.create({ name: "greenhouse daily check", cron: "0 9 * * *", timezone: "UTC", check: "c", brief: "Watch the greenhouse's soil moisture.", thread: { newTitle: "greenhouse watch" }, ...over } as Parameters<typeof runtime.schedules.create>[0]);
    if (!("schedule" in made)) throw new Error(JSON.stringify(made));
    return made.schedule;
  };
  return { env, runtime, toolsOf, context, duty, close: () => { runtime.dispose(); data.restore(); } };
}

test("a duty thread is offered no question to the owner; an ordinary thread is", async () => {
  const s = setup();
  try {
    const schedule = await s.duty();
    const tools = s.toolsOf(schedule.threadId);
    expect(tools).not.toContain("ask_user");
    expect(tools).not.toContain("withdraw_question");
    expect(tools).toEqual(expect.arrayContaining(["bash", "monitor", "schedule_wake"]));
    const ordinary = s.env.agentStore.createManagerThread("Release 3.21");
    expect(s.toolsOf(ordinary.id)).toContain("ask_user");
  } finally { s.close(); }
});

test("a duty thread's context carries its briefs, level, notes and how it reports", async () => {
  const s = setup();
  try {
    const schedule = await s.duty({ level: "fix_for_review" });
    const text = await s.context(schedule.threadId);
    expect(text).toContain("## Your duty");
    expect(text).toContain('Schedule "greenhouse daily check" (Daily 09:00):\nWatch the greenhouse\'s soil moisture.');
    expect(text).toContain("Level: fix for review. Workers may fix what you find and open a branch or PR");
    expect(text).toContain(`Your notes are in ${threadNotesDir(schedule.threadId)}.`);
    expect(text).toContain("index.md as it is now:\n(empty)");
    expect(text).toContain("your last reply is exactly NO_REPORT and nothing else");
    // The agent's name as it answers to it (unnamed, the default), as relayed messages carry it.
    expect(text).toContain("everything goes to Mandate, who decides what the user sees");
  } finally { s.close(); }
});

test("a changed notes index changes the context, and a long one is cut", async () => {
  const s = setup();
  try {
    const schedule = await s.duty();
    const before = await s.context(schedule.threadId);
    fs.writeFileSync(path.join(threadNotesDir(schedule.threadId), "index.md"), "## Open\n- sig:qwer Dry soil in bed 3");
    const after = await s.context(schedule.threadId);
    expect(after).not.toBe(before);
    expect(after).toContain("- sig:qwer Dry soil in bed 3");
    fs.writeFileSync(path.join(threadNotesDir(schedule.threadId), "index.md"), "x".repeat(9000));
    expect(await s.context(schedule.threadId)).toContain("[Cut at 8000 characters: shorten notes/index.md.]");
  } finally { s.close(); }
});

test("a thread whose last schedule is deleted is an ordinary thread again", async () => {
  const s = setup();
  try {
    const schedule = await s.duty();
    s.runtime.schedules.delete(schedule.id);
    expect(s.toolsOf(schedule.threadId)).toContain("ask_user");
    expect(await s.context(schedule.threadId)).not.toContain("## Your duty");
  } finally { s.close(); }
});
