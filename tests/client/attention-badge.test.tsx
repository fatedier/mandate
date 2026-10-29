import { expect, test } from "bun:test";
import { AttentionBadge } from "@/shell/AttentionBadge";
import { mount, type Mounted } from "../helpers/mount.js";

let view: Mounted | null = null;

function badge(urgent: boolean, count = 3, failed = false): HTMLElement {
  view = mount(<AttentionBadge count={count} urgent={urgent} failed={failed} />);
  return view.host.querySelector<HTMLElement>('[role="img"]')!;
}

test("the badge is yellow when something asked, and red when something failed or stopped", () => {
  const asked = badge(true).className.split(/\s+/);
  expect(asked).toContain("text-status-input-fg");
  expect(asked.some((t) => t.startsWith("bg-") && t.includes("--status-input"))).toBe(true);
  expect(asked).not.toContain("text-red");
  view!.unmount();
  const failed = badge(true, 3, true).className.split(/\s+/);
  expect(failed).toContain("text-red");
  expect(failed.some((t) => t.startsWith("bg-") && t.includes("--red"))).toBe(true);
  expect(failed).not.toContain("text-status-input-fg");
});

test("the badge takes the review colour when only decisions and results to read wait", () => {
  const el = badge(false);
  expect(el.className).toContain("text-status-review");
  expect(el.className).not.toContain("text-status-input");
  expect(el.className).not.toContain("text-red");
});

test("the badge's name says what its colour does: needs you, or to look at", () => {
  expect(badge(true).getAttribute("aria-label")).toBe("3 items need you");
  view!.unmount();
  expect(badge(false).getAttribute("aria-label")).toBe("3 items to look at");
  view!.unmount();
  expect(badge(true, 1).getAttribute("aria-label")).toBe("1 item needs you");
  view!.unmount();
  expect(badge(false, 1).getAttribute("aria-label")).toBe("1 item to look at");
});

test("nothing to show at zero or below: no badge, as a pill or a dot", () => {
  for (const count of [0, -3]) {
    expect(badge(true, count) === null).toBe(true);
    view!.unmount();
    const floating = mount(<AttentionBadge count={count} urgent floating />);
    expect(floating.host.querySelector('[role="img"]') === null).toBe(true);
    floating.unmount();
  }
});

test("the count is a pill: round, tabular digits, tinted in its colour", () => {
  const tokens = (el: HTMLElement) => el.className.split(/\s+/);
  const urgent = tokens(badge(true));
  expect(urgent).toEqual(expect.arrayContaining(["rounded-full", "num"]));
  expect(urgent.some((t) => t.startsWith("bg-") && t.includes("--status-input"))).toBe(true);
  view!.unmount();
  const review = tokens(badge(false));
  expect(review).toEqual(expect.arrayContaining(["rounded-full", "num"]));
  expect(review.some((t) => t.startsWith("bg-") && t.includes("--status-review"))).toBe(true);
});

test("past 99 the digits stop at 99+, and the name keeps the real count", () => {
  expect(badge(true, 99).textContent).toBe("99");
  view!.unmount();
  const el = badge(true, 150);
  expect(el.textContent).toBe("99+");
  expect(el.getAttribute("aria-label")).toBe("150 items need you");
});

test("on an icon the badge is a dot in the same colour, still named with its count", () => {
  const dotView = mount(<><AttentionBadge count={12} urgent floating /></>);
  const dot = dotView.host.querySelector<HTMLElement>('[role="img"]')!;
  // No digits over the icon; the name carries the number.
  expect(dot.textContent).toBe("");
  expect(dot.getAttribute("aria-label")).toBe("12 items need you");
  const tokens = dot.className.split(/\s+/);
  expect(tokens).toEqual(expect.arrayContaining(["absolute", "size-2", "rounded-full", "bg-status-input"]));
  dotView.unmount();
  const failedView = mount(<AttentionBadge count={2} urgent failed floating />);
  expect(failedView.host.querySelector<HTMLElement>('[role="img"]')!.className.split(/\s+/)).toContain("bg-red");
  failedView.unmount();
  const { host } = mount(<AttentionBadge count={1} urgent={false} floating />);
  const review = host.querySelector<HTMLElement>('[role="img"]')!;
  expect(review.className.split(/\s+/)).toContain("bg-status-review");
  expect(review.getAttribute("aria-label")).toBe("1 item to look at");
});
