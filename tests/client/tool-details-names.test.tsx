import { afterEach, expect, test } from "bun:test";
import { collectToolNames, type ToolNames } from "@/routes/window/chat/tool-details/names";
import { ToolNamesContext, useNameLookup, type NameLookup } from "@/routes/window/chat/tool-details/names-context";
import type { ToolCallSpec, ToolResultSpec } from "@/routes/window/chat/tool-run-summary";
import { useProjectsStore, type ProjectWorker, type Project } from "@/store/projects";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";
import { stub } from "../helpers/typed.js";

type Step = [string, unknown, ToolResultSpec | null];

/** A thread of calls c1, c2, … and the names collected from it. */
function thread(steps: Step[]) {
  const calls: ToolCallSpec[] = [];
  const results = new Map<string, ToolResultSpec>();
  steps.forEach(([toolName, args, result], index) => {
    const id = `c${index + 1}`;
    calls.push({ toolCallId: id, toolName, args });
    if (result) results.set(id, result);
  });
  return collectToolNames(calls, results);
}

/** The pane name each call would show, by call id; calls on no named pane left out. */
function paneNames(names: ToolNames): Record<string, string> {
  return Object.fromEntries(names.paneOfCall);
}

const read = (paneId: string): Step => ["read_pane", { paneId }, { result: "screen" }];

test("a call reads by the name its pane had when the call was made", () => {
  const names = thread([
    ["spawn_pane", { name: "Release preflight" }, { result: { paneId: "%4" } }],
    ["spawn_pane", { name: "tests" }, { result: { paneId: "%5" } }],
    read("%4"),
    // The pane's next task.
    ["set_pane_metadata", { paneId: "%4", name: "Compatibility tests" }, { result: { ok: true, paneId: "%4" } }],
    read("%4"),
    ["list_panes", {}, { result: { panes: [{ paneId: "%6", name: "Lint pass" }, { paneId: "%7" }] } }],
    read("%6"),
    read("%7"),
    // A check says what the pane was called when it was made.
    ["pane_status", { paneId: "%8" }, { result: { status: "running", name: "PR checks" } }],
    read("%5")
  ]);
  expect(paneNames(names)).toEqual({
    // The read before the rename keeps the name it had; the rename acted on
    // the pane as it was named, and the read after goes by the new one.
    c3: "Release preflight",
    c4: "Release preflight",
    c5: "Compatibility tests",
    c7: "Lint pass",
    c9: "PR checks",
    c10: "tests"
  });
});

test("a spawn that returns an id seen before is a new pane: calls before keep the old name", () => {
  const names = thread([
    ["spawn_pane", { name: "before the restart" }, { result: { paneId: "%4" } }],
    read("%4"),
    // tmux restarted and handed %4 out again.
    ["spawn_pane", { name: "after the restart" }, { result: { paneId: "%4" } }],
    read("%4"),
    // Opened without a name: the id alone, not the last pane's name.
    ["spawn_pane", {}, { result: { paneId: "%4" } }],
    read("%4")
  ]);
  expect(paneNames(names)).toEqual({ c2: "before the restart", c4: "after the restart" });
});

test("a pane seen without a name goes back to its id", () => {
  const names = thread([
    ["spawn_pane", { name: "cleared" }, { result: { paneId: "%1" } }],
    ["set_pane_metadata", { paneId: "%1", name: "" }, { result: { ok: true, paneId: "%1" } }],
    read("%1"),
    ["spawn_pane", { name: "listed bare" }, { result: { paneId: "%2" } }],
    ["list_panes", {}, { result: { panes: [{ paneId: "%2", status: "running" }] } }],
    read("%2"),
    ["spawn_pane", { name: "status bare" }, { result: { paneId: "%3" } }],
    ["pane_status", { paneId: "%3" }, { result: { status: "unknown" } }],
    read("%3"),
    // A metadata call that only changed the description leaves the name be.
    ["spawn_pane", { name: "kept" }, { result: { paneId: "%5" } }],
    ["set_pane_metadata", { paneId: "%5", description: "now watching CI" }, { result: { ok: true, paneId: "%5" } }],
    read("%5")
  ]);
  // The call that cleared a name acted on the pane as it was named.
  expect(paneNames(names)).toEqual({ c2: "cleared", c11: "kept", c12: "kept" });
});

