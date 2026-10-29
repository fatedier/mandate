import { expect, test } from "bun:test";
import { act } from "react";
import { ToolCallDetails } from "@/routes/window/chat/ToolCallDetails";
import type { DetailLayout } from "@/routes/window/chat/tool-details/blocks";
import type { ToolRunRow } from "@/routes/window/chat/tool-run-summary";
import { mount, type Mounted } from "../helpers/mount.js";

let view: Mounted | null = null;

function render(row: ToolRunRow, layout: DetailLayout = "inline") {
  view = mount(<ToolCallDetails row={row} layout={layout} />);
  return view.host;
}

const headings = (el: ParentNode) => [...el.querySelectorAll('[data-slot="detail-label"]')].map((h) => h.textContent);
/** The section a heading labels: the heading's row, then what it labels. */
function section(el: ParentNode, label: string): HTMLElement {
  const heading = [...el.querySelectorAll('[data-slot="detail-label"]')].find((h) => h.textContent === label);
  if (!heading) throw new Error(`no section "${label}" in ${headings(el).join(", ")}`);
  return heading.parentElement!.parentElement!;
}
const classes = (el: Element | null) => (el?.className ?? "").split(/\s+/);
const dts = (el: ParentNode) => [...el.querySelectorAll("dt")].map((dt) => dt.textContent);
const partLabels = (el: ParentNode) => [...el.querySelectorAll('[data-slot="tool-part-label"]')].map((l) => l.textContent);
/** A sub-part of a section (a piece of writing among the arguments): its heading, then what it heads. */
function part(el: ParentNode, label: string): HTMLElement {
  const heading = [...el.querySelectorAll('[data-slot="tool-part-label"]')].find((l) => l.textContent === label);
  if (!heading) throw new Error(`no part "${label}" in ${partLabels(el).join(", ")}`);
  return heading.parentElement!.parentElement!;
}

const call = (toolName: string, args: unknown, result: ToolRunRow["result"]): ToolRunRow =>
  ({ call: { toolCallId: "t1", toolName, args }, result, isRunning: false });

// ── bash ────────────────────────────────────────────────────────────────

test("a command's stdout and stderr are two sections, and stderr is not red when it succeeded", () => {
  const el = render(call("bash", { command: "bun test" }, {
    result: "stdout:\n3 pass\nstderr:\nwarning: slow test\nexitCode: 0"
  }));
  expect(headings(el)).toEqual(["Command", "Output", "Stderr"]);
  expect(section(el, "Output").textContent).toContain("3 pass");
  expect(section(el, "Output").textContent).not.toContain("warning");
  expect(section(el, "Stderr").textContent).toContain("warning: slow test");
  expect(classes(section(el, "Stderr").querySelector('[data-slot="tool-output"]'))).not.toContain("text-red");
  // The transcript's own markers are not shown.
  expect(el.textContent).not.toContain("exitCode");
  expect(el.textContent).not.toContain("stdout:");
});

test("a command that failed says how it exited, and its stderr is red", () => {
  const el = render(call("bash", { command: "ls /nope" }, { result: "stderr:\nls: /nope: No such file\nexitCode: 2" }));
  expect(el.querySelector('[data-slot="bash-exit"]')!.textContent).toBe("Exited with code 2");
  expect(classes(section(el, "Stderr").querySelector('[data-slot="tool-output"]'))).toContain("text-red");
});

test("the exit is left to the sheet's status line on a phone", () => {
  const el = render(call("bash", { command: "ls /nope" }, { result: "stderr:\nls: /nope\nexitCode: 2" }), "sheet");
  expect(el.querySelector('[data-slot="bash-exit"]') === null).toBe(true);
  expect(section(el, "Stderr").textContent).toContain("ls: /nope");
});

test("a -1 is said as it is: it can mean the command never started, or was killed", () => {
  const el = render(call("bash", { command: "sleep 99" }, { result: "stderr:\n[bash: command timed out after 1000ms]\nexitCode: -1" }));
  expect(el.querySelector('[data-slot="bash-exit"]')!.textContent).toBe("Exited with code -1");
  expect(section(el, "Stderr").textContent).toContain("timed out after 1000ms");
});

