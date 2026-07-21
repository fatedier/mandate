import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ActivityGroupDto } from "@shared/api-contracts";
import { BreakdownTable } from "@/routes/activity/BreakdownTable";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * happy-dom performs no layout, so nothing here reads a width. The tiers are
 * class names on the cells; what they do to a real box is asserted in e2e.
 */

function group(key: string, fields: Partial<ActivityGroupDto> = {}): ActivityGroupDto {
  return {
    key, label: key, calls: 10, failed: 0,
    p50Ms: 1000, p95Ms: 4000, p99Ms: 9000, maxMs: 12_000,
    inputTokens: 9000, outputTokens: 300, cacheReadTokens: 8100,
    fallbackCalls: 0, reasons: [], ...fields
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(
  groups: ActivityGroupDto[],
  onSelect: (key: string) => void = () => {}
): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<BreakdownTable groups={groups} group="model" onSelect={onSelect} />);
  });
  return container;
}

function headings(page: HTMLElement): string[] {
  return [...page.querySelectorAll("th")].map((n) => n.textContent ?? "");
}

function cells(page: HTMLElement, row = 0): string[] {
  const tr = page.querySelectorAll("tbody tr")[row]!;
  return [...tr.querySelectorAll("td")].map((n) => n.textContent ?? "");
}

test("every figure sits under the heading it was computed for", async () => {
  // Each number is distinct, so a column read off the wrong field renders a
  // plausible figure against the wrong name rather than something obviously
  // broken. 8,100 of the 9,000-token prompt is 90%.
  const page = await render([group("openai-compatible / gpt-5.6-sol", {
    calls: 1234, failed: 37, fallbackCalls: 12
  })]);

  expect(headings(page)).toEqual([
    "Provider / model", "Calls", "p50", "p95", "p99", "max",
    "Failed", "Fallback", "Input", "Cache", "Output"
  ]);
  expect(cells(page)).toEqual([
    "openai-compatible / gpt-5.6-sol", "1,234", "1.0s", "4.0s", "9.0s", "12s",
    "3.0%", "1.0%", "9.0k", "90%", "300"
  ]);
});

test("the heading names the dimension in view", async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<BreakdownTable groups={[group("memory")]} group="scopeType" onSelect={() => {}} />);
  });
  expect(headings(container)[0]).toBe("Scope type");
});

test("a group's most common failure reason sits under its name", async () => {
  const page = await render([group("a", {
    failed: 3,
    reasons: [{ reason: "Not Found", calls: 3 }, { reason: "Service Unavailable", calls: 1 }]
  })]);
  // The first one only. A group with four distinct reasons would otherwise
  // push every other row off the screen.
  const reason = page.querySelector("[data-group-reason]");
  expect(reason?.textContent).toBe("Not Found · 3");
});

test("a group that failed nothing shows no reason line at all", async () => {
  const page = await render([group("a", { failed: 0, reasons: [] })]);
  expect(page.querySelectorAll("[data-group-reason]").length).toBe(0);
});

test("a group with no fallback calls says so with a dash, not a zero", async () => {
  // 0% would read as a measurement on a dimension where the honest answer is
  // "this one is the primary".
  const page = await render([group("a", { fallbackCalls: 0 })]);
  expect(cells(page)[7]).toBe("—");
});

test("a group with no latency at all reads as unmeasured, not as instant", async () => {
  // The endpoint's percentile window skips null latencies but its coalesce
  // does not, so a group whose calls never recorded one answers 0. Rendered as
  // a duration that is "0ms" — a measurement the store never made, on the four
  // columns a reader scans for the slow ones.
  const page = await render([group("a", { p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 })]);
  expect(cells(page).slice(2, 6)).toEqual(["—", "—", "—", "—"]);
});

test("clicking a row hands back the key it was drawn from", async () => {
  const seen: string[] = [];
  const page = await render([group("first"), group("second")], (key: string) => { seen.push(key); });
  const button = page.querySelectorAll("tbody tr")[1]!.querySelector("button")!;
  await act(async () => { button.click(); });
  expect(seen).toEqual(["second"]);
});