test("an id is matched exactly, as the server matches it", () => {
  const names = thread([
    ["spawn_pane", { name: "dev server" }, { result: { paneId: "%4" } }],
    // Padded: the server found no such pane, so neither does the name.
    ["read_pane", { paneId: " %4 " }, { result: { error: "pane  %4  is not in this worker" } }],
    read("%4"),
    ["get_worker_status", { workerId: "wkr_1" }, { result: { worker: { id: " wkr_1", name: "Import list" } } }]
  ]);
  expect(paneNames(names)).toEqual({ c3: "dev server" });
  expect([...names.workers]).toEqual([[" wkr_1", "Import list"]]);
});

test("a call that failed names nothing, and still acted on the pane as it was named", () => {
  const names = thread([
    ["spawn_pane", { name: "raised" }, { isError: true, error: "no window" }],
    ["spawn_pane", { name: "base" }, { result: { paneId: "%3" } }],
    // The name is in the arguments, so only the error says it never took.
    ["set_pane_metadata", { paneId: "%3", name: "raised too" }, { isError: true, error: "tmux gone" }],
    ["set_pane_metadata", { paneId: "%3", name: "reported" }, { result: { error: "pane %3 is not in this worker" } }],
    ["spawn_pane", { name: "still running" }, null],
    ["set_pane_metadata", { paneId: "%9", name: "   " }, { result: { ok: true } }],
    ["send_keys", { paneId: "%3", args: ["Enter"] }, null]
  ]);
  expect(paneNames(names)).toEqual({ c3: "base", c4: "base", c7: "base" });
});

test("workers are named by the calls that create, read or list them", () => {
  const names = thread([
    ["create_worker", { name: "asked for" }, { result: { ok: true, workerId: "wkr_1", workerName: "sanitized name" } }],
    ["create_worker", { name: "only the argument" }, { result: { ok: true, workerId: "wkr_2" } }],
    ["get_worker_status", { workerId: "wkr_3" }, { result: { worker: { id: "wkr_3", name: "Import list" } } }],
    ["list_workers", {}, { result: { workers: [{ id: "wkr_4", name: "project-2 evict" }] } }]
  ]);
  expect([...names.workers]).toEqual([
    ["wkr_1", "sanitized name"],
    ["wkr_2", "only the argument"],
    ["wkr_3", "Import list"],
    ["wkr_4", "project-2 evict"]
  ]);
});

test("canvases are titled by the calls that create, publish, read or retitle them", () => {
  const names = thread([
    ["canvas_create", { title: "asked" }, { result: { ok: true, canvasId: "cnv_1", title: "Draft" } }],
    ["canvas_update", { canvasId: "cnv_1", title: "Final" }, { result: { ok: true, canvasId: "cnv_1", title: "Final" } }],
    ["canvas_publish", { canvasId: "cnv_2" }, { result: { ok: true, canvasId: "cnv_2", title: "Report" } }],
    ["canvas_read", { canvasId: "cnv_3" }, { result: { canvasId: "cnv_3", title: "Notes" } }],
    ["canvas_update", { canvasId: "cnv_4", title: "Refused" }, { isError: true, error: "no such canvas" }],
    ["canvas_open", { canvasId: "cnv_5" }, { result: { ok: true, canvasId: "cnv_5", path: "/canvas/cnv_5" } }],
    ["canvas_read", { canvasId: "cnv_6 " }, { result: { canvasId: "cnv_6 ", title: "Padded" } }]
  ]);
  // Ids exactly as they came back.
  expect([...names.canvases]).toEqual([["cnv_1", "Final"], ["cnv_2", "Report"], ["cnv_3", "Notes"], ["cnv_6 ", "Padded"]]);
});

test("a pane monitor goes by the name its pane had when it was registered", () => {
  const names = thread([
    ["spawn_pane", { name: "Release preflight" }, { result: { paneId: "%4" } }],
    ["monitor", { pane: { paneId: "%4", quietFor: "30s" }, note: "x" }, { result: { status: "registered", monitorId: "mon_pane_1", kind: "pane" } }],
    ["set_pane_metadata", { paneId: "%4", name: "Compatibility tests" }, { result: { ok: true } }],
    ["monitor", { pane: { paneId: "%4" }, note: "x" }, { result: { status: "already_registered", monitorId: "mon_pane_1", kind: "pane" } }],
    ["monitor", { pane: { paneId: "%4", unchangedFor: "30s" }, note: "x" }, { result: { status: "registered", monitorId: "mon_pane_2", kind: "pane" } }],
    // A command monitor names no pane.
    ["monitor", { command: { run: "gh pr checks 1", every: "2m" }, note: "x" }, { result: { status: "registered", monitorId: "mon_1", kind: "command" } }]
  ]);
  expect([...names.monitoredPanes]).toEqual([["mon_pane_1", "Release preflight"], ["mon_pane_2", "Compatibility tests"]]);
});

