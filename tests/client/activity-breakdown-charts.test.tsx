import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import fc from "fast-check";
import type { ActivityGroupDto, ActivityGroupKey, ActivitySummaryResponse } from "@shared/api-contracts";
import { BreakdownTab } from "@/routes/activity/BreakdownTab";
import { BreakdownTable } from "@/routes/activity/BreakdownTable";
import { failRanking, shortGroupLabels, spendRanking } from "@/routes/activity/breakdown-model";
import { besideMark, firstClear, overlaps, placeLabels, placeWithHint, type Box } from "@/routes/activity/breakdown/chart-scales";
import { SpeedMap } from "@/routes/activity/breakdown/SpeedMap";
import { useUIStore } from "@/store/ui";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync } from "../helpers/mount.js";

/** happy-dom performs no layout: the map draws at its default width here,
 *  and what its labels do in a real box is asserted in e2e. */

afterEach(() => {
  // Unmount before the store the fold reads is reset under it.
  runCleanups();
  act(() => { useUIStore.setState({ breakdownTableOpen: false }); });
});

function group(key: string, fields: Partial<ActivityGroupDto> = {}): ActivityGroupDto {
  return {
    key, label: key, calls: 100, failed: 0,
    p50Ms: 1000, ttftP95Ms: 2_500, tokensPerSecondP50: 40,
    inputTokens: 9000, outputTokens: 300, cacheReadTokens: 8100, reasons: [], spendMicros: 0, spendEstimated: false, unpricedCalls: 0, ...fields
  };
}

const PLOT: Box = { x: 0, y: 0, width: 300, height: 200 };

test("placed labels never overlap one another or a dot, and stay inside the plot", () => {
  const dot = fc.record({
    cx: fc.integer({ min: 0, max: 300 }),
    cy: fc.integer({ min: 0, max: 200 }),
    r: fc.integer({ min: 4, max: 14 }),
    width: fc.integer({ min: 20, max: 120 })
  });
  fc.assert(fc.property(fc.array(dot, { maxLength: 14 }), (dots) => {
    const requests = dots.map((d, index) => ({ key: `g${index}`, ...d, height: 12 }));
    const placed = placeLabels(requests, PLOT);
    for (const [index, label] of placed.entries()) {
      expect(label.box.x).toBeGreaterThanOrEqual(PLOT.x);
      expect(label.box.y).toBeGreaterThanOrEqual(PLOT.y);
      expect(label.box.x + label.box.width).toBeLessThanOrEqual(PLOT.x + PLOT.width);
      expect(label.box.y + label.box.height).toBeLessThanOrEqual(PLOT.y + PLOT.height);
      for (const other of placed.slice(index + 1)) expect(overlaps(label.box, other.box)).toBe(false);
      for (const other of requests) {
        if (other.key === label.key) continue;
        const square = { x: other.cx - other.r, y: other.cy - other.r, width: other.r * 2, height: other.r * 2 };
        // A dot's own square bounds its circle: clear of the square is clear of the dot.
        if (overlaps(label.box, square)) {
          const nearestX = Math.max(label.box.x, Math.min(other.cx, label.box.x + label.box.width));
          const nearestY = Math.max(label.box.y, Math.min(other.cy, label.box.y + label.box.height));
          expect(Math.hypot(nearestX - other.cx, nearestY - other.cy)).toBeGreaterThanOrEqual(other.r);
        }
      }
    }
  }));
});

test("the larger dot is labelled first, on its right", () => {
  // Both want the right-hand slot; the smaller one, listed first, must yield.
  const small = { key: "small", cx: 100, cy: 104, r: 4, width: 60, height: 12 };
  const large = { key: "large", cx: 90, cy: 94, r: 10, width: 60, height: 12 };
  const placed = new Map(placeLabels([small, large], PLOT).map((label) => [label.key, label]));
  expect(placed.get("large")?.side).toBe("right");
  expect(placed.get("large")?.box.x).toBe(104);
  expect(placed.get("small")?.side).not.toBe("right");
});

