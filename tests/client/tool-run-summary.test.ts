import { expect, test } from "bun:test";
import { formatDateTime } from "@/lib/format";
import {
  bashExitNote,
  describeCall,
  describeRun,
  lineChanges,
  rowElapsedMs,
  rowStatus,
  answeringProgram,
  slowDuration,
  type CallNames,
  type ToolRunRow
} from "@/routes/window/chat/tool-run-summary";

const START = "2026-08-02T10:04:00.000Z";

function row(toolName: string, args: unknown, extra: Partial<ToolRunRow> = {}): ToolRunRow {
  return {
    call: { toolCallId: `${toolName}-${JSON.stringify(args).length}`, toolName, args },
    result: { result: "ok", createdAt: "2026-08-02T10:04:00.500Z" },
    isRunning: false,
    startedAt: START,
    ...extra
  };
}

const said = (r: ToolRunRow) => {
  const p = describeCall(r);
  return [p.lead, p.detail, p.detailIsCode ? "code" : "text"];
};

test("bash reads as the model's description when it wrote one, else as the command", () => {
  expect(said(row("bash", { command: "bun test tests/a.test.ts", description: "Run the composer tests" })))
    .toEqual(["Ran", "Run the composer tests", "text"]);
  expect(said(row("bash", { command: "git status --short" }))).toEqual(["Ran", "git status --short", "code"]);
  // A blank description is no description.
  expect(said(row("bash", { command: "ls", description: "  " }))).toEqual(["Ran", "ls", "code"]);
});

test("send_keys reads as its description, else as the keys pressed", () => {
  expect(said(row("send_keys", { paneId: "%4", args: ["C-c"], description: "Stop the dev server" })))
    .toEqual(["Sent keys", "Stop the dev server", "text"]);
  // Without one, what was typed (quoted, as tmux runs it together) and
  // pressed; -l is how, not what.
  expect(said(row("send_keys", { paneId: "%4", args: ["-l", "bun run dev --port 4180"] })))
    .toEqual(["Sent keys", '"bun run dev --port 4180"', "code"]);
  expect(said(row("send_keys", { paneId: "%4", args: ["bun run dev", "Enter"] })))
    .toEqual(["Sent keys", '"bun run dev" Enter', "code"]);
  expect(said(row("send_keys", { paneId: "%4", args: ["ls", "-la", "Enter"] })))
    .toEqual(["Sent keys", '"ls-la" Enter', "code"]);
  // An option not read: the args as sent.
  expect(said(row("send_keys", { paneId: "%4", args: ["-N", "3", "Up"] })))
    .toEqual(["Sent keys", "-N 3 Up", "code"]);
});

test("a description on any other tool is an argument, not the call's purpose", () => {
  // `description` here is what the memory is being searched for.
  const p = describeCall(row("memory_recall_by_description", { description: "how the pill rule works", limit: 8 }));
  expect([p.lead, p.leadIsToolName]).toEqual(["memory_recall_by_description", true]);
  expect(p.detail).toContain("description=how the pill rule works");
});

test("file tools read as a verb and the file's name", () => {
  expect(said(row("read", { path: "src/client/routes/window/chat/ChatInput.tsx", offset: 96 })))
    .toEqual(["Read", "ChatInput.tsx", "code"]);
  expect(said(row("edit", { path: "src/a/b.ts", oldString: "x", newString: "y" }))).toEqual(["Edited", "b.ts", "code"]);
  expect(said(row("write", { path: "notes/plan.md", content: "…" }))).toEqual(["Wrote", "plan.md", "code"]);
  expect(said(row("view_image", { path: "shots/home.png" }))).toEqual(["Viewed", "home.png", "code"]);
});

test("a running call reads in the present tense", () => {
  const running = { isRunning: true, result: null };
  expect(said(row("bash", { command: "bun run test:e2e", description: "Run the e2e suite" }, running)))
    .toEqual(["Running", "Run the e2e suite", "text"]);
  expect(said(row("read", { path: "a/b.ts" }, running))).toEqual(["Reading", "b.ts", "code"]);
});

test("a tool with no wording keeps its name and its argument summary, ids left out", () => {
  const p = describeCall(row("some_new_tool", { taskId: "11111111-1111-4111-8111-111111111111", status: "waiting" }));
  expect([p.lead, p.leadIsToolName]).toEqual(["some_new_tool", true]);
  expect(p.detail).not.toContain("11111111");
});

test("a canvas publish is titled from its own result, and never from a failed one", () => {
  const args = { canvasId: "cnv_StUv56WxYzA" };
  const payload = { ok: true, canvasId: "cnv_StUv56WxYzA", title: "Feature report", path: "/canvas/abc" };
  expect(said(row("canvas_publish", args, { result: { result: payload, createdAt: START } })))
    .toEqual(["Published canvas", "Feature report", "text"]);
  // Well-formed apart from the flag, so `ok` is the only thing to reject it on.
  expect(describeCall(row("canvas_publish", args, { result: { result: { ...payload, ok: false }, createdAt: START } })).detail)
    .toBe("");
  // A success-shaped payload on a call that failed.
  expect(describeCall(row("canvas_publish", args, { result: { result: payload, isError: true, error: "read-only", createdAt: START } })).detail)
    .toBe("");
});