test("the whole row is the target, and it selects once", async () => {
  // The table this replaced was clickable across the row, and the Overview —
  // the tab a reader lands on — now renders through here. A control that is
  // only the name cell is a target the width of the text in it, with ten
  // columns of figures beside it that do nothing.
  //
  // Once, not twice: the button sits inside the row, so a click on it that
  // bubbles selects the same group again.
  const seen: string[] = [];
  const page = await render([group("first"), group("second")], (key: string) => { seen.push(key); });
  const rows = page.querySelectorAll("tbody tr");
  await act(async () => {
    rows[1]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  expect(seen).toEqual(["second"]);

  await act(async () => {
    rows[0]!.querySelector("button")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  expect(seen).toEqual(["second", "first"]);
});

test("the row reads the label and the click carries the key", async () => {
  // `key` and `label` are separate fields on the DTO — one is what the log
  // filters by, the other is what the reader sees. Every other fixture here
  // sets them equal, which makes the two indistinguishable: reading `key` into
  // the cell, or handing `label` to the caller, would pass all of them.
  const seen: string[] = [];
  const page = await render(
    [group("codex/gpt-5.6-sol", { label: "codex / gpt-5.6-sol" })],
    (key: string) => { seen.push(key); }
  );
  const button = page.querySelector("tbody tr button")!;
  expect(button.textContent).toBe("codex / gpt-5.6-sol");
  expect(button.getAttribute("title")).toBe("codex / gpt-5.6-sol");
  await act(async () => { (button as HTMLElement).click(); });
  expect(seen).toEqual(["codex/gpt-5.6-sol"]);
});

/** Both halves of a column carry the same tier, and asserting one is not
 *  evidence about the other: a heading that survives while its cells drop
 *  stands over a column of blanks, and cells that survive while the heading
 *  drops are a column of figures under no name. */
function expectTiers(marks: string[]): void {
  expect(marks.length).toBe(11);
  // p99, max, fallback and output go first; input and cache go one tier later.
  expect(marks[4]).toContain("@max-[52rem]:hidden");
  expect(marks[5]).toContain("@max-[52rem]:hidden");
  expect(marks[7]).toContain("@max-[52rem]:hidden");
  expect(marks[10]).toContain("@max-[52rem]:hidden");
  expect(marks[8]).toContain("@max-[40rem]:hidden");
  expect(marks[9]).toContain("@max-[40rem]:hidden");
  // And only that tier. A cell carrying both drops at 52rem like the rest,
  // which erases the mid tier the ordering exists to produce — the one the
  // dock-open width lands in.
  expect(marks[8]).not.toContain("52rem");
  expect(marks[9]).not.toContain("52rem");
  // Calls, p50, p95 and Failed are never dropped.
  expect(marks[1] + marks[2] + marks[3] + marks[6]).not.toContain("hidden");
}

test("the dropped columns are marked, not merely narrow", async () => {
  const page = await render([group("a")]);
  expectTiers([...page.querySelectorAll("th")].map((n) => n.className));
  expectTiers([...page.querySelectorAll("tbody tr td")].map((n) => n.className));
});

test("the tier classes have a container to be measured against", async () => {
  // `@max-[52rem]:hidden` is a container query: with no ancestor declaring
  // `@container` it is inert at every width and the table never drops a
  // column, while every class-name assertion above still passes. happy-dom
  // evaluates none of it, so what is asserted is that the ancestor exists.
  const page = await render([group("a")]);
  const ancestry: string[] = [];
  let node: Element | null = page.querySelector("table");
  while (node && node !== page) {
    ancestry.push(node.className);
    node = node.parentElement;
  }
  expect(ancestry.some((mark) => mark.split(" ").includes("@container"))).toBe(true);
});

test("an empty window says so instead of rendering a headless table", async () => {
  const page = await render([]);
  expect(page.querySelectorAll("table").length).toBe(0);
  expect(page.textContent).toContain("No calls in this window.");
});