test("a label is kept clear of the boxes the chart already holds", () => {
  const hint = { x: 104, y: 88, width: 80, height: 14 };
  const placed = placeLabels([{ key: "a", cx: 90, cy: 94, r: 6, width: 60, height: 12 }], PLOT, [hint]);
  expect(placed[0]?.side).not.toBe("right");
  expect(overlaps(placed[0]!.box, hint)).toBe(false);
});

test("a model's short name is its model, with its provider only where two share it", () => {
  const labels = shortGroupLabels([
    group("gateway / anthropic/claude-opus-4-5"),
    group("gateway / openai/gpt-5.5"),
    group("mirror / openai/gpt-5.5"),
    group("openai-compatible / judge-1")
  ], "model");
  expect([...labels.values()]).toEqual(["claude-opus-4-5", "gpt-5.5 (gateway)", "gpt-5.5 (mirror)", "judge-1"]);
  // Other groupings are named as the server names them.
  expect([...shortGroupLabels([group("memory_dream")], "purpose").values()]).toEqual(["memory_dream"]);
});

async function renderMap(groups: ActivityGroupDto[], onSelect: (key: string) => void = () => {}, kind: ActivityGroupKey = "purpose") {
  const { host } = await mountAsync(<SpeedMap groups={groups} group={kind} onSelect={onSelect} />);
  return host;
}

test("the map places groups that have a first token and a speed, and names the rest under it", async () => {
  const page = await renderMap([
    group("placed"),
    group("decision", { ttftP95Ms: null }),
    group("all-failed", { tokensPerSecondP50: null })
  ]);
  expect([...page.querySelectorAll("[data-speed-dot]")].map((dot) => dot.getAttribute("data-speed-dot"))).toEqual(["placed"]);
  expect([...page.querySelectorAll("[data-speed-missing]")].map((line) => line.textContent)).toEqual([
    "Not on the chart (no first token): decision",
    "Not on the chart (no tok/s): all-failed"
  ]);
});

test("with no group to place the map draws no axes, only the line saying why", async () => {
  const page = await renderMap([group("judge-1", { ttftP95Ms: null }), group("judge-2", { ttftP95Ms: null })]);
  expect(page.querySelector("svg") === null).toBe(true);
  expect(page.querySelector("[data-speed-missing]")?.textContent).toBe("Not on the chart (no first token): judge-1, judge-2");
});

test("a dot names its figures, and Enter or a click opens its group", async () => {
  const seen: string[] = [];
  const page = await renderMap([group("memory_dream", {
    calls: 1234, failed: 37, ttftP95Ms: 8_500, tokensPerSecondP50: 49.2, spendMicros: 4_200_000, spendEstimated: true
  })], (key) => { seen.push(key); });
  const dot = page.querySelector<SVGElement>('[data-speed-dot="memory_dream"]')!;
  expect(dot.getAttribute("role")).toBe("button");
  expect(dot.getAttribute("tabindex")).toBe("0");
  expect(dot.getAttribute("aria-label")).toBe("memory_dream: 1,234 calls, TTFT p95 8.5s, 49.2 tok/s, 3.0% failed, ~$4.20");
  await act(async () => { dot.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  await act(async () => { dot.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(seen).toStrictEqual(["memory_dream", "memory_dream"]);
});

test("hovering or focusing a dot shows its card", async () => {
  const page = await renderMap([group("a", { label: "gateway / a" }), group("b")], () => {}, "model");
  const dot = page.querySelector<SVGElement>('[data-speed-dot="a"]')!;
  await act(async () => { dot.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true })); });
  expect(page.querySelector("[data-speed-card]")?.textContent).toContain("gateway / a");
  await act(async () => { dot.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })); });
  expect(page.querySelector("[data-speed-card]") === null).toBe(true);
});