test("a finished run names the work it did, what it changed first, and counts the other calls", () => {
  const run = [
    row("read", { path: "a.ts" }),
    row("bash", { command: "ls" }),
    row("read", { path: "b.ts" }),
    row("edit", { path: "a.ts" }),
    row("write", { path: "c.ts" }),
    row("send_keys", { paneId: "%1", args: ["C-c"] }),
    row("task_update", { status: "done" })
  ];
  expect(describeRun(run).tally).toEqual({ clauses: ["Edited 2 files", "ran 1 command", "sent keys once", "read 2 files"], unnamed: 1 });
  expect(describeRun(run).phrase).toBe(null);
  expect(describeRun([row("bash", { command: "a" }), row("bash", { command: "b" })]).tally)
    .toEqual({ clauses: ["Ran 2 commands"], unnamed: 0 });
});

test("a run's web searches and page reads are named as work, after reading files", () => {
  const search = (q: string) => row("web_search", { query: q });
  const fetch = (u: string) => row("web_fetch", { url: u });
  expect(describeRun([search("a"), fetch("https://a.test/")]).tally).toEqual({ clauses: ["Searched the web once", "fetched 1 page"], unnamed: 0 });
  expect(describeRun([search("a"), fetch("https://a.test/"), search("b"), fetch("https://b.test/"), fetch("https://c.test/")]).tally)
    .toEqual({ clauses: ["Searched the web 2 times", "fetched 3 pages"], unnamed: 0 });
  expect(describeRun([fetch("https://a.test/"), row("bash", { command: "a" }), search("a"), row("read", { path: "x.ts" }), row("bash", { command: "b" })]).tally)
    .toEqual({ clauses: ["Ran 2 commands", "read 1 file", "searched the web once", "fetched 1 page"], unnamed: 0 });
});

test("a tally names the work in one order, whatever order it was done in", () => {
  const run = [
    on("read", { path: "/repo/a.ts" }, "x", "r1"),
    on("send_keys", { paneId: "%1", args: ["Enter"] }, { ok: true }, "k1"),
    on("bash", { command: "ls" }, "exitCode: 0", "b1"),
    on("edit", { path: "/repo/a.ts", oldString: "a", newString: "b" }, "Updated /repo/a.ts (1 replacement, +1 -1 lines).", "e1"),
    on("write", { path: "/repo/b.ts", content: "x" }, "Created /repo/b.ts (1 byte, 1 line).", "w1")
  ];
  expect(describeRun(run).tally?.clauses).toEqual(["Created 1 file", "edited 1 file", "ran 1 command", "sent keys once", "read 1 file"]);
});

test("the plan, panes and other steps are counted beside work, and said only in a run that did none", () => {
  const run = [
    row("update_plan", { steps: [{ id: 1, status: "in_progress" }] }),
    row("read_plan", {}),
    row("update_plan", { steps: [{ id: 1, status: "done", note: "ok" }] }),
    row("bash", { command: "ls" })
  ];
  expect(describeRun(run).tally).toEqual({ clauses: ["Ran 1 command"], unnamed: 3 });
  // No work: every kind, in the order each first appeared, and nothing left over.
  expect(describeRun([run[2]!, run[1]!, run[0]!]).tally).toEqual({ clauses: ["Updated the plan 2 times", "read a plan"], unnamed: 0 });
  expect(describeRun([run[1]!, run[1]!]).tally).toEqual({ clauses: ["Read plans 2 times"], unnamed: 0 });
});

test("a single call's run reads as that call", () => {
  const summary = describeRun([row("bash", { command: "ls", description: "List the files" })]);
  expect([summary.phrase?.lead, summary.phrase?.detail, summary.tally, summary.count]).toEqual(["Ran", "List the files", null, 1]);
});

test("a run in progress reads as the step it is on", () => {
  const summary = describeRun([
    row("read", { path: "a.ts" }),
    row("bash", { command: "bun run test:e2e", description: "Run the e2e suite" }, { isRunning: true, result: null })
  ]);
  expect([summary.running, summary.phrase?.lead, summary.phrase?.detail, summary.tally, summary.count])
    .toEqual([true, "Running", "Run the e2e suite", null, 2]);
});

test("failures are counted; a call with no result is not one", () => {
  const summary = describeRun([
    row("bash", { command: "a" }, { result: { error: "exit 1", isError: true, createdAt: START } }),
    row("bash", { command: "b" }, { result: null }),
    row("bash", { command: "c" })
  ]);
  expect(summary.failed).toBe(1);
});

test("a call's duration is known only from a real start to a real finish", () => {
  const at = (createdAt: string | undefined, extra: Partial<ToolRunRow> = {}) =>
    rowElapsedMs(row("bash", { command: "x" }, { result: createdAt === undefined ? { result: "" } : { result: "", createdAt }, ...extra }));
  expect(at("2026-08-02T10:09:12.000Z")).toBe(312_000);
  expect(at(undefined)).toBeNull();
  expect(at("not-a-date")).toBeNull();
  expect(at("2026-08-02T10:03:59.000Z")).toBeNull();
  expect(at("2026-08-02T10:04:02.000Z", { startedAt: "not-a-date" })).toBeNull();
  expect(at("2026-08-02T10:09:12.000Z", { startedAt: undefined })).toBeNull();
  // Still flagged running though its result landed: no duration from a stale start.
  expect(at("2026-08-02T10:09:12.000Z", { isRunning: true })).toBeNull();
});

test("a duration is printed only from one second up", () => {
  expect(slowDuration(999)).toBeNull();
  expect(slowDuration(1000)).toEqual({ ms: 1000, label: "1.0s" });
  expect(slowDuration(312_000)?.label).toBe("5m 12s");
  expect(slowDuration(null)).toBeNull();
});

