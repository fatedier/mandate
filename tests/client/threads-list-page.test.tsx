import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { toast } from "sonner";
import { ThreadsListPage } from "@/routes/threads/ThreadsListPage";
import { fitCount } from "@/routes/threads/thread-list";
import { PaneHeader } from "@/shell/PaneHeader";
import { PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { THREADS_LIST_DEFAULTS, THREADS_LIST_STORAGE_KEY, useThreadsListStore } from "@/store/threads-list";
import { useThreadStatusStore } from "@/store/thread-status";
import { usePersonalAgentStore } from "@/store/personal-agent";
import type { ArchivedThreadDto, ManagerThreadDto } from "@shared/api/agents";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mount, settle, settleUntil, typeInto } from "../helpers/mount.js";
import { managerThreadDto } from "../helpers/client-builders.js";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";

// The Threads page: every manager thread, open ones on Active and archived
// ones on Archived, searched by title; each row opens its thread.

afterEach(() => {
  runCleanups();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false, archived: [], archivedLoaded: false, archivedReadFailed: false });
    useThreadsListStore.setState({ ...THREADS_LIST_DEFAULTS });
    useThreadStatusStore.getState().replace({ threads: [], waiting: [] });
    usePersonalAgentStore.setState({ agent: null });
  });
  localStorage.removeItem(THREADS_LIST_STORAGE_KEY);
});

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
// Archived in January of the running year: a date of another year is written with its year.
const YEAR = new Date().getFullYear();
const owner = (name: string) => ({ name, by: "owner" as const });
const archivedEntry = (id: string, patch: Partial<ArchivedThreadDto> = {}): ArchivedThreadDto => ({
  id, title: id, archivedAt: `${YEAR}-01-13T09:00:00.000Z`, lastActivityAt: `${YEAR}-01-13T09:00:00.000Z`, workers: 0, canvases: 0, labels: [], projects: [], ...patch
});

// Mid-bucket ages, so a slow run still reads the same words.
const OPEN: ManagerThreadDto[] = [
  managerThreadDto("thr_a", {
    title: "Scale recipes per serving", lastActivityAt: ago(2.5),
    labels: [owner("billing"), { name: "3.21", by: "agent" }, owner("ops"), owner("voice")], projects: ["atlas-api", "search-server", "docs-site"]
  }),
  managerThreadDto("thr_b", { title: "Prices from one source", lastActivityAt: ago(0.5), projects: ["atlas-api"] }),
  managerThreadDto("thr_duty", { title: "Watch the greenhouse", lastActivityAt: ago(30), duty: { level: "investigate", schedules: [] } as never })
];
const ARCHIVED: ArchivedThreadDto[] = [
  archivedEntry("thr_old", { title: "Cache expiry", archivedAt: `${YEAR}-01-13T09:00:00.000Z`, workers: 2, canvases: 1, labels: [owner("ops")], projects: ["search-server"] }),
  archivedEntry("thr_older", { title: "Flaky upload", archivedAt: `${YEAR}-01-12T09:00:00.000Z`, workers: 3, canvases: 2 })
];

let pathname = "";
let locationSearch = "";
function Where() {
  const location = useLocation();
  pathname = location.pathname;
  locationSearch = location.search;
  return null;
}