test("grep finding nothing is an answer: its exit is said, and nothing is red", () => {
  const el = render(call("bash", { command: "grep -rn Enter src" }, { result: "exitCode: 1" }));
  expect(el.querySelector('[data-slot="bash-exit"]')!.textContent).toBe("Exited with code 1");
  expect(el.querySelector('[data-slot="bash-no-output"]')!.textContent).toBe("No output");
  expect(el.querySelector(".text-red") === null).toBe(true);
});

test("a command that exited 0 says nothing of its exit", () => {
  const el = render(call("bash", { command: "true" }, { result: "exitCode: 0" }));
  expect(el.querySelector('[data-slot="bash-exit"]') === null).toBe(true);
});

test("a result not in the transcript's shape is shown whole", () => {
  const el = render(call("bash", { command: "cat big.log" }, { result: "stdout:\nfirst lines… [output spooled]" }));
  expect(headings(el)).toEqual(["Command", "Output"]);
  expect(section(el, "Output").textContent).toContain("stdout:\nfirst lines… [output spooled]");
});

test("a bash call that raised shows its error", () => {
  const el = render(call("bash", { command: "sleep 99" }, { isError: true, error: "command timed out" }));
  expect(headings(el)).toEqual(["Command", "Error"]);
  expect(section(el, "Error").textContent).toContain("command timed out");
});

test("where a command ran and its timeout sit under it, and only when given", () => {
  const el = render(call("bash", { command: "make", cwd: "/repo/app", timeout: 90_000 }, { result: "exitCode: 0" }));
  expect(el.querySelector('[data-slot="bash-options"]')!.textContent).toBe("in /repo/app · timeout 90s");
  view!.rerender(<ToolCallDetails row={call("bash", { command: "make", timeout: 5_000 }, { result: "exitCode: 0" })} />);
  expect(el.querySelector('[data-slot="bash-options"]')!.textContent).toBe("timeout 5s");
  // Never rounded into a different number.
  view!.rerender(<ToolCallDetails row={call("bash", { command: "make", timeout: 1_500 }, { result: "exitCode: 0" })} />);
  expect(el.querySelector('[data-slot="bash-options"]')!.textContent).toBe("timeout 1500ms");
  view!.rerender(<ToolCallDetails row={call("bash", { command: "make" }, { result: "exitCode: 0" })} />);
  expect(el.querySelector('[data-slot="bash-options"]') === null).toBe(true);
  // A null the model sent for an option is no option, as in the generic view.
  view!.rerender(<ToolCallDetails row={call("bash", { command: "make", cwd: null }, { result: "exitCode: 0" })} />);
  expect(headings(el)).toEqual(["Command"]);
  expect(el.querySelector('[data-slot="bash-options"]') === null).toBe(true);
});

test("a bash call whose arguments are not bash's is shown argument by argument", () => {
  // A malformed call, then one with a key the view does not know: either way
  // the values the model sent stay in view.
  for (const [args, labels] of [
    [{ command: 42, timeout: "5000" }, ["Command", "Timeout"]],
    [{ command: "ls", env: "A=1" }, ["Command", "Env"]]
  ] as const) {
    const el = render(call("bash", args, { isError: true, error: "parameter validation failed" }));
    expect(headings(el)).toEqual(["Arguments", "Error"]);
    expect(dts(el)).toEqual([...labels]);
    view!.unmount();
  }
  // A required argument sent as null is not an empty command: the null is
  // what the model sent, and it stays in view.
  const el = render(call("bash", { command: null }, { isError: true, error: "parameter validation failed" }));
  expect(headings(el)).toEqual(["Arguments", "Error"]);
  expect(section(el, "Arguments").querySelector("dd")!.textContent).toBe("null");
  // And one left out is not an empty command either.
  view!.rerender(<ToolCallDetails row={call("bash", { description: "List the files" }, { isError: true, error: "parameter validation failed" })} />);
  expect(headings(el)).toEqual(["Description", "Error"]);
});

// ── edit ────────────────────────────────────────────────────────────────