test("a tool named after an Object.prototype member is just another tool", () => {
  // The model names the tool; a hallucinated `constructor` must not crash the
  // transcript by finding something on the prototype.
  const summary = describeRun([
    row("constructor", { a: 1 }, { result: { error: "unknown tool", isError: true, createdAt: START } }),
    row("toString", { b: 2 })
  ]);
  expect(summary.tally).toEqual({ clauses: ["Used 2 tools"], unnamed: 0 });
  expect(summary.failed).toBe(1);
});

test("a tool that reports failure in its result has failed", () => {
  // send_keys answers a stale pane with `{ error }` rather than throwing, so the
  // call is not flagged isError; the line must still say it failed.
  const stale = row("send_keys", { paneId: "%4", args: ["C-c"] }, { result: { result: { error: "pane %4 is not in this feature" }, createdAt: START } });
  const fine = row("send_keys", { paneId: "%4", args: ["C-c"] }, { result: { result: { ok: true }, createdAt: START } });
  // An `error` beside `ok: true` is a detail of a success, not a failure.
  const okWithNote = row("task_update", { status: "done" }, { result: { result: { ok: true, error: "retried once" }, createdAt: START } });
  expect([rowStatus(stale), rowStatus(fine), rowStatus(okWithNote)]).toEqual(["error", "ok", "ok"]);
  expect(describeRun([stale, fine]).failed).toBe(1);
  // A bash command that exits non-zero is not a failed call: grep finding nothing exits 1.
  expect(rowStatus(row("bash", { command: "grep x y" }, { result: { result: "stdout:\n\nexitCode: 1", createdAt: START } }))).toBe("ok");
});

test("a bash command that exits non-zero failed, unless exit 1 is that command's answer", () => {
  const ran = (command: string, exitCode: number | null) =>
    rowStatus(row("bash", { command }, { result: { result: exitCode === null ? "stdout:\nok" : `stdout:\n\nexitCode: ${exitCode}`, createdAt: START } }));
  // The four cases: two errors, two answers.
  expect(ran("false", 1)).toBe("error");
  expect(ran("grep -q x /no/such/file", 2)).toBe("error");
  expect(ran("grep -q no-such-text /dev/null", 1)).toBe("ok");
  expect(ran("diff a.txt b.txt", 1)).toBe("ok");
  // The case this exists for.
  expect(ran("bun test tests/chat-input.test.tsx", 1)).toBe("error");
  // cd failed and rg never ran: the 1 is cd's.
  expect(ran("cd /missing && rg pattern .", 1)).toBe("error");
  expect(ran("rg missing .;", 1)).toBe("ok");
  expect(ran("bun test", 0)).toBe("ok");
  // Could not start at all.
  expect(ran("ls", -1)).toBe("error");
  // No exit code to read: nothing to judge by.
  expect(ran("ls", null)).toBe("ok");
});

test("only a single pipeline names the program whose exit status it reports", () => {
  expect(answeringProgram("grep x f | sort")).toBe("sort");
  expect(answeringProgram("FOO=1 LANG=C /usr/bin/grep x y")).toBe("grep");
  // A `|` or `&&` inside a quoted pattern splits nothing.
  expect(answeringProgram(`grep -E "a|b" file`)).toBe("grep");
  expect(answeringProgram("rg 'x|y' src")).toBe("rg");
  expect(answeringProgram(`grep "a && b" file`)).toBe("grep");
  // A trailing separator is not a list.
  expect(answeringProgram("rg missing .;")).toBe("rg");
  // A list can end on any of its commands' status, so it names none.
  expect(answeringProgram("cd src && grep -rn Enter .")).toBeNull();
  expect(answeringProgram("make || true")).toBeNull();
  expect(answeringProgram("cd a; rg x")).toBeNull();
  expect(answeringProgram("")).toBeNull();
});

test("only a bash call has an exit to note, however another tool's output ends", () => {
  const ending = (toolName: string, text: string): ToolRunRow =>
    ({ call: { toolCallId: "x", toolName, args: {} }, result: { result: text }, isRunning: false });
  // A pane read can end on the same words, printed by whatever ran there.
  expect(bashExitNote(ending("read_pane", "$ ./run.sh\nexitCode: 3"))).toBe(null);
  expect(bashExitNote(ending("bash", "stdout:\nx\nexitCode: 3"))).toBe("exit 3");
  expect(bashExitNote(ending("bash", "exitCode: -1"))).toBe("exit -1");
  expect(bashExitNote(ending("bash", "exitCode: 0"))).toBe(null);
});