test("a dot is red from a tenth of its calls failing", async () => {
  const page = await renderMap([group("tenth", { calls: 100, failed: 10 }), group("under", { calls: 100, failed: 9 })]);
  expect(page.querySelector('[data-speed-dot="tenth"]')?.getAttribute("data-alert")).toBe("true");
  expect(page.querySelector('[data-speed-dot="under"]')?.getAttribute("data-alert")).toBe("false");
});

test("the spend list is the six largest spenders, largest first", () => {
  const groups = ["a", "b", "c", "d", "e", "f", "g"].map((key, index) => group(key, { spendMicros: (index + 1) * 1_000_000 }));
  groups.push(group("free", { spendMicros: 0 }));
  const rows = spendRanking(groups, shortGroupLabels(groups, "purpose"));
  expect(rows.map((row) => row.key)).toEqual(["g", "f", "e", "d", "c", "b"]);
  expect(rows[0]?.display).toBe("$7.00");
});

test("the fails list is the six highest failure shares among groups that failed", () => {
  const groups = [
    group("none", { failed: 0 }),
    group("a", { calls: 100, failed: 1 }),
    group("b", { calls: 10, failed: 5 }),
    group("c", { calls: 100, failed: 20 }),
    group("d", { calls: 100, failed: 2 }),
    group("e", { calls: 100, failed: 3 }),
    group("f", { calls: 100, failed: 4 }),
    group("g", { calls: 1000, failed: 1 })
  ];
  const rows = failRanking(groups, shortGroupLabels(groups, "purpose"));
  expect(rows.map((row) => row.key)).toEqual(["b", "c", "f", "e", "d", "a"]);
  expect(rows[0]?.display).toBe("50.0%");
});

function summary(groups: ActivityGroupDto[], kind: ActivityGroupKey = "model"): ActivitySummaryResponse {
  return {
    days: 7,
    ledger: { rows: [], totals: {} } as unknown as ActivitySummaryResponse["ledger"],
    spend: { micros: 0, reportedMicros: 0, estimated: false, pricedCalls: 0, unpricedCalls: 0, includedCalls: 0, pendingCalls: 0 },
    daily: [], dates: [], group: kind, groups
  };
}

async function renderTab(data: ActivitySummaryResponse, onSelectRow: (key: string) => void = () => {}) {
  return mountAsync(<BreakdownTab data={data} loading={false} group={data.group} onSelectGroup={() => {}} onSelectRow={onSelectRow} />);
}

function foldToggle(page: HTMLElement): HTMLButtonElement {
  return page.querySelector<HTMLButtonElement>("[data-breakdown-fold]")!;
}

test("the table is folded at first, opens, and stays open when the tab comes back", async () => {
  const data = summary([group("gateway / a"), group("gateway / b")]);
  const first = await renderTab(data);
  expect(foldToggle(first.host).getAttribute("aria-expanded")).toBe("false");
  expect(foldToggle(first.host).textContent).toContain("The table");
  expect(first.host.textContent).toContain("2 models");
  expect(first.host.querySelector("tbody") === null).toBe(true);
  await act(async () => { foldToggle(first.host).click(); });
  expect(foldToggle(first.host).getAttribute("aria-expanded")).toBe("true");
  expect(first.host.querySelectorAll("tbody tr").length).toBe(2);
  first.unmount();

  const again = await renderTab(summary([group("memory_dream")], "purpose"));
  expect(foldToggle(again.host).getAttribute("aria-expanded")).toBe("true");
  expect(again.host.textContent).toContain("1 group");
  expect(again.host.querySelectorAll("tbody tr").length).toBe(1);
});

test("a window with no calls says so once, with nothing folded", async () => {
  const { host } = await renderTab(summary([]));
  expect(foldToggle(host) === null).toBe(true);
  expect(host.querySelector("[data-speed-dot]") === null).toBe(true);
  expect(host.textContent).toContain("No calls in this window.");
});