test("a read of a saved output is tied to the earlier call whose output was saved there", () => {
  const saved = (path: string) => [
    "<persisted-output>",
    "Output too large (80.0KB, 2400 lines). Full output saved to:",
    path,
    "",
    "Use read with this path plus offset/limit to inspect more.",
    "",
    "Preview (first 4.0KB):",
    // The output itself can say anything, this included.
    "Full output saved to:",
    "/from/the/preview.txt",
    "</persisted-output>"
  ].join("\n");
  const P = "/u/.mandate/resources/projects/p1/tool-output/thr_1/0b1c.txt";
  const Q = "/u/.mandate/resources/projects/p1/tool-output/thr_1/9e8f.txt";
  const names = thread([
    // Before anything was saved there.
    ["read", { path: P }, { result: "File does not exist." }],
    ["read_pane", { paneId: "%4" }, { result: saved(P) }],
    ["read", { path: P, offset: 1, limit: 400 }, { result: "     1\tx" }],
    // Matched exactly, as the server matches paths.
    ["read", { path: ` ${P}` }, { isError: true, error: "path must be absolute" }],
    ["read", { path: "/from/the/preview.txt" }, { result: "x" }],
    // A call that failed saved nothing.
    ["bash", { command: "big" }, { isError: true, result: saved("/failed.txt") }],
    ["read", { path: "/failed.txt" }, { result: "x" }],
    // A read whose own output was saved is not its own source; a later read of it is.
    ["read", { path: Q }, { result: saved(Q) }],
    ["read", { path: Q, offset: 401 }, { result: "   401\tx" }],
    // Only a read is tied to one.
    ["edit", { path: P, old_string: "a", new_string: "b" }, { result: "Updated" }]
  ]);
  expect([...names.savedOutputOfRead].map(([callId, source]) => [callId, source.call.toolCallId])).toEqual([["c3", "c2"], ["c9", "c8"]]);
});

afterEach(() => {
  // Unmount before the projects the lookup reads are reset under it.
  runCleanups();
  useProjectsStore.setState({ projects: [] });
});

function lookupWith(names: ToolNames): NameLookup {
  let lookup: NameLookup | null = null;
  function Probe() {
    lookup = useNameLookup();
    return null;
  }
  mount(<ToolNamesContext.Provider value={names}><Probe /></ToolNamesContext.Provider>);
  return lookup!;
}

test("a worker's name is the one the app knows now, else the transcript's; a pane's only the transcript's", () => {
  useProjectsStore.setState({
    projects: [stub<Project>({ id: "p1", name: "mandate", workers: [stub<ProjectWorker>({ id: "wkr_1", name: "renamed since" })] })]
  });
  const lookup = lookupWith({
    paneOfCall: new Map([["c1", "dev server"]]),
    workers: new Map([["wkr_1", "old name"], ["wkr_2", "archived one"]]),
    canvases: new Map([["cnv_1", "PR #33"]]),
    monitoredPanes: new Map(),
    savedOutputOfRead: new Map([["c3", { call: { toolCallId: "c2", toolName: "read_pane", args: { paneId: "%4" } }, result: { result: "saved" } }]]),
    schedules: new Map([["sch_1", "Frost watch"]]),
    tasks: new Map([["task_1", "Check the greenhouse sensor IDs"]])
  });
  expect(lookup.worker("wkr_1")).toBe("renamed since");
  expect(lookup.worker("wkr_2")).toBe("archived one");
  expect(lookup.worker("wkr_3")).toBe(null);
  expect(lookup.pane("c1")).toBe("dev server");
  // A call on a pane no one had named, and a call the thread never saw.
  expect(lookup.pane("c2")).toBe(null);
  expect(lookup.pane("c9")).toBe(null);
  expect(lookup.canvas("cnv_1")).toBe("PR #33");
  expect(lookup.canvas("cnv_2")).toBe(null);
  expect(lookup.savedOutput("c3")).toEqual({ call: { toolCallId: "c2", toolName: "read_pane", args: { paneId: "%4" } }, result: { result: "saved" }, isRunning: false });
  expect(lookup.savedOutput("c9")).toBe(null);
  expect([lookup.schedule("sch_1"), lookup.schedule("sch_2")]).toEqual(["Frost watch", null]);
  expect([lookup.task("task_1"), lookup.task("task_2")]).toEqual(["Check the greenhouse sensor IDs", null]);
});