// What a transcript named: the call "named-pane" acted on "dev server", and
// feature feat_1 is "Import list". Any other call or feature is unnamed.
const SOURCES = new Map<string, ToolRunRow>([
  ["of-pane", { call: { toolCallId: "named-pane", toolName: "read_pane", args: { paneId: "%4" } }, result: { result: "…" }, isRunning: false }],
  ["of-bash", { call: { toolCallId: "b1", toolName: "bash", args: { command: "go doc ./...", description: "Dump the package docs" } }, result: { result: "…" }, isRunning: false }],
  ["of-bare-bash", { call: { toolCallId: "b2", toolName: "bash", args: { command: "go doc ./..." } }, result: { result: "…" }, isRunning: false }],
  ["of-list", { call: { toolCallId: "l1", toolName: "list_panes", args: {} }, result: { result: "…" }, isRunning: false }],
  // A source that is itself a read of a saved output, and one linked back to
  // itself: neither is followed further.
  ["of-read", { call: { toolCallId: "of-pane", toolName: "read", args: { path: "/u/.mandate/tool-output/thr_1/a.txt" } }, result: { result: "…" }, isRunning: false }],
  ["loop", { call: { toolCallId: "loop", toolName: "read", args: { path: "/u/.mandate/tool-output/thr_1/b.txt" } }, result: { result: "…" }, isRunning: false }]
]);
const NAMES: CallNames = {
  pane: (callId) => (callId === "named-pane" ? "dev server" : null),
  feature: (id) => (id === "feat_1" ? "Import list" : null),
  canvas: (id) => (id === "cnv_1" ? "PR #33" : null),
  savedOutput: (callId) => SOURCES.get(callId) ?? null
};

const on = (toolName: string, args: unknown, result: unknown = { ok: true }, callId = "named-pane"): ToolRunRow => ({
  call: { toolCallId: callId, toolName, args },
  result: { result },
  isRunning: false
});
const worded = (r: ToolRunRow) => {
  const p = describeCall(r, NAMES);
  return [p.lead, p.detail, p.detailIsCode ? "code" : "text"];
};

test("a read of a saved output reads as whose output it is, as that call's own line says it", () => {
  const saved = "/Users/u/.mandate/resources/projects/p1/tool-output/thr_1/4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a.txt";
  const read = (callId: string, path = saved): ToolRunRow => on("read", { path, offset: 401, limit: 400 }, "   401\tx", callId);
  const cases: Array<[ToolRunRow, string[]]> = [
    [read("of-pane"), ["Read saved output of", "dev server", "text"]],
    [read("of-bash"), ["Read saved output of", "Dump the package docs", "text"]],
    [read("of-bare-bash"), ["Read saved output of", "go doc ./...", "code"]],
    // A source whose own line names nothing.
    [read("of-list"), ["Read saved output", "", "text"]],
    [read("of-read"), ["Read saved output", "", "text"]],
    [read("loop"), ["Read saved output", "", "text"]],
    // No source in this transcript (another thread's, a mistyped path): the
    // place such files are saved still says what it is.
    [read("elsewhere"), ["Read saved output", "", "text"]],
    [read("elsewhere", "C:\\Users\\u\\.mandate\\tool-output\\thr_1\\4d5e6f7a.txt"), ["Read saved output", "", "text"]],
    // Only that place: a file merely named so is a file.
    [read("elsewhere", "/repo/tool-output/report.txt"), ["Read", "report.txt", "code"]],
    [read("elsewhere", "/repo/tool-output/a/b/report.txt"), ["Read", "report.txt", "code"]]
  ];
  for (const [row, expected] of cases) expect([row.call.toolCallId, ...worded(row)]).toEqual([row.call.toolCallId, ...expected]);
  const running: ToolRunRow = { ...read("of-pane"), result: null, isRunning: true };
  expect(worded(running)).toEqual(["Reading saved output of", "dev server", "text"]);
  // Without the transcript's names, the place alone.
  expect(describeCall(read("of-pane")).lead).toBe("Read saved output");
});

