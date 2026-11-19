import { expect, mock, test } from "bun:test";
import { act, useState } from "react";
import { PanelTabRow, type PanelTabItem } from "@/components/PanelTabRow";
import { mount, settle, settleRounds, settleUntil } from "../helpers/mount.js";
import { onCleanup } from "../helpers/cleanup.js";

// A right panel's row of tabs that has more than fits: it scrolls as before,
// and a button at the row's end, "N ⌄", lists every tab by name, grouped by
// kind; the "+" after the tabs moves to the row's end with it, so neither
// scrolls out of sight. A row that fits has neither change.

const item = (id: string, label: string, group: string, onClose = () => {}): PanelTabItem => ({
  id, label, group, onClose, icon: <span data-slot="icon" />
});
const TABS = [
  item("thread:thr_db", "Read replica switch", "Threads"),
  item("canvas:cnv_pay", "Payment callback retries", "Canvases"),
  item("canvas:cnv_log", "Log sampling rules", "Canvases"),
  item("reply:rtab_1", "Priorities for this week: payment retries first", "Replies")
];

function render(tabs: PanelTabItem[], active = "first") {
  const onSelect = mock((_id: string) => {});
  const { host, rerender } = mount(
    <PanelTabRow
      first={{ label: "Page" }}
      tabs={tabs}
      active={active}
      onSelect={onSelect}
      tools={<button type="button">Hide panel</button>}
      after={<button type="button" aria-label="Open a thread beside Juno">+</button>}
      ariaLabel="Page tabs"
    />
  );
  return { host, rerender, onSelect };
}

/** Lays the tabs out wider than the row, as a browser would, and says so. */
function overflow(host: HTMLElement) {
  const row = host.querySelector<HTMLElement>('[role="tablist"]')!;
  Object.defineProperty(row, "clientWidth", { configurable: true, get: () => 400 });
  Object.defineProperty(row, "scrollWidth", { configurable: true, get: () => 900 });
  act(() => { row.dispatchEvent(new window.Event("scroll")); });
  return row;
}

const allTabs = (host: HTMLElement) => host.querySelector<HTMLElement>('[aria-label="All tabs"]');
const plus = (host: HTMLElement) => host.querySelector<HTMLElement>('[aria-label="Open a thread beside Juno"]')!;

