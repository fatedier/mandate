import { expect, test } from "bun:test";
import { ContextBudgetPill } from "@/routes/window/chat/ContextBudgetPill";
import { mount } from "../helpers/mount.js";

const usage = (inputTokens: number) => ({ inputTokens, budgetTokens: 100_000, updatedAt: "2026-10-08T00:00:00Z", source: "compression_budget" as const });
const classes = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/);

// A phone's header showed a bare "15%". The pill is always shown
// there, so it carries its meter — under the number, as wide as it, which
// costs the title nothing — and the meter turns colour as it fills, as on a
// desktop.
test("on a phone the meter sits under the number, as wide as it", () => {
  const pill = mount(<ContextBudgetPill usage={usage(15_000)} compact />).host.firstElementChild!;
  expect(pill.textContent).toContain("15%");
  // Always shown on a phone, as a column: number over meter.
  expect(classes(pill)).toEqual(expect.arrayContaining(["flex", "flex-col-reverse"]));
  expect(classes(pill)).not.toContain("hidden");
  const meter = pill.firstElementChild!;
  // Shown, as wide as the number, and tall enough to see.
  expect(classes(meter)).not.toContain("hidden");
  expect(classes(meter)).toEqual(expect.arrayContaining(["block", "w-full", "h-[3px]"]));
  expect((meter.firstElementChild as HTMLElement).style.width).toBe("15%");
});

// Every placement's meter turns colour as it fills, and none is drawn with no
// figure (the exact thresholds: the next test).
const placements: Array<{ name: string; props: { compact?: boolean; inMenu?: boolean } }> = [
  { name: "a phone's meter turns colour as it fills, as a desktop's does", props: { compact: true } },
  { name: "a desktop header's meter turns colour as it fills and is absent with no figure", props: {} },
  { name: "a menu's line turns colour as it fills and is absent with no figure, as a header's is", props: { inMenu: true } }
];

test.each(placements)("$name", ({ props }) => {
  const fill = (tokens: number) =>
    classes(mount(<ContextBudgetPill usage={usage(tokens)} {...props} />).host.firstElementChild!.firstElementChild!.firstElementChild);
  expect(fill(15_000)).toContain("bg-faint");
  expect(fill(90_000)).toContain("bg-meter-warn");
  expect(fill(120_000)).toContain("bg-red");
  expect(mount(<ContextBudgetPill usage={{ ...usage(0), inputTokens: null }} {...props} />).host.childElementCount).toBe(0);
  expect(mount(<ContextBudgetPill usage={null} {...props} />).host.childElementCount).toBe(0);
});

// Nearing the compression budget the figure warns: yellow from 85%, red from
// 95%, where the next call will likely compact it. The number takes the
// colour with its meter: the meter alone is too small to catch the eye. Not
// the violet of "ready for review", nor the red of "needs you": a compaction
// asks nothing of the user.
test("the figure turns yellow at 85% and red at 95%, its number with its meter", () => {
  const at = (tokens: number) => {
    const pill = mount(<ContextBudgetPill usage={usage(tokens)} />).host.firstElementChild!;
    return { text: classes(pill), fill: classes(pill.firstElementChild!.firstElementChild) };
  };
  for (const [tokens, fill, text] of [
    [84_000, "bg-faint", "text-faint"],
    [85_000, "bg-meter-warn", "text-meter-warn-fg"],
    [94_000, "bg-meter-warn", "text-meter-warn-fg"],
    [95_000, "bg-red", "text-red"],
    [130_000, "bg-red", "text-red"]
  ] as const) {
    const { text: t, fill: f } = at(tokens);
    expect([tokens, f.filter((c) => c.startsWith("bg-"))]).toEqual([tokens, [fill]]);
    expect([tokens, t.filter((c) => c.startsWith("text-") && c !== "text-2xs")]).toEqual([tokens, [text]]);
  }
});

test("a desktop header keeps its meter beside the number, degraded by width", () => {
  const pill = mount(<ContextBudgetPill usage={usage(15_000)} />).host.firstElementChild!;
  expect(classes(pill)).not.toContain("flex-col-reverse");
  expect(classes(pill.firstElementChild)).toEqual(expect.arrayContaining(["hidden", "w-9", "@[31rem]:block"]));
});

// After a compaction the context has no figure until the next reply measures
// it: the header then shows no meter at all, on a phone or a
// desktop, rather than the size from before the compaction.
test("with no figure there is no meter: after a compaction, until the next reply measures it", () => {
  const unmeasured = { ...usage(0), inputTokens: null, updatedAt: "2026-10-11T06:00:00Z" };
  expect(mount(<ContextBudgetPill usage={unmeasured} compact />).host.childElementCount).toBe(0);
  expect(mount(<ContextBudgetPill usage={unmeasured} />).host.childElementCount).toBe(0);
  // The same budget with a figure draws one: it is the missing figure that hides it.
  expect(mount(<ContextBudgetPill usage={usage(15_000)} compact />).host.childElementCount).toBe(1);
});

// A worker's figure is a line of its menu, where no header's width rules
// reach: there it is whole, the meter beside the word and the number.
test("in a menu the figure is whole whatever the width: meter, word and number, padded as a menu item is", () => {
  const line = mount(<ContextBudgetPill usage={usage(41_000)} inMenu />).host.firstElementChild as HTMLElement;
  expect(line.dataset.slot).toBe("context-line");
  expect(line.textContent).toBe("Context 41%");
  expect(classes(line)).toEqual(expect.arrayContaining(["flex", "px-2", "py-1.5"]));
  for (const hidden of ["hidden", "@[27rem]:flex", "flex-col-reverse", "px-1.5"]) expect(classes(line)).not.toContain(hidden);
  const meter = line.firstElementChild!;
  expect(classes(meter)).toEqual(expect.arrayContaining(["block", "h-1", "w-9"]));
  expect(classes(meter)).not.toContain("hidden");
  expect((meter.firstElementChild as HTMLElement).style.width).toBe("41%");
  // The word is not held back for a wider header.
  expect(classes(line.lastElementChild!.firstElementChild)).not.toContain("hidden");
  // It says what the figure is to a pointer, as a header's does.
  expect(line.getAttribute("title")).toBe("Last successful agent call used 41k of 100k compression budget.");
});

test("a header's figure is not a menu's line: it keeps its own padding and its width rules", () => {
  const pill = mount(<ContextBudgetPill usage={usage(41_000)} />).host.firstElementChild as HTMLElement;
  expect(pill.dataset.slot).toBeUndefined();
  expect(classes(pill)).toEqual(expect.arrayContaining(["px-1.5", "hidden", "@[27rem]:flex"]));
  expect(classes(pill)).not.toContain("px-2");
  expect(classes(pill.lastElementChild!.firstElementChild)).toEqual(expect.arrayContaining(["hidden", "@[31rem]:inline"]));
});

test("as the context fills, the meter grows to it (and turns colour) gently, at once when less motion is asked for", () => {
  const fill = mount(<ContextBudgetPill usage={usage(15_000)} inMenu />).host.firstElementChild!.firstElementChild!.firstElementChild;
  expect(classes(fill)).toEqual(expect.arrayContaining(["transition-[width,background-color]", "motion-reduce:transition-none"]));
});