test("a ranked row opens its group's log", async () => {
  const seen: string[] = [];
  const { host } = await renderTab(summary([group("gateway / a", { spendMicros: 2_000_000, failed: 3 })]), (key) => { seen.push(key); });
  const rows = [...host.querySelectorAll<HTMLButtonElement>("[data-ranked-row]")];
  expect(rows.map((row) => row.getAttribute("data-ranked-row"))).toEqual(["gateway / a", "gateway / a"]);
  await act(async () => { rows[1]!.click(); });
  expect(seen).toStrictEqual(["gateway / a"]);
});

test("a list with nothing to rank is left out", async () => {
  const { host } = await renderTab(summary([group("gateway / a")]));
  expect(host.querySelector("[data-ranked-row]") === null).toBe(true);
});

test("the cell bars scale to their column's largest", async () => {
  const { host } = await mountAsync(<BreakdownTable groups={[
    group("a", { calls: 200, spendMicros: 4_000_000, ttftP95Ms: 1000, tokensPerSecondP50: 80, failed: 20 }),
    group("b", { calls: 50, spendMicros: 1_000_000, ttftP95Ms: null, tokensPerSecondP50: 20, failed: 0 })
  ]} group="purpose" onSelect={() => {}} />);
  const widths = (row: number) => [...host.querySelectorAll("tbody tr")[row]!.querySelectorAll("[data-cell-bar]")]
    .map((bar) => `${bar.getAttribute("data-cell-bar")}:${(bar.querySelector("[data-cell-bar-fill]") as HTMLElement | null)?.style.width ?? "none"}`);
  expect(widths(0)).toEqual(["calls:100%", "spend:100%", "ttft:100%", "rate:100%", "failed:100%"]);
  // No TTFT: the track with no fill; no failure: no fill either.
  expect(widths(1)).toEqual(["calls:25%", "spend:25%", "ttft:none", "rate:25%", "failed:none"]);
});

test("a dot's enlarged target never covers another dot: every target is drawn under every dot", async () => {
  const page = await renderMap([group("a", { calls: 10 }), group("b", { calls: 12, ttftP95Ms: 2_600 }), group("c", { calls: 500 })]);
  const marks = [...page.querySelectorAll("[data-speed-hit], [data-speed-dot]")].map((node) => node.hasAttribute("data-speed-hit") ? "hit" : "dot");
  expect(marks).toEqual(["hit", "hit", "hit", "dot", "dot", "dot"]);
  // A target is the pointer's way to its own dot, not a second control.
  const hit = page.querySelector<SVGElement>('[data-speed-hit="a"]')!;
  expect(hit.closest("[aria-hidden]")).not.toBeNull();
  const seen: string[] = [];
  const clicked = await renderMap([group("a")], (key) => { seen.push(key); });
  await act(async () => { clicked.querySelector('[data-speed-hit="a"]')!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  expect(seen).toStrictEqual(["a"]);
});

test("a dot's card is kept inside the chart by its drawn height", async () => {
  // happy-dom lays nothing out: the card reports the height a real one has.
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) { return this.hasAttribute("data-speed-card") ? 200 : 0; }
  });
  try {
    // The slowest-writing group sits on the bottom edge of a 280px chart.
    const page = await renderMap([group("fast", { tokensPerSecondP50: 100 }), group("slow", { tokensPerSecondP50: 0.5 })]);
    const dot = page.querySelector<SVGElement>('[data-speed-dot="slow"]')!;
    await act(async () => { dot.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true })); });
    const card = page.querySelector<HTMLElement>('[data-speed-card="slow"]')!;
    expect(card.style.top).toBe("80px");
  } finally {
    if (descriptor) Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", descriptor);
    else delete (window.HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
  }
});

test("a card goes right of its mark when it fits, else left, inside the chart either way", () => {
  expect(besideMark(100, 10, 224, 600)).toBe(120);
  expect(besideMark(500, 10, 224, 600)).toBe(256);
  // Neither side has room on a phone: kept inside, over the mark if it must.
  expect(besideMark(178, 10, 224, 356)).toBe(0);
  expect(besideMark(300, 10, 224, 356)).toBe(56);
});

