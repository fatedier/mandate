import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ToolCallDetails } from "@/routes/window/chat/ToolCallDetails";
import type { DetailLayout } from "@/routes/window/chat/tool-details/blocks";
import { collectToolNames, NO_NAMES, type ToolNames } from "@/routes/window/chat/tool-details/names";
import { ToolNamesContext } from "@/routes/window/chat/tool-details/names-context";
import type { ToolCallSpec, ToolResultSpec, ToolRunRow } from "@/routes/window/chat/tool-run-summary";
import { useProjectsStore } from "@/store/projects";
import { runCleanups } from "../helpers/cleanup.js";
import { mount, settle, type Mounted } from "../helpers/mount.js";

let view: Mounted | null = null;
afterEach(() => {
  // Unmount before the projects store the details read is reset under it.
  runCleanups();
  view = null;
  useProjectsStore.setState({ projects: [] });
});

/** The names a transcript would give the call under test: before it, a
 *  spawn named pane %4 "dev server" and a feature was created as "IME
 *  input". Run through the real collector, so a call on another pane, or
 *  another lifetime of %4, gets what it would get in a thread. */
function namesFor(row: ToolRunRow): ToolNames {
  const before: ToolCallSpec[] = [
    { toolCallId: "spawn", toolName: "spawn_pane", args: { name: "dev server" } },
    { toolCallId: "create", toolName: "create_feature", args: { name: "Import list" } }
  ];
  const results = new Map<string, ToolResultSpec>([
    ["spawn", { result: { paneId: "%4" } }],
    ["create", { result: { ok: true, featureId: "feat_1", featureName: "Import list" } }]
  ]);
  if (row.result) results.set(row.call.toolCallId, row.result);
  return collectToolNames([...before, row.call], results);
}

function render(row: ToolRunRow, { layout = "inline" as DetailLayout, names = namesFor(row) } = {}) {
  view = mount(
    <ToolNamesContext.Provider value={names}>
      <ToolCallDetails row={row} layout={layout} />
    </ToolNamesContext.Provider>
  );
  return view.host;
}

/** Re-render in place, names and all, as a thread would. */
function rerender(row: ToolRunRow) {
  view!.rerender(
    <ToolNamesContext.Provider value={namesFor(row)}>
      <ToolCallDetails row={row} />
    </ToolNamesContext.Provider>
  );
}

const headings = (el: ParentNode) => [...el.querySelectorAll('[data-slot="detail-label"]')].map((h) => h.textContent);
function section(el: ParentNode, label: string): HTMLElement {
  const heading = [...el.querySelectorAll('[data-slot="detail-label"]')].find((h) => h.textContent === label);
  if (!heading) throw new Error(`no section "${label}" in ${headings(el).join(", ")}`);
  return heading.parentElement!.parentElement!;
}
const classes = (el: Element | null) => (el?.className ?? "").split(/\s+/);
const dts = (el: ParentNode) => [...el.querySelectorAll("dt")].map((dt) => dt.textContent);
const call = (toolName: string, args: unknown, result: ToolRunRow["result"]): ToolRunRow =>
  ({ call: { toolCallId: "t1", toolName, args }, result, isRunning: false });
const target = (el: ParentNode, label: string) => {
  const line = section(el, label).querySelector('[data-slot="tool-target"]')!;
  return {
    name: line.querySelector('[data-slot="tool-target-name"]')?.textContent ?? null,
    id: line.querySelector('[data-slot="tool-target-id"]')!.textContent,
    note: line.querySelector('[data-slot="tool-target-note"]')?.textContent ?? null
  };
};

// ── send_keys ───────────────────────────────────────────────────────────

test("keys sent are the pane by name and the keys pressed, in order", () => {
  const el = render(call("send_keys", {
    paneId: "%4",
    args: ["C-c"],
    description: "Stop the dev server"
  }, { result: { ok: true } }));
  // A bare ok takes no section.
  expect(headings(el)).toEqual(["Description", "Pane", "Keys"]);
  expect(section(el, "Description").lastElementChild!.textContent).toBe("Stop the dev server");
  expect(target(el, "Pane")).toEqual({ name: "dev server", id: "%4", note: null });
  const keys = section(el, "Keys").querySelector('[data-slot="tool-keys"]')!;
  expect([...keys.querySelectorAll("[data-kind]")].map((k) => `${k.getAttribute("data-kind")}:${k.textContent}`)).toEqual(["key:C-c"]);
});