function render({ open = OPEN, archived = ARCHIVED, phone = false, answer, unread = false, at = "/threads" }: {
  open?: ManagerThreadDto[]; archived?: ArchivedThreadDto[]; phone?: boolean; answer?: (call: FetchCall) => Response | undefined;
  /** Neither list has arrived: the stream has not sent the open threads, the archived ones were not read. */
  unread?: boolean;
  /** The address the page opens at. */
  at?: string;
} = {}) {
  if (phone) onCleanup(fakePhoneWidth());
  const calls = mockFetch((call) => answer?.(call) ?? Response.json({ archived: [] }));
  act(() => {
    if (!unread) {
      useManagerThreadsStore.getState().replaceAll(open);
      useManagerThreadsStore.setState({ archived, archivedLoaded: true });
    }
    useThreadStatusStore.getState().replace({ threads: [{ threadId: "thr_a", state: "failed" }], waiting: [] });
  });
  const mounted = mount(
    <MemoryRouter initialEntries={[at]}>
      <Where />
      <PaneHeaderSlotsProvider>
        <PaneHeader />
        <Routes>
          <Route path="/threads" element={<ThreadsListPage />} />
          <Route path="/threads/:threadId" element={<p data-slot="thread-route">A thread</p>} />
        </Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  return { ...mounted, calls };
}

const tabs = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
const tabsSay = (host: HTMLElement) => tabs(host).map((tab) => [tab.firstChild?.textContent, tab.querySelector('[data-slot="tab-count"]')?.textContent, tab.getAttribute("aria-selected")]);
const pick = (host: HTMLElement, label: string) => { act(() => { tabs(host).find((tab) => tab.firstChild?.textContent === label)!.click(); }); };
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-slot="thread-row"]')];
const texts = (root: ParentNode, selector: string) => [...root.querySelectorAll<HTMLElement>(selector)].map((n) => n.textContent?.trim());
const row = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-slot="thread-row"][data-thread-id="${id}"]`)!;
const heads = (host: HTMLElement) => texts(host, '[data-slot="threads-head"] [data-slot="threads-head-cell"]');
const search = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[aria-label="Search threads"]')!;
const empty = (host: HTMLElement) => host.querySelector('[data-slot="threads-empty"]')?.textContent ?? null;

test("the page is titled Threads, with a tab for the open threads and one for the archived, each with its count; the tab is remembered", () => {
  const first = render();
  expect(first.host.querySelector("h1")?.textContent).toBe("Threads");
  expect(tabsSay(first.host)).toEqual([["Active", "3", "true"], ["Archived", "2", "false"]]);
  pick(first.host, "Archived");
  expect(tabsSay(first.host)).toEqual([["Active", "3", "false"], ["Archived", "2", "true"]]);
  expect(JSON.parse(localStorage.getItem(THREADS_LIST_STORAGE_KEY)!).state.tab).toBe("archived");
  first.unmount();
  const again = render();
  expect(tabsSay(again.host).map((tab) => tab[2])).toEqual(["false", "true"]);
  expect(rows(again.host).map((r) => r.dataset.threadId)).toEqual(["thr_old", "thr_older"]);
});

test("Active lists the open threads by last activity: the state mark, the title, its labels, two projects then how many more, and how long ago", () => {
  const { host } = render();
  expect(heads(host)).toEqual(["Thread", "Labels", "Project", "Last activity"]);
  expect(rows(host).map((r) => r.dataset.threadId)).toEqual(["thr_b", "thr_a", "thr_duty"]);
  const a = row(host, "thr_a");
  expect(a.querySelector('[data-slot="thread-row-title"]')?.textContent).toBe("Scale recipes per serving");
  expect(a.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("state: failed or stopped");
  expect(texts(a, '[data-slot="thread-row-labels"] [data-slot="thread-label"]')).toEqual(["billing", "3.21", "ops", "voice"]);
  expect(a.querySelector<HTMLElement>('[data-slot="thread-label"][data-by="agent"]')?.textContent?.trim()).toBe("3.21");
  expect(texts(a, '[data-slot="thread-row-project"]')).toEqual(["atlas-api", "search-server"]);
  expect(a.querySelector('[data-slot="thread-row-project-more"]')?.textContent).toBe("+1");
  expect(a.querySelector('[data-slot="thread-row-time"]')?.textContent).toBe("2h ago");
  expect(a.querySelector('[role="img"]')?.getAttribute("data-mark")).toBe("dot");
  // One project, no label: no count of more; an idle thread's slot draws no mark.
  const b = row(host, "thr_b");
  expect([texts(b, '[data-slot="thread-label"]'), texts(b, '[data-slot="thread-row-project"]'), b.querySelector('[data-slot="thread-row-project-more"]') === null, b.querySelector('[role="img"]')?.getAttribute("data-mark") ?? null])
    .toEqual([[], ["atlas-api"], true, null]);
  expect(b.querySelector('[data-slot="thread-row-time"]')?.textContent).toBe("30m ago");
});

test("a duty thread is on Active with a mark saying On duty; no other row has it", () => {
  const { host } = render();
  expect(rows(host).map((r) => [r.dataset.threadId, r.querySelector('[data-slot="thread-row-duty"]')?.textContent ?? null]))
    .toEqual([["thr_b", null], ["thr_a", null], ["thr_duty", "On duty"]]);
});

test("Archived lists the archived threads by when they were archived, with the date", () => {
  const { host } = render();
  pick(host, "Archived");
  expect(heads(host)).toEqual(["Thread", "Labels", "Project", "Archived"]);
  expect(rows(host).map((r) => [r.dataset.threadId, r.querySelector('[data-slot="thread-row-title"]')?.textContent, r.querySelector('[data-slot="thread-row-time"]')?.textContent]))
    .toEqual([["thr_old", "Cache expiry", "Jan 13"], ["thr_older", "Flaky upload", "Jan 12"]]);
  expect(texts(row(host, "thr_old"), '[data-slot="thread-label"]')).toEqual(["ops"]);
  expect(texts(row(host, "thr_old"), '[data-slot="thread-row-project"]')).toEqual(["search-server"]);
});

test("an address naming a project opens Active filtered to it and leaves the address", () => {
  act(() => useThreadsListStore.setState({ tab: "archived", filters: { labels: ["ops"], projects: [] } }));
  const { host } = render({ at: "/threads?project=atlas-api" });
  expect(tabsSay(host).find(([label]) => label === "Active")?.[2]).toBe("true");
  expect(rows(host).map((r) => r.dataset.threadId)).toEqual(["thr_b", "thr_a"]);
  expect(useThreadsListStore.getState().filters).toEqual({ labels: [], projects: ["atlas-api"] });
  expect([pathname, locationSearch]).toEqual(["/threads", ""]);
});

test("an address naming a project and the Archived tab opens Archived filtered to it", () => {
  const { host } = render({ at: "/threads?project=search-server&tab=archived" });
  expect(tabsSay(host).find(([label]) => label === "Archived")?.[2]).toBe("true");
  expect(rows(host).map((r) => r.dataset.threadId)).toEqual(["thr_old"]);
  expect(useThreadsListStore.getState()).toMatchObject({ tab: "archived", filters: { labels: [], projects: ["search-server"] } });
  expect(locationSearch).toBe("");
});

test("an address naming a project no thread has says no thread matches, with Clear filters", () => {
  const { host } = render({ at: "/threads?project=ghost" });
  const said = host.querySelector<HTMLElement>('[data-slot="threads-empty"]')!;
  expect(said.querySelector("p")?.textContent).toBe("No threads match.");
  expect([...said.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Clear filters"]);
});

test("a row opens its thread", () => {
  const { host } = render();
  const link = row(host, "thr_a").querySelector<HTMLAnchorElement>("a")!;
  expect(link.getAttribute("href")).toBe("/threads/thr_a");
  act(() => { link.click(); });
  expect(pathname).toBe("/threads/thr_a");
});

test("the search narrows the rows by title; what it leaves empty says no thread matches", async () => {
  const { host } = render();
  await typeInto(search(host), "PRICES");
  expect(rows(host).map((r) => r.dataset.threadId)).toEqual(["thr_b"]);
  // A label's name is not a title.
  await typeInto(search(host), "billing");
  expect([rows(host).length, empty(host)]).toEqual([0, "No threads match."]);
  // Nothing is ticked: there are no filters to clear.
  expect(texts(host, '[data-slot="threads-empty"] button')).toEqual([]);
  // The search acts on the tab shown.
  await typeInto(search(host), "cache");
  expect(rows(host).length).toBe(0);
  pick(host, "Archived");
  expect(rows(host).map((r) => r.dataset.threadId)).toEqual(["thr_old"]);
});

test("a tab with no thread says so", () => {
  const none = render({ open: [], archived: ARCHIVED });
  expect([rows(none.host).length, empty(none.host)]).toEqual([0, "No active threads."]);
  none.unmount();
  const noArchived = render({ open: OPEN, archived: [] });
  pick(noArchived.host, "Archived");
  expect([rows(noArchived.host).length, empty(noArchived.host)]).toEqual([0, "No archived threads."]);
});

/** Opens the page's ⋯ menu (Radix opens on pointerdown) and returns its items. */
async function pageMenu(host: HTMLElement) {
  const trigger = host.querySelector<HTMLElement>('[aria-label="Archived thread actions"]');
  if (!trigger) return null;
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

test("the page's menu is the Archived tab's: it deletes every archived thread after a dialog that counts what goes, and stays on the page", async () => {
  const { host, calls } = render({ answer: ({ method }) => (method === "DELETE" ? Response.json({ ok: true, count: 2, skipped: 0 }) : undefined) });
  // The Active tab has nothing to delete.
  expect(await pageMenu(host)).toBe(null);
  pick(host, "Archived");
  const items = (await pageMenu(host))!;
  expect(items.map((item) => [item.textContent, item.getAttribute("data-variant")])).toEqual([["Delete all archived threads…", "destructive"]]);
  await act(async () => { items[0]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.querySelector("h2")!.textContent).toBe("Delete all 2 archived threads permanently?");
  expect(dialog.textContent).toContain("This removes, for good, every archived thread’s conversation, 5 workers with their chats and plans, and 3 canvases.");
  expect(dialog.textContent).toContain("Active threads are not touched. Worktrees and branches still on disk are left as they are. This can’t be undone.");
  const button = (label: string) => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
  expect(calls.filter((c) => c.method === "DELETE")).toStrictEqual([]);
  await act(async () => { button("Delete 2 threads").click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toStrictEqual(["/api/agents/manager/threads?archived=1"]);
  await settleUntil(() => document.querySelector('[role="dialog"]') === null, "the dialog closed");
  expect(pathname).toBe("/threads");
});

test("a thread left by delete all, its work still stopping, is said so", async () => {
  const said: string[] = [];
  const original = toast.message;
  toast.message = ((message: unknown) => { said.push(String(message)); return 0; }) as typeof toast.message;
  onCleanup(() => { toast.message = original; });
  const { host } = render({ answer: ({ method }) => (method === "DELETE" ? Response.json({ ok: true, count: 1, skipped: 1 }) : undefined) });
  pick(host, "Archived");
  const items = (await pageMenu(host))!;
  await act(async () => { items[0]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Delete 2 threads")!;
  await act(async () => { confirm.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => said.length > 0, "what was left said");
  expect(said).toStrictEqual(["1 thread was left: its work is still stopping. Try again in a moment."]);
});

test("a phone's rows are two lines, the second with every label and project; there are no column heads", () => {
  const { host } = render({ phone: true });
  expect(host.querySelector('[data-slot="threads-head"]') === null).toBe(true);
  const a = row(host, "thr_a");
  expect(a.querySelector('[data-slot="thread-row-title"]')?.textContent).toBe("Scale recipes per serving");
  expect(a.querySelector('[data-slot="thread-row-time"]')?.textContent).toBe("2h ago");
  const meta = a.querySelector<HTMLElement>('[data-slot="thread-row-meta"]')!;
  expect(texts(meta, '[data-slot="thread-label"]')).toEqual(["billing", "3.21", "ops", "voice"]);
  expect(texts(meta, '[data-slot="thread-row-project"]')).toEqual(["atlas-api", "search-server", "docs-site"]);
  expect(a.querySelector('[data-slot="thread-row-project-more"]') === null).toBe(true);
  // A thread with neither has one line.
  expect(row(host, "thr_duty").querySelector('[data-slot="thread-row-meta"]') === null).toBe(true);
});

test("as many of a cell's items as fit its width, room left for the count of the rest; one at least, which is then cut", () => {
  const fits = (widths: number[], available: number, counted = false) => fitCount(widths, available, { gap: 4, more: 24, counted });
  // All of them, with no room kept for a count that is not shown.
  expect([fits([], 100), fits([50, 55, 35], 148), fits([50, 55], 110)]).toEqual([0, 3, 2]);
  // Not all: those that leave room for the count after them.
  expect([fits([50, 55, 35, 42, 160], 285), fits([50, 55], 108), fits([50, 55, 35], 140)]).toEqual([4, 1, 2]);
  // One wider than the cell is still shown (and cut).
  expect([fits([160], 100), fits([160, 40], 100)]).toEqual([1, 1]);
  // A count that shows whatever fits (more items than the cell may name) takes its room first.
  expect([fits([50, 55], 110, true), fits([50, 55], 140, true)]).toEqual([1, 2]);
});

// The Label and Project filters: what the tab's threads carry, ticked in a
// menu each (a sheet on a phone), kept in this browser until cleared.
const FILTERED: ManagerThreadDto[] = [
  managerThreadDto("thr_a", { title: "Scale recipes per serving", lastActivityAt: ago(2.5), labels: [owner("billing"), owner("3.21")], projects: ["atlas-api", "docs-site"] }),
  managerThreadDto("thr_b", { title: "Prices from one source", lastActivityAt: ago(0.5), labels: [owner("ops")], projects: ["atlas-api"] }),
  managerThreadDto("thr_c", { title: "Voice mail replies", lastActivityAt: ago(30), projects: ["search-server"] })
];
const press = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
};
const choices = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')];
const choiceNames = () => choices().map((c) => `${c.textContent?.trim()}${c.getAttribute("aria-checked") === "true" ? " ✓" : ""}`);
const tick = async (name: string) => { await act(async () => { choices().find((c) => c.textContent?.trim() === name)!.click(); await Promise.resolve(); }); };
const trigger = (host: HTMLElement, group: "label" | "project") => host.querySelector<HTMLElement>(`[data-slot="thread-filter-${group}"]`)!;
const shownIds = (host: HTMLElement) => rows(host).map((r) => r.dataset.threadId);
const clearButton = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Clear filters");
// A menu stays open while ticking: Escape closes it.
const closeMenu = async () => {
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
};
const checked = () => choices().map((c) => `${c.textContent?.trim()}:${c.getAttribute("aria-checked")}`);

test("the Label and Project menus list what the tab's threads carry; a thread passes with any ticked value of a group, and must pass both", async () => {
  const { host } = render({ open: FILTERED });
  expect([trigger(host, "label").textContent?.trim(), trigger(host, "project").textContent?.trim(), clearButton(host) === undefined]).toEqual(["Label", "Project", true]);
  await press(trigger(host, "label"));
  expect(choiceNames()).toEqual(["Select all", "3.21", "billing", "ops", "No label"]);
  await tick("billing");
  expect([shownIds(host), trigger(host, "label").textContent?.trim()]).toEqual([["thr_a"], "Label · 1"]);
  // The menu stays open for the next tick.
  expect(choiceNames()).toEqual(["Select all", "3.21", "billing ✓", "ops", "No label"]);
  await tick("ops");
  expect([shownIds(host), trigger(host, "label").textContent?.trim()]).toEqual([["thr_b", "thr_a"], "Label · 2"]);
  await closeMenu();
  await press(trigger(host, "project"));
  expect(choiceNames()).toEqual(["Select all", "atlas-api", "docs-site", "search-server", "No project"]);
  await tick("docs-site");
  expect([shownIds(host), trigger(host, "project").textContent?.trim()]).toEqual([["thr_a"], "Project · 1"]);
  await closeMenu();
  // The other tab has its own threads, and its own values to choose from.
  pick(host, "Archived");
  await press(trigger(host, "project"));
  expect(choiceNames()).toEqual(["Select all", "docs-site ✓", "search-server", "No project"]);
});

test("Select all ticks every choice and the threads with none; with all ticked it unticks them; No label alone shows the threads without one", async () => {
  const { host } = render({ open: FILTERED });
  await press(trigger(host, "label"));
  await tick("Select all");
  expect(checked()).toEqual(["Select all:true", "3.21:true", "billing:true", "ops:true", "No label:true"]);
  expect([shownIds(host), trigger(host, "label").textContent?.trim()]).toEqual([["thr_b", "thr_a", "thr_c"], "Label · 4"]);
  await tick("ops");
  expect([checked()[0], shownIds(host)]).toEqual(["Select all:mixed", ["thr_a", "thr_c"]]);
  await tick("Select all");
  expect(checked()[0]).toBe("Select all:true");
  await tick("Select all");
  expect([checked(), trigger(host, "label").textContent?.trim()]).toEqual([["Select all:false", "3.21:false", "billing:false", "ops:false", "No label:false"], "Label"]);
  await tick("No label");
  expect(shownIds(host)).toEqual(["thr_c"]);
  await closeMenu();
  await press(trigger(host, "project"));
  await tick("Select all");
  expect(trigger(host, "project").textContent?.trim()).toBe("Project · 4");
});

test("a group with one choice has no Select all", async () => {
  const { host } = render({ open: [managerThreadDto("thr_a", { title: "Scale recipes per serving", projects: ["atlas-api"] })] });
  await press(trigger(host, "label"));
  expect(choiceNames()).toEqual(["No label"]);
  await closeMenu();
  await press(trigger(host, "project"));
  expect(choiceNames()).toEqual(["Select all", "atlas-api", "No project"]);
});

test("Clear filters shows while any is ticked and clears them; what leaves nothing says so and offers it; ticks are kept in this browser", async () => {
  const first = render({ open: FILTERED });
  await press(trigger(first.host, "label"));
  await tick("ops");
  await closeMenu();
  await press(trigger(first.host, "project"));
  await tick("search-server");
  await closeMenu();
  expect([shownIds(first.host), empty(first.host)]).toEqual([[], "No threads match.Clear filters"]);
  expect(JSON.parse(localStorage.getItem(THREADS_LIST_STORAGE_KEY)!).state.filters).toEqual({ labels: ["ops"], projects: ["search-server"] });
  first.unmount();
  // Kept: the page opens as it was left.
  const again = render({ open: FILTERED });
  expect([shownIds(again.host), trigger(again.host, "label").textContent?.trim(), trigger(again.host, "project").textContent?.trim()]).toEqual([[], "Label · 1", "Project · 1"]);
  act(() => { clearButton(again.host.querySelector('[data-slot="threads-empty"]')!)!.click(); });
  expect([shownIds(again.host), trigger(again.host, "label").textContent?.trim(), clearButton(again.host) === undefined]).toEqual([["thr_b", "thr_a", "thr_c"], "Label", true]);
  // The bar has it too while something is ticked.
  await press(trigger(again.host, "label"));
  await tick("billing");
  await closeMenu();
  act(() => { clearButton(again.host)!.click(); });
  expect(shownIds(again.host)).toEqual(["thr_b", "thr_a", "thr_c"]);
});

test("a phone has one Filter button with how many are ticked; it opens Filter threads with both groups", async () => {
  const { host } = render({ open: FILTERED, phone: true });
  const filter = () => host.querySelector<HTMLElement>('[data-slot="thread-filter-phone"]')!;
  expect(filter().textContent?.trim()).toBe("Filter");
  expect(host.querySelector('[data-slot="thread-filter-label"]') === null).toBe(true);
  await act(async () => { filter().click(); await new Promise((r) => setTimeout(r, 0)); });
  const sheet = () => document.querySelector<HTMLElement>('[data-slot="thread-filter-sheet"]')!;
  expect(sheet().querySelector("h2")?.textContent).toBe("Filter threads");
  expect([...sheet().querySelectorAll<HTMLElement>('[data-slot="filter-group"]')].map((g) => g.textContent)).toEqual(["Label", "Project"]);
  expect(choiceNames()).toEqual(["Select all", "3.21", "billing", "ops", "No label", "Select all", "atlas-api", "docs-site", "search-server", "No project"]);
  await tick("billing");
  await tick("atlas-api");
  expect([filter().textContent?.trim(), shownIds(host)]).toEqual(["Filter · 2", ["thr_a"]]);
  expect(checked()).toEqual([
    "Select all:mixed", "3.21:false", "billing:true", "ops:false", "No label:false",
    "Select all:mixed", "atlas-api:true", "docs-site:false", "search-server:false", "No project:false"
  ]);
  // Each group's own Select all.
  await act(async () => { choices()[5]!.click(); await Promise.resolve(); });
  expect([filter().textContent?.trim(), checked()[5]]).toEqual(["Filter · 5", "Select all:true"]);
  act(() => { clearButton(sheet())!.click(); });
  expect([filter().textContent?.trim(), shownIds(host)]).toEqual(["Filter", ["thr_b", "thr_a", "thr_c"]]);
});

test("the bar offers Clear filters with a project alone ticked", async () => {
  const { host } = render({ open: FILTERED });
  await press(trigger(host, "project"));
  await tick("search-server");
  await closeMenu();
  expect([shownIds(host), clearButton(host) !== undefined]).toEqual([["thr_c"], true]);
  act(() => { clearButton(host)!.click(); });
  expect([shownIds(host).length, clearButton(host) === undefined]).toEqual([3, true]);
});

// Selecting rows, to label several threads or delete several archived ones
// together. The selection is of rows shown: one that leaves the list leaves it.
const rowBox = (host: HTMLElement, id: string) => row(host, id).querySelector<HTMLInputElement>('input[data-slot="thread-row-select"]');
const allBox = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[data-slot="threads-select-all"]')!;
const toggle = (box: HTMLInputElement | null) => { act(() => { box!.click(); }); };
const bar = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="threads-selection-bar"]');
const barSays = (host: HTMLElement) => {
  const el = bar(host);
  return el ? [el.querySelector('[data-slot="threads-selected-count"]')?.textContent, ...[...el.querySelectorAll("button")].map((b) => b.textContent?.trim())] : null;
};
const barButton = (host: HTMLElement, label: string) => [...bar(host)!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!;
const ticked = (host: HTMLElement) => rows(host).filter((r) => r.querySelector<HTMLInputElement>('input[data-slot="thread-row-select"]')?.checked).map((r) => r.dataset.threadId);
function catchToasts() {
  const said: Array<[string, string]> = [];
  const original = { error: toast.error, message: toast.message };
  toast.error = ((message: unknown) => { said.push(["error", String(message)]); return 0; }) as typeof toast.error;
  toast.message = ((message: unknown) => { said.push(["message", String(message)]); return 0; }) as typeof toast.message;
  onCleanup(() => { toast.error = original.error; toast.message = original.message; });
  return said;
}

test("each row has a checkbox named for its thread, and the head's selects every row shown; with rows selected a bar replaces the column heads", async () => {
  const { host } = render({ open: FILTERED });
  expect(rows(host).map((r) => r.querySelector('input[data-slot="thread-row-select"]')?.getAttribute("aria-label")))
    .toEqual(["Select Prices from one source", "Select Scale recipes per serving", "Select Voice mail replies"]);
  expect([allBox(host).getAttribute("aria-label"), allBox(host).checked, bar(host) === null, heads(host).length]).toEqual(["Select all", false, true, 4]);
  toggle(rowBox(host, "thr_a"));
  expect(barSays(host)).toEqual(["1 selected", "Add label", "Archive…"]);
  expect([heads(host).length, ticked(host), allBox(host).checked, allBox(host).indeterminate]).toEqual([0, ["thr_a"], false, true]);
  // The head's box with some selected clears them.
  toggle(allBox(host));
  expect([bar(host) === null, ticked(host), heads(host).length]).toEqual([true, [], 4]);
  // Every row shown, and only those: the search has left two.
  await typeInto(search(host), "ce");
  expect(shownIds(host)).toEqual(["thr_b", "thr_c"]);
  toggle(allBox(host));
  expect([barSays(host)?.[0], allBox(host).checked, allBox(host).indeterminate]).toEqual(["2 selected", true, false]);
  await typeInto(search(host), "");
  expect([ticked(host), barSays(host)?.[0], allBox(host).indeterminate]).toEqual([["thr_b", "thr_c"], "2 selected", true]);
});

test("a row that is no longer shown leaves the selection for good: narrowed away, archived elsewhere, or the tab changed", async () => {
  const { host } = render({ open: FILTERED });
  toggle(rowBox(host, "thr_a"));
  toggle(rowBox(host, "thr_b"));
  expect(barSays(host)?.[0]).toBe("2 selected");
  await typeInto(search(host), "prices");
  expect([shownIds(host), barSays(host)?.[0]]).toEqual([["thr_b"], "1 selected"]);
  await typeInto(search(host), "");
  expect([ticked(host), barSays(host)?.[0]]).toEqual([["thr_b"], "1 selected"]);
  // Archived from another tab: the stream publishes it, the row goes.
  act(() => { useManagerThreadsStore.getState().upsert(managerThreadDto("thr_b", { archivedAt: "2026-11-01T00:00:00.000Z" })); });
  // The store reads the archived list again after an archive: let that land.
  await settle();
  expect([shownIds(host), bar(host) === null]).toEqual([["thr_a", "thr_c"], true]);
  toggle(rowBox(host, "thr_c"));
  pick(host, "Archived");
  expect([bar(host) === null, ticked(host)]).toEqual([true, []]);
  pick(host, "Active");
  expect([bar(host) === null, ticked(host)]).toEqual([true, []]);
});

test("Add label puts the chosen label on every selected thread and keeps the selection; a refusal is said once", async () => {
  const said = catchToasts();
  const { host, calls } = render({
    open: FILTERED,
    answer: ({ method, url }) => {
      if (method !== "POST" || !url.endsWith("/labels")) return undefined;
      return url.includes("/thr_c/")
        ? Response.json({ error: "No such thread: thr_c." }, { status: 404 })
        : Response.json({ labels: [{ name: "urgent", by: "owner" }] });
    }
  });
  toggle(allBox(host));
  expect(barSays(host)).toEqual(["3 selected", "Add label", "Archive…"]);
  act(() => { barButton(host, "Add label").click(); });
  await settleUntil(() => document.querySelector('[data-slot="bulk-labels-field"]') !== null, "the label field");
  const input = document.querySelector<HTMLInputElement>('[data-slot="bulk-labels-field"] input[aria-label="Add a label"]')!;
  await typeInto(input, "urg");
  // What is in use is suggested (a thread's label here), or a new name made.
  expect([...document.querySelectorAll<HTMLElement>('[data-slot="bulk-label-suggestion"]')].map((n) => n.textContent?.trim())).toEqual(['Create "urg"']);
  await typeInto(input, "urgent");
  await act(async () => { input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await Promise.resolve(); });
  const posts = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/labels")).map((c) => `${c.url} ${c.init?.body}`);
  await settleUntil(() => posts().length === 3 && said.length > 0, "the three requests and what was refused");
  expect(posts()).toEqual([
    '/api/agents/manager/threads/thr_b/labels {"name":"urgent"}',
    '/api/agents/manager/threads/thr_a/labels {"name":"urgent"}',
    '/api/agents/manager/threads/thr_c/labels {"name":"urgent"}'
  ]);
  expect(said).toEqual([["error", "No such thread: thr_c."]]);
  expect([barSays(host)?.[0], texts(row(host, "thr_b"), '[data-slot="thread-label"]')]).toEqual(["3 selected", ["urgent"]]);
});

test("on Archived the bar offers Delete…: several go by the selection's dialog, each by its own request; one still stopping is left and said", async () => {
  const said = catchToasts();
  const { host, calls } = render({
    answer: ({ method, url }) => {
      if (method !== "DELETE") return undefined;
      return url.endsWith("/thr_older")
        ? Response.json({ error: "Its work is still stopping. Try again in a moment." }, { status: 409 })
        : Response.json({ ok: true, deleted: { threads: 3, workers: 2, canvases: 1 } });
    }
  });
  pick(host, "Archived");
  toggle(allBox(host));
  expect(barSays(host)).toEqual(["2 selected", "Add label", "Delete…"]);
  await act(async () => { barButton(host, "Delete…").click(); await new Promise((r) => setTimeout(r, 0)); });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.querySelector("h2")!.textContent).toBe("Delete 2 archived threads permanently?");
  expect(dialog.textContent).toContain("This removes, for good, these threads’ conversations, 5 workers with their chats and plans, and 3 canvases.");
  expect(dialog.textContent).toContain("Other threads are not touched. Worktrees and branches still on disk are left as they are. This can’t be undone.");
  const deletes = () => calls.filter((c) => c.method === "DELETE").map((c) => c.url);
  expect(deletes()).toEqual([]);
  const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Delete 2 threads")!;
  await act(async () => { confirm.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => document.querySelector('[role="dialog"]') === null, "the dialog closed");
  expect(deletes()).toEqual(["/api/agents/manager/threads/thr_old", "/api/agents/manager/threads/thr_older"]);
  expect(said).toEqual([["message", "1 thread was left: its work is still stopping. Try again in a moment."]]);
  expect([shownIds(host), pathname]).toEqual([["thr_older"], "/threads"]);
});

// One deleted elsewhere while the dialog was open is not a refusal: it is
// gone, as asked, and what is still stopping is said as ever.
test("a selected thread already deleted elsewhere counts as deleted: nothing said of it, and the one still stopping is still said", async () => {
  const said = catchToasts();
  const { host } = render({
    answer: ({ method, url }) => {
      if (method !== "DELETE") return undefined;
      return url.endsWith("/thr_older")
        ? Response.json({ error: "Its work is still stopping. Try again in a moment." }, { status: 409 })
        : Response.json({ error: "thread not found" }, { status: 404 });
    }
  });
  pick(host, "Archived");
  toggle(allBox(host));
  await act(async () => { barButton(host, "Delete…").click(); await new Promise((r) => setTimeout(r, 0)); });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Delete 2 threads")!;
  await act(async () => { confirm.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => document.querySelector('[role="dialog"]') === null, "the dialog closed");
  expect(said).toEqual([["message", "1 thread was left: its work is still stopping. Try again in a moment."]]);
  expect(shownIds(host)).toEqual(["thr_older"]);
});

test("Delete… with one thread selected is that thread's own dialog, and the page stays", async () => {
  const { host, calls } = render({ answer: ({ method }) => (method === "DELETE" ? Response.json({ ok: true, deleted: { threads: 3, workers: 2, canvases: 1 } }) : undefined) });
  pick(host, "Archived");
  toggle(rowBox(host, "thr_old"));
  await act(async () => { barButton(host, "Delete…").click(); await new Promise((r) => setTimeout(r, 0)); });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.querySelector("h2")!.textContent).toBe("Delete “Cache expiry” permanently?");
  const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Delete permanently")!;
  await act(async () => { confirm.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => document.querySelector('[role="dialog"]') === null, "the dialog closed");
  expect([calls.filter((c) => c.method === "DELETE").map((c) => c.url), shownIds(host), pathname]).toEqual([["/api/agents/manager/threads/thr_old"], ["thr_older"], "/threads"]);
});

test("a phone shows the checkboxes only after Select; Done leaves and clears", () => {
  const { host } = render({ open: FILTERED, phone: true });
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
  expect([rowBox(host, "thr_a") === null, bar(host) === null, button("Select") !== undefined, button("Done") === undefined]).toEqual([true, true, true, true]);
  act(() => { button("Select")!.click(); });
  expect([rowBox(host, "thr_a") !== null, barSays(host), button("Select") === undefined]).toEqual([true, ["0 selected", "Add label", "Archive…", "Done"], true]);
  // In this mode a row is its checkbox: touching it selects, it does not open.
  expect(row(host, "thr_a").querySelector("a") === null).toBe(true);
  toggle(rowBox(host, "thr_a"));
  expect(barSays(host)?.[0]).toBe("1 selected");
  act(() => { button("Done")!.click(); });
  expect([rowBox(host, "thr_a") === null, bar(host) === null, row(host, "thr_a").querySelector("a") !== null]).toEqual([true, true, true]);
  act(() => { button("Select")!.click(); });
  expect(barSays(host)?.[0]).toBe("0 selected");
});

test("Archive… opens the archive dialog for the selected threads, which leave the list as they go; with one it is that thread's own wording", async () => {
  const { host, calls } = render({
    open: FILTERED,
    answer: ({ method, url }) => {
      const id = /\/threads\/(thr_[a-z]+)$/.exec(url)?.[1];
      return method === "PATCH" && id ? Response.json({ thread: managerThreadDto(id, { archivedAt: "2026-11-01T00:00:00.000Z" }), workers: [], cleanupFailures: [] }) : undefined;
    }
  });
  toggle(rowBox(host, "thr_a"));
  await act(async () => { barButton(host, "Archive…").click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("Archive “Scale recipes per serving”?");
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Cancel")!.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => document.querySelector('[role="dialog"]') === null, "the dialog closed");
  expect(barSays(host)?.[0]).toBe("1 selected");
  toggle(rowBox(host, "thr_c"));
  await act(async () => { barButton(host, "Archive…").click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("Archive 2 threads?");
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Archive")!.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => document.querySelector('[role="dialog"]') === null, "the dialog closed");
  expect(calls.filter((c) => c.method === "PATCH").map((c) => `${c.url} ${c.init?.body}`)).toEqual([
    '/api/agents/manager/threads/thr_a {"archived":true}',
    '/api/agents/manager/threads/thr_c {"archived":true}'
  ]);
  expect([shownIds(host), bar(host) === null, pathname]).toEqual([["thr_b"], true, "/threads"]);
  // The bar's button went with the rows: focus is on the page's search, not lost.
  await settleUntil(() => document.activeElement?.getAttribute("aria-label") === "Search threads", "focus on the search");
});

test("after a bulk delete focus is on the page's search, the bar's button having gone", async () => {
  const { host } = render({ answer: ({ method }) => (method === "DELETE" ? Response.json({ ok: true, deleted: { threads: 1, workers: 0, canvases: 0 } }) : undefined) });
  pick(host, "Archived");
  toggle(allBox(host));
  await act(async () => { barButton(host, "Delete…").click(); await new Promise((r) => setTimeout(r, 0)); });
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Delete 2 threads")!;
  await act(async () => { confirm.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => document.querySelector('[role="dialog"]') === null, "the dialog closed");
  await settleUntil(() => document.activeElement?.getAttribute("aria-label") === "Search threads", "focus on the search");
});

test("on a touch screen focus is left where it fell: a focused search would bring up the keyboard", async () => {
  const coarse = window.matchMedia;
  // The coarse pointer alone is faked: every other query answers as the window does.
  window.matchMedia = ((query: string) => (query === "(pointer: coarse)"
    ? { matches: true, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }
    : coarse.call(window, query))) as typeof window.matchMedia;
  onCleanup(() => { window.matchMedia = coarse; });
  const { host } = render({ answer: ({ method }) => (method === "DELETE" ? Response.json({ ok: true, deleted: { threads: 1, workers: 0, canvases: 0 } }) : undefined) });
  pick(host, "Archived");
  toggle(allBox(host));
  await act(async () => { barButton(host, "Delete…").click(); await new Promise((r) => setTimeout(r, 0)); });
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Delete 2 threads")!;
  await act(async () => { confirm.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => document.querySelector('[role="dialog"]') === null, "the dialog closed");
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(document.activeElement?.getAttribute("aria-label")).not.toBe("Search threads");
});

test("the dialog that deletes several stays as it is, and busy, until the last of them is answered", async () => {
  const answers: Array<(response: Response) => void> = [];
  const { host } = render({ answer: ({ method }) => (method === "DELETE" ? new Promise<Response>((resolve) => { answers.push(resolve); }) as never : undefined) });
  pick(host, "Archived");
  toggle(allBox(host));
  await act(async () => { barButton(host, "Delete…").click(); await new Promise((r) => setTimeout(r, 0)); });
  const dialogSays = () => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    return dialog ? [dialog.querySelector("h2")!.textContent, ...[...dialog.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-footer"] button')].map((b) => `${b.textContent}${b.disabled ? " (off)" : ""}`)] : null;
  };
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Delete 2 threads")!.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => answers.length === 1, "the first delete out");
  expect(dialogSays()).toEqual(["Delete 2 archived threads permanently?", "Cancel (off)", "Deleting… (off)"]);
  // The first is gone; the second is still out: nothing new is asked.
  await act(async () => { answers[0]!(Response.json({ ok: true, deleted: { threads: 1, workers: 0, canvases: 0 } })); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => answers.length === 2, "the second delete out");
  expect([shownIds(host), dialogSays()]).toEqual([["thr_older"], ["Delete 2 archived threads permanently?", "Cancel (off)", "Deleting… (off)"]]);
  await act(async () => { answers[1]!(Response.json({ ok: true, deleted: { threads: 1, workers: 0, canvases: 0 } })); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => document.querySelector('[role="dialog"]') === null, "the dialog closed");
  expect(shownIds(host)).toEqual([]);
});

test("a thread deleted elsewhere while its delete is being asked leaves nothing asked: ticking another row opens no dialog", async () => {
  const { host } = render();
  pick(host, "Archived");
  toggle(rowBox(host, "thr_old"));
  await act(async () => { barButton(host, "Delete…").click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("Delete “Cache expiry” permanently?");
  act(() => { useManagerThreadsStore.getState().removeDeleted("thr_old"); });
  // The question, if it still stands, is put away by its own Cancel.
  const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Cancel");
  if (cancel) await act(async () => { cancel.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => document.querySelector('[role="dialog"]') === null, "no dialog");
  toggle(rowBox(host, "thr_older"));
  expect([barSays(host)?.[0], document.querySelector('[role="dialog"]') === null]).toEqual(["1 selected", true]);
});

test("a phone can always leave selecting: Done stays when the search leaves no row", async () => {
  const { host } = render({ open: FILTERED, phone: true });
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
  act(() => { button("Select")!.click(); });
  await typeInto(search(host), "nothing has this title");
  expect([empty(host), button("Done") !== undefined, barSays(host)?.[0]]).toEqual(["No threads match.", true, "0 selected"]);
  act(() => { button("Done")!.click(); });
  expect([bar(host) === null, button("Select") !== undefined]).toEqual([true, true]);
});

// What the page says of a list it has not read: nothing. An empty list is
// said only once it is known to be empty.
test("before a list has arrived its tab says nothing of it: no sentence that there are none, no count", () => {
  const { host } = render({ unread: true });
  expect([empty(host), rows(host).length, tabsSay(host)]).toEqual([null, 0, [["Active", undefined, "true"], ["Archived", undefined, "false"]]]);
  pick(host, "Archived");
  expect([empty(host), rows(host).length]).toEqual([null, 0]);
  // The stream's first list, and the archived one read: now it is known.
  act(() => {
    useManagerThreadsStore.getState().replaceAll([]);
    useManagerThreadsStore.setState({ archived: [], archivedLoaded: true });
  });
  expect([empty(host), tabsSay(host).map((tab) => tab[1])]).toEqual(["No archived threads.", ["0", "0"]]);
  pick(host, "Active");
  expect(empty(host)).toBe("No active threads.");
});

test("an archived list that could not be read says so, with Retry that reads it again", async () => {
  let fail = true;
  const { host, calls } = render({
    open: OPEN, archived: [],
    answer: ({ method, url }) => (method === "GET" && url.includes("?archived=1") ? (fail ? Response.json({ error: "down" }, { status: 500 }) : Response.json({ archived: ARCHIVED })) : undefined)
  });
  act(() => { useManagerThreadsStore.setState({ archivedLoaded: false, archivedReadFailed: true }); });
  pick(host, "Archived");
  const error = () => host.querySelector<HTMLElement>('[data-slot="inline-error"]');
  expect([error()?.textContent?.includes("Couldn't load the archived threads."), empty(host), tabsSay(host)[1]![1]]).toEqual([true, null, undefined]);
  // The open threads were read: their tab is as it is.
  expect(tabsSay(host)[0]![1]).toBe("3");
  fail = false;
  await act(async () => { [...error()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Retry")!.click(); await Promise.resolve(); });
  await settleUntil(() => rows(host).length === 2, "the archived threads read");
  expect([error() === null, calls.filter((c) => c.url.includes("?archived=1")).length, tabsSay(host)[1]![1]]).toEqual([true, 1, "2"]);
});