test("the corner hint takes the first spot no dot covers, or none", () => {
  const spots = [{ x: 0, y: 0, width: 60, height: 12 }, { x: 0, y: 14, width: 60, height: 12 }];
  expect(firstClear(spots, [])).toEqual(spots[0]!);
  // A large dot over the corner: the hint goes a row down.
  expect(firstClear(spots, [{ cx: 10, cy: 4, r: 8 }])).toEqual(spots[1]!);
  // Covered everywhere: no hint.
  expect(firstClear(spots, [{ cx: 10, cy: 10, r: 20 }])).toBeNull();
});

test("the map's corner hint never sits under a dot", async () => {
  // The fastest-writing, quickest-starting group sits in the very corner.
  const page = await renderMap([group("corner", { calls: 5000, ttftP95Ms: 100, tokensPerSecondP50: 120 }), group("slow", { ttftP95Ms: 30_000, tokensPerSecondP50: 10 })]);
  const hint = page.querySelector("[data-speed-hint]");
  expect(hint === null).toBe(false);
  const dot = page.querySelector('[data-speed-dot="corner"] circle:not([fill="transparent"])')!;
  const [cx, cy, r] = ["cx", "cy", "r"].map((name) => Number(dot.getAttribute(name)));
  const x = Number(hint!.getAttribute("x"));
  const top = Number(hint!.getAttribute("y")) - 11;
  const nearestX = Math.max(x, Math.min(cx!, x + 120));
  const nearestY = Math.max(top, Math.min(cy!, top + 13));
  expect(Math.hypot(nearestX - cx!, nearestY - cy!)).toBeGreaterThanOrEqual(r!);
  // The largest dot keeps its label: the hint does not take its place.
  expect(page.querySelector('[data-speed-label="corner"]')).not.toBeNull();
});

test("the dots' names are placed before the corner hint, which fits around them", () => {
  const dot = { key: "a", cx: 20, cy: 40, r: 6, width: 60, height: 12 };
  // The hint's first spot is where the dot's name goes on its right.
  const spots = [{ x: 30, y: 36, width: 60, height: 12 }, { x: 30, y: 60, width: 60, height: 12 }];
  const { labels, hint } = placeWithHint([dot], PLOT, spots);
  expect(labels[0]?.side).toBe("right");
  expect(hint).toEqual(spots[1]!);
});

test("the corner hint gives way to a dot where the dot's name is not", () => {
  const dot = { key: "a", cx: 10, cy: 30, r: 6, width: 40, height: 12 };
  // The dot reaches into the first spot; its name goes to its right, clear of that spot.
  const spots = [{ x: 0, y: 30, width: 12, height: 10 }, { x: 0, y: 100, width: 60, height: 12 }];
  const { labels, hint } = placeWithHint([dot], PLOT, spots);
  expect(labels.map((label) => [label.side, overlaps(label.box, spots[0]!)])).toStrictEqual([["right", false]]);
  expect(hint).toStrictEqual(spots[1]!);
});

test("with the corner clear, the map names it", async () => {
  // Every dot far from the top left: slow to start and slow to write.
  const page = await renderMap([group("a", { ttftP95Ms: 30_000, tokensPerSecondP50: 10 }), group("b", { ttftP95Ms: 28_000, tokensPerSecondP50: 12 })]);
  expect(page.querySelector("[data-speed-hint]")?.textContent).toBe("fast, little wait");
});

const tapDown = (pointerType: string) => new window.PointerEvent("pointerdown", { bubbles: true, pointerType });
const clickEvent = () => new window.MouseEvent("click", { bubbles: true });

