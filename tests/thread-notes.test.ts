import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { freshStoresEnv, withTempDataDir } from "./helpers/fixtures.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { testShellRunner } from "./helpers/shell-runner.js";
import { tempDir } from "./helpers/temp.js";
import type { ScheduleRunner } from "../src/server/modules/schedules/schedule-manager.js";
import { threadNotesDir } from "../src/server/platform/fs/resources.js";

// A manager thread compacted again and again keeps notes that outlast the
// summaries: from its third compaction (or once it has notes), its runtime
// context shows where they are and its index. A duty thread keeps only its own.

// The block's own words: a duty thread's notes have a heading of the same name.
const NOTES = "\n## Your notes\n\nThis thread has been compacted several times";

function setup() {
  const data = withTempDataDir();
  const env = freshStoresEnv("md-thread-notes-");
  const scheduleRunner: ScheduleRunner = { run: async () => ({ stdout: '{"wake":false}', stderr: "", exitCode: 0, timedOut: false }) };
  const runtime = testAgentRuntime(env, {
    scheduleRunner,
    scheduleClock: { now: () => Date.parse("2026-11-05T08:20:00.000Z"), setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
    commandRunner: testShellRunner(tempDir("shell-home-"))
  });
  const context = async (threadId: string) => (await runtime.scopes.manager.buildRuntimeContext?.(threadId)) ?? "";
  let n = 0;
  const compact = (threadId: string) => {
    n += 1;
    env.agentStore.appendMessage({
      threadId, role: "user", source: "compression",
      content: { type: "summary", summary: `what came before, part ${n}`, replacedRange: [1, 1], replacedCount: 1, compactedCount: 1, retained: [] }
    });
  };
  const index = (threadId: string, text: string) => {
    fs.mkdirSync(threadNotesDir(threadId), { recursive: true });
    fs.writeFileSync(path.join(threadNotesDir(threadId), "index.md"), text);
  };
  return { env, runtime, context, compact, index, close: () => { runtime.dispose(); data.restore(); } };
}

test("a thread compacted twice has no notes; at the third it has, with an empty index", async () => {
  const s = setup();
  try {
    const thread = s.env.agentStore.createManagerThread("Release 3.21").id;
    s.compact(thread);
    s.compact(thread);
    expect(await s.context(thread)).not.toContain(NOTES);
    expect(fs.existsSync(threadNotesDir(thread))).toBe(false);
    s.compact(thread);
    const text = await s.context(thread);
    expect(text).toContain(NOTES);
    expect(text).toContain("This thread has been compacted several times, and each compaction keeps only a summary of what came before.");
    expect(text).toContain(`Keep what this thread must not lose in notes in ${threadNotesDir(thread)}.`);
    expect(text).toContain("what every thread should know goes to memory.");
    expect(text).toContain("index.md as it is now:\n(empty)");
    // The folder is there for the thread to write in.
    expect(fs.statSync(threadNotesDir(thread)).isDirectory()).toBe(true);
    // Another thread's count is its own.
    expect(await s.context(s.env.agentStore.createManagerThread("Docs layout").id)).not.toContain(NOTES);
  } finally { s.close(); }
});

test("the index is shown as it is on disk, and a long one is cut", async () => {
  const s = setup();
  try {
    const thread = s.env.agentStore.createManagerThread("Release 3.21").id;
    for (let i = 0; i < 3; i++) s.compact(thread);
    s.index(thread, "## Open\n- release-3.21: waits on the user's go for the tag");
    expect(await s.context(thread)).toContain("index.md as it is now:\n## Open\n- release-3.21: waits on the user's go for the tag");
    s.index(thread, "x".repeat(9000));
    expect(await s.context(thread)).toContain("[Cut at 8000 characters: shorten notes/index.md.]");
  } finally { s.close(); }
});

test("notes already on disk are shown below three compactions", async () => {
  const s = setup();
  try {
    const thread = s.env.agentStore.createManagerThread("Release 3.21").id;
    s.index(thread, "- release-3.21: tag pushed");
    expect(await s.context(thread)).toContain("index.md as it is now:\n- release-3.21: tag pushed");
  } finally { s.close(); }
});

test("a thread keeps one notes folder: on duty its duty block shows it, off duty this section; never both", async () => {
  const s = setup();
  try {
    const made = await s.runtime.schedules.create({ name: "greenhouse daily check", cron: "0 9 * * *", timezone: "UTC", check: "c", brief: "Watch the greenhouse.", thread: { newTitle: "greenhouse watch" } });
    if (!("schedule" in made)) throw new Error(JSON.stringify(made));
    const thread = made.schedule.threadId;
    for (let i = 0; i < 3; i++) s.compact(thread);
    const onDuty = await s.context(thread);
    expect(onDuty).toContain("## Your duty");
    expect(onDuty).toContain(`Your notes are in ${threadNotesDir(thread)}.`);
    expect(onDuty).not.toContain(NOTES);
    // What it wrote on duty is what it reads off duty.
    s.index(thread, "- greenhouse bed 3: dry from an open vent, ruled out");
    s.runtime.schedules.delete(made.schedule.id);
    const off = await s.context(thread);
    expect(off).not.toContain("## Your duty");
    expect(off).toContain(NOTES);
    expect(off).toContain("index.md as it is now:\n- greenhouse bed 3: dry from an open vent, ruled out");
  } finally { s.close(); }
});

test("only a thread's summaries count as compactions", () => {
  const s = setup();
  try {
    const thread = s.env.agentStore.createManagerThread("Release 3.21").id;
    // Rows of a compaction that are not its summary.
    s.env.agentStore.appendMessage({ threadId: thread, role: "user", source: "compression", content: { type: "text", text: "a compaction's note" } });
    s.env.agentStore.appendMessage({ threadId: thread, role: "system", source: "compression", content: { type: "summary", summary: "x", replacedRange: [1, 1], replacedCount: 1, compactedCount: 1, retained: [] } });
    s.env.agentStore.appendMessage({ threadId: thread, role: "user", source: "user", content: { type: "text", text: "hello" } });
    s.compact(thread);
    s.compact(thread);
    expect(s.env.agentStore.hasCompactions(thread, 2)).toBe(true);
    expect(s.env.agentStore.hasCompactions(thread, 3)).toBe(false);
    s.compact(thread);
    expect(s.env.agentStore.hasCompactions(thread, 3)).toBe(true);
  } finally { s.close(); }
});
