import { afterEach, expect, test } from "bun:test";
import { TabMark } from "@/components/TabMark";
import { PillTabs } from "@/components/PillTabs";
import { recordAnimations, reducedMotion } from "../helpers/motion.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

// One fill under a row's chosen tab, sliding to the tab chosen next instead
// of one tab's fill going out as another's comes in.

afterEach(runCleanups);

const TABS = ["Chat", "Plan", "Changes"];
/** happy-dom lays nothing out: each tab is given its place in the row, by
 *  where it stands among the tabs now. */
function placeTabs() {
  const proto = window.HTMLElement.prototype;
  const keys = ["offsetLeft", "offsetTop", "offsetWidth", "offsetHeight"] as const;
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
  const at = (el: HTMLElement) => [...el.parentElement!.children].filter((c) => c.getAttribute("role") === "tab").indexOf(el);
  const tab = (el: HTMLElement) => el.getAttribute("role") === "tab";
  Object.defineProperty(proto, "offsetLeft", { configurable: true, get(this: HTMLElement) { return tab(this) ? 4 + at(this) * 80 : 0; } });
  Object.defineProperty(proto, "offsetTop", { configurable: true, get(this: HTMLElement) { return tab(this) ? 2 : 0; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get(this: HTMLElement) { return tab(this) ? 72 + at(this) : 0; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get(this: HTMLElement) { return tab(this) ? 28 : 0; } });
  onCleanup(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  });
}
const row = (chosen: string | null, tabs = TABS) => (
  <div role="tablist" className="relative flex">
    <TabMark selected={chosen} />
    {tabs.map((name) => <button key={name} type="button" role="tab" aria-selected={name === chosen} className="relative">{name}</button>)}
  </div>
);
const markOf = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="tab-mark"]')!;

test("it lies under the chosen tab, there at once the first time, and slides to the next one chosen", () => {
  placeTabs();
  const { host, rerender } = mount(<div>{row(null)}</div>);
  rerender(<div>{row("Chat")}</div>);
  const mark = markOf(host);
  expect([mark.style.transform, mark.style.width, mark.style.height, mark.style.transitionDuration, mark.style.visibility])
    .toEqual(["translate(4px, 2px)", "72px", "28px", "0s", ""]);
  rerender(<div>{row("Changes")}</div>);
  expect([mark.style.transform, mark.style.width, mark.style.transitionDuration]).toEqual(["translate(164px, 2px)", "74px", ""]);
});

test("drawn again before its slide is painted, with nothing moved, it keeps sliding", () => {
  placeTabs();
  const { host, rerender } = mount(row("Chat"));
  rerender(row("Changes"));
  rerender(row("Changes"));
  expect([markOf(host).style.transform, markOf(host).style.transitionDuration]).toEqual(["translate(164px, 2px)", ""]);
});

test("a tab before the chosen one closing moves it: the mark follows at once", () => {
  placeTabs();
  const { host, rerender } = mount(row("Changes"));
  rerender(row("Changes", ["Plan", "Changes"]));
  expect([markOf(host).style.transform, markOf(host).style.transitionDuration]).toEqual(["translate(84px, 2px)", "0s"]);
});

test("with no tab chosen it is not shown", () => {
  const { host } = mount(row(null));
  expect(markOf(host).style.visibility).toBe("hidden");
});

test("once another tab is chosen, what its panel shows fades in; what showed as the view opened does not move", () => {
  const started = recordAnimations();
  const page = (value: string) => (
    <div>
      <PillTabs items={[{ id: "overview", label: "Overview" }, { id: "logs", label: "Logs" }]} value={value} onChange={() => {}} aria-label="Activity views" fadesNext />
      <section>{value === "overview" ? "Spend this week" : "Every call"}</section>
    </div>
  );
  const { rerender } = mount(page("overview"));
  expect(started).toStrictEqual([]);
  rerender(page("logs"));
  expect(started.map((a) => [a.text, a.keyframes.map((k) => k.opacity), a.duration])).toStrictEqual([["Every call", [0, 1], 150]]);
});

test("asked for less motion, the panel is just there", () => {
  reducedMotion();
  const started = recordAnimations();
  const page = (value: string) => (
    <div>
      <PillTabs items={[{ id: "overview", label: "Overview" }, { id: "logs", label: "Logs" }]} value={value} onChange={() => {}} aria-label="Activity views" fadesNext />
      <section>{value}</section>
    </div>
  );
  const { rerender } = mount(page("overview"));
  rerender(page("logs"));
  expect(started).toStrictEqual([]);
});

test("tabs that do not stand over their panel (a header's switch) fade nothing after them", () => {
  const started = recordAnimations();
  const header = (value: string) => (
    <div>
      <PillTabs items={[{ id: "chat", label: "Chat" }, { id: "side", label: "Page" }]} value={value} onChange={() => {}} aria-label="View" />
      <button type="button">Agent actions</button>
    </div>
  );
  const { rerender } = mount(header("chat"));
  rerender(header("side"));
  expect(started).toStrictEqual([]);
});