test("typed text and keys read as a sequence", () => {
  const el = render(call("send_keys", { paneId: "%9", args: ["bun run dev --port 4180", "Enter"] }, { result: { ok: true } }));
  // A pane the transcript never named is its id alone.
  expect(target(el, "Pane")).toEqual({ name: null, id: "%9", note: null });
  const keys = section(el, "Keys").querySelector('[data-slot="tool-keys"]')!;
  expect(keys.textContent).toBe("typedbun run dev --port 4180thenEnter");
  expect(keys.querySelector("kbd")!.textContent).toBe("Enter");
});

test("keys in a form not read are shown as sent", () => {
  const el = render(call("send_keys", { paneId: "%4", args: ["-H", "41", "42"] }, { result: { ok: true } }));
  expect(section(el, "Keys").querySelector('[data-slot="tool-keys"]') === null).toBe(true);
  expect(section(el, "Keys").querySelector("pre")!.textContent).toBe('"-H" "41" "42"');
});

test("a key the pane refused is an error in its own words", () => {
  const el = render(call("send_keys", { paneId: "%4", args: ["Enter"] }, { result: { error: "pane %4 is not in this feature" } }));
  expect(headings(el)).toEqual(["Pane", "Keys", "Error"]);
  expect(section(el, "Error").querySelector('[data-slot="tool-output"]')!.textContent).toBe("pane %4 is not in this feature");
});

test("send_keys args not in its shape fall back to the argument list", () => {
  const el = render(call("send_keys", { paneId: "%4", args: "Enter" }, { isError: true, error: "parameter validation failed" }));
  expect(headings(el)).toEqual(["Arguments", "Error"]);
  expect(dts(el)).toEqual(["Pane ID", "Args"]);
});

// ── read_pane ───────────────────────────────────────────────────────────

test("a pane read is its screen, in the terminal's colours, with the notes outside it", () => {
  const el = render(call("read_pane", { paneId: "%4", lines: 125 }, {
    result: "… 23 lines unchanged since your last read of this pane\n$ bun run dev\n  VITE ready in 612 ms"
  }));
  expect(target(el, "Pane")).toEqual({ name: "dev server", id: "%4", note: "last 125 lines" });
  expect(el.querySelector('[data-slot="tool-notes"]')!.textContent).toBe("… 23 lines unchanged since your last read of this pane");
  const screen = section(el, "Screen").querySelector('[data-slot="tool-terminal"]')!;
  expect(screen.textContent).toBe("$ bun run dev\n  VITE ready in 612 ms");
  expect(classes(screen)).toContain("bg-terminal-bg");
});

test("a pane read with nothing new shows its notes and no screen", () => {
  const nothing = "no new output in %4 since your last read (40 lines unchanged)";
  const el = render(call("read_pane", { paneId: "%4" }, { result: nothing }));
  expect(headings(el)).toEqual(["Pane"]);
  expect(el.querySelector('[data-slot="tool-notes"]')!.textContent).toBe(nothing);
});

test("a pane read that failed shows the error", () => {
  const el = render(call("read_pane", { paneId: "%4" }, { result: { error: "pane %4 is not in this feature (scope check failed)" } }));
  expect(headings(el)).toEqual(["Pane", "Error"]);
});

test("a screen of many short lines is capped too", () => {
  const el = render(call("read_pane", { paneId: "%4" }, { result: Array.from({ length: 200 }, () => ".").join("\n") }));
  expect(classes(el.querySelector('[data-slot="tool-terminal"]'))).toContain("overflow-y-auto");
});

test("a read result not in the server's exact shape is shown whole", () => {
  const el = render(call("read", { path: "/repo/a.ts" }, { result: "1\tfirst\n99\tlast" }));
  expect(headings(el)).toEqual(["File", "Output"]);
  expect(section(el, "Output").querySelector('[data-slot="tool-output"]')!.textContent).toBe("1\tfirst\n99\tlast");
});