test("every tool in use reads as what it did, in words", () => {
  const cases: Array<[ToolRunRow, string[]]> = [
    [on("read_pane", { paneId: "%4" }, "screen"), ["Read", "dev server", "text"]],
    [on("kill_pane", { paneId: "%4" }), ["Closed", "dev server", "text"]],
    [on("set_pane_metadata", { paneId: "%4", name: "dev server (4180)" }), ["Renamed a pane to", "dev server (4180)", "text"]],
    [on("set_pane_metadata", { paneId: "%4", name: "" }), ["Cleared the name of", "dev server", "text"]],
    [on("set_pane_metadata", { paneId: "%4", description: "now watching CI" }), ["Described", "dev server", "text"]],
    [on("pane_status", { paneId: "%4" }, { status: "running" }), ["Checked", "dev server", "text"]],
    [on("spawn_pane", { name: "dev server" }, { paneId: "%4" }), ["Opened pane", "dev server", "text"]],
    // No name of its own: the id it came back with, whatever the
    // transcript called that id before or after.
    [on("spawn_pane", {}, { paneId: "%4" }), ["Opened pane", "%4", "code"]],
    [on("spawn_pane", {}, { error: "no window" }, "unnamed-spawn"), ["Opened a pane", "", "text"]],
    [on("list_panes", {}, { panes: [] }), ["Listed panes", "", "text"]],
    [on("skill", { name: "tmux-pane" }, "# doc"), ["Loaded skill", "tmux-pane", "code"]],
    [on("read_skill_reference", { skill: "canvas", path: "anti-ai-slop.md" }, "# doc"), ["Read skill reference", "anti-ai-slop.md", "code"]],
    [on("memory_search", { query: "project-2 evict" }, { memories: [] }), ["Searched memory for", "project-2 evict", "text"]],
    [on("memory_remember", { content: "Prefer bash" }, { memory: {} }), ["Remembered", "Prefer bash", "text"]],
    [on("memory_update", { id: "mem_1", content: "Prefer bash" }, { memory: {} }), ["Updated a memory", "Prefer bash", "text"]],
    // By target: the other fields may hold placeholders.
    [on("memory_read", { target: "project", id: "none", project: "project-1" }, { brief: "b" }), ["Read the memory of", "project-1", "text"]],
    [on("memory_read", { target: "user", project: "__unused__" }, { brief: "b" }), ["Read the user brief", "", "text"]],
    [on("memory_read", { target: "memory", id: "mem_1", project: "project-1" }, { memory: {} }), ["Read a memory", "", "text"]],
    [on("memory_forget", { id: "mem_1" }), ["Forgot a memory", "", "text"]],
    [on("update_plan", { steps: [{ id: 5, status: "done", note: "ok" }] }, "Plan updated: #5 done (5 of 8 done)"), ["Updated the plan", "", "text"]],
    [on("read_plan", {}, "Plan: 5 of 8 done"), ["Read the plan", "", "text"]],
    [on("read_plan", { featureId: "feat_1" }, "Plan: 5 of 8 done"), ["Read the plan of", "Import list", "text"]],
    [on("dismiss_work_item", { id: "wi_1", reason: "Merged" }), ["Cleared the feature's flag", "Merged", "text"]],
    [on("canvas_create", { title: "PR #33" }, { ok: true, canvasId: "cnv_1", title: "PR #33", path: "/canvas/cnv_1" }), ["Created canvas", "PR #33", "text"]],
    [on("canvas_update", { canvasId: "cnv_1", title: "New title" }, { ok: true, canvasId: "cnv_1", path: "/canvas/cnv_1", title: "New title" }), ["Updated canvas", "New title", "text"]],
    [on("canvas_outline", { canvasId: "cnv_1" }, { blocks: [] }), ["Outlined canvas", "PR #33", "text"]],
    [on("canvas_read", { canvasId: "cnv_9" }, { canvasId: "cnv_9", title: "Its own title" }), ["Read canvas", "Its own title", "text"]],
    [on("canvas_update", { canvasId: "cnv_1", content: "x" }, { ok: true }), ["Updated canvas", "PR #33", "text"]],
    // A canvas no call titled: nothing, never its opaque id.
    [on("canvas_update", { canvasId: "cnv_9", content: "x" }, { ok: true }), ["Updated canvas", "", "text"]],
    [on("feature_message_send", { featureId: "feat_1", message: "Sync" }, { status: "started" }), ["Messaged", "Import list", "text"]],
    [on("feature_message_send", { featureId: "feat_9", message: "Sync" }, { status: "started" }), ["Messaged", "feat_9", "code"]],
    [on("read_feature_thread", { featureId: "feat_1" }, { messages: [] }), ["Read the thread of", "Import list", "text"]],
    [on("get_feature_status", { featureId: "feat_1" }, { feature: {} }), ["Checked", "Import list", "text"]],
    [on("archive_feature", { featureId: "feat_1" }), ["Archived", "Import list", "text"]],
    [on("restore_feature", { featureId: "feat_1" }), ["Restored", "Import list", "text"]],
    [on("create_feature", { name: "Import list" }, { ok: true, featureId: "feat_1" }), ["Created feature", "Import list", "text"]],
    [on("list_features", {}, { features: [] }), ["Listed features", "", "text"]],
    [on("create_project", { name: "project-2" }), ["Created project", "project-2", "text"]],
    [on("list_projects", {}, { projects: [] }), ["Listed projects", "", "text"]],
    [on("archive_project", { projectId: "p1" }), ["Archived a project", "", "text"]],
    // When it fires, as the server worked it out, read in the viewer's time;
    // `when` itself comes in too many forms to read on the client.
    [on("schedule_wake", { when: "3m", note: "x" }, { alarmId: "alm_1", fireAt: "2026-09-09T16:13:00.000Z" }), ["Scheduled a wake for", formatDateTime("2026-09-09T16:13:00.000Z"), "text"]],
    [on("schedule_wake", { when: "2026-09-27", note: "x" }, { alarmId: "alm_1", fireAt: "2026-09-27T00:00:00.000Z" }), ["Scheduled a wake for", formatDateTime("2026-09-27T00:00:00.000Z"), "text"]],
    [on("schedule_wake", { when: "tomorrow", note: "x" }, { error: "invalid when" }), ["Scheduled a wake", "", "text"]],
    [on("cancel_alarm", { alarmId: "alm_1" }, { ok: true, alarmId: "alm_1", status: "canceled" }), ["Cancelled an alarm", "", "text"]],
    // Already fired: ok, but nothing was cancelled.
    [on("cancel_alarm", { alarmId: "alm_1" }, { ok: true, alarmId: "alm_1", status: "fired" }), ["Alarm had already fired", "", "text"]],
    [on("list_my_alarms", {}, { alarms: [] }), ["Listed alarms", "", "text"]],
    [on("monitor", { pane: { paneId: "%4", quietFor: "30s" }, note: "build" }, { status: "registered", kind: "pane" }), ["Watched", "dev server", "text"]],
    [on("list_my_monitors", {}, { monitors: [] }), ["Listed monitors", "", "text"]],
    [on("cancel_monitor", { monitorId: "mon_1" }, { ok: true, monitorId: "mon_1" }), ["Cancelled a monitor", "", "text"]],
    [on("chat_history_search", { query: "canvas id" }, { results: [] }), ["Searched history for", "canvas id", "text"]],
    [on("chat_history_read", { handle: "hist_1" }, { messages: [] }), ["Read history", "", "text"]],
    [on("end_sweep", { reason: "Nothing to push" }, { ended: true }), ["Ended the sweep", "Nothing to push", "text"]],
    [on("canvas_remove_section", { canvasId: "cnv_1", index: 2, expectLabel: "Notes" }, { ok: true }), ["Removed a section of canvas", "PR #33", "text"]],
    [on("name_thread", { title: "Release prep" }, "Named this thread \"Release prep\"."), ["Named the thread", "Release prep", "text"]],
    // Renamed when the user moved it on to another task.
    [on("name_thread", { title: "Release 3.22" }, "Renamed this thread \"Release 3.22\" (was \"Release prep\")."), ["Renamed the thread", "Release 3.22", "text"]],
    // A name the user set stays, and the row says whose it kept.
    [on("name_thread", { title: "Release prep" }, "The user named this thread \"Voice redesign\"; it stays.", "users-name"), ["Kept your thread name", "Voice redesign", "text"]],
    [on("name_thread", { title: "Voice redesign" }, "This thread is already named \"Voice redesign\".", "same-name"), ["Thread already named", "Voice redesign", "text"]],
    // In an earlier version a thread was named once, and said so.
    [on("name_thread", { title: "Release prep" }, "This thread is already named \"Voice redesign\"; only the user renames it.", "renamed-again"), ["Thread already named", "Voice redesign", "text"]],
    // The global agent's: words for a call under way or refused (one that
    // went through reads as its handoff card).
    [on("list_threads", {}, { threads: [] }), ["Listed threads", "", "text"]],
    [on("read_thread", { threadId: "thr_1" }, { messages: [] }), ["Read a thread", "", "text"]],
    [on("waiting_on_you", {}, { items: [] }), ["Checked what waits on you", "", "text"]],
    [on("message_feature", { featureId: "feat_1", text: "rebase it" }, { error: "worker archived" }), ["Messaged", "Import list", "text"]],
    [on("send_to_thread", { newThreadTitle: "Release notes", text: "draft them" }, { error: "no" }), ["Opened a thread", "Release notes", "text"]],
    [on("send_to_thread", { threadId: "thr_1", text: "draft them" }, { error: "no" }), ["Sent to a thread", "", "text"]],
    [on("await_stop", { threadId: "thr_1" }, { waiting: true }), ["Waiting for it to stop", "", "text"]],
    [on("archive_thread", { threadId: "thr_1" }, { ok: true, threadId: "thr_1", archivedWorkers: ["Import list"] }), ["Archived a thread", "", "text"]]
  ];
  for (const [r, expected] of cases) expect([r.call.toolName, ...worded(r)]).toEqual([r.call.toolName, ...expected]);
});