test("the canvas tool titles canvases by what its create, publish and read actions return", () => {
  const names = thread([
    ["canvas", { action: "create", title: "asked" }, { result: { ok: true, canvasId: "cnv_1", title: "Draft" } }],
    ["canvas", { action: "create", title: "asked too" }, { result: { ok: true, canvasId: "cnv_2", title: "Only made" } }],
    ["canvas", { action: "publish", canvasId: "cnv_1" }, { result: { ok: true, canvasId: "cnv_1", title: "Final" } }],
    ["canvas", { action: "read", canvasId: "cnv_3" }, { result: { canvasId: "cnv_3", title: "Notes" } }],
    ["canvas", { action: "outline", canvasId: "cnv_4" }, { result: { blocks: [] } }],
    ["canvas", { action: "publish", canvasId: "cnv_5" }, { isError: true, error: "canvas not found" }],
    ["canvas", { action: "publish", canvasId: "cnv_6" }, { result: { error: "canvas is not editable from this agent scope" } }]
  ]);
  expect([...names.canvases]).toEqual([["cnv_1", "Final"], ["cnv_2", "Only made"], ["cnv_3", "Notes"]]);
});

test("schedules are named by the calls that create, change, pause, resume or list them", () => {
  const dto = (id: string, name: string) => ({ id, name, cron: "*/30 * * * *", status: "active" });
  const names = thread([
    ["manage_schedule", { action: "create", name: "asked" }, { result: { status: "created", schedule: dto("sch_1", "Frost watch") } }],
    ["manage_schedule", { action: "update", id: "sch_1", name: "Frost watch (north)" }, { result: { status: "updated", schedule: dto("sch_1", "Frost watch (north)") } }],
    ["manage_schedule", { action: "pause", all: true, reason: "x" }, { result: { schedules: [dto("sch_2", "Nightly import"), dto("sch_3", "Weekly digest")] } }],
    ["list_schedules", {}, { result: { schedules: [dto("sch_4", "Disk space")] } }],
    // The tool manage_schedule replaced: its id came back, its name was asked for.
    ["create_schedule", { name: "Cert expiry" }, { result: { status: "testing", scheduleId: "sch_5" } }],
    ["manage_schedule", { action: "update", id: "sch_6", name: "Refused" }, { result: { error: "bad cron" } }],
    ["manage_schedule", { action: "create", name: "Raised" }, { isError: true, error: "boom" }]
  ]);
  expect([...names.schedules]).toEqual([
    ["sch_1", "Frost watch (north)"],
    ["sch_2", "Nightly import"],
    ["sch_3", "Weekly digest"],
    ["sch_4", "Disk space"],
    ["sch_5", "Cert expiry"]
  ]);
});

test("a background task is titled by the call that started it", () => {
  const names = thread([
    ["subagent", { title: "Find the retry call sites", task: "x" }, { result: { taskId: "task_1", status: "started" } }],
    ["subagent", { title: "Waits its turn", task: "x" }, { result: { taskId: "task_2", status: "queued" } }],
    ["bash", { command: "go test ./...", description: "Run the tests", run_in_background: true }, { result: { taskId: "task_3", status: "running" } }],
    ["bash", { command: "make bench", run_in_background: true }, { result: { taskId: "task_4", status: "running" } }],
    // Refused: it started nothing.
    ["subagent", { title: "Refused", task: "x" }, { result: { error: "20 running" } }]
  ]);
  expect([...names.tasks]).toEqual([
    ["task_1", "Find the retry call sites"],
    ["task_2", "Waits its turn"],
    ["task_3", "Run the tests"],
    ["task_4", "make bench"]
  ]);
});
