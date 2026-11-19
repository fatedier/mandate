import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ToolRun } from "@/routes/window/chat/ToolRun";
import type { ToolRunRow } from "@/routes/window/chat/tool-run-summary";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

// A long run opens on its latest calls, in the order they ran, so what the
// agent did last sits next to what comes after it; the earlier ones are a
// press away, 50 at a time. The red count of failures opens only those.

afterEach(() => {
  runCleanups();
  // The phone's sheet portals into document.body.
  document.body.innerHTML = "";
});

const START = "2026-08-02T10:04:00.000Z";
const step = (n: number, failed = false): ToolRunRow => ({
  call: { toolCallId: `c${n}`, toolName: "bash", args: { command: `step-${n}`, description: `Step ${n}` } },
  result: failed ? { error: "exit 1", isError: true, createdAt: START } : { result: `c${n} output`, createdAt: START },
  isRunning: false,
  startedAt: START
});
const run = (count: number, failures: readonly number[] = []) => Array.from({ length: count }, (_, i) => step(i + 1, failures.includes(i + 1)));

const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
/** The calls listed, by the step each names. */
const calls = (root: ParentNode) => [...root.querySelectorAll('[data-slot="tool-call"]')].map((el) => el.textContent?.match(/Step \d+/)?.[0] ?? "");
const earlier = (root: ParentNode) => root.querySelector<HTMLElement>('[data-slot="tool-run-earlier"]');
const line = (root: ParentNode) => root.querySelector<HTMLElement>('[data-slot="tool-run-line"]');
const failedCount = (root: ParentNode) => root.querySelector<HTMLElement>('[data-slot="tool-run-failed"]');
const steps = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `Step ${from + i}`);

/** A run whose open marks the test holds, as the list does. */
function held(rows: ToolRunRow[]) {
  let marks = new Set<string>();
  const tree = (r: ToolRunRow[]) => (
    <ToolRun
      rows={r}
      expandedIds={marks}
      onExpandedChange={(id, next) => {
        marks = new Set(marks);
        if (next) marks.add(id);
        else marks.delete(id);
        view.rerender(tree(current));
      }}
    />
  );
  let current = rows;
  let generation = 0;
  const view = mount(tree(rows));
  return {
    host: view.host,
    marks: () => [...marks].sort(),
    grow: (r: ToolRunRow[]) => { current = r; view.rerender(tree(r)); },
    // The same run drawn as a new element, as a row whose key changed is.
    remount: () => { generation += 1; view.rerender(<div key={generation}>{tree(current)}</div>); }
  };
}