test("on a touch screen a dot's first tap shows its card and the next opens it; a mouse opens at once", async () => {
  const seen: string[] = [];
  const page = await renderMap([group("a", { label: "gateway / a" }), group("b")], (key) => { seen.push(key); }, "model");
  const dot = page.querySelector<SVGElement>('[data-speed-dot="a"]')!;
  await act(async () => { dot.dispatchEvent(tapDown("touch")); dot.dispatchEvent(clickEvent()); });
  expect(seen).toStrictEqual([]);
  expect(page.querySelector("[data-speed-card]")?.getAttribute("data-speed-card")).toBe("a");
  await act(async () => { dot.dispatchEvent(tapDown("touch")); dot.dispatchEvent(clickEvent()); });
  expect(seen).toStrictEqual(["a"]);
  // Its wider touch target behaves the same.
  const hit = page.querySelector<SVGElement>('[data-speed-hit="b"]')!;
  await act(async () => { hit.dispatchEvent(tapDown("touch")); hit.dispatchEvent(clickEvent()); });
  expect(seen).toStrictEqual(["a"]);
  expect(page.querySelector("[data-speed-card]")?.getAttribute("data-speed-card")).toBe("b");
  // A mouse click opens at once.
  await act(async () => { dot.dispatchEvent(tapDown("mouse")); dot.dispatchEvent(clickEvent()); });
  expect(seen).toStrictEqual(["a", "a"]);
});

test("a tap whose click a phone held back (its card appeared) leaves the next tap to open", async () => {
  // iOS: the first tap shows what hover shows and sends no click.
  const seen: string[] = [];
  const page = await renderMap([group("a")], (key) => { seen.push(key); });
  const dot = page.querySelector<SVGElement>('[data-speed-dot="a"]')!;
  await act(async () => { dot.dispatchEvent(tapDown("touch")); dot.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })); });
  expect(page.querySelector("[data-speed-card]")).not.toBeNull();
  await act(async () => { dot.dispatchEvent(tapDown("touch")); dot.dispatchEvent(clickEvent()); });
  expect(seen).toStrictEqual(["a"]);
});

test("a tap away closes a tapped dot's card", async () => {
  const page = await renderMap([group("a")]);
  const dot = page.querySelector<SVGElement>('[data-speed-dot="a"]')!;
  await act(async () => { dot.dispatchEvent(tapDown("touch")); dot.dispatchEvent(clickEvent()); });
  expect(page.querySelector("[data-speed-card]")).not.toBeNull();
  // A tap elsewhere moves the phone's pointer off the dot.
  await act(async () => { dot.dispatchEvent(new window.MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
  expect(page.querySelector("[data-speed-card]") === null).toBe(true);
});

test("the keyboard's dot keeps its card when the mouse passes over another", async () => {
  const page = await renderMap([group("a"), group("b", { ttftP95Ms: 20_000 })]);
  const focusedDot = page.querySelector<SVGElement>('[data-speed-dot="b"]')!;
  const passed = page.querySelector<SVGElement>('[data-speed-dot="a"]')!;
  await act(async () => { focusedDot.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true })); });
  await act(async () => { passed.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })); });
  expect(page.querySelector("[data-speed-card]")?.getAttribute("data-speed-card")).toBe("a");
  await act(async () => { passed.dispatchEvent(new window.MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
  expect(page.querySelector("[data-speed-card]")?.getAttribute("data-speed-card")).toBe("b");
});

test("a ranked list's rows share one name column, as wide as its longest name and at most half the row", async () => {
  const { RankedList } = await import("@/routes/activity/breakdown/RankedList");
  const rows = [
    { key: "a", label: "atlas-large-preview", title: "gateway / acme/atlas-large-preview", value: 3, display: "~$3.00" },
    { key: "b", label: "flash-3", title: "gateway / bolt/flash-3", value: 1, display: "~$1.00" },
    // Wide characters take two columns of a monospace face: twelve characters, 22 columns.
    { key: "c", label: "模型模型模型模型模型-1", title: "gateway / 模型模型模型模型模型-1", value: 1, display: "~$1.00" }
  ];
  const { host } = await mountAsync(<RankedList rows={rows} tone="spend" onSelect={() => {}} />);
  const columns = [...host.querySelectorAll<HTMLElement>("[data-ranked-row]")].map((row) => row.style.gridTemplateColumns);
  // The same on every row, so the bars start at one edge.
  expect(new Set(columns).size).toBe(1);
  expect(columns[0]).toContain("min(22ch, 50%)");
});