const EDIT_ARGS = {
  path: "/repo/src/client/ToolRun.tsx",
  oldString: "const a = 1;\nconst b = 2;\nconst c = 3;",
  newString: "const a = 1;\nconst b = 20;\nconst c = 3;"
};

test("an edit is its file and the change as a diff", () => {
  const el = render(call("edit", EDIT_ARGS, { result: "Updated /repo/src/client/ToolRun.tsx (1 replacement)." }));
  expect(headings(el)).toEqual(["File", "Change"]);
  const path = el.querySelector('[data-slot="tool-path"]')!;
  expect(path.querySelector(".text-faint")!.textContent).toBe("/repo/src/client/");
  expect(path.querySelector(".font-semibold")!.textContent).toBe("ToolRun.tsx");
  // Wrapped, not cut, and preferably after a slash: one break after each.
  expect(classes(path)).toContain("[overflow-wrap:anywhere]");
  expect(classes(path).some((c) => c.includes("nowrap") || c.includes("ellipsis"))).toBe(false);
  expect(path.querySelectorAll(".text-faint wbr")).toHaveLength(4);
  const rows = [...el.querySelectorAll('[data-slot="tool-diff"] [data-diff]')];
  expect(rows.map((r) => [r.getAttribute("data-diff"), r.textContent])).toEqual([
    ["context", " const a = 1;"],
    ["removed", "−removed: const b = 2;"],
    ["added", "+added: const b = 20;"],
    ["context", " const c = 3;"]
  ]);
  // The result is the path again and "1 replacement": nothing to add.
  expect(el.textContent).not.toContain("Updated");
  expect(el.querySelector('[data-slot="edit-replace-all"]') === null).toBe(true);
});

test("an edit of every occurrence says so, and how many places that was", () => {
  const el = render(call("edit", { ...EDIT_ARGS, replaceAll: true }, { result: "Updated /repo/src/client/ToolRun.tsx (3 replacements)." }));
  expect(el.querySelector('[data-slot="edit-replace-all"]')!.textContent).toBe("Every occurrence · 3 places");
  view!.rerender(<ToolCallDetails row={call("edit", { ...EDIT_ARGS, replaceAll: true }, { result: "Updated /repo/src/client/ToolRun.tsx (1 replacement)." })} />);
  expect(el.querySelector('[data-slot="edit-replace-all"]')!.textContent).toBe("Every occurrence · 1 place");
  // Still running, or a result in some other words: no count to give.
  view!.rerender(<ToolCallDetails row={call("edit", { ...EDIT_ARGS, replaceAll: true }, null)} />);
  expect(el.querySelector('[data-slot="edit-replace-all"]')!.textContent).toBe("Every occurrence");
  view!.rerender(<ToolCallDetails row={call("edit", { ...EDIT_ARGS, replaceAll: false }, { result: "Updated /repo/src/client/ToolRun.tsx (1 replacement)." })} />);
  expect(el.querySelector('[data-slot="edit-replace-all"]') === null).toBe(true);
});

test("a success naming another path than the one asked for is shown whole", () => {
  // The server resolves the path it was given; a `..` in it comes back gone.
  const args = { ...EDIT_ARGS, path: "/repo/src/../src/client/ToolRun.tsx" };
  const el = render(call("edit", args, { result: "Updated /repo/src/client/ToolRun.tsx (1 replacement)." }));
  expect(headings(el)).toEqual(["File", "Change", "Output"]);
  expect(section(el, "Output").textContent).toContain("Updated /repo/src/client/ToolRun.tsx (1 replacement).");
});

test("an edit result that is not the success text is shown whole", () => {
  const el = render(call("edit", EDIT_ARGS, { result: "Edited /repo/src/client/ToolRun.tsx" }));
  expect(headings(el)).toEqual(["File", "Change", "Output"]);
  expect(section(el, "Output").textContent).toContain("Edited /repo/src/client/ToolRun.tsx");
  view!.rerender(<ToolCallDetails row={call("edit", EDIT_ARGS, { result: { error: "oldString not found" } })} />);
  expect(headings(el)).toEqual(["File", "Change", "Error"]);
  expect(section(el, "Error").textContent).toContain("oldString not found");
  expect(classes(section(el, "Error").querySelector('[data-slot="tool-output"]'))).toContain("text-red");
});

