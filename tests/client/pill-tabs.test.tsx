import { expect, test } from "bun:test";
import { act } from "react";
import { PillTabs } from "@/components/PillTabs";
import { scrollEdges } from "@/lib/scroll-edges";
import { mount } from "../helpers/mount.js";

const ITEMS = [{ id: "overview", label: "Overview" }, { id: "logs", label: "Logs" }] as const;

test("pill tabs: tablist semantics, one sliding mark under the selected pill, ids and aria-controls when idPrefix is set", () => {
  let picked = "";
  const { host } = mount(<PillTabs items={ITEMS} value="overview" onChange={(id) => { picked = id; }} aria-label="Activity views" idPrefix="activity" />);
  const list = host.querySelector('[role="tablist"]')!;
  expect(list === null).toBe(false);
  expect(list.getAttribute("data-slot")).toBe("page-tabs");
  expect(list.getAttribute("aria-label")).toBe("Activity views");
  for (const t of ["flex", "gap-0.5"]) expect(list.className.split(/\s+/)).toContain(t);
  const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
  for (const t of tabs) expect(t.getAttribute("type")).toBe("button");
  expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
  expect(tabs[0]!.id).toBe("activity-tab-overview");
  expect(tabs[0]!.getAttribute("aria-controls")).toBe("activity-panel-overview");
  expect(tabs[1]!.getAttribute("aria-controls")).toBe(null);
  for (const t of ["inline-flex", "h-7", "items-center", "rounded-sm", "px-2.5", "text-xs", "font-medium"]) expect(tabs[0]!.className.split(/\s+/)).toContain(t);
  // The fill is the row's one mark, which slides; the pill itself carries none.
  expect(list.querySelectorAll('[data-slot="tab-mark"]').length).toBe(1);
  expect(tabs[0]!.className.split(/\s+/)).not.toContain("bg-sel");
  expect(tabs[0]!.className.split(/\s+/)).toContain("text-foreground");
  expect(tabs[1]!.className.split(/\s+/)).toContain("text-chrome");
  expect(tabs[1]!.className.split(/\s+/)).not.toContain("bg-sel");
  expect(host.innerHTML.includes("rounded-md")).toBe(false);
  expect(host.innerHTML.includes("border-b-2")).toBe(false);
  act(() => { (tabs[1] as HTMLButtonElement).click(); });
  expect(picked).toBe("logs");
});

test("role=nav renders a <nav> with aria-current instead of tablist semantics", () => {
  const { host } = mount(<PillTabs items={ITEMS} value="logs" onChange={() => {}} aria-label="Memory views" role="nav" />);
  const nav = host.querySelector("nav")!;
  expect(nav === null).toBe(false);
  expect(nav.getAttribute("aria-label")).toBe("Memory views");
  expect(nav.getAttribute("data-slot")).toBe("page-tabs");
  for (const t of ["flex", "gap-0.5"]) expect(nav.className.split(/\s+/)).toContain(t);
  expect(nav.querySelector('[role="tab"]') === null).toBe(true);
  const buttons = Array.from(nav.querySelectorAll("button"));
  for (const b of buttons) expect(b.getAttribute("type")).toBe("button");
  expect(buttons.map((b) => b.getAttribute("aria-current"))).toEqual([null, "page"]);
  expect(nav.querySelectorAll('[data-slot="tab-mark"]').length).toBe(1);
  expect(buttons[1]!.className.split(/\s+/)).toContain("text-foreground");
  expect(buttons[0]!.className.split(/\s+/)).toContain("text-chrome");
});

// ── a row wider than its box scrolls, and says so at the edges ──────────

test("scrollEdges: which sides of a scrolled row have more", () => {
  expect(scrollEdges({ scrollLeft: 0, clientWidth: 342, scrollWidth: 342 })).toBe("none");
  expect(scrollEdges({ scrollLeft: 0, clientWidth: 342, scrollWidth: 400 })).toBe("right");
  expect(scrollEdges({ scrollLeft: 30, clientWidth: 342, scrollWidth: 400 })).toBe("both");
  expect(scrollEdges({ scrollLeft: 58, clientWidth: 342, scrollWidth: 400 })).toBe("left");
  // Sub-pixel layout: half a pixel short of the end is the end.
  expect(scrollEdges({ scrollLeft: 57.5, clientWidth: 342, scrollWidth: 400 })).toBe("left");
});

const SETTINGS = [
  { id: "general", label: "General" }, { id: "providers", label: "Providers" }, { id: "routing", label: "Routing" },
  { id: "memory", label: "Memory" }, { id: "voice", label: "Voice" }, { id: "skills", label: "Skills" }
] as const;
// A 390px phone's strip: 342px wide, the six pills 400px.
const LEFT: Record<string, number> = { General: 0, Providers: 70, Routing: 150, Memory: 220, Voice: 290, Skills: 340 };