test("a long screen is capped in the transcript, and not in the sheet", () => {
  const long = Array.from({ length: 80 }, (_, i) => `line ${i} of the dev server log`).join("\n");
  const inline = render(call("read_pane", { paneId: "%4" }, { result: long }));
  expect(classes(inline.querySelector('[data-slot="tool-terminal"]'))).toContain("overflow-y-auto");
  view!.unmount();
  const sheet = render(call("read_pane", { paneId: "%4" }, { result: long }), { layout: "sheet" });
  expect(classes(sheet.querySelector('[data-slot="tool-terminal"]'))).not.toContain("overflow-y-auto");
});

// ── monitor ─────────────────────────────────────────────────────────────

test("a pane monitor's details are a watch's: the pane, what wakes it, and why", () => {
  const el = render(call("monitor", { pane: { paneId: "%4", unchangedFor: "45s" }, timeout: "1h", note: "Wait for the build" },
    { result: { status: "registered", monitorId: "ww_1", kind: "pane", unchangedFor: "45s", timeoutAt: "2026-10-04T01:00:00.000Z" } }));
  expect(headings(el)).toEqual(["Pane", "Note", "Output"]);
  // What took, from the result.
  expect(target(el, "Pane")).toEqual({ name: "dev server", id: "%4", note: "quiet for 45s" });
  expect(section(el, "Note").textContent).toContain("Wait for the build");
});

test("a command monitor's details are what it runs, how often, until what, and what it first read", () => {
  const run = "gh pr checks 123 --json state --jq 'all(.[]; .state != \"PENDING\")' | grep -q true";
  const el = render(call("monitor", { command: { run, every: "2m", wakeWhen: "succeeds", description: "CI checks on PR 123" }, note: "Merge when green" },
    { result: { status: "registered", monitorId: "mon_1", kind: "command", every: "2m", wakeWhen: "succeeds", timeoutAt: "2026-10-05T00:00:00.000Z", exitCode: 1, output: "" } }));
  expect(headings(el)).toEqual(["Command", "When", "Note", "First run", "Result"]);
  expect(section(el, "Command").textContent).toContain("CI checks on PR 123");
  expect(section(el, "Command").querySelector("pre")!.textContent).toBe(run);
  expect(section(el, "When").querySelector('[data-slot="monitor-when"]')!.textContent).toBe("Every 2m · wakes when it succeeds · gives up after 24h");
  expect(section(el, "Note").textContent).toContain("Merge when green");
  expect(section(el, "First run").textContent).toContain("exit 1 · not yet");
  expect(section(el, "First run").textContent).toContain("(no output)");
});

test("a first run that wrote to stderr shows it, and under succeeds a failed one is no longer called not yet", () => {
  const run = "glab api projects/7/jobs/8 --jq .status | grep -q success";
  const warning = "The command exited 1 and wrote to stderr: that may be an error, not \"not yet\".";
  const el = render(call("monitor", { command: { run, every: "1m", wakeWhen: "succeeds" }, note: "Image built" },
    { result: { status: "registered", monitorId: "mon_3", kind: "command", every: "1m", wakeWhen: "succeeds", timeoutAt: "2026-10-05T00:00:00.000Z", exitCode: 1, output: "", stderr: "Unknown flag: --jq", warning } }));
  expect(headings(el)).toEqual(["Command", "When", "Note", "First run", "Stderr", "Result"]);
  expect(section(el, "First run").textContent).toContain("exit 1 · wrote to stderr");
  expect(section(el, "First run").textContent).not.toContain("not yet");
  expect(section(el, "Stderr").querySelector("pre")!.textContent).toBe("Unknown flag: --jq");
  // The server's warning, as it came, with the rest of the result.
  expect(section(el, "Result").textContent).toContain("may be an error");
});

test("a changed monitor's details say so, and show its first output as read", () => {
  const el = render(call("monitor", { command: { run: "gh api repos/o/r/issues/1/comments --jq '.[].id'", every: "5m" }, timeout: "6h", note: "Answer them" },
    { result: { status: "updated", monitorId: "mon_2", kind: "command", every: "5m", wakeWhen: "changed", timeoutAt: "2026-10-04T06:00:00.000Z", nextRunAt: "2026-10-04T00:05:00.000Z", exitCode: 0, output: "1000000001\n1000000002" } }));
  expect(section(el, "When").querySelector('[data-slot="monitor-when"]')!.textContent).toBe("Every 5m · wakes when its output changes · gives up after 6h");
  expect(section(el, "First run").textContent).toContain("exit 0");
  expect(section(el, "First run").querySelector("pre")!.textContent).toBe("1000000001\n1000000002");
});