test("a failed edit shows its error in red", () => {
  const el = render(call("edit", EDIT_ARGS, { isError: true, error: "oldString is not unique" }));
  expect(headings(el)).toEqual(["File", "Change", "Error"]);
  expect(section(el, "Error").textContent).toContain("oldString is not unique");
  expect(classes(section(el, "Error").querySelector('[data-slot="tool-output"]'))).toContain("text-red");
});

test("an edit whose arguments are not edit's falls back to the argument list", () => {
  // Each one wrong on its own, the others fine.
  const base = ["Path", "Old string", "New string"];
  for (const [bad, labels] of [
    [{ path: 7 }, base],
    [{ oldString: 42 }, base],
    [{ newString: 5 }, base],
    [{ replaceAll: "true" }, [...base, "Replace all"]],
    [{ encoding: "utf8" }, [...base, "Encoding"]]
  ] as const) {
    const args = { path: "/repo/a.ts", oldString: "a", newString: "b", ...bad };
    const el = render(call("edit", args, { isError: true, error: "Invalid arguments" }));
    expect(el.querySelector('[data-slot="tool-diff"]') === null).toBe(true);
    expect(dts(el)).toEqual([...labels]);
    view!.unmount();
  }
  // A required one left out, likewise.
  const el = render(call("edit", { path: "/repo/a.ts", oldString: "a" }, { isError: true, error: "Invalid arguments" }));
  expect(el.querySelector('[data-slot="tool-diff"]') === null).toBe(true);
  expect(dts(el)).toEqual(["Path", "Old string"]);
});

// ── any other tool ──────────────────────────────────────────────────────

test("short arguments share one grid, labelled in words; writing gets the full width", () => {
  const summary = "All three checks of the export feature pass; the review found nothing that has to change, so it can go to the owner for a last look. It is still a draft and cannot be published yet.";
  const el = render(call("update_my_work_item", {
    phase: "done",
    title: "Export feature · pre-release check",
    summary,
    decisions: ["Keep the PR in draft", "Ask the maintainer"]
  }, { result: { ok: true } }));
  // One Arguments section: the grid, then each piece of writing under its own heading.
  expect(headings(el)).toEqual(["Arguments"]);
  expect(partLabels(el)).toEqual(["Summary", "Decisions"]);
  expect(dts(section(el, "Arguments"))).toEqual(["Phase", "Title"]);
  expect(part(el, "Summary").textContent).toContain(summary);
  expect(part(el, "Summary").querySelector('[data-slot="tool-markdown"]') === null).toBe(false);
  expect([...part(el, "Decisions").querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "•Keep the PR in draft",
    "•Ask the maintainer"
  ]);
  // Nothing sideways: the grid and the writing wrap.
  expect(classes(el.querySelector('[data-slot="tool-options"]'))).toContain("[overflow-wrap:anywhere]");
  // A bare { ok: true } says what the status icon does: no output section.
  expect(headings(el)).not.toContain("Output");
});

test("writing is rendered as the markdown it was written in", () => {
  const note = "Keep the page in **draft** until the editor signs off on the \`Index.Build\` ordering change.";
  const el = render(call("task_update", { taskId: "task_1", note }, { result: { ok: true } }));
  const block = part(el, "Note").querySelector('[data-slot="tool-markdown"]')!;
  expect(block.querySelector("strong")!.textContent).toBe("draft");
  expect(block.querySelector("code")!.textContent).toBe("Index.Build");
  expect(classes(block.firstElementChild)).toContain("text-xs");
});