async function openList(host: HTMLElement) {
  await act(async () => {
    allTabs(host)!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return document.querySelector<HTMLElement>('[data-slot="all-tabs-menu"]')!;
}

test("a row that fits has no list button, and its + follows the last tab", () => {
  const { host } = render(TABS);
  expect(allTabs(host) === null).toBe(true);
  expect(plus(host).closest('[role="tablist"]')).not.toBeNull();
});

test("a row with more than fits gets the list button, counting its tabs, and its + leaves the scrolled tabs for the row's end", () => {
  const { host } = render(TABS);
  const row = overflow(host);
  expect(allTabs(host)?.textContent).toBe("5");
  expect(row.contains(allTabs(host))).toBe(false);
  expect(row.contains(plus(host))).toBe(false);
  // Before the panel's own tools.
  const order = [...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
  expect(order.slice(-3)).toEqual(["All tabs", "Open a thread beside Juno", "Hide panel"]);
});

test("the list names every tab in full, the first and then each kind under its name, the shown one marked; choosing one shows it", async () => {
  const { host, onSelect } = render(TABS, "canvas:cnv_log");
  overflow(host);
  const menu = await openList(host);
  const lines = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [data-slot="all-tabs-group"]')].map((el) =>
    el.getAttribute("data-slot") === "all-tabs-group" ? `# ${el.textContent}` : `${el.textContent}${el.hasAttribute("data-current") ? " (shown)" : ""}`);
  expect(lines).toEqual([
    "Page",
    "# Threads", "Read replica switch",
    "# Canvases", "Payment callback retries", "Log sampling rules (shown)",
    "# Replies", "Priorities for this week: payment retries first"
  ]);
  await act(async () => { [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === "Payment callback retries")!.click(); });
  expect(onSelect.mock.calls).toEqual([["canvas:cnv_pay"]]);
});

/** A row whose tabs close for real: the shown ones, as the panel keeps them. */
function Closing({ initial }: { initial: PanelTabItem[] }) {
  const [ids, setIds] = useState(initial.map((t) => t.id));
  const tabs = initial.filter((t) => ids.includes(t.id)).map((t) => ({ ...t, onClose: () => setIds((now) => now.filter((id) => id !== t.id)) }));
  return <PanelTabRow first={{ label: "Page" }} tabs={tabs} active="first" onSelect={() => {}} tools={null} ariaLabel="Page tabs" />;
}

test("a tab closed from the list by its × closes, nothing is chosen, and the list stays open", async () => {
  const closed: string[] = [];
  const tabs = TABS.map((t) => ({ ...t, onClose: () => { closed.push(t.id); } }));
  const { host, onSelect } = render(tabs);
  overflow(host);
  const menu = await openList(host);
  const close = menu.querySelector<HTMLElement>('[aria-label="Close Log sampling rules"]')!;
  // A press as a pointer makes it: down, up, click.
  await act(async () => {
    close.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    close.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }));
    close.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(closed).toEqual(["canvas:cnv_log"]);
  expect(onSelect.mock.calls).toEqual([]);
  expect(document.querySelector('[data-slot="all-tabs-menu"]')).not.toBeNull();
});

test("Delete on a tab in the list closes it, for a keyboard", async () => {
  const closed: string[] = [];
  const tabs = TABS.map((t) => ({ ...t, onClose: () => { closed.push(t.id); } }));
  const { host, onSelect } = render(tabs);
  overflow(host);
  const menu = await openList(host);
  const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === "Read replica switch")!;
  expect(item.getAttribute("aria-keyshortcuts")).toBe("Delete");
  await act(async () => { item.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Delete", bubbles: true })); });
  expect([closed, onSelect.mock.calls]).toEqual([["thread:thr_db"], []]);
  // The first tab has no close.
  const first = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === "Page")!;
  expect(first.hasAttribute("aria-keyshortcuts")).toBe(false);
});

test("closing tabs from the list until the rest fit keeps the list open until it is closed", async () => {
  const { host } = mount(<Closing initial={TABS} />);
  const row = overflow(host);
  const menu = await openList(host);
  await act(async () => { menu.querySelector<HTMLElement>('[aria-label="Close Log sampling rules"]')!.click(); });
  // What is left fits now.
  Object.defineProperty(row, "scrollWidth", { configurable: true, get: () => 400 });
  act(() => { row.dispatchEvent(new window.Event("scroll")); });
  expect(document.querySelector('[data-slot="all-tabs-menu"]')).not.toBeNull();
  expect([...document.querySelectorAll('[data-slot="all-tabs-menu"] [role="menuitem"]')].map((el) => el.textContent)).not.toContain("Log sampling rules");
  await act(async () => {
    document.querySelector('[data-slot="all-tabs-menu"]')!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(allTabs(host) === null).toBe(true);
  // Its button gone, the focus it would have taken back goes to the shown tab.
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
  expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement?.textContent).toBe("Page");
});

test("a long name in the list wraps rather than being cut, its whole name on hover too", async () => {
  const long = item("reply:rtab_2", "Priorities for this week: feeding the sourdough starter first, then the oven rota, then the spring menu tasting list", "Replies");
  const { host } = render([...TABS, long]);
  overflow(host);
  const menu = await openList(host);
  const name = menu.querySelector<HTMLElement>(`[data-slot="all-tabs-name"][title="${long.label}"]`)!;
  expect(name.textContent).toBe(long.label);
  expect(name.className.split(/\s+/)).not.toContain("truncate");
});

// Chosen with a pointer, the list leaves the focus where the pointer put it,
// as every menu here does: no ring on its button after a click.
test("a tab chosen from the list with a pointer leaves the focus off the list's button", async () => {
  const { host } = render(TABS);
  overflow(host);
  const menu = await openList(host);
  const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === "Read replica switch")!;
  await act(async () => {
    item.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    item.click();
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(document.querySelector('[data-slot="all-tabs-menu"]') === null).toBe(true);
  expect(document.activeElement === allTabs(host)).toBe(false);
});

// Reopen: a button among the row's tools while something closed can come
// back, listing the panel's recently closed tabs, newest first, each by its
// icon, name and age. The + stays for opening new things.
const MINUTE = 60_000;
const closedTab = (id: string, label: string, ago: number) => ({ id, label, icon: <span data-slot="icon" data-for={id} />, closedAt: Date.now() - ago });

function renderReopen(entries: ReturnType<typeof closedTab>[]) {
  const onReopen = mock((_id: string) => {});
  const { host } = mount(
    <PanelTabRow
      first={{ label: "Page" }}
      tabs={TABS.slice(0, 1)}
      active="first"
      onSelect={() => {}}
      tools={<button type="button">Hide panel</button>}
      after={<button type="button" aria-label="Open a thread beside Juno">+</button>}
      reopen={{ entries, onReopen }}
      ariaLabel="Page tabs"
    />
  );
  return { host, onReopen };
}
const reopenButton = (host: HTMLElement) => host.querySelector<HTMLElement>('[aria-label="Reopen a closed tab"]');

async function openReopen(host: HTMLElement) {
  await act(async () => {
    reopenButton(host)!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return document.querySelector<HTMLElement>('[data-slot="recently-closed-menu"]')!;
}

test("with nothing closed the row has no Reopen; with something closed it sits before the panel's tools, after the +", () => {
  expect(reopenButton(renderReopen([]).host) === null).toBe(true);
  const { host } = renderReopen([closedTab("canvas:cnv_pay", "Payment callback retries", 2 * MINUTE)]);
  expect(reopenButton(host)?.getAttribute("title")).toBe("Reopen a closed tab");
  const order = [...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
  expect(order.slice(-3)).toEqual(["Open a thread beside Juno", "Reopen a closed tab", "Hide panel"]);
});

test("Reopen lists the recently closed tabs in the order given, each with its icon, name and age; choosing one reopens it", async () => {
  const { host, onReopen } = renderReopen([
    closedTab("canvas:cnv_pay", "Payment callback retries", 2.5 * MINUTE),
    closedTab("thread:thr_db", "Read replica switch", 90 * MINUTE)
  ]);
  const menu = await openReopen(host);
  expect(menu.querySelector('[data-slot="recently-closed-label"]')?.textContent).toBe("Recently closed");
  const rows = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(rows.map((row) => [row.querySelector('[data-slot="icon"]')?.getAttribute("data-for"), row.querySelector('[data-slot="recently-closed-name"]')?.textContent, row.querySelector('[data-slot="recently-closed-age"]')?.textContent]))
    .toEqual([["canvas:cnv_pay", "Payment callback retries", "2m ago"], ["thread:thr_db", "Read replica switch", "1h ago"]]);
  await act(async () => {
    rows[1]!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(onReopen.mock.calls.map((c) => c[0])).toEqual(["thread:thr_db"]);
});

test("the ages are read when the menu opens, not when the row last drew", async () => {
  const { host } = renderReopen([closedTab("canvas:cnv_pay", "Payment callback retries", 0)]);
  // Three minutes on, with nothing redrawn in between.
  const real = Date.now;
  const descriptor = Object.getOwnPropertyDescriptor(Date, "now")!;
  Object.defineProperty(Date, "now", { configurable: true, writable: true, value: () => real.call(Date) + 3 * MINUTE + 1000 });
  onCleanup(() => { Object.defineProperty(Date, "now", descriptor); });
  const menu = await openReopen(host);
  expect(menu.querySelector('[data-slot="recently-closed-age"]')?.textContent).toBe("3m ago");
});

// Dragging tabs to reorder (the Terminals page): only a row given onReorder,
// only tabs given an order. A row without it draws as before.
function renderOrdered(tabs: PanelTabItem[], onReorder?: (id: string, overId: string) => void) {
  return mount(
    <PanelTabRow first={{ label: "All" }} tabs={tabs} active="first" onSelect={() => {}} tools={null} ariaLabel="Terminals" onReorder={onReorder} />
  );
}
const ordered = (id: string, label: string, order: string | undefined): PanelTabItem => ({ id, label, icon: <span />, order });
const tabNamed = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === name)!;

test("without onReorder a row draws as before: no tab carries an order or the hold-to-drag classes", () => {
  const { host } = renderOrdered([ordered("a", "Alpha", "pins"), ordered("b", "Beta", "open")]);
  expect(host.querySelectorAll("[data-sort-order]")).toHaveLength(0);
  expect(host.querySelector(".touch-manipulation") === null).toBe(true);
});

test("with onReorder each tab of an order carries it and is held, not swiped, to drag; All and a tab with no order are not", () => {
  const { host } = renderOrdered([ordered("a", "Alpha", "pins"), ordered("b", "Beta", "open"), ordered("c", "Gamma", undefined)], () => {});
  expect(tabNamed(host, "Alpha").dataset.sortOrder).toBe("pins");
  expect(tabNamed(host, "Beta").dataset.sortOrder).toBe("open");
  expect(tabNamed(host, "Gamma").dataset.sortOrder).toBeUndefined();
  expect(tabNamed(host, "All").dataset.sortOrder).toBeUndefined();
  for (const name of ["Alpha", "Beta"]) expect(tabNamed(host, name).className).toContain("touch-manipulation");
  expect(tabNamed(host, "Gamma").className).not.toContain("touch-manipulation");
});

test("tabs that change while one is carried (a list read, another device) end the drag with no move", async () => {
  const onReorder = mock((_id: string, _over: string) => {});
  const tabs = [ordered("a", "Alpha", "open"), ordered("b", "Beta", "open")];
  const { host, rerender } = renderOrdered(tabs, onReorder);
  const alpha = tabNamed(host, "Alpha");
  act(() => {
    alpha.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 40, clientY: 10 }));
  });
  // Carried (its place in the row kept, empty). The copy under the pointer
  // needs a layout to be drawn, which happy-dom has none of: e2e sees it.
  expect(host.querySelectorAll("[data-dragging]")).toHaveLength(1);
  act(() => {
    rerender(<PanelTabRow first={{ label: "All" }} tabs={[tabs[1]!]} active="first" onSelect={() => {}} tools={null} ariaLabel="Terminals" onReorder={onReorder} />);
  });
  act(() => { document.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, clientX: 40, clientY: 10 })); });
  // dnd-kit swallows the click that ends a drag for 50 ms after it, on the
  // document: waited out, so the next test's clicks are not taken.
  await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
  expect(onReorder).not.toHaveBeenCalled();
  expect(host.querySelectorAll("[data-dragging]")).toHaveLength(0);
});

// Tabs with the same name (two shells in one folder) swapped round: the shown
// one, moved, is scrolled into view again.
test("the shown tab moved past one with the same name is brought into view", () => {
  const same = (id: string): PanelTabItem => ({ id, label: "zsh · ~/work", icon: <span />, order: "open" });
  const shown = ["a", "b", "c", "d", "e"].map(same);
  const draw = (tabs: PanelTabItem[]) => <PanelTabRow first={{ label: "All" }} tabs={tabs} active="b" onSelect={() => {}} tools={null} ariaLabel="Terminals" onReorder={() => {}} />;
  const { host, rerender } = mount(draw(shown));
  const row = overflow(host);
  // Laid out as a browser would: each tab 140px wide, 150px apart, by place.
  for (const el of row.querySelectorAll<HTMLElement>('[role="tab"]')) {
    Object.defineProperty(el, "offsetLeft", { configurable: true, get: () => [...row.children].filter((c) => c.getAttribute("role") === "tab").indexOf(el) * 150 });
    Object.defineProperty(el, "offsetWidth", { configurable: true, get: () => 140 });
  }
  act(() => { rerender(draw(shown)); });
  const before = row.scrollLeft;
  act(() => { rerender(draw([shown[0]!, shown[2]!, shown[3]!, shown[4]!, shown[1]!])); });
  expect(row.scrollLeft).toBeGreaterThan(before);
});

// A tab dropped among others at the row's far end leaves the row where it is
// (the person is looking at where they let go); the shown tab, at the start
// and not moved, is not scrolled back to.
test("two tabs other than the shown one swapped round leave the row's scroll where it was", () => {
  const tab = (id: string): PanelTabItem => ({ id, label: `tab ${id}`, icon: <span />, order: "open" });
  const tabs = ["a", "b", "c", "d", "e"].map(tab);
  const draw = (list: PanelTabItem[]) => <PanelTabRow first={{ label: "All" }} tabs={list} active="a" onSelect={() => {}} tools={null} ariaLabel="Terminals" onReorder={() => {}} />;
  const { host, rerender } = mount(draw(tabs));
  const row = overflow(host);
  for (const el of row.querySelectorAll<HTMLElement>('[role="tab"]')) {
    Object.defineProperty(el, "offsetLeft", { configurable: true, get: () => [...row.children].filter((c) => c.getAttribute("role") === "tab").indexOf(el) * 150 });
    Object.defineProperty(el, "offsetWidth", { configurable: true, get: () => 140 });
  }
  act(() => { row.scrollLeft = 500; row.dispatchEvent(new window.Event("scroll")); });
  act(() => { rerender(draw([tabs[0]!, tabs[1]!, tabs[2]!, tabs[4]!, tabs[3]!])); });
  expect(row.scrollLeft).toBe(500);
});

// A pin unpinned (its tab moved among the open ones, a Close gained) can leave
// a row that fit too wide; the row says so at once.
test("a tab that gains a Close as it moves, with the first shown, makes the row read as overflowing at once", () => {
  const pinned = (id: string, onClose?: () => void): PanelTabItem => ({ id, label: `term ${id}`, icon: <span />, order: onClose ? "open" : "pins", onClose });
  const draw = (list: PanelTabItem[]) => <PanelTabRow first={{ label: "All" }} tabs={list} active="first" onSelect={() => {}} tools={null} ariaLabel="Terminals" onReorder={() => {}} />;
  const { host, rerender } = mount(draw([pinned("b"), pinned("a", () => {})]));
  const row = host.querySelector<HTMLElement>('[role="tablist"]')!;
  let wide = 400;
  Object.defineProperty(row, "clientWidth", { configurable: true, get: () => 400 });
  Object.defineProperty(row, "scrollWidth", { configurable: true, get: () => wide });
  act(() => { row.dispatchEvent(new window.Event("scroll")); });
  expect(allTabs(host) === null).toBe(true);
  wide = 900;
  act(() => { rerender(draw([pinned("a", () => {}), pinned("b", () => {})])); });
  expect(allTabs(host) === null).toBe(false);
});

// A right panel's tabs moved without dragging: a right-click on a tab offers
// Move left and Move right, a place at a time within its group. Not on a
// coarse pointer, where holding a tab starts a drag.
function radixAnchors() {
  // Radix anchors the menu at the press with a DOMRect, which the test DOM
  // keeps on its window only.
  const globals = globalThis as { DOMRect?: unknown };
  if (!globals.DOMRect) {
    globals.DOMRect = (window as unknown as { DOMRect: unknown }).DOMRect;
    onCleanup(() => { delete globals.DOMRect; });
  }
}
function renderMovable(onReorder: (id: string, overId: string) => void, moveMenu = true) {
  return mount(
    <PanelTabRow first={{ label: "Page" }} tabs={[ordered("a", "Alpha", "tabs"), ordered("b", "Beta", "tabs"), ordered("c", "Gamma", "tabs")]} active="first" onSelect={() => {}} tools={null} ariaLabel="Page tabs" onReorder={onReorder} moveMenu={moveMenu} />
  );
}
async function rightClick(tab: HTMLElement) {
  await act(async () => { tab.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
}
/** The menu a right-click opened, once it is open. */
async function menuOf(tab: HTMLElement): Promise<HTMLElement[]> {
  await rightClick(tab);
  await settleUntil(() => menuItems().length === 2, `the menu of ${tab.textContent}`);
  return menuItems();
}
// A menu closed stays in the test DOM while its exit animation never ends:
// the open one is read.
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menu"][data-state="open"] [role="menuitem"]')];
/** Until the menu is gone and Radix has given the focus back, which it does
 *  a timer later: a menu opened before then loses the focus to it and closes
 *  (no person right-clicks again within the same moment). */
const menuGone = async () => {
  await settleUntil(() => document.querySelector('[role="menu"]') === null, "the menu closed");
  await settleRounds(3);
};
const closeMenu = async () => {
  await act(async () => { document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await menuGone();
};

test("with moveMenu, right-clicking a tab offers Move left and Move right; each moves it one place in its group and is disabled at the group's end", async () => {
  radixAnchors();
  const onReorder = mock((_id: string, _over: string) => {});
  const { host } = renderMovable(onReorder);
  const beta = await menuOf(tabNamed(host, "Beta"));
  expect(beta.map((item) => item.textContent)).toEqual(["Move left", "Move right"]);
  expect(beta.some((item) => item.hasAttribute("data-disabled"))).toBe(false);
  await act(async () => { beta[0]!.click(); });
  expect(onReorder.mock.calls).toEqual([["b", "a"]]);
  await menuGone();
  const alpha = await menuOf(tabNamed(host, "Alpha"));
  expect(alpha.map((item) => item.hasAttribute("data-disabled"))).toEqual([true, false]);
  await closeMenu();
  const gamma = await menuOf(tabNamed(host, "Gamma"));
  expect(gamma.map((item) => item.hasAttribute("data-disabled"))).toEqual([false, true]);
  await act(async () => { gamma[0]!.click(); });
  expect(onReorder.mock.calls).toEqual([["b", "a"], ["c", "b"]]);
  await menuGone();
});

test("without moveMenu a right-click opens no menu", async () => {
  radixAnchors();
  const plain = renderMovable(() => {}, false);
  await rightClick(tabNamed(plain.host, "Beta"));
  await settle(20);
  expect(document.querySelector('[role="menu"]') === null).toBe(true);
});

// A finger's hold starts a drag (and a long press is a context menu on some
// phones): only a mouse opens the menu, whatever the screen's width or the
// device's main pointer.
test("a touch on a tab never opens its menu, held or with a long-press context menu; a mouse right-click does", async () => {
  radixAnchors();
  const { host } = renderMovable(() => {});
  const beta = tabNamed(host, "Beta");
  await act(async () => { beta.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch", clientX: 10, clientY: 10 })); });
  // Past Radix's own long-press time.
  await settle(800);
  expect(document.querySelector('[role="menu"]') === null).toBe(true);
  await rightClick(beta);
  await settle(20);
  expect(document.querySelector('[role="menu"]') === null).toBe(true);
  await act(async () => { beta.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerType: "touch" })); });
  await act(async () => { beta.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 2, clientX: 10, clientY: 10 })); });
  expect((await menuOf(beta)).map((item) => item.textContent)).toEqual(["Move left", "Move right"]);
  await closeMenu();
});

test("a tab that can be dragged is not a bottom sheet's drag handle", () => {
  const { host } = renderMovable(() => {});
  expect(tabNamed(host, "Beta").hasAttribute("data-vaul-no-drag")).toBe(true);
  expect(tabNamed(host, "Page").hasAttribute("data-vaul-no-drag")).toBe(false);
});

// Escape puts a carried tab back; the page's own Escape (a maximized pane's,
// a narrow row's) must not also act on it.
test("Escape while a tab is carried puts it back and is taken, so the page's own Escape leaves it", async () => {
  const onReorder = mock((_id: string, _over: string) => {});
  const { host } = renderOrdered([ordered("a", "Alpha", "open"), ordered("b", "Beta", "open")], onReorder);
  act(() => {
    tabNamed(host, "Alpha").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 40, clientY: 10 }));
  });
  expect(host.querySelectorAll("[data-dragging]")).toHaveLength(1);
  const key = new window.KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
  act(() => { document.body.dispatchEvent(key); });
  expect(key.defaultPrevented).toBe(true);
  expect(host.querySelectorAll("[data-dragging]")).toHaveLength(0);
  expect(onReorder).not.toHaveBeenCalled();
  // Not carried, Escape is the page's.
  const later = new window.KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
  act(() => { document.body.dispatchEvent(later); });
  expect(later.defaultPrevented).toBe(false);
  await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
});