/** happy-dom lays nothing out: give the strip and its pills a phone's sizes
 *  while the test runs, and put the prototype back after. */
let rowWidth = 342;
let resized: (() => void) | null = null;
function withPhoneLayout(run: () => void) {
  const proto = HTMLElement.prototype;
  const saved = ["scrollWidth", "clientWidth", "offsetLeft", "offsetWidth"].map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
  const savedObserver = globalThis.ResizeObserver;
  // The row's observer, captured so a test can say "the row resized".
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  rowWidth = 342;
  const isStrip = (el: HTMLElement) => el.getAttribute("data-slot") === "page-tabs";
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get(this: HTMLElement) { return isStrip(this) ? Math.max(400, rowWidth) : 0; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: HTMLElement) { return isStrip(this) ? rowWidth : 0; } });
  Object.defineProperty(proto, "offsetLeft", { configurable: true, get(this: HTMLElement) { return LEFT[this.textContent ?? ""] ?? 0; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get(this: HTMLElement) { return this.textContent && this.textContent in LEFT ? 60 : 0; } });
  try { run(); } finally {
    globalThis.ResizeObserver = savedObserver;
    resized = null;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  }
}

test("a row too wide for its box scrolls without a bar and fades on the side that has more, from the first paint", () => {
  withPhoneLayout(() => {
    const { host } = mount(<PillTabs items={SETTINGS} value="general" onChange={() => {}} aria-label="Settings sections" role="nav" />);
    const nav = host.querySelector<HTMLElement>('[data-slot="page-tabs"]')!;
    expect(nav.className.split(/\s+/)).toContain("scroll-x-edges");
    expect(nav.getAttribute("data-more")).toBe("right");
  });
});

test("the selected pill is scrolled into the row's view, and only the row scrolls", () => {
  withPhoneLayout(() => {
    const { host } = mount(<PillTabs items={SETTINGS} value="skills" onChange={() => {}} aria-label="Settings sections" role="nav" />);
    const nav = host.querySelector<HTMLElement>('[data-slot="page-tabs"]')!;
    // Skills ends at 400: the row scrolls to its end, past the fade's width.
    expect(nav.scrollLeft).toBe(400 - 342);
    expect(nav.getAttribute("data-more")).toBe("left");
  });
});

test("when the row narrows, the selected pill is brought back into view", () => {
  withPhoneLayout(() => {
    rowWidth = 500; // wide: everything fits, nothing scrolled
    const { host } = mount(<PillTabs items={SETTINGS} value="skills" onChange={() => {}} aria-label="Settings sections" role="nav" />);
    const nav = host.querySelector<HTMLElement>('[data-slot="page-tabs"]')!;
    expect(nav.scrollLeft).toBe(0);
    rowWidth = 342; // the window narrows; the row stays mounted
    act(() => resized!());
    expect(nav.scrollLeft).toBe(400 - 342);
    expect(nav.getAttribute("data-more")).toBe("left");
  });
});

test("a pill reached by keyboard is scrolled clear of the fade; one focused by a tap is left where it is", () => {
  withPhoneLayout(() => {
    const { host } = mount(<PillTabs items={SETTINGS} value="general" onChange={() => {}} aria-label="Settings sections" role="nav" />);
    const nav = host.querySelector<HTMLElement>('[data-slot="page-tabs"]')!;
    const voice = [...nav.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Voice")!;
    // A tap focuses without :focus-visible: scrolling then would move the pill from under the finger.
    act(() => { voice.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true })); });
    expect(nav.scrollLeft).toBe(0);
    const realMatches = Element.prototype.matches;
    // happy-dom has no input modality: stand in for a keyboard focus.
    Element.prototype.matches = function (this: Element, selector: string) {
      return selector === ":focus-visible" ? true : realMatches.call(this, selector);
    } as typeof Element.prototype.matches;
    try {
      act(() => { voice.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true })); });
    } finally {
      Element.prototype.matches = realMatches;
    }
    // Voice ends at 350: past 342 - 24 of fade, so the row moves it 32px in.
    expect(nav.scrollLeft).toBe(350 - 342 + 24);
  });
});

test("a pill's focus ring is drawn inside it, where the scrolling row cannot clip it", () => {
  const { host } = mount(<PillTabs items={ITEMS} value="overview" onChange={() => {}} aria-label="Activity views" />);
  for (const tab of host.querySelectorAll('[role="tab"]')) {
    expect(tab.className.split(/\s+/)).toContain("focus-visible:-outline-offset-2");
  }
});