test("an object argument is opened one level, and a null in it is kept", () => {
  const long = "The export job stopped half way through the third batch; the results of the first two are kept whole, the remaining batches wait for a go-ahead, and no existing file is touched meanwhile.";
  const el = render(call("update_work_item", {
    id: "wi_Qw3rTy5uIo9",
    patch: { title: "Export job to rerun", summary: long, needsUser: null, tags: { a: 1 } }
  }, { result: { ok: true } }));
  expect(headings(el)).toEqual(["Arguments"]);
  expect(partLabels(el)).toEqual(["Patch · Summary", "Patch · Tags"]);
  expect(dts(el)).toEqual(["ID", "Patch · Title", "Patch · Needs user"]);
  // `needsUser: null` is how the patch clears the field: it is shown.
  expect([...el.querySelectorAll("dd")].map((dd) => dd.textContent)).toEqual(["wi_Qw3rTy5uIo9", "Export job to rerun", "null"]);
  // Two levels down is JSON.
  expect(part(el, "Patch · Tags").querySelector("pre")!.textContent).toBe('{\n  "a": 1\n}');
});

test("a result is laid out as fields, without the ok the status already says", () => {
  const el = render(call("task_claim", { taskId: "task_aY34" }, {
    result: { ok: true, taskId: "task_aY34", title: "Read-only look at the import list", status: "active" }
  }));
  const output = section(el, "Output");
  expect(dts(output)).toEqual(["Task ID", "Title", "Status"]);
  expect(output.querySelector('[data-slot="tool-fields"]')!.textContent).not.toContain("true");
});

test("a list in a result reads as items: a title, its id, a few short fields", () => {
  const el = render(call("list_panes", {}, {
    result: { panes: [
      { paneId: "%133", name: "Format check", description: "read-only", command: "codex", cwd: "/Users/user/.mandate/worktrees/md-project-1-0a1b2c3d4e/draft-notes", status: "running", createdAt: "" },
      { paneId: "%158", name: "PR Checks", command: "zsh", status: "running" }
    ] }
  }));
  expect(headings(el)).toEqual(["Output"]);
  const nested = el.querySelector('[data-slot="tool-nested"]')!;
  expect(nested.firstElementChild!.textContent).toBe("Panes · 2");
  expect([...nested.querySelectorAll('[data-slot="tool-item-title"]')].map((t) => t.textContent)).toEqual(["Format check", "PR Checks"]);
  const meta = nested.querySelector('[data-slot="tool-item-meta"]')!.textContent;
  // Its id, then the first short fields; the long cwd and the empty time are left to the JSON.
  expect(meta).toBe("%133 · Description: read-only · Command: codex · Status: running");
});

test("an empty list says none", () => {
  const el = render(call("task_list", { status: "queued" }, { result: { tasks: [] } }));
  const output = section(el, "Output");
  expect(dts(output)).toEqual(["Tasks"]);
  expect(output.querySelector("dd")!.textContent).toBe("none");
});

test("a time reads as a time, its exact value in the tooltip", () => {
  const el = render(call("schedule_wake", { when: "3m" }, { result: { alarmId: "alm_BR4", fireAt: "2026-09-09T16:13:51.727Z" } }));
  const time = section(el, "Output").querySelector("time")!;
  expect(time.getAttribute("dateTime")).toBe("2026-09-09T16:13:51.727Z");
  expect(time.getAttribute("title")).toBe("2026-09-09T16:13:51.727Z");
  // In text, the date and the minute; the exact value stays in the title.
  expect(time.textContent).toMatch(/^Sep \d{1,2}(, 2026)? · \d{2}:\d{2}$/);
});

test("the raw JSON of a laid-out result is a tap away", () => {
  const value = { alarmId: "alm_BR4", fireAt: "2026-09-09T16:13:51.727Z" };
  const el = render(call("schedule_wake", { when: "3m" }, { result: value }));
  const button = [...section(el, "Output").querySelectorAll("button")].find((b) => b.textContent === "JSON")!;
  expect(button.getAttribute("aria-pressed")).toBe("false");
  act(() => button.click());
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(section(el, "Output").querySelector("pre")!.textContent).toBe(JSON.stringify(value, null, 2));
  expect(section(el, "Output").querySelector('[data-slot="tool-fields"]') === null).toBe(true);
});

