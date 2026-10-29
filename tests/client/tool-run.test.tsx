import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ToolRun } from "@/routes/window/chat/ToolRun";
import { ToolCallDetails } from "@/routes/window/chat/ToolCallDetails";
import type { ToolRunRow } from "@/routes/window/chat/tool-run-summary";
import { fakePhoneWidth } from "../fake-phone-width";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mount as mountTree, type Mounted } from "../helpers/mount.js";

let view: Mounted | null = null;
afterEach(() => {
  runCleanups();
  // The phone's sheet portals into document.body, outside `host`.
  document.body.innerHTML = "";
});

function mount(rows: ToolRunRow[]) {
  view = mountTree(<ToolRun rows={rows} />);
  return view.host;
}

const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });

const START = "2026-08-02T10:04:00.000Z";
const bash = (id: string, args: Record<string, unknown>, extra: Partial<ToolRunRow> = {}): ToolRunRow => ({
  call: { toolCallId: id, toolName: "bash", args },
  result: { result: `${id} output`, createdAt: "2026-08-02T10:04:00.300Z" },
  isRunning: false,
  startedAt: START,
  ...extra
});

const TESTS = bash("c1", { command: "bun test tests/chat-input.test.tsx", description: "Run the composer tests" });
const GREP = bash("c2", { command: "grep -rn Enter src/client" });

test("a run is one line in words, and nothing of its calls until opened", () => {
  const el = mount([TESTS, GREP]);
  const line = el.querySelector('[data-slot="tool-run-line"]')!;
  expect(line.textContent).toContain("Ran 2 commands");
  // The tally is the whole phrase, so it is what gives way in a narrow pane
  // (at 310px it used to run under "· 1 failed"; happy-dom lays nothing out,
  // so the class is pinned here and the look was checked in a browser).
  const tally = line.querySelector('[data-slot="tool-run-tally"]')!.className.split(/\s+/);
  expect(["min-w-0", "truncate"].every((c) => tally.includes(c))).toBe(true);
  // Every call is named, so the line does not count them.
  expect(line.querySelector('[data-slot="tool-run-count"]') === null).toBe(true);
  expect(line.getAttribute("aria-expanded")).toBe("false");
  expect(el.querySelector('[data-slot="tool-call"]') === null).toBe(true);
  expect(el.textContent).not.toContain("c1 output");
});