test("a retired tool's call in an old transcript reads as its name and arguments", () => {
  expect(said(on("task_claim", { taskId: "task_1" }, { ok: true, title: "Diagnose the import list" }))).toEqual(["task_claim", "taskId=task_1", "text"]);
  expect(describeCall(on("watch_window", { paneId: "%4" }, { status: "registered" })).leadIsToolName).toBe(true);
});

test("a pane or feature no one named reads as its id, in code", () => {
  expect(worded(on("read_pane", { paneId: "%9" }, "screen", "other-call"))).toEqual(["Read", "%9", "code"]);
  // With no names at all (outside a transcript), every id is itself.
  expect(said(on("read_pane", { paneId: "%4" }, "screen"))).toEqual(["Read", "%4", "code"]);
  expect(said(on("get_feature_status", { featureId: "feat_1" }, { feature: {} }))).toEqual(["Checked", "feat_1", "code"]);
});

test("a call that raised lends the line nothing from its result, as a canvas publish does not", () => {
  const raised: ToolRunRow = {
    call: { toolCallId: "c", toolName: "canvas_read", args: { canvasId: "cnv_9" } },
    result: { isError: true, error: "not found", result: { title: "Its own title" } },
    isRunning: false
  };
  expect(said(raised)).toEqual(["Read canvas", "", "text"]);
});

test("a feature or canvas id is looked up exactly as written", () => {
  // Padded: the server found no such feature, so the line names none.
  expect(worded(on("get_feature_status", { featureId: " feat_1" }, { error: "not found" }))).toEqual(["Checked", " feat_1", "code"]);
  expect(worded(on("canvas_update", { canvasId: "cnv_1 " }, { error: "not found" }))).toEqual(["Updated canvas", "", "text"]);
});

test("a call still running reads in the present", () => {
  const running = (r: ToolRunRow): ToolRunRow => ({ ...r, result: null, isRunning: true });
  expect(worded(running(on("read_pane", { paneId: "%4" })))).toEqual(["Reading", "dev server", "text"]);
  expect(worded(running(on("feature_message_send", { featureId: "feat_1", message: "Go" })))).toEqual(["Messaging", "Import list", "text"]);
  expect(worded(running(on("memory_search", { query: "x" })))).toEqual(["Searching memory for", "x", "text"]);
  // No fire time yet, so none is claimed; a rename says the name it gives.
  expect(worded(running(on("schedule_wake", { when: "3m", note: "x" })))).toEqual(["Scheduling a wake", "", "text"]);
  expect(worded(running(on("set_pane_metadata", { paneId: "%4", name: "new" })))).toEqual(["Renaming a pane to", "new", "text"]);
});