test("a refused command monitor shows why, and the output it judged by", () => {
  const el = render(call("monitor", { command: { run: "gh pr view 123", every: "5m" }, note: "x" },
    { result: { error: "the output changed between two runs 3s apart, so it would wake you on its own", output: "state: OPEN\nupdated 12:00:04" } }));
  expect(headings(el)).toEqual(["Error", "Command", "Output"]);
  expect(section(el, "Error").textContent).toContain("changed between two runs");
  expect(section(el, "Output").querySelector("pre")!.textContent).toBe("state: OPEN\nupdated 12:00:04");
});

test("a command monitor whose condition already held shows what it read and the server's own words", () => {
  const el = render(call("monitor", { command: { run: "gh pr checks 123", every: "2m", wakeWhen: "succeeds" }, note: "x" },
    { result: { status: "already_satisfied", kind: "command", exitCode: 0, output: "all green", note: "unexpected diagnostic: cannot confirm CI" } }));
  expect(headings(el)).toEqual(["Command", "Output", "Result"]);
  expect(section(el, "Output").querySelector("pre")!.textContent).toBe("all green");
  // Whatever the result says, as it says it: nothing it carries is dropped or replaced.
  expect(section(el, "Result").textContent).toContain("already_satisfied");
  expect(section(el, "Result").textContent).toContain("unexpected diagnostic: cannot confirm CI");
});

test("a registered command monitor lists the rest of what came back under what it read", () => {
  const el = render(call("monitor", { command: { run: "gh pr checks 123", every: "120s", wakeWhen: "succeeds" }, note: "x" },
    { result: { status: "registered", monitorId: "mon_7", kind: "command", every: "2m", wakeWhen: "succeeds", timeoutAt: "2026-10-05T00:00:00.000Z", nextRunAt: "2026-10-04T00:02:00.000Z", exitCode: 1, output: "" } }));
  expect(headings(el)).toEqual(["Command", "When", "Note", "First run", "Result"]);
  const rest = section(el, "Result").textContent ?? "";
  for (const part of ["registered", "mon_7", "2m"]) expect([part, rest.includes(part)]).toEqual([part, true]);
});

test("a command monitor whose result is not one the view knows falls back to showing it as it came", () => {
  const args = { command: { run: "gh pr checks 1", every: "2m" }, note: "x" };
  const registered = { status: "registered", monitorId: "mon_1", kind: "command", every: "2m", wakeWhen: "changed", timeoutAt: "2026-10-05T00:00:00.000Z", nextRunAt: "2026-10-04T00:02:00.000Z", exitCode: 0, output: "1" };
  // The shape the server sends is drawn by the monitor view: each case below
  // changes one thing about it.
  render(call("monitor", args, { result: registered }));
  expect(view!.host.querySelector('[data-slot="monitor-when"]') !== null).toBe(true);
  view!.unmount();
  const cases: Array<[unknown, string]> = [
    ["Unexpected server response", "Unexpected server response"],
    // A status the view does not know, with what it said beside it.
    [{ status: "unexpected", diagnostic: "Unexpected server response" }, "Unexpected server response"],
    // A known status in a shape the view does not draw: an output that is not text, a key it would drop.
    [{ ...registered, output: { lines: ["first line"] } }, "first line"],
    [{ ...registered, advice: "slow command" }, "slow command"],
    // A stderr that is not text.
    [{ ...registered, stderr: { lines: ["Unknown flag"] } }, "Unknown flag"],
    [{ error: "refused", output: "x", hint: "print ids only" }, "print ids only"],
    // Known keys holding values the server never sends: a check that held exits 0,
    // a note is text, an interval is text, a mode is one of two, the kind is command.
    [{ status: "already_satisfied", kind: "command", exitCode: 1, output: "checks pending", note: "x" }, "checks pending"],
    [{ status: "already_satisfied", kind: "command", exitCode: 0, output: "ok", note: { diagnostic: "not green" } }, "not green"],
    [{ ...registered, every: 120000 }, "120000"],
    [{ ...registered, wakeWhen: "sometimes" }, "sometimes"],
    [{ ...registered, kind: "pane" }, "pane"],
    [{ ...registered, exitCode: "0" }, "mon_1"]
  ];
  for (const [result, shown] of cases) {
    const el = render(call("monitor", args, { result }));
    // Shown, and by the generic view: none of the monitor view's own parts.
    // (Booleans, not the node: a failing match would print the whole DOM node.)
    expect([shown, el.textContent?.includes(shown), el.querySelector('[data-slot^="monitor-"]') !== null]).toEqual([shown, true, false]);
    view!.unmount();
  }
});