test("opening a run lists its calls; opening a call shows its description, args and output", () => {
  const el = mount([TESTS, GREP]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  const calls = [...el.querySelectorAll('[data-slot="tool-call"]')];
  expect(calls.map((c) => c.textContent)).toEqual(["RanRun the composer tests", "Rangrep -rn Enter src/client"]);
  expect(el.querySelector('[data-slot="tool-details"]') === null).toBe(true);

  click(calls[0]);
  const details = el.querySelector('[data-slot="tool-details"]')!;
  const headings = [...details.querySelectorAll('[data-slot="detail-label"]')].map((h) => h.textContent);
  expect(headings).toEqual(["Description", "Command", "Output"]);
  expect(details.textContent).toContain("bun test tests/chat-input.test.tsx");
  expect(details.textContent).toContain("c1 output");
  // Shown once, in its own section, not again as an argument.
  expect(details.textContent!.split("Run the composer tests").length - 1).toBe(1);
});

test("a run of one call opens straight to its details", () => {
  const el = mount([TESTS]);
  expect(el.querySelector('[data-slot="tool-run-line"]')!.textContent).toContain("RanRun the composer tests");
  click(el.querySelector('[data-slot="tool-run-line"]'));
  expect(el.querySelector('[data-slot="tool-call"]') === null).toBe(true);
  expect(el.querySelector('[data-slot="tool-details"]')!.textContent).toContain("c1 output");
});

test("a failure stays on the closed line, in red", () => {
  const el = mount([
    bash("c1", { command: "bun test" }, { result: { error: "exit 1", isError: true, createdAt: START } }),
    GREP
  ]);
  const failed = el.querySelector('[data-slot="tool-run-failed"]')!;
  expect(failed.textContent).toBe("· 1 failed");
  expect(failed.className.split(/\s+/)).toContain("text-red");
  // Opened, the failed call's verb is red and the other's is not.
  click(el.querySelector('[data-slot="tool-run-line"]'));
  const verbs = [...el.querySelectorAll('[data-slot="tool-call"] [data-slot="tool-lead"]')];
  expect(verbs.map((v) => v.className.split(/\s+/).includes("text-red"))).toEqual([true, false]);
});

test("a run in progress shows the step it is on and how many calls it has made", () => {
  const el = mount([
    GREP,
    bash("c3", { command: "bun run test:e2e", description: "Run the e2e suite" }, { isRunning: true, result: null })
  ]);
  const line = el.querySelector('[data-slot="tool-run-line"]')!;
  expect(line.textContent).toContain("RunningRun the e2e suite");
  expect(line.textContent).toContain("· 2 calls");
  expect(line.querySelector(".animate-spin") === null).toBe(false);
});

test("a slow call shows its duration on its row; a finished run's line shows no time", () => {
  const slow = bash("c1", { command: "sleep" }, { result: { result: "", createdAt: "2026-08-02T10:09:12.000Z" } });
  const fast = bash("c2", { command: "ls" }, { startedAt: "2026-08-02T10:09:12.000Z", result: { result: "", createdAt: "2026-08-02T10:09:12.200Z" } });
  const el = mount([slow, fast]);
  // The calls' time added up read as the turn's own; the turn's length is
  // the Worked-for footer's to say.
  const line = el.querySelector('[data-slot="tool-run-line"]')!;
  expect(line.querySelector('[data-slot="tool-run-duration"]') === null).toBe(true);
  expect(line.textContent).not.toContain("5m 12s");
  click(line);
  const durations = [...el.querySelectorAll('[data-slot="tool-duration"]')];
  expect(durations.map((d) => d.textContent)).toEqual(["5m 12s"]);
  expect(durations[0]!.tagName).toBe("TIME");
  expect(durations[0]!.getAttribute("datetime")).toBe("PT312S");
  expect(durations[0]!.getAttribute("title")).toContain("Completed");
  // A duration, not a clock: the row never claims when the call started.
  expect(el.textContent).not.toContain("10:04:00");
});

test("an id left out of the line is still there when you open the call", () => {
  const el = mount([{
    call: { toolCallId: "t1", toolName: "some_new_tool", args: { taskId: "11111111-1111-4111-8111-111111111111", status: "waiting" } },
    result: { result: "ok", createdAt: START },
    isRunning: false,
    startedAt: START
  }]);
  const line = el.querySelector('[data-slot="tool-run-line"]')!;
  expect(line.textContent).toContain("some_new_tool");
  expect(line.textContent).not.toContain("11111111");
  click(line);
  expect(el.textContent).toContain("11111111-1111-4111-8111-111111111111");
});

test("a run of one slow call is that call's row: its line keeps the call's own time", () => {
  const slow = bash("c1", { command: "sleep" }, { result: { result: "", createdAt: "2026-08-02T10:09:12.000Z" } });
  const el = mount([slow]);
  const time = el.querySelector('[data-slot="tool-run-line"] [data-slot="tool-run-duration"]')!;
  expect(time.textContent).toBe("· 5m 12s");
  expect(time.getAttribute("datetime")).toBe("PT312S");
});

test("on a phone a finished run's sheet shows no time; its slow call shows its own", () => {
  onCleanup(fakePhoneWidth(390));
  const slow = bash("c1", { command: "sleep" }, { result: { result: "", createdAt: "2026-08-02T10:09:12.000Z" } });
  const fast = bash("c2", { command: "ls" }, { startedAt: "2026-08-02T10:09:12.000Z", result: { result: "", createdAt: "2026-08-02T10:09:12.200Z" } });
  const el = mount([slow, fast]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  const sheet = document.querySelector('[role="dialog"]')!;
  expect(sheet.querySelector('[data-slot="tool-sheet-status"]')!.textContent).toBe("");
  click(sheet.querySelectorAll('[data-slot="tool-call"]')[0]);
  expect(document.querySelector('[role="dialog"] [data-slot="tool-sheet-status"]')!.textContent).toBe("Completed · 5m 12s");
});

test("on a phone the line opens a sheet: the calls, then one call's details, then back", () => {
  onCleanup(fakePhoneWidth(390));
  const el = mount([TESTS, GREP]);
  const line = el.querySelector('[data-slot="tool-run-line"]')!;
  // Nothing expands in place on a phone.
  click(line);
  expect(el.querySelector('[data-slot="tool-call"]') === null).toBe(true);
  const sheet = document.querySelector('[role="dialog"]')!;
  // The title counts the calls; the list under it says what each one did.
  expect(sheet.querySelector('[data-slot="tool-sheet-status"]')!.previousElementSibling!.textContent).toBe("2 tool calls");
  expect(sheet.querySelector('[data-slot="tool-sheet-status"]')!.textContent).toBe("");
  const calls = [...sheet.querySelectorAll('[data-slot="tool-call"]')];
  expect(calls).toHaveLength(2);

  click(calls[0]);
  expect(document.querySelector('[role="dialog"] [data-slot="tool-details"]')!.textContent).toContain("c1 output");
  expect(document.querySelector('[role="dialog"] [data-slot="tool-sheet-status"]')!.textContent).toBe("Completed");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("bash");

  click(document.querySelector('[aria-label="All calls in this run"]'));
  expect(document.querySelectorAll('[role="dialog"] [data-slot="tool-call"]')).toHaveLength(2);
});

// Close keeps one place, the header's right end, as every sheet's and
// dialog's: at the list it sat on the left and jumped right in a call's
// details, where ‹ took the left.
test("on a phone the sheet's Close stays at the right end; ‹ takes the left only in a call's details", () => {
  onCleanup(fakePhoneWidth(390));
  const ends = () => {
    const header = document.querySelector('[role="dialog"] [data-slot="tool-sheet-status"]')!.parentElement!.parentElement!;
    const label = (el: Element | null) => el?.getAttribute("aria-label") ?? (el?.getAttribute("aria-hidden") === "true" ? "(space)" : null);
    return [label(header.firstElementChild), label(header.lastElementChild)];
  };
  const el = mount([TESTS, GREP]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  expect(ends()).toEqual(["(space)", "Close"]);
  click(document.querySelectorAll('[role="dialog"] [data-slot="tool-call"]')[0]!);
  expect(ends()).toEqual(["All calls in this run", "Close"]);
  click(document.querySelector('[aria-label="All calls in this run"]'));
  expect(ends()).toEqual(["(space)", "Close"]);
});

// Esc, and the phone's Back with it, steps back as ‹ does: from a call's
// details to the list, and only then out of the sheet.
test("on a phone Esc in a call's details goes back to the list; the next Esc closes the sheet", () => {
  onCleanup(fakePhoneWidth(390));
  const escape = () => act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  const el = mount([TESTS, GREP]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  click(document.querySelectorAll('[role="dialog"] [data-slot="tool-call"]')[0]!);
  expect(document.querySelector('[role="dialog"] [data-slot="tool-details"]')).not.toBeNull();
  const open = '[role="dialog"]:not([data-state="closed"])';
  escape();
  expect(document.querySelector(open)).not.toBeNull();
  expect(document.querySelector(`${open} [data-slot="tool-details"]`) === null).toBe(true);
  expect(document.querySelectorAll(`${open} [data-slot="tool-call"]`)).toHaveLength(2);
  escape();
  expect(document.querySelector('[role="dialog"]:not([data-state="closed"])') === null).toBe(true);
});

test("on a phone Esc in a run of one call closes the sheet: there is no list to go back to", () => {
  onCleanup(fakePhoneWidth(390));
  const el = mount([bash("c1", { command: "bun test" }, { result: { error: "exit 1", isError: true, createdAt: START } })]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  expect(document.querySelector('[role="dialog"] [data-slot="tool-details"]')).not.toBeNull();
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(document.querySelector('[role="dialog"]:not([data-state="closed"])') === null).toBe(true);
});

test("on a phone a run of one call opens straight to its details", () => {
  onCleanup(fakePhoneWidth(390));
  const el = mount([bash("c1", { command: "bun test" }, { result: { error: "exit 1", isError: true, createdAt: START } })]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  const sheet = document.querySelector('[role="dialog"]')!;
  expect(sheet.querySelector('[data-slot="tool-details"]')!.textContent).toContain("exit 1");
  expect(sheet.querySelector('[data-slot="tool-sheet-status"]')!.textContent).toBe("Failed");
  expect(sheet.querySelector('[aria-label="All calls in this run"]') === null).toBe(true);
  const header = sheet.querySelector('[data-slot="tool-sheet-status"]')!.parentElement!.parentElement!;
  expect(header.lastElementChild!.getAttribute("aria-label")).toBe("Close");
});

test("a viewed image shows as a thumbnail and its metadata, never a JSON dump", () => {
  const imageBase64 = Buffer.from("png-bytes").toString("base64");
  const { host } = mountTree(
    <ToolCallDetails
      row={{
        call: { toolCallId: "call-1", toolName: "view_image", args: { path: "screenshot.png" } },
        result: {
          result: {
            type: "view_image_result",
            message: "Viewed image: screenshot.png",
            image: { type: "image", id: "img-1", name: "screenshot.png", displayPath: "screenshot.png", mediaType: "image/png", data: imageBase64, sizeBytes: 9 }
          }
        },
        isRunning: false
      }}
    />
  );
  expect(host.textContent).toContain("Viewed image: screenshot.png");
  expect(host.textContent).toContain("image/png, 9 B");
  expect(host.textContent).not.toContain("view_image_result");
  expect(host.textContent).not.toContain(imageBase64);
  const img = host.getElementsByTagName("img")[0]!;
  expect(img.getAttribute("src")).toBe(`data:image/png;base64,${imageBase64}`);
  expect(img.getAttribute("alt")).toBe("screenshot.png");
});

test("another tool's `description` argument stays an argument in the details", () => {
  // Here it is what the memory is searched for, not what the call is for.
  const el = mount([{
    call: { toolCallId: "m1", toolName: "memory_recall_by_description", args: { description: "how the pill rule works", limit: 8 } },
    result: { result: "[]", createdAt: START },
    isRunning: false,
    startedAt: START
  }]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  const details = el.querySelector('[data-slot="tool-details"]')!;
  expect([...details.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["Description", "Limit"]);
  // An argument in the grid, not the call's purpose in a section of its own.
  expect([...details.querySelectorAll('[data-slot="detail-label"]')].map((h) => h.textContent)).toEqual(["Arguments", "Output"]);
});

test("a run left open on a desktop does not open in place once the pane is phone-sized", () => {
  // The list keeps what is open across a resize; on a phone the sheet is the
  // only way in, so a run opened wide must not stay spread out narrow.
  onCleanup(fakePhoneWidth(390));
  const { host } = mountTree(<ToolRun rows={[TESTS, GREP]} expandedIds={new Set(["run:c1"])} />);
  expect(host.querySelector('[data-slot="tool-run-line"]') === null).toBe(false);
  expect(host.querySelector('[data-slot="tool-call"]') === null).toBe(true);
});

test("closing a run closes the calls opened inside it, so nothing hidden stays open", () => {
  // The list pauses following new messages while anything is open; a call
  // left open inside a closed run would pause it with nothing on screen.
  let openIds = new Set<string>();
  const tree = () => (
    <ToolRun
      rows={[TESTS, GREP]}
      expandedIds={openIds}
      onExpandedChange={(id, next) => {
        openIds = new Set(openIds);
        if (next) openIds.add(id);
        else openIds.delete(id);
        rerender(tree());
      }}
    />
  );
  const { host, rerender } = mountTree(tree());
  click(host.querySelector('[data-slot="tool-run-line"]'));
  click(host.querySelector('[data-slot="tool-call"]'));
  expect([...openIds].sort()).toEqual(["c1", "run:c1"]);
  click(host.querySelector('[data-slot="tool-run-line"]'));
  expect([...openIds]).toEqual([]);
});

test("a run stays open when an earlier step joins its front", () => {
  // Loading older messages can join a step onto the front of a run someone
  // has open; the run must not snap shut, or leave its mark behind.
  const openIds = new Set<string>(["run:c2"]);
  const { host, rerender } = mountTree(<ToolRun rows={[GREP]} expandedIds={openIds} />);
  expect(host.querySelector('[data-slot="tool-details"]') === null).toBe(false);
  rerender(<ToolRun rows={[TESTS, GREP]} expandedIds={openIds} />);
  expect(host.querySelectorAll('[data-slot="tool-call"]')).toHaveLength(2);
});

test("a failure the tool reported in its result is labelled an error in its details", () => {
  const el = mount([bash("c1", { command: "x" }), {
    call: { toolCallId: "k1", toolName: "send_keys", args: { paneId: "%4", args: ["C-c"], description: "Stop the dev server" } },
    result: { result: { error: "pane %4 is not in this feature" }, createdAt: START },
    isRunning: false,
    startedAt: START
  }]);
  expect(el.querySelector('[data-slot="tool-run-failed"]')!.textContent).toBe("· 1 failed");
  click(el.querySelector('[data-slot="tool-run-line"]'));
  click(el.querySelectorAll('[data-slot="tool-call"]')[1]);
  const details = el.querySelector('[data-slot="tool-details"]')!;
  expect(details.textContent).toContain("Error");
  expect(details.textContent).toContain("pane %4 is not in this feature");
});

test("on a phone a failed call's verb is red in the sheet's list too", () => {
  onCleanup(fakePhoneWidth(390));
  const el = mount([
    bash("c1", { command: "bun test" }, { result: { result: "stdout:\n 1 fail\nexitCode: 1", createdAt: START } }),
    GREP
  ]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  const verbs = [...document.querySelectorAll('[role="dialog"] [data-slot="tool-call"] [data-slot="tool-lead"]')];
  expect(verbs.map((v) => v.className.split(/\s+/).includes("text-red"))).toEqual([true, false]);
});

test("long output scrolls with the phone's sheet, not in a box of its own", () => {
  // A box that scrolls by itself inside the half-height sheet would take the
  // drag meant for the sheet. On a desktop the box stays: there it keeps a
  // long output from taking over the transcript.
  const long = Array.from({ length: 60 }, (_, i) => `line ${i} of a long test run`).join("\n");
  const row = bash("c1", { command: "bun test" }, { result: { result: `${long}\nexitCode: 0`, createdAt: START } });
  const box = (root: ParentNode) => root.querySelector('[data-slot="tool-details"] [data-slot="tool-output"]')!.className.split(/\s+/);

  const restoreWidth = fakePhoneWidth(390);
  onCleanup(restoreWidth);
  const phone = mount([row]);
  click(phone.querySelector('[data-slot="tool-run-line"]'));
  const sheet = document.querySelector('[data-slot="tool-sheet"]')!;
  expect(box(sheet)).not.toContain("overflow-y-auto");
  expect(sheet.textContent).not.toContain("Expand");
  view!.unmount();
  document.body.innerHTML = "";
  restoreWidth();

  const desk = mount([row]);
  click(desk.querySelector('[data-slot="tool-run-line"]'));
  expect(box(desk)).toContain("overflow-y-auto");
});

test("on a phone a command's non-zero exit is in the sheet's status line", () => {
  onCleanup(fakePhoneWidth(390));
  const el = mount([
    bash("c1", { command: "bun test" }, { result: { result: "stdout:\n 1 fail\nexitCode: 2", createdAt: START } }),
    bash("c2", { command: "grep -rn Enter src" }, { result: { result: "exitCode: 1", createdAt: START } }),
    bash("c3", { command: "nope" }, { result: { result: "stderr:\nspawn ENOENT\nexitCode: -1", createdAt: START } }),
    bash("c4", { command: "true" }, { result: { result: "exitCode: 0", createdAt: START } })
  ]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  const status = (index: number) => {
    click(document.querySelectorAll('[role="dialog"] [data-slot="tool-call"]')[index]);
    const text = document.querySelector('[role="dialog"] [data-slot="tool-sheet-status"]')!.textContent;
    click(document.querySelector('[aria-label="All calls in this run"]'));
    return text;
  };
  // grep's 1 is an answer, not a failure, but still what it answered.
  expect([status(0), status(1), status(2), status(3)]).toEqual(["Failed · exit 2", "Completed · exit 1", "Failed · exit -1", "Completed"]);
});

const edit = (id: string, added: number, removed: number): ToolRunRow => ({
  call: {
    toolCallId: id,
    toolName: "edit",
    args: { path: `/repo/${id}.go`, oldString: Array.from({ length: removed }, (_, i) => `old ${i}`).join("\n"), newString: Array.from({ length: added }, (_, i) => `new ${i}`).join("\n") }
  },
  result: { result: `Updated /repo/${id}.go (1 replacement, +${added} -${removed} lines).`, createdAt: "2026-08-02T10:04:00.300Z" },
  isRunning: false,
  startedAt: START
});
const counts = (root: ParentNode) => [...root.querySelectorAll('[data-slot="line-counts"]')].map((el) => el.textContent);

test("a run's line says the lines its calls changed, and each call its own, once opened", () => {
  const el = mount([edit("a", 3, 1), TESTS, edit("b", 2, 2)]);
  const line = el.querySelector('[data-slot="tool-run-line"]')!;
  expect(counts(line)).toEqual(["+5 −3"]);
  click(line);
  expect(counts(el.querySelector('[data-slot="tool-run-calls"]')!)).toEqual(["+3−1", "+2−2"]);
});

// A narrow pane is a phone or a pane under 34rem: the rules for it are
// container queries, which happy-dom does not apply, so the classes are pinned
// here and e2e/tool-run.test.ts checks what shows at both widths.
const classesOf = (el: Element) => el.className.split(/\s+/).filter(Boolean);
const NARROW_HIDDEN = "@max-[34rem]:hidden";

test("calls the tally does not name are counted on the line, at every width", () => {
  const plan: ToolRunRow = { ...READ, call: { toolCallId: "p1", toolName: "update_plan", args: { steps: [] } }, result: { result: "ok" } };
  const el = mount([GREP, plan, plan]);
  const line = el.querySelector('[data-slot="tool-run-line"]')!;
  expect([...line.querySelectorAll('[data-slot="tool-run-clause"]')].map((c) => c.textContent)).toEqual(["Ran 1 command"]);
  const count = line.querySelector('[data-slot="tool-run-count"]')!;
  expect(count.textContent).toBe("· 3 calls");
  expect(classesOf(count)).not.toContain("hidden");
});

test("a narrow pane names a run's first two clauses, then counts its calls", () => {
  const el = mount([READ, GREP, edit("a", 3, 1)]);
  const line = el.querySelector('[data-slot="tool-run-line"]')!;
  const clauses = [...line.querySelectorAll('[data-slot="tool-run-clause"]')];
  expect(clauses.map((c) => c.textContent)).toEqual(["Edited 1 file", ", ran 1 command", ", read 1 file"]);
  expect(clauses.map((c) => classesOf(c).includes(NARROW_HIDDEN))).toEqual([false, false, true]);
  // All three are named, so only the narrow line, short a clause, counts the calls.
  const count = line.querySelector('[data-slot="tool-run-count"]')!;
  expect(count.textContent).toBe("· 3 calls");
  expect(["hidden", "@max-[34rem]:inline"].every((c) => classesOf(count).includes(c))).toBe(true);
});

const FAILED_TESTS = bash("c9", { command: "bun test" }, { result: { error: "exit 1", isError: true, createdAt: START } });
const lineCountsOf = (el: Element) => el.querySelector('[data-slot="tool-run-line"] [data-slot="line-counts"]')!;

test("a narrow pane leaves the line counts off a run that reports a failure", () => {
  // "· 1 failed" takes the room: with the counts too, the second clause was
  // cut mid-word on a phone ("ran 2 comm…").
  const counts = lineCountsOf(mount([edit("a", 3, 1), FAILED_TESTS]));
  expect(counts.textContent).toBe("+3 −1");
  expect(classesOf(counts)).toContain(NARROW_HIDDEN);
});

test("a run with no failure keeps its line counts at every width", () => {
  expect(classesOf(lineCountsOf(mount([edit("a", 3, 1), TESTS])))).not.toContain(NARROW_HIDDEN);
});

test("a run still going shows no count until it is done", () => {
  const el = mount([edit("a", 3, 1), { ...TESTS, result: null, isRunning: true }]);
  expect(counts(el.querySelector('[data-slot="tool-run-line"]')!)).toEqual([]);
});

test("on a phone the sheet's title and its calls carry the counts too", () => {
  onCleanup(fakePhoneWidth(390));
  const el = mount([edit("a", 3, 1), GREP]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  const sheet = document.querySelector('[role="dialog"]')!;
  // The title sits right above the status line.
  const title = sheet.querySelector('[data-slot="tool-sheet-status"]')!.previousElementSibling!;
  expect(title.textContent).toContain("2 tool calls");
  expect(counts(title)).toEqual(["+3 −1"]);
  const rows = [...sheet.querySelectorAll('[data-slot="tool-call"]')];
  expect(rows.map((row) => counts(row))).toEqual([["+3−1"], []]);
  // Opened on one call, the title is that call's, and so is its count.
  click(rows[0]);
  const opened = document.querySelector('[role="dialog"] [data-slot="tool-sheet-status"]')!.previousElementSibling!;
  expect(opened.textContent).toContain("edit");
  expect(counts(opened)).toEqual(["+3 −1"]);
});

test("on a phone a run of one edit shows its count beside the sheet's title", () => {
  onCleanup(fakePhoneWidth(390));
  const el = mount([edit("a", 2, 5)]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  const title = document.querySelector('[role="dialog"] [data-slot="tool-sheet-status"]')!.previousElementSibling!;
  expect(counts(title)).toEqual(["+2 −5"]);
});

// ── the calls of an opened run ──────────

const READ: ToolRunRow = {
  call: { toolCallId: "r1", toolName: "read", args: { path: "src/client/app.ts" } },
  result: { result: "1\timport x", createdAt: "2026-08-02T10:04:00.300Z" },
  isRunning: false,
  startedAt: START
};
const FAILED = bash("c3", { command: "false", description: "Fail on purpose" }, {
  result: { result: "boom", isError: true, createdAt: "2026-08-02T10:04:00.300Z" }
});
const RUNNING = bash("c4", { command: "sleep 9", description: "Wait for the build" }, { result: null, isRunning: true });

const marks = (root: ParentNode) =>
  [...root.querySelectorAll('[data-slot="call-status"]')].map((mark) => [mark.getAttribute("data-status"), mark.getAttribute("data-kind")]);

test("an opened run marks each call by its kind, faintly; only a failure and a running call show a state", () => {
  const el = mount([READ, TESTS, FAILED, RUNNING]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  expect(marks(el)).toEqual([["ok", "file"], ["ok", "terminal"], ["error", "terminal"], ["running", "terminal"]]);
  // Success is the kind's icon in the faint colour: nothing green in the list.
  expect(el.querySelector('[data-slot="tool-run-calls"] .text-green') === null).toBe(true);
  expect(el.querySelector('[data-slot="call-status"][data-status="ok"] svg')!.getAttribute("class")).toContain("text-faint");
  expect(el.querySelector('[data-slot="call-status"][data-status="error"] svg')!.getAttribute("class")).toContain("text-red");
});

test("a thin line joins each call's icon to the next; the verb is in the foreground and the target faint", () => {
  const el = mount([READ, TESTS, FAILED]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  const calls = [...el.querySelectorAll('[data-slot="tool-call"]')];
  expect(calls.map((call) => call.querySelector('[data-slot="call-connector"]') !== null)).toEqual([true, true, false]);
  const tokens = (call: Element, slot: string) => call.querySelector(`[data-slot="${slot}"]`)!.className.split(/\s+/);
  expect(tokens(calls[1]!, "tool-lead")).toContain("text-foreground");
  expect(tokens(calls[1]!, "tool-detail")).toContain("text-faint");
  // A failed call's verb stays red.
  expect(tokens(calls[2]!, "tool-lead")).toContain("text-red");
});

test("a call's line counts are a tinted pill in the list; the run line keeps plain counts", () => {
  const el = mount([edit("e1", 12, 3), edit("e2", 1, 0)]);
  expect(el.querySelector('[data-slot="tool-run-line"] [data-slot="line-counts"]')!.getAttribute("data-variant")).toBe(null);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  const pills = [...el.querySelectorAll('[data-slot="tool-call"] [data-slot="line-counts"]')];
  expect(pills.map((pill) => [pill.getAttribute("data-variant"), pill.textContent])).toEqual([["pill", "+12−3"], ["pill", "+1−0"]]);
});

test("on a phone the sheet's calls are drawn the same way", () => {
  onCleanup(fakePhoneWidth(390));
  const el = mount([READ, TESTS, FAILED]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  const sheet = document.querySelector('[role="dialog"]')!;
  expect(marks(sheet)).toEqual([["ok", "file"], ["ok", "terminal"], ["error", "terminal"]]);
  const calls = [...sheet.querySelectorAll('[data-slot="tool-call"]')];
  expect(calls.map((call) => call.querySelector('[data-slot="call-connector"]') !== null)).toEqual([true, true, false]);
});

// The run's line keeps no clock: while a turn runs, the working line under
// it counts the turn's time, and two clocks side by side read as two things.
test("a call under way counts its own seconds on its row; the run's line keeps no clock", () => {
  const underWay = { ...RUNNING, startedAt: new Date(Date.now() - 12_000).toISOString() };
  const el = mount([TESTS, underWay]);
  const line = el.querySelector('[data-slot="tool-run-line"]')!;
  expect(line.textContent).toContain("Running");
  expect(line.querySelector('[data-slot="tool-run-duration"]') === null).toBe(true);
  click(line);
  const rows = [...el.querySelectorAll('[data-slot="tool-call"]')];
  expect(rows.map((row) => row.querySelector('[data-slot="tool-duration"]')?.textContent ?? null))
    .toEqual([null, expect.stringMatching(/^1[23]s$/)]);
});

test("a call under way with no known start shows no clock rather than a made-up one", () => {
  const el = mount([TESTS, { ...RUNNING, startedAt: undefined }]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  const rows = [...el.querySelectorAll('[data-slot="tool-call"]')];
  expect(rows.length).toBe(2);
  expect(rows.map((row) => row.querySelector('[data-slot="tool-duration"]') === null)).toEqual([true, true]);
});

test("on a phone the sheet's title is a count that fits, not the run's whole sentence; the status keeps what failed", () => {
  onCleanup(fakePhoneWidth(390));
  const el = mount([
    READ,
    edit("a", 3, 1),
    TESTS,
    bash("c9", { command: "go vet ./..." }, { result: { error: "exit 1", isError: true, createdAt: START } })
  ]);
  click(el.querySelector('[data-slot="tool-run-line"]'));
  const status = document.querySelector('[role="dialog"] [data-slot="tool-sheet-status"]')!;
  const title = status.previousElementSibling!;
  expect(title.textContent).toBe("4 tool calls+3 −1");
  // The count is the title's now; the status line does not say it again.
  expect(status.textContent).toBe("1 failed");
});

// A live run: the running turn is on it (liveRunRow), and its line names a
// call instead of the tally.
test("a live run's line names the call under way, not a later one of its step still waiting its turn", () => {
  const waiting = bash("c5", { command: "ls", description: "List what is left" }, { result: null, isRunning: false });
  view = mountTree(<ToolRun rows={[TESTS, RUNNING, waiting]} live />);
  const line = view.host.querySelector('[data-slot="tool-run-line"]')!;
  expect(line.textContent).toContain("RunningWait for the build");
  expect(line.textContent).not.toContain("List what is left");
  expect(line.textContent).toContain("· 3 calls");
});

test("a live run's line says no line counts until the run is done, as a running one does", () => {
  view = mountTree(<ToolRun rows={[edit("a", 3, 1), TESTS]} live />);
  const line = view.host.querySelector('[data-slot="tool-run-line"]')!;
  expect(line.textContent).toContain("RanRun the composer tests");
  expect(counts(line)).toEqual([]);
});

// The images a run viewed show under its line, folded or not: thumbnails
// like an attached image's, four at most, each opening its original.
const shot = (n: number, extra: Partial<ToolRunRow> = {}): ToolRunRow => ({
  call: { toolCallId: `v${n}`, toolName: "view_image", args: { path: `shot-${n}.png` } },
  result: {
    result: { type: "view_image_result", message: `Viewed image: shot-${n}.png`, image: { type: "image", id: `img-${n}`, name: `shot-${n}.png`, displayPath: `shots/shot-${n}.png`, mediaType: "image/png", data: "", sizeBytes: 2_000_000, url: `/api/agents/messages/msg_${n}/images/img-${n}` } },
    createdAt: "2026-08-02T10:04:00.300Z"
  },
  isRunning: false,
  startedAt: START,
  ...extra
});

test("the images a run viewed show under its line as thumbnails, four at most, each opening its original", () => {
  const el = mount([TESTS, shot(1), shot(2), shot(3), shot(4), shot(5)]);
  const strip = el.querySelector('[data-slot="image-tiles"]')!;
  expect(strip.closest('[data-slot="tool-run"]')).not.toBeNull();
  expect([...strip.querySelectorAll("img")].map((img) => img.getAttribute("src")))
    .toEqual([1, 2, 3, 4].map((n) => `/api/agents/messages/msg_${n}/images/img-${n}?size=thumb`));
  expect(strip.querySelector('[data-slot="image-tiles-more"]')?.textContent).toBe("+1");
  click(strip.querySelectorAll('[data-slot="image-open"]')[1]);
  const opened = document.querySelector('[role="dialog"]:not([data-state="closed"]) img');
  expect(opened?.getAttribute("src")).toBe("/api/agents/messages/msg_2/images/img-2");
});

test("a run that viewed no image, or failed to, shows no thumbnails", () => {
  // Marked failed, whatever came back is not shown as what it viewed.
  const failed = shot(1, { result: { ...shot(1).result!, isError: true } });
  expect(mount([TESTS, failed]).querySelector('[data-slot="image-tiles"]')).toBeNull();
  runCleanups();
  expect(mount([TESTS, GREP]).querySelector('[data-slot="image-tiles"]')).toBeNull();
});