test("a run of pane reads and watches is said in words when it did no work", () => {
  const rows = [
    on("read_pane", { paneId: "%4" }, "a", "c1"),
    on("read_pane", { paneId: "%4" }, "b", "c2"),
    on("monitor", { pane: { paneId: "%4" } }, { status: "registered", kind: "pane" }, "c3"),
    on("send_keys", { paneId: "%4", args: ["Enter"] }, { ok: true }, "c4"),
    on("list_panes", {}, { panes: [] }, "c5")
  ];
  // Keys sent are the work; the reads, the watch and the pane list are counted.
  expect(describeRun(rows, NAMES).tally).toEqual({ clauses: ["Sent keys once"], unnamed: 4 });
  expect(describeRun([rows[0]!, rows[1]!, rows[2]!, rows[4]!], NAMES).tally)
    .toEqual({ clauses: ["Read panes 2 times", "watched a pane", "used 1 tool"], unnamed: 0 });
  // Two watches of one pane: counted as times, not as two panes.
  const watches = [on("monitor", { pane: { paneId: "%4" } }, {}, "w1"), on("monitor", { pane: { paneId: "%4" } }, {}, "w2")];
  expect(describeRun(watches, NAMES).tally?.clauses).toEqual(["Watched panes 2 times"]);
  expect(describeRun(rows.slice(0, 1), NAMES).phrase?.lead).toBe("Read");
});

const edited = (id: string, oldString: string, newString: string, result: string, extra: Record<string, unknown> = {}): ToolRunRow => ({
  call: { toolCallId: id, toolName: "edit", args: { path: "/repo/storage.go", oldString, newString, ...extra } },
  result: { result },
  isRunning: false
});
const wrote = (id: string, result: unknown, path = "/repo/design.md", isError = false): ToolRunRow => ({
  call: { toolCallId: id, toolName: "write", args: { path, content: "…" } },
  result: isError ? { isError: true, error: String(result) } : { result },
  isRunning: false
});
const EDIT = edited("e1", "\treturn s.conn.Write(p)", "\ts.batch = append(s.batch, p...)\n\tif len(s.batch) < s.flushAt {\n\t\treturn len(p), nil\n\t}\n\treturn len(p), s.flush()", "Updated /repo/storage.go (1 replacement, +5 -1 lines).");
const CREATED = wrote("w1", "Created /repo/bench_test.go (4096 bytes, 153 lines).", "/repo/bench_test.go");
const OVERWROTE = wrote("w2", "Overwrote /repo/design.md (2048 bytes, +12 -20 lines).");

test("the lines a call changed are the server's count over the whole file", () => {
  expect(lineChanges(EDIT)).toEqual({ added: 5, removed: 1 });
  // Every occurrence, counted in the file, not the fragment times three.
  expect(lineChanges(edited("e2", "a", "b\nc", "Updated /repo/storage.go (3 replacements, +4 -2 lines).", { replaceAll: true }))).toEqual({ added: 4, removed: 2 });
  // Two lines joined: the fragment ("\n" -> "") alone would say one removed.
  expect(lineChanges(edited("e3", "\n", "", "Updated /repo/storage.go (1 replacement, +1 -2 lines)."))).toEqual({ added: 1, removed: 2 });
  // An edit from before the server counted.
  expect(lineChanges(edited("e4", "a", "b", "Updated /repo/storage.go (1 replacement)."))).toBe(null);
  expect(lineChanges(CREATED)).toEqual({ added: 153, removed: 0 });
  expect(lineChanges(OVERWROTE)).toEqual({ added: 12, removed: 20 });
  // Nothing to say: not counted, from before writes were counted, failed, or
  // a result about another path than the one asked for.
  expect(lineChanges(wrote("w3", "Overwrote /repo/design.md (2048 bytes)."))).toBe(null);
  expect(lineChanges(wrote("w4", "Wrote 2048 bytes to /repo/design.md."))).toBe(null);
  expect(lineChanges(wrote("w5", "read must be called before overwriting existing file: /repo/design.md", "/repo/design.md", true))).toBe(null);
  expect(lineChanges(wrote("w6", "Created /repo/design.md (1 byte, 1 line).", "/repo/../repo/design.md"))).toBe(null);
  expect(lineChanges({ ...EDIT, result: { isError: true, error: "oldString not found" } })).toBe(null);
  expect(lineChanges({ ...EDIT, result: { result: "Updated /repo/other.go (1 replacement, +5 -1 lines)." } })).toBe(null);
  // An error payload that repeats the success text is still an error.
  expect(lineChanges({ ...CREATED, result: { isError: true, result: "Created /repo/bench_test.go (4096 bytes, 153 lines)." } })).toBe(null);
  expect(lineChanges({ ...EDIT, result: { isError: true, result: "Updated /repo/storage.go (1 replacement, +5 -1 lines)." } })).toBe(null);
  expect(lineChanges(on("bash", { command: "go test ./..." }, "ok"))).toBe(null);
});

test("a run's line counts are its calls' summed, and none when no call says", () => {
  expect(describeRun([EDIT, on("bash", { command: "go test ./..." }, "ok"), OVERWROTE]).lines).toEqual({ added: 17, removed: 21 });
  expect(describeRun([on("bash", { command: "go test ./..." }, "ok")]).lines).toBe(null);
  // A change of nothing is still a count.
  expect(describeRun([wrote("w7", "Overwrote /repo/design.md (10 bytes, +0 -0 lines).")]).lines).toEqual({ added: 0, removed: 0 });
});