// ── read / write ────────────────────────────────────────────────────────

test("a file read is its path, the lines it came back with, and those lines numbered", () => {
  const el = render(call("read", { path: "/repo/src/ChatInput.tsx", offset: 96, limit: 50 }, {
    result: "    96\t  const onKeyDown = (e) => {\n    97\t    if (isImeComposing(e)) return;\n    98\t  };"
  }));
  expect(headings(el)).toEqual(["File", "Content"]);
  // The range the result has, not the 50 lines asked for.
  expect(section(el, "File").querySelector('[data-slot="tool-path-note"]')!.textContent).toBe("lines 96–98");
  const block = section(el, "Content").querySelector('[data-slot="tool-numbered"]')!;
  expect(block.querySelector('[data-slot="tool-gutter"]')!.textContent).toBe("96\n97\n98");
  expect(block.querySelectorAll("pre")[1]!.textContent).toBe("  const onKeyDown = (e) => {\n    if (isImeComposing(e)) return;\n  };");
});

test("a read of one line says line, and a failed read shows why", () => {
  const el = render(call("read", { path: "/repo/a.ts" }, { result: "     7\tconst a = 1;" }));
  expect(section(el, "File").querySelector('[data-slot="tool-path-note"]')!.textContent).toBe("line 7");
  view!.rerender(
    <ToolCallDetails row={call("read", { path: "/repo/big.go" }, { isError: true, error: "file content exceeds maximum allowed size (51200 bytes)" })} />
  );
  expect(headings(el)).toEqual(["File", "Error"]);
  expect(el.querySelector('[data-slot="tool-path-note"]') === null).toBe(true);
});

test("a file written is its path, its line count, and its content numbered from the top", () => {
  const el = render(call("write", { path: "/repo/notes.md", content: "# Notes\n\nFirst." }, { result: "Created /repo/notes.md (15 bytes, 3 lines)." }));
  // The success text is the path again and a byte count: left out.
  expect(headings(el)).toEqual(["File", "Content"]);
  expect(section(el, "File").querySelector('[data-slot="tool-path-note"]')!.textContent).toBe("3 lines");
  expect(el.querySelector('[data-slot="tool-gutter"]')!.textContent).toBe("1\n2\n3");
});

test("a final newline ends the last line rather than starting another; an empty file has none", async () => {
  const el = render(call("write", { path: "/repo/notes.md", content: "# Notes\n\nFirst.\n" }, { result: "Created /repo/notes.md (16 bytes, 3 lines)." }));
  expect(section(el, "File").querySelector('[data-slot="tool-path-note"]')!.textContent).toBe("3 lines");
  expect(el.querySelector('[data-slot="tool-gutter"]')!.textContent).toBe("1\n2\n3");
  // Copy gives the file exactly as written, its final newline included.
  const writes: string[] = [];
  const nav = navigator as unknown as { clipboard?: { writeText: (t: string) => Promise<void> } };
  const original = nav.clipboard;
  const secure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { writes.push(t); } } });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  try {
    const copy = section(el, "Content").querySelector('[aria-label="Copy content"]') as HTMLButtonElement;
    await act(async () => { copy.click(); });
    expect(writes).toStrictEqual(["# Notes\n\nFirst.\n"]);
  } finally {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: original });
    if (secure) Object.defineProperty(window, "isSecureContext", secure);
  }
  view!.rerender(<ToolCallDetails row={call("write", { path: "/repo/empty.txt", content: "" }, { result: "Created /repo/empty.txt (0 bytes, 0 lines)." })} />);
  expect(el.querySelector('[data-slot="tool-path-note"]')!.textContent).toBe("0 lines");
  expect(el.querySelector('[data-slot="tool-empty-file"]')!.textContent).toBe("Empty file");
  expect(headings(el)).toEqual(["File"]);
});

