import { expect, test } from "bun:test";
import { act } from "react";
import type { ActivityGroupDto } from "@shared/api-contracts";
import { BreakdownTable } from "@/routes/activity/BreakdownTable";
import { mountAsync } from "../helpers/mount.js";

/**
 * happy-dom performs no layout, so nothing here reads a width. The tiers are
 * class names on the cells; what they do to a real box is asserted in e2e.
 */

function group(key: string, fields: Partial<ActivityGroupDto> = {}): ActivityGroupDto {
  return {
    key, label: key, calls: 10, failed: 0,
    p50Ms: 1000, ttftP95Ms: 2_500, tokensPerSecondP50: 42.5,
    inputTokens: 9000, outputTokens: 300, cacheReadTokens: 8100,
    reasons: [], spendMicros: 0, spendEstimated: false, unpricedCalls: 0, ...fields
  };
}

async function render(
  groups: ActivityGroupDto[],
  onSelect: (key: string) => void = () => {}
): Promise<HTMLElement> {
  const { host } = await mountAsync(<BreakdownTable groups={groups} group="model" onSelect={onSelect} />);
  return host;
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
    calls: 1234, failed: 37, spendMicros: 4_200_000, spendEstimated: true
  })]);

  expect(headings(page)).toEqual(["Provider / model", "Calls", "Spend", "p50", "TTFT p95", "tok/s", "Failed", "Cache"]);
  expect(cells(page)).toEqual(["openai-compatible / gpt-5.6-sol", "1,234", "~$4.20", "1.0s", "2.5s", "42.5", "3.0%", "90.0%"]);
});

// Stacked on a phone, a figure has no column head above it, so it carries that
// head's name to show in front of it.
test("every figure carries the name of the heading it sits under", async () => {
  const page = await render([group("a")]);
  const labels = [...page.querySelectorAll("tbody tr td")].slice(1).map((n) => n.getAttribute("data-label"));
  expect(labels).toEqual(headings(page).slice(1));
});

test("the heading names the dimension in view", async () => {
  const { host: container } = await mountAsync(<BreakdownTable groups={[group("memory")]} group="scopeType" onSelect={() => {}} />);
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

test("a group with no first token or no answered output says so with a dash, not a zero", async () => {
  // Decision models answer whole: no first token. A group whose calls all
  // failed has no speed. Zero would read as instant, or as stalled.
  const page = await render([group("a", { ttftP95Ms: null, tokensPerSecondP50: null })]);
  expect(cells(page).slice(4, 6)).toEqual(["—", "—"]);
});

test("a group with no latency at all reads as unmeasured, not as instant", async () => {
  // The endpoint's percentile window skips null latencies but its coalesce
  // does not, so a group whose calls never recorded one answers 0. Rendered as
  // a duration that is "0ms" — a measurement the store never made, on the
  // column a reader scans for the slow ones.
  const page = await render([group("a", { p50Ms: 0 })]);
  expect(cells(page)[3]).toBe("—");
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
  expect(seen).toStrictEqual(["second"]);

  await act(async () => {
    rows[0]!.querySelector("button")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  expect(seen).toStrictEqual(["second", "first"]);
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
  expect(seen).toStrictEqual(["codex/gpt-5.6-sol"]);
});

/** Both halves of a column carry the same tier, and asserting one is not
 *  evidence about the other: a heading that survives while its cells drop
 *  stands over a column of blanks, and cells that survive while the heading
 *  drops are a column of figures under no name. */
function expectTiers(marks: string[]): void {
  expect(marks.length).toBe(8);
  // Below a half-screen pane's width the cache goes.
  expect(marks[7]).toContain("@max-[48rem]:hidden");
  // Calls, Spend, p50, TTFT p95, tok/s and Failed are never dropped. (Stacked
  // on a phone their heads go, and each figure carries its head's name instead.)
  expect(marks.slice(1, 7).join(" ")).not.toMatch(/@max-\[\d+rem\]:hidden/);
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

test("the table has a label-micro head row on the panel and no card wrapper", async () => {
  const page = await render([group("a", { failed: 3, calls: 10 })]);
  const head = page.querySelector('[data-slot="table-head"]')!;
  expect(head === null).toBe(false);
  expect(head.querySelector("th")!.className.split(/\s+/)).toContain("label-micro");
  expect(page.innerHTML.includes("bg-card")).toBe(false);
  const failed = page.querySelector('[data-col="failed"][data-alert="true"]')!;
  expect(failed === null).toBe(false);
  expect(failed.className.split(/\s+/)).toContain("text-destructive");
});

test("cells pad 8px so a two-line row lands on the 52px pitch the h-13 floor gives a one-line row", async () => {
  const page = await render([group("a")]);
  const cells = Array.from(page.querySelectorAll("tbody tr td"));
  expect(cells.length).toBeGreaterThan(1);
  for (const td of cells) {
    const tokens = td.className.split(/\s+/);
    expect(tokens).toContain("py-2");
    expect(tokens).not.toContain("py-2.5");
  }
});

// A day reads as a date, in the body font: the server labels it
// with its ISO key, which stays what the click filters by.
test("a day group reads as a date and filters by its key", async () => {
  const seen: string[] = [];
  const { host } = await mountAsync(
    <BreakdownTable groups={[group("2026-08-01")]} group="day" onSelect={(key) => { seen.push(key); }} />
  );
  const button = host.querySelector("tbody tr button")!;
  expect(button.textContent).toMatch(/^Aug 1(, 2026)?$/);
  expect(button.className.split(/\s+/)).not.toContain("font-mono");
  await act(async () => { (button as HTMLElement).click(); });
  expect(seen).toStrictEqual(["2026-08-01"]);
});