test("a long run opens on its latest 8 calls, in the order they ran, under a row counting the earlier ones and their failures", () => {
  const { host } = mount(<ToolRun rows={run(20, [2, 5, 18])} />);
  click(line(host));
  expect(calls(host)).toEqual(steps(13, 20));
  expect(earlier(host)!.textContent).toBe("12 earlier calls · 2 failed");
  const clauses = [...earlier(host)!.querySelectorAll<HTMLElement>("span")].filter((el) => el.children.length === 0 && el.textContent?.includes("failed"));
  expect(clauses.map((el) => el.className.split(/\s+/).includes("text-destructive"))).toEqual([true]);
  // Above the calls it stands for.
  expect(Boolean(earlier(host)!.compareDocumentPosition(host.querySelector('[data-slot="tool-call"]')!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
});

test("each press on the earlier row shows 50 more, until none are left", () => {
  const { host } = mount(<ToolRun rows={run(120)} />);
  click(line(host));
  const seen: Array<[number, string | null]> = [[calls(host).length, earlier(host)?.textContent ?? null]];
  for (let i = 0; i < 3; i++) {
    click(earlier(host));
    seen.push([calls(host).length, earlier(host)?.textContent ?? null]);
  }
  expect(seen).toEqual([[8, "112 earlier calls"], [58, "62 earlier calls"], [108, "12 earlier calls"], [120, null]]);
  expect(calls(host)[0]).toBe("Step 1");
});

test("a run of 8 or fewer opens whole; one call more is one earlier call", () => {
  const short = mount(<ToolRun rows={run(8)} />).host;
  click(line(short));
  expect([calls(short).length, earlier(short) === null]).toEqual([8, true]);
  runCleanups();
  const nine = mount(<ToolRun rows={run(9)} />).host;
  click(line(nine));
  expect([calls(nine).length, earlier(nine)?.textContent]).toEqual([8, "1 earlier call"]);
});

test("calls that come in while it is open are added at the bottom; what was shown stays shown", () => {
  const r = held(run(10));
  click(line(r.host));
  expect(calls(r.host)).toEqual(steps(3, 10));
  // Marked where it opened: the first call shown.
  expect(r.marks()).toEqual(["run:c3"]);
  r.grow(run(12));
  expect(calls(r.host)).toEqual(steps(3, 12));
  expect(earlier(r.host)!.textContent).toBe("2 earlier calls");
  click(earlier(r.host));
  expect([calls(r.host).length, r.marks()]).toEqual([12, ["run:c1"]]);
  click(line(r.host));
  expect(r.marks()).toEqual([]);
});

test("the red count opens only the failed calls; the line opens the run; each closes what it opened", () => {
  const { host } = mount(<ToolRun rows={run(20, [2, 5, 18])} />);
  expect(failedCount(host)!.textContent).toBe("· 3 failed");
  expect(failedCount(host)!.tagName).toBe("BUTTON");
  click(failedCount(host));
  expect(calls(host)).toEqual(["Step 2", "Step 5", "Step 18"]);
  expect([earlier(host) === null, failedCount(host)!.getAttribute("aria-expanded"), line(host)!.getAttribute("aria-expanded")]).toEqual([true, "true", "false"]);
  // The line switches to the whole run.
  click(line(host));
  expect([calls(host).length, earlier(host)?.textContent, line(host)!.getAttribute("aria-expanded"), failedCount(host)!.getAttribute("aria-expanded")])
    .toEqual([8, "12 earlier calls · 2 failed", "true", "false"]);
  click(line(host));
  expect(calls(host)).toEqual([]);
  click(failedCount(host));
  click(failedCount(host));
  expect(calls(host)).toEqual([]);
});

test("a run with no failure, or of one call, keeps the count on its line as before", () => {
  const ok = mount(<ToolRun rows={run(20)} />).host;
  expect(failedCount(ok) === null).toBe(true);
  runCleanups();
  const one = mount(<ToolRun rows={run(1, [1])} />).host;
  // One call opens straight to its details: nothing to pick out.
  expect([failedCount(one)!.textContent, failedCount(one)!.tagName]).toEqual(["· 1 failed", "SPAN"]);
});

test("on a phone the sheet lists the latest 8 under the earlier row, and the red count opens it on the failed calls", () => {
  onCleanup(fakePhoneWidth(390));
  const { host } = mount(<ToolRun rows={run(20, [2, 5, 18])} />);
  click(line(host));
  const sheet = () => document.querySelector('[role="dialog"]')!;
  expect([calls(sheet()).length, earlier(sheet())!.textContent]).toEqual([8, "12 earlier calls · 2 failed"]);
  click(earlier(sheet()));
  expect([calls(sheet()).length, earlier(sheet()) === null]).toEqual([20, true]);
  click(document.querySelector('[role="dialog"] [aria-label="Close"]'));
  click(failedCount(host));
  expect(calls(sheet())).toEqual(["Step 2", "Step 5", "Step 18"]);
});

const pending = (n: number): ToolRunRow => ({ ...step(n), result: null, isRunning: false });

test("opened on its failures, it stays so when its row is drawn anew (the list holds the mode with the mark)", () => {
  const rows = run(20, [2, 5]);
  const r = held(rows);
  click(failedCount(r.host));
  expect(r.marks()).toEqual(["run-failed:c2", "run:c2"]);
  // Drawn anew (an earlier step joined the run's front): same marks, same list.
  r.remount();
  expect(calls(r.host)).toEqual(["Step 2", "Step 5"]);
  // Switched to the whole run: marked at its latest, the failures' mark gone.
  click(line(r.host));
  expect(r.marks()).toEqual(["run:c13"]);
  click(line(r.host));
  expect(r.marks()).toEqual([]);
});

test("an open run is marked on a call that has its answer, so a call still on its way that leaves the run does not close it", () => {
  // The step that started 8 commands in the background: their calls wait for their answers.
  const rows = [...run(12), ...Array.from({ length: 8 }, (_, i) => pending(13 + i))];
  const r = held(rows);
  click(line(r.host));
  // Still its latest 8, though they wait: where the list starts is marked
  // apart from the call the run is held open at.
  expect([calls(r.host), earlier(r.host)?.textContent]).toEqual([steps(13, 20), "12 earlier calls"]);
  expect(r.marks()).toEqual(["run-from:c13", "run:c12"]);
  // Answered as background tasks, they leave the run (their own lines now).
  r.grow(run(12));
  expect(calls(r.host)).toEqual(steps(5, 12));
  // Opened on its failures, it is marked on a failure.
  const f = held([...run(12, [3]), ...Array.from({ length: 8 }, (_, i) => pending(13 + i))]);
  click(failedCount(f.host));
  expect(f.marks()).toEqual(["run-failed:c3", "run:c3"]);
  f.grow(run(12, [3]));
  expect(calls(f.host)).toEqual(["Step 3"]);
});

test("the line keeps keyboard focus when its first failure comes in", () => {
  const view = mount(<ToolRun rows={run(3)} />);
  line(view.host)!.focus();
  view.rerender(<ToolRun rows={[...run(3), step(4, true)]} />);
  expect(failedCount(view.host)!.tagName).toBe("BUTTON");
  expect(document.activeElement === line(view.host)).toBe(true);
  // From one call to two, likewise.
  const one = mount(<ToolRun rows={run(1)} />);
  line(one.host)!.focus();
  one.rerender(<ToolRun rows={[...run(1), step(2, true)]} />);
  expect(document.activeElement === line(one.host)).toBe(true);
});

test("on a phone the sheet keeps its place when the call it starts at leaves the run, and new calls come in under it", () => {
  onCleanup(fakePhoneWidth(390));
  const waiting = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => pending(from + i));
  const view = mount(<ToolRun rows={[...run(12), ...waiting(13, 20)]} />);
  click(line(view.host));
  const sheet = () => document.querySelector('[role="dialog"]')!;
  expect([calls(sheet()), earlier(sheet())?.textContent]).toEqual([steps(13, 20), "12 earlier calls"]);
  // c13 started a background task (it has its own line now); two more calls come in.
  view.rerender(<ToolRun rows={[...run(12), ...waiting(14, 22)]} />);
  expect([calls(sheet()), earlier(sheet())?.textContent]).toEqual([steps(14, 22), "12 earlier calls"]);
});

test("a call whose details are open stays in the list as calls come in, though the run lost calls on the way", () => {
  const r = held([...run(12), ...Array.from({ length: 8 }, (_, i) => pending(13 + i))]);
  click(line(r.host));
  // The eight left the run (background tasks): its latest 8 are 5–12.
  r.grow(run(12));
  expect(calls(r.host)).toEqual(steps(5, 12));
  const fifth = [...r.host.querySelectorAll<HTMLElement>('[data-slot="tool-call"]')].find((el) => el.textContent?.includes("Step 5"))!;
  click(fifth);
  expect(r.host.querySelector('[data-slot="tool-details"]')?.textContent).toContain("c5 output");
  // A new call comes in: Step 5 and its open details stay where they are.
  r.grow(run(13));
  expect(calls(r.host)).toEqual(steps(5, 13));
  expect(r.host.querySelector('[data-slot="tool-details"]')?.textContent).toContain("c5 output");
});