test("a write's result in either form, naming the path it was asked for, is left out", () => {
  const el = render(call("write", { path: "/repo/notes.md", content: "a\n" }, { result: "Created /repo/notes.md (2 bytes, 1 line)." }));
  expect(headings(el)).toEqual(["File", "Content"]);
  view!.rerender(<ToolCallDetails row={call("write", { path: "/repo/notes.md", content: "a\n" }, { result: "Overwrote /repo/notes.md (2 bytes, +1 -3 lines)." })} />);
  expect(headings(el)).toEqual(["File", "Content"]);
  view!.rerender(<ToolCallDetails row={call("write", { path: "/repo/notes.md", content: "a\n" }, { result: "Overwrote /repo/notes.md (2 bytes)." })} />);
  expect(headings(el)).toEqual(["File", "Content"]);
  view!.rerender(<ToolCallDetails row={call("write", { path: "/repo/../repo/notes.md", content: "a\n" }, { result: "Created /repo/notes.md (2 bytes, 1 line)." })} />);
  expect(headings(el)).toEqual(["File", "Content", "Output"]);
});

test("an edit's change and a written file say the lines they changed, beside their labels", () => {
  const counts = (root: Element) => [...root.querySelectorAll('[data-slot="line-counts"]')].map((n) => n.textContent);
  const el = render(call("edit", { path: "/repo/a.go", oldString: "a\nb", newString: "a\nB\nc" }, { result: "Updated /repo/a.go (1 replacement, +2 -1 lines)." }));
  expect(counts(section(el, "Change"))).toEqual(["+2 −1"]);
  view!.rerender(<ToolCallDetails row={call("write", { path: "/repo/notes.md", content: "a\nb\n" }, { result: "Overwrote /repo/notes.md (4 bytes, +1 -3 lines)." })} />);
  expect(counts(section(el, "File"))).toEqual(["+1 −3"]);
  // A file emptied has no Content to stand beside; the count stays with the file.
  view!.rerender(<ToolCallDetails row={call("write", { path: "/repo/notes.md", content: "" }, { result: "Overwrote /repo/notes.md (0 bytes, +0 -3 lines)." })} />);
  expect(counts(section(el, "File"))).toEqual(["+0 −3"]);
  // Nothing counted, nothing shown.
  view!.rerender(<ToolCallDetails row={call("write", { path: "/repo/notes.md", content: "a\n" }, { result: "Overwrote /repo/notes.md (2 bytes)." })} />);
  expect(counts(el)).toEqual([]);
  view!.rerender(<ToolCallDetails row={call("edit", { path: "/repo/a.go", oldString: "a", newString: "b" }, { result: "Updated /repo/a.go (1 replacement)." })} />);
  expect(counts(el)).toEqual([]);
});

test("a write result that says anything else is shown", () => {
  const el = render(call("write", { path: "/repo/../repo/notes.md", content: "x" }, { result: "Created /repo/notes.md (1 byte, 1 line)." }));
  expect(headings(el)).toEqual(["File", "Content", "Output"]);
  view!.rerender(
    <ToolCallDetails row={call("write", { path: "/repo/a.html", content: "x" }, { isError: true, error: "read must be called before overwriting existing file: /repo/a.html" })} />
  );
  expect(headings(el)).toEqual(["File", "Content", "Error"]);
});

// ── targets and markdown in the generic view ────────────────────────────

test("a tool that acts on one pane or feature shows it by name, not among the arguments", () => {
  const el = render(call("kill_pane", { paneId: "%4", signal: "SIGTERM" }, { result: { ok: true } }));
  expect(headings(el)).toEqual(["Pane", "Arguments"]);
  expect(target(el, "Pane")).toEqual({ name: "dev server", id: "%4", note: null });
  expect(dts(el)).toEqual(["Signal"]);
  rerender(call("feature_message_send", { featureId: "feat_1", message: "Read-only: find out why the import page sometimes shows a chosen file and a list that did not refresh. First see whether the file event reaches the page, then tell apart a list state that was reset, a request that was never sent, and a response that was dropped." }, { result: { status: "started" } }));
  expect(headings(el)).toEqual(["Worker", "Arguments", "Output"]);
  expect(el.querySelector('[data-slot="tool-part-label"]')!.textContent).toBe("Message");
  expect(target(el, "Worker")).toEqual({ name: "Import list", id: "feat_1", note: null });
});