test("text that reads as JSON stays text, and is never taken for an acknowledgement", () => {
  // A small JSON file's text, returned by a text-returning tool.
  const el = render(call("some_text_tool", { path: "ok.json" }, { result: '{"ok":true}' }));
  expect(section(el, "Output").querySelector('[data-slot="tool-output"]')!.textContent).toBe('{"ok":true}');
});

test("a malformed call's null arguments are shown, not dropped", () => {
  const el = render(call("some_tool", null, { isError: true, error: "parameter validation failed" }));
  expect(headings(el)).toEqual(["Arguments", "Error"]);
  expect(section(el, "Arguments").querySelector("pre")!.textContent).toBe("null");
});

test("an error a tool reported is shown in its own words, in red", () => {
  const el = render(call("create_feature", { name: "排查" }, { result: { error: "feature name sanitizes to empty" } }));
  expect(headings(el)).toEqual(["Arguments", "Error"]);
  // Its words, not the object they came in, and nothing under them: the
  // error was all it carried.
  const words = section(el, "Error").querySelector('[data-slot="tool-output"]')!;
  expect(words.textContent).toBe("feature name sanitizes to empty");
  expect(words.parentElement!.children.length).toBe(1);
  expect(classes(section(el, "Error").querySelector('[data-slot="tool-output"]'))).toContain("text-red");
});

test("a reported error keeps the rest of what came with it, and its JSON", () => {
  const raw = { ok: false, error: "No active client is associated with this agent thread.", clientId: "c_1" };
  const el = render(call("ui_read_page_summary", { timeoutMs: 2000 }, { result: raw }));
  const error = section(el, "Error");
  expect(error.querySelector('[data-slot="tool-output"]')!.textContent).toBe(raw.error);
  // The other fields laid out; `ok: false` is what the red already says.
  expect(dts(error)).toEqual(["Client ID"]);
  const button = [...error.querySelectorAll("button")].find((b) => b.textContent === "JSON")!;
  act(() => button.click());
  expect(error.querySelector("pre")!.textContent).toBe(JSON.stringify(raw, null, 2));
});

test("a list item with nothing to name it by shows as its JSON, not a blank row", () => {
  const el = render(call("some_tool", {}, { result: { items: [{ value: null }, { data: { x: 1 } }, { name: "named" }] } }));
  const items = [...el.querySelectorAll('[data-slot="tool-items"] li')].map((li) => li.textContent);
  expect(items).toEqual(['{"value":null}', '{"data":{"x":1}}', "named"]);
});

test("a null or empty result says so rather than showing a blank", () => {
  const el = render(call("some_tool", {}, { result: null }));
  expect(section(el, "Output").querySelector("pre")!.textContent).toBe("null");
  view!.rerender(<ToolCallDetails row={call("some_tool", {}, { result: {} })} />);
  expect(section(el, "Output").querySelector('[data-slot="tool-result-body"]')!.textContent).toBe("Empty");
});