test("a write that made its file says Created, in its line and in a run's tally", () => {
  expect(worded(CREATED)).toEqual(["Created", "bench_test.go", "code"]);
  expect(worded(OVERWROTE)).toEqual(["Wrote", "design.md", "code"]);
  expect(worded(wrote("w8", "Wrote 2048 bytes to /repo/design.md."))).toEqual(["Wrote", "design.md", "code"]);
  expect(worded({ ...CREATED, result: null, isRunning: true })).toEqual(["Writing", "bench_test.go", "code"]);
  expect(describeRun([CREATED, EDIT, OVERWROTE]).tally).toEqual({ clauses: ["Created 1 file", "edited 2 files"], unnamed: 0 });
  // Made first even when the edit came first.
  expect(describeRun([EDIT, CREATED]).tally?.clauses).toEqual(["Created 1 file", "edited 1 file"]);
});

test("a command monitor's row is its description, else its command", () => {
  const CI = "gh pr checks 123 --json state --jq 'all(.[]; .state != \"PENDING\")' | grep -q true";
  const described = on("monitor", { command: { run: CI, every: "2m", wakeWhen: "succeeds", description: "CI checks on PR 123" }, note: "ci" }, { status: "registered", kind: "command" }, "m1");
  const bare = on("monitor", { command: { run: CI, every: "2m" }, note: "ci" }, { status: "registered", kind: "command" }, "m2");
  // Ended (nothing says it still waits): in the past.
  expect(worded(described)).toEqual(["Monitored", "CI checks on PR 123", "text"]);
  expect(worded(bare)).toEqual(["Monitored", CI, "code"]);
  // Under way, it is monitoring.
  expect(worded({ ...described, result: null, isRunning: true })).toEqual(["Monitoring", "CI checks on PR 123", "text"]);
  // A condition that already held registered nothing: it was a check.
  expect(worded(on("monitor", { command: { run: CI, every: "2m", wakeWhen: "succeeds", description: "CI checks on PR 123" }, note: "ci" }, { status: "already_satisfied", kind: "command" }, "m3")))
    .toEqual(["Checked", "CI checks on PR 123", "text"]);
  // A pane monitor under way.
  expect(worded({ ...on("monitor", { pane: { paneId: "%4" }, note: "x" }), result: null, isRunning: true })).toEqual(["Watching", "dev server", "text"]);
  expect(worded({ ...on("list_my_monitors", {}), result: null, isRunning: true })).toEqual(["Listing monitors", "", "text"]);
});

test("a run counts pane monitors as watches and command monitors as monitored commands", () => {
  const rows = [
    on("bash", { command: "gh pr create --fill" }, "exitCode: 0", "b1"),
    on("monitor", { pane: { paneId: "%4" }, note: "x" }, { status: "registered", kind: "pane" }, "p1"),
    on("monitor", { command: { run: "gh pr checks 1", every: "2m" }, note: "x" }, { status: "registered", kind: "command" }, "c1"),
    on("monitor", { command: { run: "gh pr view 1", every: "5m" }, note: "y" }, { status: "registered", kind: "command" }, "c2")
  ];
  expect(describeRun(rows, NAMES).tally).toEqual({ clauses: ["Ran 1 command"], unnamed: 3 });
  expect(describeRun(rows.slice(1), NAMES).tally?.clauses).toEqual(["Watched a pane", "monitored commands 2 times"]);
  expect(describeRun(rows.slice(1, 3), NAMES).tally?.clauses).toEqual(["Watched a pane", "monitored a command"]);
});

// A monitor goes on after its call: its row reads in the present
// while the thread still waits on it, in the past once it fired, timed out or
// was cancelled.
test("a monitor's row reads in the present while the thread still waits on it, in the past once it ended", () => {
  const waitingOn = (...ids: string[]): CallNames => ({ ...NAMES, monitorPending: (id) => ids.includes(id) });
  const pane = on("monitor", { pane: { paneId: "%4", quietFor: "45s" }, note: "review" }, { status: "registered", kind: "pane", monitorId: "ww_1" });
  const command = on("monitor", { command: { run: "gh pr checks 48", every: "5m", description: "project-1 CI" }, note: "ci" }, { status: "registered", kind: "command", monitorId: "mon_1" }, "m4");
  const phrase = (row: ToolRunRow, names: CallNames) => describeCall(row, names).lead;
  expect([phrase(pane, waitingOn("ww_1")), phrase(pane, waitingOn())]).toEqual(["Watching", "Watched"]);
  expect([phrase(command, waitingOn("mon_1")), phrase(command, waitingOn())]).toEqual(["Monitoring", "Monitored"]);
  // Another monitor's wait is not this one's.
  expect(phrase(pane, waitingOn("mon_1"))).toBe("Watched");
});

test("a web search reads as what was searched for; a page read as the host and path it fetched", () => {
  expect(said(row("web_search", { query: "kettle boiling point" }))).toEqual(["Searched the web for", "kettle boiling point", "text"]);
  expect(said(row("web_fetch", { url: "https://tea.test/a/b?c=1#top" }))).toEqual(["Fetched", "tea.test/a/b?c=1", "code"]);
  expect(said(row("web_fetch", { url: "https://tea.test/" }))).toEqual(["Fetched", "tea.test", "code"]);
  expect(said(row("web_fetch", { url: "not an address" }))).toEqual(["Fetched", "not an address", "code"]);
  expect(said(row("web_search", { query: "q" }, { isRunning: true }))[0]).toBe("Searching the web for");
  expect(said(row("web_fetch", { url: "https://tea.test/" }, { isRunning: true }))[0]).toBe("Fetching");
});