test("a target argument that is not a string stays among the arguments", () => {
  const el = render(call("kill_pane", { paneId: 4 }, { isError: true, error: "parameter validation failed" }));
  expect(headings(el)).toEqual(["Arguments", "Error"]);
  expect(dts(el)).toEqual(["Pane ID"]);
});

test("a skill reads as the document it is, without the tags addressed to the model", async () => {
  const skill = "<system-reminder>\nThe following is the content of the 'tmux-pane' skill.\n\n# Mandate Terminal Panes\n\nUse **bash** by default.\n</system-reminder>";
  const el = render(call("skill", { name: "tmux-pane" }, { result: skill }));
  await act(async () => { await import("@/components/MarkdownView"); });
  await settle();
  const output = section(el, "Output");
  // A document's first heading, one size range down inside the panel.
  expect(output.querySelector("h3")!.textContent).toBe("Mandate Terminal Panes");
  expect(classes(output.querySelector('[data-slot="tool-markdown"]')!.firstElementChild)).toContain("[&_h3]:text-sm");
  expect(output.querySelector("strong")!.textContent).toBe("bash");
  expect(output.textContent).not.toContain("system-reminder");
});

test("a skill's reference file is shown as it is, tags it contains included", async () => {
  // The file documents prompt syntax; only `skill` wraps its result in these.
  const file = "<system-reminder>\nAn example of the wrapper.\n</system-reminder>";
  const el = render(call("read_skill_reference", { skill: "prompts", path: "wrapper.md" }, { result: file }));
  await act(async () => { await import("@/components/MarkdownView"); });
  await settle();
  expect(section(el, "Output").querySelector('[data-slot="tool-markdown"]')!.textContent).toContain("<system-reminder>");
});

test("outside a transcript no names are known, and ids show as themselves", () => {
  const el = render(call("send_keys", { paneId: "%4", args: ["Enter"] }, { result: { ok: true } }), { names: NO_NAMES });
  expect(target(el, "Pane")).toEqual({ name: null, id: "%4", note: null });
});

// ── what a view does not draw ───────────────────────────────────────────

test("every view of its own keeps the arguments as sent a tap away", () => {
  const cases: Array<[string, unknown, ToolRunRow["result"], string]> = [
    // -l is plumbing the key chips do not draw.
    ["send_keys", { paneId: "%4", args: ["-l", "ls -la"] }, { result: { ok: true } }, '"-l"'],
    // The 50 lines asked for; the view shows the 3 that came back.
    ["read", { path: "/repo/a.ts", offset: 96, limit: 50 }, { result: "    96\ta\n    97\tb\n    98\tc" }, '"limit": 50'],
    ["read_pane", { paneId: "%4", lines: 40 }, { result: "screen" }, '"lines": 40'],
    ["write", { path: "/repo/a.md", content: "x" }, { result: "Created /repo/a.md (1 byte, 1 line)." }, '"content": "x"'],
    ["bash", { command: "ls", timeout: 5000 }, { result: "exitCode: 0" }, '"timeout": 5000'],
    ["edit", { path: "/repo/a.ts", oldString: "a", newString: "b", replaceAll: false }, { result: "Updated /repo/a.ts (1 replacement)." }, '"replaceAll": false']
  ];
  for (const [tool, args, result, shown] of cases) {
    const el = render(call(tool, args, result));
    const raw = el.querySelector('[data-slot="tool-raw-args"]')!;
    expect(raw.querySelector("pre") === null).toBe(true);
    const button = raw.querySelector("button")!;
    expect(button.textContent).toBe("Show arguments");
    act(() => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(raw.querySelector("pre")!.textContent).toBe(JSON.stringify(args, null, 2));
    expect(raw.querySelector("pre")!.textContent).toContain(shown);
    view!.unmount();
  }
});

test("a view that fell back to the generic one does not repeat the arguments", () => {
  const el = render(call("send_keys", { paneId: "%4", args: "Enter" }, { isError: true, error: "parameter validation failed" }));
  expect(el.querySelector('[data-slot="tool-raw-args"]') === null).toBe(true);
});