test("a long structured result is capped in the transcript, as long text is, but not in the sheet", () => {
  const panes = Array.from({ length: 30 }, (_, i) => ({ paneId: `%${i}`, name: `pane number ${i}`, status: "running" }));
  const row = call("list_panes", {}, { result: { panes } });
  const body = (el: ParentNode) => section(el, "Output").querySelector('[data-slot="tool-result-body"]')!;
  const inline = render(row);
  expect(classes(body(inline))).toContain("overflow-y-auto");
  const expand = [...section(inline, "Output").querySelectorAll("button")].find((b) => b.textContent === "Expand")!;
  act(() => expand.click());
  expect(classes(body(inline))).not.toContain("overflow-y-auto");
  view!.unmount();
  const sheet = render(row, "sheet");
  expect(classes(body(sheet))).not.toContain("overflow-y-auto");
  expect([...section(sheet, "Output").querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Expand");
  view!.unmount();
  // Short: nothing to cap.
  const short = render(call("list_panes", {}, { result: { panes: panes.slice(0, 2) } }));
  expect(classes(body(short))).not.toContain("overflow-y-auto");
});

test("a list of many short items is capped too: the cap counts lines, not only characters", () => {
  const el = render(call("some_tool", {}, { result: Array.from({ length: 40 }, (_, i) => String(i)) }));
  expect(JSON.stringify(Array.from({ length: 40 }, (_, i) => String(i))).length).toBeLessThan(800);
  expect(classes(section(el, "Output").querySelector('[data-slot="tool-result-body"]'))).toContain("overflow-y-auto");
});

test("a heading wraps however long the key it came from", () => {
  const key = "aVeryLongMetadataKeyThatTheModelChoseForThisMemoryEntryWithoutAnySpaces";
  const el = render(call("memory_remember", { metadata: { [key]: "x".repeat(80) } }, { result: { ok: true } }));
  const label = el.querySelector('[data-slot="tool-arg"] [data-slot="tool-part-label"]')!;
  expect(label.textContent).toBe("Metadata · A very long metadata key that the model chose for this memory entry without any spaces");
  // It may shrink, and the details' root lets any word in it wrap.
  expect(classes(label)).toContain("min-w-0");
  expect(classes(el.querySelector('[data-slot="tool-details"]'))).toContain("[overflow-wrap:anywhere]");
  // A section's own heading gives way to its hairline the same way.
  const heading = section(el, "Arguments").querySelector('[data-slot="detail-label"]')!;
  expect(classes(heading)).toContain("min-w-0");
  expect(classes(heading)).not.toContain("shrink-0");
});

test("the arguments exactly as sent are a tap away, whatever the layout made of them", () => {
  const long = "x".repeat(80);
  const args = { content: long, metadata: { foo_bar: long, fooBar: `${long}y` } };
  const el = render(call("memory_remember", args, { result: { ok: true } }));
  // No short argument, so no grid — and still one section, with Copy and JSON.
  expect(headings(el)).toEqual(["Arguments"]);
  expect(el.querySelector('[data-slot="tool-options"]') === null).toBe(true);
  // Two keys, one label: the layout blurs them, the JSON does not.
  expect(partLabels(el)).toEqual(["Content", "Metadata · Foo bar", "Metadata · Foo bar"]);
  const json = [...section(el, "Arguments").querySelectorAll("button")].find((b) => b.textContent === "JSON")!;
  act(() => json.click());
  expect(section(el, "Arguments").querySelector("pre")!.textContent).toBe(JSON.stringify(args, null, 2));
  expect(section(el, "Arguments").querySelector('[aria-label="Copy arguments"]') === null).toBe(false);
});

test("a date that does not exist stays as it was written, not rolled over to a real one", () => {
  const el = render(call("memory_get", { id: "mem_1" }, { result: { expiresAt: "2027-02-30T10:00:00Z" } }));
  const dd = section(el, "Output").querySelector("dd")!;
  expect(dd.textContent).toBe("2027-02-30T10:00:00Z");
  expect(dd.querySelector("time") === null).toBe(true);
});

test("a time before 1970 stays as it was written rather than going blank", () => {
  const el = render(call("some_tool", {}, { result: { at: "1969-12-31T23:59:59Z" } }));
  const dd = section(el, "Output").querySelector("dd")!;
  expect(dd.textContent).toBe("1969-12-31T23:59:59Z");
  expect(dd.querySelector("time") === null).toBe(true);
});

test("command output of many short lines is capped in the transcript too", () => {
  const el = render(call("bash", { command: "seq 200" }, { result: `stdout:\n${Array.from({ length: 200 }, (_, i) => String(i)).join("\n")}\nexitCode: 0` }));
  expect(classes(section(el, "Output").querySelector('[data-slot="tool-output"]'))).toContain("overflow-y-auto");
});

// A worker's name in Chinese has no spaces but is no machine token: mono
// is for ids, paths and numbers, printable ASCII with no space.
test("a value in words of a script like Chinese reads in the body font, even without a space; an id stays mono", () => {
  const el = render(call("some_tool", { name: "修复project-1错误", featureId: "feat_abc123" }, { result: { ok: true } }));
  const spanOf = (text: string) => [...el.querySelectorAll("dd span")].find((s) => s.textContent === text)!;
  expect(classes(spanOf("修复project-1错误"))).not.toContain("font-mono");
  expect(classes(spanOf("feat_abc123"))).toContain("font-mono");
});
